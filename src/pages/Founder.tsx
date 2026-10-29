import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Sparkles, Code2, Palette, Rocket } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { Footer } from '../components/Footer';
import { Chatbot } from '../components/Chatbot';
import { useBrand } from '../context/BrandContext';
import { IsZmaWatermarkBg } from '../components/brand/IsZmaWatermarkBg';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';

/** Founder's external portfolio (opened on explicit tap only). */
const PORTFOLIO_URL = 'https://manik-dey-portfolio.vercel.app/';

const FOCUS = [
  {
    icon: Code2,
    title: 'Builds the product',
    body: 'Designs and ships the tools behind isZma — from the animated greeting-card engine to ReportCard Studio.',
  },
  {
    icon: Palette,
    title: 'Cares about craft',
    body: 'Every card theme, font and animation is tuned so a digital wish still feels personal and beautifully made.',
  },
  {
    icon: Rocket,
    title: 'Keeps it growing',
    body: 'New sections are added over time, with the goal of making isZma a single home for digital products in India.',
  },
];

export const Founder: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');
  const { brand } = useBrand();

  usePageMeta({
    title: pageTitle('Meet the Founder'),
    description:
      'Meet Manik, the founder of isZma, The Digital Mall — the person behind the greeting-card engine and ReportCard Studio.',
    path: '/founder',
  });

  return (
    <div className="relative isolate min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
      <IsZmaWatermarkBg />
      <Navbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} />

      <main className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 pt-10 sm:pt-16 pb-12">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to mall
        </Link>

        <header className="mb-8">
          <span className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-neon-purple bg-neon-purple/10 border border-neon-purple/30 rounded-full px-3 py-1 mb-4">
            <Sparkles className="w-3 h-3" />
            Meet the Founder
          </span>

          <div className="flex items-center gap-4 sm:gap-5">
            <div
              className="shrink-0 w-16 h-16 sm:w-20 sm:h-20 rounded-2xl flex items-center justify-center text-2xl sm:text-3xl font-black text-white"
              style={{
                background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
                boxShadow: '0 18px 44px rgba(139,92,246,0.45)',
              }}
              aria-hidden
            >
              MD
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl sm:text-3xl font-bold text-white">Manik Dey</h1>
              <p className="text-sm text-neon-purple font-semibold">Founder, {brand.site_name}</p>
              <p className="text-sm text-gray-400 mt-1">
                The person behind every card, theme and tool you use here.
              </p>
            </div>
          </div>
        </header>

        <section className="bg-bg-dark-end/70 border border-neon-purple/20 rounded-2xl p-5 sm:p-6 mb-6">
          <h2 className="text-lg font-semibold text-white mb-2">About the founder</h2>
          <p className="text-sm text-gray-300 leading-relaxed">
            Manik is the founder of {brand.site_name}. He designs and builds the platform end to end —
            the animated Digital Greetings experience with its free welcome card, and ReportCard Studio,
            which turns a plain Excel sheet into print-ready school report cards.
          </p>
          <p className="text-sm text-gray-300 leading-relaxed mt-3">
            The idea is simple: make everyday digital things — a birthday wish, a school report card —
            feel thoughtfully made and effortless to create, right from a phone.
          </p>
        </section>

        <section className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {FOCUS.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.title}
                className="bg-bg-dark-end/70 border border-neon-purple/20 rounded-2xl p-5"
              >
                <Icon className="w-5 h-5 text-neon-purple mb-3" />
                <h3 className="text-sm font-semibold text-white mb-1">{item.title}</h3>
                <p className="text-xs text-gray-400 leading-relaxed">{item.body}</p>
              </div>
            );
          })}
        </section>

        <section className="flex flex-col sm:flex-row gap-3">
          <a
            href={PORTFOLIO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-neon-purple text-white font-semibold hover:bg-purple-600 transition-all"
          >
            <ExternalLink className="w-4 h-4" />
            View Manik’s portfolio
          </a>
          <Link
            to="/section/greetings"
            className="flex-1 inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl border border-neon-purple/50 text-neon-purple font-semibold hover:bg-neon-purple/10 transition-all"
          >
            <Sparkles className="w-4 h-4" />
            Explore the mall
          </Link>
        </section>
      </main>

      <Footer />
      <Chatbot />
    </div>
  );
};
