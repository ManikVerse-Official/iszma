import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.2";
import { FREE_LIMITS, type FreeLimit } from "./plans.ts";

/**
 * True for a syntactically valid IPv4 / IPv6 address.
 *
 * The limit keys on this value, so a junk header must never become a shared
 * "IP" that silently groups unrelated visitors (or bypasses the cap).
 */
export const isIpAddress = (value: string): boolean => {
  const ip = value.trim();
  if (!ip) return false;

  // IPv4: four 0-255 octets.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").every((part) => Number(part) <= 255);
  }

  // IPv6 (including IPv4-mapped). Reject zone ids and hostnames.
  return /^[0-9a-f:]+$/i.test(ip) && ip.includes(":") && ip.length <= 45;
};

/**
 * Client IP from trusted transport headers.
 *
 * Supabase Edge Functions run behind Cloudflare + their own gateway, which set
 * `cf-connecting-ip` / `x-real-ip` for us. `x-forwarded-for` is the fallback,
 * but only its LAST entry is used: earlier entries can be supplied by the
 * caller (`X-Forwarded-For: 1.2.3.4` prepends), so reading the first hop would
 * let a client choose the "network" the free-card limit counts against.
 *
 * Returns "" when no trustworthy address is available — callers must fail
 * closed (the free-card flow does) instead of treating every such request as
 * one shared network.
 */
export const clientIp = (req: Request): string => {
  const platform =
    req.headers.get("cf-connecting-ip") ??
    req.headers.get("x-real-ip") ??
    req.headers.get("fly-client-ip") ??
    "";
  if (isIpAddress(platform)) return platform.trim();

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded.split(",").map((hop) => hop.trim()).filter(Boolean);
    const last = hops[hops.length - 1] ?? "";
    if (isIpAddress(last)) return last;
  }

  return "";
};

export interface TrialDecision {
  allowed: boolean;
  reason?: string;
  /** Remaining free uses for this email after this claim (when allowed). */
  remaining: number;
  /** True when the caller is the owner/staff and unlimited use was granted. */
  admin?: boolean;
}

/**
 * Checks the free-use limits for a feature and, when allowed, records the use.
 *
 * Rules (from FREE_LIMITS):
 *   • at most `perEmail` uses for one address,
 *   • at most `perIpEmails` distinct addresses from one IP,
 *   • at most `perIpTotal` uses from one IP in total.
 */
export const checkAndConsumeTrial = async (
  client: SupabaseClient,
  feature: string,
  rawEmail: string,
  ip: string,
  /** Admin requests are unlimited and are not recorded as free usage. */
  isAdmin = false,
): Promise<TrialDecision> => {
  const limit: FreeLimit | undefined = FREE_LIMITS[feature];
  if (!limit) return { allowed: false, reason: "Unknown feature", remaining: 0 };

  const email = (rawEmail || "").trim().toLowerCase();

  if (isAdmin) {
    return { allowed: true, remaining: limit.perEmail, admin: true };
  }

  // Pull this feature's rows for the IP so every rule is decided from one read.
  let rows: { email: string | null }[] = [];
  if (ip) {
    const { data, error } = await client
      .from("usage_events")
      .select("email")
      .eq("feature", feature)
      .eq("ip", ip);
    if (error) {
      console.error("usage_events read failed:", error.message);
      return { allowed: false, reason: "Could not verify usage limits", remaining: 0 };
    }
    rows = (data ?? []) as { email: string | null }[];
  }

  const normalised = rows.map((r) => (r.email ?? "").toLowerCase()).filter(Boolean);
  const byEmail = email ? normalised.filter((e) => e === email).length : 0;
  const distinctEmails = new Set(normalised);
  if (email) distinctEmails.delete(email);

  if (email && byEmail >= limit.perEmail) {
    return {
      allowed: false,
      reason:
        feature === "free_greeting"
          ? "You have already claimed your free card with this email."
          : `You have used all ${limit.perEmail} free uses for this email.`,
      remaining: 0,
    };
  }

  if (ip && limit.perIpEmails > 0 && distinctEmails.size >= limit.perIpEmails) {
    return {
      allowed: false,
      reason: "This network has already used its free allowance. Please subscribe to continue.",
      remaining: 0,
    };
  }

  if (ip && limit.perIpTotal > 0 && rows.length >= limit.perIpTotal) {
    return {
      allowed: false,
      reason: "This network has reached its free-use limit. Please subscribe to continue.",
      remaining: Math.max(0, limit.perEmail - byEmail - 1),
    };
  }

  // Record the use.
  const { error: insertError } = await client.from("usage_events").insert([
    { feature, email: email || null, ip: ip || null },
  ]);
  if (insertError) {
    console.error("usage_events insert failed:", insertError.message);
    return { allowed: false, reason: "Could not record usage", remaining: 0 };
  }

  return { allowed: true, remaining: Math.max(0, limit.perEmail - byEmail - 1) };
};

export interface StudioState {
  planActive: boolean;
  planId: string | null;
  expiresAt: string | null;
  freeUsed: number;
  freeRemaining: number;
  /** Owner/staff: unlimited use, never consumes free tries. */
  isAdmin: boolean;
  /** Free tries allowed for a signed-in account (so the copy can stay dynamic). */
  freeLimit: number;
}

/** Current ReportCard Studio entitlement for an email. */
export const studioState = async (
  client: SupabaseClient,
  rawEmail: string,
  isAdmin = false,
): Promise<StudioState> => {
  const email = (rawEmail || "").trim().toLowerCase();
  const limit = FREE_LIMITS.studio_generation;

  if (isAdmin) {
    return {
      planActive: true,
      planId: "admin",
      expiresAt: null,
      freeUsed: 0,
      freeRemaining: limit.perEmail,
      isAdmin: true,
      freeLimit: limit.perEmail,
    };
  }

  let planActive = false;
  let planId: string | null = null;
  let expiresAt: string | null = null;

  if (email) {
    const { data: sub } = await client
      .from("studio_subscriptions")
      .select("plan_id, expires_at, status")
      .eq("email", email)
      .maybeSingle();

    // A cancelled or expired plan grants nothing, whatever its expires_at says.
    const cancelled = (sub?.status ?? "active").toLowerCase() === "cancelled";
    if (!cancelled && sub?.expires_at && new Date(sub.expires_at).getTime() > Date.now()) {
      planActive = true;
      planId = sub.plan_id ?? null;
      expiresAt = sub.expires_at;
    }
  }

  let freeUsed = 0;
  if (email) {
    const { count } = await client
      .from("usage_events")
      .select("id", { count: "exact", head: true })
      .eq("feature", "studio_generation")
      .eq("email", email);
    freeUsed = count ?? 0;
  }

  return {
    planActive,
    planId,
    expiresAt,
    freeUsed,
    // `Infinity` never survives JSON, so an active plan reports the full limit
    // and the client treats `planActive` as unlimited.
    freeRemaining: planActive ? limit.perEmail : Math.max(0, limit.perEmail - freeUsed),
    isAdmin: false,
    freeLimit: limit.perEmail,
  };
};
