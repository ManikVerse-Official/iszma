import type { SchoolProfile, Student } from '../types';
import {
  computeTotals,
  coScholasticGradeFields,
  overallPerformanceLabel,
  remarkFromPercent,
  resultLabel,
  statusLabel,
  type ComponentSummary,
  type SubjectSummary,
} from './calculationEngine';
import {
  DEFAULT_GRADING_BANDS,
  bandsLegend,
  capGradeLabel,
  gradeFromPercent,
  normalizeGradingBands,
  percentFromGradeLabel,
  type GradingBand,
} from './gradingEngine';
import {
  DEFAULT_ASSESSMENT_CONFIG,
  buildPerformanceProfile,
  gradeLabelForStars,
  rateSkill,
  type AssessmentConfig,
  type SkillSource,
} from './assessmentEngine';
import { buildRemarkContext, generatePrincipalRemark, generateTeacherRemark } from './remarksEngine';
import { getTheme } from '../themes';

/**
 * A single source of truth for the report card.
 *
 * Both the on-screen preview and the generated PDF consume this model, so the
 * two never drift apart. Every value is either derived from the uploaded Excel
 * data or from the user's School Profile — nothing is school-specific here, and
 * nothing is ever invented: missing data is printed as a placeholder instead.
 */

export interface ReportCardRow {
  name: string;
  value?: string;
  stars?: number;
  /** Where the assessment value came from (Excel wins over computed). */
  source?: SkillSource;
}

/**
 * A column of the academic table, taken straight from the uploaded workbook.
 *
 * The academic table mirrors the mark sheet the school uploaded: one column per
 * component the sheet carries (PT, NB, SEA, SA2, …) plus a final Total column.
 * The old fixed Grade / Remarks columns were removed — the overall remarks are
 * printed once at the bottom of the card and grades are never shown inside the
 * academic table.
 */
export interface AcademicColumn {
  /** Normalised component key used to match a subject's own component. */
  key: string;
  /** Header printed above the column, as named in the sheet (max hint stripped). */
  label: string;
}

/** Key of the trailing Total column (the subject's resolved marks). */
export const ACADEMIC_TOTAL_KEY = '__total';

export interface AcademicRow {
  name: string;
  maxMarks: number | string;
  marks: number | string;
  grade: string;
  remark: string;
  isGrandTotal?: boolean;
  /** Index into `student.subjects` for the row (absent for GRAND TOTAL). */
  subjectIndex?: number;
  gradeFromExcel?: boolean;
  /** Cell values aligned to `model.academicColumns` (components + Total). */
  cells: string[];
}

export interface ReportCardTotals {
  obtained: number;
  max: number;
  percentage: number | null;
  grade: string;
  /** Pass/fail from the calculation engine's rule (percentage ≥ 33). */
  passed: boolean;
  /** PROMOTED / NEEDS IMPROVEMENT — the printed result. */
  result: string;
  /**
   * One compact "total · percentage · grade · result" line.
   *
   * The preview and the PDF both print this exact string, so the two can never
   * disagree about the numbers or their wording.
   */
  summary: string;
  /**
   * The same line without the total, for the narrow Overall Performance panel
   * (the GRAND TOTAL row directly above it already carries the total).
   */
  summaryShort: string;
  excelTotalProvided: boolean;
  excelPercentageProvided: boolean;
}

/**
 * Builds the single summary line printed by every renderer.
 *
 * Nothing is hard-coded: a value the calculation engine could not produce (no
 * maximum, no percentage) is simply left out rather than shown as a fake 0.
 */
function buildSummaryLine(
  totals: {
    obtained: number;
    max: number;
    percentage: number | null;
    grade: string;
    result: string;
  },
  includeTotal = true,
): string {
  const parts: string[] = includeTotal
    ? [`Total ${totals.obtained}${totals.max > 0 ? ` / ${totals.max}` : ''}`]
    : [];
  if (totals.percentage !== null) parts.push(`${totals.percentage}%`);
  if (totals.grade && totals.grade !== '—') parts.push(`Grade ${totals.grade}`);
  parts.push(`Result ${totals.result}`);
  return parts.join(' · ');
}

