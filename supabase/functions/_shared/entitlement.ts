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

export interface StudioPlanStatus {
  active: boolean;
  planId: string | null;
  expiresAt: string | null;
}

/**
 * The active Studio subscription for an email, decided by the DATABASE.
 *
 * Used by both the state endpoint and the claim endpoint, so a subscriber is
 * never told to spend a free generation — and so "I am on a plan" can never be
 * faked by the browser: the claim endpoint asks this, not the client.
 */
export const studioPlanStatus = async (
  client: SupabaseClient,
  rawEmail: string,
): Promise<StudioPlanStatus> => {
  const email = (rawEmail || "").trim().toLowerCase();
  if (!email) return { active: false, planId: null, expiresAt: null };

  try {
    const { data: sub } = await client
      .from("studio_subscriptions")
      .select("plan_id, expires_at, status")
      .eq("email", email)
      .maybeSingle();

    // A cancelled or expired plan grants nothing, whatever its expires_at says.
    const cancelled = (sub?.status ?? "active").toLowerCase() === "cancelled";
    if (!cancelled && sub?.expires_at && new Date(sub.expires_at).getTime() > Date.now()) {
      return { active: true, planId: sub.plan_id ?? null, expiresAt: sub.expires_at };
    }
  } catch (error) {
    console.error(
      "studio_subscriptions read failed:",
      error instanceof Error ? error.message.slice(0, 120) : "unknown",
    );
  }

  return { active: false, planId: null, expiresAt: null };
};

export interface StudioState {
  planActive: boolean;
  planId: string | null;
  expiresAt: string | null;
  /** Free generations this email has consumed. */
  freeUsed: number;
  /** The tighter of the email and device allowances. */
  freeRemaining: number;
  emailRemaining: number;
  deviceRemaining: number;
  /** Owner/staff: unlimited use, never consumes free tries. */
  isAdmin: boolean;
  /** Free tries allowed per identity (so the copy can stay dynamic). */
  freeLimit: number;
  /** False until this browser has registered a device with the server. */
  deviceRegistered: boolean;
}

export interface StudioUsageInput {
  emailUsed: number;
  deviceUsed: number;
  deviceRegistered: boolean;
}

/**
 * Current ReportCard Studio entitlement for an email (and its device).
 *
 * `usage` is read from `usage_events` by `readStudioUsage` (see
 * `_shared/studioLimits.ts`). Both counters are reported so the UI can explain
 * which allowance is holding the user back, and `freeRemaining` is the tighter
 * of the two — a generation needs BOTH to have room.
 */
export const studioState = async (
  client: SupabaseClient,
  rawEmail: string,
  isAdmin = false,
  usage: StudioUsageInput = { emailUsed: 0, deviceUsed: 0, deviceRegistered: false },
): Promise<StudioState> => {
  const email = (rawEmail || "").trim().toLowerCase();
  const limit: FreeLimit | undefined = FREE_LIMITS.studio_generation;
  const perEmail = Math.max(1, limit?.perEmail ?? 7);

  if (isAdmin) {
    return {
      planActive: true,
      planId: "admin",
      expiresAt: null,
      freeUsed: 0,
      freeRemaining: perEmail,
      emailRemaining: perEmail,
      deviceRemaining: perEmail,
      isAdmin: true,
      freeLimit: perEmail,
      deviceRegistered: true,
    };
  }

  const plan = await studioPlanStatus(client, email);
  const planActive = plan.active;
  const planId = plan.planId;
  const expiresAt = plan.expiresAt;

  const emailRemaining = Math.max(0, perEmail - Math.max(0, usage.emailUsed));
  /* No device yet means no device allowance has been consumed either; the claim
   * endpoint registers the device before it counts anything. */
  const deviceRemaining = usage.deviceRegistered
    ? Math.max(0, perEmail - Math.max(0, usage.deviceUsed))
    : perEmail;

  return {
    planActive,
    planId,
    expiresAt,
    freeUsed: Math.max(0, usage.emailUsed),
    // An active plan is unlimited, so it always reports the full allowance.
    freeRemaining: planActive ? perEmail : Math.min(emailRemaining, deviceRemaining),
    emailRemaining,
    deviceRemaining,
    isAdmin: false,
    freeLimit: perEmail,
    deviceRegistered: usage.deviceRegistered,
  };
};
