import { useBrand } from '../context/BrandContext';
import { SmartImage } from './SmartImage';
import { IsZmaWordmark } from './brand/IsZmaWordmark';

export const Hero: React.FC = () => {
  const { brand } = useBrand();
  const isCurrentName = brand.site_name.trim().toLowerCase() === 'iszma';

  return (
    <section className="relative overflow-hidden px-4 py-10 sm:px-6 sm:py-16 lg:px-8">
      {/* Soft ambient wash behind the whole hero — decorative only. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-[#6D28D9]/15 blur-3xl"
      />

      <div className="relative mx-auto grid max-w-7xl items-center gap-10 md:grid-cols-[1.05fr_0.95fr] md:gap-10 lg:gap-16">
        {/* Text column — nudged toward the page centre on larger screens. */}
        <div className="mx-auto w-full max-w-xl text-center md:mx-0 md:pl-6 md:text-left lg:pl-12">
          <h1 className="text-3xl font-black leading-[1.05] tracking-tight sm:text-4xl md:text-5xl lg:text-6xl">
            <span className="block text-white [text-shadow:0_0_32px_rgba(167,139,250,0.28)]">
              WELCOME TO
            </span>
            {isCurrentName ? (
              <>
                {/* The custom Z carries the brand shape; this keeps the H1
                    readable as "WELCOME TO isZma" for screen readers. */}
                <IsZmaWordmark className="mt-2 text-4xl drop-shadow-[0_0_30px_rgba(139,92,246,0.35)] sm:text-5xl md:text-6xl lg:text-7xl" />
                <span className="sr-only">isZma</span>
              </>
            ) : (
              <span className="bg-gradient-to-r from-[#C4B5FD] via-[#8B5CF6] to-[#6D28D9] bg-clip-text text-transparent">
                {brand.site_name}
              </span>
            )}
          </h1>

          <span
            aria-hidden="true"
            className="mx-auto mt-4 block h-px w-28 bg-gradient-to-r from-[#8B5CF6] via-[#C4B5FD] to-transparent md:mx-0"
          />

          <div className="mt-5 space-y-3">
            <p className="text-sm font-semibold uppercase tracking-[0.22em] text-[#C4B5FD] sm:text-base">
              {brand.brand_tagline}
            </p>
            <p className="mx-auto max-w-md text-sm leading-relaxed text-gray-300 sm:text-base md:mx-0">
              Animated greeting cards, school report-card tools, games and digital
              products — Tech, Art, Comics and Education in one digital mall.
            </p>
          </div>
        </div>

        {/* Right content — the supplied 3D Z mark, unaltered. */}
        <div className="flex w-full justify-center">
          <div className="relative flex items-center justify-center">
            {/* Ambient purple glow; decorative only. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute h-[78%] w-[78%] rounded-full bg-[#6D28D9]/35 blur-3xl"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(167,139,250,0.3),rgba(109,40,217,0.12)_48%,transparent_72%)] blur-2xl"
            />
            <SmartImage
              src={brand.logo_url}
              alt={`${brand.site_name} logo`}
              className="relative h-60 w-60 object-contain bg-transparent shadow-none drop-shadow-[0_0_40px_rgba(139,92,246,0.5)] border-0 sm:h-80 sm:w-80 lg:h-[23rem] lg:w-[23rem]"
            />
          </div>
        </div>
      </div>
    </section>
  );
};
