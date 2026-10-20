import * as XLSX from 'xlsx';
import {
  FIELD_ALIASES,
  isKnownNonSubjectHeader,
  normalizeHeader,
} from '../utils/normalization';

export interface MergedCell {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  value: string;
}

export interface HeaderStructure {
  level: number;
  row: number;
  col: number;
  text: string;
  span: number;
  children: HeaderStructure[];
}

export interface ColumnGroup {
  name: string;
  startCol: number;
  endCol: number;
  subColumns: ColumnGroup[];
  isSubject: boolean;
  isGrade: boolean;
  isNumeric: boolean;
}

export interface DetectedStructure {
  studentFields: FieldMapping[];
  subjectGroups: SubjectGroup[];
  gradeFields: GradeField[];
  overallFields: OverallField[];
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
  components: SubjectComponent[];
  hasTotal: boolean;
  confidence: number;
}

export interface SubjectComponent {
  name: string;
  col: number;
  maxMarks?: number;
  isTotal: boolean;
}

export interface GradeField {
  name: string;
  col: number;
  confidence: number;
}

export interface OverallField {
  name: string;
  col: number;
  fieldType:
    | 'total'
    | 'percentage'
    | 'position'
    | 'attendance'
    | 'remarks';
  confidence: number;
}

interface EffectiveColumnHeader {
  col: number;
  labels: string[];
  leaf: string;
  path: string;
  normalizedPath: string;
  normalizedLeaf: string;
}

interface ColumnClassification {
  col: number;
  header: EffectiveColumnHeader;
  studentField: FieldMapping['fieldType'] | null;
  studentConfidence: number;
  overallField: OverallField['fieldType'] | null;
  subject: boolean;
  grade: boolean;
  numericRatio: number;
}

const COMMON_HEADER_TERMS = [
  'name',
  'roll',
  'serial',
  'sr',
  'admission',
  'father',
  'mother',
  'dob',
  'birth',
  'class',
  'section',
  'address',
  'english',
  'hindi',
  'math',
  'mathematics',
  'science',
  'sci',
  'social',
  'sst',
  'computer',
  'pt',
  'nb',
  'se',
  'sa',
  'sa1',
  'sa2',
  'total',
  'percentage',
  'attendance',
  'position',
  'marks',
  'grade',
  'rank',
  'physics',
  'chemistry',
  'biology',
  'history',
  'geography',
  'civics',
  'economics',
  'sanskrit',
  'urdu',
  'punjabi',
  'marathi',
  'tamil',
  'telugu',
  'bengali',
  'kannada',
  'malayalam',
  'gujarati',
  'art',
  'music',
  'sports',
  'yoga',
  'gk',
  'evs',
  'drawing',
];

const NON_SUBJECT_WORDS = [
  'student',
  'students',
  'name',
  'father',
  'mother',
  'dob',
  'dateofbirth',
  'birth',
  'address',
  'house',
  'roll',
  'serial',
  'sr',
  'sno',
  'admission',
  'class',
  'section',
  'photo',
  'photograph',
  'image',
  'remarks',
  'remark',
  'comment',
  'comments',
  'attendance',
  'present',
  'workingdays',
  'position',
  'rank',
  'percentage',
  'percent',
  'grandtotal',
  'overalltotal',
];

const SUBJECT_INDICATORS = [
  'english',
  'hindi',
  'math',
  'mathematics',
  'science',
  'sci',
  'social',
  'sst',
  'computer',
  'physics',
  'chemistry',
  'biology',
  'economics',
  'history',
  'geography',
  'civics',
  'sanskrit',
  'french',
  'german',
  'spanish',
  'urdu',
  'punjabi',
  'marathi',
  'tamil',
  'telugu',
  'bengali',
  'kannada',
  'malayalam',
  'gujarati',
  'evs',
  'environmentalstudies',
];

const GRADE_SUBJECT_INDICATORS = [
  'gk',
  'general knowledge',
  'art',
  'drawing',
  'draw',
  'music',
  'physical education',
  'pe',
  'sports',
  'yoga',
  'moral',
  'moral values',
  'mv',
  'moral value',
  'value education',
  'work education',
  'art education',
  'computer literacy',
  'discipline',
];

const COMPONENT_TERMS = [
  'pt',
  'periodic test',
  'unit test',
  'ut',
  'assignment',
  'activity',
  'notebook',
  'nb',
  'classwork',
  'cw',
  'homework',
  'hw',
  'project',
  'internal',
  'term',
  'exam',
  'theory',
  'practical',
  'oral',
  'viva',
  'written',
  'half yearly',
  'annual',
  'final',
  'sa',
  'fa',
  'se',
  'sea',
  'mark',
  'marks',
  'obtained',
  'score',
  'grade',
  'grades',
  'total',
  'subtotal',
];

/** Lower-cased word list of a label ("Marks (50)" → ["marks", "50"]). */
function wordsOf(text: string): string[] {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '');
}

const STUDENT_FIELD_NAMES = [
  'dob',
  'address',
  'fatherName',
  'motherName',
  'name',
  'rollNo',
  'class',
  'section',
  'photo',
  'attendance',
  'remarks',
];

export function parseDynamicStructure(
  file: File,
  requestedSheetName?: string,
): Promise<DetectedStructure> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(reader.error ?? new Error('File read failed'));
    };

    reader.onload = (e) => {
      try {
        const result = e.target?.result;

        if (!(result instanceof ArrayBuffer)) {
          reject(new Error('Invalid workbook data'));
          return;
        }

        const data = new Uint8Array(result);

        const workbook = XLSX.read(data, {
          type: 'array',
          cellDates: true,
          raw: true,
        });

        const sheetName =
          requestedSheetName &&
          workbook.SheetNames.includes(requestedSheetName)
            ? requestedSheetName
            : workbook.SheetNames[0];

        if (!sheetName) {
          reject(new Error('No worksheet found in workbook'));
          return;
        }

        const worksheet = workbook.Sheets[sheetName];

        if (!worksheet || !worksheet['!ref']) {
          reject(new Error('Worksheet is empty'));
          return;
        }

        resolve(analyzeSheetStructure(worksheet, sheetName));
      } catch (error) {
        reject(
          error instanceof Error
            ? error
            : new Error('Unable to parse Excel workbook'),
        );
      }
    };

    reader.readAsArrayBuffer(file);
  });
}

function analyzeSheetStructure(
  ws: XLSX.WorkSheet,
  sheetName?: string,
): DetectedStructure {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');

  const mergedCells = extractMergedCells(ws);

  const layout = detectHeaderLayout(
    ws,
    range,
    mergedCells,
  );

  const effectiveHeaders = buildEffectiveColumnHeaders(
    ws,
    range,
    layout,
    mergedCells,
  );

  const classifications = classifyColumns(
    ws,
    range,
    effectiveHeaders,
    layout.dataStartRow,
  );

  const { inferredClass, inferredSection, schoolName } =
    inferWorkbookContext(
      ws,
      range,
      mergedCells,
      layout,
      effectiveHeaders,
      sheetName,
    );

  const studentFields = classifications
    .filter((item) => item.studentField)
    .map((item) => ({
      excelColumn: item.col,
      excelHeader: item.header.path,
      fieldType: item.studentField!,
      confidence: item.studentConfidence,
    }));

  const overallFields = classifications
    .filter(
      (item) =>
        item.overallField &&
        !item.studentField,
    )
    .map((item) => ({
      name: item.header.path,
      col: item.col,
      fieldType: item.overallField!,
      confidence: calculateOverallFieldConfidence(
        item.header.leaf,
        item.overallField!,
      ),
    }));

  const { subjectGroups, gradeFields } =
    buildSubjectGroups(classifications);

  /*
   * Attach the paper's own maximum marks to every component column. A mark
   * sheet prints them in a dedicated row under the component headers
   * (PT 10 | NB 5 | SEA 5 | SA1 80 | TOTAL 100); without it a report card can
   * only show marks, never what they are out of.
   */
  applyMaxMarksRow(ws, range, layout, subjectGroups, studentFields);

  const confidence = calculateConfidence(
    studentFields,
    subjectGroups,
    gradeFields,
    overallFields,
  );

  return {
    studentFields,
    subjectGroups,
    gradeFields,
    overallFields,
    headerRows: layout.headerRows,
    dataStartRow: layout.dataStartRow,
    confidence,
    headerStartRow: layout.headerStartRow,
    titleRows: layout.titleRows,
    inferredClass,
    inferredSection,
    schoolName,
  };
}

