import {
  GreetingTheme,
  GreetingThemeCategory,
  GreetingThemeDesign,
  GreetingTier,
} from '../types';

/**
 * Built-in greeting theme catalog.
 *
 * Every theme carries two colour systems:
 *   • gradient / accent → the storefront tile and badges
 *   • design            → the actual rendered card (surface, ink, glow, frame)
 *
 * Designs are genre-matched and tier-scaled: basics are clean and airy, while
 * premium/elite themes layer deeper gradients, stronger glows and richer photo
 * frames so they genuinely read as "expensive".
 */
export const greetingCategories: GreetingThemeCategory[] = [
  {
    id: 'romantic',
    name: 'Romantic',
    emoji: '💕',
    description: 'For the one who makes your heart skip',
    keywords: ['romantic', 'love', 'valentine', 'girlfriend', 'boyfriend', 'wife', 'husband', 'propose', 'crush'],
  },
  {
    id: 'birthday',
    name: 'Birthday',
    emoji: '🎂',
    description: 'Confetti, balloons and cake',
    keywords: ['birthday', 'bday', 'wish', 'party', 'cake', 'balloon', 'celebration'],
  },
  {
    id: 'marriage',
    name: 'Marriage & Anniversary',
    emoji: '💍',
    description: 'Weddings, engagements and every happy year after',
    keywords: ['marriage', 'wedding', 'anniversary', 'engagement', 'bride', 'groom', 'couple', 'vows'],
  },
  {
    id: 'festival',
    name: 'Festivals',
    emoji: '🪔',
    description: 'Diwali, Holi, Christmas, New Year and more',
    keywords: ['festival', 'festivals', 'diwali', 'holi', 'christmas', 'new year', 'eid', 'rakhi', 'raksha bandhan', 'pongal', 'baisakhi'],
  },
  {
    id: 'event',
    name: 'Functions & Events',
    emoji: '🎊',
    description: 'Farewell, housewarming, results, achievements',
    keywords: ['function', 'event', 'farewell', 'housewarming', 'new home', 'achievement', 'congrats', 'congratulations', 'result', 'topper', 'promotion', 'retirement'],
  },
  {
    id: 'family',
    name: 'Family & Friends',
    emoji: '🫶',
    description: 'Thank you, get well soon, new baby',
    keywords: ['family', 'friend', 'friends', 'thank you', 'thanks', 'get well', 'new baby', 'baby shower', 'mother', 'father', 'sister', 'brother', 'miss you'],
  },
];

