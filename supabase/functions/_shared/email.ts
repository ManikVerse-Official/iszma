// Transactional email via Resend. Optional: when RESEND_API_KEY is not set the
// helper no-ops and callers simply skip the email (the receipt is still issued).
//
// Secrets to set: RESEND_API_KEY, and optionally RECEIPT_FROM_EMAIL
// (defaults to Resend's onboarding sender, which only works for testing).

import { emailRetryDelayMs, shouldRetryEmail } from "./receiptsCore.ts";

export interface EmailInput {
  to: string;
  subject: string;
  html: string;
}

/**
 * One delivery result. `retryable` is true only for failures another attempt can
 * plausibly fix: a network error, a 429, or a 5xx. A 4xx rejection (bad address,
 * unverified sender) and missing configuration are terminal.
 */
export interface EmailOutcome {
  ok: boolean;
  status: "sent" | "unconfigured" | "no_recipient" | "rejected" | "transport";
  httpStatus?: number;
  /** Short provider message, never a credential. */
  error?: string;
  retryable: boolean;
}

export const isEmailConfigured = (): boolean => Boolean(Deno.env.get("RESEND_API_KEY"));

export const defaultFromAddress = (): string =>
  Deno.env.get("RECEIPT_FROM_EMAIL") ?? "isZma <onboarding@resend.dev>";

/** Sends an HTML email and reports exactly what happened. */
export const sendEmailDetailed = async ({ to, subject, html }: EmailInput): Promise<EmailOutcome> => {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    return { ok: false, status: "unconfigured", retryable: false };
  }
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, status: "no_recipient", retryable: false };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: defaultFromAddress(), to: [to], subject, html }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.text();
        detail = body.slice(0, 300);
      } catch {
        /* the status is enough */
      }
      console.error("Resend rejected the email:", response.status, detail);

      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        status: "rejected",
        httpStatus: response.status,
        error: detail || `HTTP ${response.status}`,
        retryable,
      };
    }
    return { ok: true, status: "sent", httpStatus: response.status, retryable: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown transport error";
    console.error("Email send failed:", message);
    return { ok: false, status: "transport", error: message, retryable: true };
  }
};

/** Backwards-compatible boolean helper used by the existing callers. */
export const sendEmail = async (input: EmailInput): Promise<boolean> =>
  (await sendEmailDetailed(input)).ok;

/**
 * Sends with the shared bounded-retry policy: only network/429/5xx outcomes are
 * retried, at most RECEIPT_EMAIL_MAX_ATTEMPTS times, with a short backoff.
 *
 * Used by receipts and subscription confirmations, so a transient provider blip
 * does not lose the one email that proves the purchase to the buyer.
 */
export const sendEmailWithRetry = async (
  input: EmailInput,
): Promise<{ outcome: EmailOutcome; attempts: number }> => {
  let outcome = await sendEmailDetailed(input);
  let attempts = 1;
  while (shouldRetryEmail(outcome, attempts)) {
    await new Promise((resolve) => setTimeout(resolve, emailRetryDelayMs(attempts)));
    outcome = await sendEmailDetailed(input);
    attempts += 1;
  }
  return { outcome, attempts };
};
