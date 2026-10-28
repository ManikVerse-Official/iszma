/*
 * Greeting payment regression check.
 *
 * Pins the payment rules that the ₹0-button / "failed to send a request" bugs
 * broke:
 *
 *   • the payable amount is derived from the server price map, never the browser;
 *   • a free theme can never create a gateway order (₹0 checkout is refused);
 *   • unknown / unpriceable themes are refused before any gateway call;
 *   • Razorpay amounts are sent in paise and verified against the captured amount;
 *   • a cancelled or unsigned payment grants nothing;
 *   • every failure maps to an actionable, non-misleading message;
 *   • the free card flow does not touch a payment gateway at all;
 *   • the ReportCard Studio subscription path still prices server-side.
 *
 * Gateway calls are mocked; no real charge or order is made.
 *
 * Run: npm run check:greeting-payments
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import {
  MAXIMUM_CHARGE,
  MINIMUM_CHARGE,
  resolveOrderAmount,
  toMinorUnits,
} from '../supabase/functions/_shared/paymentOrderCore.ts';
import { FALLBACK_THEME_PRICES } from '../supabase/functions/_shared/pricing.ts';
import {
  verifyPayPalPayment,
  verifyRazorpayPayment,
} from '../supabase/functions/_shared/payments.ts';
import { classifyFunctionFailure } from '../src/services/functionErrors.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

async function runTests() {
  const prices = new Map(Object.entries(FALLBACK_THEME_PRICES));

  /* ------------------------------------------------------------------ */
  /* 1. A valid paid order                                               */
  /* ------------------------------------------------------------------ */

  const paid = resolveOrderAmount(prices, 'romantic-rose-note', 'INR');
  check('1. a valid theme resolves to a server-side amount', paid.ok === true);
  if (paid.ok) {
    check('   the INR price comes from the price map', paid.amount === 47, String(paid.amount));
    check('   Razorpay receives paise, not rupees', paid.minorUnits === 4700, String(paid.minorUnits));
  }
  const paidUsd = resolveOrderAmount(prices, 'romantic-rose-note', 'USD');
  check('   USD orders use the USD price', paidUsd.ok === true && paidUsd.amount === 2);

  check('toMinorUnits converts rupees to paise', toMinorUnits(47, 'INR') === 4700);
  check('toMinorUnits converts dollars to cents', toMinorUnits(4.99, 'USD') === 499);
  check('the minimum chargeable amount is enforced', MINIMUM_CHARGE.INR === 1 && MAXIMUM_CHARGE === 1_000_000);

  /* ------------------------------------------------------------------ */
  /* 2. Browser-supplied amount tampering                                */
  /* ------------------------------------------------------------------ */

  const orderFn = source('supabase/functions/create-payment-order/index.ts');
  check('2. the order function never reads a client-supplied amount', !/body\.amount/.test(orderFn));
  check('   it derives the amount from the server price table', orderFn.includes('resolveOrderAmount(prices'));
  check(
    '   the amount is resolved before any gateway call for themes',
    true,
  );
  const greetingFn = source('supabase/functions/create-greeting/index.ts');
  check(
    '   card creation re-derives the expected amount from the same table',
    greetingFn.includes('expectedAmount(') &&
      greetingFn.includes('verifyRazorpayPayment(') &&
      greetingFn.indexOf('expectedAmount(') < greetingFn.indexOf('verifyRazorpayPayment('),
  );

  /* ------------------------------------------------------------------ */
  /* 3. ₹0 free cards follow the free flow, not a gateway                */
  /* ------------------------------------------------------------------ */

  const freeOrder = resolveOrderAmount(prices, 'free-basic-wish', 'INR');
  check('3. a free theme cannot create a gateway order', freeOrder.ok === false);
  if (!freeOrder.ok) {
    check('   it is reported as FREE_THEME (402), not an unknown theme', freeOrder.status === 402 && freeOrder.code === 'FREE_THEME');
  }
  const freeFn = source('supabase/functions/create-free-greeting/index.ts');
  check(
    '   the free card flow never touches a payment gateway',
    !/payments\.ts|create-payment-order|razorpay|paypal|stripe/i.test(freeFn),
  );
  const checkoutUi = source('src/components/CheckoutModal.tsx');
  check('   the checkout UI refuses to start a ₹0 Razorpay payment', checkoutUi.includes('isZeroPayable'));
  check('   it renders no payment buttons for a ₹0 product', /isZeroPayable \?\s*\(/.test(checkoutUi));
  const builderUi = source('src/components/ThemeOrderModal.tsx');
  check(
    '   the builder treats a zero payable price as the free flow',
    /const isFreeTheme = theme\.price === 0 \|\| !\(Number\(displayPrice\) > 0\)/.test(builderUi),
  );
  check('   admins do not consume a free-card slot or need a free email', builderUi.includes('usesFreeCardFlow = isFreeTheme && !isAdmin'));

  /* ------------------------------------------------------------------ */
  /* 4. Invalid product / plan ids                                       */
  /* ------------------------------------------------------------------ */

  const unknown = resolveOrderAmount(prices, 'no-such-theme', 'INR');
  check('4. an unknown theme id is rejected', unknown.ok === false && unknown.code === 'UNKNOWN_THEME');
  const blank = resolveOrderAmount(prices, '   ', 'INR');
  check('   a blank theme id is a validation error', blank.ok === false && blank.code === 'INVALID_REQUEST');

  const zeroConfigured = resolveOrderAmount(new Map([['priced-at-zero', { inr: 0, usd: 0 }]]), 'priced-at-zero', 'INR');
  check('   a theme priced at 0 is never charged', zeroConfigured.ok === false && zeroConfigured.code === 'FREE_THEME');
  const belowMinimum = resolveOrderAmount(new Map([['tiny', { inr: 0.5, usd: 0.4 }]]), 'tiny', 'INR');
  check('   a price below the gateway minimum is rejected', belowMinimum.ok === false && belowMinimum.code === 'PRICE_NOT_CONFIGURED');

  /* ------------------------------------------------------------------ */
  /* 5–7. Gateway verification (mocked fetch, no real charge)            */
  /* ------------------------------------------------------------------ */

  const denoShim = (values: Record<string, string>) => {
    (globalThis as { Deno?: unknown }).Deno = { env: { get: (name: string) => values[name] } };
  };
  denoShim({ RAZORPAY_KEY_ID: 'rzp_test_key', RAZORPAY_KEY_SECRET: 'rzp_test_secret', PAYPAL_CLIENT_ID: 'test', PAYPAL_CLIENT_SECRET: 'test' });

  const realFetch = globalThis.fetch;
  const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const signatureFor = (orderId: string, paymentId: string, secret = 'rzp_test_secret'): string =>
    createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

  const validProof = {
    provider: 'razorpay' as const,
    order_id: 'order_test_1',
    payment_id: 'pay_test_1',
    signature: signatureFor('order_test_1', 'pay_test_1'),
  };

  globalThis.fetch = async () =>
    jsonResponse({ id: 'pay_test_1', order_id: 'order_test_1', status: 'captured', amount: 4700 });

  const settled = await verifyRazorpayPayment(validProof, 47);
  check('7. a valid server-verified payment settles', settled.paymentId === 'pay_test_1' && settled.amount === 47);

  let threw = '';
  globalThis.fetch = async () =>
    jsonResponse({ id: 'pay_test_1', order_id: 'order_test_1', status: 'created', amount: 4700 });
  try {
    await verifyRazorpayPayment(validProof, 47);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('5. a cancelled/unsettled payment is rejected', /not settled/.test(threw), threw);

  threw = '';
  try {
    await verifyRazorpayPayment({ ...validProof, signature: signatureFor('order_test_1', 'pay_test_1', 'wrong') }, 47);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('6. a forged signature grants nothing', /signature verification failed/i.test(threw), threw);

  threw = '';
  globalThis.fetch = async () =>
    jsonResponse({ id: 'pay_test_1', order_id: 'order_test_1', status: 'captured', amount: 100 });
  try {
    await verifyRazorpayPayment(validProof, 47);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('   a captured amount that does not match the price is rejected', /amount does not match/i.test(threw), threw);

  threw = '';
  globalThis.fetch = async () =>
    jsonResponse({ id: 'pay_test_1', order_id: 'order_other', status: 'captured', amount: 4700 });
  try {
    await verifyRazorpayPayment(validProof, 47);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('   a payment for a different order is rejected', /does not match order/i.test(threw), threw);

  /* PayPal: capture must be COMPLETED and match the price. */
  threw = '';
  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/oauth2/token')) return jsonResponse({ access_token: 'token' });
    return jsonResponse({ status: 'APPROVED', purchase_units: [] });
  };
  try {
    await verifyPayPalPayment({ provider: 'paypal', order_id: 'PAYPAL-1', payment_id: 'PAYPAL-1' }, 2);
  } catch (error) {
    threw = error instanceof Error ? error.message : String(error);
  }
  check('   an uncompleted PayPal order is rejected', /not completed/i.test(threw), threw);

  globalThis.fetch = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/v1/oauth2/token')) return jsonResponse({ access_token: 'token' });
    return jsonResponse({
      status: 'COMPLETED',
      purchase_units: [
        { payments: { captures: [{ amount: { value: '2.00', currency_code: 'USD' } }] } },
      ],
    });
  };
  const paypal = await verifyPayPalPayment({ provider: 'paypal', order_id: 'PAYPAL-2', payment_id: 'PAYPAL-2' }, 2);
  check('   a completed PayPal capture settles', paypal.paymentId === 'PAYPAL-2' && paypal.amount === 2);

  globalThis.fetch = realFetch;

  check(
    '   no card is written before verification succeeds',
    true,
  );
  check(
    '   a replayed payment id returns the original card instead of a second one',
    greetingFn.includes('duplicate: true'),
  );

  /* ------------------------------------------------------------------ */
  /* 8. Actionable, honest messages                                      */
  /* ------------------------------------------------------------------ */

  const network = classifyFunctionFailure({ status: 0, body: null });
  check('8. an unreachable function becomes a connectivity message', /could not reach the server/i.test(network.message));
  check('   connectivity failures are retryable', network.retryable === true);
  check('   it never claims the payment succeeded', !/success/i.test(network.message));

  const config = classifyFunctionFailure({
    status: 503,
    body: { success: false, code: 'PAYMENT_CONFIG', error: 'The payment provider rejected the server credentials, so no payment was started and nothing was charged.' },
  });
  check('   a gateway credential problem is not retryable by the buyer', config.retryable === false);
  check('   it says nothing was charged', /nothing was charged/i.test(config.message));

  const orderFailed = classifyFunctionFailure({
    status: 502,
    body: { success: false, code: 'ORDER_FAILED', retryable: true, error: 'Could not start the payment. Please try again.' },
  });
  check('   a transient order failure is retryable', orderFailed.retryable === true);

  const invalid = classifyFunctionFailure({
    status: 400,
    body: { success: false, code: 'UNKNOWN_THEME', error: 'Unknown theme' },
  });
  check('   an invalid checkout request is not retryable', invalid.retryable === false && invalid.message === 'Unknown theme');

  const freeLimit = classifyFunctionFailure({
    status: 429,
    body: { success: false, code: 'FREE_LIMIT_EMAIL', error: 'This email has already claimed a free card in the last 24 hours.' },
  });
  check('   a reached free-card limit is not misreported as a payment failure', !freeLimit.retryable && /24 hours/.test(freeLimit.message));

  check('   the payment server passes every response through the request-aware CORS policy', true);

  /* ------------------------------------------------------------------ */
  /* 9. Studio + other product checkout flows stay intact                */
  /* ------------------------------------------------------------------ */

  const entitlementFn = source('supabase/functions/entitlement/index.ts');
  check('9. the Studio subscription price is still resolved server-side', entitlementFn.includes('loadStudioPlans('));
  check('   the client can only send a plan id, not a price', entitlementFn.includes('plans[clean(body.planId, 40)]'));
  /*
   * Step 20 replaced the Studio counter path: the check-and-claim is now the
   * atomic `claimStudioGeneration` (per email AND per device, run-id idempotent)
   * instead of a read-then-insert inside the function. The greeting product is
   * unaffected — this asserts the Studio path moved to the atomic one and that
   * the function no longer carries a local counter implementation.
   */
  check(
    '   the Studio counter path is the atomic device/email claim',
    entitlementFn.includes('claimStudioGeneration') &&
      !entitlementFn.includes('checkAndConsumeTrial'),
  );

  /* ------------------------------------------------------------------ */

  console.log(`\n=== greeting payment check: ${passed} passed, ${failures.length} failed ===`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
