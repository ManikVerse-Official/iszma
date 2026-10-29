import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Volume2, VolumeX, MousePointerClick } from 'lucide-react';
import confetti from 'canvas-confetti';
import { GreetingCard, GreetingTheme } from '../types';
import { useBrand } from '../context/BrandContext';
import { resolveTheme, getOrnamentsForTheme } from '../data/greetingThemes';
import { GreetingCardVisual } from './GreetingCardVisual';
import { getGreetingCard, isCardExpired } from '../services/greetingService';
import { DEFAULT_AUDIO_TRACKS } from '../data/audio';
import { useCatalog } from '../context/CatalogContext';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';

const FLOATERS: Record<GreetingTheme['animation'], string[]> = {
  confetti: ['🎉', '🎊', '🎈', '✨', '🎁'],
  hearts: ['❤️', '💕', '💖', '🌹', '💗'],
  petals: ['🌸', '🌺', '🌹', '🍃', '💐'],
  sparkles: ['✨', '💫', '⭐', '🌟', '🔔'],
  fireworks: ['🎆', '🎇', '✨', '💥', '🌟'],
  stars: ['⭐', '🌟', '❄️', '✨', '🌠'],
};

interface GreetingViewerProps {
  /** Used when the app is served from a card subdomain (e.g. abc123.domain.com). */
  cardId?: string;
}

