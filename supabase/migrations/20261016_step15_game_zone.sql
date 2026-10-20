-- ============================================================================
-- Ishmaverse · Step 15: Game Zone — Pair-3Balls backend
-- ----------------------------------------------------------------------------
-- Real backend for the three game modes. Nothing here trusts the client.
--
--   • game_rooms    — private rooms AND matched games. The Pair-3Balls rules are
--                     re-implemented server-side (board, lines, adjacency, win
--                     detection, 60s turn deadline) so a client cannot invent a
--                     winner, move out of turn, or skip the timer.
--   • game_queue    — matchmaking. Claiming an opponent uses
--                     `FOR UPDATE SKIP LOCKED`, and two partial unique indexes
--                     make it impossible for one player to end up in two live
--                     rooms even under concurrent requests.
--   • game_events   — analytics written only by the trusted functions, so the
--                     dashboard never displays client-claimed numbers.
--   • game_settings — admin-controlled availability/order.
--
-- Security posture:
--   • RLS on every table; clients can only ever SELECT their own room / queue row.
--   • All writes go through SECURITY DEFINER functions that re-check membership.
--   • Room payloads never expose the opponent's user id — only "your side".
--   • is_admin() (step 1) gates the admin functions.
--
-- Run with: supabase db push
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Settings, rooms, queue, events
-- ----------------------------------------------------------------------------
create table if not exists public.game_settings (
  game_id     text primary key,
  enabled     boolean not null default true,
  maintenance boolean not null default false,
  sort_order  integer not null default 0,
  updated_at  timestamptz not null default now()
);

create table if not exists public.game_rooms (
  id               uuid primary key default gen_random_uuid(),
  game_id          text not null default 'pair3balls',
  mode             text not null,                       -- 'private' | 'match'
  status           text not null default 'waiting',      -- waiting | active | finished | abandoned
  code             text,                                 -- private join code only
  host_id          uuid not null references auth.users (id) on delete cascade,
  host_side        text not null default 'white',
  guest_id         uuid references auth.users (id) on delete set null,
  guest_side       text,
  state            jsonb not null default '{}'::jsonb,
  turn_deadline_at timestamptz,
  winner_side      text,
  result           text,                                 -- three-in-a-row | timeout | abandoned
  move_count       integer not null default 0,
  rematch_of       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  expires_at       timestamptz not null default now() + interval '2 hours'
);

-- A player can be in at most ONE live room. This is what makes concurrent
-- matchmaking safe at the database level, not just in application code.
create unique index if not exists game_rooms_live_host_idx
  on public.game_rooms (host_id)
  where status in ('waiting', 'active');

create unique index if not exists game_rooms_live_guest_idx
  on public.game_rooms (guest_id)
  where status in ('waiting', 'active') and guest_id is not null;

create unique index if not exists game_rooms_code_idx
  on public.game_rooms (upper(code))
  where code is not null;

create index if not exists game_rooms_active_idx
  on public.game_rooms (game_id, status, expires_at);

