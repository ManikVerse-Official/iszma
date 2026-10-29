import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from './supabase';
import { deserialize, type GameState, type Player } from '../game/pair3balls/engine';

/**
 * Game Zone transport.
 *
 * Every privileged action goes through a SECURITY DEFINER function; this module
 * only carries the request. There is deliberately NO client-side fallback that
 * writes a move, a room or a result — if the backend is unreachable the online
 * modes fail closed and say so, rather than pretending a match happened.
 */

export const GAME_ID = 'pair3balls';

export type RoomMode = 'private' | 'match';
export type RoomStatus = 'waiting' | 'active' | 'finished' | 'abandoned';

export interface GameRoomView {
  id: string;
  game_id: string;
  mode: RoomMode;
  status: RoomStatus;
  /** Private join code. Only the host receives it. */
  code: string | null;
  is_host: boolean;
  your_side: Player | null;
  opponent_joined: boolean;
  state: unknown;
  winner_side: Player | null;
  result: string | null;
  move_count: number;
  turn_deadline_ms: number | null;
  server_now_ms: number;
  rematch_of: string | null;
  created_at: string;
  expires_at: string;
}

export interface GameSettings {
  game_id: string;
  enabled: boolean;
  maintenance: boolean;
  sort_order: number;
}

export interface GameAnalytics {
  game_id: string;
  settings: GameSettings | null;
  sessions_started: number;
  unique_players: number;
  anonymous_events: number;
  games_completed: number;
  in_progress: number;
  abandoned: number;
  timeouts: number;
  wins_by_side: Record<string, number>;
  by_mode: Record<string, number>;
  queue_waiting: number;
  active_2m: number;
  avg_duration_seconds: number | null;
  daily: Array<{ day: string; n: number }>;
}

export type GameResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

const unavailable = (): GameResult<never> => ({
  ok: false,
  error: 'The Game Zone is not connected. Please check your connection and try again.',
  code: 'offline',
});

const messageForCode = (code: string, fallback: string): string => {
  switch (code) {
    case 'not_authenticated':
      return 'Please sign in to play online.';
    case 'unavailable':
      return 'Pair-3Balls is temporarily unavailable. Please try again later.';
    case 'rate_limited':
      return 'Too many requests. Please wait a moment and try again.';
    case 'no_such_room':
      return 'That room no longer exists.';
    case 'room_expired':
      return 'That room has expired.';
    case 'room_full':
      return 'That room is already full.';
    case 'room_not_open':
      return 'That room is no longer accepting players.';
    case 'not_a_member':
      return 'You are not part of that room.';
    case 'not_active':
      return 'That match has not started yet.';
    case 'already_in_room':
      return 'One of the players is already in another match. Please try again in a moment.';
    case 'finished':
      return 'That match is already over.';
    case 'out_of_turn':
      return 'It is not your turn.';
    case 'expired':
      return 'Your time ran out.';
    case 'occupied':
      return 'That point is already taken.';
    case 'not_adjacent':
      return 'Those points are not connected.';
    case 'not_admin':
      return 'Administrator access is required.';
    default:
      return fallback;
  }
};

/** Runs an RPC and normalises both failure modes into one shape. */
const callRpc = async <T>(
  fn: string,
  args: Record<string, unknown>,
): Promise<GameResult<T>> => {
  if (!isSupabaseConfigured()) return unavailable();

  try {
    const { data, error } = await supabase.rpc(fn, args);

    if (error) {
      console.warn(`gameZone: ${fn} failed:`, error.message);
      return { ok: false, error: messageForCode('', error.message), code: 'rpc_error' };
    }

    const payload = (data ?? {}) as Record<string, unknown>;
    if (payload.ok !== true) {
      const code = typeof payload.code === 'string' ? payload.code : '';
      return {
        ok: false,
        code: code || 'rejected',
        error: messageForCode(code, 'The server rejected that request.'),
      };
    }

    return { ok: true, data: payload as unknown as T };
  } catch (error) {
    console.warn(`gameZone: ${fn} threw:`, error);
    return { ok: false, error: 'Could not reach the game server. Please try again.', code: 'network' };
  }
};

