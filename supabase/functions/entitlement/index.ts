// @ts-nocheck
//
// entitlement — ReportCard Studio free uses, subscriptions & free-trial limits
// ---------------------------------------------------------------------------
// Single server-side source of truth so the browser cannot reset the counters.
//
// POST body:
//   { action: "state",    email }                        -> plan + free uses left
//   { action: "consume",  email, feature }                -> records one use
//   { action: "subscribe", email, planId, name?, payment? } -> activates a plan (paid plans require verified payment)
//
// The client's IP is read from the request headers and never trusted from the
// body. Admin access is granted by email OR IP (see _shared/admin.ts), and an
// admin consume never counts against the free tries.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/auth.ts";
import { checkAndConsumeTrial, clientIp, studioState } from "../_shared/entitlement.ts";
import { FREE_LIMITS, loadStudioPlans } from "../_shared/plans.ts";
import { isAdminRequest, adminNotifyEmails } from "../_shared/admin.ts";
import { isEmailConfigured, sendEmail } from "../_shared/email.ts";
import { subscriptionEmail } from "../_shared/templates.ts";
import { verifyPayPalPayment, verifyRazorpayPayment } from "../_shared/payments.ts";

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const addMonths = (date: Date, months: number): Date => {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
};

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const ip = clientIp(req);
  const supabase = createAdminClient();

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const action = clean(body.action, 20);
    const email = clean(body.email, 150).toLowerCase();
    const admin = isAdminRequest(email, ip);

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
      const state = await studioState(supabase, email, admin);
      return jsonResponse({ success: true, ...state });
    }

    /* ------------------------------- consume ------------------------------ */
    if (action === "consume") {
      const feature = clean(body.feature, 40) || "studio_generation";
      const decision = await checkAndConsumeTrial(supabase, feature, email, ip, admin);
      return jsonResponse({ success: true, ...decision });
    }

    /* ------------------------------ subscribe ----------------------------- */
    if (action === "subscribe") {
      const plans = await loadStudioPlans(supabase);
      const plan = plans[clean(body.planId, 40)];
      if (!plan) return errorResponse("Unknown plan", 400);
      if (!isEmail(email)) return errorResponse("A valid email is required", 400);

      const name = clean(body.name, 80);
      const proof = body.payment as any;
      const isPaid = plan.priceInr > 0 || plan.priceUsd > 0;

      if (isPaid && !admin) {
        if (!proof?.provider || !proof?.order_id || !proof?.payment_id) {
          return errorResponse("Payment is required to activate this plan", 402);
        }
        // Prevent replay
        const lookupKey = String(proof.payment_id).trim();
        const { data: existingTx } = await supabase
          .from("transactions")
          .select("*")
          .eq("payment_id", lookupKey)
          .maybeSingle();
        if (existingTx) {
          return errorResponse("This payment has already been used", 409);
        }

        let settlement: any;
        try {
          if (proof.provider === "razorpay") {
            const expectedInr = plan.priceInr;
            settlement = await verifyRazorpayPayment(proof, expectedInr);
          } else if (proof.provider === "paypal") {
            const expectedUsd = plan.priceUsd;
            settlement = await verifyPayPalPayment(proof, expectedUsd);
          } else {
            return errorResponse("Unsupported payment provider", 400);
          }
        } catch (e: any) {
          return errorResponse(e?.message || "Payment verification failed", 402);
        }

        // Verify amount matches plan
        if (proof.provider === "razorpay" && Math.abs((settlement.amount || 0) - plan.priceInr) > 0.01) {
          return errorResponse("Payment amount does not match the selected plan", 400);
        }
        if (proof.provider === "paypal" && Math.abs((settlement.amount || 0) - plan.priceUsd) > 0.01) {
          return errorResponse("Payment amount does not match the selected plan", 400);
        }

        // Record transaction
        try {
          await supabase.from("transactions").insert([
            {
              client_name: name || email,
              client_email: email,
              payment_id: settlement.paymentId || lookupKey,
              provider: proof.provider,
              product_name: `ReportCard Studio - ${plan.name}`,
              amount: settlement.amount,
              currency: proof.provider === "paypal" ? "USD" : "INR",
              status: "paid",
            },
          ]);
        } catch (e: any) {
          console.error("Failed to record subscription transaction", e?.message);
        }
      }

      const startedAt = new Date();
      const expiresAt = addMonths(startedAt, plan.durationMonths);

      const { data: existingSub } = await supabase
        .from("studio_subscriptions")
        .select("*")
        .eq("email", email)
        .maybeSingle();

      if (existingSub && existingSub.status === "active" && new Date(existingSub.expires_at) > new Date()) {
        if (isPaid && !admin && !proof) {
          return errorResponse("Subscription already active", 409);
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
            admin_granted: admin && isPaid ? true : (admin ? true : false),
            ip: ip || null,
            updated_at: startedAt.toISOString(),
          },
        ],
        { onConflict: "email" },
      );

      if (error) {
        console.error("subscribe failed:", error.message);
        return errorResponse("Could not activate the subscription", 500);
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

          const sent = await sendEmail({ to: email, subject: rendered.subject, html: rendered.html });
          await supabase.from("email_log").insert([
            {
              template: "subscription",
              to_email: email,
              subject: rendered.subject,
              status: sent ? "sent" : "failed",
              ip: ip || null,
            },
          ]).catch(() => {});

          for (const adminEmail of adminNotifyEmails()) {
            if (adminEmail === email) continue;
            const copy = subscriptionEmail({
              name: name || email,
              planName: `${plan.name} · ${email}`,
              amount,
              durationMonths: plan.durationMonths,
              expiresAt: expiresAt.toDateString(),
            });
            const stored = await sendEmail({
              to: adminEmail,
              subject: `[Admin copy] ${copy.subject}`,
              html: copy.html,
            });
            await supabase.from("email_log").insert([
              {
                template: "subscription_admin_copy",
                to_email: adminEmail,
                subject: copy.subject,
                status: stored ? "sent" : "failed",
                ip: ip || null,
              },
            ]).catch(() => {});
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

    return errorResponse("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("entitlement failed:", message);
    return errorResponse(message, 500);
  }
});