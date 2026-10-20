/**
 * Pair-3Balls — authoritative rules engine.
 *
 * ONE engine is shared by every mode (local two-player, vs Computer, Private
 * Room, World Match) and by the tests, so the rules can never drift apart
 * between the UI and the server.
 *
 * Board (nine playable points):
 *
 *      0 ── 4 ── 1
 *      │ ╲  │  ╱ │
 *      7 ── 8 ── 5
 *      │ ╱  │  ╲ │
 *      2 ── 6 ── 3
 *
 * Eight valid lines (three points each) — three horizontal, three vertical and
 * two diagonal through the centre:
 *
 *   horizontal : 0-4-1   7-8-5   2-6-3
 *   vertical   : 0-7-2   4-8-6   1-5-3
 *   diagonal   : 0-8-3   1-8-2
 *
 * The engine is pure: every function takes the state plus `now` (epoch ms) and
 * returns a NEW state. Nothing reads the clock or randomness on its own, which
 * is what makes timeouts and replays deterministic and testable.
 *
 * Deliberately NOT here, because the official ruleset does not contain them:
 * captures, removing opponent pieces, extra pieces, draw conditions and
 * alternative win conditions.
 */

export type Player = 'white' | 'black';

/** Point index 0-8. */
export type Point = number;
export type Cell = Player | null;
export type Phase = 'placement' | 'movement' | 'finished';
export type WinReason = 'three-in-a-row' | 'timeout';

/** Seconds a player has to complete each turn before they forfeit. */
export const TURN_SECONDS = 60;
export const TURN_MS = TURN_SECONDS * 1000;

/** Pieces each player places during the placement phase. */
export const PIECES_PER_PLAYER = 3;

export const POINT_COUNT = 9;

/** Grid coordinates for drawing (col, row) in a 0-2 grid. */
export const POINT_GRID: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: 0 }, // 0 top-left corner
  { x: 2, y: 0 }, // 1 top-right corner
  { x: 0, y: 2 }, // 2 bottom-left corner
  { x: 2, y: 2 }, // 3 bottom-right corner
  { x: 1, y: 0 }, // 4 top mid
  { x: 2, y: 1 }, // 5 right mid
  { x: 1, y: 2 }, // 6 bottom mid
  { x: 0, y: 1 }, // 7 left mid
  { x: 1, y: 1 }, // 8 centre
];

/** The eight valid three-in-a-row lines. */
export const LINES: ReadonlyArray<readonly [Point, Point, Point]> = [
  [0, 4, 1],
  [7, 8, 5],
  [2, 6, 3],
  [0, 7, 2],
  [4, 8, 6],
  [1, 5, 3],
  [0, 8, 3],
  [1, 8, 2],
];

/**
 * Movement adjacency, derived from the drawn lines: a piece may step to any
 * point that shares a line with it. Corners reach their two side midpoints and
 * the centre; each side midpoint reaches its two corners and the centre; the
 * centre reaches all eight outer points.
 */
export const ADJACENCY: ReadonlyArray<readonly Point[]> = (() => {
  const table: Point[][] = Array.from({ length: POINT_COUNT }, () => []);
  for (const [a, b, c] of LINES) {
    // Endpoint <-> midpoint, and endpoint <-> endpoint only when the line is
    // straight through the middle point (never needed here, but kept general).
    table[a].push(b);
    table[b].push(a);
    table[b].push(c);
    table[c].push(b);
  }
  return table.map((list) => Array.from(new Set(list)).sort((m, n) => m - n));
})();

export const other = (player: Player): Player => (player === 'white' ? 'black' : 'white');

export type MoveKind = 'place' | 'move';

export interface Move {
  kind: MoveKind;
  player: Player;
  /** Placement point, or the destination point of a movement. */
  to: Point;
  /** Present only for `kind: 'move'`. */
  from?: Point;
  /** Server/client timestamp when the move was applied (epoch ms). */
  at: number;
}

