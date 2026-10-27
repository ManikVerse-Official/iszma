-- ============================================================================
-- Step 17 — one authoritative source for ReportCard Studio plan pricing.
-- ----------------------------------------------------------------------------
-- Before this migration the three plan prices existed only as TypeScript
-- constants in two places (ReportCard Studio/src/config/plans.ts and
-- supabase/functions/_shared/plans.ts). An admin could not change a plan price
-- at all, and the two copies could drift apart silently.
--
-- This table is now the source of truth:
--   • `entitlement` reads it before falling back to the shipped constants, so
--     the price recorded on a subscription and the bill email use the admin's
--     value.
--   • Admin Joy writes it through the `admin-ops` Edge Function only.
--   • The studio frontend reads the live prices so what a visitor sees and what
--     the server records cannot diverge.
--
-- Safety:
--   • RLS is on and the only policy is a public SELECT (prices are shown on the
--     pricing page anyway). There is no INSERT/UPDATE/DELETE policy, so only the
--     service role — i.e. the Edge Functions — can change a price.
--   • Anon/authenticated write grants are revoked explicitly.
--   • Re-running this file is safe: it never duplicates rows or policies.
-- ============================================================================

create table if not exists public.studio_plan_prices (
  plan_id text primary key,
  name text not null,
  price_inr numeric(10, 2) not null default 0
    check (price_inr >= 0 and price_inr <= 1000000),
  price_usd numeric(10, 2) not null default 0
    check (price_usd >= 0 and price_usd <= 1000000),
  duration_months integer not null default 6
    check (duration_months >= 1 and duration_months <= 36),
  updated_at timestamptz not null default now()
);

-- Seed the prices that are live today. `on conflict do nothing` means a price an
-- admin already changed is never overwritten by re-applying this migration.
insert into public.studio_plan_prices (plan_id, name, price_inr, price_usd, duration_months)
values
  ('simple', 'Simple Academic', 369, 4.99, 6),
  ('modern', 'Modern School', 578, 6.99, 6),
  ('holistic', 'Holistic Progress', 859, 10.99, 6)
on conflict (plan_id) do nothing;

alter table public.studio_plan_prices enable row level security;

-- Prices are public information (the pricing page prints them).
drop policy if exists "studio plan prices are readable" on public.studio_plan_prices;
create policy "studio plan prices are readable"
  on public.studio_plan_prices
  for select
  using (true);

-- Nobody but the service role may write. RLS already blocks it; these revokes
-- also remove the default table grants Supabase hands to anon/authenticated.
revoke insert, update, delete on public.studio_plan_prices from anon, authenticated;
grant select on public.studio_plan_prices to anon, authenticated;
grant all on public.studio_plan_prices to service_role;
