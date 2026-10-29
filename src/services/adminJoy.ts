import type { GreetingTheme, Product } from '../types';
import { greetingCategories } from '../data/greetingThemes';
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

/**
 * The four greeting-card tiers that already exist in the product data
 * (`src/data/greetingThemes.ts`, `GreetingTier`). The order mirrors
 * `TIER_OPTIONS` in that file — it is deliberately not re-invented here.
 */
export type GreetingTierId = 'basic' | 'plus' | 'premium' | 'elite';

export const GREETING_TIER_IDS: readonly GreetingTierId[] = ['basic', 'plus', 'premium', 'elite'];

export const GREETING_TIER_LABELS: Record<GreetingTierId, string> = {
  basic: 'Basic',
  plus: 'Plus',
  premium: 'Premium',
  elite: 'Elite',
};

/** A price amount in either (or both) of the currencies the catalogue uses. */
export interface AdminPriceAmount {
  priceInr?: number;
  priceUsd?: number;
}

/** The short-reply slot the previous turn left open. */
export type AdminAwaiting = 'tier' | 'price' | 'theme' | 'target' | 'plan';

/** One numbered option Joy listed and is waiting for the admin to pick. */
export interface AdminSelectionOption {
  id: string;
  name: string;
  kind: 'theme' | 'product';
}

/**
 * A working navigation link Joy can attach to an answer. The href always points
 * at a route this app really serves (see `src/App.tsx` and the dashboard's
 * `?tab=` values), never at a page that does not exist.
 */
export interface AdminPlanLink {
  href: string;
  label: string;
}

/** The guided workflows Joy can walk an admin through. */
export type AdminGuideId =
  | 'greeting-upload'
  | 'product-add'
  | 'reportcard-use'
  | 'game-maintenance'
  | 'sales-report'
  | 'pricing-troubleshoot';

/**
 * Small, explicit conversational context. It lets a reply like "99" finish the
 * price change the assistant just asked about, "Basic" answer "which tier?", or
 * "2" pick from a list it just printed, instead of making the admin repeat
 * themselves. It is never trusted for identity or permissions — it only carries
 * the *question* the last turn asked.
 */
export interface AdminConversationContext {
  /** Tier the previous turn asked for a price for. */
  pendingTier?: GreetingTierId;
  /** Last tier the admin priced or asked about, for "same tier" follow-ups. */
  lastTier?: GreetingTierId;
  /** Language of the previous turn, so a bare answer stays in that language. */
  language?: JoyLanguage;
  /**
   * Which short reply the previous turn is waiting for: a tier name when Joy
   * asked "which tier?", a new price when Joy asked "what price?", or a theme
   * when Joy listed options and asked the admin to choose one.
   */
  awaiting?: AdminAwaiting;
  /** The amount already proposed when Joy asked "which tier?" (kept, not lost). */
  pendingAmount?: AdminPriceAmount;
  /** The options the previous turn listed, so "2" / "Rose Note" / "first one" pick one. */
  options?: AdminSelectionOption[];
  /** The single theme/product the previous turn asked a price for. */
  pendingTheme?: AdminSelectionOption;
  /** The last theme/product the admin named, for "this card" / "iske tags" follow-ups. */
  lastTheme?: AdminSelectionOption;
  /**
   * The operation the previous turn was trying to run when it had to ask which
   * record was meant ("Change Sunset price to ₹50" → two matches). Keeping it
   * means the numbered reply finishes the SAME operation, not a new one.
   */
  pendingAction?: AdminAction;
  /** The last catalogue listing, so "next page" repeats it with a new offset. */
  lastQuery?: CatalogueQuery;
  /** Page of `lastQuery` the admin is currently looking at (1-based). */
  page?: number;
  /**
   * When this context stops being trusted (epoch ms). A short reply is only read
   * against a recent question, so an abandoned selection cannot be applied to a
   * message sent much later.
   */
  expiresAt?: number;
}

/**
 * One catalogue entry Joy can list and reason about. Only fields the app
 * actually holds are carried, so nothing is invented for a missing column.
 */
export interface AdminSnapshotTheme {
  id: string;
  name: string;
  price: number;
  price_usd?: number;
  tier: GreetingTierId;
  /** Search keywords (present on greeting themes only). */
  tags?: string[];
  /** Category id from the theme catalogue. */
  category_id?: string;
  /** One-line description, when the catalogue carries it. */
  tagline?: string;
}

/** One store product in the snapshot (store products carry no tags/status column). */
export interface AdminSnapshotProduct {
  id: string;
  name: string;
  price: number;
  price_inr?: number;
  price_usd?: number;
  description?: string;
  category_id?: string;
  /** Search keywords, when the product record carries them (it usually does not). */
  tags?: string[];
  /**
   * Publication flag from the store. `undefined` means the server does not
   * expose it in this build — reported as missing metadata rather than guessed.
   */
  active?: boolean;
}

/**
 * A read-only catalogue/discovery request: what to list, optionally narrowed by
 * tier, tag, a missing-tags filter, a publication filter or a search term.
 */
export interface CatalogueQuery {
  scope: 'themes' | 'products';
  tiers?: GreetingTierId[];
  tag?: string;
  missingTags?: boolean;
  unpublishedOnly?: boolean;
  term?: string;
  /**
   * Exact catalogue id looked up directly ("id: rose-note", "#t1"). Stored
   * normalised, because ids are matched with the same folding as names.
   */
  id?: string;
  /**
   * Category id the entries must belong to. Resolved from the real theme
   * catalogue (`src/data/greetingThemes.ts` categories and their keywords), so a
   * request for "romantic" or "valentine" both reach the `romantic` category.
   */
  category?: string;
  /** True when the admin asked what a catalogue entry's tags/metadata are. */
  meta?: boolean;
  /** True when a bare search term should also be matched against the other catalogue. */
  searchBoth?: boolean;
  /**
   * The lookup ends with "…then let me change it", so the single record it shows
   * is left waiting for a new price instead of being shown as a dead end.
   */
  changeNext?: boolean;
  /** 1-based page of the listing (the catalogue is paged, never dumped whole). */
  page?: number;
  /** Price ordering for "cheapest" / "most expensive" requests. */
  sort?: 'price_asc' | 'price_desc';
  /** Cap on rows when the admin asks for the single cheapest/most expensive item. */
  limit?: number;
  /** "active" / "live" items (themes: visible; products: flag not exposed). */
  activeOnly?: boolean;
  /** Explicitly inactive items (products: flag not exposed in this build). */
  inactiveOnly?: boolean;
}

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
  | 'pricing.tier.update'
  | 'pricing.tiers.read'
  | 'pricing.bulk.update'
  | 'pricing.plan.update'
  | 'pricing.plans.read'
  | 'pricing.summary.read'
  | 'catalogue.list'
  | 'catalogue.meta'
  | 'knowledge.info'
  | 'guide.info'
  | 'game.update'
  | 'brand.update'
  | 'report.orders'
  | 'report.overview'
  | 'report.audit';

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
  'pricing.tier.update': 'themes.write',
  'pricing.tiers.read': 'reports.read',
  // Scope-dependent: products.write for products, themes.write for themes.
  'pricing.bulk.update': 'products.write',
  // Business configuration for another app, matching the server's rule.
  'pricing.plan.update': 'settings.write',
  'pricing.plans.read': 'reports.read',
  'pricing.summary.read': 'reports.read',
  'catalogue.list': 'reports.read',
  'catalogue.meta': 'reports.read',
  'knowledge.info': 'reports.read',
  'guide.info': 'reports.read',
  'game.update': 'games.write',
  'brand.update': 'settings.write',
  'report.orders': 'reports.read',
  'report.overview': 'reports.read',
  'report.audit': 'reports.read',
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
  'pricing.tier.update': 'medium',
  'pricing.tiers.read': 'low',
  'pricing.bulk.update': 'high',
  'pricing.plan.update': 'medium',
  'pricing.plans.read': 'low',
  'pricing.summary.read': 'low',
  'catalogue.list': 'low',
  'catalogue.meta': 'low',
  'knowledge.info': 'low',
  'guide.info': 'low',
  'game.update': 'medium',
  'brand.update': 'medium',
  'report.orders': 'low',
  'report.overview': 'low',
  'report.audit': 'low',
};

/** The only game this build ships (matches GAME_ID in src/services/gameZone.ts). */
export const ADMIN_GAME_ID = 'pair3balls';

/** The catalogues a bulk price change can touch. */
export type BulkScope = 'products' | 'themes';
export type BulkMode = 'set' | 'increase_percent' | 'decrease_percent';
export type PricingCurrency = 'INR' | 'USD';

/** A catalogue-wide price rule, resolved against the live snapshot for preview. */
export interface BulkPriceRule {
  scope: BulkScope;
  mode: BulkMode;
  value: number;
  currency: PricingCurrency;
  /** Paid items that will change. */
  itemCount: number;
  /** A few representative before → after prices. */
  examples: { name: string; from: number; to: number }[];
}

/**
 * One ReportCard Studio plan, read from `studio_plan_prices` — the same row the
 * server charges from. Present only when the live table could be read.
 */
export interface AdminSnapshotPlan {
  id: string;
  name: string;
  priceInr: number;
  priceUsd: number;
  durationMonths: number;
}

export interface AdminSnapshot {
  products: AdminSnapshotProduct[];
  themes: AdminSnapshotTheme[];
  /** ReportCard Studio plans; undefined when the table could not be read. */
  plans?: AdminSnapshotPlan[];
  /**
   * Ids of catalogue themes an admin has hidden (the `theme_overrides.deleted`
   * flag, which is what "unpublished" means for a greeting theme). Hidden themes
   * are dropped from the live theme list, so only their ids are available here —
   * their names and prices are not readable from this snapshot.
   */
  hiddenThemeIds?: string[];
}

/** One message-ready tier price, read from the live catalogue. */
export interface TierPriceSummary {
  tier: GreetingTierId;
  label: string;
  /** Current price in the requested currency, or null when the tier has no paid themes. */
  price: number | null;
  currency: PricingCurrency;
  /** Number of paid themes whose price this summary represents. */
  themeCount: number;
  /** Distinct prices found for the tier, when they disagree. */
  conflictingPrices?: number[];
}

/**
 * A concrete ReportCard Studio plan change, resolved against the live plan rows.
 * Only the fields the admin asked to change are present.
 */
export interface PlanPriceChange {
  id: string;
  name: string;
  currentInr: number;
  currentUsd: number;
  currentDurationMonths: number;
  priceInr?: number;
  priceUsd?: number;
  durationMonths?: number;
}

/** A concrete tier price change, fully resolved against the catalogue. */
export interface TierPriceChange {
  tier: GreetingTierId;
  label: string;
  currentPrice: number;
  proposedPrice: number;
  currency: PricingCurrency;
  /** Existing theme ids that make up this tier's paid catalogue. */
  themeIds: string[];
  themeCount: number;
}

