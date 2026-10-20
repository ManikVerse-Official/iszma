import { DIFFICULTIES, type Difficulty } from './pair3balls/ai';
import { RULES } from './pair3balls/engine';

/**
 * Game Zone registry.
 *
 * The Zone behaves like a game library: every game is one tile with its own
 * artwork, status and Play button, and opening a tile enters that game's own
 * screen. Adding a game means adding an entry here — the library UI, the
 * availability badges and the checks all read this one list, so the Zone never
 * has to be redesigned for a new title.
 *
 * Only games that really exist are registered. An empty slot is left empty
 * rather than filled with a mocked-up "coming soon" game.
 */

export type GameModeId = 'computer' | 'private' | 'world';

export interface GameMode {
  id: GameModeId;
  title: string;
  blurb: string;
  /** True when the mode needs the Supabase backend to work at all. */
  online: boolean;
  /** Short availability note shown on the mode card. */
  label: string;
}

export interface GameEntry {
  /** Stable id, also used by the game's own screen. */
  id: string;
  title: string;
  /** One line shown on the tile. */
  tagline: string;
  /** Longer description shown on the game's own screen. */
  description: string;
  /** lucide-react icon key, resolved by the library UI. */
  icon: 'target';
  /** True when the whole game works with no network connection. */
  offline: boolean;
  difficultyOptions: { id: Difficulty; label: string; blurb: string }[];
  modes: GameMode[];
  rules: typeof RULES;
}

/** The three modes are fixed by the product: no more, no fewer. */
const STANDARD_MODES: GameMode[] = [
  {
    id: 'computer',
    title: 'Play vs Computer',
    blurb: 'Three difficulties, from a beginner you can beat to a strong search opponent.',
    online: false,
    label: 'works offline',
  },
  {
    id: 'private',
    title: 'Private Room — Friends',
    blurb: 'Create a room, share the code or the invite link, and play your friend.',
    online: true,
    label: 'needs a connection',
  },
  {
    id: 'world',
    title: 'World Match',
    blurb: 'Get matched with a random real player who is searching right now.',
    online: true,
    label: 'needs a connection',
  },
];

const PAIR_3_BALLS: GameEntry = {
  id: 'pair-3balls',
  title: 'Pair-3Balls',
  tagline: 'Nine points, three pieces each, one line to win.',
  description:
    'Place your three pieces, then step them along the connected lines. First to three in a row takes it — there are no captures and no draws, and every turn runs on a 60-second clock.',
  icon: 'target',
  offline: true,
  difficultyOptions: DIFFICULTIES.map((entry) => ({
    id: entry.id,
    label: entry.label,
    blurb: entry.blurb,
  })),
  modes: STANDARD_MODES,
  rules: RULES,
};

/** Display order of the library. Register new games by appending here. */
const GAME_LIBRARY: GameEntry[] = [PAIR_3_BALLS];

const getGame = (id: string | undefined): GameEntry | undefined =>
  GAME_LIBRARY.find((game) => game.id === id);

const DEFAULT_GAME_ID = PAIR_3_BALLS.id;

/*
 * Exported as a group on purpose: the SSR transform hoists `export const`
 * declarations, which would evaluate `GAME_LIBRARY = [PAIR_3_BALLS]` before
 * `PAIR_3_BALLS` exists. Plain consts + one export statement keep the order.
 */
export { PAIR_3_BALLS, GAME_LIBRARY, getGame, DEFAULT_GAME_ID };
