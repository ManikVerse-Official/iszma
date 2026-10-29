/**
 * Joy's local knowledge base.
 *
 * Joy is a rule-based assistant (no external LLM), so "smartness" comes from
 * this file: it maps what a visitor types — English or Hinglish — to a section
 * of Ishmaverse, decides whether they are asking *where* something is or asking
 * to be *taken there*, and answers in the right language.
 *
 * Language policy: Joy answers in the language the visitor writes in. English is
 * the default; a Hinglish question ("attendance 103 kyu warning de raha hai")
 * gets a Hinglish answer, an English question gets an English answer — the
 * assistant resolves the same intent either way. Every reply therefore exists in
 * both languages, and the UI follows the visitor's own message.
 *
 * Every section of the mall lives in `src/data/sections.ts`; the routes here
 * mirror the app's real routes so a match can navigate straight to it.
 */

import {
  JOY_FAQ,
  type JoyFaqEntry,
  type JoyGuideStep,
  type JoySectionGuide,
  getSectionGuide,
} from './joySectionGuides';
import { mallSections } from '../data/sections';
import { TIER_LABELS, TIER_OPTIONS, greetingThemes } from '../data/greetingThemes';
import type { GreetingTheme, GreetingTier } from '../types';

export type JoyLang = 'en' | 'hi';
export type { JoyGuideStep, JoySectionGuide };
export { getSectionGuide };

/**
 * The language an interface answers a message in: the visitor's own.
 *
 * Understanding and answering use the same signal, so a Hinglish question is
 * never answered in English (and vice versa). The keyword banks are
 * language-independent, so the resolved intent is identical in both cases.
 */
export const joyReplyLanguage = (raw: string): JoyLang => detectJoyLanguage(raw);

/** Bilingual text, resolved with {@link pick}. */
export interface JoyText {
  en: string;
  hi: string;
}

export const pick = (text: JoyText, lang: JoyLang): string => text[lang];

export interface JoyTopic {
  id: string;
  /** In-app route for this section/thing. */
  route: string;
  emoji: string;
  name: string;
  available: boolean;
  /** Trigger words/phrases (English + Hindi/Hinglish, lower-case). */
  keywords: string[];
  /** Short "where it is + what it does" answer. */
  reply: JoyText;
  /** Label for the tap-to-open button under the reply. */
  actionLabel: JoyText;
}

const sectionsRoute = (id: string) => `/section/${id}`;

/** Where the in-app founder page lives. */
export const FOUNDER_ROUTE = '/founder';

