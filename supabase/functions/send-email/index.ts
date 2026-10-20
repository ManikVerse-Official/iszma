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
import { createAdminClient } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";
import { isEmailConfigured, sendEmail } from "../_shared/email.ts";
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
        productName: clean(merged.productName, 200) || "Ishmaverse order",
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
     * A bill with no buyer address is addressed to the owner so the record of
     * the sale is never lost. The owner address is a server secret
     * (ADMIN_NOTIFY_EMAIL), never anything the browser sent. Every other
     * template still requires a real recipient.
     */
    const ownerFallback = template === "purchase" ? (adminNotifyEmails()[0] ?? "") : "";
    const to = isEmail(requestedTo) ? requestedTo : ownerFallback;
    if (!isEmail(to)) return errorResponse("A valid recipient email is required", 400);

    // Resend not configured yet? Log and no-op so callers never break.
    if (!isEmailConfigured()) {
      await supabase.from("email_log").insert([
        { template, to_email: to, subject: rendered.subject, status: "skipped", error: "RESEND_API_KEY not set", ip },
      ]);
      return jsonResponse({ success: true, sent: false, reason: "email not configured" });
    }

    const sent = await sendEmail({ to, subject: rendered.subject, html: rendered.html });

    await supabase.from("email_log").insert([
      {
        template,
        to_email: to,
        subject: rendered.subject,
        status: sent ? "sent" : "failed",
        error: sent ? null : "Resend rejected the email",
        ip,
      },
    ]);

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
    return errorResponse(message, 500);
  }
});
