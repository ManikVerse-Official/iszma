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
] as const;

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
  'report.overview': 'reports.read',
  'report.orders': 'reports.read',
  'report.audit': 'reports.read',
};

/** Which table a target lives in, used by the Edge Function's executors. */
export const TARGET_TABLE: Record<string, 'products' | 'theme_prices' | 'theme_overrides'> = {
  'product.create': 'products',
  'product.update': 'products',
  'product.delete': 'products',
  'theme.update': 'theme_prices',
  'theme.publish': 'theme_overrides',
  'theme.unpublish': 'theme_overrides',
  'theme.delete': 'theme_overrides',
};

/** Actions that need a concrete target id (they cannot create one). */
export const ACTIONS_REQUIRING_TARGET: readonly string[] = [
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
  fields: Record<string, number | string>;
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
  if (!hasAdminPermission(permissions, action)) {
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

  if (raw.targetId !== undefined && raw.targetId !== null && !targetId) {
    return fail(400, 'targetId must be a non-empty string of at most 120 characters.', action);
  }
  if (raw.targetName !== undefined && raw.targetName !== null && !targetName) {
    return fail(400, 'targetName must be a non-empty string of at most 120 characters.', action);
  }

  if (ACTIONS_REQUIRING_TARGET.includes(action) && !targetId) {
    return fail(400, 'A concrete targetId is required for this action.', action);
  }

  // The client may send `fields` (preferred) or `patch`; anything else is ignored.
  const source = (raw.fields ?? raw.patch ?? {}) as unknown;
  if (source !== null && (typeof source !== 'object' || Array.isArray(source))) {
    return fail(400, 'fields must be an object.', action);
  }
  const sourceFields = (source ?? {}) as Record<string, unknown>;

  const allowed = ALLOWED_FIELDS[action] ?? [];
  const accepted: Record<string, number | string> = {};
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
    if (key === 'name') {
      const name = asTrimmedString(value, LIMITS.name);
      if (!name) return fail(400, `name must be 1 to ${LIMITS.name} characters.`, action);
      accepted[key] = name;
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