export const greetingThemes: GreetingTheme[] = [
  /* ======================= FREE WELCOME CARD ======================== */
  /*
   * The one card a first-time visitor can send for free. Price 0 marks it as
   * the free theme; the storefront shows a FREE badge and the builder routes it
   * to the `create-free-greeting` Edge Function (which enforces the free-use
   * limits) instead of the payment flow.
   *
   * It is deliberately the FIRST entry in the catalog so every visitor sees the
   * free welcome card at the very top of the storefront the moment it opens.
   */
  {
    id: 'free-basic-wish',
    category_id: 'event',
    name: 'Free Welcome Card',
    tagline: 'A free card to say thank you — try isZma on us',
    price: 0,
    price_usd: 0,
    tier: 'basic',
    emoji: '💌',
    accent: '#38bdf8',
    gradient: 'from-sky-400 via-cyan-400 to-blue-500',
    animation: 'sparkles',
    tags: ['free', 'welcome', 'thank you', 'basic', 'simple', 'gift', 'thanks'],
    design: {
      surface: ['#0c2340', '#1d4ed8'],
      ink: '#e6f0ff',
      inkSoft: '#93c5fd',
      border: 'rgba(56,189,248,0.5)',
      glow: 'rgba(56,189,248,0.4)',
      frame: 'soft',
      motion: 'fade',
      ornaments: ['💌'],
      defaultFont: 'modern-sans',
    },
  },

  /* ============================ ROMANTIC ============================ */
  {
    id: 'romantic-rose-note',
    category_id: 'romantic',
    name: 'Rose Note',
    tagline: 'A soft pink love letter that fades in',
    price: 47,
    price_usd: 2,
    tier: 'basic',
    emoji: '🌹',
    accent: '#fb7185',
    gradient: 'from-rose-400 via-pink-400 to-rose-500',
    animation: 'hearts',
    tags: ['rose', 'simple', 'cute', 'love letter', 'pink', 'romantic'],
    design: {
      surface: ['#3b0a1f', '#7f1d3a'],
      ink: '#ffe4ef',
      inkSoft: '#f9a8c9',
      border: 'rgba(251,113,133,0.45)',
      glow: 'rgba(251,113,133,0.35)',
      frame: 'soft',
      motion: 'fade',
      ornaments: ['🌹'],
      defaultFont: 'romantic-script',
    },
  },
  {
    id: 'romantic-candlelight',
    category_id: 'romantic',
    name: 'Candlelight',
    tagline: 'Warm glow, floating hearts and soft music',
    price: 79,
    price_usd: 3,
    tier: 'plus',
    emoji: '🕯️',
    accent: '#f59e0b',
    gradient: 'from-amber-400 via-rose-400 to-fuchsia-500',
    animation: 'sparkles',
    tags: ['candle', 'date night', 'warm', 'love', 'romantic', 'glow'],
    design: {
      surface: ['#21120a', '#5c2b12', '#7c2d12'],
      ink: '#fff1e0',
      inkSoft: '#fdba74',
      border: 'rgba(245,158,11,0.5)',
      glow: 'rgba(245,158,11,0.4)',
      frame: 'elegant',
      motion: 'rise',
      ornaments: ['🕯️', '✨'],
      defaultFont: 'classic-serif',
    },
  },
  {
    id: 'romantic-forever-us',
    category_id: 'romantic',
    name: 'Forever Us',
    tagline: 'Your photo in a glowing heart frame',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '💞',
    accent: '#ec4899',
    gradient: 'from-pink-500 via-rose-500 to-purple-600',
    animation: 'petals',
    tags: ['couple', 'photo', 'anniversary', 'forever', 'romantic', 'valentine'],
    design: {
      surface: ['#4a0d33', '#831843', '#be185d'],
      ink: '#ffe9f5',
      inkSoft: '#f9a8d4',
      border: 'rgba(236,72,153,0.6)',
      glow: 'rgba(236,72,153,0.55)',
      frame: 'polaroid',
      motion: 'zoom',
      ornaments: ['💞', '🌸', '✨'],
      defaultFont: 'elegant-display',
    },
  },
  {
    id: 'romantic-eternal-love',
    category_id: 'romantic',
    name: 'Eternal Love',
    tagline: 'Cinematic particles, letter-by-letter reveal',
    price: 157,
    price_usd: 6,
    tier: 'elite',
    emoji: '💎',
    accent: '#a855f7',
    gradient: 'from-purple-600 via-fuchsia-500 to-rose-500',
    animation: 'fireworks',
    tags: ['proposal', 'propose', 'premium', 'cinematic', 'romantic', 'special'],
    design: {
      surface: ['#2e1065', '#6d28d9', '#be185d'],
      ink: '#f5ecff',
      inkSoft: '#d8b4fe',
      border: 'rgba(168,85,247,0.7)',
      glow: 'rgba(168,85,247,0.6)',
      frame: 'neon',
      motion: 'cinematic',
      ornaments: ['💎', '✨', '💫'],
      defaultFont: 'elegant-display',
    },
  },

  /* ============================ BIRTHDAY ============================ */
  {
    id: 'birthday-bash',
    category_id: 'birthday',
    name: 'Party Bash',
    tagline: 'Confetti burst with a big happy birthday',
    price: 47,
    price_usd: 2,
    tier: 'basic',
    emoji: '🎉',
    accent: '#38bdf8',
    gradient: 'from-sky-400 via-cyan-400 to-blue-500',
    animation: 'confetti',
    tags: ['birthday', 'bday', 'confetti', 'party', 'simple', 'wish'],
    design: {
      surface: ['#082f49', '#0e7490'],
      ink: '#e0f7ff',
      inkSoft: '#7dd3fc',
      border: 'rgba(56,189,248,0.45)',
      glow: 'rgba(56,189,248,0.35)',
      frame: 'soft',
      motion: 'fade',
      ornaments: ['🎉'],
      defaultFont: 'playful',
    },
  },
  {
    id: 'birthday-balloon-drop',
    category_id: 'birthday',
    name: 'Balloon Drop',
    tagline: 'Balloons float in while candles light up',
    price: 79,
    price_usd: 3,
    tier: 'plus',
    emoji: '🎈',
    accent: '#fb7185',
    gradient: 'from-red-400 via-orange-400 to-yellow-400',
    animation: 'confetti',
    tags: ['balloon', 'birthday', 'cake', 'candle', 'party'],
    design: {
      surface: ['#4c0519', '#9a3412', '#b45309'],
      ink: '#fff3e6',
      inkSoft: '#fdba74',
      border: 'rgba(251,146,60,0.55)',
      glow: 'rgba(251,146,60,0.45)',
      frame: 'polaroid',
      motion: 'rise',
      ornaments: ['🎈', '🎂'],
      defaultFont: 'playful',
    },
  },
  {
    id: 'birthday-golden-year',
    category_id: 'birthday',
    name: 'Golden Year',
    tagline: 'Gold shimmer, photo frame and birthday beat',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '🏆',
    accent: '#eab308',
    gradient: 'from-yellow-400 via-amber-500 to-orange-500',
    animation: 'sparkles',
    tags: ['golden', 'milestone', '18th', '21st', '50th', 'birthday', 'photo'],
    design: {
      surface: ['#3b2a05', '#a16207', '#f59e0b'],
      ink: '#fffbe8',
      inkSoft: '#fde68a',
      border: 'rgba(234,179,8,0.7)',
      glow: 'rgba(234,179,8,0.55)',
      frame: 'gold',
      motion: 'zoom',
      ornaments: ['🏆', '✨', '🎊'],
      defaultFont: 'modern-sans',
    },
  },
  {
    id: 'birthday-royal-celebration',
    category_id: 'birthday',
    name: 'Royal Celebration',
    tagline: 'Fireworks, gift reveals and a countdown',
    price: 157,
    price_usd: 6,
    tier: 'elite',
    emoji: '👑',
    accent: '#8b5cf6',
    gradient: 'from-violet-600 via-purple-500 to-pink-500',
    animation: 'fireworks',
    tags: ['royal', 'luxury', 'fireworks', 'birthday', 'premium', 'surprise'],
    design: {
      surface: ['#2e1065', '#7c3aed', '#db2777'],
      ink: '#f6f0ff',
      inkSoft: '#ddd6fe',
      border: 'rgba(139,92,246,0.7)',
      glow: 'rgba(139,92,246,0.6)',
      frame: 'neon',
      motion: 'cinematic',
      ornaments: ['👑', '🎆', '✨'],
      defaultFont: 'elegant-display',
    },
  },

  /* ====================== MARRIAGE & ANNIVERSARY ==================== */
  {
    id: 'marriage-sweet-vows',
    category_id: 'marriage',
    name: 'Sweet Vows',
    tagline: 'A simple, elegant wedding wish',
    price: 47,
    price_usd: 2,
    tier: 'basic',
    emoji: '💐',
    accent: '#f472b6',
    gradient: 'from-pink-300 via-rose-400 to-pink-500',
    animation: 'petals',
    tags: ['marriage', 'wedding', 'simple', 'vows', 'celebration'],
    design: {
      surface: ['#3f0d24', '#9d174d'],
      ink: '#ffe6f1',
      inkSoft: '#f9a8d4',
      border: 'rgba(244,114,182,0.5)',
      glow: 'rgba(244,114,182,0.35)',
      frame: 'soft',
      motion: 'fade',
      ornaments: ['💐'],
      defaultFont: 'classic-serif',
    },
  },
  {
    id: 'marriage-blessing-bells',
    category_id: 'marriage',
    name: 'Blessing Bells',
    tagline: 'Temple bells, petals and a blessing message',
    price: 79,
    price_usd: 3,
    tier: 'plus',
    emoji: '🔔',
    accent: '#f59e0b',
    gradient: 'from-amber-300 via-orange-400 to-rose-400',
    animation: 'petals',
    tags: ['blessing', 'wedding', 'marriage', 'temple', 'celebration'],
    design: {
      surface: ['#3b1d05', '#92400e', '#b45309'],
      ink: '#fff3e0',
      inkSoft: '#fcd34d',
      border: 'rgba(245,158,11,0.55)',
      glow: 'rgba(245,158,11,0.45)',
      frame: 'elegant',
      motion: 'rise',
      ornaments: ['🔔', '🪔'],
      defaultFont: 'classic-serif',
    },
  },
  {
    id: 'marriage-golden-anniversary',
    category_id: 'marriage',
    name: 'Golden Anniversary',
    tagline: 'Photo memories with a gold ribbon',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '🥂',
    accent: '#eab308',
    gradient: 'from-yellow-300 via-amber-400 to-rose-400',
    animation: 'sparkles',
    tags: ['anniversary', 'golden', 'photo', 'couple', 'years', 'marriage'],
    design: {
      surface: ['#3f2d04', '#a16207', '#fbbf24'],
      ink: '#fffdf0',
      inkSoft: '#fde68a',
      border: 'rgba(234,179,8,0.7)',
      glow: 'rgba(234,179,8,0.55)',
      frame: 'gold',
      motion: 'zoom',
      ornaments: ['🥂', '✨', '💫'],
      defaultFont: 'elegant-display',
    },
  },
  {
    id: 'marriage-royal-wedding',
    category_id: 'marriage',
    name: 'Royal Wedding',
    tagline: 'Cinematic invitation with animated florals',
    price: 157,
    price_usd: 6,
    tier: 'elite',
    emoji: '💍',
    accent: '#a855f7',
    gradient: 'from-purple-600 via-rose-500 to-amber-400',
    animation: 'fireworks',
    tags: ['wedding', 'invitation', 'royal', 'marriage', 'premium', 'bride', 'groom'],
    design: {
      surface: ['#2b0b4d', '#7e22ce', '#be185d'],
      ink: '#f7f0ff',
      inkSoft: '#e9d5ff',
      border: 'rgba(168,85,247,0.7)',
      glow: 'rgba(168,85,247,0.6)',
      frame: 'gold',
      motion: 'cinematic',
      ornaments: ['💍', '🌺', '✨'],
      defaultFont: 'elegant-display',
    },
  },

  /* ============================ FESTIVALS =========================== */
  {
    id: 'festival-diya-glow',
    category_id: 'festival',
    name: 'Diwali Lamp Glow',
    tagline: 'Glowing festival lamps with a warm wish',
    price: 47,
    price_usd: 2,
    tier: 'basic',
    emoji: '🪔',
    accent: '#f59e0b',
    gradient: 'from-amber-400 via-orange-500 to-red-500',
    animation: 'sparkles',
    tags: ['diwali', 'festival', 'deepavali', 'wish', 'simple', 'lights'],
    design: {
      surface: ['#3b1405', '#b45309'],
      ink: '#fff4e6',
      inkSoft: '#fdba74',
      border: 'rgba(245,158,11,0.5)',
      glow: 'rgba(245,158,11,0.45)',
      frame: 'soft',
      motion: 'fade',
      ornaments: ['🪔'],
      defaultFont: 'classic-serif',
    },
  },
  {
    id: 'festival-rang-barsay',
    category_id: 'festival',
    name: 'Holi Colour Splash',
    tagline: 'Holi colours splashing across the screen',
    price: 79,
    price_usd: 3,
    tier: 'plus',
    emoji: '🎨',
    accent: '#22d3ee',
    gradient: 'from-fuchsia-500 via-cyan-400 to-yellow-400',
    animation: 'confetti',
    tags: ['holi', 'colours', 'festival', 'celebration', 'spring'],
    design: {
      surface: ['#312e81', '#0891b2', '#7c3aed'],
      ink: '#f0fdff',
      inkSoft: '#a5f3fc',
      border: 'rgba(34,211,238,0.55)',
      glow: 'rgba(34,211,238,0.45)',
      frame: 'polaroid',
      motion: 'rise',
      ornaments: ['🎨', '💥'],
      defaultFont: 'playful',
    },
  },
  {
    id: 'festival-christmas-snow',
    category_id: 'festival',
    name: 'Christmas Snow',
    tagline: 'Falling snow, twinkling tree and carols',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '🎄',
    accent: '#10b981',
    gradient: 'from-emerald-400 via-teal-500 to-sky-500',
    animation: 'stars',
    tags: ['christmas', 'snow', 'xmas', 'festival', 'tree', 'santa'],
    design: {
      surface: ['#022c22', '#065f46', '#0f766e'],
      ink: '#ecfdf5',
      inkSoft: '#a7f3d0',
      border: 'rgba(16,185,129,0.6)',
      glow: 'rgba(16,185,129,0.5)',
      frame: 'elegant',
      motion: 'zoom',
      ornaments: ['🎄', '❄️', '✨'],
      defaultFont: 'classic-serif',
    },
  },
  {
    id: 'festival-new-year-countdown',
    category_id: 'festival',
    name: 'New Year Countdown',
    tagline: 'Live countdown and midnight fireworks',
    price: 157,
    price_usd: 6,
    tier: 'elite',
    emoji: '🎆',
    accent: '#8b5cf6',
    gradient: 'from-indigo-600 via-purple-500 to-pink-500',
    animation: 'fireworks',
    tags: ['new year', 'countdown', 'fireworks', 'festival', 'premium', 'midnight'],
    design: {
      surface: ['#1e1b4b', '#6d28d9', '#db2777'],
      ink: '#f5f3ff',
      inkSoft: '#c4b5fd',
      border: 'rgba(139,92,246,0.7)',
      glow: 'rgba(139,92,246,0.6)',
      frame: 'neon',
      motion: 'cinematic',
      ornaments: ['🎆', '🥂', '✨'],
      defaultFont: 'modern-sans',
    },
  },

  /* ====================== FUNCTIONS & EVENTS ======================== */
  {
    id: 'event-simple-congrats',
    category_id: 'event',
    name: 'Simple Congrats',
    tagline: 'Clean animated congratulations card',
    price: 47,
    price_usd: 2,
    tier: 'basic',
    emoji: '🎊',
    accent: '#38bdf8',
    gradient: 'from-sky-400 via-indigo-400 to-purple-500',
    animation: 'confetti',
    tags: ['congrats', 'congratulations', 'result', 'success', 'function', 'simple'],
    design: {
      surface: ['#0c2340', '#1d4ed8'],
      ink: '#e6f0ff',
      inkSoft: '#93c5fd',
      border: 'rgba(59,130,246,0.5)',
      glow: 'rgba(59,130,246,0.4)',
      frame: 'soft',
      motion: 'fade',
      ornaments: ['🎊'],
      defaultFont: 'modern-sans',
    },
  },
  {
    id: 'event-farewell-memories',
    category_id: 'event',
    name: 'Farewell Memories',
    tagline: 'Photo collage farewell for the last day',
    price: 79,
    price_usd: 3,
    tier: 'plus',
    emoji: '👋',
    accent: '#fb923c',
    gradient: 'from-orange-400 via-rose-400 to-purple-500',
    animation: 'petals',
    tags: ['farewell', 'goodbye', 'memories', 'school', 'college', 'office', 'event'],
    design: {
      surface: ['#3b1503', '#9a3412', '#7c2d12'],
      ink: '#fff1e6',
      inkSoft: '#fdba74',
      border: 'rgba(251,146,60,0.55)',
      glow: 'rgba(251,146,60,0.45)',
      frame: 'polaroid',
      motion: 'rise',
      ornaments: ['👋', '📸'],
      defaultFont: 'handwritten',
    },
  },
  {
    id: 'event-griha-pravesh',
    category_id: 'event',
    name: 'New Home Celebration',
    tagline: 'Housewarming wishes with a lit doorway',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '🏡',
    accent: '#f59e0b',
    gradient: 'from-amber-400 via-orange-500 to-emerald-500',
    animation: 'sparkles',
    tags: ['housewarming', 'new home', 'house warming', 'function', 'event', 'blessing'],
    design: {
      surface: ['#3b1d05', '#b45309', '#047857'],
      ink: '#fff7ed',
      inkSoft: '#fcd34d',
      border: 'rgba(245,158,11,0.65)',
      glow: 'rgba(245,158,11,0.5)',
      frame: 'elegant',
      motion: 'zoom',
      ornaments: ['🏡', '🪔', '✨'],
      defaultFont: 'classic-serif',
    },
  },
  {
    id: 'event-topper-spotlight',
    category_id: 'event',
    name: 'Spotlight Moment',
    tagline: 'Spotlight reveal for results and achievements',
    price: 157,
    price_usd: 6,
    tier: 'elite',
    emoji: '🌟',
    accent: '#a855f7',
    gradient: 'from-purple-600 via-amber-400 to-yellow-300',
    animation: 'fireworks',
    tags: ['achievement', 'topper', 'promotion', 'result', 'award', 'event', 'premium'],
    design: {
      surface: ['#2e1065', '#7c3aed', '#f59e0b'],
      ink: '#fffbeb',
      inkSoft: '#e9d5ff',
      border: 'rgba(168,85,247,0.7)',
      glow: 'rgba(168,85,247,0.6)',
      frame: 'gold',
      motion: 'cinematic',
      ornaments: ['🌟', '🏆', '✨'],
      defaultFont: 'modern-sans',
    },
  },

  /* ======================= FAMILY & FRIENDS ========================= */
  {
    id: 'family-thank-you',
    category_id: 'family',
    name: 'Thank You Note',
    tagline: 'A warm thank you with soft sparkles',
    price: 47,
    price_usd: 2,
    tier: 'basic',
    emoji: '🙏',
    accent: '#34d399',
    gradient: 'from-emerald-300 via-teal-400 to-cyan-500',
    animation: 'sparkles',
    tags: ['thank you', 'thanks', 'gratitude', 'family', 'friend', 'simple'],
    design: {
      surface: ['#022c22', '#047857'],
      ink: '#ecfdf5',
      inkSoft: '#6ee7b7',
      border: 'rgba(52,211,153,0.5)',
      glow: 'rgba(52,211,153,0.4)',
      frame: 'soft',
      motion: 'fade',
      ornaments: ['🙏'],
      defaultFont: 'modern-sans',
    },
  },
  {
    id: 'family-get-well-soon',
    category_id: 'family',
    name: 'Get Well Soon',
    tagline: 'Gentle healing wishes with floating flowers',
    price: 79,
    price_usd: 3,
    tier: 'plus',
    emoji: '🌼',
    accent: '#fbbf24',
    gradient: 'from-yellow-300 via-lime-400 to-emerald-400',
    animation: 'petals',
    tags: ['get well', 'health', 'recover', 'family', 'friend', 'wishes'],
    design: {
      surface: ['#26240a', '#3f6212', '#4d7c0f'],
      ink: '#fefce8',
      inkSoft: '#fde68a',
      border: 'rgba(250,204,21,0.5)',
      glow: 'rgba(250,204,21,0.4)',
      frame: 'elegant',
      motion: 'rise',
      ornaments: ['🌼', '🍃'],
      defaultFont: 'handwritten',
    },
  },
  {
    id: 'family-new-baby',
    category_id: 'family',
    name: 'New Baby Joy',
    tagline: 'Pastel welcome for the newest member',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '🍼',
    accent: '#60a5fa',
    gradient: 'from-sky-300 via-blue-400 to-purple-400',
    animation: 'stars',
    tags: ['new baby', 'baby shower', 'born', 'family', 'congrats'],
    design: {
      surface: ['#0c2a4d', '#1d4ed8', '#7c3aed'],
      ink: '#eff6ff',
      inkSoft: '#bfdbfe',
      border: 'rgba(96,165,250,0.6)',
      glow: 'rgba(96,165,250,0.5)',
      frame: 'polaroid',
      motion: 'zoom',
      ornaments: ['🍼', '🧸', '✨'],
      defaultFont: 'playful',
    },
  },
  {
    id: 'family-milestone-cheer',
    category_id: 'family',
    name: 'Milestone Cheer',
    tagline: 'Big cheers for a big milestone',
    price: 157,
    price_usd: 6,
    tier: 'elite',
    emoji: '🏅',
    accent: '#f472b6',
    gradient: 'from-rose-500 via-fuchsia-500 to-indigo-500',
    animation: 'fireworks',
    tags: ['milestone', 'achievement', 'family', 'friend', 'premium', 'special'],
    design: {
      surface: ['#4a0d33', '#be185d', '#4f46e5'],
      ink: '#fdf2f8',
      inkSoft: '#fbcfe8',
      border: 'rgba(244,114,182,0.7)',
      glow: 'rgba(244,114,182,0.6)',
      frame: 'neon',
      motion: 'cinematic',
      ornaments: ['🏅', '🎉', '✨'],
      defaultFont: 'elegant-display',
    },
  },

  /* ===================== LIGHT / ELEGANT EDITIONS ==================== */
  {
    id: 'birthday-blush-garden',
    category_id: 'birthday',
    name: 'Blush Garden',
    tagline: 'Airy florals and a soft ivory finish',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '🌸',
    accent: '#e8799f',
    gradient: 'from-rose-200 via-pink-300 to-rose-300',
    animation: 'petals',
    tags: ['birthday', 'floral', 'elegant', 'light', 'flowers', 'premium'],
    design: {
      surface: ['#fff8f4', '#ffe9e4', '#f6d9e3'],
      ink: '#5c3144',
      inkSoft: '#a1668a',
      border: 'rgba(232,121,159,0.55)',
      glow: 'rgba(232,121,159,0.32)',
      frame: 'elegant',
      motion: 'zoom',
      ornaments: ['🌸', '🌿'],
      defaultFont: 'elegant-display',
      mode: 'light',
    },
  },
  {
    id: 'marriage-ivory-invitation',
    category_id: 'marriage',
    name: 'Ivory Invitation',
    tagline: 'Refined cream stationery with gold accents',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '🤍',
    accent: '#c9a227',
    gradient: 'from-amber-100 via-yellow-200 to-amber-300',
    animation: 'sparkles',
    tags: ['wedding', 'invitation', 'elegant', 'light', 'ivory', 'marriage'],
    design: {
      surface: ['#fffdf7', '#f8f0df', '#eee1c9'],
      ink: '#4a3b22',
      inkSoft: '#a08c6a',
      border: 'rgba(201,162,39,0.55)',
      glow: 'rgba(201,162,39,0.35)',
      frame: 'gold',
      motion: 'cinematic',
      ornaments: ['💍', '🤍'],
      defaultFont: 'luxe-display',
      mode: 'light',
    },
  },

  /* ======================= NEW / SIGNATURE EDITIONS ================== */
  {
    id: 'event-aurora-nights',
    category_id: 'event',
    name: 'Aurora Nights',
    tagline: 'Northern-lights glow with cinematic starlight',
    price: 157,
    price_usd: 6,
    tier: 'elite',
    emoji: '🌌',
    accent: '#22d3ee',
    gradient: 'from-cyan-400 via-indigo-500 to-purple-600',
    animation: 'stars',
    tags: ['aurora', 'night', 'stars', 'premium', 'cinematic', 'event', 'celebration', 'magic', 'new'],
    design: {
      surface: ['#04101d', '#0b2a4a', '#3b1d7a'],
      ink: '#eaf7ff',
      inkSoft: '#a5d8ff',
      border: 'rgba(34,211,238,0.7)',
      glow: 'rgba(34,211,238,0.6)',
      frame: 'neon',
      motion: 'cinematic',
      ornaments: ['🌌', '✨', '💫'],
      defaultFont: 'elegant-display',
    },
  },
  {
    id: 'romantic-moonlit-vows',
    category_id: 'romantic',
    name: 'Moonlit Vows',
    tagline: 'Silver moonlight, soft roses and a slow reveal',
    price: 109,
    price_usd: 4,
    tier: 'premium',
    emoji: '🌙',
    accent: '#c4b5fd',
    gradient: 'from-indigo-300 via-purple-400 to-rose-400',
    animation: 'petals',
    tags: ['moon', 'night', 'romantic', 'premium', 'love', 'anniversary', 'roses', 'new'],
    design: {
      surface: ['#1b1633', '#3b2a63', '#7c3f74'],
      ink: '#f5f0ff',
      inkSoft: '#d8ccff',
      border: 'rgba(196,181,253,0.6)',
      glow: 'rgba(196,181,253,0.5)',
      frame: 'elegant',
      motion: 'zoom',
      ornaments: ['🌙', '🌹', '✨'],
      defaultFont: 'romantic-script',
    },
  },

];

