import type { GreetingTheme, Product } from '../types';
import { buildDiff, recordAudit } from './auditLog';
import {
  adminCommandLimiter,
  noteAuthorizationDenied,
  notePromptInjection,
  noteRateLimited,
} from './threatDetection';

/**
 * Admin Joy — the privileged, authenticated command engine.
 *
 * This module is deliberately PURE of UI and network concerns. It parses a
 * natural-language command, checks the *trusted* actor context, validates the
 * target and business rules, decides whether confirmation is needed, and only
 * then hands a concrete operation to an injected `AdminOps` executor. It records
 * every attempt in the audit log.
 *
 * The actor's identity and permissions come from the server-verified session
 * passed in by the caller — NEVER from the message text — so no wording in a
 * chat message can elevate privileges. The authoritative enforcement still
 * belongs on the server (Supabase RLS + the `is_admin` check today); this module
 * is the request-planning and defence-in-depth layer, not the security boundary.
 */

export type MaybePromise<T> = T | Promise<T>;

export type JoyLanguage = 'en' | 'hi';

export interface AdminActor {
  userId: string;
  email: string;
  /** Server-verified admin flag. Never derived from message text. */
  isAdmin: boolean;
  /**
   * Least-privilege permission keys. When omitted, an admin is treated as
   * having every permission (the current project has a single admin role).
   */
  permissions?: string[];
}

export type AdminAction =
  | 'product.create'
  | 'product.update'
  | 'product.delete'
  | 'theme.update'
  | 'theme.publish'
  | 'theme.unpublish'
  | 'theme.delete'
  | 'track.update'
  | 'track.publish'
  | 'track.unpublish'
  | 'report.orders'
  | 'report.overview';

export type CommandRisk = 'low' | 'medium' | 'high';

const REQUIRED_PERMISSION: Record<AdminAction, string> = {
  'product.create': 'products.write',
  'product.update': 'products.write',
  'product.delete': 'products.write',
  'theme.update': 'themes.write',
  'theme.publish': 'themes.write',
  'theme.unpublish': 'themes.write',
  'theme.delete': 'themes.write',
  'track.update': 'music.write',
  'track.publish': 'music.write',
  'track.unpublish': 'music.write',
  'report.orders': 'reports.read',
  'report.overview': 'reports.read',
};

/** Actions this build genuinely cannot perform (no backing module exists). */
const UNSUPPORTED_ACTIONS = new Set<AdminAction>(['track.update', 'track.publish', 'track.unpublish']);

const RISK: Record<AdminAction, CommandRisk> = {
  'product.create': 'medium',
  'product.update': 'medium',
  'product.delete': 'high',
  'theme.update': 'medium',
  'theme.publish': 'high',
  'theme.unpublish': 'high',
  'theme.delete': 'high',
  'track.update': 'medium',
  'track.publish': 'high',
  'track.unpublish': 'high',
  'report.orders': 'low',
  'report.overview': 'low',
};

export interface AdminSnapshot {
  products: Pick<Product, 'id' | 'name' | 'price' | 'price_inr' | 'description'>[];
  themes: Pick<GreetingTheme, 'id' | 'name' | 'price' | 'tier'>[];
}

export interface ParsedAdminCommand {
  action: AdminAction | null;
  /** product | theme | track, when the command names a collection. */
  targetKind: 'product' | 'theme' | 'track' | null;
  targetName?: string;
  targetId?: string;
  /** The field being changed, when it is a targeted update. */
  field?: 'price' | 'name' | 'description';
  priceInr?: number;
  priceUsd?: number;
  language: JoyLanguage;
  /** True when instruction-like content was found (it is never obeyed). */
  injection: boolean;
  /** True when the message tried to touch audit/security/roles directly. */
  protectedTarget: boolean;
  raw: string;
  unknownReason?: string;
}

export interface AdminCommandPlan {
  status: 'ready' | 'confirm' | 'clarify' | 'denied';
  action: AdminAction | null;
  risk: CommandRisk;
  target?: { id: string; name: string; kind: 'product' | 'theme' | 'track' };
  patch?: Partial<Product> | Partial<GreetingTheme>;
  summary: string;
  /** Human confirmation text; present when status === 'confirm'. */
  confirmationPrompt?: string;
  /** Candidate targets when status === 'clarify'. */
  candidates?: { id: string; name: string }[];
  /** Explanation of the status (always present). */
  reason: string;
  language: JoyLanguage;
}

