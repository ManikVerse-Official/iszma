import { GreetingCard, PaymentProof, Receipt, Transaction } from '../types';
import { supabase, isSupabaseConfigured } from './supabase';
import {
  FunctionRequestError,
  classifyFunctionFailure,
  readFunctionFailure,
} from './functionErrors';

/** Every greeting card stays live for exactly 48 hours. */
export const GREETING_LIFESPAN_HOURS = 48;
const GREETING_LIFESPAN_MS = GREETING_LIFESPAN_HOURS * 60 * 60 * 1000;

const LOCAL_STORAGE_KEY = 'ishmaverse_greeting_cards';

/**
 * Columns safe to expose to clients. `management_token` is deliberately
 * excluded, and the matching column grant is revoked in the step8 migration,
 * so a client can never read another sender's delete token.
 */
export const CARD_PUBLIC_COLUMNS =
  'id, sender_name, receiver_name, message, theme, external_image_url, created_at, expires_at, amount, paid, font, text_color, title_color, message_color, signature_color, background_color, background_color_start, background_color_end, background_gradient_angle, title, eyebrow, signoff, audio_track';

/* ------------------------------------------------------------------ */
/* Local storage fallback (used when the Supabase table is unavailable) */
/* ------------------------------------------------------------------ */

const readLocalCards = (): GreetingCard[] => {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as GreetingCard[]) : [];
  } catch {
    return [];
  }
};

const writeLocalCard = (card: GreetingCard) => {
  try {
    const cards = readLocalCards().filter((item) => item.id !== card.id);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify([card, ...cards].slice(0, 200)));
  } catch {
    /* storage full or unavailable - the in-memory card still works */
  }
};

const removeLocalCard = (id: string) => {
  try {
    const cards = readLocalCards().filter((item) => item.id !== id);
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(cards));
  } catch {
    /* storage unavailable — nothing to clean up */
  }
};

/* ------------------------------------------------------------------ */
/* Expiry helpers                                                      */
/* ------------------------------------------------------------------ */

export const getCardExpiry = (card: GreetingCard): Date =>
  card.expires_at ? new Date(card.expires_at) : new Date(new Date(card.created_at).getTime() + GREETING_LIFESPAN_MS);

export const isCardExpired = (card: GreetingCard, now: Date = new Date()): boolean =>
  getCardExpiry(card).getTime() <= now.getTime();

export const getRemainingMs = (card: GreetingCard, now: Date = new Date()): number =>
  Math.max(0, getCardExpiry(card).getTime() - now.getTime());

export const formatCountdown = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

/* ------------------------------------------------------------------ */
/* Public URL (subdomain ready)                                        */
/* ------------------------------------------------------------------ */

const newCardId = (): string => {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 8; i += 1) {
    id += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return id;
};

/**
 * Builds the shareable link for a card.
 * - When VITE_GREETING_DOMAIN is set (e.g. ishmaverse.com) every card gets its own
 *   subdomain: https://<cardId>.ishmaverse.com
 * - Otherwise it falls back to a path on the current origin: /greet/<cardId>
 */
export const buildGreetingUrl = (cardId: string): string => {
  const domain = (import.meta.env.VITE_GREETING_DOMAIN as string | undefined)?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (domain) return `https://${cardId}.${domain}`;
  return `${window.location.origin}/greet/${cardId}`;
};

/** Builds the sender's private management/delete URL for a card. */
export const buildManageUrl = (token: string): string =>
  `${window.location.origin}/manage/${token}`;

/** Reads the card id out of the current hostname when the app runs on a card subdomain. */
export const getSubdomainCardId = (): string | null => {
  const domain = (import.meta.env.VITE_GREETING_DOMAIN as string | undefined)?.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain) return null;
  const host = window.location.hostname;
  if (!host.endsWith(`.${domain}`)) return null;
  const sub = host.slice(0, host.length - domain.length - 1);
  return sub && !sub.includes('.') ? sub : null;
};

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

