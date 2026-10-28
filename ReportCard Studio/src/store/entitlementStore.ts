import { create } from 'zustand';
import { FREE_USE_LIMIT } from '../config/plans';
import {
  claimServerGeneration,
  fetchServerEntitlement,
  registerDevice,
  releaseServerClaim,
  subscribeOnServer,
  type PaymentProof,
} from '../services/entitlementApi';
import { isSupabaseConfigured } from '../services/supabase';

/**
 * Entitlement: who is using ReportCard Studio, how many free generations are
 * left, and whether they hold a subscription or owner access.
 *
 * Rules:
 *   • generating requires a signed-in account (name + email) so free tries can
 *     be attributed;
 *   • a normal user gets FREE_USE_LIMIT free generations, counted by the SERVER
 *     per email AND per registered device — clearing storage, changing the email,
 *     logging out or using a second device does not restore an allowance;
 *   • admins are unlimited, and admin status is only ever learned from the
 *     server (a verified Supabase session + `admin_users`). There is deliberately
 *     no local email list or client flag any more.
 *
 * The local copy of the counters is a CACHE for the UI. `beginGeneration()`
 * always asks the server before a run, so a tampered local value cannot grant a
 * free generation.
 */

export interface Account {
  name: string;
  email: string;
}

interface PersistedEntitlement {
  account: Account | null;
  freeUsesRemaining: number;
  freeLimit: number;
  planId: string | null;
  planStartedAt: string | null;
  planExpiresAt: string | null;
}

const STORAGE_KEY = 'rcs:entitlement';
const DEVICE_ID_KEY = 'rcs:device-id';
const DEVICE_TOKEN_KEY = 'rcs:device-token';

const DEFAULT_STATE: PersistedEntitlement = {
  account: null,
  freeUsesRemaining: FREE_USE_LIMIT,
  freeLimit: FREE_USE_LIMIT,
  planId: null,
  planStartedAt: null,
  planExpiresAt: null,
};

function loadState(): PersistedEntitlement {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<PersistedEntitlement>;
    return {
      ...DEFAULT_STATE,
      ...parsed,
      freeLimit: FREE_USE_LIMIT,
      freeUsesRemaining:
        typeof parsed.freeUsesRemaining === 'number'
          ? Math.max(0, Math.min(FREE_USE_LIMIT, parsed.freeUsesRemaining))
          : FREE_USE_LIMIT,
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function persist(state: PersistedEntitlement): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* ignore quota / private mode */
  }
}

function isPaidActive(state: PersistedEntitlement): boolean {
  if (!state.planId || !state.planExpiresAt) return false;
  if (state.planId === 'admin') return true;
  return new Date(state.planExpiresAt).getTime() > Date.now();
}

/* ── device identity ──────────────────────────────────────────────────── */

/**
 * A random id for this browser. It is only a *hint* to the server: the server
 * stores an HMAC of it and hands back a signed token, so an invented id gets no
 * allowance (see supabase/functions/_shared/studioLimits.ts).
 */
function deviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[A-Za-z0-9_-]{16,80}$/.test(existing)) return existing;
    const created = makeId();
    localStorage.setItem(DEVICE_ID_KEY, created);
    return created;
  } catch {
    // Storage blocked (private mode): still send a usable id for this page view.
    return makeId();
  }
}

