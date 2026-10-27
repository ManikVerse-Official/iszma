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
 */

const rawUrl = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) ?? '';

const baseUrl = rawUrl.replace(/\/$/, '');

export const isSupabaseConfigured = (): boolean => Boolean(baseUrl && anonKey);

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
    const response = await fetch(`${baseUrl}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The anon key is public; the function enforces everything server-side.
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify(body),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: bodyMessage(payload, response.status),
        code: bodyCode(payload),
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
