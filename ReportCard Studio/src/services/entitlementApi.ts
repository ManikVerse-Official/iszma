import {
  invokeFunction,
  invokeFunctionResult,
  isSupabaseConfigured,
  type FunctionResult,
} from './supabase';

/**
 * Server-side entitlement calls for ReportCard Studio.
 *
 * The `entitlement` Edge Function is the authoritative source for free uses,
 * subscriptions and admin access (by email or IP). When Supabase is not
 * configured every call returns null so the store falls back to its local
 * (dev / offline) behaviour.
 */

export interface ServerEntitlement {
  planActive: boolean;
  planId: string | null;
  expiresAt: string | null;
  freeUsed: number;
  freeRemaining: number;
  isAdmin: boolean;
  freeLimit: number;
}

interface StateResponse {
  success: boolean;
  planActive?: boolean;
  planId?: string | null;
  expiresAt?: string | null;
  freeUsed?: number;
  freeRemaining?: number;
  isAdmin?: boolean;
  freeLimit?: number;
}

const toEntitlement = (data: StateResponse, fallbackPlanId?: string): ServerEntitlement => ({
  planActive: Boolean(data.planActive),
  planId: data.planId ?? fallbackPlanId ?? null,
  expiresAt: data.expiresAt ?? null,
  freeUsed: Number(data.freeUsed ?? 0),
  freeRemaining: Number(data.freeRemaining ?? 0),
  isAdmin: Boolean(data.isAdmin),
  freeLimit: Number(data.freeLimit ?? 0),
});

export const fetchServerEntitlement = async (email: string): Promise<ServerEntitlement | null> => {
  if (!isSupabaseConfigured() || !email) return null;
  const data = await invokeFunction<StateResponse>('entitlement', { action: 'state', email });
  if (!data?.success) return null;
  return toEntitlement(data);
};

export interface ServerConsume {
  allowed: boolean;
  reason?: string;
  remaining: number;
  admin?: boolean;
}

export const consumeServerUse = async (
  email: string,
  feature: 'studio_generation' | 'free_greeting' = 'studio_generation',
): Promise<ServerConsume | null> => {
  if (!isSupabaseConfigured()) return null;
  const data = await invokeFunction<StateResponse & { allowed?: boolean; reason?: string; remaining?: number; admin?: boolean }>(
    'entitlement',
    { action: 'consume', email, feature },
  );
  if (!data?.success) return null;
  return {
    allowed: Boolean(data.allowed),
    reason: data.reason,
    remaining: Number(data.remaining ?? 0),
    admin: Boolean(data.admin),
  };
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
