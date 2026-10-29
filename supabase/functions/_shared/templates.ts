// Transactional email templates (Resend HTML).
//
// Every template returns { subject, html }. Styling is inline because email
// clients do not support external stylesheets.
//
// House rules for anything that looks like a bill:
//   • it always carries the isZma primary 3D logo and the company line;
//   • it always renders an explicit "Cost" column — a comped (admin) order is
//     billed at the product's REAL price and a genuinely free product costs 0;
//     the word "free" is never used as a price;
//   • it is signed by the Accountant Bot · isZma (iM) and Assistant Joy;
//   • bills also carry the handwritten stamp in the bottom corner (70%, -5deg).

export interface RenderedEmail {
  subject: string;
  html: string;
}

const BRAND = "isZma";
const TAGLINE = "The Digital Mall";
/* The live deployment until the custom domain is verified and connected. */
const SITE = (Deno.env.get("PUBLIC_SITE_URL") ?? Deno.env.get("SITE_URL") ?? "https://ishmaverse.vercel.app")
  .replace(/\/+$/, "");
const ACCENT = "#8b5cf6";

/** Company logo used in the email header. Overridable with BRAND_LOGO_URL. */
const LOGO_URL = Deno.env.get("BRAND_LOGO_URL") ?? `${SITE}/logos/iszma-primary-logo.png`;

/** Handwritten stamp for bill corners. Overridable with BRAND_STAMP_URL. */
const STAMP_URL = Deno.env.get("BRAND_STAMP_URL") ?? `${SITE}/logos/iszma-stamp-logo.png`;

/** Where customers reply. Shown in every footer. */
const SUPPORT_EMAIL = Deno.env.get("SUPPORT_EMAIL") ?? "support@ishmaverse.com";