export interface GameState {
  board: Cell[];
  turn: Player;
  phase: Phase;
  /** null while the game is still running. */
  winner: Player | null;
  reason: WinReason | null;
  /** When the current turn began (epoch ms). */
  turnStartedAt: number;
  /** Hard deadline for the current turn (epoch ms). */
  turnDeadlineAt: number;
  /** Game creation time (epoch ms). */
  startedAt: number;
  /** Game end time (epoch ms), or null. */
  endedAt: number | null;
  lastMove: Move | null;
  /** Number of applied moves; used for analytics and optimistic-lock checks. */
  moveCount: number;
  history: Move[];
}

export interface MoveOutcome {
  /** True only when the move was legal and applied. */
  ok: boolean;
  /** Machine-readable reason when `ok` is false. */
  code?:
    | 'finished'
    | 'wrong-phase'
    | 'out-of-turn'
    | 'occupied'
    | 'empty-source'
    | 'not-yours'
    | 'not-adjacent'
    | 'same-point'
    | 'expired'
    | 'bad-point';
  state: GameState;
  /** The move that was applied, when `ok`. */
  move?: Move;
}

/* ------------------------------------------------------------------ */
/* Creation / queries                                                  */
/* ------------------------------------------------------------------ */

export const emptyBoard = (): Cell[] => Array<Cell>(POINT_COUNT).fill(null);

/**
 * Starts a fresh game. `white` always places first; the caller decides who
 * owns white.
 */
export const createGame = (now: number, startingPlayer: Player = 'white'): GameState => ({
  board: emptyBoard(),
  turn: startingPlayer,
  phase: 'placement',
  winner: null,
  reason: null,
  turnStartedAt: now,
  turnDeadlineAt: now + TURN_MS,
  startedAt: now,
  endedAt: null,
  lastMove: null,
  moveCount: 0,
  history: [],
});

export const piecesOnBoard = (board: Cell[], player: Player): number =>
  board.reduce((total, cell) => (cell === player ? total + 1 : total), 0);

export const countPieces = (state: GameState): { white: number; black: number } => ({
  white: piecesOnBoard(state.board, 'white'),
  black: piecesOnBoard(state.board, 'black'),
});

/** Returns the owner of a completed line, or null. */
export const findWinner = (board: Cell[]): Player | null => {
  for (const [a, b, c] of LINES) {
    const value = board[a];
    if (value && value === board[b] && value === board[c]) return value;
  }
  return null;
};

/** Every line currently completed, with its owner (for highlighting). */
export const winningLines = (board: Cell[]): Array<{ line: readonly [Point, Point, Point]; player: Player }> => {
  const found: Array<{ line: readonly [Point, Point, Point]; player: Player }> = [];
  for (const line of LINES) {
    const value = board[line[0]];
    if (value && value === board[line[1]] && value === board[line[2]]) {
      found.push({ line, player: value });
    }
  }
  return found;
};

export const isEmptyPoint = (state: GameState, point: Point): boolean =>
  isPoint(point) && state.board[point] === null;

export const isPoint = (value: unknown): value is Point =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < POINT_COUNT;

/** Places still available during the placement phase. */
export const legalPlacements = (state: GameState): Point[] => {
  if (state.phase !== 'placement' || state.winner) return [];
  const points: Point[] = [];
  for (let i = 0; i < POINT_COUNT; i += 1) if (state.board[i] === null) points.push(i);
  return points;
};

export interface LegalMove {
  from: Point;
  to: Point;
}

/** Every legal movement for the player whose turn it is. */
export const legalMoves = (state: GameState): LegalMove[] => {
  if (state.phase !== 'movement' || state.winner) return [];
  const moves: LegalMove[] = [];
  for (let from = 0; from < POINT_COUNT; from += 1) {
    if (state.board[from] !== state.turn) continue;
    for (const to of ADJACENCY[from]) {
      if (state.board[to] === null) moves.push({ from, to });
    }
  }
  return moves;
};

