/*
 * Browser check for the Excel + Photo-ZIP workflow and the photo review table.
 *
 * The unit tests (scripts/regression-test.ts) cover the matching rules in
 * isolation; this one drives the REAL screens in Chrome: upload a workbook,
 * upload a photo archive, then read the review table on the preview step.
 *
 * It reports what it verified and, if no browser is available, SKIPS with a
 * clear message instead of pretending to pass. Run: npm run test:browser-photos
 */
const path = require('path');
const { existsSync, mkdirSync, writeFileSync } = require('fs');

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA || ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const PORT = Number(process.env.PHOTO_TEST_PORT || 5198);
const EXCEL = process.env.EXCEL_FILE || 'testdata_10_students.xlsx';

let chromium;
let JSZip;
let createServer;
try {
  ({ chromium } = require('playwright'));
  JSZip = require('jszip');
  ({ createServer } = require('vite'));
} catch (error) {
  console.log('SKIP — this check needs playwright, jszip and vite to be installed.');
  console.log(`       ${String(error.message).split('\n')[0]}`);
  process.exit(0);
}

const results = [];
const check = (label, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
};

/*
 * Two DIFFERENT 1x1 photographs. Identical bytes would (correctly) be treated
 * as one picture and claimed by a single student, which is not what this test
 * is about.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const PNG_ALT = Buffer.from(PNG);
PNG_ALT[PNG_ALT.length - 1] ^= 0xff;

(async () => {
  mkdirSync('.tmpbuild', { recursive: true });

  /* A deliberately messy archive: two good photos, a case-variant duplicate of
   * one of them, and a non-image file. */
  const zip = new JSZip();
  zip.file('1.jpg', PNG);
  zip.file('2.jpg', PNG_ALT);
  zip.file('2.JPG', PNG_ALT);
  zip.file('notes.txt', 'not a photo');
  const zipPath = path.join('.tmpbuild', 'browser-photos.zip');
  writeFileSync(zipPath, await zip.generateAsync({ type: 'nodebuffer' }));

  const server = await createServer({ server: { port: PORT, strictPort: true }, logLevel: 'error' });
  await server.listen();

  let browser = null;
  for (const executablePath of [undefined, ...CHROME_PATHS]) {
    if (executablePath && !existsSync(executablePath)) continue;
    try {
      browser = await chromium.launch(executablePath ? { executablePath } : {});
      break;
    } catch {
      /* try the next candidate */
    }
  }

  if (!browser) {
    console.log('SKIP — no Chrome/Chromium binary was available for Playwright.');
    console.log('       Run "npx playwright install chromium" and re-run this check.');
    await server.close();
    process.exit(0);
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  /* The working screens require a signed-in account (free tries are per account). */
  await context.addInitScript(() => {
    localStorage.setItem(
      'rcs:entitlement',
      JSON.stringify({
        account: { name: 'Browser Test', email: 'browser-test@example.com' },
        freeUsesRemaining: 7,
      }),
    );
  });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));

  try {
    await page.goto(`http://localhost:${PORT}/import`, { waitUntil: 'networkidle' });
    await page.locator('#excel-input').setInputFiles(path.join(process.cwd(), EXCEL));
    await page.waitForSelector('text=Column Mapping', { timeout: 60000 });

    await page.getByRole('button', { name: 'Continue to Subjects' }).click();
    await page.waitForSelector('text=Dynamic Subject Configuration', { timeout: 30000 });
    await page.getByRole('button', { name: 'Continue to Photos' }).click();
    await page.waitForSelector('text=Drop Student Photos ZIP', { timeout: 30000 });

    await page.locator('#photo-input').setInputFiles(path.join(process.cwd(), zipPath));
    await page.waitForTimeout(1500);

    const photosStep = await page.locator('body').innerText();
    check('a duplicate filename in the ZIP is reported', /duplicate filename/i.test(photosStep));
    check('a non-image file is reported as skipped', /skipped/i.test(photosStep));

    await page.getByRole('button', { name: 'Preview & Validate', exact: true }).click();
    await page.waitForSelector('text=Total Students', { timeout: 30000 });
    await page.waitForTimeout(800);

    const review = page.locator('div:has(> div:has-text("Student photo review"))');
    const preview = await page.locator('body').innerText();

    check('the photo review table is rendered', (await review.count()) > 0);
    /*
     * The review header counts in the vocabulary the screen actually uses
     * ("N matched", "N set manually", "N missing"). The counts are cross-checked
     * against the table itself, so a wrong or stale number cannot pass.
     */
    const matchedChip = preview.match(/(\d+) matched/);
    const missingChip = preview.match(/(\d+) missing/);
    const confirmedRows = await review.locator('td:has-text("Confirmed")').count();
    check(
      'the matched count is real and equals the confirmed rows',
      Boolean(matchedChip) && Number(matchedChip[1]) === confirmedRows && confirmedRows === 2,
      `${matchedChip ? matchedChip[1] : '?'} chip vs ${confirmedRows} rows`,
    );
    check('missing photos are counted', Boolean(missingChip) && Number(missingChip[1]) > 0,
      missingChip ? missingChip[1] : 'no chip');
    check('the table names the roll number, student and status', /Roll No/.test(preview) && /Status/.test(preview));
    check('statuses use the reviewed vocabulary', /Confirmed|Needs review|Missing/.test(preview));
    check(
      'every distinct photo that matches a student is shown',
      (await review.locator('table img').count()) === 2,
      `${await review.locator('table img').count()} thumbnails`,
    );
    check(
      'the students without a photo are marked missing',
      (await review.locator('td:has-text("Missing")').count()) > 0,
    );

    /*
     * Manual per-student correction (the control the review table offers for
     * every student): pick a real photo for a student who has none and the table
     * must move that student out of "Missing" and record it as a manual choice.
     * (scripts/regression-test.ts separately proves a manual override is what
     * the generated PDF embeds.)
     */
    const noPhotoRow = review.locator('tr:has(td:has-text("Missing"))').first();
    const noPhotoName = (await noPhotoRow.locator('td').nth(1).innerText()).trim();
    const picker = noPhotoRow.locator('select[aria-label^="Photo for"]');
    check(
      'every student row offers its own photo picker (Inspect / Change photo)',
      (await review.locator('select[aria-label^="Photo for"]').count()) === 10 &&
        (await review.locator('button:has-text("Inspect")').count()) === 10,
      `${await review.locator('select[aria-label^="Photo for"]').count()} pickers`,
    );
    const optionLabels = await picker.locator('option').allTextContents();
    const realPhoto = optionLabels.find((label) => /\.(jpe?g|png)$/i.test(label.trim()));
    check(
      'the picker offers the real photos loaded from the ZIP',
      Boolean(realPhoto) && optionLabels.length >= 3,
      optionLabels.join(' | '),
    );
    await picker.selectOption({ label: realPhoto });
    await page.waitForTimeout(700);

    const afterManual = await page.locator('body').innerText();
    const rowAfter = await review.locator(`tr:has(td:has-text("${noPhotoName}"))`).first().innerText();
    check(
      'choosing a photo manually removes the student from "Missing"',
      !/\bMissing\b/.test(rowAfter),
      rowAfter.replace(/\n+/g, ' | ').slice(0, 120),
    );
    check(
      'the manual choice is recorded in the review summary',
      /1 set manually/.test(afterManual) && /(\d+) missing/.test(afterManual),
      afterManual.match(/\d+ set manually/)?.[0] ?? 'no manual chip',
    );
    check(
      'the missing count went down by exactly one',
      Number(afterManual.match(/(\d+) missing/)?.[1]) === Number(missingChip[1]) - 1,
      `${missingChip[1]} -> ${afterManual.match(/(\d+) missing/)?.[1]}`,
    );

    check('no page errors during the photo workflow', errors.length === 0, errors.slice(0, 2).join(' | '));
    await page.screenshot({ path: '.tmpbuild/shot-photo-review.png', fullPage: true });
  } catch (error) {
    check('the photo workflow completes', false, String(error.message).split('\n')[0]);
  } finally {
    await browser.close();
    await server.close();
  }

  const failed = results.filter((ok) => !ok).length;
  console.log(`\nphoto workflow browser checks: ${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
  console.log('✓ Photo workflow OK — the ZIP, the duplicates and the review table all behave.');
})();
