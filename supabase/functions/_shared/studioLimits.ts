// ReportCard Studio free-generation limits — device identity + atomic claims.
//
// Policy: SEVEN free generations for a normal user, counted per email AND per
// device. Whichever allowance runs out first blocks further free generations.
// Admins (verified server-side, see `adminAccess.ts`) never consume either.
//
// Why a device at all
// -------------------
// Counting only the email let anyone type a new address to reset the allowance.
// Counting only the browser id let anyone clear site data. Both are therefore
// counted on the SAME row of `usage_events` (one row = one generation, against
// both identities at once), so:
//   • changing the email on the same device keeps draining the device allowance,
//   • using the same email on another device keeps draining the email allowance.
//
// Device identity — server-issued, not client-invented
// ---------------------------------------------------
//   1. the browser keeps a random id in local storage;
//   2. `action: "device"` sends it once; the function stores ONLY
//      HMAC(DEVICE_SECRET, id) and returns a token signed with that secret, so
//      the browser can prove the id was issued here and cannot mint a new device
//      by inventing ids;
//   3. every claim re-verifies the token's signature before the database is
//      asked, so a forged or edited token is refused (fail closed).
//
// Honest limitations (documented, not hidden):
//   • a web page has no stable hardware identifier — clearing site data, using a
//     private window or another browser produces a genuinely new device;
//   • the server fingerprint (request headers + coarse client hints) is used as
//     a CAP, not as identity: it can collide between identical school machines;
//   • the email in ReportCard Studio is user-supplied (no email verification),
//     so it is a claim; only a verified Supabase session (recorded as `user_id`)
//     is a hard identity;
//   • the caps (3 devices per fingerprint, 5 fingerprints per email) make
//     "clear storage and start again" loops uneconomic, not impossible. A
//     determined user on their own hardware can always reset a token once; that
//     is why the email allowance is tracked independently.
//
// Nothing here is called by the browser directly: `entitlement` is the only
// caller, with the service role, and the database functions are revoked from
// `anon` / `authenticated`.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.44.2";
import { safeCompare } from "./timingSafe.ts";

export const STUDIO_FEATURE = "studio_generation";
/** Seven free generations per email AND per device. */
export const STUDIO_FREE_GENERATIONS = 7;
/** A fingerprint may host at most this many devices that actually consumed. */
export const DEVICES_PER_FINGERPRINT = 3;
/** One email may consume from at most this many fingerprints. */
export const FINGERPRINTS_PER_EMAIL = 5;

export const USAGE_UNAVAILABLE_MESSAGE =
  "We could not verify your free generations right now, so nothing was generated. Please try again in a moment.";

const secret = (): string => Deno.env.get("DEVICE_SECRET") ?? "";
/** At least 16 characters of secret; anything shorter is not a real secret. */
export const isDeviceIdentityConfigured = (): boolean => secret().length >= 16;

const encoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const hmacHex = async (message: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return bytesToHex(new Uint8Array(signature));
};

/** A browser device id: 16–80 url-safe characters. */
export const isDeviceId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{16,80}$/.test(value.trim());

/** The stored identifier for a browser device (the raw id is never stored). */
export const deviceKeyFor = async (deviceId: string): Promise<string> =>
  hmacHex(`device:${deviceId.trim()}`);

/**
 * A server-computed fingerprint of the request.
 *
 * Only headers plus the coarse hints the client sends for this purpose. It is
 * used to CAP how many fresh device ids one browser may register — never as the
 * primary identity, because two identical machines can share it.
 */
export const fingerprintFor = (
  req: Request,
  hints: { timeZone?: string; screen?: string; platform?: string; languages?: string } = {},
): Promise<string> => {
  const canonical = [
    (req.headers.get("user-agent") ?? "").slice(0, 300),
    (req.headers.get("accept-language") ?? "").slice(0, 120),
    (req.headers.get("sec-ch-ua") ?? "").slice(0, 240),
    (req.headers.get("sec-ch-ua-platform") ?? "").slice(0, 60),
    (hints.timeZone ?? "").slice(0, 60),
    (hints.screen ?? "").slice(0, 30),
    (hints.platform ?? "").slice(0, 60),
    (hints.languages ?? "").slice(0, 120),
  ].join("|");
  return hmacHex(`fingerprint:${canonical}`);
};

export interface IssuedDeviceToken {
  deviceKey: string;
  token: string;
  issuedAt: number;
}

/**
 * Signs a device key into an opaque token the browser can present later.
 * Format: `deviceKey.issuedAt.signature` (all url-safe).
 */
export const issueDeviceToken = async (deviceKey: string): Promise<IssuedDeviceToken> => {
  const issuedAt = Math.floor(Date.now() / 1000);
  const signature = await hmacHex(`${deviceKey}.${issuedAt}`);
  return { deviceKey, issuedAt, token: `${deviceKey}.${issuedAt}.${signature}` };
};

