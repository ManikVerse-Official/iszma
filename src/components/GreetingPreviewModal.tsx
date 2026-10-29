import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Eye, Lock, Sparkles, ArrowRight, ShieldCheck, Volume2, VolumeX } from 'lucide-react';
import { GreetingTheme } from '../types';
import { GreetingCardVisual } from './GreetingCardVisual';
import { TIER_LABELS, TIER_TAGLINES } from '../data/greetingThemes';
import { getFontById } from '../data/fonts';

interface GreetingPreviewModalProps {
  theme: GreetingTheme;
  isOpen: boolean;
  onClose: () => void;
  senderName: string;
  receiverName: string;
  message: string;
  fontId: string;
  imageUrl?: string;
  /** Optional sender override for the title/heading colour (hex). */
  titleColor?: string;
  /** Optional sender override for the message/body colour (hex). */
  messageColor?: string;
  /** Optional sender override for the signature/sign-off colour (hex). */
  signatureColor?: string;
  /** Optional sender override for the primary text colour (hex). */
  textColor?: string;
  /** Optional sender override for the card background gradient start (hex). */
  bgGradientStart?: string;
  /** Optional sender override for the card background gradient end (hex). */
  bgGradientEnd?: string;
  /** Optional sender override for the background gradient angle (degrees). */
  bgGradientAngle?: number;
  /** Optional sender-authored heading replacing the occasion headline. */
  title?: string;
  /** Optional sender-authored eyebrow label. */
  eyebrow?: string;
  /** Optional sender-authored sign-off. */
  signoff?: string;
  /**
   * Background music to audition in the preview — the uploaded MP3 (Premium /
   * Elite) or the selected stock track. Opening the preview is a user gesture,
   * so playback starts automatically where the browser allows it; the speaker
   * button is always available as the fallback/toggle.
   */
  audioTrack?: string;
  /** CTA label, e.g. "Publish & get link · <price in the visitor's currency>". */
  ctaLabel: string;
  /** Kicks off payment (or admin free generation). No card exists yet. */
  onPublish: () => void;
  isAdmin?: boolean;
  watermarkName?: string;
}

/**
 * The "Preview-First" experience.
 *
 * Anyone can see exactly how their card will look — theme, typography, framed
 * photo and watermark — before spending a rupee. Crucially this component never
 * receives or renders a card id or URL: the shareable link is minted by the
 * server only after payment settles in ThemeOrderModal.
 */
export const GreetingPreviewModal: React.FC<GreetingPreviewModalProps> = ({
  theme,
  isOpen,
  onClose,
  senderName,
  receiverName,
  message,
  fontId,
  imageUrl,
  titleColor,
  messageColor,
  signatureColor,
  textColor,
  bgGradientStart,
  bgGradientEnd,
  bgGradientAngle,
  title,
  eyebrow,
  signoff,
  audioTrack,
  ctaLabel,
  onPublish,
  isAdmin = false,
  watermarkName = 'isZma',
}) => {
  const font = getFontById(fontId);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [musicOn, setMusicOn] = useState(false);

  // Start the music when the preview opens and stop it on close/unmount.
  useEffect(() => {
    if (!isOpen || !audioTrack) {
      audioRef.current?.pause();
      audioRef.current = null;
      setMusicOn(false);
      return;
    }

    const audio = new Audio(audioTrack);
    audio.loop = true;
    audio.volume = 0.7;
    audioRef.current = audio;
    audio
      .play()
      .then(() => setMusicOn(true))
      .catch(() => setMusicOn(false));

    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, [isOpen, audioTrack]);

  const toggleMusic = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio
        .play()
        .then(() => setMusicOn(true))
        .catch(() => setMusicOn(false));
    } else {
      audio.pause();
      setMusicOn(false);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="fixed inset-0 z-[70] flex flex-col bg-black/90 backdrop-blur-md"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          {/* Top bar */}
          <div className="flex items-center justify-between gap-4 px-4 sm:px-8 py-4 border-b border-white/10">
            <div className="flex items-center gap-3 min-w-0">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 text-[11px] font-semibold uppercase tracking-wider px-3 py-1">
                <Eye className="w-3 h-3" />
                Free live preview
              </span>
              <span className="hidden sm:block text-sm text-gray-400 truncate">
                {theme.emoji} {theme.name} · {TIER_LABELS[theme.tier]} · {font.label}
              </span>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              {audioTrack && (
                <button
                  type="button"
                  onClick={toggleMusic}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-gray-200 hover:bg-white/10 transition-colors"
                  aria-label={musicOn ? 'Pause preview music' : 'Play preview music'}
                >
                  {musicOn ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                  <span className="hidden sm:inline">{musicOn ? 'Music on' : 'Music off'}</span>
                </button>
              )}
              <button
                onClick={onClose}
                className="text-gray-400 hover:text-white transition-colors"
                aria-label="Close preview"
              >
                <X className="w-6 h-6" />
              </button>
            </div>
          </div>

          {/* Card */}
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-2xl mx-auto px-4 sm:px-8 py-8 sm:py-12">
              <motion.div
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: 'easeOut' }}
              >
                <GreetingCardVisual
                  theme={theme}
                  senderName={senderName}
                  receiverName={receiverName}
                  message={message}
                  imageUrl={imageUrl}
                  fontId={fontId}
                  titleColor={titleColor}
                  messageColor={messageColor}
                  signatureColor={signatureColor}
                  textColor={textColor}
                  bgGradientStart={bgGradientStart}
                  bgGradientEnd={bgGradientEnd}
                  bgGradientAngle={bgGradientAngle}
                  title={title}
                  eyebrow={eyebrow}
                  signoff={signoff}
                  watermarkName={watermarkName}
                />
              </motion.div>
            </div>
          </div>

          {/* Publish bar — the link itself is minted only after payment */}
          <div className="border-t border-white/10 bg-[#0b0514]/95 px-4 sm:px-8 py-4">
            <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-center gap-4">
              <div className="flex items-start gap-2 text-xs text-gray-400 flex-1 text-center sm:text-left">
                <Lock className="w-4 h-4 text-yellow-300 shrink-0 mt-0.5" />
                <span>
                  Your card isn’t live yet. The 48-hour shareable link is created
                  <span className="text-gray-200 font-semibold"> only after payment succeeds</span>.
                  {isAdmin && ' As an admin this card stays free.'}
                </span>
              </div>

              <div className="flex items-center gap-3 w-full sm:w-auto">
                <button
                  onClick={onClose}
                  className="flex-1 sm:flex-none px-5 py-3 rounded-xl border border-gray-700 text-gray-300 font-semibold hover:border-gray-500 hover:text-white transition-all"
                >
                  Keep editing
                </button>
                <button onClick={onPublish} className="flex-1 sm:flex-none group relative">
                  <div className="absolute inset-0 bg-gradient-to-r from-neon-purple via-purple-500 to-neon-purple rounded-xl blur opacity-60 group-hover:opacity-100 transition duration-300" />
                  <div className="relative flex items-center justify-center gap-2 bg-bg-dark-end border border-neon-purple rounded-xl px-6 py-3 font-bold text-white transition-all duration-300 whitespace-nowrap">
                    {isAdmin ? <Sparkles className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
                    {ctaLabel}
                    <ArrowRight className="w-4 h-4" />
                  </div>
                </button>
              </div>
            </div>
            <p className="max-w-3xl mx-auto mt-3 text-[11px] text-gray-600 text-center sm:text-left">
              {TIER_TAGLINES[theme.tier]} · {theme.tagline}
            </p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};
