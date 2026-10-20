import type {
  Student,
  ValidationIssue,
  ValidationResult,
} from '../types';
import { examinationIssues } from './examinationEngine';

/** A days-present count in a school year is at most ~366; above that it is not a count either. */
const MAX_PLAUSIBLE_DAYS_PRESENT = 366;

type IssueContext = Pick<
  ValidationIssue,
  'studentId' | 'studentName' | 'rowNumber'
>;

/**
 * Inspects one attendance value and returns the issue it deserves (or null).
 *
 * Attendance is stored either as a percentage (\"92%\" / \"92\") or, when the
 * workbook only carries Days Present + Working Days, as a derived percentage.
 * A bare number above 100 cannot be a percentage — and a whole number in the
 * range of a school year is almost always a days-present count. That case is
 * reported as a *possible* cause with a concrete correction (map the column to
 * \"Days Present\"), instead of silently converting or hiding the value.
 *
 * Nothing is ever rewritten here: the original value stays on the student.
 */
function analyzeAttendance(
  attendance: string | undefined,
  ctx: IssueContext,
): ValidationIssue | null {
  if (!attendance) return null;
  const raw = String(attendance).trim();
  if (!raw) return null;

  const hasPercentSign = /%\s*$/.test(raw);
  /* Accept a value with a trailing % or stray spaces; reject anything else. */
  const numeric = Number(raw.replace(/%/g, '').trim());
  const base = { ...ctx, field: 'attendance', value: raw };

  if (!Number.isFinite(numeric)) {
    return {
      ...base,
      severity: 'warning',
      type: 'invalid_attendance',
      message: `Attendance "${raw}" is not a number or percentage.`,
      reason: 'The value could not be read as an attendance percentage (0–100).',
      suggestion:
        'Enter attendance as a percentage such as "92%", or map this column to "Days Present" and map the working days to "Total Working Days" so the percentage can be computed.',
      confirmed: true,
    };
  }

  if (numeric < 0) {
    return {
      ...base,
      severity: 'warning',
      type: 'invalid_attendance',
      message: `Attendance "${raw}" is negative.`,
      reason: 'Attendance cannot be less than 0%.',
      suggestion: 'Enter attendance as a percentage between 0 and 100.',
      confirmed: true,
    };
  }

  if (numeric <= 100) return null;

  if (!hasPercentSign && Number.isInteger(numeric) && numeric <= MAX_PLAUSIBLE_DAYS_PRESENT) {
    return {
      ...base,
      severity: 'warning',
      type: 'attendance_looks_like_days',
      message: `Attendance "${raw}" is greater than 100, so it is not a percentage — it looks like ${numeric} days present.`,
      reason:
        `A percentage cannot exceed 100. ${numeric} is in the range of a days-present ` +
        'count, so this column was likely mapped as Attendance % but actually holds Days Present.',
      suggestion:
        'In Import Students → column mapping, map this column to "Days Present" and map the number of working days to "Total Working Days" — attendance % is then calculated as Days Present ÷ Working Days. If it really is a percentage, enter a value between 0 and 100.',
      confirmed: false,
    };
  }

  return {
    ...base,
    severity: 'warning',
    type: 'invalid_attendance',
    message: `Attendance "${raw}" is outside the valid percentage range (0–100).`,
    reason: 'Attendance must be a percentage between 0 and 100.',
    suggestion: 'Enter attendance as a percentage between 0 and 100.',
    confirmed: true,
  };
}

