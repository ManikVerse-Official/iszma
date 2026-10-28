// @ts-nocheck
//
// create-free-greeting — the one free basic card
// ---------------------------------------------------------------------------
// Mints a free greeting card for the single designated free theme. There is no
// payment. The free-use limit is enforced server-side BEFORE anything is written:
//
//   one free card per email per ROLLING 24 hours, and at most two free cards
//   from one network (the existing policy).
//
// The check-and-claim happens in one atomic database function
// (`consume_free_greeting`, migration 20261025_step19), so two concurrent
// requests cannot both claim the same slot. The claim is released again if the
// card row cannot be written, so a failed attempt never burns the 24-hour window.
//
// Failure responses always carry a machine-readable `code` so the browser can
// tell a reached limit (429) apart from an unverifiable limit (503) instead of
// treating every 429 as "you used your free card".
//
// POST body mirrors create-greeting, minus `payment`.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/auth.ts";
import { clientIp } from "../_shared/entitlement.ts";
import {
  claimFreeGreeting,
  freeGreetingStatus,
  releaseFreeGreetingClaim,
} from "../_shared/freeGreeting.ts";
import { resolveAdminAccess } from "../_shared/adminAccess.ts";
import { FREE_LIMITS } from "../_shared/plans.ts";

const FREE_THEME_ID = "free-basic-wish";
const GREETING_LIFESPAN_MS = 48 * 60 * 60 * 1000;

const ALLOWED_FONTS = new Set([
  "classic-serif", "elegant-display", "luxe-display", "editorial",
  "festive-decorative", "modern-sans", "clean-geometric", "bold-display",
  "romantic-script", "festive-script", "calligraphy", "handwritten", "playful",
  "marcellus", "dm-serif", "yeseva", "lora", "josefin", "outfit", "fredoka",
  "bebas", "satisfy", "kaushan", "parisienne", "permanent-marker",
]);

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.trim().slice(0, max) : "";
const isEmail = (value: string): boolean =>
  value === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isSafeImageUrl = (url: string): boolean => url === "" || /^https?:\/\/.+/i.test(url);
const safeColor = (value: unknown): string | null => {
  const raw = clean(value, 9).toLowerCase();
  return /^#[0-9a-f]{6}$/.test(raw) ? raw : null;
};
const newCardId = (): string => {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 8; i += 1) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
};

