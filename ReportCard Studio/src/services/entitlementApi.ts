import {
  invokeFunction,
  invokeFunctionResult,
  isSupabaseConfigured,
  type FunctionResult,
} from './supabase';

/**
 * Server-side entitlement calls for ReportCard Studio.
 *
 * The `entitlement` Edge Function is the only authority for free generations,
 * subscriptions and admin access. The browser contributes two things it cannot
 * fake the meaning of:
 *
 *   • a random `deviceId`, which the server turns into a signed device token
 *     (`registerDevice`) — the server stores an HMAC of it and never trusts a
 *     device id it has not signed;
 *   • a per-run id for each generation, so a retried request cannot be counted
 *     twice.
 *
 * Everything else — whether the caller is an admin, whether a plan is active,
 * how many generations are left — comes back from the server.
 */

export interface ServerEntitlement {
  planActive: boolean;
  planId: string | null;
  expiresAt: string | null;
  freeUsed: number;
  freeRemaining: number;
  emailRemaining: number;
  deviceRemaining: number;
  isAdmin: boolean;
  freeLimit: number;
  deviceRegistered: boolean;
}

interface StateResponse {
  success: boolean;
  planActive?: boolean;
  planId?: string | null;
  expiresAt?: string | null;
  freeUsed?: number;
  freeRemaining?: number;
  emailRemaining?: number;
  deviceRemaining?: number;
  isAdmin?: boolean;
  freeLimit?: number;
  deviceRegistered?: boolean;
  deviceToken?: string;
  error?: string;
  code?: string;
}

const toEntitlement = (data: StateResponse, fallbackPlanId?: string): ServerEntitlement => ({
  planActive: Boolean(data.planActive),
  planId: data.planId ?? fallbackPlanId ?? null,
  expiresAt: data.expiresAt ?? null,
  freeUsed: Number(data.freeUsed ?? 0),
  freeRemaining: Number(data.freeRemaining ?? 0),
  emailRemaining: Number(data.emailRemaining ?? data.freeRemaining ?? 0),
  deviceRemaining: Number(data.deviceRemaining ?? data.freeRemaining ?? 0),
  isAdmin: Boolean(data.isAdmin),
  freeLimit: Number(data.freeLimit ?? 0),
  deviceRegistered: Boolean(data.deviceRegistered),
});

/**
 * Coarse hints. They are sent ONLY so the server can bound how many browsers one
 * fingerprint may register; they are never an identity and never a limit.
 */
export interface DeviceHints {
  timeZone?: string;
  screen?: string;
  platform?: string;
  languages?: string;
}

export const deviceHints = (): DeviceHints => {
  try {
    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? '',
      screen: `${window.screen?.width ?? 0}x${window.screen?.height ?? 0}`,
      platform: navigator.platform ?? '',
      languages: (navigator.languages ?? []).slice(0, 4).join(','),
    };
  } catch {
    return {};
  }
};

/** Registers this browser and returns its signed device token. */
export const registerDevice = async (
  email: string,
  deviceId: string,
): Promise<{ token: string; state: ServerEntitlement } | null> => {
  if (!isSupabaseConfigured()) return null;
  const data = await invokeFunction<StateResponse>('entitlement', {
    action: 'device',
    email,
    deviceId,
    ...deviceHints(),
  });
  if (!data?.success || typeof data.deviceToken !== 'string') return null;
  return { token: data.deviceToken, state: toEntitlement(data) };
};

export const fetchServerEntitlement = async (
  email: string,
  deviceToken?: string | null,
): Promise<ServerEntitlement | null> => {
  if (!isSupabaseConfigured() || !email) return null;
  const data = await invokeFunction<StateResponse>('entitlement', {
    action: 'state',
    email,
    deviceToken: deviceToken ?? undefined,
  });
  if (!data?.success) return null;
  return toEntitlement(data);
};

export interface ServerConsume {
  allowed: boolean;
  reason?: string;
  code?: string;
  remaining: number;
  remainingEmail: number;
  remainingDevice: number;
  claimId: string | null;
  alreadyClaimed: boolean;
  admin: boolean;
  planActive: boolean;
  retryable: boolean;
}

type ConsumeResponse = StateResponse & {
  allowed?: boolean;
  reason?: string;
  remaining?: number;
  remainingEmail?: number;
  remainingDevice?: number;
  claimId?: string | null;
  alreadyClaimed?: boolean;
  admin?: boolean;
  retryable?: boolean;
};

