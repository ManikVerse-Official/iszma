import { STUDIO_PLANS, type StudioPlan } from '../config/plans';
import { invokeFunction, isSupabaseConfigured } from './supabase';

/**
 * Live ReportCard Studio plan pricing.
 *
 * The prices below in `config/plans.ts` are only a fallback. The authoritative
 * values live in the `studio_plan_prices` table, which `entitlement` reads when
 * it records a subscription — so the amount a visitor is shown here is the amount
 * the server charges. An admin changes those rows through Ishmaverse Admin Joy.
 *
 * `showPlans` starts from the bundled plans (so the page renders instantly) and
 * replaces any price the server reports. Every failure keeps the bundled value
 * instead of inventing one.
 */

interface LivePlan {
  id: string;
  name?: string;
  priceInr?: number;
  priceUsd?: number;
  durationMonths?: number;
}

interface PlansResponse {
  success: boolean;
  plans?: LivePlan[];
}

const positive = (value: unknown): number | null => {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
};

export const fetchLivePlans = async (): Promise<StudioPlan[]> => {
  if (!isSupabaseConfigured()) return STUDIO_PLANS;
  const data = await invokeFunction<PlansResponse>('entitlement', { action: 'plans' });
  if (!data?.success || !Array.isArray(data.plans) || data.plans.length === 0) {
    return STUDIO_PLANS;
  }
  return STUDIO_PLANS.map((plan) => {
    const live = data.plans?.find((row) => row.id === plan.id);
    if (!live) return plan;
    const priceInr = positive(live.priceInr);
    const priceUsd = positive(live.priceUsd);
    const duration = positive(live.durationMonths);
    return {
      ...plan,
      name: typeof live.name === 'string' && live.name.trim() ? live.name.trim() : plan.name,
      priceInr: priceInr ?? plan.priceInr,
      priceUsd: priceUsd ?? plan.priceUsd,
      durationMonths: duration ? Math.min(36, Math.max(1, Math.round(duration))) : plan.durationMonths,
    };
  });
};