function makeId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '');
    }
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through */
  }
  return `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function loadDeviceToken(): string | null {
  try {
    const token = localStorage.getItem(DEVICE_TOKEN_KEY);
    return token && token.trim() ? token.trim() : null;
  } catch {
    return null;
  }
}

function persistDeviceToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(DEVICE_TOKEN_KEY, token);
    else localStorage.removeItem(DEVICE_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/** A run id: unique per generation run, so a retry cannot count twice. */
const newRunId = (): string => makeId().slice(0, 40);

export interface GenerationGate {
  allowed: boolean;
  /** True when the run uses a free generation (or an unverified fallback). */
  isFree: boolean;
  reason?: string;
  /** Machine-readable server code, e.g. FREE_LIMIT_DEVICE. */
  code?: string;
  /** True when the ONLY way forward is a subscription. */
  upgrade?: boolean;
  /** Retryable (server unreachable) rather than a reached limit. */
  retryable?: boolean;
  /** Server claim to hand back if the run fails. */
  claimId?: string | null;
}

export interface EntitlementState extends PersistedEntitlement {
  /** Server-confirmed owner/staff access (unlimited, no free-try drain). */
  isAdmin: boolean;
  planActive: boolean;
  /** Remaining generations for the email / for this device (server values). */
  emailRemaining: number;
  deviceRemaining: number;
  deviceRegistered: boolean;

  signIn: (name: string, email: string) => void;
  signOut: () => void;
  /**
   * Records a subscription that the gateway has already charged.
   *
   * The plan is only marked active when the server verifies the payment proof
   * and confirms it; there is deliberately no way to activate a plan locally.
   */
  registerPaidPlan: (
    planId: string,
    payment: PaymentProof,
  ) => Promise<{ ok: boolean; error?: string }>;
  /**
   * Asks the server for permission to run one generation.
   *
   * For a normal user this CLAIMS one of the seven there and then (atomically,
   * against the email and the device). Pass the returned `claimId` to
   * `finishGeneration` so a failed run gives the generation back.
   */
  beginGeneration: () => Promise<GenerationGate>;
  /** Reports the outcome of a claimed run. */
  finishGeneration: (claimId: string | null | undefined, succeeded: boolean) => Promise<void>;
  /** Pulls the authoritative plan + free uses from the server (no-op offline). */
  refreshFromServer: () => Promise<void>;
}

const initial = loadState();

export const useEntitlement = create<EntitlementState>((set, get) => ({
  ...initial,
  /*
   * Admin is NOT decided here. It starts false and only the server can set it:
   * the old local email list meant a bundle constant could look like access.
   */
  isAdmin: false,
  planActive: isPaidActive(initial),
  emailRemaining: initial.freeUsesRemaining,
  deviceRemaining: initial.freeUsesRemaining,
  deviceRegistered: false,

  signIn: (name, email) => {
    const account = { name: name.trim(), email: email.trim() };
    const next: PersistedEntitlement = { ...get(), account };
    persist(next);
    set({ ...next });
    // Pull the authoritative plan + remaining tries for this address.
    void get().refreshFromServer();
  },

  signOut: () => {
    const next: PersistedEntitlement = { ...get(), account: null };
    persist(next);
    /* Signing out does not reset the device allowance — it is not ours to
     * reset, and the cached admin/plan flags must not survive it. */
    set({ ...next, isAdmin: false, planActive: false, planId: null, planExpiresAt: null });
  },

  registerPaidPlan: async (planId, payment) => {
    const account = get().account;
    if (!account?.email) return { ok: false, error: 'Sign in before subscribing.' };

    /*
     * The server is the only thing that can activate a plan: it verifies the
     * gateway signature, the captured amount and that the payment has not been
     * used before. A rejection (e.g. HTTP 402 "Payment is required to activate
     * this plan") is surfaced instead of being treated as a success.
     */
    const result = await subscribeOnServer(account.email, planId, account.name, payment);
    if (!result.ok) return { ok: false, error: result.error };

    const server = result.data;
    if (!server.planActive) {
      return { ok: false, error: 'The payment was not confirmed, so the plan was not activated.' };
    }

    set((s) => {
      const merged: PersistedEntitlement = {
        ...s,
        planId: server.planId ?? planId,
        planStartedAt: new Date().toISOString(),
        planExpiresAt: server.expiresAt,
      };
      persist(merged);
      return { ...merged, planActive: true, isAdmin: server.isAdmin || s.isAdmin };
    });
    return { ok: true };
  },

  beginGeneration: async () => {
    const state = get();
    const account = state.account;

    if (!account?.email) {
      return {
        allowed: false,
        isFree: false,
        reason: 'Sign in to generate report cards — free generations are counted per account.',
      };
    }

    /*
     * Offline / dev build: with no server to ask, the local cache decides. Note
     * that this branch is the ONLY place a cached admin/plan flag is trusted —
     * online, the server always answers, so a stale local flag cannot buy a
     * generation.
     */
    if (!isSupabaseConfigured()) {
      if (state.isAdmin) return { allowed: true, isFree: true };
      if (isPaidActive(state)) return { allowed: true, isFree: false };
      if (state.freeUsesRemaining <= 0) {
        return {
          allowed: false,
          isFree: false,
          upgrade: true,
          code: 'FREE_LIMIT_EMAIL',
          reason: `Your ${FREE_USE_LIMIT} free report-card generations are used up. Subscribe to keep generating.`,
        };
      }
      const next: PersistedEntitlement = {
        ...state,
        freeUsesRemaining: Math.max(0, state.freeUsesRemaining - 1),
      };
      persist(next);
      set(next);
      return { allowed: true, isFree: true };
    }

    const email = account.email;

    /* Register this browser once; the server signs the token it hands back. */
    let token = loadDeviceToken();
    if (!token) {
      const registration = await registerDevice(email, deviceId());
      if (registration) {
        token = registration.token;
        persistDeviceToken(token);
        set((s) => ({
          ...s,
          /* The server's answer, not ours: a token that no longer maps to an
           * admin account must not leave admin access behind. */
          isAdmin: registration.state.isAdmin,
          deviceRegistered: true,
        }));
      }
    }

    const attempt = async (deviceToken: string | null) =>
      claimServerGeneration(email, newRunId(), deviceToken);

    let decision = await attempt(token);

    /* A token the server does not recognise (rotated secret / restored backup)
     * is replaced once, then the run continues. */
    if (decision && !decision.allowed && decision.code === 'DEVICE_REQUIRED') {
      const registration = await registerDevice(email, deviceId());
      if (registration) {
        persistDeviceToken(registration.token);
        set((s) => ({ ...s, deviceRegistered: true }));
        decision = await attempt(registration.token);
      }
    }

    if (!decision) {
      // No answer at all: do not guess, and do not spend a free generation.
      return {
        allowed: false,
        isFree: false,
        retryable: true,
        code: 'USAGE_UNAVAILABLE',
        reason:
          'We could not verify your free generations right now, so nothing was generated. Please check your connection and try again.',
      };
    }

    set((s) => {
      const merged: PersistedEntitlement = {
        ...s,
        freeUsesRemaining: Math.min(FREE_USE_LIMIT, Math.max(0, decision!.remaining)),
        planId: decision!.admin
          ? 'admin'
          : decision!.planActive
            ? (s.planId ?? 'active')
            : s.planId,
        planExpiresAt: decision!.admin ? '9999-12-31T00:00:00.000Z' : s.planExpiresAt,
      };
      persist(merged);
      return {
        ...merged,
        /* Server-authoritative: the answer to THIS request decides, so a stale
         * local admin/plan flag can neither grant nor hide access. */
        isAdmin: decision!.admin,
        planActive: decision!.planActive || decision!.admin,
        emailRemaining: decision!.remainingEmail,
        deviceRemaining: decision!.remainingDevice,
      };
    });

    if (!decision.allowed) {
      return {
        allowed: false,
        isFree: !decision.planActive,
        reason: decision.reason,
        code: decision.code,
        upgrade: !decision.retryable,
        retryable: decision.retryable,
      };
    }

    return {
      allowed: true,
      isFree: !decision.admin && !decision.planActive,
      claimId: decision.claimId,
    };
  },

  finishGeneration: async (claimId, succeeded) => {
    if (!succeeded && claimId) {
      // The run produced nothing, so the claimed generation is given back.
      await releaseServerClaim(claimId);
      await get().refreshFromServer();
      return;
    }
    if (succeeded && isSupabaseConfigured()) await get().refreshFromServer();
  },

  refreshFromServer: async () => {
    const email = get().account?.email;
    if (!email || !isSupabaseConfigured()) return;
    const server = await fetchServerEntitlement(email, loadDeviceToken());
    if (!server) return;
    set((s) => {
      const merged: PersistedEntitlement = {
        ...s,
        // An active plan (or admin) is unlimited, so the free counter is moot.
        freeUsesRemaining:
          server.planActive || server.isAdmin
            ? s.freeUsesRemaining
            : Math.min(FREE_USE_LIMIT, Math.max(0, server.freeRemaining)),
        /*
         * The server is authoritative: when it reports no active plan, a stale
         * local `planActive` must be cleared rather than kept alive — otherwise
         * a persisted local plan could survive an unpaid/expired subscription.
         */
        planId: server.isAdmin ? 'admin' : server.planActive ? server.planId : null,
        planExpiresAt: server.isAdmin
          ? '9999-12-31T00:00:00.000Z'
          : server.planActive
            ? server.expiresAt
            : null,
        planStartedAt: server.planActive || server.isAdmin ? s.planStartedAt : null,
      };
      persist(merged);
      return {
        ...merged,
        /* Server-authoritative: a stale local admin or plan flag is cleared when
         * the server no longer reports it. */
        isAdmin: server.isAdmin,
        planActive: server.planActive || server.isAdmin,
        emailRemaining: server.emailRemaining,
        deviceRemaining: server.deviceRemaining,
        deviceRegistered: server.deviceRegistered,
      };
    });
  },
}));