/** Every section a visitor can be pointed to, plus a couple of info areas. */
export const JOY_TOPICS: JoyTopic[] = [
  {
    id: 'greetings',
    route: sectionsRoute('greetings'),
    emoji: '💌',
    name: 'Digital Greetings',
    available: true,
    keywords: [
      'greeting', 'greetings', 'greeting card', 'greeting cards', 'e card', 'ecard', 'e-card',
      'card', 'cards', 'wish', 'wishes', 'wishing', 'birthday', 'bday', 'b day', 'anniversary',
      'wedding', 'marriage', 'shaadi', 'shadi', 'diwali', 'deepavali', 'holi', 'christmas', 'xmas',
      'new year', 'valentine', 'romantic', 'love', 'thank you', 'thankyou', 'thanks', 'congrats',
      'congratulations', 'farewell', 'baby shower', 'get well', 'rakhi', 'raksha bandhan',
      'mubarak', 'shubhkamna', 'badhai', 'badhaai', 'khushkhabri', 'card banana', 'card banan',
      'card bnana', 'card banao', 'greeting banana', 'greeting bhej', 'wish bhej', 'wish banao',
      'card kaise bana', 'card kaise banaye', 'greeting kaha', 'card kaha', 'greeting card kaha',
      'happy birthday card', 'invitation', 'invite',
    ],
    reply: {
      en: 'Digital Greetings 💌 live in the “Digital Greetings” section of the mall. There you will find animated cards for birthdays, anniversaries, weddings, Diwali, Christmas, thank-yous and more. A FREE Welcome Card sits right at the top and costs nothing — you can send it again and again (a small fair-use free allowance applies per email/network); paid themes add the full library, more fonts, custom colours and music. Would you like me to take you there?',
      hi: 'Digital Greetings 💌 mall ke “Digital Greetings” section me hai. Birthday, anniversary, wedding, Diwali, Christmas aur thank-you — sab ke animated cards milte hain. Sabse upar ek FREE Welcome Card hai jo bilkul free hai — aap ise baar baar bhej sakte ho (per email/network ek chhoti free limit lagti hai); paid themes me poori library, zyada fonts, custom colours aur music milta hai. Main aapko wahan le chalti hoon?',
    },
    actionLabel: { en: 'Open Digital Greetings', hi: 'Digital Greetings kholo' },
  },
  {
    id: 'reportcard-studio',
    route: sectionsRoute('reportcard-studio'),
    emoji: '📊',
    name: 'ReportCard Studio',
    available: true,
    keywords: [
      'report card', 'report-card', 'reportcard', 'report cards', 'report', 'reports', 'marksheet',
      'mark sheet', 'marks card', 'result', 'results', 'school', 'schools', 'student', 'students',
      'teacher', 'teachers', 'excel', 'xls', 'xlsx', 'csv', 'pdf', 'holistic', 'academic', 'grade',
      'grades', 'cbse', 'term report', 'class result', 'report banao', 'report banana', 'report bnana',
      'marksheet banao', 'marksheet banana', 'result banao', 'result banana', 'result card',
      'student report', 'school report', 'report card maker', 'report card generator', 'padhai',
      'pariksha', 'imtihan', 'report kaha', 'report card kaha', 'marksheet kaha',
    ],
    reply: {
      en: 'ReportCard Studio 📊 is in the “ReportCard Studio” section. Upload an Excel sheet, map the columns and download print-ready report cards — holistic or academic — as PDFs. The first 7 generations are free. Shall I take you there?',
      hi: 'ReportCard Studio 📊 “ReportCard Studio” section me hai. Excel sheet upload karo, columns map karo aur holistic ya academic report cards PDF me download karo. Pehli 7 generations free hain. Main aapko wahan le chalti hoon?',
    },
    actionLabel: { en: 'Open ReportCard Studio', hi: 'ReportCard Studio kholo' },
  },
  {
    id: 'free-card',
    route: sectionsRoute('greetings'),
    emoji: '🎁',
    name: 'Free Welcome Card',
    available: true,
    keywords: [
      'free', 'free card', 'free greeting', 'free me', 'free mein', 'muft', 'muft card',
      'welcome card', 'free kaise', 'free wishing', 'free wish', 'no cost card',
      'free again', 'free dobara', 'baar baar free', 'free recharge', 'free card again',
      'again and again', 'multiple free', 'ek se zyada free', 'jab chahe free',
    ],
    reply: {
      en: 'The FREE Welcome Card 🎁 is pinned at the very top of “Digital Greetings”, and it costs nothing — no payment and no card details, ever. You can use it again and again (the only cap is a small fair-use free allowance per email and per network). It keeps your names, message and photo, and its share link stays live for 48 hours. Would you like me to open it for you?',
      hi: 'FREE Welcome Card 🎁 “Digital Greetings” me sabse upar hai aur bilkul free hai — na payment, na card details, kabhi bhi. Aap ise baar baar use kar sakte ho (bas ek chhoti fair-use free limit per email aur per network lagti hai). Isme aapke naam, message aur photo lagte hain, aur share link 48 ghante live rehta hai. Main aapko wahan le chalti hoon?',
    },
    actionLabel: { en: 'Open the free card', hi: 'Free card kholo' },
  },
  {
    id: 'game-zone',
    route: sectionsRoute('game-zone'),
    emoji: '🎮',
    name: 'Game Zone',
    available: true,
    /*
     * Location words only. The rules themselves are answered by the Pair-3Balls
     * FAQ entry and the Game Zone guide — a rules question matches a longer
     * keyword there and wins, so this topic can never swallow the rules.
     */
    keywords: [
      'game zone', 'games section', 'game section', 'arcade', 'play a game', 'play games',
      'online game', 'online games', 'multiplayer', 'pair 3 balls', 'pair3balls', 'pair-3balls',
      'game kaha', 'game kahan', 'games kaha', 'khelne kaha', 'khelne ka section',
    ],
    reply: {
      en: 'Game Zone 🎮 lives in the “Game Zone” section of the mall. Inside is Pair-3Balls — nine points, three pieces each, one line to win, 60 seconds a turn — in four modes: vs Computer (works offline), Two Players on one device (also offline), a Private Room you invite a friend to with a code or a link, and World Match against a real player. The same move repeated more than three times draws the game. When the backend is off, the section says the online modes are unavailable instead of pretending. Want me to open it?',
      hi: 'Game Zone 🎮 mall ke “Game Zone” section me hai. Andar Pair-3Balls hai — nau points, teen pieces, ek line banao aur jeeto, har turn 60 second — chaar modes me: Computer ke saath (offline chalta hai), Two Players ek hi device par (ye bhi offline), Private Room (code ya link se dost ko bulao) aur World Match (asli player se). Wahi move teen baar se zyada dohrane par game draw ho jaata hai. Backend off ho to section saaf likhta hai ki online modes available nahi hain, dikhawa nahi karta. Khol doon?',
    },
    actionLabel: { en: 'Open Game Zone', hi: 'Game Zone kholo' },
  },
  {
    id: 'ui-themes',
    route: sectionsRoute('ui-themes'),
    emoji: '🎨',
    name: 'UI Themes & Scripts',
    available: false,
    keywords: [
      'ui', 'ui theme', 'ui themes', 'theme', 'themes', 'figma', 'figma kit', 'template',
      'templates', 'web layout', 'layout', 'mockup', 'mockups', 'design', 'design kit',
      'website theme', 'ui kit', 'ui kaha', 'theme kaha',
    ],
    reply: {
      en: 'UI Themes & Scripts 🎨 is a section of the mall for Figma kits, web layouts and mockups. It is not live yet (“Coming soon”), but I can show you the section page.',
      hi: 'UI Themes & Scripts 🎨 mall ka ek section hai — Figma kits, web layouts aur mockups ke liye. Abhi ye live nahi hai (“Coming soon”), par main aapko uska page dikha sakti hoon.',
    },
    actionLabel: { en: 'Show UI Themes section', hi: 'UI Themes dikhao' },
  },
  {
    id: 'tech-ai',
    route: sectionsRoute('tech-ai'),
    emoji: '🤖',
    name: 'Tech & AI',
    available: false,
    keywords: [
      'tech', 'ai', 'a.i', 'artificial intelligence', 'autocad', 'auto cad', 'script', 'scripts',
      'automation', 'automatic', 'wiring', 'electric', 'diagram', 'machine learning', 'ml',
      'tech kaha', 'ai kaha',
    ],
    reply: {
      en: 'Tech & AI 🤖 is the section for AutoCAD scripts, wiring assistants and automation tools. It is still “Coming soon”, but I can show you the section page.',
      hi: 'Tech & AI 🤖 section me AutoCAD scripts, wiring assistants aur automation tools honge. Abhi “Coming soon” hai, par main aapko us section par le chal sakti hoon.',
    },
    actionLabel: { en: 'Show Tech & AI section', hi: 'Tech & AI dikhao' },
  },
  {
    id: 'education',
    route: sectionsRoute('education'),
    emoji: '📚',
    name: 'Education',
    available: false,
    keywords: [
      'education', 'notes', 'note', 'sample paper', 'question bank', 'study', 'study material',
      'padhai', 'padai', 'syllabus', 'exam', 'education kaha', 'notes kaha',
    ],
    reply: {
      en: 'Education 📚 will hold notes, sample papers and question banks. It is not live yet (“Coming soon”) — I can take you to the section page.',
      hi: 'Education 📚 section me notes, sample papers aur question banks aayenge. Abhi “Coming soon” hai — main aapko us section ka page dikha sakti hoon.',
    },
    actionLabel: { en: 'Show Education section', hi: 'Education dikhao' },
  },
  {
    id: 'originals',
    route: sectionsRoute('originals'),
    emoji: '✨',
    name: 'Originals',
    available: false,
    keywords: [
      'original', 'originals', 'artwork', 'wallpaper', 'wallpapers', 'print', 'print on demand',
      'poster', 'posters', 'art', 'painting', 'originals kaha',
    ],
    reply: {
      en: 'Originals ✨ is where premium artwork, wallpapers and print-on-demand products will live. It is “Coming soon” for now, but I can take you there.',
      hi: 'Originals ✨ section me premium artwork, wallpapers aur print-on-demand products honge. Filhaal “Coming soon” hai, par main aapko wahan le chal sakti hoon.',
    },
    actionLabel: { en: 'Show Originals section', hi: 'Originals dikhao' },
  },
  {
    id: 'fx-studios',
    route: sectionsRoute('fx-studios'),
    emoji: '🎬',
    name: 'FX / Studios',
    available: false,
    keywords: [
      'fx', 'vfx', 'video', 'videos', 'effect', 'effects', 'transition', 'transitions', 'premiere',
      'premiere pro', 'editing', 'video edit', 'video effect', 'animation pack', 'fx kaha',
    ],
    reply: {
      en: 'FX / Studios 🎬 will offer video effects, transitions and Premiere packs. It is “Coming soon” — I can show you the section.',
      hi: 'FX / Studios 🎬 section me video effects, transitions aur Premiere packs honge. Abhi “Coming soon” hai — main aapko us section par le chal sakti hoon.',
    },
    actionLabel: { en: 'Show FX / Studios section', hi: 'FX / Studios dikhao' },
  },
  {
    id: 'comics',
    route: sectionsRoute('comics'),
    emoji: '📖',
    name: 'Comics',
    available: false,
    keywords: ['comic', 'comics', 'graphic novel', 'manga', 'story', 'stories', 'series', 'comic book', 'comics kaha'],
    reply: {
      en: 'Comics 📖 will carry graphic novels and ongoing series. It is “Coming soon” for now — I can take you to the section.',
      hi: 'Comics 📖 section me graphic novels aur ongoing series aayengi. Filhaal “Coming soon” hai — main aapko wahan le chal sakti hoon.',
    },
    actionLabel: { en: 'Show Comics section', hi: 'Comics dikhao' },
  },
];

