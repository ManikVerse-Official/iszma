// @ts-nocheck
//
// entitlement — ReportCard Studio free generations, subscriptions & admin access
// ---------------------------------------------------------------------------
// THE server-side source of truth for ReportCard Studio. The browser can cache
// the answer for display, but it can never change it: every decision here is
// made from the database and from the request's verified Supabase session.
//
// POST body (JSON), by `action`:
//   { action: "plans" }                                  -> live plans + free limits
//   { action: "state",   email, deviceToken? }           -> plan, allowances, admin
//   { action: "device",  deviceId, hints? }              -> registers this browser,
//                                                           returns a SIGNED token
//   { action: "consume", email, deviceToken, runId, hints? }
//                                                        -> claims one free generation
//   { action: "release", claimId }                       -> gives a claim back
//   { action: "subscribe", email, planId, name?, payment? }
//
// Admin access: `_shared/adminAccess.ts` verifies the JWT and reads
// `admin_users`. The email in the body is NOT an identity — claiming
// `admin@ishmaverse.com` grants nothing.
//
// Free generations (7): counted per email AND per device, on one usage row per
// generation, atomically, so two concurrent requests cannot both slip through
// and a retried request cannot count twice. The device must present a token this
// server signed (`DEVICE_SECRET`); a made-up device id is refused.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/auth.ts";
import { clientIp, studioPlanStatus, studioState } from "../_shared/entitlement.ts";
import { FREE_LIMITS, loadStudioPlans } from "../_shared/plans.ts";
import { resolveAdminAccess } from "../_shared/adminAccess.ts";
import { adminNotifyEmails } from "../_shared/admin.ts";
import { isEmailConfigured, sendEmail, sendEmailWithRetry } from "../_shared/email.ts";
import { subscriptionEmail } from "../_shared/templates.ts";
import {
  verifyPayPalPayment,
  verifyRazorpayPayment,
  verifyStripePayment,
} from "../_shared/payments.ts";
import {
  claimStudioGeneration,
  fingerprintFor,
  isDeviceId,
  readStudioUsage,
  registerStudioDevice,
  releaseStudioClaim,
  STUDIO_FREE_GENERATIONS,
  USAGE_UNAVAILABLE_MESSAGE,
  verifyDeviceToken,
} from "../_shared/studioLimits.ts";

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Coarse, client-supplied hints — only ever used to build the fingerprint cap. */
const deviceHints = (body: Record<string, unknown>) => ({
  timeZone: clean(body.timeZone, 60),
  screen: clean(body.screen, 30),
  platform: clean(body.platform, 60),
  languages: clean(body.languages, 120),
});

/** A generation run id: url-safe, long enough to be unique. */
const isRunId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(value.trim());

