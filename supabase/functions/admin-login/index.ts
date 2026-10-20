// admin-login — backend admin authentication
// ---------------------------------------------------------------------------
// The browser never holds an admin password or checks one locally. It posts the
// typed credentials here and gets a real Supabase session back, which every
// other part of the app (RLS, is_admin(), admin-ops) already understands.
//
// Flow, in order:
//   1. per-IP throttle            -> 429 (best-effort, per warm instance)
//   2. admin_login_verify (bcrypt)-> 401 on a mismatch, generic message
//   3. Supabase Auth password grant (server-side) -> the session to return
//   4. if the hash matched but Auth rejected the password, the stored hash is
//      authoritative: the Auth password is re-synced once and the grant retried
//   5. tokens are returned; the client calls supabase.auth.setSession(...)
//
// The stored hash is the source of truth, so rotating it with
// `scripts/setup-admin.mjs` can never lock the owner out of their own panel.
//
// Secrets: SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
// injected automatically by Supabase — nothing to configure.
//
// Deploy: supabase functions deploy admin-login   (verify_jwt = false)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const isEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

/** Defence in depth: a per-IP throttle in front of the bcrypt comparison. */
const THROTTLE = { windowMs: 5 * 60 * 1000, maxAttempts: 10 };
const attempts = new Map<string, { count: number; resetAt: number }>();

const isThrottled = (ip: string): boolean => {
  if (!ip) return false;
  const now = Date.now();

  // Opportunistic cleanup so the map cannot grow without bound.
  if (attempts.size > 5000) {
    for (const [key, entry] of attempts) {
      if (entry.resetAt <= now) attempts.delete(key);
    }
  }

  const entry = attempts.get(ip);
  if (!entry || entry.resetAt <= now) {
    attempts.set(ip, { count: 1, resetAt: now + THROTTLE.windowMs });
    return false;
  }

  entry.count += 1;
  return entry.count > THROTTLE.maxAttempts;
};

const authBaseUrl = (): string => (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");

const anonKey = (): string =>
  Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ?? "";

interface SessionTokens {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  expires_at?: number;
}

interface PasswordGrantResult {
  tokens: SessionTokens;
  userId: string;
  email: string | null;
}

/**
 * Server-side password grant. Runs entirely in the Edge Function — the password
 * is never trusted from, nor compared in, the browser.
 */
const passwordGrant = async (
  email: string,
  password: string,
): Promise<PasswordGrantResult | null> => {
  const key = anonKey();
  if (!key) {
    console.error("admin-login: SUPABASE_ANON_KEY is not available");
    return null;
  }

  const response = await fetch(`${authBaseUrl()}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) return null;

  const data = await response.json();
  if (!data?.access_token || !data?.refresh_token) return null;

  return {
    tokens: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
      expires_at: data.expires_at,
    },
    userId: data.user?.id ?? "",
    email: data.user?.email ?? null,
  };
};

/**
 * Aligns the Supabase Auth password with the hash stored in admin_users. Used
 * when the table says the credentials are correct but Auth disagrees — the
 * table wins so the owner can never be locked out.
 */
const syncAuthPassword = async (userId: string, password: string): Promise<boolean> => {
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
    return response.ok;
  } catch (error) {
    console.error("admin-login: could not sync the Auth password:", error);
    return false;
  }
};

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  /*
   * Every response carries the request so the CORS headers come from the same
   * allowlist as a success. A response built without `req` falls back to the
   * legacy wildcard, which a browser rejects for a credentialed call — that is
   * exactly how a 405/429 used to surface as a misleading CORS failure.
   */
  if (req.method !== "POST") return errorResponse("Method not allowed", 405, req);

  const ip = clientIp(req);
  if (isThrottled(ip)) {
    return errorResponse("Too many sign-in attempts. Please wait a few minutes.", 429, req);
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const email = clean(body.email, 150).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";

    if (!isEmail(email) || !password) {
      return errorResponse("Enter your admin email and password.", 400, req);
    }

    const supabase = createAdminClient();

    // 1. Verify against the stored bcrypt hash (service role only).
    const { data: verification, error: verifyError } = await supabase.rpc(
      "admin_login_verify",
      { p_email: email, p_password: password },
    );

    if (verifyError) {
      console.error("admin-login: verification failed:", verifyError.message);
      return errorResponse("Sign-in is temporarily unavailable. Please try again.", 503, req);
    }

    const code = String(verification?.code ?? "");
    const hashConfirmed = verification?.ok === true;

    // Supabase Auth remains the check when the account has no local hash yet.
    if (!hashConfirmed && code !== "no_local_password") {
      // Same message for a wrong password and an unknown email: no enumeration.
      return errorResponse("Incorrect email or password.", 401, req);
    }

    // 2. Mint a real session the rest of the app can trust.
    let granted = await passwordGrant(email, password);

    if (!granted && hashConfirmed) {
      const userId = String(verification?.user_id ?? "");
      if (await syncAuthPassword(userId, password)) {
        granted = await passwordGrant(email, password);
      }
    }

    if (!granted) {
      return errorResponse("Sign-in is temporarily unavailable. Please try again.", 503, req);
    }

    // The session must belong to the admin we just verified.
    if (hashConfirmed && verification?.user_id && granted.userId !== verification.user_id) {
      console.error("admin-login: session/allow-list mismatch");
      return errorResponse("This account does not have administrator access.", 403, req);
    }

    return jsonResponse({
      success: true,
      access_token: granted.tokens.access_token,
      refresh_token: granted.tokens.refresh_token,
      expires_in: granted.tokens.expires_in ?? null,
      expires_at: granted.tokens.expires_at ?? null,
      user_id: granted.userId,
      email: granted.email ?? email,
    }, 200, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("admin-login failed:", message);
    return errorResponse("Sign-in is temporarily unavailable. Please try again.", 500, req);
  }
});