export interface AdminOpResult {
  ok: boolean;
  error?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}

/** The privileged operations Admin Joy can perform, injected by the caller. */
export interface AdminOps {
  updateProduct(id: string, patch: Partial<Product>): MaybePromise<AdminOpResult>;
  createProduct(input: Partial<Product>): MaybePromise<AdminOpResult>;
  deleteProduct(id: string): MaybePromise<AdminOpResult>;
  updateTheme(id: string, patch: Partial<GreetingTheme>): MaybePromise<AdminOpResult>;
  publishTheme(id: string): MaybePromise<AdminOpResult>;
  unpublishTheme(id: string): MaybePromise<AdminOpResult>;
  deleteTheme(id: string): MaybePromise<AdminOpResult>;
  report?(kind: 'orders' | 'overview'): MaybePromise<{ ok: boolean; text?: string; error?: string }>;
}

export interface AdminExecutionResult {
  ok: boolean;
  status: 'success' | 'failure' | 'denied' | 'clarify' | 'confirmation-required' | 'unsupported';
  message: string;
  /** True only when the operation reported success AND its after-state was read. */
  verified: boolean;
  auditId?: string;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                            */
/* ------------------------------------------------------------------ */

const HINGLISH_MARKERS = [
  'karo', 'kro', 'karo', 'ka', 'ki', 'ke', 'ko', 'hai', 'mein', 'kya', 'karo',
  'badlo', 'hatao', 'hata', 'daalo', 'jodo', 'banao', 'dikhao', 'aaj', 'ke', 'ki',
  'kimat', 'bhav', 'naya', 'purana', 'chalu', 'publish', 'unpublish',
];

const hasHinglish = (text: string): boolean => {
  const tokens = new Set(text.split(/[^a-z0-9]+/i).filter(Boolean));
  return HINGLISH_MARKERS.some((marker) => tokens.has(marker));
};

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all )?(previous|prior|above)/i,
  /disregard (all )?(previous|prior|above)/i,
  /you are now/i,
  /system prompt/i,
  /developer mode/i,
  /grant me (admin|owner|superuser)/i,
  /make me (an? )?(admin|owner|superuser)/i,
  /i am (the )?(admin|owner|developer)/i,
  /pretend (to be|you are)/i,
  /bypass (auth|authorization|security|login)/i,
  /disable (security|auth|authorization)/i,
  /reveal (the )?(password|token|api ?key|secret|service role)/i,
];

const PROTECTED_PATTERNS: RegExp[] = [
  /\b(audit|security) (log|logs|record|records)\b/i,
  /\b(clear|delete|erase|wipe|remove) (the )?(audit|security|log|logs)\b/i,
  /\b(grant|revoke|change|set) (my )?(role|roles|permission|permissions)\b/i,
  /\b(add|remove) (me|myself) (to|from) (the )?(admin|admins|admin_users)\b/i,
];

export const detectInjection = (raw: string): boolean =>
  INJECTION_PATTERNS.some((pattern) => pattern.test(raw));

const detectProtectedTarget = (raw: string): boolean =>
  PROTECTED_PATTERNS.some((pattern) => pattern.test(raw));

/** Words that end the target-name capture. */
const NAME_STOPWORDS = new Set([
  'price', 'rate', 'cost', 'kimat', 'bhav', 'to', 'se', 'ka', 'ki', 'ke', 'ko',
  'publish', 'unpublish', 'hide', 'delete', 'remove', 'and', 'the', 'a', 'an',
  'please', 'kar', 'karo', 'do', 'rs', 'inr', 'usd', 'rupees', 'rupee', 'for', 'of',
]);

