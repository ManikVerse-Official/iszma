/*
 * ReportCard Studio free-limit + admin-access regression check.
 *
 * Pins the required policy end to end:
 *
 *   • SEVEN free generations per email AND per device; whichever runs out first
 *     blocks, and the block can only be lifted by a subscription;
 *   • changing the email on one device does NOT reset the device allowance, and
 *     using the email on a second device does NOT reset the email allowance;
 *   • concurrent requests cannot slip past the limit, and one generation is
 *     counted once even if the request is retried;
 *   • a missing, forged or unregistered device is refused; an admin is not
 *     refused and does not consume anything;
 *   • a database failure fails CLOSED (no generation), never open;
 *   • admin access comes from a verified session + `admin_users`, never from an
 *     email/flag in the request body, and the IP-based bypass is gone;
 *   • the database functions are service-role only.
 *
 * The database function is exercised through a mock that implements the SQL
 * semantics (including the advisory-lock serialisation and the run-id
 * idempotency), so concurrency is testable without a live database. The SQL
 * itself is asserted on the migration text.
 *
 * Run: npm run check:studio-limits
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEVICES_PER_FINGERPRINT,
  FINGERPRINTS_PER_EMAIL,
  STUDIO_FREE_GENERATIONS,
  USAGE_UNAVAILABLE_MESSAGE,
  claimStudioGeneration,
  deviceKeyFor,
  fingerprintFor,
  isDeviceIdentityConfigured,
  issueDeviceToken,
  verifyDeviceToken,
} from '../supabase/functions/_shared/studioLimits.ts';
import { adminEmailAllowlist, decideAdminAccess } from '../supabase/functions/_shared/adminPolicy.ts';
import { studioState } from '../supabase/functions/_shared/entitlement.ts';
import { FREE_LIMITS } from '../supabase/functions/_shared/plans.ts';

/*
 * The Studio limit module reads `DEVICE_SECRET` from the environment the same way
 * an Edge Function does. Provide a test secret, so token signing/verification is
 * exercised exactly as it is in production. (The module reads it lazily, so this
 * only has to be in place before the first call.)
 */
const TEST_SECRET = 'test-device-secret-0123456789abcdef';
(globalThis as { Deno?: unknown }).Deno = {
  env: { get: (name: string) => (name === 'DEVICE_SECRET' ? TEST_SECRET : undefined) },
};

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

/* ── a mock that behaves like `consume_studio_generation` ─────────────── */

interface UsageRow {
  id: string;
  feature: string;
  email: string;
  deviceKey: string;
  userId: string | null;
  runId: string | null;
}

interface DeviceRow {
  fingerprint: string;
  email: string;
  claimCount: number;
}

const FEATURE = 'studio_generation';