/* -------------------------------------------------------------------------- */
/* WORKBOOK / MERGED CELLS                                                    */
/* -------------------------------------------------------------------------- */

function extractMergedCells(
  ws: XLSX.WorkSheet,
): MergedCell[] {
  const merges = ws['!merges'] || [];

  return merges.map((merge) => {
    const startRow = merge.s.r;
    const endRow = merge.e.r;
    const startCol = merge.s.c;
    const endCol = merge.e.c;

    const cellRef = XLSX.utils.encode_cell({
      r: startRow,
      c: startCol,
    });

    const cell = ws[cellRef];

    return {
      startRow,
      endRow,
      startCol,
      endCol,
      value: cell ? String(cell.v ?? '').trim() : '',
    };
  });
}

function findMergeAtPosition(
  mergedCells: MergedCell[],
  row: number,
  col: number,
): MergedCell | undefined {
  return mergedCells.find(
    (merge) =>
      row >= merge.startRow &&
      row <= merge.endRow &&
      col >= merge.startCol &&
      col <= merge.endCol,
  );
}

function getCellText(
  ws: XLSX.WorkSheet,
  row: number,
  col: number,
): string {
  const cellRef = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = ws[cellRef];

  if (!cell) return '';

  return String(cell.v ?? '').trim();
}

/* -------------------------------------------------------------------------- */
/* HEADER DETECTION                                                           */
/* -------------------------------------------------------------------------- */

interface HeaderLayout {
  /** Number of rows in the header region, counted from the first sheet row. */
  headerRows: number;
  /** Absolute (0-based) worksheet row where the header region starts. */
  headerStartRow: number;
  /** Absolute (0-based) worksheet row of the last header row. */
  headerEndRow: number;
  /** Absolute (0-based) worksheet row where student data begins. */
  dataStartRow: number;
  /** Absolute rows that only contain a title/heading (no column labels). */
  titleRows: number[];
}

interface RowStats {
  nonEmpty: number;
  numeric: number;
  text: number;
}

/**
 * Collect the distinct (merge-aware) non-empty cells of a worksheet row.
 *
 * A merged cell spanning several columns contributes exactly ONE value so a
 * title like "S.B.S PUBLIC SCHOOL (CLASS-3rd)" does not look like real columns.
 */
function rowDistinctCells(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  row: number,
  mergedCells: MergedCell[],
): string[] {
  const values: string[] = [];

  for (let col = range.s.c; col <= range.e.c; col++) {
    const merge = findMergeAtPosition(mergedCells, row, col);

    if (
      merge &&
      !(row === merge.startRow && col === merge.startCol)
    ) {
      continue;
    }

    let text = getCellText(ws, row, col);

    if (!text && merge) text = merge.value;

    text = text.trim();

    if (text) values.push(text);
  }

  return values;
}

function rowStats(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  row: number,
  mergedCells: MergedCell[],
): RowStats {
  const values = rowDistinctCells(ws, range, row, mergedCells);

  let numeric = 0;
  let text = 0;

  for (const value of values) {
    if (Number.isFinite(Number(value))) numeric++;
    else text++;
  }

  return { nonEmpty: values.length, numeric, text };
}

/**
 * A title/heading row has a single (often merged) value across the sheet.
 * These rows must never be used to build column labels.
 */
function isTitleRow(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  mergedCells: MergedCell[],
  row: number,
): boolean {
  const width = range.e.c - range.s.c + 1;

  /* Narrow sheets have no room for a title; avoid false positives. */
  if (width <= 3) return false;

  const values = rowDistinctCells(ws, range, row, mergedCells);

  if (values.length === 0) return false;
  if (values.length === 1) return true;
  if (values.length > 2) return false;

  const joined = values.join(' ');

  return /(school|class|grade|std|standard|session|term|exam|report|result)/i.test(
    joined,
  );
}

/**
 * Determine where the header region ends and the first data row begins.
 *
 * The previous scoring approach always extended the header block because
 * data rows themselves scored positively, which swallowed early students.
 * Instead we look for the first row that genuinely looks like a data row and
 * treat everything above it as the header region.
 */
function detectHeaderLayout(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  mergedCells: MergedCell[],
): HeaderLayout {
  const firstRow = range.s.r;
  const maxScan = Math.min(range.e.r, firstRow + 40);

  let dataStartRow = -1;

  for (let row = firstRow; row <= maxScan; row++) {
    const stats = rowStats(ws, range, row, mergedCells);

    if (stats.nonEmpty === 0) continue;

    /* Title rows are never data. */
    if (isTitleRow(ws, range, mergedCells, row)) continue;

    /* A real data row needs a few cells and at least one numeric mark. */
    if (stats.nonEmpty < 3 || stats.numeric < 1) continue;

    const numericRatio = stats.numeric / stats.nonEmpty;

    if (numericRatio < 0.15) continue;

    /* Confirm the following rows also look like data. */
    let confirms = 0;
    for (let k = 1; k <= 2; k++) {
      const next = rowStats(ws, range, row + k, mergedCells);
      if (
        next.nonEmpty >= 2 &&
        next.numeric >= 1 &&
        !isTitleRow(ws, range, mergedCells, row + k)
      ) {
        confirms++;
      }
    }

    if (confirms >= 1 || row === maxScan) {
      dataStartRow = row;
      break;
    }
  }

  /*
   * Secondary heuristic for text-only sheets (for example letter grades):
   * pick the first non-title row that carries no header vocabulary and whose
   * following rows look the same.
   */
  if (dataStartRow < 0) {
    for (let row = firstRow; row <= maxScan; row++) {
      if (isTitleRow(ws, range, mergedCells, row)) continue;

      const stats = rowStats(ws, range, row, mergedCells);
      if (stats.nonEmpty < 3) continue;

      if (rowLooksLikeHeader(ws, range, mergedCells, row)) continue;

      let confirms = 0;
      for (let k = 1; k <= 2; k++) {
        const next = rowStats(ws, range, row + k, mergedCells);
        if (next.nonEmpty >= 3 && !rowLooksLikeHeader(ws, range, mergedCells, row + k)) {
          confirms++;
        }
      }

      if (confirms >= 1) {
        dataStartRow = row;
        break;
      }
    }
  }

  /*
   * Fall back to a single header row when no data row could be found
   * (for example a two-column workbook).
   */
  if (dataStartRow < 0) dataStartRow = firstRow + 1;

  /*
   * Absorb rows that are still part of the vertically merged header block.
   *
   * Mark sheets usually stack a "maximum marks" row under the merged identity
   * and subject labels (S.No spans three rows, so does Student Name). That row
   * is almost all numbers, so it looks exactly like a data row — but it is not
   * a student. A merge that starts above a row and ends on/after it is proof
   * the row is still header context.
   *
   * Without this the max-marks row became student #1, which shifted every later
   * row and (because the label row also owns the columns) mis-read component
   * marks.
   */
  let firstDataRow = dataStartRow;

  while (
    firstDataRow <= range.e.r &&
    mergedCells.some(
      (merge) =>
        merge.startRow < firstDataRow &&
        merge.endRow >= firstDataRow,
    )
  ) {
    firstDataRow++;
  }

  const headerEndRow = Math.max(firstRow, dataStartRow - 1);

  const titleRows: number[] = [];
  for (let row = firstRow; row <= headerEndRow; row++) {
    if (isTitleRow(ws, range, mergedCells, row)) {
      titleRows.push(row);
    }
  }

  return {
    headerRows: headerEndRow - firstRow + 1,
    headerStartRow: firstRow,
    headerEndRow,
    dataStartRow: Math.max(headerEndRow + 1, firstDataRow),
    titleRows,
  };
}

