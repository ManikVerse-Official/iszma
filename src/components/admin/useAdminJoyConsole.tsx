import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useBrand } from '../../context/BrandContext';
import { useCatalog } from '../../context/CatalogContext';
import { useGreeting } from '../../context/GreetingContext';
import { getAdminSession, type AdminIdentity } from '../../services/adminAuth';
import {
  type AdminActor,
  type AdminCommandPlan,
  type AdminConversationContext,
  type AdminOps,
  type AdminPlanLink,
  type AdminSnapshot,
  type AdminSnapshotPlan,
  executeAdminCommand,
  nextAdminContext,
  parseAdminConfirmation,
  planAdminCommand,
} from '../../services/adminJoy';
import { getAuditLog } from '../../services/auditLog';
import { createServerAdminOps, fetchServerAudit, type ServerAuditEntry } from '../../services/adminOps';
import { loadStudioPlanPrices } from '../../services/studioPlanPrices';
import { getSecuritySummary } from '../../services/threatDetection';
import { ADMIN_JOY_WELCOME } from './adminJoyPrompts';

export interface AdminJoyMessage {
  id: string;
  from: 'bot' | 'user';
  text: string;
  /** Real navigation links offered with this answer (guided workflows). */
  links?: AdminPlanLink[];
}

/**
 * The single Admin Joy conversation engine.
 *
 * Both surfaces — the dedicated Admin Joy page and the floating dock available
 * on every other dashboard tab — call this hook, so the brain, the confirmation
 * flow, the rate limits and the audit trail are the same code. Only one of the
 * two is mounted at a time, so there is exactly one conversation.
 *
 * Security posture is unchanged: the actor comes from the verified Supabase
 * session, and every privileged action goes through the `admin-ops` Edge
 * Function with no local fallback.
 */
