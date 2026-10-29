/*
 * ReportCard Studio subscription payment regression check.
 *
 * Pins the security rules on both sides of the flow:
 *   SERVER
 *     • a paid plan cannot be activated without payment proof
 *     • forged/invalid payment signatures are rejected
 *     • mismatched amounts are rejected
 *     • replayed payments cannot activate twice
 *     • admin grants are separate
 *     • there is no demo/mock provider that can activate a plan
 *   CLIENT
 *     • "Subscribe" asks the server for a gateway order first
 *     • the Razorpay checkout modal is opened from the returned order
 *     • activation only happens with a verified payment proof
 *     • no local (pre-payment) activation path exists
 *
 * Source-string based: no browser and no gateway call is made.
 *
 * Run: npm run check:subscription-payments
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

/** The text between `start` and the next `end` marker ('' when not found). */
function sliceBetween(text: string, start: string, end: string): string {
  const from = text.indexOf(start);
  if (from === -1) return '';
  const to = text.indexOf(end, from);
  return to === -1 ? text.slice(from) : text.slice(from, to);
}

function runTests() {
  const entitlementFn = source('supabase/functions/entitlement/index.ts');
  const orderFn = source('supabase/functions/create-payment-order/index.ts');
  const plansFn = source('supabase/functions/_shared/plans.ts');

  /* ------------------------------ server ---------------------------------- */

  check('entitlement requires payment for paid plans', entitlementFn.includes('Payment is required to activate this plan'));
  check('entitlement verifies Razorpay payments', entitlementFn.includes('verifyRazorpayPayment'));
  check('entitlement verifies PayPal payments', entitlementFn.includes('verifyPayPalPayment'));
  check('entitlement verifies Stripe payments', entitlementFn.includes('verifyStripePayment'));
  check('entitlement blocks replayed payments', entitlementFn.includes('This payment has already been used'));

  /*
   * A repeated checkout callback is NOT a second order. When the payment is in
   * the ledger and the plan it bought is still active, the server answers 200
   * (idempotent success) instead of 409, so a network retry never tells a paying
   * customer their purchase failed. The early return also happens before the
   * email block, so the retry cannot send a second confirmation.
   */
  const replayBlock = sliceBetween(entitlementFn, 'const { data: existingTx }', 'let settlement: any;');
  check(
    'a replayed payment answers success when the plan is still active',
    replayBlock.includes('alreadyActive: true') && replayBlock.includes('duplicate: true'),
  );
  check(
    'the replay path returns before any activation or email',
    !replayBlock.includes('studio_subscriptions\n          .upsert') &&
      !replayBlock.toLowerCase().includes('sendemail'),
  );
  check(
    'Stripe proof does not require an order_id (a session id is the order)',
    /proof\.provider === "stripe" \|\|/.test(entitlementFn),
  );
  check(
    'the subscription ledger keeps Stripe amounts in USD',
    /proof\.provider === "paypal" \|\| proof\.provider === "stripe" \? "USD"/.test(entitlementFn),
  );
  check('entitlement checks payment amount matches plan', entitlementFn.includes('Payment amount does not match the selected plan'));
  check('entitlement uses server-side plan prices', entitlementFn.includes('loadStudioPlans'));
  check('create-payment-order supports plan_id for subscriptions', orderFn.includes('plan_id'));
  check('create-payment-order loads studio plans for subscriptions', orderFn.includes('loadStudioPlans'));
  check('studio plan prices are server-authoritative', plansFn.includes('studio_plan_prices'));

  // §4 mock clean-up: the subscribe action has no demo/mock provider branch.
  check(
    'entitlement has no demo payment provider for subscriptions',
    !/provider ===\s*["']demo["']/.test(entitlementFn),
  );

  /* ------------------------------ client ---------------------------------- */

  const api = source('ReportCard Studio/src/services/entitlementApi.ts');
  const store = source('ReportCard Studio/src/store/entitlementStore.ts');
  const login = source('ReportCard Studio/src/pages/Login.tsx');

  // The module exported by services/supabase.ts is { invokeFunction,
  // invokeFunctionResult, isSupabaseConfigured } — importing `supabase` from it
  // was a dead, type-invalid call that silently swallowed the 402.
  check(
    'entitlementApi does not import a non-existent supabase client',
    !/import\s*\{[^}]*\bsupabase\b[^}]*\}\s*from/.test(api),
  );
  check(
    'entitlementApi reaches create-payment-order for plans',
    api.includes("invokeFunctionResult<OrderResponse>('create-payment-order'") &&
      api.includes('plan_id: planId'),
  );
  check(
    'entitlementApi surfaces the server failure instead of a silent null',
    api.includes('invokeFunctionResult') && /if \(!result\.ok\) return result;/.test(api),
  );
  check(
    'subscribeOnServer forwards the payment proof',
    /subscribeOnServer[\s\S]*?action: 'subscribe'[\s\S]*?payment,/.test(api),
  );

  // §1 + §2: order first, then the Razorpay modal.
  const subscribeBody = sliceBetween(login, 'const subscribe = async () => {', '/* ── Signed out');
  check('Login has a subscribe handler', subscribeBody.length > 0);
  check(
    'Login requests a gateway order before anything else',
    subscribeBody.includes('createSubscriptionOrder(plan.id, \'INR\')'),
  );
  check(
    'Login loads and opens the Razorpay checkout',
    login.includes('https://checkout.razorpay.com/v1/checkout.js') &&
      subscribeBody.includes('.Razorpay(') &&
      subscribeBody.includes('order_id: orderId'),
  );
  check(
    'the Razorpay callback carries the signature the server verifies',
    subscribeBody.includes('razorpay_signature') &&
      subscribeBody.includes("provider: 'razorpay'"),
  );
  check(
    'the order of operations is order → checkout → register',
    subscribeBody.indexOf('createSubscriptionOrder') < subscribeBody.indexOf('.Razorpay(') &&
      subscribeBody.indexOf('.Razorpay(') < subscribeBody.indexOf('registerPaidPlan'),
  );

  // §3: activation is server-verified only.
  check('the store exposes no local activation action', !store.includes('activatePlan'));
  check(
    'the store sends the payment proof to the server',
    store.includes('subscribeOnServer(account.email, planId, account.name, payment)'),
  );
  check(
    'the store only records a plan the server confirmed active',
    /if \(!server\.planActive\)[\s\S]*?return \{ ok: false/.test(store),
  );
  check(
    'a stale local plan cannot survive a server "not active"',
    !/planActive:.*\|\|\s*s\.planActive/.test(store),
  );
  check('Login never activates a plan directly', !login.includes('activatePlan'));
  check(
    'signing in no longer activates the requested plan',
    !/if \(requestedPlan\)[\s\S]{0,120}?registerPaidPlan/.test(login),
  );

  console.log(`\n=== subscription payment check: ${passed} passed, ${failures.length} failed ===`);
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

runTests();
