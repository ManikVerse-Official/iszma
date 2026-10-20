import type { GreetingTheme, Product } from '../types';
import type { AdminOpResult, AdminOps } from './adminJoy';
import { isSupabaseConfigured, supabase } from './supabase';

/**
 * Server-authoritative admin operations.
 *
 * Every privileged change Admin Joy performs goes through the `admin-ops` Edge
 * Function, which verifies the session JWT, the admin membership and the
 * action's permission on the server before touching the database. This module is
 * intentionally only a *transport*: it contains no local mutation code, so a
 * failure of the function can never silently become a browser-side write.
 *
 * If the function is missing, unreachable or rejects the request, the caller
 * receives `ok: false` with the real reason and nothing is changed.
 */

export interface AdminOpsResponseBody {
  success: boolean;
  action?: string;
  error?: string;
  text?: string;
  notStored?: string[];
  auditId?: string | null;
  result?: {
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
  };
}

export type AdminOpsCallResult =
  | { ok: true; data: AdminOpsResponseBody }
  | { ok: false; error: string; status?: number };

/**
 * The single network seam, so the client can be tested without a live backend.
 */
export interface AdminOpsTransport {
  call(body: Record<string, unknown>): Promise<AdminOpsCallResult>;
}

const extractMessage = (error: unknown, fallback: string): string => {
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
};

/** Calls `admin-ops` with the signed-in session attached by supabase-js. */
export const createEdgeTransport = (
  client: typeof supabase = supabase,
): AdminOpsTransport => ({
  async call(body) {
    if (!isSupabaseConfigured()) {
      return {
        ok: false,
        error: 'This site is not connected to Supabase, so admin operations cannot run.',
      };
    }
    try {
      const { data, error } = await client.functions.invoke('admin-ops', { body });
      if (error) {
        // A non-2xx response arrives as an error carrying the Response body.
        let message = extractMessage(
          error,
          'The admin service rejected the request. Please sign in again and retry.',
        );
        let status: number | undefined;
        const context = (error as { context?: { status?: number; json?: () => Promise<unknown> } })
          .context;
        if (context) {
          status = context.status;
          if (typeof context.json === 'function') {
            try {
              const parsed = (await context.json()) as { error?: unknown };
              if (typeof parsed?.error === 'string' && parsed.error.trim()) message = parsed.error;
            } catch {
              // Keep the transport-level message when the body is not JSON.
            }
          }
        }
        if (!status) {
          message =
            'The admin service could not be reached. Deploy the "admin-ops" Edge Function (supabase functions deploy admin-ops).';
        }
        return { ok: false, error: message, status };
      }
      const parsed = (data ?? {}) as AdminOpsResponseBody;
      if (parsed.success !== true) {
        return { ok: false, error: parsed.error ?? 'The admin service rejected the request.' };
      }
      return { ok: true, data: parsed };
    } catch (error) {
      return {
        ok: false,
        error: extractMessage(error, 'The admin service could not be reached.'),
      };
    }
  },
});

const toOpResult = (result: AdminOpsCallResult): AdminOpResult => {
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    before: result.data.result?.before ?? undefined,
    after: result.data.result?.after ?? undefined,
  };
};

export interface ServerAuditEntry {
  id: string;
  actorEmail: string | null;
  action: string;
  targetName: string | null;
  outcome: string;
  createdAt: string;
}

/**
 * Reads the durable server audit log. Returns null when the server log is not
 * available (no session, function not deployed), so the UI can fall back to the
 * local session log without pretending the server log exists.
 */
export const fetchServerAudit = async (
  limit = 5,
  transport: AdminOpsTransport = createEdgeTransport(),
): Promise<ServerAuditEntry[] | null> => {
  let result: AdminOpsCallResult;
  try {
    result = await transport.call({ action: 'report.audit' });
  } catch {
    return null;
  }
  if (!result.ok) return null;
  const entries = result.data.result?.after?.entries;
  if (!Array.isArray(entries)) return null;
  return (entries as Record<string, unknown>[]).slice(0, limit).map((entry) => ({
    id: String(entry.id ?? ''),
    actorEmail: typeof entry.actor_email === 'string' ? entry.actor_email : null,
    action: String(entry.action ?? 'unknown'),
    targetName: typeof entry.target_name === 'string' ? entry.target_name : null,
    outcome: String(entry.outcome ?? 'unknown'),
    createdAt: String(entry.created_at ?? ''),
  }));
};

/**
 * Builds the `AdminOps` implementation Admin Joy executes against. It performs
 * no local writes: a failure is reported to the caller and nothing changes.
 */
export const createServerAdminOps = (
  transport: AdminOpsTransport = createEdgeTransport(),
): AdminOps => {
  /**
   * The `AdminOps` contract returns a result and never throws, so a transport
   * failure (offline, blocked, misconfigured) becomes an honest error instead of
   * an exception the UI might mistake for a completed change.
   */
  const call = async (body: Record<string, unknown>): Promise<AdminOpsCallResult> => {
    try {
      return await transport.call(body);
    } catch (error) {
      return { ok: false, error: extractMessage(error, 'The admin service could not be reached.') };
    }
  };

  const priceFields = (patch: Partial<Product> | Partial<GreetingTheme>) => {
    const fields: Record<string, number> = {};
    const price = (patch as { price?: unknown }).price;
    const priceUsd = (patch as { price_usd?: unknown }).price_usd;
    if (typeof price === 'number') fields.price = price;
    if (typeof priceUsd === 'number') fields.price_usd = priceUsd;
    return fields;
  };

  return {
    async updateProduct(id, patch) {
      const body: Record<string, unknown> = {
        action: 'product.update',
        targetId: id,
        fields: priceFields(patch),
      };
      if (typeof patch.name === 'string' && patch.name.trim()) {
        (body.fields as Record<string, unknown>).name = patch.name.trim();
      }
      return toOpResult(await call(body));
    },

    async createProduct(input) {
      const fields: Record<string, unknown> = {
        name: input.name ?? 'Untitled product',
        price: typeof input.price === 'number' ? input.price : 0,
      };
      if (typeof input.price_usd === 'number') fields.price_usd = input.price_usd;
      // Accepted for compatibility; the schema cannot store it and the server
      // reports that back rather than pretending it was saved.
      if (typeof input.description === 'string' && input.description.trim()) {
        fields.description = input.description.trim();
      }
      return toOpResult(await call({ action: 'product.create', fields }));
    },

    async deleteProduct(id) {
      return toOpResult(await call({ action: 'product.delete', targetId: id }));
    },

    async updateTheme(id, patch) {
      return toOpResult(
        await call({ action: 'theme.update', targetId: id, fields: priceFields(patch) }),
      );
    },

    async publishTheme(id) {
      return toOpResult(await call({ action: 'theme.publish', targetId: id }));
    },

    async unpublishTheme(id) {
      return toOpResult(await call({ action: 'theme.unpublish', targetId: id }));
    },

    async deleteTheme(id) {
      return toOpResult(await call({ action: 'theme.delete', targetId: id }));
    },

    async report(kind) {
      const result = await call({
        action: kind === 'orders' ? 'report.orders' : 'report.overview',
      });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, text: result.data.text ?? 'Report ready.' };
    },
  };
};
