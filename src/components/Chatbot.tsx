import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Compass, ChevronLeft, ChevronRight, Check } from 'lucide-react';
import { useBrand } from '../context/BrandContext';
import { useCatalog } from '../context/CatalogContext';
import { JoyBubble, JoyChip, JoyComposer, JoyFloating, JoyPanel } from './joy/JoyUI';
import {
  FOUNDER_INTRO,
  FOUNDER_NO,
  FOUNDER_ROUTE,
  FOUNDER_VIEW_LABEL,
  FOUNDER_YES,
  JOY_TOPICS,
  joyReplyLanguage,
  getFallback,
  getGreetingTierPrices,
  getSectionChips,
  getSectionGuide,
  isFounderQuery,
  parseConfirmation,
  pick,
  resolveJoyGuide,
  resolveJoyQuery,
  type JoyGuideStep,
  type JoyLang,
  type JoyText,
} from '../services/joyAssistant';
import {
  SUPPORT_SHORTCUT,
  isHumanSupportRequest,
  supportLabel,
  supportPrefill,
  supportReply,
  whatsappSupportUrl,
} from '../services/supportContact';

type ChatState = 'idle' | 'collecting_details' | 'collecting_budget';

interface JoyAction {
  label: string;
  /** Internal route, opened through the router. */
  to?: string;
  /** External link (e.g. the admin WhatsApp handoff), opened in a new tab. */
  href?: string;
}

interface JoyMessage {
  id: string;
  text: string;
  from: 'bot' | 'user';
  /** Optional tap-to-open button (used for section lookups). */
  action?: JoyAction;
}

/* ------------------------------------------------------------------ */
/* Localised UI copy — English is the default voice                   */
/* ------------------------------------------------------------------ */

const WELCOME: JoyText = {
  en: "Hi, I'm Joy — your assistant at isZma, The Digital Mall. I can take you to any section, and once you're inside one I'll walk you through every step. Ask me anything!",
  hi: 'Namaste! Main Joy hoon — isZma ki assistant. Kisi bhi section me le ja sakti hoon, aur section ke andar pahunchne par har step samjhaati hoon. Kuch bhi poochho!',
};

const BUBBLE: JoyText = {
  en: 'Stuck on a screen? I’ll walk you through it, step by step.',
  hi: 'Kisi screen par confuse ho? Main step by step samjha deti hoon.',
};

const DETAILS_PROMPT: JoyText = {
  en: 'Sure — could you tell me a little about your custom project?',
  hi: 'Bilkul — apne custom project ke baare me thoda bata dijiye?',
};

const BUDGET_PROMPT: JoyText = {
  en: 'Thank you. What budget do you have in mind?',
  hi: 'Dhanyavaad. Aapka budget kitna hai?',
};

const COLLECTED: JoyText = {
  en: 'Thank you! I have passed your requirements to the team, and you will be contacted shortly.',
  hi: 'Dhanyavaad! Maine aapki requirement team ko de di hai — aapse jaldi contact kiya jayega.',
};

const QUICK_QUESTIONS: Record<JoyLang, string[]> = {
  en: [
    'Where are the greeting cards?',
    'Open ReportCard Studio',
    'Free card please',
    'What is the price?',
    'Who is the founder?',
  ],
  hi: [
    'Greeting card kaha hai?',
    'ReportCard Studio kholo',
    'Free card chahiye',
    'Price kitna hai?',
    'Founder kaun hai?',
  ],
};

/** Custom-project intent words (English + Hinglish). */
const CUSTOM_WORDS = [
  'custom', 'project', 'build', 'develop', 'development', 'hire', 'banwana', 'banana hai',
  'banwana hai', 'karwana', 'get made', 'make me',
];

interface ChatbotProps {
  /**
   * Which section the visitor is currently inside (e.g. 'greetings').
   *
   * With a section set, Joy answers "how do I use this?" with that section's
   * step-by-step walkthrough and offers its quick questions — so she guides
   * people *inside* a section, not just to it.
   */
  sectionId?: string;
}

