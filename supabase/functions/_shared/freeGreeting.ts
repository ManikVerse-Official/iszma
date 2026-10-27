// Shared free-greeting limit guard.
//
// The rule is **one free greeting card per email per rolling 24 hours**, plus the
// existing network caps (two distinct emails, two cards total per IP). Only the
// database can enforce that safely: two requests arriving together must not both
// see "no claim yet".
//
// So every check-and-claim happens inside the atomic `consume_free_greeting`
// function (migration 20261025_step19). This module is the thin, testable
// boundary around it: it normalises the email, passes the limits from
// `FREE_LIMITS`, turns the database result into a typed decision, and can give a
// claim back if the card could not be written.
//
// Failure policy:
//   • Database/unexpected error -> USAGE_UNAVAILABLE (never "allowed").
//   • Missing IP                -> USAGE_UNAVAILABLE (fail closed, documented).
//   • Limit reached             -> FREE_LIMIT_EMAIL / FREE_LIMIT_NETWORK.
// No call site may create a card unless this returned `allowed: true`.

import { FREE_LIMITS } from "./plans.ts";

export const FREE_GREETING_FEATURE = "free_greeting";

export type FreeGreetingCode =
  | "FREE_LIMIT_EMAIL"
  | "FREE_LIMIT_NETWORK"
  | "USAGE_UNAVAILABLE"
  | "INVALID_REQUEST";

export interface FreeGreetingDecision {
  allowed: boolean;
  code?: FreeGreetingCode;
  /** Human-readable, safe to show in the UI. */
  message?: string;
  /** Free cards left for this email inside the current window (0 or 1). */
  remaining: number;
  /** The usage row this claim created; pass it back to release on failure. */
  claimId?: string | null;
  /** Seconds until the same email may claim again (email limit only). */
  retryAfterSeconds?: number;
}

/** Lower-cased, trimmed email — the same normalisation the database applies. */
export const normaliseEmail = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export const USAGE_UNAVAILABLE_MESSAGE =
  "We could not verify the free-card limit right now, so nothing was created. Please try again in a moment.";

export const FREE_LIMIT_EMAIL_MESSAGE =
  "This email has already claimed a free card in the last 24 hours. You can send another free card after 24 hours, or choose a paid card.";

/** Minimal client shape (keeps this module testable outside Deno). */
export interface FreeGreetingClient {
  rpc: (fn: string, args: Record<string, unknown>) => Promise<{
    data?: unknown;
    error?: { code?: string; message?: string } | null;
  }>;
}

const firstRow = (data: unknown): Record<string, unknown> | null => {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : null;
};

const toInt = (value: unknown, fallback = 0): number => {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric)
    ? Math.max(0, Math.trunc(numeric))
    : fallback;
};

/**
 * Attempts to claim the email's free-card slot.
 *
 * The decision comes from the database function, which:
 *   1. takes a transaction-scoped advisory lock on the email and on the IP,
 *   2. counts only rows created inside the rolling window,
 *   3. inserts the usage row and returns it atomically.
 */
