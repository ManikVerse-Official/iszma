import { useCallback, useEffect, useRef, useState } from 'react';
import { Globe2, Loader2, X, RefreshCw, AlertCircle, Info } from 'lucide-react';
import { cancelMatchmake, ensureSession, matchmake } from '../../services/gameZone';

/**
 * World Match — random online opponent.
 *
 * The queue lives in Postgres and pairing is done server-side with
 * `FOR UPDATE SKIP LOCKED`, so two people searching at the same moment cannot
 * both claim the same opponent. The client only polls and reports status.
 *
 * If nobody is available the player keeps searching; we never substitute a bot
 * or a simulated opponent while calling it a real player.
 */

interface WorldMatchLobbyProps {
  onMatched: (roomId: string) => void;
  onBack: () => void;
}

const POLL_MS = 3000;

export const WorldMatchLobby: React.FC<WorldMatchLobbyProps> = ({ onMatched, onBack }) => {
  const [status, setStatus] = useState<'idle' | 'searching'>('idle');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const stopped = useRef(false);

  const stop = useCallback(async (cancel: boolean) => {
    stopped.current = true;
    setStatus('idle');
    if (cancel) await cancelMatchmake();
  }, []);

  const search = useCallback(async () => {
    setError('');
    const session = await ensureSession();
    if (!session.ok) {
      setError(session.error);
      return;
    }
    stopped.current = false;
    setSeconds(0);
    setStatus('searching');

    const first = await matchmake(true);
    if (!first.ok) {
      setStatus('idle');
      setError(first.error);
      return;
    }
    if (first.data.status === 'matched' && first.data.room_id) {
      onMatched(first.data.room_id);
      return;
    }
  }, [onMatched]);

  /* ---- poll for an opponent -------------------------------------- */
  useEffect(() => {
    if (status !== 'searching') return;

    const tick = window.setInterval(() => setSeconds((value) => value + 1), 1000);

    const poll = window.setInterval(() => {
      if (stopped.current) return;
      void matchmake(true).then((result) => {
        if (stopped.current) return;
        if (!result.ok) {
          // A transient failure keeps the player queued; only a hard rejection
          // stops the search.
          if (result.code === 'not_authenticated' || result.code === 'unavailable') {
            setError(result.error);
            setStatus('idle');
          }
          return;
        }
        if (result.data.status === 'matched' && result.data.room_id) {
          stopped.current = true;
          onMatched(result.data.room_id);
        }
      });
    }, POLL_MS);

    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [status, onMatched]);

  /* ---- never leave a ghost in the queue -------------------------- */
  useEffect(() => () => {
    if (!stopped.current) void cancelMatchmake();
  }, []);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="inline-flex items-center gap-2 text-sm text-gray-300">
          <Globe2 className="w-4 h-4 text-neon-purple" />
          World Match — a real player, anywhere
        </p>
        <button
          type="button"
          onClick={() => {
            void stop(true);
            onBack();
          }}
          className="text-sm text-gray-400 hover:text-white transition-colors"
        >
          Back
        </button>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {status === 'idle' && (
        <button
          type="button"
          onClick={() => void search()}
          className="w-full rounded-2xl border border-neon-purple/40 bg-neon-purple/10 p-8 hover:bg-neon-purple/20 transition-colors text-center"
        >
          <Globe2 className="w-8 h-8 text-neon-purple mx-auto mb-3" />
          <p className="font-semibold text-white text-lg">Find a random player</p>
          <p className="text-sm text-gray-400 mt-1">
            You will be matched with another player who is searching right now.
          </p>
        </button>
      )}

      {status === 'searching' && (
        <div className="rounded-2xl border border-neon-purple/40 bg-neon-purple/5 p-8 text-center space-y-4">
          <Loader2 className="w-8 h-8 text-neon-purple animate-spin mx-auto" />
          <p className="font-semibold text-white" role="status" aria-live="polite">
            Searching for a real player…
          </p>
          <p className="text-sm text-gray-400">
            Waiting {seconds}s. The match starts as soon as someone is found.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <button
              type="button"
              onClick={() => void stop(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-white/20 text-sm text-gray-200 hover:text-white hover:border-white/40 transition-colors"
            >
              <X className="w-4 h-4" />
              Cancel search
            </button>
            <button
              type="button"
              onClick={() => {
                stopped.current = true;
                void search();
              }}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-white/20 text-sm text-gray-200 hover:text-white hover:border-white/40 transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Retry
            </button>
          </div>
        </div>
      )}

      <p className="flex items-start gap-2 text-xs text-gray-500">
        <Info className="w-4 h-4 mt-0.5 shrink-0" />
        If nobody is available you stay in the queue — you can cancel at any time.
        A computer opponent is only ever offered in Play vs Computer; a real match is never faked.
      </p>
    </div>
  );
};
