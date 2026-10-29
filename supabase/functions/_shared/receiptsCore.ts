// Pure receipt rules — no Deno APIs, no network.
//
// Kept separate from `receipts.ts` so the receipt number, money formatting, HTML
// escaping and the email-retry policy can be tested under Node
// (scripts/check-receipts.ts) without importing the Supabase client.
//
// The rule that matters: a receipt is only ever built from a row that already
// exists in the transactions ledger, and that ledger row is only written after
// the server has verified the payment with the gateway.

export interface ReceiptLedgerRow {
  id: string;
  client_name: string;
  client_email: string | null;
  payment_id: string;
  provider: string;
  product_name: string;
  amount: number;
  currency: string;
  status: string;
  created_at: string;
}

export interface ReceiptBranding {
  /** Absolute URL of the primary 3D logo, printed in the header. */
  logoUrl: string;
  /** Absolute URL of the handwritten stamp, printed in the bottom corner. */
  stampUrl: string;
  /** Billing contact printed in the footer. */
  supportEmail: string;
  /** Optional private management link for the card behind the purchase. */
  manageUrl?: string;
}

/** Escape every value interpolated into the receipt HTML. */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Formats a receipt cost. A zero amount prints as 0.00 in the currency — the
 * word "free" is never used as a price, so a comped order still reads like a
 * real bill.
 */
export const formatMoney = (amount: number, currency: string): string => {
  const symbol = currency === "USD" ? "$" : "₹";
  const value = Number.isFinite(amount) ? amount : 0;
  return `${symbol}${value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

/**
 * Stable human receipt number derived from the ledger row.
 *
 * It is intentionally derived from the transaction id (not random) so the same
 * sale always asks for the same receipt number; `receipts.receipt_number` is
 * UNIQUE, which is the database-level idempotency guard behind this.
 */
export const buildReceiptNumber = (row: Pick<ReceiptLedgerRow, "id" | "created_at">): string =>
  `ISH-${new Date(row.created_at).getUTCFullYear()}-${row.id
    .replace(/-/g, "")
    .slice(0, 6)
    .toUpperCase()}`;

/** The complete, self-contained printable receipt document. */
export const buildReceiptHtml = (
  row: ReceiptLedgerRow,
  receiptNumber: string,
  issuedAt: string,
  branding: ReceiptBranding,
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Receipt ${escapeHtml(receiptNumber)} · isZma</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px; font-family: 'Segoe UI', Roboto, sans-serif; background: #0b0514; color: #f4f1ff; }
  .card { position: relative; max-width: 620px; margin: 0 auto; background: linear-gradient(160deg, #1a0b2e, #0f0718); border: 1px solid rgba(139,92,246,0.45); border-radius: 20px; padding: 32px 32px 118px; box-shadow: 0 24px 60px rgba(139,92,246,0.25); }
  .stamp { position: absolute; right: 26px; bottom: 22px; border: 2px solid rgba(167,139,250,0.5); border-radius: 12px; padding: 8px 10px; transform: rotate(-5deg); opacity: 0.7; }
  .brand { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
  .brand h1 { font-size: 22px; margin: 0; letter-spacing: 0.02em; background: linear-gradient(90deg,#a78bfa,#f0abfc); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .tagline { display: block; margin-top: 2px; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: #a39bc4; }
  .logo-row { display: flex; align-items: center; gap: 12px; }
  .logo-row img { border-radius: 10px; display: block; }
  .issuer { display: flex; flex-direction: column; gap: 2px; padding-bottom: 10px; margin-bottom: 10px; border-bottom: 1px solid rgba(139,92,246,0.2); }
  .issuer strong { color: #d7d3e6; font-size: 12px; letter-spacing: 0.04em; }
  .issuer span { color: #8b83a8; font-size: 11px; }
  .badge { font-size: 11px; text-transform: uppercase; letter-spacing: 0.14em; padding: 6px 12px; border-radius: 999px; background: rgba(16,185,129,0.15); color: #6ee7b7; border: 1px solid rgba(16,185,129,0.4); }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 24px; font-size: 13px; margin-bottom: 24px; }
  .meta span { display: block; color: #a39bc4; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { padding: 12px 0; text-align: left; border-bottom: 1px solid rgba(139,92,246,0.2); }
  th { color: #a39bc4; font-weight: 500; font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; }
  td.amount, th.amount { text-align: right; }
  .total { display: flex; justify-content: space-between; align-items: baseline; margin-top: 20px; font-size: 20px; font-weight: 700; }
  .total strong { background: linear-gradient(90deg,#c4b5fd,#f0abfc); -webkit-background-clip: text; background-clip: text; color: transparent; }
  footer { margin-top: 28px; font-size: 12px; color: #7c7496; line-height: 1.6; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="logo-row">
        <img src="${escapeHtml(branding.logoUrl)}" alt="isZma" width="40" height="40" />
        <div>
          <h1>isZma</h1>
          <span class="tagline">The Digital Mall</span>
        </div>
      </div>
      <span class="badge">Bill &amp; Receipt</span>
    </div>
    <div class="meta">
      <div><span>Receipt no.</span>${escapeHtml(receiptNumber)}</div>
      <div><span>Issued</span>${escapeHtml(new Date(issuedAt).toLocaleString("en-IN"))}</div>
      <div><span>Billed to</span>${escapeHtml(row.client_name)}</div>
      <div><span>Email</span>${escapeHtml(row.client_email ?? "—")}</div>
      <div><span>Payment method</span>${escapeHtml(row.provider)}</div>
      <div><span>Payment reference</span>${escapeHtml(row.payment_id)}</div>
    </div>
    <table>
      <thead>
        <tr><th>Item</th><th class="amount">Cost</th></tr>
      </thead>
      <tbody>
        <tr>
          <td>${escapeHtml(row.product_name)}</td>
          <td class="amount">${escapeHtml(formatMoney(Number(row.amount), row.currency))}</td>
        </tr>
      </tbody>
    </table>
    <div class="total">
      <span>Total</span>
      <strong>${escapeHtml(formatMoney(Number(row.amount), row.currency))}</strong>
    </div>
    <footer>
      <div class="issuer">
        <strong>Accountant Bot · isZma (iM)</strong>
        <span>Assistant Joy · ${escapeHtml(branding.supportEmail)}</span>
      </div>
      Transaction ID: ${escapeHtml(row.id)}<br />
      This receipt was generated automatically by isZma. Digital greeting cards
      remain live for 48 hours from creation.<br />
      ${
        branding.manageUrl
          ? `Need to take it down early? <a href="${escapeHtml(
              branding.manageUrl,
            )}" style="color:#f0abfc;font-weight:600">Manage or delete your card here</a>.<br />`
          : ""
      }
      Questions? Reply to this email and our team will help.
    </footer>
    <div class="stamp" aria-label="isZma stamp">
      <img src="${escapeHtml(branding.stampUrl)}" alt="isZma handwritten stamp" width="108" height="72" style="display:block;" />
    </div>
  </div>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* Email delivery policy                                              */
