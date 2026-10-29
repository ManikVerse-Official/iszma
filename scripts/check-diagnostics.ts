/*
 * System diagnostics — pure checks.
 *
 * These pin the behaviour that matters when something is actually broken:
 *
 *   • a failure is never counted as healthy, and an unverified area is "unknown",
 *     not "ok";
 *   • a 404 (function not deployed), a 401/403 (session/permission) and a network
 *     failure (status 0) are reported as different root causes;
 *   • non-recoverable failures are flagged so the panel asks for a deployment
 *     instead of suggesting a pointless retry;
 *   • the server function is admin-gated and the client really calls it.
 *
 * Usage:  npx jiti ../scripts/check-diagnostics.ts      (from ReportCard Studio)
 *         npm run check:diagnostics                     (from the repo root)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  catalogueCheck,
  checkoutProbeCheck,
  configCheck,
  maskEmail,
  mergeDiagnostics,
  realtimeCheck,
  reportCardEmbedCheck,
  serverUnavailableCheck,
  sessionCheck,
  sortDiagnostics,
  summariseDiagnostics,
  type DiagnosticCheck,
} from '../src/services/systemDiagnosticsCore.ts';

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

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(resolve(here, '..', relative), 'utf8');

/* ── summaries ────────────────────────────────────────────────────────────── */

const ok = (id: string): DiagnosticCheck => ({
  id,
  title: id,
  status: 'ok',
  recoverable: true,
  rootCause: '',
  evidence: '',
  nextStep: '',
});
const warn = (id: string): DiagnosticCheck => ({ ...ok(id), status: 'warn' });
const fail = (id: string, recoverable = true): DiagnosticCheck => ({
  ...ok(id),
  status: 'fail',
  recoverable,
});
const unknown = (id: string): DiagnosticCheck => ({ ...ok(id), status: 'unknown' });

check('all-ok is healthy', summariseDiagnostics([ok('a'), ok('b')]).healthy === true);
check('a warning alone is still healthy', summariseDiagnostics([ok('a'), warn('b')]).healthy === true);
check('a failure is never healthy', summariseDiagnostics([ok('a'), fail('b')]).healthy === false);
check('an unknown area is not counted as ok', summariseDiagnostics([unknown('a')]).unknown === 1);
check(
  'recoverable failures do not demand an owner action',
  summariseDiagnostics([fail('a', true)]).needsOwnerAction === false,
);
check(
  'non-recoverable failures demand a deployment',
  summariseDiagnostics([fail('a', false)]).needsOwnerAction === true,
);
check('counts add up', summariseDiagnostics([ok('a'), warn('b'), fail('c'), unknown('d')]).ok === 1);

const sorted = sortDiagnostics([ok('z'), unknown('u'), warn('w'), fail('f')]);
check(
  'failing checks are listed first',
  sorted.map((entry) => entry.status).join(',') === 'fail,warn,unknown,ok',
  sorted.map((entry) => entry.status).join(','),
);

/* ── masking ──────────────────────────────────────────────────────────────── */

check('masks a normal address', maskEmail('asha@example.com') === 'a***@example.com', maskEmail('asha@example.com'));
check('never returns the full local part', !maskEmail('secret.person@example.com').includes('secret.person'));
check('empty stays empty', maskEmail('   ') === '');
check('a malformed value is still masked', maskEmail('not-an-email') === 'n***');

/* ── client checks ────────────────────────────────────────────────────────── */

const noConfig = configCheck(false);
check('missing Supabase config is a non-recoverable failure', noConfig.status === 'fail' && noConfig.recoverable === false);
check('present config is ok', configCheck(true).status === 'ok');

check('no session is a warning, not a pass', sessionCheck({ configured: true, email: null }).status === 'warn');
check('a session is ok', sessionCheck({ configured: true, email: 'a@b.co' }).status === 'ok');
check(
  'session cannot be checked without a backend',
  sessionCheck({ configured: false, email: null }).status === 'unknown',
);

check(
  'a rejected catalogue write is surfaced',
  catalogueCheck({ syncWarning: 'permission denied', themeCount: 4, productCount: 2 }).status === 'warn',
);
check(
  'an empty catalogue is a warning',
  catalogueCheck({ syncWarning: null, themeCount: 0, productCount: 0 }).status === 'warn',
);
check(
  'a loaded catalogue is ok',
  catalogueCheck({ syncWarning: null, themeCount: 4, productCount: 2 }).status === 'ok',
);

check('a publishable anon key is reported (realtime warn)', realtimeCheck(false, true).status === 'warn');
check('a JWT anon key is ok', realtimeCheck(true, true).status === 'ok');

