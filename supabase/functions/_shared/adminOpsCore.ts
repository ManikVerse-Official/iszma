// ============================================================================
// adminOpsCore — pure validation, permission and audit rules for `admin-ops`.
// ----------------------------------------------------------------------------
// This module holds NO imports and performs NO I/O on purpose: it is the part of
// the server boundary that can be unit-tested in plain Node (see
// scripts/check-admin-ops.mjs) as well as executed inside the Deno Edge
// Function. Everything here is a *rule*, never a network call.
//
// Security posture:
//   • The client is untrusted input. Anything it sends about identity,
//     permissions or confirmation is discarded — `validateAdminOpRequest`
//     returns a fresh object containing only allow-listed fields.
//   • Actions are an explicit allow-list; unknown or unsupported actions are
//     refused with a clear reason instead of being attempted.
//   • Every field and numeric limit is validated here before any DB call.
// ============================================================================

/** Read-only report actions (no mutation, no confirmation). */
export const REPORT_ACTIONS = ['report.overview', 'report.orders', 'report.audit'] as const;

/** Mutating actions the server can genuinely persist today. */
export const MUTATION_ACTIONS = [
  'product.create',
  'product.update',
  'product.delete',
  'theme.update',
  'theme.publish',
  'theme.unpublish',
  'theme.delete',
  'pricing.tier.update',
  'pricing.bulk.update',
  // ReportCard Studio plan price / billing duration (studio_plan_prices).
  'pricing.plan.update',
  'game.update',
  'brand.update',
] as const;

/**
 * The four greeting-card tiers that already exist in the product schema
 * (`GreetingTier` in src/types and TIER_OPTIONS in data/greetingThemes). A tier
 * price is stored on the existing `theme_prices` rows of the themes in it —
 * there is no separate tier product to create.
 */
export const GREETING_TIER_IDS = ['basic', 'plus', 'premium', 'elite'] as const;
export type GreetingTierId = (typeof GREETING_TIER_IDS)[number];
export const MAX_TIER_THEMES = 500;

export type AdminOpAction =
  | (typeof REPORT_ACTIONS)[number]
  | (typeof MUTATION_ACTIONS)[number];

export const ADMIN_OPS_ACTIONS: readonly string[] = [...REPORT_ACTIONS, ...MUTATION_ACTIONS];

/** Actions with no backing module. Kept refused, never faked. */
export const UNSUPPORTED_ACTIONS: readonly string[] = [
  'track.update',
  'track.publish',
  'track.unpublish',
  'music.update',
  'music.publish',
  'music.unpublish',
];

export const REQUIRED_PERMISSION: Record<AdminOpAction, string> = {
  'product.create': 'products.write',
  'product.update': 'products.write',
  'product.delete': 'products.write',
  'theme.update': 'themes.write',
  'theme.publish': 'themes.write',
  'theme.unpublish': 'themes.write',
  'theme.delete': 'themes.write',
  'pricing.tier.update': 'themes.write',
  // Scope-dependent: products.write for the product catalogue, themes.write for
  // greeting themes. Enforced in `validateAdminOpRequest`.
  'pricing.bulk.update': 'products.write',
  // Plan pricing is business configuration shown by another app, so it needs
  // the settings capability rather than a catalogue one.
  'pricing.plan.update': 'settings.write',
  'game.update': 'games.write',
  'brand.update': 'settings.write',
  'report.overview': 'reports.read',
  'report.orders': 'reports.read',
  'report.audit': 'reports.read',
};

/** The only game this build ships; it matches `GAME_ID` in src/services/gameZone.ts. */
export const GAME_ID = 'pair3balls';

/** Catalogue scopes a bulk price change can touch. */
export const BULK_SCOPES = ['products', 'themes'] as const;
export type BulkScope = (typeof BULK_SCOPES)[number];

/** How a bulk price change is calculated from each item's current price. */
export const BULK_MODES = ['set', 'increase_percent', 'decrease_percent'] as const;
export type BulkMode = (typeof BULK_MODES)[number];

