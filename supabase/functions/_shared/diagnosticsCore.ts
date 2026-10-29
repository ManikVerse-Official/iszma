// Pure diagnostics rules — no Deno, no network, no Supabase client.
//
// Shared by the admin-only `admin-diagnostics` Edge Function and the browser
// panel, so both sides describe a problem the same way:
//
//   • status     — ok / warn / fail / unknown (unknown = not verifiable here)
//   • recoverable — can the operator (or a retry) fix it without a code change?
//   • rootCause  — the actual cause, not "something went wrong"
//   • nextStep   — the safe action that addresses it
//
// Nothing here accepts or returns a secret value: configuration checks carry a
// boolean, never the key.

export type DiagnosticStatus = "ok" | "warn" | "fail" | "unknown";

export interface DiagnosticCheck {
  id: string;
  title: string;
  status: DiagnosticStatus;
  /** True when the admin can resolve it (setting a key, retrying, fixing data). */
  recoverable: boolean;
  /** The actual cause, in one sentence. */
  rootCause: string;
  /** Concrete evidence (counts, status codes, masked addresses). */
  evidence: string;
  /** The safe next action. */
  nextStep: string;
}

export interface DiagnosticSummary {
  ok: number;
  warnings: number;
  failures: number;
  unknown: number;
  /** True when nothing failed. Warnings are still surfaced. */
  healthy: boolean;
  /** True when at least one failure needs a code change / deployment. */
  needsOwnerAction: boolean;
}

export interface DiagnosticReport {
  generatedAt: string;
  checks: DiagnosticCheck[];
  summary: DiagnosticSummary;
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
    if (check.status === "ok") summary.ok += 1;
    else if (check.status === "warn") summary.warnings += 1;
    else if (check.status === "fail") summary.failures += 1;
    else summary.unknown += 1;

    if (check.status === "fail") {
      summary.healthy = false;
      if (!check.recoverable) summary.needsOwnerAction = true;
    }
  }
  return summary;
};

/** Failing checks first, then warnings, then unknown, then healthy ones. */
export const sortDiagnostics = (checks: DiagnosticCheck[]): DiagnosticCheck[] => {
  const rank: Record<DiagnosticStatus, number> = { fail: 0, warn: 1, unknown: 2, ok: 3 };
  return [...checks].sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title));
};

/** Mask an address for admin display: `asha@example.com` -> `a***@example.com`. */
export const maskEmail = (value: string): string => {
  const email = (value ?? "").trim();
  if (!email) return "";
  const at = email.indexOf("@");
  if (at <= 0) return `${email.slice(0, 1)}***`;
  return `${email.slice(0, 1)}***${email.slice(at)}`;
};

/**
 * Describes why the server diagnostics could not be read.
 *
 * These are the failures the browser can actually see, and each has a different
 * cause — reporting them all as "diagnostics failed" is what hides the real one.
 */
export const serverUnavailableCheck = (input: {
  status: number;
  code?: string;
  message?: string;
}): DiagnosticCheck => {
  const status = Number.isFinite(input.status) ? input.status : 0;
  const detail = (input.message ?? "").trim();

  if (status === 0) {
    return {
      id: "server.diagnostics",
      title: "Server diagnostics",
      status: "fail",
      recoverable: true,
      rootCause:
        "The browser could not reach the admin-diagnostics function (network, CORS or an unpublished function).",
      evidence: detail || "No response was received.",
      nextStep:
        "Check your connection and retry. If it persists, confirm admin-diagnostics is deployed and its CORS preflight answers 204.",
    };
  }

  if (status === 401 || status === 403) {
    return {
      id: "server.diagnostics",
      title: "Server diagnostics",
      status: "fail",
      recoverable: true,
      rootCause:
        status === 401
          ? "The admin session is missing or expired, so the server refuses the request."
          : "The signed-in account is not in admin_users, so server diagnostics are refused.",
      evidence: detail || `HTTP ${status}`,
      nextStep:
        status === 401
          ? "Sign in again as an admin, then re-run diagnostics."
          : "Add this account to admin_users on the server (or use an admin account).",
    };
  }

  if (status === 404) {
    return {
      id: "server.diagnostics",
      title: "Server diagnostics",
      status: "fail",
      recoverable: false,
      rootCause: "The admin-diagnostics Edge Function is not deployed on this Supabase project.",
      evidence: detail || "HTTP 404 from /functions/v1/admin-diagnostics",
      nextStep: "Deploy the function: supabase functions deploy admin-diagnostics",
    };
  }

  if (status === 429) {
    return {
      id: "server.diagnostics",
      title: "Server diagnostics",
      status: "warn",
      recoverable: true,
      rootCause: "The server rate-limited the diagnostics request.",
      evidence: detail || "HTTP 429",
      nextStep: "Wait a moment and run diagnostics again.",
    };
  }

  if (status >= 500) {
    return {
      id: "server.diagnostics",
      title: "Server diagnostics",
      status: "fail",
      recoverable: true,
      rootCause:
        "admin-diagnostics is deployed but crashed or could not read the database with its service-role key.",
      evidence: detail || `HTTP ${status}`,
      nextStep:
        "Check the function logs and the SUPABASE_SERVICE_ROLE_KEY secret, then re-run diagnostics.",
    };
  }

  return {
    id: "server.diagnostics",
    title: "Server diagnostics",
    status: "fail",
    recoverable: true,
    rootCause: "The server rejected the diagnostics request.",
    evidence: detail || `HTTP ${status}${input.code ? ` (${input.code})` : ""}`,
    nextStep: "Retry once; if it keeps failing, read the function logs.",
  };
};