/** Every legal action for the current player, whichever phase we are in. */
export const legalActions = (state: GameState): Array<{ kind: MoveKind; from?: Point; to: Point }> => {
  if (state.winner) return [];
  if (state.phase === 'placement') return legalPlacements(state).map((to) => ({ kind: 'place' as const, to }));
  if (state.phase === 'movement') return legalMoves(state).map((m) => ({ kind: 'move' as const, from: m.from, to: m.to }));
  return [];
};

export const remainingMs = (state: GameState, now: number): number => {
  if (state.winner || state.phase === 'finished') return 0;
  return Math.max(0, state.turnDeadlineAt - now);
};

export const isExpired = (state: GameState, now: number): boolean =>
  !state.winner && now >= state.turnDeadlineAt;

/* ------------------------------------------------------------------ */
/* Mutation                                                            */
/* ------------------------------------------------------------------ */

/** Marks the game finished and freezes the clock. */
const finish = (state: GameState, winner: Player | null, reason: WinReason, now: number): GameState => ({
  ...state,
  phase: 'finished',
  winner,
  reason,
  endedAt: now,
  turnDeadlineAt: now,
});

/** Advances the turn to the other player and restarts the 60s clock. */
const passTurn = (state: GameState, now: number): GameState => ({
  ...state,
  turn: other(state.turn),
  turnStartedAt: now,
  turnDeadlineAt: now + TURN_MS,
});

/**
 * Settles the turn clock. A player who lets their 60 seconds run out loses.
 * Safe to call repeatedly: a finished game is returned untouched, and calling
 * it again after the timeout resolves does not produce a second result.
 */
export const settleTimeout = (state: GameState, now: number): GameState => {
  if (state.winner || state.phase === 'finished') return state;
  if (!isExpired(state, now)) return state;
  return finish(state, other(state.turn), 'timeout', now);
};

/** Shared validation + post-move bookkeeping for both phases. */
const commit = (state: GameState, board: Cell[], move: Move): GameState => {
  const base: GameState = {
    ...state,
    board,
    lastMove: move,
    moveCount: state.moveCount + 1,
    history: [...state.history, move],
  };

  // A three-in-a-row ends the game immediately — in either phase.
  const winner = findWinner(board);
  if (winner) return finish(base, winner, 'three-in-a-row', move.at);

  const placed = moveCount(board);
  const nextPhase: Phase = placed >= PIECES_PER_PLAYER * 2 ? 'movement' : base.phase;
  return passTurn({ ...base, phase: nextPhase }, move.at);
};

const moveCount = (board: Cell[]): number =>
  board.reduce((total, cell) => (cell ? total + 1 : total), 0);

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */

export const applyPlace = (state: GameState, point: Point, now: number): MoveOutcome => {
  const settled = settleTimeout(state, now);
  if (settled.winner) return { ok: false, code: 'finished', state: settled };
  if (settled.phase !== 'placement') return { ok: false, code: 'wrong-phase', state: settled };
  if (!isPoint(point)) return { ok: false, code: 'bad-point', state: settled };
  if (settled.board[point] !== null) return { ok: false, code: 'occupied', state: settled };

  const board = [...settled.board];
  board[point] = settled.turn;
  const move: Move = { kind: 'place', player: settled.turn, to: point, at: now };
  return { ok: true, state: commit(settled, board, move), move };
};

/* ------------------------------------------------------------------ */
/* Movement                                                            */
/* ------------------------------------------------------------------ */

export const applyMove = (
  state: GameState,
  from: Point,
  to: Point,
  now: number,
): MoveOutcome => {
  const settled = settleTimeout(state, now);
  if (settled.winner) return { ok: false, code: 'finished', state: settled };
  if (settled.phase !== 'movement') return { ok: false, code: 'wrong-phase', state: settled };
  if (!isPoint(from) || !isPoint(to)) return { ok: false, code: 'bad-point', state: settled };
  if (from === to) return { ok: false, code: 'same-point', state: settled };
  if (settled.board[from] === null) return { ok: false, code: 'empty-source', state: settled };
  if (settled.board[from] !== settled.turn) return { ok: false, code: 'not-yours', state: settled };
  if (settled.board[to] !== null) return { ok: false, code: 'occupied', state: settled };
  if (!ADJACENCY[from].includes(to)) return { ok: false, code: 'not-adjacent', state: settled };

  const board = [...settled.board];
  board[to] = board[from];
  board[from] = null;
  const move: Move = { kind: 'move', player: settled.turn, from, to, at: now };
  return { ok: true, state: commit(settled, board, move), move };
};

