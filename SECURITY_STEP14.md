# Step 14 — Backend-only admin credentials & hidden ImgBB key

This step removes every secret from the browser bundle:

| Before | After |
| --- | --- |
| `VITE_ADMIN_EMAIL` in Vercel / `.env` / bundle | `admin_users.email` in Postgres (never sent to the browser) |
| `VITE_ADMIN_PASSWORD` in Vercel / `.env` (a client-side fallback check) | `admin_users.password_hash` — a **bcrypt** hash, verified only inside Postgres |
| Client called `api.imgbb.com` with `VITE_IMGBB_API_KEY` | `upload-image` Edge Function holds the key as a Supabase secret |
| Hardcoded `deym85810@gmail.com` in `adminAuth.ts` / `create-free-greeting` | Removed; the server's `is_admin()` decides, and the bill owner address comes from `ADMIN_NOTIFY_EMAIL` |

Nothing about the payment flow was touched: `create-payment-order`, `create-greeting`,
`_shared/payments.ts` (Razorpay / PayPal / Stripe) and the Resend mailer behave
exactly as before. `public.is_admin()` keeps the same signature, so every
existing RLS policy still works.

---

## Files added / changed

**New**

```
supabase/migrations/20261015_step14_admin_secrets.sql   # schema + secure RPCs
supabase/config.toml                                    # verify_jwt for the 2 public functions
supabase/functions/admin-login/index.ts                 # backend credential check -> session
supabase/functions/admin-credentials/index.ts           # admin password rotation
supabase/functions/upload-image/index.ts                # ImgBB proxy
supabase/deploy-step14.sh                               # one-shot deploy
scripts/setup-admin.mjs                                 # one-time credential bootstrap
SECURITY_STEP14.md                                      # this file
```

**Changed**

```
src/services/adminAuth.ts          # signs in via admin-login; no hardcoded email
src/services/imageUpload.ts (new)  # shared upload helper used by both components
src/components/AdminLogin.tsx      # email field starts empty
src/components/CreateGreeting.tsx  # ImgBB call -> upload-image function
src/components/ThemeOrderModal.tsx # ImgBB call -> upload-image function; billing email from the server
src/services/notify.ts             # empty `to` allowed for purchase bills
src/vite-env.d.ts                  # VITE_ADMIN_*/VITE_IMGBB_* declarations removed
supabase/functions/send-email/index.ts      # bill with no buyer email goes to the owner
supabase/functions/create-free-greeting/index.ts  # hardcoded admin email removed
.env.example                       # documents the move to backend secrets
```

---

## Deploy, step by step (VS Code terminal)

Open the repo root in VS Code (**Terminal → New Terminal**) so you are in
`D:\ishmaverse`, then run the commands in order.

### 0. Prerequisites (once per machine)

```bash
npx supabase --version          # must print 2.x
npx supabase login              # opens the browser, pastes an access token
npx supabase projects list      # sanity check that you can see your project
```

The repo is already linked (`supabase/.temp/project-ref` =
`wqrnuohvlgroytsindme`, the same value as `supabase/config.toml`). If you ever
re-link:

```bash
npx supabase link --project-ref wqrnuohvlgroytsindme
```

### 1. Apply the database migration

```bash
npx supabase migration list     # local vs remote — optional but reassuring
npx supabase db push
```

This creates the credential columns, the `admin_login_verify` /
`set_admin_password` / `admin_rotate_password` functions and the column-level
lockdown on `admin_users`. You will be asked for the database password (find it
under **Supabase → Project Settings → Database**).

> Prefer the dashboard? Paste the contents of
> `supabase/migrations/20261015_step14_admin_secrets.sql` into
> **SQL Editor → New query → Run**. The result is identical.

### 2. Store the ImgBB key as a secret

```bash
npx supabase secrets set IMGBB_API_KEY=your_imgbb_key_here
npx supabase secrets list       # confirms IMGBB_API_KEY is present (values are hashed)
```

This is the key that used to be `VITE_IMGBB_API_KEY`. It now exists only inside
the Edge Function runtime.

### 3. Deploy the Edge Functions

```bash
npx supabase functions deploy admin-login
npx supabase functions deploy admin-credentials
npx supabase functions deploy upload-image
```

`admin-login` and `upload-image` are deployed with `verify_jwt = false`
(because a visitor has no session yet); `config.toml` already records that, and
the CLI applies it automatically. `admin-credentials` keeps the default
`verify_jwt = true`.

Everything else keeps its current deployment — nothing to re-deploy.

### 4. Store the admin credential hash (once)

```bash
node scripts/setup-admin.mjs
```

The script asks for:

* the **admin email** (e.g. your existing admin account), and
* a **new password** (hidden input, minimum 10 characters).

It needs the service-role key. Put it in `.env.local` (already git-ignored) or
pass it inline:

```bash
# .env.local
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...
```

```bash
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi... node scripts/setup-admin.mjs
```

What it does:

1. calls `set_admin_password(email, password)` → writes the bcrypt hash into
   `admin_users` (and adds the row if the account was only in Supabase Auth);
2. if there is no Supabase Auth user yet, creates one through the Admin API and
   retries.

> You can skip this step if the admin row already has a `password_hash`. Sign-in
> then falls back to Supabase Auth, which is still server-side.

Once it succeeds, **remove `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`.**

### 5. Remove the old variables from `.env` and Vercel