/* ------------------------------------------------------------------ */

export type EmailAttemptStatus =
  | "sent"
  | "unconfigured"
  | "no_recipient"
  | "rejected"
  | "transport";

/** The subset of the email helper's result this module depends on. */
export interface EmailAttempt {
  ok: boolean;
  status: EmailAttemptStatus;
  httpStatus?: number;
  error?: string;
  retryable: boolean;
}

/** How many times one receipt email may be attempted in a single request. */
export const RECEIPT_EMAIL_MAX_ATTEMPTS = 3;

/**
 * True only when another attempt can plausibly succeed.
 *
 * A missing API key, a missing recipient and a 4xx rejection (bad address,
 * unverified sender) are terminal: retrying them would only delay the response
 * and spam the log. Network errors, 429 and 5xx are retried with backoff.
 */
export const shouldRetryEmail = (attempt: EmailAttempt, attemptNumber: number): boolean => {
  if (attempt.ok) return false;
  if (attemptNumber >= RECEIPT_EMAIL_MAX_ATTEMPTS) return false;
  if (!attempt.retryable) return false;
  if (attempt.status === "unconfigured" || attempt.status === "no_recipient") return false;
  if (attempt.httpStatus === 429) return true;
  if (typeof attempt.httpStatus === "number" && attempt.httpStatus >= 400 && attempt.httpStatus < 500) {
    return false;
  }
  return true;
};

/** Backoff between attempts: 250ms, then 750ms. */
export const emailRetryDelayMs = (attemptNumber: number): number =>
  attemptNumber <= 1 ? 250 : 750;

/**
 * The status written to `email_log` / reported to the caller.
 *
 * "skipped" is used only when email is not configured or there is no recipient;
 * it is never reported as a delivery.
 */
export const emailLogStatus = (attempt: EmailAttempt): "sent" | "failed" | "skipped" => {
  if (attempt.ok) return "sent";
  if (attempt.status === "unconfigured" || attempt.status === "no_recipient") return "skipped";
  return "failed";
};

/** A short, non-sensitive reason stored next to a failed attempt. */
export const emailFailureSummary = (attempt: EmailAttempt, attempts: number): string | null => {
  if (attempt.ok) return null;
  const labels: Record<EmailAttemptStatus, string> = {
    sent: "",
    unconfigured: "RESEND_API_KEY is not set on the server",
    no_recipient: "No valid recipient address",
    rejected: "The email provider rejected the message",
    transport: "The email provider could not be reached",
  };
  const detail = attempt.error ? `: ${attempt.error.slice(0, 200)}` : "";
  return `${labels[attempt.status] || "Email could not be sent"}${detail}${
    attempts > 1 ? ` (after ${attempts} attempts)` : ""
  }`;
};

/**
 * Extract the first error message from a failed Supabase query without
 * throwing. Used by callers that must continue after a logging failure.
 */
export const queryErrorMessage = (error: unknown): string => {
  if (!error) return "";
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error && "message" in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
};
