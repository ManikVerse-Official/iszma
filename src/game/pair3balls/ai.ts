/**
 * Pair-3Balls computer opponent.
 *
 * Difficulty comes from how much the opponent LOOKS AHEAD, never from adding
 * noise to a good move:
 *
 *   easy   — looks 1 ply with a POSITIONAL-ONLY score. Takes a win it can see
 *            right now, otherwise plays the most valuable square. It ignores
 *            your threats completely, which is a real, explainable weakness a
 *            beginner can beat (it is not a Medium that bluffs).
 *   medium — looks 2 plies. Takes a win, blocks your immediate win, and creates
 *            its own threats.
 *   hard   — full alpha-beta search (5 plies, node-capped) with a positional and
 *            threat evaluation, so it prefers a win now, refuses moves that let
 *            you win next, and avoids self-inflicted mistakes.
 *
 * Every difficulty picks from `legalActions(state)`, the same generator the UI
 * and the server use. The AI therefore cannot place on an occupied point, move
 * an opponent's piece, move to an occupied point, act out of turn, or move after
 * the game has ended — those are unreachable by construction.
 *
 * The search freezes the clock (`frozenNow`) so the 60-second turn timer never
 * fires mid-search; the UI owns the real timer.
 */

import {
  ADJACENCY,
  LINES,
  type GameState,
  type MoveKind,
  type Player,
  type Point,
  applyAction,
  legalActions,
  other,
} from './engine';

export type Difficulty = 'easy' | 'medium' | 'hard';

export const DIFFICULTIES: ReadonlyArray<{
  id: Difficulty;
  label: string;
  blurb: string;
  depth: number;
}> = [
  {
    id: 'easy',
    label: 'Easy',
    blurb: 'Looks one move ahead and misses your threats. Good for a first game.',
    depth: 1,
  },
  {
    id: 'medium',
    label: 'Medium',
    blurb: 'Takes wins, blocks your immediate win, and builds its own threats.',
    depth: 2,
  },
  {
    id: 'hard',
    label: 'Hard',
    blurb: 'Searches several moves ahead and will punish a loose move.',
    depth: 5,
  },
];

export interface AiAction {
  kind: MoveKind;
  from?: Point;
  to: Point;
}

/** Node budget so the hard search stays responsive on a phone. */
const NODE_BUDGET = 120_000;

const WIN_SCORE = 1_000_000;

/** Opening value of a square: the centre is strongest, corners next. */
const SQUARE_VALUE: ReadonlyArray<number> = [
  4, 4, 4, 4, // corners 0-3
  3, 3, 3, 3, // side midpoints 4-7
  5,          // centre 8
];

/**
 * Positional-only evaluation: finished result plus the value of the squares
 * each side holds. It deliberately knows NOTHING about threats, which is what
 * makes the Easy opponent a genuine beginner rather than a Medium that bluffs.
 */
export const evaluatePositional = (state: GameState, me: Player): number => {
  if (state.winner) return state.winner === me ? WIN_SCORE : -WIN_SCORE;

  const them = other(me);
  let score = 0;
  for (let point = 0; point < state.board.length; point += 1) {
    const cell = state.board[point];
    if (cell === me) score += SQUARE_VALUE[point];
    else if (cell === them) score -= SQUARE_VALUE[point];
  }
  return score;
};

/**
 * Full evaluation from `me`'s point of view: positional value, one-move line
 * threats and mobility. Positive is good for `me`.
 */
export const evaluate = (state: GameState, me: Player): number => {
  if (state.winner) {
    if (state.winner === me) return WIN_SCORE;
    return -WIN_SCORE;
  }

  const them = other(me);
  let score = 0;

  // Material position.
  for (let point = 0; point < state.board.length; point += 1) {
    const cell = state.board[point];
    if (cell === me) score += SQUARE_VALUE[point];
    else if (cell === them) score -= SQUARE_VALUE[point];
  }

  // Line pressure: two pieces plus an empty third is a one-move threat.
  for (const [a, b, c] of LINES) {
    const cells = [state.board[a], state.board[b], state.board[c]];
    const mine = cells.filter((cell) => cell === me).length;
    const theirs = cells.filter((cell) => cell === them).length;
    const empty = cells.filter((cell) => cell === null).length;
    if (empty === 0) continue;

    if (mine === 2 && theirs === 0) score += 12;
    if (theirs === 2 && mine === 0) score -= 12;
    if (mine === 2 && empty === 1) score += 6;
    if (theirs === 2 && empty === 1) score -= 6;
  }

  // Having a legal move at all matters once movement starts.
  if (state.phase === 'movement') {
    score += (isMovable(state, me) ? 2 : 0) - (isMovable(state, them) ? 2 : 0);
  }

  return score;
};

