/*
 * CORS regression check for the Supabase Edge Functions.
 *
 * The `track-visit` function was failing in the browser with a generic CORS
 * error because the deployed origin policy would not accept the request origin.
 * This check pins the replacement policy:
 *
 *   • an allowlisted origin is echoed back (never `*`);
 *   • an unknown origin gets NO `Access-Control-Allow-Origin` at all;
 *   • local dev origins are always allowed, so `npm run dev` can call the
 *     deployed functions;
 *   • the allowlist is configuration (SITE_ORIGINS), not code.
 *
 * Usage:  npx jiti scripts/check-cors.ts
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_ALLOWED_ORIGINS,
  allowedOrigins,
  corsFor,
  errorResponse,
  handleOptions,
  isLocalOrigin,
  isOriginAllowed,
  jsonResponse,
} from '../supabase/functions/_shared/http.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Minimal Deno shim so the env-reading path can be exercised under Node. */
function withDenoEnv(values: Record<string, string>, run: () => void): void {
  const previous = (globalThis as { Deno?: unknown }).Deno;
  (globalThis as { Deno?: unknown }).Deno = {
    env: { get: (name: string) => values[name] },
  };
  try {
    run();
  } finally {
    if (previous === undefined) delete (globalThis as { Deno?: unknown }).Deno;
    else (globalThis as { Deno?: unknown }).Deno = previous;
  }
}

const preflight = (origin: string): Request =>
  new Request('https://example.supabase.co/functions/v1/track-visit', {
    method: 'OPTIONS',
    headers: { origin, 'access-control-request-method': 'POST' },
  });

const post = (origin: string): Request =>
  new Request('https://example.supabase.co/functions/v1/track-visit', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
  });

const echo = (origin: string, allowed?: string[]) =>
  corsFor(preflight(origin), allowed)['Access-Control-Allow-Origin'];

/* ── default allowlist ─────────────────────────────────────────────── */

check(
  'the default allowlist is the production site, not a wildcard',
  DEFAULT_ALLOWED_ORIGINS.length > 0 &&
    !DEFAULT_ALLOWED_ORIGINS.includes('*') &&
    DEFAULT_ALLOWED_ORIGINS.includes('https://ishmaverse.com'),
  DEFAULT_ALLOWED_ORIGINS.join(','),
);

check(
  'an allowlisted origin is echoed exactly',
  echo('https://ishmaverse.com') === 'https://ishmaverse.com',
  String(echo('https://ishmaverse.com')),
);

check(
  'a trailing slash is normalised',
  echo('https://ishmaverse.com/') === 'https://ishmaverse.com',
  String(echo('https://ishmaverse.com/')),
);

check(
  'an unknown origin gets NO Access-Control-Allow-Origin',
  corsFor(preflight('https://evil.example'))['Access-Control-Allow-Origin'] === undefined,
);

check(
  'the wildcard is never emitted for an allowlisted origin',
  echo('https://ishmaverse.com') !== '*',
);

check(
  'Vary: Origin is set so caches cannot replay headers across origins',
  corsFor(preflight('https://ishmaverse.com')).Vary === 'Origin',
);

/* ── local dev origins ────────────────────────────────────────────── */

for (const origin of [
  'http://localhost:5173',
  'http://127.0.0.1:4173',
  'http://localhost:3000',
]) {
  check(`local dev origin ${origin} is allowed`, isLocalOrigin(origin));
  check(`preflight from ${origin} is accepted`, echo(origin) === origin);
}

check('a lookalike host is not treated as local', !isLocalOrigin('http://localhost.evil.com'));
check('a lookalike is not echoed', echo('http://localhost.evil.com') === undefined);

/* ── preflight response shape ─────────────────────────────────────── */

const okPreflight = handleOptions(preflight('https://ishmaverse.com'));
check('OPTIONS is answered', okPreflight !== null && okPreflight.status === 204,
  okPreflight ? String(okPreflight.status) : 'null');
