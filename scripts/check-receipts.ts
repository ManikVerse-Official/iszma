/*
 * Receipt reliability — pure checks.
 *
 * These run under Node (jiti) and never touch a network, a database or Resend.
 * They pin the rules that make receipts safe:
 *
 *   1. formatting/escaping — a customer name or product cannot inject HTML;
 *   2. receipt numbers are deterministic per transaction (the UNIQUE receipt
 *      number is the database idempotency guard);
 *   3. only transient email failures are retried, and never more than the cap;
 *   4. the purchase path issues receipts on the SERVER after verification, and
 *      the browser no longer sends a second bill for the same order;
 *   5. send-email cannot be used without a settled payment reference.
 *
 * Usage:  npx jiti ../scripts/check-receipts.ts      (from ReportCard Studio)
 *         npm run check:receipts                     (from the repo root)
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECEIPT_EMAIL_MAX_ATTEMPTS,
  buildReceiptHtml,
  buildReceiptNumber,
  emailFailureSummary,
  emailLogStatus,
  escapeHtml,
  formatMoney,
  shouldRetryEmail,
  type EmailAttempt,
  type ReceiptLedgerRow,
} from '../supabase/functions/_shared/receiptsCore.ts';

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

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string => readFileSync(resolve(here, '..', relative), 'utf8');

/* ── 1. escaping + money ──────────────────────────────────────────────────── */

check('escapes angle brackets', escapeHtml('<script>alert(1)</script>') === '&lt;script&gt;alert(1)&lt;/script&gt;');
check('escapes quotes', escapeHtml(`"x" 'y'`) === '&quot;x&quot; &#39;y&#39;');
check('escapes ampersand first', escapeHtml('a & b') === 'a &amp; b');
check('formats INR', formatMoney(47, 'INR') === '₹47.00', formatMoney(47, 'INR'));
check('formats USD', formatMoney(4.99, 'USD') === '$4.99', formatMoney(4.99, 'USD'));
check('zero is a real price, not the word free', formatMoney(0, 'INR') === '₹0.00');
check('NaN cannot leak into a bill', formatMoney(Number.NaN, 'USD') === '$0.00');

/* ── 2. receipt identity ──────────────────────────────────────────────────── */

const row: ReceiptLedgerRow = {
  id: '3f9a1c2e-1111-4222-8333-444455556666',
  client_name: 'Asha <b>Rao</b>',
  client_email: 'asha@example.com',
  payment_id: 'pay_ABC123',
  provider: 'razorpay',
  product_name: 'Rose Note — Digital Greeting Card',
  amount: 47,
  currency: 'INR',
  status: 'paid',
  created_at: '2026-10-28T10:00:00.000Z',
};

const number = buildReceiptNumber(row);
check('receipt number is deterministic', number === buildReceiptNumber(row));
check('receipt number is year + transaction prefix', number === 'ISH-2026-3F9A1C', number);
check('a different transaction gets a different number', buildReceiptNumber({ ...row, id: 'aaaaaaaa-1111' }) !== number);

const html = buildReceiptHtml(row, number, '2026-10-28T10:00:00.000Z', {
  logoUrl: 'https://ishmaverse.com/logos/iszma-primary-logo.png',
  stampUrl: 'https://ishmaverse.com/logos/iszma-stamp-logo.png',
  supportEmail: 'support@ishmaverse.com',
});
check('receipt shows the number', html.includes(number));
check('receipt carries the isZma brand', html.includes('isZma') && html.includes('The Digital Mall'));
check('receipt prints the primary logo', html.includes('/logos/iszma-primary-logo.png'));
check('receipt prints the handwritten stamp', html.includes('/logos/iszma-stamp-logo.png'));
check('receipt stamp is the bottom-corner treatment', html.includes('rotate(-5deg)') && html.includes('opacity: 0.7'));
check('receipt shows the amount', html.includes('₹47.00'));
check('receipt escapes a malicious customer name', html.includes('Asha &lt;b&gt;Rao&lt;/b&gt;') && !html.includes('<b>Rao</b>'));
check('receipt contains no script tag for user data', !/<script>alert/i.test(html));
check('receipt prints the transaction id for support', html.includes(row.id));

const withManage = buildReceiptHtml(row, number, row.created_at, {
  logoUrl: 'https://ishmaverse.com/logos/iszma-primary-logo.png',
  stampUrl: 'https://ishmaverse.com/logos/iszma-stamp-logo.png',
  supportEmail: 'support@ishmaverse.com',
  manageUrl: 'https://ishmaverse.com/manage/token-1',
});
check('manage link is included when present', withManage.includes('https://ishmaverse.com/manage/token-1'));
check('no manage link when absent', !html.includes('/manage/'));

