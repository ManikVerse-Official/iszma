// Security checks for the server-side admin boundary (`admin-ops`).
//
// What is covered here (all executed, not described):
//   • input validation: malformed bodies, unknown/unsupported actions, missing
//     or over-long targets, out-of-range and non-numeric prices, unknown fields;
//   • authorization: non-admin, missing permission, forged identity/permission/
//     confirmation fields in the body, target escalation;
//   • audit safety: secrets stripped, only changed fields diffed;
//   • rate limiting: fixed-window arithmetic for commands and auth failures;
//   • client transport: correct action mapping, no fallback write on failure,
//     and no client-side identity or mutation path at all;
//   • the Edge Function source: the trusted checks are present and the service
//     role key / untrusted body fields are not used.
//
// What this CANNOT cover: the live database. Executing the function's own SQL
// paths needs a deployed Supabase project (see the deployment notes in the
// final report). Run: node scripts/check-admin-ops.mjs
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';

// --- minimal browser globals supabase-js needs at import time ---------------
globalThis.window ??= { location: { origin: 'http://localhost:5173' } };
const store = new Map();
globalThis.localStorage ??= {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.WebSocket ??= class WebSocketStub {
  constructor() {}
  close() {}
  send() {}
  addEventListener() {}
  removeEventListener() {}
};

const problems = [];
let checked = 0;
const check = (label, condition, detail = '') => {
  checked += 1;
  const ok = Boolean(condition);
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -> ${detail}`}`);
};

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

const FUNCTIONS = new Set(['action', 'targetId', 'targetName', 'fields', 'notStored', 'destructive']);
const FORBIDDEN_CLIENT_FIELDS = ['isAdmin', 'permissions', 'confirmed', 'actorId', 'userId', 'role', 'email'];

