/*
 * Mobile / tablet / desktop viewport sweep for ReportCard Studio.
 *
 * Imports a real workbook, then checks the report-card preview at each required
 * width:
 *
 *   320 · 375 · 390 · 430 (phones) · 768 (tablet) · 1280 (desktop)
 *
 * For every width it asserts:
 *   1. the page does not scroll sideways (no accidental horizontal overflow);
 *   2. the A4 card is scaled to the viewport instead of being clipped;
 *   3. the card stays on ONE A4 sheet (the PDF's proportions are preserved);
 *   4. the Expand-preview control is reachable and the full-screen overlay
 *      really shows the card, and closing it works;
 *   5. Generate Reports keeps its primary actions reachable.
 *
 * Usage:
 *   node scripts/browser-test.cjs   (full flow)
 *   node scripts/browser-viewports.cjs                (this sweep)
 *
 * BASE_URL defaults to http://localhost:5199. Chrome is taken from the system
 * install when Playwright's bundled browser is missing.
 */
const { chromium } = require('playwright');
const { existsSync, mkdirSync } = require('node:fs');
const path = require('node:path');

mkdirSync('.tmpbuild', { recursive: true });

const BASE = process.env.BASE_URL || 'http://localhost:5199';
const EXCEL = process.env.EXCEL_FILE || 'testdata_title_class_30.xlsx';

const VIEWPORTS = [
  { name: 'phone-320', width: 320, height: 720, mobile: true },
  { name: 'phone-375', width: 375, height: 812, mobile: true },
  { name: 'phone-390', width: 390, height: 844, mobile: true },
  { name: 'phone-430', width: 430, height: 932, mobile: true },
  { name: 'tablet-768', width: 768, height: 1024, mobile: false },
  { name: 'desktop-1280', width: 1280, height: 900, mobile: false },
];

const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
];

let passed = 0;
const failures = [];
function ok(msg) {
  passed += 1;
  console.log('  PASS ' + msg);
}
function fail(msg) {
  failures.push(msg);
  console.log('  FAIL ' + msg);
}

/**
 * Elements that stick out of the viewport, so an overflow is actionable.
 *
 * Anything inside a scroll/clip container (a horizontally scrolling strip, the
 * scaled preview sheet, …) is skipped — it is clipped on purpose and is not
 * what makes the whole page scroll sideways.
 */
const OVERFLOW_PROBE = () => {
  const width = window.innerWidth;
  const clipped = (el) => {
    let parent = el.parentElement;
    while (parent && parent !== document.body) {
      const overflowX = getComputedStyle(parent).overflowX;
      if (overflowX !== 'visible') return true;
      parent = parent.parentElement;
    }
    return false;
  };

  const offenders = [];
  document.querySelectorAll('body *').forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.width < 40) return;
    const overhang = Math.round(rect.right - width);
    if (overhang > 1 && !clipped(el)) {
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 70),
        text: String(el.textContent || '').trim().slice(0, 40),
        overhang,
      });
    }
  });
  return {
    clientWidth: document.documentElement.clientWidth,
    innerWidth: width,
    offenders: offenders.sort((a, b) => b.overhang - a.overhang).slice(0, 5),
  };
};

async function launch() {
  const attempts = [];
  for (const executablePath of [undefined, ...CHROME_PATHS]) {
    if (executablePath && !existsSync(executablePath)) continue;
    try {
      return await chromium.launch(executablePath ? { executablePath } : {});
    } catch (error) {
      attempts.push(`${executablePath ?? 'bundled'}: ${String(error.message).split('\n')[0]}`);
    }
  }
  console.log('SKIP — no usable Chrome/Chromium binary was found for Playwright.');
  for (const line of attempts) console.log('       ' + line);
  console.log('       Run "npx playwright install chromium" and re-run this script.');
  process.exit(0);
}