export interface ParsedAdminCommand {
  action: AdminAction | null;
  /** The collection/subsystem the command names. */
  targetKind: 'product' | 'theme' | 'track' | 'game' | 'brand' | null;
  targetName?: string;
  targetId?: string;
  /** The field being changed, when it is a targeted update. */
  field?: 'price' | 'name' | 'description';
  priceInr?: number;
  priceUsd?: number;
  /** Greeting tiers named in the message (Basic / Plus / Premium / Elite). */
  pricingTiers?: GreetingTierId[];
  /** True when the admin asked what a tier costs instead of changing it. */
  pricingQuery?: boolean;
  /** A catalogue-wide price rule (all themes / all products). */
  bulk?: { scope: BulkScope; mode: BulkMode; value: number; currency: PricingCurrency };
  /**
   * A "Name price from X to Y" command where the collection was not named.
   * Resolved against both catalogues at plan time; it is never a tier question.
   */
  priceTargetName?: string;
  /** The "from" amount in a "from X to Y" phrase, used to sanity-check the current price. */
  fromInr?: number;
  fromUsd?: number;
  /** A read-only catalogue listing / discovery request. */
  catalogue?: CatalogueQuery;
  /** A read-only platform-knowledge question (ReportCard Studio, pricing, capabilities). */
  knowledge?: 'reportcard' | 'operations' | 'pricing';
  /** A guided how-to workflow (upload a greeting card, add a product, fix pricing…). */
  guide?: AdminGuideId;
  /**
   * A price reply that pointed at a list ("Set it to ₹59" with several records on
   * screen). The record still has to be chosen; the amount is kept while asking.
   */
  selectionOptions?: AdminSelectionOption[];
  selectionPrice?: AdminPriceAmount;
  /** A price change with an amount but no record ("Change the price to 99"). */
  needsTarget?: boolean;
  /** A second operation named in the same message (not executed this turn). */
  compoundNote?: 'publish' | 'unpublish' | 'delete' | 'rename';
  /** Two contradictory mutations in one message (delete + publish, …). */
  compoundConflict?: boolean;
  /** A request this build genuinely cannot perform, reported honestly. */
  unsupported?: 'product.activation';
  /** ReportCard Studio plans named in the message (ids, never display names). */
  planTargets?: string[];
  /** True when the message means every ReportCard Studio plan ("all plans"). */
  allPlans?: boolean;
  /** A new plan price named in the message. */
  planPrice?: AdminPriceAmount;
  /** A new billing duration in months named in the message. */
  planDurationMonths?: number;
  /** True when the message asks which pricing Joy can read or change. */
  pricingCapabilitiesQuery?: boolean;
  /** True when the message asks for every current price at once. */
  allPricesQuery?: boolean;
  /** Game Zone availability fields named in the message. */
  gamePatch?: { enabled?: boolean; maintenance?: boolean; sortOrder?: number };
  /** Brand fields named in the message. */
  brandPatch?: { siteName?: string; tagline?: string; logoUrl?: string };
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
  target?: {
    id: string;
    name: string;
    kind: 'product' | 'theme' | 'track' | 'game' | 'brand' | 'plan';
  };
  patch?: Partial<Product> | Partial<GreetingTheme>;
  /** Set for a catalogue-wide price change. */
  bulk?: BulkPriceRule;
  /** Set for a Game Zone availability change. */
  gamePatch?: { enabled?: boolean; maintenance?: boolean; sortOrder?: number };
  /** Set for a brand settings change. */
  brandPatch?: { siteName?: string; tagline?: string; logoUrl?: string };
  summary: string;
  /** Human confirmation text; present when status === 'confirm'. */
  confirmationPrompt?: string;
  /** Candidate targets when status === 'clarify'. */
  candidates?: { id: string; name: string }[];
  /** Set for a tier price change (never for an individual product/theme). */
  tierChange?: TierPriceChange;
  /** Set for a read-only tier price answer. */
  tierPrices?: TierPriceSummary[];
  /** Set for a ReportCard Studio plan price/duration change. */
  planChanges?: PlanPriceChange[];
  /** Set for a read-only ReportCard Studio plan price answer. */
  plans?: AdminSnapshotPlan[];
  /** Set for a read-only catalogue listing / knowledge answer. */
  catalogue?: CatalogueQuery;
  /** Navigation links that point at the real admin page for this answer. */
  links?: AdminPlanLink[];
  /**
   * The operation still waiting for a record when the plan asks which one is
   * meant, so a numbered reply continues that operation instead of starting a
   * new one.
   */
  pendingAction?: AdminAction;
  /** The numbered options this plan just listed, so a follow-up can pick one. */
  options?: AdminSelectionOption[];
  /** The single entry this plan is waiting for a price for. */
  pendingTheme?: AdminSelectionOption;
  /** The tier this plan is about, when exactly one tier is in play. */
  tier?: GreetingTierId;
  /**
   * Which short reply this plan is waiting for, so the console can carry the
   * question forward ("Basic" answers `tier`, "59" answers `price`).
   */
  awaiting?: AdminAwaiting;
  /** The amount already proposed when the plan is waiting for a tier name. */
  pendingAmount?: AdminPriceAmount;
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
  /**
   * Updates the price of every paid theme in one tier through the existing
   * `theme_prices` rows (the schema prices themes, not a separate tier product).
   * Optional so a caller without the server action fails honestly instead of
   * silently pretending the change happened.
   */
  updateTierPrice?(input: {
    tier: GreetingTierId;
    themeIds: string[];
    priceInr?: number;
    priceUsd?: number;
  }): MaybePromise<AdminOpResult>;
  /** Game Zone availability (enabled, maintenance, sort order). */
  updateGame?(patch: {
    enabled?: boolean;
    maintenance?: boolean;
    sortOrder?: number;
  }): MaybePromise<AdminOpResult>;
  /** Brand name, tagline and logo shown across the site. */
  updateBrand?(patch: {
    siteName?: string;
    tagline?: string;
    logoUrl?: string;
  }): MaybePromise<AdminOpResult>;
  /**
   * ReportCard Studio plan price / billing duration, written to
   * `studio_plan_prices` through the server action `pricing.plan.update`.
   */
  updatePlanPrice?(input: {
    planId: string;
    priceInr?: number;
    priceUsd?: number;
    durationMonths?: number;
  }): MaybePromise<AdminOpResult>;
  /** Catalogue-wide price change, recalculated and verified on the server. */
  bulkUpdatePrices?(input: {
    scope: BulkScope;
    mode: BulkMode;
    value: number;
    currency: PricingCurrency;
  }): MaybePromise<AdminOpResult>;
  report?(kind: 'orders' | 'overview' | 'audit'): MaybePromise<{ ok: boolean; text?: string; error?: string }>;
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
  'karo', 'kro', 'kro', 'kar', 'ka', 'ki', 'ke', 'ko', 'hai', 'hain', 'mein', 'kya',
  'badlo', 'hatao', 'hata', 'daalo', 'jodo', 'banao', 'dikhao', 'aaj',
  'kimat', 'bhav', 'naya', 'purana', 'chalu',
  /* Question/goal words: "kaise use karun", "mujhe … karna hai", "kahan hain". */
  'kaise', 'kese', 'kaisay', 'kaun', 'kaunsa', 'konsa', 'karun', 'karu', 'karna',
  'karni', 'karne', 'chahiye', 'mujhe', 'mera', 'meri', 'mere', 'mujhse', 'kahan',
  'kaha', 'aage', 'agle', 'agla', 'pichla', 'pehla', 'dusra', 'doosra', 'wala', 'bata',
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

/**
 * Tampering with security records or roles is refused. Reading the audit log is
 * allowed (`report.audit`) — only changing or erasing it is protected.
 */
const PROTECTED_PATTERNS: RegExp[] = [
  /\b(clear|delete|erase|wipe|remove|edit|change|disable|turn off|drop) (the )?(audit|security) (log|logs|record|records)\b/i,
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
  /*
   * A minus written directly before the amount ("-5", "₹-5", "$-5") is a real
   * negative, not punctuation. It is returned as-is so the range check refuses
   * it — dropping the sign would silently turn "-5" into a valid ₹5.
   */
  const negative = raw.match(/(?:^|[^\d\w.])(?:₹|\$)?-(?:₹|\$|rs\.?|inr)?(\d+(?:\.\d+)?)/i);
  if (negative) {
    const value = Number(negative[1]);
    if (Number.isFinite(value)) {
      const isUsd = /\$/.test(negative[0]) || /\busd\b/i.test(raw);
      return isUsd ? { priceUsd: -value } : { priceInr: -value };
    }
  }
  const usd = raw.match(/\$\s*(\d+(?:\.\d+)?)|\busd\b\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*\busd\b/i);
  if (usd) {
    const value = Number(usd[1] ?? usd[2] ?? usd[3]);
    if (Number.isFinite(value)) return { priceUsd: value };
  }
  /*
   * Rupees are written on either side of the amount: "₹59", "rs 59" and also
   * "59 rupees" / "59 rs" / "59 inr". All three positions are accepted.
   */
  const inr = raw.match(
    /₹\s*(\d+(?:\.\d+)?)|\b(?:rs\.?|inr|rupees?)\b\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*\b(?:rs\.?|inr|rupees?)\b/i,
  );
  if (inr) {
    const value = Number(inr[1] ?? inr[2] ?? inr[3]);
    if (Number.isFinite(value)) return { priceInr: value };
  }
  /* Bare "price to 399" / "rate 47" / "charge 59" — any real price synonym. */
  const bare = raw.match(
    /(?:price|prices|pricing|rate|rates|cost|costs|charge|charges|kimat|bhav|daam)[^0-9]{0,10}(\d+(?:\.\d+)?)/i,
  );
  if (bare) {
    const value = Number(bare[1]);
    if (Number.isFinite(value)) return { priceInr: value };
  }
  return {};
};

const word = (raw: string, list: string[]): boolean =>
  list.some((entry) => new RegExp(`\\b${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(raw));

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent transposition),
 * capped for speed. Transpositions are the most common fast-typing mistake
 * ("theams" for "themes"), so counting them as one edit is the difference
 * between understanding the word and rejecting it.
 *
 * Used only to tolerate typos in a short, curated set of command words — never
 * to guess a target name.
 */
const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 3) return 4;
  const rows: number[][] = [];
  rows[0] = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    rows[i] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = value;
    }
  }
  return rows[a.length][b.length];
};

/**
 * Matches a word exactly, or — for words long enough to be unambiguous — with a
 * small edit budget. This lets "chage", "prce" or "greetng" still be understood
 * without turning the parser into fuzzy guesswork (short words are exact only).
 */
const fuzzyWord = (raw: string, list: string[]): boolean => {
  if (word(raw, list)) return true;
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return list.some((entry) => {
    const target = entry.toLowerCase();
    if (target.includes(' ') || target.length < 4) return false;
    const budget = target.length >= 6 ? 2 : 1;
    return tokens.some((token) => {
      if (token.length < 4) return false;
      /*
       * A typo keeps the first letter and roughly the length. Without these two
       * guards a two-edit budget would start matching unrelated words ("these"
       * is one edit from "theme"), and an admin console must never guess.
       */
      if (token[0] !== target[0]) return false;
      if (Math.abs(token.length - target.length) > 1) return false;
      return editDistance(token, target) <= budget;
    });
  });
};

/** Exact-or-typo-tolerant word match for the core command vocabulary. */
const hasWord = (raw: string, list: string[]): boolean => word(raw, list) || fuzzyWord(raw, list);

/* ------------------------------------------------------------------ */
/* Greeting-card tier pricing                                         */
/* ------------------------------------------------------------------ */

/**
 * Tier spellings, including the common typos an admin makes while typing fast.
 * The canonical ids/order come from the existing product schema; only the
 * aliases live here.
 */
const TIER_ALIASES: Record<GreetingTierId, string[]> = {
  basic: ['basic', 'basics', 'basik', 'bassic'],
  plus: ['plus', 'pluss', 'plus tier'],
  premium: ['premium', 'premimum', 'premiun', 'premum', 'premiun tier'],
  elite: ['elite', 'eliete', 'elait', 'elit'],
};

/** Words that show the message is about greeting cards rather than the store. */
const GREETING_PRICING_CONTEXT = [
  'greeting', 'greetings', 'card', 'cards', 'theme', 'themes', 'tier', 'tiers',
  'plan', 'plans',
];

/** Words that mean "set this price" rather than "what is the price". */
const PRICE_UPDATE_WORDS = [
  'change', 'change karo', 'update', 'update karo', 'set', 'set karo', 'karo', 'kar do',
  'kardo', 'kar de', 'karde', 'badlo', 'badal do', 'badal', 'badle', 'make', 'modify',
  'revise', 'adjust', 'increase', 'decrease', 'reduce', 'raise', 'lower', 'lagao', 'daalo',
  'rakho', 'rakh do', 'kijiye', 'karne hain', 'karne hai', 'karna hai', 'update karna',
  'change karna', 'badhana hai', 'badhana', 'badhani hai', 'ghatana hai', 'kam karna hai',
  'increase karo', 'decrease karo',
  /* Typed/informal Hinglish forms: "krdo", "krni h", "47 ka krdo". */
  'krdo', 'kardo', 'krde', 'kro', 'ka krdo', 'ka kardo', 'ka kar do', 'krni', 'krna',
  'set krni', 'set karni', 'set krna',
];

/** Words that mean "tell me the current price". */
const PRICE_QUERY_PHRASES = [
  'current price', 'price kya', 'price kitna', 'prices kya', 'prices kitne', 'what is the price',
  'what are the prices', 'how much', 'kitna hai', 'kitne ka', 'kitne hai', 'price batao',
  'price bata do', 'rate kya', 'rates kya', 'cost kya', 'kimat kya', 'bhav kya',
];

const tierAliasEntries = (Object.entries(TIER_ALIASES) as [GreetingTierId, string[]][]).flatMap(
  ([tier, aliases]) => aliases.map((alias) => ({ tier, alias })),
);

/** Every tier named in the message, in the schema's own tier order. */
export const detectGreetingTiers = (raw: string): GreetingTierId[] => {
  const lower = raw.toLowerCase();
  const found = new Set<GreetingTierId>();
  for (const { tier, alias } of tierAliasEntries) {
    const re = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
    if (re.test(lower)) found.add(tier);
  }
  return GREETING_TIER_IDS.filter((tier) => found.has(tier));
};

/** Position (in words) of the first tier name in the message, or -1. */
const firstTierIndex = (raw: string): number => {
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.findIndex((token) =>
    tierAliasEntries.some(({ alias }) => alias.split(' ')[0] === token),
  );
};

const isPriceQuery = (lower: string): boolean => {
  const asks = PRICE_QUERY_PHRASES.some((phrase) => lower.includes(phrase));
  const updates = hasWord(lower, PRICE_UPDATE_WORDS);
  if (updates) return false;
  if (asks) return true;
  if (/\?/.test(lower)) return true;
  /*
   * "Basic greeting card price 99" is a terse command; "Basic greeting card
   * price" (no amount) is a question about the current value.
   */
  if (/\d/.test(lower)) return false;
  return hasWord(lower, PRICE_WORDS);
};

/**
 * A single price number typed without a currency/"price" prefix (e.g. "Premium
 * 99 kar do"). Only used when exactly one number is present — two numbers are
 * ambiguous and are never guessed.
 */
const parseSingleBareNumber = (raw: string): number | undefined => {
  const matches = [...raw.matchAll(/(?:^|[^\d])(\d{1,7}(?:\.\d{1,2})?)(?!\d|\.\d)/g)];
  const values = [...new Set(matches.map((match) => Number(match[1])).filter(Number.isFinite))];
  return values.length === 1 ? values[0] : undefined;
};

/**
 * Ordinal words and digits that answer "which tier?" — the tiers are shown in
 * the same fixed order as `GREETING_TIER_IDS`, so "the first one" is Basic.
 */
const TIER_ORDINALS: Record<string, GreetingTierId> = {
  first: 'basic', '1st': 'basic', '1': 'basic',
  second: 'plus', '2nd': 'plus', '2': 'plus',
  third: 'premium', '3rd': 'premium', '3': 'premium',
  fourth: 'elite', '4th': 'elite', '4': 'elite',
  /* Hinglish ordinals ("pehla", "dusra") use the same fixed tier order. */
  pehla: 'basic', pehli: 'basic', pehle: 'basic',
  dusra: 'plus', doosra: 'plus', dusri: 'plus', doosri: 'plus',
  teesra: 'premium', tisra: 'premium', teesri: 'premium',
  chautha: 'elite', chotha: 'elite', chauta: 'elite',
};

/*
 * Spelled-out cardinals ("one", "two"…) are weaker than ordinals: "that one" is
 * a pointer at the tier already under discussion, not a request for tier #1, so
 * they only count once no pointer word has claimed the reply.
 */
const TIER_CARDINALS: Record<string, GreetingTierId> = {
  one: 'basic', two: 'plus', three: 'premium', four: 'elite',
};

const matchTierWord = (raw: string, table: Record<string, GreetingTierId>): GreetingTierId | undefined => {
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const token of tokens) {
    const tier = table[token];
    if (tier) return tier;
  }
  return undefined;
};

const parseTierOrdinal = (raw: string): GreetingTierId | undefined => matchTierWord(raw, TIER_ORDINALS);

/** "that one", "this one", "same", "wahi", "usi" — a pointer, not a name. */
const REFERENTIAL_REPLY =
  /\b(that|this|same|last|wahi|usi|use|ye|yeh|isko|ise|iska|iski|iske|uska|uski|uske|inka|inki|unke)\b/i;

/** "it", "isko", "yeh", "iski" — a price reply that points at the record just discussed. */
const PRICE_REPLY_PRONOUN =
  /\b(it|its|it's|this|that|isko|ise|usko|use|ye|yeh|iska|iski|iske|uska|uski|uske|inka|inki|unke)\b/i;

/**
 * Resolves a short reply to the question the previous turn asked. Returns the
 * tier the admin chose, or undefined when the message is not a tier choice (so
 * the caller falls through to normal parsing). Never guesses a tier that was not
 * offered: the tier list is fixed to the four product tiers.
 */
const resolveTierReply = (
  raw: string,
  named: GreetingTierId[],
  context: AdminConversationContext,
): GreetingTierId | undefined => {
  if (named.length > 1) return undefined;
  if (named.length === 1) return named[0];
  const ordinal = parseTierOrdinal(raw);
  if (ordinal) return ordinal;
  if (REFERENTIAL_REPLY.test(raw)) return context.lastTier ?? GREETING_TIER_IDS[0];
  return matchTierWord(raw, TIER_CARDINALS);
};

/**
 * Resolves a short reply against the numbered options the previous turn listed
 * ("2", "the second one", "Rose Note", "sunset"). Only a genuine pointer is
 * accepted; anything else falls through to normal parsing so a fresh command is
 * never mistaken for a selection.
 */
const OPTION_ORDINALS: Record<string, number> = {
  first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2, fourth: 3, '4th': 3,
  fifth: 4, '5th': 4, sixth: 5, '6th': 5, seventh: 6, '7th': 6, eighth: 7, '8th': 7,
  ninth: 8, '9th': 8, tenth: 9, '10th': 9,
  /*
   * Hinglish ordinals, including the common "pehla wala" / "doosra" forms and
   * their oblique case ("dusre wale ki details"), which Hindi uses in front of
   * a noun.
   */
  pehla: 0, pehli: 0, pehle: 0, dusra: 1, doosra: 1, dusri: 1, doosri: 1, dusre: 1, doosre: 1,
  teesra: 2, tisra: 2, teesri: 2, chautha: 3, chotha: 3, chauta: 3,
  panchva: 4, paanchva: 4, panchwa: 4, chhata: 5, chhatha: 5, chhataa: 5,
  saatva: 6, aathva: 7, nauva: 8, dasva: 9,
};

const normalizeComparable = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const resolveOptionReply = (
  raw: string,
  options: AdminSelectionOption[],
): AdminSelectionOption | undefined => {
  const text = raw.trim();
  if (!text || options.length === 0) return undefined;

  const numbered = text.match(/^#?\s*(\d{1,2})\s*[.)]?$/);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    return options[index];
  }

  /*
   * The same pointer written out — "theme 2 ki details", "option 3", "#4". The
   * noun is required to be next to the number so a price ("₹2") or a count is
   * never mistaken for a selection.
   */
  const embedded = text.match(
    /\b(?:option|theme|product|card|item|entry|number|no\.?)\s*#?\s*(\d{1,2})\b/i,
  ) ?? text.match(/(?:^|\s)#\s*(\d{1,2})\b/);
  if (embedded) {
    const index = Number(embedded[1]) - 1;
    if (options[index]) return options[index];
  }

  const tokens = normalizeComparable(text).split(' ').filter(Boolean);
  for (const token of tokens) {
    const index = OPTION_ORDINALS[token];
    if (index !== undefined && options[index]) return options[index];
  }

  /* A name reply: exact, then unique partial. Kept to short replies only. */
  if (tokens.length > 6) return undefined;
  const wanted = normalizeComparable(text);
  if (wanted.length < 3) return undefined;
  const exact = options.filter((option) => normalizeComparable(option.name) === wanted);
  if (exact.length === 1) return exact[0];
  const partial = options.filter((option) => normalizeComparable(option.name).includes(wanted));
  return partial.length === 1 ? partial[0] : undefined;
};

const PUBLISH_WORDS = ['publish', 'go live', 'make live', 'publish karo', 'live karo', 'chalu karo', 'public karo'];
const UNPUBLISH_WORDS = ['unpublish', 'hide', 'unlist', 'unpublished', 'hide karo', 'band karo', 'hata do', 'hatao'];
const DELETE_WORDS = ['delete', 'remove', 'erase', 'mita do', 'mita', 'delete karo', 'hata do'];
const CREATE_WORDS = ['add', 'create', 'new product', 'naya product', 'add karo', 'jodo', 'daalo', 'catalogue me daalo', 'upload product'];
const PRICE_WORDS = [
  'price', 'prices', 'pricing', 'rate', 'rates', 'cost', 'costs', 'amount', 'amounts',
  'charge', 'charges', 'kimat', 'bhav', 'set price', 'price badlo',
];
const RENAME_WORDS = ['rename', 'name change', 'name badlo', 'title badlo', 'name set'];
const ORDER_REPORT_WORDS = ['order summary', 'orders', 'order', 'sales', 'aaj ke order', "today's order", 'todays order'];
const OVERVIEW_REPORT_WORDS = ['overview', 'snapshot', 'summary', 'analytics', 'report', 'reports'];
const AUDIT_REPORT_WORDS = [
  'audit log', 'audit logs', 'audit', 'audit entries', 'recent actions', 'admin actions',
  'action history', 'recent changes', 'who changed', 'kya kiya', 'kya change kiya',
  'recent activity', 'activity log',
];

/** Words that mean "apply this to the whole catalogue". */
const BULK_WORDS = [
  'all', 'every', 'entire', 'whole', 'sab', 'sabhi', 'saare', 'sare', 'poora', 'poori',
  'sab ke', 'sabka', 'sabki',
];

/** Percentage wording, so "10%" is read as a rule rather than a ₹10 price. */
const PERCENT_PATTERN = /(\d{1,3}(?:\.\d{1,2})?)\s*(?:%|percent|per\s?cent|pratishat|pratishat)/i;
const INCREASE_WORDS = ['increase', 'raise', 'hike', 'up', 'badha', 'badhao', 'badha do', 'zyada', 'mehnga'];
const DECREASE_WORDS = ['decrease', 'reduce', 'lower', 'drop', 'down', 'kam', 'kam karo', 'ghata', 'ghatao', 'sasta'];

/** Game Zone control words. */
const GAME_WORDS = ['game zone', 'game-zone', 'gamezone', 'pair 3 balls', 'pair3balls', 'pair-3balls', 'game', 'gaming'];
const GAME_ON_WORDS = ['enable', 'enable karo', 'on', 'chalu', 'chalu karo', 'start', 'live karo', 'turn on', 'on karo'];
const GAME_OFF_WORDS = ['disable', 'disable karo', 'off', 'band', 'band karo', 'stop', 'turn off', 'off karo', 'pause'];
const MAINTENANCE_WORDS = ['maintenance', 'maintenance mode', 'repair', 'down for maintenance'];

/** Brand setting words. */
const BRAND_NAME_WORDS = ['brand name', 'site name', 'site title', 'site ka naam'];
const BRAND_TAGLINE_WORDS = ['tagline', 'brand tagline', 'slogan', 'site tagline'];
const BRAND_LOGO_WORDS = ['logo url', 'logo', 'site logo', 'brand logo'];

/**
 * Reads the text after a keyword, stopping at a command verb. Used for free-text
 * brand values such as `site name Ishmaverse`. Quoted values are preferred by
 * the caller, so punctuation inside a name survives.
 */
const extractValueAfter = (raw: string, keyword: string): string | undefined => {
  const index = raw.toLowerCase().indexOf(keyword.toLowerCase());
  if (index === -1) return undefined;
  let after = raw.slice(index + keyword.length);
  /*
   * People write the value after a connector — "brand name TO Ishmaverse",
   * "tagline: Cards that feel alive", "site ka naam KO Ishmaverse karo". The
   * connector is punctuation, not part of the value, so it is dropped before the
   * value is read. Anything trailing that reads like a fresh instruction is cut.
   */
  after = after.replace(/^\s*[:=\-–]?\s*/i, '');
  after = after.replace(/^(?:to|as|ko|mein|me|into|hai|hona chahiye)\b\s*/i, '');
  after = after.replace(/\s+(?:please|pls|plz|karo|kar do|kar dena|kardo|badlo|rakho)\b[\s\S]*$/i, '');
  return cleanName(after);
};

/* ------------------------------------------------------------------ */
/* Name extraction and instructional-phrase guards                    */
/* ------------------------------------------------------------------ */

/**
 * Words that are never part of an entity name: commands, pronouns, connectors
 * and catalogue vocabulary. "Change only the Basic greeting theme I select."
 * must never yield "I select" as a theme name, and neither may an instruction
 * such as "let me choose" or "show me".
 */
const INSTRUCTION_WORDS = new Set([
  /* pronouns / speech acts */
  'i', 'we', 'you', 'me', 'my', 'us', 'it', 'its', 'that', 'this', 'these', 'those', 'them', 'one',
  /* conversational filler — "Actually make it 49" names no record */
  'actually', 'instead', 'wait', 'hmm', 'well', 'so', 'ok', 'okay',
  /* Hinglish pronouns — "iska price kya hai?" refers to a record, never names one */
  'iska', 'iske', 'iski', 'uska', 'uske', 'uski', 'isko', 'ise', 'ye', 'yeh', 'unka', 'unke',
  'want', 'wanna', 'need', 'like', 'would', 'could', 'can', 'should', 'will', 'shall', 'let', 'select',
  'selected', 'choose', 'chosen', 'pick', 'picked', 'please', 'pls', 'plz',
  /* verbs */
  'change', 'changing', 'set', 'update', 'updating', 'modify', 'edit', 'revise', 'adjust', 'make',
  'put', 'turn', 'move', 'give', 'show', 'showing', 'list', 'display', 'see', 'view', 'tell', 'help',
  /* question / determiner words */
  'how', 'what', 'which', 'when', 'where', 'who', 'why', 'new', 'old', 'current', 'next', 'all', 'every',
  'the', 'a', 'an', 'of', 'for', 'and', 'or', 'to', 'from', 'with', 'in', 'on', 'by', 'at', 'only',
  'just', 'also', 'then', 'now', 'again', 'their', 'its', 'names', 'name', 'prices', 'price', 'cost', 'rate',
  /* Hinglish */
  'karo', 'kar', 'kro', 'do', 'badlo', 'badal', 'badhao', 'badha', 'ghata', 'ghatao', 'dikhao', 'dikha',
  'batao', 'bata', 'hai', 'hain', 'ha', 'na', 'nahi', 'ka', 'ki', 'ke', 'ko', 'se', 'mein', 'me',
  'apna', 'apni', 'mujhe', 'sab', 'sabhi', 'saare', 'sare', 'har', 'abhi',
  /* catalogue vocabulary */
  'theme', 'themes', 'card', 'cards', 'greeting', 'greetings', 'product', 'products', 'item', 'items',
  'catalogue', 'catalog', 'store', 'pricing', 'rates', 'costs', 'charge', 'charges', 'amount', 'tier',
  'tiers', 'plan', 'plans', 'basic', 'plus', 'premium', 'elite',
]);

/** Words that introduce the price in "… price from X to Y" / "… ka price". */
const PRICE_KEYWORD_RE = /\b(price|prices|pricing|rate|rates|cost|costs|charge|charges|kimat|bhav|amount)\b/i;

/**
 * Position of the price word, tolerating a typo ("prie", "prce", "rat"). A
 * misspelt keyword used to hide the whole name behind it ("rose note ka prie 59"
 * became the entity name "rose note ka prie"), so the same word list is matched
 * approximately as well as exactly.
 */
const findPriceKeywordIndex = (lower: string): number => {
  const exact = lower.search(PRICE_KEYWORD_RE);
  if (exact >= 0) return exact;
  const wordRe = /[a-z]+/g;
  let match: RegExpExecArray | null;
  while ((match = wordRe.exec(lower)) !== null) {
    const token = match[0];
    if (token.length < 4) continue;
    if (['price', 'prices', 'pricing', 'charge', 'charges'].some((word) => editDistance(token, word) <= 1)) {
      return match.index;
    }
  }
  return -1;
};

const describeToken = (token: string): string => token.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Reads the entity name written before the price word: "Change Rose Note price
 * from 40 to 47." → "Rose Note"; "Rose Note ka price 40 se 47 kar do." →
 * "Rose Note". Leading/trailing command words are stripped, and the result is
 * only accepted when at least one token is a real name word (never "I select").
 */
const extractNameBeforePrice = (raw: string): string | undefined => {
  const lower = raw.toLowerCase();
  const keywordIndex = findPriceKeywordIndex(lower);
  const digitIndex = lower.search(/\d/);
  const cuts = [keywordIndex, digitIndex].filter((index) => index >= 0);
  if (cuts.length === 0) return undefined;
  const cut = Math.min(...cuts);
  const before = raw.slice(0, cut).replace(/[.,;:!?]+$/, '').trim();
  if (!before) return undefined;
  const tokens = before.split(/\s+/);
  while (tokens.length > 1 && INSTRUCTION_WORDS.has(describeToken(tokens[0]))) tokens.shift();
  while (tokens.length > 1 && INSTRUCTION_WORDS.has(describeToken(tokens[tokens.length - 1]))) tokens.pop();
  return cleanName(tokens.join(' '));
};

/**
 * Reads an entity name written AFTER the price word — "price of Rose Note",
 * "rate for Rose Note". The "before" reader cannot see these, so without this
 * the request fell through to the tier question.
 */
const extractNameAfterPrice = (raw: string): string | undefined => {
  const match = raw.match(
    /\b(?:price|prices|pricing|rate|rates|cost|costs|charge|charges|kimat|bhav|daam)\s+(?:of|for|ka|ki|ke)\s+["'“”]?(.+?)["'“”]?(?=[.,;!?]|$)/i,
  );
  if (!match) return undefined;
  /*
   * The phrase runs to the end of the sentence, so it can swallow the new price
   * ("price of Ocean View to 399"). Cut at the first amount or change phrase so
   * the name stays a name — otherwise the target is never found.
   */
  const captured = match[1];
  const cut = captured.search(/\s(?:to|se|into|kar|kardo|krdo|kro|set|at|for)\b|\s*[₹$]?\s*\d/i);
  const name = cut >= 0 ? captured.slice(0, cut) : captured;
  return stripInstructionWords(name.trim());
};

/** True when an extracted phrase could be a real catalogue name, not an instruction. */
const isPlausibleEntityName = (name: string | undefined): boolean => {
  if (!name) return false;
  const tokens = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 6) return false;
  return tokens.some((token) => token.length >= 3 && !INSTRUCTION_WORDS.has(token));
};

/* ------------------------------------------------------------------ */
/* Catalogue discovery vocabulary                                     */
/* ------------------------------------------------------------------ */

const LIST_VERBS = ['show', 'list', 'display', 'view', 'see', 'dikhao', 'dikha do', 'dikha', 'batao', 'bata do', 'give me'];
const FIND_VERBS = ['find', 'search', 'locate', 'lookup', 'look up', 'kahan hai', 'kaha hai', 'dhoondo', 'dhundo'];
const PLURAL_CATALOGUE = /\b(themes|cards|greetings|products|items|plans|tiers)\b/i;
const CATALOGUE_NOUN = /\b(theme|themes|card|cards|greeting|greetings|product|products|item|items|catalogue|catalog|store|plan|plans|tier|tiers)\b/i;
/**
 * Catalogue words that tolerate a small typo ("theams", "prodcuts"). Short
 * words stay exact-only so this never turns into guesswork.
 */
const FUZZY_CATALOGUE_NOUNS = ['theme', 'themes', 'card', 'cards', 'greeting', 'greetings', 'product', 'products'];

/**
 * Short catalogue words whose common misspelling is two edits away ("theam"
 * from "theme"). The general fuzzy budget stays at one edit below six letters,
 * so these few typed forms are listed instead of widening every short word.
 */
const CATALOGUE_TYPOS = ['theam', 'theams', 'themse', 'prodcut', 'produts', 'greetng'];

/**
 * A catalogue word typed without the space before it ("allthemes",
 * "showallcards"). Only a real suffix counts, and only when some letters come
 * before it, so an ordinary word is never mistaken for a catalogue.
 */
const GLUED_NOUNS: { noun: string; scope: 'themes' | 'products' }[] = [
  { noun: 'products', scope: 'products' },
  { noun: 'product', scope: 'products' },
  { noun: 'themes', scope: 'themes' },
  { noun: 'theme', scope: 'themes' },
  { noun: 'greetings', scope: 'themes' },
  { noun: 'greeting', scope: 'themes' },
  { noun: 'cards', scope: 'themes' },
  { noun: 'card', scope: 'themes' },
];

const gluedCatalogueScope = (lower: string): 'themes' | 'products' | undefined => {
  for (const token of lower.split(/[^a-z0-9]+/).filter(Boolean)) {
    const hit = GLUED_NOUNS.find(
      (entry) => token.length > entry.noun.length + 1 && token.endsWith(entry.noun),
    );
    if (hit) return hit.scope;
  }
  return undefined;
};

/** True when the message names a catalogue, allowing a common typo. */
const mentionsCatalogueNoun = (lower: string): boolean =>
  CATALOGUE_NOUN.test(lower) ||
  hasWord(lower, FUZZY_CATALOGUE_NOUNS) ||
  word(lower, CATALOGUE_TYPOS) ||
  gluedCatalogueScope(lower) !== undefined;

/** The catalogue words that select the product store rather than greeting cards. */
const PRODUCT_NOUNS = ['product', 'products', 'item', 'items', 'store'];
const THEME_NOUNS = ['theme', 'themes', 'card', 'cards', 'greeting', 'greetings', 'plan', 'plans', 'tier', 'tiers'];

/** "cheapest" / "sabse sasta" / "lowest price" — a price ordering request. */
const CHEAPEST_RE = /\b(cheapest|cheaper|lowest|least expensive|sabse sasta|sabse sasti|sasta|sasti|kam daam|kam price)\b/i;
const COSTLIEST_RE = /\b(most expensive|expensive|costliest|highest price|sabse mehnga|sabse mehngi|mehnga|mehngi)\b/i;

/** "unpublished", "public nahi", "publish nahi hue", "live nahi" — one filter. */
const UNPUBLISHED_INTENT =
  /\b(unpublished|un-published|not published|draft|hidden)\b|\bpublish(?:ed)?\s+nahi\b|\bpublic\s+nahi\b|\b(?:live|chalu)\s+nahi\b/i;

/** Publication wording ("active", "live", "published") and its opposite. */
const ACTIVE_INTENT = /\b(active|live|published|online|chalu)\b/i;

/**
 * Unmistakably English wording. Used only to decide which language to answer in:
 * a full English sentence after a Hinglish turn must not be answered in
 * Hinglish, while a neutral one-line reply ("59", "2") still follows the
 * language of the question it answers.
 */
const ENGLISH_SIGNAL =
  /\b(the|please|show|list|find|change|set|make|update|delete|remove|publish|unpublish|deactivate|activate|price|prices|current|what|which|how|details?|tags?|category|all|me|my|it|its|is|are|of|to|for|with|and|from|active|inactive|cheapest|lowest|name|card|product|item)\b/i;
const INACTIVE_INTENT = /\b(inactive|deactivated|disabled|not active|offline)\b/i;

/**
 * A second operation joined with "and/then" in the same message. It is never
 * executed silently: the plan reports it as a separate step.
 */
const detectSecondaryAction = (lower: string): 'publish' | 'unpublish' | 'delete' | 'rename' | undefined => {
  /*
   * The second operation can be joined with "and/then/aur/phir" or simply
   * written as its own sentence ("Change Rose Note price to 59. Publish it.").
   * Either way it is a separate change, never folded into this one.
   */
  const match = lower.match(
    /(?:\b(?:and|then|aur|phir)\b|[.;!]\s+)[\s\S]*\b(publish|unpublish|delete|remove|rename)\b/i,
  );
  if (!match) return undefined;
  const verb = match[1].toLowerCase();
  if (verb === 'unpublish') return 'unpublish';
  if (verb === 'publish') return 'publish';
  if (verb === 'rename') return 'rename';
  return 'delete';
};
/** "… let me choose one", "I select", "choose one" — an invitation to pick from a list. */
const SELECT_NEXT = /\b(let me (choose|pick|select)|i (?:will |want to |would like to |'ll )?(choose|pick|select)|choose one|select one|pick one|select karna|choose karna|chun lo|chuno|select karunga)\b/i;
const NAMES_AND_PRICES = /\b(names? (?:and|&) prices?|with (?:their )?names|[a-z]+ aur (?:price|daam|kimat)|naam aur)\b/i;

/**
 * Detects a read-only listing request such as "show me the Basic themes",
 * "list Basic cards", "show names and prices" or "… then let me choose one".
 * A pure tier price question ("show me the current pricing") is deliberately
 * not a listing, so the existing tier read path is untouched.
 */
const wantsCatalogueList = (text: string, lower: string, tiers: GreetingTierId[]): boolean => {
  /*
   * A mutation verb wins over a weak list verb. Product and theme names can
   * contain those verbs ("Ocean View"), so "update product Ocean View price to
   * 399" must stay a price change rather than becoming "view …". Only an
   * explicit read verb at the start of the request keeps it a listing.
   */
  const STRONG_LIST_VERBS = ['show', 'list', 'display', 'dikhao', 'dikha', 'batao', 'bata do'];
  /* "showallthemes" — a typed-together request is still a listing request. */
  const gluedListVerb = lower
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .some((token) =>
      ['show', 'list', 'display', 'dikhao', 'batao'].some(
        (verb) => token.length >= verb.length + 3 && token.startsWith(verb),
      ),
    );
  /*
   * Only a real mutation verb (or a price followed by a set verb) outranks a
   * listing. "Unpublished" must not count as "unpublish", and Hinglish fillers
   * like "karo" alone are not a change — otherwise "Pehla wala select karo"
   * stopped being a selection.
   */
  const MUTATION_VERBS = [
    'change', 'set', 'update', 'delete', 'remove', 'erase', 'rename', 'make', 'modify',
    'increase', 'decrease', 'reduce', 'raise', 'lower', 'publish', 'unpublish',
  ];
  const mutationIntent =
    hasWord(lower, MUTATION_VERBS) ||
    (hasWord(lower, PRICE_UPDATE_WORDS) && /\d/.test(lower));
  if (mutationIntent && !word(lower, STRONG_LIST_VERBS)) return false;
  if (SELECT_NEXT.test(text)) return true;
  /*
   * An explicit lookup by name with no catalogue noun — "Find Rose Note.",
   * "Rose Note kahan hai?" — is a read-only search, not an instruction. It is
   * resolved against both catalogues by name and never mutates anything.
   */
  if (!mentionsCatalogueNoun(lower) && hasWord(lower, FIND_VERBS) && extractSearchTerm(text) !== undefined) {
    return true;
  }
  /*
   * Ordering and availability questions are listings even when no list verb is
   * used: "List the cheapest themes", "Sabse sasta card konsa hai?", "Show
   * active products", "Jo public nahi hain wo dikhao".
   */
  if ((CHEAPEST_RE.test(lower) || COSTLIEST_RE.test(lower)) && mentionsCatalogueNoun(lower)) {
    return true;
  }
  if (UNPUBLISHED_INTENT.test(lower) && (hasWord(lower, LIST_VERBS) || hasWord(lower, FIND_VERBS) || /\b(which|kaun|konsi|kaunsi)\b/i.test(lower))) {
    return true;
  }
  if (NAMES_AND_PRICES.test(lower) && mentionsCatalogueNoun(lower)) return true;
  /* "What tags does this card have?" / "Is card ke tags kya hain?" */
  if (
    /\btags?\b/i.test(lower) &&
    mentionsCatalogueNoun(lower) &&
    /\b(kya|kitne|kitna|what|which|konsa|kaun|hain|hai)\b/i.test(lower)
  ) {
    return true;
  }
  const asks =
    hasWord(lower, LIST_VERBS) ||
    gluedListVerb ||
    hasWord(lower, FIND_VERBS) ||
    /*
     * A status question with a plural catalogue noun — "Which products are
     * unpublished?" — names no list verb, yet it is still a read-only listing.
     * 'what' is deliberately excluded so "What is the price of Basic greeting
     * cards?" keeps going to the tier price read path.
     */
    (/\b(which|kaun|konsa|kaunse|konsi|kaunsi|konse)\b/i.test(lower) && PLURAL_CATALOGUE.test(lower));
  if (!asks) return false;
  if (!mentionsCatalogueNoun(lower)) return false;
  /*
   * A list verb plus a catalogue noun is a listing in the singular too ("bday
   * wale card dikha do"); the plural rule alone silently ignored such requests.
   */
  return (
    PLURAL_CATALOGUE.test(lower) ||
    tiers.length > 0 ||
    hasWord(lower, LIST_VERBS) ||
    gluedListVerb ||
    (hasWord(lower, FIND_VERBS) && extractSearchTerm(text) !== undefined)
  );
};

/**
 * A one-line answer to the question Joy has open, as opposed to a new request.
 *
 * Precedence rule that the reported failure broke: with "which greeting card
 * tier?" open, the admin's full request ("…Show me the Basic themes…, then let
 * me choose one…") was consumed as the answer "Basic", so the listing never
 * happened and the turn ended on an instruction phrase read as a name. A message
 * that asks for a listing, or that is far too long to be an answer, is a fresh
 * command and must fall through to normal parsing.
 */
const SHORT_REPLY_MAX_WORDS = 8;

const isShortReplyTo = (raw: string, lower: string, tiers: GreetingTierId[]): boolean => {
  if (raw.trim().split(/\s+/).filter(Boolean).length > SHORT_REPLY_MAX_WORDS) return false;
  return !wantsCatalogueList(raw, lower, tiers);
};

/** Words that can never be a tag value ("tags kya hain?" is a question, not a filter). */
const TAG_STOPWORDS = new Set([
  'kya', 'kitne', 'kitna', 'what', 'which', 'konsa', 'kaun', 'hain', 'hai', 'h',
  'ke', 'ki', 'ka', 'ko', 'is', 'this', 'that', 'the', 'a', 'an', 'liye', 'me', 'mein',
  'do', 'please', 'show', 'list', 'dikhao', 'batao', 'has', 'have', 'does',
]);

/** Reads an explicit tag filter: "tagged birthday", "tag birthday", "birthday tag(s)". */
const extractTagFilter = (raw: string): string | undefined => {
  const match =
    raw.match(/\btagged\s+(?:with\s+|by\s+)?["'“”]?([a-z0-9][a-z0-9 _-]{1,30}?)["'“”]?(?=[\s.,;:!?]|$)/i) ??
    raw.match(/\btags?\s*[:\-]\s*["'“”]?([a-z0-9][a-z0-9 _-]{1,30}?)["'“”]?(?=[\s.,;:!?]|$)/i) ??
    raw.match(/["'“”]?([a-z0-9][a-z0-9 _-]{1,30}?)["'“”]?\s+tags?\b/i);
  if (!match) return undefined;
  const tag = match[1].trim().toLowerCase();
  if (!tag) return undefined;
  /* A question about tags ("… ke tags kya hain?") is not a filter value. */
  return tag.split(/\s+/).some((token) => TAG_STOPWORDS.has(token) || INSTRUCTION_WORDS.has(token))
    ? undefined
    : tag;
};

/* ------------------------------------------------------------------ */
/* Category & id lookup (read-only, from the real catalogue)          */
/* ------------------------------------------------------------------ */

/**
 * Category lookup built from the actual theme catalogue data
 * (`src/data/greetingThemes.ts`): each category's id, display name and its real
 * `keywords` list are all accepted, so "romantic", "love" and "valentine" all
 * resolve to the `romantic` category. Nothing is invented here, and the index is
 * built lazily because it folds values with `normalizeName`.
 */
let categoryAliasIndex: { id: string; name: string; aliases: string[] }[] | undefined;

const categoryAliasEntries = (): { id: string; name: string; aliases: string[] }[] => {
  if (!categoryAliasIndex) {
    categoryAliasIndex = greetingCategories.map((category) => ({
      id: category.id,
      name: category.name,
      aliases: Array.from(
        new Set([category.name, category.id, ...category.keywords].map((value) => normalizeName(value))),
      ).filter(Boolean),
    }));
  }
  return categoryAliasIndex;
};

/** Resolves a category name, id or keyword to its real catalogue category. */
const resolveCategory = (value: string): { id: string; name: string } | undefined => {
  const wanted = normalizeName(value);
  if (!wanted) return undefined;
  const entries = categoryAliasEntries();
  const exact = entries.find((entry) => entry.aliases.includes(wanted));
  if (exact) return { id: exact.id, name: exact.name };
  const partial = entries.find((entry) => entry.aliases.some((alias) => alias.startsWith(wanted)));
  return partial ? { id: partial.id, name: partial.name } : undefined;
};

/** The display name of a resolved category id (falls back to the id itself). */
const categoryLabel = (id: string): string =>
  categoryAliasEntries().find((entry) => entry.id === id)?.name ?? id;

/**
 * Reads an explicit category filter: "category: romantic", "romantic category",
 * "birthday section ke themes". The category must resolve against the real
 * catalogue; otherwise it is not treated as a filter at all.
 */
const extractCategoryFilter = (raw: string): string | undefined => {
  const inline = raw.match(
    /\bcategor(?:y|ies)\s*[:\-]?\s*["'“”]?([a-z0-9][a-z0-9 _&-]{0,30}?)["'“”]?(?=[\s.,;:!?]|$)/i,
  );
  if (inline) {
    const resolved = resolveCategory(stripInstructionWords(inline[1]) ?? inline[1]);
    if (resolved) return resolved.id;
  }
  const before = raw.match(
    /(?:^|[\s"'“”])([a-z0-9][a-z0-9_-]{1,24})\s+(?:categor(?:y|ies)|section)\b/i,
  );
  if (before) {
    const resolved = resolveCategory(before[1]);
    if (resolved) return resolved.id;
  }
  /*
   * A category used as an adjective in front of the catalogue noun — "birthday
   * themes", "bday cards", "Birthday wale cards" — is the same filter as
   * "category: birthday". The aliases come from the real theme catalogue, so no
   * category is invented and a theme NAME ("Birthday Bash") is not matched: the
   * noun has to follow the alias.
   */
  for (const entry of categoryAliasEntries()) {
    for (const alias of entry.aliases) {
      if (alias.length < 3) continue;
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const adjective = new RegExp(
        `\\b${escaped}\\b\\s*(?:(?:wala|wale|wali|vale|type|kind|ke|ki|ka)\\s+)?(?:greeting\\s+)?(?:themes?|cards?|greetings?|designs?)\\b`,
        'i',
      );
      const possessive = new RegExp(
        `\\b(?:greeting\\s+)?(?:themes?|cards?|greetings?)\\s+(?:in|of|from|under|ka|ki|ke)\\s+${escaped}\\b`,
        'i',
      );
      if (adjective.test(raw) || possessive.test(raw)) return entry.id;
    }
  }
  /*
   * The same adjective with a typo — "Birhtday themes dikhao" — still names that
   * category, but only when the word sits directly in front of a catalogue noun
   * and exactly one real category matches. Anything ambiguous stays unfiltered
   * rather than filtering by a guess.
   */
  const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean);
  const noun = /^(?:themes?|cards?|greetings?|designs?)$/;
  const connector = /^(?:wala|wale|wali|vale|type|kind|ke|ki|ka)$/;
  const matchedCategories = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index].replace(/[^a-z0-9-]/g, '');
    if (token.length < 5) continue;
    let next = index + 1;
    while (next < tokens.length && connector.test(tokens[next])) next += 1;
    if (next >= tokens.length || !noun.test(tokens[next].replace(/[^a-z0-9]/g, ''))) continue;
    for (const entry of categoryAliasEntries()) {
      for (const alias of entry.aliases) {
        if (alias.includes(' ') || alias.length < 5) continue;
        if (token[0] !== alias[0] || Math.abs(token.length - alias.length) > 1) continue;
        if (editDistance(token, alias) <= 1) matchedCategories.add(entry.id);
      }
    }
  }
  return matchedCategories.size === 1 ? [...matchedCategories][0] : undefined;
};

/**
 * Reads an explicit id filter: "id: rose-note", "theme id t1", "#t1". The value
 * is folded with `normalizeName` so it matches the stored entry id the same way
 * a name does.
 */
const extractIdFilter = (raw: string): string | undefined => {
  /*
   * `\bid\b(?!s)` plus a required separator or space: the old pattern matched the
   * letters "id" inside the word "identify" and read "identify …" as an id
   * filter, which silently returned zero products.
   */
  const match =
    raw.match(/\bid\b(?!s)\s*[:#-]\s*["'“”]?([a-z0-9][a-z0-9_-]{1,60})["'“”]?(?=[\s.,;:!?]|$)/i) ??
    raw.match(/\bid\b(?!s)\s+["'“”]?([a-z0-9][a-z0-9_-]{1,60})["'“”]?(?=[\s.,;:!?]|$)/i) ??
    raw.match(/#([a-z0-9][a-z0-9_-]{2,60})\b/i);
  return match ? normalizeName(match[1]) : undefined;
};

/**
 * Words that describe a filter, never a name: "find cards with missing tags" is
 * a missing-tags query, not a request for a card actually called "missing".
 */
const SEARCH_QUALIFIERS = new Set([
  'missing', 'without', 'none', 'unpublished', 'published', 'draft', 'hidden',
  'bina', 'khaali', 'khali', 'tags', 'tag', 'all', 'every', 'sab', 'sabhi', 'saare', 'sare',
]);

/**
 * Drops leading/trailing filter modifiers from a captured search phrase, so
 * "find unpublished birthday themes" does not become the name "unpublished
 * birthday".
 */
const stripSearchQualifiers = (term: string | undefined): string | undefined => {
  if (!term) return undefined;
  const tokens = term.split(/\s+/).filter(Boolean);
  const isQualifier = (token: string) => {
    const bare = normalizeComparable(token);
    return bare !== '' && (SEARCH_QUALIFIERS.has(bare) || SEARCH_QUALIFIERS.has(token.toLowerCase()));
  };
  while (tokens.length > 0 && isQualifier(tokens[0])) tokens.shift();
  while (tokens.length > 0 && isQualifier(tokens[tokens.length - 1])) tokens.pop();
  return tokens.length > 0 ? tokens.join(' ') : undefined;
};

/**
 * Reads an explicit search term: "find Rose Note" → "Rose Note", "Rose Note kahan
 * hai" → "Rose Note". Only explicit search wording produces a term, so a listing
 * instruction ("Show me the Basic themes …, then let me choose one") is never
 * mistaken for a search.
 */
const extractSearchTerm = (raw: string): string | undefined => {
  const patterns: RegExp[] = [
    /^\s*(?:please\s+)?(?:find|search(?:\s+for)?|locate|look\s?up)\s+(.+)$/i,
    /\b(?:find|search(?:\s+for)?|locate|look\s?up)\s+["'“”]?([^"'“”]{2,60})["'“”]?\s*$/i,
    /^\s*["'“”]?(.{2,60}?)["'“”]?\s+(?:kahan hai|kaha hai|konsa hai|kaun sa hai|dhoondo|dhundo)\b/i,
  ];
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (!match) continue;
    /* Filter modifiers belong to filters, not to the entity name. */
    const term = stripSearchQualifiers(stripInstructionWords(match[1]));
    if (!term || !isPlausibleEntityName(term)) continue;
    /* A phrase that is only filter wording is not a name. */
    const tokens = term.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (tokens.length > 0 && tokens.every((token) => SEARCH_QUALIFIERS.has(token))) continue;
    return term;
  }
  return undefined;
};

/** Drops leading/trailing command words and a trailing clause from a captured phrase. */
const stripInstructionWords = (value: string): string | undefined => {
  let text = value;
  text = text.replace(/\b(?:and|then|aur|phir)\b[\s\S]*$/i, ' ');
  text = text.replace(/\b(?:ka|ki|ke)?\s*(?:price|prices|pricing|rate|cost|kimat|bhav|tags?|naam)\b[\s\S]*$/i, ' ');
  const tokens = text
    .split(/\s+/)
    .map((token) => token.replace(/[.,;:!?]+$/, ''))
    .filter(Boolean);
  while (tokens.length > 1 && INSTRUCTION_WORDS.has(describeToken(tokens[0]))) tokens.shift();
  while (tokens.length > 1 && INSTRUCTION_WORDS.has(describeToken(tokens[tokens.length - 1]))) tokens.pop();
  return cleanName(tokens.join(' '));
};

/* ------------------------------------------------------------------ */
/* Platform knowledge vocabulary                                      */
/* ------------------------------------------------------------------ */

const REPORT_CARD_RE = /\b(report\s?cards?|reportcard|report\s?card\s?studio|reportcard\s?studio|report\s?studio)\b/i;

/** True when the admin is asking about ReportCard Studio rather than issuing a command. */
const isReportCardQuery = (lower: string): boolean => {
  if (!REPORT_CARD_RE.test(lower)) return false;
  return /\b(how|what|which|kaise|kya|konsa|works?|kaam|features?|supports?|list|show|explain|help|missing|status|about|describe)\b/i.test(lower);
};

/**
 * True when the admin is asking which admin operations Joy can perform. The
 * question word alone is deliberately not enough: plain "what can you do" stays
 * with {@link isAdminHelpQuery}, so existing behaviour is unchanged.
 */
const isOperationsQuery = (lower: string): boolean => {
  if (!/\b(operations?|actions?|commands?|capabilities|tools?)\b/i.test(lower)) return false;
  return /\b(admin|what|which|list|show|can|perform|kya|kaun|konsa)\b/i.test(lower);
};

/* ------------------------------------------------------------------ */
/* Guided admin workflows                                             */
/* ------------------------------------------------------------------ */

/**
 * Real dashboard tabs. Every link Joy offers is built from one of these, so a
 * guided answer can never point at a page that does not exist. The dashboard
 * reads the same `?tab=` value on load (`src/components/AdminDashboard.tsx`).
 */
export const ADMIN_TAB_HREF = {
  overview: '/admin/dashboard?tab=overview',
  audience: '/admin/dashboard?tab=audience',
  greetings: '/admin/dashboard?tab=greetings',
  products: '/admin/dashboard?tab=products',
  pricing: '/admin/dashboard?tab=pricing',
  transactions: '/admin/dashboard?tab=transactions',
  cards: '/admin/dashboard?tab=cards',
  subscriptions: '/admin/dashboard?tab=subscriptions',
  settings: '/admin/dashboard?tab=settings',
  joy: '/admin/dashboard?tab=joy',
  game: '/admin/dashboard?tab=game',
} as const;

/** The real public route for ReportCard Studio (see `src/data/sections.ts`). */
export const REPORTCARD_ROUTE = '/section/reportcard-studio';

/** Phrasing that asks *how* to do something rather than asking Joy to do it. */
const GUIDE_ASK = /\b(how|kaise|kaisay|kese|kaisi|help|guide|guided|steps?|process|workflow|walk me|where|kahan|kaha|troubleshoot|samjhao|samjha do|sikhao|sikh do|seekhna|understand|start|setup|set up|configure)\b/i;

/** "I want to …" / "mujhe … karna hai" — a goal, usually not a full command. */
const GUIDE_WANT = /\b(i want to|i wanna|i need to|need to|want to|karna hai|karna h|karne hain|karne hai|krna hai|mujhe|chahiye)\b/i;

/** Words that mean something is going wrong and the admin wants it diagnosed. */
const PRICING_TROUBLE = /\b(issue|issues|problem|problems|wrong|galat|stuck|error|fails?|failing|not working|nahi chal|nahi ho|dikkat|mess|messed)\b/i;

/** "next page" / "agle page dikhao" / "previous page" / "pichla page". */
const PAGE_PREV_RE = /\b(previous|prev|pichl[aei]|pichh?l[aei]|back)\s*(?:ke\s*)?page\b/i;
const PAGE_NEXT_RE = /\b(next|agl[aei]|aagl[ei]|aage)\s*(?:ke\s*)?(?:page|12|results?)\b|\bshow\s+more\b|\bmore\s+(?:cards|themes|products|items|results)\b/i;

/** Direction of a paging reply: +1 next page, -1 previous page, 0 not paging. */
const pageRequest = (raw: string): number => {
  if (PAGE_PREV_RE.test(raw)) return -1;
  if (PAGE_NEXT_RE.test(raw)) return 1;
  if (/^\s*(?:next|aage|agle)\s*(?:what|dikhao)?\s*$/i.test(raw)) return 1;
  return 0;
};

/**
 * Resolves a how-to request to a real guided workflow. Guidance is read-only: it
 * explains the correct steps, pulls real figures from the live snapshot where it
 * can, and links to the page that actually performs the work — it never claims a
 * step was executed.
 *
 * It deliberately runs on *goal* phrasing ("how do I…", "mujhe … karna hai",
 * "help me fix…") so a real command such as "add product Mystery Box" stays a
 * command and is not turned into a tutorial.
 */
const detectGuideTopic = (raw: string, lower: string): AdminGuideId | undefined => {
  const asks = GUIDE_ASK.test(lower) || GUIDE_WANT.test(lower);
  const greetingTalk = /\b(greeting|greetings|theme|themes|card|cards)\b/i.test(lower);
  const productTalk = /\b(product|products|item|items|store)\b/i.test(lower);
  const addTalk =
    /\b(upload|uploading|add|create|naya|nayi|banana|banao|daalo|daal)\b/i.test(lower) ||
    /\bnew\s+(?:theme|themes|card|cards|greeting|greetings|product|products|item|items)\b/i.test(lower);
  const priceTalk = /\b(price|prices|pricing|rate|rates|cost|costs|kimat|bhav|daam)\b/i.test(lower);

  /*
   * ReportCard Studio *usage* is its own guide; "how does it work / kaise kaam
   * karta hai" stays with the deeper knowledge answer, which cites the source.
   */
  if (
    REPORT_CARD_RE.test(lower) &&
    /\b(use|using|start|upload|generate|print|steps?|karun|karu|karna|kaise use)\b/i.test(lower) &&
    !/\b(work|works|working|kaam karta|kaam karti|kaise kaam)\b/i.test(lower)
  ) {
    return 'reportcard-use';
  }

  if (priceTalk && PRICING_TROUBLE.test(lower)) return 'pricing-troubleshoot';

  /*
   * A greeting theme is created through the dashboard form only — the server has
   * no theme-create action — so "upload/add a greeting card" is always guidance,
   * never a plan that pretends it can be created from chat.
   */
  if (greetingTalk && addTalk && !productTalk && !/\btags?\b/i.test(lower)) return 'greeting-upload';

  if (productTalk && addTalk && asks) {
    const named = extractQuotedName(raw) ?? extractNameAfter(raw, 'product');
    if (!isPlausibleEntityName(named)) return 'product-add';
  }

  if (asks && word(lower, GAME_WORDS) && (word(lower, MAINTENANCE_WORDS) || /\b(down|offline|pause)\b/i.test(lower))) {
    return 'game-maintenance';
  }

  if (asks && /\b(sales?|orders?|revenue|transactions?|payments?)\b/i.test(lower) && !word(lower, DELETE_WORDS)) {
    return 'sales-report';
  }

  return undefined;
};

/** Bilingual text pair used by the guide registry. */
interface GuideText {
  en: string;
  hi: string;
}

/**
 * The guided workflows, written against the actual admin UI and server actions.
 * Every route below is one this app serves, and every capability mentioned is one
 * the `admin-ops` Edge Function really implements.
 */
const ADMIN_GUIDES: Record<
  AdminGuideId,
  {
    title: GuideText;
    steps: { en: string[]; hi: string[] };
    note: GuideText;
    links: { href: string; label: GuideText }[];
  }
> = {
  'greeting-upload': {
    title: { en: 'Uploading a greeting card theme', hi: 'Greeting card theme upload karna' },
    steps: {
      en: [
        'Open Admin Dashboard → Manage Greetings.',
        'Click “Add theme”.',
        'Fill in theme name, emoji, tagline, category and tier (Basic / Plus / Premium / Elite).',
        'Set the INR and USD prices — paid cards in one tier should share the same price.',
        'Upload the artwork (or paste a hosted image URL) and pick the accent, gradient and animation.',
        'Add search tags so the catalogue search can find it, then save — the theme goes live immediately.',
      ],
      hi: [
        'Admin Dashboard → Manage Greetings kholiye.',
        '“Add theme” par click karein.',
        'Theme name, emoji, tagline, category aur tier (Basic / Plus / Premium / Elite) bharein.',
        'INR aur USD price daalein — ek tier ke paid cards ka price same rakhein.',
        'Artwork upload karein (ya hosted image URL paste karein) aur accent, gradient, animation chunein.',
        'Search tags daalein taaki catalogue search me mile, phir save karein — theme turant live ho jaata hai.',
      ],
    },
    note: {
      en: 'I cannot create a theme from chat: the secure server has no theme-create action, so I will not pretend to. I can change an existing theme’s price, or publish/unpublish it. If you meant a customer’s generated card instead, those appear automatically under Greeting Cards.',
      hi: 'Main chat se theme create nahi kar sakti: secure server me theme-create action nahi hai, isliye nakli success nahi bataungi. Existing theme ka price badal sakti hoon, ya publish/unpublish kar sakti hoon. Agar aap customer ka generated card keh rahe hain, woh Greeting Cards tab me khud aa jaate hain.',
    },
    links: [
      { href: ADMIN_TAB_HREF.greetings, label: { en: 'Open Manage Greetings', hi: 'Manage Greetings kholiye' } },
      { href: ADMIN_TAB_HREF.cards, label: { en: 'Open Greeting Cards', hi: 'Greeting Cards kholiye' } },
      { href: ADMIN_TAB_HREF.pricing, label: { en: 'Open Pricing Control', hi: 'Pricing Control kholiye' } },
    ],
  },
  'product-add': {
    title: { en: 'Adding a new store product', hi: 'Naya store product add karna' },
    steps: {
      en: [
        'Open Admin Dashboard → Upload Products.',
        'Click “Add product”.',
        'Enter the product name, store category and description.',
        'Set the INR and USD prices.',
        'Upload the thumbnail image, then save — it appears in the storefront right away.',
      ],
      hi: [
        'Admin Dashboard → Upload Products kholiye.',
        '“Add product” par click karein.',
        'Product name, store category aur description bharein.',
        'INR aur USD price set karein.',
        'Thumbnail image upload karke save karein — product turant storefront me dikhega.',
      ],
    },
    note: {
      en: 'You can also ask me to add a product by name — say: add product Winter Poster. I create it through the server (price 0 unless you give one) and confirm the saved row. The dashboard form is still the place for image, category and description.',
      hi: 'Aap mujhse naam se product add bhi karwa sakte hain — jaise: add product Winter Poster. Main server se create karti hoon (price 0 jab tak aap na dein) aur saved row verify karti hoon. Image, category aur description ke liye dashboard form hi use karein.',
    },
    links: [
      { href: ADMIN_TAB_HREF.products, label: { en: 'Open Upload Products', hi: 'Upload Products kholiye' } },
    ],
  },
  'reportcard-use': {
    title: { en: 'Using ReportCard Studio', hi: 'ReportCard Studio use karna' },
    steps: {
      en: [
        'Open the ReportCard Studio section and sign in — a signed-in account gets 7 free generations before a plan is needed.',
        'Upload the class Excel file (.xlsx). The parser detects student fields, subject groups, co-scholastic columns and infers class/section/school.',
        'Check the detected mapping — column mapping is where most bad output starts.',
        'Optionally add student photos; they are matched by roll/admission/name, never by upload order.',
        'Validate, then generate the PDF card (academic or holistic layout) or a whole-class ZIP.',
        'Plans are 6-month: Simple Academic ₹369 / $4.99, Modern School ₹578 / $6.99, Holistic Progress ₹859 / $10.99. Admin accounts never pay.',
      ],
      hi: [
        'ReportCard Studio section kholiye aur sign in karein — signed-in account ko plan se pehle 7 free generations milte hain.',
        'Class ki Excel file (.xlsx) upload karein. Parser student fields, subject groups, co-scholastic columns detect karta hai aur class/section/school infer karta hai.',
        'Detected mapping check karein — zyadatar galat output mapping ki wajah se hota hai.',
        'Chahein to student photos add karein; woh roll/admission/naam se match hoti hain, upload order se nahi.',
        'Validate karke PDF card (academic ya holistic layout) ya poori class ka ZIP generate karein.',
        'Plans 6-month hain: Simple Academic ₹369 / $4.99, Modern School ₹578 / $6.99, Holistic Progress ₹859 / $10.99. Admin accounts kabhi pay nahi karte.',
      ],
    },
    note: {
      en: 'I can change ReportCard Studio plan prices (INR/USD) and the billing duration here, and read its subscription rows in the Subscriptions tab. Students, templates and generated reports are managed inside the studio; the free-generation allowance is read-only.',
      hi: 'Main yahan se ReportCard Studio plan ka price (INR/USD) aur billing duration badal sakti hoon, aur Subscriptions tab me uski rows padh sakti hoon. Students/templates/generated reports studio ke andar manage hote hain; free-generation allowance read-only hai.',
    },
    links: [
      { href: REPORTCARD_ROUTE, label: { en: 'Open ReportCard Studio', hi: 'ReportCard Studio kholiye' } },
      { href: ADMIN_TAB_HREF.subscriptions, label: { en: 'Open Subscriptions', hi: 'Subscriptions kholiye' } },
    ],
  },
  'game-maintenance': {
    title: { en: 'Putting the Game Zone into maintenance', hi: 'Game Zone ko maintenance par lagana' },
    steps: {
      en: [
        'Open Admin Dashboard → Game Zone.',
        'Tick “Maintenance mode (online modes show as unavailable)”.',
        'Keep “Pair-3Balls enabled” on if visitors should still see the lobby; untick it to hide the game entirely.',
        'Click “Save settings”.',
        'Or ask me directly: “put the game in maintenance mode” — I show the change, you confirm, and I verify the saved row.',
      ],
      hi: [
        'Admin Dashboard → Game Zone kholiye.',
        '“Maintenance mode (online modes show as unavailable)” tick karein.',
        'Agar visitors ko lobby dikhni chahiye to “Pair-3Balls enabled” on rakhein; poora game hide karne ke liye untick karein.',
        '“Save settings” par click karein.',
        'Ya mujhse seedha bolein: “Game Zone maintenance on karo” — main change dikhati hoon, aap confirm karte hain, aur saved row verify hoti hai.',
      ],
    },
    note: {
      en: 'Maintenance mode does not turn the game off — online modes just show as unavailable. “enabled” is the separate on/off switch. I can apply either one for you after confirmation.',
      hi: 'Maintenance mode game ko band nahi karta — sirf online modes unavailable dikhte hain. On/off ke liye “enabled” alag switch hai. Main dono confirmation ke baad apply kar sakti hoon.',
    },
    links: [
      { href: ADMIN_TAB_HREF.game, label: { en: 'Open Game Zone', hi: 'Game Zone kholiye' } },
    ],
  },
  'sales-report': {
    title: { en: 'Seeing your sales and orders', hi: 'Sales aur orders dekhna' },
    steps: {
      en: [
        'Ask me “show my sales report” or “today’s order summary” — I read it from the server, not from the browser.',
        'For every settled payment on the ledger, open Admin Dashboard → Transactions.',
        'For the quick snapshot (catalogue counts and revenue), open Overview.',
        'For ReportCard Studio subscription sales, open Subscriptions — that data comes from the admin-subscriptions function.',
      ],
      hi: [
        'Mujhse “meri sales report dikhao” ya “today’s order summary” poochhiye — main ise server se padhti hoon, browser se nahi.',
        'Har settled payment ke ledger ke liye Admin Dashboard → Transactions kholiye.',
        'Quick snapshot (catalogue counts aur revenue) ke liye Overview kholiye.',
        'ReportCard Studio subscription sales ke liye Subscriptions kholiye — woh data admin-subscriptions function se aata hai.',
      ],
    },
    note: {
      en: 'I can only show data the signed-in admin is allowed to read. If a report is empty, it means the server returned no settled rows — not that I guessed zero.',
      hi: 'Main sirf woh data dikha sakti hoon jise signed-in admin padh sakta hai. Agar report khaali hai to server ne koi settled row nahi di — maine zero nahi maana.',
    },
    links: [
      { href: ADMIN_TAB_HREF.transactions, label: { en: 'Open Transactions', hi: 'Transactions kholiye' } },
      { href: ADMIN_TAB_HREF.overview, label: { en: 'Open Overview', hi: 'Overview kholiye' } },
    ],
  },
  'pricing-troubleshoot': {
    title: { en: 'Fixing a pricing issue', hi: 'Pricing issue fix karna' },
    steps: {
      en: [
        'Ask me “current prices” first — I read all four tier prices from the live catalogue.',
        'If one tier shows “mixed” prices, its paid themes disagree. Align them in Pricing Control or Manage Greetings before changing the tier.',
        'Change a whole tier with “Basic ka price 59 kar do”, or one record by its exact name; I show current → proposed and write only after you confirm.',
        'If the server rejects the write, nothing changed — the real error is shown. Fix the permission or the value and retry.',
        'Verify with “show greeting themes” (or the catalogue tab) after a change; I read the saved rows back before reporting success.',
      ],
      hi: [
        'Pehle mujhse “current prices” poochhiye — main live catalogue se chaaron tier prices padhti hoon.',
        'Agar kisi tier par “mixed” prices dikhein to uske paid themes ka price alag hai. Tier badalne se pehle Pricing Control ya Manage Greetings me unhe same karein.',
        'Poora tier “Basic ka price 59 kar do” se badlein, ya ek record exact naam se; main current → proposed dikhati hoon aur confirm ke baad hi likhti hoon.',
        'Agar server write reject kare to kuch nahi badla — asli error dikhta hai. Permission ya value theek karke dobara try karein.',
        'Change ke baad “show greeting themes” (ya catalogue tab) se verify karein; success batane se pehle main saved rows wapas padhti hoon.',
      ],
    },
    note: {
      en: 'The free Welcome Card is always excluded from tier pricing, and bulk rules never touch a free item. That is expected behaviour, not a bug.',
      hi: 'Free Welcome Card hamesha tier pricing se bahar rehta hai, aur bulk rules free item ko kabhi nahi chhoote. Ye expected behaviour hai, bug nahi.',
    },
    links: [
      { href: ADMIN_TAB_HREF.pricing, label: { en: 'Open Pricing Control', hi: 'Pricing Control kholiye' } },
      { href: ADMIN_TAB_HREF.greetings, label: { en: 'Open Manage Greetings', hi: 'Manage Greetings kholiye' } },
    ],
  },
};

/**
 * Builds the guided answer: real steps in the admin's language, the live tier
 * prices when they are the subject, and clickable links to the page that does the
 * work. Never mutates anything.
 */
const guidePlan = (parsed: ParsedAdminCommand, snapshot: AdminSnapshot): AdminCommandPlan => {
  const language = parsed.language;
  const id = parsed.guide ?? 'pricing-troubleshoot';
  const guide = ADMIN_GUIDES[id];
  const steps = guide.steps[language];

  const livePrices =
    id === 'pricing-troubleshoot'
      ? language === 'hi'
        ? `Abhi ke tier prices (INR): ${allTierPriceLine(snapshot, 'INR')}.`
        : `Current tier prices (INR): ${allTierPriceLine(snapshot, 'INR')}.`
      : '';

  const body = [
    guide.title[language],
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    ...(livePrices ? [livePrices] : []),
    guide.note[language],
  ].join('\n');

  const links: AdminPlanLink[] = guide.links.map((link) => ({
    href: link.href,
    label: link.label[language],
  }));

  const linkLines = links.map((link) => `→ ${link.label}: ${link.href}`).join('\n');

  return {
    status: 'ready',
    action: 'guide.info',
    risk: RISK['guide.info'],
    summary: `${body}\n\n${linkLines}`,
    links,
    reason:
      language === 'hi'
        ? 'Read-only guidance — kuch bhi change nahi hua.'
        : 'Read-only guidance — nothing was changed.',
    language,
  };
};

/** How long a pending question stays answerable (15 minutes). */
export const ADMIN_CONTEXT_TTL_MS = 15 * 60 * 1000;

export const parseAdminCommand = (
  raw: string,
  incomingContext: AdminConversationContext = {},
): ParsedAdminCommand => {
  /*
   * An expired question is not answered: a "59" sent long after Joy asked for a
   * price must not complete an abandoned change. Only the language preference
   * survives expiry.
   */
  const context: AdminConversationContext =
    incomingContext.expiresAt === undefined || incomingContext.expiresAt > Date.now()
      ? incomingContext
      : { language: incomingContext.language };
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

  /*
   * Contradictory mutations in one message ("Delete and publish Rose Note") are
   * refused before any branch can pick one of them. The delete verbs are listed
   * separately from the publication verbs because "hata do" is both an unpublish
   * and a delete in Hinglish — it must never look like a contradiction on its own.
   */
  const deleteVerb = /\b(delete|remove|erase|mita do|mitao|mita)\b/i.test(lower);
  const publicationVerb = /\b(publish|unpublish|go live|make live|hide|unlist)\b/i.test(lower);
  if (deleteVerb && publicationVerb) {
    return { ...base, action: null, compoundConflict: true, language };
  }

  /*
   * A short reply stays in the language of the question it answers — unless the
   * reply is itself Hinglish ("Agle page dikhao"), in which case answering in
   * Hinglish is what the admin actually asked for.
   */
  const replyLanguage: JoyLanguage = hasHinglish(lower)
    ? 'hi'
    : ENGLISH_SIGNAL.test(lower)
      ? 'en'
      : context.language ?? language;

  /*
   * Short reply to the previous question. Both cases read the *pending* question
   * first — a bare number is only ever a price when Joy actually asked for one.
   *
   * Intent precedence: only a genuine one-line answer may complete the open
   * question. A message that asks for a listing, or that is long enough to be a
   * request of its own, is parsed on its own terms instead of being swallowed.
   */
  const detectedTiers = detectGreetingTiers(text);
  /*
   * "Show the second theme details." is about ONE record even though "show" is a
   * listing verb. With a numbered list on screen, a pointer plus a details word
   * is an answer to that list — without this the pointer was discarded and the
   * entire catalogue was printed again.
   */
  const selectionDetailsReply =
    context.awaiting === 'theme' &&
    (context.options?.length ?? 0) > 0 &&
    text.trim().split(/\s+/).filter(Boolean).length <= SHORT_REPLY_MAX_WORDS &&
    /\b(details?|metadata|info|information|tags?|categor(?:y|ies))\b/i.test(lower) &&
    resolveOptionReply(text, context.options as AdminSelectionOption[]) !== undefined;
  const reply = selectionDetailsReply || isShortReplyTo(text, lower, detectedTiers);

  /*
   * "Show the next page" / "agle page dikhao" repeats the listing the previous
   * turn printed with the next offset. The stored query is re-filtered against
   * the live snapshot at plan time, so a page is never stale or guessed.
   */
  const pageDirection = pageRequest(text);
  if (reply && pageDirection && context.lastQuery) {
    const current = Math.max(1, context.page ?? 1);
    return {
      ...base,
      action: 'catalogue.list',
      targetKind: null,
      catalogue: { ...context.lastQuery, page: Math.max(1, current + pageDirection) },
      language: replyLanguage,
    };
  }

  /* "Which tier?" → "Basic" / "the first one" / "that one". */
  if (reply && context.awaiting === 'tier') {
    const chosen = resolveTierReply(text, detectedTiers, context);
    if (chosen) {
      const amount = context.pendingAmount ?? {};
      return {
        ...base,
        action: 'pricing.tier.update',
        targetKind: 'theme',
        field: 'price',
        pricingTiers: [chosen],
        ...amount,
        language: replyLanguage,
      };
    }
  }

  /*
   * Joy asked which ReportCard Studio plan a price belongs to. Only a plan name
   * (or "all plans") answers it; the amount stays pending until then, so a price
   * is never applied to a guessed plan.
   */
  if (reply && context.awaiting === 'plan') {
    const namedPlans = detectStudioPlans(text);
    const pendingPrice = context.pendingAmount ?? {};
    const pendingPlanPrice =
      pendingPrice.priceInr !== undefined || pendingPrice.priceUsd !== undefined
        ? { planPrice: pendingPrice }
        : {};
    if (namedPlans.length === 1) {
      return {
        ...base,
        action: 'pricing.plan.update',
        targetKind: null,
        planTargets: namedPlans,
        ...pendingPlanPrice,
        language: replyLanguage,
      };
    }
    if (namedPlans.length === 0 && /\b(all|every|sab|saari|sabhi)\b/i.test(lower)) {
      return {
        ...base,
        action: 'pricing.plan.update',
        targetKind: null,
        allPlans: true,
        ...pendingPlanPrice,
        language: replyLanguage,
      };
    }
  }

  /*
   * Joy listed themes/products and asked the admin to choose one ("then let me
   * choose one"). A number, an ordinal ("the first one") or the exact/partial
   * name picks from that list. The amount the admin already gave is kept, so
   * "1" completes the change rather than discarding the ₹19.
   */
  if (reply && context.awaiting === 'theme' && (context.options?.length ?? 0) > 0) {
    const chosen = resolveOptionReply(text, context.options as AdminSelectionOption[]);
    if (chosen) {
      /*
       * An amount typed in the same message ("theme 2 ka price 19 kar do")
       * belongs to the chosen record; it is not discarded in favour of asking
       * for the price again.
       */
      const inlinePrice = parsePrice(text);
      const inlineAmount =
        inlinePrice.priceUsd !== undefined && inlinePrice.priceInr === undefined
          ? { priceUsd: inlinePrice.priceUsd }
          : inlinePrice.priceInr !== undefined
            ? { priceInr: inlinePrice.priceInr }
            : {};
      const amount = { ...(context.pendingAmount ?? {}), ...inlineAmount };
      /*
       * "Second one ke tags batao" asks what the selected record holds, not what
       * it should cost. It is answered from the live snapshot as a metadata read
       * (id, category, tier, tags, status and price) — never as a price change.
       * "dusre wale ka price kya hai" is the same read: a question about the
       * current price carries no amount and no set verb.
       */
      const asksWhatItCosts =
        /\b(price|rate|cost|kimat|bhav|daam)\b/i.test(lower) &&
        /\b(kya|kitne|kitna|what|how much|batao|bata|tell|show|dikhao|hain|hai)\b/i.test(lower) &&
        !hasWord(lower, PRICE_UPDATE_WORDS) &&
        inlinePrice.priceInr === undefined &&
        inlinePrice.priceUsd === undefined;
      const asksForDetails =
        /\b(tags?|metadata|details?|info|information|categor(?:y|ies)|tier)\b/i.test(lower) &&
        /* "do" / "de" / "dijiye" are how Hinglish asks for the details. */
        /\b(kya|kitne|kitna|what|which|konsa|kaun|batao|bata|tell|show|dikhao|hain|hai|do|de|dein|dena|dijiye)\b/i.test(
          lower,
        ) &&
        !hasWord(lower, PRICE_UPDATE_WORDS) &&
        !/\b(price|rate|cost|kimat|bhav|daam)\b/i.test(lower);
      if (asksWhatItCosts || asksForDetails) {
        return {
          ...base,
          action: 'catalogue.meta',
          targetKind: null,
          catalogue: {
            scope: chosen.kind === 'product' ? 'products' : 'themes',
            term: chosen.name,
            meta: true,
          },
          language: replyLanguage,
        };
      }
      /*
       * A pending publish/unpublish/delete keeps its operation: the numbered
       * reply finishes THAT action on the chosen record instead of turning the
       * selection into a price change.
       */
      if (
        context.pendingAction &&
        context.pendingAction !== 'theme.update' &&
        context.pendingAction !== 'product.update'
      ) {
        return {
          ...base,
          action: context.pendingAction,
          targetKind: chosen.kind,
          targetId: chosen.id,
          targetName: chosen.name,
          language: replyLanguage,
        };
      }
      /*
       * A plain selection ("2", "second wala") with no amount and no pending
       * operation resolves the record and asks only for the price it still
       * needs. The record is carried into the next turn, so "price 47 kar do" /
       * "deactivate it" are unambiguous — and a metadata question about the
       * selected record ("iske tags kya hain?") was already answered above.
       */
      if (amount.priceInr === undefined && amount.priceUsd === undefined) {
        return {
          ...base,
          action: null,
          targetKind: chosen.kind,
          targetId: chosen.id,
          targetName: chosen.name,
          priceTargetName: chosen.name,
          field: 'price',
          unknownReason: 'The selected catalogue entry could not be matched to a record.',
          language: replyLanguage,
        };
      }
      /*
       * Otherwise the chosen entry is routed by exact name so the planner
       * resolves the live record, shows its current price and the proposed
       * price, and asks for confirmation — never a "which tier?" question.
       */
      return {
        ...base,
        action: null,
        targetKind: chosen.kind,
        priceTargetName: chosen.name,
        unknownReason: 'The selected catalogue entry could not be matched to a record.',
        ...amount,
        language: replyLanguage,
      };
    }
  }

  /*
   * "Which theme or product?" → the admin names one ("Birthday."), or answers
   * with a tier ("Basic") for a whole-tier price. A name is only a search term;
   * the planner resolves it against the real records and asks again if several
   * matches remain. Nothing is guessed.
   */
  if (reply && context.awaiting === 'target' && context.pendingAmount) {
    const amount = context.pendingAmount;
    const namedTier = detectedTiers[0];
    if (namedTier && text.trim().split(/\s+/).filter(Boolean).length <= 3) {
      return {
        ...base,
        action: 'pricing.tier.update',
        targetKind: 'theme',
        field: 'price',
        pricingTiers: [namedTier],
        ...amount,
        language: replyLanguage,
      };
    }
    const candidate = stripInstructionWords(text.replace(/[.!?]+\s*$/, ''));
    if (candidate && isPlausibleEntityName(candidate) && !/^\s*[₹$]?\s*\d/.test(text) && !hasWord(lower, PRICE_UPDATE_WORDS)) {
      return {
        ...base,
        action: null,
        priceTargetName: candidate,
        unknownReason: 'The named record could not be matched.',
        ...amount,
        language: replyLanguage,
      };
    }
  }

  /*
   * A price reply pointed at a list ("Set it to ₹59" right after "Show my
   * greeting cards"). With one option the record is clear; with several, Joy
   * keeps the amount and asks which numbered record — never guessing.
   */
  if (reply && context.awaiting === 'theme' && (context.options?.length ?? 0) > 0 && detectedTiers.length === 0) {
    const price = parsePrice(text);
    const amount = price.priceInr ?? price.priceUsd ?? parseSingleBareNumber(text);
    if (amount !== undefined && PRICE_REPLY_PRONOUN.test(text)) {
      const isUsd = price.priceUsd !== undefined && price.priceInr === undefined;
      const options = context.options as AdminSelectionOption[];
      if (options.length === 1) {
        return {
          ...base,
          action: null,
          targetKind: options[0].kind,
          priceTargetName: options[0].name,
          ...(isUsd ? { priceUsd: amount } : { priceInr: amount }),
          language: replyLanguage,
        };
      }
      return {
        ...base,
        action: null,
        selectionOptions: options,
        selectionPrice: isUsd ? { priceUsd: amount } : { priceInr: amount },
        language: replyLanguage,
      };
    }
  }

  /*
   * "What price?" → "59", "₹59", "59 rupees", "make it 59". A pure amount is
   * always accepted; otherwise the number must be tied to a pronoun ("it"/"isko")
   * so an unrelated number in a fresh command can never become a price.
   */
  /* A sentence-final period ("Set it to 59.") is punctuation, not a decimal. */
  const bareText = text.replace(/[.!?]+\s*$/, '');
  const bareInr = bareText.match(/^\s*(?:₹|rs\.?|inr)?\s*(\d{1,7}(?:\.\d{1,2})?)\s*(?:rupees?|rs\.?|inr)?\s*$/i);
  const bareUsd = bareText.match(/^\s*\$\s*(\d{1,7}(?:\.\d{1,2})?)\s*(?:usd)?\s*$/i);

  /*
   * A named theme/product waiting for its new price. A bare "59" and a short
   * phrase such as "price 47 kar do" both answer the same question; the amount
   * is only applied while the message names no different record.
   */
  const pendingPrice = parsePrice(text);
  const pendingAmountValue = pendingPrice.priceInr ?? pendingPrice.priceUsd ?? parseSingleBareNumber(text);
  const pendingNamedTarget = extractNameBeforePrice(text) ?? extractNameAfterPrice(text);
  const shortPriceAnswer = reply && text.trim().split(/\s+/).filter(Boolean).length <= 5;
  if (
    context.awaiting === 'price' &&
    context.pendingTheme &&
    pendingAmountValue !== undefined &&
    (bareInr || bareUsd || shortPriceAnswer) &&
    !isPlausibleEntityName(pendingNamedTarget) &&
    extractQuotedName(text) === undefined
  ) {
    const target = context.pendingTheme;
    const isUsd = pendingPrice.priceUsd !== undefined && pendingPrice.priceInr === undefined;
    return {
      ...base,
      action: target.kind === 'product' ? 'product.update' : 'theme.update',
      targetKind: target.kind,
      targetId: target.id,
      targetName: target.name,
      field: 'price',
      ...(isUsd ? { priceUsd: pendingAmountValue } : { priceInr: pendingAmountValue }),
      language: replyLanguage,
    };
  }

  if (context.pendingTier && (bareInr || bareUsd)) {
    return {
      ...base,
      action: 'pricing.tier.update',
      targetKind: 'theme',
      field: 'price',
      pricingTiers: [context.pendingTier],
      ...(bareUsd ? { priceUsd: Number(bareUsd[1]) } : { priceInr: Number((bareInr as RegExpMatchArray)[1]) }),
      language: replyLanguage,
    };
  }
  /*
   * "Set it to 59" / "make it 59" answers the price question for the record Joy
   * already resolved — or, when only a record is under discussion ("second one
   * ke tags", "iska price"), that record. The pronoun ties the number to it, so
   * an unrelated number in a fresh command can never become a price, and the
   * change still needs an explicit confirmation. A longer message is a request
   * of its own and is left to normal parsing.
   */
  const pronounTarget = context.pendingTheme ?? context.lastTheme;
  if (
    reply &&
    pronounTarget &&
    detectedTiers.length === 0 &&
    PRICE_REPLY_PRONOUN.test(text)
  ) {
    const price = parsePrice(text);
    const amount = price.priceInr ?? price.priceUsd ?? parseSingleBareNumber(text);
    if (amount !== undefined) {
      const target = pronounTarget;
      const isUsd = price.priceUsd !== undefined && price.priceInr === undefined;
      return {
        ...base,
        action: target.kind === 'product' ? 'product.update' : 'theme.update',
        targetKind: target.kind,
        targetId: target.id,
        targetName: target.name,
        field: 'price',
        ...(isUsd ? { priceUsd: amount } : { priceInr: amount }),
        language: replyLanguage,
      };
    }
  }
  if (
    context.pendingTier &&
    detectGreetingTiers(text).length === 0 &&
    PRICE_REPLY_PRONOUN.test(text)
  ) {
    const price = parsePrice(text);
    const amount = price.priceInr ?? price.priceUsd ?? parseSingleBareNumber(text);
    if (amount !== undefined) {
      const isUsd = price.priceUsd !== undefined && price.priceInr === undefined;
      return {
        ...base,
        action: 'pricing.tier.update',
        targetKind: 'theme',
        field: 'price',
        pricingTiers: [context.pendingTier],
        ...(isUsd ? { priceUsd: amount } : { priceInr: amount }),
        language: replyLanguage,
      };
    }
  }

  /*
   * "Price 47 kar do" after a record was selected: the record under discussion is
   * the target, even without a pronoun. An explicitly named record is never
   * overridden — that request goes down the normal named-price path.
   */
  if (
    reply &&
    context.lastTheme &&
    detectedTiers.length === 0 &&
    hasWord(lower, PRICE_UPDATE_WORDS) &&
    pendingAmountValue !== undefined &&
    extractQuotedName(text) === undefined
  ) {
    const explicitTarget = extractNameBeforePrice(text) ?? extractNameAfterPrice(text);
    if (!isPlausibleEntityName(explicitTarget)) {
      const target = context.lastTheme;
      const isUsd = pendingPrice.priceUsd !== undefined && pendingPrice.priceInr === undefined;
      return {
        ...base,
        action: target.kind === 'product' ? 'product.update' : 'theme.update',
        targetKind: target.kind,
        targetId: target.id,
        targetName: target.name,
        field: 'price',
        ...(isUsd ? { priceUsd: pendingAmountValue } : { priceInr: pendingAmountValue }),
        language: replyLanguage,
      };
    }
  }

  /* "same tier", "usko", "dobara" — reuse the last tier the admin discussed. */
  const refersBack = /\b(same tier|same card tier|wahi tier|usi tier|usko|use tier|it again|change it again|dobara)\b/i.test(text);
  if (context.lastTier && refersBack && word(lower, PRICE_WORDS)) {
    const price = parsePrice(text);
    const amount = price.priceInr ?? price.priceUsd;
    return {
      ...base,
      action: amount !== undefined ? 'pricing.tier.update' : 'pricing.tiers.read',
      targetKind: 'theme',
      field: 'price',
      pricingTiers: [context.lastTier],
      ...price,
      language: replyLanguage,
    };
  }

  /*
   * "Which pricing settings can I change through Joy?" — answered from the real
   * action registry, including what is read-only and why.
   */
  if (PRICING_CAPABILITIES_RE.test(lower)) {
    return { ...base, action: 'knowledge.info', targetKind: null, knowledge: 'pricing', language: replyLanguage };
  }

  /*
   * ReportCard Studio plan prices and billing duration. Checked before the
   * generic knowledge/guidance branches so a price command is never answered as
   * documentation.
   */
  const studioPlanPricing = parseStudioPlanPricing(text, lower);
  if (studioPlanPricing) {
    return { ...base, ...studioPlanPricing, language: replyLanguage };
  }

  /*
   * "Show all current prices" / "saari services ke current charges dikhao" /
   * "compare current prices of all services": one inventory across tiers,
   * products and plans. A message that names a catalogue ("show all greeting
   * cards and their prices") stays a catalogue listing, and a message carrying an
   * amount stays a bulk change — both are handled by their own branches.
   */
  const priceAmount = parsePrice(text);
  const catalogueNoun = hasWord(lower, [...THEME_NOUNS, ...PRODUCT_NOUNS]);
  const servicesWording = /\b(services?|everything|all prices|current prices|price list|pricing list|prices list|charges list)\b/i.test(
    lower,
  );
  if (
    hasWord(lower, PLAN_PRICE_WORDS) &&
    servicesWording &&
    !catalogueNoun &&
    /\b(all|every|sab|saari|sare|sabhi|compare|comparison|services|everything|poora|pura)\b/i.test(lower) &&
    priceAmount.priceInr === undefined &&
    priceAmount.priceUsd === undefined &&
    parseSingleBareNumber(text) === undefined
  ) {
    return { ...base, action: 'pricing.summary.read', targetKind: null, language: replyLanguage };
  }

  /*
   * Guided how-to workflows ("Mujhe greeting card upload karna hai", "Game Zone
   * maintenance par kaise lagau?", "Help me fix a pricing issue"). Guidance is
   * read-only and runs before the command branches so a goal is never mistaken
   * for a mutation — and before the knowledge branch so usage gets steps and a
   * real link.
   */
  const guide = detectGuideTopic(text, lower);
  if (guide) {
    return { ...base, action: 'guide.info', targetKind: null, guide };
  }

  /* Read-only audit history (reading is allowed; editing it is not). */
  if (word(lower, AUDIT_REPORT_WORDS) && !word(lower, DELETE_WORDS)) {
    return { ...base, action: 'report.audit', targetKind: null };
  }

  /* Game Zone availability. */
  const mentionsGame = word(lower, GAME_WORDS);
  const gameOn = word(lower, GAME_ON_WORDS);
  const gameOff = word(lower, GAME_OFF_WORDS);
  const gameMaintenance = word(lower, MAINTENANCE_WORDS);
  const gameSort = /\bsort(?:\s*order)?\b/i.test(lower) && /\d/.test(lower);
  if (gameMaintenance || (mentionsGame && (gameOn || gameOff || gameSort))) {
    const wantsOff = gameOff && !gameOn;
    if (gameMaintenance) {
      return { ...base, action: 'game.update', targetKind: 'game', gamePatch: { maintenance: !wantsOff } };
    }
    if (gameSort) {
      const sortOrder = parseSingleBareNumber(text);
      return {
        ...base,
        action: 'game.update',
        targetKind: 'game',
        gamePatch: sortOrder === undefined ? {} : { sortOrder },
      };
    }
    return { ...base, action: 'game.update', targetKind: 'game', gamePatch: { enabled: !wantsOff } };
  }

  /* Brand settings (name, tagline, logo). */
  const brandNameKeyword = BRAND_NAME_WORDS.find((entry) => word(lower, [entry]));
  const brandTaglineKeyword = BRAND_TAGLINE_WORDS.find((entry) => word(lower, [entry]));
  const brandLogoKeyword = BRAND_LOGO_WORDS.find((entry) => word(lower, [entry]));
  if (brandNameKeyword || brandTaglineKeyword || brandLogoKeyword) {
    const brandPatch: NonNullable<ParsedAdminCommand['brandPatch']> = {};
    if (brandLogoKeyword) {
      const url = text.match(/https?:\/\/\S+/i)?.[0] ?? text.match(/\/(?!\/)[\w./-]+/)?.[0];
      const logo = extractQuotedName(text) ?? url;
      if (logo && /^(https?:\/\/|\/(?!\/))/i.test(logo)) brandPatch.logoUrl = logo;
    }
    if (brandTaglineKeyword && !brandPatch.logoUrl) {
      const tagline = extractQuotedName(text) ?? extractValueAfter(text, brandTaglineKeyword);
      if (tagline) brandPatch.tagline = tagline;
    }
    if (brandNameKeyword && !brandPatch.logoUrl && !brandPatch.tagline) {
      const siteName = extractQuotedName(text) ?? extractValueAfter(text, brandNameKeyword);
      if (siteName) brandPatch.siteName = siteName;
    }
    if (Object.keys(brandPatch).length > 0) {
      return { ...base, action: 'brand.update', targetKind: 'brand', brandPatch };
    }
  }

  /*
   * Catalogue-wide price change ("sabhi themes ka price 10% badha do"). This is
   * checked before the single-theme/product branches so "all" is never mistaken
   * for an item name. It needs an explicit all-catalogue word, so a normal
   * single-item command is unaffected.
   */
  const mentionsAllItems = word(lower, BULK_WORDS);
  const percentMatch = text.match(PERCENT_PATTERN);
  const bulkQuotedName = extractQuotedName(text);
  const bulkTiers = detectGreetingTiers(text);
  const bulkPrice = parsePrice(text);
  if (
    mentionsAllItems &&
    !bulkQuotedName &&
    bulkTiers.length === 0 &&
    (percentMatch !== null || word(lower, PRICE_WORDS))
  ) {
    const bulkScope: BulkScope | null = word(lower, ['product', 'products', 'item', 'items', 'store'])
      ? 'products'
      : word(lower, ['theme', 'themes', 'card', 'cards', 'greeting', 'greetings'])
        ? 'themes'
        : null;

    if (bulkScope) {
      const currency: PricingCurrency = bulkPrice.priceUsd !== undefined ? 'USD' : 'INR';
      if (percentMatch) {
        const value = Number(percentMatch[1]);
        const decreases = word(lower, DECREASE_WORDS);
        const increases = word(lower, INCREASE_WORDS);
        if (Number.isFinite(value) && value > 0 && value <= 100 && (decreases || increases)) {
          return {
            ...base,
            action: 'pricing.bulk.update',
            targetKind: bulkScope === 'products' ? 'product' : 'theme',
            bulk: {
              scope: bulkScope,
              mode: decreases && !increases ? 'decrease_percent' : 'increase_percent',
              value,
              currency,
            },
          };
        }
      }

      const amount = bulkPrice.priceInr ?? bulkPrice.priceUsd ?? parseSingleBareNumber(text);
      if (amount !== undefined && amount > 0) {
        return {
          ...base,
          action: 'pricing.bulk.update',
          targetKind: bulkScope === 'products' ? 'product' : 'theme',
          bulk: { scope: bulkScope, mode: 'set', value: amount, currency },
        };
      }
    }
  }

  const mentionsTrack = word(lower, ['track', 'music', 'song', 'audio']);
  const mentionsTheme = word(lower, ['theme', 'greeting theme', 'card theme', 'design']);
  const mentionsProduct = word(lower, ['product', 'item', 'catalogue', 'catalog', 'store']);

  /*
   * Platform knowledge ("How does ReportCard Studio work?"), answered from the
   * real implementation notes below — never from a guess.
   */
  if (isReportCardQuery(lower)) {
    return { ...base, action: 'knowledge.info', targetKind: null, knowledge: 'reportcard' };
  }
  if (isOperationsQuery(lower)) {
    return { ...base, action: 'knowledge.info', targetKind: null, knowledge: 'operations' };
  }

  const pricingTiers = detectGreetingTiers(text);
  const parsedPrice = parsePrice(text);
  const quotedName = extractQuotedName(text);

  /*
   * Read-only catalogue discovery ("show me the Basic themes", "list all
   * products", "show names and prices", "… then let me choose one"). This is
   * checked before the tier-pricing branch so an instruction such as "I select"
   * or "show me" is never read as a theme name and no mutation is ever planned.
   * It is also checked before the bulk branch would be re-entered, but after it
   * so an explicit "all … 10%" rule still wins.
   */
  if (wantsCatalogueList(text, lower, pricingTiers)) {
    const gluedScope = gluedCatalogueScope(lower);
    const scope: 'themes' | 'products' = hasWord(lower, PRODUCT_NOUNS)
      ? 'products'
      : hasWord(lower, THEME_NOUNS)
        ? 'themes'
        : gluedScope ?? 'themes';
    const explicitScope = hasWord(lower, [...PRODUCT_NOUNS, ...THEME_NOUNS]) || gluedScope !== undefined;
    const meta = /\btags?\b/i.test(lower) && /\b(kya|kitne|kitna|what|which|konsa|kaun)\b/i.test(lower);
    const missingTags =
      /\b(missing|without|no|bina|khaali|khali|nahi|nahin)\b[^.]{0,24}\btags?\b/i.test(lower) ||
      /\btags?\b[^.]{0,24}\b(missing|none|nahi|nahin|nahi hain)\b/i.test(lower);
    /*
     * "Show unpublished products", "jo public nahi hain wo dikhao" and "jo cards
     * publish nahi hue" all mean the same filter. Which catalogue can actually
     * expose the flag is reported honestly downstream. A rushed "unpubliched"
     * is the same request, matched fuzzily because the word is unambiguous.
     */
    const unpublishedOnly =
      UNPUBLISHED_INTENT.test(lower) || hasWord(lower, ['unpublished', 'hidden', 'draft']);
    const activeOnly = !unpublishedOnly && !INACTIVE_INTENT.test(lower) && ACTIVE_INTENT.test(lower);
    const inactiveOnly = !unpublishedOnly && INACTIVE_INTENT.test(lower);
    const tag = extractTagFilter(text);
    const category = extractCategoryFilter(text);
    const id = extractIdFilter(text);
    /*
     * Price ordering: "cheapest", "lowest prices", "sabse sasta". A singular
     * question ("which card is cheapest?") is capped to the single lowest row.
     */
    const sort = CHEAPEST_RE.test(lower) ? ('price_asc' as const) : COSTLIEST_RE.test(lower) ? ('price_desc' as const) : undefined;
    const singularQuestion =
      /\b(which|what|konsi|kaunsi|konsa|kaunsa|kaun)\b/i.test(lower) && !PLURAL_CATALOGUE.test(lower);
    /*
     * A tag question ("what tags does this card have?") is about the entry the
     * admin last named, so the remembered name becomes the search term. Status
     * filters are not names, so they never become a search term.
     */
    const term =
      unpublishedOnly || inactiveOnly || sort
        ? undefined
        : extractSearchTerm(text) ?? (meta ? context.lastTheme?.name : undefined);
    /*
     * "Find Rose Note, show its current price" is a metadata read of that record,
     * not a generic listing — the metadata row carries the real price/tags.
     */
    const priceQuestion =
      term !== undefined &&
      /\b(current price|its price|uska price|iska price|price kya|price batao|price dikhao|price of)\b/i.test(lower);
    const isMetaQuery = meta || priceQuestion;
    /*
     * Multi-step request: "Find Rose Note, show its current price, then let me
     * change it." The lookup is read-only, but the admin has already said the
     * next step is a price change, so the record is left awaiting that price.
     */
    const changeNext =
      isMetaQuery &&
      parsedPrice.priceInr === undefined &&
      parsedPrice.priceUsd === undefined &&
      /\b(let me change|change it|change its price|change the price|change karna|badalna|badalna hai|change karunga|change karna hai)\b/i.test(
        lower,
      );
    return {
      ...base,
      action: isMetaQuery ? 'catalogue.meta' : 'catalogue.list',
      targetKind: null,
      catalogue: {
        scope,
        ...(pricingTiers.length > 0 ? { tiers: pricingTiers } : {}),
        ...(category ? { category } : {}),
        ...(tag ? { tag } : {}),
        ...(id ? { id } : {}),
        ...(missingTags ? { missingTags: true } : {}),
        ...(unpublishedOnly ? { unpublishedOnly: true } : {}),
        ...(activeOnly ? { activeOnly: true } : {}),
        ...(inactiveOnly ? { inactiveOnly: true } : {}),
        ...(sort ? { sort } : {}),
        ...(sort && singularQuestion ? { limit: 1 } : {}),
        ...(term ? { term } : {}),
        ...(isMetaQuery ? { meta: true } : {}),
        ...(changeNext ? { changeNext: true } : {}),
        ...(!explicitScope && term && !isMetaQuery ? { searchBoth: true } : {}),
      },
      /* A proposed price in the same message survives while the admin picks. */
      ...(parsedPrice.priceInr !== undefined ? { priceInr: parsedPrice.priceInr } : {}),
      ...(parsedPrice.priceUsd !== undefined ? { priceUsd: parsedPrice.priceUsd } : {}),
    };
  }

  /*
   * A read-only question about the record under discussion — "Iska price kya
   * hai?", "What are its tags?" — refers to the entry Joy last resolved and is
   * answered from the live snapshot. It runs before the named-price-change branch
   * so a pronoun can never be read as a record name, and it requires the absence
   * of any change verb so a real mutation is never downgraded to a read.
   */
  if (
    context.lastTheme &&
    /\b(iska|iske|iski|uska|uske|uski|isko|ise|its|this|that|ye|yeh|it)\b/i.test(lower) &&
    /\b(price|prices|rate|rates|cost|kimat|bhav|daam|tags?|categor(?:y|ies)|tier|detail|details|metadata|info|information)\b/i.test(
      lower,
    ) &&
    !hasWord(lower, PRICE_UPDATE_WORDS) &&
    !/\b(delete|remove|publish|unpublish|hata|hatao|mita|mitao)\b/i.test(lower)
  ) {
    return {
      ...base,
      action: 'catalogue.meta',
      targetKind: null,
      catalogue: {
        scope: context.lastTheme.kind === 'product' ? 'products' : 'themes',
        term: context.lastTheme.name,
        meta: true,
      },
      language: replyLanguage,
    };
  }

  /*
   * A named price change with no collection word ("Change Rose Note price from
   * 40 to 47"). The name is read from before the price word and validated, so
   * an instruction ("I want to modify the price") can never become a target.
   * This runs before the tier-pricing branch so an exactly-named theme is never
   * turned into a "which tier?" question.
   */
  if (!mentionsTheme && !mentionsProduct && !mentionsTrack && pricingTiers.length === 0 && !quotedName) {
    /*
     * The name can be written before ("Rose Note ka price") or after ("price of
     * Rose Note"). The "before" reader can return instruction leftovers ("the",
     * "change"), so the first *plausible* name wins instead of a truthy one.
     */
    const priceTargetName = [extractNameBeforePrice(text), extractNameAfterPrice(text)].find((name) =>
      isPlausibleEntityName(name),
    );
    const hasSetVerb = hasWord(lower, PRICE_UPDATE_WORDS);
    /* "Rose Note ko 47 ka krdo" has no price word — the set verb supplies the intent. */
    const amountValue =
      parsedPrice.priceInr ??
      parsedPrice.priceUsd ??
      (hasSetVerb ? parseSingleBareNumber(text) : undefined);
    const hasPriceSignal = hasWord(lower, PRICE_WORDS) || amountValue !== undefined;
    if (priceTargetName && isPlausibleEntityName(priceTargetName) && hasPriceSignal) {
      /*
       * A question about the record ("Rose Note ka price kya hai?", "price of
       * Rose Note") is a READ. The old branch assumed every named price mention
       * was a change, so a question was answered with "what new price?".
       */
      const asksCurrent =
        !hasSetVerb &&
        amountValue === undefined &&
        (/\?/.test(text) ||
          /\b(kya|kitna|kitne|how much|what is|what's|current|batao|bata do|dikhao|dikha do|show|list|display|see)\b/i.test(lower));
      if (asksCurrent) {
        return {
          ...base,
          action: 'catalogue.meta',
          targetKind: null,
          catalogue: { scope: 'themes', term: priceTargetName, meta: true, searchBoth: true },
          language: replyLanguage,
        };
      }

      const range = text.match(/(\d+(?:\.\d+)?)\s*(?:se|to|into|->|→)\s*[₹$]?\s*(\d+(?:\.\d+)?)/i);
      const currencyUsd = /\$|\busd\b/i.test(text);
      let priceInr = parsedPrice.priceInr ?? (parsedPrice.priceUsd === undefined ? amountValue : undefined);
      let priceUsd = parsedPrice.priceUsd;
      let fromInr: number | undefined;
      let fromUsd: number | undefined;
      if (range) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        if (currencyUsd) {
          fromUsd = from;
          priceUsd = to;
          priceInr = undefined;
        } else {
          fromInr = from;
          priceInr = to;
          priceUsd = undefined;
        }
      }
      const compoundNote = detectSecondaryAction(lower);
      return {
        ...base,
        action: null,
        priceTargetName,
        priceInr,
        priceUsd,
        fromInr,
        fromUsd,
        ...(compoundNote ? { compoundNote } : {}),
        unknownReason: 'The named price change could not be matched to a record.',
        language: replyLanguage,
      };
    }
  }

  /*
   * A price change with an amount but no record — "Change the price to 99".
   * Asking "which tier?" assumed greeting cards; the admin may mean any record,
   * so the planner asks which theme/product while keeping the amount.
   */
  if (
    !quotedName &&
    !mentionsTheme &&
    !mentionsProduct &&
    !mentionsTrack &&
    pricingTiers.length === 0 &&
    (parsedPrice.priceInr !== undefined ||
      parsedPrice.priceUsd !== undefined ||
      (hasWord(lower, PRICE_UPDATE_WORDS) && parseSingleBareNumber(text) !== undefined))
  ) {
    /* "make it 49" with no record named: keep the amount and ask which record. */
    const bareAmount = parseSingleBareNumber(text);
    return {
      ...base,
      action: null,
      needsTarget: true,
      ...(parsedPrice.priceInr !== undefined
        ? { priceInr: parsedPrice.priceInr }
        : parsedPrice.priceUsd !== undefined
          ? { priceUsd: parsedPrice.priceUsd }
          : { priceInr: bareAmount }),
      ...(detectSecondaryAction(lower) ? { compoundNote: detectSecondaryAction(lower) } : {}),
      language: replyLanguage,
    };
  }

  /*
   * Greeting-card tier pricing. The tiers live on the theme catalogue (each
   * theme has a `tier`; its price is the existing `theme_prices` row), so a tier
   * command is routed before the generic theme/product branches as long as it
   * is clearly about pricing and not about a named product/theme/track.
   */
  const priceIntent =
    hasWord(lower, PRICE_WORDS) ||
    parsedPrice.priceInr !== undefined ||
    parsedPrice.priceUsd !== undefined;
  const greetingPricingContext = hasWord(lower, GREETING_PRICING_CONTEXT);
  const tierNearStart = pricingTiers.length > 0 && firstTierIndex(text) <= 1;
  const shouldHandleTierPricing =
    !mentionsProduct &&
    !mentionsTheme &&
    !mentionsTrack &&
    !quotedName &&
    (priceIntent || (pricingTiers.length > 0 && hasWord(lower, PRICE_UPDATE_WORDS))) &&
    /*
     * A single named tier (or none) is enough — "Update the price for Basic."
     * names no "card"/"greeting" word and puts the tier away from the start, yet
     * is clearly a tier command. Multiple named tiers still need the greeting
     * context or a leading tier so an unrelated list is not hijacked.
     */
    (pricingTiers.length <= 1 || greetingPricingContext || tierNearStart);

  if (shouldHandleTierPricing) {
    const query = isPriceQuery(lower);
    let priceInr = parsedPrice.priceInr;
    let priceUsd = parsedPrice.priceUsd;
    if (!query && priceInr === undefined && priceUsd === undefined) {
      /* "Premium ka 99 kar do" — only one number, so it is not a guess. */
      priceInr = parseSingleBareNumber(text);
    }
    const compoundNote = query ? undefined : detectSecondaryAction(lower);
    return {
      ...base,
      action: query ? 'pricing.tiers.read' : 'pricing.tier.update',
      targetKind: 'theme',
      field: 'price',
      pricingTiers,
      pricingQuery: query,
      priceInr,
      priceUsd,
      ...(compoundNote ? { compoundNote } : {}),
    };
  }

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

  /*
   * Publication controls. A greeting theme can be published/unpublished, so
   * "deactivate it" on a selected theme is a real unpublish; a store product has
   * no activation action or exposed flag in this build, which is stated plainly
   * instead of being turned into a fake success.
   */
  if (/\b(deactivate|activate|disable|enable)\b/i.test(lower)) {
    const themeKind = context.lastTheme?.kind === 'theme' || mentionsTheme;
    const turningOff = /\b(deactivate|disable)\b/i.test(lower);
    if (themeKind) {
      return {
        ...base,
        action: turningOff ? 'theme.unpublish' : 'theme.publish',
        targetKind: 'theme',
        targetName: extractQuotedName(text) ?? context.lastTheme?.name ?? extractNameAfter(text, 'theme'),
        ...(context.lastTheme?.kind === 'theme' ? { targetId: context.lastTheme.id } : {}),
        language: replyLanguage,
      };
    }
    return { ...base, action: null, unsupported: 'product.activation', language: replyLanguage };
  }

  if (mentionsTheme) {
    const targetName = extractQuotedName(text) ?? extractNameAfter(text, 'theme');
    if (word(lower, DELETE_WORDS) && (word(lower, PUBLISH_WORDS) || word(lower, UNPUBLISH_WORDS))) {
      return { ...base, action: null, compoundConflict: true, language: replyLanguage };
    }
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

/** Name with every separator removed, so "RoseNote" and "Rose Note" agree. */
const compactName = (value: string): string => normalizeName(value).replace(/\s+/g, '');

type Candidate = { id: string; name: string };

/**
 * True when two names differ by exactly one character in one word (a typo or an
 * adjacent transposition), with the guards that keep this from matching
 * unrelated names: same number of words, each word at least four characters,
 * the same first letter, and no more than one character of length difference.
 */
const namesAreOneTypoApart = (actual: string, typed: string): boolean => {
  const a = normalizeName(actual).split(' ').filter(Boolean);
  const b = normalizeName(typed).split(' ').filter(Boolean);
  if (a.length === 0 || a.length !== b.length) return false;
  let typos = 0;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] === b[index]) continue;
    if (a[index].length < 4 || b[index].length < 4) return false;
    if (a[index][0] !== b[index][0]) return false;
    if (Math.abs(a[index].length - b[index].length) > 1) return false;
    if (editDistance(a[index], b[index]) > 1) return false;
    typos += 1;
  }
  return typos > 0;
};

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

  /* A name typed without its space ("RoseNote") is still the same name. */
  const compact = compactName(parsed.targetName ?? '');
  const compactExact = compact
    ? source.filter((candidate) => compactName(candidate.name) === compact)
    : [];
  if (compactExact.length === 1) return { kind: 'resolved', target: compactExact[0] };
  if (compactExact.length > 1) return { kind: 'ambiguous', candidates: compactExact.slice(0, 5) };

  const partial = source.filter((candidate) => normalizeName(candidate.name).includes(wanted));
  if (partial.length === 1) return { kind: 'resolved', target: partial[0] };
  if (partial.length > 1) return { kind: 'ambiguous', candidates: partial.slice(0, 5) };

  /*
   * One mistyped or transposed word ("Rsoe Note") still identifies its record,
   * but only when exactly one real record is that close. A near match shares the
   * word count, keeps each word's first letter, and differs by a single edit —
   * anything looser is reported as "missing", never guessed.
   */
  const near = source.filter((candidate) =>
    namesAreOneTypoApart(candidate.name, parsed.targetName ?? ''),
  );
  if (near.length === 1) return { kind: 'resolved', target: near[0] };
  if (near.length > 1) return { kind: 'ambiguous', candidates: near.slice(0, 5) };

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

const hasPermission = (
  actor: AdminActor,
  action: AdminAction,
  required: string = REQUIRED_PERMISSION[action],
): boolean => {
  if (!actor.isAdmin) return false;
  if (!actor.permissions) return true;
  /*
   * Reading a price is needed by whoever may change it as well as by reporting
   * staff, so either capability is enough; changes still need themes.write.
   */
  if (action === 'pricing.tiers.read') {
    return actor.permissions.includes('themes.write') || actor.permissions.includes(required);
  }
  return actor.permissions.includes(required);
};

const money = (amount: number, currency: PricingCurrency): string =>
  currency === 'INR' ? `₹${amount}` : `$${amount}`;

/**
 * Explains a second operation that was named in the same message. It is NOT part
 * of this confirmation, so the admin is never led to believe it happened.
 */
const compoundNotice = (
  note: ParsedAdminCommand['compoundNote'],
  language: JoyLanguage,
): string => {
  if (!note) return '';
  const label: Record<NonNullable<ParsedAdminCommand['compoundNote']>, { en: string; hi: string }> = {
    publish: { en: 'publish it', hi: 'publish karna' },
    unpublish: { en: 'unpublish it', hi: 'unpublish karna' },
    delete: { en: 'delete it', hi: 'delete karna' },
    rename: { en: 'rename it', hi: 'rename karna' },
  };
  const action = label[note];
  return language === 'hi'
    ? ` Dhyan dein: aapne “${action.hi}” bhi bola — woh alag change hai aur is confirmation me shamil nahi hai. Pehle is change ko confirm karein, phir mujhe ${action.hi} kehna.`
    : ` Note: you also asked to ${action.en} — that is a separate change and is NOT included here. Confirm this change first, then ask me to ${action.en}.`;
};

/**
 * Reads one tier's current price from the live catalogue snapshot.
 *
 * The free Welcome Card is a Basic theme priced at 0. It is excluded from the
 * tier's paid price and never updated, so a price change cannot accidentally
 * start charging for the free card. Themes in a tier must agree on one price; if
 * they do not, the tier is ambiguous and the caller must ask instead of guessing.
 */
const lookupTierPrice = (
  tier: GreetingTierId,
  snapshot: AdminSnapshot,
  currency: PricingCurrency,
): { summary: TierPriceSummary; paidThemes: AdminSnapshot['themes'] } => {
  const valueOf = (theme: AdminSnapshot['themes'][number]): number =>
    currency === 'INR' ? Number(theme.price) || 0 : Number(theme.price_usd) || 0;
  const themes = snapshot.themes.filter((theme) => theme.tier === tier);
  const paidThemes = themes.filter((theme) => valueOf(theme) > 0);
  const distinct = [...new Set(paidThemes.map(valueOf))];
  return {
    summary: {
      tier,
      label: GREETING_TIER_LABELS[tier],
      price: distinct.length === 1 ? distinct[0] : null,
      currency,
      themeCount: paidThemes.length,
      ...(distinct.length > 1 ? { conflictingPrices: distinct } : {}),
    },
    paidThemes,
  };
};

const tierPriceLine = (summary: TierPriceSummary): string => {
  if (summary.conflictingPrices) {
    return `${summary.label} (mixed: ${summary.conflictingPrices.map((price) => money(price, summary.currency)).join(', ')})`;
  }
  if (summary.price === null) return `${summary.label} (no paid theme)`;
  return `${summary.label} ${money(summary.price, summary.currency)}`;
};

/** One item's next price under a bulk rule. Free items always stay free. */
const bulkNextPrice = (current: number, mode: BulkMode, value: number): number => {
  if (!(current > 0)) return current;
  const next =
    mode === 'set'
      ? value
      : mode === 'increase_percent'
        ? current * (1 + value / 100)
        : current * (1 - value / 100);
  return Math.round(Math.min(1_000_000, Math.max(0, next)) * 100) / 100;
};

/**
 * Resolves a bulk rule against the live snapshot so the confirmation shows a
 * real count and real before → after prices. The server recalculates from its
 * own rows; this preview never becomes the write payload.
 */
const buildBulkRule = (
  rule: NonNullable<ParsedAdminCommand['bulk']>,
  snapshot: AdminSnapshot,
): BulkPriceRule => {
  const isProducts = rule.scope === 'products';
  const items = isProducts
    ? snapshot.products.map((product) => ({
        name: product.name,
        current:
          rule.currency === 'INR'
            ? Number(product.price_inr ?? product.price) || 0
            : Number(product.price_usd) || 0,
      }))
    : snapshot.themes.map((theme) => ({
        name: theme.name,
        current: rule.currency === 'INR' ? Number(theme.price) || 0 : Number(theme.price_usd) || 0,
      }));

  const changed = items
    .map((item) => ({ ...item, next: bulkNextPrice(item.current, rule.mode, rule.value) }))
    .filter((item) => item.current > 0 && item.next !== item.current);

  return {
    ...rule,
    itemCount: changed.length,
    examples: changed.slice(0, 3).map((item) => ({ name: item.name, from: item.current, to: item.next })),
  };
};

const allTierPriceLine = (snapshot: AdminSnapshot, currency: PricingCurrency): string =>
  GREETING_TIER_IDS.map((tier) => tierPriceLine(lookupTierPrice(tier, snapshot, currency).summary)).join(
    ' · ',
  );

/* ------------------------------------------------------------------ */
/* ReportCard Studio plan pricing                                     */
/* ------------------------------------------------------------------ */

/** Words that name the studio (or one of its plans) rather than a greeting card. */
const STUDIO_RE = /\b(report\s?card\s?studio|reportcard\s?studio|report\s?card|reportcard|studio)\b/i;

interface StudioPlanAlias {
  id: string;
  name: string;
  aliases: string[];
}

/**
 * The three plans that actually exist. Mirrors `studio_plan_prices` ids; the
 * live prices always come from the database, never from this table.
 */
export const STUDIO_PLAN_LABELS: StudioPlanAlias[] = [
  { id: 'simple', name: 'Simple Academic', aliases: ['simple academic', 'simple'] },
  { id: 'modern', name: 'Modern School', aliases: ['modern school', 'modern'] },
  { id: 'holistic', name: 'Holistic Progress', aliases: ['holistic progress', 'holistic'] },
];

export const studioPlanLabel = (id: string): string =>
  STUDIO_PLAN_LABELS.find((plan) => plan.id === id)?.name ?? id;

/** Plan ids named in the message, in the order they were mentioned. */
export const detectStudioPlans = (raw: string): string[] => {
  const lower = raw.toLowerCase();
  const found: { id: string; index: number }[] = [];
  for (const plan of STUDIO_PLAN_LABELS) {
    let best = -1;
    for (const alias of plan.aliases) {
      const pattern = new RegExp(`\\b${alias.replace(/\s+/g, '\\s+')}\\b`, 'i');
      const index = lower.search(pattern);
      if (index >= 0 && (best === -1 || index < best)) best = index;
    }
    if (best >= 0) found.push({ id: plan.id, index: best });
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.id);
};

const PLAN_PRICE_WORDS = [
  'price', 'prices', 'pricing', 'cost', 'costs', 'charge', 'charges', 'rate', 'rates',
  'fee', 'fees', 'kimat', 'bhav', 'daam', 'shulk',
];

const PLAN_DURATION_WORD = /\b(duration|validity|period|billing|tenure|months?|mahine|mahina|maheene)\b/i;
const PLAN_ALL_RE = /\b(all|every|sab|saari|sare|sabhi|sabka)\b/i;

/** "Which pricing settings can I change through Joy?" */
const PRICING_CAPABILITIES_RE =
  /\b(which|what|kaunsi|kaun|kya)\b[\s\S]{0,48}\b(pricing|price|prices|charge|charges|cost)\b[\s\S]{0,48}\b(change|control|edit|set|update|manage|kar sakti|kar sakte|badal|support)\b/i;

/** A new billing duration in months ("3 months", "duration 12"). */
const detectPlanDuration = (lower: string): number | undefined => {
  if (!PLAN_DURATION_WORD.test(lower)) return undefined;
  const match =
    lower.match(/(\d{1,2})\s*(?:months?|mahine|mahina|maheene)\b/) ??
    lower.match(/\b(?:duration|period|validity|tenure|billing)[^0-9]{0,15}(\d{1,2})\b/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isInteger(value) ? value : undefined;
};

/**
 * Detects a ReportCard Studio plan command (read or change).
 *
 * It returns `undefined` for everything else, so the greeting-card, catalogue and
 * guidance branches keep their existing precedence: "ReportCard Studio kaise use
 * karun" is still guidance, and "Basic greeting theme 59" is still a theme.
 *
 * A duration-only request ("change the subscription duration to 3 months")
 * carries no plan name and applies to every plan — that is stated in the
 * confirmation, which the admin has to approve.
 */
const parseStudioPlanPricing = (
  text: string,
  lower: string,
): Partial<ParsedAdminCommand> | undefined => {
  const planIds = detectStudioPlans(text);
  const priceWord = hasWord(lower, PLAN_PRICE_WORDS);
  const durationMonths = detectPlanDuration(lower);
  const subscriptionContext = /\b(subscription|subscriptions|plans?|studio|report\s?card|billing)\b/i.test(
    lower,
  );
  /*
   * A bare plan alias ("simple", "modern", "holistic") is only treated as
   * ReportCard Studio when the message is about a plan or a price; otherwise a
   * product that happens to be called "Simple Something" would be hijacked.
   */
  const planContext = planIds.length > 0 && (priceWord || /\bplans?\b/i.test(lower));
  const mentionsStudio = STUDIO_RE.test(text) || planContext;

  if (!mentionsStudio && !(durationMonths !== undefined && subscriptionContext)) return undefined;

  const parsedAmount = parsePrice(text);
  /*
   * "3 months" is a duration, never ₹3. A bare amount is only read as a price
   * when a price word is present, so "Modern plan 3 months" cannot become a ₹3
   * price.
   */
  const amount: AdminPriceAmount = (() => {
    if (parsedAmount.priceInr !== undefined || parsedAmount.priceUsd !== undefined) {
      return parsedAmount;
    }
    if (durationMonths !== undefined) return {};
    const bare = parseSingleBareNumber(text);
    return bare !== undefined && priceWord ? { priceInr: bare } : {};
  })();
  const hasAmount = amount.priceInr !== undefined || amount.priceUsd !== undefined;
  const asksDuration = durationMonths !== undefined;
  /*
   * A plan *listing* needs the word "plan" plus a read verb/question — not just
   * a question mark. Otherwise "How does ReportCard Studio work?" would be
   * answered with a price list instead of the usage guidance.
   */
  const planListQuery =
    /\bplans?\b/i.test(lower) &&
    /\b(show|list|dikhao|batao|bata|what|which|kya|kaun|konsa|kitne|compare|current)\b/i.test(
      lower,
    );

  if (!priceWord && !asksDuration && !planListQuery) return undefined;

  /* A pure question about what is currently on offer. */
  if (!hasAmount && !asksDuration) {
    return {
      action: 'pricing.plans.read',
      targetKind: null,
      planTargets: planIds,
    };
  }

  const allPlans = PLAN_ALL_RE.test(lower);
  /*
   * Duration with no plan named means every plan. A price with no plan named is
   * ambiguous (the three plans cost different amounts), so the planner asks
   * which plan instead of guessing.
   */
  return {
    action: 'pricing.plan.update',
    targetKind: null,
    planTargets: planIds,
    ...(allPlans || (!planIds.length && asksDuration && !hasAmount) ? { allPlans: true } : {}),
    ...(hasAmount ? { planPrice: amount } : {}),
    ...(asksDuration ? { planDurationMonths: durationMonths } : {}),
  };
};

/** Every current price, in one answer, read from the live sources. */
const allPricesLine = (snapshot: AdminSnapshot, language: JoyLanguage): string => {
  const inrTiers = GREETING_TIER_IDS.map(
    (tier) => tierPriceLine(lookupTierPrice(tier, snapshot, 'INR').summary),
  ).join(' · ');
  const usdTiers = GREETING_TIER_IDS.map(
    (tier) => tierPriceLine(lookupTierPrice(tier, snapshot, 'USD').summary),
  ).join(' · ');

  const products = snapshot.products
    .map((product) => ({ name: product.name, inr: Number(product.price_inr ?? product.price) || 0, usd: Number(product.price_usd) || 0 }))
    .sort((a, b) => a.inr - b.inr);
  const productLines = products
    .slice(0, 20)
    .map((product) => `• ${product.name} — ₹${product.inr}${product.usd > 0 ? ` / $${product.usd}` : ''}`)
    .join('\n');

  const planLines = snapshot.plans
    ?.map(
      (plan) =>
        `• ${plan.name} — ₹${plan.priceInr} / $${plan.priceUsd} · ${plan.durationMonths} month${plan.durationMonths === 1 ? '' : 's'}`,
    )
    .join('\n');

  const heading =
    language === 'hi'
      ? `Sabhi current prices (source of truth se):`
      : `All current prices (read from the source of truth):`;

  return [
    heading,
    `Greeting card tiers — INR: ${inrTiers}`,
    `Greeting card tiers — USD: ${usdTiers}`,
    products.length
      ? `Store products (${products.length}):\n${productLines}${products.length > 20 ? `\n…and ${products.length - 20} more.` : ''}`
      : 'Store products: none priced yet.',
    planLines
      ? `ReportCard Studio plans:\n${planLines}`
      : 'ReportCard Studio plans: the live plan prices could not be read from the server, so I will not guess them.',
    'Free allowances (read-only): 1 free greeting card per email, 7 free ReportCard generations per account.',
  ].join('\n');
};

/** The real limits and capabilities, stated honestly (including what is read-only). */
const pricingCapabilities = (snapshot: AdminSnapshot, language: JoyLanguage): string => {
  const planLines = snapshot.plans?.length
    ? snapshot.plans
        .map((plan) => `${plan.name} ₹${plan.priceInr} / $${plan.priceUsd} · ${plan.durationMonths} mo`)
        .join(' · ')
    : 'live plan prices are not readable right now';

  if (language === 'hi') {
    return [
      'Pricing jo main manage kar sakti hoon:',
      '• Greeting card theme ka price (INR/USD) — server par theme_prices row likhti hoon.',
      '• Greeting card tier (Basic / Plus / Premium / Elite) ka price — usi tier ke paid themes.',
      '• Store product ka price aur naam — products table.',
      '• Poora catalogue ek saath (set / +% / -%) — free items free rehte hain.',
      '• ReportCard Studio plan ka price (INR/USD) aur billing duration — studio_plan_prices table.',
      `  Abhi: ${planLines}`,
      'Ye main nahi badal sakti (aur nakli success nahi bataungi):',
      '• Free allowances (1 free greeting card, 7 free ReportCard generations) — read-only hain: ye _shared/entitlement.ts me counters ke saath enforce hote hain; inke liye alag migration chahiye.',
      '• Store product ka active/publication flag — is schema me exposed nahi hai.',
      '• Purane orders/subscriptions ka price — price change us record ko chhedta nahi.',
      '• Payment secrets, service-role key, roles/permissions — kabhi expose nahi hote.',
    ].join('\n');
  }

  return [
    'Pricing I can manage:',
    '• Greeting card theme price (INR/USD) — writes the theme_prices row on the server.',
    '• Greeting card tier price (Basic / Plus / Premium / Elite) — the paid themes in that tier.',
    '• Store product price and name — the products table.',
    '• The whole catalogue at once (set / +% / -%) — free items always stay free.',
    '• ReportCard Studio plan price (INR/USD) and billing duration — the studio_plan_prices table.',
    `  Right now: ${planLines}`,
    'What I cannot change (and will not pretend to):',
    '• Free allowances (1 free greeting card, 7 free ReportCard generations) — read-only here: they are enforced with usage counters in _shared/entitlement.ts and need their own coordinated migration.',
    '• A store product’s active/publication flag — this schema does not expose it.',
    '• Prices already recorded on past orders/subscriptions — a price change never rewrites them.',
    '• Payment secrets, the service-role key, roles and permissions — never exposed.',
  ].join('\n');
};

const clarify = (
  reason: string,
  language: JoyLanguage,
  action: AdminAction | null,
  summary = reason,
  candidates?: { id: string; name: string }[],
): AdminCommandPlan => ({
  status: 'clarify',
  action,
  risk: action ? RISK[action] : 'low',
  candidates,
  summary,
  reason,
  language,
});

/**
 * What Admin Joy can actually do — the answer to "what can you do?".
 *
 * Every line here corresponds to a server-executed action; nothing is listed
 * that the Edge Function cannot persist, and the boundaries are stated openly so
 * an admin is never left guessing why a request was refused.
 */
export const ADMIN_JOY_HELP: { en: string; hi: string } = {
  en: 'Here is what I can change for you:\n• Prices — any product or greeting theme, one tier (Basic / Plus / Premium / Elite), or the whole catalogue at once (“increase all theme prices by 10%”, “set all product prices to 99”).\n• ReportCard Studio — any plan price in INR or USD (Simple Academic / Modern School / Holistic Progress) and the billing duration (“Simple Academic plan ka price 399 kar do”, “subscription duration 3 months kar do”).\n• Catalogue — add, rename or delete a product; publish, unpublish or delete a greeting theme; read the current tier prices.\n• Game Zone — switch Pair-3Balls on or off, turn maintenance mode on or off, set its sort order.\n• Brand — site name, tagline and logo URL.\n• Reports — sales overview, orders, and the server audit log.\n• Guided help — ask “how do I upload a greeting card”, “I want to add a new product”, “ReportCard Studio kaise use karun”, “Game Zone maintenance par kaise lagau”, “help me fix a pricing issue” or “where are my sales”; I give the real steps, live figures where I have them, and a link to the exact admin tab.\nEvery change is permission-checked on the server, confirmed with you first when it is high-risk, verified by reading the row back, and written to the audit log. I cannot change roles or permissions, erase the audit log, or reveal secrets — use the database console for those.',
  hi: 'Main ye sab badal sakti hoon:\n• Price — koi bhi product ya greeting theme, ek tier (Basic / Plus / Premium / Elite), ya poora catalogue ek saath (“sabhi theme prices 10% badha do”, “saare products ka price 99 kar do”).\n• ReportCard Studio — kisi bhi plan ka price INR ya USD me (Simple Academic / Modern School / Holistic Progress) aur billing duration (“Simple Academic plan ka price 399 kar do”, “subscription duration 3 months kar do”).\n• Catalogue — product add, rename ya delete; greeting theme publish, unpublish ya delete; current tier prices bata sakti hoon.\n• Game Zone — Pair-3Balls on/off, maintenance mode on/off, sort order.\n• Brand — site name, tagline aur logo URL.\n• Reports — sales overview, orders aur server audit log.\n• Guided help — “greeting card upload kaise karun”, “naya product add karna hai”, “ReportCard Studio kaise use karun”, “Game Zone maintenance par kaise lagau”, “pricing issue fix karna hai” ya “meri sales kahan hain” poochhiye; main asli steps, live figures (jahan mere paas hain) aur sahi admin tab ka link deti hoon.\nHar change server par permission-check hota hai, high-risk ho to pehle aapse confirm hota hai, row wapas padh kar verify hota hai, aur audit log me likha jaata hai. Roles ya permissions badalna, audit log mitana, ya secrets batana mera kaam nahi — uske liye database console use karein.',
};

/** True when the admin is asking what the assistant can do, not giving a command. */
export const isAdminHelpQuery = (raw: string): boolean => {
  const text = raw.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return false;
  return /^(help|commands|capabilities|what can you do|what can i do|what can you change|what can you control|what do you support|kya kar sakti ho|kya kar sakte ho|kya kar sakta hai|kya kya kar sakti ho|madad)$/.test(text) ||
    /\b(what can you (do|change|control)|what can you help (me )?with|how can you help|list (your )?commands|show (me )?(the )?commands|kya kya kar sakti|kya kya kar sakte|commands list)\b/.test(text);
};

const tierPriceUpdatePlan = (
  parsed: ParsedAdminCommand,
  snapshot: AdminSnapshot,
): AdminCommandPlan => {
  const language = parsed.language;
  const tiers = parsed.pricingTiers ?? [];
  const proposed = parsed.priceUsd !== undefined ? parsed.priceUsd : parsed.priceInr;
  const currency: PricingCurrency = parsed.priceUsd !== undefined ? 'USD' : 'INR';

  if (tiers.length === 0) {
    const amountNote =
      proposed === undefined
        ? language === 'hi'
          ? ' Naya price bhi batao.'
          : ' Tell me the new price as well.'
        : language === 'hi'
          ? ` Aapne ${money(proposed, currency)} bola hai — bas tier batao.`
          : ` I have the amount ${money(proposed, currency)} — just tell me which tier.`;
    return {
      ...clarify(
        language === 'hi'
          ? `Kaunsa greeting card tier update karna hai — Basic, Plus, Premium ya Elite? Current prices: ${allTierPriceLine(snapshot, currency)}.${amountNote}`
          : `Which greeting card tier should I update — Basic, Plus, Premium or Elite? Current prices: ${allTierPriceLine(snapshot, currency)}.${amountNote}`,
        language,
        'pricing.tier.update',
      ),
      awaiting: 'tier',
      /* Keep the amount the admin already gave, so a bare "Basic" keeps it. */
      ...(proposed !== undefined
        ? {
            pendingAmount:
              parsed.priceUsd !== undefined ? { priceUsd: parsed.priceUsd } : { priceInr: parsed.priceInr },
          }
        : {}),
    };
  }

  if (tiers.length > 1) {
    const named = tiers.map((tier) => GREETING_TIER_LABELS[tier]).join(' and ');
    return {
      ...clarify(
        language === 'hi'
          ? `Aapne ${named} dono bole, par main ek time par ek hi tier update karti hoon — isliye kuch change nahi kiya. Pehle kaunsa tier update karna hai aur uska naya price kya hai? Current prices: ${allTierPriceLine(snapshot, currency)}.`
          : `You named ${named}, but I update one tier at a time — so nothing was changed. Which tier should I update first, and to what price? Current prices: ${allTierPriceLine(snapshot, currency)}.`,
        language,
        'pricing.tier.update',
      ),
      awaiting: 'tier',
    };
  }

  const tier = tiers[0];
  const label = GREETING_TIER_LABELS[tier];
  const lookup = lookupTierPrice(tier, snapshot, currency);

  if (lookup.summary.conflictingPrices) {
    return {
      ...clarify(
        language === 'hi'
          ? `${label} tier ke themes ke prices alag-alag hain (${lookup.summary.conflictingPrices.map((price) => money(price, currency)).join(', ')}), isliye main sabko ek saath change nahi karungi. Pehle prices align karein.`
          : `The ${label} themes currently have different prices (${lookup.summary.conflictingPrices.map((price) => money(price, currency)).join(', ')}), so I will not change them all at once. Align the prices first.`,
        language,
        'pricing.tier.update',
      ),
      tier,
    };
  }

  if (lookup.summary.price === null || lookup.paidThemes.length === 0) {
    return {
      ...clarify(
        language === 'hi'
          ? `${label} tier me koi paid greeting card nahi mila, isliye price change nahi kar sakti.`
          : `I could not find any paid greeting cards in the ${label} tier, so there is no price to change.`,
        language,
        'pricing.tier.update',
      ),
      tier,
    };
  }

  const currentPrice = lookup.summary.price;

  if (proposed === undefined) {
    return {
      ...clarify(
        language === 'hi'
          ? `${label} tier ka current price ${money(currentPrice, currency)} (${currency}) hai. Naya price kya rakhoon?`
          : `The ${label} tier currently costs ${money(currentPrice, currency)} (${currency}). What new price should I set?`,
        language,
        'pricing.tier.update',
      ),
      tier,
      awaiting: 'price',
    };
  }

  if (!Number.isFinite(proposed) || proposed < 0 || proposed > 1_000_000) {
    return {
      ...clarify(
        language === 'hi'
          ? `Price 0 se 10,00,000 ke beech hona chahiye. ${label} ka current price ${money(currentPrice, currency)} (${currency}) hai.`
          : `The price must be between 0 and 1,000,000. The ${label} tier currently costs ${money(currentPrice, currency)} (${currency}).`,
        language,
        'pricing.tier.update',
      ),
      tier,
      awaiting: 'price',
    };
  }

  if (proposed === currentPrice) {
    return {
      ...clarify(
        language === 'hi'
          ? `${label} tier ka price pehle se hi ${money(currentPrice, currency)} (${currency}) hai. Koi change nahi kiya — naya price batao.`
          : `The ${label} tier is already ${money(currentPrice, currency)} (${currency}). Nothing was changed — give me a different price.`,
        language,
        'pricing.tier.update',
      ),
      tier,
      awaiting: 'price',
    };
  }

  const change: TierPriceChange = {
    tier,
    label,
    currentPrice,
    proposedPrice: proposed,
    currency,
    themeIds: lookup.paidThemes.map((theme) => theme.id),
    themeCount: lookup.paidThemes.length,
  };

  /*
   * This summary is what the confirmation button re-runs, so it must parse back
   * to exactly the same tier + amount + currency.
   */
  const summary =
    language === 'hi'
      ? `${label} greeting card tier ka price ${money(proposed, currency)} (${currency}) kar do.`
      : `Change ${label} greeting card tier price to ${money(proposed, currency)} (${currency}).`;

  const confirmationPrompt =
    (language === 'hi'
      ? `${label} tier ka price ${money(currentPrice, currency)} se ${money(proposed, currency)} (${currency}) karna hai? Sirf ${label} tier ke ${change.themeCount} paid themes update honge. Confirm karne ke liye "confirm" likhein.`
      : `Change the ${label} greeting card tier price from ${money(currentPrice, currency)} to ${money(proposed, currency)} (${currency})? This updates ${change.themeCount} paid ${label} theme${change.themeCount === 1 ? '' : 's'} — no other tier. Reply "confirm" to proceed.`) +
    compoundNotice(parsed.compoundNote, language);

  return {
    status: 'confirm',
    action: 'pricing.tier.update',
    risk: RISK['pricing.tier.update'],
    target: { id: `tier:${tier}`, name: `${label} tier`, kind: 'theme' },
    tier,
    tierChange: change,
    summary,
    confirmationPrompt,
    reason:
      language === 'hi'
        ? 'Ye live greeting card prices badalta hai, isliye confirmation chahiye.'
        : 'This changes live greeting card prices, so it needs your confirmation.',
    language,
  };
};

/** One message-ready line for a plan, with both currencies and its duration. */
const planPriceLine = (plan: AdminSnapshotPlan): string =>
  `${plan.name} — ${money(plan.priceInr, 'INR')} (INR) / ${money(plan.priceUsd, 'USD')} (USD) · ${plan.durationMonths} month${plan.durationMonths === 1 ? '' : 's'}`;

const NO_PLANS_READ =
  'The live ReportCard Studio plan prices could not be read from the server (the studio_plan_prices table was unreachable), so nothing was changed and I will not guess a price. Apply migration 20261023_step17_studio_plan_pricing.sql and try again.';

/** Read-only answer for ReportCard Studio plan prices. */
const planPricesReadPlan = (
  parsed: ParsedAdminCommand,
  snapshot: AdminSnapshot,
): AdminCommandPlan => {
  const language = parsed.language;
  const plans = snapshot.plans;
  if (!plans || plans.length === 0) {
    return clarify(NO_PLANS_READ, language, 'pricing.plans.read');
  }
  const ids = parsed.planTargets ?? [];
  const selected = ids.length ? plans.filter((plan) => ids.includes(plan.id)) : plans;
  if (selected.length === 0) {
    return clarify(
      language === 'hi'
        ? `Us plan ka koi record nahi mila. Abhi ke plans: ${plans.map(planPriceLine).join(' · ')}.`
        : `No plan matches that name. Current plans: ${plans.map(planPriceLine).join(' · ')}.`,
      language,
      'pricing.plans.read',
    );
  }

  const lines = selected.map((plan) => `• ${planPriceLine(plan)}`).join('\n');
  const summary =
    language === 'hi'
      ? `ReportCard Studio plans (live studio_plan_prices se, wahi row jo checkout charge karta hai):\n${lines}\nPrice aur duration Admin Joy se badal sakte hain (settings.write permission).`
      : `ReportCard Studio plans (live from studio_plan_prices — the same row checkout charges):\n${lines}\nPrices and billing duration can be changed through Admin Joy (settings.write permission).`;

  return {
    status: 'ready',
    action: 'pricing.plans.read',
    risk: RISK['pricing.plans.read'],
    plans: selected,
    summary,
    reason: 'Read-only plan price lookup.',
    language,
  };
};

/**
 * A ReportCard Studio plan price and/or billing-duration change.
 *
 * Prices and durations come from `studio_plan_prices`; the confirmation shows
 * the current value from that row, so the admin approves a real change. A price
 * with no plan named is ambiguous (the three plans cost different amounts) and is
 * clarified, never guessed. A duration change with no plan named applies to every
 * plan, which the confirmation states explicitly.
 */
const planPriceUpdatePlan = (
  parsed: ParsedAdminCommand,
  snapshot: AdminSnapshot,
): AdminCommandPlan => {
  const language = parsed.language;
  const plans = snapshot.plans;
  if (!plans || plans.length === 0) {
    return clarify(NO_PLANS_READ, language, 'pricing.plan.update');
  }

  const ids = parsed.planTargets ?? [];
  const listLine = plans.map(planPriceLine).join(' · ');
  const amount = parsed.planPrice ?? {};
  const priceInr = amount.priceInr;
  const priceUsd = amount.priceUsd;
  const hasAmount = priceInr !== undefined || priceUsd !== undefined;
  const duration = parsed.planDurationMonths;

  /* An amount without a plan is a real ambiguity: ask, keep the amount. */
  const selected = parsed.allPlans
    ? plans
    : ids.length
      ? plans.filter((plan) => ids.includes(plan.id))
      : [];

  if (selected.length === 0) {
    const candidates = `Current plans: ${listLine}.`;
    const reason =
      language === 'hi'
        ? ids.length
          ? `Us naam ka koi plan nahi mila. ${candidates}`
          : `Kaunsa ReportCard Studio plan? ${candidates} Plan ka naam batao (Simple Academic / Modern School / Holistic Progress) — tabhi main price badlungi.`
        : ids.length
          ? `No plan matches that name. ${candidates}`
          : `Which ReportCard Studio plan? ${candidates} Name it (Simple Academic / Modern School / Holistic Progress) and I will apply exactly that change.`;
    return {
      ...clarify(reason, language, 'pricing.plan.update'),
      awaiting: 'plan',
      ...(hasAmount ? { pendingAmount: amount } : {}),
    };
  }

  /* One price at a time: applying one amount to three different plans is not a
   * change an admin should be able to trigger by accident. */
  if (hasAmount && selected.length > 1) {
    return clarify(
      language === 'hi'
        ? `Main ek time par ek plan ka price badalti hoon — isliye kuch change nahi kiya. Kaunsa plan? ${listLine}.`
        : `I change one plan's price at a time — so nothing was changed. Which plan? ${listLine}.`,
      language,
      'pricing.plan.update',
    );
  }