check(
  'the preflight advertises POST + OPTIONS and the client headers',
  okPreflight?.headers.get('access-control-allow-methods') === 'POST, OPTIONS' &&
    /apikey/.test(okPreflight?.headers.get('access-control-allow-headers') ?? ''),
);
check(
  'the preflight echoes an allowlisted origin',
  okPreflight?.headers.get('access-control-allow-origin') === 'https://ishmaverse.com',
);
check('a GET request is not treated as a preflight', handleOptions(post('https://ishmaverse.com')) === null);

const blockedPreflight = handleOptions(preflight('https://evil.example'));
check(
  'a disallowed origin still gets a preflight response, but no allow-origin header',
  blockedPreflight !== null &&
    blockedPreflight.headers.get('access-control-allow-origin') === null,
);

/* ── JSON responses carry the same policy ─────────────────────────── */

const json = jsonResponse({ success: true }, 200, post('https://ishmaverse.com'));
check(
  'a JSON response to an allowlisted origin is readable and not wildcarded',
  json.headers.get('access-control-allow-origin') === 'https://ishmaverse.com' &&
    json.headers.get('content-type') === 'application/json',
);

const errorJson = errorResponse('nope', 400, post('https://evil.example'));
check(
  'a JSON error to an unknown origin is not readable by it',
  errorJson.status === 400 && errorJson.headers.get('access-control-allow-origin') === null,
);

/* ── configuration, not code ──────────────────────────────────────── */

withDenoEnv({ SITE_ORIGINS: 'https://school.example, https://admin.school.example/' }, () => {
  check(
    'SITE_ORIGINS replaces the default allowlist',
    allowedOrigins().join(',') === 'https://school.example,https://admin.school.example',
    allowedOrigins().join(','),
  );
  check(
    'an origin added by configuration becomes reachable',
    echo('https://admin.school.example') === 'https://admin.school.example',
  );
  check(
    'an origin no longer on the list is refused',
    echo('https://ishmaverse.com') === undefined,
  );
  check(
    'local dev origins keep working with a custom allowlist',
    echo('http://localhost:5173') === 'http://localhost:5173',
  );
});

withDenoEnv({}, () => {
  check('an empty configuration falls back to the production origins',
    isOriginAllowed('https://ishmaverse.com') && !isOriginAllowed('https://evil.example'));
});

/* ── every response in admin-login carries the request ─────────────── */

/*
 * A response built without `req` falls back to the legacy wildcard, which the
 * browser refuses for a credentialed call. That is why a 405/429 used to reach
 * the admin login screen as a generic "Edge Function request failed" CORS
 * error instead of a readable message. This is a source-level guard: the
 * function cannot be imported under Node (it boots `serve`), so the invariant
 * is pinned on the source itself.
 */
const adminLoginSource = readFileSync(
  resolve(process.cwd(), '../supabase/functions/admin-login/index.ts'),
  'utf8',
);

const responseCalls = adminLoginSource.match(/(?:errorResponse|jsonResponse)\([\s\S]*?\);/g) ?? [];
const missingRequest = responseCalls.filter((call) => !/,\s*req,?\s*\)/.test(call));

check(
  'admin-login exists and returns responses',
  responseCalls.length >= 8,
  `${responseCalls.length} responses found`,
);
check(
  'every admin-login response (success and error) uses the request allowlist',
  missingRequest.length === 0,
  missingRequest.join(' | '),
);

/* ── track-visit preflight is not blocked by the gateway ───────────── */

const config = readFileSync(resolve(process.cwd(), '../supabase/config.toml'), 'utf8');
check(
  'track-visit accepts anonymous calls (so OPTIONS reaches its CORS handler)',
  /\[functions\.track-visit\]\s*\nverify_jwt\s*=\s*false/.test(config),
);
check(
  'admin-login still accepts anonymous calls (the caller has no JWT yet)',
  /\[functions\.admin-login\]\s*(?:#[^\n]*\n\s*)*verify_jwt\s*=\s*false/.test(config),
);

console.log(`\n=== CORS check: ${passed} passed, ${failures.length} failed ===`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
}
process.exit(failures.length > 0 ? 1 : 0);
