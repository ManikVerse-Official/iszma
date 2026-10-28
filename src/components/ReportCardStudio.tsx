import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { isSupabaseConfigured, supabase } from '../services/supabase';

/**
 * Where the embedded ReportCard Studio build lives.
 *
 * Defaults to the same-origin static sub-app shipped in `public/reportcard`
 * (built with `npm run build:embed`). Set `VITE_REPORTCARD_URL` to point the
 * embed at a separately hosted deployment instead — useful while developing the
 * Studio on its own `vite dev` server.
 */
const REPORT_CARD_URL = (() => {
  const configured = (import.meta.env.VITE_REPORTCARD_URL as string | undefined)?.trim();
  if (configured) return configured;
  return '/reportcard/';
})();

/** The origin that is allowed to receive the session, and to ask for it. */
const STUDIO_ORIGIN = (() => {
  try {
    return new URL(REPORT_CARD_URL, window.location.href).origin;
  } catch {
    return window.location.origin;
  }
})();

/**
 * Dedicated, full-width view for ReportCard Studio.
 *
 * The Studio is a standalone SPA with its own router and compiled styles, so it
 * is rendered in an iframe rather than imported into Ishmaverse's React tree.
 * That keeps its internal routes (`/dashboard`, `/import`, …) fully isolated —
 * no route collision with Ishmaverse, no missing Tailwind classes, and no blank
 * screen — while still sitting inside the Ishmaverse chrome.
 *
 * Session handoff: the Studio has no sign-in of its own, and Ishmaverse is where
 * the real Supabase session lives. This component shares that session with the
 * iframe so the `entitlement` function can verify who is calling (and therefore
 * whether they are an admin). The token is posted only to the Studio's own
 * origin, only on request or on a change, and the SERVER still verifies it — so
 * this is a transport, not a permission.
 */
export const ReportCardStudio: React.FC = () => {
  const [loaded, setLoaded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  const sendSession = useCallback(async () => {
    const frame = frameRef.current;
    if (!frame?.contentWindow || !isSupabaseConfigured()) return;
    try {
      const { data } = await supabase.auth.getSession();
      const session = data.session;
      frame.contentWindow.postMessage(
        session?.access_token
          ? {
              type: 'ishmaverse:auth',
              accessToken: session.access_token,
              email: session.user?.email ?? '',
            }
          : { type: 'ishmaverse:auth-cleared' },
        STUDIO_ORIGIN,
      );
    } catch {
      /* No session available — the Studio simply keeps its anonymous identity. */
    }
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== STUDIO_ORIGIN) return;
      if ((event.data as { type?: string } | null)?.type === 'ishmaverse:auth-request') {
        void sendSession();
      }
    };
    window.addEventListener('message', onMessage);

    /* Keep the shared token fresh: a refreshed token has a new expiry, and a
     * sign-out must be reflected inside the Studio too. */
    const subscription = supabase.auth.onAuthStateChange(() => {
      void sendSession();
    });
    const onVisible = () => {
      if (document.visibilityState === 'visible') void sendSession();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      window.removeEventListener('message', onMessage);
      document.removeEventListener('visibilitychange', onVisible);
      subscription.data.subscription.unsubscribe();
    };
  }, [sendSession]);

  return (
    <div className="min-h-screen flex flex-col bg-gradient-to-br from-bg-dark-start to-bg-dark-end">
      {/* Ishmaverse chrome around the embedded tool */}
      <header className="shrink-0 border-b border-neon-purple/25 bg-bg-dark-end/80 backdrop-blur">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-14 flex items-center gap-3">
          <Link
            to="/"
            className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Back to mall</span>
          </Link>

          <div className="flex items-center gap-2 min-w-0 ml-2">
            <span className="text-xl">📊</span>
            <div className="min-w-0">
              <h1 className="text-sm font-bold text-white leading-tight truncate">
                ReportCard Studio
              </h1>
              <p className="text-[11px] text-gray-400 leading-tight truncate">
                Excel in. Professional report cards out.
              </p>
            </div>
          </div>
        </div>
      </header>

      {/* The embedded Studio. Fixed height so its own sticky header + bottom tab
          bar behave exactly as they do standalone. */}
      <div className="relative flex-1 min-h-[calc(100dvh-3.5rem)]">
        {!loaded && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-bg-dark-start">
            <Loader2 className="w-8 h-8 text-neon-purple animate-spin" />
            <p className="text-sm text-gray-400">Loading ReportCard Studio…</p>
          </div>
        )}

        <iframe
          ref={frameRef}
          src={REPORT_CARD_URL}
          title="ReportCard Studio"
          onLoad={() => {
            setLoaded(true);
            void sendSession();
          }}
          allow="clipboard-write; downloads"
          className="absolute inset-0 w-full h-full border-0 bg-white"
        />
      </div>
    </div>
  );
};
