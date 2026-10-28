// ReportCard Studio plans — server-side pricing.
//
// `studio_plan_prices` (migration 20261023_step17) is the authoritative source:
// an admin changes a plan price through Admin Joy → `admin-ops`, and every
// server path that records money reads it back from that table.
//
// The constants below are only a fallback for two situations: the database has
// not been migrated yet, or the read fails. They also define which plan ids
// exist, so a stray row cannot introduce a plan the product does not have.
//
// Keep these ids in sync with the frontend
// `ReportCard Studio/src/config/plans.ts`. The client only ever sends a plan id;
// the price recorded for a subscription is resolved here so a tampered request
// cannot buy the Holistic plan for ₹1.

export interface StudioPlan {
  id: string;
  name: string;
  priceInr: number;
  priceUsd: number;
  durationMonths: number;
}

export const STUDIO_PLANS: Record<string, StudioPlan> = {
  simple: { id: "simple", name: "Simple Academic", priceInr: 369, priceUsd: 4.99, durationMonths: 6 },
  modern: { id: "modern", name: "Modern School", priceInr: 578, priceUsd: 6.99, durationMonths: 6 },
  holistic: { id: "holistic", name: "Holistic Progress", priceInr: 859, priceUsd: 10.99, durationMonths: 6 },
};

export const STUDIO_PLAN_IDS = Object.keys(STUDIO_PLANS) as string[];

export const getStudioPlan = (id: string): StudioPlan | null =>
  STUDIO_PLANS[id] ?? null;

const toNumber = (value: unknown, fallback: number): number => {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : fallback;
};

/**
 * Reads the live plan prices and merges them over the shipped defaults.
 *
 * Only known plan ids are accepted, so an unexpected row never becomes a
 * purchasable plan. A database error is logged and the defaults are used — the
 * checkout path stays available, and it stays consistent with the constants
 * rather than inventing a price.
 */
export const loadStudioPlans = async (
  client: { from: (table: string) => any },
): Promise<Record<string, StudioPlan>> => {
  const merged: Record<string, StudioPlan> = { ...STUDIO_PLANS };
  try {
    const { data, error } = await client
      .from("studio_plan_prices")
      .select("plan_id, name, price_inr, price_usd, duration_months");
    if (error) {
      console.error("studio_plan_prices read failed, using shipped defaults:", error.message);
      return merged;
    }
    for (const row of (data ?? []) as Record<string, unknown>[]) {
      const id = String(row.plan_id ?? "");
      const fallback = merged[id];
      if (!fallback) continue;
      const duration = Math.round(toNumber(row.duration_months, fallback.durationMonths));
      merged[id] = {
        id,
        name: typeof row.name === "string" && row.name.trim() ? row.name.trim() : fallback.name,
        priceInr: toNumber(row.price_inr, fallback.priceInr),
        priceUsd: toNumber(row.price_usd, fallback.priceUsd),
        // The DB check constraint already bounds this; clamp here too so a
        // hand-edited row can never produce a zero-month subscription.
        durationMonths: Math.min(36, Math.max(1, duration)),
      };
    }
    return merged;
  } catch (error) {
    console.error(
      "studio_plan_prices read threw, using shipped defaults:",
      error instanceof Error ? error.message : String(error),
    );
    return merged;
  }
};

/**
 * Free-use limits per feature.
 *   perEmail — how many times one email address may claim this feature for free.
 *   perIpEmails — how many DISTINCT emails may claim it from one IP address.
 *   perIpTotal — hard cap on total free claims from one IP (0 = unlimited).
 *   windowHours — when set, `perEmail` is a ROLLING window of this many hours;
 *     when absent the per-email allowance is a lifetime one (Studio generations).
 *
 * These stay in code on purpose: they are enforced by the usage counters inside
 * `_shared/entitlement.ts`, and making them writable needs its own coordinated
 * migration and audit design. Admin Joy reports them as read-only.
 */
export interface FreeLimit {
  perEmail: number;
  perIpEmails: number;
  perIpTotal: number;
  windowHours?: number;
}

export const FREE_LIMITS: Record<string, FreeLimit> = {
  /*
   * One free greeting card per email per ROLLING 24 hours (not midnight-reset),
   * and at most two free cards from one network in total. The rolling window is
   * applied by the atomic `consume_free_greeting` database function so two
   * concurrent requests cannot both claim the same slot.
   */
  free_greeting: { perEmail: 1, perIpEmails: 2, perIpTotal: 2, windowHours: 24 },
  /*
   * ReportCard Studio: SEVEN free generations per email AND per device, enforced
   * atomically by `consume_studio_generation` (migration 20261026_step20).
   *
   * The per-IP caps are deliberately 0 (off) here: the device identity replaced
   * them, because a per-IP cap punished a whole school behind one NAT and was
   * redundant once each browser is counted. Changing the email keeps draining
   * the device allowance and vice versa; the fingerprint caps in
   * `_shared/studioLimits.ts` cover "clear storage and start again".
   */
  studio_generation: { perEmail: 7, perIpEmails: 0, perIpTotal: 0 },
};
