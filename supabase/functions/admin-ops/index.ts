// @ts-nocheck
//
// admin-ops — the server-authoritative boundary for Admin Joy.
// ---------------------------------------------------------------------------
// This is the function that ACTUALLY performs privileged catalogue changes. The
// browser never mutates these tables through it directly, and it never receives
// the service-role key.
//
// Every request goes through, in order:
//   1. CORS / method check
//   2. JWT verification              -> 401 when there is no valid session
//   3. admin membership (admin_users)-> 403 when the caller is not an admin
//   4. permission check per action    -> 403 when the permission is missing
//   5. server-side rate limit         -> 429 with Retry-After
//   6. input validation (allow-list)  -> 400/501 for malformed/unsupported
//   7. the mutation itself, then a read-back of the persisted row
//   8. an append-only audit entry (success, failure, denied or blocked)
//
// Nothing the client sends about identity, permissions or confirmation is read
// or trusted: the actor is the verified JWT subject, permissions come from
// `admin_users`, and confirmation is a UI concern only.
//
// POST body (allow-listed fields only):
//   { action, targetId?, targetName?, fields? | patch? }
// Response:
//   { success, action, result?: { before?, after? }, auditId?, notStored? }
//
// Deployment: supabase functions deploy admin-ops
// Requires migration 20261014_step13_admin_ops.sql (audit + rate-limit tables
// and the optional admin_users.permissions column).

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient, getUserFromRequest, isAdminUser } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";
import {
  GAME_ID,
  LIMITS,
  MAX_BULK_ITEMS,
  buildAuditDiff,
  fixedWindowDecision,
  normaliseOutcome,
  redactSecrets,
  validateAdminOpRequest,
} from "../_shared/adminOpsCore.ts";

const safe = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

/** Surfaced when a mutation succeeded but its audit entry could not be stored. */
const AUDIT_WARNING =
  "The change was applied, but its audit entry could not be written. Check the admin_audit_log table and apply migration 20261014_step13_admin_ops.sql.";

/* ------------------------------------------------------------------ */
/* Audit                                                              */
/* ------------------------------------------------------------------ */

interface AuditInput {
  actorId: string | null;
  actorEmail: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  targetName?: string | null;
  outcome: string;
  detail?: string | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  ip: string;
}

/**
 * Writes one audit row and returns its id. A failure here is logged loudly but
 * does not roll back a completed mutation — the mutation already happened, and
 * hiding it would be worse than a missing log line.
 */
const recordAudit = async (client: any, input: AuditInput): Promise<string | null> => {
  const { data, error } = await client
    .from("admin_audit_log")
    .insert([
      {
        actor_id: input.actorId,
        actor_email: input.actorEmail,
        action: input.action,
        target_type: input.targetType ?? null,
        target_id: input.targetId ?? null,
        target_name: input.targetName ?? null,
        outcome: normaliseOutcome(input.outcome),
        detail: input.detail ? safe(input.detail, 500) : null,
        diff: buildAuditDiff(input.action, input.before, input.after),
        ip: input.ip || null,
      },
    ])
    .select("id")
    .single();

  if (error) {
    console.error("admin-ops audit insert failed:", error.message);
    return null;
  }
  return (data?.id as string) ?? null;
};

/* ------------------------------------------------------------------ */
/* Rate limiting                                                      */
/* ------------------------------------------------------------------ */

class RateLimitBackendUnavailable extends Error {}

interface RateLimitDecisionRow {
  allowed: boolean;
  remaining?: number;
  retry_after_seconds?: number;
}

/** True only when the database has not been migrated to the atomic function yet. */
const isMissingRateLimitFunction = (error: { code?: string; message?: string }): boolean =>
  error.code === "PGRST202" ||
  /could not find the function|function .* does not exist/i.test(error.message ?? "");

/**
 * Legacy read-then-upsert limiter.
 *
 * Kept only as a fallback for a database where migration 20261022 (the atomic
 * function) has not been applied yet. It still fails closed. The atomic path
 * below is the supported one and removes the read/write race that used to
 * surface as a rate-limit store error.
 */
