import { motion, Variants } from 'framer-motion';
import { GreetingTheme } from '../types';
import { getOrnamentsForTheme } from '../data/greetingThemes';
import { getFontById } from '../data/fonts';
import { PhotoFrame } from './PhotoFrame';
import { CategoryEffects } from './CategoryEffects';
import { SmartImage } from './SmartImage';

interface GreetingCardVisualProps {
  theme: GreetingTheme;
  senderName: string;
  receiverName: string;
  message: string;
  imageUrl?: string;
  fontId?: string;
  /** Brand shown in the permanent "Created with ✨" watermark. */
  watermarkName?: string;
  /** When set, the watermark links here (e.g. "/"). Left unset in previews. */
  watermarkHref?: string;
  /** Compact = in-form live preview (smaller type, no sweep). */
  compact?: boolean;
  /** Disable entrance animation (e.g. static thumbnails). */
  animate?: boolean;
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
  /** Optional sender-authored eyebrow label shown above the heading. */
  eyebrow?: string;
  /** Optional sender-authored sign-off replacing "With love,". */
  signoff?: string;
}

/** Occasion flavour per theme category — makes every genre feel designed. */
const CATEGORY_STYLES: Record<string, { eyebrow: string; headline: string; motif: string }> = {
  romantic: { eyebrow: 'A LOVE NOTE', headline: 'With All My Love', motif: '❦' },
  birthday: { eyebrow: 'A LITTLE SOMETHING FOR YOU', headline: 'Happy Birthday', motif: '✦' },
  marriage: { eyebrow: 'CELEBRATING YOU', headline: 'Best Wishes', motif: '❦' },
  festival: { eyebrow: 'FESTIVE WISHES', headline: 'Happy Celebrations', motif: '✧' },
  event: { eyebrow: 'CHEERS TO YOU', headline: 'Congratulations', motif: '✦' },
  family: { eyebrow: 'A NOTE FOR YOU', headline: 'Thinking of You', motif: '❦' },
};

const DEFAULT_STYLE = { eyebrow: 'A SPECIAL MESSAGE', headline: 'With Warmth', motif: '✦' };

/**
 * Genre-specific decorative motifs. These are what make a card feel illustrated
 * (balloons for birthdays, florals for weddings, diyas for festivals) instead of
 * looking like a plain template.
 */
const DECOR: Record<string, { emoji: string; className: string }[]> = {
  birthday: [
    { emoji: '🎈', className: 'top-16 left-4 text-3xl sm:text-4xl' },
    { emoji: '🎈', className: 'top-24 right-6 text-2xl sm:text-3xl' },
    { emoji: '🎂', className: 'bottom-24 right-5 text-2xl sm:text-3xl' },
    { emoji: '🎉', className: 'bottom-16 left-6 text-2xl sm:text-3xl' },
  ],
  romantic: [
    { emoji: '🌹', className: 'top-16 left-5 text-2xl sm:text-3xl' },
    { emoji: '💞', className: 'top-24 right-6 text-2xl sm:text-3xl' },
    { emoji: '💌', className: 'bottom-24 right-6 text-xl sm:text-2xl' },
    { emoji: '❤️', className: 'bottom-16 left-6 text-xl sm:text-2xl' },
  ],
  marriage: [
    { emoji: '🌸', className: 'top-14 left-4 text-3xl sm:text-4xl' },
    { emoji: '🌿', className: 'top-20 right-5 text-2xl sm:text-3xl' },
    { emoji: '💍', className: 'bottom-24 right-5 text-2xl sm:text-3xl' },
    { emoji: '🌺', className: 'bottom-16 left-5 text-2xl sm:text-3xl' },
  ],
  festival: [
    { emoji: '🪔', className: 'top-16 left-5 text-2xl sm:text-3xl' },
    { emoji: '🏮', className: 'top-14 right-6 text-2xl sm:text-3xl' },
    { emoji: '✨', className: 'bottom-20 left-6 text-xl sm:text-2xl' },
    { emoji: '🎆', className: 'bottom-24 right-6 text-xl sm:text-2xl' },
  ],
  event: [
    { emoji: '🎊', className: 'top-16 left-5 text-2xl sm:text-3xl' },
    { emoji: '⭐', className: 'top-20 right-6 text-xl sm:text-2xl' },
    { emoji: '🏆', className: 'bottom-24 right-5 text-2xl sm:text-3xl' },
    { emoji: '✨', className: 'bottom-16 left-6 text-xl sm:text-2xl' },
  ],
  family: [
    { emoji: '🌼', className: 'top-16 left-5 text-2xl sm:text-3xl' },
    { emoji: '🍃', className: 'top-20 right-6 text-xl sm:text-2xl' },
    { emoji: '🫶', className: 'bottom-24 right-5 text-2xl sm:text-3xl' },
    { emoji: '🌿', className: 'bottom-16 left-6 text-2xl sm:text-3xl' },
  ],
};

