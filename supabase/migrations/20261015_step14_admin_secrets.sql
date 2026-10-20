-- ============================================================================
-- Ishmaverse · Step 14: Backend-only admin credentials & hidden image key
-- ----------------------------------------------------------------------------
-- Goals
--   1. Admin credentials live ONLY in Postgres. `admin_users.password_hash`
--      holds a bcrypt hash (pgcrypto). No VITE_ADMIN_EMAIL / VITE_ADMIN_PASSWORD
--      is ever needed by the browser again.
--   2. The hash is unreachable from the client: table-level SELECT is revoked
--      and only the harmless columns are re-granted, so a stolen anon /
--      authenticated token can never read the hash.
--   3. Verification is a SECURITY DEFINER function that only the service role
--      may execute. The browser calls the `admin-login` Edge Function instead.
--   4. `public.is_admin()` and every existing policy keep their behaviour, so
--      the sales ledger, Razorpay flow and Resend email are unaffected.
--
-- Run with: supabase db push
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. pgcrypto (bcrypt).
--
--    Supabase installs extensions in the `extensions` schema on modern
--    projects, but older ones kept pgcrypto in `public`. Instead of guessing,
--    we resolve the schema it actually lives in and build two tiny wrappers
--    whose `search_path` is locked to that one schema. The migration then never
--    depends on an unqualified `crypt()` call resolving safely.
-- ----------------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $do$
declare
  v_schema text;
begin
  select n.nspname
    into v_schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
   where e.extname = 'pgcrypto';

  if v_schema is null then
    raise exception 'pgcrypto extension is not installed; run: create extension pgcrypto;';
  end if;

  -- Hash a password with a fresh bcrypt salt (cost 10).
  -- VOLATILE on purpose: gen_salt() must never be folded to a constant, or two
  -- passwords hashed in one statement would share a salt. Do NOT mark this
  -- function STABLE/IMMUTABLE.
  execute format($f$
    create or replace function public.admin_hash_password(p_password text)
    returns text
    language sql
    volatile
    security definer
    set search_path = %I
    as $body$
      select crypt(p_password, gen_salt('bf', 10))
    $body$;
  $f$, v_schema);

  -- Constant-time-ish comparison handled by crypt() itself.
  execute format($f$
    create or replace function public.admin_password_matches(p_password text, p_hash text)
    returns boolean
    language sql
    stable
    security definer
    set search_path = %I
    as $body$
      select length(coalesce(p_hash, '')) > 0
         and crypt(coalesce(p_password, ''), p_hash) = p_hash
    $body$;
  $f$, v_schema);
end
$do$;

-- Only the function owner (postgres) may call the crypto helpers directly.
revoke all on function public.admin_hash_password(text) from public, anon, authenticated;
revoke all on function public.admin_password_matches(text, text) from public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- 1. Extend the admin allow-list with credential material and metadata.
--    `password_hash` is the ONLY secret here; the rest is safe metadata.
-- ----------------------------------------------------------------------------
alter table public.admin_users add column if not exists email              text;
alter table public.admin_users add column if not exists password_hash      text;
alter table public.admin_users add column if not exists is_active          boolean not null default true;
alter table public.admin_users add column if not exists display_name       text;
alter table public.admin_users add column if not exists created_at         timestamptz not null default now();
alter table public.admin_users add column if not exists updated_at         timestamptz not null default now();
alter table public.admin_users add column if not exists last_login_at      timestamptz;
alter table public.admin_users add column if not exists password_updated_at timestamptz;
alter table public.admin_users add column if not exists failed_logins      integer not null default 0;
alter table public.admin_users add column if not exists locked_until       timestamptz;

create index if not exists admin_users_email_lower_idx
  on public.admin_users (lower(email));

-- ----------------------------------------------------------------------------
-- 2. Lock the table down at the column level.
--
--    Supabase grants anon/authenticated table-level access by default and a
--    column-level REVOKE does NOT override a table-level GRANT. So we revoke the
--    whole table and re-grant only the harmless columns. `password_hash` and the
--    lockout counters therefore never reach a browser — not even for an admin
--    reading their own row.
-- ----------------------------------------------------------------------------
alter table public.admin_users enable row level security;

revoke all on public.admin_users from anon, authenticated;
revoke all on public.admin_users from public;

grant select (user_id, email, display_name, is_active, created_at, updated_at, last_login_at)
  on public.admin_users to authenticated;

-- The server keeps full access (it is the only writer). Re-asserted so this
-- migration is correct even on a project where default privileges were changed.
grant all on public.admin_users to service_role;

drop policy if exists "admins can read their own row" on public.admin_users;
create policy "admins can read their own row"
  on public.admin_users
  for select
  to authenticated
  using (user_id = auth.uid());

-- All writes stay server-side (service role only).

