/**
 * Admin session bridge (Ishmaverse → ReportCard Studio).
 *
 * ReportCard Studio runs in an iframe inside Ishmaverse, and Ishmaverse is where
 * the real Supabase session lives (the admin signs in through `admin-login`).
 * The Studio therefore asks its parent for the session token and attaches it to
 * its server calls, so the SERVER decides whether this user is an admin.
 *
 * What this is NOT: it is not an admin flag. Hold on to any token and the server
 * still verifies it against Supabase Auth and `admin_users` on every request;
 * a normal user's token simply is not an admin. Nothing here can grant access on
 * its own, which is why the Studio has no `ADMIN_EMAILS` list any more.
 *
 * Security of the channel itself:
 *   • messages are only accepted from the site's own origin (or an explicitly
 *     configured parent origin for a cross-origin Studio deployment);
 *   • the token is kept in memory and, so a reload does not sign the user out,
 *     in `sessionStorage` — never in a URL and never in a cookie;
 *   • the request we send to the parent carries no secret at all.
 */

const SESSION_KEY = 'rcs:admin-session';

interface BridgedSession {
  accessToken: string;
  email: string;
  receivedAt: number;
}

interface ParentMessage {
  type?: string;
  accessToken?: unknown;
  email?: unknown;
}

/** Extra origin allowed to hand us a session (cross-origin Studio hosting). */
const configuredParentOrigin = (): string => {
  const raw = (import.meta.env.VITE_PARENT_ORIGIN as string | undefined)?.trim() ?? '';
  if (!raw) return '';
  try {
    return new URL(raw).origin;
  } catch {
    return '';
  }
};

const acceptedOrigins = (): string[] => {
  const origins = [window.location.origin];
  const configured = configuredParentOrigin();
  if (configured && !origins.includes(configured)) origins.push(configured);
  return origins;
};

/*
 * A Supabase access token is a JWT: three base64url segments, the header starting
 * with `eyJ`. Anything else — an empty value, the publishable key, a token that
 * arrived with its own "Bearer " prefix — is not a session and must never be
 * forwarded as one, because the edge gateway refuses it with "Invalid JWT"
 * (`UNAUTHORIZED_*_JWT`) before the function's own admin check can run.
 */
const ACCESS_TOKEN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The `exp` claim of a JWT, in seconds (0 when it cannot be read). */
const tokenExpiry = (token: string): number => {
  try {
    const segment = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(window.atob(segment.padEnd(Math.ceil(segment.length / 4) * 4, '=')));
    return typeof json?.exp === 'number' ? json.exp : 0;
  } catch {
    return 0;
  }
};

/**
 * Normalises a token handed over by Ishmaverse (or left in sessionStorage).
 *
 * • one `Bearer ` prefix at most — a token that came with one must not become
 *   `Authorization: Bearer Bearer …` (which the gateway rejects as malformed);
 * • a non-JWT value is dropped instead of being forwarded;
 * • an expired token is dropped too, so a long-idle tab does not fire a request
 *   that is certain to be refused.
 */
export const normalizeAccessToken = (raw: unknown): string | null => {
  const value = typeof raw === 'string' ? raw.trim().replace(/^Bearer\s+/i, '').trim() : '';
  if (!ACCESS_TOKEN.test(value)) return null;
  const expiry = tokenExpiry(value);
  if (expiry > 0 && expiry * 1000 <= Date.now() + 5000) return null;
  return value;
};

/** Tokens the gateway has already refused, so the parent cannot hand one back. */
const rejectedTokens = new Set<string>();

let session: BridgedSession | null = loadSession();
const listeners = new Set<(session: BridgedSession | null) => void>();

function loadSession(): BridgedSession | null {
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BridgedSession>;
    const accessToken = normalizeAccessToken(parsed?.accessToken);
    if (!accessToken || rejectedTokens.has(accessToken)) return null;
    return {
      accessToken,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      receivedAt: typeof parsed.receivedAt === 'number' ? parsed.receivedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function persist(next: BridgedSession | null): void {
  try {
    if (next) window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    else window.sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* private mode / storage disabled */
  }
}

/** The bearer token the server should verify, or null when there is none. */
export const getBridgedToken = (): string | null => session?.accessToken ?? null;

/** The verified-session email, used only for display. */
export const getBridgedEmail = (): string => session?.email ?? '';

export const subscribeToBridgedSession = (
  listener: (session: BridgedSession | null) => void,
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const setSession = (next: BridgedSession | null): void => {
  session = next;
  persist(next);
  for (const listener of listeners) listener(next);
};

/** Asks the parent window for the current Ishmaverse session. */
export const requestParentSession = (): void => {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'ishmaverse:auth-request' }, '*');
    }
  } catch {
    /* not embedded */
  }
};

/**
 * Installs the message listener. Returns an unsubscribe function.
 * Called once from `main.tsx`.
 */
export const installAuthBridge = (): (() => void) => {
  const onMessage = (event: MessageEvent<ParentMessage>) => {
    if (!acceptedOrigins().includes(event.origin)) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'ishmaverse:auth') {
      const token = normalizeAccessToken(data.accessToken);
      /* An unusable token is no session at all — never store it as one. */
      if (!token || rejectedTokens.has(token)) {
        setSession(null);
        return;
      }
      setSession({
        accessToken: token,
        email: typeof data.email === 'string' ? data.email : '',
        receivedAt: Date.now(),
      });
      return;
    }

    if (data.type === 'ishmaverse:auth-cleared') setSession(null);
  };

  window.addEventListener('message', onMessage);
  // A reload inside the iframe must still be able to ask for the session.
  requestParentSession();

  return () => window.removeEventListener('message', onMessage);
};

/**
 * Forgets a token the edge gateway refused, and remembers that it is unusable.
 *
 * Deliberately silent (no listener call): the caller is in the middle of a
 * request and immediately retries as the anonymous caller, then asks the parent
 * for a fresh session. Notifying here would set off a refresh loop for a token
 * that can never work. Once refused, the same token is never accepted again, so
 * a parent that keeps reposting it cannot restore it.
 */
export const rejectBridgedToken = (token: string | null): void => {
  if (token) rejectedTokens.add(token);
  session = null;
  persist(null);
};
