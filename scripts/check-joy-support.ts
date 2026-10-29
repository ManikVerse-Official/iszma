/*
 * Admin WhatsApp support — one channel, two Joy agents.
 *
 * Pins the parts that must never drift:
 *
 *   1. the link is the documented `https://wa.me/<number>?text=…` format, with
 *      the authorised number and the message encoded exactly once;
 *   2. the prefill is short, reviewable and language-matched, and it carries the
 *      look-up details when the problem is about a payment or a price;
 *   3. detection catches real "I need a human" requests in English and Hinglish
 *      without hijacking ordinary product/guide questions;
 *   4. the public copy never contains admin-only material, while the staff copy
 *      is addressed to the admin;
 *   5. both Joy surfaces really use the module, and an external handoff opens in
 *      a new tab instead of navigating the admin dashboard away.
 *
 * Usage:  npx jiti ../scripts/check-joy-support.ts      (from ReportCard Studio)
 *         npm run check:joy-support                     (from the repo root)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ADMIN_WHATSAPP_DISPLAY,
  ADMIN_WHATSAPP_NUMBER,
  SUPPORT_SHORTCUT,
  isHumanSupportRequest,
  supportLabel,
  supportPrefill,
  supportReply,
  whatsappSupportUrl,
} from '../src/services/supportContact.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

/* ── 1. link format ───────────────────────────────────────────────────────── */

const bare = whatsappSupportUrl();
check('bare link uses the authorised number', bare === `https://wa.me/${ADMIN_WHATSAPP_NUMBER}`, bare);
check('number carries the country code, no +', ADMIN_WHATSAPP_NUMBER === '918295075752');
check('display number is the same line', ADMIN_WHATSAPP_DISPLAY.replace(/\D/g, '') === ADMIN_WHATSAPP_NUMBER);

const message = 'Hi — order pay_12345 charged twice. Need help.';
const withText = whatsappSupportUrl(message);
check('message link starts with wa.me + number', withText.startsWith(`https://wa.me/${ADMIN_WHATSAPP_NUMBER}?text=`), withText);
check(
  'message is encoded exactly once',
  decodeURIComponent(withText.split('?text=')[1]) === message,
  withText.split('?text=')[1],
);
check('no raw spaces in the URL', !/\s/.test(withText));
check('whitespace-only message falls back to the bare link', whatsappSupportUrl('   ') === bare);

/* ── 2. prefill ───────────────────────────────────────────────────────────── */

const englishPrefill = supportPrefill('Payment failed for my greeting card order', 'en');
check('english prefill is english', englishPrefill.includes('I need help'), englishPrefill);
check('english prefill carries the problem', englishPrefill.includes('Payment failed for my greeting card order'));

const hinglishPrefill = supportPrefill('Mera payment kat gaya par card nahi mila', 'hi');
check('hinglish prefill is hinglish', hinglishPrefill.includes('mujhe help chahiye'), hinglishPrefill);
check('hinglish prefill carries the problem', hinglishPrefill.includes('Mera payment kat gaya'));

check(
  'payment problems ask for the payment id',
  /payment\/order id/i.test(supportPrefill('payment failed, money deducted', 'en')),
  supportPrefill('payment failed, money deducted', 'en'),
);
check(
  'non-payment problems do not',
  !/payment\/order id/i.test(supportPrefill('theme kaise unlock karu', 'en')),
  supportPrefill('theme kaise unlock karu', 'en'),
);

const longIssue = 'x'.repeat(600);
check(
  'a huge message is capped for the prefill',
  supportPrefill(longIssue, 'en').length < 400,
  String(supportPrefill(longIssue, 'en').length),
);

const withSection = supportPrefill('need help', 'en', { section: 'Digital Greetings' });
check('the section is included when known', withSection.includes('Digital Greetings'), withSection);

check('staff prefill is addressed as admin', supportPrefill('pricing issue', 'en', { staff: true }).includes('Admin'));
check('public prefill is not', !supportPrefill('pricing issue', 'en').includes('Admin —'));

/* ── 3. detection ─────────────────────────────────────────────────────────── */