  if (priceInr !== undefined && (!Number.isFinite(priceInr) || priceInr < 0 || priceInr > 1_000_000)) {
    return clarify(
      language === 'hi'
        ? `INR price 0 se 10,00,000 ke beech hona chahiye. ${listLine}.`
        : `An INR price must be between 0 and 1,000,000. ${listLine}.`,
      language,
      'pricing.plan.update',
    );
  }
  if (priceUsd !== undefined && (!Number.isFinite(priceUsd) || priceUsd < 0 || priceUsd > 1_000_000)) {
    return clarify(
      language === 'hi'
        ? `USD price 0 se 10,00,000 ke beech hona chahiye. ${listLine}.`
        : `A USD price must be between 0 and 1,000,000. ${listLine}.`,
      language,
      'pricing.plan.update',
    );
  }
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 36)) {
    return clarify(
      language === 'hi'
        ? `Billing duration 1 se 36 mahine ke beech ka poora number hona chahiye. ${listLine}.`
        : `The billing duration must be a whole number of months between 1 and 36. ${listLine}.`,
      language,
      'pricing.plan.update',
    );
  }

  const changes: PlanPriceChange[] = [];
  for (const plan of selected) {
    const change: PlanPriceChange = {
      id: plan.id,
      name: plan.name,
      currentInr: plan.priceInr,
      currentUsd: plan.priceUsd,
      currentDurationMonths: plan.durationMonths,
    };
    if (priceInr !== undefined && priceInr !== plan.priceInr) change.priceInr = priceInr;
    if (priceUsd !== undefined && priceUsd !== plan.priceUsd) change.priceUsd = priceUsd;
    if (duration !== undefined && duration !== plan.durationMonths) change.durationMonths = duration;
    if (
      change.priceInr !== undefined ||
      change.priceUsd !== undefined ||
      change.durationMonths !== undefined
    ) {
      changes.push(change);
    }
  }

  if (changes.length === 0) {
    return clarify(
      language === 'hi'
        ? `Ye value pehle se hi set hai — koi change nahi kiya. ${listLine}.`
        : `That value is already set — nothing was changed. ${listLine}.`,
      language,
      'pricing.plan.update',
    );
  }

  const describe = (change: PlanPriceChange): string => {
    const parts: string[] = [];
    if (change.priceInr !== undefined) parts.push(`INR ${money(change.currentInr, 'INR')} → ${money(change.priceInr, 'INR')}`);
    if (change.priceUsd !== undefined) parts.push(`USD ${money(change.currentUsd, 'USD')} → ${money(change.priceUsd, 'USD')}`);
    if (change.durationMonths !== undefined) parts.push(`duration ${change.currentDurationMonths} → ${change.durationMonths} months`);
    return parts.join(', ');
  };

  /*
   * The summary is what the confirmation re-runs, so it must parse back to the
   * same plan(s), amount, currency and duration.
   */
  const single = changes.length === 1 ? changes[0] : undefined;
  const summaryParts: string[] = [];
  if (single) {
    if (single.priceInr !== undefined) summaryParts.push(`Change the ${single.name} plan price to ₹${single.priceInr} (INR).`);
    if (single.priceUsd !== undefined) summaryParts.push(`Change the ${single.name} plan price to $${single.priceUsd} (USD).`);
    if (single.durationMonths !== undefined) {
      summaryParts.push(
        `Change the subscription duration of the ${single.name} plan to ${single.durationMonths} months.`,
      );
    }
  } else {
    const months = changes[0]?.durationMonths;
    summaryParts.push(
      `Change the subscription duration of all ReportCard Studio plans to ${months} months.`,
    );
  }

  const detail = changes
    .map((change) => `• ${change.name}: ${describe(change)}`)
    .join('\n');

  return {
    status: 'confirm',
    action: 'pricing.plan.update',
    risk: RISK['pricing.plan.update'],
    target:
      single ? { id: single.id, name: single.name, kind: 'plan' } : undefined,
    planChanges: changes,
    summary: summaryParts.join(' '),
    confirmationPrompt:
      (language === 'hi'
        ? `ReportCard Studio plan pricing badalne wali hai — ye checkout par charge hoti hai, isliye confirmation chahiye:\n${detail}\nSirf studio_plan_prices row badlegi; purani subscriptions aur past orders waisi hi rahengi. "confirm" likhein.`
        : `This changes ReportCard Studio plan pricing — the amount the checkout charges:\n${detail}\nOnly the studio_plan_prices row changes; existing subscriptions and past orders keep the price they were sold at. Reply "confirm" to proceed.`),
    reason:
      language === 'hi'
        ? 'Ye live plan pricing badalta hai, isliye confirmation chahiye.'
        : 'This changes live plan pricing, so it needs your confirmation.',
    language,
  };
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