/** Structured, non-secret failure. */
const failure = (
  req: Request,
  status: number,
  code: string,
  error: string,
  extra: Record<string, unknown> = {},
): Response => jsonResponse({ success: false, code, error, ...extra }, status, req);

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return failure(req, 405, "METHOD_NOT_ALLOWED", "Method not allowed");

  const ip = clientIp(req);
  const supabase = createAdminClient();

  try {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") {
      return failure(req, 400, "INVALID_REQUEST", "A JSON body is required");
    }

    const senderName = clean(body.sender_name, 80);
    const receiverName = clean(body.receiver_name, 80);
    const message = clean(body.message, 2000);
    const theme = clean(body.theme, 80) || FREE_THEME_ID;

    if (theme !== FREE_THEME_ID) {
      return failure(
        req,
        402,
        "PAID_THEME",
        "Only the free welcome card can be published without payment.",
      );
    }
    if (!senderName || !receiverName || !message) {
      return failure(req, 400, "INVALID_REQUEST", "Sender, receiver and message are all required");
    }

    const clientEmail = clean(body.client_email, 150).toLowerCase();
    if (!isEmail(clientEmail)) {
      return failure(req, 400, "INVALID_REQUEST", "Please provide a valid email address");
    }

    const imageUrl = clean(body.external_image_url, 500);
    if (!isSafeImageUrl(imageUrl)) {
      return failure(req, 400, "INVALID_REQUEST", "Image URL must be an http(s) link");
    }

    /*
     * Owner/staff use Ishmaverse without charges or usage limits. The check is the
     * shared server-side one (`_shared/adminAccess.ts`), so it depends on a
     * verified Supabase session and `admin_users` — never on the email in this
     * request body.
     *
     * An admin claim is NOT written to `usage_events`, so it neither consumes
     * their free card nor blocks a normal user behind the same network.
     */
    const access = await resolveAdminAccess(req, supabase);
    const freeLimit = FREE_LIMITS.free_greeting;

    const decision: {
      allowed: boolean;
      remaining: number;
      claimId?: string | null;
      code?: string;
      message?: string;
      retryAfterSeconds?: number;
    } = access.isAdmin
      ? { allowed: true, remaining: Math.max(0, freeLimit?.perEmail ?? 1) }
      : await claimFreeGreeting(supabase, clientEmail, ip);

    if (access.isAdmin) {
      console.log("Free greeting: verified admin, limit bypassed");
    }

    if (!decision.allowed) {
      return failure(
        req,
        freeGreetingStatus(decision.code),
        decision.code ?? "USAGE_UNAVAILABLE",
        decision.message ?? "Free card limit reached",
        {
          ...(decision.retryAfterSeconds
            ? { retryAfterSeconds: decision.retryAfterSeconds }
            : {}),
          // Only a reached limit is final; an unverifiable limit is retryable.
          retryable: decision.code === "USAGE_UNAVAILABLE",
        },
      );
    }

    const requestedFont = clean(body.font, 40);
    const font = ALLOWED_FONTS.has(requestedFont) ? requestedFont : "classic-serif";
    /*
     * A shipped stock track ("/audio/…") or a sender-uploaded MP3/https URL.
     * The free welcome card is a Basic tier, so it normally carries no audio,
     * but the same validation keeps the field safe if one is ever added.
     */
    const rawAudioTrack =
      typeof body.audio_track === "string" ? body.audio_track.trim() : "";
    const audioTrack =
      rawAudioTrack.startsWith("/audio/") || /^https:\/\//i.test(rawAudioTrack)
        ? rawAudioTrack.slice(0, 500)
        : null;

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + GREETING_LIFESPAN_MS);
    const cardId = newCardId();
    const managementToken = crypto.randomUUID();
    const paymentId = `FREE-${cardId}`;

    const { data: card, error: cardError } = await supabase
      .from("greeting_cards")
      .insert([
        {
          id: cardId,
          sender_name: senderName,
          receiver_name: receiverName,
          message,
          theme,
          font,
          external_image_url: imageUrl,
          created_at: createdAt.toISOString(),
          expires_at: expiresAt.toISOString(),
          management_token: managementToken,
          amount: 0,
          paid: true,
          payment_id: paymentId,
          ...(safeColor(body.text_color) ? { text_color: safeColor(body.text_color) } : {}),
          ...(safeColor(body.title_color) ? { title_color: safeColor(body.title_color) } : {}),
          ...(safeColor(body.background_color_start)
            ? { background_color_start: safeColor(body.background_color_start) }
            : {}),
          ...(safeColor(body.background_color_end)
            ? { background_color_end: safeColor(body.background_color_end) }
            : {}),
          ...(clean(body.title, 80) ? { title: clean(body.title, 80) } : {}),
          ...(clean(body.eyebrow, 60) ? { eyebrow: clean(body.eyebrow, 60) } : {}),
          ...(clean(body.signoff, 60) ? { signoff: clean(body.signoff, 60) } : {}),
          ...(audioTrack ? { audio_track: audioTrack } : {}),
        },
      ])
      .select("*")
      .single();

    if (cardError || !card) {
      console.error("Free card insert failed:", cardError?.message);
      /* The card does not exist, so the claim must not count against the limit. */
      await releaseFreeGreetingClaim(supabase, decision.claimId);
      return failure(
        req,
        500,
        "CREATE_FAILED",
        "We could not create the greeting card. Please try again — your free card has not been used.",
        { retryable: true },
      );
    }

    // Ledger row (amount 0, provider 'free') — best-effort.
    const { data: transaction } = await supabase
      .from("transactions")
      .insert([
        {
          client_name: senderName,
          client_email: clientEmail || null,
          payment_id: paymentId,
          provider: "free",
          product_name: `${theme} — Free Greeting Card`,
          amount: 0,
          currency: "INR",
          status: "free",
        },
      ])
      .select("*")
      .single();

    /* Never log the raw address: the claim row is the auditable record. */
    console.log("Free greeting card created:", { cardId, hasIp: Boolean(ip) });

    return jsonResponse(
      { success: true, card, transaction, remaining: decision.remaining },
      200,
      req,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("create-free-greeting failed:", message);
    return failure(req, 500, "CREATE_FAILED", "We could not create your free card right now.", {
      retryable: true,
    });
  }
});