/** Hard ceiling on one bulk operation, so a single command cannot rewrite the world. */
export const MAX_BULK_ITEMS = 200;

/** Which table a target lives in, used by the Edge Function's executors. */
export const TARGET_TABLE: Record<
  string,
  | 'products'
  | 'theme_prices'
  | 'theme_overrides'
  | 'game_settings'
  | 'site_settings'
  | 'studio_plan_prices'
> = {
  'product.create': 'products',
  'product.update': 'products',
  'product.delete': 'products',
  'theme.update': 'theme_prices',
  'theme.publish': 'theme_overrides',
  'theme.unpublish': 'theme_overrides',
  'theme.delete': 'theme_overrides',
  'pricing.bulk.update': 'theme_prices',
  'pricing.plan.update': 'studio_plan_prices',
  'game.update': 'game_settings',
  'brand.update': 'site_settings',
};

/** Actions that need a concrete target id (they cannot create one). */
export const ACTIONS_REQUIRING_TARGET: readonly string[] = [
  'pricing.plan.update',
  'product.update',
  'product.delete',
  'theme.update',
  'theme.publish',
  'theme.unpublish',
  'theme.delete',
];

/** Fields the client may send per action. Anything else is rejected. */
export const ALLOWED_FIELDS: Record<string, readonly string[]> = {
  'product.create': ['name', 'price', 'price_inr', 'price_usd', 'description'],
  'product.update': ['price', 'price_inr', 'price_usd', 'name'],
  'product.delete': [],
  'theme.update': ['price', 'price_inr', 'price_usd'],
  'theme.publish': [],
  'theme.unpublish': [],
  'theme.delete': [],
  'pricing.tier.update': ['price', 'price_inr', 'price_usd'],
  'pricing.plan.update': ['price', 'price_inr', 'price_usd', 'duration_months'],
  // Bulk changes are a rule (scope + mode + value), never a list of raw prices:
  // the server recalculates every price from the database it is about to write.
  'pricing.bulk.update': [],
  'game.update': ['enabled', 'maintenance', 'sort_order'],
  'brand.update': ['site_name', 'brand_tagline', 'logo_url'],
  'report.overview': [],
  'report.orders': [],
  'report.audit': [],
};

/**
 * Fields the client may send that this schema cannot store. They are accepted
 * but reported back in `notStored`, so the admin is never told a change was
 * saved when it was not.
 */
export const UNPERSISTED_FIELDS: Record<string, readonly string[]> = {
  'product.create': ['description'],
  'product.update': [],
};

/** Hard limits. Values outside these are rejected rather than clamped. */
export const LIMITS = {
  targetId: 120,
  targetName: 120,
  name: 120,
  description: 500,
  price: 1_000_000,
  siteName: 60,
  tagline: 160,
  logoUrl: 500,
  gameSortOrder: 999,
  /** Billing duration bounds for a ReportCard Studio plan (months). */
  planDurationMonths: 36,
  /** Admin commands per window, per actor. */
  opsPerWindow: 30,
  opsWindowSeconds: 60,
  /** Failed admin-ops authentications per window, per IP. */
  authFailuresPerWindow: 10,
  authFailureWindowSeconds: 60,
} as const;

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|service[_-]?role|jwt|authorization|cookie|bearer|otp|pin)/i;

/* ------------------------------------------------------------------ */
/* Permission                                                         */
/* ------------------------------------------------------------------ */

/**
 * Server-side permission decision. `permissions === null/undefined` means a full
 * admin (matches the current single-role project and the `admin_users.permissions`
 * column default). A list is treated as exhaustive.
 */
export const hasAdminPermission = (
  permissions: string[] | null | undefined,
  action: string,
): boolean => {
  const required = REQUIRED_PERMISSION[action as AdminOpAction];
  if (!required) return false;
  if (!permissions) return true;
  return permissions.includes(required);
};

/* ------------------------------------------------------------------ */
/* Request validation                                                 */
/* ------------------------------------------------------------------ */