/* ------------------------------------------------------------------ */
/* Catalogue discovery & platform knowledge (read-only)               */
/* ------------------------------------------------------------------ */

/** One catalogue row, normalised so themes and products list the same way. */
interface CatalogueEntry {
  id: string;
  name: string;
  kind: 'theme' | 'product';
  priceInr?: number;
  priceUsd?: number;
  tier?: GreetingTierId;
  tags?: string[];
  categoryId?: string;
  description?: string;
  /** Store publication flag; undefined when the build does not expose it. */
  active?: boolean;
}

const CATALOGUE_PAGE_SIZE = 12;

const themeEntries = (snapshot: AdminSnapshot): CatalogueEntry[] =>
  snapshot.themes.map((theme) => ({
    id: theme.id,
    name: theme.name,
    kind: 'theme' as const,
    priceInr: theme.price,
    ...(theme.price_usd !== undefined ? { priceUsd: theme.price_usd } : {}),
    tier: theme.tier,
    ...(theme.tags && theme.tags.length > 0 ? { tags: theme.tags } : {}),
    ...(theme.category_id ? { categoryId: theme.category_id } : {}),
    ...(theme.tagline ? { description: theme.tagline } : {}),
  }));

const productEntries = (snapshot: AdminSnapshot): CatalogueEntry[] =>
  snapshot.products.map((product) => ({
    id: product.id,
    name: product.name,
    kind: 'product' as const,
    priceInr: product.price_inr ?? product.price,
    ...(product.price_usd !== undefined ? { priceUsd: product.price_usd } : {}),
    ...(product.tags && product.tags.length > 0 ? { tags: product.tags } : {}),
    ...(product.category_id ? { categoryId: product.category_id } : {}),
    ...(product.description ? { description: product.description } : {}),
    ...(product.active !== undefined ? { active: product.active } : {}),
  }));