/* ------------------------------------------------------------------ */
/* Founder                                                            */
/* ------------------------------------------------------------------ */

/**
 * The founder intro asks a question, so the caller waits for the answer before
 * navigating. Joy never invents details — just the name and the offer.
 */
export const FOUNDER_INTRO: JoyText = {
  en: 'isZma is founded by Manik. Would you like to see his profile?',
  hi: 'isZma ke founder Manik hain. Unka profile dekhna chahenge?',
};

export const FOUNDER_YES: JoyText = {
  en: 'Great — opening Manik’s profile now.',
  hi: 'Bilkul — main Manik ka profile khol rahi hoon.',
};

export const FOUNDER_NO: JoyText = {
  en: 'No problem. How can I help you?',
  hi: 'Koi baat nahi. Main aur kaise madad kar sakti hoon?',
};

export const FOUNDER_VIEW_LABEL: JoyText = {
  en: 'See Manik’s profile',
  hi: 'Manik ka profile dekho',
};

/* ------------------------------------------------------------------ */
/* Phrase banks                                                       */
/* ------------------------------------------------------------------ */

/** Words that mean "take me there". */
const OPEN_WORDS = [
  'open', 'open it', 'open karo', 'open kar do', 'kholo', 'khol do', 'khol', 'le chalo', 'le chal',
  'le jao', 'lejao', 'le jana', 'le chaliye', 'chalo', 'chal', 'navigate', 'go to', 'take me',
  'dikhao', 'dikha do', 'dikha', 'dikhaiye', 'show me', 'show', 'jao', 'jana', 'pahuncha do',
  'bhej do', 'open kr', 'open kar',
];

/** Words that mean "where is it". */
const WHERE_WORDS = [
  'where', 'where is', 'where are', 'kaha', 'kahan', 'kahaan', 'konsi', 'kaunsi', 'kis section',
  'which section', 'location', 'find', 'dhoondo', 'dhundo', 'kahan hai', 'kaha hai',
];

/** Pricing / cost words. */
const PRICING_WORDS = [
  'price', 'prices', 'pricing', 'cost', 'costs', 'rate', 'rates', 'charges', 'charge', 'kitna',
  'kitne', 'kitna paisa', 'paisa', 'paise', 'rupees', 'rupaye', 'amount', 'fee', 'fees',
  'subscription', 'plan', 'plans', 'package', 'mehnga', 'sasta',
];

/** "What can you do / what is this site" words. */
const HELP_WORDS = [
  'help', 'madad', 'what can you do', 'kya kar sakte', 'kya kar sakti', 'sections', 'section',
  'mall', 'what is this', 'kya hai', 'about', 'ishmaverse kya', 'iszma kya', 'kya kya hai', 'list',
];

