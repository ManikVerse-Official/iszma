import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  ShieldCheck,
  Trash2,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ArrowLeft,
} from 'lucide-react';
import { GreetingCard } from '../types';
import { deleteManagedCard, getManagedCard } from '../services/greetingService';
import { resolveTheme } from '../data/greetingThemes';
import { useBrand } from '../context/BrandContext';
import { useCatalog } from '../context/CatalogContext';
import { usePageMeta } from '../hooks/usePageMeta';
import { pageTitle } from '../services/seo';

type Status = 'loading' | 'ready' | 'missing' | 'deleting' | 'deleted' | 'error';

const formatDate = (iso?: string | null): string => {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return '—';
  }
};

/**
 * Sender-facing "manage my card" page, reached only through the secret
 * management_token emailed at purchase. It shows a read-only summary of the
 * card and a single, deliberate action: delete it permanently.
 */
export const ManageCard: React.FC = () => {
  const { token = '' } = useParams<{ token: string }>();
  const { brand } = useBrand();
  const { themes } = useCatalog();

  usePageMeta({ title: pageTitle('Manage your card'), description: 'Private card management.', path: `/manage/${token || 'private'}`, noindex: true });
  const [status, setStatus] = useState<Status>('loading');
  const [card, setCard] = useState<GreetingCard | null>(null);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    const load = async () => {
      const result = await getManagedCard(token);
      if (!active) return;
      if (!result.card) {
        setStatus('missing');
        return;
      }
      setCard(result.card);
      setExpired(result.expired);
      setStatus('ready');
    };

    if (!token) {
      setStatus('missing');
      return;
    }
    void load();

    return () => {
      active = false;
    };
  }, [token]);

  const handleDelete = async () => {
    setStatus('deleting');
    setError('');
    try {
      await deleteManagedCard(token);
      setStatus('deleted');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the card.');
      setStatus('error');
    }
  };

  const theme = card ? resolveTheme(card.theme, themes) : null;

  return (
    <div className="min-h-screen bg-gradient-to-br from-bg-dark-start to-bg-dark-end px-4 py-10 sm:py-16">
      <div className="max-w-xl mx-auto">
        <Link
          to="/"
          className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          {brand.site_name}
        </Link>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="bg-bg-dark-end border border-neon-purple/30 rounded-2xl p-6 sm:p-8 shadow-2xl"
        >
          {status === 'loading' && (
            <div className="flex flex-col items-center gap-4 py-12 text-center">
              <Loader2 className="w-8 h-8 text-neon-purple animate-spin" />
              <p className="text-gray-400 text-sm">Loading your card…</p>
            </div>
          )}

          {status === 'missing' && (
            <div className="text-center py-8">
              <AlertTriangle className="w-12 h-12 text-yellow-300 mx-auto mb-4" />
              <h1 className="text-2xl font-bold text-white mb-2">Card not found</h1>
              <p className="text-gray-400 text-sm">
                This management link is invalid, or the card has already been deleted. Cards also
                disappear automatically 48 hours after they are created.
              </p>
            </div>
          )}

          {status === 'error' && (
            <div className="text-center py-8">
              <AlertTriangle className="w-12 h-12 text-red-400 mx-auto mb-4" />
              <h1 className="text-2xl font-bold text-white mb-2">Something went wrong</h1>
              <p className="text-gray-400 text-sm mb-6">{error}</p>
              <button
                onClick={() => setStatus('ready')}
                className="px-5 py-2.5 rounded-xl border border-neon-purple/50 text-neon-purple font-semibold hover:bg-neon-purple/10 transition-all"
              >
                Try again
              </button>
            </div>
          )}

          {status === 'deleted' && (
            <div className="text-center py-8">
              <CheckCircle2 className="w-14 h-14 text-emerald-400 mx-auto mb-4" />
              <h1 className="text-2xl font-bold text-white mb-2">Card deleted</h1>
              <p className="text-gray-400 text-sm">
                Your greeting card and its shareable link have been permanently removed. This cannot
                be undone.
              </p>
            </div>
          )}

          {(status === 'ready' || status === 'deleting') && card && theme && (
            <>
              <div className="flex items-center gap-3 mb-6">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-400/40 text-emerald-300 text-[11px] font-semibold uppercase tracking-wider px-3 py-1">
                  <ShieldCheck className="w-3 h-3" />
                  Private management
                </span>
                {expired && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-yellow-500/15 border border-yellow-400/40 text-yellow-300 text-[11px] font-semibold uppercase tracking-wider px-3 py-1">
                    <Clock className="w-3 h-3" />
                    Expired
                  </span>
                )}
              </div>

              <h1 className="text-2xl sm:text-3xl font-bold text-white mb-1">
                {theme.emoji} Your card
              </h1>
              <p className="text-gray-400 text-sm mb-6">
                {expired
                  ? 'This card has passed its 48-hour window and is no longer publicly viewable.'
                  : 'Review the details below, or take the card down early.'}
              </p>

              <dl className="space-y-3 mb-8">
                {[
                  { label: 'From', value: card.sender_name || '—' },
                  { label: 'To', value: card.receiver_name || '—' },
                  { label: 'Theme', value: theme.name },
                  { label: 'Created', value: formatDate(card.created_at) },
                  { label: 'Expires', value: formatDate(card.expires_at) },
                ].map((row) => (
                  <div
                    key={row.label}
                    className="flex items-start justify-between gap-4 bg-bg-dark-start border border-neon-purple/20 rounded-xl px-4 py-3"
                  >
                    <dt className="text-xs uppercase tracking-wider text-gray-500 pt-0.5">
                      {row.label}
                    </dt>
                    <dd className="text-sm text-white text-right break-words">{row.value}</dd>
                  </div>
                ))}
              </dl>

              <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-4 mb-4">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-200">
                    Deleting is permanent. The card and its shareable link stop working immediately
                    and cannot be recovered.
                  </p>
                </div>
              </div>

              <button
                onClick={handleDelete}
                disabled={status === 'deleting'}
                className="w-full flex items-center justify-center gap-2 bg-red-600 hover:bg-red-500 disabled:opacity-60 disabled:cursor-not-allowed text-white font-bold rounded-xl px-6 py-4 transition-colors"
              >
                {status === 'deleting' ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="w-5 h-5" />
                    Delete Card Permanently
                  </>
                )}
              </button>
            </>
          )}
        </motion.div>

        <p className="text-center text-[11px] text-gray-600 mt-5">
          Keep this link private — anyone with it can delete the card.
        </p>
      </div>
    </div>
  );
};
