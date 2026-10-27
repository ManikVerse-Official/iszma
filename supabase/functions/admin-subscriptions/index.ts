// @ts-nocheck
//
// admin-subscriptions — the ReportCard Studio subscription tracker.
// ---------------------------------------------------------------------------
// Admin-only. Every row in `studio_subscriptions` is returned with a derived
// status (active / expiring soon / expired), so the owner can see who bought
// which plan, when it runs out and who has to be reminded.
//
// POST body:
//   { action: "list" }                              -> subscriptions + totals
//   { action: "cancel", email }                     -> turns a plan off now
//   { action: "extend", email, months? }            -> adds months to a plan
//   { action: "renew",  email }                     -> re-starts the plan today
//
// The caller must present a Supabase Auth JWT whose user is in `admin_users`.
// The tables themselves stay locked to the service role (no RLS policies).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient, getUserFromRequest, isAdminUser } from "../_shared/auth.ts";
import { loadStudioPlans, type StudioPlan } from "../_shared/plans.ts";

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const addMonths = (date: Date, months: number): Date => {
  const next = new Date(date.getTime());
  next.setMonth(next.getMonth() + months);
  return next;
};

interface SubscriptionRow {
  email: string;
  name: string | null;
  plan_id: string;
  price_inr: number | null;
  price_usd: number | null;
  started_at: string;
  expires_at: string;
  status: string | null;
  renewal_warned_at: string | null;
  admin_granted: boolean | null;
  ip: string | null;
  updated_at: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const withStatus = (row: SubscriptionRow, plans: Record<string, StudioPlan>) => {
  const expiresAt = new Date(row.expires_at).getTime();
  const now = Date.now();
  const daysLeft = Math.ceil((expiresAt - now) / DAY_MS);
  /* Prices already recorded on the row win; the live plan is only a fallback. */
  const plan = plans[row.plan_id] ?? null;
  const raw = (row.status ?? "active").toLowerCase();

  let status: "active" | "expiring" | "expired" | "cancelled" = "active";
  if (raw === "cancelled") status = "cancelled";
  else if (expiresAt <= now) status = "expired";
  else if (daysLeft <= 7) status = "expiring";

  return {
    email: row.email,
    name: row.name ?? "",
    planId: row.plan_id,
    planName: plan?.name ?? row.plan_id,
    priceInr: Number(row.price_inr ?? plan?.priceInr ?? 0),
    priceUsd: Number(row.price_usd ?? plan?.priceUsd ?? 0),
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    status,
    daysLeft: Math.max(daysLeft, 0),
    adminGranted: Boolean(row.admin_granted),
    renewalWarnedAt: row.renewal_warned_at,
    ip: row.ip ?? "",
    updatedAt: row.updated_at,
  };
};

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    const supabase = createAdminClient();
    const user = await getUserFromRequest(req);
    if (!user) return errorResponse("Sign in as an administrator first", 401);
    if (!(await isAdminUser(user.id))) {
      return errorResponse("Administrator access required", 403);
    }

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = clean(body.action, 20) || "list";
    const email = clean(body.email, 150).toLowerCase();

    /* --------------------------- list ------------------------------- */
    if (action === "list") {
      const { data, error } = await supabase
        .from("studio_subscriptions")
        .select("*")
        .order("expires_at", { ascending: true });
      if (error) throw new Error(error.message);

      const plans = await loadStudioPlans(supabase);
      const subscriptions = ((data ?? []) as SubscriptionRow[]).map((row) => withStatus(row, plans));

      // Per-email free-use counts, so the owner can size up the freeloaders.
      const { data: usage } = await supabase
        .from("usage_events")
        .select("email, feature")
        .eq("feature", "studio_generation");

      const freeByEmail: Record<string, number> = {};
      for (const row of (usage ?? []) as { email: string | null }[]) {
        const key = (row.email ?? "").toLowerCase();
        if (!key) continue;
        freeByEmail[key] = (freeByEmail[key] ?? 0) + 1;
      }

      const { data: emails } = await supabase
        .from("email_log")
        .select("template, to_email, subject, status, created_at")
        .order("created_at", { ascending: false })
        .limit(50);

      const now = Date.now();
      const totals = {
        total: subscriptions.length,
        active: subscriptions.filter((s) => s.status === "active" || s.status === "expiring").length,
        expiring: subscriptions.filter((s) => s.status === "expiring").length,
        expired: subscriptions.filter((s) => s.status === "expired").length,
        cancelled: subscriptions.filter((s) => s.status === "cancelled").length,
        revenueInr: subscriptions
          .filter((s) => new Date(s.expiresAt).getTime() > now && !s.adminGranted)
          .reduce((sum, s) => sum + s.priceInr, 0),
      };

      return jsonResponse({
        success: true,
        subscriptions: subscriptions.map((s) => ({
          ...s,
          freeUsed: freeByEmail[s.email.toLowerCase()] ?? 0,
        })),
        totals,
        emails: emails ?? [],
      });
    }

    if (!email) return errorResponse("An email is required", 400);

    /* -------------------------- cancel ------------------------------ */
    if (action === "cancel") {
      const { error } = await supabase
        .from("studio_subscriptions")
        .update({ status: "cancelled", updated_at: new Date().toISOString() })
        .eq("email", email);
      if (error) throw new Error(error.message);
      return jsonResponse({ success: true });
    }

    /* --------------------------- extend ----------------------------- */
    if (action === "extend" || action === "renew") {
      const { data: existing, error: readError } = await supabase
        .from("studio_subscriptions")
        .select("plan_id, expires_at")
        .eq("email", email)
        .maybeSingle();
      if (readError) throw new Error(readError.message);
      if (!existing) return errorResponse("No subscription for that email", 404);

      /* Renewal uses the plan's live billing duration, which an admin may change. */
      const plans = await loadStudioPlans(supabase);
      const plan = plans[existing.plan_id] ?? null;
      const months = action === "renew"
        ? (plan?.durationMonths ?? 6)
        : Math.max(1, Math.min(36, Number(body.months) || 6));

      // Extend from whichever is later: today or the current expiry.
      const base =
        action === "renew" ? new Date() : new Date(Math.max(Date.now(), new Date(existing.expires_at).getTime()));

      const { error } = await supabase
        .from("studio_subscriptions")
        .update({
          expires_at: addMonths(base, months).toISOString(),
          status: "active",
          renewal_warned_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq("email", email);
      if (error) throw new Error(error.message);

      return jsonResponse({ success: true, months });
    }

    return errorResponse("Unknown action", 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("admin-subscriptions failed:", message);
    return errorResponse(message, 500);
  }
});