`.env` in this repo has already had them deleted. Now do the same in Vercel:

**Vercel → your project → Settings → Environment Variables** — delete:

* `VITE_ADMIN_EMAIL`
* `VITE_ADMIN_PASSWORD`
* `VITE_IMGBB_API_KEY`

Then **redeploy** (Deployments → ⋯ → Redeploy, or push a commit). The variables
are baked in at build time, so the old values stay in the previously built
bundle until a new build runs.

Also confirm nothing else was relying on them:

```bash
grep -rn "VITE_ADMIN_EMAIL\|VITE_ADMIN_PASSWORD\|VITE_IMGBB_API_KEY" src/ index.html vite.config.ts
# expected output: nothing
```

### 6. Rebuild and check

```bash
npm run build
npm run preview
```

Open the preview, go to `/admin`, and sign in with the email + password you set
in step 4.

---

## Verification checklist

1. **No secrets in the bundle.** After `npm run build`:
   ```bash
   grep -rniE "admin_?password|imgbb|api\.imgbb\.com|deym85810" dist/assets/ || echo "clean"
   ```
   Expected: `clean`.
2. **Wrong password is rejected.** `/admin` with a bad password → *"Incorrect
   email or password."* and no session is created.
3. **Correct password signs in.** The dashboard at `/admin/dashboard` loads and
   admin actions work (they use the same `is_admin()` check).
4. **The hash is not readable.** In the browser console while signed in as admin:
   ```js
   await window.__supabase?.from('admin_users').select('password_hash')
   ```
   or simply open DevTools → Network and inspect any Supabase response — no
   `password_hash` field ever appears.
5. **Photo upload works.** Create a card with a photo; DevTools → Network shows a
   request to `/functions/v1/upload-image`, never to `api.imgbb.com`. The card
   image renders.
6. **Payments still work.** Create a paid card end-to-end (Razorpay/Stripe/PayPal
   in test mode) and confirm the receipt/bill email still arrives.
7. **Pwned-password sanity check** — the request payload for `admin-login`
   contains the typed password (unavoidable over TLS) but the **response**
   contains only tokens, never a hash.

---

## Rotating the admin password later

Two options, both server-side:

* **Re-run the bootstrap** (recommended, no UI needed):
  ```bash
  node scripts/setup-admin.mjs
  ```
* **From the app**: call `POST /functions/v1/admin-credentials` with a valid
  admin session and `{ "current_password": "...", "new_password": "..." }`.
  The `admin-credentials` function is deployed and ready if you want to wire a
  "Change password" form into the dashboard later.

Log in afterwards to confirm both paths agree — `admin-login` self-heals the
Supabase Auth password from the stored hash whenever they drift apart, so the
hash you set is always the password that works.

---

## How the login actually works

```
browser                     admin-login (Edge Function)              Postgres / GoTrue
  │  POST {email, password}         │                                     │
  ├─────────────────────────────────▶│                                     │
  │                                  │ 1. per-IP throttle (10 / 5 min)      │
  │                                  │ 2. admin_login_verify(email, pass) ──▶│ bcrypt check
  │                                  │◀──────── jsonb { ok, user_id } ──────│ + lockout counter
  │                                  │ 3. password grant (server-side) ─────▶│ GoTrue
  │                                  │◀──────── access + refresh token ─────│
  │◀──── { access_token, refresh_token } ────│                             │
  │  supabase.auth.setSession(tokens)                                       │
```

Why mint a real session instead of just returning `true`?

* every existing RLS policy uses `auth.uid()` through `is_admin()`;
* `admin-ops`, `entitlement` and the other Edge Functions verify the JWT;
* Razorpay/Stripe admin comps and the Resend owner copy keep working unchanged.

A pure boolean RPC would have broken all of that.

### Defence in depth

* **bcrypt cost 10** for every stored password.
* **Lockout**: 10 failed attempts lock the account for 15 minutes; the counters
  live in Postgres, so clearing the browser does nothing.
* **Per-IP throttle** in `admin-login` in front of the hash comparison (best
  effort, per warm instance) plus GoTrue's own auth rate limits.
* **No account enumeration**: a wrong password and an unknown email produce the
  same response.
* **Column-level lockdown**: `password_hash`, `failed_logins` and `locked_until`
  are not granted to `anon` or `authenticated` at all.
* **Upload limits**: 5 MB maximum, image mime types only, 30 uploads per network
  per hour recorded durably in `usage_events`.

---

## Rollback

Everything is additive, so you can revert by:

```bash
# redeploy the previous functions (they never changed)
# drop the new functions / columns if you really want to:
```

```sql
-- SQL Editor, only if you need to undo fully
drop function if exists public.admin_rotate_password(text, text);
drop function if exists public.set_admin_password(text, text);
drop function if exists public.admin_login_verify(text, text);
drop function if exists public.admin_password_matches(text, text);
drop function if exists public.admin_hash_password(text);
alter table public.admin_users
  drop column if exists password_hash,
  drop column if exists is_active,
  drop column if exists display_name,
  drop column if exists updated_at,
  drop column if exists last_login_at,
  drop column if exists password_updated_at,
  drop column if exists failed_logins,
  drop column if exists locked_until;
```

Do **not** re-add `VITE_ADMIN_PASSWORD` / `VITE_ADMIN_EMAIL` — restore the old
Supabase-Auth-only login instead.