/** Applies a move whose kind the caller already knows. */
export const applyAction = (
  state: GameState,
  action: { kind: MoveKind; from?: Point; to: Point },
  now: number,
): MoveOutcome =>
  action.kind === 'place'
    ? applyPlace(state, action.to, now)
    : applyMove(state, action.from as Point, action.to, now);

/* ------------------------------------------------------------------ */
/* Serialisation (used by the backend and by reconnection)             */
/* ------------------------------------------------------------------ */

export interface SerializedState {
  board: Array<Player | null>;
  turn: Player;
  phase: Phase;
  winner: Player | null;
  reason: WinReason | null;
  turnStartedAt: number;
  turnDeadlineAt: number;
  startedAt: number;
  endedAt: number | null;
  lastMove: Move | null;
  moveCount: number;
}

export const serialize = (state: GameState): SerializedState => ({
  board: [...state.board],
  turn: state.turn,
  phase: state.phase,
  winner: state.winner,
  reason: state.reason,
  turnStartedAt: state.turnStartedAt,
  turnDeadlineAt: state.turnDeadlineAt,
  startedAt: state.startedAt,
  endedAt: state.endedAt,
  lastMove: state.lastMove,
  moveCount: state.moveCount,
});

/**
 * Rebuilds a state from stored/serialised data. Invalid input yields a fresh
 * game rather than a half-broken state, and the history is dropped (it is
 * cosmetic; the board and clocks are what matter).
 */
export const deserialize = (raw: unknown, now: number): GameState => {
  if (!raw || typeof raw !== 'object') return createGame(now);
  const data = raw as Partial<SerializedState>;

  const board = Array.isArray(data.board) && data.board.length === POINT_COUNT
    ? data.board.map((cell) => (cell === 'white' || cell === 'black' ? cell : null))
    : emptyBoard();

  const turn: Player = data.turn === 'black' ? 'black' : 'white';
  const phase: Phase =
    data.phase === 'placement' || data.phase === 'movement' || data.phase === 'finished'
      ? data.phase
      : 'placement';
  const winner = data.winner === 'white' || data.winner === 'black' ? data.winner : null;
  const reason = data.reason === 'three-in-a-row' || data.reason === 'timeout' ? data.reason : null;

  const numberOr = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  return {
    board,
    turn,
    phase,
    winner,
    reason,
    turnStartedAt: numberOr(data.turnStartedAt, now),
    turnDeadlineAt: numberOr(data.turnDeadlineAt, now + TURN_MS),
    startedAt: numberOr(data.startedAt, now),
    endedAt: typeof data.endedAt === 'number' ? data.endedAt : null,
    lastMove: (data.lastMove as Move | null) ?? null,
    moveCount: Math.max(0, Math.floor(numberOr(data.moveCount, 0))),
    history: [],
  };
};

/** Full rule text, reused by the Game Zone UI and by Joy's knowledge base. */
export const RULES = {
  board:
    'The board has nine points: four corners, four side midpoints and one centre, joined by straight lines.',
  placement:
    'White and Black take turns placing their three pieces on empty points. White starts.',
  movement:
    'Once all six pieces are placed, players take turns stepping one of their own pieces to an empty point joined to it by a line.',
  capture: 'Pieces are never captured or removed.',
  win: 'The first player to line up three of their own pieces on one of the drawn lines wins.',
  timer: `Each turn has a ${TURN_SECONDS}-second timer. Running out of time loses the game.`,
  draw: 'There is no draw in the official ruleset: a game ends only by three-in-a-row or by a timeout.',
} as const;
