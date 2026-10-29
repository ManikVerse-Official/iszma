// @ts-nocheck

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

import {
  errorResponse,
  handleOptions,
  jsonResponse,
} from "../_shared/http.ts";

import {
  createAdminClient,
  getUserFromRequest,
} from "../_shared/auth.ts";

import { resolveAdminAccess } from "../_shared/adminAccess.ts";

import {
  expectedAmount,
  loadThemePrices,
  settlementCurrency,
  type Currency,
} from "../_shared/pricing.ts";

import {
  verifyPayPalPayment,
  verifyRazorpayPayment,
  verifyStripePayment,
  type PaymentProof,
  type VerifiedPayment,
} from "../_shared/payments.ts";

import { clientIp } from "../_shared/entitlement.ts";
import { issueReceiptForTransaction } from "../_shared/receipts.ts";
import type { ReceiptLedgerRow } from "../_shared/receiptsCore.ts";



const GREETING_LIFESPAN_HOURS = 48;
const GREETING_LIFESPAN_MS =
  GREETING_LIFESPAN_HOURS * 60 * 60 * 1000;


interface CreateGreetingRequest {
  sender_name?: string;
  receiver_name?: string;
  message?: string;
  theme?: string;
  font?: string;

  external_image_url?: string;

  text_color?: string;
  title_color?: string;
  message_color?: string;
  signature_color?: string;

  background_color?: string;
  background_color_start?: string;
  background_color_end?: string;
  background_gradient_angle?: number;

  title?: string;
  eyebrow?: string;
  signoff?: string;

  audio_track?: string;

  client_email?: string;

  currency?: Currency;

  payment?: PaymentProof;
}


/* -----------------------------------------------------------
   ALLOWED FONTS
----------------------------------------------------------- */

const ALLOWED_FONTS = new Set([
  "classic-serif",
  "elegant-display",
  "luxe-display",
  "editorial",
  "festive-decorative",
  "modern-sans",
  "clean-geometric",
  "bold-display",
  "romantic-script",
  "festive-script",
  "calligraphy",
  "handwritten",
  "playful",
  "marcellus",
  "dm-serif",
  "yeseva",
  "lora",
  "josefin",
  "outfit",
  "fredoka",
  "bebas",
  "satisfy",
  "kaushan",
  "parisienne",
  "permanent-marker",
]);

const DEFAULT_FONT = "classic-serif";


/* -----------------------------------------------------------
   HELPERS
----------------------------------------------------------- */

const newCardId = (): string => {
  const alphabet =
    "abcdefghijkmnpqrstuvwxyz23456789";

  let id = "";

  for (let i = 0; i < 8; i += 1) {
    id += alphabet[
      Math.floor(Math.random() * alphabet.length)
    ];
  }

  return id;
};


const clean = (
  value: unknown,
  max: number
): string =>
  typeof value === "string"
    ? value.trim().slice(0, max)
    : "";


const isSafeImageUrl = (
  url: string
): boolean =>
  url === "" ||
  /^https?:\/\/.+/i.test(url);


const isEmail = (
  value: string
): boolean =>
  value === "" ||
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);


const safeColor = (
  value: unknown
): string | null => {
  const raw = clean(value, 9).toLowerCase();

  return /^#[0-9a-f]{6}$/.test(raw)
    ? raw
    : null;
};


const safeAngle = (
  value: unknown
): number | null => {

  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const n =
    typeof value === "number"
      ? value
      : Number(value);

  if (!Number.isFinite(n)) {
    return null;
  }

  return Math.round(
    ((n % 360) + 360) % 360
  );
};


/* -----------------------------------------------------------
   RECEIPT HELPER

   Never throws: an email/receipt problem must not turn a settled payment into
   an error the buyer sees. The result is shaped for the browser so it does not
   send a second copy.
----------------------------------------------------------- */

interface ReceiptInfo {
  receipt: Record<string, unknown>;
  emailed: boolean;
  emailStatus: string;
  error?: string;
}

