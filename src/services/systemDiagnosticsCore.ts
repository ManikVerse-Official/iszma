/**
 * Client-side diagnostic helpers.
 *
 * Deliberately pure: the checks a browser can make (configuration, session,
 * catalogue sync, embedded Studio) are described here and unit-tested under Node
 * (scripts/check-diagnostics.ts). The runner in `systemDiagnostics.ts` supplies
 * the live values and merges the server's read-only checks.
 *
 * Rules:
 *   • "ok" is never inferred from a page reload — it means the specific check
 *     actually ran and passed;
 *   • "unknown" is used when a check could not be performed, so an unverified
 *     area is never shown as healthy;
 *   • every failure names a root cause and a safe next step, and says whether it
 *     is recoverable without a code change.
 */

export type DiagnosticStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface DiagnosticCheck {
  id: string;
  title: string;
  status: DiagnosticStatus;
  recoverable: boolean;
  rootCause: string;
  evidence: string;
  nextStep: string;
}

export interface DiagnosticSummary {
  ok: number;
  warnings: number;
  failures: number;
  unknown: number;
  healthy: boolean;
  needsOwnerAction: boolean;
}

export const summariseDiagnostics = (checks: DiagnosticCheck[]): DiagnosticSummary => {
  const summary: DiagnosticSummary = {
    ok: 0,
    warnings: 0,
    failures: 0,
    unknown: 0,
    healthy: true,
    needsOwnerAction: false,
  };
  for (const check of checks) {
    if (check.status === 'ok') summary.ok += 1;
    else if (check.status === 'warn') summary.warnings += 1;
    else if (check.status === 'fail') summary.failures += 1;
    else summary.unknown += 1;

    if (check.status === 'fail') {
      summary.healthy = false;
      if (!check.recoverable) summary.needsOwnerAction = true;
    }
  }
  return summary;
};

/** Failing checks first, then warnings, then unverified, then healthy. */
export const sortDiagnostics = (checks: DiagnosticCheck[]): DiagnosticCheck[] => {
  const rank: Record<DiagnosticStatus, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 };
  return [...checks].sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title));
};

export const maskEmail = (value: string): string => {
  const email = (value ?? '').trim();
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return `${email.slice(0, 1)}***`;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
};

export const configCheck = (configured: boolean): DiagnosticCheck => ({
  id: 'client.supabase',
  title: 'Supabase configuration',
  status: configured ? 'ok' : 'fail',
  recoverable: false,
  rootCause: configured
    ? 'The browser is configured with a real Supabase project.'
    : 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are missing or still the placeholder, so no server call can succeed.',
  evidence: configured ? 'A real project URL is present (value never shown).' : 'Placeholder or empty configuration.',
  nextStep: configured
    ? 'No action needed.'
    : 'Set both VITE_SUPABASE_* build variables and rebuild the site.',
});

export const sessionCheck = (input: {
  configured: boolean;
  email: string | null;
}): DiagnosticCheck => {
  if (!input.configured) {
    return {
      id: 'client.session',
      title: 'Admin session',
      status: 'unknown',
      recoverable: true,
      rootCause: 'The session cannot be checked until Supabase is configured.',
      evidence: 'No backend to authenticate against.',
      nextStep: 'Configure Supabase first, then re-run diagnostics.',
    };
  }
  if (!input.email) {
    return {
      id: 'client.session',
      title: 'Admin session',
      status: 'warn',
      recoverable: true,
      rootCause: 'No verified admin session is loaded in this browser.',
      evidence: 'getAdminSession() returned no session.',
      nextStep: 'Sign in as an admin; every server-side check requires a valid session.',
    };
  }
  return {
    id: 'client.session',
    title: 'Admin session',
    status: 'ok',
    recoverable: true,
    rootCause: 'A verified session is present.',
    evidence: `Signed in as ${maskEmail(input.email)}.`,
    nextStep: 'No action needed.',
  };
};

export const catalogueCheck = (input: {
  syncWarning?: string | null;
  themeCount: number;
  productCount: number;
}): DiagnosticCheck => {
  const warning = (input.syncWarning ?? '').trim();
  if (warning) {
    return {
      id: 'client.catalogue',
      title: 'Catalogue sync',
      status: 'warn',
      recoverable: true,
      rootCause: 'The last catalogue write was rejected by the server, so the change is only in this browser.',
      evidence: warning.slice(0, 300),
      nextStep: 'Re-apply the change after confirming the admin permission, or read the admin audit log for the rejected write.',
    };
  }
  if (input.themeCount === 0 || input.productCount === 0) {
    return {
      id: 'client.catalogue',
      title: 'Catalogue sync',
      status: 'warn',
      recoverable: true,
      rootCause: 'The live catalogue is empty in this browser, so the storefront may show nothing.',
      evidence: `${input.productCount} product(s), ${input.themeCount} theme(s) loaded.`,
      nextStep: 'Check the products/theme_prices tables and the catalogue fetch in the browser console.',
    };
  }
  return {
    id: 'client.catalogue',
    title: 'Catalogue sync',
    status: 'ok',
    recoverable: true,
    rootCause: 'The live catalogue is loaded and the last server write was accepted.',
    evidence: `${input.productCount} product(s), ${input.themeCount} theme(s) loaded.`,
    nextStep: 'No action needed.',
  };
};