const escapeHtml = (value: unknown): string =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Formats a money amount. A zero/empty amount is billed as the currency's 0 — never "free". */
export const formatCost = (amount: string | number | undefined, symbol = "₹"): string => {
  if (typeof amount === "number" && Number.isFinite(amount)) {
    return `${symbol}${amount.toLocaleString("en-IN", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }
  const text = String(amount ?? "").trim();
  if (!text) return `${symbol}0.00`;
  if (/^(rs\.?|₹|\$|inr|usd)\s*0(\.0+)?$/i.test(text)) return `${symbol}0.00`;
  return text;
};

const layout = (
  title: string,
  body: string,
  options: { eyebrow?: string; stamp?: boolean } = {},
): string => `
<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0f0a1e;font-family:Inter,Arial,Helvetica,sans-serif;">
    <div style="max-width:600px;margin:0 auto;padding:28px 16px;">
      <table role="presentation" style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="vertical-align:middle;padding-bottom:18px;">
            <img src="${LOGO_URL}" alt="${BRAND}" width="40" height="40" style="display:inline-block;vertical-align:middle;border-radius:9px;border:0;" />
            <span style="display:inline-block;vertical-align:middle;margin-left:10px;">
              <span style="display:block;font-size:22px;font-weight:800;letter-spacing:0.5px;color:#ffffff;">${BRAND}</span>
              <span style="display:block;margin-top:2px;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#a78bfa;">${TAGLINE}</span>
            </span>
          </td>
          <td style="text-align:right;vertical-align:middle;padding-bottom:18px;color:#7c7a8c;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;">
            ${escapeHtml(options.eyebrow ?? TAGLINE)}
          </td>
        </tr>
      </table>
      <div style="background:#160f2c;border:1px solid rgba(139,92,246,0.35);border-radius:18px;padding:28px;">
        <h1 style="margin:0 0 14px;font-size:20px;color:#ffffff;">${title}</h1>
        ${body}
      </div>
      ${
        options.stamp
          ? `<div style="text-align:right;margin:14px 6px 0;">
        <div style="display:inline-block;border:2px solid rgba(167,139,250,0.45);border-radius:12px;padding:7px 10px;transform:rotate(-5deg);">
          <img src="${STAMP_URL}" alt="${BRAND} stamp" width="92" style="display:block;opacity:0.7;border:0;" />
        </div>
      </div>`
          : ""
      }
      <p style="text-align:center;color:#7c7a8c;font-size:12px;margin-top:20px;line-height:1.7;">
        © ${new Date().getFullYear()} ${BRAND} · ${TAGLINE} · <a href="${SITE}" style="color:${ACCENT};text-decoration:none;">${SITE.replace(/^https?:\/\//, "")}</a><br />
        <span style="color:#635f78;">Issued by the Accountant Bot · ${BRAND} (iM) · Assistant Joy · ${escapeHtml(SUPPORT_EMAIL)}</span>
      </p>
    </div>
  </body>
</html>`;

const para = (text: string): string =>
  `<p style="margin:0 0 12px;color:#d7d3e6;font-size:14px;line-height:1.6;">${text}</p>`;

const button = (href: string, label: string): string => `
  <div style="text-align:center;margin:22px 0 6px;">
    <a href="${href}" style="display:inline-block;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 26px;border-radius:12px;">${label}</a>
  </div>`;

/** One label/value row of a bill summary. */
const summaryRow = (label: string, value: string, strong = false): string => `
  <tr>
    <td style="padding:7px 0;color:#9a95b5;font-size:13px;">${label}</td>
    <td style="padding:7px 0;color:#ffffff;font-size:13px;text-align:right;font-weight:${strong ? 700 : 600};">${value}</td>
  </tr>`;

/**
 * The itemised cost table shared by every bill.
 *
 * `Cost` is always printed — there is no "free" wording. A free product is
 * simply ₹0.00; a comped (admin) order still shows the product's real price.
 */
const costTable = (
  items: { description: string; cost: string }[],
  total: string,
): string => `
  <table style="width:100%;border-collapse:collapse;margin:10px 0 0;border-top:1px solid rgba(139,92,246,0.3);">
    <thead>
      <tr>
        <th style="text-align:left;padding:8px 0;color:#9a95b5;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Item</th>
        <th style="text-align:right;padding:8px 0;color:#9a95b5;font-size:11px;text-transform:uppercase;letter-spacing:1px;font-weight:600;">Cost</th>
      </tr>
    </thead>
    <tbody>
      ${items
        .map(
          (item) => `
      <tr>
        <td style="padding:9px 0;color:#ffffff;font-size:13px;border-top:1px solid rgba(139,92,246,0.18);">${escapeHtml(item.description)}</td>
        <td style="padding:9px 0;color:#ffffff;font-size:13px;text-align:right;border-top:1px solid rgba(139,92,246,0.18);font-weight:600;">${escapeHtml(item.cost)}</td>
      </tr>`,
        )
        .join("")}
    </tbody>
  </table>
  <table style="width:100%;border-collapse:collapse;margin-top:6px;border-top:1px solid rgba(139,92,246,0.3);border-bottom:1px solid rgba(139,92,246,0.3);">
    <tr>
      <td style="padding:12px 0;color:#ffffff;font-size:15px;font-weight:700;">Total</td>
      <td style="padding:12px 0;text-align:right;font-size:18px;font-weight:800;color:#c4b5fd;">${escapeHtml(total)}</td>
    </tr>
  </table>`;

/* ------------------------------------------------------------------ */
/* Welcome — sent when a visitor signs in / creates an account          */
/* ------------------------------------------------------------------ */

export const welcomeEmail = (name: string): RenderedEmail => {
  const who = escapeHtml(name || "there");
  return {
    subject: `Welcome to ${BRAND}, ${who}! 🎉`,
    html: layout(
      `Welcome aboard, ${who}!`,
      [
        para(
          `Thank you for joining ${BRAND}. I'm <strong>Joy</strong>, your digital assistant, and I'm here to help you create greeting cards and report cards in seconds.`,
        ),
        para("Here's what you can do right away:"),
        `<ul style="margin:0 0 14px;padding-left:18px;color:#d7d3e6;font-size:14px;line-height:1.8;">
           <li>Create an animated greeting card for any occasion</li>
           <li>Generate professional school report cards from Excel</li>
           <li>Try ReportCard Studio free for your first 7 report cards</li>
         </ul>`,
        button(SITE, "Start creating"),
        para("If you ever need help, just reply to this email — Joy is listening."),
      ].join(""),
      { eyebrow: "Welcome" },
    ),
  };
};

/* ------------------------------------------------------------------ */
/* Purchase — thank-you + professional bill                             */
/* ------------------------------------------------------------------ */

export interface PurchaseDetails {
  name: string;
  productName: string;
  /** Already-formatted cost, or a number. Never the literal word "free". */
  amount: string;
  paymentId: string;
  orderDate: string;
  receiptNumber?: string;
  currency?: string;
  receiptUrl?: string;
  cardUrl?: string;
  /** True when the owner comped the order — the bill still shows real cost. */
  comped?: boolean;
}

export const purchaseEmail = (details: PurchaseDetails): RenderedEmail => {
  const name = escapeHtml(details.name || "there");
  const symbol = details.currency === "USD" ? "$" : "₹";
  const cost = formatCost(details.amount, symbol);

  /*
   * The reference is part of the subject on purpose: `send-email` dedupes a
   * repeated checkout callback by (template, recipient, subject). Without the
   * reference every bill for the same buyer had the same subject and a retry
   * could not be told apart from a second order.
   */
  const reference = details.receiptNumber || details.paymentId || "";
  return {
    subject: `Thank you for your purchase — your ${BRAND} bill${reference ? ` · ${reference}` : ""}`,
    html: layout(
      "Thank you for your purchase! 🙏",
      [
        para(
          `Dear ${name}, thank you for shopping with ${BRAND}. Your order is confirmed — this email is your bill.`,
        ),
        `<table style="width:100%;border-collapse:collapse;margin:8px 0 0;">
           ${summaryRow("Bill no.", escapeHtml(details.receiptNumber || details.paymentId || "—"))}
           ${summaryRow("Date", escapeHtml(details.orderDate))}
           ${summaryRow("Payment ID", escapeHtml(details.paymentId || "—"))}
         </table>`,
        costTable([{ description: details.productName, cost }], cost),
        details.cardUrl ? button(details.cardUrl, "Open your card") : "",
        details.receiptUrl ? button(details.receiptUrl, "View your receipt online") : "",
        para(
          "Please keep this email as your bill. Reply to this message and the Accountant Bot will help with anything billing related.",
        ),
      ].join(""),
      { eyebrow: "Bill & Receipt", stamp: true },
    ),
  };
};

/* ------------------------------------------------------------------ */
/* Subscription — ReportCard Studio plan activated                      */
/* ------------------------------------------------------------------ */

export interface SubscriptionDetails {
  name: string;
  planName: string;
  amount: string;
  durationMonths: number;
  expiresAt: string;
}

export const subscriptionEmail = (details: SubscriptionDetails): RenderedEmail => {
  const name = escapeHtml(details.name || "there");
  const cost = formatCost(details.amount);
  return {
    subject: `Your ${BRAND} ReportCard Studio plan is active ✅`,
    html: layout(
      "Your subscription is active ✅",
      [
        para(
          `Hi ${name}, thank you for subscribing to the <strong>${escapeHtml(details.planName)}</strong> plan. Unlimited report cards are unlocked for ${details.durationMonths} months.`,
        ),
        `<table style="width:100%;border-collapse:collapse;margin:8px 0 0;">
           ${summaryRow("Plan", escapeHtml(details.planName))}
           ${summaryRow("Valid until", escapeHtml(details.expiresAt))}
         </table>`,
        costTable([{ description: `${details.planName} (${details.durationMonths} months)`, cost }], cost),
        button(`${SITE}/section/reportcard-studio`, "Open ReportCard Studio"),
        para("This email is your bill. Thank you for being part of isZma!"),
      ].join(""),
      { eyebrow: "Bill & Receipt", stamp: true },
    ),
  };
};

/* ------------------------------------------------------------------ */
/* Renewal warning — sent before a plan lapses                          */
/* ------------------------------------------------------------------ */

export interface RenewalWarningDetails {
  name: string;
  planName: string;
  expiresAt: string;
  daysLeft: number;
}

export const renewalWarningEmail = (details: RenewalWarningDetails): RenderedEmail => ({
  subject: `Your ${BRAND} plan ends in ${details.daysLeft} day(s)`,
  html: layout(
    "Your plan is ending soon ⏳",
    [
      para(
        `Hi ${escapeHtml(details.name || "there")}, your <strong>${escapeHtml(details.planName)}</strong> plan expires on <strong>${escapeHtml(details.expiresAt)}</strong> — that is ${details.daysLeft} day(s) away.`,
      ),
      para(
        "Renew before it ends to keep unlimited report-card generations. If it is not renewed, the plan will switch off automatically on the expiry date.",
      ),
      button(`${SITE}/section/reportcard-studio`, "Renew your plan"),
      para("Need more time or a different plan? Just reply to this email."),
    ].join(""),
    { eyebrow: "Renewal Reminder" },
  ),
});

/* ------------------------------------------------------------------ */
/* Subscription ended — plan switched off                               */
/* ------------------------------------------------------------------ */

export const subscriptionExpiredEmail = (details: RenewalWarningDetails): RenderedEmail => ({
  subject: `Your ${BRAND} plan has ended`,
  html: layout(
    "Your plan has ended",
    [
      para(
        `Hi ${escapeHtml(details.name || "there")}, your <strong>${escapeHtml(details.planName)}</strong> plan ended on <strong>${escapeHtml(details.expiresAt)}</strong> and has been switched off.`,
      ),
      para(
        "You can still sign in and use any free generations left on your account. Renew any time to restore unlimited report cards.",
      ),
      button(`${SITE}/section/reportcard-studio`, "Renew now"),
      para("Thank you for using ReportCard Studio — we saved your school profile and data."),
    ].join(""),
    { eyebrow: "Plan Ended" },
  ),
});
