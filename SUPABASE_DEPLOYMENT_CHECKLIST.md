# Supabase deployment & security checklist

Every step in this file is a **manual, reviewable action for the project owner**.
Nothing here was applied from the working copy: no migration was run, no Edge
Function was deployed, no secret was set and no RLS policy was changed.

Steps that need your authorization are marked **⚠️ NEEDS APPROVAL**.

---

## 0. ⛔ Blocking finding — no Edge Function is deployed on this project

Measured against the configured project (`wqrnuohvlgroytsindme.supabase.co`,
the URL in `.env`) on 2026-10-18, with plain `curl`:

| Probe | Result | Meaning |
| --- | --- | --- |
| `GET /rest/v1/` (no apikey) | `401` | project is up and reachable |
| `GET /auth/v1/health` | `401` | Auth is up |
| `OPTIONS /functions/v1/admin-login` | `404` | **no such function deployed** |
| `POST /functions/v1/admin-login` | `404` | same |
| `OPTIONS` / `POST /functions/v1/track-visit` | `404` | same |
| `OPTIONS` / `POST /functions/v1/send-email` | `404` | same — *every* function |
| `admin_users`, `site_settings` (REST) | `200` | those tables exist |
| `usage_events`, `site_visits`, `game_rooms`, `entitlements`, `card_orders` | `404 PGRST205` | **migrations step 9–15 are not applied** |
| `POST /rest/v1/rpc/admin_login_verify` | `404 PGRST202` | **the login password check does not exist yet** |

`supabase migration list --linked` confirms it — applied remotely: `20260925`…`20261002`
(steps 1–8); pending: `20261003`, `20261004`, `20261005`, `20261006`, `20261014`,
`20261015`, `20261016` (steps 9–15, `admin_login_verify` lives in step 14).
`supabase db push --dry-run --linked` lists exactly those seven — nothing else.

So **both halves** are missing, and both are needed for sign-in: the function and the
RPC it calls. Deploying `admin-login` on its own would answer
*"Sign-in is temporarily unavailable"* (503) because `admin_login_verify` is absent.

Nothing is deployed, so this is the actual cause of both live symptoms:

- the browser console shows `Access to fetch at '…/functions/v1/admin-login' …
  has been blocked by CORS policy: Response to preflight request doesn't pass
  access control check: It does not have HTTP ok status` (the `404`);
- the form shows *"Failed to send a request to the Edge Function"* — that is what
  `supabase-js` throws when the preflight never completes, and it is why the
  message in the UI (see `src/services/adminAuth.ts`) now names the real
  condition instead of repeating the SDK string.

The code side of this was already fixed in this repository (`verify_jwt = false`
for the anonymous functions in `supabase/config.toml`, the request attached to
*every* `admin-login` response, the `SITE_ORIGINS` allowlist). **The remaining
step is deployment, which needs your Supabase login — I cannot run it without
your credentials.**

```bash
npx supabase login                 # once, with your own account
npx supabase link --project-ref wqrnuohvlgroytsindme
npx supabase secrets set SITE_ORIGINS=https://ishmaverse.com,https://www.ishmaverse.com
npx supabase db push               # the 7 migrations above (additive)
bash supabase/deploy-step14.sh     # admin-login, admin-credentials, upload-image
npx supabase functions deploy track-visit
# plus the rest of supabase/functions/ as needed (see §3)
```

The CLI on the development machine is already logged in and linked, so these are
the only remaining steps — they were left for the project owner to approve because
they write to the live project.

Until then: admin sign-in, page-view analytics, photo uploads and email can only
fail, and no client-side change can fix them.

---

## 1. Environment variables

### Frontend (`VITE_*`, compiled into the public bundle)

| Variable | Purpose |
| --- | --- |
| `VITE_SUPABASE_URL` | Supabase project URL (mall + entitlement). |
| `VITE_SUPABASE_ANON_KEY` | Public anon key. **Never** the service-role key. |
| `VITE_PAYMENT_MODE` | `demo` to exercise payments without a real charge. |
| `VITE_REPORTCARD_URL` | Where the admin dashboard links to ReportCard Studio. |

Also set `ReportCard Studio/.env` with the same `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` pair to enable server-side entitlements.

### Edge Function secrets (`supabase secrets set`, never in `.env`)