const consumeRateLimitLegacy = async (
  client: any,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> => {
  const { data, error } = await client
    .from("admin_rate_limits")
    .select("window_start, count")
    .eq("key", key)
    .maybeSingle();

  if (error) throw new RateLimitBackendUnavailable(error.message);

  const now = Date.now();
  const startMs = data?.window_start ? Date.parse(data.window_start) : NaN;
  const elapsed = Number.isFinite(startMs) ? (now - startMs) / 1000 : windowSeconds;
  const inWindow = Number.isFinite(startMs) && elapsed < windowSeconds;

  const decision = fixedWindowDecision(data?.count ?? 0, limit, elapsed, windowSeconds);
  if (!decision.allowed) return decision;

  const next = {
    key,
    window_start: inWindow ? data.window_start : new Date(now).toISOString(),
    count: inWindow ? Number(data.count ?? 0) + 1 : 1,
  };
  const { error: writeError } = await client.from("admin_rate_limits").upsert(next, { onConflict: "key" });
  if (writeError) throw new RateLimitBackendUnavailable(writeError.message);

  return decision;
};

/**
 * Fixed-window limit consumed atomically by `consume_admin_rate_limit`
 * (service-role only). If the counter cannot be consumed the request is refused
 * rather than allowed, so a missing migration can never silently remove the
 * limit.
 */
const consumeRateLimit = async (
  client: any,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfterSeconds: number }> => {
  const { data, error } = await client.rpc("consume_admin_rate_limit", {
    p_key: key,
    p_limit: limit,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    if (isMissingRateLimitFunction(error)) {
      return consumeRateLimitLegacy(client, key, limit, windowSeconds);
    }
    throw new RateLimitBackendUnavailable(error.message);
  }

  const row = (Array.isArray(data) ? data[0] : data) as RateLimitDecisionRow | null;
  if (!row || typeof row.allowed !== "boolean") {
    throw new RateLimitBackendUnavailable(
      "The atomic rate-limit function returned no decision.",
    );
  }

  return {
    allowed: row.allowed,
    retryAfterSeconds: Math.max(0, Number(row.retry_after_seconds ?? 0)),
  };
};

/* ------------------------------------------------------------------ */
/* Executors                                                          */
/* ------------------------------------------------------------------ */

interface ExecOk {
  ok: true;
  before?: Record<string, unknown>;
  after: Record<string, unknown>;
  notStored?: string[];
}
interface ExecFail {
  ok: false;
  status: number;
  error: string;
}
type ExecResult = ExecOk | ExecFail;

const asRecord = (row: unknown): Record<string, unknown> =>
  (row ?? {}) as Record<string, unknown>;

const execProductUpdate = async (client: any, id: string, fields: any): Promise<ExecResult> => {
  const { data: before, error } = await client.from("products").select("*").eq("id", id).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!before) return { ok: false, status: 404, error: "No product with that id." };

  const patch: Record<string, unknown> = {};
  if (fields.name !== undefined) patch.name = fields.name;
  if (fields.price !== undefined) patch.price = fields.price;
  if (fields.price_usd !== undefined) patch.price_usd = fields.price_usd;
  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: "No supported product fields to change." };
  }

  const { data: after, error: updateError } = await client
    .from("products")
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (updateError) return { ok: false, status: 500, error: updateError.message };

  return { ok: true, before: asRecord(before), after: asRecord(after) };
};

const execProductCreate = async (client: any, fields: any): Promise<ExecResult> => {
  const row: Record<string, unknown> = {
    name: fields.name,
    price: fields.price ?? fields.price_inr ?? 0,
    price_usd: fields.price_usd ?? null,
  };

  const { data: after, error } = await client.from("products").insert([row]).select("*").single();
  if (error) return { ok: false, status: 500, error: error.message };

  const notStored: string[] = [];
  if (fields.description !== undefined) notStored.push("description");

  return { ok: true, after: asRecord(after), notStored };
};

const execProductDelete = async (client: any, id: string): Promise<ExecResult> => {
  const { data: before, error } = await client.from("products").select("*").eq("id", id).maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!before) return { ok: false, status: 404, error: "No product with that id." };

  const { error: deleteError } = await client.from("products").delete().eq("id", id);
  if (deleteError) return { ok: false, status: 500, error: deleteError.message };

  // Verify the row is really gone before reporting success.
  const { data: stillThere } = await client.from("products").select("id").eq("id", id).maybeSingle();
  if (stillThere) return { ok: false, status: 500, error: "The product could not be removed." };

  return { ok: true, before: asRecord(before), after: { id, deleted: true } };
};

