import { supabase, isSupabaseConfigured } from './supabase';

/**
 * Transactional email helper.
 *
 * Sends welcome / purchase (bill) / subscription emails through the
 * `send-email` Edge Function, which talks to Resend server-side. All calls are
 * best-effort: an email failure must never block the user's action.
 */

export type EmailTemplate =
  | 'welcome'
  | 'purchase'
  | 'subscription'
  | 'renewal_warning'
  | 'subscription_expired';

export interface EmailPayload {
  template: EmailTemplate;
  to: string;
  name?: string;
  // purchase — `amount` is the product's real COST (0 for a genuinely free
  // product). The bill never says "free".
  productName?: string;
  amount?: string;
  currency?: 'INR' | 'USD';
  paymentId?: string;
  orderDate?: string;
  receiptNumber?: string;
  receiptUrl?: string;
  cardUrl?: string;
  // subscription
  planName?: string;
  durationMonths?: number;
  expiresAt?: string;
  daysLeft?: number;
}

/**
 * Sends a transactional email. Returns true when Resend accepted it.
 *
 * `to` may be empty for a purchase bill: the `send-email` function then
 * addresses it to the store owner (ADMIN_NOTIFY_EMAIL, a server secret) so the
 * record of the sale is never lost. Every other template still needs a real
 * recipient.
 */
export const sendTransactionalEmail = async (payload: EmailPayload): Promise<boolean> => {
  if (!isSupabaseConfigured()) return false;
  try {
    const { data, error } = await supabase.functions.invoke('send-email', { body: payload });
    if (error) {
      console.warn('send-email failed:', error);
      return false;
    }
    return Boolean(data?.sent);
  } catch (error) {
    console.warn('send-email threw:', error);
    return false;
  }
};

/** Welcome email — call after a visitor signs in / creates an account. */
export const sendWelcomeEmail = (to: string, name?: string): Promise<boolean> =>
  sendTransactionalEmail({ template: 'welcome', to, name });

/**
 * Thank-you + professional bill — call after EVERY settled purchase (card or
 * product), including admin comps and free cards. The bill states the item's
 * real cost; the owner receives a copy automatically from the server.
 */
export const sendPurchaseEmail = (
  to: string,
  details: Omit<EmailPayload, 'template' | 'to'>,
): Promise<boolean> => sendTransactionalEmail({ template: 'purchase', to, ...details });

/** Subscription confirmation — sent by the entitlement function on activation. */
export const sendSubscriptionEmail = (
  to: string,
  details: Omit<EmailPayload, 'template' | 'to'>,
): Promise<boolean> => sendTransactionalEmail({ template: 'subscription', to, ...details });
