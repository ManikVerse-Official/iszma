/**
 * The ONE admin check every Ishmaverse section shares.
 *
 * An admin is a real Supabase Auth user whose `user_id` is listed (and active) in
 * `admin_users`, verified on the server from the request's own JWT:
 *
 *   • the email in the request body is ignored — it used to be enough to claim
 *     `admin@ishmaverse.com` and become unlimited;
 *   • a client-side `isAdmin` flag, localStorage value or hidden button does
 *     nothing, because this module never reads the request body at all;
 *   • the IP address is NOT an identity. (The old `ADMIN_IPS` bypass treated
 *     every visitor behind that network as the owner.)
 *
 * The `ADMIN_EMAILS` allowlist is still honoured, but only when it matches an
 * email that came from a VERIFIED Supabase session — a convenience for a fresh
 * deployment where `admin_users` has not been seeded, not a second door.
 *
 * The decision rule lives in `adminPolicy.ts` (pure, unit-tested); this module
 * only does the two things that need the network: verify the JWT and read
 * `admin_users`.
 *
 * Admin access means: no charge, no subscription and no usage limit. Callers
 * treat a false result as the default.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.2";
import { createAdminClient } from "./auth.ts";
import {
  adminEmailAllowlist,
  decideAdminAccess,
  isAllowlistedAdminEmail,
  type AdminAccess,
} from "./adminPolicy.ts";

export type { AdminAccess, AdminSource } from "./adminPolicy.ts";
export { adminEmailAllowlist, isAllowlistedAdminEmail };

const bearerToken = (req: Request): string => {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

const DENIED: AdminAccess = {
  isAdmin: false,
  userId: null,
  email: "",
  source: "none",
  reason: "No verified session",
};

/**
 * Reads the admin membership row for a verified user.
 *
 * `admin_users` gained an `is_active` flag in step 14. A database that has not
 * been migrated yet is retried without that column, so an older deployment is
 * not locked out of its own admin area.
 */
const membershipActive = async (
  client: SupabaseClient,
  userId: string,
): Promise<boolean> => {
  const { data, error } = await client
    .from("admin_users")
    .select("user_id, is_active")
    .eq("user_id", userId)
    .maybeSingle();

  if (!error) {
    if (!data) return false;
    return (data as { is_active?: boolean | null }).is_active !== false;
  }

  const { data: fallback, error: fallbackError } = await client
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (fallbackError) {
    console.error("admin_users lookup failed:", fallbackError.message);
    return false;
  }
  return Boolean(fallback);
};

/**
 * Verifies the request's session and returns the admin decision.
 *
 * Pass an existing service-role client when the caller already has one. This
 * never throws: any failure is a denial.
 */
export const resolveAdminAccess = async (
  req: Request,
  client: SupabaseClient = createAdminClient(),
): Promise<AdminAccess> => {
  const token = bearerToken(req);
  if (!token) return DENIED;

  try {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) {
      /*
       * Common and expected: the Studio's anonymous key is a valid Supabase key
       * but not a user session, so `getUser` rejects it. That is a denial, not a
       * server fault.
       */
      return { ...DENIED, reason: "Session could not be verified" };
    }

    const user = data.user;
    return decideAdminAccess({
      userId: user.id,
      email: user.email ?? "",
      membershipActive: await membershipActive(client, user.id),
    });
  } catch (error) {
    console.error(
      "admin access check failed:",
      error instanceof Error ? error.message.slice(0, 160) : "unknown",
    );
    return { ...DENIED, reason: "Admin check failed" };
  }
};
