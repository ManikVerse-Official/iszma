import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  HelpCircle,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
} from 'lucide-react';
import { useCatalog } from '../../context/CatalogContext';
import { runSystemDiagnostics, type DiagnosticRun } from '../../services/systemDiagnostics';
import type { DiagnosticCheck, DiagnosticStatus } from '../../services/systemDiagnosticsCore';

const STATUS_STYLE: Record<
  DiagnosticStatus,
  { label: string; className: string; Icon: typeof CheckCircle2 }
> = {
  fail: { label: 'Failing', className: 'text-red-300 bg-red-500/10 border-red-400/40', Icon: ShieldAlert },
  warn: { label: 'Warning', className: 'text-amber-200 bg-amber-400/10 border-amber-400/40', Icon: AlertTriangle },
  unknown: { label: 'Unverified', className: 'text-sky-200 bg-sky-400/10 border-sky-400/40', Icon: HelpCircle },
  ok: { label: 'OK', className: 'text-emerald-300 bg-emerald-400/10 border-emerald-400/40', Icon: CheckCircle2 },
};

const CheckRow: React.FC<{ check: DiagnosticCheck }> = ({ check }) => {
  const style = STATUS_STYLE[check.status];
  const Icon = style.Icon;
  return (
    <details className="rounded-xl border border-white/10 bg-bg-dark-start/60 px-3 py-2">
      <summary className="flex cursor-pointer items-start gap-2 text-xs text-gray-200 marker:content-none">
        <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
          check.status === 'ok'
            ? 'text-emerald-300'
            : check.status === 'warn'
              ? 'text-amber-300'
              : check.status === 'fail'
                ? 'text-red-300'
                : 'text-sky-300'
        }`} />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-white">{check.title}</span>
          <span className="ml-2 text-gray-500">{check.rootCause}</span>
        </span>
        <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${style.className}`}>
          {style.label}
        </span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] ${
            check.recoverable
              ? 'border-white/15 text-gray-400'
              : 'border-red-400/40 text-red-300'
          }`}
        >
          {check.recoverable ? 'recoverable' : 'needs code/deploy'}
        </span>
      </summary>
      <div className="mt-2 space-y-1 border-t border-white/10 pt-2 text-[11px] leading-relaxed text-gray-400">
        <p>
          <span className="text-gray-500">Evidence: </span>
          {check.evidence}
        </p>
        <p>
          <span className="text-gray-500">Safe next step: </span>
          {check.nextStep}
        </p>
      </div>
    </details>
  );
};

/**
 * Read-only diagnostics, shown inside Admin Joy.
 *
 * Nothing here mutates data. It runs browser checks plus the admin-only
 * `admin-diagnostics` function, and it reports an unreachable server as its own
 * failure with the real cause — never as a healthy system.
 */
export const AdminJoyDiagnostics: React.FC = () => {
  const { products, themes, syncWarning, loading: catalogLoading } = useCatalog();
  const [run, setRun] = useState<DiagnosticRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const execute = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await runSystemDiagnostics({
        catalogWarning: syncWarning,
        themeCount: themes.length,
        productCount: products.length,
      });
      setRun(result);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Diagnostics could not be completed in this browser.',
      );
    } finally {
      setLoading(false);
    }
  }, [products.length, syncWarning, themes.length]);

  useEffect(() => {
    /*
     * Wait for the live catalogue: running during its initial load would report
     * an empty catalogue as a warning that is not real.
     */
    if (started.current || catalogLoading) return;
    started.current = true;
    void execute();
  }, [catalogLoading, execute]);

  const summary = run?.summary;

  return (
    <section className="rounded-2xl border border-neon-purple/25 p-4 text-xs">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="flex items-center gap-2 font-semibold text-white">
            <Stethoscope className="h-4 w-4 text-neon-purple" />
            System diagnostics
            {summary && (
              <span
                className={`rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
                  summary.failures > 0
                    ? 'border-red-400/40 bg-red-500/10 text-red-300'
                    : summary.warnings > 0
                      ? 'border-amber-400/40 bg-amber-400/10 text-amber-200'
                      : 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                }`}
              >
                {summary.failures > 0
                  ? `${summary.failures} failing`
                  : summary.warnings > 0
                    ? `${summary.warnings} warning${summary.warnings === 1 ? '' : 's'}`
                    : 'healthy'}
              </span>
            )}
          </h4>
          <p className="mt-1 text-[11px] text-gray-500">
            Read-only. Server checks connect to the admin-only diagnostics function and never expose
            a key.
          </p>
        </div>

        <button
          type="button"
          onClick={() => void execute()}
          disabled={loading}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-neon-purple/40 px-2.5 py-1.5 text-[11px] font-medium text-neon-purple hover:bg-neon-purple/10 disabled:opacity-50"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
          {loading ? 'Running…' : 'Run diagnostics'}
        </button>
      </div>

      {error && (
        <p className="mt-3 rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
          {error} Nothing was changed; retry the check.
        </p>
      )}

      {run && (
        <>
          <p className="mt-2 text-[11px] text-gray-500">
            {run.summary.failures} failing · {run.summary.warnings} warning(s) ·{' '}
            {run.summary.unknown} unverified · {run.summary.ok} OK · server checks{' '}
            {run.serverReachable ? 'ran' : 'did not run'} ·{' '}
            {new Date(run.generatedAt).toLocaleString()}
          </p>

          {run.summary.needsOwnerAction && (
            <p className="mt-2 rounded-xl border border-red-400/40 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
              At least one failure cannot be fixed from the browser (a deployment or code change is
              required). It is marked “needs code/deploy” below.
            </p>
          )}

          <div className="mt-3 space-y-1.5">
            {run.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </div>
        </>
      )}
    </section>
  );
};

export default AdminJoyDiagnostics;
