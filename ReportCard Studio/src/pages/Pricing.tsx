import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Sparkles, Crown, GraduationCap } from 'lucide-react';
import clsx from 'clsx';
import { STUDIO_PLANS, FREE_USE_LIMIT, type StudioPlan } from '../config/plans';
import { fetchLivePlans } from '../services/planPricing';
import { useEntitlement } from '../store/entitlementStore';

const PLAN_ICONS: Record<string, typeof Sparkles> = {
  simple: GraduationCap,
  modern: Sparkles,
  holistic: Crown,
};

export default function Pricing() {
  const navigate = useNavigate();
  const { account, planActive, planId } = useEntitlement();
  const [currency, setCurrency] = useState<'INR' | 'USD'>('INR');
  /* Prices come from the server (studio_plan_prices); the bundle is the fallback. */
  const [plans, setPlans] = useState<StudioPlan[]>(STUDIO_PLANS);

  useEffect(() => {
    let active = true;
    void fetchLivePlans().then((live) => {
      if (active) setPlans(live);
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <section className="card">
        <div className="card-header text-center">
          <h2 className="text-xl font-semibold text-ink-900">Choose your ReportCard Studio plan</h2>
          <p className="text-sm text-ink-500 mt-1">
            Sign in and try it free for your first {FREE_USE_LIMIT} report-card generations. No card
            needed to start.
          </p>
          <div className="mt-4 inline-flex items-center gap-1 bg-slate-100 rounded-full p-1">
            {(['INR', 'USD'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setCurrency(c)}
                className={clsx(
                  'px-4 py-1.5 rounded-full text-sm font-semibold transition-colors',
                  currency === c ? 'bg-brand-600 text-white' : 'text-ink-600 hover:bg-white',
                )}
              >
                {c === 'INR' ? '₹ INR' : '$ USD'}
              </button>
            ))}
          </div>
        </div>
      </section>

      {account && planActive && (
        <div className="card border-brand-300 bg-brand-50">
          <div className="card-body text-sm text-brand-800">
            You're on the <strong>{plans.find((p) => p.id === planId)?.name ?? 'Studio'}</strong>{' '}
            plan — unlimited report cards. Manage it from your account.
          </div>
        </div>
      )}

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {plans.map((plan) => {
          const Icon = PLAN_ICONS[plan.id] ?? Sparkles;
          const price = currency === 'INR' ? plan.priceInr : plan.priceUsd;
          const symbol = currency === 'INR' ? '\u20b9' : '$';
          const current = planActive && planId === plan.id;
          return (
            <div
              key={plan.id}
              className={clsx(
                'card flex flex-col relative',
                plan.recommended && 'border-brand-400 shadow-card ring-1 ring-brand-200',
              )}
            >
              {plan.recommended && (
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-brand-600 text-white text-[11px] font-bold uppercase tracking-wide px-3 py-1 rounded-full">
                  Most popular
                </span>
              )}
              <div className="card-body flex flex-col flex-1">
                <div className="flex items-center gap-2">
                  <div className="h-9 w-9 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-ink-900">{plan.name}</h3>
                    <p className="text-xs text-ink-500">{plan.tagline}</p>
                  </div>
                </div>

                <div className="mt-4">
                  <span className="text-3xl font-black text-ink-900">
                    {symbol}
                    {price}
                  </span>
                  <span className="text-sm text-ink-500">
                    {' '}
                    / {plan.durationMonths} months
                  </span>
                </div>

                <ul className="mt-4 space-y-2 text-sm text-ink-700 flex-1">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2">
                      <Check className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => navigate(`/login?plan=${plan.id}`)}
                  type="button"
                  disabled={current}
                  className={clsx(
                    'mt-5 w-full py-3 rounded-xl font-semibold transition-colors',
                    current
                      ? 'bg-emerald-50 text-emerald-700 cursor-default'
                      : 'bg-brand-600 text-white hover:bg-brand-700',
                  )}
                >
                  {current ? 'Current plan' : `Subscribe · ${symbol}${price}`}
                </button>
              </div>
            </div>
          );
        })}
      </section>

      <p className="text-xs text-ink-500 text-center">
        Prices are set by isZma (this page shows the live server prices). Each plan shows its own
        billing period. You can keep using the {FREE_USE_LIMIT} free generations before subscribing.
      </p>
    </div>
  );
}
