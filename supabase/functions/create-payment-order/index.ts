// Creates a payment order whose amount is derived from the server-side price
// table — the client only names the theme/plan and currency.
//
// The browser cannot supply an amount: those are read from `theme_prices`
// (admin-managed) or `studio_plan_prices` (admin-managed) here. A free item
// never reaches a gateway.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/auth.ts";
import { loadThemePrices, type Currency } from "../_shared/pricing.ts";
import { resolveOrderAmount } from "../_shared/paymentOrderCore.ts";
import { loadStudioPlans } from "../_shared/plans.ts";
import {
  createPayPalOrder,
  createRazorpayOrder,
  createStripeCheckoutSession,
} from "../_shared/payments.ts";

interface OrderRequest {
  theme_id?: string;
  plan_id?: string;
  currency?: Currency;
  /** Preferred international provider. Defaults to PayPal. */
  provider?: "paypal" | "stripe";
}

/** True when the gateway rejected our server credentials (needs owner action). */
const isCredentialFailure = (message: string): boolean =>
  /authentication failed|unauthorized|invalid api key|invalid key|bad request.*key|key_id/i.test(message);

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST")
    return errorResponse("Method not allowed", 405, req);

  try {
    const body = (await req.json().catch(() => null)) as OrderRequest | null;
    if (!body || typeof body !== "object") {
      return jsonResponse(
        { success: false, code: "INVALID_REQUEST", error: "A JSON body is required" },
        400,
        req,
      );
    }

    // Prices come from the DB (admin-managed), falling back to shipped defaults.
    const supabase = createAdminClient();
    const currency = (body.currency === "USD" ? "USD" : "INR") as Currency;

    // Subscription plan order
    if (body.plan_id) {
      const plans = await loadStudioPlans(supabase);
      const plan = plans[String(body.plan_id).trim()];
      if (!plan) {
        return jsonResponse(
          { success: false, code: "UNKNOWN_PLAN", error: "Unknown plan" },
          400,
          req,
        );
      }
      const amount = currency === "USD" ? plan.priceUsd : plan.priceInr;
      if (!(amount > 0)) {
        return jsonResponse(
          { success: false, code: "FREE_PLAN", error: "This plan is not chargeable" },
          400,
          req,
        );
      }

      const planId = plan.id;
      const description = `ReportCard Studio ${plan.name} (${plan.durationMonths} months)`;

      if (currency === "INR") {
        const keyId = Deno.env.get("RAZORPAY_KEY_ID");
        if (!keyId) {
          return jsonResponse(
            {
              success: false,
              code: "PAYMENT_CONFIG",
              error:
                "Razorpay is not configured on the server. The site owner must set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
            },
            503,
            req,
          );
        }
        const order = await createRazorpayOrder(amount, `rcs_${planId}`.slice(0, 40), {
          plan_id: planId,
        });
        return jsonResponse(
          {
            success: true,
            provider: "razorpay",
            key_id: keyId,
            order_id: order.id,
            amount: order.amount,
            currency: order.currency,
            plan_id: planId,
          },
          200,
          req,
        );
      }

      if (body.provider === "stripe") {
        const origin = (req.headers.get("origin") ?? "").replace(/\/$/, "");
        const base = origin || "https://ishmaverse.vercel.app";
        const session = await createStripeCheckoutSession(
          amount,
          description,
          `${base}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
          `${base}/studio/pricing`,
        );
        return jsonResponse(
          {
            success: true,
            provider: "stripe",
            session_id: session.id,
            url: session.url,
            amount: session.amount,
            currency: "USD",
            plan_id: planId,
          },
          200,
          req,
        );
      }

      const order = await createPayPalOrder(amount, description);
      return jsonResponse(
        {
          success: true,
          provider: "paypal",
          order_id: order.id,
          amount: order.amount,
          currency: order.currency,
          plan_id: planId,
        },
        200,
        req,
      );
    }

    const prices = await loadThemePrices(supabase);

    /*
     * Authoritative amount. `resolveOrderAmount` rejects an unknown theme, a free
     * theme and an unchargeable price BEFORE any gateway call, so a manipulated
     * request can never buy a paid card for ₹0 or create a ₹0 order.
     */
    const resolved = resolveOrderAmount(prices, body.theme_id, body.currency);
    if (!resolved.ok) {
      return jsonResponse(
        { success: false, code: resolved.code, error: resolved.message },
        resolved.status,
        req,
      );
    }

    const { amount } = resolved;
    const themeId = String(body.theme_id).trim();

    // India → Razorpay (UPI, PhonePe, GPay, Amazon Pay, BHIM, netbanking, cards…).
    if (currency === "INR") {
      const keyId = Deno.env.get("RAZORPAY_KEY_ID");
      if (!keyId) {
        return jsonResponse(
          {
            success: false,
            code: "PAYMENT_CONFIG",
            error:
              "Razorpay is not configured on the server. The site owner must set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.",
          },
          503,
          req,
        );
      }

      const order = await createRazorpayOrder(amount, `iszma_${themeId}`.slice(0, 40), {
        theme_id: themeId,
      });

      return jsonResponse(
        {
          success: true,
          provider: "razorpay",
          key_id: keyId,
          order_id: order.id,
          amount: order.amount,
          currency: order.currency,
        },
        200,
        req,
      );
    }

    // International → Stripe (hosted card checkout) when requested.
    if (body.provider === "stripe") {
      const origin = (req.headers.get("origin") ?? "").replace(/\/$/, "");
      const base = origin || "https://ishmaverse.vercel.app";

      const session = await createStripeCheckoutSession(
        amount,
        `isZma greeting card (${themeId})`,
        `${base}/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
        `${base}/section/greetings`,
      );

      return jsonResponse(
        {
          success: true,
          provider: "stripe",
          session_id: session.id,
          url: session.url,
          amount: session.amount,
          currency: "USD",
        },
        200,
        req,
      );
    }

    // International default → PayPal.
    const order = await createPayPalOrder(amount, `isZma greeting card (${themeId})`);
    return jsonResponse(
      {
        success: true,
        provider: "paypal",
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
      },
      200,
      req,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("create-payment-order failed:", message);

    if (/not configured/i.test(message)) {
      return jsonResponse(
        {
          success: false,
          code: "PAYMENT_CONFIG",
          error:
            "The payment provider is not configured on the server. The site owner must set its API credentials.",
        },
        503,
        req,
      );
    }

    /*
     * A gateway credential rejection is an owner problem, not a buyer problem:
     * say so, never echo the upstream body, and never claim money moved. No order
     * was created, so nothing can have been charged.
     */
    if (isCredentialFailure(message)) {
      return jsonResponse(
        {
          success: false,
          code: "PAYMENT_CONFIG",
          error:
            "The payment provider rejected the server credentials, so no payment was started and nothing was charged. The site owner needs to update the Razorpay keys, then try again.",
        },
        503,
        req,
      );
    }

    return jsonResponse(
      {
        success: false,
        code: "ORDER_FAILED",
        error: "Could not start the payment. Please try again.",
        retryable: true,
      },
      502,
      req,
    );
  }
});