/** Reads the admin-controlled availability switch (publicly readable). */
export const fetchGameSettings = async (): Promise<GameSettings | null> => {
  if (!isSupabaseConfigured()) return null;
  try {
    const { data, error } = await supabase
      .from('game_settings')
      .select('game_id, enabled, maintenance, sort_order')
      .eq('game_id', GAME_ID)
      .maybeSingle();
    if (error) return null;
    return (data as GameSettings) ?? null;
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ */
/* Rooms                                                               */
/* ------------------------------------------------------------------ */

export const createPrivateRoom = (): Promise<GameResult<{ room: GameRoomView }>> =>
  callRpc('game_create_private_room', {});

export const joinPrivateRoom = (code: string): Promise<GameResult<{ room: GameRoomView }>> =>
  callRpc('game_join_private_room', { p_code: code });

export const getRoom = (roomId: string): Promise<GameResult<{ room: GameRoomView }>> =>
  callRpc('game_room_state', { p_room_id: roomId });

export const leaveRoom = (roomId: string): Promise<GameResult<Record<string, unknown>>> =>
  callRpc('game_leave_room', { p_room_id: roomId });

export const rematchRoom = (roomId: string): Promise<GameResult<{ room: GameRoomView }>> =>
  callRpc('game_rematch', { p_room_id: roomId });

/**
 * Asks the SERVER to declare a timeout once the turn deadline has passed.
 * The client never decides the result itself — it only prompts the server, and
 * the server refuses unless the deadline has genuinely gone by.
 */
export const settleRoomTimeout = (roomId: string): Promise<GameResult<{ room: GameRoomView }>> =>
  callRpc('game_settle_timeout', { p_room_id: roomId });

/** Submits one move. The server is the only thing that decides legality. */
export const submitMove = (
  roomId: string,
  action: { kind: 'place' | 'move'; from?: number; to: number },
): Promise<GameResult<{ room: GameRoomView }>> =>
  callRpc('game_submit_move', {
    p_room_id: roomId,
    p_kind: action.kind,
    p_from: action.from ?? null,
    p_to: action.to,
  });

/* ------------------------------------------------------------------ */
/* Matchmaking                                                         */
/* ------------------------------------------------------------------ */

export interface MatchmakeResult {
  status: 'searching' | 'matched';
  room_id?: string;
}

export const matchmake = (heartbeat = true): Promise<GameResult<MatchmakeResult>> =>
  callRpc('game_matchmake', { p_heartbeat: heartbeat });

export const cancelMatchmake = (): Promise<GameResult<Record<string, unknown>>> =>
  callRpc('game_matchmake_cancel', {});

/* ------------------------------------------------------------------ */
/* Admin                                                               */
/* ------------------------------------------------------------------ */

export const fetchGameAnalytics = (): Promise<GameResult<{ analytics: GameAnalytics }>> =>
  callRpc('game_admin_analytics', {});

export const saveGameSettings = (
  settings: Pick<GameSettings, 'enabled' | 'maintenance' | 'sort_order'>,
): Promise<GameResult<Record<string, unknown>>> =>
  callRpc('game_admin_settings', {
    p_game_id: GAME_ID,
    p_enabled: settings.enabled,
    p_maintenance: settings.maintenance,
    p_sort_order: settings.sort_order,
  });

/* ------------------------------------------------------------------ */
/* Engine bridge                                                       */
/* ------------------------------------------------------------------ */

/**
 * Converts a room payload into the shared engine's state.
 *
 * The server's `turn_deadline_ms` column wins over the copy inside `state`, so
 * a tampered or stale client payload can never extend a turn beyond the
 * server's own deadline.
 */
export const roomToEngineState = (room: GameRoomView, now: number = Date.now()): GameState => {
  const state = deserialize(room.state, now);
  /*
   * The end reason lives in the room's `result` column, so it is mapped here —
   * including the repetition draw, which has no `winner_side` at all. Without
   * this an online draw would render as a game that never ended.
   */
  const reason =
    room.result === 'repetition'
      ? 'repetition'
      : room.result === 'timeout'
        ? 'timeout'
        : room.winner_side
          ? 'three-in-a-row'
          : state.reason;
  const merged: GameState = {
    ...state,
    winner: room.winner_side ?? state.winner,
    reason,
    phase: room.status === 'finished' ? 'finished' : state.phase,
  };
  return typeof room.turn_deadline_ms === 'number'
    ? { ...merged, turnDeadlineAt: room.turn_deadline_ms }
    : merged;
};

/** True when it is this player's turn in the given room. */
export const isMyTurn = (room: GameRoomView): boolean =>
  room.status === 'active' && room.your_side !== null && room.state !== null
    ? (room.state as { turn?: string }).turn === room.your_side
    : false;

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Ensures the player has a real Supabase session before joining a room.
 *
 * Guests get an ANONYMOUS Supabase user — a genuine server-issued identity with
 * no email, name or password — instead of an invented client-side id. Anonymous
 * sign-ins must be switched on in Supabase → Authentication → Providers; when
 * they are off (or the project is offline) this returns an error and the online
 * modes stay closed rather than faking a player.
 */
export const ensureSession = async (): Promise<GameResult<{ userId: string; anonymous: boolean }>> => {
  if (!isSupabaseConfigured()) return unavailable();

  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) {
      return { ok: true, data: { userId: data.session.user.id, anonymous: !data.session.user.email } };
    }

    const { data: created, error } = await supabase.auth.signInAnonymously();
    if (error || !created.user) {
      return {
        ok: false,
        code: 'no_session',
        error:
          'Online play needs a session. Enable “Anonymous sign-ins” in Supabase → Authentication → Providers, then try again.',
      };
    }

    return { ok: true, data: { userId: created.user.id, anonymous: true } };
  } catch (error) {
    console.warn('gameZone: ensureSession failed:', error);
    return { ok: false, code: 'network', error: 'Could not start a session. Please try again.' };
  }
};

/* ------------------------------------------------------------------ */
/* Realtime                                                            */
/* ------------------------------------------------------------------ */

/**
 * Subscribes to a single room row. RLS still applies to Realtime, so this only
 * ever delivers rooms the signed-in user is a member of.
 */
export const subscribeToRoom = (
  roomId: string,
  onChange: (room: GameRoomView) => void,
): (() => void) => {
  if (!isSupabaseConfigured()) return () => {};

  let channel: RealtimeChannel | null = null;
  try {
    channel = supabase
      .channel(`game-room-${roomId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'game_rooms', filter: `id=eq.${roomId}` },
        (payload) => {
          const row = payload.new as Record<string, unknown> | undefined;
          if (!row) return;
          // Re-fetch through the RPC so the row is shaped by the same
          // membership check as everything else.
          void getRoom(roomId).then((result) => {
            if (result.ok) onChange(result.data.room);
          });
        },
      )
      .subscribe();
  } catch (error) {
    console.warn('gameZone: realtime subscribe failed:', error);
    return () => {};
  }

  return () => {
    if (channel) void supabase.removeChannel(channel);
  };
};
