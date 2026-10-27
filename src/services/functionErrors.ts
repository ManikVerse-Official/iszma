/**
 * Turns a failed Supabase Edge Function call into something the UI can act on.
 *
 * The important rule: an HTTP 429 is NOT automatically "you used your free
 * card". The status alone can mean three different things, so the function
 * body's machine-readable `code` decides:
 *
 *   FREE_LIMIT_EMAIL / FREE_LIMIT_NETWORK  -> a real reached limit (no retry)
 *   USAGE_UNAVAILABLE                      -> limits could not be checked (retry)
 *   any other 429 (gateway / proxy)        -> temporary rate limiting (retry)
 *
 * A request that never got a response (supabase-js `FunctionsFetchError`, or a
 * blocked CORS preflight) is reported as a connectivity problem with a retry,
 * not as a limit and not as a completed payment.
 *
 * No dependency on the browser or on Supabase, so the classification can be
 * unit-tested under Node (scripts/check-greeting-payments.ts).
 */

export interface FunctionFailure {
  /** Safe to show to the user. */
  message: string;
  /** Stable machine code (server code when present). */
  code: string;
  /** HTTP status, or 0 when no response was received. */
  status: number;
  /** True only when trying the same action again can plausibly succeed. */
  retryable: boolean;
}

export class FunctionRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;

  constructor(failure: FunctionFailure) {
    super(failure.message);
    this.name = 'FunctionRequestError';
    this.code = failure.code;
    this.status = failure.status;
    this.retryable = failure.retryable;
  }
}

export const NETWORK_ERROR_MESSAGE =
  'We could not reach the server (the request did not complete). Check your connection and try again.';

/** A reached free-card limit — the one case where retrying is pointless. */
export const isFreeCardLimit = (failure: Pick<FunctionFailure, 'code'>): boolean =>
  failure.code === 'FREE_LIMIT_EMAIL' || failure.code === 'FREE_LIMIT_NETWORK';

/** Limits could not be verified server-side: nothing was created, retry later. */
export const isUsageUnavailable = (failure: Pick<FunctionFailure, 'code'>): boolean =>
  failure.code === 'USAGE_UNAVAILABLE';

const bodyRecord = (body: unknown): Record<string, unknown> | null =>
  body && typeof body === 'object' ? (body as Record<string, unknown>) : null;

const bodyMessage = (body: unknown): string => {
  const record = bodyRecord(body);
  if (!record) return '';
  for (const key of ['error', 'message', 'reason']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
};

/**
 * Classifies a failed call.
 *
 * `status` is 0 when fetch itself failed (no response). `body` is the parsed
 * JSON body when the function answered, otherwise null.
 */
export const classifyFunctionFailure = (input: {
  status?: number;
  body?: unknown;
  /** The raw JS error message, used only when the body has nothing better. */
  fallbackMessage?: string;
}): FunctionFailure => {
  const status = Number.isFinite(input.status) ? Number(input.status) : 0;
  const record = bodyRecord(input.body);
  const serverMessage = bodyMessage(input.body);
  const rawCode = typeof record?.code === 'string' ? record.code : '';
  const code = rawCode || (status === 0 ? 'NETWORK' : `HTTP_${status}`);
  const serverRetryable = record?.retryable === true;

  // Never received a response: connectivity / CORS / function unreachable.
  if (status === 0) {
    return {
      message: NETWORK_ERROR_MESSAGE,
      code: 'NETWORK',
      status: 0,
      retryable: true,
    };
  }

  if (code === 'FREE_LIMIT_EMAIL') {
    return {
      message:
        serverMessage ||
        'This email already claimed a free card in the last 24 hours. Try again after 24 hours, or pick a paid card.',
      code,
      status,
      retryable: false,
    };
  }

  if (code === 'FREE_LIMIT_NETWORK') {
    return {
      message:
        serverMessage ||
        'This network has already used its free-card allowance. Paid cards and subscriptions are still available.',
      code,
      status,
      retryable: false,
    };
  }

  if (code === 'USAGE_UNAVAILABLE') {
    return {
      message:
        serverMessage ||
        'We could not verify the free-card limit just now, so nothing was created. Please try again in a moment.',
      code,
      status,
      retryable: true,
    };
  }

  if (code === 'PAYMENT_CONFIG') {
    return {
      message:
        serverMessage ||
        'Payments are not configured on the server, so nothing was charged. The site owner needs to set the payment keys.',
      code,
      status,
      retryable: false,
    };
  }

  if (code === 'PAID_THEME') {
    return {
      message: serverMessage || 'This card requires payment and cannot be published without it.',
      code,
      status,
      retryable: false,
    };
  }

  // A bare 429 from the gateway/proxy is temporary, not a reached allowance.
  if (status === 429 && !rawCode) {
    return {
      message:
        serverMessage ||
        'The server is receiving too many requests right now. Please wait a few seconds and try again.',
      code: 'RATE_LIMITED',
      status,
      retryable: true,
    };
  }

  // Authentication / validation problems never fix themselves on retry.
  if (status === 400 || status === 401 || status === 403 || status === 409) {
    return {
      message:
        serverMessage ||
        input.fallbackMessage ||
        'The request was rejected. Please check your details and try again.',
      code,
      status,
      retryable: false,
    };
  }

  // Any other server-side failure (500/502/503) is worth one more attempt,
  // unless the server explicitly said otherwise.
  return {
    message:
      serverMessage ||
      input.fallbackMessage ||
      'The server could not complete the request. Please try again.',
    code,
    status,
    retryable: serverRetryable || status >= 500,
  };
};

/** Reads the JSON body out of a supabase-js function error, without throwing. */
const readErrorBody = async (error: unknown): Promise<{ status: number; body: unknown }> => {
  const context = (error as { context?: Response })?.context;
  if (!context || typeof context.json !== 'function') return { status: 0, body: null };

  let body: unknown = null;
  try {
    body = await context.json();
  } catch {
    /* non-JSON error body — the status still tells us what happened */
  }
  return { status: Number(context.status) || 0, body };
};

/**
 * Builds the typed failure for `supabase.functions.invoke` results.
 *
 * `data` is the function's 200 body (functions can answer `{ success: false }`
 * without an HTTP error), so it is checked as a fallback.
 */
export const readFunctionFailure = async (
  error: unknown,
  data?: unknown,
): Promise<FunctionFailure> => {
  const { status, body } = await readErrorBody(error);

  if (!error) {
    // No transport error: the function answered, but reported a failure.
    const failure = classifyFunctionFailure({
      status: 200,
      body: data,
      fallbackMessage: 'The request could not be completed.',
    });
    return failure;
  }

  return classifyFunctionFailure({
    status,
    body,
    fallbackMessage: error instanceof Error ? error.message : '',
  });
};
