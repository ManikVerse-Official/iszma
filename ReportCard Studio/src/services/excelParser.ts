import * as XLSX from 'xlsx';
import type { WorkbookData } from '../types';
import { normalizeHeader } from '../utils/normalization';

export interface ParsedSheet {
  headers: string[];
  rows: Record<string, unknown>[];
  headerRows: number;
  dataStartRow: number;
}

const COMMON_HEADER_TERMS = [
  'name', 'roll', 'serial', 'admission', 'father', 'mother', 'dob', 'class', 'section',
  'english', 'hindi', 'math', 'science', 'social', 'sst', 'computer', 'pt', 'nb', 'se', 'sa2',
  'total', 'percentage', 'attendance', 'position', 'marks', 'grade', 'rank',
];

export function parseWorkbookFromFile(file: File): Promise<WorkbookData> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array', cellDates: true, raw: true });
        const sheetNames = wb.SheetNames;
        const activeSheet = sheetNames[0] ?? '';
        const parsed = activeSheet
          ? parseSheetFromWorkbook(wb, activeSheet)
          : { headers: [], rows: [], headerRows: 1, dataStartRow: 1 };
        resolve({
          fileName: file.name,
          sheetNames,
          activeSheet,
          headers: parsed.headers,
          rows: parsed.rows,
        });
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

export function parseSheetFromWorkbook(
  wb: XLSX.WorkBook,
  sheetName: string,
): ParsedSheet {
  const ws = wb.Sheets[sheetName];
  if (!ws) return { headers: [], rows: [], headerRows: 1, dataStartRow: 1 };

  const json = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: false,
    defval: '',
    raw: true,
    dateNF: 'yyyy-mm-dd',
  });

  if (!json.length) return { headers: [], rows: [], headerRows: 1, dataStartRow: 1 };

  /*
   * The worksheet range rarely starts at column A (a mark sheet whose title
   * block begins at B gives `!ref` = "B1:AW19"). `sheet_to_json` returns one
   * array per row starting at that first column, so array position is NOT the
   * Excel column index. Everything downstream identifies a column by its real
   * Excel index, so the arrays are realigned to absolute column indexes here.
   */
  const sheetRange = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const colOffset = sheetRange.s.c;
  const rowOffset = sheetRange.s.r;

  /*
   * Merged regions are expressed in absolute sheet coordinates; the header
   * helpers work on the row/column indexes of the JSON arrays, so the merges
   * are shifted into that space once, here.
   */
  const merges = (ws['!merges'] || []).map((m) => ({
    s: { r: m.s.r - rowOffset, c: m.s.c - colOffset },
    e: { r: m.e.r - rowOffset, c: m.e.c - colOffset },
  }));

  const { headerRows, dataStartRow } = detectHeaderRows(json, merges);

  const flattened = buildFlattenedHeaders(json, headerRows, merges, dataStartRow);

  /* Absolute column index → header text (leading columns stay empty). */
  const headers: string[] = new Array(colOffset).fill('');
  headers.push(...flattened);

  const rows: Record<string, unknown>[] = [];
  for (let r = dataStartRow; r < json.length; r++) {
    const rawRow = (json[r] ?? []) as unknown[];
    const isEmpty = rawRow.every((c) => String(c ?? '').trim() === '');
    if (isEmpty) continue;

    /* Same realignment for the raw cell arrays. */
    const cells: unknown[] = new Array(colOffset).fill('');
    cells.push(...rawRow);

    const obj: Record<string, unknown> = {};
    headers.forEach((h, i) => {
      if (!h) return;
      obj[h] = cells[i] ?? '';
    });

    Object.defineProperty(obj, '__rowNumber', {
      value: r + rowOffset + 1,
      enumerable: false,
    });

    Object.defineProperty(obj, '__cells', {
      value: cells,
      enumerable: false,
    });

    rows.push(obj);
  }

  return { headers, rows, headerRows, dataStartRow };
}

