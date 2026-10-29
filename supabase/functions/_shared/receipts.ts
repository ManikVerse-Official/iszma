// Server-side receipt issuance.
//
// The one rule this module exists to enforce: a receipt is minted ONLY from a
// `transactions` row that was written after the gateway verified the payment —
// and it is minted on the server, so every purchase path (Razorpay, PayPal,
// Stripe, admin comp, free card) gets the same treatment even when the browser
// never comes back to the thank-you screen.
//
// Reliability properties:
//   • Idempotent. `receipts.transaction_id` (read) plus the UNIQUE
//     `receipts.receipt_number` (write) make a retried callback reuse the existing
//     receipt instead of minting a second one.
//   • Bounded retry. Only transient email failures (network / 429 / 5xx) are
//     retried, at most RECEIPT_EMAIL_MAX_ATTEMPTS times. A bad address or a
//     missing API key is recorded once and never retried.
//   • Logged. Every attempt is written to `email_log`, including the reason, so
//     a delivery failure is visible in Admin diagnostics instead of vanishing.
//   • Never throws for email problems. The purchase already succeeded; an email
//     failure must not turn a paid order into a failed one.

import { sendEmailWithRetry } from "./email.ts";
import { adminNotifyEmails } from "./admin.ts";
import {
  buildReceiptHtml,
  buildReceiptNumber,
  emailFailureSummary,
  emailLogStatus,
  type ReceiptLedgerRow,
} from "./receiptsCore.ts";

/* The Supabase client is passed in so this module has no client of its own and
 * can be used by every function (create-greeting, accountant-bot, retries). */
type DbClient = {
  from: (table: string) => any;
};

/* The live deployment until the custom domain is verified and connected. */
export const siteBaseUrl = (): string =>
  (Deno.env.get("PUBLIC_SITE_URL") ?? Deno.env.get("SITE_URL") ?? "https://ishmaverse.vercel.app").replace(
    /\/+$/,
    "",
  );

export const brandLogoUrl = (): string =>
  Deno.env.get("BRAND_LOGO_URL") ?? `${siteBaseUrl()}/logos/iszma-primary-logo.png`;

export const brandStampUrl = (): string =>
  Deno.env.get("BRAND_STAMP_URL") ?? `${siteBaseUrl()}/logos/iszma-stamp-logo.png`;

export const supportEmail = (): string =>
  Deno.env.get("SUPPORT_EMAIL") ?? "support@ishmaverse.com";

export interface ReceiptRow {
  id: string;
  receipt_number: string;
  transaction_id: string | null;
  client_name: string;
  client_email: string | null;
  product_name: string | null;
  amount: number;
  currency: string;
  payment_id: string | null;
  issued_at: string;
  payload?: unknown;
}

export interface ReceiptIssueResult {
  receipt: ReceiptRow | null;
  /** True when this call created the receipt; false when one already existed. */
  created: boolean;
  /** Complete printable document, always built from the stored receipt. */
  html: string;
  /** True only when the provider accepted the buyer's email on this call. */
  emailed: boolean;
  emailStatus: "sent" | "existing" | "skipped" | "failed";
  attempts: number;
  /** Non-sensitive delivery failure reason, for logs / the diagnostics panel. */
  error: string | null;
}

const logEmailAttempt = async (
  client: DbClient,
  entry: {
    template: string;
    to_email: string;
    subject: string;
    status: "sent" | "failed" | "skipped";
    error?: string | null;
    ip?: string | null;
  },
): Promise<void> => {
  try {
    const { error } = await client.from("email_log").insert([
      {
        template: entry.template,
        to_email: entry.to_email,
        subject: entry.subject,
        status: entry.status,
        error: entry.error ?? null,
        ip: entry.ip ?? null,
      },
    ]);
    if (error) console.error("email_log insert rejected:", error.message);
  } catch (error) {
    console.error(
      "email_log insert failed:",
      error instanceof Error ? error.message : String(error),
    );
  }
};

const readReceipt = async (
  client: DbClient,
  transactionId: string,
): Promise<ReceiptRow | null> => {
  const { data, error } = await client
    .from("receipts")
    .select("*")
    .eq("transaction_id", transactionId)
    .maybeSingle();
  if (error) {
    console.error("receipt lookup failed:", error.message);
    return null;
  }
  return (data ?? null) as ReceiptRow | null;
};

const readManageUrl = async (client: DbClient, paymentId: string): Promise<string> => {
  if (!paymentId) return "";
  const { data } = await client
    .from("greeting_cards")
    .select("management_token")
    .eq("payment_id", paymentId)
    .maybeSingle();
  return data?.management_token ? `${siteBaseUrl()}/manage/${data.management_token}` : "";
};

