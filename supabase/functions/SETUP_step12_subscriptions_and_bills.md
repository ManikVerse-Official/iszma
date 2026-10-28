# Step 12 — Subscription tracker, renewal automation & professional bills

Everything here is additive and best-effort: with no email secret set the app
keeps working and simply logs `skipped` instead of sending.

## 1. Apply the migration

```bash
supabase db push
# or paste supabase/migrations/20261006_step12_subscription_tracker.sql
```

Adds `name`, `status`, `renewal_warned_at` and `admin_granted` to
`studio_subscriptions`, plus the `expire_studio_subscriptions()` helper.

## 2. Set the secrets

```bash
supabase secrets set \
  RESEND_API_KEY=re_xxxxxxxx \
  RECEIPT_FROM_EMAIL="Ishmaverse <receipts@yourdomain.com>" \
  ADMIN_EMAILS="admin@ishmaverse.com" \
  ADMIN_NOTIFY_EMAIL="admin@ishmaverse.com" \
  DEVICE_SECRET=<32+ random bytes> \
  PUBLIC_SITE_URL=https://ishmaverse.com \
  BRAND_LOGO_URL=https://ishmaverse.com/ishmaverse.png \
  SUPPORT_EMAIL=support@ishmaverse.com \
  MAINTENANCE_SECRET=<long-random-string>
```

| Secret | Used for |
|--------|----------|
| `RESEND_API_KEY` | Turns email on. Without it nothing is sent (logged as `skipped`). |
| `RECEIPT_FROM_EMAIL` | The "from" line on every email. |
| `ADMIN_EMAILS` | Emails that get unlimited, free ReportCard Studio access — matched only against a VERIFIED Supabase session email, never a request body. |
| `DEVICE_SECRET` | Signs Studio device tokens and device fingerprints. Required: without it free generations fail closed. |
| `ADMIN_NOTIFY_EMAIL` | Where admin copies of bills/receipts/plan notices go. |
| `PUBLIC_SITE_URL` | Base URL for buttons/links inside emails. |
| `BRAND_LOGO_URL` | Logo printed on every bill/receipt. |
| `SUPPORT_EMAIL` | Reply-to shown in the footer. |
| `MAINTENANCE_SECRET` | Shared secret the cron uses to call `subscription-maintenance`. |
| `RENEWAL_WARN_DAYS` | Optional, default `7`. |

## 3. Deploy the functions

```bash
supabase functions deploy send-email
supabase functions deploy entitlement
supabase functions deploy accountant-bot
supabase functions deploy admin-subscriptions
supabase functions deploy subscription-maintenance
```

## 4. What each piece does

| Function | Endpoint body | Purpose |
|----------|---------------|---------|
| `entitlement` | `{ action: "state" \| "consume" \| "subscribe", email, planId?, feature? }` | Plan + free tries; consumes a use; activates a subscription and emails the bill (plus an admin copy). |
| `admin-subscriptions` | `{ action: "list" \| "cancel" \| "renew" \| "extend", email?, months? }` | Admin-only subscription tracker. Requires an admin Supabase Auth JWT. |
| `subscription-maintenance` | `{}` | Cron: warns plans expiring within `RENEWAL_WARN_DAYS`, switches off lapsed ones, emails the subscriber and the owner. |
| `send-email` | `{ template, to, … }` | `welcome`, `purchase`, `subscription`, `renewal_warning`, `subscription_expired`. |
| `accountant-bot` | `{ payment_id }` | Printable, logo-bearing receipt; also emails the buyer and the owner. |

## 5. Expiry automation

Call `subscription-maintenance` once a day. The migration contains a ready
`cron.schedule(...)` block — uncomment it and fill in your project ref and
`MAINTENANCE_SECRET`:

```sql
select cron.schedule(
  'ishmaverse-subscription-maintenance',
  '0 6 * * *',
  $$ select net.http_post(
       url := 'https://<project-ref>.supabase.co/functions/v1/subscription-maintenance',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'x-maintenance-secret', '<MAINTENANCE_SECRET>'
       ),
       body := '{}'::jsonb
     ); $$
);
```

The job is idempotent: a plan is warned once (`renewal_warned_at`) and expired
once (`status → 'expired'`), so an outage or a re-run can't double-charge or
double-email anyone.

## 6. Billing rules (important)

- Every bill renders an explicit **Cost** column. The word "free" is never used
  as a price.
- An admin comp is billed at the product's **real list price** so the document
  stays professional, while `admin_granted = true` records it as a comp.
- A genuinely free product is billed at **₹0.00**.
- The owner receives a copy of every purchase bill, issued receipt and plan
  notice — marked `[Admin copy]` so it's never confused with the customer's.
- The customer bill is available in the app under ReportCard Studio → Plan.

## 7. Free-try rules (all server-enforced)

```ts
free_greeting:     { perEmail: 1, perIpEmails: 2, perIpTotal: 2, windowHours: 24 }
studio_generation: { perEmail: 7, perIpEmails: 0, perIpTotal: 0 }
```

- A free greeting card is one per email per rolling 24 hours (atomic:
  `consume_free_greeting`, step 19).
- ReportCard Studio allows **7 free generations per email AND per device**
  (atomic: `consume_studio_generation`, step 20). Both are counted on the same
  usage row, so changing the email on one device does not reset the device
  allowance and vice versa.
- The Studio per-IP caps are intentionally 0 (off): the device and email
  counters replaced them, and 3 devices per fingerprint / 5 fingerprints per
  email bound "clear storage and start again".
- Admins (verified session + `admin_users`) bypass the limits entirely, are never
  charged, and never consume a free try.