async function main() {
const browser = await launch();

try {
  /* ---- import a workbook once, then reuse the session ----------------- */
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  /* Every working screen needs an account, so sign in first. */
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill('viewport-sweep@example.com');
  await page.locator('form input:not([type="email"])').first().fill('Viewport Sweep');
  await page.getByRole('button', { name: /Continue/i }).click();
  await page.waitForSelector('#excel-input, a[href="/dashboard"]', { timeout: 30000 });

  await page.goto(BASE + '/import', { waitUntil: 'networkidle' });
  await page.locator('#excel-input').setInputFiles(path.join(process.cwd(), EXCEL));
  await page.waitForSelector('text=Column Mapping', { timeout: 60000 });
  await page.getByRole('button', { name: 'Continue to Subjects' }).click();
  await page.waitForSelector('text=Dynamic Subject Configuration', { timeout: 30000 });
  await page.getByRole('button', { name: 'Continue to Photos' }).click();
  await page.waitForSelector('text=Drop Student Photos ZIP', { timeout: 30000 });
  await page.getByRole('button', { name: 'Preview & Validate', exact: true }).click();
  await page.waitForSelector('text=Total Students', { timeout: 30000 });
  ok('import completed once for the whole sweep');

  await page.locator('a[href="/template"]:visible').first().click();
  await page.waitForSelector('.shadow-card', { timeout: 30000 });
  ok('report template opened with a rendered card');
  await page.waitForTimeout(800);

  for (const viewport of VIEWPORTS) {
    console.log(`\n--- ${viewport.name} (${viewport.width}x${viewport.height}) ---`);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(500);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow <= 1) {
      ok(`${viewport.name}: no sideways scroll (${overflow}px)`);
    } else {
      const probe = await page.evaluate(OVERFLOW_PROBE);
      fail(
        `${viewport.name}: page scrolls sideways by ${overflow}px (clientWidth ${probe.clientWidth}) — widest: ${probe.offenders
          .map((o) => `<${o.tag} class="${o.cls}"> +${o.overhang}px`)
          .join(' | ')}`,
      );
    }

    /* The card must be inside the viewport, not clipped, and scaled down. */
    const card = await page.evaluate(() => {
      const sheet = document.querySelector('.shadow-card');
      if (!sheet) return null;
      const rect = sheet.getBoundingClientRect();
      return {
        width: Math.round(rect.width),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        height: sheet.offsetHeight,
        viewport: window.innerWidth,
        a4: Math.round((297 / 25.4) * 96),
      };
    });

    if (!card) {
      fail(`${viewport.name}: no report card found in the preview`);
    } else {
      if (card.width <= card.viewport + 1 && card.left >= -1) {
        ok(`${viewport.name}: card fits the viewport (${card.width}px in ${card.viewport}px)`);
      } else {
        fail(
          `${viewport.name}: card is ${card.width}px wide starting at ${card.left}px in a ${card.viewport}px viewport`,
        );
      }
      if (card.height <= card.a4 + 2) {
        ok(`${viewport.name}: card stays on one A4 sheet (${card.height}px of ${card.a4}px)`);
      } else {
        fail(`${viewport.name}: card overflows A4 (${card.height}px of ${card.a4}px)`);
      }
    }

    /* Expand control: reachable, opens the overlay, shows the card, closes. */
    const expand = page.getByRole('button', { name: /Expand preview/i }).first();
    const expandVisible = await expand.isVisible().catch(() => false);
    if (!expandVisible) {
      fail(`${viewport.name}: Expand preview is not reachable`);
    } else {
      await expand.click();
      await page.waitForSelector('[role="dialog"][aria-label*="Report card preview"]', {
        timeout: 15000,
      });
      const overlayCard = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label*="Report card preview"]');
        const sheet = dialog?.querySelector('.shadow-card');
        if (!dialog || !sheet) return null;
        const rect = sheet.getBoundingClientRect();
        return { width: Math.round(rect.width), viewport: window.innerWidth };
      });
      if (overlayCard && overlayCard.width <= overlayCard.viewport + 1 && overlayCard.width > 0) {
        ok(`${viewport.name}: full-screen preview shows the card (${overlayCard.width}px)`);
      } else {
        fail(`${viewport.name}: full-screen preview did not show the card`);
      }

      const overlayOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      if (overlayOverflow <= 1) ok(`${viewport.name}: expanded view does not scroll sideways`);
      else fail(`${viewport.name}: expanded view scrolls sideways by ${overlayOverflow}px`);

      await page.getByRole('button', { name: /Close/i }).first().click();
      await page.waitForTimeout(250);
      const closed = await page.evaluate(
        () => document.querySelector('[role="dialog"][aria-label*="Report card preview"]') === null,
      );
      if (closed) ok(`${viewport.name}: expanded view closes`);
      else fail(`${viewport.name}: expanded view did not close`);
    }

    /*
     * Essential actions stay reachable on Generate Reports. Navigation is done
     * by clicking the app's own links on purpose: a full page load would reset
     * the in-memory student store and empty every screen.
     */
    await page.locator('a[href="/generate"]:visible').first().click();
    await page.waitForTimeout(600);
    const generateOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (generateOverflow <= 1) ok(`${viewport.name}: Generate Reports has no sideways scroll`);
    else fail(`${viewport.name}: Generate Reports scrolls sideways by ${generateOverflow}px`);

    const action = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const target = buttons.find((b) => /Generate \d+ Reports|Re-generate/.test(b.textContent || ''));
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      return { width: Math.round(rect.width), visible: rect.width > 0 && rect.height >= 24 };
    });
    if (action && action.visible) ok(`${viewport.name}: the Generate action is reachable`);
    else fail(`${viewport.name}: the Generate action is missing or too small`);

    await page.locator('a[href="/template"]:visible').first().click();
    await page.waitForTimeout(600);
  }

  if (pageErrors.length === 0) ok('no page errors during the sweep');
  else fail('page errors: ' + pageErrors.slice(0, 3).join(' | '));

  await context.close();
} finally {
  await browser.close();
}

console.log(`\n=== viewport sweep: ${passed} passed, ${failures.length} failed ===`);
for (const failure of failures) console.log('  - ' + failure);
process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error('VIEWPORT SWEEP ERROR:', error);
  process.exit(1);
});