export interface AdminOpRequest {
  action: AdminOpAction;
  targetId: string | null;
  targetName: string | null;
  /** Validated, allow-listed fields only. */
  fields: Record<string, number | string | boolean>;
  /** Only set for `pricing.tier.update`; validated against the four real tiers. */
  tier: GreetingTierId | null;
  /** Themes whose existing price rows make up the tier. Validated + de-duplicated. */
  themeIds: string[];
  /**
   * Only set for `pricing.bulk.update`: a rule the server applies to the live
   * table. The client never sends the resulting prices.
   */
  bulk: { scope: BulkScope; mode: BulkMode; value: number; currency: 'INR' | 'USD' } | null;
  /** Fields the client sent that the schema cannot store. */
  notStored: string[];
  destructive: boolean;
}

export interface ValidationOk {
  ok: true;
  request: AdminOpRequest;
}

export interface ValidationFail {
  ok: false;
  status: number;
  error: string;
  /** True when the caller was authenticated but not permitted. */
  denied: boolean;
  action: string | null;
}

export type ValidationResult = ValidationOk | ValidationFail;

const fail = (
  status: number,
  error: string,
  action: string | null = null,
  denied = false,
): ValidationFail => ({ ok: false, status, error, denied, action });

const asTrimmedString = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) return null;
  return trimmed;
};

const asPrice = (value: unknown): number | null => {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return null;
  if (numeric < 0) return null;
  if (numeric > LIMITS.price) return null;
  // Money is stored with at most 2 decimals.
  return Math.round(numeric * 100) / 100;
};

/**
 * Validates an arbitrary request body into a trusted operation description.
 *
 * Fields the client must never be able to set — `isAdmin`, `permissions`,
 * `actorId`, `confirmed`, `userId`, `role` — are simply not read, so a forged
 * value cannot survive into the operation.
 */
