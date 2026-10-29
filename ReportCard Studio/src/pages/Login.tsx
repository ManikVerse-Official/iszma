import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  LogIn,
  ShieldCheck,
  ArrowRight,
  LogOut,
  Crown,
  Sparkles,
  RefreshCw,
  Loader2,
} from 'lucide-react';
import clsx from 'clsx';
import { STUDIO_PLANS, getPlanById, FREE_USE_LIMIT, type StudioPlan } from '../config/plans';
import { fetchLivePlans } from '../services/planPricing';
import { createSubscriptionOrder } from '../services/entitlementApi';
import { useEntitlement } from '../store/entitlementStore';

/** Razorpay's checkout script, loaded on demand. */
const RAZORPAY_SDK = 'https://checkout.razorpay.com/v1/checkout.js';

const loadRazorpayScript = (): Promise<boolean> =>
  new Promise((resolve) => {
    if ((window as { Razorpay?: unknown }).Razorpay) {
      resolve(true);
      return;
    }
    const script = document.createElement('script');
    script.src = RAZORPAY_SDK;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });

interface RazorpayCallbackResponse {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

/**
 * Sign in and (optionally) subscribe.
 *
 * Signing in is what ties the free tries and the plan to a person, so the owner
 * can see whose plan is running out — and so clearing browser storage cannot
 * hand out another free run. With Supabase connected, the server is the source
 * of truth for admin access, remaining tries and the active plan.
 */
export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const {
    signIn,
    signOut,
    registerPaidPlan,
    refreshFromServer,
    account,
    planActive,
    planId,
    planExpiresAt,
    isAdmin,
    freeUsesRemaining,
  } = useEntitlement();

  const nextPath = params.get('next') || '/dashboard';
  const requestedPlan = getPlanById(params.get('plan'))?.id ?? null;

  const [name, setName] = useState(account?.name ?? '');
  const [email, setEmail] = useState(account?.email ?? '');
  const [selectedPlan, setSelectedPlan] = useState(requestedPlan ?? STUDIO_PLANS[2].id);
  /* Live prices from the server; the bundled plans are the fallback. */
  const [plans, setPlans] = useState<StudioPlan[]>(STUDIO_PLANS);
  const [busy, setBusy] = useState(false);
  const [busyNote, setBusyNote] = useState('');
  const [error, setError] = useState('');
  const [justSubscribed, setJustSubscribed] = useState(false);

  const activePlan = plans.find((plan) => plan.id === planId);

  // Keep the plan status fresh whenever this screen is opened.
  useEffect(() => {
    void refreshFromServer();
  }, [refreshFromServer]);

  useEffect(() => {
    let active = true;
    void fetchLivePlans().then((live) => {
      if (active) setPlans(live);
    });
    return () => {
      active = false;
    };
  }, []);