check('a failed embed probe is a warning', reportCardEmbedCheck({ attempted: true, ok: false }).status === 'warn');
check('a passing embed probe is ok', reportCardEmbedCheck({ attempted: true, ok: true }).status === 'ok');

/* The checkout probe is safe: an unknown theme is rejected before any gateway
 * call, so this proves deployment/pricing without creating a payment order. */
check(
  'a deployed checkout function answering UNKNOWN_THEME is ok',
  checkoutProbeCheck({ attempted: true, status: 400, code: 'UNKNOWN_THEME' }).status === 'ok',
);
check(
  'an undeployed checkout function is non-recoverable',
  checkoutProbeCheck({ attempted: true, status: 404 }).recoverable === false,
);
check(
  'an unconfigured provider is a warning, not a pass',
  checkoutProbeCheck({ attempted: true, status: 503, code: 'PAYMENT_CONFIG' }).status === 'warn',
);
check(
  'an unexpected checkout answer is surfaced',
  checkoutProbeCheck({ attempted: true, status: 500 }).status === 'fail',
);

/* ── server failure classification ────────────────────────────────────────── */

check('network (status 0) is retryable', serverUnavailableCheck({ status: 0 }).recoverable === true);
check(
  'network is described as connectivity, not a permission problem',
  /network|could not reach/i.test(serverUnavailableCheck({ status: 0 }).rootCause),
);
check('401 points at the session', /session/i.test(serverUnavailableCheck({ status: 401 }).rootCause));
check('403 points at admin_users', /admin_users/i.test(serverUnavailableCheck({ status: 403 }).rootCause));
check(
  '404 is a non-recoverable deployment problem',
  serverUnavailableCheck({ status: 404 }).recoverable === false &&
    /not deployed/i.test(serverUnavailableCheck({ status: 404 }).rootCause),
);
check('429 asks for a retry', serverUnavailableCheck({ status: 429 }).status === 'warn');
check('500 is recoverable via logs/config', serverUnavailableCheck({ status: 500 }).recoverable === true);
check(
  'an unexpected 200 rejection is still a failure',
  serverUnavailableCheck({ status: 200 }).status === 'fail',
);

/* ── merging ──────────────────────────────────────────────────────────────── */

const merged = mergeDiagnostics([ok('a'), warn('b')], [fail('b'), ok('c')]);
check('merged result contains client and server checks', merged.length === 3, String(merged.length));
check(
  'the server version wins for the same id',
  merged.find((entry) => entry.id === 'b')?.status === 'fail',
);
const mergedWithDuplicates = mergeDiagnostics([ok('x')], []);
check('client checks are not duplicated', mergedWithDuplicates.filter((entry) => entry.id === 'x').length === 1);

/* ── wiring ───────────────────────────────────────────────────────────────── */

const fn = read('supabase/functions/admin-diagnostics/index.ts');
check('server verifies the JWT', /getUserFromRequest\(req\)/.test(fn));
check('server verifies admin membership', /isAdminUser\(user\.id\)/.test(fn));
check('server refuses non-admins with 403', /Administrator access required", 403/.test(fn));
check('server refuses anonymous callers with 401', /valid administrator session is required", 401/.test(fn));
check(
  'server only reports whether secrets exist, not their values',
  !/Deno\.env\.get\([^)]*\)\s*}\s*`/.test(fn) && /Boolean\(Deno\.env\.get/.test(fn),
);
check('server records the run in the audit log', /diagnostics\.run/.test(fn));
check('server checks receipt coverage', /receipts/.test(fn) && /missingReceiptCheck/.test(fn));
check('server checks failed emails', /email_log/.test(fn) && /emailFailureCheck/.test(fn));

const runner = read('src/services/systemDiagnostics.ts');
check('client calls the admin-diagnostics function', /functions\.invoke\('admin-diagnostics'/.test(runner));
check('client reports an unreachable server', /serverUnavailableCheck/.test(runner));
check('client never treats a reload as verification', !/location\.reload/.test(runner));

const panel = read('src/components/admin/AdminJoyDiagnostics.tsx');
check('the panel runs the shared diagnostics runner', /runSystemDiagnostics/.test(panel));
check('the panel surfaces non-recoverable failures', /needsOwnerAction/.test(panel));
check('the panel labels recoverable state per check', /check\.recoverable/.test(panel));

const consoleSource = read('src/components/AdminJoy.tsx');
check('Admin Joy renders the diagnostics panel', /AdminJoyDiagnostics/.test(consoleSource));

/* ── report ───────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('Diagnostics checks failed.');
  process.exit(1);
}
console.log('Diagnostics checks passed.');
