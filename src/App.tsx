import { Suspense, lazy } from 'react';
import { Routes, Route } from 'react-router-dom';
import { Home } from './pages/Home';
import { VisitTracker } from './components/VisitTracker';
import { getSubdomainCardId } from './services/greetingService';

/**
 * Route-level code splitting.
 *
 * The heavy screens (admin dashboard, the greeting viewer, checkout return and
 * the theme catalogue with its payment SDKs) are rarely the first thing a
 * visitor loads, so they are fetched on demand. This keeps the landing page's
 * JavaScript small and the first paint fast.
 */
const SectionPage = lazy(() =>
  import('./pages/SectionPage').then((m) => ({ default: m.SectionPage })),
);
const Admin = lazy(() => import('./pages/Admin').then((m) => ({ default: m.Admin })));
const AdminDashboard = lazy(() =>
  import('./components/AdminDashboard').then((m) => ({ default: m.AdminDashboard })),
);
const CheckoutReturn = lazy(() =>
  import('./pages/CheckoutReturn').then((m) => ({ default: m.CheckoutReturn })),
);
const GreetingViewer = lazy(() =>
  import('./components/GreetingViewer').then((m) => ({ default: m.GreetingViewer })),
);
const CreateGreeting = lazy(() =>
  import('./components/CreateGreeting').then((m) => ({ default: m.CreateGreeting })),
);
const ManageCard = lazy(() =>
  import('./pages/ManageCard').then((m) => ({ default: m.ManageCard })),
);
const Legal = lazy(() => import('./pages/Legal').then((m) => ({ default: m.Legal })));
const Founder = lazy(() => import('./pages/Founder').then((m) => ({ default: m.Founder })));
const GameZone = lazy(() => import('./pages/GameZone').then((m) => ({ default: m.GameZone })));
/* Indexable marketing pages — every URL listed in sitemap.xml resolves here. */
const Store = lazy(() => import('./pages/Info').then((m) => ({ default: m.Store })));
const Blog = lazy(() => import('./pages/Info').then((m) => ({ default: m.Blog })));
const Faq = lazy(() => import('./pages/Info').then((m) => ({ default: m.Faq })));
const Contact = lazy(() => import('./pages/Info').then((m) => ({ default: m.Contact })));
const NotFound = lazy(() => import('./pages/NotFound').then((m) => ({ default: m.NotFound })));

const RouteFallback = () => (
  <div className="min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end flex items-center justify-center">
    <div className="animate-spin w-12 h-12 border-4 border-neon-purple border-t-transparent rounded-full" />
  </div>
);

function App() {
  // When the app is served from a card subdomain (e.g. abc123.ishmaverse.com)
  // the card is the whole page.
  const subdomainCardId = getSubdomainCardId();

  if (subdomainCardId) {
    return (
      <Suspense fallback={<RouteFallback />}>
        <GreetingViewer cardId={subdomainCardId} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={<RouteFallback />}>
      {/* Audience analytics — records each page view (admins excluded server-side). */}
      <VisitTracker />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/section/:sectionId" element={<SectionPage />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/admin/dashboard" element={<AdminDashboard />} />
        <Route path="/greet/:id" element={<GreetingViewer />} />
        <Route path="/checkout/return" element={<CheckoutReturn />} />
        <Route path="/create-greeting" element={<CreateGreeting />} />
        <Route path="/manage/:token" element={<ManageCard />} />
        <Route path="/founder" element={<Founder />} />
        <Route path="/store" element={<Store />} />
        <Route path="/blog" element={<Blog />} />
        <Route path="/faq" element={<Faq />} />
        <Route path="/contact" element={<Contact />} />
        {/* Game Zone: the lobby, plus invite links (/game-zone/room/<code>). */}
        <Route path="/game-zone" element={<GameZone />} />
        <Route path="/game-zone/room/:code" element={<GameZone />} />
        <Route path="/terms" element={<Legal kind="terms" />} />
        <Route path="/privacy" element={<Legal kind="privacy" />} />
        {/* Unknown paths get a branded, noindex page (the host still answers 200). */}
        <Route path="*" element={<NotFound />} />
      </Routes>
    </Suspense>
  );
}

export default App;
