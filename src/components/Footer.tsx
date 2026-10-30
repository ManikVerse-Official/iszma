import { Link } from 'react-router-dom';
import { useBrand } from '../context/BrandContext';
import { SmartImage } from './SmartImage';
import { IsZmaWordmark } from './brand/IsZmaWordmark';

const FOOTER_LINKS = [
  { to: '/store', label: 'Store' },
  { to: '/blog', label: 'Journal' },
  { to: '/faq', label: 'FAQ' },
  { to: '/contact', label: 'Contact' },
  { to: '/terms', label: 'Terms & Conditions' },
  { to: '/privacy', label: 'Privacy Policy' },
  { to: '/founder', label: 'Meet the Founder' },
];

export const Footer: React.FC = () => {
  const currentYear = new Date().getFullYear();
  const { brand } = useBrand();
  const isCurrentName = brand.site_name.trim().toLowerCase() === 'iszma';

  return (
    <footer className="relative mt-16 overflow-hidden border-t border-neon-purple/30 bg-bg-dark-end px-4 py-8 sm:px-6 sm:py-12 lg:px-8">
      {/* Faint purple wash keeps the wide footer from feeling flat. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-24 left-1/4 h-48 w-96 rounded-full bg-neon-purple/10 blur-3xl"
      />

      <div className="relative mx-auto grid max-w-7xl gap-7 sm:grid-cols-2 sm:gap-9 lg:grid-cols-[1.15fr_1fr_0.85fr] lg:items-center lg:gap-10">
        {/* Left — brand mark and tagline. */}
        <div className="flex flex-col items-center gap-3 text-center sm:items-start sm:text-left">
          <Link
            to="/"
            aria-label={`${brand.site_name} — ${brand.brand_tagline}, go to the mall home`}
            className="inline-flex items-center gap-3 rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-purple focus-visible:ring-offset-2 focus-visible:ring-offset-bg-dark-end"
          >
            <SmartImage
              src={brand.logo_url}
              alt=""
              className="h-14 w-14 shrink-0 object-contain bg-transparent border-0 shadow-none drop-shadow-[0_0_24px_rgba(139,92,246,0.35)] sm:h-16 sm:w-16"
            />
            {isCurrentName ? (
              <IsZmaWordmark className="text-3xl sm:text-4xl" />
            ) : (
              <span className="text-3xl font-bold tracking-wide text-white sm:text-4xl">
                {brand.site_name}
              </span>
            )}
          </Link>
          <p className="max-w-xs text-[10px] uppercase leading-relaxed tracking-[0.22em] text-[#A78BFA]/85 sm:text-[11px]">
            {brand.brand_tagline}
          </p>
        </div>

        {/* Centre — navigation and copyright. */}
        <div className="flex flex-col items-center gap-4 text-center sm:items-start sm:text-left lg:border-l lg:border-white/10 lg:pl-10">
          <nav aria-label="Footer" className="flex flex-col items-center gap-2.5 sm:items-start">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.to}
                to={link.to}
                className="text-sm text-gray-400 transition-colors hover:text-[#C4B5FD]"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <p className="text-xs text-gray-500">
            © {currentYear} {brand.site_name}. All rights reserved.
          </p>
        </div>

        {/* Right — the handwritten stamp, decorative and balanced with the logo. */}
        <div className="flex items-center justify-center sm:col-span-2 lg:col-span-1 lg:justify-end">
          <div className="relative flex items-center justify-center">
            <div
              aria-hidden="true"
              className="pointer-events-none absolute h-24 w-36 rounded-full bg-neon-purple/20 blur-2xl"
            />
            <img
              src="/logos/iszma-stamp-logo.png"
              alt=""
              aria-hidden="true"
              className="relative h-14 w-auto opacity-80 [filter:invert(1)_sepia(1)_saturate(4)_hue-rotate(215deg)] sm:h-20"
            />
          </div>
        </div>
      </div>
    </footer>
  );
};