export const validateAdminOpRequest = (
  body: unknown,
  /** Server-derived permissions. `null` = full admin. */
  permissions: string[] | null | undefined,
  /** If false, even a valid action is refused (not authenticated as admin). */
  authenticatedAdmin = true,
): ValidationResult => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail(400, 'A JSON body with an "action" is required.');
  }

  const raw = body as Record<string, unknown>;
  const rawAction = typeof raw.action === 'string' ? raw.action.trim() : '';

  if (!rawAction) return fail(400, 'An action is required.');

  if (UNSUPPORTED_ACTIONS.includes(rawAction)) {
    return fail(
      501,
      'That action has no server-side implementation in this build, so it cannot be run.',
      rawAction,
    );
  }

  if (!ADMIN_OPS_ACTIONS.includes(rawAction)) {
    return fail(400, `Unknown action "${rawAction}".`, rawAction);
  }

  const action = rawAction as AdminOpAction;

  // Authorisation: identity comes from the verified JWT, never the body.
  if (!authenticatedAdmin) {
    return fail(403, 'Administrator access required.', action, true);
  }
  // A bulk change can touch either catalogue, so its permission depends on the
  // scope in the (validated) body; it is checked below once the scope is known.
  if (action !== 'pricing.bulk.update' && !hasAdminPermission(permissions, action)) {
    return fail(
      403,
      `Your account does not have the "${REQUIRED_PERMISSION[action]}" permission.`,
      action,
      true,
    );
  }

  const targetId = raw.targetId === undefined || raw.targetId === null
    ? null
    : asTrimmedString(raw.targetId, LIMITS.targetId);
  const targetName = raw.targetName === undefined || raw.targetName === null
    ? null
    : asTrimmedString(raw.targetName, LIMITS.targetName);

  let tier: GreetingTierId | null = null;
  let themeIds: string[] = [];
  let bulk: AdminOpRequest['bulk'] = null;

  if (action === 'pricing.tier.update') {
    const rawTier =
      typeof raw.tier === 'string' ? raw.tier.trim().toLowerCase() : '';
    if (!(GREETING_TIER_IDS as readonly string[]).includes(rawTier)) {
      return fail(
        400,
        `tier must be one of: ${GREETING_TIER_IDS.join(', ')}.`,
        action,
      );
    }
    tier = rawTier as GreetingTierId;

    if (!Array.isArray(raw.themeIds) || raw.themeIds.length === 0) {
      return fail(400, 'themeIds must be a non-empty array of theme ids.', action);
    }
    if (raw.themeIds.length > MAX_TIER_THEMES) {
      return fail(400, `themeIds may contain at most ${MAX_TIER_THEMES} ids.`, action);
    }
    const seen = new Set<string>();
    for (const value of raw.themeIds) {
      const id = asTrimmedString(value, LIMITS.targetId);
      if (!id) {
        return fail(400, 'Every theme id must be a non-empty string of at most 120 characters.', action);
      }
      seen.add(id);
    }
    themeIds = [...seen];
  }

  if (action === 'pricing.bulk.update') {
    const rawScope = typeof raw.scope === 'string' ? raw.scope.trim().toLowerCase() : '';
    if (!(BULK_SCOPES as readonly string[]).includes(rawScope)) {
      return fail(400, `scope must be one of: ${BULK_SCOPES.join(', ')}.`, action);
    }
    const scope = rawScope as BulkScope;

    const scopePermission = scope === 'products' ? 'products.write' : 'themes.write';
    if (permissions && !permissions.includes(scopePermission)) {
      return fail(
        403,
        `Your account does not have the "${scopePermission}" permission.`,
        action,
        true,
      );
    }

    const rawMode = typeof raw.mode === 'string' ? raw.mode.trim().toLowerCase() : '';
    if (!(BULK_MODES as readonly string[]).includes(rawMode)) {
      return fail(400, `mode must be one of: ${BULK_MODES.join(', ')}.`, action);
    }
    const mode = rawMode as BulkMode;

    const numeric = typeof raw.value === 'string' ? Number(raw.value) : raw.value;
    if (typeof numeric !== 'number' || !Number.isFinite(numeric) || numeric <= 0) {
      return fail(400, 'value must be a positive number.', action);
    }
    const value = Math.round(numeric * 100) / 100;
    if (mode === 'set' && value > LIMITS.price) {
      return fail(400, `A price must be between 0 and ${LIMITS.price}.`, action);
    }
    if (mode !== 'set' && value > 100) {
      return fail(400, 'A percentage change must be between 0 and 100.', action);
    }

    const rawCurrency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : 'INR';
    if (rawCurrency !== 'INR' && rawCurrency !== 'USD') {
      return fail(400, 'currency must be INR or USD.', action);
    }

    bulk = { scope, mode, value, currency: rawCurrency };
  }

  if (raw.targetId !== undefined && raw.targetId !== null && !targetId) {
    return fail(400, 'targetId must be a non-empty string of at most 120 characters.', action);
  }
  if (raw.targetName !== undefined && raw.targetName !== null && !targetName) {
    return fail(400, 'targetName must be a non-empty string of at most 120 characters.', action);
  }

  if (ACTIONS_REQUIRING_TARGET.includes(action) && !targetId) {
    return fail(400, 'A concrete targetId is required for this action.', action);
  }
  /*
   * A plan id is one of the short, lower-case ids this product ships
   * (`simple`, `modern`, `holistic`). Restricting the shape means a caller can
   * never inject SQL-ish or path-like targets; whether the plan exists is
   * checked against the table by the executor.
   */
  if (action === 'pricing.plan.update' && targetId && !/^[a-z][a-z0-9_]{0,39}$/.test(targetId)) {
    return fail(400, 'targetId must be a lower-case plan id (letters, digits or underscore).', action);
  }

  // The client may send `fields` (preferred) or `patch`; anything else is ignored.
  const source = (raw.fields ?? raw.patch ?? {}) as unknown;
  if (source !== null && (typeof source !== 'object' || Array.isArray(source))) {
    return fail(400, 'fields must be an object.', action);
  }
  const sourceFields = (source ?? {}) as Record<string, unknown>;

  const allowed = ALLOWED_FIELDS[action] ?? [];
  const accepted: Record<string, number | string | boolean> = {};
  const notStored: string[] = [];

  for (const key of Object.keys(sourceFields)) {
    const value = sourceFields[key];
    if (value === undefined || value === null || value === '') continue;
    if (!allowed.includes(key)) {
      return fail(400, `Field "${key}" is not allowed for ${action}.`, action);
    }
    if (key === 'price' || key === 'price_inr' || key === 'price_usd') {
      const price = asPrice(value);
      if (price === null) {
        return fail(400, `${key} must be a number between 0 and ${LIMITS.price}.`, action);
      }
      accepted[key] = price;
      continue;
    }
    if (key === 'duration_months') {
      const months = typeof value === 'string' ? Number(value) : value;
      if (
        typeof months !== 'number' ||
        !Number.isInteger(months) ||
        months < 1 ||
        months > LIMITS.planDurationMonths
      ) {
        return fail(
          400,
          `duration_months must be a whole number between 1 and ${LIMITS.planDurationMonths}.`,
          action,
        );
      }
      accepted[key] = months;
      continue;
    }
    if (key === 'name') {
      const name = asTrimmedString(value, LIMITS.name);
      if (!name) return fail(400, `name must be 1 to ${LIMITS.name} characters.`, action);
      accepted[key] = name;
      continue;
    }
    if (key === 'enabled' || key === 'maintenance') {
      if (typeof value !== 'boolean') {
        return fail(400, `${key} must be true or false.`, action);
      }
      accepted[key] = value;
      continue;
    }
    if (key === 'sort_order') {
      const order = typeof value === 'string' ? Number(value) : value;
      if (
        typeof order !== 'number' ||
        !Number.isInteger(order) ||
        order < 0 ||
        order > LIMITS.gameSortOrder
      ) {
        return fail(400, `sort_order must be a whole number between 0 and ${LIMITS.gameSortOrder}.`, action);
      }
      accepted[key] = order;
      continue;
    }
    if (key === 'site_name') {
      const siteName = asTrimmedString(value, LIMITS.siteName);
      if (!siteName) return fail(400, `site_name must be 1 to ${LIMITS.siteName} characters.`, action);
      accepted[key] = siteName;
      continue;
    }
    if (key === 'brand_tagline') {
      const tagline = asTrimmedString(value, LIMITS.tagline);
      if (!tagline) return fail(400, `brand_tagline must be 1 to ${LIMITS.tagline} characters.`, action);
      accepted[key] = tagline;
      continue;
    }
    if (key === 'logo_url') {
      const logo = asTrimmedString(value, LIMITS.logoUrl);
      const safeLogo = logo && (/^https?:\/\//i.test(logo) || /^\/(?!\/)/.test(logo));
      if (!logo || !safeLogo) {
        return fail(400, 'logo_url must be an http(s) URL or a site-relative path such as /ishmaverse.png.', action);
      }
      accepted[key] = logo;
      continue;
    }
    if (key === 'description') {
      const description = asTrimmedString(value, LIMITS.description) ?? '';
      if ((UNPERSISTED_FIELDS[action] ?? []).includes('description')) notStored.push('description');
      accepted[key] = description;
      continue;
    }
    return fail(400, `Field "${key}" cannot be validated for ${action}.`, action);
  }

  if (action === 'product.create' && !accepted.name) {
    return fail(400, 'A product name is required to create a product.', action);
  }
  if (action === 'product.update' && Object.keys(accepted).length === 0) {
    return fail(400, 'A product update needs at least one field to change.', action);
  }
  if (action === 'theme.update' && accepted.price === undefined && accepted.price_inr === undefined && accepted.price_usd === undefined) {
    return fail(400, 'A theme price update needs price or price_usd.', action);
  }
  if (action === 'pricing.tier.update' && accepted.price === undefined && accepted.price_inr === undefined && accepted.price_usd === undefined) {
    return fail(400, 'A tier price update needs price, price_inr or price_usd.', action);
  }
  if (
    action === 'pricing.plan.update' &&
    accepted.price === undefined &&
    accepted.price_inr === undefined &&
    accepted.price_usd === undefined &&
    accepted.duration_months === undefined
  ) {
    return fail(400, 'A plan update needs a price or duration_months.', action);
  }
  if (
    action === 'game.update' &&
    accepted.enabled === undefined &&
    accepted.maintenance === undefined &&
    accepted.sort_order === undefined
  ) {
    return fail(400, 'A Game Zone update needs enabled, maintenance or sort_order.', action);
  }
  if (action === 'brand.update' && Object.keys(accepted).length === 0) {
    return fail(400, 'A brand update needs at least one of site_name, brand_tagline or logo_url.', action);
  }

  // `price_inr` and `price` are the same number in this schema; keep them in sync.
  if (accepted.price === undefined && accepted.price_inr !== undefined) accepted.price = accepted.price_inr;
  if (accepted.price_inr === undefined && accepted.price !== undefined) accepted.price_inr = accepted.price;

  return {
    ok: true,
    request: {
      action,
      targetId,
      targetName,
      fields: accepted,
      tier,
      themeIds,
      bulk,
      notStored,
      destructive: action.includes('delete'),
    },
  };
};

