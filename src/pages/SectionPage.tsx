import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { ArrowLeft, Search, Clock, ShieldCheck, Sparkles, Lock, Wand2 } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { SmartImage } from '../components/SmartImage';
import { Footer } from '../components/Footer';
import { Chatbot } from '../components/Chatbot';
import { ThemeOrderModal } from '../components/ThemeOrderModal';
import { getSectionById } from '../data/sections';
import {
  TIER_LABELS,
  TIER_TAGLINES,
  TIER_ORNAMENT_COUNT,
  greetingCategories,
  searchThemeList,
} from '../data/greetingThemes';
import { getThemePriceRanges, themePriceForRegion } from '../services/catalog';
import { useCurrency } from '../context/CurrencyContext';
import { TiltCard } from '../components/TiltCard';
import { ReportCardStudio } from '../components/ReportCardStudio';
import { GameZone } from './GameZone';
import { GreetingTheme } from '../types';
import { useGreeting } from '../context/GreetingContext';
import { useCatalog } from '../context/CatalogContext';
import { IsZmaWatermarkBg } from '../components/brand/IsZmaWatermarkBg';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle, SITE_NAME, SITE_TAGLINE } from '../services/seo';

export const SectionPage: React.FC = () => {
  const { sectionId = '' } = useParams<{ sectionId: string }>();
  const [searchParams] = useSearchParams();
  const { isAdmin } = useGreeting();
  const { themes: allThemes } = useCatalog();
  const { isIndia: isIndiaRegion, symbol: currencySymbol } = useCurrency();

  const [searchTerm, setSearchTerm] = useState(searchParams.get('q') ?? '');
  const [activeCategory, setActiveCategory] = useState('all');
  const [selectedTheme, setSelectedTheme] = useState<GreetingTheme | null>(null);

  const section = getSectionById(sectionId);
  const isGreetings = sectionId === 'greetings';
  const isReportCard = sectionId === 'reportcard-studio';
  const isGameZone = sectionId === 'game-zone';

  /*
   * Route metadata, computed before any early return so the hook order never
   * changes. Game Zone also applies its own title when it renders.
   */
  const meta = useMemo(() => {
    if (isReportCard) {
      return {
        title: pageTitle('ReportCard Studio — School Report Card Maker'),
        description:
          'Turn an Excel mark sheet into print-ready school report cards in minutes with ReportCard Studio, built into isZma, The Digital Mall.',
        path: '/section/reportcard-studio',
      };
    }
    if (isGameZone) {
      return {
        title: pageTitle('Game Zone — Pair-3Balls'),
        description:
          'Play Pair-3Balls in the isZma Game Zone: against the computer offline, with a friend on one device, in a private room, or in a world match.',
        /* Game Zone has its own canonical route, so do not split ranking signals. */
        path: '/game-zone',
      };
    }
    if (isGreetings) {
      return {
        title: pageTitle('Digital Greeting Cards'),
        description:
          'Create and share animated digital greeting cards for birthdays, anniversaries, weddings and festivals, or send the free Welcome Card on isZma.',
        path: '/section/greetings',
      };
    }
    if (!section) {
      return {
        title: `Section not found | ${SITE_NAME} — ${SITE_TAGLINE}`,
        description: 'This isZma section could not be found. Return to the mall to explore Tech, Art, Comics and Education.',
        path: `/section/${sectionId}`,
        noindex: true,
      };
    }
    return {
      title: pageTitle(section.name),
      description: `${section.tagline} — explore ${section.name} on ${SITE_NAME}, ${SITE_TAGLINE}.`,
      path: `/section/${section.id}`,
    };
  }, [isGreetings, isGameZone, isReportCard, section, sectionId]);

  usePageMeta(meta);

  /*
   * Every hook above MUST run on every render, in the same order. The early
   * returns below therefore stay AFTER this block — an early return placed
   * before a hook (as the ReportCard Studio branch once was) makes React throw
   * "Rendered fewer hooks than expected" the moment Joy navigates here from a
   * normal section page.
   */
  const themes = useMemo(() => {
    const bySearch = searchThemeList(allThemes, searchTerm);
    return activeCategory === 'all'
      ? bySearch
      : bySearch.filter((theme) => theme.category_id === activeCategory);
  }, [allThemes, searchTerm, activeCategory]);

  const priceRanges = useMemo(() => getThemePriceRanges(allThemes), [allThemes]);
  const rangeMin = isIndiaRegion ? priceRanges.inrMin : priceRanges.usdMin;
  const rangeMax = isIndiaRegion ? priceRanges.inrMax : priceRanges.usdMax;

  // ReportCard Studio is its own SPA; render the dedicated embed view instead
  // of trying to mount it inside this router (which caused a route clash).
  if (isReportCard) {
    return <ReportCardStudio />;
  }

  // Game Zone is its own screen with its own Navbar/Footer, so it renders in
  // place of the greeting catalogue. Still after every hook, same as above.
  if (isGameZone) {
    return <GameZone />;
  }

  if (!section) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end flex items-center justify-center p-6">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-3">Section not found</h1>
          <Link to="/" className="text-neon-purple hover:underline">
            ← Back to the mall
          </Link>
        </div>
      </div>
    );
  }

  if (!isGreetings || !section.available) {
    return (
      <div className="relative isolate min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
        <IsZmaWatermarkBg />
        <Navbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} />
        <div className="max-w-2xl mx-auto px-6 py-20 text-center">
          <div className="text-6xl mb-6">{section.emoji}</div>
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-gray-300 bg-white/5 border border-white/10 rounded-full px-4 py-1 mb-5">
            <Lock className="w-3 h-3" />
            Coming soon
          </span>
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-3">{section.name}</h1>
          <p className="text-gray-400 mb-8">{section.tagline}</p>
          <Link
            to="/section/greetings"
            className="inline-flex items-center gap-2 px-6 py-3 bg-neon-purple text-white rounded-xl font-semibold hover:bg-purple-600 transition-all"
          >
            <Wand2 className="w-4 h-4" />
            Explore Digital Greetings
          </Link>
        </div>
        <Footer />
        {/* Section-aware Joy: knows this section's walkthrough. */}
        <Chatbot sectionId={section.id} />
      </div>
    );
  }

  return (
    <div className="relative isolate min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
      <IsZmaWatermarkBg />
      <Navbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-10 sm:pt-16 pb-12">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to mall
        </Link>

        <header className="mb-8">
          <div className="flex flex-wrap items-center gap-4 mb-3">
            <span className="text-5xl">{section.emoji}</span>
            <div>
              <h1 className="text-3xl sm:text-4xl font-bold text-white">{section.name}</h1>
              <p className="text-gray-400 text-sm sm:text-base">{section.tagline}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-3 mt-4">
            <span className="inline-flex items-center gap-2 text-xs text-yellow-200 bg-yellow-500/10 border border-yellow-500/30 rounded-full px-3 py-1">
              <Clock className="w-3 h-3" />
              Every card stays live for 48 hours
            </span>
            <span
              className="inline-flex items-center gap-2 text-xs text-neon-purple bg-neon-purple/10 border border-neon-purple/30 rounded-full px-3 py-1"
              title="Prices are set by the store admin and update in real time"
            >
              <Sparkles className="w-3 h-3" />
              {allThemes.length} animated themes · {currencySymbol}
              {rangeMin}–{currencySymbol}
              {rangeMax}
            </span>
            {isAdmin && (
              <span className="inline-flex items-center gap-2 text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-3 py-1">
                <ShieldCheck className="w-3 h-3" />
                Admin: all cards free
              </span>
            )}
          </div>
        </header>

        {/* Search + category filter */}
        <div className="mb-8 space-y-4">
          <div className="relative max-w-xl">
            <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
              <Search className="w-5 h-5 text-neon-purple" />
            </div>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search themes: romantic, birthday, wedding, diwali, farewell..."
              className="w-full bg-bg-dark-end border border-neon-purple/30 rounded-xl pl-12 pr-4 py-3 text-white placeholder-gray-500 focus:outline-none focus:border-neon-purple transition-colors"
            />
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setActiveCategory('all')}
              className={`px-4 py-2 rounded-full text-sm font-semibold border transition-all ${
                activeCategory === 'all'
                  ? 'bg-neon-purple border-neon-purple text-white'
                  : 'bg-bg-dark-end border-neon-purple/30 text-gray-300 hover:border-neon-purple/60'
              }`}
            >
              All themes
            </button>
            {greetingCategories.map((category) => (
              <button
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={`px-4 py-2 rounded-full text-sm font-semibold border transition-all ${
                  activeCategory === category.id
                    ? 'bg-neon-purple border-neon-purple text-white'
                    : 'bg-bg-dark-end border-neon-purple/30 text-gray-300 hover:border-neon-purple/60'
                }`}
              >
                {category.emoji} {category.name}
              </button>
            ))}
          </div>
        </div>

        {/* Themes */}
        {themes.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-5xl mb-4">🔍</div>
            <h2 className="text-xl font-bold text-white mb-2">No themes found</h2>
            <p className="text-gray-400 text-sm mb-6">
              We couldn't find anything for "{searchTerm}". Try a different keyword.
            </p>
            <button
              onClick={() => {
                setSearchTerm('');
                setActiveCategory('all');
              }}
              className="px-6 py-3 bg-neon-purple text-white rounded-xl font-semibold hover:bg-purple-600 transition-all"
            >
              Reset search
            </button>
          </div>
        ) : (
          <>
            <p className="text-sm text-gray-500 mb-4">
              Showing {themes.length} of {allThemes.length} themes
            </p>
            <motion.div
              className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5"
              initial="hidden"
              animate="show"
              variants={{ hidden: {}, show: { transition: { staggerChildren: 0.06 } } }}
            >
              {themes.map((theme) => {
                const ornaments = theme.design.ornaments.slice(0, TIER_ORNAMENT_COUNT[theme.tier]);
                const isRich = theme.tier === 'premium' || theme.tier === 'elite';
                const hasArtwork = Boolean(theme.artwork_url);
                return (
                  <motion.div
                    key={theme.id}
                    variants={{
                      hidden: { opacity: 0, y: 24 },
                      show: { opacity: 1, y: 0, transition: { duration: 0.5, ease: 'easeOut' } },
                    }}
                    className="h-full"
                  >
                    <TiltCard
                      glow={theme.design.glow}
                      className="group relative h-full rounded-2xl overflow-hidden flex flex-col"
                      style={{
                        border: `1px solid ${theme.design.border}`,
                        boxShadow: `0 18px 50px ${theme.design.glow}`,
                      }}
                    >
                    <div
                      className="relative h-36 overflow-hidden"
                      style={{ background: `linear-gradient(150deg, ${theme.design.surface.join(', ')})` }}
                    >
                      {theme.artwork_url && (
                        <SmartImage
                          src={theme.artwork_url}
                          alt=""
                          aria-hidden
                          className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                        />
                      )}
                      {hasArtwork ? (
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-0"
                          style={{
                            background:
                              theme.design.mode === 'light'
                                ? 'linear-gradient(180deg, rgba(255,250,240,0.15), rgba(255,250,240,0.7))'
                                : 'linear-gradient(180deg, rgba(0,0,0,0.15), rgba(0,0,0,0.65))',
                          }}
                        />
                      ) : (
                        <>
                          {isRich && (
                            <div
                              aria-hidden
                              className="absolute -top-10 -right-10 w-40 h-40 rounded-full blur-2xl opacity-60"
                              style={{ background: theme.design.glow }}
                            />
                          )}
                          <div className="absolute inset-0 flex items-center justify-center text-5xl opacity-90 group-hover:scale-110 transition-transform duration-500">
                            {theme.emoji}
                          </div>
                          {ornaments.map((emoji, index) => (
                            <span
                              key={`${emoji}-${index}`}
                              aria-hidden
                              className="absolute text-xl opacity-80"
                              style={{ top: 14 + index * 6, left: 16 + index * 8 }}
                            >
                              {emoji}
                            </span>
                          ))}
                        </>
                      )}
                      {hasArtwork && (
                        <span className="absolute bottom-3 left-3 text-2xl drop-shadow-lg" aria-hidden>
                          {theme.emoji}
                        </span>
                      )}
                      <div className="absolute top-3 right-3 flex flex-col items-end gap-1">
                        <span
                          className="backdrop-blur-sm rounded-full px-3 py-1 text-[10px] font-bold uppercase tracking-wider"
                          style={{ background: 'rgba(0,0,0,0.45)', color: theme.design.ink }}
                        >
                          {TIER_LABELS[theme.tier]}
                        </span>
                        <span className="text-[10px] font-medium text-white/75">
                          {TIER_TAGLINES[theme.tier]}
                        </span>
                      </div>
                    </div>

                    <div
                      className="p-5 flex flex-col flex-grow"
                      style={{ background: 'rgba(10,6,20,0.78)', backdropFilter: 'blur(6px)' }}
                    >
                      <h3 className="text-lg font-bold text-white mb-1">{theme.name}</h3>
                      <p className="text-sm text-gray-400 flex-grow">{theme.tagline}</p>

                      <div className="flex items-center justify-between mt-4">
                        <div>
                          <div className="text-2xl font-black" style={{ color: theme.accent }}>
                            {theme.price === 0 && theme.price_usd === 0
                              ? 'FREE'
                              : `${currencySymbol}${themePriceForRegion(theme, isIndiaRegion)}`}
                          </div>
                          {isAdmin && <div className="text-[10px] text-emerald-300">Admin: free</div>}
                        </div>
                        <button
                          onClick={() => setSelectedTheme(theme)}
                          className="group/btn relative"
                        >
                          <div
                            className="absolute inset-0 rounded-lg blur opacity-50 group-hover/btn:opacity-100 transition duration-300"
                            style={{ background: `linear-gradient(90deg, ${theme.accent}, ${theme.design.surface[theme.design.surface.length - 1]})` }}
                          />
                          <div className="relative bg-bg-dark-end/90 border rounded-lg px-4 py-2 text-sm font-semibold text-white transition-all duration-300" style={{ borderColor: theme.design.border }}>
                            Create card
                          </div>
                        </button>
                      </div>
                    </div>
                    </TiltCard>
                  </motion.div>
                );
              })}
            </motion.div>
          </>
        )}
      </main>

      <ThemeOrderModal
        theme={selectedTheme}
        isOpen={!!selectedTheme}
        onClose={() => setSelectedTheme(null)}
      />

      <Footer />
      {/* Section-aware Joy: knows this section's walkthrough. */}
      <Chatbot sectionId={section.id} />
    </div>
  );
};