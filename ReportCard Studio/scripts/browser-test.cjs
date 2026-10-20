/* Full browser flow: school profile -> upload Excel -> mapping -> preview -> generate. */
const { chromium } = require('playwright');
const { mkdirSync, existsSync } = require('fs');
const path = require('path');

/* Screenshots are written here; the folder is scratch output, not committed. */
mkdirSync('.tmpbuild', { recursive: true });

const BASE = process.env.BASE_URL || 'http://localhost:5199';
const EXCEL = process.env.EXCEL_FILE || 'testdata_title_class_30.xlsx';
const EXPECT = Number(process.env.EXPECT_STUDENTS || 30);

const steps = [];
function ok(msg) {
  steps.push('PASS ' + msg);
  console.log('  PASS ' + msg);
}
function fail(msg) {
  steps.push('FAIL ' + msg);
  console.log('  FAIL ' + msg);
}

/* ── mobile pass: no sideways scrolling, tappable bottom navigation ────── */
async function runMobileChecks(browser, base) {
  console.log('\n=== mobile probe (Android Chrome sized viewport) ===');
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    acceptDownloads: true,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  for (const route of ['/dashboard', '/school-profile', '/import', '/template', '/generate']) {
    await page.goto(base + route, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow <= 1) ok(`no page horizontal scroll on ${route} (${overflow}px)`);
    else fail(`${route} scrolls sideways by ${overflow}px`);
  }

  /*
   * Every working screen needs an account, so the mobile pass has to identify
   * itself first — otherwise /import redirects to /login and the probe fails.
   */
  await page.goto(base + '/login', { waitUntil: 'networkidle' });
  await page.locator('input[type="email"]').fill('browser-mobile@example.com');
  await page.locator('form input:not([type="email"])').first().fill('Mobile Test');
  await page.getByRole('button', { name: /Continue/i }).click();
  /* The desktop sidebar link is hidden on a phone, so readiness is the route. */
  await page.waitForFunction(() => !location.pathname.startsWith('/login'), null, {
    timeout: 30000,
  });
  ok('mobile pass signed in');

  await page.goto(base + '/import', { waitUntil: 'networkidle' });
  await page.locator('#excel-input').setInputFiles(path.join(process.cwd(), EXCEL));
  await page.waitForSelector('text=Column Mapping', { timeout: 60000 });
  const importOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  if (importOverflow <= 1) ok('upload + mapping step does not overflow on mobile');
  else fail(`mapping step overflows by ${importOverflow}px`);

  /* Finish the import flow (students live in memory, not localStorage). */
  await page.getByRole('button', { name: 'Continue to Subjects' }).click();
  await page.waitForSelector('text=Dynamic Subject Configuration', { timeout: 30000 });
  await page.getByRole('button', { name: 'Continue to Photos' }).click();
  await page.waitForSelector('text=Drop Student Photos ZIP', { timeout: 30000 });
  await page.getByRole('button', { name: 'Preview & Validate', exact: true }).click();
  await page.waitForSelector('text=Total Students', { timeout: 30000 });
  ok('import flow completes on a phone viewport');

  /* Stay in the same session (client-side navigation) so the imported students
   * are still in the store, then check the A4 preview on a phone width. */
  await page.locator('nav[aria-label="Main"] a', { hasText: 'Report Template' }).first().click();
  await page.waitForSelector('[data-testid="report-card"]', { timeout: 30000 });
  await page.waitForTimeout(1200);
  const cardFit = await page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="report-card"]');
    if (!sheet) return null;
    const rect = sheet.getBoundingClientRect();
    return { width: Math.round(rect.width), viewport: window.innerWidth };
  });
  if (cardFit && cardFit.width <= cardFit.viewport + 1) {
    ok(`report card preview is scaled to the phone width (${cardFit.width}px)`);
  } else {
    fail(`preview is ${cardFit ? cardFit.width : 'missing'}px wide on a ${cardFit ? cardFit.viewport : '?'}px screen`);
  }

  /*
   * The card must stay ONE A4 sheet. The shared typography scale raised the body
   * text, so this guard fails if a size increase ever pushes the preview past
   * 297mm (the PDF would then paginate while the preview would not).
   */
  const sheetHeight = await page.evaluate(() => {
    const sheet = document.querySelector('[data-testid="report-card"]');
    if (!sheet) return null;
    return { height: sheet.offsetHeight, a4: (297 / 25.4) * 96 };
  });
  if (sheetHeight && sheetHeight.height <= sheetHeight.a4 + 2) {
    ok(`preview stays on one A4 sheet (${sheetHeight.height}px of ${Math.round(sheetHeight.a4)}px)`);
  } else {
    fail(
      `preview overflows A4: ${sheetHeight ? `${sheetHeight.height}px of ${Math.round(sheetHeight.a4)}px` : 'sheet missing'}`,
    );
  }

  /*
   * The preview frame must NOT reserve a large blank area under the card, and
   * the bottom of the card must be reachable by scrolling. `reserved` is the
   * scaler's layout height (what the page actually gives the preview) and
   * `visual` is what the reader sees, so a big gap between them is exactly the
   * "preview only fills the top of a large panel" bug.
   */
  const previewSpace = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="report-card"]');
    if (!card || !card.parentElement || !card.parentElement.parentElement) return null;
    const scaler = card.parentElement;
    const frame = card.parentElement.parentElement;
    return {
      reserved: scaler.offsetHeight,
      visual: Math.round(card.getBoundingClientRect().height),
      frame: Math.round(frame.getBoundingClientRect().height),
    };
  });
  if (
    previewSpace &&
    previewSpace.reserved >= previewSpace.visual - 4 &&
    previewSpace.reserved <= previewSpace.visual + 24
  ) {
    ok(`preview reserves exactly the card height (${previewSpace.reserved}px vs ${previewSpace.visual}px visual)`);
  } else {
    fail('preview reserves the wrong height: ' + JSON.stringify(previewSpace));
  }

  /*
   * The card must actually be PAINTED, not just present in the DOM. A collapsed
   * (clipped) preview passes every text-based check, so it is probed with
   * elementFromPoint — the bug this guards was a sub-pixel scaler height that
   * clipped the whole card away.
   */
  const painted = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="report-card"]');
    if (!card) return null;
    card.scrollIntoView({ block: 'center', behavior: 'instant' });
    const rect = card.getBoundingClientRect();
    const probe = (offsetY) => {
      const x = Math.min(window.innerWidth - 2, rect.left + rect.width / 2);
      const y = rect.top + offsetY;
      if (y < 0 || y > window.innerHeight) return false;
      const hit = document.elementFromPoint(x, y);
      return Boolean(hit && card.contains(hit));
    };
    return {
      rectH: Math.round(rect.height),
      top: probe(20),
      middle: probe(Math.round(rect.height / 2)),
      bottom: probe(Math.max(10, rect.height - 20)),
    };
  });
  if (painted && painted.top && painted.middle && painted.bottom && painted.rectH > 200) {
    ok(`report card is painted on screen (${painted.rectH}px tall, top/middle/bottom visible)`);
  } else {
    fail('report card is clipped / not painted: ' + JSON.stringify(painted));
  }

  /* The lower sections must be reachable, not clipped out of the page. */
  const reachable = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="report-card"]');
    if (!card) return null;
    card.scrollIntoView({ block: 'end' });
    const rect = card.getBoundingClientRect();
    return { bottom: Math.round(rect.bottom), top: Math.round(rect.top), viewport: window.innerHeight };
  });
  if (reachable && reachable.bottom <= reachable.viewport + 2) {
    ok(`the bottom of the report card is reachable on a phone (${reachable.bottom}px)`);
  } else {
    fail('the bottom of the preview cannot be reached: ' + JSON.stringify(reachable));
  }

  const navCheck = await page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Main"]');
    if (!nav) return { found: false };
    const links = Array.from(nav.querySelectorAll('a'));
    const heights = links.map((link) => Math.round(link.getBoundingClientRect().height));
    const visible = getComputedStyle(nav).display !== 'none';
    return { found: true, count: links.length, minHeight: Math.min(...heights), visible };
  });
  if (navCheck.found && navCheck.visible && navCheck.count >= 5 && navCheck.minHeight >= 44) {
    ok(`bottom navigation has ${navCheck.count} targets, min ${navCheck.minHeight}px tall`);
  } else {
    fail('bottom navigation missing or too small: ' + JSON.stringify(navCheck));
  }

  if (errors.length === 0) ok('no page errors during the mobile pass');
  else fail('mobile page errors: ' + errors.slice(0, 3).join(' | '));

  await page.screenshot({ path: '.tmpbuild/shot-mobile.png', fullPage: true });
  await context.close();
}

