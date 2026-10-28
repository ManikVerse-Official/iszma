/**
 * Owner/staff email helpers.
 *
 * Authentication lives in `adminAccess.ts`: it verifies the caller's Supabase
 * JWT and reads `admin_users`. This module only answers two questions that are
 * not authentication at all:
 *
 *   • which addresses receive the owner copies of receipts / notices
 *     (`ADMIN_NOTIFY_EMAIL`, falling back to `ADMIN_EMAILS`);
 *   • whether an email — that the caller MUST have obtained from a verified
 *     session or a database row, never from a request body — is on the staff
 *     allowlist.
 *
 * The previous `isAdminRequest(email, ip)` helper is deliberately gone: it
 * granted unlimited use to whoever sent `admin@ishmaverse.com` in the body, and
 * to every visitor behind an allow-listed IP address. Admin access is now
 * identity-based only (see `resolveAdminAccess`).
 *
 *   supabase secrets set ADMIN_EMAILS="you@school.com,admin@ishmaverse.com" \
 *                        ADMIN_NOTIFY_EMAIL="you@school.com"
 */

import { adminEmailAllowlist, isAllowlistedAdminEmail } from "./adminPolicy.ts";

const parseList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

/** Where copies of customer receipts and any subscription warnings are sent. */
export const adminNotifyEmails = (): string[] => {
  const notify = parseList(Deno.env.get("ADMIN_NOTIFY_EMAIL")).map((e) => e.toLowerCase());
  return notify.length > 0 ? notify : adminEmailAllowlist();
};

/** The staff allowlist (lower-cased). Never use it as an authentication result. */
export const adminEmails = (): string[] => adminEmailAllowlist();

/**
 * True when a VERIFIED email is on the staff allowlist.
 *
 * Only pass an email that came from a verified Supabase session (or from
 * `admin_users`); passing a request-body address would reintroduce the bypass
 * this replaced.
 */
export const isAdminEmail = (verifiedEmail: string): boolean =>
  isAllowlistedAdminEmail(verifiedEmail);