/* ── 3. retry policy ──────────────────────────────────────────────────────── */

const attempt = (overrides: Partial<EmailAttempt>): EmailAttempt => ({
  ok: false,
  status: 'transport',
  retryable: true,
  ...overrides,
});

check('success stops retrying', shouldRetryEmail(attempt({ ok: true, status: 'sent' }), 1) === false);
check('network failure is retried', shouldRetryEmail(attempt({}), 1) === true);
check('500 is retried', shouldRetryEmail(attempt({ status: 'rejected', httpStatus: 500 }), 1) === true);
check('429 is retried', shouldRetryEmail(attempt({ status: 'rejected', httpStatus: 429 }), 1) === true);
check('400 is terminal', shouldRetryEmail(attempt({ status: 'rejected', httpStatus: 400 }), 1) === false);
check('missing recipient is terminal', shouldRetryEmail(attempt({ status: 'no_recipient' }), 1) === false);
check('unconfigured is terminal', shouldRetryEmail(attempt({ status: 'unconfigured' }), 1) === false);
check(
  'retries stop at the cap',
  shouldRetryEmail(attempt({}), RECEIPT_EMAIL_MAX_ATTEMPTS) === false,
);
check('cap is small and bounded', RECEIPT_EMAIL_MAX_ATTEMPTS >= 2 && RECEIPT_EMAIL_MAX_ATTEMPTS <= 5);

check('sent status', emailLogStatus({ ok: true, status: 'sent', retryable: false }) === 'sent');
check(
  'unconfigured is logged as skipped, never sent',
  emailLogStatus({ ok: false, status: 'unconfigured', retryable: false }) === 'skipped',
);
check(
  'a rejection is logged as failed',
  emailLogStatus({ ok: false, status: 'rejected', retryable: false }) === 'failed',
);
check(
  'failure summary names the cause and attempts',
  /provider rejected/i.test(emailFailureSummary(attempt({ status: 'rejected', error: 'invalid address' }), 2) ?? '') &&
    /2 attempts/.test(emailFailureSummary(attempt({ status: 'rejected' }), 2) ?? ''),
);
check('a sent email has no failure summary', emailFailureSummary(attempt({ ok: true, status: 'sent' }), 1) === null);

/* ── 4. wiring: server issues it, browser does not duplicate it ───────────── */

const createGreeting = read('supabase/functions/create-greeting/index.ts');
check(
  'create-greeting issues a receipt after the ledger write',
  /issueReceiptForTransaction\(/.test(createGreeting) &&
    /Ledger insert failed[\s\S]*safeIssueReceipt\(/.test(createGreeting),
);
check(
  'a receipt failure cannot fail the purchase',
  /try \{[\s\S]*issueReceiptForTransaction[\s\S]*\} catch \(error\)/.test(createGreeting) &&
    /purchase kept/i.test(createGreeting),
);
check(
  'the duplicate callback also returns the receipt',
  /duplicateReceipt/.test(createGreeting),
);

const accountant = read('supabase/functions/accountant-bot/index.ts');
check('accountant-bot uses the shared issuer', /issueReceiptForTransaction/.test(accountant));
check(
  'accountant-bot no longer keeps a second HTML template',
  !/<style>[\s\S]*color-scheme/.test(accountant),
);

const orderModal = read('src/components/ThemeOrderModal.tsx');
check(
  'browser bill is skipped when the receipt was emailed',
  /if \(!receiptInfo\?\.emailed\)/.test(orderModal),
);
check(
  'browser only reads the server receipt HTML',
  orderModal.includes('only reads the printable HTML back') &&
    orderModal.includes('receiptInfo?.receipt.receipt_number'),
);

const sendEmail = read('supabase/functions/send-email/index.ts');
check('send-email verifies the ledger row', /\.from\("transactions"\)/.test(sendEmail));
check('send-email refuses an unknown payment reference', /No settled purchase matches that payment reference/.test(sendEmail));
check('send-email dedupes a repeated bill', /already sent for this order/.test(sendEmail));
check('send-email guards the recipient rate', /Too many emails to this address/.test(sendEmail));

const templates = read('supabase/functions/_shared/templates.ts');
check(
  'purchase subject carries the order reference (dedupe key)',
  /purchase — your \$\{BRAND\} bill\$\{reference/.test(templates),
);

/* ── report ───────────────────────────────────────────────────────────────── */

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.error('Receipt checks failed.');
  process.exit(1);
}
console.log('Receipt checks passed.');