export interface CreateGreetingInput {
  sender_name: string;
  receiver_name: string;
  message: string;
  theme: string;
  /** Typography id chosen by the sender (see data/fonts.ts). */
  font?: string;
  /** Optional custom title/heading colour (hex) that overrides the theme accent. */
  title_color?: string;
  /** Optional custom message/body colour (hex) that overrides the theme ink. */
  message_color?: string;
  /** Optional custom signature/sign-off colour (hex) that overrides the theme accent. */
  signature_color?: string;
  /** Optional custom text colour (hex) that overrides the theme ink. */
  text_color?: string;
  /** Optional custom card background colour (hex) that overrides the theme surface. */
  background_color?: string;
  /** Optional custom background gradient start (hex). */
  background_color_start?: string;
  /** Optional custom background gradient end (hex). */
  background_color_end?: string;
  /** Optional background gradient angle in degrees (0-359). */
  background_gradient_angle?: number;
  /** Optional sender-authored heading that replaces the theme headline. */
  title?: string;
  /** Optional sender-authored eyebrow label shown above the heading. */
  eyebrow?: string;
  /** Optional sender-authored sign-off that replaces "With love,". */
  signoff?: string;
  /** Audio track asset path (e.g. /audio/romantic.mp3). */
  audio_track?: string;
  external_image_url: string;
  /** Buyer email, recorded on the sales ledger (guests don't have a session). */
  client_email?: string;
  currency?: 'INR' | 'USD';
  /**
   * Gateway proof for paid cards. Omit it only for signed-in admins — the
   * server inspects the Supabase session JWT and rejects everyone else.
   */
  payment?: PaymentProof;
}

export interface CreateGreetingResult {
  card: GreetingCard;
  transaction?: Transaction;
  receipt?: Receipt;
}

/**
 * Creates a card through the secure `create-greeting` Edge Function.
 *
 * The browser never writes to `greeting_cards` or `transactions` directly —
 * RLS denies it. The function verifies admin status from the session JWT, or a
 * gateway-verified payment, then writes the card and its ledger row together.
 *
 * A failure is thrown as a `FunctionRequestError` so the UI can tell a reached
 * limit apart from a retryable server/connectivity problem.
 */
export const createGreetingCard = async (
  input: CreateGreetingInput,
): Promise<CreateGreetingResult> => {
  if (isSupabaseConfigured()) {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const { data, error } = await supabase.functions.invoke('create-greeting', {
      body: {
        ...input,
        currency: input.currency ?? 'INR',
      },
      headers: session?.access_token
        ? {
            Authorization: `Bearer ${session.access_token}`,
          }
        : undefined,
    });

    if (error) throw new FunctionRequestError(await readFunctionFailure(error, data));
    if (!data?.success || !data.card) {
      throw new FunctionRequestError(
        classifyFunctionFailure({
          status: 200,
          body: data,
          fallbackMessage: 'Could not create the greeting card',
        }),
      );
    }

    return {
      card: data.card as GreetingCard,
      transaction: data.transaction as Transaction | undefined,
    };
  }

  // Dev-only fallback when Supabase is not configured: nothing is stored on a
  // server, so no real card can be shared and no payment is bypassed.
  const createdAt = new Date();
  const payload: GreetingCard = {
    id: newCardId(),
    sender_name: input.sender_name,
    receiver_name: input.receiver_name,
    message: input.message,
    theme: input.theme,
    font: input.font,
    // Dev fallback only: give the card a token so /manage/<token> works locally.
    management_token: crypto.randomUUID(),
    title_color: input.title_color,
    message_color: input.message_color,
    signature_color: input.signature_color,
    text_color: input.text_color,
    background_color: input.background_color,
    background_color_start: input.background_color_start,
    background_color_end: input.background_color_end,
    background_gradient_angle: input.background_gradient_angle,
    title: input.title,
    eyebrow: input.eyebrow,
    signoff: input.signoff,
    audio_track: input.audio_track,
    external_image_url: input.external_image_url,
    amount: 0,
    paid: true,
    created_at: createdAt.toISOString(),
    expires_at: new Date(createdAt.getTime() + GREETING_LIFESPAN_MS).toISOString(),
  };

  writeLocalCard(payload);
  return { card: payload };
};

/**
 * Creates the single FREE basic card through `create-free-greeting`.
 *
 * No payment is involved. The server enforces the free-use limits (one free
 * card per email, at most two per IP) before minting the card, so a user cannot
 * reset the limit by clearing their browser.
 */