/** Legacy cards stored only 'Birthday' / 'Valentine' throttle. */
const LEGACY_THEME_DESIGNS: Record<string, GreetingTheme['design']> = {
  Birthday: {
    surface: ['#082f49', '#0e7490', '#7c3aed'],
    ink: '#e0f7ff',
    inkSoft: '#7dd3fc',
    border: 'rgba(56,189,248,0.5)',
    glow: 'rgba(56,189,248,0.45)',
    frame: 'soft',
    motion: 'fade',
    ornaments: ['🎂', '🎉'],
    defaultFont: 'playful',
  },
  Valentine: {
    surface: ['#3b0a1f', '#9d174d'],
    ink: '#ffe4ef',
    inkSoft: '#f9a8c9',
    border: 'rgba(251,113,133,0.5)',
    glow: 'rgba(251,113,133,0.4)',
    frame: 'soft',
    motion: 'fade',
    ornaments: ['❤️'],
    defaultFont: 'romantic-script',
  },
};

export const TIER_LABELS: Record<GreetingTier, string> = {
  basic: 'Basic',
  plus: 'Plus',
  premium: 'Premium',
  elite: 'Elite',
};

/** Short marketing line that makes each tier feel distinct. */
export const TIER_TAGLINES: Record<GreetingTier, string> = {
  basic: 'Clean & charming',
  plus: 'Richer motion',
  premium: 'Photo-ready luxe',
  elite: 'Cinematic showcase',
};