| Secret | Required for | Notes |
| --- | --- | --- |
| `SITE_ORIGINS` | **CORS for every Edge Function** | Comma-separated allowlist, no trailing slash. e.g. `https://ishmaverse.com,https://www.ishmaverse.com`. Localhost dev origins are always allowed. **Without this the production origin is not allowed and browser calls are blocked.** |
| `VISIT_HASH_SALT` | `track-visit` | Salt for the non-reversible visitor hash. |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | India payments | Server-side only. |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_MODE` | International payments | `sandbox` while testing. |
| `STRIPE_SECRET_KEY` | Optional Stripe option | `sk_test_…` / `sk_live_…`. |
| `IMGBB_API_KEY` | `upload-image` | Card photo hosting. |
| `RESEND_API_KEY`, `RECEIPT_FROM_EMAIL`, `SUPPORT_EMAIL`, `BRAND_LOGO_URL` | Bills, receipts, renewal notices. |
| `ADMIN_EMAILS`, `ADMIN_NOTIFY_EMAIL` | Admin access + admin copies. `ADMIN_EMAILS` is matched **only** against the verified session email — there is no IP-based bypass any more. |
| `DEVICE_SECRET` | **Required for Studio free generations.** 32+ random bytes. HMAC key for the signed device tokens and the device fingerprint. Without it the `entitlement` function fails closed: no free generation is granted. |
| `MAINTENANCE_SECRET`, `RENEWAL_WARN_DAYS` | `subscription-maintenance` cron. |
| `PUBLIC_SITE_URL` | "Manage or delete your card" links in email. |

> Never expose `SUPABASE_SERVICE_ROLE_KEY` to the client. No frontend file in
> this repository reads it; the checks below fail the build if one ever does.

---

## 2. Migration review and application order

Migrations live in `supabase/migrations/` and are **additive**. Apply in
filename order — do not reorder or edit an applied file.

```
20260925_step1_security_and_ledger.sql
20260926_step2_card_font.sql
20260927_step3_payment_idempotency.sql
20260928_step4_theme_prices_and_usd.sql
20260929_step5_theme_artwork_storage.sql
20260930_step6_card_colors.sql
20261001_step7_card_audio.sql
20261002_step8_card_privacy.sql
20261003_step9_usage_and_studio.sql
20261004_step10_site_visits.sql
20261005_step11_greeting_audio.sql
20261006_step12_subscription_tracker.sql
20261014_step13_admin_ops.sql
20261015_step14_admin_secrets.sql
20261016_step15_game_zone.sql
```

Before applying anything, read each file and confirm:

- [ ] it is additive (no `DROP` of a populated table or column);
- [ ] every new table has `ENABLE ROW LEVEL SECURITY`;
- [ ] client roles are granted **no** write access to server-authoritative tables
      (`game_rooms`, `game_queue`, `game_events`, `site_visits`, ledger tables);
- [ ] every `SECURITY DEFINER` function sets `search_path` explicitly and is not
      executable by `anon` — **⚠️ NEEDS APPROVAL** if a policy must change;
- [ ] **⚠️ NEEDS APPROVAL** for anything that touches production data.

`supabase db push` / `supabase migration up` is **⚠️ NEEDS APPROVAL**.

---

## 3. Edge Function deployment

`supabase/functions/` (one folder per function):

`accountant-bot`, `admin-credentials`, `admin-login`, `admin-ops`,
`admin-subscriptions`, `create-free-greeting`, `create-greeting`,
`create-payment-order`, `delivery-bot`, `entitlement`, `joy-sync`,
`manage-greeting`, `send-email`, `subscription-maintenance`, `track-visit`,
`upload-image`.

```bash
# review first
supabase functions deploy track-visit --no-verify-jwt   # ⚠️ NEEDS APPROVAL to run
```

Notes:

- `track-visit` is called by anonymous browsers, so its JWT verification is
  disabled **by design**; it never trusts the body for identity — admin traffic
  is excluded from the verified JWT only. `supabase/config.toml` now pins
  `[functions.track-visit] verify_jwt = false` as well, so a plain
  `supabase functions deploy` (no flag) can no longer re-enable it and bring
  back the CORS preflight failure (`OPTIONS` carries no `Authorization` header,
  so the gateway rejected it before the function's own handler could answer).
- `admin-login` answers **every** response — including 405/429/401 — through
  `_shared/http.ts` with the request attached; a response built without it falls
  back to the legacy wildcard, which the browser refuses for a credentialed call
  and which surfaces as a misleading "Edge Function request failed" CORS error.
- Functions that act on a user's account (`entitlement`, `admin-*`,
  `manage-greeting`, `create-payment-order`) **must keep JWT verification on**.
- CORS now comes from `_shared/http.ts` and the `SITE_ORIGINS` allowlist instead
  of `Access-Control-Allow-Origin: *`. See §1.

---

## 4. Anonymous / authenticated / admin access

| Actor | Expected access |
| --- | --- |
| Anonymous | Create a greeting card, read a shared card by id, record a page view. Nothing else. |
| Authenticated (school account) | Own entitlements and usage; generate report cards client-side; no student data leaves the browser. |
| Admin (Supabase account in `admin_users`) | Admin ops, audience analytics, game analytics, unlimited report cards, playable Game Zone while it is disabled. |

Admin identity is decided **server-side** by `_shared/adminAccess.ts`: the
request's Supabase JWT is verified, then `admin_users` is read for that user id.
`ADMIN_EMAILS` is honoured only when the email comes from that verified session.
There is no client-side admin flag, no body email and no IP-based bypass to
spoof — an IP is not an identity, and a claimed email is not a session.

---

## 5. Matchmaking, private rooms and cleanup

The Game Zone backend (`20261016_step15_game_zone.sql`) is server-authoritative:

- room creation and code joining go through `SECURITY DEFINER` RPCs;
- moves are validated server-side against the same nine lines, the same
  adjacency, the same six-piece phase change and the same 60-second deadline as
  the client engine (proved by `npm run check:pair3balls`);
- every mutation takes a `FOR UPDATE` row lock, so concurrent or duplicate
  submissions cannot interleave;
- matchmaking claims an opponent atomically (`FOR UPDATE SKIP LOCKED`);
- timeouts are resolved server-side.

### Cleanup scheduling

Expired rooms and abandoned queue entries are removed by the maintenance
functions. Schedule them (the cron row below is a dashboard action —
**⚠️ NEEDS APPROVAL**):

```sql
-- daily, 03:00 IST
select cron.schedule('game-cleanup', '30 21 * * *', $$
  select public.game_cleanup();
$$);
```

`subscription-maintenance` requires the `MAINTENANCE_SECRET` header; schedule it
the same way (`RENEWAL_WARN_DAYS` controls the warning window).

---

## 6. Post-deployment verification

- [ ] `curl -i -X OPTIONS <fn-url> -H "Origin: https://ishmaverse.com" -H "Access-Control-Request-Method: POST"`
      returns `Access-Control-Allow-Origin: https://ishmaverse.com`.