const matchesCatalogueQuery = (
  entry: CatalogueEntry,
  query: CatalogueQuery,
  term: string,
  tag: string,
): boolean => {
  if (query.id && normalizeName(entry.id) !== query.id) return false;
  if (query.category && entry.categoryId !== query.category) return false;
  if (query.tiers && query.tiers.length > 0 && (!entry.tier || !query.tiers.includes(entry.tier))) {
    return false;
  }
  if (tag && !(entry.tags ?? []).some((value) => normalizeName(value).includes(tag))) return false;
  if (query.missingTags && (entry.tags?.length ?? 0) > 0) return false;
  /* A search term matches the name, or the exact id (so "rose-note" is found). */
  if (term && !(normalizeName(entry.name).includes(term) || normalizeName(entry.id) === term)) return false;
  return true;
};

/**
 * Renders the numbered options the admin can pick from on the next turn.
 *
 * In metadata mode each line also carries the record's real metadata — and says
 * plainly which fields the record does not have, rather than leaving a blank.
 */
const renderCatalogueLines = (entries: CatalogueEntry[], isMeta: boolean): string[] =>
  entries.map((entry, index) => {
    const tier = entry.tier ? ` [${GREETING_TIER_LABELS[entry.tier]}]` : '';
    const currency: PricingCurrency = 'INR';
    const price = entry.priceInr === undefined ? '' : ` — ${money(entry.priceInr, currency)}`;
    const usd = entry.priceUsd !== undefined && entry.priceUsd > 0 ? ` / ${money(entry.priceUsd, 'USD')}` : '';
    if (!isMeta) return `${index + 1}. ${entry.name}${tier}${price}${usd}`;
    const detail = [
      `id: ${entry.id}`,
      `category: ${entry.categoryId ? categoryLabel(entry.categoryId) : 'none recorded'}`,
      `tags: ${entry.tags && entry.tags.length > 0 ? entry.tags.join(', ') : 'none recorded'}`,
      entry.kind === 'product'
        ? `status: ${
            entry.active === undefined
              ? 'not exposed in this build'
              : entry.active
                ? 'published'
                : 'unpublished'
          }`
        : '',
    ].filter(Boolean);
    return `${index + 1}. ${entry.name}${tier}${price}${usd} — ${detail.join(' · ')}`;
  });

