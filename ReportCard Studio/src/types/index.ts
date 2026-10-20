export type SubjectStatus = 'present' | 'absent' | 'exempt' | 'medical';

/**
 * One band of a grading scale. Grades are configuration, never hard-coded per
 * school — see services/gradingEngine.ts.
 */
export interface GradingBand {
  grade: string;
  min: number;
  max: number;
  remark: string;
}

export interface SubjectComponent {
  name: string;
  marks: number | null;
  maxMarks: number;
  status: SubjectStatus;
  rawValue?: string;
  isTotal: boolean;
  /** Letter grade carried by this component when the workbook provides one. */
  gradeValue?: string;
}

export interface SubjectMark {
  name: string;
  marks: number | null;
  maxMarks: number;
  status: SubjectStatus;
  rawValue?: string;
  components?: SubjectComponent[];
  hasComponents: boolean;
  /** Grade supplied by the workbook for this subject (preserved on the card). */
  excelGrade?: string;
}

export interface Student {
  studentId: string;
  rowNumber: number;
  rollNo: string;
  admissionNo?: string;
  class?: string;
  section?: string;
  name: string;
  fatherName?: string;
  motherName?: string;
  dob?: string;
  address?: string;
  attendance?: string;
  workingDays?: string;
  daysPresent?: string;
  photoFilename?: string;
  photoDataUrl?: string;
  subjects: SubjectMark[];
  gradeFields?: GradeField[];
  overall?: OverallFields;
  teacherRemarks?: string;
  principalRemarks?: string;
  learningSkills?: Record<string, string>;
  personalityDev?: Record<string, string>;
  coScholastic?: Record<string, string>;
  rawRow?: Record<string, unknown>;
}

export interface GradeField {
  name: string;
  value: string;
  rawValue?: string;
}

export interface OverallFields {
  total?: number | string;
  percentage?: number | string;
  position?: number | string;
  attendance?: string;
  remarks?: string;
}

export type FieldKey =
  | 'rollNo'
  | 'admissionNo'
  | 'class'
  | 'section'
  | 'name'
  | 'fatherName'
  | 'motherName'
  | 'dob'
  | 'attendance'
  | 'workingDays'
  | 'daysPresent'
  | 'photoFilename'
  | 'teacherRemarks'
  | 'principalRemarks'
  | 'address'
  | 'position';

export type ColumnMappingFieldKey = FieldKey | 'subject' | 'gradeField' | 'overallField' | 'ignore';

export interface ColumnMapping {
  columnName: string;
  fieldKey: ColumnMappingFieldKey;
  subjectName?: string;
  /**
   * Component name of a grouped sub-column ("English | PT" → "PT").
   *
   * Kept separate from `subjectName` so PT / NB / SEA / SA1 / TOTAL columns are
   * never collapsed into five copies of the same subject.
   */
  componentName?: string;
  maxMarks?: number;
  overallFieldType?: 'total' | 'percentage' | 'position' | 'attendance' | 'remarks';
  excelColumn?: number; // Store original column index for stability
}

export interface ValidationIssue {
  studentId?: string;
  /** Affected student's name, carried so explanations are self-contained. */
  studentName?: string;
  rowNumber?: number;
  severity: 'error' | 'warning';
  type: string;
  message: string;
  field?: string;
  /**
   * The offending workbook value, when known (e.g. the raw attendance cell).
   * Used by Joy and the UI to explain the issue without re-reading the file.
   */
  value?: string;
  /** Why the issue was raised, when it can be determined from the data. */
  reason?: string;
  /** What the user can do to correct it. */
  suggestion?: string;
  /**
   * True when the cause is certain from the validation data; false/undefined
   * means it is only a possible cause and should be presented as such.
   */
  confirmed?: boolean;
  /**
   * True when this issue blocks report generation for the affected student
   * (errors do; warnings do not). Lets Joy and the UI say so explicitly.
   */
  blocksGeneration?: boolean;
}

export interface ValidationResult {
  isValid: boolean;
  issues: ValidationIssue[];
  errorCount: number;
  warningCount: number;
}

