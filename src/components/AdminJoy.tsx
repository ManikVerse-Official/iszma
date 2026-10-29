import { useMemo } from 'react';
import { Bot, Send, ShieldCheck, ShieldAlert, Check, X } from 'lucide-react';
import { ADMIN_JOY_EXAMPLES } from './admin/adminJoyPrompts';
import { AdminJoyDiagnostics } from './admin/AdminJoyDiagnostics';
import { useAdminJoySession } from './admin/useAdminJoyConsole';

/**
 * Admin Joy — the full in-dashboard console.
 *
 * It only exists on the authenticated dashboard route, and it re-reads the
 * server-verified session before acting. The engine (permission gate,
 * confirmation, ambiguity handling, audit) lives in `useAdminJoyConsole` and is
 * shared with the floating dock, so both surfaces run the exact same code.
 */
const AdminJoy: React.FC = () => {
  const {
    actor,
    adminLoading,
    isAdmin,
    messages,
    input,
    setInput,
    run,
    pending,
    confirmPending,
    cancelPending,
    notice,
    dismissNotice,
    serverAudit,
    security,
    localAudit,
    scrollRef,
  } = useAdminJoySession();

  /* The summary counts are cheap to derive and stable between renders. */
  const auditSource = useMemo(
    () => (serverAudit ? 'server log' : 'this browser only'),
    [serverAudit],
  );

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
          <button onClick={dismissNotice} aria-label="Dismiss">
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
              {msg.links && msg.links.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {msg.links.map((link) => (
                    <a
                      key={`${link.href}-${link.label}`}
                      href={link.href}
                      /* Admin routes stay in the app; the WhatsApp handoff opens
                       * in its own tab so the console is not navigated away. */
                      {...(/^https?:\/\//i.test(link.href)
                        ? { target: '_blank', rel: 'noopener noreferrer' }
                        : {})}
                      className="rounded-lg border border-neon-purple/40 px-2.5 py-1 text-[11px] text-neon-purple hover:bg-neon-purple/10"
                    >
                      {link.label}
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {pending && (
          <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-sm text-amber-100">
            <p className="mb-2">{pending.confirmationPrompt ?? pending.summary}</p>
            <div className="flex gap-2">
              <button
                onClick={confirmPending}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
              >
                <Check className="w-3.5 h-3.5" /> Confirm
              </button>
              <button
                onClick={cancelPending}
                className="inline-flex items-center gap-1 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/5"
              >
                <X className="w-3.5 h-3.5" /> Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {ADMIN_JOY_EXAMPLES.map((example) => (
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
          aria-label="Ask Admin Joy"
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
            <span className="ml-2 text-[10px] font-normal text-gray-500">{auditSource}</span>
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

      {/*
       * System-wide checks. Read-only: it reports what is actually verifiable
       * (browser + server), and treats an unreachable server as a failure rather
       * than assuming a reload fixed anything.
       */}
      <AdminJoyDiagnostics />
    </div>
  );
};

export default AdminJoy;
