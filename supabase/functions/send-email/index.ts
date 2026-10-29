// @ts-nocheck
//
// send-email — Ishmaverse transactional email
// ---------------------------------------------------------------------------
// Sends the branded welcome / bill (purchase) / subscription / renewal emails
// through Resend and records each attempt in `email_log`.
//
// POST body:
//   {
//     template: "welcome" | "purchase" | "subscription" | "renewal_warning" | "subscription_expired",
//     to: "user@example.com",
//     name?: "Joy",
//     // purchase:
//     productName?, amount?, currency?, paymentId?, orderDate?, receiptUrl?, cardUrl?,
//     // subscription:
//     planName?, durationMonths?, expiresAt?, daysLeft?
//   }
//
// Bills always state the product's real COST (never the word "free"), and the
// owner receives a copy of every bill so nothing is sold without their knowing.
//
// Secrets to set (supabase secrets set ...):
//   RESEND_API_KEY, RECEIPT_FROM_EMAIL (optional), PUBLIC_SITE_URL (optional),
//   BRAND_LOGO_URL (optional), SUPPORT_EMAIL (optional),
//   ADMIN_NOTIFY_EMAIL (optional, defaults to ADMIN_EMAILS)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient, getUserFromRequest, isAdminUser } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";
import { isEmailConfigured, sendEmail, sendEmailDetailed } from "../_shared/email.ts";
import { adminNotifyEmails } from "../_shared/admin.ts";
import {
  purchaseEmail,
  renewalWarningEmail,
  subscriptionEmail,
  subscriptionExpiredEmail,
  welcomeEmail,
} from "../_shared/templates.ts";

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const render = (body: Record<string, unknown>, overrides: Record<string, unknown> = {}) => {
  const merged = { ...body, ...overrides };
  const name = clean(merged.name, 80);
  switch (merged.template) {
    case "welcome":
      return welcomeEmail(name);
    case "purchase":
      return purchaseEmail({
        name,
        productName: clean(merged.productName, 200) || "isZma order",
        amount: clean(merged.amount, 40),
        currency: clean(merged.currency, 8) || "INR",
        paymentId: clean(merged.paymentId, 80),
        orderDate: clean(merged.orderDate, 60) || new Date().toDateString(),
        receiptNumber: clean(merged.receiptNumber, 80) || undefined,
        receiptUrl: clean(merged.receiptUrl, 400) || undefined,
        cardUrl: clean(merged.cardUrl, 400) || undefined,
      });
    case "subscription":
      return subscriptionEmail({
        name,
        planName: clean(merged.planName, 80) || "ReportCard Studio",
        amount: clean(merged.amount, 40),
        durationMonths: Number(merged.durationMonths) || 6,
        expiresAt: clean(merged.expiresAt, 60),
      });
    case "renewal_warning":
      return renewalWarningEmail({
        name,
        planName: clean(merged.planName, 80) || "ReportCard Studio",
        expiresAt: clean(merged.expiresAt, 60),
        daysLeft: Math.max(1, Number(merged.daysLeft) || 7),
      });
    case "subscription_expired":
      return subscriptionExpiredEmail({
        name,
        planName: clean(merged.planName, 80) || "ReportCard Studio",
        expiresAt: clean(merged.expiresAt, 60),
        daysLeft: 0,
      });
    default:
      return null;
  }
};

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const ip = clientIp(req);
  const supabase = createAdminClient();

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const requestedTo = clean(body.to, 150).toLowerCase();
    const template = clean(body.template, 40);

    const rendered = render(body);
    if (!rendered) return errorResponse("Unknown email template", 400);

    /*
     * AUTHORIZATION — this function used to accept any template for any address,
     * which made it an open relay on the project's Resend account. It now needs a
     * capability that proves the request is tied to a real relationship:
     *
     *   purchase      -> the payment id must exist in the settled ledger, and the
     *                    recipient must be that order's own address (or the owner
     *                    when the order has none);
     *   welcome       -> a signed-in user, to their own verified address;
     *   subscription* -> an admin, or an address that actually has a Studio record.
     *
     * Admins (verified JWT + admin_users, never the body) may send any template.
     */
    const user = await getUserFromRequest(req);
    const admin = await isAdminUser(user?.id);
    let ledgerEmail = "";

    if (!admin) {
      if (template === "purchase") {
        const paymentId = clean(body.paymentId, 100);
        if (!paymentId) {
          return errorResponse("A payment reference is required for a purchase bill", 400);
        }
        const { data: transaction, error: txError } = await supabase
          .from("transactions")
          .select("payment_id, client_email, status")
          .eq("payment_id", paymentId)
          .maybeSingle();
        if (txError) {
          console.error("send-email ledger lookup failed:", txError.message);
          return errorResponse("Could not verify the purchase right now", 503);
        }
        if (!transaction || !["paid", "free"].includes(String(transaction.status))) {
          return errorResponse("No settled purchase matches that payment reference", 403);
        }
        ledgerEmail = String(transaction.client_email ?? "").trim().toLowerCase();
        if (requestedTo && requestedTo !== ledgerEmail) {
          return errorResponse("That address does not match the order", 403);
        }
      } else if (template === "welcome") {
        const sessionEmail = (user?.email ?? "").trim().toLowerCase();
        if (!user || !sessionEmail || requestedTo !== sessionEmail) {
          return errorResponse("Sign in to send yourself a welcome email", 401);
        }
      } else {
        if (!user) return errorResponse("A valid session is required", 401);
        const { data: subscription } = await supabase
          .from("studio_subscriptions")
          .select("email")
          .eq("email", requestedTo)
          .maybeSingle();
        if (!subscription) {
          return errorResponse("No ReportCard Studio record matches that address", 403);
        }
      }
    }

    /*
     * A bill with no buyer address is addressed to the order's own address, then
     * to the owner, so the record of the sale is never lost. The owner address is
     * a server secret (ADMIN_NOTIFY_EMAIL), never anything the browser sent.
     * Every other template still requires a real recipient.
     */
    const ownerFallback = template === "purchase" ? (adminNotifyEmails()[0] ?? "") : "";
    const to =
      template === "purchase"
        ? (isEmail(requestedTo) ? requestedTo : ledgerEmail) || ownerFallback
        : isEmail(requestedTo)
          ? requestedTo
          : "";
    if (!isEmail(to)) return errorResponse("A valid recipient email is required", 400);

    /*
     * PER-ORDER DEDUPE — a repeated checkout callback re-runs the same bill. The
     * bill's subject carries its payment reference, so a delivered bill for this
     * order is found and skipped instead of mailed again. A failed attempt is not
     * skipped: it may be retried.
     */
    if (template === "purchase") {
      const { data: alreadySent } = await supabase
        .from("email_log")
        .select("id")
        .eq("template", "purchase")
        .eq("to_email", to)
        .eq("subject", rendered.subject)
        .eq("status", "sent")
        .limit(1)
        .maybeSingle();
      if (alreadySent) {
        return jsonResponse({ success: true, sent: false, skipped: true, reason: "already sent for this order" });
      }
    }

    /*
     * ABUSE GUARD — even a caller holding a real payment id should not be able to
     * mail the same address in a loop. Five emails per address per ten minutes is
     * generous for real checkouts and useless for spam.
     */
    const windowStart = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const { count: recentEmails } = await supabase
      .from("email_log")
      .select("*", { count: "exact", head: true })
      .eq("to_email", to)
      .gte("created_at", windowStart);
    if ((recentEmails ?? 0) >= 5) {
      return errorResponse("Too many emails to this address. Please wait a few minutes.", 429);
    }

    // Resend not configured yet? Log and no-op so callers never break.
    if (!isEmailConfigured()) {
      await supabase.from("email_log").insert([
        { template, to_email: to, subject: rendered.subject, status: "skipped", error: "RESEND_API_KEY not set", ip },
      ]);
      return jsonResponse({ success: true, sent: false, reason: "email not configured" });
    }

    const outcome = await sendEmailDetailed({ to, subject: rendered.subject, html: rendered.html });
    const sent = outcome.ok;

    const { error: logError } = await supabase.from("email_log").insert([
      {
        template,
        to_email: to,
        subject: rendered.subject,
        status: sent ? "sent" : "failed",
        error: sent ? null : (outcome.error ?? "Resend rejected the email").slice(0, 300),
        ip,
      },
    ]);
    /*
     * The email was already handed to Resend, so a failed log insert must not be
     * reported as a failed send. It is surfaced in the function logs (and the
     * dedupe/rate-limit queries will not see this row).
     */
    if (logError) console.error("email_log insert failed:", logError.message);

    /*
     * The owner gets a copy of every bill, so a comped or discounted sale is
     * always visible. The copy is clearly marked and never replaces the
     * customer's own email.
     */
    if (template === "purchase") {
      for (const adminEmail of adminNotifyEmails()) {
        if (adminEmail === to) continue;
        const copy = render(body, { name: `Admin (for ${to})` });
        if (!copy) continue;
        const stored = await sendEmail({
          to: adminEmail,
          subject: `[Admin copy] ${copy.subject}`,
          html: copy.html,
        });
        await supabase.from("email_log").insert([
          {
            template: "purchase_admin_copy",
            to_email: adminEmail,
            subject: copy.subject,
            status: stored ? "sent" : "failed",
            ip,
          },
        ]);
      }
    }

    return jsonResponse({ success: true, sent });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("send-email failed:", message);
    // Never echo a provider/database error to a public caller.
    return errorResponse("The email could not be sent right now.", 500);
  }
});