function detectHeaderRows(
  json: unknown[][],
  merges: XLSX.Range[],
): { headerRows: number; dataStartRow: number } {
  if (!json.length) return { headerRows: 1, dataStartRow: 1 };

  const width = json.reduce((max, row) => Math.max(max, row.length), 0);
  const maxScan = Math.min(json.length, 60);

  /*
   * The header region is everything above the FIRST row that begins a run of
   * student rows. A grouped mark sheet has several header rows stacked on top of
   * each other (title, subject groups, PT/NB/SEA/SA1/TOTAL components); the old
   * "max merged row span" guess only counted two of them, so the component row
   * was read as the first student and every column lost its component name.
   */
  let dataStartRow = -1;

  for (let row = 0; row < maxScan; row++) {
    const rowData = json[row] as unknown[];

    if (isEmptyRow(rowData)) continue;
    if (isTitleLikeRowData(rowData, width)) continue;
    if (!isLikelyDataRow(rowData)) continue;

    /* A real data row is normally followed by another data row. */
    const next = json[row + 1] as unknown[] | undefined;
    const nextIsData = !next || isEmptyRow(next) || isLikelyDataRow(next);

    if (nextIsData) {
      dataStartRow = row;
      break;
    }
  }

  /*
   * Text-only sheets (for example letter grades with no numeric marks) never
   * satisfy `isLikelyDataRow`; fall back to the first row that carries no
   * header vocabulary and whose next row looks the same.
   */
  if (dataStartRow < 0) {
    for (let row = 0; row < maxScan; row++) {
      const rowData = json[row] as unknown[];
      if (isEmptyRow(rowData)) continue;
      if (isTitleLikeRowData(rowData, width)) continue;
      if (isLikelyHeaderRow(rowData)) continue;

      const next = json[row + 1] as unknown[] | undefined;
      if (!next || isEmptyRow(next) || !isLikelyHeaderRow(next)) {
        dataStartRow = row;
        break;
      }
    }
  }

  /*
   * Nothing recognisable: keep the historical "one row per merged level"
   * heuristic so a two-column workbook still imports.
   */
  if (dataStartRow < 0) {
    const maxRowSpan = merges.length
      ? Math.max(...merges.map((m) => m.e.r - m.s.r + 1))
      : 1;
    dataStartRow = Math.min(json.length, Math.max(1, Math.min(maxRowSpan, 4)));
  }

  const headerRows = Math.max(1, Math.min(dataStartRow, json.length));

  /*
   * Absorb rows that are still part of a vertically merged header block.
   *
   * Mark sheets put a "maximum marks" row under labels such as "S.No" that
   * span several rows. That row is nearly all numbers, so it passes the
   * data-row test, but it is not a student: the merge reaching into it proves
   * it is still header context. Keeping it out of both the label rows and the
   * data rows is what stops it being imported as student #1 (which shifted
   * every later row and made the marks columns read off by one).
   */
  let firstDataRow = Math.max(headerRows, dataStartRow);

  while (
    firstDataRow < json.length &&
    merges.some((m) => m.s.r < firstDataRow && m.e.r >= firstDataRow)
  ) {
    firstDataRow++;
  }

  return { headerRows, dataStartRow: firstDataRow };
}

/**
 * A title/heading row holds at most one or two distinct values across a wide
 * sheet. Real header rows hold one label per column.
 */
function isTitleLikeRowData(row: unknown[], maxCols: number): boolean {
  if (maxCols <= 3) return false;

  const distinct = new Set<string>();
  for (const cell of row ?? []) {
    const value = String(cell ?? '').trim();
    if (value) distinct.add(value);
  }

  if (distinct.size === 0) return false;
  if (distinct.size === 1) return true;
  if (distinct.size > 2) return false;

  return /(school|class|grade|std|standard|session|term|exam|report|result)/i.test(
    [...distinct].join(' '),
  );
}

function isEmptyRow(row: unknown[]): boolean {
  if (!row || row.length === 0) return true;
  return row.every(cell => String(cell ?? '').trim() === '');
}

function isLikelyHeaderRow(row: unknown[]): boolean {
  if (!row || row.length === 0) return false;

  const textCount = row.filter(cell => {
    const val = String(cell ?? '').trim();
    return val !== '' && isNaN(Number(val));
  }).length;

  const numericCount = row.filter(cell => {
    const val = String(cell ?? '').trim();
    return val !== '' && !isNaN(Number(val));
  }).length;

  const total = textCount + numericCount;
  if (total === 0) return false;

  const textRatio = textCount / total;

  const hasCommonHeaderTerms = row.some(cell => {
    const val = normalizeHeader(String(cell ?? ''));
    return COMMON_HEADER_TERMS.some(term => val.includes(term));
  });

  if (hasCommonHeaderTerms && textRatio > 0.5) return true;

  return textRatio > 0.7;
}

function checkNextRowsForData(json: unknown[][], startRow: number): boolean {
  const rowsToCheck = Math.min(3, json.length - startRow);
  if (rowsToCheck < 1) return false;
  let dataRowCount = 0;

  for (let i = 0; i < rowsToCheck; i++) {
    const row = json[startRow + i] as unknown[];
    if (isLikelyDataRow(row)) {
      dataRowCount++;
    }
  }

  return dataRowCount >= Math.min(2, rowsToCheck);
}

function isLikelyDataRow(row: unknown[]): boolean {
  if (!row || row.length === 0) return false;

  const textCount = row.filter(cell => {
    const val = String(cell ?? '').trim();
    return val !== '' && isNaN(Number(val));
  }).length;

  const numericCount = row.filter(cell => {
    const val = String(cell ?? '').trim();
    return val !== '' && !isNaN(Number(val));
  }).length;

  const total = textCount + numericCount;
  if (total === 0) return false;

  const numericRatio = numericCount / total;

  const hasMix = textCount > 0 && numericCount > 0;
  const mostlyNumeric = numericRatio >= 0.4;

  const hasHeaderTerms = row.some(cell => {
    const val = normalizeHeader(String(cell ?? ''));
    return COMMON_HEADER_TERMS.some(term => val === term || val.startsWith(term + ' '));
  });

  if (hasHeaderTerms && numericRatio < 0.3) return false;

  return hasMix || mostlyNumeric;
}

