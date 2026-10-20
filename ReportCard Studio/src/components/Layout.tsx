import { Outlet, NavLink, Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  GraduationCap,
  Upload,
  FileText,
  Printer,
  Sparkles,
  LogIn,
  LogOut,
  ShieldCheck,
} from 'lucide-react';
import clsx from 'clsx';
import { FREE_USE_LIMIT } from '../config/plans';
import { useEntitlement } from '../store/entitlementStore';
import JoyGuide from './JoyGuide';

const NAV_ITEMS = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/school-profile', label: 'School Profile', icon: GraduationCap },
  { to: '/import', label: 'Import Students', icon: Upload },
  { to: '/template', label: 'Report Template', icon: FileText },
  { to: '/generate', label: 'Generate Reports', icon: Printer },
];

const STEPS = [
  { step: 1, label: 'School Details', route: '/school-profile' },
  { step: 2, label: 'Upload Excel', route: '/import' },
  { step: 3, label: 'Map / Verify Data', route: '/import' },
  { step: 4, label: 'Upload Photos', route: '/import' },
  { step: 5, label: 'Preview & Validate', route: '/template' },
  { step: 6, label: 'Generate Reports', route: '/generate' },
  { step: 7, label: 'Download ZIP', route: '/generate' },
];

function routeToMaxStep(route: string): number {
  if (route.startsWith('/school-profile')) return 1;
  if (route.startsWith('/import')) return 3;
  if (route.startsWith('/template')) return 5;
  if (route.startsWith('/generate')) return 7;
  return 0;
}

export default function Layout() {
  const location = useLocation();
  const navigate = useNavigate();
  const maxStep = routeToMaxStep(location.pathname);
  const { planActive, isAdmin, freeUsesRemaining, account, signOut } = useEntitlement();

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            {/* Ishmaverse logo — ReportCard Studio is now part of the Ishmaverse ecosystem. */}
            <img
              src="/ishmaverse.png"
              alt="Ishmaverse"
              className="h-10 w-10 shrink-0 rounded-xl object-contain"
              width={40}
              height={40}
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-base sm:text-lg font-semibold text-ink-900 leading-tight truncate">
                  ReportCard Studio
                </h1>
                <span className="hidden sm:inline-flex items-center rounded-full bg-brand-50 text-brand-700 text-[10px] font-semibold px-2 py-0.5 shrink-0">
                  by Ishmaverse
                </span>
              </div>
              <p className="text-[11px] sm:text-xs text-ink-500 leading-tight truncate">
                Excel In. Professional Report Cards Out.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/*
             * The full nav only appears from `lg`. At 768px (tablet) the five
             * links plus Plans and Sign out were 17px wider than the screen and
             * forced the whole page to scroll sideways, so tablets keep the
             * bottom tab bar instead.
             */}
            <nav className="hidden lg:flex items-center gap-1">
            {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-brand-50 text-brand-700'
                      : 'text-ink-700 hover:bg-slate-100',
                  )
                }
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </NavLink>
            );
          })}
            </nav>
            {/* Who is using the tool, and how much of their allowance is left. */}
            {account && (
              <div className="hidden lg:flex flex-col items-end leading-tight mr-1">
                <span className="text-xs font-semibold text-ink-800 max-w-[180px] truncate">
                  {account.email}
                </span>
                <span
                  className={clsx(
                    'text-[11px]',
                    isAdmin || planActive ? 'text-emerald-700 font-semibold' : 'text-ink-500',
                  )}
                >
                  {isAdmin
                    ? 'Admin · unlimited'
                    : planActive
                      ? 'Plan active · unlimited'
                      : `${freeUsesRemaining} of ${FREE_USE_LIMIT} free left`}
                </span>
              </div>
            )}

            <Link
              to="/pricing"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-slate-100 transition-colors"
            >
              <Sparkles className="h-4 w-4 text-brand-600" />
              <span className="hidden sm:inline">{planActive ? 'My plan' : 'Plans'}</span>
            </Link>

            {account ? (
              <button
                onClick={() => {
                  signOut();
                  navigate('/login');
                }}
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-ink-700 hover:bg-slate-100 transition-colors"
                title={`Signed in as ${account.email}`}
              >
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">Sign out</span>
              </button>
            ) : (
              <Link
                to="/login"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-2 text-sm font-semibold text-white hover:bg-brand-700 transition-colors"
              >
                {isAdmin ? <ShieldCheck className="h-4 w-4" /> : <LogIn className="h-4 w-4" />}
                <span className="hidden sm:inline">Sign in</span>
              </Link>
            )}
          </div>
        </div>
      </header>

      {/*
       * Mobile navigation: a fixed bottom tab bar instead of a horizontally
       * scrolling strip, so nothing needs sideways scrolling on a phone and
       * every target is comfortably tappable.
       */}
      <nav
        className="lg:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-slate-200 pb-safe no-print"
        aria-label="Main"
      >
        <div className="grid grid-cols-5">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  clsx(
                    'flex flex-col items-center justify-center gap-0.5 py-2 px-1 min-h-[56px] text-[10px] font-medium leading-tight text-center',
                    isActive ? 'text-brand-700 bg-brand-50' : 'text-ink-600',
                  )
                }
              >
                <Icon className="h-5 w-5" />
                <span className="rc-wrap">{item.label}</span>
              </NavLink>
            );
          })}
        </div>
      </nav>

      {maxStep > 0 && (
        <div className="bg-white border-b border-slate-200 no-print">
          {/* Compact progress summary for phones. */}
          <div className="md:hidden px-4 py-3">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-ink-800">
                Step {maxStep} of {STEPS.length}
              </span>
              <span className="text-xs text-ink-500 rc-wrap text-right max-w-[60%]">
                {STEPS[maxStep - 1]?.label}
              </span>
            </div>
            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-brand-600"
                style={{ width: `${(maxStep / STEPS.length) * 100}%` }}
              />
            </div>
          </div>
          <div className="hidden md:block max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-3 overflow-x-auto">
            <ol className="flex items-center gap-2 min-w-max">
              {STEPS.map((s, i) => {
                const done = s.step < maxStep;
                const active = s.step === maxStep;
                return (
                  <li key={s.step} className="flex items-center gap-2">
                    <span
                      className={clsx(
                        'step-badge shrink-0',
                        done && 'bg-emerald-600 text-white',
                        active && 'bg-brand-600 text-white',
                        !done && !active && 'bg-slate-100 text-ink-500',
                      )}
                    >
                      {s.step}
                    </span>
                    <span
                      className={clsx(
                        'text-xs font-medium whitespace-nowrap',
                        (done || active) ? 'text-ink-800' : 'text-ink-500',
                      )}
                    >
                      {s.label}
                    </span>
                    {i < STEPS.length - 1 && (
                      <div className="w-4 sm:w-8 h-px bg-slate-200 shrink-0" />
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}

      {/* Bottom padding reserves room for Joy's floating launcher so it can
          never hide the last row of a table on any screen size. */}
      <main className="flex-1 pb-20 lg:pb-24">
        <div className="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-4 sm:py-6">
          <Outlet />
        </div>
      </main>

      {/* Joy — the guide who knows every screen of the Studio. */}
      <JoyGuide />

      <footer className="border-t border-slate-200 bg-white no-print">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 pb-20 lg:pb-4 text-xs text-ink-500 flex flex-col sm:flex-row sm:items-center gap-1 sm:justify-between">
          <span>
            ReportCard Studio · Phase 1 · Report Generation Engine
          </span>
          <span>
            Data stays local. No student data is uploaded anywhere.
          </span>
        </div>
      </footer>
    </div>
  );
}