export const claimFreeGreeting = async (
  client: FreeGreetingClient,
  rawEmail: unknown,
  ip: string,
): Promise<FreeGreetingDecision> => {
  const email = normaliseEmail(rawEmail);
  if (!email) {
    return {
      allowed: false,
      code: "INVALID_REQUEST",
      message: "Please provide a valid email address",
      remaining: 0,
    };
  }

  /*
   * Without a trustworthy network address the network caps cannot be checked.
   * Supabase always sends `x-forwarded-for`, so this only happens on a broken
   * deployment — refuse rather than hand out an unlimited free card.
   */
  if (!ip) {
    console.error("free greeting refused: no client IP available");
    return { allowed: false, code: "USAGE_UNAVAILABLE", message: USAGE_UNAVAILABLE_MESSAGE, remaining: 0 };
  }

  const limit = FREE_LIMITS[FREE_GREETING_FEATURE];
  if (!limit) {
    console.error("free greeting refused: no FREE_LIMITS entry for", FREE_GREETING_FEATURE);
    return { allowed: false, code: "USAGE_UNAVAILABLE", message: USAGE_UNAVAILABLE_MESSAGE, remaining: 0 };
  }

  try {
    const { data, error } = await client.rpc("consume_free_greeting", {
      p_email: email,
      p_ip: ip,
      p_per_email: limit.perEmail,
      p_per_ip_emails: limit.perIpEmails,
      p_per_ip_total: limit.perIpTotal,
      p_window_hours: limit.windowHours ?? 24,
    });

    if (error) {
      /* Never include the email/IP or a raw database message in the response. */
      console.error(
        "consume_free_greeting failed:",
        error.code ?? "unknown",
        String(error.message ?? "").slice(0, 160),
      );
      return { allowed: false, code: "USAGE_UNAVAILABLE", message: USAGE_UNAVAILABLE_MESSAGE, remaining: 0 };
    }

    const row = firstRow(data);
    if (!row || typeof row.allowed !== "boolean") {
      console.error("consume_free_greeting returned no decision");
      return { allowed: false, code: "USAGE_UNAVAILABLE", message: USAGE_UNAVAILABLE_MESSAGE, remaining: 0 };
    }

    if (row.allowed) {
      return {
        allowed: true,
        remaining: toInt(row.remaining, 0),
        claimId: typeof row.claim_id === "string" ? row.claim_id : null,
      };
    }

    const code: FreeGreetingCode =
      row.code === "FREE_LIMIT_EMAIL" || row.code === "FREE_LIMIT_NETWORK" || row.code === "INVALID_REQUEST"
        ? row.code
        : "USAGE_UNAVAILABLE";
    const fallback =
      code === "FREE_LIMIT_EMAIL"
        ? FREE_LIMIT_EMAIL_MESSAGE
        : code === "FREE_LIMIT_NETWORK"
          ? "This network has already used its free allowance. Please subscribe to continue."
          : USAGE_UNAVAILABLE_MESSAGE;

    return {
      allowed: false,
      code,
      message: typeof row.message === "string" && row.message.trim() ? row.message : fallback,
      remaining: 0,
      retryAfterSeconds:
        toInt(row.retry_after_seconds, 0) > 0 ? toInt(row.retry_after_seconds, 0) : undefined,
    };
  } catch (error) {
    console.error(
      "consume_free_greeting threw:",
      error instanceof Error ? error.message.slice(0, 160) : "unknown",
    );
    return { allowed: false, code: "USAGE_UNAVAILABLE", message: USAGE_UNAVAILABLE_MESSAGE, remaining: 0 };
  }
};

/**
 * Gives a claim back when the card itself could not be written.
 *
 * The usage row is what blocks the next attempt, so without this a failed insert
 * would silently burn the user's free card for 24 hours. Best-effort by design:
 * the caller still reports the (real) failure.
 */
export const releaseFreeGreetingClaim = async (
  client: FreeGreetingClient,
  claimId: string | null | undefined,
): Promise<void> => {
  if (!claimId) return;
  try {
    const { error } = await client.rpc("release_free_greeting_claim", { p_claim_id: claimId });
    if (error) {
      console.error("release_free_greeting_claim failed:", error.code ?? "unknown");
    }
  } catch (error) {
    console.error(
      "release_free_greeting_claim threw:",
      error instanceof Error ? error.message.slice(0, 120) : "unknown",
    );
  }
};

/**
 * HTTP status for a denial.
 *
 * A reached limit is 429 (compatible with the existing client), an unverifiable
 * limit is 503 — retryable and explicitly NOT a reached limit, and bad input is
 * 400. The response body always carries `code`, so the UI never has to guess
 * from the status alone.
 */
export const freeGreetingStatus = (code: FreeGreetingCode | undefined): number => {
  if (code === "FREE_LIMIT_EMAIL" || code === "FREE_LIMIT_NETWORK") return 429;
  if (code === "USAGE_UNAVAILABLE") return 503;
  return 400;
};
