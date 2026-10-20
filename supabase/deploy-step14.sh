#!/usr/bin/env bash
#
# Ishmaverse · Step 14 — one-shot deploy
# ---------------------------------------------------------------------------
# Moves the admin credentials and the ImgBB key onto the backend, then deploys
# the functions that use them.
#
# Prerequisites:
#   1. Supabase CLI available (the script uses `npx supabase`).
#   2. `npx supabase login`                         (once)
#   3. `npx supabase link --project-ref <ref>`      (once, already done here)
#   4. IMGBB_API_KEY set as a secret BEFORE running (see below)
#
# Usage:
#   bash supabase/deploy-step14.sh
#
# Secrets (set these first — the script warns when they are missing):
#   npx supabase secrets set IMGBB_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "▶ Ishmaverse Step 14 deploy"
echo "  project: $ROOT_DIR"
echo

if [[ -z "${IMGBB_API_KEY:-}" ]]; then
  echo "⚠  IMGBB_API_KEY is not set in this shell."
  echo "   Photo uploads will return 503 until you run:"
  echo "     npx supabase secrets set IMGBB_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  echo
fi

echo "▶ 1/4  Applying the database migration (npx supabase db push)…"
npx supabase db push

echo
echo "▶ 2/4  Deploying the new Edge Functions…"
for fn in admin-login admin-credentials upload-image; do
  echo "   • $fn"
  npx supabase functions deploy "$fn"
done

echo
echo "▶ 3/4  Storing the admin credential hash…"
echo "   Run this once (it prompts for the email and password):"
echo "     node scripts/setup-admin.mjs"
echo "   Skip it if the admin already has a password_hash in admin_users."
echo
read -r -p "   Run it now? [y/N] " run_setup || true
if [[ "${run_setup:-}" =~ ^[Yy]$ ]]; then
  node scripts/setup-admin.mjs
else
  echo "   Skipped — remember to run it before signing in."
fi

echo
echo "▶ 4/4  Done."
echo
echo "Now remove these from .env AND from Vercel → Settings → Environment Variables,"
echo "then redeploy the site so the old values are no longer baked into the bundle:"
echo "  • VITE_ADMIN_EMAIL"
echo "  • VITE_ADMIN_PASSWORD"
echo "  • VITE_IMGBB_API_KEY"
echo
echo "Full checklist: SECURITY_STEP14.md"
