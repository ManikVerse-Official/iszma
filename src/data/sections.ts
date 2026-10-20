import { MallSection } from '../types';

/**
 * Sections of the digital mall.
 * Only `greetings` is stocked right now - the rest render as "coming soon".
 */
export const mallSections: MallSection[] = [
  {
    id: 'greetings',
    name: 'Digital Greetings',
    emoji: '💌',
    tagline: 'Animated cards that live for 48 hours',
    accent: '#ec4899',
    gradient: 'from-pink-500 via-fuchsia-500 to-neon-purple',
    available: true,
  },
  {
    id: 'reportcard-studio',
    name: 'ReportCard Studio',
    emoji: '📊',
    tagline: 'Generate holistic & academic student report cards from Excel',
    accent: '#ec4899', // Dark Pink / Fuchsia
    gradient: 'from-pink-600 via-fuchsia-600 to-rose-700',
    available: true,
  },
  {
    id: 'game-zone',
    name: 'Game Zone',
    emoji: '🎮',
    tagline: 'Pair-3Balls — play vs computer, a private room, or a random player',
    accent: '#8b5cf6',
    gradient: 'from-violet-600 via-purple-600 to-fuchsia-600',
    available: true,
  },
  {
    id: 'tech-ai',
    name: 'Tech & AI',
    emoji: '🤖',
    tagline: 'AutoCAD scripts, wiring assistants, automation',
    accent: '#8b5cf6',
    gradient: 'from-violet-500 via-purple-500 to-indigo-500',
    available: false,
  },
  {
    id: 'education',
    name: 'Education',
    emoji: '📚',
    tagline: 'Notes, sample papers, question banks',
    accent: '#06b6d4',
    gradient: 'from-cyan-500 via-sky-500 to-blue-500',
    available: false,
  },
  {
    id: 'originals',
    name: 'Originals',
    emoji: '✨',
    tagline: 'Premium artwork, wallpapers, print on demand',
    accent: '#f59e0b',
    gradient: 'from-amber-400 via-orange-500 to-rose-500',
    available: false,
  },
  {
    id: 'ui-themes',
    name: 'UI Themes & Scripts',
    emoji: '🎨',
    tagline: 'Figma kits, web layouts, mockups',
    accent: '#ec4899',
    gradient: 'from-pink-500 via-rose-500 to-purple-500',
    available: false,
  },
  {
    id: 'fx-studios',
    name: 'FX / Studios',
    emoji: '🎬',
    tagline: 'Video effects, transitions, premiere packs',
    accent: '#10b981',
    gradient: 'from-emerald-400 via-teal-500 to-cyan-500',
    available: false,
  },
  {
    id: 'comics',
    name: 'Comics',
    emoji: '📖',
    tagline: 'Graphic novels and ongoing series',
    accent: '#ef4444',
    gradient: 'from-red-500 via-rose-500 to-orange-500',
    available: false,
  },
];

export const getSectionById = (id: string): MallSection | undefined =>
  mallSections.find((section) => section.id === id);