export const realtimeCheck = (supported: boolean, configured: boolean): DiagnosticCheck => {
  if (!configured) {
    return {
      id: 'client.realtime',
      title: 'Realtime (Game Zone online modes)',
      status: 'unknown',
      recoverable: true,
      rootCause: 'Realtime cannot be checked until Supabase is configured.',
      evidence: 'No backend configured.',
      nextStep: 'Configure Supabase first.',
    };
  }
  return {
    id: 'client.realtime',
    title: 'Realtime (Game Zone online modes)',
    status: supported ? 'ok' : 'warn',
    recoverable: true,
    rootCause: supported
      ? 'The anon key is a JWT, so realtime subscriptions can authenticate.'
      : 'The anon key is a publishable key, not a JWT; realtime subscriptions are skipped and online matchmaking will not update.',
    evidence: supported ? 'Anon key format is realtime-compatible.' : 'Publishable key detected.',
    nextStep: supported
      ? 'No action needed.'
      : 'Use the project anon (JWT) key for VITE_SUPABASE_ANON_KEY, or expect offline-only Game Zone play.',
  };
};

export const reportCardEmbedCheck = (input: {
  attempted: boolean;
  ok: boolean;
  detail?: string;
}): DiagnosticCheck => {
  if (!input.attempted) {
    return {
      id: 'client.reportcard',
      title: 'ReportCard Studio embed',
      status: 'unknown',
      recoverable: true,
      rootCause: 'The embedded Studio could not be probed from this page.',
      evidence: input.detail || 'Probe not available.',
      nextStep: 'Open /reportcard directly and confirm it loads.',
    };
  }
  return {
    id: 'client.reportcard',
    title: 'ReportCard Studio embed',
    status: input.ok ? 'ok' : 'warn',
    recoverable: true,
    rootCause: input.ok
      ? 'The embedded Studio entry point responded.'
      : 'The embedded Studio entry point did not respond successfully, so the Studio tab will show an empty frame.',
    evidence: input.detail || (input.ok ? 'HTTP 200' : 'Non-OK response'),
    nextStep: input.ok
      ? 'No action needed.'
      : 'Confirm the /reportcard build is deployed with the site (public/reportcard).',
  };
};

/**
 * Probes the checkout function with an impossible theme id.
 *
 * Safe by construction: `create-payment-order` resolves the price BEFORE it
 * talks to a gateway, so an unknown theme returns 400 UNKNOWN_THEME and no order
 * (and no charge) is created. That distinguishes the real causes of a broken
 * checkout — function not deployed, prices missing, provider not configured —
 * without initiating a payment.
 */
export const checkoutProbeCheck = (input: {
  attempted: boolean;
  status: number;
  code?: string;
  message?: string;
}): DiagnosticCheck => {
  if (!input.attempted) {
    return {
      id: 'client.checkout',
      title: 'Checkout order function',
      status: 'unknown',
      recoverable: true,
      rootCause: 'The checkout probe could not be attempted.',
      evidence: input.message || 'No backend configured.',
      nextStep: 'Configure Supabase, then re-run diagnostics.',
    };
  }

  if (input.status === 0) {
    return {
      id: 'client.checkout',
      title: 'Checkout order function',
      status: 'fail',
      recoverable: true,
      rootCause: 'The browser could not reach create-payment-order (network or CORS).',
      evidence: input.message || 'No response received.',
      nextStep: 'Retry; if it persists, confirm the function is deployed and its CORS preflight answers 204.',
    };
  }

  if (input.status === 404) {
    return {
      id: 'client.checkout',
      title: 'Checkout order function',
      status: 'fail',
      recoverable: false,
      rootCause: 'create-payment-order is not deployed, so no paid checkout can start.',
      evidence: 'HTTP 404 from /functions/v1/create-payment-order',
      nextStep: 'Deploy it: supabase functions deploy create-payment-order',
    };
  }

  if (input.code === 'UNKNOWN_THEME' || (input.status === 400 && /unknown theme/i.test(input.message ?? ''))) {
    return {
      id: 'client.checkout',
      title: 'Checkout order function',
      status: 'ok',
      recoverable: true,
      rootCause: 'The function is deployed and resolves prices from the server. No order was created by this probe.',
      evidence: 'Probe answered 400 UNKNOWN_THEME before any gateway call.',
      nextStep: 'No action needed.',
    };
  }

  if (input.code === 'PAYMENT_CONFIG' || input.status === 503) {
    return {
      id: 'client.checkout',
      title: 'Checkout order function',
      status: 'warn',
      recoverable: true,
      rootCause: 'The checkout function is deployed but a payment provider is not configured, so buyers cannot pay.',
      evidence: input.message || 'HTTP 503 PAYMENT_CONFIG',
      nextStep: 'Set the provider keys (see the payment checks above) and retry a real checkout in test mode.',
    };
  }

  return {
    id: 'client.checkout',
    title: 'Checkout order function',
    status: input.status >= 500 ? 'fail' : 'warn',
    recoverable: true,
    rootCause: 'The checkout probe got an unexpected answer, so order creation may be failing.',
    evidence: input.message || `HTTP ${input.status}${input.code ? ` (${input.code})` : ''}`,
    nextStep: 'Read the create-payment-order function logs, then retry.',
  };
};

