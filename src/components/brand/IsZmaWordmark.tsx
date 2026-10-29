import { useId } from 'react';

interface IsZmaWordmarkProps {
  /** Type scale, supplied by the caller (e.g. text-xl sm:text-2xl). */
  className?: string;
}

/**
 * The `isZma` wordmark.
 *
 * The official spelling is `isZma` (capital Z). The Z is drawn as an SVG path
 * with the long upper stroke and the lower underline from the handwritten mark,
 * because no ordinary font reproduces that shape faithfully. The `is` and `ma`
 * use the site's Outfit lettering with a purple metallic gradient.
 *
 * The mark is decorative: the surrounding link supplies the accessible name
 * (`isZma — The Digital Mall`), so this is hidden from assistive technology.
 */
export const IsZmaWordmark: React.FC<IsZmaWordmarkProps> = ({ className = '' }) => {
  const gradientId = `iszma-z-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;

  return (
    <span
      aria-hidden="true"
      className={`inline-flex select-none items-baseline leading-none ${className}`}
      style={{
        fontFamily: 'Outfit, Poppins, ui-sans-serif, system-ui, sans-serif',
        fontWeight: 600,
        letterSpacing: '-0.045em',
      }}
    >
      <span className="bg-gradient-to-r from-[#C4B5FD] via-[#8B5CF6] to-[#6D28D9] bg-clip-text text-transparent">
        is
      </span>
      <svg
        viewBox="0 0 48 40"
        className="mx-[0.01em] h-[0.98em] w-[1.04em] self-center"
        role="presentation"
        focusable="false"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#C4B5FD" />
            <stop offset="48%" stopColor="#8B5CF6" />
            <stop offset="100%" stopColor="#6D28D9" />
          </linearGradient>
        </defs>
        {/* Long top stroke, diagonal, long bottom underline — the stamp's Z. */}
        <path
          d="M3 6 H45 L12 34 H46"
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="5.5"
          strokeLinecap="square"
          strokeLinejoin="miter"
        />
      </svg>
      <span className="bg-gradient-to-r from-[#A78BFA] via-[#8B5CF6] to-[#6D28D9] bg-clip-text text-transparent">
        ma
      </span>
    </span>
  );
};

export default IsZmaWordmark;
