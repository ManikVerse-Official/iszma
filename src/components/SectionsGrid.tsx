import { useNavigate } from 'react-router-dom';
import { ArrowRight, Lock } from 'lucide-react';
import { mallSections } from '../data/sections';
import { TiltCard } from './TiltCard';

interface SectionsGridProps {
  searchTerm: string;
}

export const SectionsGrid: React.FC<SectionsGridProps> = ({ searchTerm }) => {
  const navigate = useNavigate();
  const query = searchTerm.trim().toLowerCase();

  const visibleSections = mallSections.filter(
    (section) =>
      !query ||
      section.name.toLowerCase().includes(query) ||
      section.tagline.toLowerCase().includes(query),
  );


  return (
    <section className="py-10 px-4 sm:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-end justify-between gap-4 mb-6">
          <div>
            <h2 className="text-2xl sm:text-3xl font-bold text-white">Explore the Mall</h2>
            <p className="text-sm text-gray-400 mt-1">Pick a section to walk into</p>
          </div>
        </div>

        {query && (
          <button
            onClick={() => navigate(`/section/greetings?q=${encodeURIComponent(searchTerm)}`)}
            className="w-full mb-6 text-left group relative"
          >
            <div className="relative flex items-center gap-3 bg-bg-dark-end border border-neon-purple/50 rounded-2xl px-5 py-4 group-hover:border-neon-purple transition-all">
              <span className="text-sm text-gray-300">
                Looking for <span className="text-white font-semibold">"{searchTerm}"</span>? Search
                it inside Digital Greetings
              </span>
              <ArrowRight className="w-4 h-4 text-neon-purple ml-auto group-hover:translate-x-1 transition-transform" />
            </div>
          </button>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          {visibleSections.map((section) => (
            <TiltCard
              key={section.id}
              glow={section.available ? 'rgba(139,92,246,0.35)' : undefined}
              className={`group h-full rounded-2xl ${
                section.available ? 'mall-card mall-card--live' : 'mall-card mall-card--soon'
              }`}
            >
              <button
                onClick={() => navigate(`/section/${section.id}`)}
                className="relative h-full w-full rounded-2xl text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-purple focus-visible:ring-offset-2 focus-visible:ring-offset-bg-dark-start"
              >
                <div className="mall-card__surface relative flex h-full flex-col rounded-2xl border p-6">
                  <div className="mb-4 flex items-start justify-between gap-3">
                    <span
                      className={`text-4xl ${section.available ? '' : 'mall-card__icon'}`}
                      aria-hidden="true"
                    >
                      {section.emoji}
                    </span>
                    {section.available ? (
                      <span className="mall-card__badge inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider">
                        <span className="h-1.5 w-1.5 rounded-full bg-white/90" aria-hidden="true" />
                        Live now
                      </span>
                    ) : (
                      <span className="mall-card__badge inline-flex items-center gap-1 whitespace-nowrap rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-wider">
                        <Lock className="h-3 w-3" aria-hidden="true" />
                        Coming soon
                      </span>
                    )}
                  </div>

                  <h3 className="mall-card__heading mb-2 text-xl font-bold">{section.name}</h3>
                  <p className="mall-card__copy flex-grow text-sm">{section.tagline}</p>

                  <div className="mall-card__action mt-5 flex items-center gap-2 font-semibold">
                    <span>{section.available ? 'Enter section' : 'Preview'}</span>
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
                  </div>
                </div>
              </button>
            </TiltCard>
          ))}
        </div>
      </div>
    </section>
  );
};
