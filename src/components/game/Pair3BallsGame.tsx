import { useCallback, useEffect, useMemo, useState } from 'react';
import { RotateCcw, Timer, Trophy, Users, Bot, ArrowLeft } from 'lucide-react';
import {
  TURN_MS,
  createGame,
  legalMoves,
  legalPlacements,
  other,
  remainingMs,
  settleTimeout,
  winningLines,
  isDraw,
  type GameState,
  type Player,
  type Point,
  applyMove,
  applyPlace,
  applyAction,
  RULES,
} from '../../game/pair3balls/engine';
import { chooseAction, DIFFICULTIES, type Difficulty } from '../../game/pair3balls/ai';
import { Pair3BallsBoard, pointName } from './Pair3BallsBoard';

/**
 * Local Pair-3Balls: two humans sharing one device, or one human against the
 * computer. Every rule decision comes from the engine; this component only
 * routes clicks, runs the clock and renders.
 */

interface Pair3BallsGameProps {
  mode: 'local' | 'computer';
  difficulty?: Difficulty;
  onExit?: () => void;
}

const playableSide = (game: GameState, player: Player | null): boolean =>
  player === null || game.turn === player;

export const Pair3BallsGame: React.FC<Pair3BallsGameProps> = ({
  mode,
  difficulty = 'medium',
  onExit,
}) => {
  const [game, setGame] = useState<GameState>(() => createGame(Date.now()));
  const [selected, setSelected] = useState<Point | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [thinking, setThinking] = useState(false);

  const humanSide: Player = 'white';
  const aiSide: Player = other(humanSide);
  const vsComputer = mode === 'computer';

  const restart = useCallback(() => {
    setGame(createGame(Date.now()));
    setSelected(null);
    setThinking(false);
  }, []);

  /* ---- clock ---------------------------------------------------- */
  useEffect(() => {
    if (game.winner) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [game.winner, game.turn]);

  useEffect(() => {
    if (game.winner) return;
    if (now < game.turnDeadlineAt) return;
    // Exactly one resolution: settleTimeout is idempotent and the effect stops
    // as soon as the game has a winner.
    setGame((current) => settleTimeout(current, Date.now()));
  }, [now, game.winner, game.turnDeadlineAt]);

  /* ---- computer opponent ---------------------------------------- */
  useEffect(() => {
    if (!vsComputer || game.winner) return;
    if (game.turn !== aiSide) {
      setThinking(false);
      return;
    }
    setThinking(true);
    const id = window.setTimeout(() => {
      setGame((current) => {
        if (current.winner || current.turn !== aiSide) return current;
        const action = chooseAction(current, difficulty);
        if (!action) return current;
        const outcome = applyAction(current, action, Date.now());
        return outcome.ok ? outcome.state : current;
      });
      setThinking(false);
    }, 550);
    return () => window.clearTimeout(id);
  }, [vsComputer, game.turn, game.moveCount, game.winner, aiSide, difficulty]);

  /* ---- interaction ---------------------------------------------- */
  const canPlay =
    game.phase !== 'finished' && !game.winner && playableSide(game, vsComputer ? humanSide : null);

  const movableSources = useMemo(() => {
    if (game.phase !== 'movement' || !canPlay) return [] as Point[];
    const sources = new Set<Point>();
    for (const move of legalMoves(game)) sources.add(move.from);
    return Array.from(sources).sort((a, b) => a - b);
  }, [game, canPlay]);

  const destinations = useMemo(() => {
    if (selected === null || game.phase !== 'movement' || !canPlay) return [] as Point[];
    return legalMoves(game)
      .filter((move) => move.from === selected)
      .map((move) => move.to);
  }, [game, selected, canPlay]);

  const selectablePoints = useMemo(() => {
    if (!canPlay) return [] as Point[];
    if (game.phase === 'placement') return legalPlacements(game);
    return selected === null ? movableSources : [...destinations, selected];
  }, [canPlay, game, selected, movableSources, destinations]);

  const handlePointClick = (point: Point) => {
    if (!canPlay) return;
    setNow(Date.now());

    if (game.phase === 'placement') {
      const outcome = applyPlace(game, point, Date.now());
      if (outcome.ok) setGame(outcome.state);
      return;
    }

    if (game.phase !== 'movement') return;

    if (selected === null) {
      if (game.board[point] === game.turn) setSelected(point);
      return;
    }

    if (point === selected) {
      setSelected(null);
      return;
    }

    if (game.board[point] === game.turn) {
      setSelected(point); // pick a different piece
      return;
    }

    const outcome = applyMove(game, selected, point, Date.now());
    if (outcome.ok) {
      setGame(outcome.state);
      setSelected(null);
    }
  };

  /* ---- presentation --------------------------------------------- */
  const line = useMemo(() => {
    const found = winningLines(game.board);
    return found.length > 0 ? found[0].line : null;
  }, [game.board]);

  const remaining = game.winner ? 0 : remainingMs(game, now);
  const percent = Math.max(0, Math.min(100, (remaining / TURN_MS) * 100));
  const urgent = !game.winner && remaining <= 10_000;

  const sideLabel = (player: Player): string => {
    if (!vsComputer) return player === 'white' ? 'Player 1 (white)' : 'Player 2 (black)';
    return player === humanSide ? 'You (white)' : 'Computer (black)';
  };

  const status = (() => {
    if (isDraw(game)) return 'Draw — the same move was repeated more than three times.';
    if (game.winner) {
      const winner = sideLabel(game.winner);
      return game.reason === 'timeout'
        ? `${winner} wins — the other player ran out of time.`
        : `${winner} wins with three in a row.`;
    }
    if (thinking) return 'Computer is thinking…';
    if (game.phase === 'placement') {
      return `${sideLabel(game.turn)}: place a piece on any empty point.`;
    }
    if (selected === null) {
      return `${sideLabel(game.turn)}: tap one of your pieces to move it.`;
    }
    return `${sideLabel(game.turn)}: tap a highlighted point to step there.`;
  })();

  const recent = game.history.slice(-6).reverse();

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-300">
          {vsComputer ? <Bot className="w-4 h-4 text-neon-purple" /> : <Users className="w-4 h-4 text-neon-purple" />}
          <span>
            {vsComputer
              ? `vs Computer · ${DIFFICULTIES.find((d) => d.id === difficulty)?.label ?? 'Medium'}`
              : 'Two players, one device'}
          </span>
          <span className="text-gray-500">
            {game.phase === 'placement' ? '· placing' : game.phase === 'movement' ? '· moving' : '· finished'}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={restart}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-neon-purple/15 border border-neon-purple/40 text-sm text-white hover:bg-neon-purple/25 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            New game
          </button>
          {onExit && (
            <button
              type="button"
              onClick={onExit}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-white/15 text-sm text-gray-300 hover:text-white hover:border-white/30 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Modes
            </button>
          )}
        </div>
      </div>

      {/* Turn + timer */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className={`w-4 h-4 rounded-full ${game.turn === 'white' ? 'bg-white' : 'bg-[#1a0b2e] border-2 border-gray-300'}`}
          />
          <span className="text-sm font-semibold text-white">
            {game.winner ? 'Game over' : `${game.turn === 'white' ? 'White' : 'Black'} to play`}
          </span>
        </div>

        <div className="flex-1 min-w-[10rem] flex items-center gap-2">
          <Timer className={`w-4 h-4 ${urgent ? 'text-red-400' : 'text-neon-purple'}`} />
          <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full transition-[width] duration-200 ${urgent ? 'bg-red-500' : 'bg-neon-purple'}`}
              style={{ width: `${percent}%` }}
            />
          </div>
          <span className={`text-xs tabular-nums ${urgent ? 'text-red-400' : 'text-gray-400'}`}>
            {Math.ceil(remaining / 1000)}s
          </span>
        </div>
      </div>

      {/* Status */}
      <p
        role="status"
        aria-live="polite"
        className={`text-sm ${game.winner ? 'text-emerald-300 font-semibold' : 'text-gray-300'}`}
      >
        {status}
      </p>

      {/* Board */}
      <Pair3BallsBoard
        board={game.board}
        selectablePoints={selectablePoints}
        selected={selected}
        winningLine={line}
        lastMove={game.lastMove}
        onPointClick={handlePointClick}
        myPlayer={vsComputer ? humanSide : null}
        disabled={!canPlay}
      />

      {/* Result */}
      {game.winner && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-400/40 bg-emerald-400/10 p-4">
          <div className="flex items-center gap-2 text-emerald-200">
            <Trophy className="w-5 h-5" />
            <span className="font-semibold">{sideLabel(game.winner)} wins</span>
            <span className="text-sm text-emerald-200/80">
              {game.reason === 'timeout' ? '(opponent timed out)' : '(three in a row)'}
            </span>
          </div>
          <button
            type="button"
            onClick={restart}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-400 text-[#0b0514] font-semibold text-sm hover:bg-emerald-300 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Rematch
          </button>
        </div>
      )}

      {/* Repetition draw */}
      {isDraw(game) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4">
          <div className="flex items-center gap-2 text-amber-200">
            <Users className="w-5 h-5" />
            <span className="font-semibold">Draw</span>
            <span className="text-sm text-amber-200/80">
              (same move repeated more than three times)
            </span>
          </div>
          <button
            type="button"
            onClick={restart}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-300 text-[#0b0514] font-semibold text-sm hover:bg-amber-200 transition-colors"
          >
            <RotateCcw className="w-4 h-4" />
            Play again
          </button>
        </div>
      )}

      {/* Move log */}
      {recent.length > 0 && (
        <div className="rounded-2xl border border-white/10 p-4">
          <p className="text-xs uppercase tracking-wider text-gray-500 mb-2">Recent moves</p>
          <ul className="space-y-1 text-sm text-gray-400">
            {recent.map((move, index) => (
              <li key={`${move.at}-${index}`}>
                <span className={move.player === 'white' ? 'text-white' : 'text-neon-purple'}>
                  {move.player === 'white' ? 'White' : 'Black'}
                </span>{' '}
                {move.kind === 'place'
                  ? `placed on the ${pointName(move.to)}`
                  : `moved ${pointName(move.from as Point)} → ${pointName(move.to)}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Short rules reference */}
      <div className="rounded-2xl border border-white/10 p-4 space-y-1.5 text-sm text-gray-400">
        <p className="text-xs uppercase tracking-wider text-gray-500">Rules</p>
        <p>{RULES.placement}</p>
        <p>{RULES.movement}</p>
        <p>{RULES.win}</p>
        <p>{RULES.capture} {RULES.timer}</p>
        <p>{RULES.draw}</p>
      </div>
    </div>
  );
};