/* ── PWA pass: manifest, icons, service worker, install metadata ───────── */
async function runPwaChecks(browser, base) {
  console.log('\n=== PWA probe ===');
  const context = await browser.newContext({ viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  await page.goto(base + '/', { waitUntil: 'networkidle' });

  const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
  if (manifestHref) ok('manifest link present: ' + manifestHref);
  else fail('no manifest link');

  const manifest = await page.evaluate(async (href) => {
    const res = await fetch(href, { cache: 'no-store' });
    if (!res.ok) return { error: res.status };
    return res.json();
  }, manifestHref);

  if (manifest && !manifest.error) {
    if (manifest.name && manifest.start_url && manifest.display === 'standalone') {
      ok(`manifest installable (${manifest.name}, display=${manifest.display})`);
    } else {
      fail('manifest missing name/start_url/display: ' + JSON.stringify(manifest));
    }
    const sizes = (manifest.icons || []).map((icon) => icon.sizes);
    if (sizes.some((s) => String(s).includes('192')) && sizes.some((s) => String(s).includes('512'))) {
      ok('manifest declares 192px and 512px icons');
    } else {
      fail('manifest icons missing required sizes: ' + JSON.stringify(sizes));
    }
    const maskable = (manifest.icons || []).some((icon) =>
      String(icon.purpose || '').includes('maskable'),
    );
    if (maskable) ok('maskable icon provided for Android');
    else fail('no maskable icon');

    const iconSources = (manifest.icons || []).map((icon) => icon.src);
    const iconStatuses = await page.evaluate(
      async ({ href, sources }) => {
        const url = new URL(href, location.href);
        const base = new URL('.', url);
        const results = [];
        for (const source of sources) {
          const res = await fetch(new URL(source, base).href);
          results.push(source + ':' + res.status + ':' + res.headers.get('content-type'));
        }
        return results;
      },
      { href: manifestHref, sources: iconSources },
    );
    const broken = iconStatuses.filter((entry) => !entry.includes(':200:'));
    if (broken.length === 0) ok('all manifest icons resolve: ' + iconStatuses.join(', '));
    else fail('broken icons: ' + broken.join(', '));
  } else {
    fail('manifest could not be fetched: ' + JSON.stringify(manifest));
  }

  const swResponse = await page.evaluate(async () => {
    const res = await fetch('sw.js', { cache: 'no-store' });
    return { status: res.status, bytes: (await res.text()).length };
  });
  if (swResponse.status === 200 && swResponse.bytes > 100) {
    ok(`service worker served (${swResponse.bytes} bytes)`);
  } else {
    fail('service worker not served: ' + JSON.stringify(swResponse));
  }

  const registered = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (regs.length > 0) return 'registered';
      await new Promise((r) => setTimeout(r, 250));
    }
    return 'not-registered';
  });
  if (registered === 'registered') ok('service worker registered (PWA installable)');
  else fail('service worker registration: ' + registered);

  const viewport = await page.getAttribute('meta[name="viewport"]', 'content');
  if (viewport && /width=device-width/.test(viewport)) ok('responsive viewport meta present');
  else fail('viewport meta missing width=device-width');

  await context.close();
}