/* -------------------------------------------------------------------------- */
/* CLASS / SECTION / SCHOOL INFERENCE                                         */
/* -------------------------------------------------------------------------- */

/**
 * Generic class/section inference from any available workbook context.
 *
 * Supports (without hard-coding any value):
 *   CLASS-3rd | Class 3 | CLASS 5 | Class-10 | Grade 7 | Std. 8 | 3rd | 5-A
 */
/**
 * Does a row contain header vocabulary (Name, Roll, Class, Total, ...)?
 *
 * Short terms ("sr", "sa") only match exactly so they cannot be tripped by
 * ordinary student names.
 */
function rowLooksLikeHeader(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  mergedCells: MergedCell[],
  row: number,
): boolean {
  const values = rowDistinctCells(ws, range, row, mergedCells);

  return values.some((value) => {
    const normalized = safeNormalize(value);
    if (!normalized) return false;

    return COMMON_HEADER_TERMS.some((term) => {
      const token = safeNormalize(term);
      if (!token) return false;
      return normalized === token || (token.length >= 4 && normalized.includes(token));
    });
  });
}

function inferClassAndSection(
  text: string,
): { class?: string; section?: string } {
  const raw = String(text ?? '').trim();
  if (!raw) return {};

  const result: { class?: string; section?: string } = {};

  const classMatch =
    raw.match(
      /(?:\bclass\b|\bstd\b\.?|\bstandard\b|\bgrade\b)\s*[:\-]?\s*([0-9]{1,2}\s*(?:st|nd|rd|th)?|\b[IVXLCDM]{1,5}\b)/i,
    ) ??
    null;

  if (classMatch) {
    result.class = normalizeClassValue(classMatch[1]);
  } else {
    /* Bare ordinal such as "3rd" — only for short standalone labels. */
    const ordinal = raw.match(/\b([0-9]{1,2}(?:st|nd|rd|th))\b/i);
    if (ordinal && raw.length <= 30) {
      result.class = ordinal[1].toLowerCase();
    }
  }

  const sectionMatch =
    raw.match(
      /\bsection\b\s*[:\-]?\s*([A-Za-z0-9]{1,3})\b/i,
    ) ??
    raw.match(
      /(?:\bclass\b|\bstd\b\.?|\bstandard\b|\bgrade\b)\s*[:\-]?\s*[0-9]{1,2}(?:\s*(?:st|nd|rd|th))?\s*[-– ]\s*([A-Za-z])\b/i,
    );

  if (sectionMatch) {
    result.section = sectionMatch[1].toUpperCase();
  }

  return result;
}

function normalizeClassValue(value: string): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function inferWorkbookContext(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  mergedCells: MergedCell[],
  layout: HeaderLayout,
  headers: EffectiveColumnHeader[],
  sheetName?: string,
): {
  inferredClass?: string;
  inferredSection?: string;
  schoolName?: string;
} {
  const candidates: string[] = [];

  if (sheetName) candidates.push(sheetName);

  for (const row of layout.titleRows) {
    for (const value of rowDistinctCells(ws, range, row, mergedCells)) {
      candidates.push(value);
    }
  }

  /* Header context (some schools put the class inside a header cell). */
  for (const header of headers) {
    if (header.path) candidates.push(header.path);
  }

  let inferredClass: string | undefined;
  let inferredSection: string | undefined;

  for (const candidate of candidates) {
    const parsed = inferClassAndSection(candidate);
    if (!inferredClass && parsed.class) inferredClass = parsed.class;
    if (!inferredSection && parsed.section) inferredSection = parsed.section;
    if (inferredClass && inferredSection) break;
  }

  /* School name = longest title text (with any class part stripped). */
  let schoolName: string | undefined;
  for (const row of layout.titleRows) {
    for (const value of rowDistinctCells(ws, range, row, mergedCells)) {
      const cleaned = value
        .replace(
          /[\s(\[-]*(?:class|grade|std\.?|standard)\s*[:\-]?\s*[^)\]]*[)\]]?/gi,
          ' ',
        )
        .replace(/\s+/g, ' ')
        .trim();

      const candidate = cleaned || value.trim();

      if (candidate.length > (schoolName?.length ?? 0)) {
        schoolName = candidate;
      }
    }
  }

  return { inferredClass, inferredSection, schoolName };
}

/* -------------------------------------------------------------------------- */
/* HEADER HIERARCHY                                                           */
/* -------------------------------------------------------------------------- */

function buildEffectiveColumnHeaders(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  layout: HeaderLayout,
  mergedCells: MergedCell[],
): EffectiveColumnHeader[] {
  const result: EffectiveColumnHeader[] = [];

  /*
   * Only real column-label rows contribute to the header path.
   * Title rows (for example "Some Public School (CLASS-3rd)") are excluded so
   * they never pollute column identities.
   */
  const headerRowIndices: number[] = [];

  for (
    let row = layout.headerStartRow;
    row <= layout.headerEndRow;
    row++
  ) {
    if (!layout.titleRows.includes(row)) {
      headerRowIndices.push(row);
    }
  }

  if (headerRowIndices.length === 0) {
    headerRowIndices.push(layout.headerEndRow);
  }

  const lastHeaderRow = headerRowIndices[headerRowIndices.length - 1];

  /*
   * Grouped headers often spell the subject name only above the FIRST of its
   * component columns and leave the rest of that row blank (no merged cells at
   * all). Carrying the label across those blanks is what keeps "English | PT",
   * "English | NB", "English | SEA" … attached to the same subject.
   *
   * The LAST header row is never filled: it carries one distinct component per
   * column (PT / NB / SEA / SA1 / TOTAL) and must not be propagated sideways.
   */
  const filledText = new Map<string, string>();

  for (const row of headerRowIndices) {
    let carried = '';
    /*
     * How far right a carried label may reach.
     *
     * A label that lives inside a merged region describes exactly the columns
     * of that region — no further. "S.No" (merged B3:B5) must not spill into
     * the next blank column, otherwise "Adm" inherits it and the admission
     * number is read as a roll number; the same leak turned the merged
     * "Father name" (E3:E5) into the mother's column. Labels on unmerged cells
     * keep the historical "carry up to the next label" behaviour used by
     * grouped-but-unmerged mark sheets.
     */
    let carriedEndCol = -1;

    for (let col = range.s.c; col <= range.e.c; col++) {
      let text = cleanHeaderText(getCellText(ws, row, col));
      const merge = findMergeAtPosition(mergedCells, row, col);

      if (!text && merge) {
        text = cleanHeaderText(merge.value);
      }

      if (text) {
        carried = text;
        carriedEndCol = merge ? merge.endCol : range.e.c;
      } else if (
        carried &&
        row !== lastHeaderRow &&
        !merge &&
        col <= carriedEndCol &&
        /*
         * A column with no data below the header cannot own an inherited
         * label: a stray empty column next to "Attendance" would otherwise be
         * classified as a second attendance column and shadow the real one.
         */
        columnHasData(ws, range, col, layout.dataStartRow)
      ) {
        text = carried;
      }

      filledText.set(`${row}:${col}`, text);
    }
  }

  for (
    let col = range.s.c;
    col <= range.e.c;
    col++
  ) {
    const labels: string[] = [];

    for (const row of headerRowIndices) {
      const text = filledText.get(
        `${row}:${col}`,
      ) ?? '';

      if (!text) continue;

      /*
       * Avoid repeating the same inherited label.
       * Example:
       * School Name
       * School Name
       * English
       */
      if (
        labels.length === 0 ||
        safeNormalize(
          labels[labels.length - 1],
        ) !== safeNormalize(text)
      ) {
        labels.push(text);
      }
    }

    const leaf =
      labels[labels.length - 1] ||
      `Column ${convertColumnToLetter(col)}`;

    const path = labels.join(' | ');

    result.push({
      col,
      labels,
      leaf,
      path,
      normalizedPath: safeNormalize(path),
      normalizedLeaf: safeNormalize(leaf),
    });
  }

  return result;
}