/**
 * Answers a read-only catalogue request against the live snapshot: list
 * themes/products with their names and current prices, filter by tier, tag or
 * missing tags, look one up by name, or read an entry's tags. Never mutates.
 */
const catalogueListPlan = (
  parsed: ParsedAdminCommand,
  snapshot: AdminSnapshot,
): AdminCommandPlan => {
  const language = parsed.language;
  const query = parsed.catalogue ?? { scope: 'themes' as const };
  const isMeta = parsed.action === 'catalogue.meta' || query.meta === true;
  const term = query.term ? normalizeName(query.term) : '';
  const tag = query.tag ? normalizeName(query.tag) : '';

  const base: AdminCommandPlan = {
    status: 'ready',
    action: parsed.action ?? 'catalogue.list',
    risk: RISK[parsed.action ?? 'catalogue.list'],
    catalogue: query,
    summary: '',
    reason: 'Read-only catalogue lookup.',
    language,
  };

  /*
   * Store products have no tags column in this build, so a tag filter is
   * reported as missing metadata rather than silently returning nothing.
   */
  if (query.scope === 'products' && (tag || query.missingTags)) {
    return {
      ...base,
      summary:
        language === 'hi'
          ? 'Store products ke records me is build me tags field nahi hai, isliye main unhe tags se filter nahi kar sakti. Greeting themes me tags hote hain.'
          : 'Store products do not carry tags in this build, so I cannot filter them by tag. Greeting themes do have tags.',
    };
  }

  /*
   * Greeting themes are "unpublished" when an admin has hidden them (the
   * `theme_overrides.deleted` flag). Hidden themes are removed from the live
   * list, so only their ids reach the snapshot — their names and prices are
   * genuinely unavailable here and are reported as such, never guessed.
   */
  if (query.scope === 'themes' && (query.unpublishedOnly || query.inactiveOnly)) {
    if (snapshot.hiddenThemeIds === undefined) {
      return {
        ...base,
        summary:
          language === 'hi'
            ? 'Is dashboard session me hidden themes ki list mere paas nahi aayi, isliye main unpublished greeting themes confirm nahi kar sakti. Admin Dashboard → Greeting Cards me check karein.'
            : 'This dashboard session did not give me the hidden-theme list, so I cannot confirm which greeting themes are unpublished. Check Admin Dashboard → Greeting Cards.',
      };
    }
    const hidden = snapshot.hiddenThemeIds;
    /*
     * Hidden themes are removed from the live list, so their names, prices and
     * categories are genuinely unavailable. A category/tag/tier filter therefore
     * cannot be applied to them — saying so is honest, silently ignoring it is
     * not.
     */
    const filteredOut =
      query.category || query.tag || (query.tiers && query.tiers.length > 0)
        ? language === 'hi'
          ? ' Hidden themes ka naam/category yahan available nahi hai, isliye category/tag/tier filter laga nahi sakti — ye sabhi hidden theme ids hain.'
          : ' Hidden themes do not expose their names or categories here, so I cannot apply the category/tag/tier filter — these are all hidden theme ids.'
        : '';
    return {
      ...base,
      summary:
        hidden.length === 0
          ? language === 'hi'
            ? 'Koi greeting theme unpublished (hidden) nahi hai — catalogue ke sabhi themes visitors ko dikh rahe hain.'
            : 'No greeting theme is unpublished — every theme in the catalogue is visible to visitors.'
          : language === 'hi'
            ? `Unpublished (hidden) greeting themes: ${hidden.length} — id: ${hidden.join(', ')}. Hidden themes live list se hat jaate hain, isliye unke naam aur price yahan available nahi hain. Restore karne ke liye Admin Dashboard → Greeting Cards me jaayein.${filteredOut}`
            : `Unpublished (hidden) greeting themes: ${hidden.length} — id: ${hidden.join(', ')}. Hidden themes are removed from the live list, so their names and prices are not available here. Restore one from Admin Dashboard → Greeting Cards.${filteredOut}`,
    };
  }

  const scoped = query.scope === 'products' ? productEntries(snapshot) : themeEntries(snapshot);
  const others = query.scope === 'products' ? themeEntries(snapshot) : productEntries(snapshot);

  let entries = scoped.filter((entry) => matchesCatalogueQuery(entry, query, term, tag));
  let scope: 'themes' | 'products' = query.scope;
  /* A bare name search is looked up in both catalogues. */
  if (entries.length === 0 && query.searchBoth && term) {
    const alt = others.filter((entry) =>
      matchesCatalogueQuery(entry, { ...query, searchBoth: false, scope: undefined as never }, term, tag),
    );
    if (alt.length > 0) {
      entries = alt;
      scope = query.scope === 'products' ? 'themes' : 'products';
    }
  }

  /* Products with no publication flag: say it is missing, never guess. */
  if (
    scope === 'products' &&
    (query.unpublishedOnly || query.inactiveOnly) &&
    entries.every((entry) => entry.active === undefined)
  ) {
    return {
      ...base,
      summary:
        language === 'hi'
          ? 'Is build me product ka publication flag (active) dashboard ko nahi milta, isliye inactive/unpublished products ki list nahi de sakti. Products tab khud check karein.'
          : 'This build does not expose the product publication flag to the dashboard, so I cannot list inactive or unpublished products. Please check the Products tab directly.',
    };
  }
  /*
   * "active" also depends on that same missing flag for products. Rather than
   * pretending the filter was applied, the list is shown with an explicit note
   * that the status cannot be confirmed.
   */
  const activeFlagGap =
    scope === 'products' && query.activeOnly && entries.every((entry) => entry.active === undefined);

  const filtered =
    scope === 'products' && (query.unpublishedOnly || query.inactiveOnly)
      ? entries.filter((entry) => entry.active === false)
      : entries;

  const scopeLabel = scope === 'products' ? 'store product' : 'greeting theme';
  const tierLabel =
    query.tiers && query.tiers.length > 0
      ? query.tiers.map((tierId) => GREETING_TIER_LABELS[tierId]).join(' / ')
      : '';
  const categoryNote = query.category ? `${categoryLabel(query.category)} category ` : '';
  const statusWord = query.activeOnly ? 'active ' : query.inactiveOnly ? 'inactive ' : '';
  const orderWord =
    query.sort === 'price_asc'
      ? language === 'hi'
        ? ' (sabse sasta pehle)'
        : ' (cheapest first)'
      : query.sort === 'price_desc'
        ? language === 'hi'
          ? ' (sabse mehnga pehle)'
          : ' (most expensive first)'
        : '';
  const heading = isMeta
    ? `Metadata for ${query.term ? `"${query.term}"` : `the ${scopeLabel} catalogue`}`
    : `${tierLabel ? `${tierLabel} ` : ''}${categoryNote}${statusWord}${scopeLabel}${filtered.length === 1 ? '' : 's'} (name and current price)${orderWord}`;

  if (filtered.length === 0) {
    const filterNote = [
      tierLabel ? `tier ${tierLabel}` : '',
      categoryNote ? `category ${categoryNote.trim()}` : '',
      tag ? `tag "${query.tag}"` : '',
      term ? `name "${query.term}"` : '',
      query.id ? `id "${query.id}"` : '',
      query.missingTags ? 'missing tags' : '',
      query.unpublishedOnly ? 'unpublished only' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return {
      ...clarify(
        language === 'hi'
          ? `Koi ${scopeLabel} nahi mila${filterNote ? ` (filter: ${filterNote})` : ''}. Filter hata kar dobara try karein.`
          : `No ${scopeLabel}s matched${filterNote ? ` (filter: ${filterNote})` : ''}. Try a different tier, tag or name.`,
        language,
        base.action,
      ),
      catalogue: query,
    };
  }

  /* Price ordering is applied to the real snapshot values, never to a guess. */
  const priceValue = (entry: CatalogueEntry): number =>
    entry.priceInr === undefined ? Number.POSITIVE_INFINITY : Number(entry.priceInr);
  const ordered =
    query.sort === 'price_asc'
      ? [...filtered].sort((a, b) => priceValue(a) - priceValue(b))
      : query.sort === 'price_desc'
        ? [...filtered].sort((a, b) => priceValue(b) - priceValue(a))
        : filtered;
  const capped = query.limit && query.limit > 0 ? ordered.slice(0, query.limit) : ordered;

  const pageCount = Math.max(1, Math.ceil(capped.length / CATALOGUE_PAGE_SIZE));
  const page = Math.max(1, Math.min(pageCount, query.page ?? 1));
  const start = (page - 1) * CATALOGUE_PAGE_SIZE;
  const shown = capped.slice(start, start + CATALOGUE_PAGE_SIZE);
  const options: AdminSelectionOption[] = shown.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: entry.kind,
  }));

  /*
   * Paging is explicit and re-filtered from the live snapshot, so "next page"
   * never shows a stale list and never invents entries. The admin is told which
   * page they are on and how many there are.
   */
  const more =
    page < pageCount
      ? language === 'hi'
        ? `\nPage ${page} / ${pageCount}. ${page === 1 ? `Ees ${capped.length} me se pehle ${shown.length} dikhaye.` : `Ab ${start + 1}–${start + shown.length} dikhaye.`} Aage ke liye “next page” likhein.`
        : `\nPage ${page} of ${pageCount}. ${page === 1 ? `Showing the first ${shown.length} of ${capped.length}.` : `Showing ${start + 1}–${start + shown.length}.`} Say “next page” to see the rest.`
      : page > 1
        ? language === 'hi'
          ? `\nPage ${page} / ${pageCount}. “Previous page” se peeche ja sakte hain.`
          : `\nPage ${page} of ${pageCount}. Say “previous page” to go back.`
        : '';

  /*
   * An explicit lowest/highest line makes "identify which have the lowest
   * prices" answerable directly, with ties listed from the real rows.
   */
  const orderLine = (() => {
    if (!query.sort) return '';
    const priced = ordered.filter((entry) => entry.priceInr !== undefined);
    if (priced.length === 0) return '';
    const prices = priced.map((entry) => Number(entry.priceInr));
    const target = query.sort === 'price_asc' ? Math.min(...prices) : Math.max(...prices);
    const ties = priced.filter((entry) => Number(entry.priceInr) === target).map((entry) => entry.name);
    const label =
      query.sort === 'price_asc'
        ? language === 'hi'
          ? 'Sabse kam price'
          : 'Lowest price'
        : language === 'hi'
          ? 'Sabse zyada price'
          : 'Highest price';
    return `\n${label}: ${ties.join(', ')} — ${money(target, 'INR')}.`;
  })();

  const activeNote = activeFlagGap
    ? language === 'hi'
      ? '\nNote: is build me product ka publication flag dashboard ko nahi milta, isliye main confirm nahi kar sakti ki ye products active hain — ye saare store products hain.'
      : '\nNote: this build does not expose the product publication flag, so I cannot confirm which products are active — these are all store products.'
    : '';

  const proposed = parsed.priceUsd !== undefined ? parsed.priceUsd : parsed.priceInr;
  const proposedCurrency: PricingCurrency = parsed.priceUsd !== undefined ? 'USD' : 'INR';
  /*
   * "…then let me change it" asked for the next step, so the single record shown
   * is left waiting for the new price — a bare "59" completes it.
   */
  const changeNext = query.changeNext === true && filtered.length === 1;
  const priceNote = changeNext
    ? language === 'hi'
      ? '\nAb naya price bata dein (jaise “59”) — main isi record ka price badlungi.'
      : '\nNow tell me the new price (for example “59”) and I will change this record.'
    : proposed !== undefined
      ? language === 'hi'
        ? `\nAapne naya price ${money(proposed, proposedCurrency)} (${proposedCurrency}) bataya hai — maine yaad rakha hai; bas number ya exact naam bhejein.`
        : `\nI have kept your proposed price ${money(proposed, proposedCurrency)} (${proposedCurrency}) — reply with the number or the exact name to pick one.`
      : language === 'hi'
        ? '\nChunein: number, "pehla", ya exact/partial naam.'
        : '\nReply with the number, an ordinal ("first one"), or the exact or partial name.';
  return {
      ...base,
      summary: `${heading}:\n${renderCatalogueLines(shown, isMeta).join('\n')}${orderLine}${activeNote}${more}${priceNote}`,
      options,
      awaiting: changeNext ? 'price' : 'theme',
      ...(changeNext && filtered[0]
        ? { pendingTheme: { id: filtered[0].id, name: filtered[0].name, kind: filtered[0].kind } }
        : {}),
      /*
       * A single result is the record now under discussion, so "iska price kya
       * hai" / "set it to 59" refer to it without the admin repeating the name.
       */
      ...(filtered.length === 1
        ? { target: { id: filtered[0].id, name: filtered[0].name, kind: filtered[0].kind } }
        : {}),
      ...(proposed !== undefined
      ? { pendingAmount: parsed.priceUsd !== undefined ? { priceUsd: parsed.priceUsd } : { priceInr: parsed.priceInr } }
      : {}),
  };
};