/** Founder / ownership words. */
const FOUNDER_WORDS = [
  'founder', 'co founder', 'co-founder', 'owner', 'creator', 'who made this',
  'who made', 'who owns', 'who built', 'who is behind', 'team behind', 'manik', 'manik dey',
  'portfolio', 'malik', 'kiski website', 'kisne banaya', 'kisne banai', 'kisne bnaya',
  'kaun banaya', 'kon banaya', 'kiska hai', 'owner kaun', 'founder kaun', 'boss',
];

/** Clear "yes" answers. */
const YES_WORDS = [
  'yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'yes please', 'go ahead', 'please do',
  'haan', 'ha', 'haa', 'hn', 'han', 'haanji', 'bilkul', 'zaroor', 'dikhao', 'dikhaiye',
  'kholo', 'le chalo', 'le chaliye', 'show me', 'open it',
];

/** Clear "no" answers. */
const NO_WORDS = [
  'no', 'nope', 'nah', 'nahi', 'nahin', 'nai', 'na', 'not now', 'later', 'baad me', 'baad mein',
  'abhi nahi', 'no thanks', 'no thank you', 'skip', 'rehne do', 'chhodo', 'chodo', 'nahi chahiye',
];

/** Markers that strongly indicate romanised Hindi (Hinglish). */
const HINGLISH_MARKERS = [
  'kya', 'kaise', 'kaisa', 'kaisi', 'kaha', 'kahan', 'kahaan', 'nahi', 'nahin', 'mujhe', 'mera',
  'meri', 'tum', 'aap', 'aapko', 'aapka', 'aapki', 'chahiye', 'karo', 'kro', 'krna', 'karna',
  'kholo', 'khol', 'bolo', 'bol', 'yaar', 'bhai', 'kaun', 'kon', 'kisne', 'kis', 'mein', 'bohot',
  'bahut', 'theek', 'thik', 'dikhao', 'dikhaiye', 'dikha', 'batao', 'bata', 'jaldi', 'matlab',
  'wala', 'waala', 'kyun', 'kyu', 'konsi', 'kaunsi', 'chalo', 'chal', 'dedo', 'sakta', 'sakti',
  'haan', 'haa', 'hn', 'hai', 'hain', 'kitna', 'kitne', 'paisa', 'paise', 'rupaye', 'zaroor',
  'bilkul', 'accha', 'acha', 'haanji', 'lelo', 'chalega', 'hoga', 'hogi', 'kaunsi', 'wahan',
  'yahan', 'dekhna', 'bana', 'banaya', 'banao', 'hoja',
];

/* ------------------------------------------------------------------ */
/* Localised built-in replies                                         */
/* ------------------------------------------------------------------ */

/**
 * The four greeting-card tiers and their current prices, read from the same
 * product data the storefront uses. Joy therefore answers with real catalogue
 * values instead of a hard-coded "starts at" line that drifts when an admin
 * changes a price.
 */
export interface GreetingTierPrice {
  tier: GreetingTier;
  label: string;
  price: number;
  priceUsd: number;
  themeCount: number;
}

export const getGreetingTierPrices = (
  source: Pick<GreetingTheme, 'tier' | 'price' | 'price_usd'>[] = greetingThemes,
): GreetingTierPrice[] =>
  TIER_OPTIONS.map((tier) => {
    const themes = source.filter((theme) => theme.tier === tier && theme.price > 0);
    return {
      tier,
      label: TIER_LABELS[tier],
      price: themes[0]?.price ?? 0,
      priceUsd: themes[0]?.price_usd ?? 0,
      themeCount: themes.length,
    };
  });

const greetingTierLine = (prices: GreetingTierPrice[] = getGreetingTierPrices()): string =>
  prices.map((tier) => `${tier.label} ₹${tier.price}`).join(' · ');

const pricingReply = (prices?: GreetingTierPrice[]): JoyText => ({
  en: `Pricing 💰 — Digital Greetings has four card tiers: ${greetingTierLine(prices)} (USD prices are shown outside India), and there is a FREE Welcome Card as well. ReportCard Studio plans are ₹369 / ₹578 / ₹859 (6 months each), with the first 7 report generations free. Which one would you like the exact price for?`,
  hi: `Pricing 💰 — Digital Greetings me chaar card tiers hain: ${greetingTierLine(prices)} (India ke bahar USD prices dikhte hain), aur ek FREE Welcome Card bhi hai. ReportCard Studio ke plans ₹369 / ₹578 / ₹859 (6 months) hain, pehli 7 report generations free. Kis cheez ka exact price chahiye?`,
});

/*
 * Built from the section list itself, so this can never drift out of date: the
 * live ones are named with what they do, and the rest are honestly “coming
 * soon” rather than quietly missing.
 */
const liveSectionLine = (): string =>
  mallSections
    .filter((section) => section.available)
    .map((section) => `${section.emoji} ${section.name}`)
    .join(', ');

const comingSoonLine = (): string =>
  mallSections
    .filter((section) => !section.available)
    .map((section) => section.name)
    .join(', ');

const HELP_REPLY: JoyText = {
  en: `I’m Joy, the assistant here at isZma, The Digital Mall. Live right now: ${liveSectionLine()} — animated greeting cards (including a FREE Welcome Card you can send again and again), print-ready report cards from an Excel mark sheet (7 free generations per account), and Game Zone’s Pair-3Balls against the computer, a friend or a real opponent. Still “coming soon”: ${comingSoonLine()}. Ask me about prices, payment, fonts and music, card lifetime, or what usually goes wrong in any section — name a section or a problem and I’ll answer it or take you straight there.`,
  hi: `Main Joy hoon, isZma ki assistant. Abhi live: ${liveSectionLine()} — animated greeting cards (FREE Welcome Card bhi, jo aap baar baar bhej sakte ho), Excel mark sheet se print-ready report cards (per account 7 free generations), aur Game Zone me Pair-3Balls (computer, dost ya asli opponent ke saath). “Coming soon”: ${comingSoonLine()}. Price, payment, font aur music, card kitni der live rehta hai, ya kisi bhi section me kya gadbad hoti hai — section ka naam ya problem bolo, main jawab deti hoon ya seedha wahan le chalti hoon.`,
};