/** True when `player` has at least one legal step (used for mobility scoring). */
const isMovable = (state: GameState, player: Player): boolean => {
  for (let from = 0; from < state.board.length; from += 1) {
    if (state.board[from] !== player) continue;
    for (const to of ADJACENCY[from]) if (state.board[to] === null) return true;
  }
  return false;
};

interface SearchContext {
  me: Player;
  frozenNow: number;
  nodes: number;
  aborted: boolean;
}

/**
 * Alpha-beta minimax. Returns the score of `state` for `ctx.me`.
 * `depth` counts plies still to look ahead.
 */
const search = (state: GameState, depth: number, alpha: number, beta: number, ctx: SearchContext): number => {
  ctx.nodes += 1;
  if (ctx.nodes > NODE_BUDGET) {
    ctx.aborted = true;
    return evaluate(state, ctx.me);
  }

  if (state.winner || state.phase === 'finished') {
    // Prefer winning sooner and losing later.
    const sign = state.winner === ctx.me ? 1 : -1;
    return sign * (WIN_SCORE + depth);
  }
  if (depth <= 0) return evaluate(state, ctx.me);

  const actions = legalActions(state);
  if (actions.length === 0) return evaluate(state, ctx.me);

  const maximising = state.turn === ctx.me;
  let best = maximising ? -Infinity : Infinity;

  for (const action of actions) {
    const outcome = applyAction(state, action, ctx.frozenNow);
    if (!outcome.ok) continue;
    const value = search(outcome.state, depth - 1, alpha, beta, ctx);

    if (maximising) {
      if (value > best) best = value;
      if (best > alpha) alpha = best;
    } else {
      if (value < best) best = value;
      if (best < beta) beta = best;
    }
    if (beta <= alpha) break; // prune
  }

  return best;
};

/**
 * Picks the computer's next action.
 *
 * `rng` is used ONLY to break exact ties between equally good moves; it never
 * makes a weaker move look better, so difficulty is not a random handicap.
 * Returns null when the game is over or no legal action exists.
 */
export const chooseAction = (
  state: GameState,
  difficulty: Difficulty,
  rng: () => number = () => 0,
): AiAction | null => {
  if (state.winner || state.phase === 'finished') return null;

  const actions = legalActions(state);
  if (actions.length === 0) return null;

  const config = DIFFICULTIES.find((entry) => entry.id === difficulty) ?? DIFFICULTIES[0];

  // Easy takes a win it can see and otherwise just plays the best square — it
  // never looks for the opponent's threats, so a beginner can genuinely beat it.
  if (config.depth <= 1) {
    const scored = actions.map((action) => {
      const outcome = applyAction(state, action, state.turnDeadlineAt - 1);
      return { action, value: outcome.ok ? evaluatePositional(outcome.state, state.turn) : -Infinity };
    });
    return pickBest(scored, rng);
  }

  const depth = config.depth;
  const ctx: SearchContext = {
    me: state.turn,
    frozenNow: state.turnDeadlineAt - 1,
    nodes: 0,
    aborted: false,
  };

  const scored: Array<{ action: AiAction; value: number }> = [];
  let alpha = -Infinity;
  const beta = Infinity;

  for (const action of actions) {
    const outcome = applyAction(state, action, ctx.frozenNow);
    if (!outcome.ok) continue;
    const value = search(outcome.state, depth - 1, alpha, beta, ctx);
    scored.push({ action, value });
    if (value > alpha) alpha = value;
  }

  if (scored.length === 0) return null;
  return pickBest(scored, rng);
};

/** Highest value wins; exact ties are broken with `rng` (deterministic by default). */
const pickBest = (
  scored: Array<{ action: AiAction; value: number }>,
  rng: () => number,
): AiAction => {
  let best = -Infinity;
  let bestSet: AiAction[] = [];
  for (const entry of scored) {
    if (entry.value > best) {
      best = entry.value;
      bestSet = [entry.action];
    } else if (entry.value === best) {
      bestSet.push(entry.action);
    }
  }
  if (bestSet.length === 1) return bestSet[0];
  const index = Math.floor(rng() * bestSet.length);
  return bestSet[Math.min(bestSet.length - 1, Math.max(0, index))];
};

/**
 * Human-readable action label, e.g. "place on the centre" or "d5 → centre".
 * Used by the UI's move log.
 */
export const describeAction = (
  action: AiAction,
  pointName: (point: Point) => string = (point) => `point ${point}`,
): string =>
  action.kind === 'place'
    ? `place on ${pointName(action.to)}`
    : `${pointName(action.from as Point)} → ${pointName(action.to)}`;