const BUNTING_CATEGORIES = new Set(['birthday', 'festival', 'event']);

/** Bunting + motif emojis, drawn behind the card content. */
const OccasionDecor: React.FC<{ categoryId: string; accent: string; ink: string }> = ({
  categoryId,
  accent,
  ink,
}) => {
  const decors = DECOR[categoryId] ?? [];
  return (
    <>
      {BUNTING_CATEGORIES.has(categoryId) && (
        <svg
          aria-hidden
          className="pointer-events-none absolute top-0 left-0 w-full h-14 opacity-90"
          viewBox="0 0 400 56"
          preserveAspectRatio="none"
        >
          <path d="M0 6 Q100 30 200 10 T400 18" fill="none" stroke={`${ink}44`} strokeWidth="1.5" />
          {Array.from({ length: 9 }).map((_, i) => {
            const x = i * 46 + 8;
            const y = 8 + Math.sin(i * 1.1) * 7;
            return (
              <polygon
                key={i}
                points={`${x},${y} ${x + 16},${y} ${x + 8},${y + 22}`}
                fill={accent}
                opacity={0.7}
              />
            );
          })}
        </svg>
      )}
      {decors.map((decor) => (
        <span
          key={`${decor.emoji}-${decor.className}`}
          aria-hidden
          className={`pointer-events-none absolute select-none opacity-80 ${decor.className}`}
        >
          {decor.emoji}
        </span>
      ))}
    </>
  );
};

const containerVariants: Variants = {
  hidden: { opacity: 0 },
  show: (motionStyle?: string) => ({
    opacity: 1,
    transition: {
      duration: motionStyle === 'cinematic' ? 1 : 0.7,
      staggerChildren: motionStyle === 'cinematic' ? 0.22 : 0.12,
      delayChildren: motionStyle === 'cinematic' ? 0.15 : 0.05,
    },
  }),
};

/** Per-motion entrance styles for individual parts of the card. */
const itemVariants = (motionStyle?: string): Variants => {
  switch (motionStyle) {
    case 'rise':
      return {
        hidden: { opacity: 0, y: 26 },
        show: { opacity: 1, y: 0, transition: { duration: 0.7, ease: 'easeOut' } },
      };
    case 'zoom':
      return {
        hidden: { opacity: 0, scale: 0.92 },
        show: { opacity: 1, scale: 1, transition: { duration: 0.8, ease: [0.22, 1, 0.36, 1] } },
      };
    case 'cinematic':
      return {
        hidden: { opacity: 0, y: 30, filter: 'blur(8px)' },
        show: {
          opacity: 1,
          y: 0,
          filter: 'blur(0px)',
          transition: { duration: 1, ease: [0.22, 1, 0.36, 1] },
        },
      };
    case 'fade':
    default:
      return {
        hidden: { opacity: 0 },
        show: { opacity: 1, transition: { duration: 0.9, ease: 'easeOut' } },
      };
  }
};

/**
 * Modern layered surface: two soft radial colour blooms over a linear base so
 * every card reads as a rich multi-stop gradient rather than a flat wash.
 */
const surfaceGradient = (stops: string[], accent: string, isLight: boolean): string => {
  if (stops.length <= 1) return stops[0];
  const bloom = isLight ? `${accent}26` : `${accent}4d`;
  return [
    `radial-gradient(130% 120% at 12% -10%, ${bloom} 0%, transparent 55%)`,
    `radial-gradient(120% 130% at 100% 115%, ${bloom} 0%, transparent 60%)`,
    `linear-gradient(150deg, ${stops.join(', ')})`,
  ].join(', ');
};

/** Four L-shaped corner ornaments that make premium cards feel framed. */
const CornerFlourishes: React.FC<{ accent: string }> = ({ accent }) => (
  <>
    {[
      'top-4 left-4 border-t-2 border-l-2 rounded-tl-lg',
      'top-4 right-4 border-t-2 border-r-2 rounded-tr-lg',
      'bottom-4 left-4 border-b-2 border-l-2 rounded-bl-lg',
      'bottom-4 right-4 border-b-2 border-r-2 rounded-br-lg',
    ].map((position) => (
      <span
        key={position}
        aria-hidden
        className={`pointer-events-none absolute w-6 h-6 sm:w-8 sm:h-8 opacity-70 ${position}`}
        style={{ borderColor: `${accent}aa` }}
      />
    ))}
  </>
);

