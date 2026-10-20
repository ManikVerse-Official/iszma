// Shared CORS headers for all Ishmaverse Edge Functions.
//
// ── Why this is not `*` ───────────────────────────────────────────────────────
// The studio used to answer every request with `Access-Control-Allow-Origin: *`.
// A wildcard makes the browser refuse any request that carries credentials and
// gives every site on the internet a free hand at the function's quota. The
// allowlist below is the intended, explicit policy:
//
//   • `SITE_ORIGINS` / `ALLOWED_ORIGINS` (Edge Function secret, comma-separated)
//     — the deployed origins, e.g.
//       supabase secrets set SITE_ORIGINS="https://ishmaverse.com,https://www.ishmaverse.com"
//   • localhost / 127.0.0.1 on any port — always allowed, so `npm run dev` can
//     talk to the DEPLOYED functions (a browser only ever reaches them
//     cross-origin, which is exactly why the dev origin must be allowlisted
//     rather than blocked).
//
// A request from an origin that is not allowed simply receives NO
// `Access-Control-Allow-Origin` header, so the browser blocks it. Nothing is
// silently widened to make a call work.

/** Origins used when `SITE_ORIGINS` is not configured. */
export const DEFAULT_ALLOWED_ORIGINS = [
  'https://ishmaverse.com',
  'https://www.ishmaverse.com',
];

/**
 * Reads an environment variable in a runtime-neutral way.
 *
 * The module is also imported by plain Node (the CORS regression check), so it
 * must not touch `Deno` unconditionally.
 */
const envValue = (key: string): string => {
  const deno = (
    globalThis as {
      Deno?: { env?: { get(name: string): string | undefined } };
    }
  ).Deno;
  try {
    return deno?.env?.get(key) ?? '';
  } catch {
    return '';
  }
};

const normalizeOrigin = (value: string): string => value.trim().replace(/\/+$/, '');

/** The configured allowlist, falling back to the known production origins. */
export const allowedOrigins = (): string[] => {
  const configured = envValue('SITE_ORIGINS') || envValue('ALLOWED_ORIGINS');
  const list = configured
    .split(',')
    .map(normalizeOrigin)
    .filter(Boolean);
  return list.length > 0 ? list : DEFAULT_ALLOWED_ORIGINS;
};

/** True for a local dev-server origin (`http://localhost:5173`, `127.0.0.1`, …). */
export const isLocalOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return (
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '::1' ||
      url.hostname === '[::1]'
    );
  } catch {
    return false;
  }
};

/** Is this exact origin allowed to call the functions? */
export const isOriginAllowed = (origin: string, allowed = allowedOrigins()): boolean => {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  if (allowed.map(normalizeOrigin).includes(normalized)) return true;
  return isLocalOrigin(normalized);
};

/**
 * CORS headers for one request.
 *
 * The requesting origin is echoed ONLY when it is allowlisted. `Vary: Origin`
 * stops a cache from replaying one origin's headers to another.
 */
export const corsFor = (
  req: Request,
  allowed = allowedOrigins(),
): Record<string, string> => {
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };

  const origin = req.headers.get('origin') ?? '';
  if (isOriginAllowed(origin, allowed)) {
    base['Access-Control-Allow-Origin'] = normalizeOrigin(origin);
  } else if (origin) {
    /*
     * Never silent: a refused origin is exactly the failure that used to be
     * invisible in the browser (it only shows up as a generic CORS error).
     */
    console.warn(
      `CORS: refused origin "${origin}". Add it to the SITE_ORIGINS secret (comma-separated).`,
    );
  }
  return base;
};

/**
 * Legacy wildcard headers.
 *
 * Kept so functions that have not been migrated to {@link corsFor} keep working
 * exactly as before. Do NOT use it for new code — pass the request to
 * `jsonResponse`, `errorResponse` or `handleOptions` instead.
 */
export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * JSON response. Pass the request to get allowlist-aware CORS headers; omitting
 * it keeps the previous wildcard behaviour.
 */
export const jsonResponse = (
  body: unknown,
  status = 200,
  req?: Request,
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...(req ? corsFor(req) : corsHeaders),
      'Content-Type': 'application/json',
    },
  });

export const errorResponse = (
  message: string,
  status = 400,
  req?: Request,
): Response => jsonResponse({ success: false, error: message }, status, req);

/**
 * OPTIONS preflight.
 *
 * Always answered (204) so the browser gets a real preflight response; an
 * origin that is not allowlisted simply gets no `Access-Control-Allow-Origin`
 * back and is therefore blocked by the browser.
 */
export const handleOptions = (req: Request): Response | null =>
  req.method === 'OPTIONS'
    ? new Response(null, { status: 204, headers: corsFor(req) })
    : null;
