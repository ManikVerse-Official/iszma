-- ============================================================================
-- Ishmaverse · Step 20 — admin bypass for games + secure Studio free limits
-- ----------------------------------------------------------------------------
-- Two changes, both additive. Not applied automatically: run with
--   supabase db push
-- only after explicit approval.
--
-- 1. GAMES — an authenticated admin can use the Game Zone even while the game is
--    switched off / in maintenance. The gate is still server-side and still
--    identity-based (`public.is_admin()`, which reads `admin_users` for
--    `auth.uid()`); nothing is trusted from the browser.
--
--    Both functions are re-created verbatim from step 15 with that single extra
--    clause. No other rule (rate limits, turn ownership, results) changes.
--
-- 2. REPORT CARD STUDIO — each normal user gets SEVEN free generations per EMAIL
--    and per DEVICE, enforced atomically in the database.
--
--    Reuses the existing `usage_events` table from step 9 (no duplicate usage
--    table) and adds:
--      • `usage_events.device_key`, `.user_id`, `.run_id` (+ one unique run id,
--        so retrying/duplicating a request can never count a generation twice),
--      • `studio_devices` — one row per registered device, identified by an
--        HMAC of the browser's device id (the raw id and the secret never meet),
--        plus a server-computed fingerprint of the request's own headers,
--      • `consume_studio_generation(...)` — advisory-locked check-and-claim,
--        counting the same generation against BOTH the email and the device,
--      • `register_studio_device(...)` and `release_studio_claim(...)`.
--
--    Device identity — and its honest limits
--    ---------------------------------------
--    The browser generates a random id and asks `entitlement` to register it.
--    The server stores only `HMAC_DEVICE_SECRET(device id)` and hands the browser
--    a token signed with the same secret, so a made-up id is rejected: a client
--    cannot mint a device the server never issued.
--
--    A web page has no stable hardware identifier. So:
--      • clearing site data / a different browser or profile produces a NEW
--        device, which is why the fingerprint cap (below) exists;
--      • the fingerprint (user agent, locale, timezone, screen, platform) is
--        coarse and can collide between two identical school machines, so it is
--        used only as a CAP, never as the primary identity;
--      • the email is supplied by the user (ReportCard Studio has no email
--        verification), so it is a claim, not a proof — it is still worth
--        counting, because changing it on the same device must not reset the
--        device allowance, and the device cap stops the reverse trick.
--    Both counters therefore have to pass. A verified Supabase session, when one
--    is present, is recorded as well (`user_id`) and is the only hard identity.
--
--    Caps that stop "clear storage to reset" loops:
--      • at most `p_devices_per_fingerprint` (default 3) DEVICES with claims per
--        fingerprint,
--      • at most `p_fingerprints_per_email` (default 5) fingerprints with claims
--        per email.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Game Zone — admins can play while the game is off / in maintenance
-- ----------------------------------------------------------------------------
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
  /* Admin bypass: the owner/staff may open a room even while it is disabled. */
  if found and (not v_settings.enabled or v_settings.maintenance) and not public.is_admin() then
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
  /* Admin bypass: the owner/staff may match even while it is disabled. */
  if found and (not v_settings.enabled or v_settings.maintenance) and not public.is_admin() then
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

-- Same grants as before (CREATE OR REPLACE keeps them; restated for clarity).
revoke all on function public.game_create_private_room() from public, anon;
revoke all on function public.game_matchmake(boolean) from public, anon;
grant execute on function public.game_create_private_room() to authenticated;
grant execute on function public.game_matchmake(boolean) to authenticated;

-- ----------------------------------------------------------------------------
-- 2. Studio usage: the extra identity columns (idempotent, additive)
-- ----------------------------------------------------------------------------
alter table public.usage_events add column if not exists device_key text;
alter table public.usage_events add column if not exists user_id uuid;
alter table public.usage_events add column if not exists run_id text;

create index if not exists usage_events_feature_device_idx
  on public.usage_events (feature, device_key);
create index if not exists usage_events_feature_user_idx
  on public.usage_events (feature, user_id);

-- One generation = one row. A retried request carrying the same run id cannot
-- be counted twice, even if it raced the first one.
create unique index if not exists usage_events_feature_run_idx
  on public.usage_events (feature, run_id)
  where run_id is not null;

-- ----------------------------------------------------------------------------
-- 3. Studio devices (registered identities, service-role only)
-- ----------------------------------------------------------------------------
create table if not exists public.studio_devices (
  -- HMAC(secret, browser device id). The raw id is never stored.
  device_key    text primary key,
  -- HMAC(secret, server-side fingerprint of the request headers).
  fingerprint   text not null default '',
  user_id       uuid,
  email         text,
  ip            text,
  claim_count   integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  revoked       boolean not null default false
);

create index if not exists studio_devices_fingerprint_idx
  on public.studio_devices (fingerprint);
create index if not exists studio_devices_email_idx
  on public.studio_devices (lower(email));