/**
 * Polite off-topic redirect.
 *
 * When someone asks something that has nothing to do with the mall, Joy does
 * not pretend or guess — she says (nicely, in the visitor's own language) that
 * she can only help with isZma, then lists what she *can* do.
 */
const FALLBACK_REPLY: JoyText = {
  en: 'I’m Joy, the isZma assistant — I can only help with things here on isZma. Ask me about our greeting cards, ReportCard Studio, prices, or where to find a section, and I’ll take you straight there.',
  hi: 'Main Joy hoon, isZma ki assistant — main sirf isZma se judi cheezon me madad kar sakti hoon. Greeting cards, ReportCard Studio, price, ya koi section kahan hai — ye poochhiye, main seedha wahan le chalti hoon.',
};

export const getFallback = (lang: JoyLang): string => pick(FALLBACK_REPLY, lang);

/* ------------------------------------------------------------------ */
/* Matching                                                           */
/* ------------------------------------------------------------------ */

/** Lower-cases, strips punctuation and collapses whitespace. */
const normalize = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^\w\s+.-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word matcher. Word boundaries stop short keywords from matching inside
 * unrelated words ("ai" in "mail", "ui" in "build", "art" in "start").
 */
const toRegexes = (words: string[]): RegExp[] =>
  words.map((word) => new RegExp(`\\b${escapeRegExp(word)}\\b`, 'i'));

const anyMatch = (text: string, regexes: RegExp[]): boolean => regexes.some((re) => re.test(text));

const tokensOf = (text: string): string[] => text.split(' ').filter(Boolean);

/**
 * Optimal-string-alignment distance (Levenshtein + adjacent transposition).
 *
 * A transposition counts as one edit, so "reprot" → "report" and "markshet" →
 * "marksheet" are one typo, not two.
 */
export const editDistance = (a: string, b: string): number => {
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev2: number[] = [];
  let prev: number[] = Array.from({ length: cols }, (_, j) => j);
  for (let i = 1; i < rows; i++) {
    const current: number[] = [i];
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, current[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      current[j] = value;
    }
    prev2 = prev;
    prev = current;
  }
  return prev[cols - 1];
};

/** How many typos a keyword of this length may carry before we stop trusting it. */
const typoBudget = (word: string): number =>
  word.length >= 9 ? 2 : word.length >= 5 ? 1 : 0;

/**
 * True when `typed` is just `expected` with a one- or two-letter affix.
 *
 * That is the same word, not a misspelling. Without this guard the exact word
 * "card" would "typo-match" the keyword "ecard" and wrongly outrank a more
 * specific answer (e.g. "elite card" → the tiers FAQ).
 */
const affixOnly = (typed: string, expected: string): boolean => {
  if (typed.length < 3 || typed.length >= expected.length) return false;
  if (expected.length - typed.length > 2) return false;
  return expected.startsWith(typed) || expected.endsWith(typed);
};

/**
 * Typo-tolerant keyword search, used only after the exact matcher misses.
 *
 * This is what lets Joy understand "reprot card kaha hai", "greeeting price" or
 * "markshet banao" instead of falling back to the "I only help with isZma"
 * message. Multi-word keywords are matched over a sliding window of query
 * tokens, and a keyword only counts when it is *not* an exact match (those are
 * handled by the faster regex path) and stays inside its typo budget.
 */
export const fuzzyKeywordMatch = (tokens: string[], keywords: string[]): string | null => {
  for (const keyword of keywords) {
    const parts = keyword.split(' ').filter(Boolean);
    if (parts.length === 0 || tokens.length < parts.length) continue;
    for (let start = 0; start + parts.length <= tokens.length; start++) {
      let distance = 0;
      let usable = true;
      for (let offset = 0; offset < parts.length; offset++) {
        const typed = tokens[start + offset];
        const expected = parts[offset];
        if (typed === expected) continue;
        if (affixOnly(typed, expected)) {
          usable = false;
          break;
        }
        const budget = typoBudget(expected);
        const d = editDistance(typed, expected);
        if (budget === 0 || d > budget) {
          usable = false;
          break;
        }
        distance += d;
      }
      if (usable && distance > 0) return keyword;
    }
  }
  return null;
};

/**
 * True when the text hits a phrase bank — first by exact word match, then (only
 * if that misses) by tolerating a typo or two.
 */
const bankHit = (text: string, tokens: string[], exact: RegExp[], words: string[]): boolean =>
  anyMatch(text, exact) || fuzzyKeywordMatch(tokens, words) !== null;

const OPEN_RE = toRegexes(OPEN_WORDS);
const WHERE_RE = toRegexes(WHERE_WORDS);
const PRICING_RE = toRegexes(PRICING_WORDS);
const HELP_RE = toRegexes(HELP_WORDS);
const FOUNDER_RE = toRegexes(FOUNDER_WORDS);
const YES_RE = toRegexes(YES_WORDS);
const NO_RE = toRegexes(NO_WORDS);
const HINGLISH_RE = toRegexes(HINGLISH_MARKERS);
const TOPIC_REGEXES = new Map<string, RegExp[]>(
  JOY_TOPICS.map((topic) => [topic.id, toRegexes(topic.keywords)]),
);
/** "show me how to use this" — a walkthrough request rather than a lookup. */
const GUIDE_WORDS = [
  'how do i', 'how to', 'how can i', 'how do you', 'guide', 'guide me', 'walk me',
  'walkthrough', 'walk through', 'steps', 'step by step', 'help me', 'i am stuck', 'stuck',
  'confused', 'what do i do', 'what to do', 'teach me', 'explain', 'show me how', 'tutorial',
  'kaise', 'kaisa', 'kese', 'kaise kare', 'kaise karu', 'kaise use', 'use kaise', 'samjhao',
  'samjao', 'samjha do', 'batao kaise', 'madad karo', 'kya karu', 'kya karna', 'shuru kaise',
];
const GUIDE_RE = toRegexes(GUIDE_WORDS);