const execThemeUpdate = async (client: any, id: string, fields: any): Promise<ExecResult> => {
  const { data: existing, error } = await client
    .from("theme_prices")
    .select("*")
    .eq("theme_id", id)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };

  const priceInr = fields.price_inr ?? fields.price ?? Number(existing?.price_inr ?? 0);
  const priceUsd = fields.price_usd ?? Number(existing?.price_usd ?? 0);

  const { data: after, error: upsertError } = await client
    .from("theme_prices")
    .upsert(
      {
        theme_id: id,
        price_inr: priceInr,
        price_usd: priceUsd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "theme_id" },
    )
    .select("*")
    .single();
  if (upsertError) return { ok: false, status: 500, error: upsertError.message };

  return {
    ok: true,
    before: existing ? asRecord(existing) : { theme_id: id },
    after: asRecord(after),
  };
};

/**
 * Updates the existing `theme_prices` rows for one greeting-card tier.
 *
 * There is no tier table in this schema: a tier is the set of themes with that
 * `tier`, and its price is each theme's `theme_prices` row. The executor reads
 * the rows first, writes them, then reads them back and compares the persisted
 * values before reporting success. The free theme (price 0) is never included by
 * Admin Joy, so it cannot accidentally become paid.
 */
const execTierPriceUpdate = async (
  client: any,
  tier: string,
  themeIds: string[],
  fields: any,
): Promise<ExecResult> => {
  const ids = [...new Set(themeIds)];
  if (!ids.length) return { ok: false, status: 400, error: "No themes were supplied for that tier." };

  const { data: beforeRows, error: readError } = await client
    .from("theme_prices")
    .select("*")
    .in("theme_id", ids);
  if (readError) return { ok: false, status: 500, error: readError.message };

  const beforeById = new Map<string, Record<string, unknown>>();
  for (const row of beforeRows ?? []) {
    beforeById.set(String((row as Record<string, unknown>).theme_id), asRecord(row));
  }

  const priceInr = fields.price_inr ?? fields.price;
  const priceUsd = fields.price_usd;
  const now = new Date().toISOString();
  const rows = ids.map((themeId) => {
    const before = beforeById.get(themeId) ?? {};
    return {
      theme_id: themeId,
      price_inr: priceInr !== undefined ? Number(priceInr) : Number(before.price_inr ?? 0),
      price_usd: priceUsd !== undefined ? Number(priceUsd) : Number(before.price_usd ?? 0),
      updated_at: now,
    };
  });

  const { error: writeError } = await client
    .from("theme_prices")
    .upsert(rows, { onConflict: "theme_id" });
  if (writeError) return { ok: false, status: 500, error: writeError.message };

  /* Read back the money fields and prove every requested theme was saved. */
  const { data: afterRows, error: verifyError } = await client
    .from("theme_prices")
    .select("*")
    .in("theme_id", ids);
  if (verifyError) return { ok: false, status: 500, error: verifyError.message };

  const afterById = new Map<string, Record<string, unknown>>();
  for (const row of afterRows ?? []) {
    afterById.set(String((row as Record<string, unknown>).theme_id), asRecord(row));
  }

  for (const themeId of ids) {
    const saved = afterById.get(themeId);
    if (!saved) {
      return {
        ok: false,
        status: 500,
        error: `The saved price for theme "${themeId}" could not be verified.`,
      };
    }
    if (priceInr !== undefined && Number(saved.price_inr) !== Number(priceInr)) {
      return {
        ok: false,
        status: 500,
        error: `Theme "${themeId}" did not save the requested price.`,
      };
    }
    if (priceUsd !== undefined && Number(saved.price_usd) !== Number(priceUsd)) {
      return {
        ok: false,
        status: 500,
        error: `Theme "${themeId}" did not save the requested USD price.`,
      };
    }
  }

  const firstBefore = beforeRows?.length ? asRecord(beforeRows[0]) : null;
  const firstAfter = afterRows?.length ? asRecord(afterRows[0]) : null;
  return {
    ok: true,
    before: {
      tier,
      price_inr: firstBefore ? Number(firstBefore.price_inr) : null,
      price_usd: firstBefore ? Number(firstBefore.price_usd) : null,
      themes: beforeRows ?? [],
    },
    after: {
      tier,
      price_inr: priceInr !== undefined ? Number(priceInr) : firstAfter ? Number(firstAfter.price_inr) : null,
      price_usd: priceUsd !== undefined ? Number(priceUsd) : firstAfter ? Number(firstAfter.price_usd) : null,
      themes: afterRows ?? [],
    },
  };
};

