/**
 * Audit + security-event log.
 *
 * Every privileged Joy operation records who did what, to which record, when,
 * and with what result — with a short before/after diff that never includes
 * credentials, tokens or full customer records.
 *
 * IMPORTANT LIMITATION: this log lives in the browser for the current build.
 * It is append-only through the public API here (no delete/clear is exposed to
 * the UI), but a browser-side log is NOT tamper-proof. Durable, tamper-evident
 * auditing requires a server-side table with an insert-only policy — see the
 * "required infrastructure" note in the final report.
 */

export type AuditOutcome =
  | 'success'
  | 'failure'
  | 'denied'
  | 'blocked'
  | 'confirmation-required';

export interface AuditEntry {
  id: string;
  at: string;
  actorId: string;
  actorEmail: string;
  /** Stable action key, e.g. "product.update". */
  action: string;
  targetId?: string;
  targetName?: string;
  outcome: AuditOutcome;
  /** Short human detail. Must never contain secrets. */
  detail?: string;
  /** Only the changed fields, e.g. { price: { from: 100, to: 399 } }. */
  diff?: Record<string, { from: unknown; to: unknown }>;
}

export type SecurityEventKind =
  | 'auth_failure'
  | 'authorization_denied'
  | 'rate_limited'
  | 'prompt_injection'
  | 'suspicious_activity';

export interface SecurityEvent {
  id: string;
  at: string;
  kind: SecurityEventKind;
  actorEmail?: string;
  detail: string;
}

const AUDIT_KEY = 'ishmaverse_audit_log_v1';
const SECURITY_KEY = 'ishmaverse_security_log_v1';
const MAX_ENTRIES = 500;

const hasStorage = (): boolean => {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
};

const readList = <T>(key: string): T[] => {
  if (!hasStorage()) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
};

const writeList = <T>(key: string, list: T[]): void => {
  if (!hasStorage()) return;
  try {
    localStorage.setItem(key, JSON.stringify(list.slice(-MAX_ENTRIES)));
  } catch {
    /* storage full/unavailable — the in-memory copy still exists this session */
  }
};

const newId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** In-memory mirror so the log is readable even without localStorage. */
let auditMemory: AuditEntry[] = readList<AuditEntry>(AUDIT_KEY);
let securityMemory: SecurityEvent[] = readList<SecurityEvent>(SECURITY_KEY);

/** Appends one audit entry and returns it. */
export const recordAudit = (entry: Omit<AuditEntry, 'id' | 'at'>): AuditEntry => {
  const full: AuditEntry = { id: newId(), at: new Date().toISOString(), ...entry };
  auditMemory = [...auditMemory, full].slice(-MAX_ENTRIES);
  writeList(AUDIT_KEY, auditMemory);
  return full;
};

/** Appends one security event and returns it. */
export const recordSecurityEvent = (
  event: Omit<SecurityEvent, 'id' | 'at'>,
): SecurityEvent => {
  const full: SecurityEvent = { id: newId(), at: new Date().toISOString(), ...event };
  securityMemory = [...securityMemory, full].slice(-MAX_ENTRIES);
  writeList(SECURITY_KEY, securityMemory);
  return full;
};

/** Most recent audit entries first. */
export const getAuditLog = (): AuditEntry[] => [...auditMemory].reverse();

/** Most recent security events first. */
export const getSecurityEvents = (): SecurityEvent[] => [...securityMemory].reverse();

/** A read-only export for an admin to download. */
export const exportAuditLog = (): string =>
  JSON.stringify({ audit: getAuditLog(), security: getSecurityEvents() }, null, 2);

/**
 * Test-only reset. Deliberately NOT wired to any UI control, so an operator (or
 * a chat command) cannot erase the audit trail from the app.
 */
export const __resetLogsForTests = (): void => {
  auditMemory = [];
  securityMemory = [];
  writeList(AUDIT_KEY, auditMemory);
  writeList(SECURITY_KEY, securityMemory);
};

/** Builds a minimal, secret-free before/after diff for the audit entry. */
export const buildDiff = (
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): AuditEntry['diff'] => {
  if (!before || !after) return undefined;
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    const from = before[key];
    const to = after[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) diff[key] = { from, to };
  }
  return Object.keys(diff).length > 0 ? diff : undefined;
};
