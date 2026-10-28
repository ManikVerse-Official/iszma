import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store/appStore';
import { useEntitlement } from '../store/entitlementStore';
import { FREE_USE_LIMIT } from '../config/plans';
import ReportCardPreview from '../components/report/ReportCardPreview';
import PreviewFrame from '../components/report/PreviewFrame';
import { resolvePhotosWithOverrides } from '../services/photoOverrides';
import { REPORT_CARD_THEMES, getTheme } from '../themes';
import { buildReportCardModel } from '../services/reportCardModel';
import { validateStudents } from '../services/validationEngine';
import { ChevronLeft, ChevronRight, Download, Eye } from 'lucide-react';
import { generateStudentPdfBlob, buildPdfFilename } from '../services/pdfGenerator';
import { downloadBlob } from '../services/bulkGenerator';

export default function ReportTemplate() {
  const students = useAppStore((s) => s.students);
  const school = useAppStore((s) => s.schoolProfile);
  const photoMap = useAppStore((s) => s.photoMap);
  const photoOverrides = useAppStore((s) => s.photoOverrides);
  const validation = useAppStore((s) => s.validation);
  const setValidation = useAppStore((s) => s.setValidation);
  const setProfile = useAppStore((s) => s.setSchoolProfile);

  const [idx, setIdx] = useState(0);
  const [downloading, setDownloading] = useState(false);
  const [gateMessage, setGateMessage] = useState('');
  const { beginGeneration, finishGeneration, freeUsesRemaining, isAdmin, planActive } =
    useEntitlement();

  /* Hooks must run before the empty-state early return. */
  const studentPhotos = useMemo(
    () => resolvePhotosWithOverrides(students, photoMap, photoOverrides).photos,
    [photoMap, students, photoOverrides],
  );

  const student = students[idx];

  useMemo(() => {
    if (students.length > 0 && !validation) {
      const v = validateStudents(students);
      setValidation(v);
    }
  }, [students.length, validation, setValidation, students]);

  if (students.length === 0) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-xl font-bold text-ink-900">Report Template</h2>
          <p className="text-sm text-ink-500">
            Preview the holistic report-card layout and inspect every field before generating.
          </p>
        </div>
        <EmptyState />
      </div>
    );
  }

  const theme = getTheme(school.reportTheme);
  const photo = student ? studentPhotos.get(student.studentId) : undefined;
  /*
   * Single source of truth: the sidebar reads the same model the preview and
   * the PDF are built from. Previously the sidebar called `computeTotals` on
   * its own with the DEFAULT grading bands, so a school with custom bands could
   * see a different overall grade here than on the card.
   */
  const model = student ? buildReportCardModel(student, school) : null;
  const totals = model?.totals ?? null;
  /* Academic subjects that carry real marks (grade-only columns excluded). */
  const presentSubjects = model
    ? model.academic.filter((row) => !row.isGrandTotal && typeof row.marks === 'number').length
    : 0;
  const studentIssues =
    validation?.issues.filter((i) => i.studentId === student?.studentId) ?? [];

  /*
   * A single-PDF download is a generation too, so it goes through the same
   * gate and consumes one free try. Previously only the batch page consumed,
   * which is why the counter appeared stuck at the full allowance.
   */
  const downloadOne = async () => {
    if (!student) return;

    /* The server claims the generation before the PDF is rendered, so a used-up
     * allowance blocks the download rather than silently producing the file. */
    const gate = await beginGeneration();
    if (!gate.allowed) {
      setGateMessage(gate.reason ?? 'Subscribe to keep downloading report cards.');
      return;
    }
    setGateMessage('');
    setDownloading(true);
    try {
      const blob = await generateStudentPdfBlob({ student, school, photoDataUrl: photo });
      const used = new Set<string>();
      const fname = buildPdfFilename(student.rollNo, student.name, used);
      downloadBlob(blob, fname);
      await finishGeneration(gate.claimId, true);
    } catch {
      // The PDF was not produced, so the claimed generation is given back.
      await finishGeneration(gate.claimId, false);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div
        className={`rounded-xl border px-4 py-3 text-sm flex flex-wrap items-center justify-between gap-2 ${
          isAdmin || planActive
            ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
            : freeUsesRemaining > 0
              ? 'bg-brand-50 border-brand-200 text-brand-800'
              : 'bg-amber-50 border-amber-200 text-amber-800'
        }`}
      >
        <span>
          {isAdmin ? (
            <strong>Admin: Unlimited</strong>
          ) : planActive ? (
            'Your subscription is active — unlimited report cards.'
          ) : freeUsesRemaining > 0 ? (
            <>
              Free generations left:{' '}
              <strong>
                {freeUsesRemaining} of {FREE_USE_LIMIT}
              </strong>{' '}
              — a single PDF download counts as one.
            </>
          ) : (
            `Your ${FREE_USE_LIMIT} free generations are used up. Subscribe to keep downloading.`
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

      {gateMessage && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {gateMessage}{' '}
          <Link to="/pricing" className="font-semibold underline">
            View plans
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink-900">Report Template</h2>
          <p className="text-sm text-ink-500">
            Preview the report layout. Navigate between students to check each record.
          </p>
        </div>
        {/*
         * `flex-wrap` + `min-w-0` matter on a 320px phone: the student pager,
         * the theme picker and Download This PDF together are wider than the
         * screen, and without wrapping they pushed the whole page sideways.
         */}
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto justify-start sm:justify-end min-w-0">
          <div className="flex items-center gap-1 bg-white border border-slate-200 rounded-lg overflow-hidden shrink-0">
            <button
              onClick={() => setIdx((i) => Math.max(0, i - 1))}
              disabled={idx === 0}
              className="px-2 py-2 text-ink-600 hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="text-sm text-ink-700 px-3 min-w-[110px] text-center font-medium">
              {idx + 1} / {students.length}
            </div>
            <button
              onClick={() => setIdx((i) => Math.min(students.length - 1, i + 1))}
              disabled={idx >= students.length - 1}
              className="px-2 py-2 text-ink-600 hover:bg-slate-50 disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <select
            className="input !w-auto min-w-0 max-w-full sm:max-w-[190px]"
            value={school.reportTheme ?? theme.id}
            onChange={(e) => setProfile({ reportTheme: e.target.value })}
            title="Report card theme (change it in School Profile)"
          >
            {REPORT_CARD_THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button onClick={downloadOne} disabled={downloading} className="btn-secondary shrink-0">
            <Download className="h-4 w-4" />
            {downloading ? 'Generating...' : 'Download This PDF'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="space-y-4">
          <div className="card">
            <div className="card-header flex items-center gap-2">
              <Eye className="h-4 w-4 text-brand-600" />
              <h3 className="font-semibold text-ink-900">Current Student</h3>
            </div>
            <div className="card-body text-sm space-y-1.5">
              <div className="flex gap-2 justify-between">
                <span className="text-ink-500">Name:</span>
                <span className="font-medium truncate text-right">{student?.name}</span>
              </div>
              <div className="flex gap-2 justify-between">
                <span className="text-ink-500">Roll No:</span>
                <span className="font-medium">{student?.rollNo}</span>
              </div>
              <div className="flex gap-2 justify-between">
                <span className="text-ink-500">Class / Sec:</span>
                <span className="font-medium">
                  {student?.class}
                  {student?.section ? ` - ${student.section}` : ''}
                </span>
              </div>
              <div className="flex gap-2 justify-between">
                <span className="text-ink-500">Attendance:</span>
                <span className="font-medium">{student?.attendance || '—'}</span>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-header">
              <h3 className="font-semibold text-ink-900">Totals Preview</h3>
            </div>
            <div className="card-body space-y-2 text-sm">
              <SumRow label="Subjects Count" value={`${student?.subjects.length ?? 0}`} />
              <SumRow label="Present" value={`${presentSubjects}`} />
              <SumRow
                label="Grand Total"
                value={`${totals?.obtained ?? 0} / ${totals?.max ?? 0}`}
                strong
              />
              <SumRow
                label="Percentage"
                value={
                  totals && totals.percentage !== null && totals.percentage !== undefined
                    ? `${totals.percentage}%`
                    : '—'
                }
              />
              <SumRow label="Overall Grade" value={totals?.grade ?? '—'} />
              {/*
               * The result is the model's own value — the sidebar used to
               * re-implement the 33% rule, so it could disagree with the card.
               */}
              <SumRow
                label="Result"
                value={totals ? totals.result : '—'}
                highlight={Boolean(totals?.passed)}
              />
            </div>
          </div>
          {studentIssues.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3 className="font-semibold text-ink-900">Validation for This Student</h3>
              </div>
              <div className="card-body space-y-2 text-xs">
                {studentIssues.map((i, idx2) => (
                  <div
                    key={idx2}
                    className={`p-2 rounded-lg border ${
                      i.severity === 'error'
                        ? 'border-red-200 bg-red-50 text-red-800'
                        : 'border-amber-200 bg-amber-50 text-amber-800'
                    }`}
                  >
                    <div className="font-semibold uppercase">
                      {i.severity} · {i.type}
                    </div>
                    <div>{i.message}</div>
                    {i.reason && (
                      <div className="mt-1 text-ink-700">
                        <span className="font-semibold">
                          {i.confirmed === false ? 'Possible cause:' : 'Cause:'}
                        </span>{' '}
                        {i.reason}
                      </div>
                    )}
                    {i.suggestion && (
                      <div className="mt-1 text-ink-700">
                        <span className="font-semibold">Fix:</span> {i.suggestion}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="card">
            <div className="card-header">
              <h3 className="font-semibold text-ink-900">Jump to Student</h3>
            </div>
            <div className="card-body">
              <select
                className="input"
                value={idx}
                onChange={(e) => setIdx(Number(e.target.value))}
              >
                {students.map((s, i) => (
                  <option key={s.studentId} value={i}>
                    {s.rollNo} · {s.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>

        {/*
         * lg:col-span-3 keeps the card beside the summary on a desktop and
         * stacked underneath it on a phone. The frame owns its own scrolling
         * and the Expand control, so the card is never clipped by the viewport
         * and never forces the page to scroll sideways.
         */}
        <div className="lg:col-span-3 pb-8">
          <PreviewFrame
            title={`Report card preview — ${student?.name ?? ''}${student?.rollNo ? ` (Roll ${student.rollNo})` : ''}`}
            caption={`Theme: ${theme.name} · ${idx + 1} of ${students.length}`}
          >
            <ReportCardPreview student={student} school={school} photoDataUrl={photo} />
          </PreviewFrame>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="card">
      <div className="card-body py-16 text-center text-ink-500">
        <Eye className="h-10 w-10 mx-auto text-ink-300 mb-3" />
        <h3 className="text-lg font-semibold text-ink-800">No students loaded yet</h3>
        <p className="text-sm mt-1 max-w-md mx-auto">
          Complete the &ldquo;Import Students&rdquo; workflow first. You will then be able to preview
          each student report card in this tab before final generation.
        </p>
      </div>
    </div>
  );
}

function SumRow({
  label,
  value,
  strong,
  highlight,
}: {
  label: string;
  value: string;
  strong?: boolean;
  highlight?: boolean;
}) {
  let cls = 'text-ink-800';
  if (highlight) cls = 'text-emerald-700 font-bold';
  else if (strong) cls = 'text-ink-900 font-bold';
  return (
    <div className="flex justify-between border-b border-slate-100 py-1.5">
      <span className="text-ink-500">{label}</span>
      <span className={cls}>{value}</span>
    </div>
  );
}
