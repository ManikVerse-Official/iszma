import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://placeholder.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'placeholder-key';

/**
 * True only when a real Supabase project is configured.
 *
 * The client always needs *some* URL to exist, so we fall back to a placeholder.
 * That placeholder previously passed the old `.includes('supabase.co')` check,
 * which made the app believe it was connected and then blow up with a
 * "Failed to fetch" network error on the first auth/storage call. This guard
 * rejects the placeholder (and empty values) so callers can fall back safely.
 */
export const isSupabaseConfigured = (): boolean => {
  const url = (import.meta.env.VITE_SUPABASE_URL || '').trim();
  if (!url || url.includes('placeholder')) return false;
  return /^https?:\/\/[^/\s]+\.supabase\.(co|in)/i.test(url);
};

/*
 * Realtime authenticates its WebSocket with a JWT. A Supabase *publishable* key
 * (`sb_publishable_…`) is not a JWT, so `channel().subscribe()` always fails
 * with "WebSocket is closed before the connection is established" and logs a
 * network error on every page load, even though nothing needs realtime.
 *
 * Callers use this to skip a subscription that cannot succeed instead of
 * shipping a permanent console error to production.
 */
export const supportsRealtime = (): boolean =>
  /^eyJ/.test((import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim());

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