const createMockDatabase = () => {
  const usage: UsageRow[] = [];
  const devices = new Map<string, DeviceRow>();
  let sequence = 0;

  const deny = (code: string) => [
    {
      allowed: false,
      code,
      message: null,
      remaining: 0,
      remaining_device: 0,
      claim_id: null,
      already_claimed: false,
    },
  ];

  const consume = (args: Record<string, unknown>): unknown => {
    const email = String(args.p_email ?? '');
    const deviceKey = String(args.p_device_key ?? '');
    const fingerprint = String(args.p_fingerprint ?? '');
    const runId = (args.p_run_id as string | null) ?? null;
    const perEmail = Number(args.p_per_email ?? STUDIO_FREE_GENERATIONS);
    const perDevice = Number(args.p_per_device ?? STUDIO_FREE_GENERATIONS);

    if (!email) return deny('INVALID_REQUEST');
    if (!deviceKey) return deny('DEVICE_REQUIRED');

    // Run-id idempotency first: a retry is the SAME generation.
    if (runId) {
      const existing = usage.find((row) => row.feature === FEATURE && row.runId === runId);
      if (existing) {
        const emailCount = usage.filter((row) => row.email === email).length;
        const deviceCount = usage.filter((row) => row.deviceKey === deviceKey).length;
        return [
          {
            allowed: true,
            code: null,
            message: null,
            remaining: Math.max(perEmail - emailCount, 0),
            remaining_device: Math.max(perDevice - deviceCount, 0),
            claim_id: existing.id,
            already_claimed: true,
          },
        ];
      }
    }

    const device = devices.get(deviceKey);
    if (device) {
      if (fingerprint) device.fingerprint = fingerprint;
      device.email = email;
    } else {
      devices.set(deviceKey, { fingerprint, email, claimCount: 0 });
    }

    const emailCount = usage.filter((row) => row.feature === FEATURE && row.email === email).length;
    const deviceCount = usage.filter((row) => row.feature === FEATURE && row.deviceKey === deviceKey).length;

    if (emailCount >= perEmail) return deny('FREE_LIMIT_EMAIL');
    if (deviceCount >= perDevice) return deny('FREE_LIMIT_DEVICE');

    if (fingerprint) {
      const fpDevices = new Set(
        [...devices.entries()]
          .filter(([key, row]) => row.fingerprint === fingerprint && key !== deviceKey && row.claimCount > 0)
          .map(([key]) => key),
      ).size;
      if (fpDevices >= DEVICES_PER_FINGERPRINT) return deny('FREE_LIMIT_DEVICE');

      const emailFingerprints = new Set(
        [...devices.entries()]
          .filter(
            ([, row]) =>
              row.email === email && row.fingerprint !== fingerprint && row.claimCount > 0,
          )
          .map(([, row]) => row.fingerprint),
      ).size;
      if (emailFingerprints >= FINGERPRINTS_PER_EMAIL) return deny('FREE_LIMIT_EMAIL');
    }

    sequence += 1;
    const row: UsageRow = {
      id: `claim-${sequence}`,
      feature: FEATURE,
      email,
      deviceKey,
      userId: (args.p_user_id as string | null) ?? null,
      runId,
    };
    usage.push(row);
    const stored = devices.get(deviceKey);
    if (stored) stored.claimCount += 1;

    return [
      {
        allowed: true,
        code: null,
        message: null,
        remaining: Math.max(perEmail - (emailCount + 1), 0),
        remaining_device: Math.max(perDevice - (deviceCount + 1), 0),
        claim_id: row.id,
        already_claimed: false,
      },
    ];
  };

  /* One in-flight claim per email/device at a time — the SQL takes transaction
   * advisory locks in that order, so interleaved requests serialise. */
  const locks = new Map<string, Promise<void>>();
  const withLock = async <T>(keys: string[], work: () => T): Promise<T> => {
    const previous = keys.map((key) => locks.get(key) ?? Promise.resolve());
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const key of keys) locks.set(key, held);
    await Promise.all(previous);
    try {
      // A turn of the event loop, so interleaving is real.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return work();
    } finally {
      release();
      for (const key of keys) if (locks.get(key) === held) locks.delete(key);
    }
  };

  return {
    usage,
    devices,
    client: {
      async rpc(fn: string, args: Record<string, unknown>) {
        if (fn === 'consume_studio_generation') {
          return {
            data: await withLock(
              [
                `email:${String(args.p_email ?? '')}`,
                `device:${String(args.p_device_key ?? '')}`,
              ],
              () => consume(args),
            ),
            error: null,
          };
        }
        if (fn === 'release_studio_claim') {
          const claimId = String(args.p_claim_id ?? '');
          const index = usage.findIndex((row) => row.id === claimId);
          if (index >= 0) {
            const [removed] = usage.splice(index, 1);
            const device = devices.get(removed.deviceKey);
            if (device) device.claimCount = Math.max(0, device.claimCount - 1);
            return { data: true, error: null };
          }
          return { data: false, error: null };
        }
        if (fn === 'register_studio_device') {
          const key = String(args.p_device_key ?? '');
          const fingerprint = String(args.p_fingerprint ?? '');
          const email = String(args.p_email ?? '');
          if (!key || !fingerprint) {
            return { data: null, error: { code: 'P0001', message: 'device key required' } };
          }
          const existing = devices.get(key);
          if (existing) {
            existing.fingerprint = fingerprint;
            existing.email = email || existing.email;
          } else {
            devices.set(key, { fingerprint, email, claimCount: 0 });
          }
          return { data: [{ devices_on_fingerprint: 1, claim_count: devices.get(key)?.claimCount ?? 0 }], error: null };
        }
        return { data: null, error: { code: 'PGRST202', message: `unknown function ${fn}` } };
      },
    },
  };
};

