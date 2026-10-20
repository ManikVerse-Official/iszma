#!/usr/bin/env node
/**
 * Ishmaverse · one-time admin credential setup
 * ---------------------------------------------------------------------------
 * Stores the admin's bcrypt password hash in `public.admin_users` and makes sure
 * the matching Supabase Auth user exists, so `admin-login` can mint a real
 * session. Run it once from the repo root:
 *
 *   node scripts/setup-admin.mjs
 *
 * It needs the SERVICE ROLE key (a secret — never commit it, never put it in
 * Vercel, never prefix it with VITE_). Provide it either way:
 *
 *   • in `.env.local` (git-ignored):   SUPABASE_SERVICE_ROLE_KEY=...
 *   • or inline for one run:           SUPABASE_SERVICE_ROLE_KEY=... node scripts/setup-admin.mjs
 *
 * Use it again any time you want to rotate the admin password. Nothing here is
 * ever sent to the browser.
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_PASSWORD_LENGTH = 10;

/* ------------------------------------------------------------------ */
/* Env loading                                                         */
/* ------------------------------------------------------------------ */

const parseEnvFile = (file) => {
  const values = {};
  if (!fs.existsSync(file)) return values;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
};

const fromFiles = {
  ...parseEnvFile(path.join(ROOT, '.env')),
  ...parseEnvFile(path.join(ROOT, '.env.local')),
};

const pick = (...keys) => {
  for (const key of keys) {
    const value = (process.env[key] ?? fromFiles[key] ?? '').trim();
    if (value) return value;
  }
  return '';
};

const supabaseUrl = pick('SUPABASE_URL', 'VITE_SUPABASE_URL');
const serviceKey = pick('SUPABASE_SERVICE_ROLE_KEY');

/* ------------------------------------------------------------------ */
/* Prompts                                                             */
/* ------------------------------------------------------------------ */

const ask = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });

/** Reads a password without echoing it to the terminal. */
const askHidden = (question) =>
  new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', (line) => {
        rl.close();
        resolve(line.trim());
      });
      return;
    }

    process.stdout.write(question);
    const wasRaw = Boolean(process.stdin.isRaw);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let value = '';
    const onData = (chunk) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (char === '\u0003') {
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    const cleanup = () => {
      process.stdin.removeListener('data', onData);
      process.stdin.setRawMode(wasRaw);
      process.stdin.pause();
    };

    process.stdin.on('data', onData);
  });

/* ------------------------------------------------------------------ */
/* Supabase calls                                                      */
/* ------------------------------------------------------------------ */

const restHeaders = () => ({
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  'Content-Type': 'application/json',
});

/** Calls public.set_admin_password(...). Returns the parsed jsonb result. */
const setAdminPassword = async (email, password) => {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/set_admin_password`, {
    method: 'POST',
    headers: restHeaders(),
    body: JSON.stringify({ p_email: email, p_password: password }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`set_admin_password failed (${response.status}): ${text}`);
  }
  return JSON.parse(text || '{}');
};

/** Creates the Supabase Auth user (idempotent: 422 means it already exists). */
const createAuthUser = async (email, password) => {
  const response = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: 'POST',
    headers: restHeaders(),
    body: JSON.stringify({ email, password, email_confirm: true }),
  });

  if (response.ok) return { created: true };
  if (response.status === 422) return { created: false, alreadyExists: true };

  const text = await response.text();
  throw new Error(`Could not create the Auth user (${response.status}): ${text}`);
};

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

const main = async () => {
  console.log('\nIshmaverse · admin credential setup');
  console.log('-----------------------------------');

  if (!supabaseUrl) {
    console.error(
      '\n✖ SUPABASE_URL (or VITE_SUPABASE_URL) was not found in the environment, .env or .env.local.',
    );
    process.exit(1);
  }

  if (!serviceKey) {
    console.error(
      [
        '\n✖ SUPABASE_SERVICE_ROLE_KEY is required.',
        '  Find it in Supabase → Project Settings → API → service_role (secret).',
        '  Then either add it to .env.local (git-ignored):',
        '',
        '      SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi...',
        '',
        '  …or run this script once with it inline:',
        '',
        '      SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOi... node scripts/setup-admin.mjs',
        '',
      ].join('\n'),
    );
    process.exit(1);
  }

  const email = (process.env.ADMIN_EMAIL ?? (await ask('Admin email: '))).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('\n✖ That does not look like a valid email address.');
    process.exit(1);
  }

  const password = process.env.ADMIN_PASSWORD ?? (await askHidden('New admin password (hidden): '));
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`\n✖ The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    process.exit(1);
  }

  if (password !== (process.env.ADMIN_PASSWORD ?? password)) {
    console.error('\n✖ Passwords did not match.');
    process.exit(1);
  }

  console.log(`\n▶ Storing the credential hash for ${email} …`);

  // The RPC needs an auth.users row; create it only when it is missing.
  let result = await setAdminPassword(email, password);

  if (result?.code === 'no_auth_user') {
    console.log('  • No Supabase Auth user yet — creating one…');
    await createAuthUser(email, password);
    result = await setAdminPassword(email, password);
  }

  if (result?.ok !== true) {
    console.error(`\n✖ Setup failed: ${result?.message ?? result?.code ?? 'unknown error'}`);
    process.exit(1);
  }

  console.log('\n✅ Admin credentials stored in public.admin_users.');
  console.log('   Sign in at /admin with this email and password.');
  console.log('   Remember to remove SUPABASE_SERVICE_ROLE_KEY from .env.local when you are done.\n');
};

main().catch((error) => {
  console.error('\n✖ Unexpected error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