/**
 * Does the column hold any value at or below the first data row?
 *
 * Used only to decide whether an inherited (sideways-carried) header label may
 * attach to a column. A trailing/stray column that holds nothing at all is not
 * a real data column, so it must not inherit its neighbour's label.
 */
function columnHasData(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  col: number,
  fromRow: number,
): boolean {
  for (let row = fromRow; row <= range.e.r; row++) {
    if (getCellText(ws, row, col)) return true;
  }

  return false;
}

function cleanHeaderText(
  value: string,
): string {
  return value
    .replace(/\s+/g, ' ')
    .replace(/\|+/g, ' | ')
    .trim();
}

function safeNormalize(
  value: string,
): string {
  try {
    // Preserve % character for percentage detection
    const normalized = normalizeHeader(value);
    // Remove special chars but keep %
    return normalized
      .replace(/[^a-z0-9%]+/gi, '')
      .toLowerCase();
  } catch {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9%]+/g, '');
  }
}

/* -------------------------------------------------------------------------- */
/* COLUMN CLASSIFICATION                                                      */
/* -------------------------------------------------------------------------- */

function classifyColumns(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  headers: EffectiveColumnHeader[],
  dataStartRow: number,
): ColumnClassification[] {
  return headers.map((header) => {
    const studentResult =
      identifyStudentField(
        header,
      );

    const overallField =
      identifyOverallFieldFromPath(
        header,
      );

    const numericRatio =
      calculateColumnNumericRatio(
        ws,
        range,
        header.col,
        dataStartRow,
      );

    /*
     * Student fields ALWAYS win.
     *
     * This is the most important protection:
     * D.O.B / Father's Name / Address / Student Name
     * can never fall through into subject detection.
     */
    const isStudentField =
      studentResult.fieldType !==
      'ignore';

    const subject =
      !isStudentField &&
      !overallField &&
      isAcademicColumn(header, numericRatio) &&
      (
        numericRatio >= 0.15 ||
        hasMarksLikeHeader(header)
      );

    /*
     * Grade/co-scholastic columns (MV, GK, DRAW, Art, Discipline, ...) stay
     * grade fields even when they hold numeric marks, so an unknown
     * co-scholastic column is never silently promoted to a numeric subject.
     *
     * A per-subject letter grade column ("MATHEMATICS | GRADE") is a grade
     * field too — it must never become the student's `class` column and its
     * value has to reach the report card.
     */
    const grade =
      !isStudentField &&
      !overallField &&
      !subject &&
      (isGradeColumn(header) || isSubjectGradeComponent(header));

    return {
      col: header.col,
      header,
      studentField: isStudentField
        ? studentResult.fieldType
        : null,
      studentConfidence:
        studentResult.confidence,
      overallField:
        overallField?.fieldType ?? null,
      subject,
      grade,
      numericRatio,
    };
  });
}

function identifyStudentField(
  header: EffectiveColumnHeader,
): {
  fieldType: FieldMapping['fieldType'];
  confidence: number;
} {
  /*
   * First inspect the complete hierarchy.
   * This solves duplicate flattened headers because
   * column position + parent labels are preserved.
   */
  const labels = header.labels;

  /*
   * Explicit hard-negative checks.
   * These fields are NEVER academic subjects.
   */
  if (
    labels.some((label) =>
      isDobHeader(label),
    )
  ) {
    return {
      fieldType: 'dob',
      confidence: 0.99,
    };
  }

  if (
    labels.some((label) =>
      isFatherHeader(label),
    )
  ) {
    return {
      fieldType: 'fatherName',
      confidence: 0.99,
    };
  }

  if (
    labels.some((label) =>
      isMotherHeader(label),
    )
  ) {
    return {
      fieldType: 'motherName',
      confidence: 0.99,
    };
  }

  if (
    labels.some((label) =>
      isAddressHeader(label),
    )
  ) {
    return {
      fieldType: 'address',
      confidence: 0.99,
    };
  }

  if (
    labels.some((label) =>
      isRollHeader(label),
    )
  ) {
    return {
      fieldType: 'rollNo',
      confidence: 0.99,
    };
  }

  if (
    labels.some((label) =>
      isStudentNameHeader(label),
    )
  ) {
    return {
      fieldType: 'name',
      confidence: 0.99,
    };
  }

  /*
   * Other known fields are resolved only after
   * the hard-negative checks above.
   */
  const candidates: Array<{
    field: FieldMapping['fieldType'];
    confidence: number;
  }> = [];

  /*
   * A component-only leaf inside a hierarchy must never become a student
   * field: "MATHEMATICS | GRADE" is a subject grade column, not the student's
   * class. Without this guard the word "GRADE" was mapped to `class` and the
   * student's class/section on the report card became "A+".
   */
  const leafLabel = labels[labels.length - 1];
  const skipLeafAsField =
    labels.length > 1 && isComponentLeafLabel(leafLabel);

  for (const fa of FIELD_ALIASES) {
    for (const aliasRaw of fa.aliases) {
      const alias = safeNormalize(aliasRaw);

      if (!alias) continue;

      for (const label of labels) {
        if (skipLeafAsField && label === leafLabel) continue;
        const normalized =
          safeNormalize(label);

        if (!normalized) continue;

        if (normalized === alias) {
          candidates.push({
            field:
              mapAliasFieldToFieldType(
                fa.field,
              ),
            confidence: 0.94,
          });
        }
      }
    }
  }

  /*
   * Do NOT use fuzzy matching for dangerous fields
   * such as name/father/DOB. It can create false positives.
   */
  const safeCandidate =
    candidates
      .filter(
        (candidate) =>
          candidate.field !==
            'ignore' &&
          candidate.field !==
            'address' &&
          candidate.field !==
            'position',
      )
      .sort(
        (a, b) =>
          b.confidence -
          a.confidence,
      )[0];

  if (safeCandidate) {
   return {
  fieldType: safeCandidate.field,
  confidence: safeCandidate.confidence,
};
  }

  /*
   * Conservative fallback.
   * Unknown fields must NOT become student fields.
   */
  return {
    fieldType: 'ignore',
    confidence: 0,
  };
}

/**
 * A leaf that only names a component of a subject ("MARKS", "TOTAL",
 * "GRADE", "OBTAINED", ...) rather than a whole column of its own.
 *
 * Used so "SCIENCE | MARKS" is understood as the Science marks column and the
 * leaf never vetoes the parent label or becomes a student field.
 */
function isComponentLeafLabel(
  text: string,
): boolean {
  if (isComponentLabel(text)) return true;
  const norm = safeNormalize(text);
  if (!norm) return false;
  return /^(marks?|obtained|scores?|grades?|results?|percent(age)?|totals?|subtotals?)/.test(norm);
}

