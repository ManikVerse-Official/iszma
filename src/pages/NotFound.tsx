import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Compass } from 'lucide-react';
import { Navbar } from '../components/Navbar';
import { Footer } from '../components/Footer';
import { IsZmaWatermarkBg } from '../components/brand/IsZmaWatermarkBg';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';

/**
 * Unknown route. A single-page app cannot change the HTTP status of this
 * response, so the page is explicitly `noindex` and offers real navigation
 * instead of a dead end.
 */
export const NotFound: React.FC = () => {
  const [searchTerm, setSearchTerm] = useState('');

  usePageMeta({
    title: pageTitle('Page not found'),
    description: 'This isZma page does not exist. Return to The Digital Mall.',
    path: '/404',
    noindex: true,
  });

  return (
    <div className="relative isolate min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
      <IsZmaWatermarkBg />
      <Navbar searchTerm={searchTerm} setSearchTerm={setSearchTerm} />
      <main className="mx-auto max-w-2xl px-6 py-20 text-center">
        <span className="mb-5 inline-flex items-center gap-2 rounded-full border border-neon-purple/40 bg-neon-purple/10 px-4 py-1 text-xs font-semibold uppercase tracking-wider text-neon-purple">
          <Compass className="h-3.5 w-3.5" /> 404
        </span>
        <h1 className="text-3xl font-bold text-white sm:text-4xl">This aisle doesn’t exist</h1>
        <p className="mt-3 text-gray-400">
          The page you were looking for has moved or never existed. The mall is still open.
        </p>
        <Link
          to="/"
          className="mt-8 inline-flex items-center gap-2 rounded-xl bg-neon-purple px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-purple-600"
        >
          <ArrowLeft className="h-4 w-4" /> Back to isZma
        </Link>
      </main>
      <Footer />
    </div>
  );
};

export default NotFound;
