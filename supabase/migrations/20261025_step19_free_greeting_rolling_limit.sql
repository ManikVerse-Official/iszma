-- ============================================================================
-- Step 19 — atomic free-greeting limit (one per email per rolling 24 hours)
-- ----------------------------------------------------------------------------
-- Reuses the existing `usage_events` table from step 9 (20261003). Step 9 must
-- already be applied; this migration only adds functions and indexes.
--
-- Why a database function:
--   The old check was read-then-insert done by the Edge Function. Two concurrent
--   requests could both read "no free card yet" and both insert, minting two free
--   cards for one email. The check and the claim now happen in ONE transaction,
--   serialised by advisory locks, so a second request always sees the first
--   claim.
--
-- Rules (limits are supplied by the Edge Function from FREE_LIMITS, the single
-- policy definition):
--   • at most `p_per_email` claims for one email inside a ROLLING window of
--     `p_window_hours` hours (24 for free greetings — not a midnight reset),
--   • at most `p_per_ip_emails` distinct emails from one IP in total,
--   • at most `p_per_ip_total` claims from one IP in total.
--
-- Only rows inside the rolling window count toward the email limit, so the same
-- address becomes eligible again exactly 24 hours after its claim. Network caps
-- are deliberately unchanged (existing product policy: two free cards per
-- network).
--
-- Privacy: rows keep the existing schema (email + best-effort IP, no new PII).
-- `release_free_greeting_claim` lets the Edge Function give a claim back when the
-- card write fails, so a failed attempt never burns the 24-hour window.
--
-- Apply with the other pending migrations (step 9 first). Safe to re-run.
-- ============================================================================

create index if not exists usage_events_feature_email_created_idx
  on public.usage_events (feature, lower(email), created_at desc);

create index if not exists usage_events_feature_ip_created_idx
  on public.usage_events (feature, ip, created_at desc);

-- ----------------------------------------------------------------------------
-- Claim a free greeting slot.
--
-- Returns exactly one row:
--   allowed, code, message, remaining, claim_id, retry_after_seconds
-- Codes: FREE_LIMIT_EMAIL | FREE_LIMIT_NETWORK | INVALID_REQUEST.
-- A database error (function missing / table missing) surfaces as an RPC error,
-- which the Edge Function turns into USAGE_UNAVAILABLE — never an allow.
-- ----------------------------------------------------------------------------
create or replace function public.consume_free_greeting(
  p_email text,
  p_ip text,
  p_per_email integer,
  p_per_ip_emails integer,
  p_per_ip_total integer,
  p_window_hours integer default 24
)
returns table (
  allowed boolean,
  code text,
  message text,
  remaining integer,
  claim_id uuid,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_feature constant text := 'free_greeting';
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_ip text := btrim(coalesce(p_ip, ''));
  v_window interval := make_interval(hours => greatest(1, coalesce(p_window_hours, 24)));
  v_email_limit integer := greatest(1, coalesce(p_per_email, 1));
  v_ip_emails_limit integer := greatest(0, coalesce(p_per_ip_emails, 0));
  v_ip_total_limit integer := greatest(0, coalesce(p_per_ip_total, 0));
  v_email_count integer;
  v_ip_total integer;
  v_ip_distinct integer;
  v_retry integer;
  v_claim uuid;
begin
  if v_email = '' then
    return query select false, 'INVALID_REQUEST',
      'A valid email address is required.', 0, null::uuid, null::integer;
    return;
  end if;

  -- The Edge Function refuses to call this without a trustworthy IP; keep the
  -- guard here too so a direct RPC call cannot skip the network caps.
  if v_ip = '' then
    raise exception 'consume_free_greeting requires a client IP';
  end if;

  -- Serialise by email first, then by IP (always this order, so no deadlock).
  perform pg_advisory_xact_lock(hashtext('free_greeting:email:' || v_email)::bigint);
  perform pg_advisory_xact_lock(hashtext('free_greeting:ip:' || v_ip)::bigint);

  select count(*) into v_email_count
  from public.usage_events ue
  where ue.feature = v_feature
    and lower(ue.email) = v_email
    and ue.created_at > now() - v_window;

  if v_email_count >= v_email_limit then
    /* Seconds until the oldest windowed claim falls out of the window. */
    select ceil(extract(epoch from (ue.created_at + v_window - now())))::integer
      into v_retry
    from public.usage_events ue
    where ue.feature = v_feature
      and lower(ue.email) = v_email
      and ue.created_at > now() - v_window
    order by ue.created_at asc
    offset greatest(v_email_limit, 1) - 1
    limit 1;

    return query select false, 'FREE_LIMIT_EMAIL',
      'This email has already claimed a free card in the last 24 hours. You can send another free card after 24 hours, or choose a paid card.',
      0, null::uuid,
      greatest(1, coalesce(v_retry, 1));
    return;
  end if;

  /* Distinct emails from this IP, excluding the caller's own (it may be older
     than the window and is therefore not a second email on this network). */
  select count(distinct lower(coalesce(ue.email, ''))) into v_ip_distinct
  from public.usage_events ue
  where ue.feature = v_feature
    and ue.ip = v_ip
    and lower(coalesce(ue.email, '')) <> v_email;

  if v_ip_emails_limit > 0 and v_ip_distinct >= v_ip_emails_limit then
    return query select false, 'FREE_LIMIT_NETWORK',
      'This network has already used its free allowance. Please subscribe to continue.',
      0, null::uuid, null::integer;
    return;
  end if;

  select count(*) into v_ip_total
  from public.usage_events ue
  where ue.feature = v_feature
    and ue.ip = v_ip;

  if v_ip_total_limit > 0 and v_ip_total >= v_ip_total_limit then
    return query select false, 'FREE_LIMIT_NETWORK',
      'This network has reached its free-use limit. Please subscribe to continue.',
      0, null::uuid, null::integer;
    return;
  end if;

  insert into public.usage_events (feature, email, ip)
  values (v_feature, v_email, v_ip)
  returning id into v_claim;

  return query select true, null::text, null::text,
    greatest(v_email_limit - (v_email_count + 1), 0),
    v_claim, null::integer;
end;
$$;

comment on function public.consume_free_greeting(text, text, integer, integer, integer, integer)
  is 'Atomically claims the rolling free-greeting slot for an email (advisory-locked per email and per IP).';

-- ----------------------------------------------------------------------------
-- Give a claim back after a failed card write (best effort, recent claims only).
-- ----------------------------------------------------------------------------
create or replace function public.release_free_greeting_claim(p_claim_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer;
begin
  if p_claim_id is null then
    return false;
  end if;

  delete from public.usage_events
  where id = p_claim_id
    and feature = 'free_greeting'
    /* Only a claim just made by this request can be released. */
    and created_at > now() - interval '10 minutes';

  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

comment on function public.release_free_greeting_claim(uuid)
  is 'Deletes a just-created free_greeting usage claim when the card could not be written.';

-- ----------------------------------------------------------------------------
-- Lock the functions down to the service role (Edge Functions only).
-- ----------------------------------------------------------------------------
revoke all on function public.consume_free_greeting(text, text, integer, integer, integer, integer)
  from public, anon, authenticated;
revoke all on function public.release_free_greeting_claim(uuid)
  from public, anon, authenticated;

grant execute on function public.consume_free_greeting(text, text, integer, integer, integer, integer)
  to service_role;
grant execute on function public.release_free_greeting_claim(uuid)
  to service_role;