export function validateStudents(students: Student[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  const rollSeen = new Map<string, string[]>();

  for (const s of students) {
    const ctx: IssueContext = {
      studentId: s.studentId,
      studentName: s.name,
      rowNumber: s.rowNumber,
    };

    if (!s.name || !s.name.trim()) {
      issues.push({
        ...ctx,
        severity: 'error',
        type: 'missing_name',
        message: 'Student name is missing.',
        field: 'name',
        reason: 'The name column is empty for this row.',
        suggestion: 'Fill the name in the source Excel file (or fix the column mapping) and re-import.',
        confirmed: true,
      });
    }

    if (!s.rollNo || !String(s.rollNo).trim()) {
      issues.push({
        ...ctx,
        severity: 'error',
        type: 'missing_roll',
        message: 'Roll number is missing.',
        field: 'rollNo',
        reason: 'The roll-number column is empty for this row.',
        suggestion: 'Fill the roll number in the source Excel file and re-import.',
        confirmed: true,
      });
    } else {
      const key = `${s.class ?? ''}__${s.section ?? ''}__${String(s.rollNo).trim()}`;
      const existing = rollSeen.get(key) ?? [];
      existing.push(s.studentId);
      rollSeen.set(key, existing);
    }

    if (!s.class || !String(s.class).trim()) {
      issues.push({
        ...ctx,
        severity: 'warning',
        type: 'missing_class',
        message: 'Class is missing; default value will be used.',
        field: 'class',
        reason: 'No class value was found for this row.',
        suggestion: 'Set the default class in Import Students, or add a Class column to the workbook.',
        confirmed: true,
      });
    }

    for (const sub of s.subjects) {
      if (sub.status === 'present') {
        const subjectCtx = { ...ctx, field: `subject.${sub.name}` };
        if (sub.marks === null) {
          issues.push({
            ...subjectCtx,
            severity: 'error',
            type: 'missing_marks',
            message: `${sub.name} marks missing.`,
            reason: 'The subject is marked as present but no marks were read.',
            suggestion: `Check the ${sub.name} column mapping and the row in the source Excel file.`,
            confirmed: true,
          });
        } else if (sub.marks < 0) {
          issues.push({
            ...subjectCtx,
            severity: 'error',
            type: 'invalid_marks_negative',
            message: `${sub.name} marks ${sub.marks} are negative.`,
            value: String(sub.marks),
            reason: 'Marks cannot be negative.',
            suggestion: 'Correct the marks in the source Excel file and re-import.',
            confirmed: true,
          });
        } else if (sub.marks > sub.maxMarks) {
          issues.push({
            ...subjectCtx,
            severity: 'error',
            type: 'marks_exceed_max',
            message: `${sub.name} marks ${sub.marks} exceed maximum ${sub.maxMarks}.`,
            value: String(sub.marks),
            reason: `${sub.name} marks are greater than its configured maximum of ${sub.maxMarks}.`,
            suggestion: `Correct the marks, or set the correct maximum for ${sub.name} in the Subjects tab.`,
            confirmed: true,
          });
        }
      }
    }

    const attendanceIssue = analyzeAttendance(s.attendance, ctx);
    if (attendanceIssue) issues.push(attendanceIssue);
  }

  for (const [key, ids] of rollSeen.entries()) {
    if (ids.length > 1) {
      const [cls, sec, roll] = key.split('__');
      for (const id of ids) {
        const st = students.find((x) => x.studentId === id);
        if (!st) continue;
        issues.push({
          studentId: st.studentId,
          studentName: st.name,
          rowNumber: st.rowNumber,
          severity: 'error',
          type: 'duplicate_roll',
          message: `Roll number ${roll}${cls ? ` in Class ${cls}` : ''}${sec ? ` - Section ${sec}` : ''} is duplicated.`,
          field: 'rollNo',
          reason: 'Another student in the same class/section has this roll number.',
          suggestion: 'Give each student a unique roll number (or separate them by class/section) and re-import.',
          confirmed: true,
        });
      }
    }
  }

  /*
   * Workbook-level calculation ambiguities (e.g. separate SA1/SA2 summed with
   * no TOTAL rule) are reported alongside per-student issues so a single entry
   * point still surfaces everything the user must review.
   */
  issues.push(...examinationIssues(students));

  /*
   * Every issue states whether it blocks generation: errors do (the affected
   * student is excluded by default), warnings do not.
   */
  for (const issue of issues) {
    if (issue.blocksGeneration === undefined) {
      issue.blocksGeneration = issue.severity === 'error';
    }
  }

  const errorCount = issues.filter((i) => i.severity === 'error').length;
  const warningCount = issues.length - errorCount;

  return {
    isValid: errorCount === 0,
    issues,
    errorCount,
    warningCount,
  };
}

export function getIssuesForStudent(
  validation: ValidationResult | null,
  studentId: string,
): ValidationIssue[] {
  if (!validation) return [];
  return validation.issues.filter((i) => i.studentId === studentId);
}
