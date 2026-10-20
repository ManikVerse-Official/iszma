import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Trophy, Frown, LogOut, RotateCcw, Timer, AlertCircle, Clock } from 'lucide-react';
import {
  TURN_MS,
  legalMoves,
  legalPlacements,
  remainingMs,
  type Point,
} from '../../game/pair3balls/engine';
import {
  getRoom,
  isMyTurn,
  leaveRoom,
  rematchRoom,
  roomToEngineState,
  settleRoomTimeout,
  subscribeToRoom,
  submitMove,
  type GameRoomView,
} from '../../services/gameZone';
import { Pair3BallsBoard } from './Pair3BallsBoard';

/**
 * A live online match.
 *
 * The board is rendered from the SERVER's state and every tap is sent to
 * `game_submit_move`, which re-checks membership, turn order, phase, occupancy,
 * adjacency and the deadline before writing anything. The client never decides
 * a winner, never advances its own turn and never settles a timeout by itself —
 * it asks the server (`game_settle_timeout`) and shows whatever comes back.
 *
 * If Realtime is unavailable the screen still works: it falls back to polling.
 */

interface OnlineMatchProps {
  roomId: string;
  onLeave: () => void;
}

export const OnlineMatch: React.FC<OnlineMatchProps> = ({ roomId, onLeave }) => {
  const [room, setRoom] = useState<GameRoomView | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Point | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const settling = useRef(false);

  /* ---- load + keep in sync ---------------------------------------- */
  const refresh = useCallback(async () => {
    const result = await getRoom(roomId);
    if (result.ok) {
      setRoom(result.data.room);
      setError('');
    } else {
      setError(result.error);
    }
  }, [roomId]);

  useEffect(() => {
    void refresh();
    const unsubscribe = subscribeToRoom(roomId, (updated) => setRoom(updated));
    const id = window.setInterval(() => void refresh(), 4000);
    return () => {
      unsubscribe();
      window.clearInterval(id);
    };
  }, [roomId, refresh]);

  /* ---- clock ------------------------------------------------------- */
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);

  const state = useMemo(() => (room ? roomToEngineState(room, now) : null), [room, now]);

  /* ---- server-settled timeout -------------------------------------- */
  useEffect(() => {
    if (!room || !state) return;
    if (room.status !== 'active' || state.winner) return;
    if (now < state.turnDeadlineAt) return;
    if (settling.current) return;

    settling.current = true;
    void settleRoomTimeout(roomId).then((result) => {
      if (result.ok) setRoom(result.data.room);
      window.setTimeout(() => {
        settling.current = false;
      }, 2000);
    });
  }, [room, state, now, roomId]);

  /* ---- interaction -------------------------------------------------- */
  const mySide = room?.your_side ?? null;
  const active = room?.status === 'active' && !state?.winner;
  const myTurn = Boolean(room && isMyTurn(room) && active);

  const selectablePoints = useMemo(() => {
    if (!state || !myTurn) return [] as Point[];
    if (state.phase === 'placement') return legalPlacements(state);
    if (state.phase !== 'movement') return [] as Point[];
    if (selected === null) {
      const sources = new Set<Point>();
      for (const move of legalMoves(state)) sources.add(move.from);
      return Array.from(sources).sort((a, b) => a - b);
    }
    return [
      ...legalMoves(state).filter((move) => move.from === selected).map((move) => move.to),
      selected,
    ];
  }, [state, myTurn, selected]);

  const send = useCallback(
    async (action: { kind: 'place' | 'move'; from?: Point; to: Point }) => {
      if (busy) return;
      setBusy(true);
      setError('');
      try {
        const result = await submitMove(roomId, action);
        if (result.ok) {
          setRoom(result.data.room);
          setSelected(null);
        } else {
          setError(result.error);
          // Re-sync so a rejected move cannot leave the board out of step.
          await refresh();
        }
      } finally {
        setBusy(false);
      }
    },
    [busy, roomId, refresh],
  );

  const handlePointClick = (point: Point) => {
    if (!state || !myTurn || busy) return;

    if (state.phase === 'placement') {
      void send({ kind: 'place', to: point });
      return;
    }

    if (selected === null) {
      if (state.board[point] === mySide) setSelected(point);
      return;
    }
    if (point === selected) {
      setSelected(null);
      return;
    }
    if (state.board[point] === mySide) {
      setSelected(point);
      return;
    }
    void send({ kind: 'move', from: selected, to: point });
  };

  const doLeave = async () => {
    if (room && (room.status === 'waiting' || room.status === 'active')) {
      await leaveRoom(room.id);
    }
    onLeave();
  };

  const doRematch = async () => {
    if (!room) return;
    setBusy(true);
    const result = await rematchRoom(room.id);
    setBusy(false);
    if (result.ok) {
      setRoom(result.data.room);
      setSelected(null);
      setError('');
    } else {
      setError(result.error);
    }
  };

  /* ---- render ------------------------------------------------------- */
  if (!room || !state) {
    return (
      <div className="py-20 text-center space-y-3">
        <Loader2 className="w-8 h-8 text-neon-purple animate-spin mx-auto" />
        <p className="text-sm text-gray-400">{error || 'Loading the match…'}</p>
        <button type="button" onClick={onLeave} className="text-sm text-gray-300 hover:text-white underline">
          Back to Game Zone
        </button>
      </div>
    );
  }

  const remaining = state.winner ? 0 : remainingMs(state, now);
  const percent = Math.max(0, Math.min(100, (remaining / TURN_MS) * 100));
  const urgent = remaining > 0 && remaining <= 10_000;
  const youWon = Boolean(room.winner_side && room.winner_side === mySide);

  const sideName = (side: string | null): string =>
    side === mySide ? 'You' : side === 'white' ? 'White' : side === 'black' ? 'Black' : 'Opponent';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-gray-300">
          <span className="uppercase tracking-wider text-xs text-gray-500">
            {room.mode === 'match' ? 'World Match' : 'Private Room'}
          </span>
          {mySide && (
            <span className="inline-flex items-center gap-1.5">
              <span className={`w-3 h-3 rounded-full ${mySide === 'white' ? 'bg-white' : 'bg-[#1a0b2e] border border-gray-300'}`} />
              you are {mySide}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => void doLeave()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-white/15 text-sm text-gray-300 hover:text-white hover:border-white/30 transition-colors"
        >
          <LogOut className="w-4 h-4" />
          Leave
        </button>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {/* Waiting for the friend */}
      {room.status === 'waiting' && (
        <div className="rounded-2xl border border-neon-purple/40 bg-neon-purple/5 p-6 text-center space-y-2">
          <Loader2 className="w-6 h-6 text-neon-purple animate-spin mx-auto" />
          <p className="text-white font-semibold">Waiting for your friend to join…</p>
          {room.code && (
            <p className="text-sm text-gray-300">
              Room code <span className="font-black tracking-[0.25em] text-white">{room.code}</span>
            </p>
          )}
        </div>
      )}

      {/* Turn + timer */}
      {room.status === 'active' && (
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <span className={`w-4 h-4 rounded-full ${state.turn === 'white' ? 'bg-white' : 'bg-[#1a0b2e] border-2 border-gray-300'}`} />
            <span className="text-sm font-semibold text-white">
              {myTurn ? 'Your turn' : `${sideName(state.turn)}'s turn`}
            </span>
          </div>
          <div className="flex-1 min-w-[10rem] flex items-center gap-2">
            <Timer className={`w-4 h-4 ${urgent ? 'text-red-400' : 'text-neon-purple'}`} />
            <div className="flex-1 h-2 rounded-full bg-white/10 overflow-hidden">
              <div className={`h-full ${urgent ? 'bg-red-500' : 'bg-neon-purple'}`} style={{ width: `${percent}%` }} />
            </div>
            <span className={`text-xs tabular-nums ${urgent ? 'text-red-400' : 'text-gray-400'}`}>
              {Math.ceil(remaining / 1000)}s
            </span>
          </div>
          <span className="inline-flex items-center gap-1 text-xs text-gray-500">
            <Clock className="w-3 h-3" />
            server clock
          </span>
        </div>
      )}

      {/* Board */}
      <Pair3BallsBoard
        board={state.board}
        selectablePoints={selectablePoints}
        selected={selected}
        lastMove={state.lastMove}
        onPointClick={handlePointClick}
        myPlayer={mySide}
        disabled={!myTurn || busy || room.status !== 'active'}
      />

      {busy && (
        <p className="text-center text-xs text-gray-500" role="status">
          <Loader2 className="w-3 h-3 inline animate-spin mr-1" />
          Waiting for the server to confirm…
        </p>
      )}

      {/* Result */}
      {state.winner && (
        <div
          className={`flex flex-wrap items-center justify-between gap-3 rounded-2xl border p-4 ${
            youWon ? 'border-emerald-400/40 bg-emerald-400/10' : 'border-white/15 bg-white/5'
          }`}
        >
          <div className="flex items-center gap-2">
            {youWon ? <Trophy className="w-5 h-5 text-emerald-300" /> : <Frown className="w-5 h-5 text-gray-400" />}
            <span className={`font-semibold ${youWon ? 'text-emerald-200' : 'text-gray-200'}`}>
              {youWon ? 'You win!' : `${sideName(room.winner_side)} wins`}
            </span>
            <span className="text-sm text-gray-400">
              {room.result === 'timeout' ? '(timeout)' : '(three in a row)'}
            </span>
          </div>
          {room.opponent_joined && (
            <button
              type="button"
              onClick={() => void doRematch()}
              disabled={busy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-neon-purple text-white text-sm font-semibold hover:bg-purple-600 transition-colors disabled:opacity-60"
            >
              <RotateCcw className="w-4 h-4" />
              Rematch
            </button>
          )}
        </div>
      )}

      {room.status === 'abandoned' && (
        <p className="text-sm text-amber-300 bg-amber-400/10 border border-amber-400/30 rounded-xl p-3">
          This match was abandoned — a player left before it finished.
        </p>
      )}
    </div>
  );
};