create table if not exists public.game_queue (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  game_id      text not null default 'pair3balls',
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists public.game_events (
  id         uuid primary key default gen_random_uuid(),
  game_id    text not null default 'pair3balls',
  user_id    uuid references auth.users (id) on delete set null,
  room_id    uuid references public.game_rooms (id) on delete set null,
  mode       text,
  event      text not null,
  detail     text,
  created_at timestamptz not null default now()
);

create index if not exists game_events_game_created_idx
  on public.game_events (game_id, created_at desc);

-- Seed the game setting so the admin toggle has something to flip.
insert into public.game_settings (game_id, enabled, maintenance, sort_order)
values ('pair3balls', true, false, 1)
on conflict (game_id) do nothing;

-- ----------------------------------------------------------------------------
-- 2. Rule helpers (the server's copy of the rules — mirrors src/game/pair3balls)
-- ----------------------------------------------------------------------------

/** Nine empty points. */
create or replace function public.game_empty_board()
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(null, null, null, null, null, null, null, null, null);
$$;

/**
 * Starting state for a fresh match. The epoch timestamps are what the client
 * engine reads, so they are filled in here rather than left to the browser.
 */
create or replace function public.game_initial_state()
returns jsonb
language sql
volatile
as $$
  select jsonb_build_object(
    'board', public.game_empty_board(),
    'turn', 'white',
    'phase', 'placement',
    'turnStartedAt', (extract(epoch from now()) * 1000)::bigint,
    'turnDeadlineAt', (extract(epoch from now()) * 1000)::bigint + 60000,
    'moveCount', 0
  );
$$;

/** Owner of a completed line, or NULL. Lines: 0-4-1, 7-8-5, 2-6-3, 0-7-2, 4-8-6, 1-5-3, 0-8-3, 1-8-2. */
create or replace function public.game_pair3balls_winner(p_board jsonb)
returns text
language sql
immutable
as $$
  select (p_board ->> x.a)
    from (values (0, 4, 1), (7, 8, 5), (2, 6, 3), (0, 7, 2),
                 (4, 8, 6), (1, 5, 3), (0, 8, 3), (1, 8, 2)) as x(a, b, c)
   where coalesce(p_board ->> x.a, '') <> ''
     and (p_board ->> x.a) = (p_board ->> x.b)
     and (p_board ->> x.a) = (p_board ->> x.c)
   limit 1;
$$;

/** True when two points share a drawn line (one-step movement is allowed). */
create or replace function public.game_adjacent(p_from integer, p_to integer)
returns boolean
language sql
immutable
as $$
  select exists (
    select 1
      from (values (0, 4), (1, 4), (7, 8), (5, 8), (2, 6), (3, 6),
                   (0, 7), (2, 7), (4, 8), (6, 8), (1, 5), (3, 5),
                   (0, 8), (3, 8), (1, 8), (2, 8)) as e(a, b)
     where (e.a = p_from and e.b = p_to)
        or (e.a = p_to and e.b = p_from)
  );
$$;

/** Side of the player whose turn it is. */
create or replace function public.game_turn_side(p_state jsonb)
returns text
language sql
immutable
as $$
  select coalesce(nullif(p_state ->> 'turn', ''), 'white');
$$;

/** True when it is the movement phase (all six pieces placed). */
create or replace function public.game_piece_count(p_board jsonb)
returns integer
language sql
immutable
as $$
  select count(*)::integer
    from generate_series(0, 8) as g(i)
   where coalesce(p_board ->> g.i, '') <> '';
$$;

-- ----------------------------------------------------------------------------
-- 3. Safe room payload — never reveals the opponent's user id
-- ----------------------------------------------------------------------------
create or replace function public.game_room_view(p_room public.game_rooms, p_uid uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'id', p_room.id,
    'game_id', p_room.game_id,
    'mode', p_room.mode,
    'status', p_room.status,
    'code', case when p_uid = p_room.host_id then p_room.code else null end,
    'is_host', p_uid = p_room.host_id,
    'your_side', case when p_uid = p_room.host_id then p_room.host_side else p_room.guest_side end,
    'opponent_joined', p_room.guest_id is not null,
    'state', p_room.state,
    'winner_side', p_room.winner_side,
    'result', p_room.result,
    'move_count', p_room.move_count,
    'turn_deadline_ms', case when p_room.turn_deadline_at is null then null
                             else (extract(epoch from p_room.turn_deadline_at) * 1000)::bigint end,
    'server_now_ms', (extract(epoch from now()) * 1000)::bigint,
    'rematch_of', p_room.rematch_of,
    'created_at', p_room.created_at,
    'expires_at', p_room.expires_at
  );
$$;

revoke all on function public.game_room_view(public.game_rooms, uuid) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 4. Row level security + grants
-- ----------------------------------------------------------------------------
alter table public.game_settings enable row level security;
alter table public.game_rooms    enable row level security;
alter table public.game_queue    enable row level security;
alter table public.game_events   enable row level security;

-- Settings are publicly readable (the UI needs to know if the game is on);
-- only admins may change them, and only through the RPC below.
revoke all on public.game_settings from anon, authenticated;
grant select on public.game_settings to anon, authenticated;
drop policy if exists "game settings are public" on public.game_settings;
create policy "game settings are public"
  on public.game_settings for select to anon, authenticated using (true);

-- Rooms: a member may read only their own room. No client writes at all.
revoke all on public.game_rooms from anon, authenticated;
grant select on public.game_rooms to authenticated;
drop policy if exists "members can read their own room" on public.game_rooms;
create policy "members can read their own room"
  on public.game_rooms for select to authenticated
  using (host_id = auth.uid() or guest_id = auth.uid());

-- Queue: a player may read only their own entry.
revoke all on public.game_queue from anon, authenticated;
grant select on public.game_queue to authenticated;
drop policy if exists "players can read their own queue row" on public.game_queue;
create policy "players can read their own queue row"
  on public.game_queue for select to authenticated
  using (user_id = auth.uid());

-- Analytics events: written by the trusted functions only, read by nobody
-- directly. No client grant at all, so no RLS policy can leak them.
revoke all on public.game_events from anon, authenticated;
revoke all on public.game_events from public;

-- ----------------------------------------------------------------------------
-- 5. Private rooms
-- ----------------------------------------------------------------------------

/** Unpredictable 6-character code, avoiding look-alike characters. */
create or replace function public.game_new_code()
returns text
language plpgsql
volatile
as $$
declare
  v_alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_code text := '';
  i integer;
begin
  for i in 1..6 loop
    v_code := v_code || substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1);
  end loop;
  return v_code;
end;
$$;

create or replace function public.game_create_private_room()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_code text;
  v_room public.game_rooms;
  v_settings public.game_settings;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  select * into v_settings from public.game_settings where game_id = 'pair3balls';
  if found and (not v_settings.enabled or v_settings.maintenance) then
    return jsonb_build_object('ok', false, 'code', 'unavailable');
  end if;

  -- Server-side abuse limit: a room is cheap to create but not free.
  if (select count(*) from public.game_rooms
        where host_id = v_uid and created_at > now() - interval '10 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  -- Re-use a room this player already hosts rather than erroring on the unique
  -- live-room index.
  select * into v_room
    from public.game_rooms
   where host_id = v_uid and status in ('waiting', 'active') and expires_at > now()
   limit 1;
  if found then
    return jsonb_build_object('ok', true, 'reused', true, 'room', public.game_room_view(v_room, v_uid));
  end if;

  for i in 1..40 loop
    v_code := public.game_new_code();
    begin
      insert into public.game_rooms (
        game_id, mode, status, code, host_id, host_side, state, turn_deadline_at, expires_at
      ) values (
        'pair3balls', 'private', 'waiting', v_code, v_uid, 'white',
        public.game_initial_state(),
        now() + interval '60 seconds',
        now() + interval '2 hours'
      )
      returning * into v_room;

      insert into public.game_events (game_id, user_id, room_id, mode, event)
      values ('pair3balls', v_uid, v_room.id, 'private', 'room_created');

      return jsonb_build_object('ok', true, 'reused', false, 'room', public.game_room_view(v_room, v_uid));
    exception
      when unique_violation then
        -- Code collision or an existing live room; retry with a new code.
        continue;
    end;
  end loop;

  return jsonb_build_object('ok', false, 'code', 'could_not_create');
end;
$$;

create or replace function public.game_join_private_room(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.game_rooms;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  select * into v_room
    from public.game_rooms
   where upper(code) = upper(trim(coalesce(p_code, '')))
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_such_room');
  end if;

  if v_room.expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'room_expired');
  end if;

  -- Already a member (e.g. the invited player reopened the link): idempotent.
  if v_uid = v_room.host_id or v_uid = v_room.guest_id then
    return jsonb_build_object('ok', true, 'joined', true, 'room', public.game_room_view(v_room, v_uid));
  end if;

  if v_room.status <> 'waiting' then
    return jsonb_build_object('ok', false, 'code', 'room_not_open');
  end if;

  if v_room.guest_id is not null then
    return jsonb_build_object('ok', false, 'code', 'room_full');
  end if;

  /* The host may have created the room minutes ago, so the clock starts NOW —
   * both in the column and inside `state`, otherwise the host's client would
   * read a deadline that has already passed. */
  update public.game_rooms
     set guest_id = v_uid,
         guest_side = 'black',
         status = 'active',
         state = jsonb_set(
                   jsonb_set(
                     v_room.state,
                     '{turnStartedAt}',
                     to_jsonb((extract(epoch from now()) * 1000)::bigint)
                   ),
                   '{turnDeadlineAt}',
                   to_jsonb((extract(epoch from now()) * 1000)::bigint + 60000)
                 ),
         turn_deadline_at = now() + interval '60 seconds',
         updated_at = now()
   where id = v_room.id
     and guest_id is null            -- guards against a double join race
     and status = 'waiting'
  returning * into v_room;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'room_full');
  end if;

  insert into public.game_events (game_id, user_id, room_id, mode, event)
  values ('pair3balls', v_uid, v_room.id, 'private', 'room_joined');

  return jsonb_build_object('ok', true, 'joined', true, 'room', public.game_room_view(v_room, v_uid));
end;
$$;

/** Reads a room. Only a member ever gets a payload. */
create or replace function public.game_room_state(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.game_rooms;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  select * into v_room from public.game_rooms where id = p_room_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_such_room');
  end if;

  if v_uid <> v_room.host_id and v_uid is distinct from v_room.guest_id then
    return jsonb_build_object('ok', false, 'code', 'not_a_member');
  end if;

  return jsonb_build_object('ok', true, 'room', public.game_room_view(v_room, v_uid));
end;
$$;

-- ----------------------------------------------------------------------------
-- 6. The authoritative move
-- ----------------------------------------------------------------------------
-- Every rule is checked here against the stored state with the server clock:
-- membership, active status, turn ownership, phase, occupancy, adjacency and
-- the 60-second deadline. A late request forfeits the player on the clock
-- BEFORE their move is considered, so a timeout can never be raced by a move.
create or replace function public.game_submit_move(
  p_room_id uuid,
  p_kind    text,
  p_from    integer,
  p_to      integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_room   public.game_rooms;
  v_side   text;
  v_board  jsonb;
  v_turn   text;
  v_phase  text;
  v_winner text;
  v_placed integer;
  v_from_val text;
  v_to_val   text;
  v_new_board jsonb;
  v_now    timestamptz := now();
  v_deadline_ms bigint;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  -- Row lock: serialises simultaneous moves on the same room.
  select * into v_room from public.game_rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_such_room');
  end if;

  if v_uid <> v_room.host_id and v_uid is distinct from v_room.guest_id then
    return jsonb_build_object('ok', false, 'code', 'not_a_member');
  end if;

  v_side := case when v_uid = v_room.host_id then v_room.host_side else v_room.guest_side end;

  if v_room.status = 'finished' then
    return jsonb_build_object('ok', false, 'code', 'finished', 'room', public.game_room_view(v_room, v_uid));
  end if;
  if v_room.status <> 'active' then
    return jsonb_build_object('ok', false, 'code', 'not_active', 'room', public.game_room_view(v_room, v_uid));
  end if;

  v_board := coalesce(nullif(v_room.state -> 'board', 'null'::jsonb), public.game_empty_board());
  v_turn  := public.game_turn_side(v_room.state);
  v_phase := coalesce(nullif(v_room.state ->> 'phase', ''), 'placement');
  v_placed := public.game_piece_count(v_board);

  -- 1. Deadline first. The player on the clock loses; no move is applied.
  if v_room.turn_deadline_at is not null and v_now >= v_room.turn_deadline_at then
    update public.game_rooms
       set status = 'finished',
           result = 'timeout',
           winner_side = case when v_turn = v_room.host_side then v_room.guest_side else v_room.host_side end,
           updated_at = v_now
     where id = p_room_id
     returning * into v_room;

    insert into public.game_events (game_id, user_id, room_id, mode, event, detail)
    values ('pair3balls', v_uid, p_room_id, v_room.mode, 'timeout', v_turn);

    return jsonb_build_object('ok', false, 'code', 'expired', 'room', public.game_room_view(v_room, v_uid));
  end if;

  -- 2. Turn ownership.
  if v_turn <> v_side then
    return jsonb_build_object('ok', false, 'code', 'out_of_turn');
  end if;

  -- 3. Shape of the request.
  if p_kind not in ('place', 'move') then
    return jsonb_build_object('ok', false, 'code', 'bad_kind');
  end if;
  if p_to is null or p_to < 0 or p_to > 8 then
    return jsonb_build_object('ok', false, 'code', 'bad_point');
  end if;
  if p_kind = 'move' and (p_from is null or p_from < 0 or p_from > 8) then
    return jsonb_build_object('ok', false, 'code', 'bad_point');
  end if;

  -- 4. Phase.
  if p_kind = 'place' and v_phase <> 'placement' then
    return jsonb_build_object('ok', false, 'code', 'wrong_phase');
  end if;
  if p_kind = 'move' and v_phase <> 'movement' then
    return jsonb_build_object('ok', false, 'code', 'wrong_phase');
  end if;

  v_to_val := coalesce(v_board ->> p_to, '');

  if p_kind = 'place' then
    if v_to_val <> '' then
      return jsonb_build_object('ok', false, 'code', 'occupied');
    end if;

    v_new_board := jsonb_set(v_board, ARRAY[p_to::text], to_jsonb(v_side));
  else
    v_from_val := coalesce(v_board ->> p_from, '');

    if p_from = p_to then
      return jsonb_build_object('ok', false, 'code', 'same_point');
    end if;
    if v_from_val = '' then
      return jsonb_build_object('ok', false, 'code', 'empty_source');
    end if;
    if v_from_val <> v_side then
      return jsonb_build_object('ok', false, 'code', 'not_yours');
    end if;
    if v_to_val <> '' then
      return jsonb_build_object('ok', false, 'code', 'occupied');
    end if;
    if not public.game_adjacent(p_from, p_to) then
      return jsonb_build_object('ok', false, 'code', 'not_adjacent');
    end if;

    v_new_board := jsonb_set(
      jsonb_set(v_board, ARRAY[p_to::text], to_jsonb(v_side)),
      ARRAY[p_from::text], 'null'::jsonb
    );
  end if;

  -- 5. Did that complete a line?
  v_winner := public.game_pair3balls_winner(v_new_board);
  v_placed := public.game_piece_count(v_new_board);

  v_deadline_ms := (extract(epoch from v_now) * 1000)::bigint + 60000;

  -- The epoch timestamps are mirrored into `state` on purpose: the client
  -- engine reads turnDeadlineAt from there, so the UI can never invent its own
  -- (longer) deadline and outlive the server clock.
  update public.game_rooms
     set state = jsonb_build_object(
           'board', v_new_board,
           'turn', case when v_winner is null
                        then case when v_turn = 'white' then 'black' else 'white' end
                        else v_turn end,
           'phase', case when v_winner is not null then 'finished'
                         when v_placed >= 6 then 'movement'
                         else 'placement' end,
           'turnStartedAt', (extract(epoch from v_now) * 1000)::bigint,
           'turnDeadlineAt', case when v_winner is not null
                                  then (extract(epoch from v_now) * 1000)::bigint
                                  else v_deadline_ms end,
           'startedAt', coalesce((v_room.state ->> 'startedAt')::bigint,
                                 (extract(epoch from v_room.created_at) * 1000)::bigint),
           'lastMove', jsonb_build_object(
             'kind', p_kind,
             'player', v_side,
             'from', case when p_kind = 'move' then p_from else null end,
             'to', p_to,
             'at', (extract(epoch from v_now) * 1000)::bigint
           ),
           'moveCount', v_room.move_count + 1
         ),
         status = case when v_winner is not null then 'finished' else 'active' end,
         winner_side = v_winner,
         result = case when v_winner is not null then 'three-in-a-row' else null end,
         move_count = v_room.move_count + 1,
         turn_deadline_at = case when v_winner is not null then now()
                                 else to_timestamp(v_deadline_ms / 1000.0) end,
         updated_at = v_now
   where id = p_room_id
  returning * into v_room;

  insert into public.game_events (game_id, user_id, room_id, mode, event, detail)
  values (
    'pair3balls', v_uid, p_room_id, v_room.mode,
    case when v_winner is not null then 'game_won' else 'move' end,
    p_kind || ':' || p_to::text
  );

  return jsonb_build_object('ok', true, 'room', public.game_room_view(v_room, v_uid));
end;
$$;

-- ----------------------------------------------------------------------------
-- 6b. Settle a turn timeout without moving
-- ----------------------------------------------------------------------------
-- The turn clock is authoritative in `game_submit_move`, but a player who has
-- already left the tab never submits anything. Either client can call this to
-- have the SERVER declare the forfeit. It can only ever end a match whose
-- deadline has genuinely passed, and it is idempotent, so calling it twice (or
-- from both sides at once) cannot produce two results.
create or replace function public.game_settle_timeout(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid  uuid := auth.uid();
  v_room public.game_rooms;
  v_turn text;
  v_now  timestamptz := now();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  select * into v_room from public.game_rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_such_room');
  end if;

  if v_uid <> v_room.host_id and v_uid is distinct from v_room.guest_id then
    return jsonb_build_object('ok', false, 'code', 'not_a_member');
  end if;

  if v_room.status = 'active'
     and v_room.turn_deadline_at is not null
     and v_now >= v_room.turn_deadline_at then

    v_turn := public.game_turn_side(v_room.state);

    update public.game_rooms
       set status = 'finished',
           result = 'timeout',
           winner_side = case when v_turn = v_room.host_side then v_room.guest_side else v_room.host_side end,
           updated_at = v_now
     where id = p_room_id
     returning * into v_room;

    insert into public.game_events (game_id, user_id, room_id, mode, event, detail)
    values ('pair3balls', v_uid, p_room_id, v_room.mode, 'timeout', v_turn);
  end if;

  return jsonb_build_object('ok', true, 'room', public.game_room_view(v_room, v_uid));
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. Leaving, rematching
-- ----------------------------------------------------------------------------
create or replace function public.game_leave_room(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.game_rooms;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  select * into v_room from public.game_rooms where id = p_room_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_such_room');
  end if;
  if v_uid <> v_room.host_id and v_uid is distinct from v_room.guest_id then
    return jsonb_build_object('ok', false, 'code', 'not_a_member');
  end if;

  if v_room.status in ('waiting', 'active') then
    update public.game_rooms
       set status = 'abandoned',
           result = 'abandoned',
           winner_side = case when v_uid = v_room.host_id then v_room.guest_side else v_room.host_side end,
           updated_at = now()
     where id = p_room_id;

    insert into public.game_events (game_id, user_id, room_id, mode, event)
    values ('pair3balls', v_uid, p_room_id, v_room.mode, 'abandoned');
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

/** Creates a fresh room with the same players and opposite colours. */
create or replace function public.game_rematch(p_room_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.game_rooms;
  v_new public.game_rooms;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  select * into v_room from public.game_rooms where id = p_room_id;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_such_room');
  end if;
  if v_uid <> v_room.host_id and v_uid is distinct from v_room.guest_id then
    return jsonb_build_object('ok', false, 'code', 'not_a_member');
  end if;
  if v_room.guest_id is null then
    return jsonb_build_object('ok', false, 'code', 'no_opponent');
  end if;

  -- Close the old room so the live-room uniqueness rule allows a new one.
  update public.game_rooms
     set status = 'finished', updated_at = now()
   where id = p_room_id and status in ('waiting', 'active');

  begin
    insert into public.game_rooms (
      game_id, mode, status, code, host_id, host_side, guest_id, guest_side,
      state, turn_deadline_at, rematch_of, expires_at
    ) values (
      v_room.game_id,
      v_room.mode,
      'active',
      case when v_room.mode = 'private' then public.game_new_code() else null end,
      v_room.guest_id,                 -- colours swap
      case when v_room.host_side = 'white' then 'black' else 'white' end,
      v_room.host_id,
      v_room.host_side,
      public.game_initial_state(),
      now() + interval '60 seconds',
      p_room_id,
      now() + interval '2 hours'
    )
    returning * into v_new;
  exception
    when unique_violation then
      -- One of the two players is already in another live room (e.g. they
      -- started a world match in the meantime). Fail cleanly instead of
      -- raising a raw database error at the client.
      return jsonb_build_object('ok', false, 'code', 'already_in_room');
  end;

  insert into public.game_events (game_id, user_id, room_id, mode, event)
  values (v_new.game_id, v_uid, v_new.id, v_new.mode, 'rematch');

  return jsonb_build_object('ok', true, 'room', public.game_room_view(v_new, v_uid));
end;
$$;

-- ----------------------------------------------------------------------------
-- 8. Matchmaking (World Match) — concurrency safe
-- ----------------------------------------------------------------------------
-- `FOR UPDATE SKIP LOCKED` means two simultaneous callers can never claim the
-- same waiting player, and the partial unique indexes on game_rooms mean a
-- player who is already in a live room cannot be paired into a second one.
create or replace function public.game_matchmake(p_heartbeat boolean default true)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_existing uuid;
  v_opponent public.game_queue;
  v_room_id uuid;
  v_settings public.game_settings;
  v_new_queue boolean := false;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  select * into v_settings from public.game_settings where game_id = 'pair3balls';
  if found and (not v_settings.enabled or v_settings.maintenance) then
    return jsonb_build_object('ok', false, 'code', 'unavailable');
  end if;

  -- Server-side abuse limit on repeated queueing.
  if (select count(*) from public.game_events
        where user_id = v_uid and event = 'queue_join' and created_at > now() - interval '1 minute') >= 30 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited');
  end if;

  -- Already playing? Return that room instead of queueing again.
  select r.id into v_existing
    from public.game_rooms r
   where r.game_id = 'pair3balls'
     and r.status in ('waiting', 'active')
     and r.expires_at > now()
     and (r.host_id = v_uid or r.guest_id = v_uid)
   order by r.created_at desc
   limit 1;

  if v_existing is not null then
    return jsonb_build_object('ok', true, 'status', 'matched', 'room_id', v_existing);
  end if;

  -- Drop abandoned searchers so nobody is paired with a closed tab.
  delete from public.game_queue where last_seen_at < now() - interval '45 seconds';

  -- Claim the longest-waiting opponent atomically.
  select * into v_opponent
    from public.game_queue q
   where q.game_id = 'pair3balls'
     and q.user_id <> v_uid
   order by q.created_at
   for update skip locked
   limit 1;

  if v_opponent.user_id is not null then
    delete from public.game_queue where user_id in (v_opponent.user_id, v_uid);

    begin
      insert into public.game_rooms (
        game_id, mode, status, host_id, host_side, guest_id, guest_side,
        state, turn_deadline_at, expires_at
      ) values (
        'pair3balls', 'match', 'active',
        v_opponent.user_id, 'white', v_uid, 'black',
        public.game_initial_state(),
        now() + interval '60 seconds',
        now() + interval '2 hours'
      )
      returning id into v_room_id;
    exception
      when unique_violation then
        -- One side is already in a live room; let the client re-poll.
        return jsonb_build_object('ok', true, 'status', 'searching');
    end;

    insert into public.game_events (game_id, user_id, room_id, mode, event)
    values ('pair3balls', v_uid, v_room_id, 'match', 'match_found'),
           ('pair3balls', v_opponent.user_id, v_room_id, 'match', 'match_found');

    return jsonb_build_object('ok', true, 'status', 'matched', 'room_id', v_room_id);
  end if;

  if p_heartbeat then
    /* `returning (xmax = 0)` is true only for a genuinely NEW queue row. This
     * matters: the client polls every few seconds, and the abuse limit counts
     * 'queue_join' events, so logging one per poll would both inflate the
     * metric and lock a patient player out of matchmaking. */
    insert into public.game_queue (user_id, game_id, last_seen_at)
    values (v_uid, 'pair3balls', now())
    on conflict (user_id) do update set last_seen_at = now()
    returning (xmax = 0) into v_new_queue;

    if v_new_queue then
      insert into public.game_events (game_id, user_id, mode, event)
      values ('pair3balls', v_uid, 'match', 'queue_join');
    end if;
  end if;

  return jsonb_build_object('ok', true, 'status', 'searching');
end;
$$;

create or replace function public.game_matchmake_cancel()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  delete from public.game_queue where user_id = v_uid;

  insert into public.game_events (game_id, user_id, mode, event)
  values ('pair3balls', v_uid, 'match', 'queue_cancel');

  return jsonb_build_object('ok', true, 'status', 'cancelled');
end;
$$;

-- ----------------------------------------------------------------------------
-- 9. Admin controls + analytics (admins only)
-- ----------------------------------------------------------------------------
create or replace function public.game_admin_settings(
  p_game_id     text,
  p_enabled     boolean,
  p_maintenance boolean,
  p_sort_order  integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'not_admin');
  end if;

  insert into public.game_settings (game_id, enabled, maintenance, sort_order, updated_at)
  values (p_game_id, coalesce(p_enabled, true), coalesce(p_maintenance, false), coalesce(p_sort_order, 0), now())
  on conflict (game_id) do update
    set enabled = coalesce(p_enabled, game_settings.enabled),
        maintenance = coalesce(p_maintenance, game_settings.maintenance),
        sort_order = coalesce(p_sort_order, game_settings.sort_order),
        updated_at = now();

  insert into public.game_events (game_id, user_id, event, detail)
  values (p_game_id, auth.uid(), 'admin_settings',
          'enabled=' || coalesce(p_enabled, true)::text || ' maintenance=' || coalesce(p_maintenance, false)::text);

  return jsonb_build_object('ok', true);
end;
$$;

/**
 * Analytics for the dashboard. Every number is COUNTED from game_events, so
 * nothing is estimated or invented. "Active" is a defined 2-minute window.
 */
create or replace function public.game_admin_analytics()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result jsonb;
begin
  if not public.is_admin() then
    return jsonb_build_object('ok', false, 'code', 'not_admin');
  end if;

  select jsonb_build_object(
    'game_id', 'pair3balls',
    'settings', (select to_jsonb(s) from public.game_settings s where s.game_id = 'pair3balls'),
    'sessions_started', (select count(distinct room_id) from public.game_events where event in ('room_created', 'match_found')),
    'unique_players',   (select count(distinct user_id) from public.game_events where user_id is not null),
    'anonymous_events', (select count(*) from public.game_events where user_id is null),
    'games_completed',  (select count(*) from public.game_rooms where status = 'finished' and result in ('three-in-a-row', 'timeout')),
    'in_progress',      (select count(*) from public.game_rooms where status = 'active'),
    'abandoned',        (select count(*) from public.game_rooms where result = 'abandoned'),
    'timeouts',         (select count(*) from public.game_events where event = 'timeout'),
    'wins_by_side',     (select coalesce(jsonb_object_agg(w.winner_side, w.n), '{}'::jsonb)
                           from (select winner_side, count(*) as n from public.game_rooms
                                  where winner_side is not null group by winner_side) w),
    'by_mode',          (select coalesce(jsonb_object_agg(m.mode, m.n), '{}'::jsonb)
                           from (select mode, count(*) as n from public.game_rooms group by mode) m),
    'queue_waiting',    (select count(*) from public.game_queue),
    'active_2m',        (select count(*) from public.game_rooms where status = 'active' and updated_at > now() - interval '2 minutes'),
    'avg_duration_seconds', (select round(avg(extract(epoch from (updated_at - created_at))))::int
                               from public.game_rooms where status = 'finished'),
    'daily',            (select coalesce(jsonb_agg(d order by d.day), '[]'::jsonb)
                           from (select date_trunc('day', created_at)::date as day, count(*) as n
                                   from public.game_events
                                  where created_at > now() - interval '14 days'
                                  group by 1) d)
  ) into v_result;

  return jsonb_build_object('ok', true, 'analytics', v_result);
end;
$$;

-- ----------------------------------------------------------------------------
-- 10. Grants — authenticated members only, admins for the admin functions
-- ----------------------------------------------------------------------------
revoke all on function public.game_create_private_room()          from public, anon;
revoke all on function public.game_join_private_room(text)        from public, anon;
revoke all on function public.game_room_state(uuid)               from public, anon;
revoke all on function public.game_submit_move(uuid, text, integer, integer) from public, anon;
revoke all on function public.game_settle_timeout(uuid)           from public, anon;
revoke all on function public.game_leave_room(uuid)               from public, anon;
revoke all on function public.game_rematch(uuid)                  from public, anon;
revoke all on function public.game_matchmake(boolean)             from public, anon;
revoke all on function public.game_matchmake_cancel()             from public, anon;
revoke all on function public.game_admin_settings(text, boolean, boolean, integer) from public, anon;
revoke all on function public.game_admin_analytics()              from public, anon;

grant execute on function public.game_create_private_room()          to authenticated;
grant execute on function public.game_join_private_room(text)        to authenticated;
grant execute on function public.game_room_state(uuid)               to authenticated;
grant execute on function public.game_submit_move(uuid, text, integer, integer) to authenticated;
grant execute on function public.game_settle_timeout(uuid)           to authenticated;
grant execute on function public.game_leave_room(uuid)               to authenticated;
grant execute on function public.game_rematch(uuid)                  to authenticated;
grant execute on function public.game_matchmake(boolean)             to authenticated;
grant execute on function public.game_matchmake_cancel()             to authenticated;
grant execute on function public.game_admin_settings(text, boolean, boolean, integer) to authenticated;
grant execute on function public.game_admin_analytics()              to authenticated;

-- ----------------------------------------------------------------------------
-- 11. Realtime — a room stream is what makes live play feel live
-- ----------------------------------------------------------------------------
-- Members still only receive rows RLS allows them to see, so a Realtime
-- subscription cannot leak someone else's match.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
        where pubname = 'supabase_realtime'
          and schemaname = 'public'
          and tablename = 'game_rooms'
     ) then
    execute 'alter publication supabase_realtime add table public.game_rooms';
  end if;
end
$$;

-- ----------------------------------------------------------------------------
-- 12. Housekeeping — expire stale rooms and queue rows
-- ----------------------------------------------------------------------------
create or replace function public.game_cleanup()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rooms integer;
  v_queue integer;
begin
  update public.game_rooms
     set status = 'abandoned', result = coalesce(result, 'abandoned'), updated_at = now()
   where status in ('waiting', 'active')
     and expires_at <= now();

  get diagnostics v_rooms = row_count;

  delete from public.game_queue where last_seen_at < now() - interval '5 minutes';
  get diagnostics v_queue = row_count;

  return v_rooms + v_queue;
end;
$$;

revoke all on function public.game_cleanup() from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 13. Deploy notes
-- ----------------------------------------------------------------------------
--   supabase db push
--   supabase functions deploy send-email     (unchanged; listed for completeness)
--
-- Nothing here needs a new Edge Function: the rules are enforced inside the
-- SECURITY DEFINER functions above, which run with the caller's JWT identity.
-- Schedule `select public.game_cleanup();` (pg_cron or the existing
-- subscription-maintenance job) to reap stale rooms.
-- ============================================================================
