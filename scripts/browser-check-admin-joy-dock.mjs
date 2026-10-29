/*
 * Real-browser check for the floating Admin Joy dock on the Admin Dashboard.
 *
 * It proves the behaviour that cannot be seen from unit tests:
 *   1. every dashboard tab shows exactly ONE Joy launcher (and none of the tabs
 *      shows a second one),
 *   2. the launcher opens the chat, the chat closes again, and the conversation
 *      survives navigation between tabs (state lives in the shared layout),
 *   3. the dedicated Admin Joy tab does not add a duplicate launcher — its full
 *      console is the assistant there, and "Full console" in the dock goes there,
 *   4. the dock never renders for a non-admin.
 *
 * No production data is touched: the admin session and the Supabase/Edge
 * responses are intercepted in the browser, so this runs against a local dev
 * server with stubbed backend answers.
 *
 * Run: node scripts/browser-check-admin-joy-dock.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';

const PORT = Number(process.env.ADMIN_JOY_CHECK_PORT || 5257);
/**
 * Reuse an already-running dev server instead of starting one. Handy when
 * verifying the exact server the developer has open:
 *   ADMIN_JOY_CHECK_URL=http://localhost:5173 node scripts/browser-check-admin-joy-dock.mjs
 */
const EXTERNAL_BASE = process.env.ADMIN_JOY_CHECK_URL;