function isRollHeader(
  text: string,
): boolean {
  const norm = safeNormalize(text);

  return (
    norm === 'srno' ||
    norm === 'sno' ||
    norm === 'serialno' ||
    norm === 'serialnumber' ||
    norm === 'rollno' ||
    norm === 'rollnumber' ||
    norm === 'studentrollno' ||
    norm === 'studentrollnumber' ||
    norm.includes('rollno') ||
    norm.includes('rollnumber')
  );
}

function isStudentNameHeader(
  text: string,
): boolean {
  const norm = safeNormalize(text);

  return (
    norm === 'name' ||
    norm === 'studentname' ||
    norm === 'studentsname' ||
    norm === 'nameofstudent' ||
    norm === 'studentfullname'
  );
}

function isFatherHeader(
  text: string,
): boolean {
  const norm = safeNormalize(text);

  return (
    norm === 'fathername' ||
    norm === 'fathersname' ||
    norm === 'father' ||
    norm === 'parentfathername'
  );
}

function isMotherHeader(
  text: string,
): boolean {
  const norm = safeNormalize(text);

  return (
    norm === 'mothername' ||
    norm === 'mothersname' ||
    norm === 'mother'
  );
}

function isDobHeader(
  text: string,
): boolean {
  const norm = safeNormalize(text);

  return (
    norm === 'dob' ||
    norm === 'dateofbirth' ||
    norm === 'birthdate' ||
    norm === 'datebirth'
  );
}

function isAddressHeader(
  text: string,
): boolean {
  const norm = safeNormalize(text);

  return (
    norm === 'address' ||
    norm === 'studentaddress' ||
    norm === 'residentialaddress' ||
    norm === 'homeaddress'
  );
}

/* -------------------------------------------------------------------------- */
/* SUBJECT DETECTION                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Does a single header label name an academic subject?
 *
 * Matching is intentionally conservative:
 * - exact match always works ("sci", "it", "evs");
 * - longer indicators may appear inside a longer label ("maths" contains
 *   "math", "english marks" contains "english");
 * - short indicators only match exactly so "discipline" does NOT match "sci".
 * - co-scholastic/grade labels (MV, GK, Draw, Art, Discipline, ...) are never
 *   treated as academic subject parents.
 */
function labelMatchesSubject(text: string): boolean {
  const norm = safeNormalize(text);

  if (!norm) return false;

  if (
    GRADE_SUBJECT_INDICATORS.some(
      (indicator) => safeNormalize(indicator) === norm,
    )
  ) {
    return false;
  }

  return SUBJECT_INDICATORS.some((indicator) => {
    const token = safeNormalize(indicator);

    if (!token) return false;
    if (norm === token) return true;

    return token.length >= 4 && norm.includes(token);
  });
}

function labelMatchesGrade(text: string): boolean {
  const norm = safeNormalize(text);

  if (!norm) return false;

  return GRADE_SUBJECT_INDICATORS.some((indicator) => {
    const token = safeNormalize(indicator);
    return token.length > 1 && token === norm;
  });
}

function isAcademicColumn(
  header: EffectiveColumnHeader,
  numericRatio = 0,
): boolean {
  /*
   * Inspect the complete hierarchy, not only the flattened leaf.
   *
   * Example:
   * English | PT
   * English | Notebook
   * English | Total
   *
   * All three belong to English. This check runs BEFORE the forbidden-label
   * check so a per-subject "English | TOTAL" is grouped under English instead
   * of being mistaken for the standalone overall TOTAL.
   */
  const labels = header.labels ?? [];

  if (labels.some((label) => labelMatchesSubject(label))) {
    return true;
  }

  /*
   * Co-scholastic / grade columns are normally grade fields — but when such a
   * column carries real NUMERIC marks (for example "GENERAL KNOWLEDGE" with
   * 89/100, as in the holistic report card) it is an academic subject so its
   * marks are not lost. Letter grades (A/B/Excellent) stay co-scholastic.
   */
  if (
    labels.some((label) => labelMatchesGrade(label)) &&
    numericRatio < 0.6
  ) {
    return false;
  }

  /*
   * A component-only leaf must not veto the column: "SCIENCE | MARKS" is a
   * real marks column even though the word "marks" by itself looks like
   * metadata. Only the parent labels are checked for forbidden terms then.
   */
  const vetoLabels =
    labels.length > 1 && isComponentLeafLabel(labels[labels.length - 1])
      ? labels.slice(0, -1)
      : labels;

  if (
    vetoLabels.some((label) =>
      isForbiddenSubjectLabel(label),
    )
  ) {
    return false;
  }

  /*
   * Generic fallback for schools whose subject names are outside our
   * vocabulary (e.g. "IT", "Artificial Intelligence", "Environmental
   * Education"). We only accept columns that genuinely carry numeric marks so
   * numeric metadata columns are not silently turned into subjects.
   */
  if (numericRatio >= 0.5) {
    if (labels.length > 1) return true;

    if (
      !isGenericHeaderLabel(header.leaf) &&
      !isComponentLabel(header.leaf)
    ) {
      return true;
    }
  }

  return false;
}

/**
 * "MATHEMATICS | GRADE" — a letter grade attached to one academic subject.
 * The parent label must really be a subject, otherwise a bare "GRADE" column
 * (which schools sometimes use for the class) is left alone.
 */
function isSubjectGradeComponent(
  header: EffectiveColumnHeader,
): boolean {
  const labels = header.labels ?? [];
  if (labels.length < 2) return false;

  const leaf = safeNormalize(labels[labels.length - 1]);
  if (!/^(grades?|grd)$/.test(leaf)) return false;

  return labels
    .slice(0, -1)
    .some((label) => labelMatchesSubject(label));
}

function isGradeColumn(
  header: EffectiveColumnHeader,
): boolean {
  /* Grade/co-scholastic detection must not be blocked by generic
     non-subject rules. Check the actual grade indicators first. */
  const labels = header.labels ?? [];
  const normalizedLabels = labels.map(safeNormalize);
  const path = safeNormalize(header.path);
  const leaf = safeNormalize(header.leaf);

  const gradeMatch = GRADE_SUBJECT_INDICATORS.some((indicator) => {
    const token = safeNormalize(indicator);
    if (token.length <= 1) return false;
    if (leaf === token) return true;
    if (normalizedLabels.some((label) => label === token)) return true;
    /*
     * Only longer multi-word indicators ("physical education", "art
     * education", ...) are matched as substrings. Short tokens such as "art"
     * or "pe" must match a label exactly to avoid mis-classifying real
     * subjects that merely contain those letters.
     */
    return token.length >= 6 && path.includes(token);
  });

  if (!gradeMatch) return false;

  // Hard-protect real student identity fields.
  return !labels.some((label) =>
    isDobHeader(label) ||
    isFatherHeader(label) ||
    isMotherHeader(label) ||
    isAddressHeader(label) ||
    isStudentNameHeader(label) ||
    isRollHeader(label)
  );
}

function isForbiddenSubjectLabel(
  text: string,
): boolean {
  const norm = safeNormalize(text);

  if (!norm) return true;

  /*
   * Never allow these to be interpreted as subjects.
   */
  if (
    NON_SUBJECT_WORDS.some((word) =>
      norm === safeNormalize(word),
    )
  ) {
    return true;
  }

  if (
    isKnownNonSubjectHeader(text)
  ) {
    return true;
  }

  if (
    isDobHeader(text) ||
    isFatherHeader(text) ||
    isMotherHeader(text) ||
    isAddressHeader(text) ||
    isStudentNameHeader(text) ||
    isRollHeader(text)
  ) {
    return true;
  }

  return false;
}

function hasMarksLikeHeader(
  header: EffectiveColumnHeader,
): boolean {
  const path = safeNormalize(
    header.path,
  );

  return (
    path.includes('marks') ||
    path.includes('total') ||
    path.includes('max') ||
    path.includes('obtained') ||
    path.includes('score')
  );
}

