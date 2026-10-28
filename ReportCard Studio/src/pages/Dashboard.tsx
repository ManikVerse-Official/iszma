import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAppStore } from '../store/appStore';
import { useEntitlement } from '../store/entitlementStore';
import { FREE_USE_LIMIT, getPlanById } from '../config/plans';
import {
  ArrowRight,
  Upload,
  GraduationCap,
  FileText,
  Printer,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';

export default function Dashboard() {
  const schoolProfile = useAppStore((s) => s.schoolProfile);
  const workbook = useAppStore((s) => s.workbook);
  const students = useAppStore((s) => s.students);
  const validation = useAppStore((s) => s.validation);
  const gen = useAppStore((s) => s.generation);
  const { isAdmin, planActive, planId, freeUsesRemaining, account, refreshFromServer } =
    useEntitlement();
  const activePlan = getPlanById(planId);

  /*
   * The dashboard is where the owner lands, and admin status is a server answer
   * (the bridged Ishmaverse session). Re-check on mount and whenever the
   * signed-in email changes so the banner reflects it immediately instead of
   * waiting for a generation attempt.
   */
  const accountEmail = account?.email ?? '';
  useEffect(() => {
    void refreshFromServer();
  }, [accountEmail, refreshFromServer]);

  const schoolReady = Boolean(schoolProfile.schoolName && schoolProfile.academicSession && schoolProfile.examTerm);
  const dataReady = students.length > 0;
  const validationReady = validation !== null;
  const generationRan = gen.status !== 'idle';

  const quickActions = [
    { to: '/school-profile', label: 'Set up School Profile', icon: GraduationCap, desc: 'Name, logo, signatures, session', done: schoolReady },
    { to: '/import', label: 'Import Students Excel', icon: Upload, desc: 'Upload .xlsx / .xls / .csv, map columns', done: dataReady },
    { to: '/template', label: 'Preview Report Template', icon: FileText, desc: 'See how the report card looks', done: dataReady },
    { to: '/generate', label: 'Generate & Download', icon: Printer, desc: 'PDF per student + ZIP bundle', done: generationRan && gen.status === 'complete' },
  ];

  return (
    <div className="space-y-6">
      <section className="card">
        <div className="card-header">
          <h2 className="text-lg font-semibold text-ink-900">Welcome to ReportCard Studio</h2>
          <p className="text-sm text-ink-500 mt-1">
            Excel In. Professional Report Cards Out.
          </p>
        </div>
        <div className="card-body">
          <p className="text-sm text-ink-700 leading-relaxed">
            Upload a student Excel sheet, map your columns to dynamic subjects, validate every record,
            then generate an individual PDF report card for every student — packaged automatically into a single ZIP.
          </p>
        </div>
      </section>

      {/* Plan / usage summary */}
      <section className="card">
        <div className="card-body flex flex-wrap items-center justify-between gap-3 text-sm">
          {isAdmin ? (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-lg px-4 py-3 font-semibold w-full">
              Admin: Unlimited
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 text-ink-700">
                {planActive && activePlan ? (
                  <span>
                    <strong>{activePlan.name}</strong> plan active — unlimited report cards for 6 months.
                  </span>
                ) : (
                  <span>
                    <strong>{freeUsesRemaining}</strong> of {FREE_USE_LIMIT} free generations left ·
                    signed in as <strong>{account?.email}</strong>.
                  </span>
                )}
              </div>
              {!planActive && (
                <Link
                  to="/pricing"
                  className="shrink-0 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 text-white px-4 py-2 text-xs font-semibold hover:bg-brand-700"
                >
                  {freeUsesRemaining > 0 ? 'See plans' : 'Subscribe now'}
                </Link>
              )}
            </>
          )}
        </div>
      </section>

      <section className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Students Loaded"
          value={students.length || '—'}
          sub={workbook ? workbook.fileName : 'No file uploaded yet'}
          tone={students.length ? 'brand' : 'neutral'}
        />
        <StatCard
          label="Validation"
          value={validationReady ? (validation?.isValid ? 'PASSED' : 'ISSUES') : 'Not run'}
          sub={validationReady ? `${validation?.errorCount ?? 0} errors · ${validation?.warningCount ?? 0} warnings` : 'Validate after import'}
          tone={!validationReady ? 'neutral' : validation?.isValid ? 'success' : 'error'}
        />
        <StatCard
          label="Dynamic Subjects"
          value={students[0]?.subjects.length ?? 0}
          sub={students[0]?.subjects.map((s) => s.name).join(', ') || 'Detected from Excel mapping'}
          tone="brand"
        />
        <StatCard
          label="Last Generation"
          value={
            !generationRan
              ? 'Not run'
              : gen.status === 'running'
              ? 'In progress...'
              : gen.status === 'complete'
              ? 'Complete'
              : 'Halted'
          }
          sub={generationRan ? `${gen.completed} done · ${gen.failed} failed` : 'Run after validation passes'}
          tone={gen.status === 'complete' && gen.failed === 0 ? 'success' : gen.failed > 0 ? 'error' : 'neutral'}
        />
      </section>

      <section>
        <h3 className="text-sm font-semibold text-ink-800 mb-3">Get Started</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {quickActions.map((a, i) => {
            const Icon = a.icon;
            return (
              <Link key={a.to} to={a.to} className="card hover:border-brand-300 transition-colors">
                <div className="card-body flex items-start gap-4">
                  <div
                    className={`h-10 w-10 rounded-lg flex items-center justify-center shrink-0 ${
                      a.done ? 'bg-emerald-50 text-emerald-600' : 'bg-brand-50 text-brand-600'
                    }`}
                  >
                    {a.done ? <CheckCircle2 className="h-5 w-5" /> : <Icon className="h-5 w-5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-bold text-ink-500">STEP {i + 1}</span>
                    </div>
                    <h4 className="font-semibold text-ink-900 mt-0.5">{a.label}</h4>
                    <p className="text-sm text-ink-500 mt-0.5">{a.desc}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 text-ink-400 shrink-0 mt-2" />
                </div>
              </Link>
            );
          })}
        </div>
      </section>

      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card lg:col-span-2">
          <div className="card-header flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-ink-500" />
            <h3 className="font-semibold text-ink-900">How does it work?</h3>
          </div>
          <div className="card-body text-sm text-ink-700 space-y-2 leading-relaxed">
            <p>
              <span className="font-semibold">1. School Profile:</span> Fill in your school name, address, upload logo and signatures.
              Saved locally in your browser.
            </p>
            <p>
              <span className="font-semibold">2. Import Students:</span> Drop your Excel/CSV file. Columns are auto-mapped to name, roll no,
              parents, attendance, and <strong>dynamic subjects</strong>. Manual override is available.
            </p>
            <p>
              <span className="font-semibold">3. Preview & Validate:</span> Review detected students, fix validation
              errors (missing names, duplicate rolls, out-of-range marks).
            </p>
            <p>
              <span className="font-semibold">4. Generate:</span> Pick validated students and generate one PDF per
              student. All reports are bundled into one ZIP.
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-header">
            <h3 className="font-semibold text-ink-900">Sample Excel Format</h3>
          </div>
          <div className="card-body text-xs text-ink-700 overflow-x-auto">
            <table className="w-full whitespace-nowrap">
              <thead>
                <tr className="border-b border-slate-200">
                  {['Roll', 'Name', 'Class', 'Section', 'English', 'Maths', 'Science', 'Attendance'].map((c) => (
                    <th key={c} className="text-left py-1.5 pr-3 font-semibold text-ink-800">{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ['01', 'Aarav Sharma', '8', 'A', '92', '88', '95', '96%'],
                  ['02', 'Ananya Singh', '8', 'A', '95', 'AB', '90', '92%'],
                  ['03', 'Riya Verma', '8', 'A', '78', '82', 'EX', '89%'],
                ].map((r, i) => (
                  <tr key={i} className="border-b border-slate-100">
                    {r.map((c, j) => (
                      <td key={j} className="py-1.5 pr-3">{c}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-ink-500">
              Subjects are NOT hard-coded. Add any subjects — Science, Sanskrit, GK, IT — they are detected and mapped automatically.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone: 'brand' | 'success' | 'error' | 'neutral';
}) {
  const toneCls = {
    brand: 'text-brand-700',
    success: 'text-emerald-700',
    error: 'text-red-700',
    neutral: 'text-ink-800',
  }[tone];
  return (
    <div className="card">
      <div className="card-body">
        <div className="text-xs font-semibold uppercase tracking-wide text-ink-500">{label}</div>
        <div className={`text-2xl font-bold mt-1 ${toneCls}`}>{value}</div>
        {sub && <div className="text-xs text-ink-500 mt-1 line-clamp-2">{sub}</div>}
      </div>
    </div>
  );
}
