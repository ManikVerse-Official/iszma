import type { Student, SubjectMark, SubjectComponent } from '../types';
import {
  DEFAULT_GRADING_BANDS,
  UNGRADED_LABEL,
  gradeFromMarksOutOf,
  gradeFromPercent,
  normalizeGradingBands,
  remarkFromPercent,
  type GradingBand,
} from './gradingEngine';

export type GradeSource = 'excel' | 'computed' | 'status';

export interface SubjectSummary {
  name: string;
  marks: number | null;
  maxMarks: number;
  status: SubjectMark['status'];
  grade: string;
  remark: string;
  components?: ComponentSummary[];
  /** Percentage of the subject's own maximum (max marks may be 25/50/80/100/…). */
  percentage: number | null;
  /** True when the grade printed came from the uploaded Excel file. */
  gradeFromExcel: boolean;
  source: GradeSource;
}

export interface ComponentSummary {
  name: string;
  marks: number | null;
  maxMarks: number;
  status: SubjectComponent['status'];
  grade: string;
  isTotal: boolean;
}

export interface ReportTotals {
  totalMarks: number;
  totalMax: number;
  percentage: number | null;
  overallGrade: string;
  passed: boolean;
  presentSubjects: number;
  gradedSubjects: SubjectSummary[];
  /** Excel-provided grand total, when the workbook carried one. */
  excelTotal?: number;
  /** Excel-provided percentage, when the workbook carried one. */
  excelPercentage?: number;
  /** Where the printed percentage came from. */
  percentageSource: 'excel' | 'computed' | 'none';
  /** Excel percentage that was rejected because it contradicted its own marks. */
  ignoredExcelPercentage?: number;
}

export interface TotalsOptions {
  bands?: GradingBand[] | null;
}

/** Percentage of `total` out of `max` (never assumes max is 100 or 600). */
export function computePercentage(total: number, max: number): number | null {
  if (!Number.isFinite(max) || max <= 0) return null;
  if (!Number.isFinite(total)) return null;
  return Math.round((total / max) * 10000) / 100;
}

/* ── grading delegation (kept for API compatibility) ───────────────────── */

export function gradeFromMarksPercent(
  pct: number | null,
  bands?: GradingBand[] | null,
): string {
  return gradeFromPercent(pct, bands);
}

export function remarkFromPercentSafe(
  pct: number | null,
  bands?: GradingBand[] | null,
): string {
  return remarkFromPercent(pct, bands);
}

/*
 * Result wording lives here so the sidebar, the on-screen card and the PDF all
 * print the same words for the same numbers (the sidebar used to re-implement
 * the 33% rule on its own).
 */
export const RESULT_PROMOTED = 'PROMOTED';
export const RESULT_NEEDS_IMPROVEMENT = 'NEEDS IMPROVEMENT';

/** The result printed for a pass/fail, from the same rule as `totals.passed`. */
export const resultLabel = (passed: boolean): string =>
  passed ? RESULT_PROMOTED : RESULT_NEEDS_IMPROVEMENT;

/** Overall performance band shown at the bottom of the report card. */
export function overallPerformanceLabel(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return UNGRADED_LABEL;
  if (pct >= 91) return 'EXCELLENT';
  if (pct >= 81) return 'VERY GOOD';
  if (pct >= 71) return 'GOOD';
  if (pct >= 61) return 'SATISFACTORY';
  if (pct >= 51) return 'FAIR';
  return 'NEEDS IMPROVEMENT';
}

export function gradeFromMarksOutOfValue(
  marks: number | null,
  max: number,
  bands?: GradingBand[] | null,
): string {
  return gradeFromMarksOutOf(marks, max, bands);
}

export function statusLabel(
  status: SubjectMark['status'] | SubjectComponent['status'],
): string {
  switch (status) {
    case 'absent':
      return 'AB';
    case 'exempt':
      return 'EX';
    case 'medical':
      return 'Medical';
    default:
      return UNGRADED_LABEL;
  }
}

/* ── Excel-provided grades ─────────────────────────────────────────────── */

