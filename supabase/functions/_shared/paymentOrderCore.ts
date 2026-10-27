// Pure order-amount rules for `create-payment-order`.
//
// The browser chooses a theme and a currency — never an amount. This module
// resolves the payable amount from the authoritative price map and rejects the
// cases that must never reach a gateway:
//
//   • an unknown / unpublished theme,
//   • a free theme (no Razorpay order for ₹0 — the free flow mints the card),
//   • a price that is not chargeable in the requested currency.
//
// It is pure so the rules can be unit-tested in Node (see
// scripts/check-greeting-payments.mjs) as well as executed in the Edge Function.

import { expectedAmount, type Currency, type ThemePriceMap } from "./pricing.ts";

export type OrderErrorCode =
  | "UNKNOWN_THEME"
  | "FREE_THEME"
  | "PRICE_NOT_CONFIGURED"
  | "INVALID_REQUEST";

export interface OrderAmountOk {
  ok: true;
  /** Amount in the major unit (₹ or $). */
  amount: number;
  /** Amount in the gateway's minor unit (paise / cents). */
  minorUnits: number;
  currency: Currency;
}

export interface OrderAmountFail {
  ok: false;
  status: number;
  code: OrderErrorCode;
  message: string;
}

export type OrderAmountResult = OrderAmountOk | OrderAmountFail;

/** Gateway limits: Razorpay needs at least ₹1; USD providers need at least $0.50. */
export const MINIMUM_CHARGE: Record<Currency, number> = { INR: 1, USD: 0.5 };
/** Upper sanity bound, matching the admin price limit. */
export const MAXIMUM_CHARGE = 1_000_000;

/** ₹47 → 4700 paise; $4.99 → 499 cents. */
export const toMinorUnits = (amount: number, currency: Currency): number => {
  const rounded = Math.round(Number(amount) * 100) / 100;
  return currency === "INR" ? Math.round(rounded * 100) : Math.round(rounded * 100);
};

/**
 * Resolves the authoritative amount for a theme order.
 *
 * No client-supplied amount is accepted anywhere in this path; the caller only
 * passes the price map it loaded from `theme_prices` and the requested currency.
 */
export const resolveOrderAmount = (
  prices: ThemePriceMap,
  rawThemeId: unknown,
  rawCurrency: unknown,
): OrderAmountResult => {
  const themeId = typeof rawThemeId === "string" ? rawThemeId.trim() : "";
  if (!themeId) {
    return { ok: false, status: 400, code: "INVALID_REQUEST", message: "Unknown theme" };
  }

  const currency: Currency = rawCurrency === "USD" ? "USD" : "INR";
  const amount = expectedAmount(prices, themeId, currency);

  if (amount === null || !Number.isFinite(amount)) {
    return { ok: false, status: 400, code: "UNKNOWN_THEME", message: "Unknown theme" };
  }

  /*
   * A zero price is the free welcome card (or a theme the admin has not priced).
   * Either way no gateway order may be created: the free path mints the card, and
   * for any other theme the honest answer is that it is not purchasable yet.
   */
  if (amount <= 0) {
    return {
      ok: false,
      status: 402,
      code: "FREE_THEME",
      message:
        "This card is free — no payment is required. Use the free welcome card flow to publish it.",
    };
  }

  if (amount < MINIMUM_CHARGE[currency]) {
    return {
      ok: false,
      status: 400,
      code: "PRICE_NOT_CONFIGURED",
      message:
        currency === "INR"
          ? "This card's price is below the minimum Razorpay amount. Please contact support."
          : "This card's price is below the minimum card payment amount. Please contact support.",
    };
  }

  if (amount > MAXIMUM_CHARGE) {
    return {
      ok: false,
      status: 400,
      code: "PRICE_NOT_CONFIGURED",
      message: "This card's price is not valid for checkout. Please contact support.",
    };
  }

  return { ok: true, amount, minorUnits: toMinorUnits(amount, currency), currency };
};
