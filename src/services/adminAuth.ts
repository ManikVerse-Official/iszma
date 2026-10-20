import { supabase, isSupabaseConfigured } from './supabase';

export interface AdminIdentity {
  userId: string;
  email: string;
  provider: 'supabase';
}

/**
 * True only when Supabase is properly configured.
 */
export const isSupabaseAuthAvailable = (): boolean =>
  isSupabaseConfigured();

/** Pulls the human-readable message out of a failed function invocation. */
const readFunctionError = async (
  error: unknown,
  fallback: string,
): Promise<string> => {
  const context = (error as { context?: Response })?.context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { error?: unknown };
      if (typeof body?.error === 'string' && body.error.trim()) return body.error;
    } catch {
      /* fall through to the generic message */
    }
  }

  /*
   * No HTTP response at all means the request never produced one: the browser
   * blocked the preflight, the function is not deployed, or the network is down.
   * "Failed to send a request to the Edge Function" tells the user nothing, so
   * the actual condition and the thing to check are spelled out — without ever
   * guessing that the credentials were wrong.
   */
  const message = error instanceof Error ? error.message : '';
  if (!context || /failed to (send|fetch)|network|load failed/i.test(message)) {
    return (
      'Could not reach the admin sign-in service. The admin-login function is ' +
      'unreachable from this site — check that it is deployed for this Supabase ' +
      'project and that this origin is allowed (SITE_ORIGINS). Your credentials ' +
      'were not checked.'
    );
  }

  return message || fallback;
};

/**
 * Returns the currently signed-in Supabase user.
 *
 * IMPORTANT:
 * We do NOT use localStorage/password fallback here.
 * The backend needs the real Supabase JWT.
 */
export const getAdminSession =
  async (): Promise<AdminIdentity | null> => {
    if (!isSupabaseConfigured()) {
      return null;
    }

    try {
      const { data, error } = await supabase.auth.getSession();

      if (error || !data.session?.user) {
        return null;
      }

      return {
        userId: data.session.user.id,
        email: data.session.user.email ?? '',
        provider: 'supabase',
      };
    } catch {
      return null;
    }
  };

/**
 * Checks whether the currently authenticated Supabase user is an admin.
 *
 * The ONLY source of truth is the server: `is_admin()` reads the `admin_users`
 * table with a SECURITY DEFINER function. No email is hardcoded here, so the
 * admin address is not part of the shipped bundle.
 */
export const checkIsAdmin =
  async (): Promise<boolean> => {
    if (!isSupabaseConfigured()) {
      return false;
    }

    try {
      const {
        data: sessionData,
        error: sessionError,
      } = await supabase.auth.getSession();

      if (
        sessionError ||
        !sessionData.session?.user
      ) {
        return false;
      }

      const { data, error } = await supabase.rpc('is_admin');
      return !error && data === true;
    } catch {
      return false;
    }
  };

/**
 * Signs the admin in through the `admin-login` Edge Function.
 *
 * The credentials are verified server-side against the bcrypt hash stored in
 * `admin_users`; the function then returns a real Supabase session which we hand
 * to supabase-js. Nothing about the admin account is present in the browser
 * bundle, and there is no client-side password check to bypass.
 */
export const signInAdmin = async (
  email: string,
  password: string,
): Promise<AdminIdentity> => {
  if (!isSupabaseConfigured()) {
    throw new Error(
      'Supabase authentication is not configured.',
    );
  }

  const normalizedEmail =
    email.trim().toLowerCase();

  if (!normalizedEmail) {
    throw new Error('Please enter your email address.');
  }

  if (!password) {
    throw new Error('Please enter your password.');
  }

  const { data, error } = await supabase.functions.invoke('admin-login', {
    body: { email: normalizedEmail, password },
  });

  if (error) {
    throw new Error(
      await readFunctionError(error, 'Incorrect email or password.'),
    );
  }

  if (!data?.success || !data.access_token || !data.refresh_token) {
    throw new Error(
      typeof data?.error === 'string' && data.error
        ? data.error
        : 'Incorrect email or password.',
    );
  }

  const { data: sessionData, error: sessionError } =
    await supabase.auth.setSession({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
    });

  if (sessionError || !sessionData.session?.user) {
    throw new Error(
      'Signed in, but the session could not be stored. Please try again.',
    );
  }

  return {
    userId: sessionData.session.user.id,
    email: sessionData.session.user.email ?? data.email ?? normalizedEmail,
    provider: 'supabase',
  };
};

/**
 * Signs the current admin out of Supabase.
 */
export const signOutAdmin =
  async (): Promise<void> => {
    if (!isSupabaseConfigured()) {
      return;
    }

    try {
      await supabase.auth.signOut();
    } catch {
      // Already signed out / session unavailable.
    }
  };

/**
 * Watches Supabase login/logout/token-refresh events.
 */
export const subscribeToAuthChanges =
  (
    onChange: () => void,
  ): (() => void) => {
    if (!isSupabaseConfigured()) {
      return () => {};
    }

    try {
      const {
        data,
      } = supabase.auth.onAuthStateChange(
        () => {
          onChange();
        },
      );

      return () =>
        data.subscription.unsubscribe();
    } catch {
      return () => {};
    }
  };
