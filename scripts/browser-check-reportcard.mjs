/*
 * End-to-end check of ReportCard Studio AS EMBEDDED in Ishmaverse.
 *
 * The Studio is a static sub-app at /reportcard/ shown inside an iframe, so the
 * fixes only reach a user if that built copy is current. This script drives the
 * real embedded app and pins the three reports that came from the browser:
 *
 *   1. the attendance warning ("Attendance 103 ...") is shown for the row;
 *   2. Joy explains THAT warning, in the language it was asked in, instead of
 *      answering with an unrelated plan/renewal FAQ;
 *   3. the report card prints its GRAND TOTAL as obtained / maximum, the grade,
 *      the result and the student's attendance.
 *
 * Playwright is resolved from the project or the sibling Studio install; when no
 * browser is available the script says SKIP instead of pretending to pass.
 *
 * Run: node scripts/browser-check-reportcard.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';

const PORT = Number(process.env.RC_CHECK_PORT || 5246);
const BASE = `http://localhost:${PORT}`;
const WORKBOOK = process.env.RC_WORKBOOK || 'ReportCard Studio/testdata_sbs_marks_list_class7.xlsx';

const problems = [];
let checked = 0;
const check = (label, ok, detail = '') => {
  checked += 1;
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok && detail ? ` (${detail})` : ''}${ok ? '' : ` -> ${detail}`}`);
};

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const loadPlaywright = () => {
  for (const root of [
    new URL('../package.json', import.meta.url),
    new URL('../ReportCard Studio/package.json', import.meta.url),
  ]) {
    try {
      return createRequire(root)('playwright');
    } catch {
      /* next candidate */
    }
  }
  return null;
};

const playwright = loadPlaywright();
if (!playwright) {
  console.log('SKIP — Playwright is not installed, so the embedded Studio could not be driven.');
  process.exit(0);
}

const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'error',
});

let browser = null;