/** Ornament density scales with the tier so elite themes feel lavish. */
export const TIER_ORNAMENT_COUNT: Record<GreetingTier, number> = {
  basic: 0,
  plus: 1,
  premium: 2,
  elite: 3,
};

/** Id of the single free welcome card (always sorted to the top of the list). */
export const FREE_THEME_ID = 'free-basic-wish';

/**
 * Puts the free welcome card first and keeps every other theme in its current
 * order. Applied everywhere themes are listed so the free card can never be
 * pushed down by admin patches, custom themes or catalog sync order.
 */
export const sortFreeThemeFirst = (themes: GreetingTheme[]): GreetingTheme[] => {
  const free = themes.filter((theme) => theme.id === FREE_THEME_ID);
  if (free.length === 0) return themes;
  return [...free, ...themes.filter((theme) => theme.id !== FREE_THEME_ID)];
};

export const getThemeById = (
  id: string,
  themes: GreetingTheme[] = greetingThemes,
): GreetingTheme | undefined => themes.find((theme) => theme.id === id);

export const getCategoryById = (id: string): GreetingThemeCategory | undefined =>
  greetingCategories.find((category) => category.id === id);

/** Resolves a theme id (or legacy id) into usable design tokens. */
export const getThemeDesign = (
  themeId: string,
  themes: GreetingTheme[] = greetingThemes,
): GreetingTheme['design'] => {
  const theme = getThemeById(themeId, themes);
  if (theme) return theme.design;
  return LEGACY_THEME_DESIGNS[themeId] ?? greetingThemes[0].design;
};