const execThemeVisibility = async (
  client: any,
  id: string,
  deleted: boolean,
): Promise<ExecResult> => {
  const { data: existing, error } = await client
    .from("theme_overrides")
    .select("*")
    .eq("theme_id", id)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };

  const { data: after, error: upsertError } = await client
    .from("theme_overrides")
    .upsert(
      {
        theme_id: id,
        patch: existing?.patch ?? {},
        deleted,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "theme_id" },
    )
    .select("*")
    .single();
  if (upsertError) return { ok: false, status: 500, error: upsertError.message };

  return {
    ok: true,
    before: existing ? asRecord(existing) : { theme_id: id, deleted: false },
    after: asRecord(after),
  };
};

const execThemeDelete = async (client: any, id: string): Promise<ExecResult> => {
  // A custom theme is a real row; a built-in one is hidden with an override.
  const { data: custom, error } = await client
    .from("custom_themes")
    .select("id, data")
    .eq("id", id)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };

  if (custom) {
    const { error: deleteError } = await client.from("custom_themes").delete().eq("id", id);
    if (deleteError) return { ok: false, status: 500, error: deleteError.message };
    return { ok: true, before: asRecord(custom), after: { id, deleted: true, source: "custom" } };
  }

  const hidden = await execThemeVisibility(client, id, true);
  if (!hidden.ok) return hidden;
  return { ...hidden, after: { ...hidden.after, source: "builtin" } };
};

/*
 * Game Zone availability.
 *
 * The setting lives in `game_settings` (migration 20261016). The executor only
 * writes the fields it was given, then reads the row back and compares every
 * saved value before reporting success.
 */
const execGameUpdate = async (client: any, fields: any): Promise<ExecResult> => {
  const { data: before, error } = await client
    .from("game_settings")
    .select("*")
    .eq("game_id", GAME_ID)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.enabled !== undefined) patch.enabled = fields.enabled;
  if (fields.maintenance !== undefined) patch.maintenance = fields.maintenance;
  if (fields.sort_order !== undefined) patch.sort_order = fields.sort_order;

  if (before) {
    const { error: updateError } = await client
      .from("game_settings")
      .update(patch)
      .eq("game_id", GAME_ID);
    if (updateError) return { ok: false, status: 500, error: updateError.message };
  } else {
    const { error: insertError } = await client.from("game_settings").insert([
      {
        game_id: GAME_ID,
        enabled: fields.enabled ?? true,
        maintenance: fields.maintenance ?? false,
        sort_order: fields.sort_order ?? 0,
        updated_at: new Date().toISOString(),
      },
    ]);
    if (insertError) return { ok: false, status: 500, error: insertError.message };
  }

  const { data: after, error: readError } = await client
    .from("game_settings")
    .select("*")
    .eq("game_id", GAME_ID)
    .maybeSingle();
  if (readError) return { ok: false, status: 500, error: readError.message };
  if (!after) {
    return { ok: false, status: 500, error: "The Game Zone setting could not be read back after saving." };
  }

  for (const key of ["enabled", "maintenance", "sort_order"] as const) {
    if (fields[key] !== undefined && after[key] !== fields[key]) {
      return { ok: false, status: 500, error: `The Game Zone setting "${key}" did not save.` };
    }
  }

  return {
    ok: true,
    before: before ? asRecord(before) : { game_id: GAME_ID },
    after: asRecord(after),
  };
};

/**
 * Brand settings (site name, tagline, logo). Stored in the single
 * `site_settings` row the storefront already reads. No row means there is
 * nothing to update; the executor says so rather than inventing defaults.
 */
const execBrandUpdate = async (client: any, fields: any): Promise<ExecResult> => {
  const { data: before, error } = await client
    .from("site_settings")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!before || before.id === undefined || before.id === null) {
    return {
      ok: false,
      status: 404,
      error: "No site_settings row exists yet, so there is nothing to update. Save the brand once in Admin → Settings first.",
    };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (fields.site_name !== undefined) patch.site_name = fields.site_name;
  if (fields.brand_tagline !== undefined) patch.brand_tagline = fields.brand_tagline;
  if (fields.logo_url !== undefined) patch.logo_url = fields.logo_url;

  const { data: after, error: updateError } = await client
    .from("site_settings")
    .update(patch)
    .eq("id", before.id)
    .select("*")
    .single();
  if (updateError) return { ok: false, status: 500, error: updateError.message };

  for (const key of ["site_name", "brand_tagline", "logo_url"] as const) {
    if (fields[key] !== undefined && after[key] !== fields[key]) {
      return { ok: false, status: 500, error: `The brand setting "${key}" did not save.` };
    }
  }

  return { ok: true, before: asRecord(before), after: asRecord(after) };
};

