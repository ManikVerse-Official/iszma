/*
 * Free greeting card limit regression check.
 *
 * Pins the required policy — ONE free card per email per ROLLING 24 hours, plus
 * the existing network caps (two distinct emails / two cards per IP) — and the
 * failure behaviour that the browser relies on:
 *
 *   • a reached limit is a 429 with a FREE_LIMIT_* code, and is NOT retryable;
 *   • an unverifiable limit is a 503 USAGE_UNAVAILABLE and never creates a card;
 *   • an unrelated 429 (gateway/proxy) is reported as temporary rate limiting,
 *     never as "you used your free card";
 *   • the server refuses to mint a card without a trustworthy client IP;
 *   • the paid flow stays separate.
 *
 * The database function is validated twice: its rolling-window / advisory-lock
 * invariants are asserted on the migration SQL, and the Edge Function wrapper is
 * exercised against a mock that implements the same atomic claim semantics, so
 * concurrent claims can be tested without a live database.
 *
 * Run: npm run check:greeting-limits
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  claimFreeGreeting,
  freeGreetingStatus,
  normaliseEmail,
  type FreeGreetingClient,
} from '../supabase/functions/_shared/freeGreeting.ts';
import { FREE_LIMITS } from '../supabase/functions/_shared/plans.ts';
import { clientIp, isIpAddress } from '../supabase/functions/_shared/entitlement.ts';
import {
  classifyFunctionFailure,
  isFreeCardLimit,
} from '../src/services/functionErrors.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

async function runTests() {
  /* ------------------------------------------------------------------ */
  /* Policy                                                              */
  /* ------------------------------------------------------------------ */

  const limits = FREE_LIMITS.free_greeting;

  check(
    'free greeting is one card per email per rolling 24 hours',
    limits.perEmail === 1 && limits.windowHours === 24,
    JSON.stringify(limits),
  );
  check(
    'the existing network caps are preserved (2 emails / 2 cards per IP)',
    limits.perIpEmails === 2 && limits.perIpTotal === 2,
    JSON.stringify(limits),
  );

  /* ------------------------------------------------------------------ */
  /* Mock of the atomic `consume_free_greeting` database function        */
  /* ------------------------------------------------------------------ */

  interface ClaimRow {
    id: string;
    email: string;
    ip: string;
    createdAt: number;
  }

  interface MockDb {
    rows: ClaimRow[];
    clock: { now: number };
    /** Mirrors the SQL: windowed email count, all-time network counts, one insert. */
    claim: (email: string, ip: string) => Record<string, unknown>;
  }

  const makeDb = (start = Date.parse('2026-10-25T09:00:00Z')): MockDb => {
    const rows: ClaimRow[] = [];
    const clock = { now: start };
    const windowMs = (limits.windowHours ?? 24) * 60 * 60 * 1000;
    const denial = (code: string, retryAfter?: number) => ({
      allowed: false,
      code,
      message: null,
      remaining: 0,
      claim_id: null,
      retry_after_seconds: retryAfter ?? null,
    });

    return {
      rows,
      clock,
      claim(email: string, ip: string) {
        const windowed = rows.filter(
          (row) => row.email === email && row.createdAt > clock.now - windowMs,
        );
        if (windowed.length >= limits.perEmail) {
          const oldest = windowed[0];
          const retry = Math.ceil((oldest.createdAt + windowMs - clock.now) / 1000);
          return denial('FREE_LIMIT_EMAIL', Math.max(1, retry));
        }

        const distinctEmails = new Set(
          rows
            .filter((row) => row.ip === ip && row.email !== email)
            .map((row) => row.email),
        );
        if (limits.perIpEmails > 0 && distinctEmails.size >= limits.perIpEmails) {
          return denial('FREE_LIMIT_NETWORK');
        }

        const ipTotal = rows.filter((row) => row.ip === ip).length;
        if (limits.perIpTotal > 0 && ipTotal >= limits.perIpTotal) {
          return denial('FREE_LIMIT_NETWORK');
        }

        const id = `claim-${rows.length + 1}`;
        rows.push({ id, email, ip, createdAt: clock.now });
        return {
          allowed: true,
          code: null,
          message: null,
          remaining: Math.max(0, limits.perEmail - (windowed.length + 1)),
          claim_id: id,
          retry_after_seconds: null,
        };
      },
    };
  };

  /** A client that forwards the real call arguments into the mock. */
  const claimWith = (db: MockDb): FreeGreetingClient => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      check('the Edge Function calls the atomic database function', fn === 'consume_free_greeting', fn);
      return {
        data: [db.claim(String(args.p_email), String(args.p_ip))],
        error: null,
      };
    },
  });

  /* ------------------------------------------------------------------ */
  /* 1–3. First claim, same email inside 24h, eligible again after 24h   */
  /* ------------------------------------------------------------------ */

  const db = makeDb();

  const first = await claimFreeGreeting(claimWith(db), 'Alice@Example.com', '203.0.113.10');
  check('1. the first eligible free-card request succeeds', first.allowed === true);
  check('   the email is normalised before the check', db.rows[0]?.email === 'alice@example.com');
  check(
    '   a successful claim carries the claim id (so it can be released on failure)',
    first.claimId === 'claim-1',
  );

  db.clock.now += 60 * 60 * 1000; // +1h
  const earlyRetry = await claimFreeGreeting(claimWith(db), ' alice@example.com ', '203.0.113.10');
  check('2. the same email is blocked within 24 hours', earlyRetry.allowed === false);
  check('   the block is reported as a reached limit', earlyRetry.code === 'FREE_LIMIT_EMAIL');
  check('   a reached limit returns HTTP 429', freeGreetingStatus(earlyRetry.code) === 429);
  check(
    '   the reply says how long remains in the rolling window',
    (earlyRetry.retryAfterSeconds ?? 0) >= 23 * 3600 - 60,
    String(earlyRetry.retryAfterSeconds),
  );

  db.clock.now += 22 * 60 * 60 * 1000; // 23h total, still inside the window
  const stillBlocked = await claimFreeGreeting(claimWith(db), 'alice@example.com', '203.0.113.10');
  check('   the limit is a rolling 24 hours, not a midnight reset', stillBlocked.allowed === false);

  db.clock.now += 60 * 60 * 1000 + 1000; // 24h + 1s since the claim
  const afterWindow = await claimFreeGreeting(claimWith(db), 'alice@example.com', '198.51.100.7');
  check('3. the same email is eligible again after 24 hours', afterWindow.allowed === true);

  /* ------------------------------------------------------------------ */
  /* 4–5. Network vs email limits                                        */
  /* ------------------------------------------------------------------ */

  const net = makeDb();
  const netClient = claimWith(net);

  const bob = await claimFreeGreeting(netClient, 'bob@example.com', '203.0.113.20');
  const carol = await claimFreeGreeting(netClient, 'carol@example.com', '203.0.113.20');
  const dave = await claimFreeGreeting(netClient, 'dave@example.com', '203.0.113.20');
  check('4. a second email from the same IP is still allowed (2 per network)', bob.allowed && carol.allowed);
  check('   a third email from that IP is refused', dave.allowed === false && dave.code === 'FREE_LIMIT_NETWORK');

  const otherIpHit = await claimFreeGreeting(netClient, 'bob@example.com', '198.51.100.99');
  check(
    '5. the same email from another IP is still subject to the email limit',
    otherIpHit.allowed === false && otherIpHit.code === 'FREE_LIMIT_EMAIL',
  );

  /* ------------------------------------------------------------------ */
  /* 6. Concurrent requests cannot exceed the limit                      */
  /* ------------------------------------------------------------------ */

  const concurrent = makeDb();
  const race = await Promise.all([
    claimFreeGreeting(claimWith(concurrent), 'race@example.com', '203.0.113.30'),
    claimFreeGreeting(claimWith(concurrent), 'race@example.com', '203.0.113.30'),
  ]);
  check(
    '6. two simultaneous requests for one email yield exactly one card',
    race.filter((decision) => decision.allowed).length === 1,
    race.map((decision) => decision.code ?? 'allowed').join(','),
  );
  check('   the loser is told the limit was reached', race.some((d) => d.code === 'FREE_LIMIT_EMAIL'));
  check('   only one usage row was written for the pair', concurrent.rows.length === 1);

  /* ------------------------------------------------------------------ */
  /* 7. A verification failure never grants a free card                  */
  /* ------------------------------------------------------------------ */

  const rpcError = await claimFreeGreeting(
    {
      rpc: async () => ({
        data: null,
        error: { code: 'PGRST202', message: 'Could not find the function public.consume_free_greeting' },
      }),
    },
    'erin@example.com',
    '203.0.113.40',
  );
  check('7. a database failure does not create a free card', rpcError.allowed === false);
  check('   it is reported as an unavailable check, not a reached limit', rpcError.code === 'USAGE_UNAVAILABLE');
  check('   it maps to HTTP 503 (retryable), not 429', freeGreetingStatus(rpcError.code) === 503);

  const rpcThrew = await claimFreeGreeting(
    {
      rpc: async () => {
        throw new Error('network down');
      },
    },
    'erin@example.com',
    '203.0.113.40',
  );
  check('   a throwing RPC also fails closed with USAGE_UNAVAILABLE', rpcThrew.code === 'USAGE_UNAVAILABLE');

  const noRow = await claimFreeGreeting({ rpc: async () => ({ data: [], error: null }) }, 'erin@example.com', '1.1.1.1');
  check('   a malformed/empty database reply fails closed', noRow.allowed === false && noRow.code === 'USAGE_UNAVAILABLE');

  const noIp = await claimFreeGreeting({ rpc: async () => ({ data: [], error: null }) }, 'erin@example.com', '');
  check('   a missing client IP fails closed (no unverified free card)', noIp.allowed === false);
  check('   the missing-IP failure is USAGE_UNAVAILABLE (503)', noIp.code === 'USAGE_UNAVAILABLE');

  const badEmail = await claimFreeGreeting(claimWith(makeDb()), '   ', '203.0.113.41');
  check('   an empty email is a validation error (400)', badEmail.code === 'INVALID_REQUEST' && freeGreetingStatus(badEmail.code) === 400);

  /* ------------------------------------------------------------------ */
  /* Client IP selection (trusted transport headers only)                */
  /* ------------------------------------------------------------------ */

  const request = (headers: Record<string, string>) =>
    new Request('https://example.supabase.co/functions/v1/create-free-greeting', {
      method: 'POST',
      headers,
    });

  check(
    'the platform header beats a client-supplied x-forwarded-for',
    clientIp(request({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' })) === '9.9.9.9',
    clientIp(request({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '1.2.3.4' })),
  );
  check(
    'the LAST x-forwarded-for hop is used (a prepended value cannot pick the network)',
    clientIp(request({ 'x-forwarded-for': '1.2.3.4, 203.0.113.55' })) === '203.0.113.55',
  );
  check('a junk IP header is not trusted', clientIp(request({ 'x-forwarded-for': 'not-an-ip' })) === '');
  check('an out-of-range IPv4 octet is rejected', !isIpAddress('999.1.1.1'));
  check('IPv6 is accepted', isIpAddress('2001:db8::1'));

  /* ------------------------------------------------------------------ */
  /* 8. An unrelated 429 is not misreported as a free-card limit         */
  /* ------------------------------------------------------------------ */

  const gateway429 = classifyFunctionFailure({ status: 429, body: null });
  check('8. a bare 429 is treated as temporary rate limiting', gateway429.code === 'RATE_LIMITED');
  check('   it is retryable', gateway429.retryable === true);
  check('   it is NOT reported as a free-card limit', !isFreeCardLimit(gateway429));

  const limit429 = classifyFunctionFailure({
    status: 429,
    body: { success: false, code: 'FREE_LIMIT_EMAIL', error: 'Already claimed' },
  });
  check('   a coded limit 429 stays a reached limit (and is not retryable)', isFreeCardLimit(limit429) && !limit429.retryable);

  const unavailable503 = classifyFunctionFailure({
    status: 503,
    body: { success: false, code: 'USAGE_UNAVAILABLE', retryable: true, error: 'Could not verify' },
  });
  check('   an unverifiable limit is retryable', unavailable503.retryable === true && unavailable503.code === 'USAGE_UNAVAILABLE');

  const offline = classifyFunctionFailure({ status: 0, body: null });
  check('   a request that never completed is a connectivity error', offline.code === 'NETWORK' && offline.retryable);

  /* ------------------------------------------------------------------ */
  /* 9–10. Paid cards and the migration invariants                       */
  /* ------------------------------------------------------------------ */

  const freeFn = source('supabase/functions/create-free-greeting/index.ts');
  const paidFn = source('supabase/functions/create-greeting/index.ts');

  check(
    '9. the free function only mints the free theme (paid cards are refused)',
    freeFn.includes('PAID_THEME') && freeFn.includes('FREE_THEME_ID'),
  );
  check(
    '   paid card creation still requires a gateway-verified payment',
    paidFn.includes('verifyRazorpayPayment') && paidFn.includes('Payment is required to create this card'),
  );
  check(
    '   a ₹0 paid order is refused instead of publishing a card',
    /amount\s*<=\s*0/.test(paidFn),
  );
  check(
    '   the free function releases its claim when the card write fails',
    freeFn.includes('releaseFreeGreetingClaim(supabase, decision.claimId)'),
  );

  const sql = source('supabase/migrations/20261025_step19_free_greeting_rolling_limit.sql');
  check(
    '10. the database claim is serialised with per-email and per-IP advisory locks',
    (sql.match(/pg_advisory_xact_lock/g) ?? []).length >= 2,
  );
  check('   the email count uses a rolling window based on created_at', sql.includes('ue.created_at > now() - v_window'));
  check('   the claim is a single atomic insert', (sql.match(/insert into public\.usage_events/gi) ?? []).length === 1);
  check('   the retry hint is derived from the window, in seconds', sql.includes('ue.created_at + v_window - now()'));
  check(
    '   the network caps count distinct emails and total cards per IP',
    sql.indexOf('count(distinct') >= 0 && sql.includes('and ue.ip = v_ip'),
  );
  check(
    '   only the service role may call the limit functions',
    sql.includes('from public, anon, authenticated') && sql.includes('to service_role'),
  );

  check('normaliseEmail trims and lowercases', normaliseEmail('  A@B.COM ') === 'a@b.com');

  /* ------------------------------------------------------------------ */

  console.log(`\n=== free greeting limit check: ${passed} passed, ${failures.length} failed ===`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