const OPERATIONS_EXTRA: Record<JoyLanguage, string> = {
  en: '\n• Read-only discovery — list greeting themes or store products with their current prices, filter by tier (Basic / Plus / Premium / Elite), category (Romantic, Birthday, Marriage, Festival, Event, Family) or tag, find items with missing tags, look one up by exact or partial name or by id, and read an item’s real metadata (id, category, tier, tags, publication status and prices). These never change anything.',
  hi: '\n• Read-only discovery — greeting themes ya store products ki list unke current prices ke saath, tier (Basic / Plus / Premium / Elite), category (Romantic, Birthday, Marriage, Festival, Event, Family) ya tag se filter, missing tags wale items, kisi item ko exact/partial naam ya id se dhoondhna, aur uski asli metadata (id, category, tier, tags, publication status aur price) padhna. Ye kuch badalta nahi.',
};

/**
 * Answers a platform-knowledge question from the real implementation, never from
 * a guess. ReportCard Studio facts come from its own source and test harnesses.
 */
const REPORTCARD_KNOWLEDGE: Record<JoyLanguage, string> = {
  en: [
    'ReportCard Studio is a separate report-card app embedded in isZma (isZma section "reportcard-studio"; the built app is served from public/reportcard). I am describing its real source, not a guess.',
    'Implemented in code:',
    '• Import — an Excel parser (ReportCard Studio/src/services/dynamicExcelParser.ts, with the legacy excelParser.ts) detects student fields, subject groups with their components, co-scholastic grade columns and overall fields, and infers class, section and school.',
    '• Mapping — dynamicMappingEngine.ts / mappingEngine.ts map the detected columns to fields and validate the mapping.',
    '• Calculation & grading — calculationEngine.ts and gradingEngine.ts compute totals and percentages and apply CBSE-style bands (A1…C1), and ignore an Excel percentage that contradicts its own marks.',
    '• Validation — validationEngine.ts flags duplicate roll numbers, missing names and marks above the maximum.',
    '• Photos — photoMatcher.ts / photoOverrides.ts match each student photo by roll/admission/name, never by upload order.',
    '• PDF — pdfGenerator.ts renders one A4 card per student with an academic layout (pdf/academicLayout.ts) or a holistic layout (pdf/holisticLayout.ts); bulkGenerator.ts builds a whole-class ZIP with JSZip ("Download-all ZIP bundle").',
    '• Entitlement — free generations and subscriptions are checked through the `entitlement` Edge Function (entitlementApi.ts). Its config/plans.ts lists three 6-month plans: Simple Academic (₹369 / $4.99), Modern School (₹578 / $6.99) and Holistic Progress (₹859 / $10.99); a signed-in account gets 7 free generations first, and admin accounts never pay.',
    'Verified by automated tests (the app’s own harnesses — I have not run them in this session, so this is what the tests assert, not a live status):',
    '• scripts/pipeline-test.ts, scripts/regression-test.ts, scripts/smoke-test-core.mjs and scripts/browser-check-reportcard.mjs cover column mapping, grading maths, per-student photo identity, and one-page, non-overlapping PDFs that print the grand total, grade, result and attendance.',
    'Not yet verified operationally: I have no live run of those scripts or of a real school upload in this session. Treat the above as what the code and tests say.',
    'Missing or planned: students, templates and generated reports are still managed inside the studio, and the free-generation allowance is read-only (it is enforced with usage counters in _shared/entitlement.ts). Plan prices (INR/USD) and the billing duration, by contrast, ARE editable from Admin Joy through the studio_plan_prices table.',
  ].join('\n'),
  hi: [
    'ReportCard Studio ek alag report-card app hai jo isZma me embedded hai (section "reportcard-studio"; build output public/reportcard me). Main iska asli source bata rahi hoon, andaaza nahi. Code se ye pakka hai:',
    'Implemented in code:',
    '• Import — Excel parser (ReportCard Studio/src/services/dynamicExcelParser.ts aur legacy excelParser.ts) student fields, subject groups aur unke components, co-scholastic grade columns aur overall fields detect karta hai, aur class/section/school infer karta hai.',
    '• Mapping — dynamicMappingEngine.ts / mappingEngine.ts detected columns ko fields se map karte hain aur mapping validate karte hain.',
    '• Calculation & grading — calculationEngine.ts aur gradingEngine.ts totals/percentage nikalte hain aur CBSE-style bands (A1…C1) lagate hain; Excel ka galat percentage ignore hota hai.',
    '• Validation — validationEngine.ts duplicate roll numbers, missing naam aur maximum se zyada marks flag karta hai.',
    '• Photos — photoMatcher.ts / photoOverrides.ts har student ki photo roll/admission/naam se match karte hain, upload order se nahi.',
    '• PDF — pdfGenerator.ts har student ka ek A4 card banata hai — academic layout (pdf/academicLayout.ts) ya holistic layout (pdf/holisticLayout.ts); bulkGenerator.ts poori class ka ZIP (JSZip) banata hai.',
    '• Entitlement — free generations aur subscription `entitlement` Edge Function se check hote hain (entitlementApi.ts). Iski config/plans.ts me teen 6-month plans hain: Simple Academic (₹369 / $4.99), Modern School (₹578 / $6.99) aur Holistic Progress (₹859 / $10.99); signed-in account ko pehle 7 free generations milte hain, aur admin accounts kabhi pay nahi karte.',
    'Verified by automated tests (app ke apne harnesses — maine is session me ye nahi chalaye, isliye ye tests ka claim hai, live status nahi):',
    '• scripts/pipeline-test.ts, scripts/regression-test.ts, scripts/smoke-test-core.mjs aur scripts/browser-check-reportcard.mjs column mapping, grading maths, photo identity aur ek-page non-overlapping PDF (grand total, grade, result, attendance) cover karte hain.',
    'Not yet verified operationally: is session me na ye scripts chale, na koi asli school upload. Upar ki baat code aur tests ke hisaab se hai.',
    'Missing or planned: students, templates aur generated reports abhi bhi studio ke andar manage hote hain, aur free-generation allowance read-only hai (_shared/entitlement.ts ke usage counters). Iske ulta plan ka price (INR/USD) aur billing duration Admin Joy se studio_plan_prices table ke through badle ja sakte hain.',
  ].join('\n'),
};

const knowledgePlan = (
  parsed: ParsedAdminCommand,
  snapshot: AdminSnapshot,
): AdminCommandPlan => {
  const language = parsed.language;
  const text =
    parsed.knowledge === 'reportcard'
      ? REPORTCARD_KNOWLEDGE[language]
      : parsed.knowledge === 'pricing'
        ? pricingCapabilities(snapshot, language)
        : ADMIN_JOY_HELP[language] + OPERATIONS_EXTRA[language];
  return {
    status: 'ready',
    action: 'knowledge.info',
    risk: RISK['knowledge.info'],
    summary: text,
    reason: 'Read-only platform knowledge, sourced from the actual implementation.',
    language,
  };
};

/**
 * Resolves a "Name price from X to Y" command where no collection was named.
 * The exact record is looked up in both catalogues; a missing or ambiguous name
 * is clarified instead of guessed, and a tier is never asked for.
 */
const namedPriceChangePlan = (
  parsed: ParsedAdminCommand,
  snapshot: AdminSnapshot,
  actor: AdminActor,
): AdminCommandPlan => {
  const language = parsed.language;
  const name = parsed.priceTargetName ?? '';
  const wanted = normalizeName(name);
  const all: CatalogueEntry[] = [...themeEntries(snapshot), ...productEntries(snapshot)];

  const proposed = parsed.priceUsd !== undefined ? parsed.priceUsd : parsed.priceInr;
  const currency: PricingCurrency = parsed.priceUsd !== undefined ? 'USD' : 'INR';
  const amountPatch = proposed !== undefined
    ? parsed.priceUsd !== undefined
      ? { pendingAmount: { priceUsd: parsed.priceUsd } }
      : { pendingAmount: { priceInr: parsed.priceInr } }
    : {};

  const exact = all.filter((entry) => normalizeName(entry.name) === wanted);
  /* "RoseNote" (no space) still names "Rose Note". */
  const compact = compactName(name);
  const compactExact = compact
    ? all.filter((entry) => compactName(entry.name) === compact)
    : [];
  let matches =
    exact.length > 0
      ? exact
      : compactExact.length > 0
        ? compactExact
        : all.filter((entry) => normalizeName(entry.name).includes(wanted));

  /*
   * One mistyped or transposed word ("Rsoe Note") still names its record when
   * exactly one record is that close. A wider net is never cast: ambiguity is
   * reported, not guessed.
   */
  if (matches.length === 0) {
    matches = all.filter((entry) => namesAreOneTypoApart(entry.name, name));
  }

  if (matches.length === 0) {
    return {
      ...clarify(
        language === 'hi'
          ? `"${name}" naam ka koi greeting theme ya product nahi mila. Exact naam check karein, ya "show me all greeting themes" likh kar list dekh lein.`
          : `No greeting theme or product matches "${name}". Check the exact name, or ask me to list the catalogue.`,
        language,
        'theme.update',
      ),
      candidates: [],
    };
  }

  if (matches.length > 1) {
    const options: AdminSelectionOption[] = matches.slice(0, 5).map((entry) => ({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
    }));
    const numbered = options.map((option, index) => `${index + 1}. ${option.name}`).join('\n');
    return {
      ...clarify(
        language === 'hi'
          ? `I found ${options.length} records matching "${name}". Kaunsa?\n${numbered}\nNumber ya poora naam likhein — main kuch change nahi karungi jab tak ek record clear na ho.`
          : `I found ${options.length} records matching "${name}". Which one do you mean?\n${numbered}\nReply with the number or the full name — nothing is changed until one record is clear.`,
        language,
        'theme.update',
      ),
      candidates: options.map((option) => ({ id: option.id, name: option.name })),
      options,
      awaiting: 'theme',
      ...amountPatch,
    };
  }

  const entry = matches[0];
  const action: AdminAction = entry.kind === 'product' ? 'product.update' : 'theme.update';
  const required = REQUIRED_PERMISSION[action];
  if (!hasPermission(actor, action, required)) {
    noteAuthorizationDenied(actor.email, action);
    return denied(`Your account does not have the "${required}" permission.`, language, action);
  }

  const current = currency === 'INR' ? entry.priceInr : entry.priceUsd;
  const label = entry.kind === 'product' ? 'product' : 'greeting theme';

  if (proposed === undefined) {
    return {
      ...clarify(
        language === 'hi'
          ? `"${entry.name}" (${label}) ka current price ${current === undefined ? 'record me nahi hai' : money(current, currency)} (${currency}) hai. Naya price kya rakhoon?`
          : `"${entry.name}" is a ${label}; its current price is ${current === undefined ? 'not recorded' : money(current, currency)} (${currency}). What new price should I set?`,
        language,
        action,
      ),
      target: { id: entry.id, name: entry.name, kind: entry.kind },
      awaiting: 'price',
      pendingTheme: { id: entry.id, name: entry.name, kind: entry.kind },
    };
  }

  if (!Number.isFinite(proposed) || proposed < 0 || proposed > 1_000_000) {
    return {
      ...clarify(
        language === 'hi'
          ? `Price 0 se 10,00,000 ke beech hona chahiye. "${entry.name}" ka current price ${current === undefined ? 'record me nahi hai' : money(current, currency)} hai.`
          : `The price must be between 0 and 1,000,000. "${entry.name}" currently costs ${current === undefined ? 'no recorded price' : money(current, currency)}.`,
        language,
        action,
      ),
      target: { id: entry.id, name: entry.name, kind: entry.kind },
      awaiting: 'price',
      pendingTheme: { id: entry.id, name: entry.name, kind: entry.kind },
    };
  }

  if (current !== undefined && proposed === current) {
    return {
      ...clarify(
        language === 'hi'
          ? `"${entry.name}" ka price pehle se hi ${money(current, currency)} (${currency}) hai. Koi change nahi kiya — naya price batao.`
          : `"${entry.name}" is already ${money(current, currency)} (${currency}). Nothing was changed — give me a different price.`,
        language,
        action,
      ),
      target: { id: entry.id, name: entry.name, kind: entry.kind },
      awaiting: 'price',
      pendingTheme: { id: entry.id, name: entry.name, kind: entry.kind },
    };
  }

  /* The "from" amount is compared with the live record, never assumed correct. */
  const claimedFrom = currency === 'INR' ? parsed.fromInr : parsed.fromUsd;
  const discrepancy =
    claimedFrom !== undefined && current !== undefined && claimedFrom !== current
      ? language === 'hi'
        ? ` Dhyan dein: aapne current price ${money(claimedFrom, currency)} bataya, par record me ${money(current, currency)} hai.`
        : ` Note: you said the current price is ${money(claimedFrom, currency)}, but the record shows ${money(current, currency)}.`
      : '';

  /*
   * The confirmation button re-runs THIS summary as a brand-new command, so it
   * must carry only the NEW amount. Repeating the live price here made the
   * re-parse read the current value as the proposed one — the old price was
   * written back and the turn still reported success. The current → proposed
   * pair lives in `confirmationPrompt`, which is what the admin actually reads
   * and approves.
   */
  const summary =
    language === 'hi'
      ? `${label} "${entry.name}" ka price ${money(proposed, currency)} (${currency}) kar do.`
      : `Change the ${label} "${entry.name}" price to ${money(proposed, currency)} (${currency}).`;
  const confirmationPrompt =
    (language === 'hi'
      ? `${entry.name} (${label}) ka price ${current === undefined ? '' : `${money(current, currency)} (${currency}) se `}${money(proposed, currency)} (${currency}) karna hai?${discrepancy} Sirf yahi record badlega. Confirm karne ke liye "confirm" likhein.`
      : `Change "${entry.name}" (${label}) price ${current === undefined ? '' : `from ${money(current, currency)} (${currency}) `}to ${money(proposed, currency)} (${currency})?${discrepancy} Only this record will change. Reply "confirm" to proceed.`) +
    compoundNotice(parsed.compoundNote, language);

  return {
    status: 'confirm',
    action,
    risk: RISK[action],
    target: { id: entry.id, name: entry.name, kind: entry.kind },
    patch: buildPatch({ ...parsed, action, field: 'price' }),
    summary,
    confirmationPrompt,
    reason:
      language === 'hi'
        ? 'Ye live price badalta hai, isliye confirmation chahiye.'
        : 'This changes a live price, so it needs your confirmation.',
    language,
  };
};

/**
 * Turns a parsed command into a plan. This performs the security gate and all
 * validation; it never performs the operation itself.
 *
 * It is split from {@link parseAdminCommand} so an AI interpreter can be dropped
 * in as a single seam later: whatever produces the `ParsedAdminCommand` (today
 * the deterministic parser, tomorrow a model call), this validation and the
 * server-side enforcement are unchanged.
 */
export const planAdminCommand = (
  raw: string,
  actor: AdminActor,
  snapshot: AdminSnapshot,
  context: AdminConversationContext = {},
): AdminCommandPlan => planParsedAdminCommand(parseAdminCommand(raw, context), actor, snapshot);

