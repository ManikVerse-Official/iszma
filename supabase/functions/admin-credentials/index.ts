// admin-credentials — server-side admin password rotation
// ---------------------------------------------------------------------------
// Lets a signed-in admin change their password without ever handing the
// service-role key, the hash or the plaintext to the browser.
//
// Order of operations matters: the bcrypt hash in `admin_users` is the source
// of truth, so it is written FIRST. If the follow-up Supabase Auth update fails,
// the next sign-in simply re-syncs Auth from the hash (see admin-login) and the
// owner is never locked out. Doing it the other way round would break sign-in.
//
// Checks, in order:
//   1. CORS / method
//   2. JWT                              -> 401 when there is no valid session
//   3. admin membership (admin_users)   -> 403 when the caller is not an admin
//   4. current password (server-side grant) -> 401 on a mismatch
//   5. new-password strength (>= 10)    -> 400
//   6. hash rotation (admin_rotate_password) then the Auth password update
//
// POST body: { current_password: string, new_password: string }
// Deploy:    supabase functions deploy admin-credentials   (verify_jwt = true)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.44.2";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient, getUserFromRequest, isAdminUser } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";

const MIN_PASSWORD_LENGTH = 10;

const authBaseUrl = (): string => (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");

const anonKey = (): string =>
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

/** Re-verifies the current password through Supabase Auth, server-side. */
const confirmPassword = async (email: string, password: string): Promise<boolean> => {
  const key = anonKey();
  if (!key || !email || !password) return false;

  const response = await fetch(`${authBaseUrl()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  return response.ok;
};

/** Updates the Supabase Auth password to match the newly stored hash. */
const setAuthPassword = async (userId: string, password: string): Promise<boolean> => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!serviceKey || !userId) return false;

  try {
    const response = await fetch(`${authBaseUrl()}/auth/v1/admin/users/${userId}`, {
      method: "PUT",
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password, email_confirm: true }),
    });

    if (!response.ok) {
      console.error("admin-credentials: Auth password update failed", await response.text());
      return false;
    }
    return true;
  } catch (error) {
    console.error("admin-credentials: Auth password update threw:", error);
    return false;
  }
};

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const ip = clientIp(req);

  try {
    // 1. The caller must present a real session.
    const user = await getUserFromRequest(req);
    if (!user?.id) {
      return errorResponse("Please sign in again.", 401);
    }

    // 2. …and that session must belong to an admin.
    if (!(await isAdminUser(user.id))) {
      return errorResponse("This account does not have administrator access.", 403);
    }

    const body = (await req.json()) as Record<string, unknown>;
    const currentPassword = typeof body.current_password === "string" ? body.current_password : "";
    const newPassword = typeof body.new_password === "string" ? body.new_password : "";

    if (!currentPassword || !newPassword) {
      return errorResponse("Enter your current and new password.", 400);
    }

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return errorResponse(
        `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
        400,
      );
    }

    if (newPassword === currentPassword) {
      return errorResponse("Your new password must be different from the current one.", 400);
    }

    const email = (user.email ?? "").trim().toLowerCase();
    if (!email) {
      return errorResponse("This account has no email address.", 400);
    }

    // 3. Prove the caller knows the current password.
    if (!(await confirmPassword(email, currentPassword))) {
      return errorResponse("Your current password is incorrect.", 401);
    }

    // 4. Rotate the stored hash using the caller's own JWT, so the function
    //    re-checks admin membership via auth.uid() as well.
    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const callerClient = createClient(authBaseUrl(), anonKey(), {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: rotated, error: rotateError } = await callerClient.rpc("admin_rotate_password", {
      p_current_password: currentPassword,
      p_new_password: newPassword,
    });

    if (rotateError) {
      console.error("admin-credentials: rotation failed:", rotateError.message);
      return errorResponse("Could not update your password. Please try again.", 500);
    }

    if (rotated?.ok !== true) {
      const code = String(rotated?.code ?? "");
      if (code === "bad_password") {
        return errorResponse("Your current password is incorrect.", 401);
      }
      if (code === "weak_password") {
        return errorResponse(String(rotated?.message ?? "Choose a stronger password."), 400);
      }
      return errorResponse("Could not update your password. Please try again.", 400);
    }

    // 5. Keep Supabase Auth in step. A failure here is not fatal — admin-login
    //    re-syncs from the hash on the next sign-in.
    const synced = await setAuthPassword(user.id, newPassword);

    // Best-effort audit trail: a missing log must never mask a completed
    // password change.
    try {
      const client = createAdminClient();
      await client.from("admin_audit_log").insert([
        {
          actor_id: user.id,
          actor_email: email,
          action: "admin.password_rotate",
          outcome: "success",
          detail: synced ? "Auth password synced" : "Auth password pending re-sync",
          ip: ip || null,
        },
      ]);
    } catch (auditError) {
      console.warn("admin-credentials: audit entry not written:", auditError);
    }

    return jsonResponse({ success: true, synced });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("admin-credentials failed:", message);
    return errorResponse("Could not update your password. Please try again.", 500);
  }
});
