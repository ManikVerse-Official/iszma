import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Share2, Check, Users, LogIn, Loader2, KeyRound, AlertCircle } from 'lucide-react';
import {
  createPrivateRoom,
  ensureSession,
  getRoom,
  joinPrivateRoom,
  subscribeToRoom,
  type GameRoomView,
} from '../../services/gameZone';

/**
 * Private Room lobby.
 *
 * Both invitation paths — the secret code and the shareable link — land in the
 * SAME room: the link is just `/game-zone/room/<code>`, so a friend arriving
 * from WhatsApp and a friend typing the code end up in exactly one place.
 *
 * The code is the join secret (there is no bypass token in the URL), and the
 * server still requires an authenticated session before letting anyone in.
 */

interface PrivateRoomLobbyProps {
  /** Pre-filled when the player arrived from an invite link. */
  initialCode?: string;
  onReady: (roomId: string) => void;
  onBack: () => void;
}

export const PrivateRoomLobby: React.FC<PrivateRoomLobbyProps> = ({
  initialCode = '',
  onReady,
  onBack,
}) => {
  const [view, setView] = useState<'choose' | 'hosting' | 'joining'>(initialCode ? 'joining' : 'choose');
  const [code, setCode] = useState(initialCode.toUpperCase());
  const [room, setRoom] = useState<GameRoomView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);
  const handled = useRef(false);

  const inviteLink = room?.code
    ? `${window.location.origin}/game-zone/room/${room.code}`
    : '';

  /* ---- create ---------------------------------------------------- */
  const create = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const session = await ensureSession();
      if (!session.ok) {
        setError(session.error);
        return;
      }
      const result = await createPrivateRoom();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRoom(result.data.room);
      setView('hosting');
    } finally {
      setBusy(false);
    }
  }, []);

  /* ---- join ------------------------------------------------------ */
  const join = useCallback(async (rawCode: string) => {
    const clean = rawCode.trim().toUpperCase();
    if (clean.length < 4) {
      setError('Enter the 6-character room code.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const session = await ensureSession();
      if (!session.ok) {
        setError(session.error);
        return;
      }
      const result = await joinPrivateRoom(clean);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setRoom(result.data.room);
      onReady(result.data.room.id);
    } finally {
      setBusy(false);
    }
  }, [onReady]);

  /* ---- invite link opened directly -------------------------------- */
  useEffect(() => {
    if (!initialCode || handled.current) return;
    handled.current = true;
    void join(initialCode);
  }, [initialCode, join]);

  /* ---- wait for the friend --------------------------------------- */
  useEffect(() => {
    if (view !== 'hosting' || !room) return;

    const unsubscribe = subscribeToRoom(room.id, (updated) => {
      setRoom(updated);
      if (updated.opponent_joined) onReady(updated.id);
    });

    // Fallback poll, so the match still starts when Realtime is unavailable.
    const id = window.setInterval(() => {
      void getRoom(room.id).then((result) => {
        if (!result.ok) return;
        setRoom(result.data.room);
        if (result.data.room.opponent_joined) onReady(result.data.room.id);
      });
    }, 3000);

    return () => {
      unsubscribe();
      window.clearInterval(id);
    };
  }, [view, room?.id, onReady, room]);

  const copy = async (value: string, which: 'code' | 'link') => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setError('Could not copy automatically — please select and copy it manually.');
    }
  };

  const share = async () => {
    const text = `Play Pair-3Balls with me on isZma. Room code: ${room?.code}`;
    const nav = navigator as Navigator & { share?: (data: ShareData) => Promise<void> };
    if (nav.share) {
      try {
        await nav.share({ title: 'Pair-3Balls', text, url: inviteLink });
        return;
      } catch {
        // The player dismissed the sheet — fall back to copying.
      }
    }
    await copy(`${text}\n${inviteLink}`, 'link');
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <p className="inline-flex items-center gap-2 text-sm text-gray-300">
          <Users className="w-4 h-4 text-neon-purple" />
          Private Room — invite a friend
        </p>
        <button
          type="button"
          onClick={onBack}
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

      {view === 'choose' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="text-left rounded-2xl border border-neon-purple/40 bg-neon-purple/10 p-5 hover:bg-neon-purple/20 transition-colors disabled:opacity-60"
          >
            <KeyRound className="w-6 h-6 text-neon-purple mb-3" />
            <p className="font-semibold text-white">Create a room</p>
            <p className="text-sm text-gray-400 mt-1">
              Get a unique code and an invite link to send to your friend.
            </p>
          </button>

          <div className="rounded-2xl border border-white/15 p-5">
            <LogIn className="w-6 h-6 text-neon-purple mb-3" />
            <p className="font-semibold text-white">Join with a code</p>
            <div className="mt-2 flex gap-2">
              <input
                value={code}
                onChange={(event) => setCode(event.target.value.toUpperCase().slice(0, 6))}
                placeholder="ABC123"
                inputMode="text"
                autoComplete="off"
                spellCheck={false}
                aria-label="Room code"
                className="flex-1 min-w-0 bg-bg-dark-start border border-neon-purple/40 rounded-xl px-3 py-2 text-white tracking-[0.2em] uppercase placeholder-gray-500 focus:outline-none focus:border-neon-purple"
              />
              <button
                type="button"
                onClick={() => void join(code)}
                disabled={busy || code.trim().length < 4}
                className="inline-flex items-center gap-2 px-4 rounded-xl bg-neon-purple text-white text-sm font-semibold hover:bg-purple-600 transition-colors disabled:opacity-50"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Join'}
              </button>
            </div>
          </div>
        </div>
      )}

      {view === 'hosting' && room && (
        <div className="rounded-2xl border border-neon-purple/40 bg-neon-purple/5 p-5 space-y-4">
          <div>
            <p className="text-xs uppercase tracking-wider text-gray-500">Room code</p>
            <div className="flex items-center gap-3 mt-1">
              <span className="text-3xl font-black tracking-[0.3em] text-white">{room.code}</span>
              <button
                type="button"
                onClick={() => void copy(room.code ?? '', 'code')}
                className="inline-flex items-center gap-1.5 text-sm text-neon-purple hover:text-white transition-colors"
              >
                {copied === 'code' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied === 'code' ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div>
            <p className="text-xs uppercase tracking-wider text-gray-500">Invite link</p>
            <p className="text-sm text-gray-300 break-all mt-1">{inviteLink}</p>
            <div className="flex flex-wrap gap-2 mt-3">
              <button
                type="button"
                onClick={() => void copy(inviteLink, 'link')}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-neon-purple/40 text-sm text-white hover:bg-neon-purple/15 transition-colors"
              >
                {copied === 'link' ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied === 'link' ? 'Copied' : 'Copy link'}
              </button>
              <button
                type="button"
                onClick={() => void share()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-neon-purple text-white text-sm font-semibold hover:bg-purple-600 transition-colors"
              >
                <Share2 className="w-4 h-4" />
                Share
              </button>
              <a
                href={`https://wa.me/?text=${encodeURIComponent(
                  `Play Pair-3Balls with me on isZma. Room code: ${room.code}\n${inviteLink}`,
                )}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl border border-emerald-400/40 text-sm text-emerald-200 hover:bg-emerald-400/10 transition-colors"
              >
                WhatsApp
              </a>
            </div>
          </div>

          <p className="flex items-center gap-2 text-sm text-gray-400">
            <Loader2 className="w-4 h-4 animate-spin text-neon-purple" />
            Waiting for your friend to join… the match starts the moment they do.
          </p>
        </div>
      )}
    </div>
  );
};