const safeIssueReceipt = async (
  supabase: ReturnType<typeof createAdminClient>,
  transaction: ReceiptLedgerRow | null | undefined,
  req: Request,
): Promise<ReceiptInfo | null> => {
  if (!transaction?.id || !transaction.payment_id) return null;

  try {
    const issued = await issueReceiptForTransaction(supabase, transaction, {
      ip: clientIp(req),
    });
    if (!issued.receipt) {
      console.error("Receipt not issued:", issued.error);
      return null;
    }
    return {
      receipt: issued.receipt as unknown as Record<string, unknown>,
      emailed: issued.emailed,
      emailStatus: issued.emailStatus,
      ...(issued.error ? { error: issued.error } : {}),
    };
  } catch (error) {
    console.error(
      "Receipt issuance failed (purchase kept):",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
};


/* -----------------------------------------------------------
   SERVER
----------------------------------------------------------- */

serve(async (req: Request) => {

  const preflight = handleOptions(req);

  if (preflight) {
    return preflight;
  }

  if (req.method !== "POST") {
    return errorResponse(
      "Method not allowed",
      405
    );
  }


  try {

    /* -------------------------------------------------------
       READ REQUEST
    ------------------------------------------------------- */

    const body =
      (await req.json()) as CreateGreetingRequest;


    const senderName =
      clean(body.sender_name, 80);

    const receiverName =
      clean(body.receiver_name, 80);

    const message =
      clean(body.message, 2000);

    const theme =
      clean(body.theme, 80);


    const requestedFont =
      clean(body.font, 40);

    const font =
      ALLOWED_FONTS.has(requestedFont)
        ? requestedFont
        : DEFAULT_FONT;


    const imageUrl =
      clean(
        body.external_image_url,
        500
      );


    const textColor =
      safeColor(body.text_color);

    const titleColor =
      safeColor(body.title_color);

    const messageColor =
      safeColor(body.message_color);

    const signatureColor =
      safeColor(body.signature_color);


    const backgroundColor =
      safeColor(body.background_color);

    const backgroundGradientStart =
      safeColor(
        body.background_color_start
      );

    const backgroundGradientEnd =
      safeColor(
        body.background_color_end
      );


    const backgroundGradientAngle =
      safeAngle(
        body.background_gradient_angle
      );


    const title =
      clean(body.title, 80);

    const eyebrow =
      clean(body.eyebrow, 60);

    const signoff =
      clean(body.signoff, 60);


    /*
     * Audio can be a shipped stock track ("/audio/…") or a sender-uploaded MP3
     * hosted in the public `greeting-audio` bucket (Premium/Elite only). Only
     * https URLs are accepted so the card never plays an insecure/mixed source.
     */
    const rawAudioTrack =
      typeof body.audio_track === "string"
        ? body.audio_track.trim()
        : "";

    const audioTrack =
      rawAudioTrack.startsWith("/audio/") ||
      /^https:\/\//i.test(rawAudioTrack)
        ? rawAudioTrack.slice(0, 500)
        : null;


    const clientEmail =
      clean(
        body.client_email,
        150
      ).toLowerCase();


    const currency: Currency =
      body.currency === "USD"
        ? "USD"
        : "INR";


    /* -------------------------------------------------------
       BASIC VALIDATION
    ------------------------------------------------------- */

    if (
      !senderName ||
      !receiverName ||
      !message
    ) {
      return errorResponse(
        "Sender, receiver and message are all required",
        400
      );
    }


    if (!isEmail(clientEmail)) {
      return errorResponse(
        "Please provide a valid email address",
        400
      );
    }


    if (!isSafeImageUrl(imageUrl)) {
      return errorResponse(
        "Image URL must be an http(s) link",
        400
      );
    }


    /* -------------------------------------------------------
       SUPABASE ADMIN CLIENT
    ------------------------------------------------------- */

    const supabase =
      createAdminClient();


    /* -------------------------------------------------------
       LOAD PRICES
    ------------------------------------------------------- */

    const prices =
      await loadThemePrices(
        supabase
      );


    if (!prices.has(theme)) {
      return errorResponse(
        "Unknown theme",
        400
      );
    }


    /* =======================================================
       ADMIN AUTHENTICATION
       
       IMPORTANT:
       
       We NEVER trust:
       
       - client_email
       - body.payment.provider
       - frontend admin flag
       
       Admin is determined from the VERIFIED
       Supabase Auth JWT.
    ======================================================= */


    let user = null;

    try {

      /*
       * First use the existing helper.
       */
      user =
        await getUserFromRequest(req);

    } catch (authError) {

      console.error(
        "getUserFromRequest failed:",
        authError
      );

    }


    /*
     * Backup verification directly from the
     * Authorization Bearer token.
     *
     * This avoids a situation where the helper
     * fails to resolve the logged-in user.
     */

    if (!user) {

      const authHeader =
        req.headers.get(
          "Authorization"
        );

      if (
        authHeader &&
        authHeader.startsWith("Bearer ")
      ) {

        const token =
          authHeader
            .substring(7)
            .trim();

        if (token) {

          try {

            const {
              data,
              error,
            } =
              await supabase.auth.getUser(
                token
              );

            if (
              !error &&
              data?.user
            ) {
              user = data.user;
            }

          } catch (tokenError) {

            console.error(
              "JWT verification failed:",
              tokenError
            );

          }

        }

      }

    }


    /* -------------------------------------------------------
       DETERMINE ADMIN
    ------------------------------------------------------- */

    /*
     * ONE central, server-verified admin check — `_shared/adminAccess.ts`.
     *
     * It verifies the Supabase JWT and reads `admin_users`; the request body
     * (including client_email) is never consulted. The admin address that used
     * to be hardcoded in this file is gone: the allowlist is a deployment
     * secret, matched only against the VERIFIED session email.
     */
    const access = await resolveAdminAccess(req, supabase);
    const admin = access.isAdmin;


    /* -------------------------------------------------------
       DEBUG LOG
       
       This will appear in Supabase Edge Function logs.
       It does NOT expose the JWT.
    ------------------------------------------------------- */

    console.log(
      "create-greeting auth:",
      {
        authenticated: !!user,
        userId: user?.id ?? null,
        authEmail: user?.email ?? null,
        admin,
      }
    );


    /* =======================================================
       PAYMENT / ADMIN
    ======================================================= */

    let settlement: VerifiedPayment;


    /* =======================================================
       ADMIN
       
       ADMIN = COMPLETELY FREE
    ======================================================= */

    if (admin) {

      console.log(
        "ADMIN CARD GENERATION - PAYMENT BYPASSED"
      );


      settlement = {

        provider: "admin",

        paymentId: "",

        amount: 0,

        currency: "INR",

      };

    }


    /* =======================================================
       NORMAL USER
       
       PAYMENT REQUIRED
    ======================================================= */

    else {

      const proof =
        body.payment;


      if (!proof?.provider) {

        return errorResponse(
          "Payment is required to create this card",
          402
        );

      }


      /* -----------------------------------------------------
         IDEMPOTENCY
      ----------------------------------------------------- */

      const lookupKey = (
        proof.payment_id ??
        proof.order_id ??
        ""
      ).trim();


      if (lookupKey) {

        const {
          data: existingTx,
        } =
          await supabase
            .from("transactions")
            .select("*")
            .eq(
              "payment_id",
              lookupKey
            )
            .maybeSingle();


        if (existingTx) {

          const {
            data: existingCard,
          } =
            await supabase
              .from("greeting_cards")
              .select("*")
              .eq(
                "payment_id",
                lookupKey
              )
              .maybeSingle();


          if (existingCard) {

            /*
             * A retried callback must not mint a second card, and must not be
             * told the order failed. If the first attempt crashed after writing
             * the ledger but before the receipt, this idempotent call fills that
             * gap without emailing twice.
             */
            const duplicateReceipt = await safeIssueReceipt(
              supabase,
              existingTx as unknown as ReceiptLedgerRow,
              req,
            );

            return jsonResponse({

              success: true,

              duplicate: true,

              card: existingCard,

              transaction: existingTx,

              ...(duplicateReceipt ? { receipt: duplicateReceipt } : {}),

            });

          }


          return errorResponse(
            "This payment has already been used",
            409
          );

        }

      }


      /* -----------------------------------------------------
         PAYMENT AMOUNT
      ----------------------------------------------------- */

      const effectiveCurrency =
        settlementCurrency(
          proof.provider,
          currency
        );


      const amount =
        expectedAmount(
          prices,
          theme,
          effectiveCurrency
        );


      if (amount === null) {

        return errorResponse(
          "Unknown theme",
          400
        );

      }

      // Free themes (the welcome card) are published through the dedicated
      // create-free-greeting flow, which enforces usage limits. A paid order
      // for ₹0 is always a client mistake, never a discount.
      if (amount <= 0) {

        return errorResponse(
          "This card is free — publish it through the free card flow (create-free-greeting).",
          402
        );

      }


      /* -----------------------------------------------------
         DEMO
      ----------------------------------------------------- */

      if (
        proof.provider === "demo"
      ) {

        if (
          Deno.env.get(
            "PAYMENT_MODE"
          ) !== "demo"
        ) {

          return errorResponse(
            "Demo payments are disabled",
            403
          );

        }


        settlement = {

          provider: "demo",

          paymentId:
            proof.payment_id?.trim() ||
            `DEMO-${crypto.randomUUID()}`,

          amount,

          currency:
            effectiveCurrency,

        };

      }


      /* -----------------------------------------------------
         RAZORPAY
      ----------------------------------------------------- */

      else if (
        proof.provider === "razorpay"
      ) {

        settlement =
          await verifyRazorpayPayment(
            proof,
            amount
          );

      }


      /* -----------------------------------------------------
         STRIPE
      ----------------------------------------------------- */

      else if (
        proof.provider === "stripe"
      ) {

        settlement =
          await verifyStripePayment(
            proof,
            amount
          );

      }


      /* -----------------------------------------------------
         PAYPAL
      ----------------------------------------------------- */

      else {

        settlement =
          await verifyPayPalPayment(
            proof,
            amount
          );

      }

    }


    /* =======================================================
       CREATE CARD
    ======================================================= */

    const createdAt =
      new Date();


    const expiresAt =
      new Date(
        createdAt.getTime() +
        GREETING_LIFESPAN_MS
      );


    const cardId =
      newCardId();


    const managementToken =
      crypto.randomUUID();


    /*
     * Admin gets:
     *
     * ADMIN-xxxxxxxx
     *
     * Normal user gets:
     *
     * Razorpay/Stripe/PayPal payment ID
     */

    const paymentId =
      settlement.provider === "admin"
        ? `ADMIN-${cardId}`
        : settlement.paymentId;


    /* =======================================================
       INSERT GREETING CARD
    ======================================================= */

    const {
      data: card,
      error: cardError,
    } =
      await supabase
        .from("greeting_cards")
        .insert([
          {

            id: cardId,

            sender_name:
              senderName,

            receiver_name:
              receiverName,

            message,

            theme,

            font,


            ...(textColor
              ? {
                  text_color:
                    textColor,
                }
              : {}),


            ...(titleColor
              ? {
                  title_color:
                    titleColor,
                }
              : {}),


            ...(messageColor
              ? {
                  message_color:
                    messageColor,
                }
              : {}),


            ...(signatureColor
              ? {
                  signature_color:
                    signatureColor,
                }
              : {}),


            ...(backgroundColor
              ? {
                  background_color:
                    backgroundColor,
                }
              : {}),


            ...(backgroundGradientStart
              ? {
                  background_color_start:
                    backgroundGradientStart,
                }
              : {}),


            ...(backgroundGradientEnd
              ? {
                  background_color_end:
                    backgroundGradientEnd,
                }
              : {}),


            ...(backgroundGradientAngle !== null
              ? {
                  background_gradient_angle:
                    backgroundGradientAngle,
                }
              : {}),


            ...(title
              ? {
                  title,
                }
              : {}),


            ...(eyebrow
              ? {
                  eyebrow,
                }
              : {}),


            ...(signoff
              ? {
                  signoff,
                }
              : {}),


            ...(audioTrack
              ? {
                  audio_track:
                    audioTrack,
                }
              : {}),


            external_image_url:
              imageUrl,


            created_at:
              createdAt.toISOString(),


            expires_at:
              expiresAt.toISOString(),


            management_token:
              managementToken,


            /*
             * ADMIN = 0
             * NORMAL USER = PAID AMOUNT
             */
            amount:
              settlement.amount,


            paid: true,


            payment_id:
              paymentId,

          },
        ])
        .select("*")
        .single();


    if (
      cardError ||
      !card
    ) {

      console.error(
        "Card insert failed:",
        cardError?.message
      );


      return errorResponse(
        "Could not create the greeting card",
        500
      );

    }


    /* =======================================================
       TRANSACTION LEDGER
    ======================================================= */

    const {
      data: transaction,
      error: ledgerError,
    } =
      await supabase
        .from("transactions")
        .insert([
          {

            client_name:
              senderName,


            client_email:
              clientEmail ||
              user?.email ||
              null,


            payment_id:
              paymentId,


            provider:
              settlement.provider,


            product_name:
              `${theme} — Digital Greeting Card`,


            amount:
              settlement.amount,


            currency:
              settlement.currency,


            status:
              "paid",

          },
        ])
        .select("*")
        .single();


    /* -------------------------------------------------------
       LEDGER FAILURE
    ------------------------------------------------------- */

    if (ledgerError) {

      console.error(
        "Ledger insert failed:",
        ledgerError.message
      );


      /*
       * Roll back card.
       */
      await supabase
        .from("greeting_cards")
        .delete()
        .eq(
          "id",
          cardId
        );


      if (
        ledgerError.code ===
        "23505"
      ) {

        /*
         * A concurrent callback (not a replay of a finished order) won the
         * ledger insert. Return the card it created instead of telling the
         * buyer their successful purchase failed.
         */
        const {
          data: winnerCard,
        } = await supabase
          .from("greeting_cards")
          .select("*")
          .eq(
            "payment_id",
            paymentId
          )
          .maybeSingle();

        if (winnerCard) {

          const {
            data: winnerTx,
          } = await supabase
            .from("transactions")
            .select("*")
            .eq(
              "payment_id",
              paymentId
            )
            .maybeSingle();

          return jsonResponse({

            success: true,

            duplicate: true,

            card: winnerCard,

            transaction: winnerTx,

          });

        }

        return errorResponse(
          "This payment has already been used",
          409
        );

      }


      return errorResponse(
        "Could not record the transaction",
        500
      );

    }


    /* =======================================================
       RECEIPT (server-side, after a verified payment)

       This is the ONLY place a purchase receipt is minted. It runs after the
       gateway verification and the ledger write, is idempotent on the payment
       id, retries transient email failures, and logs every attempt. A failure
       here is reported in `receipt`, never as a failed purchase.
    ======================================================= */

    const receiptInfo = await safeIssueReceipt(
      supabase,
      transaction as unknown as ReceiptLedgerRow,
      req,
    );


    /* =======================================================
       SUCCESS
    ======================================================= */

    console.log(
      "Greeting card created:",
      {
        cardId,
        admin,
        amount:
          settlement.amount,
        provider:
          settlement.provider,
        receiptIssued: Boolean(receiptInfo?.receipt),
        receiptEmailed: receiptInfo?.emailed ?? false,
      }
    );


    return jsonResponse({

      success: true,

      card,

      transaction,

      ...(receiptInfo ? { receipt: receiptInfo } : {}),

    });


  } catch (error) {

    const message =
      error instanceof Error
        ? error.message
        : "Unknown error";


    console.error(
      "create-greeting failed:",
      message
    );


    /*
     * Only payment-verification wording is safe to echo back. A database,
     * storage or provider error can carry internal detail, so the buyer gets a
     * generic sentence that still tells them nothing was necessarily lost.
     */
    const safeToEcho =
      /^(Incomplete (Razorpay|PayPal|Stripe) payment proof|Razorpay signature verification failed|Could not verify (Razorpay|Stripe) payment|Payment does not match order|Payment is not settled|Paid amount does not match|Captured amount does not match|PayPal order is not completed|Demo payments are disabled|This card is free|Payment is required|This payment has already been used)/.test(
        message
      );


    return errorResponse(
      safeToEcho
        ? message
        : "We could not complete this purchase. If money was deducted, nothing else was charged — contact support with your payment reference.",
      500
    );

  }

});