export const GreetingViewer: React.FC<GreetingViewerProps> = ({ cardId }) => {
  const params = useParams<{ id: string }>();
  const id = cardId ?? params.id;

  const [card, setCard] = useState<GreetingCard | null>(null);
  const [loading, setLoading] = useState(true);
  // The card (and its audio) stays sealed behind the envelope until the
  // receiver taps it. Nothing is fetched or rendered before that point.
  const [opened, setOpened] = useState(false);
  // True while the cover plays its opening animation (before the card shows).
  const [opening, setOpening] = useState(false);
  const [muted, setMuted] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const openTimer = useRef<number | null>(null);
  const { brand } = useBrand();
  const { themes } = useCatalog();

  usePageMeta({
    title: pageTitle('A greeting card for you'),
    description: 'Someone sent you a private isZma greeting card.',
    path: `/greet/${id ?? 'private'}`,
    noindex: true,
  });

  const reducedMotion = useMemo(() => {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }, []);

  // Privacy: a shared card must never be indexed by search engines. The tag is
  // injected while this view is mounted and removed on unmount.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex, nofollow';
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);

  // Tear down any playing audio (and any pending open timeout) on unmount.
  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
      if (openTimer.current) window.clearTimeout(openTimer.current);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const fetchCard = async () => {
      if (!id) {
        setLoading(false);
        return;
      }

      const data = await getGreetingCard(id);
      if (cancelled) return;

      if (!data || isCardExpired(data)) {
        setCard(null);
      } else {
        setCard(data);
      }
      setLoading(false);
    };

    setOpened(false);
    setOpening(false);
    if (openTimer.current) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    fetchCard();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Expiry stays enforced in the background while the page is open, but the
  // receiver never sees a mechanical countdown — the card simply closes itself.
  useEffect(() => {
    if (!card) return;
    const interval = setInterval(() => {
      if (isCardExpired(card, new Date())) setCard(null);
    }, 60_000);
    return () => clearInterval(interval);
  }, [card]);

  const theme = card ? resolveTheme(card.theme, themes) : null;
  const design = theme?.design ?? null;
  const animation = theme?.animation ?? 'confetti';

  /**
   * Opened by the envelope tap — the user gesture that lets the browser start
   * audio. The Audio object is created ONLY here (preload="none"), so no audio
   * bytes are ever requested on initial page load.
   */
  const openCard = () => {
    if (opening) return;
    setOpening(true);

    // Start audio inside the user gesture (mobile browsers require it). The
    // Audio object is created ONLY here, so nothing preloads before the tap.
    const track = card?.audio_track;
    if (track) {
      try {
        const audio = new Audio(track);
        audio.preload = 'none';
        audio.loop = true;
        audio.muted = muted;
        audioRef.current = audio;
        // If a category file is not uploaded yet, fall back to the shipped
        // default track so the card is never silent.
        audio.onerror = () => {
          if (!audio.src.endsWith(DEFAULT_AUDIO_TRACKS)) {
            audio.src = DEFAULT_AUDIO_TRACKS;
            void audio.play().catch(() => {});
          }
        };
        void audio.play().catch(() => {
          /* Autoplay can still be blocked — the card opens silently regardless. */
        });
      } catch {
        /* Audio unsupported: the card opens without music. */
      }
    }

    // Let the cover animation play, then reveal the card and its effects.
    openTimer.current = window.setTimeout(() => setOpened(true), reducedMotion ? 0 : 620);
  };

  const toggleSound = () => {
    setMuted((prev) => {
      const next = !prev;
      if (audioRef.current) audioRef.current.muted = next;
      return next;
    });
  };

  // Celebration burst — fires once the card is actually opened, for EVERY
  // theme (tinted to the card's own colours) so opening always feels special.
  useEffect(() => {
    if (!card || !opened || reducedMotion) return;

    const colors = [theme?.accent, design?.ink].filter(Boolean) as string[];
    const duration = 2500;
    const animationEnd = Date.now() + duration;
    const defaults = {
      startVelocity: 30,
      spread: 360,
      ticks: 60,
      zIndex: 0,
      ...(colors.length ? { colors } : {}),
    };
    const randomInRange = (min: number, max: number) => Math.random() * (max - min) + min;

    const interval = setInterval(() => {
      const timeLeft = animationEnd - Date.now();
      if (timeLeft <= 0) {
        clearInterval(interval);
        return;
      }
      const particleCount = 50 * (timeLeft / duration);
      confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.1, 0.3), y: Math.random() - 0.2 } });
      confetti({ ...defaults, particleCount, origin: { x: randomInRange(0.7, 0.9), y: Math.random() - 0.2 } });
    }, 400);

    return () => clearInterval(interval);
  }, [card, opened, reducedMotion, theme?.accent, design?.ink]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end flex items-center justify-center">
        <div className="animate-spin w-12 h-12 border-4 border-neon-purple border-t-transparent rounded-full mx-auto" />
      </div>
    );
  }

  if (!card || !theme || !design) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end flex items-center justify-center p-4">
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          className="max-w-lg text-center"
        >
          <div className="text-6xl mb-6">⏳</div>
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-4">
            This special moment has passed
          </h1>
          <p className="text-gray-400 mb-8">
            Every greeting card stays live for just 48 hours, then it is automatically
            removed — so every moment stays fresh and special.
          </p>
          <Link to="/" className="group relative inline-block">
            <div className="absolute inset-0 bg-gradient-to-r from-neon-purple via-purple-500 to-neon-purple rounded-xl blur opacity-50 group-hover:opacity-100 transition duration-300" />
            <div className="relative bg-bg-dark-end border border-neon-purple rounded-xl px-8 py-4 font-semibold text-white transition-all duration-300">
              Create Your Own Card
            </div>
          </Link>
        </motion.div>
      </div>
    );
  }

  const hasAudio = Boolean(card.audio_track);
  const ornaments = getOrnamentsForTheme(theme);

  // ---- Cover: every card arrives sealed. It only opens on the receiver's tap. ----
  if (!opened) {
    const coverSurface = `linear-gradient(150deg, ${design.surface.join(', ')})`;
    const flapSurface = `linear-gradient(160deg, ${
      design.surface[design.surface.length - 1]
    }, ${design.surface[0]})`;

    return (
      <div
        className="min-h-screen relative overflow-hidden flex items-center justify-center p-5 sm:p-8"
        style={{
          background: `radial-gradient(120% 90% at 50% 0%, ${design.glow} 0%, #08040f 55%, #05030a 100%)`,
        }}
      >
        <div className="relative flex flex-col items-center gap-7 sm:gap-9 text-center">
          <motion.button
            type="button"
            onClick={openCard}
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            whileHover={opening ? undefined : { y: -4, scale: 1.02 }}
            whileTap={opening ? undefined : { scale: 0.98 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="group relative [perspective:1400px] focus:outline-none"
            aria-label="Tap to open your greeting card"
          >
            <span
              aria-hidden
              className="absolute -inset-14 rounded-full blur-3xl opacity-40 group-hover:opacity-80 transition-opacity duration-500"
              style={{ background: design.glow }}
            />

            <motion.div
              className="relative w-[min(84vw,360px)] aspect-[4/3]"
              style={{ transformStyle: 'preserve-3d' }}
              animate={
                opening
                  ? { rotateX: -18, scale: 1.08, opacity: 0, y: -10 }
                  : { rotateX: 0, scale: 1, opacity: 1, y: 0 }
              }
              transition={{ duration: opening ? 0.62 : 0.45, ease: 'easeInOut' }}
            >
              {/* Envelope body */}
              <div
                className="absolute inset-0 rounded-2xl overflow-hidden border"
                style={{
                  background: coverSurface,
                  borderColor: design.border,
                  boxShadow: `0 30px 80px ${design.glow}, inset 0 1px 0 rgba(255,255,255,0.16)`,
                }}
              >
                <div
                  aria-hidden
                  className="absolute -top-16 -right-10 w-48 h-48 rounded-full blur-3xl opacity-50"
                  style={{ background: design.glow }}
                />
                {/* Envelope fold lines (V shape) */}
                <svg
                  aria-hidden
                  className="absolute inset-0 w-full h-full"
                  viewBox="0 0 100 75"
                  preserveAspectRatio="none"
                >
                  <path
                    d="M0 0 L50 44 L100 0"
                    fill="none"
                    stroke={design.ink}
                    strokeOpacity="0.25"
                    strokeWidth="0.7"
                  />
                  <path
                    d="M0 75 L50 32 L100 75"
                    fill="none"
                    stroke={design.ink}
                    strokeOpacity="0.15"
                    strokeWidth="0.7"
                  />
                </svg>
                {/* Shine sweep on hover */}
                <span
                  aria-hidden
                  className="pointer-events-none absolute -inset-y-8 -left-1/3 w-1/3 rotate-12 opacity-0 group-hover:opacity-60 group-hover:translate-x-[380%] transition-all duration-700"
                  style={{
                    background: `linear-gradient(90deg, transparent, ${design.ink}33, transparent)`,
                  }}
                />
                {/* Wax seal */}
                <div
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-14 h-14 sm:w-16 sm:h-16 rounded-full border-2 text-2xl"
                  style={{
                    background: `radial-gradient(circle at 35% 30%, ${design.ink}22, rgba(0,0,0,0.35))`,
                    borderColor: design.border,
                    color: design.ink,
                    boxShadow: `0 0 26px ${design.glow}`,
                  }}
                >
                  <span className="drop-shadow">{theme.emoji}</span>
                </div>
              </div>

              {/* Top flap — lifts open on tap */}
              <motion.div
                aria-hidden
                className="absolute left-0 right-0 top-0 h-[56%] origin-top"
                style={{ transformStyle: 'preserve-3d', backfaceVisibility: 'hidden' }}
                animate={{ rotateX: opening ? -168 : 0 }}
                transition={{ duration: opening ? 0.6 : 0.3, ease: 'easeInOut' }}
              >
                <div
                  className="w-full h-full"
                  style={{
                    clipPath: 'polygon(0 0, 100% 0, 50% 100%)',
                    background: flapSurface,
                    filter: `drop-shadow(0 10px 18px ${design.glow})`,
                    opacity: 0.96,
                  }}
                />
              </motion.div>

              {/* "Click me" cue sitting on the cover */}
              <span
                className="absolute bottom-3 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider whitespace-nowrap shadow-lg transition-transform duration-300 group-hover:-translate-y-0.5"
                style={{ background: design.ink, color: '#120a1f' }}
              >
                <MousePointerClick className="w-3.5 h-3.5" />
                Tap to open
              </span>
            </motion.div>
          </motion.button>

          <div className="relative space-y-2 max-w-sm">
            <motion.h1
              className="text-2xl sm:text-3xl font-black text-white"
              animate={reducedMotion ? undefined : { opacity: [0.85, 1, 0.85] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
            >
              You've got a card 💌
            </motion.h1>
            <p className="text-sm sm:text-base text-gray-300">
              {card.receiver_name
                ? `${card.receiver_name}, tap the envelope to open`
                : 'Tap the envelope to open'}
            </p>
            {hasAudio && (
              <span
                className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-[11px] font-semibold uppercase tracking-wider"
                style={{ borderColor: design.border, color: design.inkSoft }}
              >
                <Volume2 className="w-3.5 h-3.5" />
                Opens with music
              </span>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen relative overflow-hidden"
      style={{
        // Use the theme glow (not its surface) so light cards still sit on a
        // dark, gallery-like backdrop.
        background: `radial-gradient(120% 90% at 50% 0%, ${design.glow} 0%, #08040f 55%, #05030a 100%)`,
      }}
    >
      {/* Sound toggle — only when the card actually has audio. */}
      {hasAudio && (
        <button
          type="button"
          onClick={toggleSound}
          className="fixed top-4 right-4 z-30 inline-flex items-center justify-center w-11 h-11 rounded-full bg-black/40 backdrop-blur-sm border border-white/15 text-white hover:bg-black/60 transition-colors"
          aria-label={muted ? 'Unmute music' : 'Mute music'}
        >
          {muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
        </button>
      )}

      {/* Theme-aware floating elements. Kept lean (and off for reduced motion)
          so the celebration never costs frame rate on low-end phones. */}
      {!reducedMotion && (
        <div className="absolute inset-0 pointer-events-none">
          {[...Array(animation === 'hearts' ? 14 : 10)].map((_, i) => (
            <motion.div
              key={i}
              className="absolute text-3xl"
              initial={{
                x: Math.random() * window.innerWidth,
                y: -100,
                rotate: Math.random() * 360,
              }}
              animate={{
                y: window.innerHeight + 100,
                rotate: Math.random() * 360,
              }}
              transition={{
                duration: Math.random() * 10 + 12,
                repeat: Infinity,
                delay: Math.random() * 10,
              }}
            >
              {FLOATERS[animation][Math.floor(Math.random() * FLOATERS[animation].length)]}
            </motion.div>
          ))}
        </div>
      )}

      <div className="relative z-10 min-h-screen flex flex-col items-center justify-center p-4 py-10">
        {/* Download prevention: the card (and especially the uploaded photo) is
            select-proof, drag-proof and right-click-proof for the receiver. */}
        <div
          className="w-full max-w-2xl select-none [&_img]:pointer-events-none [&_img]:select-none"
          style={{
            WebkitTouchCallout: 'none',
            WebkitUserSelect: 'none',
            userSelect: 'none',
          }}
          onContextMenu={(event) => event.preventDefault()}
          onDragStart={(event) => event.preventDefault()}
          onTouchStart={(event) => {
            if ((event.target as HTMLElement | null)?.tagName === 'IMG') event.preventDefault();
          }}
        >
          <GreetingCardVisual
            theme={theme}
            senderName={card.sender_name}
            receiverName={card.receiver_name}
            message={card.message}
            imageUrl={card.external_image_url || undefined}
            fontId={card.font}
            titleColor={card.title_color}
            messageColor={card.message_color}
            signatureColor={card.signature_color}
            textColor={card.text_color}
            bgGradientStart={card.background_color_start}
            bgGradientEnd={card.background_color_end}
            bgGradientAngle={card.background_gradient_angle}
            title={card.title}
            eyebrow={card.eyebrow}
            signoff={card.signoff}
            watermarkName={brand.site_name}
            watermarkHref="/"
          />
        </div>

        {ornaments.length > 0 && (
          <div className="mt-4 flex items-center gap-2 text-2xl opacity-70" aria-hidden>
            {ornaments.map((emoji, index) => (
              <span key={`${emoji}-${index}`}>{emoji}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
