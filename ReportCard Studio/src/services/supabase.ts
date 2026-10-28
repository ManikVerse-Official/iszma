/**
 * Tiny Supabase Edge Function client.
 *
 * ReportCard Studio talks to the Ishmaverse `entitlement` function with plain
 * `fetch` (no supabase-js dependency) so the app stays lightweight. When the
 * two env vars are absent every call resolves to null and the app falls back to
 * its local entitlement store.
 *
 *   VITE_SUPABASE_URL=https://<project>.supabase.co
 *   VITE_SUPABASE_ANON_KEY=<anon key>
 *
 * Authentication: when the embedded Studio has been handed the Ishmaverse
 * session (see services/authBridge.ts) that JWT is sent as the bearer token, so
 * the server can verify WHO is calling. Without it NO Authorization header is
 * sent and the server treats the caller as anonymous — which is exactly what a
 * normal user is for limit purposes.
 *
 * The public key goes in `apikey` only. It is a publishable key, not a JWT, so
 * forwarding it as a bearer earns a gateway "Invalid JWT" — and an unverifiable
 * or expired session token (rotated signing key, stale tab) is refused the same
 * way before the function runs. Both are handled here.
 */

import { normalizeAccessToken, rejectBridgedToken, requestParentSession } from './authBridge';

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';

const baseUrl = rawUrl.replace(/\/$/, '');

export const isSupabaseConfigured = (): boolean => Boolean(baseUrl && anonKey);

/**
 * Bearer token override. Set by services/authBridge.ts to the verified
 * Ishmaverse session; the server still verifies it, so holding a token is not
 * the same as holding admin rights.
 *
 * Only a well-formed, unexpired JWT is kept: `normalizeAccessToken` strips a
 * duplicated "Bearer " prefix and drops anything else, so a malformed value can
 * never reach the gateway.
 */
let sessionToken: string | null = null;

export const setSessionToken = (token: string | null): void => {
  sessionToken = normalizeAccessToken(token);
};

/** The bearer for the next call, or null when the caller is anonymous. */
export const currentBearer = (): string | null => sessionToken;

/** Request headers: the project key, plus the session bearer when there is one. */
const requestHeaders = (token: string | null): Record<string, string> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    // Identifies the project. It is NOT a session token, so it is never the bearer.
    apikey: anonKey,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
};

const post = (name: string, body: unknown, token: string | null): Promise<Response> =>
  fetch(`${baseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: requestHeaders(token),
    body: JSON.stringify(body),
  });

const readJson = (response: Response): Promise<unknown> =>
  response.json().catch(() => null);

/** The gateway's own reason code for a refused Authorization header. */
const gatewayCode = (response: Response): string | undefined => {
  const code = response.headers.get('sb-error-code');
  return code && code.trim() ? code.trim() : undefined;
};

/** A rejected call that kept enough detail for the UI to explain what happened. */
export interface FunctionFailure {
  ok: false;
  /** HTTP status, or 0 when no response was received at all. */
  status: number;
  /** Safe to show to the user. */
  error: string;
  /** Machine-readable code from the function body, when the server supplied one. */
  code?: string;
}

export type FunctionResult<T> = { ok: true; data: T } | FunctionFailure;

const bodyMessage = (payload: unknown, status: number): string => {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['error', 'message', 'reason']) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  return `The server refused the request (HTTP ${status}).`;
};

const bodyCode = (payload: unknown): string | undefined => {
  if (payload && typeof payload === 'object') {
    const code = (payload as Record<string, unknown>).code;
    if (typeof code === 'string' && code.trim()) return code.trim();
  }
  return undefined;
};

/**
 * Invokes an Edge Function and reports the outcome.
 *
 * Unlike `invokeFunction` this keeps the server's own message (e.g. "Payment is
 * required to activate this plan"), so a rejected payment is never mistaken for
 * a successful one.
 */
export const invokeFunctionResult = async <T>(
  name: string,
  body: unknown,
): Promise<FunctionResult<T>> => {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      status: 0,
      code: 'NOT_CONFIGURED',
      error: 'The Studio server is not configured in this build.',
    };
  }
  try {
    const token = sessionToken;
    let response = await post(name, body, token);
    let payload: unknown = await readJson(response);

    /*
     * A session the gateway cannot verify (token from before a signing-key
     * rotation, an expired tab, a token minted by another project) is refused
     * with 401 "Invalid JWT" before the function runs. Drop it, ask the parent
     * for a fresh one, and retry ONCE as the anonymous caller: the function
     * decides admin access from the request itself, so the retry is safe and the
     * user gets a correct answer instead of an error.
     */
    if (token && response.status === 401) {
      rejectBridgedToken(token);
      setSessionToken(null);
      requestParentSession();
      response = await post(name, body, null);
      payload = await readJson(response);
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: bodyMessage(payload, response.status),
        code: bodyCode(payload) ?? gatewayCode(response),
      };
    }
    return { ok: true, data: payload as T };
  } catch {
    return {
      ok: false,
      status: 0,
      code: 'NETWORK',
      error: 'We could not reach the server. Check your connection and try again.',
    };
  }
};

/** Invokes an Edge Function. Returns null on any failure (never throws). */
export const invokeFunction = async <T>(name: string, body: unknown): Promise<T | null> => {
  const result = await invokeFunctionResult<T>(name, body);
  return result.ok ? result.data : null;
};
