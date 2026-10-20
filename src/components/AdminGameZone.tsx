import { useCallback, useEffect, useState } from 'react';
import {
  Gamepad2, Users, Activity, Trophy, Clock, AlertCircle, Loader2, RefreshCw, Save, Info,
} from 'lucide-react';
import {
  fetchGameAnalytics,
  fetchGameSettings,
  saveGameSettings,
  type GameAnalytics,
} from '../services/gameZone';

/**
 * Game Zone panel for the admin dashboard.
 *
 * Every number shown here is COUNTED server-side from `game_events` and
 * `game_rooms` by `game_admin_analytics()`. Nothing is estimated, sampled or
 * invented, and the panel says plainly when it cannot measure something.
 *
 * "Sessions" and "unique players" are deliberately separate: a session is a
 * distinct room, while a unique player is a distinct authenticated user id
 * (guests are anonymous Supabase users, so they are real identities but carry
 * no personal information).
 */

const Stat: React.FC<{ icon: React.ReactNode; label: string; value: string; hint?: string }> = ({
  icon, label, value, hint,
}) => (
  <div className="rounded-2xl border border-white/10 p-4">
    <div className="flex items-center gap-2 text-gray-400 text-xs uppercase tracking-wider">
      {icon}
      {label}
    </div>
    <p className="text-2xl font-black text-white mt-2 tabular-nums">{value}</p>
    {hint && <p className="text-xs text-gray-500 mt-1">{hint}</p>}
  </div>
);

const formatDuration = (seconds: number | null): string => {
  if (seconds === null || !Number.isFinite(seconds)) return '—';
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
};