function normalizeGradeKey(value: string): string {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Grades that were supplied in the workbook must be preserved, not recomputed.
 *
 * Grade columns arrive either as standalone grade fields ("MATHS | GRADE",
 * "MV", "GK", "DRAW") or as an explicit `excelGrade` on the subject. A grade
 * field is attributed to a subject only when its name clearly references that
 * subject, so co-scholastic columns stay co-scholastic.
 */
export function resolveExcelGrades(student: Student): Map<string, string> {
  const map = new Map<string, string>();
  const subjectKeys = new Map<string, string>();
  for (const subject of student.subjects) {
    subjectKeys.set(normalizeGradeKey(subject.name), subject.name);
  }

  for (const subject of student.subjects) {
    if (subject.excelGrade && String(subject.excelGrade).trim()) {
      map.set(subject.name, String(subject.excelGrade).trim());
    }
    for (const component of subject.components ?? []) {
      if (!component.gradeValue || !String(component.gradeValue).trim()) continue;
      if (/grade|gr\.?\b/i.test(component.name)) {
        map.set(subject.name, String(component.gradeValue).trim());
      }
    }
  }

  for (const field of student.gradeFields ?? []) {
    const value = String(field.value ?? '').trim();
    if (!value) continue;

    const segments = String(field.name ?? '')
      .split(/[|/]/)
      .map((segment) => normalizeGradeKey(segment))
      .filter(Boolean);
    if (segments.length === 0) continue;

    /* Try the leaf first ("MATHS | GRADE" → "grade" | "maths"), then every
     * other segment, then the whole label. */
    const candidates = [
      segments[segments.length - 1],
      ...segments.slice(0, -1).reverse(),
      normalizeGradeKey(field.name),
    ];

    for (const candidate of candidates) {
      const subjectName = subjectKeys.get(candidate);
      if (subjectName && !map.has(subjectName)) {
        map.set(subjectName, value);
        break;
      }
    }
  }

  return map;
}

/** Grade fields that are NOT tied to an academic subject (co-scholastic). */
export function coScholasticGradeFields(
  student: Student,
): { name: string; value: string }[] {
  return (student.gradeFields ?? [])
    .filter((field) => String(field.value ?? '').trim() !== '')
    .filter((field) => {
      const segments = String(field.name ?? '')
        .split(/[|/]/)
        .map((segment) => normalizeGradeKey(segment))
        .filter(Boolean);
      if (segments.length === 0) return false;
      /* A grade column that clearly belongs to an academic subject
       * ("MATHS | GRADE") is shown in the academic row, not here. */
      return !student.subjects.some((subject) =>
        segments.includes(normalizeGradeKey(subject.name)),
      );
    })
    .map((field) => ({ name: field.name, value: field.value }));
}

export function summarizeComponents(
  components: SubjectComponent[],
  bands?: GradingBand[] | null,
): ComponentSummary[] {
  return components.map((c) => ({
    name: c.name,
    marks: c.marks,
    maxMarks: c.maxMarks,
    status: c.status,
    grade:
      c.status === 'present' && c.marks !== null
        ? gradeFromMarksOutOf(c.marks, c.maxMarks, bands)
        : statusLabel(c.status),
    isTotal: c.isTotal,
  }));
}

/**
 * Adds the marks of the components that are present. Excel TOTAL columns are
 * never summed here — they win outright in `buildSubjectTotals`.
 */
export function sumPresentMarks(components: SubjectComponent[]): number | null {
  let sum = 0;
  let found = false;
  for (const component of components) {
    if (
      component.status === 'present' &&
      typeof component.marks === 'number' &&
      Number.isFinite(component.marks)
    ) {
      sum += component.marks;
      found = true;
    }
  }
  return found ? sum : null;
}

/**
 * Marks and status of one subject.
 *
 * Priority (Excel is the source of truth):
 *   1. the Excel TOTAL column, when the workbook provides one;
 *   2. otherwise the sum of the valid component columns;
 *   3. otherwise the single marks column.
 */
export function resolveSubjectTotals(subject: SubjectMark): {
  marks: number | null;
  status: SubjectMark['status'];
} {
  const components = subject.components ?? [];
  if (components.length === 0) {
    return { marks: subject.marks, status: subject.status };
  }

  const totalComponent = components.find((c) => c.isTotal);
  if (totalComponent) {
    const marks =
      totalComponent.status === 'present'
        ? (totalComponent.marks ?? sumPresentMarks(components))
        : null;
    return { marks, status: totalComponent.status };
  }

  const nonPresent = components.find((c) => c.status !== 'present');
  return {
    marks: sumPresentMarks(components) ?? subject.marks,
    status: nonPresent ? nonPresent.status : 'present',
  };
}

export function summarizeSubjects(
  student: Student,
  bands?: GradingBand[] | null,
): SubjectSummary[] {
  const excelGrades = resolveExcelGrades(student);

  return student.subjects.map((subject) => {
    /* Grade fields (max marks 0) are not academic subjects. */
    const isAcademic = subject.maxMarks !== 0;

    const totals = resolveSubjectTotals(subject);
    const rawMarks = totals.marks ?? subject.marks;
    const marks = typeof rawMarks === 'number' ? rawMarks : null;
    const status = totals.status ?? subject.status;

    const pct =
      status === 'present' && marks !== null && subject.maxMarks > 0
        ? (marks / subject.maxMarks) * 100
        : null;

    const excelGrade = isAcademic ? excelGrades.get(subject.name) : undefined;

    const grade =
      excelGrade !== undefined
        ? excelGrade
        : status === 'present' && marks !== null
          ? gradeFromPercent(pct, bands)
          : statusLabel(status);

    const remark =
      status === 'present' && marks !== null
        ? remarkFromPercent(pct, bands)
        : statusLabel(status);

    return {
      name: subject.name,
      marks,
      maxMarks: subject.maxMarks,
      status,
      grade,
      remark,
      percentage: pct,
      gradeFromExcel: excelGrade !== undefined,
      source:
        excelGrade !== undefined
          ? 'excel'
          : status === 'present' && marks !== null
            ? 'computed'
            : 'status',
      components:
        subject.hasComponents && subject.components
          ? summarizeComponents(subject.components, bands)
          : undefined,
    };
  });
}

export function computeTotals(
  student: Student,
  options: TotalsOptions = {},
): ReportTotals {
  const bands = normalizeGradingBands(options.bands ?? DEFAULT_GRADING_BANDS);
  const graded = summarizeSubjects(student, bands);

  let total = 0;
  let max = 0;
  let present = 0;

  for (const summary of graded) {
    /* Grade-only columns carry no marks and must not affect the total. */
    if (summary.maxMarks === 0) continue;
    if (summary.status === 'present' && summary.marks !== null) {
      total += summary.marks;
      max += summary.maxMarks;
      present++;
    }
  }

  /* Marks always come from Excel; the percentage is cross-checked. */
  const excelTotal =
    typeof student.overall?.total === 'number' && Number.isFinite(student.overall.total)
      ? student.overall.total
      : undefined;
  const excelPercentageRaw = toFiniteNumber(student.overall?.percentage);

  const shownTotal = excelTotal ?? total;
  const computedPct = computePercentage(shownTotal, max);

  /*
   * Percentage = Obtained / Maximum × 100.
   *
   * A percentage that the workbook itself provides is honoured only when it
   * agrees with its own total and maximum (schools round, so a small delta is
   * fine). An Excel percentage that is mathematically impossible — for
   * example 111% — is never printed: the computed value is shown instead and
   * the file is reported during verification.
   */
  let pct = computedPct;
  let percentageSource: ReportTotals['percentageSource'] = computedPct === null ? 'none' : 'computed';
  let excelPercentageUsed: number | undefined;
  let ignoredExcelPercentage: number | undefined;

  if (excelPercentageRaw !== null) {
    const plausible = excelPercentageRaw >= 0 && excelPercentageRaw <= 100;
    const agrees =
      computedPct !== null && Math.abs(excelPercentageRaw - computedPct) <= 1.5;

    if (computedPct === null && plausible) {
      pct = excelPercentageRaw;
      percentageSource = 'excel';
      excelPercentageUsed = excelPercentageRaw;
    } else if (plausible && agrees) {
      pct = excelPercentageRaw;
      percentageSource = 'excel';
      excelPercentageUsed = excelPercentageRaw;
    } else {
      ignoredExcelPercentage = excelPercentageRaw;
    }
  }

  return {
    totalMarks: shownTotal,
    totalMax: max,
    percentage: pct,
    overallGrade: gradeFromPercent(pct, bands),
    passed: pct !== null ? pct >= 33 : false,
    presentSubjects: present,
    gradedSubjects: graded,
    excelTotal,
    excelPercentage: excelPercentageUsed,
    percentageSource,
    ignoredExcelPercentage,
  };
}

function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[^0-9.\-]/g, '');
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) ? num : null;
}

export { UNGRADED_LABEL, remarkFromPercent, normalizeGradingBands };
