// Game Zone library checks.
//
// The Zone is supposed to behave like a desktop game library: one tile per
// registered game, and the tile opens that game's own screen. These checks pin
// the registry contract so the shelf cannot silently drift:
//
//   1. Pair-3Balls is the first registered game and carries every tile field.
//   2. Exactly the three product modes exist, with the right online/offline
//      nature (computer = offline, private + world = online).
//   3. The difficulty list is the engine's real difficulty list.
//   4. Nothing is invented to fill the shelf — a registered game must be real.
//   5. The library page is driven by the registry, not by hard-coded titles.
//   6. Advertising stays unavailable until a provider exists.
//
// Run: node scripts/check-game-library.mjs
import { createServer } from 'vite';
import { readFileSync } from 'node:fs';

const problems = [];
let checked = 0;
const check = (label, condition, detail = '') => {
  checked += 1;
  const ok = Boolean(condition);
  if (!ok) problems.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` -> ${detail}`}`);
};

const server = await createServer({
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'error',
});

try {
  const registry = await server.ssrLoadModule('/src/game/registry.ts');
  const ai = await server.ssrLoadModule('/src/game/pair3balls/ai.ts');
  const engine = await server.ssrLoadModule('/src/game/pair3balls/engine.ts');

  const { GAME_LIBRARY, DEFAULT_GAME_ID, PAIR_3_BALLS, getGame } = registry;
  const zoneSrc = readFileSync(new URL('../src/pages/GameZone.tsx', import.meta.url), 'utf8');

  /* ── 1. Pair-3Balls is the first game ─────────────────────────── */
  check('the library has at least one game', GAME_LIBRARY.length >= 1, String(GAME_LIBRARY.length));
  check('Pair-3Balls is the first registered game', GAME_LIBRARY[0]?.id === 'pair-3balls',
    GAME_LIBRARY[0]?.id);
  check('Pair-3Balls is the default game', DEFAULT_GAME_ID === 'pair-3balls', String(DEFAULT_GAME_ID));
  check('getGame resolves by id', getGame('pair-3balls') === PAIR_3_BALLS);
  check('getGame returns undefined for an unknown id', getGame('does-not-exist') === undefined);

  for (const game of GAME_LIBRARY) {
    check(`${game.id}: has a title`, typeof game.title === 'string' && game.title.trim() !== '');
    check(`${game.id}: has a short tile description`, typeof game.tagline === 'string' && game.tagline.trim() !== '');
    check(`${game.id}: has a full description`, typeof game.description === 'string' && game.description.length > 40);
    check(`${game.id}: has an icon key`, typeof game.icon === 'string' && game.icon.trim() !== '');
    check(`${game.id}: declares whether it plays offline`, typeof game.offline === 'boolean');
    check(`${game.id}: carries its own rules text`, Boolean(game.rules?.board && game.rules?.win));
  }

  const ids = GAME_LIBRARY.map((g) => g.id);
  check('game ids are unique', new Set(ids).size === ids.length, ids.join(','));

  /* ── 2. Exactly the four modes ───────────────────────────────── */
  check('Pair-3Balls has exactly four modes', PAIR_3_BALLS.modes.length === 4,
    String(PAIR_3_BALLS.modes.length));
  check('the modes are computer / local / private / world',
    PAIR_3_BALLS.modes.map((m) => m.id).join(',') === 'computer,local,private,world',
    PAIR_3_BALLS.modes.map((m) => m.id).join(','));
  check('Play vs Computer works offline',
    PAIR_3_BALLS.modes.find((m) => m.id === 'computer')?.online === false);
  check('two players on one device works offline',
    PAIR_3_BALLS.modes.find((m) => m.id === 'local')?.online === false);
  check('the local mode is labelled as an offline, same-device mode',
    /one device/i.test(PAIR_3_BALLS.modes.find((m) => m.id === 'local')?.title ?? '') &&
      Boolean(PAIR_3_BALLS.modes.find((m) => m.id === 'local')?.blurb?.trim()));
  check('Private Room is an online mode',
    PAIR_3_BALLS.modes.find((m) => m.id === 'private')?.online === true);
  check('World Match is an online mode',
    PAIR_3_BALLS.modes.find((m) => m.id === 'world')?.online === true);
  for (const mode of PAIR_3_BALLS.modes) {
    check(`${mode.id}: the mode card has a title and a blurb`,
      Boolean(mode.title?.trim() && mode.blurb?.trim()));
  }

  /* ── 3. Difficulties come from the engine ─────────────────────── */
  const engineDifficulties = ai.DIFFICULTIES.map((d) => d.id).join(',');
  const registryDifficulties = PAIR_3_BALLS.difficultyOptions.map((d) => d.id).join(',');
  check('the library lists the engine\'s real difficulties',
    registryDifficulties === engineDifficulties, `${registryDifficulties} vs ${engineDifficulties}`);
  check('there are three difficulties', PAIR_3_BALLS.difficultyOptions.length === 3);
  check('every difficulty has a label and a blurb',
    PAIR_3_BALLS.difficultyOptions.every((d) => d.label?.trim() && d.blurb?.trim()));
  check('the rules the library shows are the engine\'s rules',
    PAIR_3_BALLS.rules === engine.RULES);
  check('the game is marked as playable offline', PAIR_3_BALLS.offline === true);

  /* ── 4. Nothing invented ──────────────────────────────────────── */
  check('only Pair-3Balls is registered so far', GAME_LIBRARY.length === 1,
    ids.join(','));
  check('no registered game is a placeholder',
    GAME_LIBRARY.every((g) => !/coming soon|placeholder|todo|lorem/i.test(`${g.title} ${g.tagline} ${g.description}`)));

  /* ── 5. The page is driven by the registry ────────────────────── */
  check('the library page imports the registry', /from '\.\.\/game\/registry'/.test(zoneSrc));
  check('the library page maps over GAME_LIBRARY', /GAME_LIBRARY\.map\(/.test(zoneSrc));
  check('the library page has a library screen', /screen === 'library'/.test(zoneSrc));
  check('tiles open a dedicated game screen', /setScreen\('game'\)/.test(zoneSrc));
  check('there is a back-to-library control', /Game Library/.test(zoneSrc) && /const toLibrary/.test(zoneSrc));
  check('the tile shows an availability status', /Available/.test(zoneSrc));
  check('the page does not hard-code a game title outside the registry',
    !/'Pair-3Balls'/.test(zoneSrc) && !/Pair-3Balls/.test(zoneSrc.replace(/game\.title|entry\.title/g, '')),
    'a hard-coded title means the registry is not the source of truth');
  check('the private-room deep link still opens the lobby directly',
    /useParams<\{ code\?: string \}>/.test(zoneSrc) && /initialCode \? 'private'/.test(zoneSrc));
  check('the online modes are still gated on the real settings check',
    /fetchGameSettings/.test(zoneSrc) && /onlineAvailable === false/.test(zoneSrc));
  check('the Zone still mounts the JOY chatbot for this section',
    /<Chatbot sectionId="game-zone" \/>/.test(zoneSrc));
  check('the ad slot is still mounted on the game screen', /<AdSlot placement="lobby" \/>/.test(zoneSrc));

  const adSlot = await server.ssrLoadModule('/src/components/game/AdSlot.tsx');
  check('the ad slot still renders NOTHING without a provider',
    adSlot.AdSlot({ placement: 'lobby' }) === null && adSlot.isAdProviderConfigured() === false);

  /* ── 6. Local play needs no backend ───────────────────────────── */
  const gameSrc = readFileSync(new URL('../src/components/game/Pair3BallsGame.tsx', import.meta.url), 'utf8');
  check('the computer game renders without any network service',
    !/fetch\(|supabase|functions\.invoke/.test(gameSrc));

  /* ── 7. English-only UI: no language switch anywhere in the Zone ─ */
  const rulesSrc = readFileSync(
    new URL('../src/components/game/Pair3BallsRules.tsx', import.meta.url),
    'utf8',
  );
  const zoneFiles = ['src/pages/GameZone.tsx', 'src/components/game/Pair3BallsGame.tsx',
    'src/components/game/Pair3BallsRules.tsx', 'src/components/game/PrivateRoomLobby.tsx',
    'src/components/game/WorldMatchLobby.tsx', 'src/components/game/Pair3BallsBoard.tsx'];
  const withToggle = zoneFiles.filter((file) => {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    return /Hinglish|aria-label="Language"|setLang\b/.test(text);
  });
  check('no Game Zone file offers an English/Hinglish switch', withToggle.length === 0, withToggle.join(', '));
  check('the rules are written in English',
    /How to play/.test(rulesSrc) && /Nine points/.test(rulesSrc) && !/[\u0900-\u097F]/.test(rulesSrc));
  check('the rules still state the engine timer', /TURN_SECONDS/.test(rulesSrc));
} finally {
  await server.close();
}

console.log(`\ngame library checks: ${checked}`);
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  • ${problem}`);
  process.exit(1);
}
console.log('\n✓ Game Zone library OK — one registered game, four modes, offline play intact.');
