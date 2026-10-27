import type { ReactNode } from 'react';
import { MessageCircle, Minus, Send, User, X } from 'lucide-react';
import ishmaverseLogo from '../../ishmaverse.png';
import { SmartImage } from '../SmartImage';

/**
 * Shared chrome for Joy's floating assistant.
 *
 * The public assistant (`components/Chatbot.tsx`) and the admin assistant
 * (`components/admin/AdminJoyDock.tsx`) have completely separate brains — one
 * answers visitors, the other runs permission-checked admin operations — but
 * they must look and behave like the same assistant. Everything visual and
 * behavioural (position, glow, launcher, tooltip, panel, bubbles, composer) lives
 * here so the two can never drift apart and no second chat implementation is
 * introduced.
 *
 * These components are presentational only: they hold no conversation state and
 * perform no privileged work.
 */

/** Home Joy's floating position: bottom-right, lifted above the phone toolbar. */
export const JOY_FLOATING_POSITION =
  'fixed z-50 flex flex-col items-end gap-3 right-3 bottom-[max(1rem,env(safe-area-inset-bottom))] sm:right-8 sm:bottom-8';

/**
 * Admin variant: identical placement, but below the dashboard's z-50 modals so
 * an open form is never covered by the launcher or the chat panel.
 */
export const JOY_ADMIN_FLOATING_POSITION =
  'fixed z-40 flex flex-col items-end gap-3 right-3 bottom-[max(1rem,env(safe-area-inset-bottom))] sm:right-8 sm:bottom-8';

/** The round purple launcher button with its glow. */
export const JoyLauncherButton: React.FC<{
  onClick: () => void;
  ariaLabel: string;
  /** Rendered inside the button (defaults to the chat bubble). */
  icon?: ReactNode;
  className?: string;
}> = ({ onClick, ariaLabel, icon, className }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={ariaLabel}
    className={`bg-neon-purple p-3 sm:p-4 rounded-full shadow-neon hover:bg-purple-600 transition-all ${
      className ?? ''
    }`}
  >
    {icon ?? <MessageCircle className="w-6 h-6" />}
  </button>
);

/** The welcome tooltip shown above the launcher before it is first opened. */
export const JoyGreetingTooltip: React.FC<{
  title: string;
  text: string;
  onOpen: () => void;
  onDismiss: () => void;
}> = ({ title, text, onOpen, onDismiss }) => (
  <div className="relative max-w-[78vw] sm:max-w-xs bg-bg-dark-end border border-neon-purple/50 rounded-2xl rounded-br-sm px-4 py-3 shadow-neon text-left">
    <button
      type="button"
      onClick={onDismiss}
      className="absolute -top-2 -right-2 bg-bg-dark-start border border-neon-purple/40 rounded-full p-1 text-gray-400 hover:text-white"
      aria-label="Dismiss welcome message"
    >
      <X className="w-3 h-3" />
    </button>
    <button type="button" onClick={onOpen} className="text-left">
      <p className="text-sm text-white font-semibold">{title}</p>
      <p className="text-xs text-gray-300 mt-0.5">{text}</p>
    </button>
  </div>
);

export interface JoyGreeting {
  title: string;
  text: string;
  onOpen: () => void;
  onDismiss: () => void;
}

/**
 * Floating container: renders the panel when open, otherwise the optional
 * welcome tooltip plus the launcher. Exactly one launcher is ever rendered.
 */
export const JoyFloating: React.FC<{
  open: boolean;
  onOpen: () => void;
  ariaLabel: string;
  greeting?: JoyGreeting | null;
  positionClassName?: string;
  launcherIcon?: ReactNode;
  children: ReactNode;
}> = ({
  open,
  onOpen,
  ariaLabel,
  greeting,
  positionClassName = JOY_FLOATING_POSITION,
  launcherIcon,
  children,
}) => (
  <div className={positionClassName}>
    {open ? (
      children
    ) : (
      <div className="flex flex-col items-end gap-3">
        {greeting && (
          <JoyGreetingTooltip
            title={greeting.title}
            text={greeting.text}
            onOpen={greeting.onOpen}
            onDismiss={greeting.onDismiss}
          />
        )}
        <JoyLauncherButton onClick={onOpen} ariaLabel={ariaLabel} icon={launcherIcon} />
      </div>
    )}
  </div>
);