const addMonths = (date: Date, months: number): Date => {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
};

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405, req);

  const ip = clientIp(req);
  const supabase = createAdminClient();

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = clean(body.action, 20);
    const email = clean(body.email, 150).toLowerCase();
    const deviceToken = clean(body.deviceToken, 400);

    /*
     * Admin is decided ONCE, from the verified session, for every action. The
     * request body cannot influence it.
     */
    const access = await resolveAdminAccess(req, supabase);
    const admin = access.isAdmin;

    /* -------------------------------- plans ------------------------------- */
    if (action === "plans") {
      const plans = await loadStudioPlans(supabase);
      return jsonResponse({
        success: true,
        plans: Object.values(plans),
        freeLimits: FREE_LIMITS,
      });
    }

    /* -------------------------------- state ------------------------------- */
    if (action === "state") {
      const deviceKey = deviceToken ? await verifyDeviceToken(deviceToken) : null;
      const usage = await readStudioUsage(supabase, email, deviceKey);
      const state = await studioState(supabase, email, admin, {
        emailUsed: usage.emailUsed,
        deviceUsed: usage.deviceUsed,
        deviceRegistered: Boolean(deviceKey),
      });
      return jsonResponse({ success: true, ...state });
    }

    /* ------------------------------- device ------------------------------- */
    /*
     * Registers the browser and returns a signed token. The stored identifier is
     * an HMAC of the id, and the token proves the server issued it — a client
     * cannot invent a device, only ask for a new one (which the fingerprint caps
     * in the claim function bound).
     */
    if (action === "device") {
      const deviceId = clean(body.deviceId, 80);
      if (!isDeviceId(deviceId)) {
        return errorResponse("A valid device id is required", 400, req);
      }
      const fingerprint = await fingerprintFor(req, deviceHints(body));
      const registration = await registerStudioDevice(supabase, {
        deviceId,
        fingerprint,
        userId: access.userId,
        email,
        ip,
      });
      if (!registration) {
        // Fail closed: without a device there is no free allowance to grant.
        return jsonResponse(
          { success: false, code: "USAGE_UNAVAILABLE", error: USAGE_UNAVAILABLE_MESSAGE },
          503,
          req,
        );
      }

      const usage = await readStudioUsage(supabase, email, registration.deviceKey);
      const state = await studioState(supabase, email, admin, {
        emailUsed: usage.emailUsed,
        deviceUsed: usage.deviceUsed,
        deviceRegistered: true,
      });

      return jsonResponse({
        success: true,
        deviceToken: registration.deviceToken,
        freeLimit: STUDIO_FREE_GENERATIONS,
        ...state,
      });
    }

    /* ------------------------------- consume ------------------------------ */
    if (action === "consume") {
      if (!email || !isEmail(email)) {
        return errorResponse("A valid email address is required", 400, req);
      }
      const runId = clean(body.runId, 80);
      if (!isRunId(runId)) {
        // Without a run id a retry could be counted twice; require one.
        return errorResponse("A generation id is required", 400, req);
      }

      /*
       * An active subscription is unlimited, and that fact comes from the
       * DATABASE — not from the browser saying so. Nothing is claimed or counted
       * for a subscriber, so their free allowance stays untouched.
       */
      if (!admin) {
        const plan = await studioPlanStatus(supabase, email);
        if (plan.active) {
          return jsonResponse({
            success: true,
            allowed: true,
            remaining: STUDIO_FREE_GENERATIONS,
            remainingEmail: STUDIO_FREE_GENERATIONS,
            remainingDevice: STUDIO_FREE_GENERATIONS,
            planActive: true,
            planId: plan.planId,
            claimId: null,
            alreadyClaimed: false,
            admin: false,
          });
        }
      }

      const fingerprint = await fingerprintFor(req, deviceHints(body));
      const decision = await claimStudioGeneration(supabase, {
        email,
        userId: access.userId,
        deviceToken,
        fingerprint,
        ip,
        runId,
        isAdmin: admin,
      });

      /*
       * Shape kept compatible with the existing client: `allowed` plus a
       * human-readable `reason`. `code` is what the UI uses to tell "you used
       * your 7" apart from "we could not check" — only the former suggests a
       * plan.
       */
      return jsonResponse({
        success: true,
        allowed: decision.allowed,
        reason: decision.message,
        code: decision.code,
        remaining: Math.min(decision.remainingEmail, decision.remainingDevice),
        remainingEmail: decision.remainingEmail,
        remainingDevice: decision.remainingDevice,
        claimId: decision.claimId,
        alreadyClaimed: decision.alreadyClaimed,
        admin: decision.admin,
        retryable: decision.code === "USAGE_UNAVAILABLE",
      });
    }

    /* ------------------------------- release ------------------------------ */
    if (action === "release") {
      const claimId = clean(body.claimId, 80);
      if (!claimId) return errorResponse("A claim id is required", 400, req);
      await releaseStudioClaim(supabase, claimId);
      return jsonResponse({ success: true });
    }

    /* ------------------------------ subscribe ----------------------------- */
    if (action === "subscribe") {
      const plans = await loadStudioPlans(supabase);
      const plan = plans[clean(body.planId, 40)];
      if (!plan) return errorResponse("Unknown plan", 400, req);
      if (!isEmail(email)) return errorResponse("A valid email is required", 400, req);

      const name = clean(body.name, 80);
      const proof = body.payment as any;
      const isPaid = plan.priceInr > 0 || plan.priceUsd > 0;

      /*
       * Only a VERIFIED admin may activate a plan without payment (that is the
       * "no charge for the owner" rule). Everyone else must present gateway proof
       * and the amount is re-checked server-side.
       */
      if (isPaid && !admin) {
        /*
         * Stripe proves a session id, not an order id; requiring `order_id` for
         * every provider made the hosted-card flow impossible to activate even
         * though `create-payment-order` offers it.
         */
        const hasProof =
          Boolean(proof?.provider) &&
          Boolean(proof?.payment_id) &&
          (proof.provider === "stripe" || Boolean(proof?.order_id));
        if (!hasProof) {
          return errorResponse("Payment is required to activate this plan", 402, req);
        }

        /*
         * REPLAY GUARD.
         *
         * A repeated callback must not extend the plan and must not be reported
         * as a failed purchase. When the payment is already in the ledger and the
         * subscription it bought is still active, this is the same successful
         * order — answer 200 with the existing state; never 409.
         */
        const lookupKey = String(proof.payment_id).trim();
        const { data: existingTx } = await supabase
          .from("transactions")
          .select("payment_id")
          .eq("payment_id", lookupKey)
          .maybeSingle();
        if (existingTx) {
          const { data: currentSub } = await supabase
            .from("studio_subscriptions")
            .select("plan_id, status, expires_at")
            .eq("email", email)
            .maybeSingle();
          const stillActive =
            currentSub?.status === "active" && new Date(currentSub.expires_at) > new Date();
          if (stillActive) {
            return jsonResponse(
              {
                success: true,
                planActive: true,
                planId: currentSub.plan_id,
                expiresAt: currentSub.expires_at,
                alreadyActive: true,
                duplicate: true,
                isAdmin: admin,
              },
              200,
              req,
            );
          }
          /*
           * No subscription row at all: the first attempt recorded the payment
           * and then failed before activating. Falling through re-verifies the
           * SAME captured payment and completes the activation, so the buyer is
           * not left paid-but-inactive. A row that exists but has expired means
           * the payment was already consumed — that stays a 409 (no free
           * reactivation of a finished plan).
           */
          if (currentSub) {
            return errorResponse("This payment has already been used", 409, req);
          }
          console.warn("Completing a paid subscription whose activation was interrupted");
        }

        let settlement: any;
        try {
          if (proof.provider === "razorpay") {
            settlement = await verifyRazorpayPayment(proof, plan.priceInr);
          } else if (proof.provider === "paypal") {
            settlement = await verifyPayPalPayment(proof, plan.priceUsd);
          } else if (proof.provider === "stripe") {
            settlement = await verifyStripePayment(proof, plan.priceUsd);
          } else {
            return errorResponse("Unsupported payment provider", 400, req);
          }
        } catch (e: any) {
          return errorResponse(e?.message || "Payment verification failed", 402, req);
        }

        // Verify amount matches plan
        if (
          proof.provider === "razorpay" &&
          Math.abs((settlement.amount || 0) - plan.priceInr) > 0.01
        ) {
          return errorResponse("Payment amount does not match the selected plan", 400, req);
        }
        if (
          (proof.provider === "paypal" || proof.provider === "stripe") &&
          Math.abs((settlement.amount || 0) - plan.priceUsd) > 0.01
        ) {
          return errorResponse("Payment amount does not match the selected plan", 400, req);
        }

        // Record transaction. A duplicate id here is a concurrent retry of the
        // SAME order; anything else is logged loudly but does not revoke a plan
        // the buyer has already paid for.
        const { error: ledgerError } = await supabase.from("transactions").insert([
          {
            client_name: name || email,
            client_email: email,
            payment_id: settlement.paymentId || lookupKey,
            provider: proof.provider,
            product_name: `ReportCard Studio - ${plan.name}`,
            amount: settlement.amount,
            currency:
              proof.provider === "paypal" || proof.provider === "stripe" ? "USD" : "INR",
            status: "paid",
          },
        ]);
        if (ledgerError && ledgerError.code !== "23505") {
          console.error("Failed to record subscription transaction:", ledgerError.message);
        }
      }

      const startedAt = new Date();
      const expiresAt = addMonths(startedAt, plan.durationMonths);

      const { data: existingSub } = await supabase
        .from("studio_subscriptions")
        .select("*")
        .eq("email", email)
        .maybeSingle();

      if (
        existingSub &&
        existingSub.status === "active" &&
        new Date(existingSub.expires_at) > new Date()
      ) {
        if (isPaid && !admin && !proof) {
          return errorResponse("Subscription already active", 409, req);
        }
      }

      const { error } = await supabase.from("studio_subscriptions").upsert(
        [
          {
            email,
            name: name || null,
            plan_id: plan.id,
            price_inr: plan.priceInr,
            price_usd: plan.priceUsd,
            started_at: startedAt.toISOString(),
            expires_at: expiresAt.toISOString(),
            status: "active",
            renewal_warned_at: null,
            admin_granted: admin,
            ip: ip || null,
            updated_at: startedAt.toISOString(),
          },
        ],
        { onConflict: "email" },
      );

      if (error) {
        console.error("subscribe failed:", error.message);
        return errorResponse("Could not activate the subscription", 500, req);
      }

      /* ------------------------------------------------------------------------
       * SAFE EMAIL & LOG DELIVERY (Wrapped in try/catch so email failure never crashes checkout)
       * ------------------------------------------------------------------------ */
      try {
        if (isEmailConfigured()) {
          const amount = isPaid ? `₹${plan.priceInr}` : `₹0`;
          const rendered = subscriptionEmail({
            name,
            planName: plan.name,
            amount,
            durationMonths: plan.durationMonths,
            expiresAt: expiresAt.toDateString(),
          });

          const { outcome, attempts } = await sendEmailWithRetry({
            to: email,
            subject: rendered.subject,
            html: rendered.html,
          });
          await supabase
            .from("email_log")
            .insert([
              {
                template: "subscription",
                to_email: email,
                subject: rendered.subject,
                status: outcome.ok ? "sent" : "failed",
                error: outcome.ok
                  ? null
                  : `${(outcome.error ?? "Resend rejected the email").slice(0, 260)}${
                      attempts > 1 ? ` (after ${attempts} attempts)` : ""
                    }`,
                ip: ip || null,
              },
            ])
            .catch(() => {});

          for (const notifyEmail of adminNotifyEmails()) {
            if (notifyEmail === email) continue;
            const copy = subscriptionEmail({
              name: name || email,
              planName: `${plan.name} · ${email}`,
              amount,
              durationMonths: plan.durationMonths,
              expiresAt: expiresAt.toDateString(),
            });
            const stored = await sendEmail({
              to: notifyEmail,
              subject: `[Admin copy] ${copy.subject}`,
              html: copy.html,
            });
            await supabase
              .from("email_log")
              .insert([
                {
                  template: "subscription_admin_copy",
                  to_email: notifyEmail,
                  subject: copy.subject,
                  status: stored ? "sent" : "failed",
                  ip: ip || null,
                },
              ])
              .catch(() => {});
          }
        }
      } catch (emailErr) {
        console.error("Non-fatal email error during subscribe:", emailErr);
      }

      return jsonResponse({
        success: true,
        planActive: true,
        planId: plan.id,
        expiresAt: expiresAt.toISOString(),
        isAdmin: admin,
      });
    }

    return errorResponse("Unknown action", 400, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("entitlement failed:", message);
    return errorResponse(message, 500, req);
  }
});
