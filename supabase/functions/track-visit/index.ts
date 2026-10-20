// @ts-nocheck
//
// track-visit — audience analytics
// ---------------------------------------------------------------------------
// Records one page view into `site_visits`. Admin traffic is skipped (verified
// from the Supabase JWT, never from the body), so the dashboard shows real
// customers only.
//
// POST body: { path?: string, referrer?: string, session_id?: string }
//
// Secrets: VISIT_HASH_SALT (optional) — salt for the non-reversible visitor hash.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient, getUserFromRequest, isAdminUser } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";
import { hashVisitor, parseBrowser, parseDevice, resolveGeo } from "../_shared/geo.ts";

const ADMIN_EMAIL = "deym85810@gmail.com";

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  /*
   * `req` is threaded into every response so the CORS headers come from the
   * allowlist (SITE_ORIGINS + local dev origins) instead of a wildcard — this is
   * the fix for the local-origin rejection. See _shared/http.ts.
   */
  if (req.method !== "POST") return errorResponse("Method not allowed", 405, req);

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const supabase = createAdminClient();

    /* ------------------------------ admin? ----------------------------- */
    // Admins are never counted as audience.
    let user = null;
    try {
      user = await getUserFromRequest(req);
    } catch {
      /* anonymous */
    }
    if (user?.id) {
      let admin = false;
      try {
        admin = await isAdminUser(user.id);
      } catch {
        /* ignore */
      }
      if (user.email && user.email.toLowerCase().trim() === ADMIN_EMAIL) admin = true;
      if (admin) {
        return jsonResponse({ success: true, tracked: false, reason: "admin" }, 200, req);
      }
    }

    /* ----------------------------- collect ----------------------------- */
    const ip = clientIp(req);
    const userAgent = req.headers.get("user-agent") ?? "";
    const geo = await resolveGeo(req, ip);
    const visitorHash = await hashVisitor(ip || userAgent || "unknown");

    const path = clean(body.path, 300) || "/";
    const referrer = clean(body.referrer, 300) || null;
    const sessionId = clean(body.session_id, 64) || null;

    const { error } = await supabase.from("site_visits").insert([
      {
        path,
        referrer,
        country: geo.country,
        region: geo.region,
        city: geo.city,
        device: parseDevice(userAgent),
        browser: parseBrowser(userAgent),
        session_id: sessionId,
        visitor_hash: visitorHash,
      },
    ]);

    if (error) {
      console.error("track-visit insert failed:", error.message);
      return errorResponse("Could not record the visit", 500, req);
    }

    return jsonResponse({ success: true, tracked: true }, 200, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("track-visit failed:", message);
    return errorResponse(message, 500, req);
  }
});
