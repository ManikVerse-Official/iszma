-- ============================================================================
-- Pair-3Balls · repetition draw
-- ----------------------------------------------------------------------------
-- The client engine (`src/game/pair3balls/engine.ts`) now ends a game as a draw
-- when the identical move (same side, same piece, same destination) is played
-- more than three times. Online modes are decided by `game_submit_move`, so the
-- server must apply exactly the same rule — otherwise Private Room and World
-- Match would let two players shuffle the same two pieces forever while the
-- offline modes drew.
--
-- How it is counted
--   `state.repeats` is a jsonb map of "<kind>:<from|->:<to>:<side>" -> count.
--   Counts live in the room state, so they survive reconnects and rematches
--   start from a fresh room (fresh state) like everything else.
--
-- What changes in the result
--   The 4th occurrence of a move is still APPENDED (the board shows what was
--   played) but the room finishes with `winner_side = null` and
--   `result = 'repetition'`. A draw therefore has no winner for either side,
--   which is what `game_room_view` already reports.
--
-- This migration only replaces the function; no table, policy or grant changes,
-- no data rewrite, and it is safe to run on a live database (CREATE OR REPLACE).
-- ============================================================================

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
  v_repeats jsonb;
  v_key    text;
  v_repeat integer;
  v_draw   boolean := false;
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

  /* 6. Repetition: the identical move (same side, same piece, same target)
   *    may appear three times. The fourth is applied and drawn — a win on the
   *    same move still wins, because a line is never overridden. */
  v_key := p_kind || ':' || coalesce(p_from::text, '-') || ':' || p_to::text || ':' || v_side;
  v_repeats := coalesce(nullif(v_room.state -> 'repeats', 'null'::jsonb), '{}'::jsonb);
  v_repeat := coalesce((v_repeats ->> v_key)::int, 0) + 1;
  v_draw := v_winner is null and v_repeat > 3;

  v_deadline_ms := (extract(epoch from v_now) * 1000)::bigint + 60000;

  -- The epoch timestamps are mirrored into `state` on purpose: the client
  -- engine reads turnDeadlineAt from there, so the UI can never invent its own
  -- (longer) deadline and outlive the server clock.
  update public.game_rooms
     set state = jsonb_build_object(
           'board', v_new_board,
           'turn', case when v_winner is not null or v_draw
                        then v_turn
                        else case when v_turn = 'white' then 'black' else 'white' end end,
           'phase', case when v_winner is not null or v_draw then 'finished'
                         when v_placed >= 6 then 'movement'
                         else 'placement' end,
           'turnStartedAt', (extract(epoch from v_now) * 1000)::bigint,
           'turnDeadlineAt', case when v_winner is not null or v_draw
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
           'moveCount', v_room.move_count + 1,
           'repeats', jsonb_set(v_repeats, ARRAY[v_key], to_jsonb(v_repeat), true)
         ),
         status = case when v_winner is not null or v_draw then 'finished' else 'active' end,
         winner_side = v_winner,
         result = case when v_winner is not null then 'three-in-a-row'
                       when v_draw then 'repetition'
                       else null end,
         move_count = v_room.move_count + 1,
         turn_deadline_at = case when v_winner is not null or v_draw then now()
                                 else to_timestamp(v_deadline_ms / 1000.0) end,
         updated_at = v_now
   where id = p_room_id
  returning * into v_room;

  insert into public.game_events (game_id, user_id, room_id, mode, event, detail)
  values (
    'pair3balls', v_uid, p_room_id, v_room.mode,
    case when v_winner is not null then 'game_won'
         when v_draw then 'game_drawn'
         else 'move' end,
    p_kind || ':' || p_to::text
  );

  return jsonb_build_object('ok', true, 'room', public.game_room_view(v_room, v_uid));
end;
$$;