/* -------------------------------------------------------------------------- */
/* MAXIMUM MARKS ROW                                                         */
/* -------------------------------------------------------------------------- */

/** Numeric value of a cell, or null when it is empty / not a number. */
function readCellNumber(ws: XLSX.WorkSheet, row: number, col: number): number | null {
  const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })];
  if (!cell) return null;
  if (typeof cell.v === 'number' && Number.isFinite(cell.v)) return cell.v;
  const text = String(cell.v ?? '').replace(/%/g, '').trim();
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** True when a cell holds text (a student name, a subject label, …). */
function cellHasText(ws: XLSX.WorkSheet, row: number, col: number): boolean {
  const cell = ws[XLSX.utils.encode_cell({ r: row, c: col })];
  return typeof cell?.v === 'string' && cell.v.trim() !== '';
}

/**
 * Reads the workbook's maximum-marks row and writes it onto the components.
 *
 * The row is only ever looked for BETWEEN the header block and the first student
 * row — never inside the data — so a student whose components happen to add up
 * to their total can never be mistaken for the paper's maxima. Inside that
 * window it must carry no text in any component column and prove itself: at
 * least one subject group's component values have to add up to that group's own
 * TOTAL cell on the same row.
 *
 * An existing maximum (from a header like "PT (10)") is never overwritten.
 */
