/**
 * The admin decision itself, with no I/O.
 *
 * `adminAccess.ts` does the two things that need the network — verify the JWT,
 * and read `admin_users` — and then hands the outcome to `decideAdminAccess`
 * here. Keeping the rule pure means the policy (including "never trust the
 * request body") is unit-testable in plain Node, without a Supabase client.
 *
 * Rule, in order:
 *   1. no verified session -> not an admin, whatever the caller claims;
 *   2. a row in `admin_users` (and not deactivated) -> admin;
 *   3. an allow-listed email that came from the VERIFIED session -> admin.
 * Anything else is a normal user.
 */

export type AdminSource = "admin_users" | "verified_email" | "none";

export interface AdminAccess {
  isAdmin: boolean;
  userId: string | null;
  email: string;
  source: AdminSource;
  reason?: string;
}

/** Owner/staff addresses accepted when they match a VERIFIED session email. */
export const adminEmailAllowlist = (
  raw: string | undefined = (globalThis as { Deno?: { env?: { get(name: string): string | undefined } } })
    .Deno?.env?.get("ADMIN_EMAILS"),
): string[] => {
  const configured = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return configured.length > 0 ? configured : ["admin@ishmaverse.com"];
};

export const isAllowlistedAdminEmail = (
  verifiedEmail: string,
  rawAllowlist?: string,
): boolean => {
  const email = (verifiedEmail ?? "").trim().toLowerCase();
  return Boolean(email) && adminEmailAllowlist(rawAllowlist).includes(email);
};

export interface AdminAccessInput {
  /** The Supabase user resolved from the request's JWT (null when anonymous). */
  userId: string | null;
  /** Email from the VERIFIED session — never the request body. */
  email: string;
  /** Whether `admin_users` has an active row for this user. */
  membershipActive: boolean;
  /** Override for tests; defaults to the `ADMIN_EMAILS` secret. */
  allowlistRaw?: string;
}

export const decideAdminAccess = (input: AdminAccessInput): AdminAccess => {
  const email = (input.email ?? "").trim().toLowerCase();

  if (!input.userId) {
    return {
      isAdmin: false,
      userId: null,
      email: "",
      source: "none",
      reason: "No verified session",
    };
  }

  if (input.membershipActive) {
    return { isAdmin: true, userId: input.userId, email, source: "admin_users" };
  }

  if (isAllowlistedAdminEmail(email, input.allowlistRaw)) {
    return { isAdmin: true, userId: input.userId, email, source: "verified_email" };
  }

  return {
    isAdmin: false,
    userId: input.userId,
    email,
    source: "none",
    reason: "Signed-in account is not an administrator",
  };
};
