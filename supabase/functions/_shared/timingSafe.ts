/**
 * Constant-time string comparison.
 *
 * Its own module (rather than living inside `auth.ts`) because `auth.ts` imports
 * supabase-js from a URL — which a plain Node regression check cannot resolve.
 * Token verification in `studioLimits.ts` must stay testable outside Deno.
 */
export const safeCompare = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};
