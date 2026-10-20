-- ============================================================================
-- Ishmaverse · Step 13: Server-side admin operations (admin-ops)
-- ----------------------------------------------------------------------------
-- Goals
--   1. A durable, append-only audit log for administrative actions. It is
--      written by the service-role Edge Function and has NO policies for
--      anon/authenticated, so a normal Admin Joy command cannot read, edit or
--      delete history through the API.
--   2. Server-side rate-limit counters, so repeated admin commands and failed
--      sign-ins are limited on the backend (the browser limiter stays a bonus).
--   3. Optional per-admin permissions (least privilege). A NULL list means the
--      account keeps full admin rights, so existing admins are unaffected.
--
-- This migration is ADDITIVE: it creates new tables, adds one nullable column
-- and changes no existing policy. It must be applied with explicit
-- authorization (supabase db push). It does NOT touch products/theme policies.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Administrative audit log (append-only, service-role only)
-- ----------------------------------------------------------------------------
create table if not exists public.admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid,
  actor_email text,
  -- e.g. 'product.update' | 'theme.publish' | 'report.audit'
  action      text not null,
  target_type text,
  target_id   text,
  target_name text,
  outcome     text not null,          -- 'success' | 'failure' | 'denied' | 'blocked'
  detail      text,
  -- Only the changed fields, e.g. {"price": {"from": 100, "to": 399}}.
  -- Never passwords, tokens or secrets.
  diff        jsonb not null default '{}'::jsonb,
  ip          text,
  created_at  timestamptz not null default now()
);

create index if not exists admin_audit_log_created_idx
  on public.admin_audit_log (created_at desc);
create index if not exists admin_audit_log_actor_idx
  on public.admin_audit_log (actor_id, created_at desc);

alter table public.admin_audit_log enable row level security;

-- No policies are created on purpose: RLS denies every anon/authenticated
-- request, and the explicit revoke documents that. Only the service role (used
-- inside the admin-ops Edge Function) can write or read these rows. This is what
-- makes the log append-only from the application's point of view.
revoke all on public.admin_audit_log from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 2. Server-side rate-limit counters
-- ----------------------------------------------------------------------------
create table if not exists public.admin_rate_limits (
  -- e.g. 'admin_ops:<user_id>' | 'auth_fail:<email>'
  key          text primary key,
  window_start timestamptz not null default now(),
  count        integer not null default 0
);

alter table public.admin_rate_limits enable row level security;
revoke all on public.admin_rate_limits from anon, authenticated;

-- ----------------------------------------------------------------------------
-- 3. Optional per-admin permissions (least privilege)
-- ----------------------------------------------------------------------------
-- NULL  -> full admin rights (existing behaviour, so no one is locked out).
-- array -> the account may only perform actions whose permission it lists.
alter table public.admin_users
  add column if not exists permissions text[];

-- ----------------------------------------------------------------------------
-- 4. Bootstrap note
-- ----------------------------------------------------------------------------
-- To restrict an admin to specific capabilities (optional):
--   update public.admin_users
--      set permissions = array['products.write', 'reports.read']
--    where email = 'staff@ishmaverse.com';
-- To restore full rights: update public.admin_users set permissions = null where ...