/**
 * Builds a full theme object for any stored id, including the legacy
 * 'Birthday' / 'Valentine' ids so old cards still render beautifully.
 */
export const resolveTheme = (
  themeId: string,
  themes: GreetingTheme[] = greetingThemes,
): GreetingTheme => {
  const found = getThemeById(themeId, themes);
  if (found) return found;

  const design = LEGACY_THEME_DESIGNS[themeId] ?? greetingThemes[0].design;
  const isValentine = themeId === 'Valentine';
  const isBirthday = themeId === 'Birthday';

  return {
    id: themeId,
    category_id: isValentine ? 'romantic' : 'birthday',
    name: isValentine ? 'Valentine' : isBirthday ? 'Birthday' : 'Greeting',
    tagline: 'A classic isZma card',
    price: 0,
    price_usd: 0,
    tier: 'basic',
    emoji: isValentine ? '💕' : '🎂',
    accent: design.surface[design.surface.length - 1],
    gradient: isValentine ? 'from-rose-400 via-pink-400 to-rose-500' : 'from-sky-400 via-cyan-400 to-blue-500',
    animation: isValentine ? 'hearts' : 'confetti',
    tags: [],
    design,
  };
};

export const getThemeOrnaments = (
  themeId: string,
  themes: GreetingTheme[] = greetingThemes,
): string[] => {
  const theme = getThemeById(themeId, themes);
  if (!theme) return LEGACY_THEME_DESIGNS[themeId]?.ornaments ?? [];
  // Ornament density scales with the tier; basics stay clean.
  return theme.design.ornaments.slice(0, TIER_ORNAMENT_COUNT[theme.tier]);
};