function buildFlattenedHeaders(
  json: unknown[][],
  headerRows: number,
  merges: XLSX.Range[],
  dataStartRow: number,
): string[] {
  if (headerRows <= 0 || !json.length) return [];

  const headerStructure: string[][] = [];
  for (let row = 0; row < headerRows; row++) {
    if (row < json.length) {
      const rowData = json[row] as unknown[];
      headerStructure.push(rowData.map(cell => String(cell ?? '').trim()));
    } else {
      headerStructure.push([]);
    }
  }

  const maxCols = headerStructure.reduce((max, row) => Math.max(max, row.length), 0);

  /*
   * Rows that only carry a title/heading (for example "Some Public School
   * (CLASS-3rd)") must never pollute column names, otherwise every header
   * becomes "School Name | Student Name" and duplicate titles can hide real
   * columns.
   */
  const titleRows = new Set<number>();
  for (let row = 0; row < headerRows; row++) {
    if (isTitleLikeHeaderRow(headerStructure[row], maxCols)) {
      titleRows.add(row);
    }
  }

  /*
   * Grouped headers often only spell the subject name once, above the FIRST of
   * its component columns (the rest of the group row is blank). Carrying that
   * label across the blank cells — up to the next filled cell — is what lets
   * "English | PT", "English | NB", "English | SEA", … stay attached to the
   * same subject even when the workbook has no merged cells at all.
   *
   * Only the group rows (everything above the last header row) are filled; the
   * last row carries one distinct component per column and must never be
   * propagated sideways.
   */
  /*
   * A column that holds nothing below the header cannot own an inherited
   * label (a stray empty column next to "Attendance" must not become a second
   * attendance column).
   */
  const columnHasData = (col: number): boolean => {
    for (let row = dataStartRow; row < json.length; row++) {
      const value = String((json[row] as unknown[] | undefined)?.[col] ?? '').trim();
      if (value) return true;
    }

    return false;
  };

  for (let row = 0; row < headerRows - 1; row++) {
    if (titleRows.has(row)) continue;
    let carried = '';
    /*
     * How far right a carried label may reach. A label inside a merged region
     * describes exactly that region: "S.No" (merged B3:B5) must not spill into
     * the next blank column, or "Adm" inherits it and the admission number is
     * read as the student's roll number. The same leak attached the merged
     * "Father name" (E3:E5) to the mother's column. Unmerged labels keep the
     * "carry up to the next label" behaviour that grouped-but-unmerged mark
     * sheets rely on.
     */
    let carriedEndCol = -1;

    for (let col = 0; col < maxCols; col++) {
      const value = headerStructure[row][col] || '';
      const merge = merges.find(m =>
        col >= m.s.c && col <= m.e.c && row >= m.s.r && row <= m.e.r,
      );

      if (value) {
        carried = value;
        carriedEndCol = merge ? merge.e.c : maxCols - 1;
      } else if (
        carried &&
        !merge &&
        col <= carriedEndCol &&
        columnHasData(col)
      ) {
        headerStructure[row][col] = carried;
      }
    }
  }

  const headers: string[] = [];

  for (let col = 0; col < maxCols; col++) {
    const headerParts: string[] = [];

    for (let row = 0; row < headerRows; row++) {
      if (titleRows.has(row)) continue;

      let cellValue = headerStructure[row][col] || '';

      const merge = merges.find(m =>
        col >= m.s.c && col <= m.e.c &&
        row >= m.s.r && row <= m.e.r
      );

      if (merge && (row !== merge.s.r || col !== merge.s.c)) {
        if (!cellValue && merge.s.r < headerStructure.length && merge.s.c < (headerStructure[merge.s.r]?.length || 0)) {
          cellValue = headerStructure[merge.s.r][merge.s.c] || '';
        }
      }

      if (!merge || (row === merge.s.r && col === merge.s.c) || (merge && !headerParts.includes(cellValue) && cellValue)) {
        if (cellValue && !headerParts.includes(cellValue)) {
          headerParts.push(cellValue);
        }
      }
    }

    if (headerParts.length > 0) {
      const uniqueParts = headerParts.filter((v, i, a) => a.indexOf(v) === i);
      if (uniqueParts.length > 1) {
        headers.push(uniqueParts.join(' | '));
      } else {
        headers.push(uniqueParts[0]);
      }
    } else {
      headers.push(`Column_${col + 1}`);
    }
  }

  return headers;
}

/**
 * A title/heading row holds at most one or two distinct values across a wide
 * sheet. Real header rows hold one label per column.
 */
function isTitleLikeHeaderRow(
  row: string[],
  maxCols: number,
): boolean {
  return isTitleLikeRowData(row ?? [], maxCols);
}

export function parseSheetFromFileByName(
  file: File,
  sheetName: string,
): Promise<ParsedSheet> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('File read failed'));
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const wb = XLSX.read(data, { type: 'array', cellDates: true, raw: true });
        resolve(parseSheetFromWorkbook(wb, sheetName));
      } catch (err) {
        reject(err);
      }
    };
    reader.readAsArrayBuffer(file);
  });
}
