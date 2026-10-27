-- ============================================================================
-- Ishmaverse · Step 16: Atomic admin rate-limit store
-- ----------------------------------------------------------------------------
-- Root cause fixed here
--   `admin-ops` used to read `admin_rate_limits`, decide, and then upsert the
--   counter in two separate statements. Two concurrent invocations could read
--   the same count, both write, and the losing upsert could surface a store
--   error (or silently lose an attempt), which the function then reported as
--   "the server rate-limit store is unavailable".
--
--   The counter is now consumed by ONE function, inside a row lock, so the
--   read + increment is atomic. The original limits are unchanged
--   (`LIMITS.opsPerWindow` / `LIMITS.opsWindowSeconds` in adminOpsCore.ts).
--
-- This migration is ADDITIVE. It also re-creates the counter table defensively
-- in case step 13 was never applied, and it keeps the table service-role-only.
-- Apply with: supabase db push   (or paste into the Supabase SQL editor)
-- ============================================================================

create table if not exists public.admin_rate_limits (
  key          text primary key,
  window_start timestamptz not null default now(),
  count        integer not null default 0
);

alter table public.admin_rate_limits enable row level security;
revoke all on public.admin_rate_limits from anon, authenticated;
-- Explicit grant for the Edge Function's service role. This also repairs a
-- project whose default table privileges were revoked, which was another way
-- the limiter could report "store unavailable" even though the table existed.
grant all on public.admin_rate_limits to service_role;

create or replace function public.consume_admin_rate_limit(
  p_key text,
  p_limit integer,
  p_window_seconds integer
)
returns table (
  allowed boolean,
  remaining integer,
  retry_after_seconds integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_start timestamptz;
  v_count integer;
  v_elapsed double precision;
begin
  if p_key is null or length(p_key) = 0 then
    raise exception 'rate-limit key is required';
  end if;
  if p_limit < 0 or p_window_seconds <= 0 then
    raise exception 'invalid rate-limit parameters';
  end if;

  -- Ensure a row exists, then lock that exact row for the read + write below.
  insert into public.admin_rate_limits (key, window_start, count)
  values (p_key, v_now, 0)
  on conflict (key) do nothing;

  select r.window_start, r.count
    into v_start, v_count
    from public.admin_rate_limits r
   where r.key = p_key
   for update;

  v_elapsed := extract(epoch from (v_now - v_start));

  -- A new or expired window starts fresh.
  if v_start is null or v_elapsed < 0 or v_elapsed >= p_window_seconds then
    update public.admin_rate_limits
       set window_start = v_now, count = 1
     where key = p_key;
    return query select true, greatest(p_limit - 1, 0), 0;
    return;
  end if;

  if v_count >= p_limit then
    return query
      select false,
             0,
             greatest(1, ceil(p_window_seconds - v_elapsed)::integer);
    return;
  end if;

  update public.admin_rate_limits
     set count = v_count + 1
   where key = p_key;
  return query
    select true,
           greatest(p_limit - (v_count + 1), 0),
           0;
end;
$$;

-- Only the service-role Edge Function may consume counters.
revoke all on function public.consume_admin_rate_limit(text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.consume_admin_rate_limit(text, integer, integer)
  to service_role;

comment on function public.consume_admin_rate_limit(text, integer, integer)
  is 'Atomically consumes one fixed-window admin rate-limit slot. Service-role only.';