export const Chatbot: React.FC<ChatbotProps> = ({ sectionId }) => {
  const { brand } = useBrand();
  const catalog = useCatalog();
  const navigate = useNavigate();
  const [isOpen, setIsOpen] = useState(false);
  const [chatState, setChatState] = useState<ChatState>('idle');
  const [projectDetails, setProjectDetails] = useState('');
  /* Answer language follows the visitor's own message (English is the default). */
  const [lang, setLang] = useState<JoyLang>('en');
  // True while Joy waits for a yes/no on the founder profile offer.
  const [awaitingFounder, setAwaitingFounder] = useState(false);
  // Active step-by-step walkthrough for the section the visitor is inside.
  const [walk, setWalk] = useState<{ steps: JoyGuideStep[]; index: number } | null>(null);
  const [messages, setMessages] = useState<JoyMessage[]>([
    { id: '1', text: WELCOME.en, from: 'bot' },
  ]);
  const [input, setInput] = useState('');
  const [showGreeting, setShowGreeting] = useState(false);
  const navTimer = useRef<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /*
   * Whether the conversation should stay pinned to the newest message. While the
   * visitor scrolls up to re-read older messages we leave their position alone;
   * sending a message (or opening the chat) pins it back to the bottom.
   */
  const stickToBottom = useRef(true);

  /*
   * Section awareness: inside a section, Joy knows the walkthrough and offers
   * that section's own questions instead of the generic mall ones.
   */
  const sectionGuide = getSectionGuide(sectionId);
  const sectionChips = getSectionChips(sectionId);
  const sectionName = JOY_TOPICS.find((topic) => topic.id === sectionId)?.name ?? '';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem('ishmaverse-joy-greeted')) return;
    const timer = window.setTimeout(() => setShowGreeting(true), 1200);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * The welcome nudge is a transient hint — dismiss it by itself after a few
   * seconds so it never keeps covering the page's own buttons/content.
   */
  useEffect(() => {
    if (!showGreeting || isOpen) return;
    const timer = window.setTimeout(() => setShowGreeting(false), 9000);
    return () => window.clearTimeout(timer);
  }, [showGreeting, isOpen]);

  useEffect(
    () => () => {
      if (navTimer.current) window.clearTimeout(navTimer.current);
    },
    [],
  );

  /*
   * Keep the latest message visible at the bottom of the conversation whenever a
   * message arrives, Joy's walkthrough updates, or the panel opens. Only the
   * message list scrolls — never the page or the composer. If the visitor has
   * scrolled up, we respect that until they send their own message.
   */
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !stickToBottom.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages, walk, isOpen]);

  const handleMessagesScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    const distanceFromBottom = node.scrollHeight - node.scrollTop - node.clientHeight;
    stickToBottom.current = distanceFromBottom < 48;
  };

  const openChat = () => {
    stickToBottom.current = true;
    setShowGreeting(false);
    setIsOpen(true);
    try {
      window.sessionStorage.setItem('ishmaverse-joy-greeted', '1');
    } catch {
      /* sessionStorage unavailable — the bubble simply shows again next visit. */
    }
  };

  const pushBot = (text: string, action?: JoyAction) => {
    setMessages((prev) => [...prev, { id: `${Date.now()}-b`, text, from: 'bot', action }]);
  };

  const scheduleNavigate = (to: string, delay = 1200) => {
    if (navTimer.current) window.clearTimeout(navTimer.current);
    navTimer.current = window.setTimeout(() => {
      navTimer.current = null;
      setIsOpen(false);
      navigate(to);
    }, delay);
  };

  const goTo = (to: string) => {
    if (navTimer.current) window.clearTimeout(navTimer.current);
    navTimer.current = null;
    setIsOpen(false);
    navigate(to);
  };

  const send = async (rawOverride?: string) => {
    const userMessage = (rawOverride ?? input).trim();
    if (!userMessage) return;

    /* Sending is an explicit "show me the latest" action. */
    stickToBottom.current = true;
    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, text: userMessage, from: 'user' }]);
    setInput('');

    const messageLang = joyReplyLanguage(userMessage);
    setLang(messageLang);

    setTimeout(async () => {
      // 0) Waiting on the founder offer — read the answer first.
      if (awaitingFounder) {
        const answer = parseConfirmation(userMessage);
        if (answer === 'yes') {
          setAwaitingFounder(false);
          pushBot(pick(FOUNDER_YES, messageLang));
          scheduleNavigate(FOUNDER_ROUTE, 900);
          return;
        }
        if (answer === 'no') {
          setAwaitingFounder(false);
          pushBot(pick(FOUNDER_NO, messageLang));
          return;
        }
        // Anything else: drop the offer and handle the new message normally.
        setAwaitingFounder(false);
      }

      // 1) Custom-project flow.
      if (chatState === 'collecting_details') {
        setProjectDetails(userMessage);
        pushBot(pick(BUDGET_PROMPT, messageLang));
        setChatState('collecting_budget');
        return;
      }

      if (chatState === 'collecting_budget') {
        let budget = 0;
        const match = userMessage.match(/\d+/);
        if (match) budget = parseFloat(match[0]);

        if (budget < brand.minimum_budget_threshold) {
          pushBot(
            pick(
              {
                en: `Thank you. Our custom development work starts at ${brand.minimum_budget_threshold}. For this budget I’d suggest exploring the ready-made products in the mall.`,
                hi: `Dhanyavaad. Hamara custom development ${brand.minimum_budget_threshold} se shuru hota hai. Is budget me main mall ke ready-made products dekhne ki salah doongi.`,
              },
              messageLang,
            ),
          );
        } else {
          pushBot(pick(COLLECTED, messageLang));
          if (brand.admin_notification_webhook) {
            try {
              await fetch(brand.admin_notification_webhook, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  project_details: projectDetails,
                  budget,
                  timestamp: new Date().toISOString(),
                }),
              });
            } catch (error) {
              console.error('Failed to send webhook:', error);
            }
          }
        }
        setChatState('idle');
        setProjectDetails('');
        return;
      }

      /*
       * 1.5) Inside a section and asking how to use it — run the walkthrough.
       * Checked before the destination lookup so "ReportCard kaise use karu?"
       * teaches instead of just pointing at the section they are already in.
       */
      const guide = resolveJoyGuide(userMessage, messageLang, sectionId);
      if (guide) {
        pushBot(guide.reply);
        setWalk({ steps: guide.steps, index: 0 });
        return;
      }

      /*
       * 1.6) A human is needed — hand the visitor to the admin on WhatsApp with
       * their own message pre-filled. This is a transport, not a permission:
       * Public Joy still never performs an admin action here.
       */
      if (isHumanSupportRequest(userMessage)) {
        pushBot(supportReply(messageLang, { raw: userMessage }), {
          label: supportLabel(messageLang),
          href: whatsappSupportUrl(
            supportPrefill(userMessage, messageLang, { section: sectionName || undefined }),
          ),
        });
        return;
      }

      // 2) Founder / owner questions.
      if (isFounderQuery(userMessage)) {
        pushBot(pick(FOUNDER_INTRO, messageLang), {
          label: pick(FOUNDER_VIEW_LABEL, messageLang),
          to: FOUNDER_ROUTE,
        });
        setAwaitingFounder(true);
        return;
      }

      // 3) Section lookup — understands English + Hinglish keywords.
      // Prices come from the live catalogue, so an admin price change is reflected.
      const resolved = resolveJoyQuery(
        userMessage,
        messageLang,
        getGreetingTierPrices(catalog.themes),
      );
      if (resolved) {
        if (resolved.kind === 'section') {
          pushBot(resolved.reply, { label: resolved.actionLabel, to: resolved.topic.route });
          if (resolved.navigate) scheduleNavigate(resolved.topic.route);
        } else if (resolved.kind === 'admin') {
          // Public Joy only points at the authenticated sign-in page; it never
          // performs a privileged action or opens the dashboard directly.
          pushBot(resolved.reply, { label: resolved.actionLabel, to: resolved.route });
        } else {
          pushBot(resolved.reply);
        }
        return;
      }

      // 4) Custom-project intent.
      const lower = userMessage.toLowerCase();
      if (CUSTOM_WORDS.some((word) => lower.includes(word))) {
        if (!brand.accept_custom_orders) {
          pushBot(
            pick(
              {
                en: `Our team is fully booked and not taking custom projects for the next ${brand.unavailable_days} days. In the meantime, the ready-made products in the mall might help.`,
                hi: `Hamari team agle ${brand.unavailable_days} din tak busy hai, isliye abhi custom projects nahi le rahi. Tab tak mall ke ready-made products dekh sakte hain.`,
              },
              messageLang,
            ),
          );
        } else {
          pushBot(pick(DETAILS_PROMPT, messageLang));
          setChatState('collecting_details');
        }
        return;
      }

      // 5) Friendly fallback.
      pushBot(getFallback(messageLang));
    }, 350);
  };

  const handleSend = () => {
    void send();
  };

  return (
    <JoyFloating
      open={isOpen}
      onOpen={openChat}
      ariaLabel="Open chat with Joy"
      greeting={
        showGreeting
          ? {
              title: 'Hi, I’m Joy 👋',
              text: BUBBLE.en,
              onOpen: openChat,
              onDismiss: () => setShowGreeting(false),
            }
          : null
      }
    >
      <JoyPanel
        title="isZma"
        onClose={() => setIsOpen(false)}
        onMinimise={() => setIsOpen(false)}
        bodyRef={scrollRef}
        onBodyScroll={handleMessagesScroll}
        badge={
          sectionName ? (
            <div className="px-4 py-2 bg-neon-purple/10 border-b border-neon-purple/25 text-[11px] text-gray-300 flex items-center gap-1.5">
              <Compass className="w-3.5 h-3.5 shrink-0 text-neon-purple" />
              <span className="truncate">
                You are in <strong className="text-white">{sectionName}</strong> — I can guide you
                here.
              </span>
            </div>
          ) : null
        }
        footer={
          <div className="px-4 pt-3 border-t border-neon-purple/30 bg-bg-dark-end">
            {/*
             * Quick questions. Inside a section these become that section's
             * own questions (plus a "Guide me" button), so Joy is useful
             * exactly where the visitor is standing.
             */}
            <div className="flex flex-wrap gap-1.5 mb-2">
              {sectionGuide && sectionGuide.steps.length > 0 && (
                <JoyChip
                  primary
                  icon={<Compass className="w-3 h-3" />}
                  label={pick({ en: 'Guide me', hi: 'Guide karo' }, lang)}
                  onClick={() => void send('How do I use this section?')}
                />
              )}
              {(sectionChips.length > 0
                ? sectionChips.slice(0, 3).map((chip) => pick(chip, lang))
                : QUICK_QUESTIONS[lang]
              ).map((question) => (
                <JoyChip key={question} label={question} onClick={() => void send(question)} />
              ))}
              {/*
               * Always available, without having to ask: the admin is one tap
               * away on WhatsApp. The message is pre-filled with the visitor's
               * language and section so nobody has to hunt for support.
               */}
              <a
                href={whatsappSupportUrl(
                  supportPrefill(
                    pick(
                      { en: 'I need help with isZma.', hi: 'Mujhe isZma par help chahiye.' },
                      lang,
                    ),
                    lang,
                    { section: sectionName || undefined },
                  ),
                )}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border border-emerald-400/40 px-2.5 py-1 text-[11px] text-emerald-300 hover:border-emerald-400 hover:text-white transition-all"
              >
                {pick(SUPPORT_SHORTCUT, lang)}
              </a>
            </div>

            <JoyComposer
              value={input}
              onChange={setInput}
              onSend={handleSend}
              placeholder="TYPE A MESSAGE..."
            />
          </div>
        }
      >
        {messages.map((msg) => (
          <JoyBubble key={msg.id} from={msg.from} text={msg.text}>
            {msg.action &&
              (msg.action.href ? (
                <a
                  href={msg.action.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-emerald-400/60 bg-bg-dark-end/70 px-3 py-1.5 text-xs font-semibold text-emerald-300 hover:bg-emerald-500 hover:text-white transition-all"
                >
                  <Compass className="w-3.5 h-3.5" />
                  {msg.action.label}
                </a>
              ) : (
                <button
                  onClick={() => goTo(msg.action!.to!)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-neon-purple/60 bg-bg-dark-end/70 px-3 py-1.5 text-xs font-semibold text-neon-purple hover:bg-neon-purple hover:text-white transition-all"
                >
                  <Compass className="w-3.5 h-3.5" />
                  {msg.action.label}
                </button>
              ))}
          </JoyBubble>
        ))}

        {/* Step-by-step walkthrough — one step at a time, Back / Next. */}
        {walk && (
          <div className="rounded-xl border border-neon-purple/40 bg-bg-dark-end p-3">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[10px] font-bold uppercase tracking-wide text-neon-purple">
                Step {walk.index + 1} of {walk.steps.length}
              </span>
              <button
                onClick={() => setWalk(null)}
                className="text-[11px] text-gray-400 hover:text-white"
              >
                Close
              </button>
            </div>
            <div className="h-1.5 w-full bg-white/10 rounded-full overflow-hidden mb-3">
              <div
                className="h-full bg-neon-purple transition-all"
                style={{ width: `${((walk.index + 1) / walk.steps.length) * 100}%` }}
              />
            </div>
            <h4 className="text-sm font-semibold text-white">
              {pick(walk.steps[walk.index].title, lang)}
            </h4>
            <p className="text-xs text-gray-300 mt-1 leading-relaxed">
              {pick(walk.steps[walk.index].detail, lang)}
            </p>
            <div className="flex items-center justify-between mt-3">
              <button
                onClick={() =>
                  setWalk((w) => (w ? { ...w, index: Math.max(0, w.index - 1) } : w))
                }
                disabled={walk.index === 0}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-neon-purple/40 text-xs font-semibold text-gray-200 hover:bg-white/5 disabled:opacity-40"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Back
              </button>
              {walk.index < walk.steps.length - 1 ? (
                <button
                  onClick={() =>
                    setWalk((w) =>
                      w ? { ...w, index: Math.min(w.steps.length - 1, w.index + 1) } : w,
                    )
                  }
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-neon-purple text-white text-xs font-semibold hover:bg-purple-600"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              ) : (
                <button
                  onClick={() => {
                    setWalk(null);
                    pushBot(
                      pick(
                        {
                          en: 'That is the whole section — you are set. Anything else I can explain?',
                          hi: 'Bas itna hi tha — ab aap ready ho. Aur kuch samjhaun?',
                        },
                        lang,
                      ),
                    );
                  }}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                >
                  <Check className="w-3.5 h-3.5" /> Done
                </button>
              )}
            </div>
          </div>
        )}
      </JoyPanel>
    </JoyFloating>
  );
};