export const useAdminJoyConsole = () => {
  const { isAdmin, adminLoading } = useGreeting();
  const catalog = useCatalog();
  const { refreshBrand } = useBrand();
  const [actor, setActor] = useState<AdminActor | null>(null);
  const [messages, setMessages] = useState<AdminJoyMessage[]>([
    { id: 'welcome', from: 'bot', text: ADMIN_JOY_WELCOME },
  ]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<AdminCommandPlan | null>(null);
  /* Invisible chat context: "99" completes the tier price question Joy just asked. */
  const [context, setContext] = useState<AdminConversationContext>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [serverAudit, setServerAudit] = useState<ServerAuditEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * Live ReportCard Studio plan prices, read from `studio_plan_prices` — the
   * same row the server charges. `undefined` means the table could not be read,
   * and Joy says so instead of showing a guessed price.
   */
  const [plans, setPlans] = useState<AdminSnapshotPlan[] | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* Re-read the server-verified session whenever the dashboard mounts. */
  useEffect(() => {
    let active = true;
    void (async () => {
      const session: AdminIdentity | null = await getAdminSession();
      if (!active) return;
      setActor(
        session ? { userId: session.userId, email: session.email, isAdmin: isAdmin } : null,
      );
    })();
    return () => {
      active = false;
    };
  }, [isAdmin]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, pending]);

  const refreshPlans = async () => {
    const rows = await loadStudioPlanPrices();
    setPlans(rows ?? undefined);
  };

  useEffect(() => {
    if (!isAdmin) return;
    void refreshPlans();
  }, [isAdmin]);

  const snapshot: AdminSnapshot = useMemo(
    () => ({
      products: catalog.products.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        price_inr: p.price_inr,
        price_usd: p.price_usd,
        description: p.description,
        category_id: p.category_id,
      })),
      themes: catalog.themes.map((t) => ({
        id: t.id,
        name: t.name,
        price: t.price,
        price_usd: t.price_usd,
        tier: t.tier,
        tags: t.tags,
        category_id: t.category_id,
        tagline: t.tagline,
      })),
      /*
       * Themes an admin has hidden. They are dropped from the live list above,
       * so this is the only way Joy can report which themes are unpublished.
       */
      hiddenThemeIds: catalog.deletedThemeIds,
      ...(plans ? { plans } : {}),
    }),
    [catalog.products, catalog.themes, catalog.deletedThemeIds, plans],
  );

  /*
   * The executor runs every privileged change on the server through the
   * `admin-ops` Edge Function. There is deliberately NO local fallback: if the
   * function rejects the request (or is unreachable) the call returns
   * `ok: false` and nothing is changed in the browser.
   *
   * After a confirmed success we re-read the catalogue from the server, so the
   * dashboard shows what the database actually persisted rather than an
   * optimistic local edit.
   */
  const serverOps = useMemo(() => createServerAdminOps(), []);

  const ops: AdminOps = useMemo(() => {
    const refresh = async (kind: 'product' | 'theme', id?: string, ids?: string[]) => {
      try {
        await catalog.refreshFromServer(ids?.length ? { kind, ids } : id ? { kind, id } : { kind });
      } catch {
        setNotice(
          'The change was saved on the server, but the dashboard could not re-read it. Reload to see the latest state.',
        );
      }
    };

    return {
      updateProduct: async (id, patch) => {
        const result = await serverOps.updateProduct(id, patch);
        if (result.ok) await refresh('product', id);
        return result;
      },
      createProduct: async (inputProduct) => {
        const result = await serverOps.createProduct(inputProduct);
        if (result.ok) {
          const createdId = typeof result.after?.id === 'string' ? result.after.id : undefined;
          await refresh('product', createdId);
        }
        return result;
      },
      deleteProduct: async (id) => {
        const result = await serverOps.deleteProduct(id);
        if (result.ok) await refresh('product', id);
        return result;
      },
      updateTheme: async (id, patch) => {
        const result = await serverOps.updateTheme(id, patch);
        if (result.ok) await refresh('theme', id);
        return result;
      },
      publishTheme: async (id) => {
        const result = await serverOps.publishTheme(id);
        if (result.ok) await refresh('theme', id);
        return result;
      },
      unpublishTheme: async (id) => {
        const result = await serverOps.unpublishTheme(id);
        if (result.ok) await refresh('theme', id);
        return result;
      },
      updateTierPrice: async (tierInput) => {
        if (!serverOps.updateTierPrice) {
          return { ok: false, error: 'The server tier price action is unavailable.' };
        }
        const result = await serverOps.updateTierPrice(tierInput);
        /* A tier change touches several themes; the server wins for all of them. */
        if (result.ok) await refresh('theme', undefined, tierInput.themeIds);
        return result;
      },
      deleteTheme: async (id) => {
        const result = await serverOps.deleteTheme(id);
        if (result.ok) await refresh('theme', id);
        return result;
      },
      updateGame: async (patch) => serverOps.updateGame!(patch),
      updateBrand: async (patch) => {
        const result = await serverOps.updateBrand!(patch);
        if (result.ok) await refreshBrand();
        return result;
      },
      updatePlanPrice: async (planInput) => {
        if (!serverOps.updatePlanPrice) {
          return { ok: false, error: 'The server plan pricing action is unavailable.' };
        }
        const result = await serverOps.updatePlanPrice(planInput);
        /* Re-read the authoritative rows so the next answer shows what was saved. */
        if (result.ok) await refreshPlans();
        return result;
      },
      bulkUpdatePrices: async (bulkInput) => {
        const result = await serverOps.bulkUpdatePrices!(bulkInput);
        /* A bulk change can touch both catalogues; re-read the whole catalogue. */
        if (result.ok) await refresh('theme');
        return result;
      },
      report: (kind) => serverOps.report!(kind),
    };
  }, [catalog, refreshBrand, serverOps]);

  const pushBot = (text: string, links?: AdminPlanLink[]) =>
    setMessages((prev) => [
      ...prev,
      { id: `${Date.now()}-b`, from: 'bot', text, ...(links && links.length > 0 ? { links } : {}) },
    ]);

  const run = async (text: string, confirmed = false) => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;

    /*
     * A text confirmation or cancellation ("yes", "confirm", "haan", "no",
     * "cancel", "nahi") answers the pending question. Only a real pending plan is
     * affected; with nothing pending the reply is answered honestly and never
     * treated as a command. This never bypasses the confirmation itself — the
     * server still requires `confirmed: true` for the write.
     */
    if (!confirmed) {
      const verdict = parseAdminConfirmation(trimmed);
      if (verdict) {
        setMessages((prev) => [...prev, { id: `${Date.now()}-u`, from: 'user', text: trimmed }]);
        setInput('');
        if (pending) {
          const plan = pending;
          setPending(null);
          if (verdict === 'confirm') void run(plan.summary, true);
          else {
            /* Cancelling drops the open question too, so a later "59" cannot
             * complete a change the admin already abandoned. */
            setContext({});
            pushBot('Cancelled — nothing was changed.');
          }
        } else {
          pushBot(
            verdict === 'confirm'
              ? 'There is nothing waiting for confirmation right now.'
              : 'There is nothing pending to cancel.',
          );
        }
        return;
      }
    }

    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, from: 'user', text: trimmed }]);
    setInput('');
    setBusy(true);
    /* A fresh command supersedes any confirmation that was left open. */
    if (!confirmed) setPending(null);

    try {
      const actorForPlan = actor ?? { userId: '', email: '', isAdmin: false };
      if (!actor || !actor.isAdmin) {
        const plan = planAdminCommand(trimmed, actorForPlan, snapshot);
        const result = await executeAdminCommand(plan, ops, actorForPlan);
        pushBot(result.message);
        return;
      }

      const plan = planAdminCommand(trimmed, actor, snapshot, context);
      /* Carry the question this turn leaves open, so short replies resolve. */
      setContext(nextAdminContext(plan, context));

      if (plan.status === 'confirm' && !confirmed) {
        setPending(plan);
        pushBot(plan.confirmationPrompt ?? plan.summary);
        return;
      }
      if (plan.status === 'denied' || plan.status === 'clarify') {
        const result = await executeAdminCommand(plan, ops, actor);
        pushBot(result.message, plan.links);
        return;
      }

      const result = await executeAdminCommand(plan, ops, actor, { confirmed });
      setPending(null);
      pushBot(result.message, plan.links);
      if (catalog.syncWarning) setNotice(catalog.syncWarning);
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = () => {
    if (!pending) return;
    const plan = pending;
    setPending(null);
    void run(plan.summary, true);
  };

  const cancelPending = () => {
    setPending(null);
    /* The open question is dropped with the plan, so it cannot resurface. */
    setContext({});
    pushBot('Cancelled — nothing was changed.');
  };

  /*
   * Read the durable server audit log; fall back to the local log when absent.
   * Only an authenticated admin has a server log to read at all.
   */
  useEffect(() => {
    if (!isAdmin) return;
    let active = true;
    void (async () => {
      const entries = await fetchServerAudit(5);
      if (active) setServerAudit(entries);
    })();
    return () => {
      active = false;
    };
  }, [messages, isAdmin]);

  const security = useMemo(() => getSecuritySummary(5), [messages]);
  const localAudit = useMemo(() => getAuditLog().slice(0, 5), [messages]);

  const dismissNotice = () => {
    setNotice(null);
    catalog.dismissSyncWarning();
  };

  return {
    actor,
    adminLoading,
    isAdmin,
    messages,
    input,
    setInput,
    run,
    busy,
    pending,
    confirmPending,
    cancelPending,
    notice,
    dismissNotice,
    serverAudit,
    security,
    localAudit,
    scrollRef,
  };
};

export type AdminJoyConsoleState = ReturnType<typeof useAdminJoyConsole>;

const AdminJoySessionContext = createContext<AdminJoyConsoleState | null>(null);

/**
 * One Admin Joy conversation for the whole dashboard.
 *
 * The provider is mounted once in the dashboard layout, so switching tabs (or
 * opening the dedicated console) never resets the chat, and there is exactly one
 * engine instance — the floating dock and the full page are two views of the same
 * state, never two assistants.
 */
export const AdminJoySessionProvider = ({ children }: { children: ReactNode }) => {
  const session = useAdminJoyConsole();
  return (
    <AdminJoySessionContext.Provider value={session}>{children}</AdminJoySessionContext.Provider>
  );
};

/** Reads the dashboard's single Admin Joy session. */
export const useAdminJoySession = (): AdminJoyConsoleState => {
  const session = useContext(AdminJoySessionContext);
  if (!session) {
    throw new Error('useAdminJoySession must be used inside AdminJoySessionProvider');
  }
  return session;
};
