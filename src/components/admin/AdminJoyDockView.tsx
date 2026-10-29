import type { Ref } from 'react';
import { Check, Maximize2, ShieldCheck, X } from 'lucide-react';
import type { AdminCommandPlan } from '../../services/adminJoy';
import {
  JOY_ADMIN_FLOATING_POSITION,
  JoyBubble,
  JoyChip,
  JoyComposer,
  JoyFloating,
  JoyPanel,
} from '../joy/JoyUI';
import { ADMIN_JOY_EXAMPLES } from './adminJoyPrompts';

export const ADMIN_JOY_GREETING_TITLE = 'Admin Joy 👋';
export const ADMIN_JOY_GREETING_TEXT =
  'Ask me to change a price, toggle the Game Zone, update the brand or show the audit log.';

export interface AdminJoyDockViewProps {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** Switch to the dedicated Admin Joy tab. */
  onOpenFull: () => void;
  messages: { id: string; from: 'bot' | 'user'; text: string; links?: { href: string; label: string }[] }[];
  input: string;
  onInput: (value: string) => void;
  onSend: () => void;
  /** Runs a suggested command directly (the chips). */
  onRun: (text: string) => void;
  pending: AdminCommandPlan | null;
  onConfirm: () => void;
  onCancel: () => void;
  notice?: string | null;
  onDismissNotice?: () => void;
  /** Whether the welcome tooltip is currently shown next to the launcher. */
  greeting: boolean;
  onDismissGreeting: () => void;
  bodyRef?: Ref<HTMLDivElement>;
}

/**
 * Presentational Admin Joy dock: the same chrome as Home Joy (launcher, glow,
 * welcome tooltip, panel, bubbles, composer) wired to Admin Joy's own engine.
 *
 * It is deliberately free of data fetching, so it can be rendered and tested on
 * its own; `AdminJoyDock` supplies the live, server-backed conversation.
 */
export const AdminJoyDockView: React.FC<AdminJoyDockViewProps> = ({
  open,
  onOpen,
  onClose,
  onOpenFull,
  messages,
  input,
  onInput,
  onSend,
  onRun,
  pending,
  onConfirm,
  onCancel,
  notice,
  onDismissNotice,
  greeting,
  onDismissGreeting,
  bodyRef,
}) => (
  <JoyFloating
    open={open}
    onOpen={onOpen}
    ariaLabel="Open Admin Joy"
    positionClassName={JOY_ADMIN_FLOATING_POSITION}
    greeting={
      greeting
        ? {
            title: ADMIN_JOY_GREETING_TITLE,
            text: ADMIN_JOY_GREETING_TEXT,
            onOpen,
            onDismiss: onDismissGreeting,
          }
        : null
    }
  >
    <JoyPanel
      title="Admin Joy"
      ariaLabel="Admin Joy assistant"
      onClose={onClose}
      onMinimise={onClose}
      bodyRef={bodyRef}
      badge={
        <div className="px-4 py-2 bg-neon-purple/10 border-b border-neon-purple/25 text-[11px] text-gray-300 flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 min-w-0">
            <ShieldCheck className="w-3.5 h-3.5 shrink-0 text-emerald-300" />
            <span className="truncate">Permission-checked · audited</span>
          </span>
          <button
            type="button"
            onClick={onOpenFull}
            className="inline-flex items-center gap-1 shrink-0 text-neon-purple hover:text-white"
          >
            <Maximize2 className="w-3 h-3" /> Full console
          </button>
        </div>
      }
      footer={
        <div className="px-4 pt-3 border-t border-neon-purple/30 bg-bg-dark-end">
          <div className="flex flex-wrap gap-1.5 mb-2">
            {ADMIN_JOY_EXAMPLES.slice(0, 3).map((example) => (
              <JoyChip key={example} label={example} onClick={() => onRun(example)} />
            ))}
          </div>
          <JoyComposer
            value={input}
            onChange={onInput}
            onSend={onSend}
            placeholder="Ask Admin Joy…"
          />
        </div>
      }
    >
      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-xl border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-[11px] text-amber-200">
          <span>{notice}</span>
          {onDismissNotice && (
            <button type="button" onClick={onDismissNotice} aria-label="Dismiss notice">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {messages.map((message) => (
        <JoyBubble key={message.id} from={message.from} text={message.text}>
          {message.links && message.links.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {message.links.map((link) => (
                <a
                  key={`${link.href}-${link.label}`}
                  href={link.href}
                  /* External handoffs (WhatsApp) open in a new tab; admin routes
                   * keep the current tab so the dashboard stays loaded. */
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
        </JoyBubble>
      ))}

      {pending && (
        <div className="rounded-xl border border-amber-400/40 bg-amber-400/10 p-3 text-xs text-amber-100">
          <p className="mb-2">{pending.confirmationPrompt ?? pending.summary}</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onConfirm}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-700"
            >
              <Check className="w-3.5 h-3.5" /> Confirm
            </button>
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded-lg border border-white/20 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/5"
            >
              <X className="w-3.5 h-3.5" /> Cancel
            </button>
          </div>
        </div>
      )}
    </JoyPanel>
  </JoyFloating>
);

export default AdminJoyDockView;