const problems = [];
let checked = 0;
const check = (label, ok, detail = '') => {
  checked += 1;
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'no  '} ${label}${ok && detail ? ` (${detail})` : ''}${ok ? '' : ` -> ${detail}`}`);
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
      /* try the next root */
    }
  }
  return null;
};

const playwright = loadPlaywright();
if (!playwright) {
  console.log('playwright is not installed in this project or the sibling ReportCard Studio app.');
  console.log('Skipping the browser check (it would otherwise report a fake pass).');
  process.exit(0);
}

const executablePath = CHROME_PATHS.find((path) => path && existsSync(path));

/** A far-future fake session, so supabase-js never tries to refresh it. */
const fakeSession = (now) => ({
  access_token: 'stub-access-token',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(now / 1000) + 3600,
  refresh_token: 'stub-refresh-token',
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    aud: 'authenticated',
    role: 'authenticated',
    email: 'admin@ishmaverse.test',
    app_metadata: { provider: 'email' },
    user_metadata: { name: 'Stub Admin' },
    created_at: new Date(now).toISOString(),
  },
});

const TABS = [
  'Overview',
  'Audience',
  'Manage Greetings',
  'Upload Products',
  'Pricing Control',
  'Transactions',
  'Greeting Cards',
  'Subscriptions',
  'Site Settings',
  'Game Zone',
];

const vite = EXTERNAL_BASE
  ? null
  : await createServer({
      server: { port: PORT, strictPort: true },
      logLevel: 'error',
    });

let browser;
try {
  if (vite) await vite.listen();
  const base = EXTERNAL_BASE ?? `http://localhost:${PORT}`;

  browser = await playwright.chromium.launch(
    executablePath ? { executablePath } : {},
  );
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  /*
   * Stub the backend. A fake session is injected through localStorage (the key
   * name depends on the project ref, so the read is intercepted by shape), and
   * every REST/auth/function call is answered locally.
   */
  await context.addInitScript(() => {
    const originalGet = Storage.prototype.getItem;
    Storage.prototype.getItem = function getItem(key) {
      if (typeof key === 'string' && /-auth-token$/.test(key)) {
        return window.__STUB_SESSION__;
      }
      return originalGet.call(this, key);
    };
  });
  await context.addInitScript(`window.__STUB_SESSION__ = ${JSON.stringify(JSON.stringify(fakeSession(Date.now())))};`);

  await context.route('**/rest/v1/**', (route) => {
    const url = route.request().url();
    if (/\/rpc\/is_admin/.test(url)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: 'true' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await context.route('**/auth/v1/**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
  );
  await context.route('**/functions/v1/**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'stubbed in the browser check' }),
    }),
  );
  /* Anything else (fonts, analytics) is left alone. */

  const page = await context.newPage();
  const launcher = page.locator('[aria-label="Open Admin Joy"]');
  const panel = page.locator('[aria-label="Admin Joy assistant"]');

  await page.goto(`${base}/admin/dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[aria-label="Open Admin Joy"]', { timeout: 20000 });

  /* Hide the welcome tooltip so it can never sit over a click target. */
  const dismiss = page.locator('[aria-label="Dismiss welcome message"]');
  if (await dismiss.count()) await dismiss.first().click();

  check('the dashboard mounts the floating Admin Joy launcher', (await launcher.count()) === 1);
  check('…and does not open the panel by itself', (await panel.count()) === 0);

  /* ── every tab: exactly one launcher, no duplicate panel ───────────── */
  for (const tab of TABS) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(120);
    const launchers = await launcher.count();
    const panels = await panel.count();
    check(`“${tab}” shows exactly one launcher`, launchers === 1, String(launchers));
    check(`“${tab}” shows no second chat window`, panels === 0, String(panels));
  }

  /* ── open / close ─────────────────────────────────────────────────── */
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await launcher.click();
  await page.waitForSelector('[aria-label="Admin Joy assistant"]', { timeout: 5000 });
  check('the launcher opens one chat window', (await panel.count()) === 1);
  check('…and the launcher is replaced by it', (await launcher.count()) === 0);
  check(
    '…with Home Joy’s composer and quick commands',
    (await page.locator('[aria-label="Ask Admin Joy…"]').count()) === 1 &&
      (await page
        .getByRole('button', { name: 'Change the Plus greeting card price to ₹89.' })
        .count()) === 1,
  );

  /* ── the dock runs the real Admin Joy engine ──────────────────────── */
  await page.locator('[aria-label="Ask Admin Joy…"]').fill('what can you do');
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.body.innerText.includes('Here is what I can change for you'),
    undefined,
    { timeout: 8000 },
  );
  check('a question is answered by Admin Joy’s own engine', true);

  /* ── chat state survives navigation ───────────────────────────────── */
  await page.getByRole('button', { name: 'Transactions', exact: true }).click();
  await page.waitForTimeout(300);
  check(
    'the conversation is still open after switching tabs',
    (await page.locator('[aria-label="Admin Joy assistant"]').count()) === 1,
  );
  check(
    '…and keeps its messages (state lives in the shared layout)',
    (await page.locator('[aria-label="Admin Joy assistant"]').innerText()).includes(
      'Here is what I can change for you',
    ),
  );

  /* ── close gives the launcher back ───────────────────────────────── */
  await page.locator('[aria-label="Admin Joy assistant"] [aria-label="Close chat"]').click();
  await page.waitForTimeout(150);
  check('closing the chat restores exactly one launcher', (await launcher.count()) === 1);
  check('…and removes the window', (await panel.count()) === 0);

  /* ── the dedicated Admin Joy tab ──────────────────────────────────── */
  await page.getByRole('button', { name: 'Admin Joy', exact: true }).click();
  await page.waitForTimeout(300);
  check(
    'the dedicated Admin Joy tab shows its full console',
    (await page.locator('[aria-label="Ask Admin Joy"]').count()) === 1,
  );
  check('…and no floating launcher (no duplicate assistant)', (await launcher.count()) === 0);
  check(
    '…carrying the same conversation from the dock',
    (await page.locator('main').innerText()).includes('Here is what I can change for you'),
  );

  /* ── system diagnostics ───────────────────────────────────────────── */
  await page.waitForSelector('text=System diagnostics', { timeout: 15000 });
  const diagnosticsText = await page.locator('main').innerText();
  check('the console shows the system diagnostics panel', true);
  check(
    '…with a run control',
    /Run diagnostics|Running/.test(diagnosticsText),
    diagnosticsText.match(/(Run diagnostics|Running…)/)?.[0] ?? 'no control',
  );
  /*
   * The Edge Functions are stubbed with an empty body here, so the server half
   * cannot be verified. The panel must say so and must NOT print the green
   * “healthy” badge — that would be success inferred from a stub.
   */
  check(
    '…and does not claim health when the server checks could not run',
    !/\bhealthy\b/.test(diagnosticsText),
    diagnosticsText.slice(0, 200).replace(/\n+/g, ' '),
  );
  check(
    '…naming the server diagnostics gap',
    /Server diagnostics/i.test(diagnosticsText),
  );
  const rerun = page.getByRole('button', { name: /Run diagnostics/ });
  if (await rerun.count()) await rerun.first().click();
  await page.waitForTimeout(600);
  check(
    're-running diagnostics leaves the console usable',
    (await page.locator('[aria-label="Ask Admin Joy"]').count()) === 1,
  );

  /* ── “Full console” from the dock reaches that tab ────────────────── */
  await page.getByRole('button', { name: 'Overview', exact: true }).click();
  await launcher.click();
  await page.waitForSelector('[aria-label="Admin Joy assistant"]', { timeout: 5000 });
  await page.getByRole('button', { name: 'Full console' }).click();
  await page.waitForTimeout(300);
  check(
    '“Full console” switches to the dedicated tab',
    (await page.locator('[aria-label="Ask Admin Joy"]').count()) === 1,
  );
  check('…and leaves no floating window behind', (await panel.count()) === 0);

  /* ── a visitor never sees the admin dock ─────────────────────────── */
  {
    const guest = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await guest.route('**/rest/v1/**', (route) => {
      const url = route.request().url();
      if (/\/rpc\/is_admin/.test(url)) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: 'false' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await guest.route('**/auth/v1/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    await guest.route('**/functions/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'stubbed in the browser check' }),
      }),
    );
    const guestPage = await guest.newPage();
    await guestPage.goto(`${base}/admin/dashboard`, { waitUntil: 'domcontentloaded' });
    await guestPage.waitForTimeout(1500);
    check(
      'a non-admin gets no Admin Joy launcher',
      (await guestPage.locator('[aria-label="Open Admin Joy"]').count()) === 0,
    );
    check(
      '…and no admin chat window',
      (await guestPage.locator('[aria-label="Admin Joy assistant"]').count()) === 0,
    );
    await guest.close();
  }

  /* ── mobile: same launcher, panel fits the screen ────────────────── */
  {
    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await mobile.addInitScript(() => {
      const originalGet = Storage.prototype.getItem;
      Storage.prototype.getItem = function getItem(key) {
        if (typeof key === 'string' && /-auth-token$/.test(key)) return window.__STUB_SESSION__;
        return originalGet.call(this, key);
      };
    });
    await mobile.addInitScript(
      `window.__STUB_SESSION__ = ${JSON.stringify(JSON.stringify(fakeSession(Date.now())))};`,
    );
    await mobile.route('**/rest/v1/**', (route) =>
      /\/rpc\/is_admin/.test(route.request().url())
        ? route.fulfill({ status: 200, contentType: 'application/json', body: 'true' })
        : route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
    await mobile.route('**/auth/v1/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    await mobile.route('**/functions/v1/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'stubbed in the browser check' }),
      }),
    );
    const phone = await mobile.newPage();
    await phone.goto(`${base}/admin/dashboard`, { waitUntil: 'domcontentloaded' });
    await phone.waitForSelector('[aria-label="Open Admin Joy"]', { timeout: 20000 });
    check(
      'a phone shows exactly one launcher',
      (await phone.locator('[aria-label="Open Admin Joy"]').count()) === 1,
    );
    await phone.locator('[aria-label="Open Admin Joy"]').click();
    await phone.waitForSelector('[aria-label="Admin Joy assistant"]', { timeout: 5000 });
    const box = await phone.locator('[aria-label="Admin Joy assistant"]').boundingBox();
    check(
      '…and the chat window fits the phone width',
      Boolean(box) && box.width <= 390 && box.x >= 0,
      box ? `${Math.round(box.x)}..${Math.round(box.x + box.width)}` : 'no box',
    );
    await mobile.close();
  }

  /* ── public Home Joy still uses the same chrome ──────────────────── */
  {
    const home = await context.newPage();
    await home.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
    await home.waitForSelector('[aria-label="Open chat with Joy"]', { timeout: 20000 });
    check(
      'Home still shows exactly one Joy launcher',
      (await home.locator('[aria-label="Open chat with Joy"]').count()) === 1,
    );
    await home.locator('[aria-label="Open chat with Joy"]').click();
    await home.waitForSelector('[aria-label="IshMaVerse"]', { timeout: 5000 });
    check('…which still opens the Home chat window', (await home.locator('[aria-label="IshMaVerse"]').count()) === 1);
    await home.locator('[aria-label="TYPE A MESSAGE..."]').fill('is there a free card');
    await home.keyboard.press('Enter');
    await home.waitForFunction(
      () => document.body.innerText.includes('FREE Welcome Card'),
      undefined,
      { timeout: 8000 },
    );
    check('…and still answers a visitor’s question', true);
    await home.close();
  }
} catch (error) {
  problems.push(`browser check crashed — ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (vite) await vite.close().catch(() => {});
}

console.log(`\nbrowser dock checks: ${checked}`);
if (problems.length) {
  console.error('\n✗ Admin Joy dock browser check FAILED:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('\n✓ Admin Joy dock OK — one launcher on every tab, state survives navigation.');