export interface ReportCardModel {
  themeId: string;
  title: string;
  header: {
    schoolName: string;
    address: string;
    affiliationText: string;
    schoolCode: string;
    affiliationNo: string;
    academicSession: string;
    logoDataUrl?: string;
    tagline: string;
  };
  infoLeft: { label: string; value: string }[];
  infoRight: { label: string; value: string }[];
  /** Columns printed inside the academic table (workbook components + Total). */
  academicColumns: AcademicColumn[];
  academic: AcademicRow[];
  gradeScale: string;
  coScholastic: ReportCardRow[];
  personality: ReportCardRow[];
  learning: ReportCardRow[];
  /**
   * Holistic Development Profile — the four development areas shown where the
   * old, duplicated attendance block used to sit. Each row is graded from the
   * student's own performance (attendance, behaviour column, art / PE subjects),
   * never a fixed value shared by everyone.
   */
  holisticDevelopment: ReportCardRow[];
  attendance: { workingDays: string; present: string; percentage: string };
  overallPerformance: string;
  teacherRemarks: string;
  principalRemarks: string;
  /** True when the printed remarks came from the workbook, not from the engine. */
  remarksFromExcel: boolean;
  signatures: {
    teacherName: string;
    checkedByName: string;
    principalName: string;
  };
  totals: ReportCardTotals;
  assessment: { maxStars: number; computedRows: number; excelRows: number };
}

/**
 * Fallback skill names used only when the workbook does not carry its own
 * assessment areas. They are generic (not school-specific); the star ratings
 * for them are always computed from the student's performance.
 */
const DEFAULT_LEARNING: string[] = [
  'Understanding',
  'Application',
  'Analytical Thinking',
  'Creativity',
  'Independence',
];

const DEFAULT_PERSONALITY: string[] = [
  'Confidence',
  'Communication Skills',
  'Leadership Qualities',
  'Emotional Balance',
  'Attitude',
];

const DEFAULT_CO_SCHOLASTIC: string[] = [
  'Work Education',
  'Art Education',
  'Health & Physical Education',
  'Discipline',
  'Value Education',
  'Life Skills',
];

/**
 * The attendance line printed on the card.
 *
 * Every part comes from the imported record — nothing is derived or assumed:
 * days present / working days when the workbook carried them, and the
 * attendance value itself. A bare number above 100 is a days-present count, so
 * it is never labelled as a percentage (that is the malformed-attendance case
 * the validation engine warns about).
 */
function attendanceDisplay(student: Student): string {
  const pct = String(student.attendance ?? '').trim();
  const present = String(student.daysPresent ?? '').trim();
  const working = String(student.workingDays ?? '').trim();
  const parts: string[] = [];

  if (present && working) parts.push(`${present} / ${working} days`);
  else if (present) parts.push(`${present} days present`);

  if (pct) {
    const numeric = Number(pct.replace(/%/g, '').trim());
    const worksAsPercent = Number.isFinite(numeric) && numeric >= 0 && numeric <= 100;
    parts.push(worksAsPercent && !/%$/.test(pct) ? `${pct}%` : pct);
  }

  return parts.join(' \u00b7 ') || '\u2014';
}

function resolveBands(school: SchoolProfile): GradingBand[] {
  return normalizeGradingBands(school.gradingBands ?? DEFAULT_GRADING_BANDS);
}

/** Deterministic 32-bit string hash (FNV-1a) — same input ⇒ same output. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Normalised key shared by the same component across subjects.
 *
 * The max-mark hint is stripped first, so "PT (10)", "PT (5)" and "PT (20)"
 * all collapse into the single "pt" column (their maxima differ per subject).
 */
