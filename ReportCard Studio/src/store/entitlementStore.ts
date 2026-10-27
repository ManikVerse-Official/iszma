import { create } from 'zustand';
import { FREE_USE_LIMIT, isAdminEmail } from '../config/plans';
import {
  consumeServerUse,
  fetchServerEntitlement,
  subscribeOnServer,
  type PaymentProof,
} from '../services/entitlementApi';
import { isSupabaseConfigured } from '../services/supabase';

/**
 * Entitlement: who is using ReportCard Studio, how many free generations they
 * have left, and whether they hold an active subscription.
 *
 * Rules:
 *   • generating requires a signed-in account (name + email) so free tries can
 *     be attributed and the owner can see whose plan is running out;
 *   • an account gets FREE_USE_LIMIT free generations, counted per generation
 *     run on the server (an IP that farms accounts is capped too);
 *   • admins (recognised server-side by email or IP) are always unlimited.
 *
 * The server is authoritative; the local copy is a cache so the UI stays
 * responsive and the tool keeps working without Supabase configured.
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

export interface EntitlementState extends PersistedEntitlement {
  /** Server-confirmed owner/staff access (unlimited, no free-try drain). */
  isAdmin: boolean;
  planActive: boolean;

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
  consumeUse: () => void;
  canGenerate: () => { allowed: boolean; isFree: boolean; reason?: string };
  /** Pulls the authoritative plan + free uses from the server (no-op offline). */
  refreshFromServer: () => Promise<void>;
}

const initial = loadState();

export const useEntitlement = create<EntitlementState>((set, get) => ({
  ...initial,
  // Local hint from the email; the server confirms/replaces it on sign-in.
  isAdmin: initial.account ? isAdminEmail(initial.account.email) : false,
  planActive: isPaidActive(initial),

  signIn: (name, email) => {
    const account = { name: name.trim(), email: email.trim() };
    const next: PersistedEntitlement = { ...get(), account };
    persist(next);
    set({ ...next, isAdmin: isAdminEmail(account.email) });
    // Pull the authoritative plan + remaining tries for this address.
    void get().refreshFromServer();
  },

  signOut: () => {
    const next: PersistedEntitlement = { ...get(), account: null };
    persist(next);
    set({ ...next, isAdmin: false });
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

  consumeUse: () => {
    const state = get();

    // Admins and active subscribers never drain the free counter.
    if (!state.isAdmin && !isPaidActive(state)) {
      const next: PersistedEntitlement = {
        ...state,
        freeUsesRemaining: Math.max(0, state.freeUsesRemaining - 1),
      };
      persist(next);
      set(next);
    }

    // Mirror the use on the server (best-effort; never blocks generation).
    const email = state.account?.email;
    if (email && isSupabaseConfigured()) {
      void consumeServerUse(email, 'studio_generation').then((result) => {
        if (!result || result.admin || typeof result.remaining !== 'number') return;
        set((s) => {
          const merged: PersistedEntitlement = {
            ...s,
            freeUsesRemaining: Math.min(FREE_USE_LIMIT, Math.max(0, result.remaining)),
          };
          persist(merged);
          return merged;
        });
      });
    }
  },

  refreshFromServer: async () => {
    const email = get().account?.email;
    if (!email || !isSupabaseConfigured()) return;
    const server = await fetchServerEntitlement(email);
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
        isAdmin: server.isAdmin || s.isAdmin,
        planActive: server.planActive || server.isAdmin,
      };
    });
  },

  canGenerate: () => {
    const state = get();
    // Owner/staff: always unlimited.
    if (state.isAdmin) return { allowed: true, isFree: true };
    // Every generation is tied to an account so plans + free tries are trackable.
    if (!state.account) {
      return {
        allowed: false,
        isFree: false,
        reason: 'Sign in to generate report cards — free generations are counted per account.',
      };
    }
    if (isPaidActive(state)) return { allowed: true, isFree: false };
    if (state.freeUsesRemaining > 0) return { allowed: true, isFree: true };
    return {
      allowed: false,
      isFree: false,
      reason: `Your ${FREE_USE_LIMIT} free report-card generations are used up. Subscribe to keep generating.`,
    };
  },
}));