export const AdminGameZone: React.FC = () => {
  const [analytics, setAnalytics] = useState<GameAnalytics | null>(null);
  const [settings, setSettings] = useState({ enabled: true, maintenance: false, sort_order: 1 });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');

    const [analyticsResult, settingsResult] = await Promise.all([
      fetchGameAnalytics(),
      fetchGameSettings(),
    ]);

    if (analyticsResult.ok) {
      setAnalytics(analyticsResult.data.analytics);
    } else {
      setError(analyticsResult.error);
    }

    if (settingsResult) {
      setSettings({
        enabled: settingsResult.enabled,
        maintenance: settingsResult.maintenance,
        sort_order: settingsResult.sort_order,
      });
    }

    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setNotice('');
    setError('');
    const result = await saveGameSettings(settings);
    setSaving(false);
    if (result.ok) {
      setNotice('Game Zone settings saved.');
      void load();
    } else {
      setError(result.error);
    }
  };

  const wins = analytics?.wins_by_side ?? {};
  const modes = analytics?.by_mode ?? {};

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Gamepad2 className="w-5 h-5 text-neon-purple" />
            Game Zone
          </h2>
          <p className="text-sm text-gray-400 mt-1">
            Pair-3Balls activity, counted from real server events.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-white/15 text-sm text-gray-300 hover:text-white hover:border-white/30 transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <p role="alert" className="flex items-start gap-2 text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-xl p-3">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          {error}
        </p>
      )}
      {notice && (
        <p className="text-sm text-emerald-300 bg-emerald-400/10 border border-emerald-400/30 rounded-xl p-3">
          {notice}
        </p>
      )}

      {loading && !analytics && (
        <p className="flex items-center gap-2 text-sm text-gray-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading analytics…
        </p>
      )}

      {analytics && (
        <>
          {/* Availability controls */}
          <div className="rounded-2xl border border-neon-purple/30 bg-neon-purple/5 p-5 space-y-3">
            <p className="text-sm font-semibold text-white">Controls</p>
            <div className="flex flex-wrap gap-5">
              <label className="inline-flex items-center gap-2 text-sm text-gray-200">
                <input
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(event) => setSettings((s) => ({ ...s, enabled: event.target.checked }))}
                  className="accent-[#8b5cf6] w-4 h-4"
                />
                Pair-3Balls enabled
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-200">
                <input
                  type="checkbox"
                  checked={settings.maintenance}
                  onChange={(event) => setSettings((s) => ({ ...s, maintenance: event.target.checked }))}
                  className="accent-[#8b5cf6] w-4 h-4"
                />
                Maintenance mode (online modes show as unavailable)
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-gray-200">
                Display order
                <input
                  type="number"
                  min={0}
                  max={99}
                  value={settings.sort_order}
                  onChange={(event) =>
                    setSettings((s) => ({ ...s, sort_order: Number(event.target.value) || 0 }))
                  }
                  className="w-20 bg-bg-dark-start border border-neon-purple/40 rounded-lg px-2 py-1 text-white text-sm"
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-neon-purple text-white text-sm font-semibold hover:bg-purple-600 transition-colors disabled:opacity-60"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              Save settings
            </button>
            <p className="text-xs text-gray-500">
              Changing a rule needs a migration, not a toggle — these controls only turn the game
              on/off and change its order.
            </p>
          </div>

          {/* Live numbers */}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              icon={<Activity className="w-4 h-4" />}
              label="Sessions started"
              value={String(analytics.sessions_started)}
              hint="Distinct rooms created or matched"
            />
            <Stat
              icon={<Users className="w-4 h-4" />}
              label="Unique players"
              value={String(analytics.unique_players)}
              hint={`${analytics.anonymous_events} events with no user id`}
            />
            <Stat
              icon={<Trophy className="w-4 h-4" />}
              label="Games completed"
              value={String(analytics.games_completed)}
              hint={`${analytics.timeouts} ended on the timer`}
            />
            <Stat
              icon={<Gamepad2 className="w-4 h-4" />}
              label="In progress"
              value={String(analytics.in_progress)}
              hint={`${analytics.active_2m} active in the last 2 minutes`}
            />
            <Stat
              icon={<Clock className="w-4 h-4" />}
              label="Average duration"
              value={formatDuration(analytics.avg_duration_seconds)}
              hint="Finished games only"
            />
            <Stat
              icon={<AlertCircle className="w-4 h-4" />}
              label="Abandoned"
              value={String(analytics.abandoned)}
            />
            <Stat
              icon={<Users className="w-4 h-4" />}
              label="Searching now"
              value={String(analytics.queue_waiting)}
              hint="Players in the World Match queue"
            />
            <Stat
              icon={<Trophy className="w-4 h-4" />}
              label="Wins by side"
              value={`${wins.white ?? 0} / ${wins.black ?? 0}`}
              hint="white / black"
            />
          </div>

          {/* Breakdowns */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 p-4">
              <p className="text-xs uppercase tracking-wider text-gray-500 mb-3">Games by mode</p>
              {Object.keys(modes).length === 0 ? (
                <p className="text-sm text-gray-500">No games recorded yet.</p>
              ) : (
                <ul className="space-y-2 text-sm">
                  {Object.entries(modes).map(([mode, count]) => (
                    <li key={mode} className="flex items-center justify-between">
                      <span className="text-gray-300 capitalize">{mode}</span>
                      <span className="text-white tabular-nums">{count}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-2xl border border-white/10 p-4">
              <p className="text-xs uppercase tracking-wider text-gray-500 mb-3">
                Daily activity (14 days)
              </p>
              {analytics.daily.length === 0 ? (
                <p className="text-sm text-gray-500">No events yet.</p>
              ) : (
                <ul className="space-y-1.5 text-sm max-h-48 overflow-y-auto">
                  {analytics.daily.map((entry) => (
                    <li key={String(entry.day)} className="flex items-center justify-between">
                      <span className="text-gray-400">
                        {new Date(entry.day).toLocaleDateString()}
                      </span>
                      <span className="text-white tabular-nums">{entry.n}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Advertising */}
          <div className="rounded-2xl border border-white/10 p-5 space-y-2">
            <p className="text-sm font-semibold text-white">Advertising / revenue</p>
            <p className="flex items-start gap-2 text-sm text-amber-200">
              <Info className="w-4 h-4 mt-0.5 shrink-0" />
              Ad provider not configured — no revenue, impressions or RPM is shown, because
              Ishmaverse has no advertising integration yet and inventing numbers would be wrong.
            </p>
            <p className="text-xs text-gray-500">
              Integration point (already in place): <code>src/components/game/AdSlot.tsx</code> is mounted
              on the Game Zone landing page and renders <strong>nothing at all</strong> until
              VITE_ADS_PROVIDER and VITE_ADS_SLOT are set, so no request, no box and no script runs
              today. Revenue reporting would have to come from the provider&apos;s own API through a
              Supabase Edge Function, because account tokens and report keys can never live in the
              frontend bundle.
            </p>
          </div>
        </>
      )}
    </div>
  );
};

export default AdminGameZone;
