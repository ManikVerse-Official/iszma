/*
 * Real-browser check for the Admin Portal sign-in.
 *
 * The admin login used to fail in the browser with an opaque "Edge Function
 * request failed" CORS error. That failure has two halves:
 *
 *   1. the FRONTEND must call the right function on the right project with the
 *      right payload, and
 *   2. it must surface whatever the function actually answers (a readable
 *      "Incorrect email or password."), not a generic network message.
 *
 * Both are verified here WITHOUT touching production: the request to
 * `admin-login` is intercepted in the browser and answered locally, so no
 * credential ever reaches the deployed function and no rate-limit slot is used.
 *
 * Playwright is resolved from the project, from the sibling "ReportCard Studio"
 * install, or from a system Chrome. When none exists the script says so and
 * exits 0 — it never reports a fake pass.
 *
 * Run: node scripts/browser-check-admin.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';

const PORT = Number(process.env.ADMIN_CHECK_PORT || 5244);
const BASE = `http://localhost:${PORT}`;

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
  const roots = [
    new URL('../package.json', import.meta.url),
    new URL('../ReportCard Studio/package.json', import.meta.url),
  ];
  for (const root of roots) {
    try {
      const require = createRequire(root);
      return require('playwright');
    } catch {
      /* try the next root */
    }
  }
  return null;
};

const playwright = loadPlaywright();

if (!playwright) {
  console.log('SKIP — Playwright is not installed, so the Admin Portal could not be driven in a browser.');
  console.log('       scripts/check-cors.ts still pins the shared CORS policy.');
  process.exit(0);
}

const server = await createServer({
  server: { port: PORT, strictPort: true },
  logLevel: 'error',
});

let browser = null;