/** Verifies an issued token and returns the device key, or null when forged. */
export const verifyDeviceToken = async (token: unknown): Promise<string | null> => {
  if (typeof token !== "string") return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3) return null;
  const [deviceKey, issuedAt, signature] = parts;
  if (!/^[0-9a-f]{64}$/.test(deviceKey)) return null;
  if (!/^\d{9,12}$/.test(issuedAt)) return null;
  if (!/^[0-9a-f]{64}$/.test(signature)) return null;
  const expected = await hmacHex(`${deviceKey}.${issuedAt}`);
  return safeCompare(signature, expected) ? deviceKey : null;
};

export const normaliseStudioEmail = (value: unknown): string =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

export interface StudioClaimInput {
  email: string;
  userId: string | null;
  /** Signed device token from a previous `device` action. */
  deviceToken?: string;
  fingerprint: string;
  ip: string;
  /** One id per generation run: retries can never count twice. */
  runId: string;
  /** Verified admin bypass — never taken from the request body. */
  isAdmin: boolean;
}

export interface StudioClaimDecision {
  allowed: boolean;
  code?:
    | "FREE_LIMIT_EMAIL"
    | "FREE_LIMIT_DEVICE"
    | "DEVICE_REQUIRED"
    | "INVALID_REQUEST"
    | "USAGE_UNAVAILABLE";
  message?: string;
  remainingEmail: number;
  remainingDevice: number;
  claimId: string | null;
  alreadyClaimed: boolean;
  admin: boolean;
}

interface StudioClaimRow {
  allowed?: boolean;
  code?: string;
  message?: string | null;
  remaining?: number;
  remaining_device?: number;
  claim_id?: string | null;
  already_claimed?: boolean;
}

const firstRow = (data: unknown): StudioClaimRow | null => {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? (row as StudioClaimRow) : null;
};

const toInt = (value: unknown, fallback = 0): number => {
  const numeric = typeof value === "string" ? Number(value) : value;
  return typeof numeric === "number" && Number.isFinite(numeric)
    ? Math.max(0, Math.trunc(numeric))
    : fallback;
};

const DENIALS: Record<string, { code: StudioClaimDecision["code"]; message: string }> = {
  FREE_LIMIT_EMAIL: {
    code: "FREE_LIMIT_EMAIL",
    message: `This email has used all ${STUDIO_FREE_GENERATIONS} free report-card generations. Subscribe for unlimited report cards.`,
  },
  FREE_LIMIT_DEVICE: {
    code: "FREE_LIMIT_DEVICE",
    message: `This device has used all ${STUDIO_FREE_GENERATIONS} free report-card generations. Subscribe for unlimited report cards.`,
  },
  DEVICE_REQUIRED: {
    code: "DEVICE_REQUIRED",
    message:
      "This browser could not be registered for free generations. Allow site storage and reload, or subscribe for unlimited report cards.",
  },
  INVALID_REQUEST: {
    code: "INVALID_REQUEST",
    message: "A valid email address is required.",
  },
};

export interface StudioLimitClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data?: unknown; error?: { code?: string; message?: string } | null }>;
}

/**
 * Claims ONE free generation, atomically, against the email and the device.
 *
 * Fails closed: any database error, unknown result or unconfigured secret
 * returns `allowed: false`, so a broken limit never becomes a free-for-all.
 */
export const claimStudioGeneration = async (
  client: StudioLimitClient,
  input: StudioClaimInput,
): Promise<StudioClaimDecision> => {
  const email = normaliseStudioEmail(input.email);
  const denied = (code: StudioClaimDecision["code"], message: string): StudioClaimDecision => ({
    allowed: false,
    code,
    message,
    remainingEmail: 0,
    remainingDevice: 0,
    claimId: null,
    alreadyClaimed: false,
    admin: false,
  });

  if (input.isAdmin) {
    return {
      allowed: true,
      remainingEmail: STUDIO_FREE_GENERATIONS,
      remainingDevice: STUDIO_FREE_GENERATIONS,
      claimId: null,
      alreadyClaimed: false,
      admin: true,
    };
  }

  if (!email) return denied("INVALID_REQUEST", DENIALS.INVALID_REQUEST.message);
  if (!isDeviceIdentityConfigured()) {
    console.error("DEVICE_SECRET is not configured; Studio free generations fail closed");
    return denied("USAGE_UNAVAILABLE", USAGE_UNAVAILABLE_MESSAGE);
  }

  const deviceKey = await verifyDeviceToken(input.deviceToken);
  if (!deviceKey) {
    return denied(
      "DEVICE_REQUIRED",
      "This browser has not been registered for free generations yet. Reload the page and try again.",
    );
  }

  try {
    const { data, error } = await client.rpc("consume_studio_generation", {
      p_email: email,
      p_user_id: input.userId,
      p_device_key: deviceKey,
      p_fingerprint: input.fingerprint,
      p_ip: input.ip || null,
      p_run_id: input.runId || null,
      p_per_email: STUDIO_FREE_GENERATIONS,
      p_per_device: STUDIO_FREE_GENERATIONS,
      p_devices_per_fingerprint: DEVICES_PER_FINGERPRINT,
      p_fingerprints_per_email: FINGERPRINTS_PER_EMAIL,
    });

    if (error) {
      console.error(
        "consume_studio_generation failed:",
        error.code ?? "unknown",
        String(error.message ?? "").slice(0, 160),
      );
      return denied("USAGE_UNAVAILABLE", USAGE_UNAVAILABLE_MESSAGE);
    }

    const row = firstRow(data);
    if (!row || typeof row.allowed !== "boolean") {
      console.error("consume_studio_generation returned no decision");
      return denied("USAGE_UNAVAILABLE", USAGE_UNAVAILABLE_MESSAGE);
    }

    if (row.allowed) {
      return {
        allowed: true,
        remainingEmail: toInt(row.remaining),
        remainingDevice: toInt(row.remaining_device),
        claimId: typeof row.claim_id === "string" ? row.claim_id : null,
        alreadyClaimed: row.already_claimed === true,
        admin: false,
      };
    }

    const known = typeof row.code === "string" ? DENIALS[row.code] : undefined;
    return {
      allowed: false,
      code: known?.code ?? "USAGE_UNAVAILABLE",
      message:
        known?.message ??
        (typeof row.message === "string" && row.message.trim()
          ? row.message
          : USAGE_UNAVAILABLE_MESSAGE),
      remainingEmail: toInt(row.remaining),
      remainingDevice: toInt(row.remaining_device),
      claimId: null,
      alreadyClaimed: false,
      admin: false,
    };
  } catch (error) {
    console.error(
      "consume_studio_generation threw:",
      error instanceof Error ? error.message.slice(0, 160) : "unknown",
    );
    return denied("USAGE_UNAVAILABLE", USAGE_UNAVAILABLE_MESSAGE);
  }
};