export interface SchoolProfile {
  schoolName: string;
  address: string;
  logoDataUrl?: string;
  /** Optional tagline shown under the logo (e.g. "DISCIPLINE • DEDICATION • EXCELLENCE"). */
  tagline?: string;
  /** Affiliations / board line, e.g. "AFFILIATED TO C.B.S.E., NEW DELHI". */
  affiliationText?: string;
  schoolCode?: string;
  affiliationNo?: string;
  principalName: string;
  principalSignDataUrl?: string;
  teacherName: string;
  teacherSignDataUrl?: string;
  /** "Checked by" (usually Vice Principal) shown between teacher and principal. */
  checkedByName?: string;
  checkedBySignDataUrl?: string;
  stampDataUrl?: string;
  academicSession: string;
  examTerm: string;
  /** Date printed as "Date of Issue" on the report card. */
  dateOfIssue?: string;
  /** Grading scale legend text (optional override of the built-in scale). */
  gradingScale?: string;
  /** Optional custom grading bands; when absent the default scale is used. */
  gradingBands?: GradingBand[];
  /** Selected report card theme id (see src/themes). */
  reportTheme?: string;
}

export interface WorkbookData {
  fileName: string;
  sheetNames: string[];
  activeSheet: string;
  headers: string[];
  rows: Record<string, unknown>[];
}

export interface GenerationResult {
  studentId: string;
  rollNo: string;
  name: string;
  rowNumber: number;
  success: boolean;
  fileName?: string;
  error?: string;
}

export interface GenerationProgress {
  total: number;
  completed: number;
  failed: number;
  current?: {
    studentId: string;
    name: string;
    rollNo: string;
  };
  results: GenerationResult[];
  status: 'idle' | 'running' | 'complete' | 'error';
  zipBlobUrl?: string;
  zipFileName?: string;
}

export interface PhotoMap {
  [filename: string]: string;
}

export interface DetectedStructure {
  studentFields: FieldMapping[];
  subjectGroups: SubjectGroup[];
  gradeFields: GradeFieldMapping[];
  overallFields: OverallFieldMapping[];
  headerRows: number;
  dataStartRow: number;
  confidence: number;
  /** Absolute worksheet row index (0-based) where the header region begins. */
  headerStartRow?: number;
  /** Absolute worksheet rows (0-based) that only contain a title/heading. */
  titleRows?: number[];
  /** Class inferred from sheet name / title / header context (no column required). */
  inferredClass?: string;
  /** Section inferred from sheet name / title / header context. */
  inferredSection?: string;
  /** Best-effort school name inferred from the workbook title rows. */
  schoolName?: string;
}

export interface FieldMapping {
  excelColumn: number;
  excelHeader: string;
  fieldType:
    | 'rollNo'
    | 'admissionNo'
    | 'name'
    | 'fatherName'
    | 'motherName'
    | 'dob'
    | 'class'
    | 'section'
    | 'attendance'
    | 'workingDays'
    | 'daysPresent'
    | 'photo'
    | 'remarks'
    | 'position'
    | 'total'
    | 'percentage'
    | 'address'
    | 'ignore';
  confidence: number;
}

export interface SubjectGroup {
  name: string;
  startCol: number;
  endCol: number;
  components: SubjectComponentMapping[];
  hasTotal: boolean;
  confidence: number;
}

export interface SubjectComponentMapping {
  name: string;
  col: number;
  maxMarks?: number;
  isTotal: boolean;
}

export interface GradeFieldMapping {
  name: string;
  col: number;
  confidence: number;
}

export interface OverallFieldMapping {
  name: string;
  col: number;
  fieldType: 'total' | 'percentage' | 'position' | 'attendance' | 'remarks';
  confidence: number;
}

export interface StructureMapping {
  detected: DetectedStructure;
  confirmed: boolean;
  customMappings: {
    [excelCol: number]: {
      type: 'studentField' | 'subject' | 'gradeField' | 'overallField' | 'ignore';
      mappedTo?: string;
    };
  };
}
