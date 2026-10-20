// @ts-nocheck
//
// create-free-greeting — the one free basic card
// ---------------------------------------------------------------------------
// Mints a free greeting card for the single designated free theme. There is no
// payment: instead the free-use limits (one per email, two per IP) are enforced
// server-side via the shared usage guard, so clearing the browser cannot grant
// another free card.
//
// POST body mirrors create-greeting, minus `payment`.

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { errorResponse, handleOptions, jsonResponse } from "../_shared/http.ts";
import { createAdminClient } from "../_shared/auth.ts";
import { checkAndConsumeTrial, clientIp } from "../_shared/entitlement.ts";

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

serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const ip = clientIp(req);
  const supabase = createAdminClient();

  try {
    const body = (await req.json()) as Record<string, unknown>;

    const senderName = clean(body.sender_name, 80);
    const receiverName = clean(body.receiver_name, 80);
    const message = clean(body.message, 2000);
    const theme = clean(body.theme, 80) || FREE_THEME_ID;

    if (theme !== FREE_THEME_ID) {
      return errorResponse("Only the free basic card is available without payment", 402);
    }
    if (!senderName || !receiverName || !message) {
      return errorResponse("Sender, receiver and message are all required", 400);
    }

    const clientEmail = clean(body.client_email, 150).toLowerCase();
    if (!isEmail(clientEmail)) {
      return errorResponse("Please provide a valid email address", 400);
    }

    const imageUrl = clean(body.external_image_url, 500);
    if (!isSafeImageUrl(imageUrl)) {
      return errorResponse("Image URL must be an http(s) link", 400);
    }

    // Enforce one free card per email, at most two per IP.
    const decision = await checkAndConsumeTrial(supabase, "free_greeting", clientEmail, ip);
    if (!decision.allowed) {
      return errorResponse(decision.reason ?? "Free card limit reached", 429);
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
      return errorResponse("Could not create the greeting card", 500);
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

    console.log("Free greeting card created:", { cardId, ip: ip || null });

    return jsonResponse({ success: true, card, transaction, remaining: decision.remaining });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("create-free-greeting failed:", message);
    return errorResponse(message, 500);
  }
});