export const createFreeGreetingCard = async (
  input: Omit<CreateGreetingInput, 'payment' | 'currency'>,
): Promise<CreateGreetingResult> => {
  if (isSupabaseConfigured()) {
    const {
      data: { session },
    } = await supabase.auth.getSession();

    const { data, error } = await supabase.functions.invoke('create-free-greeting', {
      body: { ...input },
      headers: session?.access_token
        ? { Authorization: `Bearer ${session.access_token}` }
        : undefined,
    });

    if (error) throw new FunctionRequestError(await readFunctionFailure(error, data));
    if (!data?.success || !data.card) {
      throw new FunctionRequestError(
        classifyFunctionFailure({
          status: 200,
          body: data,
          fallbackMessage: 'Could not create your free card',
        }),
      );
    }

    return {
      card: data.card as GreetingCard,
      transaction: data.transaction as Transaction | undefined,
    };
  }

  // Without a backend the free path uses the same local, dev-only fallback.
  return createGreetingCard(input);
};

export interface ReceiptResult {
  receipt: Receipt;
  /** Self-contained printable HTML document. */
  html: string;
  /** True when the receipt was also emailed to the buyer. */
  emailed: boolean;
}

/** Fetches (or lazily issues) the receipt for a settled payment. */
export const fetchReceipt = async (paymentId: string): Promise<ReceiptResult | null> => {
  if (!isSupabaseConfigured() || !paymentId) return null;

  const { data, error } = await supabase.functions.invoke('accountant-bot', {
    body: { payment_id: paymentId },
  });

  if (error || !data?.success || !data.receipt) {
    console.warn('Receipt fetch failed:', error ?? data?.error);
    return null;
  }

  return {
    receipt: data.receipt as Receipt,
    html: String(data.html ?? ''),
    emailed: Boolean(data.emailed),
  };
};

export const getGreetingCard = async (id: string): Promise<GreetingCard | null> => {
  if (isSupabaseConfigured()) {
    const { data, error } = await supabase
      .from('greeting_cards')
      .select(CARD_PUBLIC_COLUMNS)
      .eq('id', id)
      .maybeSingle();
    if (!error && data) return data as GreetingCard;
  }

  return readLocalCards().find((card) => card.id === id) ?? null;
};

/**
 * Loads a card through its secret management token. Goes through the
 * `manage-greeting` Edge Function because the token is never client-readable.
 * Returns `card: null` when the token is invalid or the card is already gone.
 */
export const getManagedCard = async (
  token: string,
): Promise<{ card: GreetingCard | null; expired: boolean }> => {
  if (!token) return { card: null, expired: false };

  if (isSupabaseConfigured()) {
    const { data, error } = await supabase.functions.invoke('manage-greeting', {
      body: { token, action: 'get' },
    });

    if (error || !data?.success || !data.card) return { card: null, expired: false };
    return { card: data.card as GreetingCard, expired: Boolean(data.expired) };
  }

  // Local fallback (dev): cards created without Supabase keep their token here.
  const card = readLocalCards().find((item) => item.management_token === token) ?? null;
  return { card, expired: card ? isCardExpired(card) : false };
};

/** Permanently deletes a card (and its live link) using its management token. */
export const deleteManagedCard = async (token: string): Promise<boolean> => {
  if (!token) throw new Error('Invalid management link.');

  if (isSupabaseConfigured()) {
    const { data, error } = await supabase.functions.invoke('manage-greeting', {
      body: { token, action: 'delete' },
    });

    if (error) throw new FunctionRequestError(await readFunctionFailure(error, data));
    if (!data?.success || !data.deleted) {
      throw new FunctionRequestError(
        classifyFunctionFailure({
          status: 200,
          body: data,
          fallbackMessage: 'Could not delete the card.',
        }),
      );
    }
    return true;
  }

  // Local fallback (dev).
  const card = readLocalCards().find((item) => item.management_token === token);
  if (!card) throw new Error('This card no longer exists.');
  removeLocalCard(card.id);
  return true;
};

export const isPaymentDemoMode = (): boolean =>
  (import.meta.env.VITE_PAYMENT_MODE as string | undefined) === 'demo';

export { isSupabaseConfigured };
