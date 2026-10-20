import { useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Send, ShieldCheck, ShieldAlert, Check, X } from 'lucide-react';
import { useCatalog } from '../context/CatalogContext';
import { useGreeting } from '../context/GreetingContext';
import { getAdminSession, type AdminIdentity } from '../services/adminAuth';
import {
  type AdminActor,
  type AdminCommandPlan,
  type AdminOps,
  type AdminSnapshot,
  executeAdminCommand,
  planAdminCommand,
} from '../services/adminJoy';
import { getAuditLog } from '../services/auditLog';
import { createServerAdminOps, fetchServerAudit, type ServerAuditEntry } from '../services/adminOps';
import { getSecuritySummary } from '../services/threatDetection';

interface JoyMessage {
  id: string;
  from: 'bot' | 'user';
  text: string;
}

const EXAMPLES = [
  "Change product XYZ's price to ₹399.",
  'Show me today\'s order summary.',
  'Publish theme Holistic Progress.',
  'Unpublish the selected track.',
];

/**
 * Admin Joy — the in-dashboard assistant.
 *
 * It only exists on the authenticated dashboard route, and it re-reads the
 * server-verified session before acting. The heavy lifting (permission gate,
 * confirmation, ambiguity handling, audit) lives in `services/adminJoy.ts`; this
 * component is the console UI and the bridge to the live catalog.
 */