const positives = [
  'I want to talk to the admin',
  'connect me to the admin please',
  'contact support please',
  'team se baat karni hai',
  'admin se baat karo',
  'admin se contact karna hai',
  /* Payment failures — English and Hinglish. */
  'payment failed but money deducted',
  'my payment failed and the card was not created',
  'mera payment fail ho gaya',
  'paisa kat gaya par card nahi mila',
  'I was charged twice for one order',
  'dobara kat gaya',
  /* Refunds — English and Hinglish. */
  'I need a refund',
  'please refund my money',
  'refund chahiye',
  'paise wapas chahiye',
  /* Complaints — English and Hinglish. */
  'I want to file a complaint',
  'mujhe shikayat karni hai',
  /* Other explicit handoff phrasings. */
  'whatsapp number do',
  'customer care se baat karni hai',
];
for (const phrase of positives) {
  check(`detects support request: ${phrase}`, isHumanSupportRequest(phrase));
}

const negatives = [
  'Rose Note ka price kya hai',
  'Basic theme ki price batao',
  'how do I use this section',
  'report card kaise banau',
  'who is the founder',
  'greeting card kaha hai',
  'how does refundable credit work in accounting',
];
for (const phrase of negatives) {
  check(`does not hijack: ${phrase}`, !isHumanSupportRequest(phrase));
}
check('empty message is not a support request', !isHumanSupportRequest('   '));

/* ── 4. copy ──────────────────────────────────────────────────────────────── */

const publicEn = supportReply('en', { raw: 'refund chahiye' });
const publicHi = supportReply('hi', { raw: 'refund chahiye' });
const staffEn = supportReply('en', { staff: true, raw: 'refund chahiye' });

check('public copy names the WhatsApp number', publicEn.includes(ADMIN_WHATSAPP_DISPLAY), publicEn);
check('public copy is language matched', publicHi.includes('WhatsApp') && publicHi !== publicEn);
check('staff copy is addressed to the admin', staffEn.includes('admin team') && staffEn !== publicEn);
check(
  'copy promises review before sending',
  /review|edit/i.test(publicEn) && /edit|dekh/i.test(publicHi),
);

const forbidden = [
  'service_role',
  'service role',
  'admin_users',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RAZORPAY_KEY_SECRET',
  'database password',
  'edge function logs',
];
for (const secret of forbidden) {
  check(`public copy never mentions "${secret}"`, !publicEn.toLowerCase().includes(secret.toLowerCase()));
}

check('english label', supportLabel('en') === 'Chat on WhatsApp');
check('hinglish label', /WhatsApp/.test(supportLabel('hi')) && supportLabel('hi') !== supportLabel('en'));
check('shortcut label exists in both languages', SUPPORT_SHORTCUT.en.length > 0 && SUPPORT_SHORTCUT.hi.length > 0);

/* ── 5. wiring ────────────────────────────────────────────────────────────── */

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(resolve(here, '..', relative), 'utf8');

const chatbot = read('src/components/Chatbot.tsx');
check('public Joy imports the support module', /from '\.\.\/services\/supportContact'/.test(chatbot));
check('public Joy answers a human request', /isHumanSupportRequest\(userMessage\)/.test(chatbot));
check('public Joy opens the WhatsApp link', /whatsappSupportUrl\(/.test(chatbot));
check('public Joy keeps a constant support shortcut', /SUPPORT_SHORTCUT/.test(chatbot));
check('public Joy renders external actions in a new tab', /href=\{msg\.action\.href\}/.test(chatbot) && chatbot.includes('noopener noreferrer'));

const adminConsole = read('src/components/admin/useAdminJoyConsole.tsx');
check('Admin Joy imports the support module', /from '\.\.\/\.\.\/services\/supportContact'/.test(adminConsole));
check('Admin Joy answers a human request', /isHumanSupportRequest\(trimmed\)/.test(adminConsole));
check('Admin Joy attaches the WhatsApp link', /whatsappSupportUrl\(/.test(adminConsole));

const fullConsole = read('src/components/AdminJoy.tsx');
const dockConsole = read('src/components/admin/AdminJoyDockView.tsx');
for (const [name, source] of [
  ['Admin Joy page', fullConsole],
  ['Admin Joy dock', dockConsole],
] as const) {
  check(`${name} opens external links in a new tab`, /target: '_blank'/.test(source) && source.includes('noopener noreferrer'));
}

const supportSource = read('src/services/supportContact.ts');
check('support module hard-codes no secret', !/service_role|SERVICE_ROLE|RAZORPAY_KEY_SECRET/.test(supportSource));

/* ── report ───────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('Joy support checks failed.');
  process.exit(1);
}
console.log('Joy support checks passed.');
