import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import {
  MessageCircle,
  X,
  Send,
  Minus,
  Compass,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Check,
} from 'lucide-react';
import {
  SCREEN_GUIDES,
  detectJoyLanguage,
  pick,
  resolveStudioQuery,
  screenFromPath,
  studioFallback,
  studioWelcome,
  type GuideStep,
  type JoyLang,
} from '../services/joyKnowledge';
import { useAppStore } from '../store/appStore';

/**
 * Joy — the in-Studio guider.
 *
 * ReportCard Studio runs inside an iframe, so the mall's Joy cannot see it.
 * This is her Studio twin: she knows every screen, reads the current route, and
 * can either answer a question or walk the user through the screen step by step
 * (Back / Next), so nobody gets stuck on a confusing screen.
 */

interface JoyMessage {
  id: string;
  text: string;
  from: 'bot' | 'user';
}

interface Walk {
  steps: GuideStep[];
  index: number;
}

const BUBBLE: Record<JoyLang, string> = {
  en: 'Need a hand with this screen? Tap and I’ll show you what to do 👋',
  hi: 'Is screen me madad chahiye? Tap karo, main batati hoon kya karna hai 👋',
};

const PLACEHOLDER: Record<JoyLang, string> = {
  en: 'Ask me how to use this screen…',
  hi: 'Poochho is screen ko kaise use karna hai…',
};

const SEEN_KEY = 'rcs:joy-greeted';

