# Step 9 — Usage limits, emails & the free card

This adds the server-side pieces so the browser can't reset free usage and so
Ishmaverse can send transactional email. Everything is best-effort: if a secret
is missing the feature degrades instead of breaking the app.

## 1. Apply the migration

```bash
supabase db push
# (or paste supabase/migrations/20261003_step9_usage_and_studio.sql into the SQL editor)
```

Creates `usage_events`, `studio_subscriptions` and `email_log` (locked to the
service role only).

## 2. Set the secrets

```bash
supabase secrets set \
  RESEND_API_KEY=re_xxxxxxxx \
  RECEIPT_FROM_EMAIL="Ishmaverse <receipts@yourdomain.com>" \
  PUBLIC_SITE_URL=https://ishmaverse.com
```

`RESEND_API_KEY` is what actually turns email on. Without it, `send-email`
still returns success but logs `skipped`, so nothing breaks.

## 3. Deploy the functions

```bash
supabase functions deploy send-email
supabase functions deploy entitlement
supabase functions deploy create-free-greeting
```

## 4. How each piece works

| Function               | Endpoint body                                                        | Purpose |
|------------------------|----------------------------------------------------------------------|---------|
| `send-email`           | `{ template: "welcome" \| "purchase" \| "subscription", to, name, ... }` | Welcome / thank-you + bill / plan confirmation via Resend. Logs to `email_log`. |
| `entitlement`          | `{ action: "state" \| "consume" \| "subscribe", email, planId?, feature? }` | ReportCard Studio plan + free uses; consumes a use; activates a subscription. |
| `create-free-greeting` | same as `create-greeting` minus `payment`                            | Mints the single free basic card, enforcing the free limits. |

## 5. Free-use rules (edit in `_shared/plans.ts`)

```ts
free_greeting:     { perEmail: 1, perIpEmails: 2, perIpTotal: 2  }
studio_generation: { perEmail: 7, perIpEmails: 2, perIpTotal: 14 }
```

Generating in ReportCard Studio now requires a signed-in account, and an
account that matches `ADMIN_EMAILS` (or is on `ADMIN_IPS`) is unlimited and
never consumes free tries. See `SETUP_step12_subscriptions_and_bills.md`.

- **perEmail** — free claims allowed for one email address.
- **perIpEmails** — distinct emails allowed from one IP.
- **perIpTotal** — hard cap of free claims from one IP.

The client IP is read from `x-forwarded-for` / `cf-connecting-ip`; it is never
taken from the request body.

## 6. Wire the frontend (already scaffolded)

- `src/services/notify.ts` — `sendWelcomeEmail`, `sendPurchaseEmail`,
  `sendSubscriptionEmail`. The purchase thank-you/bill is already sent from the
  card flow (skipped when the accountant receipt was already emailed).
- ReportCard Studio keeps its own entitlement client
  (`src/services/entitlementApi.ts` + `src/store/entitlementStore.ts`), which is
  where the plan/free-use calls actually run. The mall app has no separate
  client of its own.

## 7. ReportCard Studio — server-enforced entitlement (wired)

The store (`src/store/entitlementStore.ts`) already calls the `entitlement`
function and caches the result locally:

- `refreshFromServer()` fetches the plan + free uses (`action: "state"`) on
  mount and before every generation.
- `consumeUse()` mirrors each generation to the server (`action: "consume"`).
- `activatePlan()` records the subscription (`action: "subscribe"`), which also
  sends the bill/confirmation email.

The client lives in `src/services/supabase.ts` + `src/services/entitlementApi.ts`
(plain `fetch`, no dependency). **To turn it on, set these in ReportCard Studio**
(copy `.env.example` to `.env`):

```
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
```

With them empty, ReportCard Studio keeps working offline using its local store.
