/**
 * Report-card typography — the SINGLE source of truth for text sizes.
 *
 * Sizes are expressed in millimetres because that is the one unit both renderers
 * can honour exactly:
 *   • the browser preview sets `font-size: <x>mm` (CSS mm is an absolute unit);
 *   • the PDF converts the same number with `mmToPt()` for `doc.setFontSize`.
 *
 * Before this module the preview used px classes (`text-[10.5px]`) while the PDF
 * used hardcoded points (7.6pt) for the same text. Those two numbers drifted, so
 * the printed card never quite matched the on-screen one. Now both sides read
 * the same constants and can only change together.
 *
 * `FONT_SCALE_STEPS` mirrors the shrink steps the layouts use to fit a big mark
 * sheet onto one A4 page, so the preview's density tiers and the PDF's fit
 * search land on the same sizes.
 */

/** Points per millimetre (1pt = 25.4/72 mm). */
export const PT_PER_MM = 72 / 25.4;

/** Millimetres → PDF points, the conversion used by every `setFontSize` call. */
export const mmToPt = (mm: number): number => mm * PT_PER_MM;

/** Millimetres → CSS length string for inline `style={{ fontSize }}`. */
export const mmCss = (mm: number): string => `${Math.round(mm * 1000) / 1000}mm`;

/**
 * Base text sizes in mm at full scale (scale = 1).
 *
 * Values were raised across the card so the printed text is comfortable to read
 * while staying inside the fixed A4 geometry.
 */
export const TYPE_MM = {
  /** Academic table: subject names, component cells and column headers. */
  academic: 3.05,
  /** The title/section bars ("ACADEMIC PERFORMANCE", "OVERALL PERFORMANCE", …). */
  sectionBar: 3.05,
  /** Co-scholastic area names and their grade values. */
  coScholastic: 3.05,
  /** Holistic Development Profile area names and grade values. */
  holisticValue: 3.05,
  /** Personality Development / Learning Skills rows. */
  skills: 2.95,
  /** Student information grid (Date of Birth, Admission No., …). */
  info: 3.25,
  /** The card title bar ("ANNUAL REPORT CARD"). */
  title: 3.9,
  /** Summary strip labels ("MARKS OBTAINED", "PERCENTAGE" …). */
  summaryLabel: 2.7,
  /** Summary strip values (big numbers under those labels). */
  summaryValue: 5.3,
  /** The big performance word inside the Overall panel ("GOOD"). */
  overallValue: 5.1,
  /** "Overall Percentage: 76%". */
  overallLabel: 3.05,
  /** The grading-scale legend under the academic table. */
  gradingScale: 2.7,
  /** Teacher's / Principal's remarks body text. */
  remarks: 2.95,
  /** "TEACHER'S REMARKS" / "PRINCIPAL'S REMARKS" labels. */
  remarksLabel: 3.05,
  /** Signature name and role labels. */
  signatureName: 3.0,
  /** Page footer note. */
  footer: 2.55,
} as const;

/** Scale steps shared by the preview density tiers and the PDF fit search. */
export const FONT_SCALE_STEPS = [1, 0.94, 0.88, 0.82, 0.76, 0.7, 0.64] as const;

/**
 * Density tiers, keyed by academic row count — used by the preview so a large
 * mark sheet shrinks exactly like the PDF does instead of overflowing the page.
 */
export const DENSITY_SCALE = {
  /** Up to 10 academic rows. */
  normal: 1,
  /** 11–17 rows. */
  compact: 0.92,
  /** 18+ rows. */
  ultra: 0.84,
} as const;

export type DensityTier = keyof typeof DENSITY_SCALE;

/** Picks the density tier for a number of academic rows (incl. GRAND TOTAL). */
export function densityTierFor(rows: number): DensityTier {
  if (rows >= 18) return 'ultra';
  if (rows >= 11) return 'compact';
  return 'normal';
}
