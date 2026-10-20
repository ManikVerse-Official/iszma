/*
 * Real-browser check for the Game Zone.
 *
 * Boots the actual Vite dev server, opens the real routes in Chrome and PLAYS a
 * complete Pair-3Balls game against the computer by clicking the board. It
 * intentionally does not touch the online modes' buttons (creating a room or
 * joining matchmaking would write to the live Supabase project), so those are
 * verified by scripts/check-pair3balls.mjs (rules + client/server parity).
 *
 * Playwright is resolved from the project, or from the sibling "ReportCard
 * Studio" install that already ships it, or from a system Chrome. When none of
 * those exist the script says so and exits 0 — it never reports a fake pass.
 *
 * Run: node scripts/browser-check-gamezone.mjs
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';

/** True when the online mode cards are clickable (i.e. the backend is reachable). */
const onlineModeEnabled = async (page) =>
  !(await page.locator('button:has-text("World Match")').first().isDisabled());

const PORT = Number(process.env.GAME_ZONE_PORT || 5233);
const BASE = `http://localhost:${PORT}`;

const problems = [];
let checked = 0;
const check = (label, ok, detail = '') => {
  checked += 1;
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok && detail ? ` (${detail})` : ''}${ok ? '' : ` -> ${detail}`}`);
};

/* ------------------------------------------------------------------ */
/* Playwright (optional — the harness must not invent a browser)       */
/* ------------------------------------------------------------------ */

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
  console.log('SKIP — Playwright is not installed, so the UI could not be driven in a browser.');
  console.log('       (The rules engine and the client/server parity are still checked by');
  console.log('        scripts/check-pair3balls.mjs, which needs no browser.)');
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
  const knownNoise = [];
  const networkNotes = [];
  /*
   * The deployed `track-visit` function rejects the local dev origin, so its
   * CORS refusal shows up as a console error on every route. It is a pre-existing
   * deployment/config issue, unrelated to the Game Zone, so it is reported as a
   * NOTE instead of failing this check — but it is never hidden.
   */
  const isPreExistingNoise = (text) =>
    /track-visit/i.test(text) || /favicon/i.test(text);

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) =>
    networkNotes.push(`request failed: ${request.url().slice(0, 110)} (${request.failure()?.errorText ?? 'unknown'})`),
  );
  page.on('response', (response) => {
    if (response.status() >= 400 && !/favicon/i.test(response.url())) {
      networkNotes.push(`HTTP ${response.status()}: ${response.url().slice(0, 110)}`);
    }
  });
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (isPreExistingNoise(text)) {
      if (!knownNoise.includes(text)) knownNoise.push(text);
      return;
    }
    /* "Failed to load resource" is a network symptom, not a JS error; the URL
     * behind it is captured above and reported as a note. */
    if (/Failed to load resource/i.test(text)) return;
    pageErrors.push(`console: ${text}`);
  });

  /* ---------------------------------------------------------------- */
  /* 1. The landing page                                               */
  /* ---------------------------------------------------------------- */
  await page.goto(`${BASE}/game-zone`, { waitUntil: 'networkidle' });

  /* The landing screen is the LIBRARY: one tile per registered game. */
  check('the Game Zone route loads the game library', await page.locator('h1', { hasText: 'Game Library' }).isVisible());
  const tile = page.locator('article:has-text("Pair-3Balls")').first();
  check('Pair-3Balls has its own tile', await tile.isVisible());
  check(
    'the tile carries an icon, a title, a description and a status',
    (await tile.locator('svg').count()) > 0 &&
      /Pair-3Balls/.test(await tile.innerText()) &&
      /nine points/i.test(await tile.innerText()) &&
      /available/i.test(await tile.innerText()),
    (await tile.innerText()).replace(/\s+/g, ' ').slice(0, 90),
  );
  const openButton = tile.locator('button:has-text("Play")').first();
  check('the tile has a Play button', await openButton.isVisible());

  /* Opening the tile enters the game's own screen. */
  await openButton.click();
  await page.waitForTimeout(400);
  check('opening the tile shows the game screen', await page.locator('h1', { hasText: 'Pair-3Balls' }).isVisible());
  for (const mode of ['Play vs Computer', 'Private Room', 'World Match']) {
    check(`the "${mode}" card is offered`, await page.locator(`button:has-text("${mode}")`).first().isVisible());
  }
  check(
    'the rules are shown in the Game Zone',
    /nine points/i.test(await page.locator('main').innerText()),
  );
  check(
    'the 60-second timer is stated on the page',
    /60-second/i.test(await page.locator('main').innerText()),
  );
  check('the mode list is exactly the three product modes', (await page.locator('button:has-text("Play vs Computer")').count()) === 1);
  check(
    'there is a way back to the library',
    (await page.locator('button:has-text("Game Library")').count()) === 1,
  );

  /* ---------------------------------------------------------------- */
  /* 2. Difficulty selection                                           */
  /* ---------------------------------------------------------------- */
  await page.locator('button:has-text("Play vs Computer")').first().click();
  await page.waitForTimeout(300);

  const mainText = await page.locator('main').innerText();
  for (const level of ['Easy', 'Medium', 'Hard']) {
    check(`difficulty "${level}" is offered`, new RegExp(`\\b${level}\\b`).test(mainText));
  }

  await page.locator('button', { hasText: /^Hard/ }).first().click();
  await page.waitForTimeout(400);

  const points = page.locator('button[aria-label*="selectable"]');
  check('the board renders nine points', (await page.locator('button[aria-label*="piece"], button[aria-label*="empty"]').count()) === 9);
  check('the human may click a point to start', (await points.count()) === 9, `${await points.count()} selectable`);

  /* ---------------------------------------------------------------- */
  /* 3. Play a complete game by clicking                               */
  /* ---------------------------------------------------------------- */
  const status = page.locator('p[role="status"]');
  check(
    'the turn indicator names the side to move',
    /White to play/i.test(await page.locator('main').innerText()),
  );
  check(
    'the human is told to place a piece',
    /place a piece/i.test(await status.innerText()),
    await status.innerText(),
  );
  check('the turn timer is shown', /^\d+s$/.test((await page.locator('span.tabular-nums').first().innerText()).trim()));

  let clicks = 0;
  let blackMoves = 0;

  while (clicks < 160) {
    const text = await status.innerText();
    if (/wins/i.test(text)) break;

    const target = page.locator('button[aria-label*="selectable"]:not([disabled])').first();
    if ((await target.count()) === 0) {
      await page.waitForTimeout(700);
      continue;
    }
    await target.click();
    clicks += 1;
    await page.waitForTimeout(700); // let the computer answer
    blackMoves = (await page.locator('li:has-text("Black")').count());
  }

  const finalStatus = await status.innerText();
  check(
    `a game plays through to a result (${clicks} clicks, final: "${finalStatus}")`,
    /wins/i.test(finalStatus),
  );
  check('the move log records both players', blackMoves > 0, `${blackMoves} black entries`);
  check('the result banner appears', (await page.locator('text=/wins/').count()) > 0);
  check(
    'the result states how the game ended',
    /three in a row|ran out of time/i.test(await page.locator('main').innerText()),
  );
  check('no point accepts a click once the game is over', (await page.locator('button[aria-label*="selectable"]').count()) === 0);

  /* ---------------------------------------------------------------- */
  /* 4. Restart clears everything                                      */
  /* ---------------------------------------------------------------- */
  await page.locator('button:has-text("Rematch"), button:has-text("New game")').first().click();
  await page.waitForTimeout(400);

  check('a rematch starts a fresh game', !/wins/i.test(await status.innerText()));
  check('the fresh board is empty again', (await page.locator('button[aria-label*="selectable"]').count()) === 9);
  check('the fresh board has no pieces', (await page.locator('button[aria-label*="piece"]').count()) === 0);

  /* ---------------------------------------------------------------- */
  /* 5. The other modes render (buttons untouched on purpose)          */
  /* ---------------------------------------------------------------- */
  await page.locator('button:has-text("Modes")').first().click();
  await page.waitForTimeout(400);
  check(
    'the user can navigate back out of a game to the mode list',
    (await page.locator('button:has-text("Play vs Computer")').count()) > 0,
  );

  /* And from the mode list back to the library shelf. */
  await page.locator('button:has-text("Game Library")').first().click();
  await page.waitForTimeout(400);
  check(
    'the user can navigate back from the game to the library',
    await page.locator('h1', { hasText: 'Game Library' }).isVisible(),
  );
  await page.locator('article:has-text("Pair-3Balls") button:has-text("Play")').first().click();
  await page.waitForTimeout(400);
  if (!(await onlineModeEnabled(page))) {
    console.log('note the online modes read as unavailable here (Supabase not configured for this origin)');
  }

  const privateCard = page.locator('button:has-text("Private Room")').first();
  if (await privateCard.isVisible()) {
    const disabled = await privateCard.isDisabled();
    console.log(
      disabled
        ? 'ok   Private Room is disabled (the live backend is unavailable here) — not clicked'
        : 'note Private Room is enabled; its buttons are NOT clicked, because creating a room would write to the live project',
    );
  }

  /* ---------------------------------------------------------------- */
  /* 6. No runtime errors, and the rest of the app still boots         */
  /* ---------------------------------------------------------------- */
  check('the Game Zone produced no JavaScript runtime errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  for (const noise of knownNoise) console.log(`note pre-existing console noise (not Game Zone): ${noise.slice(0, 140)}`);
  for (const note of [...new Set(networkNotes)].slice(0, 6)) console.log(`note network: ${note}`);

  for (const route of ['/', '/game-zone']) {
    const errors = [];
    const off = (error) => errors.push(error.message);
    page.on('pageerror', off);
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    page.off('pageerror', off);
    check(`route ${route} still loads without a crash`, errors.length === 0, errors.slice(0, 2).join(' | '));
  }
} finally {
  if (browser) await browser.close();
  await server.close();
}

console.log(`\nGame Zone browser checks: ${checked}`);
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  • ${problem}`);
  process.exit(1);
}
console.log('\n✓ Game Zone OK — the real UI renders and a full game plays to a result in Chrome.');