/** Hands a claim back when the generation itself could not run. */
export const releaseStudioClaim = async (
  client: StudioLimitClient,
  claimId: string | null | undefined,
): Promise<void> => {
  if (!claimId) return;
  try {
    const { error } = await client.rpc("release_studio_claim", { p_claim_id: claimId });
    if (error) console.error("release_studio_claim failed:", error.code ?? "unknown");
  } catch (error) {
    console.error(
      "release_studio_claim threw:",
      error instanceof Error ? error.message.slice(0, 120) : "unknown",
    );
  }
};

export interface StudioDeviceRegistration {
  deviceKey: string;
  deviceToken: string;
  fingerprint: string;
  devicesOnFingerprint: number;
  remaining: number;
}

/**
 * Registers (or refreshes) a browser device and returns its signed token.
 *
 * The browser only ever holds the token; the server keeps the HMAC key. An id
 * the server has never seen is simply a new device — the fingerprint caps in the
 * claim function are what stop that from becoming an unlimited allowance.
 */
export const registerStudioDevice = async (
  client: StudioLimitClient,
  input: {
    deviceId: string;
    fingerprint: string;
    userId: string | null;
    email: string;
    ip: string;
  },
): Promise<StudioDeviceRegistration | null> => {
  if (!isDeviceIdentityConfigured()) {
    console.error("DEVICE_SECRET is not configured; denying device registration");
    return null;
  }

  try {
    const deviceKey = await deviceKeyFor(input.deviceId);
    const { error } = await client.rpc("register_studio_device", {
      p_device_key: deviceKey,
      p_fingerprint: input.fingerprint,
      p_user_id: input.userId,
      p_email: normaliseStudioEmail(input.email) || null,
      p_ip: input.ip || null,
    });
    if (error) {
      console.error("register_studio_device failed:", error.code ?? "unknown");
      return null;
    }

    const issued = await issueDeviceToken(deviceKey);
    return {
      deviceKey,
      deviceToken: issued.token,
      fingerprint: input.fingerprint,
      devicesOnFingerprint: 1,
      remaining: STUDIO_FREE_GENERATIONS,
    };
  } catch (error) {
    console.error(
      "register_studio_device threw:",
      error instanceof Error ? error.message.slice(0, 160) : "unknown",
    );
    return null;
  }
};

export interface StudioUsageCounts {
  emailUsed: number;
  deviceUsed: number;
  remainingEmail: number;
  remainingDevice: number;
}

/** Reads the two counters for the state endpoint (service role only). */
export const readStudioUsage = async (
  client: SupabaseClient,
  email: string,
  deviceKey: string | null,
): Promise<StudioUsageCounts> => {
  let emailUsed = 0;
  if (email) {
    const { count } = await client
      .from("usage_events")
      .select("id", { count: "exact", head: true })
      .eq("feature", STUDIO_FEATURE)
      .eq("email", email.trim().toLowerCase());
    emailUsed = count ?? 0;
  }

  let deviceUsed = 0;
  if (deviceKey) {
    const { count } = await client
      .from("usage_events")
      .select("id", { count: "exact", head: true })
      .eq("feature", STUDIO_FEATURE)
      .eq("device_key", deviceKey);
    deviceUsed = count ?? 0;
  }

  return {
    emailUsed,
    deviceUsed,
    remainingEmail: Math.max(0, STUDIO_FREE_GENERATIONS - emailUsed),
    remainingDevice: Math.max(0, STUDIO_FREE_GENERATIONS - deviceUsed),
  };
};