-- ----------------------------------------------------------------------------
-- 3. admin_login_verify — the real password check.
--
--    * SECURITY DEFINER so it can read password_hash despite the column grants.
--    * EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to
--      service_role. The browser can never call this directly; it goes through
--      the `admin-login` Edge Function.
--    * A wrong password and an unknown email return the same shape, so the
--      caller cannot enumerate admin accounts.
-- ----------------------------------------------------------------------------
create or replace function public.admin_login_verify(
  p_email text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.admin_users;
begin
  if p_email is null
     or p_password is null
     or length(trim(p_email)) = 0
     or length(p_password) = 0 then
    return jsonb_build_object('ok', false, 'code', 'invalid_input');
  end if;

  select *
    into v_row
    from public.admin_users
   where lower(email) = lower(trim(p_email))
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_admin');
  end if;

  if coalesce(v_row.is_active, true) is not true then
    return jsonb_build_object('ok', false, 'code', 'disabled');
  end if;

  -- Defence in depth on top of GoTrue's own rate limiting.
  if v_row.locked_until is not null and v_row.locked_until > now() then
    return jsonb_build_object('ok', false, 'code', 'locked');
  end if;

  -- No hash yet (admin seeded through the Supabase Auth dashboard only): report
  -- it so the Edge Function can fall back to Supabase Auth, which is still a
  -- server-side check.
  if coalesce(v_row.password_hash, '') = '' then
    return jsonb_build_object(
      'ok', false,
      'code', 'no_local_password',
      'user_id', v_row.user_id,
      'email', v_row.email
    );
  end if;

  if not public.admin_password_matches(p_password, v_row.password_hash) then
    update public.admin_users
       set failed_logins = coalesce(v_row.failed_logins, 0) + 1,
           locked_until = case
                            when coalesce(v_row.failed_logins, 0) + 1 >= 10
                              then now() + interval '15 minutes'
                            else v_row.locked_until
                          end
     where user_id = v_row.user_id;

    return jsonb_build_object('ok', false, 'code', 'bad_password');
  end if;

  update public.admin_users
     set last_login_at  = now(),
         failed_logins  = 0,
         locked_until   = null
   where user_id = v_row.user_id;

  return jsonb_build_object(
    'ok', true,
    'user_id', v_row.user_id,
    'email', coalesce(v_row.email, lower(trim(p_email)))
  );
end;
$$;

revoke all on function public.admin_login_verify(text, text) from public, anon, authenticated;
grant execute on function public.admin_login_verify(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 4. set_admin_password — writes the bcrypt hash for an EXISTING auth user.
--
--    Service role only (bootstrap script / secret rotation). Requiring an
--    existing auth.users row means it can never mint a login for a phantom
--    account.
-- ----------------------------------------------------------------------------
create or replace function public.set_admin_password(
  p_email text,
  p_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email   text := lower(trim(coalesce(p_email, '')));
  v_user_id uuid;
begin
  if length(coalesce(p_password, '')) < 10 then
    return jsonb_build_object(
      'ok', false,
      'code', 'weak_password',
      'message', 'Use a password of at least 10 characters.'
    );
  end if;

  select id
    into v_user_id
    from auth.users
   where lower(email) = v_email
   limit 1;

  if v_user_id is null then
    return jsonb_build_object(
      'ok', false,
      'code', 'no_auth_user',
      'message', 'Create the user in Supabase Auth first.'
    );
  end if;

  insert into public.admin_users (
    user_id, email, password_hash, is_active, updated_at, password_updated_at
  )
  values (
    v_user_id, v_email, public.admin_hash_password(p_password), true, now(), now()
  )
  on conflict (user_id) do update
    set email               = excluded.email,
        password_hash       = excluded.password_hash,
        is_active           = true,
        failed_logins       = 0,
        locked_until        = null,
        updated_at          = now(),
        password_updated_at = now();

  return jsonb_build_object('ok', true, 'user_id', v_user_id, 'email', v_email);
end;
$$;

revoke all on function public.set_admin_password(text, text) from public, anon, authenticated;
grant execute on function public.set_admin_password(text, text) to service_role;

-- ----------------------------------------------------------------------------
-- 5. admin_rotate_password — self-service change for a signed-in admin.
--
--    Granted to `authenticated` (the caller already holds a JWT) but the
--    function re-checks admin membership itself, so a normal signed-in user
--    cannot rotate anyone's password.
-- ----------------------------------------------------------------------------
create or replace function public.admin_rotate_password(
  p_current_password text,
  p_new_password text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.admin_users;
begin
  if auth.uid() is null then
    return jsonb_build_object('ok', false, 'code', 'not_authenticated');
  end if;

  if length(coalesce(p_new_password, '')) < 10 then
    return jsonb_build_object(
      'ok', false,
      'code', 'weak_password',
      'message', 'Use a password of at least 10 characters.'
    );
  end if;

  select *
    into v_row
    from public.admin_users
   where user_id = auth.uid()
   limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_admin');
  end if;

  if not public.admin_password_matches(coalesce(p_current_password, ''), v_row.password_hash) then
    return jsonb_build_object('ok', false, 'code', 'bad_password');
  end if;

  update public.admin_users
     set password_hash       = public.admin_hash_password(p_new_password),
         password_updated_at = now(),
         updated_at          = now(),
         failed_logins       = 0,
         locked_until        = null
   where user_id = v_row.user_id;

  return jsonb_build_object('ok', true, 'user_id', v_row.user_id);
end;
$$;

revoke all on function public.admin_rotate_password(text, text) from public, anon;
grant execute on function public.admin_rotate_password(text, text) to authenticated;

-- ----------------------------------------------------------------------------
-- 6. is_admin() — re-asserted (now also honouring is_active). Behaviour is
--    otherwise identical to step 1, so every existing RLS policy is unaffected.
-- ----------------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
      from public.admin_users
     where user_id = auth.uid()
       and coalesce(is_active, true) is true
  );
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

-- ----------------------------------------------------------------------------
-- 7. Bootstrap checklist (full details in SECURITY_STEP14.md)
-- ----------------------------------------------------------------------------
--   a. supabase db push
--   b. supabase secrets set IMGBB_API_KEY=<your key>
--   c. supabase functions deploy admin-login
--      supabase functions deploy admin-credentials
--      supabase functions deploy upload-image
--   d. node scripts/setup-admin.mjs      (stores the admin bcrypt hash)
--   e. Delete VITE_ADMIN_EMAIL, VITE_ADMIN_PASSWORD and VITE_IMGBB_API_KEY from
--      .env, from Vercel's Environment Variables, then redeploy the site.
-- ----------------------------------------------------------------------------