/**
 * Chat panel chrome used by both assistants: the Home Joy header (logo + title,
 * minimise and close) and the same panel size/animation.
 */
export const JoyPanel: React.FC<{
  title: string;
  onClose: () => void;
  /** Optional minimise action; the close button is always present. */
  onMinimise?: () => void;
  /** Optional strip under the header, e.g. "You are in Digital Greetings". */
  badge?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  ariaLabel?: string;
  /** Lets a caller keep the newest message in view / track scroll position. */
  bodyRef?: React.Ref<HTMLDivElement>;
  onBodyScroll?: () => void;
}> = ({ title, onClose, onMinimise, badge, children, footer, ariaLabel, bodyRef, onBodyScroll }) => (
  <section
    aria-label={ariaLabel ?? title}
    className="bg-bg-dark-end border border-neon-purple rounded-2xl w-[calc(100vw-1.5rem)] max-w-sm sm:w-80 sm:max-w-none shadow-neon flex flex-col max-h-[75vh] sm:max-h-[80vh]"
  >
    <div className="flex items-center justify-between p-4 border-b border-neon-purple/30 bg-gradient-to-r from-bg-dark-end to-bg-dark-start">
      <div className="flex items-center gap-3 min-w-0">
        <SmartImage src={ishmaverseLogo} alt="IshMaVerse" className="w-8 h-8" />
        <span className="font-bold text-white text-sm sm:text-base truncate">{title}</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {onMinimise && (
          <button
            type="button"
            onClick={onMinimise}
            className="text-gray-400 hover:text-white p-1"
            aria-label="Minimise chat"
          >
            <Minus className="w-5 h-5" />
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-gray-400 hover:text-white p-1"
          aria-label="Close chat"
        >
          <X className="w-5 h-5" />
        </button>
      </div>
    </div>

    {badge}

    <div
      ref={bodyRef}
      onScroll={onBodyScroll}
      className="flex-1 p-4 overflow-y-auto flex flex-col gap-3 bg-bg-dark-start"
    >
      {children}
    </div>

    {footer}
  </section>
);

/** One chat bubble, matching Home Joy's bubbles and avatars. */
export const JoyBubble: React.FC<{
  from: 'bot' | 'user';
  text: string;
  /** Bot avatar icon (defaults to the Home Joy user glyph). */
  avatarIcon?: ReactNode;
  /** Extra content under the text, e.g. a tap-to-open action button. */
  children?: ReactNode;
}> = ({ from, text, avatarIcon, children }) => (
  <div className={`flex items-start gap-2 ${from === 'user' ? 'flex-row-reverse' : 'flex-row'}`}>
    {from === 'bot' && (
      <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs bg-neon-purple flex-shrink-0">
        {avatarIcon ?? <User className="w-4 h-4" />}
      </div>
    )}
    <div
      className={`max-w-[80%] p-3 rounded-xl text-sm ${
        from === 'bot' ? 'bg-neon-purple/20 text-white' : 'bg-purple-600 text-white'
      }`}
    >
      <p className="whitespace-pre-line">{text}</p>
      {children}
    </div>
  </div>
);

/** A one-tap suggested question. */
export const JoyChip: React.FC<{
  label: string;
  onClick: () => void;
  primary?: boolean;
  icon?: ReactNode;
}> = ({ label, onClick, primary, icon }) => (
  <button
    type="button"
    onClick={onClick}
    className={
      primary
        ? 'rounded-full bg-neon-purple px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-purple-600 transition-all inline-flex items-center gap-1'
        : 'rounded-full border border-neon-purple/40 px-2.5 py-1 text-[11px] text-gray-300 hover:border-neon-purple hover:text-white transition-all'
    }
  >
    {icon}
    {label}
  </button>
);

/** The message input + send button, identical in both assistants. */
export const JoyComposer: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  placeholder: string;
}> = ({ value, onChange, onSend, placeholder }) => (
  <div className="flex items-center gap-3 pb-4">
    <input
      type="text"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onSend();
      }}
      placeholder={placeholder}
      aria-label={placeholder}
      className="flex-1 bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-neon-purple text-white"
    />
    <button
      type="button"
      onClick={onSend}
      className="bg-neon-purple p-2 rounded-xl hover:bg-purple-600 transition-all"
      aria-label="Send message"
    >
      <Send className="w-5 h-5" />
    </button>
  </div>
);