/**
 * Describes why the server diagnostics could not be read. Mirrors the server's
 * classification so a browser 404 (function not deployed) is never confused with
 * a 401 (signed out) or a network failure.
 */
export const serverUnavailableCheck = (input: {
  status: number;
  message?: string;
  code?: string;
}): DiagnosticCheck => {
  const status = Number.isFinite(input.status) ? input.status : 0;
  const detail = (input.message ?? '').trim();

  if (status === 0) {
    return {
      id: 'server.diagnostics',
      title: 'Server diagnostics',
      status: 'fail',
      recoverable: true,
      rootCause: 'The browser could not reach the admin-diagnostics function (network or CORS).',
      evidence: detail || 'No response received.',
      nextStep: 'Retry; if it persists, confirm the function is deployed and its CORS preflight answers 204.',
    };
  }
  if (status === 401 || status === 403) {
    return {
      id: 'server.diagnostics',
      title: 'Server diagnostics',
      status: 'fail',
      recoverable: true,
      rootCause:
        status === 401
          ? 'The admin session is missing or expired, so the server refused the request.'
          : 'The signed-in account is not in admin_users, so server diagnostics are refused.',
      evidence: detail || `HTTP ${status}`,
      nextStep:
        status === 401 ? 'Sign in again as an admin.' : 'Use an account that exists in admin_users.',
    };
  }
  if (status === 404) {
    return {
      id: 'server.diagnostics',
      title: 'Server diagnostics',
      status: 'fail',
      recoverable: false,
      rootCause: 'The admin-diagnostics Edge Function is not deployed on this project.',
      evidence: 'HTTP 404 from /functions/v1/admin-diagnostics',
      nextStep: 'Deploy it: supabase functions deploy admin-diagnostics',
    };
  }
  if (status === 429) {
    return {
      id: 'server.diagnostics',
      title: 'Server diagnostics',
      status: 'warn',
      recoverable: true,
      rootCause: 'The server rate-limited this diagnostics request.',
      evidence: detail || 'HTTP 429',
      nextStep: 'Wait a moment and run diagnostics again.',
    };
  }
  if (status >= 500) {
    return {
      id: 'server.diagnostics',
      title: 'Server diagnostics',
      status: 'fail',
      recoverable: true,
      rootCause: 'admin-diagnostics is deployed but crashed or cannot read the database.',
      evidence: detail || `HTTP ${status}`,
      nextStep: 'Read the function logs and verify SUPABASE_SERVICE_ROLE_KEY, then re-run.',
    };
  }
  return {
    id: 'server.diagnostics',
    title: 'Server diagnostics',
    status: 'fail',
    recoverable: true,
    rootCause: 'The server rejected the diagnostics request.',
    evidence: detail || `HTTP ${status}${input.code ? ` (${input.code})` : ''}`,
    nextStep: 'Retry once; then read the function logs.',
  };
};

/** De-duplicates by id (server wins) so a check cannot appear twice. */
export const mergeDiagnostics = (
  clientChecks: DiagnosticCheck[],
  serverChecks: DiagnosticCheck[],
): DiagnosticCheck[] => {
  const byId = new Map<string, DiagnosticCheck>();
  for (const check of clientChecks) byId.set(check.id, check);
  for (const check of serverChecks) byId.set(check.id, check);
  return sortDiagnostics([...byId.values()]);
};