const FAQ_MATCHERS = JOY_FAQ.map((entry: JoyFaqEntry) => toRegexes(entry.keywords));

/* ------------------------------------------------------------------ */
/* Admin boundary (Public Joy)                                        */
/* ------------------------------------------------------------------ */

/** Where the admin sign-in page lives. */
export const ADMIN_ROUTE = '/admin';

/**
 * Words that mean the visitor wants the admin area. Public Joy never opens the
 * dashboard itself — she explains that authentication is required and offers
 * the sign-in page.
 */
const ADMIN_WORDS = [
  'admin', 'administrator', 'admin panel', 'admin dashboard', 'dashboard', 'control panel',
  'backend', 'back end', 'admin login', 'admin sign in', 'admin signin', 'manage products',
  'manage the site', 'site settings', 'upload product', 'admin area', 'admin account',
];

/**
 * Privileged actions the public chat must never perform.
 *
 * These are patterns, not fixed phrases, because a request can be worded many
 * ways ("change product XYZ's price", "update the price of …", "delete product
 * …"). The verb must sit near a collection noun (or carry a price) so ordinary
 * visitor questions are not misread as admin requests.
 */
const ADMIN_MUTATION_PATTERNS: RegExp[] = [
  /\b(delete|remove|add|create|edit|update|publish|unpublish)\b[^.!?]{0,40}\b(product|theme|track|music|song|item|catalogue|catalog|store)\b/i,
  /\b(change|set|update|badlo|badal)\b[^.!?]{0,30}\bprice\b[^.!?]{0,20}\d/i,
  /\bprice\b[^.!?]{0,20}\b(to|se|ko)\b[^.!?]{0,10}\d/i,
  /\b(make|grant|give)\b[^.!?]{0,20}\bme\b[^.!?]{0,15}\badmin\b/i,
  /\badmin\b[^.!?]{0,20}\b(access|rights|permission|permissions)\b/i,
];

const ADMIN_RE = toRegexes(ADMIN_WORDS);

/** True when the message asks for the admin area (in any phrasing). */
export const isAdminAccessQuery = (raw: string): boolean => {
  const text = normalize(raw);
  if (!text) return false;
  return anyMatch(text, ADMIN_RE) || ADMIN_MUTATION_PATTERNS.some((re) => re.test(text));
};

/** True when the message asks Public Joy to perform a privileged action. */
export const isAdminMutationRequest = (raw: string): boolean => {
  const text = normalize(raw);
  return text.length > 0 && ADMIN_MUTATION_PATTERNS.some((re) => re.test(text));
};

export const ADMIN_ACCESS_REPLY: JoyText = {
  en: 'The admin dashboard is a private area, so it needs a signed-in administrator account. I can open the admin sign-in page for you; the admin assistant is available only inside that authenticated dashboard. I cannot perform admin actions from the public site.',
  hi: 'Admin dashboard ek private area hai, isliye iske liye signed-in administrator account chahiye. Main aapke liye admin sign-in page khol sakti hoon; admin assistant sirf usi authenticated dashboard ke andar milta hai. Public site se main admin actions nahi kar sakti.',
};

export const ADMIN_MUTATION_REFUSAL: JoyText = {
  en: 'That is an administrative action. I can only do it inside an authenticated admin session — never from the public chat. I can open the admin sign-in page; sign in and ask again inside the dashboard.',
  hi: 'Ye ek administrative action hai. Main ise sirf authenticated admin session me kar sakti hoon — public chat se kabhi nahi. Main admin sign-in page khol sakti hoon; sign in karke dashboard ke andar dobara poochhiye.',
};

export const ADMIN_ACTION_LABEL: JoyText = {
  en: 'Open admin sign-in',
  hi: 'Admin sign-in kholo',
};

/* ------------------------------------------------------------------ */
/* Pair-3Balls: Joy explains the rules and nothing else                */
/* ------------------------------------------------------------------ */

/**
 * Joy is a RULES EXPLAINER, not a gameplay coach.
 *
 * Asking what the rules are is welcome: "how do I win?", "timer kitne seconds
 * ka hai?", "movement phase kaise chalti hai?". Asking for help PLAYING is
 * refused: move suggestions, board analysis, blocking advice, opponent
 * weaknesses, "which point should I choose", "how do I beat the computer".
 *
 * Detection needs an advice word together with a game signal (or one of the
 * unmistakable phrases), so a genuine rules question like "how do I win" is
 * never swallowed by the refusal, while "give me a winning tip" always is.
 */
const GAME_CONTEXT_WORDS = [
  'pair 3 balls', 'pair3balls', 'pair-3balls', 'game zone', 'gamezone',
  'board', 'piece', 'opponent', 'computer', 'khel', 'turn',
];

const GAME_ADVICE_WORDS = [
  'tip', 'tips', 'hint', 'hints', 'advice', 'suggest', 'suggestion', 'recommend',
  'strategy', 'strategies', 'strategic', 'tactics', 'tactic', 'tactical',
  'best move', 'next move', 'winning move', 'which move', 'what move',
  'how to beat', 'how do i beat', 'beat the', 'help me win', 'win this game',
  'weakness', 'analyse the board', 'analyze the board',
];

/**
 * Phrases that are advice requests on their own, with no other game word
 * needed. Deliberately excludes bare "how do i win" and "kaise khelte hain",
 * which are legitimate RULES questions.
 */