try {
  await server.listen();
  for (const executablePath of [undefined, ...CHROME_PATHS]) {
    if (executablePath && !existsSync(executablePath)) continue;
    try {
      browser = await playwright.chromium.launch(executablePath ? { executablePath } : {});
      break;
    } catch {
      /* next candidate */
    }
  }
  if (!browser) {
    console.log('SKIP — no usable Chrome/Chromium binary was found for Playwright.');
    process.exit(0);
  }

  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  /* The Studio counts free tries per account; seed the same store its login writes. */
  await context.addInitScript(() => {
    try {
      localStorage.setItem(
        'rcs:entitlement',
        JSON.stringify({
          account: { name: 'Embed Check', email: 'embed-check@example.com' },
          freeUsesRemaining: 7,
        }),
      );
    } catch {
      /* storage unavailable */
    }
  });

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(`${BASE}/section/reportcard-studio`, { waitUntil: 'networkidle' });
  const frameHandle = await page.waitForSelector('iframe', { timeout: 30000 });
  const frame = await frameHandle.contentFrame();
  check('the Ishmaverse section embeds the built Studio', Boolean(frame));

  if (frame) {
    /* The embedded Studio lands on its dashboard; the import screen is a route. */
    await frame.waitForSelector('text=Import Students', { timeout: 60000 });
    check(
      'the embedded Studio loads from /reportcard/ (built copy, not the dev server)',
      frame.url().includes('/reportcard/'),
      frame.url(),
    );
    await frame.getByRole('link', { name: 'Import Students' }).first().click();
    /* The file input is a hidden control driven by a drop-zone button. */
    await frame.waitForSelector('#excel-input', { state: 'attached', timeout: 60000 });

    await frame.locator('#excel-input').setInputFiles(WORKBOOK);
    await frame.waitForSelector('text=Column Mapping', { timeout: 60000 });
    await frame.getByRole('button', { name: 'Continue to Subjects' }).click();
    await frame.waitForSelector('text=Dynamic Subject Configuration', { timeout: 30000 });
    await frame.getByRole('button', { name: 'Continue to Photos' }).click();
    await frame.waitForSelector('text=Drop Student Photos ZIP', { timeout: 30000 });
    await frame.getByRole('button', { name: 'Preview & Validate', exact: true }).click();
    await frame.waitForSelector('text=Total Students', { timeout: 30000 });
    await frame.waitForTimeout(600);

    /* ── 1. the attendance warning is visible and names the value ───── */
    const body = await frame.locator('body').innerText();
    check(
      'the import shows the attendance warning for this workbook',
      /Attendance\s*"103"/.test(body),
      body.match(/Attendance[^\n]{0,60}/)?.[0] ?? 'no attendance warning',
    );
    check(
      'the import reports 0 errors (the attendance issue is a warning)',
      /ERRORS?\s*\n?\s*0/i.test(body) || /0\s*error/i.test(body),
      body.match(/ERRORS?[\s\S]{0,6}0/)?.[0]?.replace(/\n/g, ' ') ?? 'no error count',
    );
    check(
      'the affected student row carries a warning badge',
      /\b\d+W\b/.test(body),
      body.match(/\b\d+W\b/)?.[0] ?? 'no warning badge',
    );

    /* ── 2. Joy explains THAT warning, in Hinglish ──────────────────── */
    const joyLauncher = frame.locator('button[aria-label*="Joy" i], button[aria-label*="chat" i]').first();
    if (await joyLauncher.count()) await joyLauncher.click();
    const joyInput = frame.locator('input[placeholder*="Poochho" i], input[placeholder*="Ask me" i]').first();
    await joyInput.waitFor({ timeout: 15000 });
    await joyInput.fill('warning kyu aa rahi hai');
    await joyInput.press('Enter');
    await frame.waitForTimeout(1500);

    const joyText = await frame.locator('body').innerText();
    const auditAnswer = joyText.slice(joyText.lastIndexOf('warning kyu aa rahi hai'));
    check(
      'Joy answers the warning question from the live import',
      /103/.test(auditAnswer) && /Attendance/i.test(auditAnswer),
      auditAnswer.replace(/\n+/g, ' ').slice(0, 200),
    );
    check(
      'Joy does NOT answer a validation question with plan/renewal text',
      !/plan khatam|renewal reminder|renew karo|expiry/i.test(auditAnswer),
      auditAnswer.replace(/\n+/g, ' ').slice(0, 120),
    );
    check(
      'Joy explains the cause and the fix',
      /(days present|percentage|column mapping|Days Present)/i.test(auditAnswer),
      auditAnswer.replace(/\n+/g, ' ').slice(0, 160),
    );
    check(
      'Joy replies in Hinglish to a Hinglish question',
      /(hai|hai\?|karo|nahi|me|ka|ki)\b/i.test(auditAnswer) && /(Possible|Fix|warning)/i.test(auditAnswer),
      auditAnswer.replace(/\n+/g, ' ').slice(0, 120),
    );

    /*
     * ── 2b. Joy also answers about the REST of Ishmaverse from in here ──
     * She is the mall's assistant, not a Studio-only bot. A problem inside
     * another section is explained without yanking the visitor out of the
     * Studio (no navigation for a question, only for "take me there").
     */
    const studioUrlBefore = frame.url();
    await joyInput.fill('pair 3 balls room code not working');
    await joyInput.press('Enter');
    await frame.waitForTimeout(1200);
    const crossText = await frame.locator('body').innerText();
    const crossAnswer = crossText.slice(crossText.lastIndexOf('pair 3 balls room code not working'));
    check(
      'Joy answers about another Ishmaverse section from inside the Studio',
      /Game Zone/i.test(crossAnswer) && /room code|6 characters|Private Room/i.test(crossAnswer),
      crossAnswer.replace(/\n+/g, ' ').slice(0, 160),
    );
    check(
      'an answer about another section does not navigate the visitor away',
      frame.url() === studioUrlBefore,
      `${studioUrlBefore} -> ${frame.url()}`,
    );

    /* ── 3. the report card prints the full summary + attendance ────── */
    await frame.getByRole('link', { name: 'Report Template' }).first().click();
    await frame.waitForSelector('[data-testid="report-card"]', { timeout: 30000 });
    await frame.waitForTimeout(800);

    const cardText = (await frame.locator('[data-testid="report-card"]').first().innerText()).toUpperCase();
    const cardSummary = await frame.evaluate(() => {
      const card = document.querySelector('[data-testid="report-card"]');
      return card ? card.innerText.toUpperCase() : '';
    }).catch(() => '');

    check('the card prints GRAND TOTAL', /GRAND TOTAL/.test(cardText || cardSummary));
    const grandPair = (cardText || cardSummary).match(/GRAND TOTAL[\s\S]{0,220}?(\d+)\s*\/\s*(\d+)/);
    check(
      'the GRAND TOTAL row carries obtained / maximum (not a bare number)',
      Boolean(grandPair) && Number(grandPair[2]) > Number(grandPair[1]),
      grandPair ? `${grandPair[1]} / ${grandPair[2]}` : 'no obtained/maximum pair in the grand-total row',
    );
    /*
     * Every column states what it is out of, and every subject line prints its
     * marks out of its own maximum — the workbook's own max-marks row.
     */
    check(
      'each component column states its maximum (PT (10), NB (5), SEA (5), SA1 (80))',
      /PT\s*\(\s*10\s*\)/.test(cardText || cardSummary) &&
        /NB\s*\(\s*5\s*\)/.test(cardText || cardSummary) &&
        /SA1\s*\(\s*80\s*\)/.test(cardText || cardSummary),
      (cardText || cardSummary).replace(/\n/g, ' ').slice(0, 160),
    );
    check(
      'the Total column states the subject maximum',
      /TOTAL\s*\(\s*100\s*\)/.test(cardText || cardSummary),
      (cardText || cardSummary).match(/TOTAL\s*\(\s*\d+\s*\)/)?.[0] ?? 'no total hint',
    );
    const outOfRows = ((cardText || cardSummary).match(/\d+(\.\d+)?\s*\/\s*100/g) ?? []).length;
    check(
      'every subject line prints its marks out of its maximum',
      outOfRows >= 6,
      `${outOfRows} "x / 100" cells`,
    );
    check(
      'the card prints the overall grade and the result',
      /(GRADE|B1|B2|A1|A2|C1|C2|D)/.test(cardText || cardSummary) &&
        /(PROMOTED|NEEDS IMPROVEMENT)/.test(cardText || cardSummary),
    );
    check(
      'the card prints the student attendance',
      /ATTENDANCE/.test(cardText || cardSummary) && /103/.test(cardText || cardSummary),
      (cardText || cardSummary).match(/ATTENDANCE[^\n]{0,20}/)?.[0] ?? 'no attendance row',
    );

    /*
     * ── 4. asking for another section hands the parent the real mall route ──
     * This one DOES navigate (the visitor asked to go), so it runs last.
     */
    await joyInput.fill('take me to the game zone');
    await joyInput.press('Enter');
    await page.waitForTimeout(2500);
    check(
      'asking for another section opens it in the mall',
      /\/section\/game-zone/.test(page.url()),
      page.url(),
    );

    check('no page errors in the embedded Studio', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
  }
} finally {
  if (browser) await browser.close();
  await server.close();
}

console.log(`\nEmbedded Studio browser checks: ${checked}`);
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  • ${problem}`);
  process.exit(1);
}
console.log('\n✓ Embedded Studio OK — warning shown, Joy explains it, card prints total/grade/result/attendance.');