/** Same as {@link getThemeOrnaments} but works for any (incl. custom) theme object. */
export const getOrnamentsForTheme = (theme: GreetingTheme): string[] =>
  (theme.design?.ornaments ?? []).slice(0, TIER_ORNAMENT_COUNT[theme.tier] ?? 0);

/**
 * Free-text search across theme names, taglines, tiers, tags and their category.
 * Falls back to the built-in keyword list so related terms and synonyms work.
 */
export const searchThemes = (term: string): GreetingTheme[] => {
  const query = term.trim().toLowerCase();
  if (!query) return greetingThemes;

  return greetingThemes.filter((theme) => {
    const category = getCategoryById(theme.category_id);
    const haystack = [
      theme.name,
      theme.tagline,
      theme.tier,
      theme.emoji,
      ...theme.tags,
      category?.name ?? '',
      category?.description ?? '',
      ...(category?.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  });
};

/** The same search, but against a caller-supplied (dynamic) theme list. */
export const searchThemeList = (themes: GreetingTheme[], term: string): GreetingTheme[] => {
  const query = term.trim().toLowerCase();
  if (!query) return themes;

  return themes.filter((theme) => {
    const category = getCategoryById(theme.category_id);
    const haystack = [
      theme.name,
      theme.tagline,
      theme.tier,
      theme.emoji,
      ...(theme.tags ?? []),
      category?.name ?? '',
      category?.description ?? '',
      ...(category?.keywords ?? []),
    ]
      .join(' ')
      .toLowerCase();

    return haystack.includes(query);
  });
};

/* ------------------------------------------------------------------ */
/* Custom theme design helpers (used by the Admin Panel)               */
/* ------------------------------------------------------------------ */

/** Converts `#rgb` / `#rrggbb` to an `rgba()` string with the given alpha. */
export const hexToRgba = (hex: string, alpha: number): string => {
  const clean = (hex || '#8b5cf6').replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const int = parseInt(full.slice(0, 6) || '8b5cf6', 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/**
 * Base design tokens per tier. Custom themes (created in the Admin Panel) reuse
 * these so a hand-built theme still renders with the right richness for its tier.
 */
const TIER_DESIGN_PRESETS: Record<GreetingTier, Omit<GreetingThemeDesign, 'border' | 'glow'>> = {
  basic: {
    surface: ['#160b26', '#2a1546'],
    ink: '#f3ecff',
    inkSoft: '#c4b5fd',
    frame: 'soft',
    motion: 'fade',
    ornaments: ['✨'],
    defaultFont: 'modern-sans',
  },
  plus: {
    surface: ['#1b0f31', '#3b1d63', '#4c1d95'],
    ink: '#f6f0ff',
    inkSoft: '#c4b5fd',
    frame: 'elegant',
    motion: 'rise',
    ornaments: ['✨', '🌟'],
    defaultFont: 'classic-serif',
  },
  premium: {
    surface: ['#221046', '#5b21b6', '#9333ea'],
    ink: '#f9f5ff',
    inkSoft: '#ddd6fe',
    frame: 'polaroid',
    motion: 'zoom',
    ornaments: ['👑', '✨'],
    defaultFont: 'elegant-display',
  },
  elite: {
    surface: ['#1e1065', '#6d28d9', '#be185d'],
    ink: '#f5ecff',
    inkSoft: '#e9d5ff',
    frame: 'neon',
    motion: 'cinematic',
    ornaments: ['💎', '👑', '✨'],
    defaultFont: 'elegant-display',
  },
};

/** Builds complete design tokens for a custom theme from its tier + accent. */
export const buildDesignForTier = (
  tier: GreetingTier,
  accent: string,
): GreetingThemeDesign => ({
  ...TIER_DESIGN_PRESETS[tier],
  border: hexToRgba(accent, 0.6),
  glow: hexToRgba(accent, 0.45),
});

/** Tailwind gradient presets offered in the Admin Panel's theme editor. */
export const GRADIENT_PRESETS: { label: string; value: string }[] = [
  { label: 'Rose', value: 'from-rose-400 via-pink-400 to-rose-500' },
  { label: 'Amber Glow', value: 'from-amber-400 via-rose-400 to-fuchsia-500' },
  { label: 'Royal Purple', value: 'from-violet-600 via-purple-500 to-pink-500' },
  { label: 'Ocean', value: 'from-sky-400 via-cyan-400 to-blue-500' },
  { label: 'Gold', value: 'from-yellow-400 via-amber-500 to-orange-500' },
  { label: 'Emerald', value: 'from-emerald-400 via-teal-500 to-cyan-500' },
  { label: 'Sunset', value: 'from-orange-400 via-rose-400 to-purple-500' },
  { label: 'Ice', value: 'from-slate-300 via-sky-400 to-indigo-500' },
];

/** Animation choices offered in the Admin Panel's theme editor. */
export const ANIMATION_OPTIONS: GreetingTheme['animation'][] = [
  'confetti',
  'hearts',
  'petals',
  'sparkles',
  'fireworks',
  'stars',
];

export const TIER_OPTIONS: GreetingTier[] = ['basic', 'plus', 'premium', 'elite'];
