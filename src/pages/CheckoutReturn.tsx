import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check, Copy, ExternalLink, Loader2, AlertTriangle, Clock } from 'lucide-react';
import { buildGreetingUrl, buildManageUrl, createGreetingCard } from '../services/greetingService';
import { clearPendingGreeting, readPendingGreeting } from '../services/pendingCheckout';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';

type Status = 'verifying' | 'success' | 'error';

/**
 * Landing page for Stripe's hosted checkout redirect.
 *
 * The card payload was stashed in sessionStorage before leaving the app; here we
 * hand the Stripe session id to the server as payment proof. `create-greeting`
 * re-verifies the session with Stripe and is idempotent on the session id, so a
 * refresh cannot charge twice or mint a duplicate card.
 */
export const CheckoutReturn: React.FC = () => {
  const [params] = useSearchParams();
  const sessionId = params.get('session_id');

  const [status, setStatus] = useState<Status>('verifying');
  const [cardLink, setCardLink] = useState('');
  const [managementToken, setManagementToken] = useState('');
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const started = useRef(false);

  usePageMeta({ title: pageTitle('Confirming your payment'), description: 'Confirming your isZma payment.', path: '/checkout/return', noindex: true });

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const run = async () => {
      if (!sessionId) {
        setError('This page is missing its payment reference.');
        setStatus('error');
        return;
      }

      const pending = readPendingGreeting();
      if (!pending) {
        setError(
          'We could not find the card details for this payment. If you were charged, please contact support with your Stripe reference.',
        );
        setStatus('error');
        return;
      }

      try {
        const { card } = await createGreetingCard({
          ...pending,
          payment: { provider: 'stripe', payment_id: sessionId, order_id: sessionId },
        });
        setCardLink(buildGreetingUrl(card.id));
        setManagementToken(card.management_token ?? '');
        setExpiresAt(card.expires_at ? new Date(card.expires_at) : null);
        clearPendingGreeting();
        setStatus('success');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'We could not create your greeting card.');
        setStatus('error');
      }
    };

    void run();
  }, [sessionId]);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(cardLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end flex items-center justify-center px-4 pt-24 pb-16">
      <div className="w-full max-w-lg bg-bg-dark-end border border-neon-purple/30 rounded-2xl p-8 text-center">
        {status === 'verifying' && (
          <div className="space-y-4">
            <Loader2 className="w-12 h-12 text-neon-purple animate-spin mx-auto" />
            <h1 className="text-2xl font-bold text-white">Confirming your payment…</h1>
            <p className="text-gray-400 text-sm">
              Please wait while we verify your Stripe payment and create your card.
            </p>
          </div>
        )}

        {status === 'success' && (
          <div className="space-y-5">
            <div className="relative w-16 h-16 mx-auto">
              <div className="absolute inset-0 bg-gradient-to-r from-neon-purple to-purple-500 rounded-full blur-xl opacity-60 animate-pulse" />
              <div className="relative w-16 h-16 bg-bg-dark-end border-2 border-neon-purple rounded-full flex items-center justify-center">
                <Check className="w-8 h-8 text-neon-purple" />
              </div>
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">Your card is ready! 🎉</h1>
              <p className="text-gray-400 text-sm mt-1">
                Share this link with the person you're thinking of.
              </p>
            </div>

            <div className="flex gap-2">
              <input
                value={cardLink}
                readOnly
                onFocus={(e) => e.currentTarget.select()}
                className="flex-1 min-w-0 bg-bg-dark-start border border-neon-purple/30 rounded-xl px-4 py-3 text-white text-sm"
              />
              <button
                onClick={copyLink}
                className="flex items-center gap-2 px-5 py-3 bg-neon-purple text-white rounded-xl font-semibold hover:bg-purple-600 transition-all shrink-0"
              >
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>

            {expiresAt && (
              <p className="text-[11px] text-gray-500 flex items-center justify-center gap-1.5">
                <Clock className="w-3.5 h-3.5" />
                Live for 48 hours — until {expiresAt.toLocaleString()}
              </p>
            )}

            {managementToken && (
              <p className="text-[11px] text-gray-500">
                Need to take it down early?{' '}
                <a
                  href={buildManageUrl(managementToken)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-neon-purple hover:text-purple-300 font-semibold"
                >
                  Manage or delete your card
                </a>
              </p>
            )}

            <div className="flex flex-col sm:flex-row gap-3">
              <a
                href={cardLink}
                target="_blank"
                rel="noreferrer"
                className="flex-1 flex items-center justify-center gap-2 px-6 py-3 border border-neon-purple rounded-xl text-neon-purple font-semibold hover:bg-neon-purple hover:text-white transition-all"
              >
                <ExternalLink className="w-4 h-4" />
                Preview card
              </a>
              <Link
                to="/section/greetings"
                className="flex-1 px-6 py-3 border border-gray-700 rounded-xl text-gray-300 font-semibold hover:border-gray-500 hover:text-white transition-all"
              >
                Back to greetings
              </Link>
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-5">
            <div className="w-16 h-16 mx-auto bg-red-500/10 border border-red-500/40 rounded-full flex items-center justify-center">
              <AlertTriangle className="w-8 h-8 text-red-400" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white">We couldn't finish your card</h1>
              <p className="text-gray-400 text-sm mt-2">{error}</p>
            </div>
            <div className="flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => window.location.reload()}
                className="flex-1 px-6 py-3 bg-neon-purple text-white rounded-xl font-semibold hover:bg-purple-600 transition-all"
              >
                Try again
              </button>
              <Link
                to="/section/greetings"
                className="flex-1 px-6 py-3 border border-gray-700 rounded-xl text-gray-300 font-semibold hover:border-gray-500 hover:text-white transition-all"
              >
                Back to greetings
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