/* ------------------------------------------------------------------ */
/* Rate limiting (decision only — the counter lives in the database)  */
/* ------------------------------------------------------------------ */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Decides a fixed-window limit from a counter the caller read from the
 * database. Pure so the boundary is testable; the Edge Function is responsible
 * for persisting the counter.
 */
export const fixedWindowDecision = (
  count: number,
  limit: number,
  windowElapsedSeconds: number,
  windowSeconds: number,
): RateLimitDecision => {
  const bounded = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  const inWindow = windowElapsedSeconds >= 0 && windowElapsedSeconds < windowSeconds;
  if (inWindow && bounded >= limit) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - windowElapsedSeconds)),
    };
  }
  const used = inWindow ? bounded + 1 : 1;
  return { allowed: true, remaining: Math.max(0, limit - used), retryAfterSeconds: 0 };
};

/* ------------------------------------------------------------------ */
/* Audit helpers                                                      */
/* ------------------------------------------------------------------ */

/** Removes anything secret-shaped from a value before it can be audited. */
export const redactSecrets = (value: unknown, depth = 0): unknown => {
  if (depth > 4) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactSecrets(item, depth + 1));
  if (typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    output[key] = SECRET_KEY.test(key) ? '[redacted]' : redactSecrets(item, depth + 1);
  }
  return output;
};

