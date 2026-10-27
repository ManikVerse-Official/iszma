// Server-side pricing is the single source of truth for what a theme costs.
//
// Prices are loaded from the `theme_prices` table (managed from the Admin Panel)
// so an admin can set INR and USD prices without a redeploy. The table is
// authoritative; the constants below are only an emergency fallback used when
// the table is missing or empty (e.g. before the first migration run).
//
// The client never supplies an amount — the Edge Function derives it here, so a
// tampered request cannot buy an Elite card for ₹1.

export interface ThemePrice {
  inr: number;
  usd: number;
}

export const USD_INR_RATE = 85;
export const MINIMUM_USD = 1;

export type Currency = "INR" | "USD";
export type ThemePriceMap = Map<string, ThemePrice>;

/** Emergency fallback only — the `theme_prices` table overrides these. */
export const FALLBACK_THEME_PRICES: Record<string, ThemePrice> = {
  // The one free welcome card. It is listed explicitly (price 0) so the payment
  // server can answer "this card is free" instead of "unknown theme" — and so
  // no gateway order is ever attempted for it.
  "free-basic-wish": { inr: 0, usd: 0 },
  // Romantic
  "romantic-rose-note": { inr: 47, usd: 2 },
  "romantic-candlelight": { inr: 79, usd: 3 },
  "romantic-forever-us": { inr: 109, usd: 4 },
  "romantic-eternal-love": { inr: 157, usd: 6 },
  // Birthday
  "birthday-bash": { inr: 47, usd: 2 },
  "birthday-balloon-drop": { inr: 79, usd: 3 },
  "birthday-golden-year": { inr: 109, usd: 4 },
  "birthday-royal-celebration": { inr: 157, usd: 6 },
  // Marriage & Anniversary
  "marriage-sweet-vows": { inr: 47, usd: 2 },
  "marriage-blessing-bells": { inr: 79, usd: 3 },
  "marriage-golden-anniversary": { inr: 109, usd: 4 },
  "marriage-royal-wedding": { inr: 157, usd: 6 },
  // Festivals
  "festival-diya-glow": { inr: 47, usd: 2 },
  "festival-rang-barsay": { inr: 79, usd: 3 },
  "festival-christmas-snow": { inr: 109, usd: 4 },
  "festival-new-year-countdown": { inr: 157, usd: 6 },
  // Functions & Events
  "event-simple-congrats": { inr: 47, usd: 2 },
  "event-farewell-memories": { inr: 79, usd: 3 },
  "event-griha-pravesh": { inr: 109, usd: 4 },
  "event-topper-spotlight": { inr: 157, usd: 6 },
  // Family & Friends
  "family-thank-you": { inr: 47, usd: 2 },
  "family-get-well-soon": { inr: 79, usd: 3 },
  "family-new-baby": { inr: 109, usd: 4 },
  "family-milestone-cheer": { inr: 157, usd: 6 },
  // Light / elegant editions
  "birthday-blush-garden": { inr: 109, usd: 4 },
  "marriage-ivory-invitation": { inr: 109, usd: 4 },
  // Legacy themes still accepted for admin-generated cards.
  Birthday: { inr: 47, usd: 2 },
  Valentine: { inr: 47, usd: 2 },
};

export const inrToUsd = (inr: number): number =>
  Math.max(MINIMUM_USD, Number((inr / USD_INR_RATE).toFixed(2)));

/** Minimal shape we need from a Supabase client (avoids a hard import). */
type PriceQueryClient = { from: (table: string) => any };

/**
 * Loads the authoritative price map: DB rows first, fallback constants for any
 * theme the table does not cover (including custom themes added later).
 */
export const loadThemePrices = async (client: PriceQueryClient): Promise<ThemePriceMap> => {
  const prices: ThemePriceMap = new Map(Object.entries(FALLBACK_THEME_PRICES));

  try {
    const { data, error } = await client
      .from("theme_prices")
      .select("theme_id, price_inr, price_usd");

    if (!error && Array.isArray(data)) {
      for (const row of data) {
        const themeId = row?.theme_id ? String(row.theme_id) : "";
        const inr = Number(row?.price_inr);
        if (!themeId || !Number.isFinite(inr) || inr < 0) continue;
        const usd = Number(row?.price_usd);
        prices.set(themeId, {
          inr,
          usd: Number.isFinite(usd) && usd > 0 ? usd : inrToUsd(inr),
        });
      }
    }
  } catch {
    /* table missing / offline — fall back to the defaults above */
  }

  return prices;
};

export const getThemePriceInr = (
  prices: ThemePriceMap,
  themeId: string,
): number | null => prices.get(themeId)?.inr ?? null;

/** Expected settlement amount for a theme in the requested currency. */
export const expectedAmount = (
  prices: ThemePriceMap,
  themeId: string,
  currency: Currency,
): number | null => {
  const price = prices.get(themeId);
  if (!price) return null;
  return currency === "INR" ? price.inr : price.usd;
};

/**
 * The currency a payment actually settles in, decided by the provider rather
 * than the client. Razorpay always settles INR; PayPal and Stripe settle USD,
 * which removes any chance of a client-supplied currency breaking verification.
 */
export const settlementCurrency = (provider: string, requested: Currency): Currency => {
  if (provider === "razorpay") return "INR";
  if (provider === "paypal" || provider === "stripe") return "USD";
  return requested; // demo / admin fall back to the requested currency
};