/** A required configuration check: absence is a real, actionable failure. */
export const requiredConfigCheck = (
  id: string,
  title: string,
  configured: boolean,
  rootCause: string,
  nextStep: string,
): DiagnosticCheck => ({
  id,
  title,
  status: configured ? "ok" : "fail",
  recoverable: true,
  rootCause: configured ? "Configured." : rootCause,
  evidence: configured ? "A server secret is present (value never read)." : "The secret is not set.",
  nextStep: configured ? "No action needed." : nextStep,
});

/** An optional capability: absence is a warning, not a broken site. */
export const optionalConfigCheck = (
  id: string,
  title: string,
  configured: boolean,
  impact: string,
  nextStep: string,
): DiagnosticCheck => ({
  id,
  title,
  status: configured ? "ok" : "warn",
  recoverable: true,
  rootCause: configured ? "Configured." : impact,
  evidence: configured ? "A server secret is present (value never read)." : "The secret is not set.",
  nextStep: configured ? "No action needed." : nextStep,
});

/**
 * A receipt gap: a settled transaction with no receipt row.
 *
 * This is not cosmetic — it means the buyer has no email record of the purchase.
 * It is recoverable because `accountant-bot` re-issues idempotently.
 */
export const missingReceiptCheck = (count: number, samplePaymentId?: string): DiagnosticCheck => ({
  id: "receipts.missing",
  title: "Receipts for settled orders",
  status: count === 0 ? "ok" : "warn",
  recoverable: true,
  rootCause:
    count === 0
      ? "Every settled order checked has a stored receipt."
      : `${count} settled order(s) have no receipt row, so no email record was issued for them.`,
  evidence:
    count === 0
      ? "0 missing in the last 30 days."
      : `${count} missing in the last 30 days${samplePaymentId ? ` (e.g. ${samplePaymentId})` : ""}.`,
  nextStep:
    count === 0
      ? "No action needed."
      : "Re-issue the missing receipt through accountant-bot (it is idempotent and will not duplicate one that exists).",
});

/**
 * A failed delivery is never "hidden": the count and the latest reason are shown
 * so the admin can decide whether it is a bad address or a provider outage.
 */
export const emailFailureCheck = (input: {
  configured: boolean;
  failedCount: number;
  latestError?: string;
}): DiagnosticCheck => {
  if (!input.configured) {
    return {
      id: "email.delivery",
      title: "Transactional email (Resend)",
      status: "warn",
      recoverable: true,
      rootCause: "RESEND_API_KEY is not set, so receipts and bills are recorded as skipped.",
      evidence: "No provider key; nothing was sent.",
      nextStep: "Set RESEND_API_KEY and RECEIPT_FROM_EMAIL, then redeploy send-email.",
    };
  }
  if (input.failedCount > 0) {
    return {
      id: "email.delivery",
      title: "Transactional email (Resend)",
      status: "warn",
      recoverable: true,
      rootCause: `${input.failedCount} email attempt(s) failed in the last 7 days.`,
      evidence: input.latestError || "See email_log for the full record.",
      nextStep:
        "Open the email_log entry. A 4xx means a bad address or unverified sender; a 5xx/network error is transient and is already retried.",
    };
  }
  return {
    id: "email.delivery",
    title: "Transactional email (Resend)",
    status: "ok",
    recoverable: true,
    rootCause: "Configured, with no failed attempts logged in the last 7 days.",
    evidence: "0 failures in email_log.",
    nextStep: "No action needed.",
  };
};