const cleanName = (value: string): string | undefined => {
  const name = value.replace(/['’]s$/i, '').replace(/[.,;:!?]+$/, '').trim();
  return name || undefined;
};

const extractQuotedName = (raw: string): string | undefined => {
  const match = raw.match(/["'“”‘’]([^"'“”‘’]{2,60})["'“”‘’]/);
  return match ? cleanName(match[1]) : undefined;
};

const extractNameAfter = (raw: string, keyword: string): string | undefined => {
  const index = raw.toLowerCase().indexOf(keyword);
  if (index === -1) return undefined;
  const after = raw.slice(index + keyword.length).replace(/^[\s:,-]+/, '');
  const tokens = after.split(/\s+/);
  const kept: string[] = [];
  for (const token of tokens) {
    const bare = token.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (
      NAME_STOPWORDS.has(token.toLowerCase()) ||
      NAME_STOPWORDS.has(bare) ||
      /^[₹$]/.test(token) ||
      /^\d/.test(token)
    ) {
      break;
    }
    kept.push(token);
  }
  return cleanName(kept.join(' '));
};

const parsePrice = (raw: string): { priceInr?: number; priceUsd?: number } => {
  const usd = raw.match(/\$\s*(\d+(?:\.\d+)?)|usd\s*(\d+(?:\.\d+)?)/i);
  if (usd) {
    const value = Number(usd[1] ?? usd[2]);
    if (Number.isFinite(value)) return { priceUsd: value };
  }
  const inr = raw.match(/₹\s*(\d+(?:\.\d+)?)|(?:rs|inr|rupees?)\s*(\d+(?:\.\d+)?)/i);
  if (inr) {
    const value = Number(inr[1] ?? inr[2]);
    if (Number.isFinite(value)) return { priceInr: value };
  }
  /* Bare "price to 399" / "price 399". */
  const bare = raw.match(/price[^0-9]{0,10}(\d+(?:\.\d+)?)/i);
  if (bare) {
    const value = Number(bare[1]);
    if (Number.isFinite(value)) return { priceInr: value };
  }
  return {};
};

const word = (raw: string, list: string[]): boolean =>
  list.some((entry) => new RegExp(`\\b${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(raw));

const PUBLISH_WORDS = ['publish', 'go live', 'make live', 'publish karo', 'live karo', 'chalu karo', 'public karo'];
const UNPUBLISH_WORDS = ['unpublish', 'hide', 'unlist', 'unpublished', 'hide karo', 'band karo', 'hata do', 'hatao'];
const DELETE_WORDS = ['delete', 'remove', 'erase', 'mita do', 'mita', 'delete karo', 'hata do'];
const CREATE_WORDS = ['add', 'create', 'new product', 'naya product', 'add karo', 'jodo', 'daalo', 'catalogue me daalo', 'upload product'];
const PRICE_WORDS = ['price', 'pricing', 'rate', 'cost', 'kimat', 'bhav', 'set price', 'price badlo'];
const RENAME_WORDS = ['rename', 'name change', 'name badlo', 'title badlo', 'name set'];
const ORDER_REPORT_WORDS = ['order summary', 'orders', 'order', 'sales', 'aaj ke order', "today's order", 'todays order'];
const OVERVIEW_REPORT_WORDS = ['overview', 'snapshot', 'summary', 'analytics', 'report', 'reports'];

export const parseAdminCommand = (raw: string): ParsedAdminCommand => {
  const text = raw.trim();
  const lower = text.toLowerCase();
  const language: JoyLanguage = hasHinglish(lower) ? 'hi' : 'en';
  const injection = detectInjection(text);
  const protectedTarget = detectProtectedTarget(text);

  const base: ParsedAdminCommand = {
    action: null,
    targetKind: null,
    language,
    injection,
    protectedTarget,
    raw: text,
  };

  const mentionsTrack = word(lower, ['track', 'music', 'song', 'audio']);
  const mentionsTheme = word(lower, ['theme', 'greeting theme', 'card theme', 'design']);
  const mentionsProduct = word(lower, ['product', 'item', 'catalogue', 'catalog', 'store']);

  /* Read-only reports first — they contain the word "summary"/"orders" too. */
  if (
    !word(lower, DELETE_WORDS) &&
    !word(lower, PUBLISH_WORDS) &&
    !word(lower, UNPUBLISH_WORDS) &&
    !word(lower, CREATE_WORDS) &&
    !word(lower, PRICE_WORDS)
  ) {
    if (word(lower, ORDER_REPORT_WORDS) || /order summary|today'?s orders?/i.test(lower)) {
      return { ...base, action: 'report.orders', targetKind: null };
    }
    if (word(lower, OVERVIEW_REPORT_WORDS)) {
      return { ...base, action: 'report.overview', targetKind: null };
    }
  }

  if (mentionsTrack) {
    if (word(lower, UNPUBLISH_WORDS)) return { ...base, action: 'track.unpublish', targetKind: 'track' };
    if (word(lower, PUBLISH_WORDS)) return { ...base, action: 'track.publish', targetKind: 'track' };
    return { ...base, action: 'track.update', targetKind: 'track' };
  }

  if (mentionsTheme) {
    const targetName = extractQuotedName(text) ?? extractNameAfter(text, 'theme');
    if (word(lower, DELETE_WORDS)) {
      return { ...base, action: 'theme.delete', targetKind: 'theme', targetName };
    }
    if (word(lower, UNPUBLISH_WORDS)) {
      return { ...base, action: 'theme.unpublish', targetKind: 'theme', targetName };
    }
    if (word(lower, PUBLISH_WORDS)) {
      return { ...base, action: 'theme.publish', targetKind: 'theme', targetName };
    }
    const price = parsePrice(text);
    return {
      ...base,
      action: 'theme.update',
      targetKind: 'theme',
      targetName,
      field: 'price',
      ...price,
    };
  }

  if (mentionsProduct) {
    const targetName = extractQuotedName(text) ?? extractNameAfter(text, 'product');
    if (word(lower, DELETE_WORDS)) {
      return { ...base, action: 'product.delete', targetKind: 'product', targetName };
    }
    if (word(lower, CREATE_WORDS)) {
      return { ...base, action: 'product.create', targetKind: 'product', targetName };
    }
    const price = parsePrice(text);
    if (word(lower, PRICE_WORDS) || price.priceInr !== undefined || price.priceUsd !== undefined) {
      return {
        ...base,
        action: 'product.update',
        targetKind: 'product',
        targetName,
        field: 'price',
        ...price,
      };
    }
    if (word(lower, RENAME_WORDS)) {
      return { ...base, action: 'product.update', targetKind: 'product', targetName, field: 'name' };
    }
    return { ...base, action: 'product.update', targetKind: 'product', targetName };
  }

  return { ...base, unknownReason: 'No product, theme or report command was recognised.' };
};

/* ------------------------------------------------------------------ */
/* Target resolution                                                  */
/* ------------------------------------------------------------------ */

const normalizeName = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

type Candidate = { id: string; name: string };

/**
 * Resolves a target uniquely. Returns "ambiguous" (with candidates) rather than
 * guessing, so a command can never change the wrong record.
 */
export const resolveTarget = (
  parsed: ParsedAdminCommand,
  snapshot: AdminSnapshot,
): { kind: 'resolved'; target: Candidate } | { kind: 'ambiguous'; candidates: Candidate[] } | { kind: 'missing' } => {
  const source: Candidate[] =
    parsed.targetKind === 'product'
      ? snapshot.products.map((p) => ({ id: p.id, name: p.name }))
      : parsed.targetKind === 'theme'
        ? snapshot.themes.map((t) => ({ id: t.id, name: t.name }))
        : [];

  if (source.length === 0) return { kind: 'missing' };

  const wantedId = parsed.targetId?.trim();
  if (wantedId) {
    const byId = source.find((candidate) => candidate.id === wantedId);
    return byId ? { kind: 'resolved', target: byId } : { kind: 'missing' };
  }

  const wanted = parsed.targetName ? normalizeName(parsed.targetName) : '';
  if (!wanted) return { kind: 'missing' };

  const exact = source.filter((candidate) => normalizeName(candidate.name) === wanted);
  if (exact.length === 1) return { kind: 'resolved', target: exact[0] };
  if (exact.length > 1) return { kind: 'ambiguous', candidates: exact.slice(0, 5) };

  const partial = source.filter((candidate) => normalizeName(candidate.name).includes(wanted));
  if (partial.length === 1) return { kind: 'resolved', target: partial[0] };
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial.slice(0, 5) };

  return { kind: 'missing' };
};

/* ------------------------------------------------------------------ */
/* Planning                                                           */
/* ------------------------------------------------------------------ */

const denied = (
  reason: string,
  language: JoyLanguage,
  action: AdminAction | null = null,
): AdminCommandPlan => ({ status: 'denied', action, risk: action ? RISK[action] : 'low', summary: reason, reason, language });

const hasPermission = (actor: AdminActor, action: AdminAction): boolean => {
  if (!actor.isAdmin) return false;
  if (!actor.permissions) return true;
  return actor.permissions.includes(REQUIRED_PERMISSION[action]);
};

const buildPatch = (parsed: ParsedAdminCommand): Partial<Product> | Partial<GreetingTheme> | undefined => {
  if (parsed.action === 'product.update') {
    if (parsed.field === 'price') {
      const patch: Partial<Product> = {};
      if (parsed.priceInr !== undefined) {
        patch.price = parsed.priceInr;
        patch.price_inr = parsed.priceInr;
      }
      if (parsed.priceUsd !== undefined) patch.price_usd = parsed.priceUsd;
      return patch;
    }
    return {};
  }
  if (parsed.action === 'theme.update') {
    const patch: Partial<GreetingTheme> = {};
    if (parsed.priceInr !== undefined) patch.price = parsed.priceInr;
    if (parsed.priceUsd !== undefined) patch.price_usd = parsed.priceUsd;
    return patch;
  }
  return undefined;
};

const describePatch = (parsed: ParsedAdminCommand, targetName: string): string => {
  if (parsed.action === 'product.update' && parsed.field === 'price') {
    const amount = parsed.priceUsd !== undefined ? `$${parsed.priceUsd}` : `₹${parsed.priceInr ?? '?'}`;
    return `Change the price of product "${targetName}" to ${amount}.`;
  }
  if (parsed.action === 'theme.update') {
    const amount = parsed.priceUsd !== undefined ? `$${parsed.priceUsd}` : `₹${parsed.priceInr ?? '?'}`;
    return `Change the price of greeting theme "${targetName}" to ${amount}.`;
  }
  if (parsed.action === 'product.delete') return `Delete product "${targetName}". This cannot be undone from here.`;
  if (parsed.action === 'theme.delete') return `Delete greeting theme "${targetName}". This cannot be undone from here.`;
  if (parsed.action === 'theme.publish') return `Publish greeting theme "${targetName}" for visitors.`;
  if (parsed.action === 'theme.unpublish') return `Unpublish greeting theme "${targetName}" (hidden from visitors).`;
  if (parsed.action === 'product.create') return `Add a new product "${targetName}" to the catalogue.`;
  return `Run ${parsed.action} on "${targetName}".`;
};

/**
 * Turns a parsed command into a plan. This performs the security gate and all
 * validation; it never performs the operation itself.
 */
export const planAdminCommand = (
  raw: string,
  actor: AdminActor,
  snapshot: AdminSnapshot,
): AdminCommandPlan => {
  const parsed = parseAdminCommand(raw);
  const language = parsed.language;

  /* 1. Authentication gate — the actor comes from the verified session only. */
  /*
   * Reply language policy: Admin Joy answers in the language the admin wrote in
   * (English by default, Hinglish when the comment is Hinglish), while the
   * permission and validation rules stay identical.
   */
  if (!actor.isAdmin) {
    return denied(
      language === 'hi'
        ? 'Admin access chahiye. Pehle /admin par apne admin account se sign in karein.'
        : 'Administrator access is required. Sign in with an admin account at /admin first.',
      language,
      parsed.action,
    );
  }

  /* 2. Audit/security/role tampering is never allowed through chat. */
  if (parsed.protectedTarget) {
    return denied(
      'The audit log, security settings and roles cannot be changed from chat.',
      language,
      parsed.action,
    );
  }

  /* 3. Rate limit repeated privileged attempts. */
  if (!adminCommandLimiter.allow(`cmd:${actor.userId}`)) {
    noteRateLimited(actor.email, parsed.action ?? 'unknown');
    return denied('Too many admin commands just now. Please wait a moment and try again.', language, parsed.action);
  }

  /* 4. Instruction-like content is logged and ignored (never obeyed). */
  if (parsed.injection) {
    notePromptInjection(actor.email, parsed.raw);
  }

  /* 5. Recognised action? */
  if (!parsed.action) {
    return denied(
      parsed.unknownReason ?? 'I could not tell which action you want. Try: "change product X price to ₹399".',
      language,
    );
  }

  /* 6. Least-privilege permission check. */
  if (!hasPermission(actor, parsed.action)) {
    noteAuthorizationDenied(actor.email, parsed.action);
    return denied(`Your account does not have the "${REQUIRED_PERMISSION[parsed.action]}" permission.`, language, parsed.action);
  }

  /* 7. Actions with no backing module are refused honestly. */
  if (UNSUPPORTED_ACTIONS.has(parsed.action)) {
    return denied(
      'Music management is not available in this build yet. It needs the music module and a server function before Joy can publish or edit tracks.',
      language,
      parsed.action,
    );
  }

  /* 8. Read-only reports need no target or confirmation. */
  if (parsed.action === 'report.orders' || parsed.action === 'report.overview') {
    const summary = parsed.action === 'report.orders' ? "Show today's order summary." : 'Show the overview summary.';
    return { status: 'ready', action: parsed.action, risk: RISK[parsed.action], summary, reason: 'Read-only report.', language };
  }

  /* 9. Resolve the target uniquely. */
  if (parsed.action === 'product.create') {
    if (!parsed.targetName) {
      return {
        status: 'clarify',
        action: parsed.action,
        risk: RISK[parsed.action],
        summary: 'Adding a product needs a name.',
        reason: 'No product name was given. Example: add product "Monsoon Wallpaper".',
        language,
      };
    }
    const summary = describePatch(parsed, parsed.targetName);
    return {
      status: 'confirm',
      action: parsed.action,
      risk: RISK[parsed.action],
      patch: { name: parsed.targetName },
      summary,
      confirmationPrompt: `Add product "${parsed.targetName}" to the catalogue?`,
      reason: 'Creating a product changes the public catalogue, so it needs confirmation.',
      language,
    };
  }

  const resolution = resolveTarget(parsed, snapshot);
  if (resolution.kind === 'missing') {
    return {
      status: 'clarify',
      action: parsed.action,
      risk: RISK[parsed.action],
      candidates: [],
      summary: 'No matching record was found.',
      reason: parsed.targetName
        ? `No ${parsed.targetKind ?? 'record'} matches "${parsed.targetName}". Check the exact name and try again.`
        : `Please name the ${parsed.targetKind ?? 'record'} you mean.`,
      language,
    };
  }
  if (resolution.kind === 'ambiguous') {
    return {
      status: 'clarify',
      action: parsed.action,
      risk: RISK[parsed.action],
      candidates: resolution.candidates,
      summary: 'More than one record matches.',
      reason: `"${parsed.targetName}" matches more than one ${parsed.targetKind}. Pick one by full name before I change anything.`,
      language,
    };
  }

  const target = { id: resolution.target.id, name: resolution.target.name, kind: parsed.targetKind ?? 'product' } as const;

  /* A price update with no parsable amount must never guess a value. */
  if (parsed.action === 'product.update' && parsed.field === 'price' && parsed.priceInr === undefined && parsed.priceUsd === undefined) {
    return {
      status: 'clarify',
      action: parsed.action,
      risk: RISK[parsed.action],
      target,
      summary: 'No price was found.',
      reason: 'Tell me the new price, for example: "price to ₹399" or "$4.99".',
      language,
    };
  }

  const summary = describePatch(parsed, target.name);
  const needsConfirmation = RISK[parsed.action] !== 'low';
  return {
    status: needsConfirmation ? 'confirm' : 'ready',
    action: parsed.action,
    risk: RISK[parsed.action],
    target,
    patch: buildPatch(parsed),
    summary,
    confirmationPrompt: needsConfirmation ? `Confirm: ${summary}` : undefined,
    reason: needsConfirmation
      ? 'This changes live data, so it needs your confirmation.'
      : 'Safe to run.',
    language,
  };
};

/* ------------------------------------------------------------------ */
/* Execution                                                          */
/* ------------------------------------------------------------------ */

const auditOutcomeFor = (status: AdminExecutionResult['status']): 'success' | 'failure' | 'denied' | 'blocked' | 'confirmation-required' => {
  if (status === 'success') return 'success';
  if (status === 'failure') return 'failure';
  if (status === 'confirmation-required') return 'confirmation-required';
  if (status === 'unsupported') return 'blocked';
  return 'denied';
};

/**
 * Executes an approved plan through the injected ops, verifying the result and
 * writing an audit entry. Never reports success unless the executor confirmed
 * it. A plan that still needs confirmation is refused unless `confirmed` is set.
 */
export const executeAdminCommand = async (
  plan: AdminCommandPlan,
  ops: AdminOps,
  actor: AdminActor,
  options: { confirmed?: boolean } = {},
): Promise<AdminExecutionResult> => {
  const log = (result: Omit<AdminExecutionResult, 'auditId'>, extra?: { before?: Record<string, unknown>; after?: Record<string, unknown> }): AdminExecutionResult => {
    const entry = recordAudit({
      actorId: actor.userId,
      actorEmail: actor.email,
      action: plan.action ?? 'unknown',
      targetId: plan.target?.id,
      targetName: plan.target?.name,
      outcome: auditOutcomeFor(result.status),
      detail: result.message,
      diff: buildDiff(extra?.before, extra?.after),
    });
    return { ...result, auditId: entry.id };
  };

  if (plan.status === 'denied') {
    return log({ ok: false, status: 'denied', message: plan.reason, verified: false });
  }
  if (plan.status === 'clarify') {
    const names = plan.candidates?.map((candidate) => candidate.name).join(', ');
    return log({
      ok: false,
      status: 'clarify',
      message: plan.reason + (names ? ` Options: ${names}.` : ''),
      verified: false,
    });
  }
  if (plan.status === 'confirm' && !options.confirmed) {
    return log({
      ok: false,
      status: 'confirmation-required',
      message: plan.confirmationPrompt ?? plan.summary,
      verified: false,
    });
  }
  if (!plan.action) {
    return log({ ok: false, status: 'failure', message: 'Nothing to execute.', verified: false });
  }

  try {
    let result: AdminOpResult;
    switch (plan.action) {
      case 'product.update':
        result = await ops.updateProduct(plan.target!.id, (plan.patch ?? {}) as Partial<Product>);
        break;
      case 'product.create':
        result = await ops.createProduct((plan.patch ?? {}) as Partial<Product>);
        break;
      case 'product.delete':
        result = await ops.deleteProduct(plan.target!.id);
        break;
      case 'theme.update':
        result = await ops.updateTheme(plan.target!.id, (plan.patch ?? {}) as Partial<GreetingTheme>);
        break;
      case 'theme.publish':
        result = await ops.publishTheme(plan.target!.id);
        break;
      case 'theme.unpublish':
        result = await ops.unpublishTheme(plan.target!.id);
        break;
      case 'theme.delete':
        result = await ops.deleteTheme(plan.target!.id);
        break;
      case 'report.orders':
      case 'report.overview': {
        const kind = plan.action === 'report.orders' ? 'orders' : 'overview';
        const report = ops.report ? await ops.report(kind) : { ok: false, error: 'Reporting is not wired in this context.' };
        return log({
          ok: Boolean(report.ok),
          status: report.ok ? 'success' : 'failure',
          message: report.ok ? report.text ?? 'Report ready.' : report.error ?? 'The report is unavailable.',
          verified: Boolean(report.ok),
        });
      }
      default:
        return log({ ok: false, status: 'unsupported', message: 'That action is not supported.', verified: false });
    }

    /* Verify: success requires the executor to confirm it AND return an after-state. */
    const verified = Boolean(result.ok) && result.after !== undefined;
    if (!result.ok) {
      return log(
        { ok: false, status: 'failure', message: result.error ?? 'The operation failed.', verified: false },
        { before: result.before, after: result.after },
      );
    }
    return log(
      { ok: true, status: 'success', message: plan.summary, verified },
      { before: result.before, after: result.after },
    );
  } catch (error) {
    return log({
      ok: false,
      status: 'failure',
      message: error instanceof Error ? error.message : 'The operation failed.',
      verified: false,
    });
  }
};

/** Convenience: plan then execute, for the UI. */
export const runAdminCommand = async (
  raw: string,
  actor: AdminActor,
  snapshot: AdminSnapshot,
  ops: AdminOps,
  options: { confirmed?: boolean } = {},
): Promise<{ plan: AdminCommandPlan; result: AdminExecutionResult }> => {
  const plan = planAdminCommand(raw, actor, snapshot);
  const result = await executeAdminCommand(plan, ops, actor, options);
  return { plan, result };
};