export default function JoyGuide() {
  const location = useLocation();
  const screen = useMemo(() => screenFromPath(location.pathname), [location.pathname]);
  const guide = SCREEN_GUIDES[screen];

  /*
   * Joy explains the *current* screen, so she reads the live app state: the
   * validation results, the confirmed column mapping, the loaded photos (plus
   * any manual correction) and the last generation run. Nothing is hard-coded —
   * a value the app does not expose stays undefined and Joy says so.
   */
  const validation = useAppStore((state) => state.validation);
  const students = useAppStore((state) => state.students);
  const columnMapping = useAppStore((state) => state.columnMapping);
  const photoMap = useAppStore((state) => state.photoMap);
  const photoOverrides = useAppStore((state) => state.photoOverrides);
  const generation = useAppStore((state) => state.generation);

  const [isOpen, setIsOpen] = useState(false);
  /* Joy answers in the language the visitor wrote in (English by default). */
  const [lang, setLang] = useState<JoyLang>('en');
  const [input, setInput] = useState('');
  const [walk, setWalk] = useState<Walk | null>(null);
  const [showBubble, setShowBubble] = useState(false);
  const [messages, setMessages] = useState<JoyMessage[]>([
    { id: 'welcome', text: studioWelcome('en'), from: 'bot' },
  ]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScreen = useRef(screen);
  const navTimer = useRef<number | null>(null);

  const chips = guide.chips;

  const pushBot = (text: string) =>
    setMessages((prev) => [...prev, { id: `${Date.now()}-b`, text, from: 'bot' }]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem(SEEN_KEY)) return;
    const timer = window.setTimeout(() => setShowBubble(true), 2500);
    return () => window.clearTimeout(timer);
  }, []);

  /*
   * The nudge is a transient hint, not a permanent panel. Auto-dismiss it after
   * a few seconds so it never keeps sitting on top of the page's own content
   * (e.g. the mapping table on Import Students).
   */
  useEffect(() => {
    if (!showBubble || isOpen) return;
    const timer = window.setTimeout(() => setShowBubble(false), 9000);
    return () => window.clearTimeout(timer);
  }, [showBubble, isOpen]);

  /* Announce the new screen so the guidance always matches what is on the page. */
  useEffect(() => {
    if (lastScreen.current === screen) return;
    lastScreen.current = screen;
    setWalk(null);
    if (isOpen) pushBot(pick(guide.intro, lang));
  }, [screen, isOpen, guide, lang]);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, walk, isOpen]);

  useEffect(
    () => () => {
      if (navTimer.current) window.clearTimeout(navTimer.current);
    },
    [],
  );

  /**
   * Hands the parent Ishmaverse window a real mall route.
   *
   * The Studio lives in a same-origin iframe, so `window.top` is reachable and
   * can be sent to the existing section. Standalone (or a cross-origin parent)
   * returns false, and the caller explains instead of pretending it worked.
   */
  const navigateInMall = (route: string): boolean => {
    try {
      const top = window.top;
      if (top && top !== window) {
        top.location.href = route;
        return true;
      }
    } catch {
      /* Cross-origin parent — navigation is not available. */
    }
    return false;
  };

  const scheduleMallNavigation = (route: string, messageLang: JoyLang) => {
    if (navTimer.current) window.clearTimeout(navTimer.current);
    navTimer.current = window.setTimeout(() => {
      navTimer.current = null;
      if (!navigateInMall(route)) {
        pushBot(
          pick(
            {
              en: `I couldn’t open it from here. Open this link to continue: ${route}`,
              hi: `Yahan se khol nahi payi. Aage badhne ke liye ye link kholo: ${route}`,
            },
            messageLang,
          ),
        );
      }
    }, 900);
  };

  const openChat = () => {
    setShowBubble(false);
    setIsOpen(true);
    try {
      window.sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      /* sessionStorage unavailable — the nudge simply shows again next time. */
    }
  };

  const startWalkthrough = (index = 0) => {
    setWalk({ steps: guide.steps, index });
  };

  const send = (rawOverride?: string) => {
    const text = (rawOverride ?? input).trim();
    if (!text) return;

    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, text, from: 'user' }]);
    setInput('');

    const messageLang = detectJoyLanguage(text);
    setLang(messageLang);

    const answer = resolveStudioQuery(text, screen, messageLang, {
      validation,
      students,
      columnMapping,
      photoMap,
      photoOverrides,
      generation,
    });
    if (!answer) {
      pushBot(studioFallback(screen, messageLang));
      return;
    }
    pushBot(answer.reply);
    if (answer.guide) {
      setWalk({ steps: answer.guide.steps, index: answer.guide.index });
    }
    if (answer.navigate) {
      scheduleMallNavigation(answer.navigate, messageLang);
    }
  };

  const currentStep = walk ? walk.steps[walk.index] : null;

  return (
    // On a phone the launcher sits clear above the fixed bottom tab bar (and any
    // browser toolbar / safe area); on desktop it takes the usual corner.
    <div className="fixed z-50 flex flex-col items-end gap-3 no-print right-3 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] lg:right-6 lg:bottom-6">
      {isOpen ? (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-card w-[calc(100vw-1.5rem)] max-w-sm sm:w-96 overflow-hidden flex flex-col max-h-[70vh] md:max-h-[600px]">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-slate-200 bg-gradient-to-r from-brand-600 to-brand-700">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="h-8 w-8 shrink-0 rounded-full bg-white/15 text-white flex items-center justify-center">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="text-sm font-bold text-white leading-tight">Joy</div>
                <div className="text-[11px] text-white/70 leading-tight truncate">
                  ReportCard Studio guide · isZma
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <button
                onClick={() => setIsOpen(false)}
                className="text-white/70 hover:text-white p-1"
                aria-label="Minimise guide"
              >
                <Minus className="h-4 w-4" />
              </button>
              <button
                onClick={() => setIsOpen(false)}
                className="text-white/70 hover:text-white p-1"
                aria-label="Close guide"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Context strip — what Joy is looking at right now */}
          <div className="px-4 py-2 bg-brand-50 border-b border-brand-100 text-[11px] text-brand-800 flex items-center gap-1.5">
            <Compass className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              You are on <strong>{screenLabel(screen)}</strong> — I can guide you here.
            </span>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5 bg-slate-50">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex items-start gap-2 ${msg.from === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
              >
                {msg.from === 'bot' && (
                  <span className="h-6 w-6 shrink-0 rounded-full bg-brand-600 text-white flex items-center justify-center">
                    <Sparkles className="h-3.5 w-3.5" />
                  </span>
                )}
                <div
                  className={`max-w-[80%] px-3 py-2 rounded-xl text-[13px] leading-relaxed ${
                    msg.from === 'bot'
                      ? 'bg-white border border-slate-200 text-ink-800'
                      : 'bg-brand-600 text-white'
                  }`}
                >
                  <p className="whitespace-pre-line">{msg.text}</p>
                </div>
              </div>
            ))}

            {/* Walkthrough card — Back / Next through the current screen's steps */}
            {currentStep && walk && (
              <div className="rounded-xl border border-brand-200 bg-white p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-bold uppercase tracking-wide text-brand-700">
                    Step {walk.index + 1} of {walk.steps.length}
                  </span>
                  <button
                    onClick={() => setWalk(null)}
                    className="text-[11px] text-ink-500 hover:text-ink-800"
                  >
                    Close
                  </button>
                </div>
                <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden mb-3">
                  <div
                    className="h-full bg-brand-600 transition-all"
                    style={{ width: `${((walk.index + 1) / walk.steps.length) * 100}%` }}
                  />
                </div>
                <h4 className="text-sm font-semibold text-ink-900">
                  {pick(currentStep.title, lang)}
                </h4>
                <p className="text-[12px] text-ink-600 mt-1 leading-relaxed">
                  {pick(currentStep.detail, lang)}
                </p>
                <div className="flex items-center justify-between mt-3">
                  <button
                    onClick={() => setWalk((w) => (w ? { ...w, index: Math.max(0, w.index - 1) } : w))}
                    disabled={walk.index === 0}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-ink-700 hover:bg-slate-50 disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" /> Back
                  </button>
                  {walk.index < walk.steps.length - 1 ? (
                    <button
                      onClick={() =>
                        setWalk((w) =>
                          w ? { ...w, index: Math.min(w.steps.length - 1, w.index + 1) } : w,
                        )
                      }
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700"
                    >
                      Next <ChevronRight className="h-3.5 w-3.5" />
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setWalk(null);
                        pushBot(
                          pick(
                            {
                              en: 'That’s the whole screen — you’re set. Anything else you want me to explain?',
                              hi: 'Bas itna hi tha — ab aap ready ho. Aur kuch samjhaun?',
                            },
                            lang,
                          ),
                        );
                      }}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
                    >
                      <Check className="h-3.5 w-3.5" /> Done
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Quick actions + composer */}
          <div className="px-3 pt-2.5 border-t border-slate-200 bg-white">
            <div className="flex items-center gap-1.5 mb-2">
              <button
                onClick={() => startWalkthrough(0)}
                className="inline-flex items-center gap-1 rounded-full bg-brand-600 text-white px-3 py-1 text-[11px] font-semibold hover:bg-brand-700"
              >
                <Compass className="h-3 w-3" />
                {pick({ en: 'Guide me', hi: 'Guide karo' }, lang)}
              </button>
              <div className="flex gap-1.5 overflow-x-auto">
                {chips.slice(0, 2).map((chip) => (
                  <button
                    key={chip.en}
                    onClick={() => send(pick(chip, lang))}
                    className="shrink-0 rounded-full border border-slate-200 px-2.5 py-1 text-[11px] text-ink-600 hover:border-brand-400 hover:text-brand-700"
                  >
                    {pick(chip, lang)}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-2 pb-3">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && send()}
                placeholder={PLACEHOLDER[lang]}
                className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-[13px] text-ink-900 focus:outline-none focus:border-brand-500"
              />
              <button
                onClick={() => send()}
                className="bg-brand-600 p-2 rounded-xl hover:bg-brand-700"
                aria-label="Send message to Joy"
              >
                <Send className="h-4 w-4 text-white" />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-end gap-2">
          {showBubble && (
            <div className="relative max-w-[72vw] sm:max-w-xs bg-white border border-brand-200 rounded-2xl rounded-br-sm px-3.5 py-2.5 shadow-card text-left">
              <button
                onClick={() => setShowBubble(false)}
                className="absolute -top-2 -right-2 bg-white border border-slate-200 rounded-full p-1 text-ink-400 hover:text-ink-700"
                aria-label="Dismiss Joy's nudge"
              >
                <X className="h-3 w-3" />
              </button>
              <button onClick={openChat} className="text-left">
                <p className="text-[13px] text-ink-900 font-semibold">Hi, I’m Joy 👋</p>
                <p className="text-[11px] text-ink-500 mt-0.5 leading-snug">{BUBBLE.en}</p>
              </button>
            </div>
          )}
          {/* Compact, icon-only launcher so it stays out of the way of the page. */}
          <button
            onClick={openChat}
            className="bg-brand-600 p-3 rounded-full shadow-card hover:bg-brand-700 transition-colors"
            aria-label="Open Joy, your ReportCard Studio guide"
            title="Open Joy, your guide"
          >
            <MessageCircle className="h-5 w-5 text-white" />
          </button>
        </div>
      )}
    </div>
  );
}

const screenLabel = (screen: ReturnType<typeof screenFromPath>): string => {
  const labels: Record<ReturnType<typeof screenFromPath>, string> = {
    dashboard: 'Dashboard',
    'school-profile': 'School Profile',
    import: 'Import Students',
    template: 'Report Template',
    generate: 'Generate Reports',
    pricing: 'Plans',
    login: 'Sign in',
  };
  return labels[screen];
};
