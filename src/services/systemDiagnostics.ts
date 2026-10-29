/**
 * System-wide diagnostics for Admin Joy.
 *
 * Runs in two halves and never pretends one covers the other:
 *
 *   • browser checks — configuration, verified session, catalogue sync, realtime
 *     compatibility and the embedded ReportCard Studio entry point;
 *   • server checks — the admin-only `admin-diagnostics` function reads provider
 *     configuration flags, recent email failures and receipt coverage from the
 *     database (never from a page reload, never exposing a secret).
 *
 * If the server half cannot run, that fact is itself a reported failure with its
 * real cause (not deployed / not signed in / network), not a silent pass.
 */

import { getAdminSession } from './adminAuth';
import { readFunctionFailure } from './functionErrors';
import { isSupabaseConfigured, supabase, supportsRealtime } from './supabase';
import {
  catalogueCheck,
  checkoutProbeCheck,
  configCheck,
  mergeDiagnostics,
  reportCardEmbedCheck,
  realtimeCheck,
  serverUnavailableCheck,
  sessionCheck,
  summariseDiagnostics,
  type DiagnosticCheck,
  type DiagnosticSummary,
} from './systemDiagnosticsCore';

export interface DiagnosticRun {
  generatedAt: string;
  checks: DiagnosticCheck[];
  summary: DiagnosticSummary;
  /** True only when the server-side checks actually answered. */
  serverReachable: boolean;
}

export interface DiagnosticsInput {
  catalogWarning?: string | null;
  themeCount?: number;
  productCount?: number;
}

const probeReportCardEmbed = async (): Promise<{
  attempted: boolean;
  ok: boolean;
  detail?: string;
}> => {
  try {
    const base = import.meta.env.BASE_URL || '/';
    const url = `${base.replace(/\/?$/, '/')}reportcard/index.html`;
    const response = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    return { attempted: true, ok: response.ok, detail: `HTTP ${response.status} · ${url}` };
  } catch (error) {
    return {
      attempted: true,
      ok: false,
      detail: error instanceof Error ? error.message : 'The embed probe failed.',
    };
  }
};

/**
 * Asks create-payment-order for an impossible theme. The function resolves the
 * price before any gateway call, so this returns 400 UNKNOWN_THEME and creates
 * no order — a real deployment/pricing check with no payment.
 */
const probeCheckout = async (configured: boolean): Promise<DiagnosticCheck> => {
  if (!configured) {
    return checkoutProbeCheck({ attempted: false, status: 0 });
  }
  try {
    const { data, error } = await supabase.functions.invoke('create-payment-order', {
      body: { theme_id: '__admin_diagnostics_probe__', currency: 'INR' },
    });
    if (!error) {
      return checkoutProbeCheck({
        attempted: true,
        status: 200,
        code: typeof data?.code === 'string' ? data.code : undefined,
        message:
          typeof data?.error === 'string'
            ? data.error
            : 'The probe unexpectedly succeeded; no real theme was requested.',
      });
    }
    const failure = await readFunctionFailure(error, data);
    return checkoutProbeCheck({
      attempted: true,
      status: failure.status,
      code: failure.code,
      message: failure.message,
    });
  } catch (error) {
    return checkoutProbeCheck({
      attempted: true,
      status: 0,
      message: error instanceof Error ? error.message : 'The checkout probe threw.',
    });
  }
};

const unconfiguredServerCheck = (): DiagnosticCheck => ({
  id: 'server.diagnostics',
  title: 'Server diagnostics',
  status: 'unknown',
  recoverable: true,
  rootCause: 'Server checks cannot run because the browser has no Supabase project configured.',
  evidence: 'No backend configured.',
  nextStep: 'Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, rebuild, then re-run diagnostics.',
});

export const runSystemDiagnostics = async (
  input: DiagnosticsInput = {},
): Promise<DiagnosticRun> => {
  const configured = isSupabaseConfigured();
  const session = configured ? await getAdminSession().catch(() => null) : null;

  const clientChecks: DiagnosticCheck[] = [
    configCheck(configured),
    sessionCheck({ configured, email: session?.email ?? null }),
    catalogueCheck({
      syncWarning: input.catalogWarning ?? null,
      themeCount: input.themeCount ?? 0,
      productCount: input.productCount ?? 0,
    }),
    realtimeCheck(supportsRealtime(), configured),
    reportCardEmbedCheck(await probeReportCardEmbed()),
    await probeCheckout(configured),
  ];

  let serverChecks: DiagnosticCheck[] = [];
  let serverReachable = false;

  if (!configured) {
    serverChecks = [unconfiguredServerCheck()];
  } else {
    try {
      const { data, error } = await supabase.functions.invoke('admin-diagnostics', { body: {} });

      if (error) {
        const failure = await readFunctionFailure(error, data);
        serverChecks = [
          serverUnavailableCheck({
            status: failure.status,
            message: failure.message,
            code: failure.code,
          }),
        ];
      } else if (data?.success && Array.isArray(data.checks)) {
        serverChecks = data.checks as DiagnosticCheck[];
        serverReachable = true;
      } else {
        const failure = await readFunctionFailure(null, data);
        serverChecks = [
          serverUnavailableCheck({
            status: 200,
            message: failure.message,
            code: failure.code,
          }),
        ];
      }
    } catch (error) {
      serverChecks = [
        serverUnavailableCheck({
          status: 0,
          message: error instanceof Error ? error.message : 'The diagnostics call threw.',
        }),
      ];
    }
  }

  const checks = mergeDiagnostics(clientChecks, serverChecks);
  return {
    generatedAt: new Date().toISOString(),
    checks,
    summary: summariseDiagnostics(checks),
    serverReachable,
  };
};
