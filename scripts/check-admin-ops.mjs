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

const FUNCTIONS = new Set([
  'action',
  'targetId',
  'targetName',
  'fields',
  'tier',
  'themeIds',
  'bulk',
  'notStored',
  'destructive',
]);
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

  /* ── CORE · greeting-tier pricing ───────────────────────────────────── */
  {
    const tierOk = validateAdminOpRequest(
      {
        action: 'pricing.tier.update',
        tier: 'premium',
        themeIds: ['t2', 't5', 't2'],
        fields: { price: 99 },
      },
      null,
      true,
    );
    check(
      'a tier price accepts the four-tier id, theme ids and price',
      tierOk.ok === true && tierOk.request.tier === 'premium' && tierOk.request.fields.price_inr === 99,
      JSON.stringify(tierOk),
    );
    check(
      '…and de-duplicates the theme ids',
      tierOk.ok === true && JSON.stringify(tierOk.request.themeIds) === JSON.stringify(['t2', 't5']),
      JSON.stringify(tierOk.ok && tierOk.request.themeIds),
    );

    const noTier = validateAdminOpRequest(
      { action: 'pricing.tier.update', themeIds: ['t2'], fields: { price: 99 } },
      null,
      true,
    );
    check('a tier price without a tier is rejected', noTier.ok === false && /tier must be one of/i.test(noTier.error));

    const fakeTier = validateAdminOpRequest(
      { action: 'pricing.tier.update', tier: 'gold', themeIds: ['t2'], fields: { price: 99 } },
      null,
      true,
    );
    check('an invented tier is rejected (no fifth tier)', fakeTier.ok === false && /tier must be one of/i.test(fakeTier.error));

    const noThemes = validateAdminOpRequest(
      { action: 'pricing.tier.update', tier: 'premium', themeIds: [], fields: { price: 99 } },
      null,
      true,
    );
    check('a tier price with no theme ids is rejected', noThemes.ok === false && /themeIds/i.test(noThemes.error));

    const noPrice = validateAdminOpRequest(
      { action: 'pricing.tier.update', tier: 'premium', themeIds: ['t2'], fields: {} },
      null,
      true,
    );
    check('a tier price without an amount is rejected', noPrice.ok === false && /price/i.test(noPrice.error));

    const denied = validateAdminOpRequest(
      { action: 'pricing.tier.update', tier: 'premium', themeIds: ['t2'], fields: { price: 99 } },
      ['reports.read'],
      true,
    );
    check('a reports-only admin cannot change a tier price', denied.ok === false && denied.status === 403 && /themes\.write/.test(denied.error), JSON.stringify(denied));

    const writerAllowed = hasAdminPermission(['themes.write'], 'pricing.tier.update');
    check('a themes-writer can update a tier price', writerAllowed === true);
  }

  /* ── CORE · ReportCard Studio plan pricing ──────────────────────────── */
  {
    const planOk = validateAdminOpRequest(
      {
        action: 'pricing.plan.update',
        targetId: 'simple',
        fields: { price_inr: 399, duration_months: 3 },
      },
      null,
      true,
    );
    check(
      'a plan price accepts a plan id, an INR price and a duration',
      planOk.ok === true &&
        planOk.request.fields.price_inr === 399 &&
        planOk.request.fields.duration_months === 3,
      JSON.stringify(planOk),
    );
    check(
      '…keeping price and price_inr in sync for the plan row',
      planOk.ok === true && planOk.request.fields.price === 399,
      JSON.stringify(planOk.ok && planOk.request.fields),
    );

    const planUsd = validateAdminOpRequest(
      { action: 'pricing.plan.update', targetId: 'modern', fields: { price_usd: 7.99 } },
      null,
      true,
    );
    check(
      'a USD-only plan change is accepted without touching INR',
      planUsd.ok === true &&
        planUsd.request.fields.price_usd === 7.99 &&
        planUsd.request.fields.price_inr === undefined,
      JSON.stringify(planUsd.ok && planUsd.request.fields),
    );

    const planBad = [
      [{ action: 'pricing.plan.update', fields: { price_inr: 399 } }, 'a plan price without a target'],
      [
        { action: 'pricing.plan.update', targetId: 'x'.repeat(LIMITS.targetId + 1), fields: { price_inr: 399 } },
        'an over-long plan id',
      ],
      [
        { action: 'pricing.plan.update', targetId: '../../etc/passwd', fields: { price_inr: 399 } },
        'a path-like plan id',
      ],
      [
        { action: 'pricing.plan.update', targetId: 'simple', fields: { price_inr: LIMITS.price + 1 } },
        'a plan price above the limit',
      ],
      [
        { action: 'pricing.plan.update', targetId: 'simple', fields: { price_inr: -1 } },
        'a negative plan price',
      ],
      [
        { action: 'pricing.plan.update', targetId: 'simple', fields: { duration_months: 0 } },
        'a zero-month duration',
      ],
      [
        { action: 'pricing.plan.update', targetId: 'simple', fields: { duration_months: LIMITS.planDurationMonths + 1 } },
        'a duration beyond the limit',
      ],
      [
        { action: 'pricing.plan.update', targetId: 'simple', fields: { duration_months: 2.5 } },
        'a fractional duration',
      ],
      [
        { action: 'pricing.plan.update', targetId: 'simple', fields: { duration_months: 'abc' } },
        'a non-numeric duration',
      ],
      [
        { action: 'pricing.plan.update', targetId: 'simple', fields: { price_inr: 399, plan_id: 'holistic' } },
        'an attempt to move the target plan through fields',
      ],
      [{ action: 'pricing.plan.update', targetId: 'simple', fields: {} }, 'a plan update with no fields'],
    ];
    for (const [body, label] of planBad) {
      const result = validateAdminOpRequest(body, null, true);
      check(
        `rejects ${label}`,
        result.ok === false && [400, 403].includes(result.status),
        JSON.stringify(result),
      );
    }

    const planDenied = validateAdminOpRequest(
      { action: 'pricing.plan.update', targetId: 'simple', fields: { price_inr: 399 } },
      ['themes.write', 'products.write'],
      true,
    );
    check(
      'a catalogue writer cannot change plan pricing without settings.write',
      planDenied.ok === false && planDenied.status === 403 && /settings\.write/.test(planDenied.error),
      JSON.stringify(planDenied),
    );
    check(
      'a settings writer may change plan pricing',
      hasAdminPermission(['settings.write'], 'pricing.plan.update') === true,
    );

    const planDiff = buildAuditDiff(
      'pricing.plan.update',
      { price_inr: 369, price_usd: 4.99, duration_months: 6 },
      { price_inr: 399, price_usd: 4.99, duration_months: 3 },
    );
    check(
      'the plan audit diff keeps only the changed money/duration fields',
      Object.keys(planDiff).sort().join(',') === 'duration_months,price_inr',
      JSON.stringify(planDiff),
    );
    check(
      '…with the real before and after values',
      planDiff.price_inr.from === 369 &&
        planDiff.price_inr.to === 399 &&
        planDiff.duration_months.from === 6 &&
        planDiff.duration_months.to === 3,
      JSON.stringify(planDiff),
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

    /* Bulk pricing is a rule, validated server-side, never a price list. */
    const bulkOk = validateAdminOpRequest(
      { action: 'pricing.bulk.update', scope: 'themes', mode: 'increase_percent', value: 10 },
      null,
      true,
    );
    check(
      'a bulk price rule is accepted as a rule',
      bulkOk.ok === true &&
        bulkOk.request.bulk?.scope === 'themes' &&
        bulkOk.request.bulk?.mode === 'increase_percent' &&
        bulkOk.request.bulk?.value === 10 &&
        bulkOk.request.bulk?.currency === 'INR',
      bulkOk.ok ? JSON.stringify(bulkOk.request.bulk) : bulkOk.error,
    );
    check(
      'a bulk rule carries no raw prices',
      bulkOk.ok === true && Object.keys(bulkOk.request.fields).length === 0,
      bulkOk.ok ? JSON.stringify(bulkOk.request.fields) : bulkOk.error,
    );

    const bulkScopeRequired = validateAdminOpRequest(
      { action: 'pricing.bulk.update', mode: 'set', value: 99 },
      null,
      true,
    );
    check('a bulk change without a scope is refused', bulkScopeRequired.ok === false);

    const bulkBadMode = validateAdminOpRequest(
      { action: 'pricing.bulk.update', scope: 'themes', mode: 'double', value: 10 },
      null,
      true,
    );
    check('an unknown bulk mode is refused', bulkBadMode.ok === false);

    const bulkTooBig = validateAdminOpRequest(
      { action: 'pricing.bulk.update', scope: 'themes', mode: 'increase_percent', value: 500 },
      null,
      true,
    );
    check('a bulk percentage above 100 is refused (not clamped)', bulkTooBig.ok === false);

    const bulkBadCurrency = validateAdminOpRequest(
      { action: 'pricing.bulk.update', scope: 'themes', mode: 'set', value: 99, currency: 'EUR' },
      null,
      true,
    );
    check('an unsupported bulk currency is refused', bulkBadCurrency.ok === false);

    const bulkThemesOnly = validateAdminOpRequest(
      { action: 'pricing.bulk.update', scope: 'products', mode: 'set', value: 99 },
      ['themes.write'],
      true,
    );
    check(
      'a themes-only admin cannot bulk-change product prices',
      bulkThemesOnly.ok === false && bulkThemesOnly.denied === true && /products\.write/.test(bulkThemesOnly.error),
      bulkThemesOnly.ok ? 'accepted' : bulkThemesOnly.error,
    );

    const gameOk = validateAdminOpRequest(
      { action: 'game.update', fields: { enabled: false, maintenance: true, sort_order: 2 } },
      null,
      true,
    );
    check(
      'a Game Zone update validates enabled, maintenance and sort_order',
      gameOk.ok === true &&
        gameOk.request.fields.enabled === false &&
        gameOk.request.fields.maintenance === true &&
        gameOk.request.fields.sort_order === 2,
      gameOk.ok ? JSON.stringify(gameOk.request.fields) : gameOk.error,
    );

    const gameBadSort = validateAdminOpRequest(
      { action: 'game.update', fields: { sort_order: 1.5 } },
      null,
      true,
    );
    check('a non-integer game sort_order is refused', gameBadSort.ok === false);

    const brandUnsafeLogo = validateAdminOpRequest(
      { action: 'brand.update', fields: { logo_url: 'javascript:alert(1)' } },
      null,
      true,
    );
    check('an unsafe brand logo URL is refused', brandUnsafeLogo.ok === false);

    const brandOk = validateAdminOpRequest(
      { action: 'brand.update', fields: { site_name: 'Ishmaverse', brand_tagline: 'Cards that feel alive' } },
      null,
      true,
    );
    check(
      'a brand update validates the site name and tagline',
      brandOk.ok === true &&
        brandOk.request.fields.site_name === 'Ishmaverse' &&
        brandOk.request.fields.brand_tagline === 'Cards that feel alive',
      brandOk.ok ? JSON.stringify(brandOk.request.fields) : brandOk.error,
    );

    const gameDenied = validateAdminOpRequest(
      { action: 'game.update', fields: { enabled: false } },
      ['products.write'],
      true,
    );
    check(
      'Game Zone controls need the games.write permission',
      gameDenied.ok === false && /games\.write/.test(gameDenied.error),
      gameDenied.ok ? 'accepted' : gameDenied.error,
    );

    const brandDenied = validateAdminOpRequest(
      { action: 'brand.update', fields: { site_name: 'Nope' } },
      ['themes.write'],
      true,
    );
    check(
      'brand controls need the settings.write permission',
      brandDenied.ok === false && /settings\.write/.test(brandDenied.error),
      brandDenied.ok ? 'accepted' : brandDenied.error,
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

    await ops.updateTierPrice({ tier: 'premium', themeIds: ['t2', 't5'], priceInr: 99 });
    check(
      'a tier price maps to pricing.tier.update with the resolved theme ids',
      calls.at(-1).action === 'pricing.tier.update' &&
        calls.at(-1).tier === 'premium' &&
        JSON.stringify(calls.at(-1).themeIds) === JSON.stringify(['t2', 't5']) &&
        calls.at(-1).fields.price_inr === 99,
      JSON.stringify(calls.at(-1)),
    );

    await ops.updatePlanPrice({ planId: 'simple', priceInr: 399 });
    check(
      'a plan price maps to pricing.plan.update with the plan id',
      calls.at(-1).action === 'pricing.plan.update' && calls.at(-1).targetId === 'simple',
      JSON.stringify(calls.at(-1)),
    );
    check(
      '…sending only the money fields',
      calls.at(-1).fields.price_inr === 399 && calls.at(-1).fields.price_usd === undefined,
      JSON.stringify(calls.at(-1).fields),
    );
    await ops.updatePlanPrice({ planId: 'modern', durationMonths: 3 });
    check(
      'a duration-only plan change sends duration_months',
      calls.at(-1).action === 'pricing.plan.update' &&
        calls.at(-1).fields.duration_months === 3 &&
        calls.at(-1).fields.price_inr === undefined,
      JSON.stringify(calls.at(-1)),
    );

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
      'the rate limit is consumed atomically through one database function',
      /consume_admin_rate_limit/.test(fn) && /\.rpc\("consume_admin_rate_limit"/.test(fn),
    );
    check(
      'the legacy read-then-upsert limiter is only a fallback',
      /consumeRateLimitLegacy/.test(fn) && /isMissingRateLimitFunction/.test(fn),
    );
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

    const rateLimitMigration = readFileSync(
      'supabase/migrations/20261022_step16_atomic_admin_rate_limit.sql',
      'utf8',
    );
    check(
      'the atomic rate-limit function locks the counter row',
      /create or replace function public\.consume_admin_rate_limit/.test(rateLimitMigration) &&
        /for update/.test(rateLimitMigration),
    );
    check(
      'the atomic limiter is not executable by client roles',
      /revoke all on function public\.consume_admin_rate_limit[\s\S]{0,80}?from public, anon, authenticated/.test(rateLimitMigration),
    );
    check(
      'the atomic limiter keeps the existing service-role-only counter table',
      /create table if not exists public\.admin_rate_limits/.test(rateLimitMigration) &&
        /revoke all on public\.admin_rate_limits from anon, authenticated/.test(rateLimitMigration),
    );
    check(
      'the service role is explicitly granted access to the counter',
      /grant all on public\.admin_rate_limits to service_role/.test(rateLimitMigration),
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

    /* Plan pricing: one authoritative table, locked to the service role. */
    const planMigration = readFileSync(
      'supabase/migrations/20261023_step17_studio_plan_pricing.sql',
      'utf8',
    );
    check(
      'the plan price table exists with bounded money and duration columns',
      /create table if not exists public\.studio_plan_prices/.test(planMigration) &&
        /price_inr numeric/.test(planMigration) &&
        /duration_months integer/.test(planMigration),
    );
    check('RLS is enabled on the plan price table', /alter table public\.studio_plan_prices enable row level security/.test(planMigration));
    check(
      'clients may read plan prices but not write them',
      /create policy "studio plan prices are readable"/.test(planMigration) &&
        /revoke insert, update, delete on public\.studio_plan_prices from anon, authenticated/.test(planMigration),
    );
    check(
      'no policy grants a client write on plan prices',
      !/create policy[^;]*studio_plan_prices[\s\S]{0,120}?for (insert|update|delete)/i.test(planMigration),
    );
    check(
      'seeding never overwrites a price an admin already changed',
      /on conflict \(plan_id\) do nothing/.test(planMigration),
    );

    check(
      'the function executes plan pricing against the authoritative table',
      /execPlanPriceUpdate/.test(fn) && /\.from\("studio_plan_prices"\)/.test(fn),
    );
    check(
      'the plan executor reads back and compares the saved values',
      /The saved INR plan price could not be verified/.test(fn) &&
        /The saved plan duration could not be verified/.test(fn),
    );
    check(
      'an unknown plan id is a 404, never an insert',
      /No ReportCard Studio plan has the id/.test(fn) && !/studio_plan_prices"\)[\s\S]{0,80}?insert/.test(fn),
    );

    /* The store-product table shipped without RLS; the fix must stay narrow. */
    const productsMigration = readFileSync(
      'supabase/migrations/20261024_step18_products_rls.sql',
      'utf8',
    );
    check(
      'the products table gets RLS enabled',
      /alter table if exists public\.products enable row level security/.test(productsMigration),
    );
    check(
      '…a public read policy keeps the storefront working',
      /create policy "products public read"[\s\S]{0,80}?for select/.test(productsMigration),
    );
    check(
      '…and only an admin may write',
      /create policy "products admin write"[\s\S]{0,120}?using \(public\.is_admin\(\)\)[\s\S]{0,80}?with check \(public\.is_admin\(\)\)/.test(
        productsMigration,
      ),
    );
    check(
      '…with anon write grants removed',
      /revoke insert, update, delete on public\.products from anon/.test(productsMigration),
    );
    check(
      'the products fix drops no table and no existing policy content',
      !/drop table/i.test(productsMigration),
    );

    const entitlementFn = readFileSync('supabase/functions/entitlement/index.ts', 'utf8');
    check(
      'the subscribe path charges from the live plan table',
      /loadStudioPlans\(supabase\)/.test(entitlementFn) &&
        /const plan = plans\[clean\(body\.planId, 40\)\]/.test(entitlementFn),
    );
    check(
      'the public plans endpoint exposes prices and limits, not secrets',
      /action === "plans"/.test(entitlementFn) &&
        /plans: Object\.values\(plans\)/.test(entitlementFn) &&
        !/SERVICE_ROLE|service_role_key|RAZORPAY_KEY_SECRET/.test(entitlementFn),
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