function applyMaxMarksRow(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  layout: { headerStartRow: number; headerRows: number; headerEndRow: number; dataStartRow: number },
  subjectGroups: SubjectGroup[],
  _studentFields: { excelColumn: number }[],
): void {
  if (subjectGroups.length === 0) return;

  const firstCandidate = layout.headerEndRow + 1;
  const lastCandidate = Math.min(range.e.r, layout.dataStartRow - 1);
  if (lastCandidate < firstCandidate) return;

  const components = subjectGroups.flatMap((group) => group.components ?? []);

  let maxima: Map<number, number> | null = null;

  for (let row = firstCandidate; row <= lastCandidate; row++) {
    /* A maxima row never has a subject or note written over a component. */
    if (components.some((component) => cellHasText(ws, row, component.col))) continue;

    const values = new Map<number, number>();
    for (const component of components) {
      const value = readCellNumber(ws, row, component.col);
      if (value !== null) values.set(component.col, value);
    }
    if (values.size === 0) continue;
    /* Every subject group must be represented, or this is not the maxima row. */
    if (!subjectGroups.every((group) => (group.components ?? []).some((c) => values.has(c.col)))) {
      continue;
    }

    /* Proof: some group's component values add up to its own TOTAL on this row. */
    const provesItself = subjectGroups.some((group) => {
      const total = (group.components ?? []).find((component) => component.isTotal);
      if (!total) return false;
      const totalValue = values.get(total.col);
      if (totalValue === undefined) return false;
      const parts = (group.components ?? [])
        .filter((component) => !component.isTotal)
        .map((component) => values.get(component.col))
        .filter((value): value is number => value !== undefined);
      if (parts.length === 0) return false;
      const sum = parts.reduce((totalOfParts, value) => totalOfParts + value, 0);
      return Math.abs(sum - totalValue) <= 0.001;
    });
    if (!provesItself) continue;

    maxima = values;
    break;
  }

  if (!maxima) return;

  for (const group of subjectGroups) {
    for (const component of group.components ?? []) {
      const value = maxima.get(component.col);
      if (value === undefined || value <= 0) continue;
      if (typeof component.maxMarks === 'number' && component.maxMarks > 0) continue;
      component.maxMarks = value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* SUBJECT GROUPING                                                           */
/* -------------------------------------------------------------------------- */

function buildSubjectGroups(
  classifications: ColumnClassification[],
): {
  subjectGroups: SubjectGroup[];
  gradeFields: GradeField[];
} {
  const subjectGroups: SubjectGroup[] = [];
  const gradeFields: GradeField[] = [];

  /*
   * Grade columns are individual fields.
   */
  for (const item of classifications) {
    if (
      item.grade &&
      !item.studentField &&
      !item.overallField
    ) {
      gradeFields.push({
        name: item.header.path,
        col: item.col,
        confidence: 0.92,
      });
    }
  }

  /*
   * Only genuine academic columns enter this phase.
   */
  const subjectColumns =
    classifications.filter(
      (item) =>
        item.subject &&
        !item.studentField &&
        !item.overallField &&
        !item.grade,
    );

  /*
   * Group by the first meaningful academic label
   * in the hierarchy, while preserving column position.
   */
  let current:
    | {
        name: string;
        startCol: number;
        endCol: number;
        columns: ColumnClassification[];
      }
    | null = null;

  /*
   * A subject may be interrupted by a non-subject column (for example a
   * per-subject "GRADE" column sitting between SA2 and TOTAL). Those columns
   * must not split one subject into two rows — that used to duplicate the
   * subject and double-count its marks in the grand total.
   */
  const subjectColumnSet = new Set(subjectColumns.map((item) => item.col));
  const onlyNonSubjectColumnsBetween = (from: number, to: number): boolean => {
    for (let col = from + 1; col < to; col++) {
      if (subjectColumnSet.has(col)) return false;
    }
    return true;
  };

  for (const item of subjectColumns) {
    const subjectName =
      getSubjectName(item.header, item.numericRatio);

    if (!subjectName) continue;

    const sameGroup =
      current &&
      normalizeGroupName(
        current.name,
      ) ===
        normalizeGroupName(
          subjectName,
        ) &&
      (item.col === current.endCol + 1 ||
        (item.col > current.endCol &&
          onlyNonSubjectColumnsBetween(current.endCol, item.col)));

    if (!sameGroup) {
      if (current) {
        subjectGroups.push(
          createSubjectGroup(
            current.name,
            current.startCol,
            current.endCol,
            current.columns,
          ),
        );
      }

      current = {
        name: subjectName,
        startCol: item.col,
        endCol: item.col,
        columns: [item],
      };
    } else {
      current!.endCol = item.col;
      current!.columns.push(item);
    }
  }

  if (current) {
    subjectGroups.push(
      createSubjectGroup(
        current.name,
        current.startCol,
        current.endCol,
        current.columns,
      ),
    );
  }

  return {
    subjectGroups,
    gradeFields,
  };
}

function getSubjectName(
  header: EffectiveColumnHeader,
  numericRatio = 0,
): string | null {
  /*
   * First prefer a known academic label. This keeps familiar school
   * subjects such as English, Hindi, Maths, Science, SCI., SST and
   * Computer stable without relying on the leaf/component name.
   */
  for (const label of header.labels) {
    if (labelMatchesSubject(label)) {
      return cleanSubjectName(label);
    }
  }

  /*
   * Generic fallback for schools using subject names that are not in our
   * vocabulary. We only accept a parent/header label that looks like a
   * subject and whose column contains numeric marks. This keeps the
   * parser genuinely dynamic instead of requiring every possible subject
   * name to be hard-coded.
   *
   * Example:
   *   "Environmental Education | PT"
   *   "Artificial Intelligence | Theory"
   *   "Value Education | Total"
   *
   * The component itself is not selected as the subject name.
   */
  if (numericRatio >= 0.15 && header.labels.length > 1) {
    const candidates = header.labels
      .map((label) => cleanSubjectName(label))
      .filter(Boolean)
      .filter((label) => !isGenericHeaderLabel(label))
      .filter((label) => !isComponentLabel(label))
      .filter((label) => !isForbiddenSubjectLabel(label));

    if (candidates.length > 0) {
      /* Prefer the last meaningful parent label before the component. */
      return candidates[candidates.length - 1];
    }
  }

  /*
   * A single-column subject can have no component parent. For these files,
   * accept the leaf only when it is numeric and is not a known protected
   * field/header.
   */
  if (
    numericRatio >= 0.15 &&
    header.labels.length === 1 &&
    !isGenericHeaderLabel(header.leaf) &&
    !isComponentLabel(header.leaf) &&
    !isForbiddenSubjectLabel(header.leaf)
  ) {
    return cleanSubjectName(header.leaf);
  }

  return null;
}

function isComponentLabel(text: string): boolean {
  const normalized = safeNormalize(text);
  if (!normalized) return true;

  /* "SA2" / "PT-1" / "PT(10)" are the component term plus an index. */
  const withoutIndex = normalized.replace(/[0-9]+$/, '');
  const words = wordsOf(text);

  return COMPONENT_TERMS.some((term) => {
    const termWords = wordsOf(term);
    if (termWords.length === 0) return false;

    const termCompact = termWords.join('');
    if (normalized === termCompact || withoutIndex === termCompact) return true;

    /*
     * Whole words only. Substring matching meant any long subject name
     * containing the letters of a short term was mistaken for a component:
     * "ENVIRONMENTAL EDUCATION AND DISASTER MANAGEMENT" contains "sa" and
     * "...disasTERManagement" contains "term", so the whole column used to be
     * dropped from the report card.
     */
    if (termWords.length === 1) return words.includes(termWords[0]);

    for (let start = 0; start + termWords.length <= words.length; start++) {
      if (termWords.every((word, offset) => words[start + offset] === word)) {
        return true;
      }
    }

    return false;
  });
}

function isGenericHeaderLabel(text: string): boolean {
  const normalized = safeNormalize(text);
  if (!normalized) return true;

  const generic = [
    'school',
    'schoolname',
    'publicschool',
    'schoolcode',
    'academic',
    'academicsession',
    'session',
    'term',
    'finalterm',
    'annual',
    'examination',
    'exam',
    'result',
    'reportcard',
    'marksheet',
    'class',
    'section',
    'subject',
    'subjects',
    'student',
    'students',
  ];

  if (generic.includes(normalized)) return true;

  /* School-title style labels should never become subjects. */
  if (
    normalized.includes('publicschool') ||
    normalized.includes('school') && normalized.length > 8
  ) {
    return true;
  }

  return false;
}

function cleanSubjectName(
  value: string,
): string {
  return value
    .replace(
      /\s*\((?:max|marks?|out of)[^)]*\)/gi,
      '',
    )
    .replace(
      /\s*\[[^\]]*\]/g,
      '',
    )
    .trim();
}

function normalizeGroupName(
  value: string,
): string {
  return safeNormalize(
    cleanSubjectName(value),
  );
}

function createSubjectGroup(
  name: string,
  startCol: number,
  endCol: number,
  columns: ColumnClassification[],
): SubjectGroup {
  const components: SubjectComponent[] =
    [];

  let hasTotal = false;

  for (const item of columns) {
    const isTotal =
      isTotalColumn(
        item.header.leaf,
      );

    if (isTotal) {
      hasTotal = true;
    }

    components.push({
      name: getComponentName(
        item.header,
      ),
      col: item.col,
      maxMarks: extractMaxMarks(
        item.header.path,
      ),
      isTotal,
    });
  }

  /*
   * If a subject has only a single column,
   * that column itself is the marks field.
   */
  return {
    name,
    startCol,
    endCol,
    components,
    hasTotal,
    confidence:
      calculateSubjectGroupConfidence(
        columns,
      ),
  };
}

function getComponentName(
  header: EffectiveColumnHeader,
): string {
  if (header.labels.length <= 1) {
    return header.leaf;
  }

  /*
   * Remove the subject parent from the
   * component label.
   */
  const subjectIndex =
    header.labels.findIndex((label) =>
      labelMatchesSubject(label),
    );

  if (
    subjectIndex >= 0 &&
    subjectIndex <
      header.labels.length - 1
  ) {
    return header.labels
      .slice(subjectIndex + 1)
      .join(' | ');
  }

  return header.leaf;
}

function calculateSubjectGroupConfidence(
  columns: ColumnClassification[],
): number {
  if (!columns.length) return 0;

  const numericAverage =
    columns.reduce(
      (sum, item) =>
        sum + item.numericRatio,
      0,
    ) / columns.length;

  const numericBonus = Math.min(
    numericAverage,
    1,
  ) * 0.08;

  return Math.min(
    0.98,
    0.88 + numericBonus,
  );
}

/* -------------------------------------------------------------------------- */
/* OVERALL FIELDS                                                             */
/* -------------------------------------------------------------------------- */

function identifyOverallFieldFromPath(
  header: EffectiveColumnHeader,
): {
  fieldType: OverallField['fieldType'];
  confidence: number;
} | null {
  /* Student identity fields always win. */
  if (
    header.labels.some((label) =>
      isForbiddenStudentOverallLabel(label)
    )
  ) {
    return null;
  }

  /*
   * Use the leaf for standalone result columns. The full path may contain
   * school/class labels, so checking path === "TOTAL" or path === "%"
   * incorrectly misses valid overall columns.
   */
  const pathNorm = safeNormalize(header.path);
  const rawLeaf = String(header.leaf ?? '').trim();
  const leafNorm = rawLeaf === '%' ? '%' : safeNormalize(rawLeaf);

  if (
    leafNorm === '%' ||
    leafNorm === 'percent' ||
    leafNorm === 'percentage' ||
    pathNorm.endsWith('%') ||
    pathNorm.endsWith('percent') ||
    pathNorm.endsWith('percentage')
  ) {
    return {
      fieldType: 'percentage',
      confidence: 0.98,
    };
  }

  const explicitOverallTotal =
    leafNorm === 'grandtotal' ||
    leafNorm === 'overalltotal' ||
    leafNorm === 'finaltotal' ||
    pathNorm.endsWith('grandtotal') ||
    pathNorm.endsWith('overalltotal') ||
    pathNorm.endsWith('finaltotal');

  const hasAcademicParent = header.labels.some((label) =>
    SUBJECT_INDICATORS.some((indicator) =>
      safeNormalize(label).includes(safeNormalize(indicator))
    )
  );

  const hasGradeParent = header.labels.some((label) =>
    GRADE_SUBJECT_INDICATORS.some((indicator) =>
      safeNormalize(label).includes(safeNormalize(indicator))
    )
  );

  /* A leaf TOTAL is overall when it is not under an academic subject.
     This handles flattened headers such as "School | TOTAL". */
  const standaloneTotal =
    leafNorm === 'total' &&
    !hasAcademicParent &&
    !hasGradeParent;

  if (explicitOverallTotal || standaloneTotal) {
    return {
      fieldType: 'total',
      confidence: 0.98,
    };
  }

  if (
    leafNorm.includes('position') ||
    leafNorm.includes('rank') ||
    leafNorm.includes('merit') ||
    pathNorm.endsWith('position') ||
    pathNorm.endsWith('rank') ||
    pathNorm.endsWith('merit')
  ) {
    return {
      fieldType: 'position',
      confidence: 0.94,
    };
  }

  if (
    leafNorm.includes('attendance') ||
    leafNorm.includes('dayspresent') ||
    leafNorm.includes('workingdays') ||
    pathNorm.endsWith('attendance') ||
    pathNorm.endsWith('dayspresent') ||
    pathNorm.endsWith('workingdays')
  ) {
    return {
      fieldType: 'attendance',
      confidence: 0.94,
    };
  }

  if (
    leafNorm.includes('remarks') ||
    leafNorm.includes('remark') ||
    leafNorm.includes('comment')
  ) {
    return {
      fieldType: 'remarks',
      confidence: 0.94,
    };
  }

  return null;
}

function isForbiddenStudentOverallLabel(
  text: string,
): boolean {
  return (
    isDobHeader(text) ||
    isFatherHeader(text) ||
    isMotherHeader(text) ||
    isAddressHeader(text) ||
    isStudentNameHeader(text) ||
    isRollHeader(text)
  );
}

function calculateOverallFieldConfidence(
  header: string,
  fieldType: OverallField['fieldType'],
): number {
  const norm = safeNormalize(
    header,
  );

  const exactPatterns: Record<
    OverallField['fieldType'],
    string[]
  > = {
    total: [
      'grandtotal',
      'overalltotal',
    ],
    percentage: [
      'percentage',
      'percent',
    ],
    position: [
      'position',
      'rank',
      'merit',
    ],
    attendance: [
      'attendance',
      'dayspresent',
      'workingdays',
    ],
    remarks: [
      'remarks',
      'remark',
      'comment',
      'comments',
    ],
  };

  if (
    exactPatterns[fieldType].some(
      (pattern) =>
        norm ===
        safeNormalize(pattern),
    )
  ) {
    return 0.97;
  }

  return 0.82;
}

/* -------------------------------------------------------------------------- */
/* NUMERIC DATA                                                               */
/* -------------------------------------------------------------------------- */

function calculateColumnNumericRatio(
  ws: XLSX.WorkSheet,
  range: XLSX.Range,
  col: number,
  dataStartRow: number,
): number {
  let total = 0;
  let numeric = 0;

  const endRow = Math.min(
    range.e.r,
    dataStartRow + 15,
  );

  for (
    let row = dataStartRow;
    row <= endRow;
    row++
  ) {
    const text = getCellText(
      ws,
      row,
      col,
    );

    if (!text) continue;

    total++;

    if (Number.isFinite(Number(text))) {
      numeric++;
    }
  }

  return total > 0
    ? numeric / total
    : 0;
}

/* -------------------------------------------------------------------------- */
/* TOTAL / MAX MARKS                                                          */
/* -------------------------------------------------------------------------- */

function isTotalColumn(
  text: string,
): boolean {
  const norm = safeNormalize(text);

  return (
    norm === 'total' ||
    norm === 'subtotal' ||
    norm === 'grandtotal' ||
    norm === 'overalltotal' ||
    norm.endsWith('total')
  );
}

function extractMaxMarks(
  text: string,
): number | undefined {
  const bracket =
    text.match(
      /\(\s*(\d+(?:\.\d+)?)\s*\)/,
    ) ||
    text.match(
      /\[\s*(\d+(?:\.\d+)?)\s*\]/,
    );

  if (bracket) {
    return Number(bracket[1]);
  }

  const maxMatch = text.match(
    /max(?:imum)?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i,
  );

  if (maxMatch) {
    return Number(maxMatch[1]);
  }

  const outOfMatch = text.match(
    /out\s*of\s*(\d+(?:\.\d+)?)/i,
  );

  if (outOfMatch) {
    return Number(outOfMatch[1]);
  }

  return undefined;
}

/* -------------------------------------------------------------------------- */
/* CONFIDENCE                                                                 */
/* -------------------------------------------------------------------------- */

function calculateConfidence(
  studentFields: FieldMapping[],
  subjectGroups: SubjectGroup[],
  gradeFields: GradeField[],
  overallFields: OverallField[],
): number {
  const hasName = studentFields.some(
    (field) =>
      field.fieldType === 'name',
  );

  const hasRoll = studentFields.some(
    (field) =>
      field.fieldType === 'rollNo',
  );

  const hasDob = studentFields.some(
    (field) =>
      field.fieldType === 'dob',
  );

  const hasFather = studentFields.some(
    (field) =>
      field.fieldType ===
      'fatherName',
  );

  /*
   * Required identity fields provide strong confidence.
   */
  let score = 0.35;

  if (hasName) score += 0.18;
  if (hasRoll) score += 0.15;
  if (hasDob) score += 0.08;
  if (hasFather) score += 0.08;

  if (subjectGroups.length > 0) {
    score += Math.min(
      subjectGroups.length * 0.025,
      0.12,
    );
  }

  if (gradeFields.length > 0) {
    score += 0.03;
  }

  if (overallFields.length > 0) {
    score += 0.03;
  }

  return Math.min(
    0.99,
    Math.max(0, score),
  );
}

/* -------------------------------------------------------------------------- */
/* LEGACY HELPERS                                                             */
/* -------------------------------------------------------------------------- */

function getBigrams(
  value: string,
): Set<string> {
  const result = new Set<string>();
  const clean = safeNormalize(value);

  for (
    let index = 0;
    index < clean.length - 1;
    index++
  ) {
    result.add(
      clean.substring(
        index,
        index + 2,
      ),
    );
  }

  return result;
}

function bigramOverlap(
  a: string,
  b: string,
): number {
  const first = getBigrams(a);
  const second = getBigrams(b);

  if (!first.size || !second.size) {
    return 0;
  }

  let intersection = 0;

  for (const item of first) {
    if (second.has(item)) {
      intersection++;
    }
  }

  const union =
    first.size +
    second.size -
    intersection;

  return union > 0
    ? intersection / union
    : 0;
}

function identifyStudentFieldType(
  header: string,
): {
  fieldType: FieldMapping['fieldType'];
  confidence: number;
} {
  const effective: EffectiveColumnHeader = {
    col: -1,
    labels: [header],
    leaf: header,
    path: header,
    normalizedPath:
      safeNormalize(header),
    normalizedLeaf:
      safeNormalize(header),
  };

  return identifyStudentField(
    effective,
  );
}

function mapAliasFieldToFieldType(
  aliasField: string,
): FieldMapping['fieldType'] {
  const mapping: Record<
    string,
    FieldMapping['fieldType']
  > = {
    name: 'name',
    rollNo: 'rollNo',
    admissionNo: 'admissionNo',
    class: 'class',
    section: 'section',
    fatherName: 'fatherName',
    motherName: 'motherName',
    dob: 'dob',
    address: 'address',
    attendance: 'attendance',
    workingDays: 'workingDays',
    daysPresent: 'daysPresent',
    position: 'position',
    photoFilename: 'photo',
    teacherRemarks: 'remarks',
    principalRemarks: 'remarks',
  };

  return (
    mapping[aliasField] ||
    'ignore'
  );
}

function calculateFieldConfidence(
  header: string,
  fieldType: FieldMapping['fieldType'],
): number {
  return identifyStudentFieldType(
    header,
  ).confidence;
}

function looksLikeSubject(
  text: string,
): boolean {
  const header: EffectiveColumnHeader = {
    col: -1,
    labels: [text],
    leaf: text,
    path: text,
    normalizedPath:
      safeNormalize(text),
    normalizedLeaf:
      safeNormalize(text),
  };

  return isAcademicColumn(header);
}

function looksLikeGradeField(
  text: string,
): boolean {
  return GRADE_SUBJECT_INDICATORS.some(
    (indicator) =>
      safeNormalize(text).includes(
        safeNormalize(indicator),
      ),
  );
}

/* -------------------------------------------------------------------------- */
/* UTILS                                                                      */
/* -------------------------------------------------------------------------- */

export function convertColumnToLetter(
  col: number,
): string {
  let letter = '';
  let temp = col;

  while (temp >= 0) {
    letter =
      String.fromCharCode(
        (temp % 26) + 65,
      ) + letter;

    temp =
      Math.floor(temp / 26) - 1;
  }

  return letter;
}

export function convertLetterToColumn(
  letter: string,
): number {
  let column = 0;

  const normalized =
    letter.toUpperCase().trim();

  for (
    let index = 0;
    index < normalized.length;
    index++
  ) {
    column =
      column * 26 +
      (normalized.charCodeAt(index) -
        64);
  }

  return column - 1;
}
