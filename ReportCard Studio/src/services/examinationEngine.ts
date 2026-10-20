import type {
  Student,
  SubjectMark,
  SubjectComponent,
  ValidationIssue,
} from '../types';

/**
 * Examination-component intelligence.
 *
 * The workbook — not this code — decides what components a subject has. This
 * module only *interprets* what the parser discovered: it groups component
 * names into examinations (SA1, SA2, Term-1, Annual, or a single general
 * examination) and reports when a subject's total appears to add two separate
 * examinations together without the workbook saying so.
 *
 * It never changes a mark or a total. Where the workbook establishes the rule
 * (an explicit TOTAL column) that rule wins; where it does not, the ambiguity
 * is surfaced as a warning that needs the user's confirmation.
 */

export type ExaminationCombination =
  | 'no-marks'
  | 'single-component'
  | 'explicit-total'
  | 'single-exam'
  | 'multi-exam';

export interface ComponentPlan {
  name: string;
  maxMarks: number;
  isTotal: boolean;
  /** Examination group this component belongs to (e.g. "SA1", "General"). */
  examination: string;
  /** True for the exam groups that look like separate examinations. */
  terminal: boolean;
}

export interface SubjectExaminationPlan {
  subject: string;
  combination: ExaminationCombination;
  components: ComponentPlan[];
  /** Distinct terminal examination groups, e.g. ["SA1", "SA2"]. */
  examinations: string[];
  /** True when the resolved total adds two or more separate examinations. */
  summedAcrossExams: boolean;
  /** True when a calculation rule is genuinely ambiguous and needs confirmation. */
  needsConfirmation: boolean;
  maxMarks: number;
  marks: number | null;
}

export interface ExaminationReport {
  subjects: SubjectExaminationPlan[];
  /** True when at least one subject needs the user's confirmation. */
  needsConfirmation: boolean;
  /** Every component name discovered this session, in workbook order. */
  componentNames: string[];
}

/* Terminal bases that represent separate examinations (never PT/NB/SEA). */
const TERMINAL_BASES: Record<string, string> = {
  sa: 'SA',
  fa: 'FA',
  term: 'Term',
  sem: 'Semester',
  semester: 'Semester',
  t: 'Term',
  annual: 'Annual',
  final: 'Annual',
  board: 'Board',
  preboard: 'Pre-Board',
  'halfyearly': 'Half Yearly',
};

function normalizeComponentName(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9\u0900-\u097F]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Classifies one component name into an examination group.
 *
 * "SA1" → SA1 (terminal), "TERM 2" → Term2 (terminal), "half yearly" →
 * Half Yearly (terminal), "PT" / "NB" / "practical" → General (part of one
 * examination). Index may be attached or spaced ("sa-1", "sa 1", "sa1").
 */
export function classifyComponent(name: string): { examination: string; terminal: boolean } {
  const norm = normalizeComponentName(name);
  if (!norm) return { examination: 'General', terminal: false };

  /* Spaced key for multi-word bases ("half yearly"). */
  const joined = norm.replace(/\s+/g, '');
  const withIndex = /^(.*?)[\s-]*(\d+)$/.exec(norm);
  const baseRaw = withIndex ? withIndex[1].replace(/\s+/g, '') : joined;
  const index = withIndex ? withIndex[2] : '';

  /* Multi-word named terminals first. */
  if (baseRaw === 'halfyearly') return { examination: 'Half Yearly', terminal: true };
  if (baseRaw === 'preboard') return { examination: 'Pre-Board', terminal: true };

  const canonicalBase = TERMINAL_BASES[baseRaw];
  if (canonicalBase) {
    return { examination: `${canonicalBase}${index}`, terminal: true };
  }

  return { examination: 'General', terminal: false };
}

function planSubject(subject: SubjectMark): SubjectExaminationPlan {
  const components = subject.components ?? [];

  if (subject.maxMarks === 0) {
    return {
      subject: subject.name,
      combination: 'no-marks',
      components: [],
      examinations: [],
      summedAcrossExams: false,
      needsConfirmation: false,
      maxMarks: subject.maxMarks,
      marks: subject.marks,
    };
  }

  if (components.length === 0) {
    return {
      subject: subject.name,
      combination: 'single-component',
      components: [],
      examinations: [],
      summedAcrossExams: false,
      needsConfirmation: false,
      maxMarks: subject.maxMarks,
      marks: subject.marks,
    };
  }

  const plans: ComponentPlan[] = components.map((component: SubjectComponent) => {
    const classified = classifyComponent(component.name);
    return {
      name: component.name,
      maxMarks: component.maxMarks,
      isTotal: component.isTotal,
      examination: classified.examination,
      terminal: classified.terminal,
    };
  });

  const explicitTotal = plans.some((plan) => plan.isTotal);
  const examinations = Array.from(
    new Set(plans.filter((plan) => plan.terminal && !plan.isTotal).map((plan) => plan.examination)),
  );

  const summedAcrossExams = !explicitTotal && examinations.length >= 2;

  let combination: ExaminationCombination;
  if (explicitTotal) combination = 'explicit-total';
  else if (summedAcrossExams) combination = 'multi-exam';
  else combination = 'single-exam';

  return {
    subject: subject.name,
    combination,
    components: plans,
    examinations,
    summedAcrossExams,
    needsConfirmation: summedAcrossExams,
    maxMarks: subject.maxMarks,
    marks: subject.marks,
  };
}

/** Plans every subject in the workbook (deduplicated by subject name). */
export function analyzeExaminations(students: Student[]): ExaminationReport {
  const subjects = new Map<string, SubjectExaminationPlan>();
  const componentNames: string[] = [];
  const seenComponents = new Set<string>();

  for (const student of students) {
    for (const subject of student.subjects) {
      if (!subjects.has(subject.name)) subjects.set(subject.name, planSubject(subject));
      for (const component of subject.components ?? []) {
        if (seenComponents.has(component.name)) continue;
        seenComponents.add(component.name);
        componentNames.push(component.name);
      }
    }
  }

  const plans = [...subjects.values()];
  return {
    subjects: plans,
    needsConfirmation: plans.some((plan) => plan.needsConfirmation),
    componentNames,
  };
}

/**
 * Warnings for subjects whose total adds separate examinations without the
 * workbook establishing that rule. These are *possible* causes (unconfirmed),
 * they never block generation, and they never alter the computed totals.
 */
export function examinationIssues(students: Student[]): ValidationIssue[] {
  const report = analyzeExaminations(students);
  const issues: ValidationIssue[] = [];

  for (const plan of report.subjects) {
    if (!plan.needsConfirmation) continue;
    const exams = plan.examinations.join(' and ');
    const marks = plan.marks === null ? '—' : String(plan.marks);
    issues.push({
      severity: 'warning',
      type: 'examination_rule_assumed',
      field: `subject.${plan.subject}`,
      value: plan.examinations.join('+'),
      message: `${plan.subject}: ${exams} look like separate examinations; their marks are currently added together (${marks} / ${plan.maxMarks}).`,
      reason: `No TOTAL column was found for ${plan.subject}, so its components ${plan.components
        .filter((component) => !component.isTotal)
        .map((component) => component.name)
        .join(', ')} are summed. If ${exams} are separate examinations, adding them may not be the intended result.`,
      suggestion: `Add a TOTAL column for ${plan.subject}, or confirm whether ${exams} should be summed or reported separately. Until then the total assumes summation.`,
      confirmed: false,
      blocksGeneration: false,
    });
  }

  return issues;
}