export const GreetingCardVisual: React.FC<GreetingCardVisualProps> = ({
  theme,
  senderName,
  receiverName,
  message,
  imageUrl,
  fontId,
  watermarkName = 'isZma',
  watermarkHref,
  compact = false,
  animate = true,
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
}) => {
  const design = theme.design;
  const ornamentCount = getOrnamentsForTheme(theme);
  const font = getFontById(fontId ?? design.defaultFont);
  const isPremium = theme.tier === 'premium';
  const isElite = theme.tier === 'elite';
  const isRich = isPremium || isElite;

  const occasion = CATEGORY_STYLES[theme.category_id] ?? DEFAULT_STYLE;
  // Light/dark is a property of the theme design; custom colour overrides do
  // not flip the whole card's contrast mode.
  const isLight = design.mode === 'light';

  // Sender overrides (from the colour pickers) win over the theme tokens.
  // Each recipe role now has its own override so senders can control headline,
  // body and signature independently while the eyebrow/divider still follow the
  // headline/signature accents.
  const ink = messageColor || textColor || design.ink;
  const inkSoft = messageColor || textColor || design.inkSoft;
  const textAccent = titleColor || signatureColor || textColor || theme.accent;
  const titleColorResolved = titleColor || textColor || theme.accent;
  const signatureColorResolved = signatureColor || textColor || theme.accent;
  const surface = (bgGradientStart || bgGradientEnd)
    ? `linear-gradient(${bgGradientAngle ?? 135}deg, ${bgGradientStart || design.surface[0]}, ${bgGradientEnd || design.surface[1] || design.surface[0]})`
    : surfaceGradient(design.surface, theme.accent, isLight);

  // Sender-authored copy wins over the theme's designed wording.
  const headline = title?.trim() || occasion.headline;
  const eyebrowText = eyebrow?.trim() || occasion.eyebrow;
  const signoffText = signoff?.trim() || 'With love,';
  const artwork = theme.artwork_url;
  const hasArtwork = Boolean(artwork);

  // Tier shell personality + depth. The compact in-form preview stays calm so
  // typing isn't competed with by the animated shells.
  const shellClass = compact
    ? ''
    : isPremium
      ? 'card-shell-premium'
      : isElite
        ? 'card-shell-elite'
        : 'card-shell-basic';
  const innerShadow = isPremium
    ? `0 44px 130px ${design.glow}, 0 14px 44px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.12)`
    : isElite
      ? `0 38px 110px ${design.glow}, inset 0 1px 0 rgba(255,255,255,0.1)`
      : `0 22px 56px rgba(0,0,0,0.34), 0 10px 30px ${design.glow}, inset 0 1px 0 rgba(255,255,255,0.06)`;

  const heading = `Dear ${receiverName || 'Friend'},`;
  const body = message || 'Your message will appear here…';
  const signer = senderName || 'Your name';

  return (
    <motion.div
      variants={containerVariants}
      custom={design.motion}
      initial={animate ? 'hidden' : false}
      animate={animate ? 'show' : false}
      className={`relative ${compact ? 'rounded-2xl p-[1px]' : 'rounded-[28px] p-[1.5px]'} ${shellClass}`}
      style={{
        background: `linear-gradient(140deg, ${design.border}, transparent 45%, ${design.border})`,
        // Consumed by the premium shimmer border and the elite breathing glow.
        '--shell-accent': theme.accent,
        '--shell-glow': design.glow,
      } as React.CSSProperties}
    >
      {isRich && !compact && (
        // Opacity pulse (compositor-friendly) instead of animating the shadow itself.
        <div
          aria-hidden
          className="card-glow-border pointer-events-none absolute inset-0 rounded-[28px]"
          style={{ boxShadow: `0 0 60px ${design.glow}` }}
        />
      )}

      <div
        className={`relative overflow-hidden ${compact ? 'rounded-[15px] px-5 py-6' : 'rounded-[26px] px-6 py-9 sm:px-11 sm:py-12'} ${
          isElite ? 'sm:px-14' : ''
        }`}
        style={{
          background: surface,
          boxShadow: innerShadow,
        }}
      >
        {/* Admin-uploaded artwork — real illustrated / photographic background. */}
        {hasArtwork && (
          <SmartImage
            src={artwork}
            alt=""
            aria-hidden
            className="pointer-events-none absolute inset-0 w-full h-full object-cover select-none"
          />
        )}

        {/* Readability scrim — light themes get a warm wash, dark themes get a dark veil. */}
        {hasArtwork && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background: isLight
                ? 'linear-gradient(180deg, rgba(255,250,240,0.35) 0%, rgba(255,250,240,0.68) 52%, rgba(255,250,240,0.86) 100%)'
                : 'linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.58) 52%, rgba(0,0,0,0.8) 100%)',
            }}
          />
        )}


        {/* Ambient light pools (hidden when artwork supplies its own depth) */}
        {!hasArtwork && (
          <>
            <div
              aria-hidden
              className="pointer-events-none absolute -top-24 -right-16 w-64 h-64 rounded-full blur-3xl opacity-50"
              style={{ background: design.glow }}
            />
            <div
              aria-hidden
              className="pointer-events-none absolute -bottom-24 -left-16 w-64 h-64 rounded-full blur-3xl opacity-40"
              style={{ background: design.glow }}
            />

            {/* Fine dot texture — adds depth without costing much to paint. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 opacity-[0.07]"
              style={{
                backgroundImage: `radial-gradient(${ink} 1px, transparent 1px)`,
                backgroundSize: '20px 20px',
              }}
            />

            {/* Vignette so the middle content always reads clearly. */}
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0"
              style={{
                background: isLight
                  ? 'radial-gradient(120% 95% at 50% 0%, transparent 62%, rgba(0,0,0,0.05) 100%)'
                  : 'radial-gradient(120% 95% at 50% 0%, transparent 45%, rgba(0,0,0,0.38) 100%)',
              }}
            />
          </>
        )}

        {/* Premium engraved pattern — intricate, expensive-looking depth. */}
        {!hasArtwork && isPremium && !compact && (
          <div
            aria-hidden
            className="card-pattern-premium pointer-events-none absolute inset-0 opacity-20"
            style={{ color: ink }}
          />
        )}

        {/* Drifting particle field — subtle animated depth for every theme. */}
        {!hasArtwork && !compact && (
          <div
            aria-hidden
            className="card-particles pointer-events-none absolute inset-0 overflow-hidden"
            style={{ color: theme.accent, opacity: isLight ? 0.3 : 0.55 }}
          />
        )}

        {/* Category ambience — rising balloons, falling petals, glowing diyas. */}
        {!hasArtwork && (
          <CategoryEffects
            categoryId={theme.category_id}
            tier={theme.tier}
            accent={theme.accent}
            compact={compact}
          />
        )}

        {/* Occasion motifs — balloons, florals, diyas, bunting… (skipped over artwork) */}
        {!hasArtwork && (
          <OccasionDecor categoryId={theme.category_id} accent={theme.accent} ink={ink} />
        )}

        {isRich && !compact && <CornerFlourishes accent={theme.accent} />}

        {/* Shine sweep for premium/elite (transform-only, spaced far apart) */}
        {isRich && !compact && (
          <motion.div
            aria-hidden
            className="pointer-events-none absolute top-0 bottom-0 w-1/3"
            initial={{ x: '-120%', opacity: 0 }}
            animate={{ x: '320%', opacity: [0, 0.45, 0] }}
            transition={{ duration: 3.2, delay: 1.2, repeat: Infinity, repeatDelay: 7, ease: 'easeInOut' }}
            style={{
              background: `linear-gradient(105deg, transparent, ${ink}55, transparent)`,
            }}
          />
        )}

        {/* Tier ornaments (skipped over artwork so the illustration stays clean) */}
        {!hasArtwork &&
          ornamentCount.map((emoji, index) => (
          <motion.span
            key={`${emoji}-${index}`}
            aria-hidden
            className={`pointer-events-none absolute select-none ${compact ? 'text-lg' : 'text-2xl sm:text-3xl'} opacity-80`}
            style={{
              top: compact ? 8 + index * 4 : 18 + index * 8,
              right: compact ? 10 + index * 6 : 22 + index * 10,
            }}
            initial={{ opacity: 0, y: -8, rotate: -8 }}
            animate={{ opacity: 0.85, y: [0, -6, 0], rotate: [-6, 4, -6] }}
            transition={{ duration: 5 + index, repeat: Infinity, ease: 'easeInOut', delay: index * 0.4 }}
          >
            {emoji}
          </motion.span>
          ))}

        <div className={`relative z-10 ${compact ? 'space-y-3' : 'space-y-5 sm:space-y-6'}`}>
          {imageUrl && (
            <motion.div
              variants={itemVariants(design.motion)}
              className={`mx-auto ${compact ? 'w-40 h-40' : 'w-full max-w-md h-64 sm:h-80'} ${design.frame === 'polaroid' ? 'pb-2' : ''}`}
            >
              <PhotoFrame
                frame={design.frame}
                accent={theme.accent}
                glow={design.glow}
                src={imageUrl}
                alt="Greeting photo"
                compact={compact}
                className="w-full h-full"
              />
            </motion.div>
          )}

          {/* Occasion eyebrow */}
          <motion.div
            variants={itemVariants(design.motion)}
            className={`flex items-center gap-3 ${imageUrl ? '' : 'pt-1'}`}
          >
            <span
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 uppercase"
              style={{
                borderColor: design.border,
                color: inkSoft,
                letterSpacing: '0.18em',
                fontSize: compact ? 8 : 10,
                fontWeight: 700,
              }}
            >
              <span style={{ color: textAccent }}>{occasion.motif}</span>
              {eyebrowText}
            </span>
          </motion.div>

          <motion.h2
            variants={itemVariants(design.motion)}
            className={`${compact ? 'text-2xl' : 'text-4xl sm:text-6xl'} font-black leading-[1.05]`}
            style={{
              fontFamily: font.family,
              color: titleColorResolved,
              textShadow: isLight ? 'none' : `0 2px 22px ${design.glow}`,
            }}
          >
            {headline}
          </motion.h2>

          <motion.h1
            variants={itemVariants(design.motion)}
            className={`${compact ? 'text-xl' : 'text-3xl sm:text-5xl'} font-bold leading-tight`}
            style={{
              fontFamily: font.family,
              backgroundImage: `linear-gradient(100deg, ${ink}, ${textAccent})`,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
            }}
          >
            {heading}
          </motion.h1>

          <motion.p
            variants={itemVariants(design.motion)}
            className={`${compact ? 'text-sm' : 'text-base sm:text-xl'} leading-relaxed whitespace-pre-wrap`}
            style={{ fontFamily: font.family, color: ink }}
          >
            {body}
          </motion.p>

          {/* Ornamental divider */}
          <motion.div variants={itemVariants(design.motion)} className="flex items-center gap-3 py-1">
            <span
              className="h-px flex-1"
              style={{ background: `linear-gradient(90deg, transparent, ${design.border})` }}
            />
            <span className={compact ? 'text-[10px]' : 'text-sm'} style={{ color: textAccent }}>
              {occasion.motif}
            </span>
            <span
              className="h-px flex-1"
              style={{ background: `linear-gradient(90deg, ${design.border}, transparent)` }}
            />
          </motion.div>

          <motion.div
            variants={itemVariants(design.motion)}
            className="text-right pt-1"
          >
            <p className={compact ? 'text-[11px]' : 'text-sm'} style={{ color: inkSoft, fontFamily: font.family }}>
              {signoffText}
            </p>
            <p
              className={`${compact ? 'text-lg' : 'text-2xl sm:text-3xl'} font-bold`}
              style={{ fontFamily: font.family, color: signatureColorResolved }}
            >
              {signer}
            </p>
          </motion.div>
        </div>

        {/* Permanent watermark — always rendered, never optional, on every card. */}
        <motion.div
          variants={itemVariants(design.motion)}
          className={`relative z-10 flex justify-center ${compact ? 'mt-4' : 'mt-8'}`}
        >
          {(() => {
            const classes = `inline-flex items-center gap-1.5 rounded-full border backdrop-blur-sm ${
              compact ? 'px-3 py-1 text-[10px]' : 'px-4 py-2 text-xs'
            }`;
            const inner = (
              <>
                <span>Created with ✨ by</span>
                <span className="font-semibold" style={{ color: ink }}>
                  {watermarkName}
                </span>
              </>
            );
            const style = { borderColor: design.border, color: inkSoft };

            return watermarkHref ? (
              <a href={watermarkHref} className={classes} style={style}>
                {inner}
              </a>
            ) : (
              <span className={classes} style={style}>
                {inner}
              </span>
            );
          })()}
        </motion.div>
      </div>
    </motion.div>
  );
};