alter table public.studio_devices enable row level security;
revoke all on public.studio_devices from anon, authenticated;
revoke all on public.studio_devices from public;
grant all on public.studio_devices to service_role;

-- ----------------------------------------------------------------------------
-- 4. Register (or refresh) a device
-- ----------------------------------------------------------------------------
create or replace function public.register_studio_device(
  p_device_key text,
  p_fingerprint text,
  p_user_id uuid,
  p_email text,
  p_ip text
)
returns table (devices_on_fingerprint integer, claim_count integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device text := btrim(coalesce(p_device_key, ''));
  v_fingerprint text := btrim(coalesce(p_fingerprint, ''));
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  if v_device = '' then
    raise exception 'register_studio_device requires a device key';
  end if;

  if v_fingerprint = '' then
    raise exception 'register_studio_device requires a fingerprint';
  end if;

  insert into public.studio_devices (device_key, fingerprint, user_id, email, ip)
  values (v_device, v_fingerprint, p_user_id, nullif(v_email, ''), nullif(btrim(coalesce(p_ip, '')), ''))
  on conflict (device_key) do update
    set last_seen_at = now(),
        fingerprint = excluded.fingerprint,
        email = coalesce(excluded.email, public.studio_devices.email),
        user_id = coalesce(excluded.user_id, public.studio_devices.user_id),
        ip = coalesce(excluded.ip, public.studio_devices.ip);

  return query
    select count(*)::integer, coalesce(max(d.claim_count), 0)::integer
      from public.studio_devices d
     where d.fingerprint = v_fingerprint
       and d.device_key = v_device;
end;
$$;

comment on function public.register_studio_device(text, text, uuid, text, text)
  is 'Registers/refreshes one Studio device (HMAC key + fingerprint). Service role only.';

-- ----------------------------------------------------------------------------
-- 5. Atomic claim: seven free generations per EMAIL and per DEVICE
-- ----------------------------------------------------------------------------
create or replace function public.consume_studio_generation(
  p_email text,
  p_user_id uuid,
  p_device_key text,
  p_fingerprint text,
  p_ip text,
  p_run_id text,
  p_per_email integer,
  p_per_device integer,
  p_devices_per_fingerprint integer default 3,
  p_fingerprints_per_email integer default 5
)
returns table (
  allowed boolean,
  code text,
  message text,
  remaining integer,
  remaining_device integer,
  claim_id uuid,
  already_claimed boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_feature constant text := 'studio_generation';
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_device text := btrim(coalesce(p_device_key, ''));
  v_fingerprint text := btrim(coalesce(p_fingerprint, ''));
  v_run text := nullif(btrim(coalesce(p_run_id, '')), '');
  v_email_limit integer := greatest(1, coalesce(p_per_email, 7));
  v_device_limit integer := greatest(1, coalesce(p_per_device, 7));
  v_devices_per_fingerprint integer := greatest(1, coalesce(p_devices_per_fingerprint, 3));
  v_fingerprints_per_email integer := greatest(1, coalesce(p_fingerprints_per_email, 5));
  v_email_count integer := 0;
  v_device_count integer := 0;
  v_fp_devices integer := 0;
  v_email_fingerprints integer := 0;
  v_claim uuid;
begin
  if v_email = '' then
    return query select false, 'INVALID_REQUEST',
      'A valid email address is required.', 0, 0, null::uuid, false;
    return;
  end if;

  if v_device = '' then
    return query select false, 'DEVICE_REQUIRED',
      'This device could not be identified, so a free generation cannot be granted.', 0, 0, null::uuid, false;
    return;
  end if;

  -- Serialise by email first, then device (fixed order, so no deadlock).
  perform pg_advisory_xact_lock(hashtext('studio:email:' || v_email)::bigint);
  perform pg_advisory_xact_lock(hashtext('studio:device:' || v_device)::bigint);

  -- Idempotency: the same run id is ONE generation, whatever it retries.
  if v_run is not null then
    select ue.id into v_claim
      from public.usage_events ue
     where ue.feature = v_feature and ue.run_id = v_run
     limit 1;

    if v_claim is not null then
      select count(*) into v_email_count
        from public.usage_events ue
       where ue.feature = v_feature and lower(ue.email) = v_email;
      select count(*) into v_device_count
        from public.usage_events ue
       where ue.feature = v_feature and ue.device_key = v_device;

      return query select true, null::text, null::text,
        greatest(v_email_limit - v_email_count, 0),
        greatest(v_device_limit - v_device_count, 0),
        v_claim, true;
      return;
    end if;
  end if;

  -- Track the device on every attempt, but only a real claim raises claim_count.
  insert into public.studio_devices (device_key, fingerprint, user_id, email, ip)
  values (v_device, v_fingerprint, p_user_id, v_email, nullif(btrim(coalesce(p_ip, '')), ''))
  on conflict (device_key) do update
    set last_seen_at = now(),
        fingerprint = case
          when excluded.fingerprint <> '' then excluded.fingerprint
          else public.studio_devices.fingerprint
        end,
        email = excluded.email,
        user_id = coalesce(excluded.user_id, public.studio_devices.user_id);

  select count(*) into v_email_count
    from public.usage_events ue
   where ue.feature = v_feature and lower(ue.email) = v_email;

  select count(*) into v_device_count
    from public.usage_events ue
   where ue.feature = v_feature and ue.device_key = v_device;

  if v_email_count >= v_email_limit then
    return query select false, 'FREE_LIMIT_EMAIL',
      'This email has used all its free report-card generations. Subscribe for unlimited report cards, or use a plan that is already active.',
      0, greatest(v_device_limit - v_device_count, 0), null::uuid, false;
    return;
  end if;

  if v_device_count >= v_device_limit then
    return query select false, 'FREE_LIMIT_DEVICE',
      'This device has used all its free report-card generations. Subscribe to continue on this device.',
      greatest(v_email_limit - v_email_count, 0), 0, null::uuid, false;
    return;
  end if;

  /*
   * Reset resistance. A cleared browser is a new device id, so cap how many
   * devices may claim from one fingerprint, and how many fingerprints one email
   * may claim from. Both counts ignore the attempted device itself.
   */
  if v_fingerprint <> '' then
    select count(distinct d.device_key) into v_fp_devices
      from public.studio_devices d
     where d.fingerprint = v_fingerprint
       and d.device_key <> v_device
       and d.claim_count > 0;

    if v_fp_devices >= v_devices_per_fingerprint then
      return query select false, 'FREE_LIMIT_DEVICE',
        'Too many browsers on this device have already used the free generations. Subscribe to continue.',
        greatest(v_email_limit - v_email_count, 0), 0, null::uuid, false;
      return;
    end if;

    select count(distinct d.fingerprint) into v_email_fingerprints
      from public.studio_devices d
     where lower(coalesce(d.email, '')) = v_email
       and d.fingerprint <> v_fingerprint
       and d.claim_count > 0;

    if v_email_fingerprints >= v_fingerprints_per_email then
      return query select false, 'FREE_LIMIT_EMAIL',
        'This email has been used on too many devices. Contact support or subscribe to continue.',
        0, greatest(v_device_limit - v_device_count, 0), null::uuid, false;
      return;
    end if;
  end if;

  insert into public.usage_events (feature, email, ip, device_key, user_id, run_id)
  values (v_feature, v_email, nullif(btrim(coalesce(p_ip, '')), ''), v_device, p_user_id, v_run)
  returning id into v_claim;

  update public.studio_devices
     set claim_count = claim_count + 1,
         last_seen_at = now()
   where device_key = v_device;

  return query select true, null::text, null::text,
    greatest(v_email_limit - (v_email_count + 1), 0),
    greatest(v_device_limit - (v_device_count + 1), 0),
    v_claim, false;
end;
$$;

comment on function public.consume_studio_generation(text, uuid, text, text, text, text, integer, integer, integer, integer)
  is 'Atomically claims one Studio free generation against BOTH the email and the device (advisory-locked, run-id idempotent).';

-- ----------------------------------------------------------------------------
-- 6. Give a claim back when the generation itself failed
-- ----------------------------------------------------------------------------
create or replace function public.release_studio_claim(p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_device text;
begin
  if p_claim_id is null then
    return false;
  end if;

  delete from public.usage_events
   where id = p_claim_id
     and feature = 'studio_generation'
     /* Only a claim just made by this request can be released. */
     and created_at > now() - interval '30 minutes'
  returning device_key into v_device;

  if v_device is null then
    return false;
  end if;

  update public.studio_devices
     set claim_count = greatest(claim_count - 1, 0)
   where device_key = v_device;

  return true;
end;
$$;

comment on function public.release_studio_claim(uuid)
  is 'Deletes a just-created Studio usage claim when the generation could not run.';

-- ----------------------------------------------------------------------------
-- 7. Lock the functions down (Edge Functions only)
-- ----------------------------------------------------------------------------
revoke all on function public.register_studio_device(text, text, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.consume_studio_generation(text, uuid, text, text, text, text, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.release_studio_claim(uuid)
  from public, anon, authenticated;

grant execute on function public.register_studio_device(text, text, uuid, text, text)
  to service_role;
grant execute on function public.consume_studio_generation(text, uuid, text, text, text, text, integer, integer, integer, integer)
  to service_role;
grant execute on function public.release_studio_claim(uuid)
  to service_role;

-- ----------------------------------------------------------------------------
-- 8. Deploy notes
-- ----------------------------------------------------------------------------
--   supabase db push                                  (this migration)
--   supabase functions deploy entitlement             (device + verified admin checks)
--   supabase functions deploy create-free-greeting     (admin bypass)
--   supabase functions deploy create-greeting          (central admin check)
--   supabase secrets set DEVICE_SECRET="<32+ random bytes>"
--
-- `DEVICE_SECRET` signs device tokens and fingerprints. Without it the
-- entitlement function fails closed for Studio usage (no free generation is
-- granted) instead of accepting an unsigned device id.
-- ============================================================================
