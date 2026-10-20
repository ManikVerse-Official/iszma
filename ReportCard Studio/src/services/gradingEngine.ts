/**
 * Grading engine.
 *
 * Grades are configuration, never hard-coded per school. The engine ships with
 * a sensible CBSE-style default scale but accepts any band list, so a school
 * (or a future theme/settings screen) can plug in its own scale without
 * touching the report card code.
 */

import type { GradingBand } from '../types';

export type { GradingBand };


/**
 * Default scale: A1 (91-100) A2 (81-90) B1 (71-80) B2 (61-70) C1 (below 61).
 *
 * The scale is deliberately capped at C1 — the lowest grade printed anywhere on
 * the card is C1, never D/E/F. Order matters: the first band whose range
 * contains the value wins.
 */
export const DEFAULT_GRADING_BANDS: GradingBand[] = [
  { grade: 'A1', min: 91, max: 100, remark: 'Excellent' },
  { grade: 'A2', min: 81, max: 90, remark: 'Very Good' },
  { grade: 'B1', min: 71, max: 80, remark: 'Good' },
  { grade: 'B2', min: 61, max: 70, remark: 'Satisfactory' },
  { grade: 'C1', min: 0, max: 60, remark: 'Average' },
];

/** Awarded for a value that cannot be graded (missing / absent / exempt). */
export const UNGRADED_LABEL = '—';

export function normalizeGradingBands(
  bands?: GradingBand[] | null,
): GradingBand[] {
  if (!Array.isArray(bands) || bands.length === 0) return DEFAULT_GRADING_BANDS;
  const cleaned = bands
    .filter(
      (b) =>
        b &&
        typeof b.grade === 'string' &&
        b.grade.trim() !== '' &&
        Number.isFinite(Number(b.min)) &&
        Number.isFinite(Number(b.max)),
    )
    .map((b) => ({
      grade: b.grade.trim(),
      min: Number(b.min),
      max: Number(b.max),
      remark: (b.remark || '').trim() || b.grade.trim(),
    }));
  return cleaned.length > 0 ? cleaned : DEFAULT_GRADING_BANDS;
}

/** Grade symbol for a percentage (null / non-finite → "—"). */
export function gradeFromPercent(
  pct: number | null | undefined,
  bands?: GradingBand[] | null,
): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return UNGRADED_LABEL;
  }
  const scale = normalizeGradingBands(bands);
  const value = Math.max(0, Math.min(100, pct));
  for (const band of scale) {
    if (value >= band.min && value <= band.max) return band.grade;
  }
  /* Below the lowest band's floor → use the lowest band's grade. */
  return scale[scale.length - 1]?.grade ?? UNGRADED_LABEL;
}

/** Qualitative remark for a percentage. */
export function remarkFromPercent(
  pct: number | null | undefined,
  bands?: GradingBand[] | null,
): string {
  if (pct === null || pct === undefined || !Number.isFinite(pct)) {
    return UNGRADED_LABEL;
  }
  const scale = normalizeGradingBands(bands);
  const value = Math.max(0, Math.min(100, pct));
  for (const band of scale) {
    if (value >= band.min && value <= band.max) return band.remark;
  }
  return scale[scale.length - 1]?.remark ?? UNGRADED_LABEL;
}

/** Grade for raw marks out of a maximum (max is never assumed to be 100). */
export function gradeFromMarksOutOf(
  marks: number | null | undefined,
  max: number,
  bands?: GradingBand[] | null,
): string {
  if (marks === null || marks === undefined || !Number.isFinite(marks)) {
    return UNGRADED_LABEL;
  }
  if (!Number.isFinite(max) || max <= 0) return UNGRADED_LABEL;
  return gradeFromPercent((marks / max) * 100, bands);
}

/**
 * Human-readable legend, e.g. "A1 (91-100)  A2 (81-90)  ...".
 * Used when the school has not typed a custom legend in its profile.
 */
export function bandsLegend(bands?: GradingBand[] | null): string {
  const scale = normalizeGradingBands(bands);
  return scale
    .map((b) => {
      const upper = Math.min(100, b.max);
      const rounded = Number.isInteger(upper) ? upper : Math.round(upper * 10) / 10;
      return `${b.grade} (${b.min}-${rounded})`;
    })
    .join('    ');
}

/**
 * Clamp an externally supplied grade label (from the workbook) to the scale's
 * floor.
 *
 * The product rule is simple: grades run A1 … C1 and never go below C1. A
 * workbook may still carry an older label (C2, D, E, "Needs Improvement", …);
 * those are pulled up to the floor grade so nothing worse than C1 is ever
 * printed. Labels that are already at or above the floor (A1/A2/B1/B2, or a
 * school's own A/B/C) are preserved untouched, as are plain numeric values.
 */
export function capGradeLabel(
  value: string | null | undefined,
  bands?: GradingBand[] | null,
): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  /* Numbers (marks, star counts, 4/5) are never grades. */
  if (/^\d/.test(raw)) return raw;

  const scale = normalizeGradingBands(bands);
  const floor = scale[scale.length - 1]?.grade;
  if (!floor) return raw;

  const upper = raw.toUpperCase();
  if (upper === floor.toUpperCase()) return raw;
  if (scale.some((band) => band.grade.toUpperCase() === upper)) return raw;

  const pct = percentFromGradeLabel(raw);
  if (pct === null) return raw;

  const mapped = gradeFromPercent(pct, scale);
  return mapped === floor ? floor : raw;
}

/**
 * Best-effort conversion of an already-provided grade (from Excel or from a
 * teacher) into a 0..100 percentage. Returns null when the value cannot be
 * interpreted — callers must never invent a value in that case.
 */
export function percentFromGradeLabel(value: string | null | undefined): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const direct = Number(raw.replace(/[%\s]/g, ''));
  if (Number.isFinite(direct) && direct >= 0 && direct <= 100) return direct;

  const upper = raw.toUpperCase();
  const mapping: [RegExp, number][] = [
    [/^A\+{1,}$/, 96],
    [/^A1$/, 95],
    [/^A2$/, 86],
    [/^A$/, 92],
    [/^B\+$/, 78],
    [/^B1$/, 75],
    [/^B2$/, 65],
    [/^B$/, 72],
    [/^C\+$/, 58],
    [/^C1$/, 55],
    [/^C2$/, 52],
    [/^C$/, 55],
    [/^D\+$/, 45],
    [/^D$/, 38],
    [/^E$/, 25],
    [/^F$/, 15],
  ];
  for (const [re, pct] of mapping) {
    if (re.test(upper)) return pct;
  }

  const wordMap: Record<string, number> = {
    OUTSTANDING: 96,
    EXCELLENT: 94,
    VERYGOOD: 86,
    'VERY GOOD': 86,
    GOOD: 75,
    SATISFACTORY: 65,
    AVERAGE: 55,
    FAIR: 48,
    'NEEDS IMPROVEMENT': 35,
    POOR: 25,
  };
  const wordKey = upper.replace(/\s+/g, ' ').trim();
  if (wordMap[wordKey] !== undefined) return wordMap[wordKey];
  if (wordMap[wordKey.replace(/\s+/g, '')] !== undefined) {
    return wordMap[wordKey.replace(/\s+/g, '')];
  }

  return null;
}