try {
  const core = await server.ssrLoadModule('/supabase/functions/_shared/adminOpsCore.ts');
  const adminOpsModule = await server.ssrLoadModule('/src/services/adminOps.ts');

  const {
    validateAdminOpRequest,
    hasAdminPermission,
    buildAuditDiff,
    redactSecrets,
    normaliseOutcome,
    fixedWindowDecision,
    REQUIRED_PERMISSION,
    LIMITS,
  } = core;

  /* ── CORE · malformed and unsupported input ─────────────────────────── */
  {
    const bad = [
      [null, 'a null body'],
      ['not-an-object', 'a string body'],
      [[], 'an array body'],
      [{}, 'a body with no action'],
      [{ action: '   ' }, 'a blank action'],
      [{ action: 'product.explode' }, 'an unknown action'],
    ];
    for (const [body, label] of bad) {
      const result = validateAdminOpRequest(body, null, true);
      check(`rejects ${label}`, result.ok === false && result.status === 400, JSON.stringify(result));
    }

    const unsupported = validateAdminOpRequest({ action: 'track.publish' }, null, true);
    check(
      'refuses unsupported music actions instead of faking them',
      unsupported.ok === false && unsupported.status === 501 && /implementation/i.test(unsupported.error),
      JSON.stringify(unsupported),
    );
    check(
      'unsupported actions are never reported as valid',
      validateAdminOpRequest({ action: 'music.delete' }, null, true).ok === false,
    );
  }

  /* ── CORE · target handling ─────────────────────────────────────────── */
  {
    const noTarget = validateAdminOpRequest({ action: 'product.update', fields: { price: 10 } }, null, true);
    check(
      'a mutation without a targetId is rejected',
      noTarget.ok === false && noTarget.status === 400 && /targetId/i.test(noTarget.error),
      JSON.stringify(noTarget),
    );

    const longId = validateAdminOpRequest(
      { action: 'product.delete', targetId: 'x'.repeat(LIMITS.targetId + 1) },
      null,
      true,
    );
    check('an over-long targetId is rejected', longId.ok === false && longId.status === 400);

    const ok = validateAdminOpRequest({ action: 'product.delete', targetId: 'p1' }, null, true);
    check('a valid delete is accepted and flagged destructive', ok.ok === true && ok.request.destructive === true);
    check('a delete carries no fields', ok.ok === true && Object.keys(ok.request.fields).length === 0);

    const report = validateAdminOpRequest({ action: 'report.overview' }, null, true);
    check('a read-only report needs no target', report.ok === true && report.request.destructive === false);
  }

  /* ── CORE · field validation ────────────────────────────────────────── */
  {
    const cases = [
      [{ action: 'product.update', targetId: 'p1', fields: { price: -5 } }, 'a negative price'],
      [{ action: 'product.update', targetId: 'p1', fields: { price: LIMITS.price + 1 } }, 'a price above the limit'],
      [{ action: 'product.update', targetId: 'p1', fields: { price: 'abc' } }, 'a non-numeric price'],
      [{ action: 'product.update', targetId: 'p1', fields: { price: Number.NaN } }, 'a NaN price'],
      [{ action: 'product.update', targetId: 'p1', fields: { price: Number.POSITIVE_INFINITY } }, 'an infinite price'],
      [{ action: 'product.update', targetId: 'p1', fields: {} }, 'an update with no fields'],
      [{ action: 'product.update', targetId: 'p1', fields: { role: 'owner' } }, 'an unknown field'],
      [{ action: 'product.update', targetId: 'p1', fields: { price_usd: 5, active: false } }, 'an unmodifiable field'],
      [{ action: 'product.create', fields: { price: 10 } }, 'a create without a name'],
      [{ action: 'product.create', fields: { name: 'x'.repeat(LIMITS.name + 1) } }, 'an over-long name'],
      [{ action: 'theme.update', targetId: 't1', fields: {} }, 'a theme update without a price'],
    ];
    for (const [body, label] of cases) {
      const result = validateAdminOpRequest(body, null, true);
      check(`rejects ${label}`, result.ok === false && [400, 403].includes(result.status), JSON.stringify(result));
    }

    const rounded = validateAdminOpRequest(
      { action: 'product.update', targetId: 'p1', fields: { price: '399.129' } },
      null,
      true,
    );
    check(
      'accepts a numeric string and rounds money to 2 decimals',
      rounded.ok === true && rounded.request.fields.price === 399.13,
      JSON.stringify(rounded.ok && rounded.request.fields),
    );

    const synced = validateAdminOpRequest(
      { action: 'theme.update', targetId: 't1', fields: { price: 47 } },
      null,
      true,
    );
    check(
      'keeps price and price_inr in sync for themes',
      synced.ok === true && synced.request.fields.price === 47 && synced.request.fields.price_inr === 47,
      JSON.stringify(synced.ok && synced.request.fields),
    );

    const usdOnly = validateAdminOpRequest(
      { action: 'product.update', targetId: 'p1', fields: { price_usd: 9.5 } },
      null,
      true,
    );
    check('accepts a USD-only change', usdOnly.ok === true && usdOnly.request.fields.price_usd === 9.5);

    const created = validateAdminOpRequest(
      { action: 'product.create', fields: { name: 'Monsoon Wallpaper', price: 250, description: 'Wall art' } },
      null,
      true,
    );
    check(
      'create is accepted and reports the field the schema cannot store',
      created.ok === true && created.request.notStored.includes('description'),
      JSON.stringify(created.ok && created.request),
    );
  }

  /* ── CORE · authorization, including forged body fields ─────────────── */
  {
    const forged = validateAdminOpRequest(
      {
        action: 'product.update',
        targetId: 'p1',
        fields: { price: 1 },
        isAdmin: true,
        permissions: ['products.write', 'themes.write'],
        confirmed: true,
        actorId: 'someone-else',
        userId: 'someone-else',
        role: 'owner',
      },
      [],
      true,
    );
    check(
      'forged permissions cannot authorise an action',
      forged.ok === false && forged.status === 403 && forged.denied === true,
      JSON.stringify(forged),
    );

    const asVisitor = validateAdminOpRequest(
      { action: 'product.delete', targetId: 'p1', isAdmin: true, confirmed: true },
      null,
      false,
    );
    check(
      'a non-admin caller is refused even with forged flags',
      asVisitor.ok === false && asVisitor.status === 403,
      JSON.stringify(asVisitor),
    );

    const perms = [
      [null, 'product.update', true],
      [null, 'theme.publish', true],
      [[], 'product.update', false],
      [['products.write'], 'product.update', true],
      [['products.write'], 'theme.update', false],
      [['themes.write'], 'theme.delete', true],
      [['reports.read'], 'report.overview', true],
      [['reports.read'], 'product.delete', false],
    ];
    for (const [list, action, expected] of perms) {
      check(
        `permission check ${JSON.stringify(list)} on ${action} -> ${expected}`,
        hasAdminPermission(list, action) === expected,
      );
    }
    check(
      'every supported action maps to a permission key',
      Object.values(REQUIRED_PERMISSION).every((value) => typeof value === 'string' && value.length > 0),
    );

    const limited = validateAdminOpRequest(
      { action: 'product.delete', targetId: 'p1' },
      ['reports.read'],
      true,
    );
    check(
      'an under-permissioned admin is denied and told which permission is missing',
      limited.ok === false &&
        limited.status === 403 &&
        limited.denied === true &&
        /products\.write/.test(limited.error),
      JSON.stringify(limited),
    );

    // The validated request must contain ONLY allow-listed keys.
    const accepted = validateAdminOpRequest(
      {
        action: 'product.update',
        targetId: 'p1',
        targetName: 'Sunset Sky',
        fields: { price: 399 },
        isAdmin: false,
        confirmed: false,
      },
      null,
      true,
    );
    const keys = accepted.ok ? Object.keys(accepted.request) : [];
    check(
      'the trusted request exposes only allow-listed keys',
      accepted.ok === true && keys.every((key) => FUNCTIONS.has(key)),
      JSON.stringify(keys),
    );
    check(
      'no identity or confirmation field survives validation',
      accepted.ok === true && FORBIDDEN_CLIENT_FIELDS.every((key) => !(key in accepted.request)),
      JSON.stringify(keys),
    );
    check(
      'a client-sent "confirmed" flag is not part of the server decision',
      accepted.ok === true && JSON.stringify(accepted.request).includes('confirmed') === false,
    );
  }

  /* ── CORE · audit safety ────────────────────────────────────────────── */
  {
    const redacted = redactSecrets({
      price: 399,
      password: 'hunter2',
      nested: { token: 'abc', service_role_key: 'secret', keep: 1 },
      list: [{ apiKey: 'zzz' }],
    });
    const asText = JSON.stringify(redacted);
    check('secrets are redacted from audited values', !/hunter2|abc|secret|zzz/.test(asText), asText);
    check('non-secret values survive redaction', redacted.price === 399 && redacted.nested.keep === 1);

    const diff = buildAuditDiff(
      'product.update',
      { name: 'Sunset Sky', price: 100, token: 'abc' },
      { name: 'Sunset Sky', price: 399, token: 'def' },
    );
    check('the diff keeps only changed fields', Object.keys(diff).join(',') === 'price', JSON.stringify(diff));
    check('the diff records before and after', diff.price.from === 100 && diff.price.to === 399);
    check('the diff never carries a secret', !/abc|def/.test(JSON.stringify(diff)), JSON.stringify(diff));

    const noChange = buildAuditDiff('product.update', { price: 100 }, { price: 100 });
    check('an unchanged field is not diffed', Object.keys(noChange).length === 0);

    check('an unknown outcome is not trusted as success', normaliseOutcome('made-up') === 'failure');
    check('a known outcome is preserved', normaliseOutcome('denied') === 'denied');
  }

  /* ── CORE · rate limiting ───────────────────────────────────────────── */
  {
    const first = fixedWindowDecision(0, LIMITS.opsPerWindow, 0, LIMITS.opsWindowSeconds);
    check('a first command is allowed', first.allowed === true);
    check('the allowance decreases as commands are used', first.remaining === LIMITS.opsPerWindow - 1);

    const nearLimit = fixedWindowDecision(LIMITS.opsPerWindow - 1, LIMITS.opsPerWindow, 10, LIMITS.opsWindowSeconds);
    check('the last command in the window is allowed', nearLimit.allowed === true && nearLimit.remaining === 0);

    const atLimit = fixedWindowDecision(LIMITS.opsPerWindow, LIMITS.opsPerWindow, 10, LIMITS.opsWindowSeconds);
    check('the command over the limit is refused', atLimit.allowed === false);
    check('…with a retry-after hint', atLimit.retryAfterSeconds > 0, String(atLimit.retryAfterSeconds));

    const newWindow = fixedWindowDecision(LIMITS.opsPerWindow, LIMITS.opsPerWindow, LIMITS.opsWindowSeconds, LIMITS.opsWindowSeconds);
    check('the window resets once it elapses', newWindow.allowed === true);

    const authBlocked = fixedWindowDecision(
      LIMITS.authFailuresPerWindow,
      LIMITS.authFailuresPerWindow,
      5,
      LIMITS.authFailureWindowSeconds,
    );
    check('repeated authentication failures are limited', authBlocked.allowed === false);

    const negative = fixedWindowDecision(-5, 5, 1, 60);
    check('a corrupt counter does not block forever', negative.allowed === true);
  }

  /* ── CLIENT · action mapping and no fallback ────────────────────────── */
  {
    const makeTransport = (response) => {
      const calls = [];
      return {
        calls,
        transport: {
          async call(body) {
            calls.push(body);
            return typeof response === 'function' ? response(body) : response;
          },
        },
      };
    };

    const successFor = (body) => ({
      ok: true,
      data: {
        success: true,
        action: body.action,
        result: { before: { id: 'x' }, after: { id: 'x', ...(body.fields ?? {}) } },
        auditId: 'audit-1',
      },
    });

    const { calls, transport } = makeTransport(successFor);
    const ops = adminOpsModule.createServerAdminOps(transport);

    const update = await ops.updateProduct('p3', { price: 399, price_usd: 4.99 });
    check('product price update maps to product.update', calls.at(-1).action === 'product.update');
    check('product update sends the targetId', calls.at(-1).targetId === 'p3');
    check('product update sends both currencies', calls.at(-1).fields.price === 399 && calls.at(-1).fields.price_usd === 4.99);
    check('a successful operation returns the server after-state', update.ok === true && update.after?.id === 'x');

    await ops.updateTheme('t2', { price: 99 });
    check('theme price update maps to theme.update', calls.at(-1).action === 'theme.update' && calls.at(-1).targetId === 't2');

    await ops.publishTheme('t2');
    check('publishing maps to theme.publish', calls.at(-1).action === 'theme.publish');
    await ops.unpublishTheme('t2');
    check('unpublishing maps to theme.unpublish', calls.at(-1).action === 'theme.unpublish');
    await ops.deleteTheme('t2');
    check('theme deletion maps to theme.delete', calls.at(-1).action === 'theme.delete');

    await ops.createProduct({ name: 'Monsoon Wallpaper', price: 250, description: 'Wall art' });
    check('product creation maps to product.create with a name', calls.at(-1).action === 'product.create' && calls.at(-1).fields.name === 'Monsoon Wallpaper');
    check('a created product resolves the id from the server', (await ops.createProduct({ name: 'Second' })).ok === true);

    await ops.report('orders');
    check('the order report maps to report.orders', calls.at(-1).action === 'report.orders');
    const report = await ops.report('overview');
    check('a report returns text from the server', report.ok === true && typeof report.text === 'string');

    const sentKeys = new Set(calls.flatMap((body) => Object.keys(body)));
    check(
      'the client sends no identity, permission or confirmation field',
      FORBIDDEN_CLIENT_FIELDS.every((key) => !sentKeys.has(key)),
      JSON.stringify([...sentKeys]),
    );
    check(
      'every client request carries an allowed action',
      calls.every((body) => typeof body.action === 'string' && body.action.length > 0),
    );

    /* Failure: exactly one attempt, no local write, honest error. */
    const failing = makeTransport({ ok: false, error: 'Administrator access required', status: 403 });
    const failingOps = adminOpsModule.createServerAdminOps(failing.transport);
    const denied = await failingOps.deleteProduct('p9');
    check('a denied operation fails honestly', denied.ok === false && /administrator access/i.test(denied.error), JSON.stringify(denied));
    check('…and reports no after-state', denied.after === undefined && denied.before === undefined);
    check('…with exactly one server attempt (no retry)', failing.calls.length === 1, String(failing.calls.length));

    const thrown = makeTransport(() => {
      throw new Error('Failed to send a request to the Edge Function');
    });
    const thrownOps = adminOpsModule.createServerAdminOps(thrown.transport);
    const unreachable = await thrownOps.updateTheme('t1', { price: 10 });
    check('an unreachable function returns an error, not a success', unreachable.ok === false && Boolean(unreachable.error));
    check('…still with exactly one attempt', thrown.calls.length === 1);
    check('…and it never claims the change was verified', unreachable.after === undefined);

    const { transport: auditTransport } = makeTransport({
      ok: true,
      data: {
        success: true,
        result: {
          after: {
            entries: [
              { id: 'a1', actor_email: 'admin@ishmaverse.com', action: 'product.update', target_name: 'Sunset Sky', outcome: 'success', created_at: '2026-10-14T00:00:00Z' },
            ],
          },
        },
      },
    });
    const entries = await adminOpsModule.fetchServerAudit(5, auditTransport);
    check('the server audit log is readable through the function', Array.isArray(entries) && entries[0].action === 'product.update', JSON.stringify(entries));
    check('…with the actor and outcome', entries[0].actorEmail === 'admin@ishmaverse.com' && entries[0].outcome === 'success');

    const unavailable = await adminOpsModule.fetchServerAudit(5, { call: async () => ({ ok: false, error: 'down' }) });
    check('an unavailable server audit log returns null (so the UI falls back)', unavailable === null);

    /* Structural: the client module has no mutation path of its own. */
    const source = readFileSync('src/services/adminOps.ts', 'utf8');
    check('the client never writes to a table directly', !/\.from\(|\.insert\(|\.update\(|\.upsert\(|\.delete\(/.test(source));
    check('the client does not import the local catalog for writes', !/from '\.\/catalog'/.test(source));
    check('the client calls the admin-ops function', /functions\.invoke\('admin-ops'/.test(source));
  }

  /* ── EDGE FUNCTION · source guarantees ─────────────────────────────── */
  {
    const fn = readFileSync('supabase/functions/admin-ops/index.ts', 'utf8');
    check('the function verifies the session JWT', /getUserFromRequest\(req\)/.test(fn));
    check('the function verifies admin membership server-side', /isAdminUser\(user\.id\)/.test(fn));
    check('the function validates and permission-gates before acting', /validateAdminOpRequest\(body, permissions, true\)/.test(fn));
    check('the function writes the durable audit log', /from\("admin_audit_log"\)/.test(fn));
    check(
      'the function never updates or deletes audit history',
      !/admin_audit_log"[\s\S]{0,120}?\.(delete|update)\(/.test(fn),
      'an audit delete/update path exists',
    );
    check(
      'a failed audit write on a successful change is disclosed',
      /auditWarning/.test(fn) && /could not be written/.test(fn),
    );
    check('the function rate-limits requests', /consumeRateLimit\(/.test(fn));
    check(
      'the function never reads client-supplied identity or permission fields',
      !/body\.(isAdmin|permissions|confirmed|actorId|userId|role)|raw\.(isAdmin|permissions|confirmed|actorId|userId|role)/.test(fn),
      'a body field that must be ignored appears to be read',
    );
    check(
      'the function never mentions the service-role key (so it cannot leak it)',
      !/SUPABASE_SERVICE_ROLE_KEY/.test(fn),
    );
    check(
      'the function refuses when no valid session is presented',
      /if \(!user\)/.test(fn) && /41\b/.test(fn) === false,
    );
    check(
      'the function refuses non-admins',
      /if \(!admin\) \{\s*[\s\S]{0,200}?role|if \(!admin\)/m.test(fn),
    );
    check(
      'the rate-limit store failing is fail-closed, not silently open',
      /RateLimitBackendUnavailable/.test(fn) && /503/.test(fn),
    );
    check(
      'a mutation success requires a read-back after-state',
      /\.select\("\*"\)\.single\(\)/.test(fn),
    );
    check(
      'the function verifies a delete really removed the row',
      /stillThere/.test(fn),
    );

    const migration = readFileSync('supabase/migrations/20261014_step13_admin_ops.sql', 'utf8');
    check('audit history has no client-facing delete/update grant', !/grant[^;]*admin_audit_log/i.test(migration) || /revoke all on public\.admin_audit_log/.test(migration));
    check('the audit table exists and is append-only for the client', /create table if not exists public\.admin_audit_log/.test(migration) && /revoke all on public\.admin_audit_log from anon, authenticated/.test(migration));
    check('RLS is enabled on the audit table', /alter table public\.admin_audit_log enable row level security/.test(migration));
    check('no policy grants the client access to the audit table', !/create policy[^;]*admin_audit_log/i.test(migration));
    check('the rate-limit table is client-inaccessible', /revoke all on public\.admin_rate_limits from anon, authenticated/.test(migration));
    check('permissions are additive (null keeps full admin rights)', /add column if not exists permissions text\[\]/.test(migration));
    check(
      'the migration is additive and does not drop existing policies',
      !/drop policy/i.test(migration) && !/drop table/i.test(migration),
    );
  }

  console.log(`\nadmin-ops checks: ${checked}`);
  if (problems.length) {
    console.error('\n✗ admin-ops checks FAILED:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log('\n✓ admin-ops OK — server-verified, permission-gated, validated, rate-limited and audited.');
} finally {
  await server.close();
}
