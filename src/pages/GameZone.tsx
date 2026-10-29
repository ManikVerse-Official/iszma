import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Bot,
  Users,
  MonitorSmartphone,
  Globe2,
  ArrowLeft,
  AlertCircle,
  Cpu,
  Info,
  Target,
  Play,
  CheckCircle2,
} from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { Footer } from '../components/Footer';
import { Chatbot } from '../components/Chatbot';
import { Pair3BallsGame } from '../components/game/Pair3BallsGame';
import { Pair3BallsRules } from '../components/game/Pair3BallsRules';
import { AdSlot } from '../components/game/AdSlot';
import { PrivateRoomLobby } from '../components/game/PrivateRoomLobby';
import { WorldMatchLobby } from '../components/game/WorldMatchLobby';
import { OnlineMatch } from '../components/game/OnlineMatch';
import type { Difficulty } from '../game/pair3balls/ai';
import { DEFAULT_GAME_ID, GAME_LIBRARY, getGame, type GameEntry } from '../game/registry';
import { fetchGameSettings } from '../services/gameZone';
import { IsZmaWatermarkBg } from '../components/brand/IsZmaWatermarkBg';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';

/**
 * Game Zone — a game library.
 *
 *   library  → one tile per registered game (icon, title, description, status,
 *              Play button). Nothing is invented to fill the shelf.
 *   game     → the chosen game's own screen: description, the four modes
 *              (vs Computer / Two Players on one device / Private Room / World
 *              Match) and its rules.
 *   difficulty / computer / private / world / match → the actual play surfaces.
 *
 * Local (computer) play needs no backend. The online modes need Supabase; when
 * it is not configured they say so instead of pretending to be online.
 */

type Screen = 'library' | 'game' | 'difficulty' | 'computer' | 'local' | 'private' | 'world' | 'match';

const GAME_ICONS: Record<GameEntry['icon'], React.ReactNode> = {
  target: <Target className="w-6 h-6" />,
};

