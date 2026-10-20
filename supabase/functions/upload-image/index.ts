// upload-image — server-side ImgBB proxy
// ---------------------------------------------------------------------------
// The greeting flow used to call ImgBB straight from the browser with
// VITE_IMGBB_API_KEY, which put the key in the shipped JavaScript bundle. Now
// the browser posts the file here and the key stays a Supabase secret
// (`supabase secrets set IMGBB_API_KEY=...`) that never leaves the server.
//
// Guards, in order:
//   1. CORS / method / multipart body
//   2. file present, non-empty, <= 5 MB, image mime type only
//   3. durable per-IP limit (30 uploads / hour, recorded in usage_events)
//   4. upload to ImgBB with the server-side key, images expire after 48h
//
// Guests upload before paying, so this function accepts anonymous calls
// (verify_jwt = false). The limits above are what keep it from being abused as
// a free image host.
//
// Secrets: IMGBB_API_KEY (required)
// Deploy:  supabase functions deploy upload-image   (verify_jwt = false)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";

const MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Matches the card's own 48-hour life. */
const DEFAULT_EXPIRATION_SECONDS = 172800;
const MIN_EXPIRATION_SECONDS = 60;
const MAX_EXPIRATION_SECONDS = 15552000; // ImgBB's documented ceiling

const MAX_UPLOADS_PER_IP_PER_HOUR = 30;
const RATE_FEATURE = "image_upload";

const clampExpiration = (value: unknown): number => {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_EXPIRATION_SECONDS;
  return Math.min(MAX_EXPIRATION_SECONDS, Math.max(MIN_EXPIRATION_SECONDS, Math.floor(seconds)));
};

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const ip = clientIp(req);

  try {
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      return errorResponse("Send the photo as multipart/form-data.", 415);
    }

    const form = await req.formData();
    const file = form.get("image");

    if (!(file instanceof File) || file.size === 0) {
      return errorResponse("Please choose a photo to upload.", 400);
    }

    if (file.size > MAX_BYTES) {
      return errorResponse("That photo is larger than 5 MB. Please choose a smaller one.", 413);
    }

    const mime = (file.type || "").toLowerCase();
    if (!ALLOWED_TYPES.has(mime)) {
      return errorResponse("Please upload a JPEG, PNG, WebP or GIF image.", 415);
    }

    const apiKey = Deno.env.get("IMGBB_API_KEY");
    if (!apiKey) {
      console.error("upload-image: IMGBB_API_KEY is not set");
      return errorResponse("Image uploads are temporarily unavailable.", 503);
    }

    const supabase = createAdminClient();

    // Durable per-IP limit so clearing the browser cannot reset it.
    if (ip) {
      const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const { count, error: countError } = await supabase
        .from("usage_events")
        .select("id", { count: "exact", head: true })
        .eq("feature", RATE_FEATURE)
        .eq("ip", ip)
        .gte("created_at", since);

      if (countError) {
        console.error("upload-image: rate-limit read failed:", countError.message);
        return errorResponse("Image uploads are temporarily unavailable.", 503);
      }

      if ((count ?? 0) >= MAX_UPLOADS_PER_IP_PER_HOUR) {
        return errorResponse(
          "Too many photo uploads from this network. Please try again in a little while.",
          429,
        );
      }
    }

    const forwarded = new FormData();
    forwarded.append("image", file);
    forwarded.append("expiration", String(clampExpiration(form.get("expiration"))));

    const response = await fetch(`https://api.imgbb.com/1/upload?key=${encodeURIComponent(apiKey)}`, {
      method: "POST",
      body: forwarded,
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.success || !data?.data?.url) {
      console.error("upload-image: ImgBB rejected the upload", response.status, data?.error?.message);
      return errorResponse("We could not upload that photo. Please try a different one.", 502);
    }

    // Record the successful upload against the IP (best-effort).
    if (ip) {
      const { error: insertError } = await supabase
        .from("usage_events")
        .insert([{ feature: RATE_FEATURE, email: null, ip }]);
      if (insertError) console.warn("upload-image: usage record not written:", insertError.message);
    }

    return jsonResponse({
      success: true,
      url: String(data.data.url),
      display_url: String(data.data.display_url ?? data.data.url),
      thumb_url: String(data.data.thumb?.url ?? ""),
      delete_url: String(data.data.delete_url ?? ""),
      expires_in: clampExpiration(form.get("expiration")),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("upload-image failed:", message);
    return errorResponse("We could not upload that photo. Please try again.", 500);
  }
});