/** Fields worth diffing for each action (keeps the log small and readable). */
const DIFF_FIELDS: Record<string, readonly string[]> = {
  'product.create': ['name', 'price', 'price_usd', 'active'],
  'product.update': ['name', 'price', 'price_usd', 'active'],
  'product.delete': ['name', 'price', 'price_usd'],
  'theme.update': ['price', 'price_inr', 'price_usd'],
  'theme.publish': ['deleted'],
  'theme.unpublish': ['deleted'],
  'theme.delete': ['deleted'],
  'pricing.tier.update': ['price_inr', 'price_usd'],
  'pricing.plan.update': ['price_inr', 'price_usd', 'duration_months'],
};

/**
 * Builds a safe before/after diff containing only changed, allow-listed fields.
 * Secrets are stripped, so a token can never reach the audit table.
 */
export const buildAuditDiff = (
  action: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): Record<string, { from: unknown; to: unknown }> => {
  const fields = DIFF_FIELDS[action] ?? [];
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of fields) {
    if (SECRET_KEY.test(field)) continue;
    const from = redactSecrets(before?.[field]);
    const to = redactSecrets(after?.[field]);
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    diff[field] = { from: from ?? null, to: to ?? null };
  }
  return diff;
};

/** Outcome values that may be written to the audit table. */
export const AUDIT_OUTCOMES = ['success', 'failure', 'denied', 'blocked'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const normaliseOutcome = (value: string): AuditOutcome =>
  (AUDIT_OUTCOMES as readonly string[]).includes(value) ? (value as AuditOutcome) : 'failure';