try {
  await server.listen();

  const { chromium } = playwright;
  const launchErrors = [];

  for (const executablePath of [undefined, ...CHROME_PATHS]) {
    if (executablePath && !existsSync(executablePath)) continue;
    try {
      browser = await chromium.launch(executablePath ? { executablePath } : {});
      break;
    } catch (error) {
      launchErrors.push(`${executablePath ?? 'bundled'}: ${String(error.message).split('\n')[0]}`);
    }
  }

  if (!browser) {
    console.log('SKIP — no usable Chrome/Chromium binary was found for Playwright.');
    for (const line of launchErrors) console.log(`       ${line}`);
    console.log('       Run "npx playwright install chromium" and re-run this script.');
    process.exit(0);
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  /* Every console line the browser emits, so framework noise can be pinned. */
  const consoleLines = [];
  page.on('console', (message) => consoleLines.push(`${message.type()}: ${message.text()}`));

  /* Everything the frontend sends to admin-login, captured (never forwarded). */
  const calls = [];
  let answerStatus = 401;
  let answerBody = { success: false, error: 'Incorrect email or password.' };
  /* When true the request is failed at the network layer (unreachable function). */
  let failAtNetwork = false;

  await page.route('**/functions/v1/admin-login', async (route) => {
    const request = route.request();
    if (failAtNetwork) {
      await route.abort('failed');
      return;
    }
    calls.push({
      url: request.url(),
      method: request.method(),
      body: request.postData() ?? '',
    });
    await route.fulfill({
      status: answerStatus,
      headers: {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
      },
      body: JSON.stringify(answerBody),
    });
  });

  /* ── the page renders the real sign-in form ───────────────────────── */
  await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
  const emailVisible = await page.locator('input[type="email"]').isVisible();
  const passwordVisible = await page.locator('input[type="password"]').isVisible();
  const submit = page.getByRole('button', { name: /Enter Admin Panel/i });
  check('the /admin route renders the admin sign-in form', emailVisible && passwordVisible);
  check('the form offers the real submit control', await submit.isVisible());
  check(
    'the admin address is not pre-filled (nothing privileged ships in the bundle)',
    (await page.locator('input[type="email"]').inputValue()) === '',
  );

  /* ── a rejected sign-in shows the function's own message ──────────── */
  await page.locator('input[type="email"]').fill('browser-check@example.com');
  await page.locator('input[type="password"]').fill('definitely-not-the-password');
  await submit.click();
  await page.waitForFunction(
    () => /Incorrect email or password/i.test(document.body.innerText),
    null,
    { timeout: 15000 },
  ).catch(() => {});

  const bodyText = await page.locator('body').innerText();
  check(
    'a 401 response is shown to the user verbatim',
    /Incorrect email or password/i.test(bodyText),
    bodyText.match(/Incorrect email or password[^\n]*/i)?.[0] ?? 'message not shown',
  );
  check(
    'no generic network failure is shown instead',
    !/Failed to fetch|Edge Function|Load failed|NetworkError/i.test(bodyText),
  );

  const first = calls[0];
  check('the submit really calls the admin-login Edge Function', Boolean(first), `${calls.length} call(s)`);

  if (first) {
    const url = new URL(first.url);
    check(
      'it calls the configured Supabase project (not a placeholder)',
      /\.supabase\.(co|in)$/i.test(url.hostname) && !url.hostname.includes('placeholder'),
      url.hostname,
    );
    check('it uses a POST with the password grant body', first.method === 'POST');
    let parsed = null;
    try {
      parsed = JSON.parse(first.body);
    } catch {
      /* reported below */
    }
    check(
      'the body carries the typed email and password and nothing else',
      Boolean(parsed) &&
        parsed.email === 'browser-check@example.com' &&
        parsed.password === 'definitely-not-the-password',
      first.body.slice(0, 80),
    );
    check(
      'the preflight/target path is exactly /functions/v1/admin-login',
      url.pathname === '/functions/v1/admin-login',
      url.pathname,
    );
  }

  /* ── a 200 with a real-shaped session must not be trusted blindly ─── */
  calls.length = 0;
  answerStatus = 200;
  answerBody = {
    success: true,
    access_token: 'not-a-real-token',
    refresh_token: 'not-a-real-refresh-token',
    expires_in: 3600,
    user_id: '00000000-0000-0000-0000-000000000000',
    email: 'browser-check@example.com',
  };

  await page.getByRole('button', { name: /Enter Admin Panel/i }).click();
  await page.waitForTimeout(1500);

  /*
   * The function answered 200 but the tokens cannot mint a real session, so the
   * UI must show its own error — and must NOT open the dashboard. The error is
   * read from the form's own error element, not from loose body text.
   */
  const errorBox = page.locator('form p.text-red-400');
  const errorText = (await errorBox.count()) > 0 ? (await errorBox.first().innerText()).trim() : '';
  const dashboardOpen = /Admin Dashboard|Sign out/i.test(await page.locator('body').innerText());

  check(
    'an invalid session is reported instead of silently granting the dashboard',
    errorText.length > 0 && !dashboardOpen,
    errorText || 'no error element rendered',
  );
  check('the page never crashed while rejecting the session', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));

  /* ── an unreachable function must be explained, not blamed on nothing ── */
  calls.length = 0;
  failAtNetwork = true;
  await page.getByRole('button', { name: /Enter Admin Panel/i }).click();
  await page.waitForTimeout(2500);
  const unreachableText = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  check(
    'an unreachable admin-login function explains the deployment/CORS condition',
    /Could not reach the admin sign-in service/i.test(unreachableText),
    unreachableText.match(/Could not reach[^.]*\./i)?.[0] ?? unreachableText.slice(0, 120),
  );
  check(
    'the unreachable case never claims the credentials were wrong',
    !/Incorrect email or password/i.test(unreachableText),
  );

  /* ── console hygiene on the sign-in screen ─────────────────────────── */
  const routerWarnings = consoleLines.filter((line) => /React Router Future Flag/i.test(line));
  check(
    'React Router prints no future-flag warnings on the sign-in screen',
    routerWarnings.length === 0,
    routerWarnings[0] ?? '',
  );
  const realtimeNoise = consoleLines.filter((line) => /WebSocket is closed|realtime\/v1\/websocket/i.test(line));
  check(
    'no realtime WebSocket error is logged (the key cannot authenticate realtime)',
    realtimeNoise.length === 0,
    realtimeNoise[0] ?? '',
  );

  check('no page errors during the admin pass', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
} finally {
  if (browser) await browser.close();
  await server.close();
}

console.log(`\nAdmin Portal browser checks: ${checked}`);
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  • ${problem}`);
  process.exit(1);
}
console.log('\n✓ Admin Portal OK — the real form renders and answers are surfaced verbatim.');