const GAME_STRATEGY_PHRASES = [
  'best move', 'next move', 'winning move', 'winning strategy', 'best strategy',
  'where should i move', 'where should i place', 'which point', 'what point',
  'should i move', 'should i place', 'should i choose', 'how to block',
  'block the opponent', 'help me win', 'win this game', 'give me a hint',
  'give me a tip', 'give me advice', 'any tips', 'any hints',
  'kya khelu', 'chaal batao', 'move batao', 'tip do', 'hint do', 'koi tip',
  'koi hint', 'jeetne ke liye kya', 'madad karo jeetne', 'kaunsa point',
  'konsa point', 'kaun sa point',
];

/** True when the visitor is asking Joy to help them PLAY rather than to explain. */
export const isGameStrategyQuery = (raw: string): boolean => {
  const text = normalize(raw);
  if (!text) return false;

  if (GAME_STRATEGY_PHRASES.some((phrase) => text.includes(phrase))) return true;

  const hasContext = GAME_CONTEXT_WORDS.some((word) => text.includes(word));
  const hasAdvice = GAME_ADVICE_WORDS.some((word) => text.includes(word));
  return hasContext && hasAdvice;
};

export const GAME_STRATEGY_REFUSAL: JoyText = {
  en: 'I can explain the official Pair-3Balls rules, but I cannot help with the play itself — no move suggestions, no board analysis and no winning strategies. That would be coaching rather than rules, and it would be unfair in an online match. What I can do is describe the rules: nine points joined by lines, three pieces each, place them first and then step a piece along a line to an empty point, three in a row wins, and every turn has a 60-second timer.',
  hi: 'Main Pair-3Balls ke official rules samjha sakti hoon, par khel me madad nahi kar sakti — na move suggestion, na board analysis, na jeetne ki strategy. Wo coaching hoti, rules nahi — aur online match me ye galat hoga. Haan, rules main zaroor bata sakti hoon: nau points lines se jude hue, teen-teen pieces, pehle place karo aur phir apna piece line se jude khaali point par step karo, teen line me bane to jeet, aur har turn par 60 second ka timer.',
};

/* The FAQ_MATCHERS reference is intentionally kept above the admin block so the
 * admin route is decided first inside resolveJoyQuery (security before replies). */

/** True when the message is asking to be taught how to use something. */
export const isGuideQuery = (raw: string): boolean => {
  const text = normalize(raw);
  return text.length > 0 && bankHit(text, tokensOf(text), GUIDE_RE, GUIDE_WORDS);
};

/**
 * The walkthrough for the section the visitor is currently standing in.
 * Returns null when there is no guided section (e.g. the home page).
 */
export const resolveJoyGuide = (
  raw: string,
  lang: JoyLang,
  sectionId?: string,
): { reply: string; steps: JoyGuideStep[] } | null => {
  if (!isGuideQuery(raw)) return null;
  const guide = getSectionGuide(sectionId);
  if (!guide) return null;
  return {
    reply: `${pick(guide.intro, lang)}\n\n${lang === 'hi' ? 'Step' : 'Step'} 1 of ${
      guide.steps.length
    }: ${pick(guide.steps[0].title, lang)}`,
    steps: guide.steps,
  };
};

/** One-tap questions shown for the current section (empty on the home page). */
export const getSectionChips = (sectionId?: string): JoyText[] =>
  getSectionGuide(sectionId)?.chips ?? [];

/**
 * Best FAQ hit for a message, with the length of the keyword that matched.
 *
 * Length is what breaks ties: a specific question ("free vs paid card") must
 * beat a generic one ("free"). Returns null when nothing matches.
 */
const matchFaq = (text: string, tokens: string[]): { index: number; length: number } | null => {
  let bestIndex = -1;
  let bestLen = 0;

  JOY_FAQ.forEach((entry, index) => {
    for (const re of FAQ_MATCHERS[index]) {
      const match = text.match(re);
      if (match && match[0].length > bestLen) {
        bestLen = match[0].length;
        bestIndex = index;
      }
    }
    const fuzzy = fuzzyKeywordMatch(tokens, entry.keywords);
    if (fuzzy && fuzzy.length > bestLen) {
      bestLen = fuzzy.length;
      bestIndex = index;
    }
  });

  return bestIndex >= 0 ? { index: bestIndex, length: bestLen } : null;
};

/** Answers a product question (free card, payment, receipt, plans, …). */
export const resolveJoyFaq = (raw: string, lang: JoyLang): string | null => {
  const text = normalize(raw);
  if (!text) return null;
  const hit = matchFaq(text, tokensOf(text));
  return hit ? pick(JOY_FAQ[hit.index].reply, lang) : null;
};

/**
 * Detects whether a message is written in Hinglish. English is the default, so
 * anything without a Hindi marker stays English.
 */
export const detectJoyLanguage = (raw: string): JoyLang =>
  anyMatch(normalize(raw), HINGLISH_RE) ? 'hi' : 'en';

/** True when the visitor is asking about the founder / owner. */
export const isFounderQuery = (raw: string): boolean => {
  const text = normalize(raw);
  return text.length > 0 && bankHit(text, tokensOf(text), FOUNDER_RE, FOUNDER_WORDS);
};

/** Reads a short yes/no answer (used by the founder confirmation step). */
export const parseConfirmation = (raw: string): 'yes' | 'no' | null => {
  const text = normalize(raw);
  if (!text) return null;
  if (anyMatch(text, NO_RE)) return 'no';
  if (anyMatch(text, YES_RE)) return 'yes';
  return null;
};

/**
 * Longest keyword the text actually contains (multi-word matches win).
 *
 * Runs the exact matcher first. Only when it finds nothing does it retry with the
 * typo-tolerant matcher, so a correct spelling always beats a fuzzy guess.
 *
 * The matched keyword's length is returned alongside the topic so a more
 * specific answer (an FAQ) can outrank a broad destination keyword such as
 * "card".
 */