/*
 * The bundled Playwright browser may not be downloaded on this machine; set
 * PW_CHANNEL=chrome to drive the locally installed Google Chrome instead, or
 * let the launcher fall back to a system Chrome automatically.
 */
const CHROME_PATHS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  '/usr/bin/google-chrome',
];

async function launchBrowser() {
  const options = process.env.PW_CHANNEL ? [{ channel: process.env.PW_CHANNEL }, {}] : [{}];
  for (const option of options) {
    try {
      return await chromium.launch(option);
    } catch {
      /* fall through to the next candidate */
    }
  }
  for (const executablePath of CHROME_PATHS) {
    if (!existsSync(executablePath)) continue;
    try {
      return await chromium.launch({ executablePath });
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'No usable browser: run "npx playwright install chromium", or set PW_CHANNEL=chrome.',
  );
}

(async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();

  const errors = [];
  const IGNORE = /Future Flag Warning|Download the React DevTools/i;
  page.on('console', (m) => {
    if (IGNORE.test(m.text())) return;
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  try {
    /*
     * 0. Sign in. Every working screen requires an account (free tries are
     *    counted per account), so the flow has to start here or it is simply
     *    redirected to /login.
     */
    await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
    await page.locator('input[type="email"]').fill('browser-test@example.com');
    await page.locator('form input:not([type="email"])').first().fill('Browser Test');
    await page.getByRole('button', { name: /Continue/i }).click();
    await page.waitForSelector('a[href="/dashboard"]', { timeout: 30000 });
    ok('signed in');

    /* 1. School profile */
    await page.goto(BASE + '/school-profile', { waitUntil: 'networkidle' });
    await page.getByPlaceholder('e.g. Delhi Public School').fill('SHAHEED BHAGAT SINGH PUBLIC SCHOOL');
    await page.getByPlaceholder('Full address with city, state, PIN').fill('Village Jhiwerheri, Yamuna Nagar (Haryana)');
    await page.getByPlaceholder('DISCIPLINE • DEDICATION • EXCELLENCE').fill('DISCIPLINE • DEDICATION • EXCELLENCE');
    await page.getByPlaceholder('AFFILIATED TO C.B.S.E., NEW DELHI').fill('AFFILIATED TO C.B.S.E., NEW DELHI');
    await page.getByPlaceholder('e.g. 41627').fill('41627');
    await page.getByPlaceholder('e.g. 531651').fill('531651');
    await page.getByPlaceholder('e.g. 2025-2026').fill('2026-27');
    await page.getByPlaceholder('e.g. Periodic Test - I').fill('Periodic Test - I');
    await page.getByPlaceholder('e.g. 14-08-2026').fill('14-08-2026');
    await page.getByPlaceholder('Ms. Priya Verma').fill('Pooja Sharma');
    await page.getByPlaceholder('Mrs. Zahida').fill('Zahida');
    await page.getByPlaceholder('Dr. R. K. Sharma').fill('Ruhi Rani');
    ok('school profile filled');

    /* 2. Import */
    await page.locator('header nav a', { hasText: 'Import Students' }).first().click();
    await page.waitForSelector('text=Drop your Excel / CSV file here');
    await page.locator('#excel-input').setInputFiles(path.join(process.cwd(), EXCEL));
    await page.waitForSelector('text=Column Mapping', { timeout: 45000 });
    ok('excel uploaded and mapped');

    const mappingSummary = await page.locator('text=/\\d+ (subjects|subject)/').first().innerText().catch(() => '');
    console.log('  mapping summary:', mappingSummary.replace(/\s+/g, ' '));

    /* 3. Subjects */
    await page.getByRole('button', { name: 'Continue to Subjects' }).click();
    await page.waitForSelector('text=Dynamic Subject Configuration');
    const subjectRows = await page.locator('text=Dynamic Subject Configuration').locator('xpath=ancestor::div[contains(@class,"card")]').locator('tbody tr').count();
    ok(`subjects tab rendered (${subjectRows} subject rows)`);

    /* 4. Photos -> Preview */
    await page.getByRole('button', { name: 'Continue to Photos' }).click();
    await page.waitForSelector('text=Drop Student Photos ZIP');
    await page.getByRole('button', { name: 'Preview & Validate', exact: true }).click();
    await page.waitForSelector('text=Total Students', { timeout: 30000 });

    const totalStudents = await page
      .locator('div.card:has-text("Total Students") .text-2xl')
      .first()
      .innerText();
    const warnings = await page
      .locator('div.card:has-text("Warnings") .text-2xl')
      .first()
      .innerText();
    console.log('  preview: total=' + totalStudents.trim() + ' warnings=' + warnings.trim());
    if (totalStudents.trim() === String(EXPECT)) ok(`preview shows ${EXPECT} students`);
    else fail(`preview shows ${totalStudents.trim()} students (expected ${EXPECT})`);

    const previewText = await page.locator('main').innerText();
    console.log('  preview class/roll block present:', /Class/.test(previewText));
    console.log('  preview mentions English:', /English/i.test(previewText));

    /* 5. Report template (holistic card) */
    await page.locator('header nav a', { hasText: 'Report Template' }).first().click();
    await page.waitForSelector('text=HOLISTIC PROGRESS REPORT CARD', { timeout: 20000 });
    const card = page.locator('[data-testid="report-card"]').first();
    const cardText = (await card.innerText()).toUpperCase();
    for (const needle of [
      'HOLISTIC PROGRESS REPORT CARD',
      'ACADEMIC PERFORMANCE',
      'GRAND TOTAL',
      'CO-SCHOLASTIC AREAS',
      'PERSONALITY DEVELOPMENT',
      'LEARNING SKILLS',
      'HOLISTIC DEVELOPMENT PROFILE',
      'OVERALL PERFORMANCE',
      'Class Teacher',
      'Principal',
    ]) {
      if (cardText.includes(needle.toUpperCase())) ok('report card has "' + needle + '"');
      else fail('report card missing "' + needle + '"');
    }
    const box = await card.boundingBox();
    if (box) console.log('  report card px: ' + Math.round(box.width) + ' x ' + Math.round(box.height) + ' (A4 ≈ 794 x 1123)');

    /*
     * The Totals Preview card and the printed card must show the SAME numbers:
     * total, percentage, overall grade and result all come from one model. This
     * compares the two real renderings rather than either one against a literal.
     */
    const sidebarText = await page
      .locator('div.card:has-text("Totals Preview")')
      .first()
      .innerText();
    const totalMatch = sidebarText.match(/Grand Total[\s\S]{0,20}?([\d.]+)\s*\/\s*([\d.]+)/);
    const pctMatch = sidebarText.match(/Percentage[\s\S]{0,20}?([\d.]+)%/);
    const gradeMatch = sidebarText.match(/Overall Grade[\s\S]{0,20}?([A-Z0-9+\-]+)/);
    const resultMatch = sidebarText.match(/Result[\s\S]{0,20}?(PROMOTED|NEEDS IMPROVEMENT)/);

    if (totalMatch && cardText.includes(`${totalMatch[1]} / ${totalMatch[2]}`)) {
      ok(`card grand total matches the sidebar (${totalMatch[1]} / ${totalMatch[2]})`);
    } else {
      fail('card grand total does not match the sidebar: ' + JSON.stringify(totalMatch && totalMatch[0]));
    }
    if (pctMatch && cardText.includes(`${pctMatch[1]}%`)) {
      ok(`card percentage matches the sidebar (${pctMatch[1]}%)`);
    } else {
      fail('card percentage does not match the sidebar: ' + JSON.stringify(pctMatch && pctMatch[1]));
    }
    if (gradeMatch && cardText.includes(gradeMatch[1].toUpperCase())) {
      ok(`card prints the overall grade (${gradeMatch[1]})`);
    } else {
      fail('card does not print the overall grade: ' + JSON.stringify(gradeMatch && gradeMatch[1]));
    }
    if (resultMatch && cardText.includes(resultMatch[1])) {
      ok(`card prints the result (${resultMatch[1]})`);
    } else {
      fail('card does not print the result: ' + JSON.stringify(resultMatch && resultMatch[1]));
    }

    if (process.env.PROBE === '1') {
      const sections = await card.evaluate((el) => {
        const out = [];
        for (const child of Array.from(el.children)) {
          const r = child.getBoundingClientRect();
          out.push({
            tag: child.tagName,
            cls: String(child.className || '').slice(0, 52),
            h: Math.round(r.height),
          });
        }
        return out;
      });
      console.log('  --- section heights (card children) ---');
      for (const s of sections) console.log('   ' + String(s.h).padStart(5) + 'px  ' + s.tag + '  ' + s.cls);
      console.log('   sum=' + sections.reduce((a, s) => a + s.h, 0) + 'px');
    }

    const layout = await card.evaluate((el) => ({
      scrollW: el.scrollWidth,
      clientW: el.clientWidth,
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
    }));
    const hOverflow = layout.scrollW - layout.clientW;
    const vOverflow = layout.scrollH - layout.clientH;
    console.log('  overflow: horizontal=' + hOverflow + 'px vertical=' + vOverflow + 'px');
    if (hOverflow <= 1) ok('no horizontal overflow in report card');
    else fail('report card has ' + hOverflow + 'px horizontal overflow');
    if (vOverflow <= 40) ok('report card fits one A4 page (vertical overflow ' + vOverflow + 'px)');
    else fail('report card overflows A4 by ' + vOverflow + 'px');
    await page.screenshot({ path: '.tmpbuild/shot-template.png', fullPage: true });
    ok('screenshot saved: .tmpbuild/shot-template.png');

    /* 5b. The two marks-focused themes must be visibly different cards. */
    const themeSelect = page.locator('main select').first();
    const checkTheme = async (id, title, required, forbidden) => {
      await themeSelect.selectOption(id);
      await page.waitForSelector('text=' + title, { timeout: 20000 });
      const el = page.locator('[data-testid="report-card"]').first();
      const text = (await el.innerText()).toUpperCase();
      for (const needle of required) {
        if (text.includes(needle.toUpperCase())) ok(id + ' card has "' + needle + '"');
        else fail(id + ' card missing "' + needle + '"');
      }
      for (const needle of forbidden) {
        if (!text.includes(needle.toUpperCase())) ok(id + ' card omits "' + needle + '"');
        else fail(id + ' card should not print "' + needle + '"');
      }
      const box = await el.boundingBox();
      const layout = await el.evaluate((node) => ({
        sw: node.scrollWidth,
        cw: node.clientWidth,
        sh: node.scrollHeight,
        ch: node.clientHeight,
      }));
      if (layout.sw - layout.cw <= 1) ok(id + ' card has no horizontal overflow');
      else fail(id + ' card has ' + (layout.sw - layout.cw) + 'px horizontal overflow');
      if (layout.sh - layout.ch <= 40) ok(id + ' card fits one A4 page');
      else fail(id + ' card overflows A4 by ' + (layout.sh - layout.ch) + 'px');
      const band = await el.evaluate((node) => {
        const first = node.children[0];
        return first ? window.getComputedStyle(first).backgroundColor : 'none';
      });
      console.log(
        '  ' + id + ' card: ' + Math.round(box.width) + 'x' + Math.round(box.height) + 'px, header background ' + band,
      );
      return band;
    };

    const modernBand = await checkTheme(
      'modern',
      'STUDENT PROGRESS REPORT',
      ['ACADEMIC PERFORMANCE', 'GRAND TOTAL', 'MARKS OBTAINED', 'PERCENTAGE', 'OVERALL PERFORMANCE'],
      ['GRADING SCALE'],
    );
    const classicBand = await checkTheme(
      'academic',
      'STUDENT REPORT CARD',
      ['ACADEMIC PERFORMANCE', 'GRAND TOTAL', 'GRADING SCALE'],
      [],
    );
    if (modernBand !== classicBand) ok('the two themes use different header treatments');
    else fail('both themes render the same header background (' + modernBand + ')');
    await themeSelect.selectOption('holistic');
    ok('theme switched back to holistic');

    /* 6. Generate */
    await page.locator('header nav a', { hasText: 'Generate Reports' }).first().click();
    await page.waitForSelector('text=Generation Progress');
    const genBtn = page.getByRole('button', { name: /Generate \d+ Reports/ });
    if (await genBtn.count()) {
      await genBtn.first().click();
    } else {
      await page.getByRole('button', { name: /Re-generate/ }).first().click();
    }
    await page.getByRole('button', { name: /Download .*\.zip/ }).waitFor({ timeout: 180000 });
    ok('ZIP ready (download button appeared)');

    const generated = await page.locator('span.badge-success:has-text("Generated")').count();
    const failed = await page.locator('span.badge-error:has-text("Failed")').count();
    console.log('  generate results: generated=' + generated + ' failed=' + failed);
    if (generated === EXPECT && failed === 0) ok(`${EXPECT} PDFs generated, 0 failed`);
    else fail(`generated=${generated} failed=${failed} (expected ${EXPECT}/0)`);

    await page.screenshot({ path: '.tmpbuild/shot-generate.png', fullPage: true });
    ok('screenshot saved: .tmpbuild/shot-generate.png');
  } catch (e) {
    fail('flow threw: ' + e.message);
  }

  console.log('\n=== console/page errors (' + errors.length + ') ===');
  for (const err of errors.slice(0, 25)) console.log('  ' + err);

  if (process.env.MOBILE_PROBE === '1') {
    await runMobileChecks(browser, BASE);
  }
  if (process.env.PWA_PROBE === '1') {
    await runPwaChecks(browser, BASE);
  }

  await browser.close();

  const failedCount = steps.filter((s) => s.startsWith('FAIL')).length;
  console.log('\n=== summary: ' + (steps.length - failedCount) + ' passed, ' + failedCount + ' failed ===');
  process.exit(failedCount > 0 || errors.length > 0 ? 1 : 0);
})();