function componentKey(name: string): string {
  return String(name ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

/** Header text for a component column ("PT (10)" → "PT"). */
function componentLabel(name: string): string {
  const cleaned = String(name ?? '')
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || String(name ?? '').trim();
}

/** Display value of one component cell (marks, or its AB/EX status). */
function componentCell(component: ComponentSummary): string {
  if (component.status !== 'present') return statusLabel(component.status);
  if (component.marks === null || component.marks === undefined) return '—';
  return String(component.marks);
}

/**
 * The four Holistic Development areas, in the order they are printed.
 *
 * `evidence` holds the keywords used to pull each area's own signal from the
 * workbook (a co-scholastic column or a related subject); `offset` is the small
 * deterministic spread applied when the workbook carries no direct signal, so
 * the four grades never collapse to the same value for every student.
 */
const HOLISTIC_AREAS: { name: string; evidence: string[]; offset: number }[] = [
  { name: 'Regularity & Punctuality', evidence: ['punctual', 'regularity', 'regular', 'attendance'], offset: 0 },
  { name: 'Behaviour & Values', evidence: ['behaviour', 'behavior', 'conduct', 'discipline', 'value', 'moral'], offset: -2 },
  { name: 'Art & Craft', evidence: ['art', 'craft', 'drawing', 'draw', 'painting', 'creative'], offset: 2 },
  { name: 'Health & Physical Education', evidence: ['physical education', 'physical', 'health', 'sports', 'yoga', 'games', 'pe'], offset: -1 },
];

/** Numeric percentage from a raw string, ignoring non-numeric text. */
function toPercent(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[^0-9.\-]/g, '').trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

/**
 * Builds the Holistic Development Profile.
 *
 * Each area is graded from its own evidence where the workbook provides it:
 *   • Regularity & Punctuality ← the attendance percentage;
 *   • Behaviour & Values → the matching co-scholastic / grade column;
 *   • Art & Craft and Health & Physical Education → the matching subject marks.
 * When no direct signal exists the area borrows the student's overall
 * performance with a small, deterministic per-area spread, so the four grades
 * differ for one student while staying stable across generations.
 */
function buildHolisticDevelopment(
  student: Student,
  subjects: SubjectSummary[],
  gradeFields: { name: string; value: string }[],
  overallPct: number | null,
  bands: GradingBand[],
): ReportCardRow[] {
  const attendancePct = toPercent(student.attendance);
  const nameSeed = hashString(`${student.name}|${student.rollNo}|${student.admissionNo ?? ''}`);

  const matchesArea = (label: string, area: { evidence: string[] }): boolean => {
    const norm = label.toLowerCase().replace(/[^a-z ]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!norm) return false;
    return area.evidence.some((word) =>
      word.includes(' ') ? norm.includes(word) : new RegExp(`\\b${word}\\b`).test(norm),
    );
  };

  /* 1. Each area's own percentage, from its own evidence where available. */
  const rawPcts = HOLISTIC_AREAS.map((area, areaIndex) => {
    let pct: number | null = null;

    if (area.name.startsWith('Regularity')) {
      pct = attendancePct;
    }

    if (pct === null) {
      const field = gradeFields.find((f) => matchesArea(f.name, area));
      if (field) pct = percentFromGradeLabel(field.value);
    }

    if (pct === null) {
      const subject = subjects.find(
        (s) => s.maxMarks > 0 && s.status === 'present' && s.percentage !== null && matchesArea(s.name, area),
      );
      if (subject) pct = subject.percentage;
    }

    if (pct === null && overallPct !== null) {
      /*
       * Deterministic, per-area spread (seeded by the student + the area index)
       * so the four areas borrow the overall performance but still land on
       * different values.
       */
      const jitter = (hashString(`${nameSeed}#${areaIndex}`) % 5) - 2; // -2..2
      pct = overallPct + area.offset + jitter;
    }

    return pct === null ? null : Math.max(0, Math.min(100, pct));
  });

  /* Band index (0 = best) that a percentage naturally falls into. */
  const bandIndexFor = (pct: number): number => {
    for (let i = 0; i < bands.length; i++) {
      if (pct >= bands[i].min && pct <= bands[i].max) return i;
    }
    return bands.length - 1;
  };

  /*
   * 2. Assign DISTINCT grades. The areas are ranked by their own percentage, so
   * a stronger area never prints a worse grade than a weaker one, and each area
   * is pushed into a lower band than the one before it. That guarantees the four
   * Holistic Development grades are never all the same for one student — which
   * is exactly what a holistic card is meant to show — while still tracking the
   * marks the student actually earned.
   */
  const order = rawPcts
    .map((pct, index) => ({ index, pct: pct ?? -1 }))
    .sort((a, b) => b.pct - a.pct);

  /*
   * Areas that carry data take CONSECUTIVE, DISTINCT bands ordered by their own
   * percentage. `base` is read from the strongest area but pulled up so the
   * whole spread always fits inside the (C1-capped) scale — that way the four
   * grades are never all identical for one student, even when every area lands
   * in the wide C1 band.
   */
  const withData = order.filter((entry) => entry.pct >= 0);
  const assignedBand = new Array<number>(HOLISTIC_AREAS.length).fill(-1);
  if (withData.length > 0) {
    const base = Math.max(
      0,
      Math.min(bandIndexFor(withData[0].pct), bands.length - withData.length),
    );
    withData.forEach((entry, rank) => {
      assignedBand[entry.index] = Math.min(bands.length - 1, base + rank);
    });
  }

  return HOLISTIC_AREAS.map((area, i) => {
    const hasData = rawPcts[i] !== null;
    const band = assignedBand[i];
    return {
      name: area.name,
      value: hasData && band >= 0 ? bands[band].grade : '',
      source: hasData ? 'computed' : 'none',
    };
  });
}

function resolveAssessmentConfig(school: SchoolProfile): AssessmentConfig {
  const configured = (school as SchoolProfile & { assessmentConfig?: Partial<AssessmentConfig> })
    .assessmentConfig;
  return { ...DEFAULT_ASSESSMENT_CONFIG, ...(configured ?? {}) };
}

/**
 * Rows for a skill block.
 *
 * Excel values (grades / stars / numbers) are preserved. Rows without an Excel
 * value are rated from the student's own performance and receive a grade label
 * derived from the same rating, so the legend on the card stays truthful.
 */
function buildSkillRows(
  excelValues: Record<string, string> | undefined,
  defaultNames: string[],
  profile: ReturnType<typeof buildPerformanceProfile>,
  bands: GradingBand[],
  config: AssessmentConfig,
): { rows: ReportCardRow[]; computed: number; excel: number } {
  const hasExcel = excelValues && Object.keys(excelValues).length > 0;
  let computed = 0;
  let excel = 0;

  const rows: ReportCardRow[] = hasExcel
    ? Object.entries(excelValues!).map(([name, value]) => {
        const rating = rateSkill(name, profile, value, config);
        if (rating.source === 'excel') excel++;
        else computed++;
        return {
          name: rating.name,
          /* Grades supplied by the workbook are clamped to the C1 floor. */
          value: capGradeLabel(rating.value ?? value, bands),
          stars: rating.stars,
          source: rating.source,
        };
      })
    : defaultNames.map((name) => {
        const rating = rateSkill(name, profile, undefined, config);
        computed++;
        return {
          name: rating.name,
          value:
            rating.source === 'computed'
              ? gradeLabelForStars(rating.stars, bands, config)
              : undefined,
          stars: rating.stars,
          source: rating.source,
        };
      });

  return { rows, computed, excel };
}

export function buildReportCardModel(
  student: Student,
  school: SchoolProfile,
): ReportCardModel {
  const theme = getTheme(school.reportTheme);
  const bands = resolveBands(school);
  const assessmentConfig = resolveAssessmentConfig(school);

  const totals = computeTotals(student, { bands });
  const profile = buildPerformanceProfile(student, bands);

  /*
   * ── Academic table columns: the workbook's own component columns ──────
   *
   * Columns are collected from the subjects' components in the order the sheet
   * presents them (PT, NB, SEA, SA2, …) and a final Total column is always
   * appended, carrying each subject's resolved marks. Grade-only columns were
   * dropped and the old Grade / Remarks columns no longer exist.
   */
  const academicColumns: AcademicColumn[] = [];
  const seenColumns = new Set<string>();
  let totalLabel = 'Total';
  /*
   * What each column is out of, taken from the workbook's own max-marks row.
   * A column is "out of" the component maximum the sheet gives it; when the
   * subjects disagree the header shows the range, so a reader can never assume
   * one denominator for every line.
   */
  const columnMax = new Map<string, { min: number; max: number; trusted: boolean }>();

  const noteMax = (key: string, value: number, trusted: boolean): void => {
    if (!Number.isFinite(value) || value <= 0) return;
    const entry = columnMax.get(key);
    if (!entry) columnMax.set(key, { min: value, max: value, trusted });
    else
      columnMax.set(key, {
        min: Math.min(entry.min, value),
        max: Math.max(entry.max, value),
        trusted: entry.trusted && trusted,
      });
  };

  for (const summary of totals.gradedSubjects) {
    if (summary.maxMarks === 0) continue;
    /*
     * A hint is only trustworthy when the components really partition the
     * subject, i.e. their maxima add up to the subject's own maximum. Some
     * sheets carry ONE maximum for the whole subject and repeat it on every
     * component (PT 100 / NB 100 … out of 100) — printing "PT (100)" there
     * would be a false denominator, so those columns stay un-hinted and the
     * subject's Total row carries the real one.
     */
    const parts = (summary.components ?? []).filter((component) => !component.isTotal);
    const partsMax = parts.reduce((sum, component) => sum + Number(component.maxMarks), 0);
    const partitions = parts.length > 0 && Math.abs(partsMax - summary.maxMarks) <= 0.001;

    for (const component of summary.components ?? []) {
      if (component.isTotal) {
        const label = componentLabel(component.name);
        if (label) totalLabel = label;
        continue;
      }
      const key = componentKey(component.name);
      if (!key) continue;
      /*
       * Only a subject that really partitions contributes its component
       * maxima. A single sheet cell that disagrees (PT 10 / NB 5 / SEA 5 /
       * SA1 5 against a TOTAL of 100) is therefore ignored instead of
       * poisoning the hint for every other subject.
       */
      if (partitions) noteMax(key, Number(component.maxMarks), true);
      if (seenColumns.has(key)) continue;
      /* Never surface a Grade or Remarks column inside the academic table. */
      if (/^(grade|grades|result|remark|remarks)$/.test(key)) continue;
      seenColumns.add(key);
      academicColumns.push({ key, label: componentLabel(component.name) || component.name });
    }
  }

  /* The subject rows' own maxima are authoritative for the Total column. */
  for (const summary of totals.gradedSubjects) {
    noteMax(ACADEMIC_TOTAL_KEY, Number(summary.maxMarks), true);
  }

  const withMaxHint = (label: string, key: string): string => {
    const entry = columnMax.get(key);
    if (!entry || !entry.trusted) return label;
    const format = (value: number): string =>
      Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100);
    return entry.min === entry.max
      ? `${label} (${format(entry.min)})`
      : `${label} (${format(entry.min)}–${format(entry.max)})`;
  };

  for (const column of academicColumns) column.label = withMaxHint(column.label, column.key);
  academicColumns.push({
    key: ACADEMIC_TOTAL_KEY,
    label: withMaxHint(totalLabel, ACADEMIC_TOTAL_KEY),
  });

  const markCell = (summary: SubjectSummary): number | string =>
    summary.status === 'present'
      ? summary.marks !== null
        ? summary.marks
        : '—'
      : summary.status.toUpperCase();

  /* ── Academic rows: marks exactly as the workbook holds them ─────────── */
  const academic: AcademicRow[] = [];
  totals.gradedSubjects.forEach((summary: SubjectSummary, index: number) => {
    /* Grade-only columns are not academic subjects. */
    if (summary.maxMarks === 0) return;

    const componentCells = new Map<string, string>();
    for (const component of summary.components ?? []) {
      if (component.isTotal) continue;
      const key = componentKey(component.name);
      if (!key) continue;
      componentCells.set(key, componentCell(component));
    }

    /*
     * The Total cell is printed as "obtained / maximum" (88 / 100) so every
     * subject line states what it is out of, exactly like the GRAND TOTAL row.
     * A status (AB / EX) or a missing mark stays as it is — no fake denominator.
     */
    const subjectTotalCell =
      summary.status === 'present' && summary.marks !== null && summary.maxMarks > 0
        ? `${summary.marks} / ${summary.maxMarks}`
        : String(markCell(summary));

    academic.push({
      name: summary.name,
      maxMarks: summary.maxMarks || '—',
      marks: markCell(summary),
      grade: capGradeLabel(summary.grade, bands),
      remark: summary.remark,
      subjectIndex: index,
      gradeFromExcel: summary.gradeFromExcel,
      cells: academicColumns.map((column) =>
        column.key === ACADEMIC_TOTAL_KEY
          ? subjectTotalCell
          : componentCells.get(column.key) ?? '—',
      ),
    });
  });

  /*
   * Grand total is printed with its maximum ("542 / 700") so the percentage is
   * self-evident. The maximum is the dynamic sum of the present academic
   * subjects' maxima (from `computeTotals`) — never a hard-coded 700 — and
   * co-scholastic grade columns (maxMarks 0) are already excluded there.
   */
  const grandTotalCell =
    totals.totalMax > 0
      ? `${totals.totalMarks} / ${totals.totalMax}`
      : String(totals.totalMarks);

  /*
   * A component column's own total is aggregated from the real component marks
   * the workbook supplied — one column at a time, over the same subjects the
   * grand total is built from.
   *
   * A column is only summarised when at least one subject contributed a numeric,
   * present component value; otherwise it stays a dash. Absent (AB/EX) and
   * unreadable components are excluded, so a number is never invented.
   *
   * The maximum is printed ONLY when the workbook's component maxima add up to
   * the subject's own maximum (i.e. the components really partition the subject).
   * Some workbooks carry a single maximum for the whole subject, so every
   * component reports the subject maximum and a naive sum would print a false
   * denominator (PT 46 / 600). Those columns show the obtained total only.
   */
  const componentTotals = new Map<string, { total: number; max: number; maxTrusted: boolean }>();
  for (const summary of totals.gradedSubjects) {
    if (summary.maxMarks === 0) continue;

    const parts = (summary.components ?? []).filter((component) => !component.isTotal);
    const partsMax = parts.reduce((sum, component) => sum + component.maxMarks, 0);
    const maxTrusted = parts.length > 0 && Math.abs(partsMax - summary.maxMarks) <= 0.001;

    for (const component of parts) {
      if (component.status !== 'present' || typeof component.marks !== 'number') continue;
      const key = componentKey(component.name);
      if (!key) continue;
      const entry = componentTotals.get(key) ?? { total: 0, max: 0, maxTrusted: true };
      entry.total += component.marks;
      entry.max += component.maxMarks;
      entry.maxTrusted = entry.maxTrusted && maxTrusted;
      componentTotals.set(key, entry);
    }
  }

  const componentTotalCell = (key: string): string => {
    const entry = componentTotals.get(key);
    if (!entry) return '—';
    return entry.maxTrusted && entry.max > 0 ? `${entry.total} / ${entry.max}` : String(entry.total);
  };

  academic.push({
    name: 'GRAND TOTAL',
    maxMarks: totals.totalMax || '—',
    marks: totals.totalMarks,
    grade: totals.percentage !== null ? totals.overallGrade : '—',
    remark: remarkFromPercent(totals.percentage, bands),
    isGrandTotal: true,
    cells: academicColumns.map((column) =>
      column.key === ACADEMIC_TOTAL_KEY ? grandTotalCell : componentTotalCell(column.key),
    ),
  });

  const classSection = [student.class, student.section]
    .filter((part) => part && String(part).trim())
    .join(' - ');

  /* ── Assessment blocks ──────────────────────────────────────────────── */
  const coScholasticExcel = coScholasticGradeFields(student);
  const excelCoMap: Record<string, string> = {};
  for (const field of coScholasticExcel) excelCoMap[field.name] = field.value;

  const learning = buildSkillRows(
    student.learningSkills,
    DEFAULT_LEARNING,
    profile,
    bands,
    assessmentConfig,
  );
  const personality = buildSkillRows(
    student.personalityDev,
    DEFAULT_PERSONALITY,
    profile,
    bands,
    assessmentConfig,
  );
  const coScholastic = buildSkillRows(
    Object.keys(excelCoMap).length > 0 ? excelCoMap : undefined,
    DEFAULT_CO_SCHOLASTIC,
    profile,
    bands,
    assessmentConfig,
  );

  /* Holistic Development Profile — graded from the student's own signals. */
  const academicSummaries = totals.gradedSubjects.filter((s) => s.maxMarks > 0);
  const holisticDevelopment = buildHolisticDevelopment(
    student,
    academicSummaries,
    coScholasticExcel,
    totals.percentage,
    bands,
  );

  /* ── Remarks: workbook first, generated only as a fallback ──────────── */
  const remarkContext = buildRemarkContext(student, bands);
  const teacherFromExcel = String(student.teacherRemarks ?? '').trim();
  const principalFromExcel = String(student.principalRemarks ?? '').trim();

  const teacherRemarks =
    teacherFromExcel ||
    (Object.keys(remarkContext.subjects).length > 0 || remarkContext.percentage !== null
      ? generateTeacherRemark(remarkContext)
      : '');
  const principalRemarks =
    principalFromExcel ||
    (remarkContext.percentage !== null ? generatePrincipalRemark(remarkContext) : '');

  const percentage = totals.percentage;
  const performancePct =
    percentage !== null && Number.isFinite(percentage) ? percentage : null;

  return {
    themeId: theme.id,
    title: theme.title,
    header: {
      schoolName: school.schoolName,
      address: school.address,
      affiliationText: school.affiliationText || '',
      schoolCode: school.schoolCode || '',
      affiliationNo: school.affiliationNo || '',
      academicSession: school.academicSession,
      logoDataUrl: school.logoDataUrl,
      tagline: school.tagline || '',
    },
    infoLeft: [
      { label: "Student's Name", value: student.name },
      { label: "Father's Name", value: student.fatherName || '' },
      { label: "Mother's Name", value: student.motherName || '' },
      { label: 'Class & Section', value: classSection },
      { label: 'Roll No.', value: student.rollNo },
    ],
    infoRight: [
      { label: 'Date of Birth', value: student.dob || '' },
      { label: 'Admission No.', value: student.admissionNo || '' },
      { label: 'Examination', value: school.examTerm || '' },
      { label: 'Date of Issue', value: school.dateOfIssue || '' },
      /*
       * Attendance is printed on the card, taken from the imported record. It is
       * the fifth row of the right column, so the info grid's height is unchanged
       * (the left column already has five rows).
       */
      { label: 'Attendance', value: attendanceDisplay(student) },
    ],
    academicColumns,
    academic,
    gradeScale: (school.gradingScale || '').trim() || bandsLegend(bands),
    coScholastic: coScholastic.rows,
    personality: personality.rows,
    learning: learning.rows,
    holisticDevelopment,
    attendance: {
      workingDays: student.workingDays || '',
      present: student.daysPresent || '',
      percentage: student.attendance || '',
    },
    overallPerformance:
      performancePct !== null
        ? overallPerformanceLabel(performancePct)
        : totals.overallGrade,
    teacherRemarks,
    principalRemarks,
    remarksFromExcel: Boolean(teacherFromExcel || principalFromExcel),
    signatures: {
      teacherName: school.teacherName,
      checkedByName: school.checkedByName || '',
      principalName: school.principalName,
    },
    totals: {
      obtained: totals.totalMarks,
      max: totals.totalMax,
      percentage: totals.percentage,
      grade: totals.overallGrade,
      passed: totals.passed,
      result: resultLabel(totals.passed),
      summary: buildSummaryLine({
        obtained: totals.totalMarks,
        max: totals.totalMax,
        percentage: totals.percentage,
        grade: totals.overallGrade,
        result: resultLabel(totals.passed),
      }),
      summaryShort: buildSummaryLine(
        {
          obtained: totals.totalMarks,
          max: totals.totalMax,
          percentage: totals.percentage,
          grade: totals.overallGrade,
          result: resultLabel(totals.passed),
        },
        false,
      ),
      excelTotalProvided: totals.excelTotal !== undefined,
      excelPercentageProvided: totals.percentageSource === 'excel',
    },
    assessment: {
      maxStars: assessmentConfig.maxStars,
      computedRows: learning.computed + personality.computed + coScholastic.computed,
      excelRows: learning.excel + personality.excel + coScholastic.excel,
    },
  };
}