const matchTopic = (text: string): { topic: JoyTopic; length: number } | null => {
  let best: JoyTopic | null = null;
  let bestLen = 0;
  /* Exact pass — a correct spelling always gets first say. */
  for (const topic of JOY_TOPICS) {
    for (const re of TOPIC_REGEXES.get(topic.id) ?? []) {
      const match = text.match(re);
      if (match && match[0].length > bestLen) {
        best = topic;
        bestLen = match[0].length;
      }
    }
  }
  /*
   * A typo-tolerant match that is LONGER than the best exact match wins, because
   * it carries more of the intent: "reprot card" (fuzzy, 11 chars) must beat the
   * exact word "card" (4 chars) and land on ReportCard Studio.
   */
  const tokens = tokensOf(text);
  for (const topic of JOY_TOPICS) {
    const hit = fuzzyKeywordMatch(tokens, topic.keywords);
    if (hit && hit.length > bestLen) {
      best = topic;
      bestLen = hit.length;
    }
  }
  return best ? { topic: best, length: bestLen } : null;
};

export type JoyResolution =
  | {
      kind: 'section';
      topic: JoyTopic;
      /** True when the user clearly asked to be taken there. */
      navigate: boolean;
      reply: string;
      actionLabel: string;
    }
  | { kind: 'pricing'; reply: string }
  | { kind: 'help'; reply: string }
  /** Admin access: authenticated area; Public Joy only points at sign-in. */
  | { kind: 'admin'; reply: string; route: string; actionLabel: string };

/**
 * Resolves an admin-area request for Public Joy.
 *
 * This is the public/admin separation boundary: a visitor is told that
 * authentication is required and is offered the sign-in route. No privileged
 * action is ever performed here, and claiming to be an admin changes nothing —
 * the reply is identical for everyone.
 */
export const resolveAdminAccess = (raw: string, lang: JoyLang = 'en'): {
  reply: string;
  route: string;
  actionLabel: string;
} | null => {
  if (!isAdminAccessQuery(raw)) return null;
  const mutation = isAdminMutationRequest(raw);
  return {
    reply: pick(mutation ? ADMIN_MUTATION_REFUSAL : ADMIN_ACCESS_REPLY, lang),
    route: ADMIN_ROUTE,
    actionLabel: pick(ADMIN_ACTION_LABEL, lang),
  };
};

/**
 * Resolves a visitor's message into an answer + an optional navigation target.
 * `lang` controls which language the reply is written in (default English).
 * Returns `null` when the message is unrelated (the caller then falls back).
 */
export const resolveJoyQuery = (
  raw: string,
  lang: JoyLang = 'en',
  /** Live tier prices from the catalogue; falls back to the seeded product data. */
  greetingTierPrices?: GreetingTierPrice[],
): JoyResolution | null => {
  const text = normalize(raw);
  if (!text) return null;

  /*
   * Admin requests are handled before any product navigation, so the public
   * assistant can never be talked into opening privileged tools. It only ever
   * points at the authenticated sign-in page.
   */
  const admin = resolveAdminAccess(raw, lang);
  if (admin) {
    return { kind: 'admin', reply: admin.reply, route: admin.route, actionLabel: admin.actionLabel };
  }

  /*
   * Pair-3Balls: rules yes, coaching no. Checked before any topic/FAQ match so
   * "what is the best move?" and "give me a hint" can never be answered with a
   * rules explanation that reads like advice.
   */
  if (isGameStrategyQuery(raw)) {
    return { kind: 'help', reply: pick(GAME_STRATEGY_REFUSAL, lang) };
  }

  const tokens = tokensOf(text);
  const topicHit = matchTopic(text);
  const faqHit = matchFaq(text, tokens);
  const wantsOpen = bankHit(text, tokens, OPEN_RE, OPEN_WORDS);
  const wantsWhere = bankHit(text, tokens, WHERE_RE, WHERE_WORDS);
  const wantsPrice = bankHit(text, tokens, PRICING_RE, PRICING_WORDS);

  /*
   * A more specific product question ("how long is my card live?") beats a
   * broad destination keyword ("card"), otherwise Joy would always answer with
   * "that section is over there" and never explain anything.
   */
  const topic =
    topicHit && !(faqHit && faqHit.length > topicHit.length) ? topicHit.topic : null;

  if (topic) {
    const base = pick(topic.reply, lang);
    const reply = wantsPrice
      ? `${base}\n\n${pick(
          {
            en: `For reference: greeting card tiers are ${greetingTierLine(greetingTierPrices)}, and ReportCard plans start at ₹369, with the first 7 generations free.`,
            hi: `Reference ke liye: greeting card tiers ${greetingTierLine(greetingTierPrices)} hain, aur ReportCard plans ₹369 se, pehli 7 generations free.`,
          },
          lang,
        )}`
      : base;

    return {
      kind: 'section',
      topic,
      navigate: wantsOpen,
      reply,
      actionLabel: pick(topic.actionLabel, lang),
    };
  }

  /*
   * No destination matched, so treat it as a question and answer it: free card,
   * payment methods, receipts/bills, sign-in, plans, renewals, card lifetime,
   * tiers, photos, support. These are the things people actually get stuck on.
   */
  if (faqHit) return { kind: 'help', reply: pick(JOY_FAQ[faqHit.index].reply, lang) };

  if (wantsPrice) return { kind: 'pricing', reply: pick(pricingReply(greetingTierPrices), lang) };
  if (bankHit(text, tokens, HELP_RE, HELP_WORDS) || (wantsWhere && wantsOpen)) {
    return { kind: 'help', reply: pick(HELP_REPLY, lang) };
  }

  return null;
};