/**
 * Asks the server for permission to run ONE generation and, for a free user,
 * claims it there and then. A refusal is final: the caller must not generate.
 */
export const claimServerGeneration = async (
  email: string,
  runId: string,
  deviceToken: string | null,
): Promise<ServerConsume | null> => {
  if (!isSupabaseConfigured()) return null;
  const data = await invokeFunction<ConsumeResponse>('entitlement', {
    action: 'consume',
    email,
    runId,
    deviceToken: deviceToken ?? undefined,
    ...deviceHints(),
  });
  if (!data?.success) return null;
  return {
    allowed: Boolean(data.allowed),
    reason: data.reason,
    code: data.code,
    remaining: Number(data.remaining ?? 0),
    remainingEmail: Number(data.remainingEmail ?? data.remaining ?? 0),
    remainingDevice: Number(data.remainingDevice ?? data.remaining ?? 0),
    claimId: typeof data.claimId === 'string' ? data.claimId : null,
    alreadyClaimed: Boolean(data.alreadyClaimed),
    admin: Boolean(data.admin),
    planActive: Boolean(data.planActive),
    retryable: Boolean(data.retryable),
  };
};

/**
 * Gives a claimed generation back (the run failed), so a failed batch does not
 * burn one of the seven.
 */
export const releaseServerClaim = async (claimId: string | null): Promise<void> => {
  if (!isSupabaseConfigured() || !claimId) return;
  await invokeFunction('entitlement', { action: 'release', claimId });
};

/** Gateway proof the server re-verifies before it activates a paid plan. */
export interface PaymentProof {
  provider: 'razorpay' | 'paypal';
  order_id: string;
  payment_id: string;
  /** Razorpay only: HMAC signature from the checkout callback. */
  signature?: string;
}

/** A gateway order the browser hands to its checkout SDK. */
export interface SubscriptionOrder {
  provider: 'razorpay' | 'paypal' | 'stripe';
  /** Razorpay public key (INR orders). */
  key_id?: string;
  order_id?: string;
  session_id?: string;
  url?: string;
  /** Razorpay amounts are in paise; other providers use major units. */
  amount: number;
  currency: string;
  plan_id: string;
}

type OrderResponse = SubscriptionOrder & { success?: boolean };

/**
 * Asks the server for a gateway order for a subscription plan.
 *
 * The browser never sends an amount: `create-payment-order` prices the plan from
 * `studio_plan_prices`. A failure keeps the server's own message (unpaid plan,
 * missing gateway keys, …) so the UI can report it instead of pretending the
 * subscription worked.
 */
export const createSubscriptionOrder = async (
  planId: string,
  currency: 'INR' | 'USD' = 'INR',
  provider?: 'paypal' | 'stripe',
): Promise<FunctionResult<SubscriptionOrder>> => {
  if (!isSupabaseConfigured()) {
    return {
      ok: false,
      status: 0,
      code: 'NOT_CONFIGURED',
      error: 'Payments are unavailable in this build.',
    };
  }
  const result = await invokeFunctionResult<OrderResponse>('create-payment-order', {
    plan_id: planId,
    currency,
    provider,
  });
  if (!result.ok) return result;
  if (!result.data?.success) {
    return {
      ok: false,
      status: 200,
      code: 'ORDER_FAILED',
      error: 'Could not start the payment. Please try again.',
    };
  }
  return { ok: true, data: result.data };
};

/**
 * Records a subscription on the server.
 *
 * A paid plan is only activated when `payment` carries gateway proof that
 * `entitlement` verifies (signature + captured amount + replay guard). Without
 * it the server answers 402 and no plan is granted.
 */
export const subscribeOnServer = async (
  email: string,
  planId: string,
  name?: string,
  payment?: PaymentProof,
): Promise<FunctionResult<ServerEntitlement>> => {
  if (!isSupabaseConfigured() || !email) {
    return {
      ok: false,
      status: 0,
      code: 'NOT_CONFIGURED',
      error: 'The Studio server is not configured in this build.',
    };
  }
  const result = await invokeFunctionResult<StateResponse>('entitlement', {
    action: 'subscribe',
    email,
    planId,
    name,
    payment,
  });
  if (!result.ok) return result;
  if (!result.data?.success) {
    return {
      ok: false,
      status: 200,
      code: 'SUBSCRIBE_FAILED',
      error: 'The subscription could not be activated.',
    };
  }
  return { ok: true, data: toEntitlement(result.data, planId) };
};
