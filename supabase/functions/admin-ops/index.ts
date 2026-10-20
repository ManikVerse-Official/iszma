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
  LIMITS,
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

/**
 * Fixed-window limit backed by `admin_rate_limits` (service-role only).
 * If the counter table cannot be read the request is refused rather than
 * allowed, so a missing migration can never silently remove the limit.
 */
const consumeRateLimit = async (
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

    if (!result.ok) {
      const auditId = await recordAudit(client, {
        actorId: user.id,
        actorEmail: user.email ?? null,
        action: op.action,
        targetId: op.targetId,
        targetName: op.targetName,
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
      targetId: op.targetId,
      targetName: op.targetName ?? (result.after?.name as string | undefined) ?? null,
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
      return errorResponse(
        "The server rate-limit store is unavailable, so this command was refused. Apply migration 20261014_step13_admin_ops.sql.",
        503,
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("admin-ops failed:", message);
    return errorResponse("The admin operation could not be completed.", 500);
  }
});
