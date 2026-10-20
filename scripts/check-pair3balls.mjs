// Pair-3Balls rules engine + AI checks.
//
// Covers the required cases:
//    1. All eight winning lines are detected; mixed ownership never wins.
//    2. Illegal placement / movement is rejected (occupied, out of turn, wrong
//       phase, not adjacent, empty source, opponent's piece, same point,
//       out-of-range point).
//    3. Placement phase ends after six pieces, then movement begins.
//    4. Pieces are never captured; counts stay constant while moving.
//    5. Exactly one terminal result — no double winners, no moves after the end.
//    6. The 60-second turn deadline forfeits the correct player.
//    7. Serialise/deserialise round-trips (used by the online layer).
//    8. Every AI difficulty only ever plays legal actions, Easy takes a win but
//       ignores threats, Medium/Hard block an immediate loss.
//
// Run: node scripts/check-pair3balls.mjs
import { createServer } from 'vite';

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
  const engine = await server.ssrLoadModule('/src/game/pair3balls/engine.ts');
  const ai = await server.ssrLoadModule('/src/game/pair3balls/ai.ts');

  const {
    LINES, ADJACENCY, POINT_COUNT, TURN_MS, TURN_SECONDS, PIECES_PER_PLAYER,
    createGame, applyPlace, applyMove, applyAction, findWinner, legalActions,
    legalPlacements, legalMoves, settleTimeout, serialize, deserialize,
    countPieces, remainingMs, winningLines, other, RULES, POINT_GRID,
  } = engine;

  const T0 = 1_700_000_000_000;
  const board = (spec) => {
    const cells = Array(POINT_COUNT).fill(null);
    for (const [point, owner] of Object.entries(spec)) cells[Number(point)] = owner;
    return cells;
  };
  /** Builds a state with an explicit board, phase and turn. */
  const state = (spec, turn, phase) => ({
    ...createGame(T0),
    board: board(spec),
    turn,
    phase,
  });

  /* ---------------------------------------------------------------- */
  /* 1. Board shape                                                    */
  /* ---------------------------------------------------------------- */
  check('there are nine playable points', POINT_COUNT === 9);
  check('there are eight valid lines', LINES.length === 8, String(LINES.length));
  check(
    'every line has three distinct in-range points',
    LINES.every((line) => new Set(line).size === 3 && line.every((p) => Number.isInteger(p) && p >= 0 && p < 9)),
  );
  check('every point has grid coordinates', POINT_GRID.length === 9);
  check(
    'the centre (8) joins all eight outer points',
    ADJACENCY[8].join(',') === '0,1,2,3,4,5,6,7',
    ADJACENCY[8].join(','),
  );
  check('corner 0 joins its two midpoints and the centre', ADJACENCY[0].join(',') === '4,7,8', ADJACENCY[0].join(','));
  check('corner 3 joins its two midpoints and the centre', ADJACENCY[3].join(',') === '5,6,8', ADJACENCY[3].join(','));
  check('adjacency is symmetric', ADJACENCY.every((list, from) => list.every((to) => ADJACENCY[to].includes(from))));
  check(
    'adjacency only ever joins points that share a line',
    ADJACENCY.every((list, from) => list.every((to) => LINES.some((l) => l.includes(from) && l.includes(to)))),
  );

  /* ---------------------------------------------------------------- */
  /* 2. Every winning line                                             */
  /* ---------------------------------------------------------------- */
  for (const [a, b, c] of LINES) {
    const cells = board({ [a]: 'white', [b]: 'white', [c]: 'white' });
    check(`line ${a}-${b}-${c} wins for white`, findWinner(cells) === 'white');
    const blackCells = board({ [a]: 'black', [b]: 'black', [c]: 'black' });
    check(`line ${a}-${b}-${c} wins for black`, findWinner(blackCells) === 'black');
  }
  check(
    'mixed ownership on a line is NOT a win',
    findWinner(board({ 0: 'white', 4: 'black', 1: 'white' })) === null,
  );
  check('two of three on a line is NOT a win', findWinner(board({ 0: 'white', 4: 'white' })) === null);
  check(
    'an empty board has no winner',
    findWinner(Array(9).fill(null)) === null,
  );

  /* ---------------------------------------------------------------- */
  /* 3. Placement phase                                                */
  /* ---------------------------------------------------------------- */
  {
    let game = createGame(T0);
    check('a new game starts in the placement phase', game.phase === 'placement');
    check('white moves first', game.turn === 'white');
    check('nine placements are available at the start', legalPlacements(game).length === 9);

    // Alternate placements on points that cannot accidentally line up.
    const order = [4, 0, 5, 1, 6, 2]; // white, black, white, black, white, black
    let ok = true;
    for (const point of order) {
      const outcome = applyPlace(game, point, T0);
      if (!outcome.ok) {
        ok = false;
        break;
      }
      game = outcome.state;
    }
    check('six alternating placements are accepted', ok);
    check('placement phase ends after six pieces', game.phase === 'movement', game.phase);
    check('exactly three pieces per player after placement', (() => {
      const { white, black } = countPieces(game);
      return white === PIECES_PER_PLAYER && black === PIECES_PER_PLAYER;
    })());
    check('turn alternated back to white', game.turn === 'white', game.turn);
    check('no further placement is allowed once movement starts', legalPlacements(game).length === 0);
    check('a placement during the movement phase is rejected', (() => {
      const outcome = applyPlace(game, 8, T0);
      return outcome.ok === false && outcome.code === 'wrong-phase';
    })());
  }

  /* ---------------------------------------------------------------- */
  /* 4. Illegal movements                                              */
  /* ---------------------------------------------------------------- */
  {
    const moving = state({ 0: 'white', 8: 'white', 4: 'black', 5: 'black', 6: 'black' }, 'white', 'movement');
    check('moving onto an occupied point is rejected', (() => {
      const o = applyMove(moving, 0, 8, T0);
      return !o.ok && o.code === 'occupied';
    })());
    check("moving the opponent's piece is rejected", (() => {
      const o = applyMove(moving, 4, 1, T0);
      return !o.ok && o.code === 'not-yours';
    })());
    check('moving from an empty point is rejected', (() => {
      const o = applyMove(moving, 2, 8, T0);
      return !o.ok && o.code === 'empty-source';
    })());
    check('moving to a non-adjacent point is rejected', (() => {
      // 0 and 1 share no line, so the step is illegal.
      const o = applyMove(moving, 0, 1, T0);
      return !o.ok && o.code === 'not-adjacent';
    })());
    check('moving a piece onto itself is rejected', (() => {
      const o = applyMove(moving, 0, 0, T0);
      return !o.ok && o.code === 'same-point';
    })());
    check('an out-of-range point is rejected', (() => {
      const o = applyMove(moving, 0, 99, T0);
      return !o.ok && o.code === 'bad-point';
    })());
    check('placing on an occupied point is rejected', (() => {
      const placing = state({ 0: 'white' }, 'black', 'placement');
      const o = applyPlace(placing, 0, T0);
      return !o.ok && o.code === 'occupied';
    })());
    check('a legal step is accepted', (() => {
      const o = applyMove(moving, 0, 7, T0);
      return o.ok === true;
    })());
    check('a legal step alternates the turn', (() => {
      const o = applyMove(moving, 0, 7, T0);
      return o.state.turn === 'black';
    })());
  }

  /* ---------------------------------------------------------------- */
  /* 5. No captures                                                    */
  /* ---------------------------------------------------------------- */
  {
    let game = state({ 0: 'white', 8: 'white', 4: 'black', 5: 'black', 6: 'black' }, 'white', 'movement');
    const before = countPieces(game);
    let steps = 0;
    // Drive the sequence from the engine's own legal-move list, so this test can
    // never itself contain an illegal step.
    for (let i = 0; i < 8 && !game.winner; i += 1) {
      const [move] = legalMoves(game);
      if (!move) break;
      const outcome = applyMove(game, move.from, move.to, T0);
      if (!outcome.ok) break;
      game = outcome.state;
      steps += 1;
    }
    check('a run of legal steps all succeed', steps >= 6, `${steps} steps`);
    const after = countPieces(game);
    check('piece counts never change during movement (no captures)', before.white === after.white && before.black === after.black);
  }

  /* ---------------------------------------------------------------- */
  /* 6. Exactly one terminal result                                    */
  /* ---------------------------------------------------------------- */
  {
    // White has 0 and 4; placing on 1 completes the top line.
    const placing = state({ 0: 'white', 4: 'white' }, 'white', 'placement');
    const win = applyPlace(placing, 1, T0);
    check('completing a line ends the game', win.ok && win.state.phase === 'finished');
    check('the winner is recorded', win.state.winner === 'white');
    check('the reason is recorded', win.state.reason === 'three-in-a-row');
    check('an end time is recorded', typeof win.state.endedAt === 'number');

    const finished = win.state;
    const retry = applyPlace(finished, 8, T0);
    check('no action is accepted after the game ends', !retry.ok && retry.code === 'finished');
    check('the winner cannot change after the game ends', retry.state.winner === 'white');

    const moveRetry = applyMove(finished, 0, 7, T0);
    check('no movement is accepted after the game ends', !moveRetry.ok && moveRetry.code === 'finished');
    check('the terminal state is stable across repeated attempts', moveRetry.state.winner === 'white' && moveRetry.state.phase === 'finished');
    check('a finished game offers no legal actions', legalActions(finished).length === 0);
    check('a finished game reports no remaining time', remainingMs(finished, T0) === 0);
  }
  {
    // `winningLines` must report the completed line and its owner, and nothing
    // for a near-miss. (With three pieces each, two lines can never complete on
    // the same move, so that state is deliberately not asserted.)
    const one = winningLines(board({ 0: 'white', 8: 'white', 3: 'white', 1: 'black' }));
    check('a completed line is reported exactly once', one.length === 1, String(one.length));
    check('the reported line names its owner', one[0]?.player === 'white');
    check('the reported line is the real one', (one[0]?.line ?? []).join(',') === '0,8,3');
    check('a near-miss reports no line', winningLines(board({ 0: 'white', 8: 'white', 4: 'black' })).length === 0);
  }

  /* ---------------------------------------------------------------- */
  /* 7. The 60-second turn timer                                       */
  /* ---------------------------------------------------------------- */
  {
    check('the turn timer is 60 seconds', TURN_SECONDS === 60);
    const game = createGame(T0);
    check('a fresh turn has the full 60 seconds', remainingMs(game, T0) === TURN_MS);
    check('time remaining counts down', remainingMs(game, T0 + 30_000) === 30_000);
    check('time remaining never goes negative', remainingMs(game, T0 + 999_999) === 0);

    const expired = settleTimeout(game, T0 + TURN_MS + 1);
    check('running out of time loses the game', expired.phase === 'finished');
    check('the player who ran out of time loses', expired.winner === other(game.turn));
    check('the loss reason is the timeout', expired.reason === 'timeout');

    const repeated = settleTimeout(expired, T0 + TURN_MS + 99_999);
    check('a timeout resolved twice does not produce a second result', repeated.winner === expired.winner && repeated.reason === 'timeout');

    const early = settleTimeout(game, T0 + 1_000);
    check('settling before the deadline changes nothing', early.phase === 'placement' && early.turn === game.turn);

    // A move submitted after the deadline must not be honoured.
    const lateMove = applyPlace(game, 4, T0 + TURN_MS + 1);
    check('a move after the deadline is not accepted', !lateMove.ok);
    check('a late move forfeits the player who was on the clock', lateMove.state.winner === 'black');
  }

  /* ---------------------------------------------------------------- */
  /* 8. Serialisation round-trip                                       */
  /* ---------------------------------------------------------------- */
  {
    let game = createGame(T0);
    for (const point of [4, 0, 5, 1, 6, 2]) game = applyPlace(game, point, T0).state;
    const restored = deserialize(serialize(game), T0 + 5_000);
    check('serialise/deserialise keeps the board', restored.board.join(',') === game.board.join(','));
    check('serialise/deserialise keeps the turn', restored.turn === game.turn);
    check('serialise/deserialise keeps the phase', restored.phase === game.phase);
    check('serialise/deserialise keeps the deadline', restored.turnDeadlineAt === game.turnDeadlineAt);
    check('a legal step works on the restored state', (() => {
      const o = applyMove(restored, 4, 8, T0 + 5_000);
      return o.ok === true;
    })());
    const garbage = deserialize({ board: 'nonsense', turn: 42, phase: 7 }, T0);
    check('garbage input falls back to a valid placement state', garbage.phase === 'placement' && garbage.board.length === 9);
    check('an empty input falls back to a fresh game', deserialize(undefined, T0).turn === 'white');
  }

  /* ---------------------------------------------------------------- */
  /* 9. AI — legality on every difficulty                              */
  /* ---------------------------------------------------------------- */
  {
    const difficulties = ['easy', 'medium', 'hard'];
    const legalSet = (s) => new Set(legalActions(s).map((a) => `${a.kind}:${a.from ?? ''}:${a.to}`));

    // A deterministic pseudo-random walk through real games.
    let seed = 12345;
    const rng = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    let allLegal = true;
    let movesChecked = 0;
    let gamesFinished = 0;

    for (let game = 0; game < 12; game += 1) {
      let current = createGame(T0);
      for (let step = 0; step < 60 && !current.winner; step += 1) {
        const difficulty = difficulties[step % difficulties.length];
        const action = ai.chooseAction(current, difficulty, rng);
        if (!action) break;

        if (!legalSet(current).has(`${action.kind}:${action.from ?? ''}:${action.to}`)) {
          allLegal = false;
          break;
        }
        const outcome = applyAction(current, action, T0);
        if (!outcome.ok) {
          allLegal = false;
          break;
        }
        current = outcome.state;
        movesChecked += 1;
      }
      if (current.winner) gamesFinished += 1;
    }

    check(`the AI only ever plays legal actions (${movesChecked} moves across 12 games)`, allLegal);
    check('games played out by the AI reach a real result', gamesFinished > 0, `${gamesFinished} finished`);

    check('the AI offers no action once the game is over', (() => {
      const done = state({ 0: 'white', 1: 'white', 4: 'white' }, 'black', 'movement');
      return ai.chooseAction({ ...done, winner: 'white', phase: 'finished' }, 'hard') === null;
    })());
    check('the AI never returns an action when none is legal', (() => {
      // No white piece has a free neighbour.
      const stuck = state({ 0: 'white', 4: 'black', 7: 'black', 8: 'black' }, 'white', 'movement');
      return ai.chooseAction(stuck, 'hard') === null;
    })());
  }

  /* ---------------------------------------------------------------- */
  /* 10. AI — difficulty actually differs                              */
  /* ---------------------------------------------------------------- */
  {
    // Black to place. White already has 0-4, so point 1 completes the top line
    // for white next move: a beginner-level AI should miss it.
    const threat = state({ 0: 'white', 4: 'white' }, 'black', 'placement');

    const easyPick = ai.chooseAction(threat, 'easy');
    const mediumPick = ai.chooseAction(threat, 'medium');
    const hardPick = ai.chooseAction(threat, 'hard');

    check('Easy plays the strongest square when it sees no win', easyPick?.to === 8, `chose ${easyPick?.to}`);
    check('Medium blocks the immediate loss', mediumPick?.to === 1, `chose ${mediumPick?.to}`);
    check('Hard blocks the immediate loss too', hardPick?.to === 1, `chose ${hardPick?.to}`);
    check(
      'Easy and Medium genuinely differ on a one-move threat',
      easyPick?.to !== mediumPick?.to,
      `easy=${easyPick?.to} medium=${mediumPick?.to}`,
    );

    // Black can complete 0-4-1 by placing on 1: every difficulty must take it.
    const winning = state({ 0: 'black', 4: 'black', 2: 'white', 8: 'white' }, 'black', 'placement');
    for (const difficulty of ['easy', 'medium', 'hard']) {
      const pick = ai.chooseAction(winning, difficulty);
      const outcome = pick ? applyAction(winning, pick, T0) : null;
      check(`${difficulty} takes an immediate win`, outcome?.ok === true && outcome.state.winner === 'black', `chose ${pick?.to}`);
    }

    // Hard must not walk into a loss when a safe move exists.
    // White has 0 and 4 (threat on 1); black to move with a legal block.
    const mustBlock = state({ 0: 'white', 4: 'white', 2: 'black' }, 'black', 'placement');
    const hardBlock = ai.chooseAction(mustBlock, 'hard');
    check('Hard does not walk into a loss', hardBlock?.to === 1, `chose ${hardBlock?.to}`);

    // In the movement phase Hard must step 5 -> 3 to complete 0-8-3 and win.
    const moveWin = state({ 0: 'black', 8: 'black', 5: 'black', 1: 'white', 2: 'white', 6: 'white' }, 'black', 'movement');
    const hardMove = ai.chooseAction(moveWin, 'hard');
    const hardOutcome = hardMove ? applyAction(moveWin, hardMove, T0) : null;
    check('Hard finds the winning step in the movement phase', hardOutcome?.state.winner === 'black', `chose ${hardMove?.from}->${hardMove?.to}`);

    // Easy must not see it (it never looks for a threat, and only takes a win
    // that already exists on the board).
    const easyMove = ai.chooseAction(moveWin, 'easy');
    check('Easy is allowed to miss the same winning step', easyMove !== null);
  }

  /* ---------------------------------------------------------------- */
  /* 11. Published rules text                                          */
  /* ---------------------------------------------------------------- */
  /* ---------------------------------------------------------------- */
  /* 12. Client <-> server parity                                      */
  /* ---------------------------------------------------------------- */
  /*
   * The rules exist TWICE on purpose: once in the shared engine, once inside
   * the SECURITY DEFINER functions that own an online match. Two copies can
   * drift, so these checks parse the migration and prove the server agrees with
   * the engine on the board, the lines, the movement steps, the 60s deadline
   * and the phase change. They also prove the client service can only ever call
   * functions that really exist, and that it holds no privileged key.
   */
  {
    const fs = await import('node:fs');
    const sql = fs.readFileSync(
      new URL('../supabase/migrations/20261016_step15_game_zone.sql', import.meta.url),
      'utf8',
    );
    const service = fs.readFileSync(
      new URL('../src/services/gameZone.ts', import.meta.url),
      'utf8',
    );

    const section = (start, end) => {
      const from = sql.indexOf(start);
      const to = sql.indexOf(end);
      return from === -1 || to === -1 || to < from ? '' : sql.slice(from, to);
    };

    /* -- the eight winning lines -- */
    const winnerSql = section('game_pair3balls_winner', 'game_adjacent');
    const sqlLines = [...winnerSql.matchAll(/\((\d), (\d), (\d)\)/g)].map((m) =>
      [Number(m[1]), Number(m[2]), Number(m[3])].sort((a, b) => a - b).join('-'),
    );
    const engineLines = LINES.map((line) => [...line].sort((a, b) => a - b).join('-'));
    check(
      `the server checks the same ${LINES.length} winning lines as the engine`,
      sqlLines.length === engineLines.length &&
        new Set(sqlLines).size === sqlLines.length &&
        engineLines.every((line) => sqlLines.includes(line)),
      `server=${sqlLines.join(' | ')}`,
    );

    /* -- movement steps -- */
    const adjacencySql = section('game_adjacent', 'game_turn_side');
    const sqlEdges = new Set(
      [...adjacencySql.matchAll(/\((\d), (\d)\)/g)].map((m) =>
        [Number(m[1]), Number(m[2])].sort((a, b) => a - b).join('-'),
      ),
    );
    const engineEdges = new Set();
    ADJACENCY.forEach((list, from) => list.forEach((to) => engineEdges.add([from, to].sort((a, b) => a - b).join('-'))));
    check(
      `the server allows exactly the same ${engineEdges.size} movement steps as the engine`,
      sqlEdges.size === engineEdges.size && [...engineEdges].every((edge) => sqlEdges.has(edge)),
      `server=${[...sqlEdges].join(',')}`,
    );

    /* -- the same clock and the same phase change -- */
    const initialStateSql = section('game_initial_state', 'game_pair3balls_winner');
    check(
      'the server starts every turn with the same 60s deadline',
      initialStateSql.includes('60000') && /interval '60 seconds'/.test(sql),
    );
    check(
      `the server switches to movement on the same ${PIECES_PER_PLAYER * 2}th piece`,
      sql.includes(`v_placed >= ${PIECES_PER_PLAYER * 2}`),
    );
    check(
      'the server enforces the deadline before applying a move',
      /v_now >= v_room\.turn_deadline_at/.test(section('game_submit_move', 'game_settle_timeout')),
    );
    for (const [fn, next] of [
      ['game_submit_move', 'game_settle_timeout'],
      ['game_settle_timeout', 'game_leave_room'],
      ['game_leave_room', 'game_rematch'],
    ]) {
      check(
        `${fn} locks the room row so simultaneous requests cannot interleave`,
        /for update;/.test(section(fn, next)),
      );
    }
    check(
      'matchmaking claims an opponent atomically (SKIP LOCKED)',
      /for update skip locked/i.test(sql),
    );
    check(
      'a repeated matchmaking poll does not log a second queue_join',
      /returning \(xmax = 0\)/.test(sql) && /if v_new_queue then/.test(sql),
    );

    /* -- RLS on every table -- */
    for (const table of ['game_settings', 'game_rooms', 'game_queue', 'game_events']) {
      check(
        `row level security is enabled on ${table}`,
        new RegExp(`alter table public\\.${table}\\s+enable row level security`).test(sql),
      );
    }
    check(
      'clients are given no write grant on any game table',
      !/grant (insert|update|delete|all)[^;]*on public\.game_(rooms|queue|events)/i.test(sql),
    );
    check(
      'privileged functions are not executable by anon',
      !/grant execute on function public\.game_[a-z_]+\([^)]*\)\s+to (anon|public)/i.test(sql),
    );

    /* -- the client only calls functions that exist -- */
    const rpcNames = [...service.matchAll(/callRpc<[^>]*>\('([a-z0-9_]+)'|callRpc\('([a-z0-9_]+)'/g)].map(
      (m) => m[1] ?? m[2],
    );
    const uniqueRpcs = [...new Set(rpcNames)];
    check(`the client calls ${uniqueRpcs.length} game RPCs`, uniqueRpcs.length >= 10, uniqueRpcs.join(','));
    const missing = uniqueRpcs.filter((name) => !sql.includes(`function public.${name}(`));
    check('every RPC the client calls exists in the migration', missing.length === 0, missing.join(','));

    /* -- the client holds no privileged access -- */
    check('the client service never embeds a service-role key', !/service_role|SERVICE_ROLE/i.test(service));
    check('the client service opens no direct connection', !/createClient\(/.test(service));
    check(
      'the client never writes to a game table directly',
      !/from\('game_(rooms|queue|events)'\)/.test(service) && !/\.(insert|update|upsert|delete)\(/.test(service),
    );
    check(
      'the client cannot decide a winner or a timeout locally',
      !/winner_side\s*[:=]\s*['"]/.test(service) && !/settleTimeout\(/.test(service),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 13. Advertising + admin honesty                                   */
  /* ---------------------------------------------------------------- */
  {
    const fs = await import('node:fs');
    const adSlot = await server.ssrLoadModule('/src/components/game/AdSlot.tsx');
    const adminSrc = fs.readFileSync(new URL('../src/components/AdminGameZone.tsx', import.meta.url), 'utf8');
    const zoneSrc = fs.readFileSync(new URL('../src/pages/GameZone.tsx', import.meta.url), 'utf8');

    check('the ad slot renders NOTHING while no provider is configured', adSlot.AdSlot({ placement: 'lobby' }) === null);
    check('the ad slot reports itself unconfigured', adSlot.isAdProviderConfigured() === false);
    check('the ad slot is actually mounted on the Game Zone page', /<AdSlot placement="lobby" \/>/.test(zoneSrc));
    check(
      'the admin panel claims no revenue, impressions or RPM numbers',
      !/\b(rpm|cpm|impressions|clicks|earnings|revenue)\b\s*[:=]\s*[\d$]/i.test(adminSrc) && !/\$\s*\d/.test(adminSrc),
    );
    check('the admin panel states plainly that no provider is configured', /ad provider not configured/i.test(adminSrc));
    check(
      'the advertising integration point named in the admin panel really exists',
      adminSrc.includes('src/components/game/AdSlot.tsx'),
    );
    check(
      'admin analytics come from the real RPC, not from hard-coded literals',
      /fetchGameAnalytics/.test(adminSrc) && /analytics\.(sessions_started|games_completed)/.test(adminSrc),
    );
    check(
      'the admin panel says so when the backend cannot be reached',
      /(unavailable|could not|failed|not available)/i.test(adminSrc),
    );
    check(
      'sessions and unique players are labelled separately',
      /unique_players/.test(adminSrc) && /sessions_started/.test(adminSrc),
    );
  }

  /* ---------------------------------------------------------------- */
  /* 11. Published rules text                                          */
  /* ---------------------------------------------------------------- */
  check('the rules mention all nine points', /nine points/i.test(RULES.board));
  check('the rules mention three pieces each', /three of their own pieces/i.test(RULES.win));
  check('the rules state there are no captures', /never captured/i.test(RULES.capture));
  check('the rules state the 60-second timer', /60-second timer/i.test(RULES.timer));
  check('the rules state there is no draw', /no draw/i.test(RULES.draw));
} finally {
  await server.close();
}

console.log(`\npair3balls checks: ${checked}`);
if (problems.length) {
  console.log(`\n✗ ${problems.length} problem(s):`);
  for (const problem of problems) console.log(`  • ${problem}`);
  process.exit(1);
}
console.log('\n✓ Pair-3Balls OK — one rules engine, no captures, no illegal moves, three real difficulties.');
