-- ============================================================================
-- Step 18 — lock down `products` (store product pricing).
-- ----------------------------------------------------------------------------
-- Found during the Task-5 pricing audit: `products` was created in step 4 with
-- no `enable row level security` and no policies, while every other catalogue
-- table (theme_prices, custom_themes, theme_overrides) has public read +
-- admin-only write. Supabase grants table privileges to `anon` and
-- `authenticated` by default, so with RLS off any visitor holding the public
-- anon key could update, insert or delete a product — including its price.
--
-- This repeats the exact pattern step 4/5 already use for the sibling tables, so
-- the storefront keeps reading prices and the admin dashboard keeps writing them
-- (the dashboard's authenticated admin session passes `is_admin()`).
--
-- Additive and idempotent: no table, row or policy is dropped. Not applied to the
-- linked project by the audit task — see the final report.
-- ============================================================================

alter table if exists public.products enable row level security;

drop policy if exists "products public read" on public.products;
create policy "products public read"
  on public.products
  for select
  using (true);

drop policy if exists "products admin write" on public.products;
create policy "products admin write"
  on public.products
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- `anon` may read the catalogue but must never write it.
grant select on public.products to anon, authenticated;
revoke insert, update, delete on public.products from anon;