const AdminJoy: React.FC = () => {
  const { isAdmin, adminLoading } = useGreeting();
  const catalog = useCatalog();
  const [actor, setActor] = useState<AdminActor | null>(null);
  const [messages, setMessages] = useState<JoyMessage[]>([
    {
      id: 'welcome',
      from: 'bot',
      text: 'Admin assistant ready. Ask me to change a price, publish or unpublish a theme, add a product, or show a report. I confirm before anything sensitive runs.',
    },
  ]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState<AdminCommandPlan | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverAudit, setServerAudit] = useState<ServerAuditEntry[] | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  /* Re-read the server-verified session whenever the dashboard mounts. */
  useEffect(() => {
    let active = true;
    void (async () => {
      const session: AdminIdentity | null = await getAdminSession();
      if (!active) return;
      setActor(
        session
          ? { userId: session.userId, email: session.email, isAdmin: isAdmin }
          : null,
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

  const snapshot: AdminSnapshot = useMemo(
    () => ({
      products: catalog.products.map((p) => ({
        id: p.id,
        name: p.name,
        price: p.price,
        price_inr: p.price_inr,
        description: p.description,
      })),
      themes: catalog.themes.map((t) => ({ id: t.id, name: t.name, price: t.price, tier: t.tier })),
    }),
    [catalog.products, catalog.themes],
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
    const refresh = async (kind: 'product' | 'theme', id?: string) => {
      try {
        await catalog.refreshFromServer(id ? { kind, id } : { kind });
      } catch {
        setNotice('The change was saved on the server, but the dashboard could not re-read it. Reload to see the latest state.');
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
      deleteTheme: async (id) => {
        const result = await serverOps.deleteTheme(id);
        if (result.ok) await refresh('theme', id);
        return result;
      },
      report: (kind) => serverOps.report!(kind),
    };
  }, [catalog, serverOps]);

  const pushBot = (text: string) =>
    setMessages((prev) => [...prev, { id: `${Date.now()}-b`, from: 'bot', text }]);

  const run = async (text: string, confirmed = false) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, from: 'user', text: trimmed }]);
    setInput('');

    if (!actor || !actor.isAdmin) {
      const plan = planAdminCommand(trimmed, actor ?? { userId: '', email: '', isAdmin: false }, snapshot);
      const result = await executeAdminCommand(
        plan,
        ops,
        actor ?? { userId: '', email: '', isAdmin: false },
      );
      pushBot(result.message);
      return;
    }

    const plan = planAdminCommand(trimmed, actor, snapshot);
    if (plan.status === 'confirm' && !confirmed) {
      setPending(plan);
      pushBot(plan.confirmationPrompt ?? plan.summary);
      return;
    }
    if (plan.status === 'denied' || plan.status === 'clarify') {
      const result = await executeAdminCommand(plan, ops, actor);
      pushBot(result.message);
      return;
    }

    const result = await executeAdminCommand(plan, ops, actor, { confirmed });
    setPending(null);
    pushBot(result.message);
    if (catalog.syncWarning) setNotice(catalog.syncWarning);
  };

  /* Read the durable server audit log; fall back to the local log when absent. */
  useEffect(() => {
    let active = true;
    void (async () => {
      const entries = await fetchServerAudit(5);
      if (active) setServerAudit(entries);
    })();
    return () => {
      active = false;
    };
  }, [messages]);

  const security = useMemo(() => getSecuritySummary(5), [messages]);
  const localAudit = useMemo(() => getAuditLog().slice(0, 5), [messages]);

  if (adminLoading) {
    return <div className="text-gray-400 text-sm">Checking your admin session…</div>;
  }

  if (!isAdmin) {
    return (
      <div className="flex items-center gap-2 text-amber-300 text-sm">
        <ShieldAlert className="w-4 h-4" /> Admin Joy is available only in an authenticated admin session.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-emerald-300 text-sm">
        <ShieldCheck className="w-4 h-4" />
        Authenticated as {actor?.email ?? 'admin'} — actions are permission-checked and audited.
      </div>

      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <span>{notice}</span>
          <button onClick={() => { setNotice(null); catalog.dismissSyncWarning(); }} aria-label="Dismiss">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div
        ref={scrollRef}
        className="h-80 overflow-y-auto rounded-2xl border border-neon-purple/25 bg-bg-dark-start p-3 space-y-3"
      >
        {messages.map((msg) => (
          <div key={msg.id} className={`flex items-start gap-2 ${msg.from === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className="w-6 h-6 rounded-full bg-neon-purple flex items-center justify-center text-white shrink-0">
              <Bot className="w-3.5 h-3.5" />
            </div>
            <div className={`max-w-[80%] rounded-xl px-3 py-2 text-sm ${msg.from === 'user' ? 'bg-purple-600 text-white' : 'bg-neon-purple/20 text-white'}`}>
              <p className="whitespace-pre-line">{msg.text}</p>
            </div>
          </div>
        ))}

        {pending && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100">
            <p className="mb-2">{pending.confirmationPrompt ?? pending.summary}</p>
            <div className="flex gap-2">
              <button
                onClick={() => void run(pending.summary, true)}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                <Check className="w-3.5 h-3.5" /> Confirm
              </button>
              <button
                onClick={() => { setPending(null); pushBot('Cancelled — nothing was changed.'); }}
                className="inline-flex items-center gap-1 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/5"
              >
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {EXAMPLES.map((example) => (
          <button
            key={example}
            onClick={() => void run(example)}
            className="rounded-full border border-neon-purple/40 px-2.5 py-1 text-[11px] text-gray-300 hover:border-neon-purple hover:text-white"
          >
            {example}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void run(input)}
          placeholder="Ask Admin Joy…"
          className="flex-1 rounded-xl border border-neon-purple/30 bg-bg-dark-start px-4 py-2 text-sm text-white focus:outline-none focus:border-neon-purple"
        />
        <button onClick={() => void run(input)} className="rounded-xl bg-neon-purple p-2 hover:bg-purple-600" aria-label="Send command">
          <Send className="w-5 h-5 text-white" />
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 text-xs">
        <div className="rounded-2xl border border-neon-purple/25 p-4">
          <h4 className="font-semibold text-white mb-2">
            Recent audit entries
            <span className="ml-2 text-[10px] font-normal text-gray-500">
              {serverAudit ? 'server log' : 'this browser only'}
            </span>
          </h4>
          {serverAudit ? (
            serverAudit.length === 0 ? (
              <p className="text-gray-500">No admin actions recorded on the server yet.</p>
            ) : (
              <ul className="space-y-1 text-gray-300">
                {serverAudit.map((entry) => (
                  <li key={entry.id}>
                    <span className="text-white">{entry.action}</span> · {entry.targetName ?? '—'} ·{' '}
                    <span className={entry.outcome === 'success' ? 'text-emerald-300' : 'text-amber-300'}>{entry.outcome}</span>
                  </li>
                ))}
              </ul>
            )
          ) : localAudit.length === 0 ? (
            <p className="text-gray-500">No admin actions yet this session.</p>
          ) : (
            <ul className="space-y-1 text-gray-300">
              {localAudit.map((entry) => (
                <li key={entry.id}>
                  <span className="text-white">{entry.action}</span> · {entry.targetName ?? entry.targetId ?? '—'} ·{' '}
                  <span className={entry.outcome === 'success' ? 'text-emerald-300' : 'text-amber-300'}>{entry.outcome}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-2xl border border-neon-purple/25 p-4">
          <h4 className="font-semibold text-white mb-2">Security summary</h4>
          <p className="text-gray-300">Events recorded: {security.total}</p>
          <p className="text-gray-400 mt-1">
            auth failures {security.byKind.auth_failure} · denials {security.byKind.authorization_denied} · rate-limited{' '}
            {security.byKind.rate_limited} · injection {security.byKind.prompt_injection}
          </p>
        </div>
      </div>
    </div>
  );
};

export default AdminJoy;