/** Plans an already-parsed command. See {@link planAdminCommand}. */
export const planParsedAdminCommand = (
  parsed: ParsedAdminCommand,
  actor: AdminActor,
  snapshot: AdminSnapshot,
): AdminCommandPlan => {
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

  /*
   * 4a. A named price change ("Change Rose Note price from 40 to 47") names no
   * collection, so it is resolved against both catalogues by exact/partial name.
   * It runs before the "which action?" fallback so an exactly-named record is
   * never dropped and a tier is never asked for when the target is already
   * resolved.
   */
  if (!parsed.action && parsed.priceTargetName && isPlausibleEntityName(parsed.priceTargetName)) {
    return namedPriceChangePlan(parsed, snapshot, actor);
  }

  /* 5. Recognised action? "What can you do?" gets the capability list. */
  if (!parsed.action) {
    if (isAdminHelpQuery(parsed.raw)) {
      return clarify(ADMIN_JOY_HELP[language], language, null);
    }

    /*
     * An amount was given for "it" while a list was on screen. Ask which record
     * with the numbered, snapshot-backed choices and keep the amount, so "2"
     * finishes the change rather than starting over.
     */
    if ((parsed.selectionOptions?.length ?? 0) > 0) {
      const options = (parsed.selectionOptions as AdminSelectionOption[]).slice(0, 5);
      const numbered = options.map((option, index) => `${index + 1}. ${option.name}`).join('\n');
      const amount = parsed.selectionPrice;
      const amountText =
        amount?.priceUsd !== undefined
          ? `$${amount.priceUsd} (USD)`
          : amount?.priceInr !== undefined
            ? `₹${amount.priceInr} (INR)`
            : '';
      const heading =
        language === 'hi'
          ? `Aapne ${amountText} propose kiya, par screen par ${options.length} records hain. Kaunsa?\n${numbered}\nNumber ya poora naam likhein — main kisi ek record ke bina kuch change nahi karungi.`
          : `You proposed ${amountText}, but more than one record is on screen. Which one?\n${numbered}\nReply with the number or the full name — nothing changes until one record is chosen.`;
      return {
        status: 'clarify',
        action: null,
        risk: 'low',
        options,
        awaiting: 'theme',
        ...(amount ? { pendingAmount: amount } : {}),
        summary: heading,
        reason: heading,
        language,
      };
    }

    /* Two mutations for one record in one message is never guessed. */
    if (parsed.compoundConflict) {
      const text =
        language === 'hi'
          ? 'Aapne ek hi greeting theme par do alag changes bole (delete aur publish/unpublish). Main ek time par ek change karti hoon — batayein kaunsa: “delete theme X” ya “publish theme X”.'
          : 'You asked for two different changes to the same greeting theme (delete plus publish/unpublish). I run one change at a time — tell me which: “delete theme X” or “publish theme X”.';
      return clarify(text, language, null);
    }

    /*
     * "Change the price to 99" with no record. The amount is kept, and the reply
     * can be a theme/product name or a tier — never a guess.
     */
    if (parsed.needsTarget) {
      const currency: PricingCurrency = parsed.priceUsd !== undefined ? 'USD' : 'INR';
      const amount = parsed.priceUsd ?? parsed.priceInr ?? 0;
      const tierLine = allTierPriceLine(snapshot, currency);
      const note = compoundNotice(parsed.compoundNote, language);
      const heading =
        language === 'hi'
          ? `₹${amount} kis theme ya product ka price banana hai? Naam batayein (jaise “Rose Note”), ya kaunsa greeting card tier — Basic, Plus, Premium ya Elite? Abhi ke tier prices: ${tierLine}.${note}`
          : `Which theme or product should get ${money(amount, currency)}? Name it (for example “Rose Note”), or tell me which greeting card tier — Basic, Plus, Premium or Elite. Current tier prices: ${tierLine}.${note}`;
      return {
        status: 'clarify',
        action: null,
        risk: 'low',
        awaiting: 'target',
        pendingAmount: parsed.priceUsd !== undefined ? { priceUsd: parsed.priceUsd } : { priceInr: parsed.priceInr },
        summary: heading,
        reason: heading,
        language,
      };
    }

    /*
     * A request this build genuinely cannot perform is explained, never faked.
     * Store products have no activation action and no exposed status flag.
     */
    if (parsed.unsupported === 'product.activation') {
      const text =
        language === 'hi'
          ? 'Store products ko activate/deactivate karne ka action is build me nahi hai — admin service sirf product ka naam aur price badalta hai, aur product ka publication flag dashboard ko milta hi nahi. Isliye main nakli success nahi bataungi. Main product ka naam/price badal sakti hoon ya delete kar sakti hoon; greeting theme ko unpublish kiya ja sakta hai.'
          : 'This build has no activate/deactivate action for store products — the admin service only changes a product’s name and prices, and the product publication flag is not exposed to the dashboard. So I will not pretend it changed. I can change a product’s name/price or delete it, and a greeting theme can be unpublished instead.';
      return clarify(text, language, null);
    }
    /*
     * Unrecognised wording is a clarification, not a dead end: Joy says what is
     * missing and offers the real operations it can run, so the next message can
     * be a short reply rather than a repeated guess.
     */
    const menu =
      language === 'hi'
        ? [
            'Main is message ko kisi supported action se match nahi kar payi — kuch change nahi hua.',
            'Mujhe bas ye batayein ki kya karna hai:',
            '1. Price badalna — product, greeting theme, ek tier (Basic / Plus / Premium / Elite) ya poora catalogue',
            '2. Catalogue dekhna — themes/products, tier, category, tags ya naam se',
            '3. Product add karna',
            '4. Theme publish / unpublish / delete karna',
            '5. Game Zone on/off ya maintenance',
            '6. Sales, orders ya audit report',
            '7. Guide — greeting card upload, ReportCard Studio, pricing issue',
            'Udaharan: “Basic ka price 59 kar do” ya “showing unpublished cards”.',
          ].join('\n')
        : [
            'I could not match that to a supported action — nothing was changed.',
            'Tell me which one you mean:',
            '1. Change a price — a product, a greeting theme, one tier (Basic / Plus / Premium / Elite), or the whole catalogue',
            '2. Read the catalogue — themes/products by tier, category, tag or name',
            '3. Add a product',
            '4. Publish, unpublish or delete a greeting theme',
            '5. Turn the Game Zone on/off or into maintenance',
            '6. Sales, orders or audit report',
            '7. Guidance — greeting card upload, ReportCard Studio, a pricing issue',
            'For example: “change the Basic price to ₹59” or “show unpublished cards”.',
          ].join('\n');
    return clarify(menu, language, null);
  }

  /* 6. Least-privilege permission check (bulk is scope-dependent). */
  const requiredPermission =
    parsed.action === 'pricing.bulk.update' && parsed.bulk
      ? parsed.bulk.scope === 'products'
        ? 'products.write'
        : 'themes.write'
      : REQUIRED_PERMISSION[parsed.action];
  if (!hasPermission(actor, parsed.action, requiredPermission)) {
    noteAuthorizationDenied(actor.email, parsed.action);
    return denied(`Your account does not have the "${requiredPermission}" permission.`, language, parsed.action);
  }

  /* 7. Actions with no backing module are refused honestly. */
  if (UNSUPPORTED_ACTIONS.has(parsed.action)) {
    return denied(
      'Music management is not available in this build yet. It needs the music module and a server function before Joy can publish or edit tracks.',
      language,
      parsed.action,
    );
  }

  /*
   * 7a. Read-only catalogue discovery and platform knowledge. These never
   * mutate anything: the listing is filtered from the live snapshot, and the
   * knowledge answer is sourced from the actual implementation.
   */
  if (parsed.action === 'guide.info') {
    return guidePlan(parsed, snapshot);
  }

  if (
    parsed.action === 'catalogue.list' ||
    parsed.action === 'catalogue.meta' ||
    parsed.action === 'knowledge.info'
  ) {
    return parsed.action === 'knowledge.info'
      ? knowledgePlan(parsed, snapshot)
      : catalogueListPlan(parsed, snapshot);
  }

  /* 8. Read-only reports need no target or confirmation. */
  if (
    parsed.action === 'report.orders' ||
    parsed.action === 'report.overview' ||
    parsed.action === 'report.audit'
  ) {
    const summaries: Record<string, string> = {
      'report.orders': "Show today's order summary.",
      'report.overview': 'Show the overview summary.',
      'report.audit': 'Show the most recent admin audit entries.',
    };
    return {
      status: 'ready',
      action: parsed.action,
      risk: RISK[parsed.action],
      summary: summaries[parsed.action],
      reason: 'Read-only report.',
      language,
    };
  }

  /* 8a. Game Zone availability. */
  if (parsed.action === 'game.update') {
    const patch = parsed.gamePatch ?? {};
    if (Object.keys(patch).length === 0) {
      return {
        status: 'clarify',
        action: parsed.action,
        risk: RISK[parsed.action],
        summary: 'No Game Zone change was found.',
        reason:
          language === 'hi'
            ? 'Batao kya badalna hai — Game Zone band/chalu karna hai, maintenance on/off, ya sort order.'
            : 'Tell me what to change — turn the Game Zone on/off, set maintenance, or set its sort order.',
        language,
      };
    }
    const parts: string[] = [];
    if (patch.enabled !== undefined) parts.push(patch.enabled ? 'turn the Game Zone ON for visitors' : 'turn the Game Zone OFF for visitors');
    if (patch.maintenance !== undefined) parts.push(patch.maintenance ? 'put Pair-3Balls into maintenance mode' : 'take Pair-3Balls out of maintenance mode');
    if (patch.sortOrder !== undefined) parts.push(`set its sort order to ${patch.sortOrder}`);
    const summary = `Game Zone: ${parts.join(', ')}.`;
    return {
      status: 'confirm',
      action: parsed.action,
      risk: RISK[parsed.action],
      target: { id: ADMIN_GAME_ID, name: 'Game Zone (Pair-3Balls)', kind: 'game' },
      gamePatch: patch,
      summary,
      confirmationPrompt: `Confirm: ${summary}`,
      reason: 'This changes what visitors can play, so it needs confirmation.',
      language,
    };
  }

  /* 8a(ii). Brand settings. */
  if (parsed.action === 'brand.update') {
    const patch = parsed.brandPatch ?? {};
    if (Object.keys(patch).length === 0) {
      return {
        status: 'clarify',
        action: parsed.action,
        risk: RISK[parsed.action],
        summary: 'No brand value was found.',
        reason:
          language === 'hi'
            ? 'Naya value quotes me bolo, jaise: brand name "isZma" set karo.'
            : 'Give the new value in quotes, for example: set brand name to "isZma".',
        language,
      };
    }
    const parts: string[] = [];
    if (patch.siteName !== undefined) parts.push(`site name → "${patch.siteName}"`);
    if (patch.tagline !== undefined) parts.push(`tagline → "${patch.tagline}"`);
    if (patch.logoUrl !== undefined) parts.push(`logo → ${patch.logoUrl}`);
    const summary = `Update brand settings: ${parts.join(', ')}.`;
    return {
      status: 'confirm',
      action: parsed.action,
      risk: RISK[parsed.action],
      target: { id: 'site_settings', name: 'Brand settings', kind: 'brand' },
      brandPatch: patch,
      summary,
      confirmationPrompt: `Confirm: ${summary}`,
      reason: 'Branding is shown across the whole site, so it needs confirmation.',
      language,
    };
  }

  /* 8a(iii). Catalogue-wide price change. */
  if (parsed.action === 'pricing.bulk.update') {
    if (!parsed.bulk) {
      return {
        status: 'clarify',
        action: parsed.action,
        risk: RISK[parsed.action],
        summary: 'No bulk price rule was resolved.',
        reason: 'Name the catalogue and the rule, for example: increase all theme prices by 10%.',
        language,
      };
    }
    const rule = buildBulkRule(parsed.bulk, snapshot);
    if (rule.itemCount === 0) {
      return {
        status: 'clarify',
        action: parsed.action,
        risk: RISK[parsed.action],
        summary: 'No paid items would change.',
        reason:
          rule.scope === 'products'
            ? 'No priced products would change with that rule (free items stay free).'
            : 'No priced greeting themes would change with that rule (free items stay free).',
        language,
      };
    }
    const verb =
      rule.mode === 'set'
        ? `Set every paid ${rule.scope === 'products' ? 'product' : 'greeting theme'} price to ${money(rule.value, rule.currency)}`
        : rule.mode === 'increase_percent'
          ? `Increase every paid ${rule.scope === 'products' ? 'product' : 'greeting theme'} price by ${rule.value}%`
          : `Decrease every paid ${rule.scope === 'products' ? 'product' : 'greeting theme'} price by ${rule.value}%`;
    const examples = rule.examples
      .map((example) => `${example.name}: ${money(example.from, rule.currency)} → ${money(example.to, rule.currency)}`)
      .join(', ');
    const summary = `${verb} (${rule.currency}) — ${rule.itemCount} item${rule.itemCount === 1 ? '' : 's'} affected.${examples ? ` e.g. ${examples}.` : ''} Free items stay free.`;
    return {
      status: 'confirm',
      action: parsed.action,
      risk: RISK[parsed.action],
      bulk: rule,
      summary,
      confirmationPrompt: `Confirm: ${summary}`,
      reason: 'This changes many live prices at once, so it needs explicit confirmation.',
      language,
    };
  }

  /*
   * 8a(iv). Read-only pricing inventory: every current price, and one plan's
   * price. Both read the live sources, never a hard-coded copy.
   */
  if (parsed.action === 'pricing.summary.read') {
    return {
      status: 'ready',
      action: parsed.action,
      risk: RISK[parsed.action],
      summary: allPricesLine(snapshot, language),
      reason: 'Read-only price inventory from the live catalogue and plan table.',
      language,
    };
  }

  if (parsed.action === 'pricing.plans.read') {
    return planPricesReadPlan(parsed, snapshot);
  }

  if (parsed.action === 'pricing.plan.update') {
    return planPriceUpdatePlan(parsed, snapshot);
  }

  /*
   * 8b. Greeting-card tier pricing. Both paths work only against the existing
   * theme records; no tier product or duplicate price field is created.
   */
  if (parsed.action === 'pricing.tiers.read') {
    const requested = parsed.pricingTiers ?? [];
    const tiers = requested.length > 0 ? requested : [...GREETING_TIER_IDS];
    const currency: PricingCurrency = parsed.priceUsd !== undefined ? 'USD' : 'INR';
    const summaries = tiers.map((tier) => lookupTierPrice(tier, snapshot, currency).summary);
    const body = summaries.map(tierPriceLine).join(' · ');
    const summary =
      language === 'hi'
        ? `Greeting card prices (${currency}): ${body}.`
        : `Greeting card tier prices (${currency}): ${body}.`;
    return {
      status: 'ready',
      action: parsed.action,
      risk: RISK[parsed.action],
      tierPrices: summaries,
      ...(requested.length === 1 ? { tier: requested[0] } : {}),
      summary,
      reason: 'Read-only price lookup.',
      language,
    };
  }

  if (parsed.action === 'pricing.tier.update') {
    return tierPriceUpdatePlan(parsed, snapshot);
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
      summary:
        language === 'hi'
          ? 'Koi matching record nahi mila — kuch change nahi hua.'
          : 'No matching record was found — nothing was changed.',
      reason:
        language === 'hi'
          ? parsed.targetId
            ? `${parsed.targetKind === 'product' ? 'product' : 'greeting theme'} ki id "${parsed.targetId}" maujood nahi hai. Kuch change nahi hua — asli id check karein.`
            : parsed.targetName
              ? `"${parsed.targetName}" naam ka koi ${parsed.targetKind === 'product' ? 'product' : 'greeting theme'} nahi mila. Poora naam bataiye.`
              : `${parsed.targetKind === 'product' ? 'Product' : 'Greeting theme'} ka naam bataiye.`
          : parsed.targetId
            ? `No ${parsed.targetKind ?? 'record'} has the id "${parsed.targetId}". Nothing was changed — check the real id.`
            : parsed.targetName
              ? `No ${parsed.targetKind ?? 'record'} matches "${parsed.targetName}". Check the exact name and try again.`
              : `Please name the ${parsed.targetKind ?? 'record'} you mean.`,
      language,
    };
  }
  if (resolution.kind === 'ambiguous') {
    /*
     * Ambiguity gets numbered, database-backed choices — and the amount already
     * proposed is kept, so "2" finishes the same price change instead of
     * starting a new one. Nothing is written until a single record is resolved.
     */
    const options: AdminSelectionOption[] = resolution.candidates.slice(0, 5).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      kind: parsed.targetKind === 'product' ? 'product' : 'theme',
    }));
    const numbered = options.map((option, index) => `${index + 1}. ${option.name}`).join('\n');
    const pendingAmount =
      parsed.priceUsd !== undefined
        ? { priceUsd: parsed.priceUsd }
        : parsed.priceInr !== undefined
          ? { priceInr: parsed.priceInr }
          : undefined;
    const heading =
      language === 'hi'
        ? `"${parsed.targetName}" se ek se zyada ${parsed.targetKind === 'product' ? 'product' : 'greeting theme'} match karte hain. Kaunsa?\n${numbered}\nNumber ya poora naam likhein — main kuch change nahi karungi jab tak ek record clear na ho.`
        : `I found ${options.length} ${parsed.targetKind === 'product' ? 'products' : 'greeting themes'} matching "${parsed.targetName}". Which one do you mean?\n${numbered}\nReply with the number or the full name — nothing is changed until one record is clear.`;
    return {
      status: 'clarify',
      action: parsed.action,
      risk: RISK[parsed.action],
      candidates: resolution.candidates,
      options,
      awaiting: 'theme',
      pendingAction: parsed.action,
      ...(pendingAmount ? { pendingAmount } : {}),
      summary: heading,
      reason: heading,
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

  /*
   * A price outside the real range is refused here as well, so a negative or
   * absurd amount can never reach the confirmation step (the server rejects it
   * too — this keeps the conversation honest before anything is approved).
   */
  const proposedPrice = parsed.priceUsd !== undefined ? parsed.priceUsd : parsed.priceInr;
  if (parsed.field === 'price' && proposedPrice !== undefined && (proposedPrice < 0 || proposedPrice > 1_000_000)) {
    return {
      status: 'clarify',
      action: parsed.action,
      risk: RISK[parsed.action],
      target,
      summary: 'That price is out of range.',
      reason:
        language === 'hi'
          ? `Price 0 se 10,00,000 ke beech hona chahiye. "${target.name}" ka price waise hi hai — naya valid price batayein.`
          : `The price must be between 0 and 1,000,000. "${target.name}" is unchanged — give me a valid price.`,
      language,
    };
  }

  /*
   * A price change on an already-resolved record shows the live current price
   * next to the proposed one, so the admin confirms against real data
   * ("Set it to 59." → from ₹40 to ₹59).
   */
  if (parsed.field === 'price' && proposedPrice !== undefined) {
    const entry = [...themeEntries(snapshot), ...productEntries(snapshot)].find((row) => row.id === target.id);
    const currency: PricingCurrency = parsed.priceUsd !== undefined ? 'USD' : 'INR';
    const current = currency === 'INR' ? entry?.priceInr : entry?.priceUsd;
    const label = target.kind === 'product' ? 'product' : 'greeting theme';
    /*
     * Only the NEW amount belongs in the summary: the confirmation button
     * re-parses it as a fresh command, so a second (current) price would be read
     * back as the requested one. The current → proposed pair is shown in
     * `confirmationPrompt` instead.
     */
    const changeSummary =
      language === 'hi'
        ? `${label} "${target.name}" ka price ${money(proposedPrice, currency)} (${currency}) kar do.`
        : `Change the ${label} "${target.name}" price to ${money(proposedPrice, currency)} (${currency}).`;
    return {
      status: 'confirm',
      action: parsed.action,
      risk: RISK[parsed.action],
      target,
      patch: buildPatch(parsed),
      summary: changeSummary,
      confirmationPrompt:
        (language === 'hi'
          ? `${target.name} (${label}) ka price ${current === undefined ? '' : `${money(current, currency)} (${currency}) se `}${money(proposedPrice, currency)} (${currency}) karna hai? Sirf yahi record badlega. Confirm karne ke liye "confirm" likhein.`
          : `Change "${target.name}" (${label}) price ${current === undefined ? '' : `from ${money(current, currency)} (${currency}) `}to ${money(proposedPrice, currency)} (${currency})? Only this record will change. Reply "confirm" to proceed.`) +
        compoundNotice(parsed.compoundNote, language),
      reason:
        language === 'hi'
          ? 'Ye live price badalta hai, isliye confirmation chahiye.'
          : 'This changes a live price, so it needs your confirmation.',
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

/**
 * Proves the server really persisted the tier price by reading back every
 * affected theme row and comparing the saved money field. A success claim without
 * this evidence is downgraded to a failure.
 */
const verifyTierChange = (
  change: TierPriceChange,
  after: Record<string, unknown> | undefined,
): boolean => {
  const rows = after?.themes;
  if (!Array.isArray(rows)) return false;
  const field = change.currency === 'INR' ? 'price_inr' : 'price_usd';
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const id = String(record.theme_id ?? record.id ?? '');
    if (id) byId.set(id, record);
  }
  return change.themeIds.every((id) => {
    const saved = byId.get(id);
    return Boolean(saved) && Number(saved?.[field]) === change.proposedPrice;
  });
};

/**
 * Proves a single-record price write really persisted by comparing the row the
 * server read back against the patch that was approved. A mismatch counts as a
 * failure even though the server answered "ok" — telling an admin a price was
 * saved when a different value is stored is exactly what must never happen.
 *
 * Returns `undefined` when the plan is not a plain price patch, in which case
 * the generic `after` check applies unchanged.
 */
const verifySavedPrice = (
  plan: AdminCommandPlan,
  after: Record<string, unknown> | undefined,
): boolean | undefined => {
  if (plan.action !== 'theme.update' && plan.action !== 'product.update') return undefined;
  const patch = plan.patch as { price?: unknown; price_usd?: unknown } | undefined;
  if (!patch) return undefined;
  const wantInr = typeof patch.price === 'number' ? patch.price : undefined;
  const wantUsd = typeof patch.price_usd === 'number' ? patch.price_usd : undefined;
  if (wantInr === undefined && wantUsd === undefined) return undefined;
  if (!after) return false;

  /* `theme_prices` stores the INR amount as `price_inr`; `products` uses `price`. */
  const readMoney = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = after[key];
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    return undefined;
  };

  if (wantUsd !== undefined && readMoney('price_usd') !== wantUsd) return false;
  if (wantInr !== undefined) {
    const saved = readMoney('price_inr', 'price');
    if (saved !== wantInr) return false;
  }
  return true;
};

/**
 * Proves a plan price/duration write really persisted by reading the saved row
 * back. The amount is money, so a mismatch is a failure even if the server said
 * "ok".
 */
const verifyPlanChange = (
  change: PlanPriceChange,
  after: Record<string, unknown> | undefined,
): boolean => {
  if (!after) return false;
  const readNumber = (value: unknown): number => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim() !== '') return Number(value);
    return Number.NaN;
  };
  if (change.priceInr !== undefined && readNumber(after.price_inr) !== change.priceInr) return false;
  if (change.priceUsd !== undefined && readNumber(after.price_usd) !== change.priceUsd) return false;
  if (
    change.durationMonths !== undefined &&
    readNumber(after.duration_months) !== change.durationMonths
  ) {
    return false;
  }
  return true;
};

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

  /* Read-only tier prices came from the live catalogue snapshot. */
  if (plan.action === 'pricing.tiers.read') {
    return log({
      ok: true,
      status: 'success',
      message: plan.summary,
      verified: Array.isArray(plan.tierPrices) && plan.tierPrices.length > 0,
    });
  }

  /* Read-only plan prices and the price inventory read the live sources. */
  if (plan.action === 'pricing.plans.read') {
    return log({
      ok: true,
      status: 'success',
      message: plan.summary,
      verified: Array.isArray(plan.plans) && plan.plans.length > 0,
    });
  }
  if (plan.action === 'pricing.summary.read') {
    return log({
      ok: true,
      status: 'success',
      message: plan.summary,
      verified: Boolean(plan.summary),
    });
  }

  /*
   * Read-only catalogue listings and knowledge answers were resolved at plan
   * time from the live snapshot / the real implementation. Nothing to write.
   */
  if (
    plan.action === 'catalogue.list' ||
    plan.action === 'catalogue.meta' ||
    plan.action === 'knowledge.info' ||
    plan.action === 'guide.info'
  ) {
    return log({
      ok: true,
      status: 'success',
      message: plan.summary,
      verified: Boolean(plan.summary),
    });
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
      case 'pricing.tier.update': {
        const change = plan.tierChange;
        if (!change) {
          return log({
            ok: false,
            status: 'failure',
            message: 'The tier price change could not be resolved.',
            verified: false,
          });
        }
        if (!ops.updateTierPrice) {
          return log({
            ok: false,
            status: 'failure',
            message:
              'The server does not expose a tier price action in this build, so nothing was changed.',
            verified: false,
          });
        }

        const tierResult = await ops.updateTierPrice({
          tier: change.tier,
          themeIds: change.themeIds,
          ...(change.currency === 'INR'
            ? { priceInr: change.proposedPrice }
            : { priceUsd: change.proposedPrice }),
        });

        if (!tierResult.ok) {
          return log(
            {
              ok: false,
              status: 'failure',
              message: tierResult.error ?? 'The tier price could not be updated.',
              verified: false,
            },
            { before: tierResult.before, after: tierResult.after },
          );
        }

        if (!verifyTierChange(change, tierResult.after)) {
          return log({
            ok: false,
            status: 'failure',
            message:
              'The server reported success, but the saved tier price could not be verified. Reload the dashboard and check the catalogue before trying again.',
            verified: false,
          });
        }

        const savedMessage =
          plan.language === 'hi'
            ? `${change.label} greeting card tier ka price ${money(change.currentPrice, change.currency)} se ${money(change.proposedPrice, change.currency)} (${change.currency}) ho gaya — ${change.themeCount} paid themes me verify kiya. Koi doosra tier nahi badla.`
            : `${change.label} greeting card tier price changed from ${money(change.currentPrice, change.currency)} to ${money(change.proposedPrice, change.currency)} (${change.currency}). Verified in ${change.themeCount} paid theme${change.themeCount === 1 ? '' : 's'}; no other tier was changed.`;

        return log(
          { ok: true, status: 'success', message: savedMessage, verified: true },
          {
            before: { price: change.currentPrice, currency: change.currency },
            after: { price: change.proposedPrice, currency: change.currency },
          },
        );
      }
      case 'game.update': {
        if (!ops.updateGame) {
          return log({
            ok: false,
            status: 'failure',
            message: 'The server does not expose a Game Zone action in this build, so nothing was changed.',
            verified: false,
          });
        }
        result = await ops.updateGame(plan.gamePatch ?? {});
        break;
      }
      case 'brand.update': {
        if (!ops.updateBrand) {
          return log({
            ok: false,
            status: 'failure',
            message: 'The server does not expose a brand settings action in this build, so nothing was changed.',
            verified: false,
          });
        }
        result = await ops.updateBrand(plan.brandPatch ?? {});
        break;
      }
      case 'pricing.bulk.update': {
        const rule = plan.bulk;
        if (!rule) {
          return log({
            ok: false,
            status: 'failure',
            message: 'The bulk price change could not be resolved.',
            verified: false,
          });
        }
        if (!ops.bulkUpdatePrices) {
          return log({
            ok: false,
            status: 'failure',
            message: 'The server does not expose a bulk price action in this build, so nothing was changed.',
            verified: false,
          });
        }
        const bulkResult = await ops.bulkUpdatePrices({
          scope: rule.scope,
          mode: rule.mode,
          value: rule.value,
          currency: rule.currency,
        });
        if (!bulkResult.ok) {
          return log(
            {
              ok: false,
              status: 'failure',
              message: bulkResult.error ?? 'The bulk price change failed.',
              verified: false,
            },
            { before: bulkResult.before, after: bulkResult.after },
          );
        }
        const updated = Number(bulkResult.after?.updated ?? 0);
        if (!(updated > 0)) {
          return log({
            ok: false,
            status: 'failure',
            message:
              'The server reported success, but no saved price could be verified. Reload the dashboard and check the catalogue before trying again.',
            verified: false,
          });
        }
        const scopeLabel = rule.scope === 'products' ? 'product' : 'greeting theme';
        return log(
          {
            ok: true,
            status: 'success',
            message:
              rule.mode === 'set'
                ? `Set the price of ${updated} paid ${scopeLabel}${updated === 1 ? '' : 's'} to ${money(rule.value, rule.currency)} (${updated} verified). Free items were left at zero.`
                : `${rule.mode === 'increase_percent' ? 'Increased' : 'Decreased'} the price of ${updated} paid ${scopeLabel}${updated === 1 ? '' : 's'} by ${rule.value}% (${updated} verified). Free items were left at zero.`,
            verified: true,
          },
          { before: bulkResult.before, after: bulkResult.after },
        );
      }
      case 'pricing.plan.update': {
        const changes = plan.planChanges ?? [];
        if (!changes.length) {
          return log({
            ok: false,
            status: 'failure',
            message: 'The plan price change could not be resolved.',
            verified: false,
          });
        }
        if (!ops.updatePlanPrice) {
          return log({
            ok: false,
            status: 'failure',
            message:
              'The server does not expose a plan pricing action in this build, so nothing was changed.',
            verified: false,
          });
        }

        const applied: PlanPriceChange[] = [];
        for (const change of changes) {
          const planResult = await ops.updatePlanPrice({
            planId: change.id,
            ...(change.priceInr !== undefined ? { priceInr: change.priceInr } : {}),
            ...(change.priceUsd !== undefined ? { priceUsd: change.priceUsd } : {}),
            ...(change.durationMonths !== undefined ? { durationMonths: change.durationMonths } : {}),
          });

          if (!planResult.ok) {
            return log(
              {
                ok: false,
                status: 'failure',
                message:
                  (applied.length
                    ? `${applied.length} of ${changes.length} plans were already changed before this failure; `
                    : '') +
                  (planResult.error ?? 'The plan price could not be updated.'),
                verified: false,
              },
              { after: planResult.after },
            );
          }

          if (!verifyPlanChange(change, planResult.after)) {
            return log({
              ok: false,
              status: 'failure',
              message:
                'The server reported success, but the saved plan price could not be verified. Reload the dashboard and check the plan before trying again.',
              verified: false,
            });
          }

          applied.push(change);
        }

        const detail = applied
          .map((change) => {
            const parts: string[] = [];
            if (change.priceInr !== undefined) parts.push(`${money(change.currentInr, 'INR')} → ${money(change.priceInr, 'INR')} (INR)`);
            if (change.priceUsd !== undefined) parts.push(`${money(change.currentUsd, 'USD')} → ${money(change.priceUsd, 'USD')} (USD)`);
            if (change.durationMonths !== undefined) {
              parts.push(`duration ${change.currentDurationMonths} → ${change.durationMonths} months`);
            }
            return `• ${change.name}: ${parts.join(', ')}`;
          })
          .join('\n');

        return log(
          {
            ok: true,
            status: 'success',
            message:
              plan.language === 'hi'
                ? `ReportCard Studio plan pricing update ho gayi aur server se verify ki gayi:\n${detail}\nYehi value ab checkout charge karega. Purani subscriptions aur past orders nahi badle.`
                : `ReportCard Studio plan pricing updated and verified from the saved row:\n${detail}\nThis is now what checkout charges. Existing subscriptions and past orders are unchanged.`,
            verified: true,
          },
          {
            before: {
              plans: applied.map((change) => ({
                name: change.name,
                price_inr: change.currentInr,
                price_usd: change.currentUsd,
                duration_months: change.currentDurationMonths,
              })),
            },
            after: {
              plans: applied.map((change) => ({
                name: change.name,
                price_inr: change.priceInr ?? change.currentInr,
                price_usd: change.priceUsd ?? change.currentUsd,
                duration_months: change.durationMonths ?? change.currentDurationMonths,
              })),
            },
          },
        );
      }
      case 'report.orders':
      case 'report.overview':
      case 'report.audit': {
        const kind =
          plan.action === 'report.orders'
            ? 'orders'
            : plan.action === 'report.audit'
              ? 'audit'
              : 'overview';
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
    if (verifySavedPrice(plan, result.after) === false) {
      return log(
        {
          ok: false,
          status: 'failure',
          message: `The server reported success, but the saved price could not be verified. Reload the dashboard and check "${plan.target?.name ?? 'the record'}" before trying again.`,
          verified: false,
        },
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

/* ------------------------------------------------------------------ */
/* Conversation state                                                 */
/* ------------------------------------------------------------------ */

/**
 * The next invisible context after a plan is shown, so short replies land on the
 * right question. This is the single place that decides what Joy is waiting for,
 * so no reply is ever interpreted without checking the pending question first.
 */
export const nextAdminContext = (
  plan: AdminCommandPlan,
  previous: AdminConversationContext = {},
): AdminConversationContext => {
  const language = plan.language ?? previous.language;
  /* Every context this function hands out is time-boxed (see ADMIN_CONTEXT_TTL_MS). */
  const expiresAt = Date.now() + ADMIN_CONTEXT_TTL_MS;

  /*
   * A real listing (— never a metadata read) becomes the paging context, so
   * "next page" repeats the same filters with the next offset.
   */
  const paging: Pick<AdminConversationContext, 'lastQuery' | 'page'> =
    plan.action === 'catalogue.list' && plan.catalogue
      ? { lastQuery: plan.catalogue, page: Math.max(1, plan.catalogue.page ?? 1) }
      : { lastQuery: previous.lastQuery, page: previous.page };

  /*
   * Joy listed options and asked the admin to choose one. The whole list is
   * remembered so "2", "the first one" or a theme name picks from it, and the
   * amount the admin already proposed is kept rather than discarded. The pending
   * operation travels with it, so a numbered reply for a delete/publish stays
   * that operation.
   */
  if (plan.awaiting === 'theme' && (plan.options?.length ?? 0) > 0) {
    const chosen =
      plan.pendingTheme ??
      (plan.target && (plan.target.kind === 'theme' || plan.target.kind === 'product')
        ? { id: plan.target.id, name: plan.target.name, kind: plan.target.kind }
        : undefined);
    return {
      language,
      awaiting: 'theme',
      options: plan.options,
      pendingAmount: plan.pendingAmount ?? previous.pendingAmount,
      /* Only an operation THIS question is about travels forward — a stale
       * delete from an abandoned question must never attach to a new list. */
      pendingAction: plan.pendingAction,
      lastTier: plan.tier ?? previous.lastTier,
      lastTheme: chosen ?? previous.lastTheme,
      ...paging,
      expiresAt,
    };
  }

  /*
   * Joy asked which record should get an amount. The amount is kept so the name
   * reply (or a tier) completes the same change.
   */
  if (plan.awaiting === 'target') {
    return {
      language,
      awaiting: 'target',
      pendingAmount: plan.pendingAmount ?? previous.pendingAmount,
      lastTheme: previous.lastTheme,
      lastTier: previous.lastTier,
      ...paging,
      expiresAt,
    };
  }

  /*
   * Joy resolved exactly one theme/product and asked for its new price. The
   * entry is remembered so a bare "59" completes that one change.
   */
  if (plan.awaiting === 'price' && plan.pendingTheme) {
    return {
      language,
      awaiting: 'price',
      pendingTheme: plan.pendingTheme,
      lastTheme: plan.pendingTheme,
      lastTier: previous.lastTier,
      ...paging,
      expiresAt,
    };
  }

  if (plan.action?.startsWith('pricing.')) {
    const tier = plan.tierChange?.tier ?? plan.tier ?? previous.pendingTier;
    return {
      language,
      lastTier: tier ?? previous.lastTier,
      awaiting: plan.awaiting,
      pendingTier: plan.awaiting === 'price' ? tier : undefined,
      /* Keep the amount while Joy asks which plan a price belongs to. */
      pendingAmount:
        plan.awaiting === 'tier' || plan.awaiting === 'plan' ? plan.pendingAmount : undefined,
      lastTheme: previous.lastTheme,
      ...paging,
      expiresAt,
    };
  }
  if (plan.status === 'ready' || plan.status === 'confirm') {
    /*
     * The turn resolved exactly one theme/product (or is asking to confirm one),
     * so the record is carried forward: "Set it to 59." or "what tags does it
     * have?" still refer to it until the conversation moves on. Only a real
     * theme/product target is remembered — never a synthetic tier, game or brand
     * target, which has no catalogue row behind it.
     */
    const target = plan.target;
    const resolved =
      plan.pendingTheme ??
      (target && (target.kind === 'theme' || target.kind === 'product')
        ? { id: target.id, name: target.name, kind: target.kind }
        : undefined);
    return {
      language,
      lastTheme: resolved ?? previous.lastTheme,
      pendingTheme: resolved ?? previous.pendingTheme,
      lastTier: previous.lastTier,
      ...paging,
      expiresAt,
    };
  }
  return { language, lastTier: previous.lastTier, ...paging, expiresAt };
};

/* Confirmation / cancellation words, matched on the reply's first word so a
 * real command that merely contains "no" or "ok" is never mistaken for a reply. */
const CONFIRM_HEADS = new Set([
  'yes', 'yeah', 'yep', 'yup', 'ya', 'ok', 'okay', 'sure', 'confirm', 'confirmed',
  'proceed', 'approve', 'approved', 'go', 'done', 'haan', 'han', 'ha', 'theek', 'thik', 'thike',
  'haanji', 'hanji', 'bilkul', 'zaroor',
]);
const CANCEL_HEADS = new Set([
  'no', 'nope', 'nah', 'nahi', 'nahin', 'nhi', 'nai', 'na', 'cancel', 'cancelled', 'canceled',
  'abort', 'chhodo', 'chhod', 'rehne', 'mat', 'stop',
]);
const CONFIRM_TAILS = new Set([
  'please', 'it', 'that', 'this', 'the', 'change', 'now', 'karo', 'kar', 'do', 'abhi',
  'ahead', 'ji', 'hai', 'saab', 'thing',
]);

/**
 * Reads a text confirmation or cancellation ("yes", "confirm", "haan", "no",
 * "cancel", "nahi", "no cancel"). Returns null when the message is not a
 * confirmation reply, so a normal command is never swallowed. Only the leading
 * word (plus a few filler words) is inspected — "disable the Game Zone" is not a
 * confirmation, but "yes, confirm it" is.
 */
export const parseAdminConfirmation = (raw: string): 'confirm' | 'cancel' | null => {
  const tokens = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const head = tokens[0];
  const verdict = CONFIRM_HEADS.has(head) ? 'confirm' : CANCEL_HEADS.has(head) ? 'cancel' : null;
  if (!verdict) return null;
  /* Anything beyond confirmation filler means this is a fresh command, not a reply. */
  const isFiller = (token: string) =>
    CONFIRM_TAILS.has(token) || CONFIRM_HEADS.has(token) || CANCEL_HEADS.has(token);
  return tokens.slice(1).every(isFiller) ? verdict : null;
};