/*
 * ReportCard Studio plan pricing (studio_plan_prices, migration 20261023).
 *
 * This row is what the `entitlement` function charges and records, so the
 * executor reads it before the write and proves every requested value after it —
 * including the billing duration, which changes what a subscription buys.
 * A plan id that is not in the table is a 404, never a silent insert.
 */
const execPlanPriceUpdate = async (client: any, id: string, fields: any): Promise<ExecResult> => {
  const { data: before, error } = await client
    .from("studio_plan_prices")
    .select("*")
    .eq("plan_id", id)
    .maybeSingle();
  if (error) return { ok: false, status: 500, error: error.message };
  if (!before) {
    return {
      ok: false,
      status: 404,
      error: `No ReportCard Studio plan has the id "${id}".`,
    };
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const priceInr = fields.price_inr ?? fields.price;
  if (priceInr !== undefined) patch.price_inr = priceInr;
  if (fields.price_usd !== undefined) patch.price_usd = fields.price_usd;
  if (fields.duration_months !== undefined) patch.duration_months = fields.duration_months;
  if (Object.keys(patch).length === 1) {
    return { ok: false, status: 400, error: "No supported plan fields to change." };
  }

  const { data: after, error: updateError } = await client
    .from("studio_plan_prices")
    .update(patch)
    .eq("plan_id", id)
    .select("*")
    .single();
  if (updateError) return { ok: false, status: 500, error: updateError.message };
  if (!after) {
    return { ok: false, status: 500, error: "The plan price could not be read back after saving." };
  }

  /* Read-back verification: a mismatch is a failure, never a success message. */
  if (priceInr !== undefined && Number(after.price_inr) !== Number(priceInr)) {
    return { ok: false, status: 500, error: "The saved INR plan price could not be verified." };
  }
  if (fields.price_usd !== undefined && Number(after.price_usd) !== Number(fields.price_usd)) {
    return { ok: false, status: 500, error: "The saved USD plan price could not be verified." };
  }
  if (
    fields.duration_months !== undefined &&
    Number(after.duration_months) !== Number(fields.duration_months)
  ) {
    return { ok: false, status: 500, error: "The saved plan duration could not be verified." };
  }

  return { ok: true, before: asRecord(before), after: asRecord(after) };
};

const roundMoney = (value: number): number => Math.round(value * 100) / 100;

/** A new price for one item. Free items stay free in every bulk change. */
const bulkNextPrice = (
  current: number,
  mode: "set" | "increase_percent" | "decrease_percent",
  value: number,
): number => {
  if (!(current > 0)) return current;
  const next =
    mode === "set"
      ? value
      : mode === "increase_percent"
        ? current * (1 + value / 100)
        : current * (1 - value / 100);
  return roundMoney(Math.min(LIMITS.price, Math.max(0, next)));
};

/**
 * Catalogue-wide price change.
 *
 * The server recalculates every price from the rows it is about to write — the
 * client only sends the rule (scope, mode, value, currency). Rows are read
 * before and after, and every requested change is verified. Free (₹0 / $0)
 * items are deliberately left at zero so a percentage command cannot turn the
 * free Welcome Card into a paid product.
 */
const execBulkPriceUpdate = async (
  client: any,
  bulk: { scope: "products" | "themes"; mode: "set" | "increase_percent" | "decrease_percent"; value: number; currency: "INR" | "USD" },
): Promise<ExecResult> => {
  const { scope, mode, value, currency } = bulk;

  if (scope === "products") {
    const { data: rows, error } = await client
      .from("products")
      .select("id, name, price, price_usd");
    if (error) return { ok: false, status: 500, error: error.message };

    const changes = (rows ?? [])
      .map((row: Record<string, unknown>) => {
        const id = String(row.id ?? "");
        const current = Number(currency === "INR" ? row.price : row.price_usd) || 0;
        const next = bulkNextPrice(current, mode, value);
        return { id, name: String(row.name ?? ""), current, next };
      })
      .filter((row: { id: string; current: number; next: number }) => row.id && row.next !== row.current);

    if (!changes.length) {
      return { ok: false, status: 400, error: "No priced products would change with that rule (free items stay free)." };
    }
    if (changes.length > MAX_BULK_ITEMS) {
      return { ok: false, status: 400, error: `One bulk change may touch at most ${MAX_BULK_ITEMS} products.` };
    }

    for (const change of changes) {
      const patch = currency === "INR" ? { price: change.next } : { price_usd: change.next };
      const { error: writeError } = await client.from("products").update(patch).eq("id", change.id);
      if (writeError) return { ok: false, status: 500, error: writeError.message };
    }

    const { data: afterRows, error: verifyError } = await client
      .from("products")
      .select("id, name, price, price_usd")
      .in("id", changes.map((change: { id: string }) => change.id));
    if (verifyError) return { ok: false, status: 500, error: verifyError.message };
    const afterById = new Map<string, Record<string, unknown>>();
    for (const row of afterRows ?? []) {
      afterById.set(String((row as Record<string, unknown>).id), asRecord(row));
    }
    for (const change of changes) {
      const saved = afterById.get(change.id);
      const savedPrice = Number(currency === "INR" ? saved?.price : saved?.price_usd);
      if (!saved || savedPrice !== change.next) {
        return { ok: false, status: 500, error: `The new price for product "${change.name}" could not be verified.` };
      }
    }

    return {
      ok: true,
      before: { scope, currency, samples: changes.slice(0, 10).map((c: { name: string; current: number }) => ({ name: c.name, price: c.current })) },
      after: { scope, currency, updated: changes.length, samples: changes.slice(0, 10).map((c: { name: string; next: number }) => ({ name: c.name, price: c.next })) },
    };
  }

  const { data: rows, error } = await client
    .from("theme_prices")
    .select("theme_id, price_inr, price_usd");
  if (error) return { ok: false, status: 500, error: error.message };

  const changes = (rows ?? [])
    .map((row: Record<string, unknown>) => {
      const themeId = String(row.theme_id ?? "");
      const beforeInr = Number(row.price_inr) || 0;
      const beforeUsd = Number(row.price_usd) || 0;
      const current = currency === "INR" ? beforeInr : beforeUsd;
      const next = bulkNextPrice(current, mode, value);
      return { themeId, beforeInr, beforeUsd, current, next };
    })
    .filter((row: { themeId: string; current: number; next: number }) => row.themeId && row.next !== row.current);

  if (!changes.length) {
    return { ok: false, status: 400, error: "No priced greeting themes would change with that rule (free items stay free)." };
  }
  if (changes.length > MAX_BULK_ITEMS) {
    return { ok: false, status: 400, error: `One bulk change may touch at most ${MAX_BULK_ITEMS} themes.` };
  }

  const now = new Date().toISOString();
  const payload = changes.map((change: { themeId: string; beforeInr: number; beforeUsd: number; next: number }) => ({
    theme_id: change.themeId,
    price_inr: currency === "INR" ? change.next : change.beforeInr,
    price_usd: currency === "USD" ? change.next : change.beforeUsd,
    updated_at: now,
  }));

  const { error: writeError } = await client
    .from("theme_prices")
    .upsert(payload, { onConflict: "theme_id" });
  if (writeError) return { ok: false, status: 500, error: writeError.message };

  const { data: afterRows, error: verifyError } = await client
    .from("theme_prices")
    .select("theme_id, price_inr, price_usd")
    .in("theme_id", changes.map((change: { themeId: string }) => change.themeId));
  if (verifyError) return { ok: false, status: 500, error: verifyError.message };
  const afterById = new Map<string, Record<string, unknown>>();
  for (const row of afterRows ?? []) {
    afterById.set(String((row as Record<string, unknown>).theme_id), asRecord(row));
  }
  for (const change of changes) {
    const saved = afterById.get(change.themeId);
    const savedPrice = Number(currency === "INR" ? saved?.price_inr : saved?.price_usd);
    if (!saved || savedPrice !== change.next) {
      return { ok: false, status: 500, error: `The new price for theme "${change.themeId}" could not be verified.` };
    }
  }

  return {
    ok: true,
    before: { scope, currency, samples: changes.slice(0, 10).map((c: { themeId: string; current: number }) => ({ themeId: c.themeId, price: c.current })) },
    after: { scope, currency, updated: changes.length, samples: changes.slice(0, 10).map((c: { themeId: string; next: number }) => ({ themeId: c.themeId, price: c.next })) },
  };
};

const countRows = async (client: any, table: string): Promise<number | null> => {
  const { count, error } = await client
    .from(table)
    .select("*", { count: "exact", head: true });
  if (error) {
    console.error(`admin-ops count ${table} failed:`, error.message);
    return null;
  }
  return count ?? 0;
};

const buildReport = async (
  client: any,
  action: string,
): Promise<{ text: string; after: Record<string, unknown> } | ExecFail> => {
  if (action === "report.audit") {
    const { data, error } = await client
      .from("admin_audit_log")
      .select("id, actor_email, action, target_name, outcome, created_at")
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return { ok: false, status: 500, error: error.message };
    const rows = data ?? [];
    return { text: `${rows.length} recent audit entries.`, after: { entries: rows } };
  }

  if (action === "report.orders") {
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    const { count: todayCount, error } = await client
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .gte("created_at", since.toISOString());
    if (error) return { ok: false, status: 500, error: error.message };
    const total = await countRows(client, "transactions");
    return {
      text: `${todayCount ?? 0} transaction(s) since midnight, ${total ?? 0} in total.`,
      after: { todayCount: todayCount ?? 0, totalCount: total },
    };
  }

  const products = await countRows(client, "products");
  const pricedThemes = await countRows(client, "theme_prices");
  const customThemes = await countRows(client, "custom_themes");
  const visits = await countRows(client, "site_visits");
  return {
    text: `${products ?? "?"} products, ${pricedThemes ?? "?"} priced themes, ${customThemes ?? 0} custom themes live.`,
    after: { products, pricedThemes, customThemes, visits },
  };
};

/* ------------------------------------------------------------------ */
/* Handler                                                            */
/* ------------------------------------------------------------------ */

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const ip = clientIp(req);

  try {
    const client = createAdminClient();

    /* 1. Session: the JWT is verified against Supabase Auth. */
    const user = await getUserFromRequest(req);
    if (!user) {
      // Count failed authentications per IP so credential stuffing is limited.
      try {
        await consumeRateLimit(
          client,
          `auth_fail:${ip || "unknown"}`,
          LIMITS.authFailuresPerWindow,
          LIMITS.authFailureWindowSeconds,
        );
      } catch (rateError) {
        if (!(rateError instanceof RateLimitBackendUnavailable)) throw rateError;
      }
      return errorResponse("A valid administrator session is required", 401);
    }

    /* 2. Admin membership: the trusted server-side check. */
    const admin = await isAdminUser(user.id);
    if (!admin) {
      await recordAudit(client, {
        actorId: user.id,
        actorEmail: user.email ?? null,
        action: "unknown",
        outcome: "denied",
        detail: "Non-admin account attempted an admin operation.",
        ip,
      });
      return errorResponse("Administrator access required", 403);
    }

    /* 3. Per-actor rate limit. */
    const limit = await consumeRateLimit(
      client,
      `admin_ops:${user.id}`,
      LIMITS.opsPerWindow,
      LIMITS.opsWindowSeconds,
    );
    if (!limit.allowed) {
      await recordAudit(client, {
        actorId: user.id,
        actorEmail: user.email ?? null,
        action: "unknown",
        outcome: "blocked",
        detail: "Rate limit exceeded.",
        ip,
      });
      return jsonResponse(
        {
          success: false,
          error: "Too many admin commands. Please wait a moment and try again.",
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        429,
      );
    }

    /* 4. Server-derived permissions (never from the body). */
    const { data: adminRow } = await client
      .from("admin_users")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle();
    const permissions = Array.isArray(adminRow?.permissions) ? adminRow.permissions : null;

    const body = await req.json().catch(() => null);

    /* 5. Validation + permission gate. */
    const validated = validateAdminOpRequest(body, permissions, true);
    if (!validated.ok) {
      const raw = (body ?? {}) as Record<string, unknown>;
      const auditId = await recordAudit(client, {
        actorId: user.id,
        actorEmail: user.email ?? null,
        action: validated.action ?? "unknown",
        targetId: safe(raw.targetId, LIMITS.targetId) || null,
        targetName: safe(raw.targetName, LIMITS.targetName) || null,
        outcome: validated.denied ? "denied" : "blocked",
        detail: validated.error,
        ip,
      });
      return jsonResponse(
        { success: false, error: validated.error, auditId },
        validated.status,
      );
    }

    const op = validated.request;

    /* 6. Execute, verify, audit. */
    let result: ExecResult;
    switch (op.action) {
      case "product.create":
        result = await execProductCreate(client, op.fields);
        break;
      case "product.update":
        result = await execProductUpdate(client, op.targetId!, op.fields);
        break;
      case "product.delete":
        result = await execProductDelete(client, op.targetId!);
        break;
      case "theme.update":
        result = await execThemeUpdate(client, op.targetId!, op.fields);
        break;
      case "theme.publish":
        result = await execThemeVisibility(client, op.targetId!, false);
        break;
      case "theme.unpublish":
        result = await execThemeVisibility(client, op.targetId!, true);
        break;
      case "theme.delete":
        result = await execThemeDelete(client, op.targetId!);
        break;
      case "pricing.tier.update":
        result = await execTierPriceUpdate(client, op.tier!, op.themeIds, op.fields);
        break;
      case "pricing.bulk.update":
        result = await execBulkPriceUpdate(client, op.bulk!);
        break;
      case "pricing.plan.update":
        result = await execPlanPriceUpdate(client, op.targetId!, op.fields);
        break;
      case "game.update":
        result = await execGameUpdate(client, op.fields);
        break;
      case "brand.update":
        result = await execBrandUpdate(client, op.fields);
        break;
      default: {
        const report = await buildReport(client, op.action);
        if ("ok" in report && report.ok === false) {
          result = report as ExecFail;
        } else {
          const ok = report as { text: string; after: Record<string, unknown> };
          const auditId = await recordAudit(client, {
            actorId: user.id,
            actorEmail: user.email ?? null,
            action: op.action,
            outcome: "success",
            detail: ok.text,
            after: redactSecrets(ok.after) as Record<string, unknown>,
            ip,
          });
          return jsonResponse({
            success: true,
            action: op.action,
            text: ok.text,
            result: { after: ok.after },
            auditId,
            ...(auditId ? {} : { auditWarning: AUDIT_WARNING }),
          });
        }
      }
    }

    const auditTargetId =
      op.action === "pricing.tier.update" ? `tier:${op.tier}` : op.targetId;
    const auditTargetName =
      op.action === "pricing.tier.update"
        ? op.tier
        : op.action === "pricing.plan.update"
          ? (result.after?.name as string | undefined) ?? op.targetName
          : op.targetName;
    const auditTargetType =
      op.action === "pricing.tier.update"
        ? "tier"
        : op.action === "pricing.plan.update"
          ? "studio_plan"
          : undefined;

    if (!result.ok) {
      const auditId = await recordAudit(client, {
        actorId: user.id,
        actorEmail: user.email ?? null,
        action: op.action,
        targetType: auditTargetType,
        targetId: auditTargetId,
        targetName: auditTargetName,
        outcome: "failure",
        detail: result.error,
        ip,
      });
      return jsonResponse({ success: false, error: result.error, auditId }, result.status);
    }

    const auditId = await recordAudit(client, {
      actorId: user.id,
      actorEmail: user.email ?? null,
      action: op.action,
      targetType: auditTargetType,
      targetId: auditTargetId,
      targetName:
        auditTargetName ?? (result.after?.name as string | undefined) ?? null,
      outcome: "success",
      detail: `Persisted by ${user.email ?? user.id}.`,
      before: result.before,
      after: result.after,
      ip,
    });

    const notStored = [...new Set([...(result.notStored ?? []), ...op.notStored])];
    return jsonResponse({
      success: true,
      action: op.action,
      result: { before: result.before ?? null, after: result.after },
      auditId,
      // The change really was applied, but the audit row could not be written.
      // Say so instead of implying the action was fully recorded.
      ...(auditId ? {} : { auditWarning: AUDIT_WARNING }),
      ...(notStored.length ? { notStored } : {}),
    });
  } catch (error) {
    if (error instanceof RateLimitBackendUnavailable) {
      console.error("admin-ops rate-limit backend unavailable:", error.message);
      return errorResponse(          "The server rate-limit store is unavailable, so this command was refused. Apply migration 20261022_step16_atomic_admin_rate_limit.sql (it also re-creates the step-13 table and grants service_role access).",
        503,
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("admin-ops failed:", message);
    return errorResponse("The admin operation could not be completed.", 500);
  }
});