- [ ] The same request with `-H "Origin: https://evil.example"` returns **no**
      `Access-Control-Allow-Origin` header.
- [ ] Browser console on every route: no CORS error for `track-visit`.
- [ ] Admin dashboard "Audience" shows rows (or states plainly that
      `track-visit` is not deployed).
- [ ] Game Zone shows the honest availability badge; World Match finds a real
      opponent or reports unavailability — it never fakes one.
- [ ] `select public.game_admin_analytics()` returns real counts, and the admin
      panel still labels advertising revenue **UNAVAILABLE**.
- [ ] A free greeting card can be created and opened by its link.
- [ ] A bill/receipt email arrives after a (demo-mode) purchase.

---

## 7. Rollback / recovery

1. **Edge Function**: redeploy the previous revision
   (`supabase functions deploy <name>`) — functions are versioned by the CLI.
2. **CORS regression**: re-add the missing origin to `SITE_ORIGINS` and re-run
   `npm run check:cors`; never fall back to `Access-Control-Allow-Origin: *`.
3. **Migration**: migrations are additive. Roll back by disabling the affected
   policy/grant rather than dropping data; **⚠️ NEEDS APPROVAL** for any drop.
4. **Game Zone incident**: flip `game_settings.enabled = false` (or
   `maintenance = true`) to switch the online modes off while local play keeps
   working.
5. **Entitlements**: `ReportCard Studio` falls back to its local store when the
   Edge Function is unreachable, so a backend outage never blocks generation for
   an admin.

---

## 8. Actions that need your explicit authorization

- [ ] Applying any migration to the production project.
- [ ] Changing or adding any RLS policy / `SECURITY DEFINER` grant.
- [ ] Setting production secrets (especially `SITE_ORIGINS`).
- [ ] Deploying any Edge Function.
- [ ] Creating cron schedules.
- [ ] Enabling a real ad provider (would make advertising revenue a real,
      reportable number instead of **UNAVAILABLE**).
