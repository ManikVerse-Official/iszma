import { isSupabaseConfigured, supabase } from './supabase';

/**
 * ReportCard Studio plan prices, read from the authoritative table.
 *
 * `studio_plan_prices` (migration 20261023_step17) is what the server charges:
 * `entitlement` records a subscription from this row, and Admin Joy changes it
 * through `admin-ops`. Reading it here means Admin Joy shows the same numbers
 * the checkout uses instead of a second copy of the prices.
 *
 * Returns null when the table cannot be read (no Supabase, not migrated, network
 * error). The caller must report that honestly rather than guessing a price.
 */
export interface StudioPlanPrice {
  id: string;
  name: string;
  priceInr: number;
  priceUsd: number;
  durationMonths: number;
}

const toNumber = (value: unknown): number | null => {
  const numeric = typeof value === 'string' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : null;
};

export const loadStudioPlanPrices = async (): Promise<StudioPlanPrice[] | null> => {
  if (!isSupabaseConfigured()) return null;
  try {
    const { data, error } = await supabase
      .from('studio_plan_prices')
      .select('plan_id, name, price_inr, price_usd, duration_months');
    if (error || !Array.isArray(data)) {
      console.warn(
        'studio_plan_prices could not be read:',
        error?.message ?? 'unexpected response',
      );
      return null;
    }
    const plans: StudioPlanPrice[] = [];
    for (const row of data as Record<string, unknown>[]) {
      const id = typeof row.plan_id === 'string' ? row.plan_id : '';
      const priceInr = toNumber(row.price_inr);
      const priceUsd = toNumber(row.price_usd);
      const durationMonths = toNumber(row.duration_months);
      if (!id || priceInr === null || priceUsd === null || durationMonths === null) continue;
      plans.push({
        id,
        name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : id,
        priceInr,
        priceUsd,
        durationMonths: Math.min(36, Math.max(1, Math.round(durationMonths))),
      });
    }
    return plans.length > 0 ? plans : null;
  } catch (error) {
    console.warn(
      'studio_plan_prices could not be read:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};
