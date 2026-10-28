import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.2";

/** Service-role client. Never returns user-scoped data to the browser directly. */
export const createAdminClient = (): SupabaseClient =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } },
  );

const bearerToken = (req: Request): string => {
  const header = req.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
};

/**
 * Resolves the authenticated user behind a request. Returns null for anonymous
 * callers (e.g. the anon key used while logged out).
 */
export const getUserFromRequest = async (req: Request) => {
  const token = bearerToken(req);
  if (!token) return null;
  const client = createAdminClient();
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
};

/** Server-side admin membership check — the real security boundary. */
export const isAdminUser = async (userId: string | undefined): Promise<boolean> => {
  if (!userId) return false;
  const client = createAdminClient();
  const { data, error } = await client
    .from("admin_users")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();
  return !error && Boolean(data);
};

/**
 * Constant-time-ish hex string comparison to reduce signature timing leaks.
 * Re-exported from `timingSafe.ts` so modules that must stay importable outside
 * Deno (the Studio limit checks) can use it without pulling in supabase-js.
 */
export { safeCompare } from "./timingSafe.ts";
