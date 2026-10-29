/**
 * Admin WhatsApp support — the one handoff both Joy agents share.
 *
 * Public Joy and Admin Joy are different assistants with different permissions,
 * but when a human is needed they both point at the same authorised admin
 * number. This module owns the number, the link format, the language-aware copy
 * and the detection of "I need a person" requests, so the two agents cannot drift
 * apart or invent a second number.
 *
 * What is deliberately NOT here:
 *   • no user data is collected — the prefill is the visitor's own message, which
 *     they review and can edit inside WhatsApp before sending;
 *   • nothing admin-only (logs, keys, database details) is ever put in the copy,
 *     because Public Joy shows the same module to anonymous visitors;
 *   • the link is a plain https link, so no privileged action happens just by
 *     tapping it.
 */

import type { JoyLang, JoyText } from './joyAssistant';

/** The authorised admin support number, in wa.me format (country code, digits). */
export const ADMIN_WHATSAPP_NUMBER = '918295075752';

/** The same number as humans read it. */
export const ADMIN_WHATSAPP_DISPLAY = '+91 82950 75752';

/**
 * Builds the WhatsApp handoff link.
 *
 * `https://wa.me/<number>?text=<encoded>` is the documented click-to-chat format;
 * the number carries the country code and no `+`, spaces or dashes. The message
 * is URL-encoded once here, so callers must not encode it again.
 */
export const whatsappSupportUrl = (message?: string): string => {
  const base = `https://wa.me/${ADMIN_WHATSAPP_NUMBER}`;
  const text = (message ?? '').trim();
  return text ? `${base}?text=${encodeURIComponent(text)}` : base;
};

/**
 * Phrasing that means "connect me with a person", in English and Hinglish.
 *
 * Kept specific on purpose: a bare "help" belongs to the guide/FAQ flow, while a
 * failed payment, a refund, a complaint or an explicit request for the admin/team
 * is exactly what a human has to answer.
 */
const SUPPORT_CUES: readonly RegExp[] = [
  /\b(talk|speak|chat)\s+(to|with)\s+(the\s+)?(admin|owner|team|human|someone|support)\b/i,
  /\b(contact|reach)\s+(the\s+)?(admin|owner|team|support|you)\b/i,
  /\b(connect|put)\s+me\s+(to|through to|with)\s+(the\s+)?(admin|owner|team|human|someone|support)\b/i,
  /\badmin\s*(se|ko)\s*(baat|contact|message)\b/i,
  /\b(team|admin)\s*se\s*baat\b/i,
  /\b(customer\s*care|human\s*support|real\s*person|live\s*person|someone\s*real)\b/i,
  /\b(complaint|complain|shikayat|shikayat\s*karna)\b/i,
  /\b(refund|money\s*back|paise?\s*wapas|paisa\s*wapas)\b/i,
  /\b(double\s*charged|charged\s*twice|dobara\s*kat|do\s*baar\s*kat)\b/i,
  /\b(payment|order)\s*(failed|fail|fails|stuck)\b/i,
  /\b(payment|paisa|paise)\s*(kat\s*gaya|cut\s*gaya|nahi\s*mila)\b/i,
  /\bwhats\s*app\b|\bwhatsapp\b/i,
  /\b(call|phone|dial)\s*(karo|kar|karna|me)\b/i,
];

/** True when the message should be handed to the admin on WhatsApp. */
export const isHumanSupportRequest = (raw: string): boolean => {
  const text = (raw ?? '').trim();
  if (!text) return false;
  return SUPPORT_CUES.some((cue) => cue.test(text));
};

/** What a payment/support problem needs to be looked up quickly. */
const wantsPaymentId = /\b(payment|order|refund|charged|kat|bill|receipt|invoice)\b/i;
/** What a pricing question needs so admin can find the row. */
const wantsPriceContext = /\b(price|pricing|rate|plan|tier|usd|inr|dollar|rupee|₹|\$)\b/i;

/**
 * A short, editable summary for the WhatsApp message.
 *
 * It stays under ~240 characters: long enough to carry the actual problem, short
 * enough that the visitor can review it on a phone before sending.
 */
export const supportPrefill = (
  raw: string,
  lang: JoyLang,
  context: { section?: string; staff?: boolean } = {},
): string => {
  const issue = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const who = context.staff ? 'Admin' : 'isZma user';
  const lines =
    lang === 'hi'
      ? [`${who} — mujhe help chahiye.`, issue ? `Sawaal: ${issue}` : '']
      : [`${who} — I need help.`, issue ? `Problem: ${issue}` : ''];
  if (context.section) {
    lines.push(lang === 'hi' ? `Section: ${context.section}` : `Section: ${context.section}`);
  }
  if (wantsPaymentId.test(issue)) {
    lines.push(lang === 'hi' ? 'Payment/order id: (yahan likhiye)' : 'Payment/order id: (write it here)');
  }
  return lines.filter(Boolean).join('\n');
};

/** Copy for the handoff itself. Public wording — safe for anonymous visitors. */
export const supportReply = (
  lang: JoyLang,
  context: { staff?: boolean; raw?: string } = {},
): string => {
  const raw = context.raw ?? '';
  const tips: string[] = [];

  if (wantsPaymentId.test(raw)) {
    tips.push(
      lang === 'hi'
        ? 'Payment ki baat hai to payment id (pay_… ya FREE-…) saath rakhiye — lookup turant hota hai.'
        : 'For anything payment-related keep the payment id (pay_… or FREE-…) handy — it makes the lookup instant.',
    );
  }
  if (wantsPriceContext.test(raw)) {
    tips.push(
      lang === 'hi'
        ? 'Pricing ki baat hai to tier ya plan ka naam likhiye (Basic/Plus/Premium/Elite, ya ReportCard Studio plan).'
        : 'For a pricing question name the tier or plan (Basic/Plus/Premium/Elite, or the ReportCard Studio plan).',
    );
  }

  if (context.staff) {
    const head =
      lang === 'hi'
        ? `Manual help chahiye? WhatsApp par admin team ko message kijiye — ${ADMIN_WHATSAPP_DISPLAY}. Neeche link par aapka message pehle se likha hoga; bhejne se pehle edit kar sakte hain.`
        : `Need a human? Message the admin team on WhatsApp — ${ADMIN_WHATSAPP_DISPLAY}. The link below has your note pre-filled; edit it before sending if you like.`;
    return [head, ...tips].join('\n');
  }

  const head =
    lang === 'hi'
      ? `Ye baat main admin team ko hi dena chahungi. Neeche WhatsApp kholiye — ${ADMIN_WHATSAPP_DISPLAY}. Aapka message pehle se likha hoga, bhejne se pehle dekh/edit kar sakte hain.`
      : `This one needs a human. Tap below to open WhatsApp with the admin team — ${ADMIN_WHATSAPP_DISPLAY}. Your message is pre-filled, so you can review or edit it before sending.`;
  return [head, ...tips].join('\n');
};

/** Button label for the handoff. */
export const supportLabel = (lang: JoyLang): string =>
  lang === 'hi' ? 'WhatsApp par baat karein' : 'Chat on WhatsApp';

/** Always-visible shortcut label (used in the public Joy footer). */
export const SUPPORT_SHORTCUT: JoyText = {
  en: 'WhatsApp support',
  hi: 'WhatsApp support',
};