/**
 * Issues the receipt for a settled ledger row, and emails it.
 *
 * Safe to call repeatedly: the existing receipt is returned and NOT re-emailed,
 * so a duplicate callback cannot send a second copy. A failure is returned (and
 * logged) rather than thrown, so callers may treat the purchase as successful.
 */
export const issueReceiptForTransaction = async (
  client: DbClient,
  row: ReceiptLedgerRow,
  options: { ip?: string | null } = {},
): Promise<ReceiptIssueResult> => {
  const manageUrl = await readManageUrl(client, row.payment_id);
  const branding = {
    logoUrl: brandLogoUrl(),
    stampUrl: brandStampUrl(),
    supportEmail: supportEmail(),
    ...(manageUrl ? { manageUrl } : {}),
  };

  const existing = await readReceipt(client, row.id);
  if (existing) {
    return {
      receipt: existing,
      created: false,
      html: buildReceiptHtml(row, existing.receipt_number, existing.issued_at, branding),
      emailed: false,
      emailStatus: "existing",
      attempts: 0,
      error: null,
    };
  }

  const receiptNumber = buildReceiptNumber(row);
  const issuedAt = new Date().toISOString();
  const { data, error } = await client
    .from("receipts")
    .insert([
      {
        receipt_number: receiptNumber,
        transaction_id: row.id,
        client_name: row.client_name,
        client_email: row.client_email,
        product_name: row.product_name,
        amount: Number(row.amount),
        currency: row.currency,
        payment_id: row.payment_id,
        issued_at: issuedAt,
        payload: {
          transaction_id: row.id,
          provider: row.provider,
          line_items: [
            {
              description: row.product_name,
              amount: Number(row.amount),
              currency: row.currency,
            },
          ],
        },
      },
    ])
    .select("*")
    .single();

  /*
   * A concurrent callback can win the insert. `receipt_number` is UNIQUE, so the
   * loser sees 23505 and must return the winner's receipt — never a 500 and
   * never a second email.
   */
  if (error) {
    if (error.code === "23505") {
      const raced = await readReceipt(client, row.id);
      if (raced) {
        return {
          receipt: raced,
          created: false,
          html: buildReceiptHtml(row, raced.receipt_number, raced.issued_at, branding),
          emailed: false,
          emailStatus: "existing",
          attempts: 0,
          error: null,
        };
      }
    }
    console.error("Receipt insert failed:", error.message);
    return {
      receipt: null,
      created: false,
      html: buildReceiptHtml(row, receiptNumber, issuedAt, branding),
      emailed: false,
      emailStatus: "failed",
      attempts: 0,
      error: "Could not store the receipt.",
    };
  }

  const receipt = data as ReceiptRow;
  const html = buildReceiptHtml(row, receipt.receipt_number, receipt.issued_at, branding);
  const subject = `Your isZma receipt · ${receipt.receipt_number}`;
  const buyerEmail = (receipt.client_email ?? row.client_email ?? "").trim();

  const { outcome: attempt, attempts } = await sendEmailWithRetry({
    to: buyerEmail,
    subject,
    html,
  });
  await logEmailAttempt(client, {
    template: "receipt",
    to_email: buyerEmail || "owner-fallback",
    subject,
    status: emailLogStatus(attempt),
    error: emailFailureSummary(attempt, attempts),
    ip: options.ip ?? null,
  });

  /*
   * The owner keeps a copy of every receipt. A failure on a copy is logged but
   * never affects the buyer's receipt or the purchase result.
   */
  for (const adminEmail of adminNotifyEmails()) {
    if (adminEmail.toLowerCase() === buyerEmail.toLowerCase()) continue;
    const copySubject = `[Admin copy] ${subject} — ${row.client_name}`;
    const copy = await sendEmailWithRetry({ to: adminEmail, subject: copySubject, html });
    await logEmailAttempt(client, {
      template: "receipt_admin_copy",
      to_email: adminEmail,
      subject: copySubject,
      status: emailLogStatus(copy.outcome),
      error: emailFailureSummary(copy.outcome, copy.attempts),
      ip: options.ip ?? null,
    });
  }

  return {
    receipt,
    created: true,
    html,
    emailed: attempt.ok,
    emailStatus: attempt.ok ? "sent" : emailLogStatus(attempt) === "skipped" ? "skipped" : "failed",
    attempts,
    error: emailFailureSummary(attempt, attempts),
  };
};