export const GameZone: React.FC = () => {
  const { code } = useParams<{ code?: string }>();
  const [searchTerm, setSearchTerm] = useState('');

  const initialCode = (code ?? '').toUpperCase();
  const [screen, setScreen] = useState<Screen>(initialCode ? 'private' : 'library');
  const [gameId, setGameId] = useState<string>(DEFAULT_GAME_ID);
  const [difficulty, setDifficulty] = useState<Difficulty>('medium');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [onlineAvailable, setOnlineAvailable] = useState<boolean | null>(null);

  usePageMeta({
    title: pageTitle('Game Zone — Pair-3Balls'),
    description:
      'Play Pair-3Balls in the isZma Game Zone: against the computer offline, with a friend on one device, in a private room, or in a world match.',
    /* An invite link is user-owned and must never enter search results. */
    path: initialCode ? `/game-zone/room/${initialCode.toLowerCase()}` : '/game-zone',
    noindex: Boolean(initialCode),
  });

  useEffect(() => {
    let active = true;
    void fetchGameSettings().then((settings) => {
      if (!active) return;
      setOnlineAvailable(settings === null ? false : settings.enabled && !settings.maintenance);
    });
    return () => {
      active = false;
    };
  }, []);

  const online = onlineAvailable === true;
  const game = getGame(gameId) ?? GAME_LIBRARY[0];

  /** Back to the library from anywhere, dropping any room in progress. */
  const toLibrary = () => {
    setRoomId(null);
    setScreen('library');
  };

  const openMode = (mode: GameEntry['modes'][number]['id']) => {
    if (mode === 'computer') setScreen('difficulty');
    else if (mode === 'local') setScreen('local');
    else if (mode === 'private') setScreen('private');
    else setScreen('world');
  };

  return (
    <div className="relative isolate min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
      <IsZmaWatermarkBg />
      <Navbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} />

      <main className="pt-24 pb-16 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto space-y-8">
          {/* Same top-left exit used by the other sections (ReportCard Studio,
              section pages, Founder). Sits above every Game Zone screen so the
              mall is always one click away, including mid-game. */}
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to mall
          </Link>

          {/* ── Library ─────────────────────────────────────────────── */}
          {screen === 'library' && (
            <>
              <header className="space-y-3">
                <p className="text-xs uppercase tracking-[0.3em] text-neon-purple">Game Zone</p>
                <h1 className="text-3xl sm:text-4xl font-black text-white">Game Library</h1>
                <p className="text-gray-400 max-w-2xl">
                  Pick a game to open its own screen. Every title here is playable — nothing is
                  listed as a placeholder.
                </p>
              </header>

              {onlineAvailable === false && (
                /*
                 * The icon and the sentence sit in ONE flex item: as siblings the
                 * <strong> and the trailing text became separate flex columns, so
                 * the line broke into stray fragments on the right.
                 */
                <p className="flex items-start gap-2 text-xs text-amber-200/90 bg-amber-400/10 border border-amber-400/25 rounded-xl px-3 py-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    Online modes are off — the Game Zone backend is not configured. Offline games
                    still play normally.
                  </span>
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                {GAME_LIBRARY.map((entry) => (
                  <article
                    key={entry.id}
                    className="rounded-2xl border border-neon-purple/40 bg-bg-dark-end p-5 flex flex-col"
                  >
                    <div className="flex items-start gap-3">
                      <span className="shrink-0 rounded-xl bg-neon-purple/15 border border-neon-purple/40 p-2.5 text-neon-purple">
                        {GAME_ICONS[entry.icon]}
                      </span>
                      <div className="min-w-0">
                        <h2 className="font-semibold text-white rc-wrap">{entry.title}</h2>
                        <p className="text-sm text-gray-400 mt-1">{entry.tagline}</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2 mt-4 text-[11px] uppercase tracking-wider">
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-400/10 border border-emerald-400/30 text-emerald-300 px-2 py-0.5">
                        <CheckCircle2 className="w-3 h-3" /> Available
                      </span>
                      {entry.offline && (
                        <span className="rounded-full bg-white/5 border border-white/15 text-gray-300 px-2 py-0.5">
                          Offline play
                        </span>
                      )}
                      <span className="rounded-full bg-white/5 border border-white/15 text-gray-300 px-2 py-0.5">
                        {entry.modes.length} modes
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        setGameId(entry.id);
                        setScreen('game');
                      }}
                      className="mt-5 inline-flex items-center justify-center gap-2 rounded-xl bg-neon-purple text-white px-4 py-2.5 text-sm font-semibold hover:bg-neon-purple/85 transition-colors"
                    >
                      <Play className="w-4 h-4" /> Play {entry.title}
                    </button>
                  </article>
                ))}
              </div>

              <p className="flex items-start gap-2 text-xs text-gray-500">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                More games will appear on this shelf as they are registered. An empty slot is left
                empty on purpose.
              </p>
            </>
          )}

          {/* ── The chosen game's own screen ─────────────────────────── */}
          {screen === 'game' && (
            <>
              <BackButton label="Game Library" onClick={toLibrary} />

              <header className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className="shrink-0 rounded-xl bg-neon-purple/15 border border-neon-purple/40 p-2.5 text-neon-purple">
                    {GAME_ICONS[game.icon]}
                  </span>
                  <h1 className="text-3xl sm:text-4xl font-black text-white">{game.title}</h1>
                </div>
                <p className="text-gray-400 max-w-2xl">{game.description}</p>
              </header>

              {onlineAvailable === false && (
                <p className="flex items-start gap-2 text-xs text-amber-200/90 bg-amber-400/10 border border-amber-400/25 rounded-xl px-3 py-2">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <span>
                    {onlineAvailable === null
                      ? 'Checking online availability…'
                      : 'Online modes are off — the Game Zone backend is not configured. Offline play works without a connection.'}
                  </span>
                </p>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                {game.modes.map((mode) => {
                  const available = mode.online ? online : true;
                  return (
                    <button
                      key={mode.id}
                      type="button"
                      disabled={!available}
                      onClick={() => openMode(mode.id)}
                      className="text-left rounded-2xl border border-neon-purple/40 bg-bg-dark-end p-5 transition-colors hover:border-neon-purple hover:bg-neon-purple/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-neon-purple/40 disabled:hover:bg-bg-dark-end"
                    >
                      <span className="text-neon-purple">
                        {mode.id === 'computer' ? (
                          <Bot className="w-6 h-6" />
                        ) : mode.id === 'local' ? (
                          <MonitorSmartphone className="w-6 h-6" />
                        ) : mode.id === 'private' ? (
                          <Users className="w-6 h-6" />
                        ) : (
                          <Globe2 className="w-6 h-6" />
                        )}
                      </span>
                      <p className="font-semibold text-white mt-3">{mode.title}</p>
                      <p className="text-sm text-gray-400 mt-1">{mode.blurb}</p>
                      <p className="text-xs text-gray-500 mt-3 uppercase tracking-wider">
                        {mode.online ? (online ? 'online' : 'needs a connection') : mode.label}
                      </p>
                    </button>
                  );
                })}
              </div>

              <Pair3BallsRules />

              {/* Renders nothing until a real ad provider is configured. */}
              <AdSlot placement="lobby" />

              <p className="flex items-start gap-2 text-xs text-gray-500">
                <Info className="w-4 h-4 mt-0.5 shrink-0" />
                All four modes use the same rules and the same 60-second turn timer. There is no
                capturing; a game ends by three in a row, by a timeout, or as a draw when the same
                move is repeated more than three times.
              </p>
            </>
          )}

          {/* 1. Computer difficulty */}
          {screen === 'difficulty' && (
            <div className="space-y-4">
              <BackButton label={game.title} onClick={() => setScreen('game')} />
              <p className="inline-flex items-center gap-2 text-sm text-gray-300">
                <Cpu className="w-4 h-4 text-neon-purple" />
                Choose a difficulty
              </p>
              <div className="grid gap-3 sm:grid-cols-3">
                {game.difficultyOptions.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => {
                      setDifficulty(entry.id);
                      setScreen('computer');
                    }}
                    className="text-left rounded-2xl border border-white/15 p-5 hover:border-neon-purple hover:bg-neon-purple/10 transition-colors"
                  >
                    <p className="font-semibold text-white">{entry.label}</p>
                    <p className="text-sm text-gray-400 mt-1">{entry.blurb}</p>
                  </button>
                ))}
              </div>
              <Pair3BallsRules />
            </div>
          )}

          {/* 1. Computer game */}
          {screen === 'computer' && (
            <div className="space-y-4">
              <BackButton label="Difficulties" onClick={() => setScreen('difficulty')} />
              <Pair3BallsGame
                mode="computer"
                difficulty={difficulty}
                onExit={() => setScreen('game')}
              />
            </div>
          )}

          {/* 1b. Two players, one device (pass and play) */}
          {screen === 'local' && (
            <div className="space-y-4">
              <BackButton label="Modes" onClick={() => setScreen('game')} />
              <Pair3BallsGame mode="local" onExit={() => setScreen('game')} />
            </div>
          )}

          {/* 2. Private room */}
          {screen === 'private' && (
            <div className="space-y-4">
              <PrivateRoomLobby
                initialCode={initialCode}
                onBack={() => setScreen('game')}
                onReady={(id) => {
                  setRoomId(id);
                  setScreen('match');
                }}
              />
              <Pair3BallsRules />
            </div>
          )}

          {/* 3. World match */}
          {screen === 'world' && (
            <div className="space-y-4">
              <WorldMatchLobby
                onBack={() => setScreen('game')}
                onMatched={(id) => {
                  setRoomId(id);
                  setScreen('match');
                }}
              />
              <Pair3BallsRules />
            </div>
          )}

          {/* Live match */}
          {screen === 'match' && roomId && (
            <div className="space-y-4">
              <OnlineMatch
                roomId={roomId}
                onLeave={() => {
                  setRoomId(null);
                  setScreen('game');
                }}
              />
            </div>
          )}

          {screen === 'match' && !roomId && (
            <p className="text-sm text-gray-400">No match selected. Pick a mode to start playing.</p>
          )}
        </div>
      </main>

      <Chatbot sectionId="game-zone" />
      <Footer />
    </div>
  );
};

const BackButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
  >
    <ArrowLeft className="w-4 h-4" />
    {label}
  </button>
);
