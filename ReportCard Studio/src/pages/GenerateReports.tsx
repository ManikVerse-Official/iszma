import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store/appStore';
import { useEntitlement } from '../store/entitlementStore';
import {
  Play,
  Square,
  Download,
  AlertCircle,
  CheckCircle2,
  AlertTriangle,
  FileDown,
  RefreshCw,
  Upload,
  Lock,
  Sparkles,
  X,
} from 'lucide-react';
import clsx from 'clsx';
import { FREE_USE_LIMIT } from '../config/plans';
import { generateAllAndZip, downloadBlob } from '../services/bulkGenerator';
import { validateStudents } from '../services/validationEngine';
import ReportCardPreview from '../components/report/ReportCardPreview';
import PreviewFrame from '../components/report/PreviewFrame';
import { resolvePhotosWithOverrides } from '../services/photoOverrides';
import { buildZipFilename } from '../services/pdfGenerator';
import { getTheme } from '../themes';
import type { GenerationResult } from '../types';

export default function GenerateReports() {
  const students = useAppStore((s) => s.students);
  const school = useAppStore((s) => s.schoolProfile);
  const photoMap = useAppStore((s) => s.photoMap);
  const photoOverrides = useAppStore((s) => s.photoOverrides);
  const validation = useAppStore((s) => s.validation);
  const setValidation = useAppStore((s) => s.setValidation);
  const generation = useAppStore((s) => s.generation);
  const setGen = useAppStore((s) => s.setGenerationProgress);
  const resetGen = useAppStore((s) => s.resetGeneration);

  const [mode, setMode] = useState<'valid' | 'all'>('valid');
  const [showPaywall, setShowPaywall] = useState(false);
  const [gateMessage, setGateMessage] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const { beginGeneration, finishGeneration, refreshFromServer, freeUsesRemaining, isAdmin, planActive } =
    useEntitlement();

  // Pull the authoritative plan + free-use count from the server on mount (or
  // when the signed-in email changes). No-op when Supabase is not configured.
  const accountEmail = useEntitlement((s) => s.account?.email);
  useEffect(() => {
    void refreshFromServer();
  }, [accountEmail, refreshFromServer]);

  if (validation === null && students.length > 0) {
    const v = validateStudents(students);
    setValidation(v);
  }

  const readyCount = useMemo(() => {
    if (!validation) return 0;
    const badIds = new Set(
      validation.issues.filter((i) => i.severity === 'error').map((i) => i.studentId as string),
    );
    return students.filter((s) => !badIds.has(s.studentId)).length;
  }, [validation, students]);

  const chosenStudents = useMemo(() => {
    if (mode === 'all' || !validation) return students;
    const badIds = new Set(
      validation.issues.filter((i) => i.severity === 'error').map((i) => i.studentId as string),
    );
    return students.filter((s) => !badIds.has(s.studentId));
  }, [mode, students, validation]);

  /* Photos are matched by identity (roll / admission / name), never by order,
   * and the user's manual corrections from the review table are applied on top. */
  const photoResolution = useMemo(
    () => resolvePhotosWithOverrides(students, photoMap, photoOverrides),
    [photoMap, students, photoOverrides],
  );
  const studentPhotos = photoResolution.photos;
  const theme = getTheme(school.reportTheme);

  const start = async () => {
    if (chosenStudents.length === 0) return;

    /*
     * The server decides, and a free generation is CLAIMED here — before a
     * single page is rendered. A refusal (email allowance used, device
     * allowance used, a generation already spent) stops the run instead of
     * producing cards the user has not paid for.
     */
    const gate = await beginGeneration();
    if (!gate.allowed) {
      setGateMessage(gate.reason ?? 'Subscribe to keep generating report cards.');
      setShowPaywall(true);
      return;
    }
    setGateMessage('');
    resetGen();
    const controller = new AbortController();
    abortRef.current = controller;
    setGen({
      status: 'running',
      total: chosenStudents.length,
      completed: 0,
      failed: 0,
      results: [],
    });

    try {
      const { blob, filename, results } = await generateAllAndZip({
        students: chosenStudents,
        school,
        photoMap,
        photoOverrides,
        batchSize: 5,
        signal: controller.signal,
        onProgress: ({ completed, failed, total, current }) => {
          setGen({
            completed,
            failed,
            total,
            current: current
              ? { studentId: current.studentId, name: current.name, rollNo: current.rollNo }
              : undefined,
          });
        },
        onStudentComplete: (res: GenerationResult) => {
          setGen({ results: [...generation.results, res] });
        },
      });

      const url = URL.createObjectURL(blob);
      setGen({
        status: 'complete',
        results,
        zipBlobUrl: url,
        zipFileName: filename,
      });
      // The run succeeded, so the claimed free generation stands.
      await finishGeneration(gate.claimId, true);
    } catch (e) {
      setGen({
        status: 'error',
      });
      // Nothing was produced: give the claimed generation back.
      await finishGeneration(gate.claimId, false);
    } finally {
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setGen({ status: 'error' });
  };

  const downloadZip = () => {
    if (generation.zipBlobUrl && generation.zipFileName) {
      const a = document.createElement('a');
      a.href = generation.zipBlobUrl;
      a.download = generation.zipFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  const downloadFailed = () => {
    const failed = generation.results.filter((r) => !r.success);
    if (failed.length === 0) return;
    const lines = ['Row,Roll,Name,Reason'];
    for (const f of failed) {
      const name = JSON.stringify(f.name).replace(/^"|"$/g, '');
      const reason = JSON.stringify(f.error || '').replace(/^"|"$/g, '');
      lines.push([f.rowNumber, f.rollNo, name, reason].join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    downloadBlob(blob, 'failed_students.csv');
  };

  const progressPct =
    generation.total > 0
      ? Math.round(((generation.completed + generation.failed) / generation.total) * 100)
      : 0;

  if (students.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-bold text-ink-900">Generate Reports</h2>
          <p className="text-sm text-ink-500">
            Batch-generate one PDF per student and package all into a single ZIP.
          </p>
        </div>
        <div className="card">
          <div className="card-body py-16 text-center text-ink-500">
            <Upload className="h-10 w-10 mx-auto text-ink-300 mb-3" />
            <h3 className="text-lg font-semibold text-ink-800">No students available</h3>
            <p className="text-sm mt-1 max-w-md mx-auto">
              Complete the &ldquo;Import Students&rdquo; workflow to start by importing an Excel file first.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Usage / plan banner */}
      <div
        className={clsx(
          'rounded-xl border px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-2',
          isAdmin || planActive
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : freeUsesRemaining > 0
              ? 'bg-brand-50 border-brand-200 text-brand-800'
              : 'bg-amber-50 border-amber-200 text-amber-800',
        )}
      >
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0" />
          {isAdmin ? (
            <span><strong>Admin: Unlimited</strong></span>
          ) : planActive ? (
            <span>Your subscription is active — unlimited report cards.</span>
          ) : freeUsesRemaining > 0 ? (
            <span>
              Free generations left:{' '}
              <strong>
                {freeUsesRemaining} of {FREE_USE_LIMIT}
              </strong>{' '}
              — usage is counted per generation run.
            </span>
          ) : (
            <span>
              Your {FREE_USE_LIMIT} free generations are used up. Subscribe to keep generating
              report cards.
            </span>
          )}
        </span>
        {!isAdmin && !planActive && (
          <Link
            to="/pricing"
            className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 text-white px-4 py-2 text-xs font-semibold hover:bg-brand-700"
          >
            {freeUsesRemaining > 0 ? 'View plans' : 'Subscribe now'}
          </Link>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink-900">Generate Reports</h2>
          <p className="text-sm text-ink-500">
            One PDF per student · Filename{' '}
            <code className="bg-slate-100 px-1 rounded text-xs">{`{rollNo}_{name}.pdf`}</code> · All packaged into a single ZIP.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {generation.status === 'complete' && generation.zipBlobUrl && (
            <button onClick={downloadZip} className="btn-primary">
              <Download className="h-4 w-4" /> Download {generation.zipFileName}
            </button>
          )}
          {generation.status === 'running' ? (
            <button onClick={stop} className="btn-danger">
              <Square className="h-4 w-4" /> Cancel
            </button>
          ) : (
            <>
              <button
                onClick={start}
                className="btn-primary"
                disabled={chosenStudents.length === 0}
              >
                <Play className="h-4 w-4" />
                {generation.status === 'complete'
                  ? 'Re-generate'
                  : `Generate ${chosenStudents.length} Reports`}
              </button>
              {generation.status !== 'idle' && (
                <button onClick={resetGen} className="btn-secondary">
                  <RefreshCw className="h-4 w-4" /> Reset
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card lg:col-span-2 space-y-4 p-5">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium text-ink-800">Include students:</span>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="mode"
                checked={mode === 'valid'}
                onChange={() => setMode('valid')}
                className="text-brand-600"
              />
              Only records with no errors ({readyCount})
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                name="mode"
                checked={mode === 'all'}
                onChange={() => setMode('all')}
                className="text-brand-600"
              />
              All records ({students.length})
            </label>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2 text-sm">
              <span className="font-semibold text-ink-800">
                {generation.status === 'running' ? 'Generating Report Cards...' : 'Generation Progress'}
              </span>
              <span className="text-ink-600 tabular-nums">{progressPct}%</span>
            </div>
            <div className="w-full h-3 bg-slate-100 rounded-full overflow-hidden">
              <div
                className={clsx(
                  'h-full transition-all duration-300',
                  generation.status === 'error'
                    ? 'bg-red-500'
                    : generation.status === 'complete' && generation.failed > 0
                    ? 'bg-amber-500'
                    : 'bg-brand-600',
                )}
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-4 text-sm text-ink-600">
              <span>
                <span className="font-bold tabular-nums">{generation.completed + generation.failed}</span>{' '}
                / {generation.total || chosenStudents.length} completed
              </span>
              <span className={generation.failed > 0 ? 'text-red-700 font-semibold' : ''}>
                <AlertCircle className="h-4 w-4 inline mr-1 align-[-2px]" />
                {generation.failed} errors
              </span>
              {generation.current && generation.status === 'running' && (
                <span className="text-ink-700 truncate max-w-xs">
                  Now: <span className="font-medium">{generation.current.name}</span>
                  <span className="text-ink-500"> · Roll {generation.current.rollNo}</span>
                </span>
              )}
            </div>
          </div>

          {generation.results.length > 0 && (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-ink-800">Results</h3>
                {generation.failed > 0 && (
                  <button onClick={downloadFailed} className="btn-secondary !py-1 !px-3 text-xs">
                    <FileDown className="h-3.5 w-3.5" /> Export Failed CSV
                  </button>
                )}
              </div>
              <div className="max-h-64 overflow-auto border border-slate-200 rounded-lg">
                {/* Phones: one card per student instead of a wide table. */}
                <ul className="sm:hidden divide-y divide-slate-100">
                  {generation.results.map((r: GenerationResult, i: number) => (
                    <li key={i} className="p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-medium rc-wrap">{r.name}</div>
                          <div className="text-xs text-ink-500">
                            Roll {r.rollNo} · Row {r.rowNumber}
                          </div>
                          <div className="text-[11px] font-mono text-ink-500 rc-wrap mt-0.5">
                            {r.fileName || '—'}
                          </div>
                        </div>
                        {r.success ? (
                          <span className="badge-success shrink-0">
                            <CheckCircle2 className="h-3 w-3" /> Done
                          </span>
                        ) : (
                          <span className="badge-error shrink-0">
                            <AlertCircle className="h-3 w-3" /> Failed
                          </span>
                        )}
                      </div>
                      {!r.success && r.error && (
                        <p className="text-xs text-red-700 mt-1.5 rc-wrap">{r.error}</p>
                      )}
                    </li>
                  ))}
                </ul>

                <table className="table hidden sm:table">
                  <thead className="sticky top-0 bg-white">
                    <tr>
                      <th>Row</th>
                      <th>Roll</th>
                      <th>Name</th>
                      <th>File</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {generation.results.map((r: GenerationResult, i: number) => (
                      <tr key={i}>
                        <td className="text-xs text-ink-500 font-mono">{r.rowNumber}</td>
                        <td className="font-medium">{r.rollNo}</td>
                        <td className="truncate max-w-[220px]">{r.name}</td>
                        <td className="font-mono text-xs max-w-[240px] truncate">{r.fileName || '—'}</td>
                        <td>
                          {r.success ? (
                            <span className="badge-success">
                              <CheckCircle2 className="h-3 w-3" /> Generated
                            </span>
                          ) : (
                            <span className="badge-error" title={r.error}>
                              <AlertCircle className="h-3 w-3" /> Failed
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        <div className="card space-y-3 p-5">
          <h3 className="text-sm font-semibold text-ink-900">Validation Summary</h3>
          {validation ? (
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-ink-500">Students</span>
                <span className="font-semibold">{students.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-500">Errors</span>
                <span className={validation.errorCount > 0 ? 'text-red-700 font-semibold' : 'text-ink-800 font-semibold'}>
                  {validation.errorCount}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-500">Warnings</span>
                <span className={validation.warningCount > 0 ? 'text-amber-700 font-semibold' : 'text-ink-800 font-semibold'}>
                  {validation.warningCount}
                </span>
              </div>
              <div className="flex items-center justify-between pt-2 mt-2 border-t border-slate-100">
                <span className="text-ink-500">To generate</span>
                <span className="font-semibold text-brand-700">{chosenStudents.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-500">ZIP filename</span>
                <span
                  className="font-mono text-xs truncate max-w-[180px]"
                  title={buildZipFilename(students[0]?.class, students[0]?.section)}
                >
                  {buildZipFilename(students[0]?.class, students[0]?.section)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-500">Photos available</span>
                <span className="font-semibold">{Object.keys(photoMap).length > 0 ? 'YES' : 'none'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-ink-500">Photos to print</span>
                <span className="font-semibold">
                  {studentPhotos.size}
                  {photoOverrides && Object.keys(photoOverrides).length > 0 && (
                    <span className="text-ink-500 font-normal"> · manual on {Object.keys(photoOverrides).length}</span>
                  )}
                </span>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-500">Validating...</p>
          )}
          {validation && !validation.isValid && (
            <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-800 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                Some students have validation errors. By default, only valid records are generated.
                Switch to &ldquo;All records&rdquo; if you want to include them anyway.
              </span>
            </div>
          )}
        </div>
      </div>

      {chosenStudents[0] && (
        <div className="card">
          <div className="card-header flex items-center justify-between">
            <h3 className="font-semibold text-ink-900">Sample Preview (first student in queue)</h3>
            <span className="text-xs text-ink-500 rc-wrap">
              Theme: <span className="font-medium text-ink-700">{theme.name}</span> · Actual PDFs are
              print-ready and follow this layout on A4.
            </span>
          </div>
          <div className="card-body">
            <PreviewFrame
              title={`Sample preview — ${chosenStudents[0].name} (Roll ${chosenStudents[0].rollNo})`}
              caption="Exactly what the generated PDF contains."
            >
              <ReportCardPreview
                student={chosenStudents[0]}
                school={school}
                photoDataUrl={studentPhotos.get(chosenStudents[0].studentId)}
              />
            </PreviewFrame>
          </div>
        </div>
      )}

      {showPaywall && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="relative w-full max-w-md bg-white rounded-2xl shadow-card p-6">
            <button
              onClick={() => setShowPaywall(false)}
              className="absolute top-4 right-4 text-ink-400 hover:text-ink-700"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
            <div className="h-12 w-12 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center mb-4">
              <Lock className="h-6 w-6" />
            </div>
            <h3 className="text-lg font-semibold text-ink-900">Free generations used up</h3>
            <p className="text-sm text-ink-600 mt-1">
              {gateMessage ||
                `You've used all ${FREE_USE_LIMIT} free report-card generations. Subscribe to a plan for unlimited report cards for 6 months.`}
            </p>
            <p className="text-xs text-ink-500 mt-2">
              Free generations are counted per email and per device, so signing in with another
              address (or clearing this browser) does not reset them.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 mt-5">
              <Link
                to="/pricing"
                className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700"
              >
                <Sparkles className="h-4 w-4" /> View plans
              </Link>
              <Link
                to="/login"
                className="flex-1 inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-slate-300 text-ink-700 font-semibold hover:bg-slate-50"
              >
                Sign in
              </Link>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