/** A device: its client id, its signed token, and its fingerprints. */
const makeDevice = async (id: string, fingerprint = 'fp-default') => {
  const key = await deviceKeyFor(id);
  const { token } = await issueDeviceToken(key);
  return { id, key, token, fingerprint };
};

const runTests = async (): Promise<void> => {
  /* ------------------------------------------------------------------ */
  /* 0. Policy                                                           */
  /* ------------------------------------------------------------------ */
  check(
    'the policy is seven free generations',
    STUDIO_FREE_GENERATIONS === 7 && FREE_LIMITS.studio_generation.perEmail === 7,
    `limit=${STUDIO_FREE_GENERATIONS}`,
  );
  check('device identity is configured (secret present)', isDeviceIdentityConfigured());

  /* ------------------------------------------------------------------ */
  /* 1. Seven generations, then blocked                                  */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();
    const device = await makeDevice('device-a-000000000001');
    let allowed = 0;
    let firstRefusal: string | undefined;

    for (let i = 0; i < 9; i += 1) {
      const decision = await claimStudioGeneration(db.client, {
        email: 'teacher@school.com',
        userId: null,
        deviceToken: device.token,
        fingerprint: device.fingerprint,
        ip: '203.0.113.9',
        runId: `run-aaaaaaaaaaaaaaaa-${i}`,
        isAdmin: false,
      });
      if (decision.allowed) allowed += 1;
      else firstRefusal = decision.code;
    }

    check('exactly 7 generations are granted for one email/device', allowed === 7, `allowed=${allowed}`);
    check('the 8th is refused on the email allowance', firstRefusal === 'FREE_LIMIT_EMAIL', String(firstRefusal));
    check('the database holds one row per granted generation', db.usage.length === 7);
  }

  /* ------------------------------------------------------------------ */
  /* 2. Same email, different device -> email allowance still binds      */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();
    const first = await makeDevice('device-b-000000000001');
    const second = await makeDevice('device-b-000000000002');

    for (let i = 0; i < 7; i += 1) {
      await claimStudioGeneration(db.client, {
        email: 'shared@school.com',
        userId: null,
        deviceToken: first.token,
        fingerprint: first.fingerprint,
        ip: '',
        runId: `run-bbbbbbbbbbbbbbbb-${i}`,
        isAdmin: false,
      });
    }

    const other = await claimStudioGeneration(db.client, {
      email: 'shared@school.com',
      userId: null,
      deviceToken: second.token,
      fingerprint: second.fingerprint,
      ip: '',
      runId: 'run-bbbbbbbbbbbbbbbb-x',
      isAdmin: false,
    });

    check(
      'a second device with the same email does not reset the email allowance',
      !other.allowed && other.code === 'FREE_LIMIT_EMAIL',
      String(other.code),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 3. Different emails, same device -> device allowance still binds    */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();
    const device = await makeDevice('device-c-000000000001');

    for (let i = 0; i < 7; i += 1) {
      await claimStudioGeneration(db.client, {
        email: `user${i}@school.com`,
        userId: null,
        deviceToken: device.token,
        fingerprint: device.fingerprint,
        ip: '',
        runId: `run-cccccccccccccccc-${i}`,
        isAdmin: false,
      });
    }

    const stranger = await claimStudioGeneration(db.client, {
      email: 'brand-new@school.com',
      userId: null,
      deviceToken: device.token,
      fingerprint: device.fingerprint,
      ip: '',
      runId: 'run-cccccccccccccccc-x',
      isAdmin: false,
    });

    check(
      'changing the email on the same device does not reset the device allowance',
      !stranger.allowed && stranger.code === 'FREE_LIMIT_DEVICE',
      String(stranger.code),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 4. Concurrent requests cannot exceed the limit                      */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();
    const device = await makeDevice('device-d-000000000001');

    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        claimStudioGeneration(db.client, {
          email: 'concurrent@school.com',
          userId: null,
          deviceToken: device.token,
          fingerprint: device.fingerprint,
          ip: '',
          runId: `run-dddddddddddddddd-${i}`,
          isAdmin: false,
        }),
      ),
    );

    const allowed = decisions.filter((decision) => decision.allowed).length;
    check('20 concurrent claims grant exactly 7', allowed === 7, `allowed=${allowed}`);
    check('the database never records more than the limit', db.usage.length === 7);
  }

  /* ------------------------------------------------------------------ */
  /* 5. A retried request counts once                                    */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();
    const device = await makeDevice('device-e-000000000001');
    const input = {
      email: 'retry@school.com',
      userId: null,
      deviceToken: device.token,
      fingerprint: device.fingerprint,
      ip: '',
      runId: 'run-eeeeeeeeeeeeeeee-1',
      isAdmin: false,
    };

    const first = await claimStudioGeneration(db.client, input);
    const again = await claimStudioGeneration(db.client, input);

    check('the first attempt claims a generation', first.allowed && !first.alreadyClaimed);
    check('the retry is the same generation', again.allowed && again.alreadyClaimed);
    check('the retry did not consume a second generation', db.usage.length === 1, `rows=${db.usage.length}`);
  }

  /* ------------------------------------------------------------------ */
  /* 6. Admin bypass                                                     */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();
    const device = await makeDevice('device-f-000000000001');

    const decisions = [];
    for (let i = 0; i < 12; i += 1) {
      decisions.push(
        await claimStudioGeneration(db.client, {
          email: 'admin@ishmaverse.com',
          userId: '00000000-0000-0000-0000-0000000000ad',
          deviceToken: device.token,
          fingerprint: device.fingerprint,
          ip: '',
          runId: `run-ffffffffffffffff-${i}`,
          isAdmin: true,
        }),
      );
    }

    check('an admin is never blocked', decisions.every((decision) => decision.allowed));
    check('an admin claim writes no usage row', db.usage.length === 0);
    check(
      'an admin keeps the full allowance reported',
      decisions.every((decision) => decision.remainingEmail === STUDIO_FREE_GENERATIONS),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 7. Unauthorised / unusable device                                   */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();

    const noToken = await claimStudioGeneration(db.client, {
      email: 'someone@school.com',
      userId: null,
      deviceToken: undefined,
      fingerprint: 'fp-x',
      ip: '',
      runId: 'run-gggggggggggggggg-1',
      isAdmin: false,
    });
    check(
      'a request without a registered device is refused',
      !noToken.allowed && noToken.code === 'DEVICE_REQUIRED',
      String(noToken.code),
    );

    const forged = await claimStudioGeneration(db.client, {
      email: 'someone@school.com',
      userId: null,
      deviceToken: `${await deviceKeyFor('device-made-up-0000001')}.1700000000.${'a'.repeat(64)}`,
      fingerprint: 'fp-x',
      ip: '',
      runId: 'run-gggggggggggggggg-2',
      isAdmin: false,
    });
    check(
      'a forged device token is refused',
      !forged.allowed && forged.code === 'DEVICE_REQUIRED',
      String(forged.code),
    );
    check('nothing was written for the refused requests', db.usage.length === 0);
  }

  /* ------------------------------------------------------------------ */
  /* 8. Fail closed on a database error                                  */
  /* ------------------------------------------------------------------ */
  {
    const failingClient = {
      async rpc() {
        return { data: null, error: { code: 'PGRST202', message: 'function does not exist' } };
      },
    };
    const device = await makeDevice('device-h-000000000001');

    const decision = await claimStudioGeneration(failingClient, {
      email: 'someone@school.com',
      userId: null,
      deviceToken: device.token,
      fingerprint: device.fingerprint,
      ip: '',
      runId: 'run-hhhhhhhhhhhhhhhh-1',
      isAdmin: false,
    });

    check(
      'a database failure never grants a generation',
      !decision.allowed && decision.code === 'USAGE_UNAVAILABLE',
      String(decision.code),
    );
    check('the failure message is the retryable one', decision.message === USAGE_UNAVAILABLE_MESSAGE);
  }

  /* ------------------------------------------------------------------ */
  /* 9. Device tokens                                                    */
  /* ------------------------------------------------------------------ */
  {
    const key = await deviceKeyFor('device-i-000000000001');
    const { token } = await issueDeviceToken(key);
    check('an issued token verifies back to its device key', (await verifyDeviceToken(token)) === key);
    check('a token with an edited key is rejected', (await verifyDeviceToken(`${'f'.repeat(64)}.1700000000.${token.split('.')[2]}`)) === null);
    check('a token with an edited signature is rejected', (await verifyDeviceToken(`${token.split('.').slice(0, 2).join('.')}.${'0'.repeat(64)}`)) === null);
    check('garbage is rejected', (await verifyDeviceToken('not-a-token')) === null);

    const request = new Request('https://example.test/entitlement', {
      headers: { 'user-agent': 'UA/1', 'accept-language': 'en-GB' },
    });
    const other = new Request('https://example.test/entitlement', {
      headers: { 'user-agent': 'UA/2', 'accept-language': 'en-GB' },
    });
    check(
      'the fingerprint is stable for one browser and differs for another',
      (await fingerprintFor(request)) === (await fingerprintFor(request)) &&
        (await fingerprintFor(request)) !== (await fingerprintFor(other)),
    );
    check(
      'the raw device id is never the stored key',
      key !== 'device-i-000000000001' && /^[0-9a-f]{64}$/.test(key),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 10. Reset resistance: devices per fingerprint, fingerprints per email */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();
    const sameBrowser = 'fp-identical-school-machine';

    for (let i = 0; i < DEVICES_PER_FINGERPRINT; i += 1) {
      const device = await makeDevice(`device-j-${String(i).padStart(12, '0')}`, sameBrowser);
      const decision = await claimStudioGeneration(db.client, {
        email: `child${i}@school.com`,
        userId: null,
        deviceToken: device.token,
        fingerprint: sameBrowser,
        ip: '',
        runId: `run-jjjjjjjjjjjjjjjj-${i}`,
        isAdmin: false,
      });
      check(`device ${i + 1} of the fingerprint is allowed`, decision.allowed, String(decision.code));
    }

    const extra = await makeDevice('device-j-999999999999', sameBrowser);
    const blocked = await claimStudioGeneration(db.client, {
      email: 'another@school.com',
      userId: null,
      deviceToken: extra.token,
      fingerprint: sameBrowser,
      ip: '',
      runId: 'run-jjjjjjjjjjjjjjjj-extra',
      isAdmin: false,
    });
    check(
      'clearing storage repeatedly is capped per fingerprint',
      !blocked.allowed && blocked.code === 'FREE_LIMIT_DEVICE',
      String(blocked.code),
    );
  }

  {
    const db = createMockDatabase();
    const email = 'roaming@school.com';

    for (let i = 0; i < FINGERPRINTS_PER_EMAIL; i += 1) {
      const device = await makeDevice(`device-k-${String(i).padStart(12, '0')}`, `fp-roam-${i}`);
      const decision = await claimStudioGeneration(db.client, {
        email,
        userId: null,
        deviceToken: device.token,
        fingerprint: `fp-roam-${i}`,
        ip: '',
        runId: `run-kkkkkkkkkkkkkkkk-${i}`,
        isAdmin: false,
      });
      check(`fingerprint ${i + 1} for the email is allowed`, decision.allowed, String(decision.code));
    }

    const wanderer = await makeDevice('device-k-999999999999', 'fp-roam-99');
    const blocked = await claimStudioGeneration(db.client, {
      email,
      userId: null,
      deviceToken: wanderer.token,
      fingerprint: 'fp-roam-99',
      ip: '',
      runId: 'run-kkkkkkkkkkkkkkkk-extra',
      isAdmin: false,
    });
    check(
      'one email is capped across devices',
      !blocked.allowed && blocked.code === 'FREE_LIMIT_EMAIL',
      String(blocked.code),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 11. A reported failure gives the generation back                    */
  /* ------------------------------------------------------------------ */
  {
    const db = createMockDatabase();
    const device = await makeDevice('device-l-000000000001');
    const decision = await claimStudioGeneration(db.client, {
      email: 'failed-run@school.com',
      userId: null,
      deviceToken: device.token,
      fingerprint: device.fingerprint,
      ip: '',
      runId: 'run-llllllllllllllll-1',
      isAdmin: false,
    });
    check('a claim is made before the run', decision.allowed && db.usage.length === 1);

    await db.client.rpc('release_studio_claim', { p_claim_id: decision.claimId });
    check('a failed run gives the generation back', db.usage.length === 0);

    const retry = await claimStudioGeneration(db.client, {
      email: 'failed-run@school.com',
      userId: null,
      deviceToken: device.token,
      fingerprint: device.fingerprint,
      ip: '',
      runId: 'run-llllllllllllllll-2',
      isAdmin: false,
    });
    check(
      'the allowance is usable again after a failure',
      retry.allowed && retry.remainingEmail === STUDIO_FREE_GENERATIONS - 1,
      `remaining=${retry.remainingEmail}`,
    );
  }

  /* ------------------------------------------------------------------ */
  /* 12. State reports both allowances                                   */
  /* ------------------------------------------------------------------ */
  {
    const noPlanClient = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
      }),
    };

    const free = await studioState(noPlanClient as never, 'user@school.com', false, {
      emailUsed: 7,
      deviceUsed: 2,
      deviceRegistered: true,
    });
    check(
      'the tighter allowance decides what is left',
      free.freeRemaining === 0 && free.emailRemaining === 0 && free.deviceRemaining === 5,
      JSON.stringify({ freeRemaining: free.freeRemaining, email: free.emailRemaining, device: free.deviceRemaining }),
    );

    const partial = await studioState(noPlanClient as never, 'user@school.com', false, {
      emailUsed: 3,
      deviceUsed: 5,
      deviceRegistered: true,
    });
    check('the device allowance can be the binding one', partial.freeRemaining === 2);

    const admin = await studioState(noPlanClient as never, 'admin@ishmaverse.com', true, {
      emailUsed: 7,
      deviceUsed: 7,
      deviceRegistered: true,
    });
    check('an admin always reports the full allowance', admin.freeRemaining === 7 && admin.isAdmin);

    const planClient = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: {
                plan_id: 'holistic',
                status: 'active',
                expires_at: new Date(Date.now() + 86_400_000).toISOString(),
              },
              error: null,
            }),
          }),
        }),
      }),
    };
    const subscriber = await studioState(planClient as never, 'paid@school.com', false, {
      emailUsed: 2,
      deviceUsed: 7,
      deviceRegistered: true,
    });
    check(
      'an active subscription is unlimited even when both counters are low',
      subscriber.planActive && subscriber.freeRemaining === 7,
      JSON.stringify({ plan: subscriber.planActive, remaining: subscriber.freeRemaining }),
    );
  }

  /* ------------------------------------------------------------------ */
  /* 13. Admin policy — no client-side trust                             */
  /* ------------------------------------------------------------------ */
  {
    check(
      'an anonymous caller is not an admin',
      !decideAdminAccess({ userId: null, email: 'admin@ishmaverse.com', membershipActive: false }).isAdmin,
    );
    check(
      'a claimed admin email without a session is not an admin',
      !decideAdminAccess({ userId: null, email: 'deym85810@gmail.com', membershipActive: false }).isAdmin,
    );
    check(
      'admin_users membership grants access',
      decideAdminAccess({ userId: 'u1', email: 'anything@x.com', membershipActive: true }).source ===
        'admin_users',
    );
    check(
      'a VERIFIED allow-listed email grants access',
      decideAdminAccess({
        userId: 'u2',
        email: 'Owner@Ishmaverse.com',
        membershipActive: false,
        allowlistRaw: 'owner@ishmaverse.com',
      }).source === 'verified_email',
    );
    check(
      'an unlisted verified email is a normal user',
      !decideAdminAccess({
        userId: 'u3',
        email: 'teacher@school.com',
        membershipActive: false,
        allowlistRaw: 'owner@ishmaverse.com',
      }).isAdmin,
    );
    check('the allowlist defaults to the owner address', adminEmailAllowlist('').length === 1);
  }

  /* ------------------------------------------------------------------ */
  /* 14. Source + SQL invariants                                         */
  /* ------------------------------------------------------------------ */
  {
    const adminSrc = source('supabase/functions/_shared/admin.ts');
    check(
      'the IP/email-only admin bypass is gone from the shared admin module',
      !/export const isAdminRequest/.test(adminSrc) && !/export const isAdminIp/.test(adminSrc),
    );

    const entitlementSrc = source('supabase/functions/entitlement/index.ts');
    check(
      'the entitlement function derives admin from the verified session',
      entitlementSrc.includes('resolveAdminAccess(req, supabase)') &&
        !entitlementSrc.includes('isAdminRequest'),
    );
    check(
      'the body email is never used as an admin identity',
      !/isAdmin\s*=\s*[^;]*\bemail\b/.test(entitlementSrc.replace(/access\.isAdmin/g, 'accessIsAdmin')),
    );
    check(
      'Studio free generations go through the atomic claim',
      entitlementSrc.includes('claimStudioGeneration'),
    );

    const freeGreetingSrc = source('supabase/functions/create-free-greeting/index.ts');
    check(
      'the free greeting bypasses the 24h limit for a verified admin only',
      freeGreetingSrc.includes('resolveAdminAccess') && freeGreetingSrc.includes('access.isAdmin'),
    );

    const createGreetingSrc = source('supabase/functions/create-greeting/index.ts');
    check(
      'the hardcoded admin email is gone from create-greeting',
      !createGreetingSrc.includes('deym85810@gmail.com') &&
        createGreetingSrc.includes('resolveAdminAccess'),
    );

    const migration = source('supabase/migrations/20261026_step20_admin_bypass_and_studio_limits.sql');
    check(
      'the migration locks the functions to the service role',
      /revoke all on function public\.consume_studio_generation[\s\S]*?from public, anon, authenticated/.test(
        migration,
      ) &&
        /grant execute on function public\.consume_studio_generation[\s\S]*?to service_role/.test(migration),
    );
    check(
      'the claim function serialises on the email AND the device',
      migration.includes("pg_advisory_xact_lock(hashtext('studio:email:' || v_email)") &&
        migration.includes("pg_advisory_xact_lock(hashtext('studio:device:' || v_device)"),
    );
    check(
      'usage rows carry the device, the verified user and a unique run id',
      migration.includes('add column if not exists device_key text') &&
        migration.includes('add column if not exists run_id text') &&
        /unique index[\s\S]*usage_events \(feature, run_id\)/.test(migration),
    );
    check(
      'the devices table is not readable or writable by normal users',
      migration.includes('alter table public.studio_devices enable row level security') &&
        migration.includes('revoke all on public.studio_devices from anon, authenticated'),
    );
    check(
      'admins can use the Game Zone while it is disabled',
      (migration.match(/and not public\.is_admin\(\)/g) ?? []).length === 2 &&
        migration.includes("'unavailable'"),
    );

    const storeSrc = source('ReportCard Studio/src/store/entitlementStore.ts');
    check(
      'the Studio store has no local admin list or client admin flag shortcut',
      !storeSrc.includes('isAdminEmail') && storeSrc.includes('isAdmin: false'),
    );
    check(
      'a generation is claimed before it runs and released when it fails',
      storeSrc.includes('claimServerGeneration') && storeSrc.includes('releaseServerClaim'),
    );

    const plansSrc = source('ReportCard Studio/src/config/plans.ts');
    check(
      'no admin address ships in the Studio bundle',
      !plansSrc.includes('ADMIN_EMAILS') && !/admin@ishmaverse\.com/.test(plansSrc),
    );

    const bridgeSrc = source('ReportCard Studio/src/services/authBridge.ts');
    check(
      'the Studio only accepts a session from the site origin',
      bridgeSrc.includes('window.location.origin') && bridgeSrc.includes('event.origin'),
    );
  }
};

runTests()
  .then(() => {
    console.log(`\ncheck-studio-limits: ${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const failure of failures) console.log(`  - ${failure}`);
      process.exit(1);
    }
  })
  .catch((error) => {
    console.error('check-studio-limits crashed:', error);
    process.exit(1);
  });
