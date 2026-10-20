import { recordSecurityEvent, getSecurityEvents, type SecurityEvent } from './auditLog';

/**
 * Lightweight abuse protection.
 *
 * This is a best-effort, browser-side layer that slows down repeated privileged
 * attempts and records suspicious activity. It is NOT a substitute for
 * server-side rate limiting: a determined client can bypass it. The durable
 * protection belongs in the Edge Function / gateway (see the final report).
 *
 * No guaranteed attacker or "scammer" detection is claimed — only honest,
 * reversible throttling and logging.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

/** A simple fixed-window limiter, keyed by an opaque string. */
export class FixedWindowLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt and returns true when it is within the limit. */
  allow(key: string): boolean {
    const time = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= time) {
      this.buckets.set(key, { count: 1, resetAt: time + this.windowMs });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.limit;
  }

  /** Reads (without consuming) the remaining allowance. */
  remaining(key: string): number {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= this.now()) return this.limit;
    return Math.max(0, this.limit - bucket.count);
  }

  reset(): void {
    this.buckets.clear();
  }
}

/* Widely-spaced windows: enough for real admin work, tight enough to blunt a loop. */
export const adminCommandLimiter = new FixedWindowLimiter(30, 60_000);
export const authAttemptLimiter = new FixedWindowLimiter(5, 5 * 60_000);

/** Records a failed sign-in and returns the security event. */
export const noteAuthFailure = (identifier: string): SecurityEvent => {
  authAttemptLimiter.allow(`auth:${identifier}`);
  return recordSecurityEvent({
    kind: 'auth_failure',
    actorEmail: identifier,
    detail: `Failed admin sign-in for ${identifier || 'unknown account'}.`,
  });
};

/** Records an authorization denial (authenticated but not permitted). */
export const noteAuthorizationDenied = (actor: string, action: string): SecurityEvent =>
  recordSecurityEvent({
    kind: 'authorization_denied',
    actorEmail: actor,
    detail: `Authorization denied for "${action}".`,
  });

/** Records a prompt-injection attempt found in a chat message. */
export const notePromptInjection = (actor: string, snippet: string): SecurityEvent =>
  recordSecurityEvent({
    kind: 'prompt_injection',
    actorEmail: actor,
    detail: `Instruction-like content ignored: "${snippet.slice(0, 120)}"`,
  });

/** Records a rate-limit block. */
export const noteRateLimited = (actor: string, action: string): SecurityEvent =>
  recordSecurityEvent({
    kind: 'rate_limited',
    actorEmail: actor,
    detail: `Rate limit hit for "${action}".`,
  });

export interface SecuritySummary {
  total: number;
  byKind: Record<SecurityEvent['kind'], number>;
  recent: SecurityEvent[];
}

/** Counts security events by kind for the admin security summary. */
export const getSecuritySummary = (limit = 20): SecuritySummary => {
  const events = getSecurityEvents();
  const byKind = events.reduce(
    (acc, event) => {
      acc[event.kind] = (acc[event.kind] ?? 0) + 1;
      return acc;
    },
    {
      auth_failure: 0,
      authorization_denied: 0,
      rate_limited: 0,
      prompt_injection: 0,
      suspicious_activity: 0,
    } as Record<SecurityEvent['kind'], number>,
  );
  return { total: events.length, byKind, recent: events.slice(0, limit) };
};