  const submitSignIn = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Please enter your name.');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }
    setError('');
    // Signing in never activates a plan — the chosen plan still has to be paid
    // for on the next screen (its card is pre-selected).
    signIn(name, email);
    navigate(nextPath, { replace: true });
  };

  /**
   * Subscribe: order → Razorpay checkout → server-verified activation.
   *
   * The amount is never sent from the browser: `create-payment-order` prices the
   * plan from `studio_plan_prices`. The subscription is recorded only from the
   * checkout callback, and even then only after the server re-verifies the
   * signature and the captured amount.
   */
  const subscribe = async () => {
    const plan = plans.find((p) => p.id === selectedPlan);
    if (!plan) return;

    setError('');
    setJustSubscribed(false);

    if (!(plan.priceInr > 0)) {
      setError('This plan is not chargeable. Please pick another plan.');
      return;
    }

    setBusy(true);
    setBusyNote('Preparing secure checkout…');
    try {
      const order = await createSubscriptionOrder(plan.id, 'INR');
      if (!order.ok) throw new Error(order.error);

      const { key_id: keyId, order_id: orderId, amount, currency } = order.data;
      if (!keyId || !orderId) {
        throw new Error('The payment gateway did not return a usable order.');
      }

      const ready = await loadRazorpayScript();
      if (!ready) throw new Error('The Razorpay checkout could not be loaded. Please retry.');

      setBusyNote('Waiting for your payment…');
      await new Promise<void>((resolve, reject) => {
        const razorpay = new (
          window as unknown as {
            Razorpay: new (options: Record<string, unknown>) => { open: () => void };
          }
        ).Razorpay({
          key: keyId,
          amount,
          currency,
          order_id: orderId,
          name: 'ReportCard Studio',
          description: `${plan.name} · ${plan.durationMonths} months`,
          handler: (response: RazorpayCallbackResponse) => {
            setBusyNote('Verifying your payment…');
            void registerPaidPlan(plan.id, {
              provider: 'razorpay',
              order_id: response.razorpay_order_id,
              payment_id: response.razorpay_payment_id,
              signature: response.razorpay_signature,
            }).then((result) => {
              if (result.ok) {
                setJustSubscribed(true);
                resolve();
                return;
              }
              reject(new Error(result.error ?? 'The payment could not be verified.'));
            });
          },
          modal: {
            ondismiss: () => reject(new Error('Checkout was closed before the payment completed.')),
          },
          prefill: { name: account?.name ?? '', email: account?.email ?? '' },
          theme: { color: '#7c3aed' },
        }).open();
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not complete the payment.');
    } finally {
      setBusy(false);
      setBusyNote('');
    }
  };

  /* ── Signed out: the sign-in form ───────────────────────────────────── */
  if (!account) {
    return (
      <div className="max-w-lg mx-auto mt-6 space-y-4">
        <form onSubmit={submitSignIn} className="card">
          <div className="card-header flex items-center gap-2">
            <LogIn className="h-5 w-5 text-brand-600" />
            <h2 className="text-lg font-semibold text-ink-900">Sign in to ReportCard Studio</h2>
          </div>
          <div className="card-body space-y-4">
            <p className="text-sm text-ink-600">
              Your {FREE_USE_LIMIT} free report-card generations, your plan and your receipts are
              tied to this account.
            </p>
            <div>
              <label className="label" htmlFor="login-name">
                Your name *
              </label>
              <input
                id="login-name"
                className="input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Priya Sharma"
                autoComplete="name"
              />
            </div>
            <div>
              <label className="label" htmlFor="login-email">
                Email *
              </label>
              <input
                id="login-email"
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@school.com"
                autoComplete="email"
              />
              <p className="text-xs text-ink-500 mt-1">
                Your receipt, renewal reminders and plan notices are sent here.
              </p>
            </div>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            <button
              type="submit"
              className="w-full inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700"
            >
              Continue <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </form>
      </div>
    );
  }

  /* ── Signed in: account, plan status and plan chooser ───────────────── */
  return (
    <div className="max-w-2xl mx-auto mt-6 space-y-4">
      <div className="card">
        <div className="card-body flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-ink-700 space-y-1">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              <span>
                Signed in as <strong>{account.email}</strong>
              </span>
            </div>
            {isAdmin ? (
              <div className="text-brand-700 font-semibold">Admin access — unlimited &amp; free.</div>
            ) : planActive && activePlan ? (
              <div className="text-emerald-700 font-semibold">
                {activePlan.name} — unlimited report cards until{' '}
                {planExpiresAt ? new Date(planExpiresAt).toLocaleDateString() : '—'}.
              </div>
            ) : (
              <div>
                <strong>{freeUsesRemaining}</strong> of {FREE_USE_LIMIT} free generations left.
              </div>
            )}
          </div>
          <button
            onClick={() => {
              signOut();
              navigate('/login', { replace: true });
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-4 py-2 text-sm font-semibold text-ink-700 hover:bg-slate-100"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </div>

      {justSubscribed && (
        <div className="card border-emerald-300 bg-emerald-50">
          <div className="card-body text-sm text-emerald-800 flex items-center gap-2">
            <Crown className="h-4 w-4" />
            Your plan is activated. A confirmation with your bill has been emailed to{' '}
            <strong>{account.email}</strong>.
          </div>
        </div>
      )}

      {!isAdmin && (
        <div className="card">
          <div className="card-header">
            <h3 className="font-semibold text-ink-900">
              {planActive ? 'Change plan' : 'Subscribe for unlimited report cards'}
            </h3>
            <p className="text-sm text-ink-500 mt-1">
              Each plan shows its own billing period (live server prices). Prices set by isZma.
            </p>
          </div>
          <div className="card-body space-y-3">
            {plans.map((p) => {
              const current = planActive && planId === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setSelectedPlan(p.id)}
                  disabled={current}
                  className={clsx(
                    'w-full flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                    current
                      ? 'border-emerald-300 bg-emerald-50 cursor-default'
                      : selectedPlan === p.id
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-slate-200 hover:border-slate-300',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block font-semibold text-ink-900">
                      {p.name}
                      {p.recommended && (
                        <span className="ml-2 text-[10px] font-bold uppercase text-brand-700">
                          Most popular
                        </span>
                      )}
                    </span>
                    <span className="block text-xs text-ink-500">{p.tagline}</span>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block font-bold text-ink-900">₹{p.priceInr}</span>
                    <span className="block text-[11px] text-ink-500">
                      ${p.priceUsd} · {p.durationMonths} mo
                    </span>
                  </span>
                </button>
              );
            })}

            <div className="flex flex-col sm:flex-row gap-3 pt-1">
              <button
                onClick={() => void subscribe()}
                disabled={busy || (planActive && planId === selectedPlan)}
                className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700 disabled:opacity-60"
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                {busy
                  ? busyNote || 'Working…'
                  : planActive
                    ? 'Switch to this plan'
                    : `Subscribe · ₹${plans.find((p) => p.id === selectedPlan)?.priceInr ?? ''}`}
              </button>
              <button
                onClick={() => void refreshFromServer()}
                disabled={busy}
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-slate-300 text-ink-700 font-semibold hover:bg-slate-50 disabled:opacity-60"
                title="Re-check the plan on the server"
              >
                <RefreshCw className="h-4 w-4" /> Refresh
              </button>
              <button
                onClick={() => navigate('/dashboard')}
                disabled={busy}
                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-slate-300 text-ink-700 font-semibold hover:bg-slate-50 disabled:opacity-60"
              >
                Go to dashboard
              </button>
            </div>

            <p className="text-xs text-ink-500">
              Paying by UPI, card, net banking or wallet (Razorpay, in ₹). Your plan is activated
              only after the payment is verified — if the payment does not complete, no plan is
              granted.
            </p>

            {error && (
              <p className="text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
