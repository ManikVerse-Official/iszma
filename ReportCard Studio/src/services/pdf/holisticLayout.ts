import type jsPDF from 'jspdf';
import type { ReportCardModel, ReportCardRow } from '../reportCardModel';
import type { SchoolProfile } from '../../types';
import type { ReportCardTheme } from '../../themes';
import {
  A4_H_MM,
  A4_W_MM,
  CONTENT_W,
  CONTENT_TO_REMARKS_GAP,
  FOOTER_BAR_H,
  MARGIN_MM,
  REMARKS_TO_SIGNATURE_GAP,
  SIGNATURE_BLOCK_H,
  SIGNATURE_TO_FOOTER_GAP,
  colorsFromPalette,
  drawFooterAndFrame,
  drawInfoGrid,
  drawLogoBox,
  drawPhotoBox,
  drawSignatureBlock,
  drawStars,
  drawTextBlock,
  drawWrapped,
  fillRect,
  layoutInfoGrid,
  measureText,
  strokeRect,
  type PdfColors,
  type TextBlock,
} from './pdfKit';
import {
  academicColumnRatios,
  BODY_GAP_MM,
  CO_VALUE_W_MM,
  LEFT_W_MM,
  LOGO_MM,
  OVERALL_MAX_H_MM,
  OVERALL_MIN_H_MM,
  PHOTO_H_MM,
  PHOTO_W_MM,
  RIGHT_W_MM,
  SESSION_W_MM,
  SKILLS_GAP_MM,
} from '../../themes/geometry';
import { mmToPt, TYPE_MM } from '../../themes/typography';

/**
 * Holistic theme — PDF layout.
 *
 * Hard rules encoded here:
 *   - nothing overlaps: every drawn cell is confined to its measured box;
 *   - nothing is truncated: values wrap (the info grid, subject names, remarks
 *     and teacher/principal remarks all grow their own row);
 *   - the card stays on exactly ONE A4 page: the body auto-fits by scaling the
 *     row spacing / font a little, never by dropping content.
 */

export interface ThemeRenderOptions {
  doc: jsPDF;
  model: ReportCardModel;
  school: SchoolProfile;
  theme: ReportCardTheme;
  photoDataUrl?: string;
}

/* Geometry lives in `themes/geometry.ts` so the preview uses the exact same
 * numbers and cannot drift away from the generated PDF. */
const LEFT_X = MARGIN_MM;
const LEFT_W = LEFT_W_MM;
const RIGHT_X = MARGIN_MM + LEFT_W_MM + BODY_GAP_MM; // 134
const RIGHT_W = RIGHT_W_MM; // 68

const INFO_PADDING = 2;
const INFO_LABEL_W = 30;
const MAX_CELL_LINES = 4;

const SCALES = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55];

/**
 * Height limits (mm) applied when the spare page height is handed back to the
 * row heights: the card fills the sheet, but rows never become slabs. Fonts are
 * never scaled by the fill, so text is never stretched — only the padding grows.
 */
const MAX_ROW_MM = { academic: 12, co: 11, skills: 11, attendance: 11 };
/** Minimum height a single text row needs, whatever the fill factor. */
const TEXT_ROW_FLOOR = 4.4;
/** Upper bound of the row-growth search. */
const FILL_MAX = 2.4;
/** Left over height is shared out over the three section gaps, at most this each. */
const FILL_GAP_MAX = 3;
/**
 * The right column (co-scholastic, attendance, overall) is spread over the depth
 * of the left column so both end on the same line. The slack is shared by the
 * two gaps between those blocks and then by the overall panel itself — bounded,
 * so neither the gaps nor the panel can become oversized.
 */
const RIGHT_GAP_MAX = 12;
const OVERALL_BOX_H = OVERALL_MIN_H_MM;
const OVERALL_BOX_MAX_H = OVERALL_MAX_H_MM;

/**
 * Row height at a given fill factor.
 *
 * `natural` is the height the row wants at rest, `floor` is what the text inside
 * it needs. Growing can therefore only ever add padding: text can never overlap
 * whatever the fill factor is.
 */
function growRow(natural: number, floor: number, fill: number, cap: number): number {
  return Math.max(floor, Math.min(natural * fill, cap));
}

interface BodyLayout {
  scale: number;
  fill: number;
  acadRowHeights: number[];
  acadHeight: number;
  scaleHeight: number;
  skillsHeight: number;
  skillRowHeight: number;
  attendanceRowHeight: number;
  leftHeight: number;
  coRowHeights: number[];
  coHeight: number;
  attendanceHeight: number;
  overallHeight: number;
  rightHeight: number;
  ok: boolean;
}

function fontScale(scale: number, base: number): number {
  return Math.max(5.5, Math.round(base * scale * 10) / 10);
}

/* ── body measurement ─────────────────────────────────────────────────── */

function computeBody(
  doc: jsPDF,
  model: ReportCardModel,
  scale: number,
  fill = 1,
): BodyLayout {
  const acadFontSize = fontScale(scale, mmToPt(TYPE_MM.academic));
  const acadBaseRow = Math.max(3.6, 5.2 * scale);
  const acadNames = model.academic.map((row) => row.name);

  const acadRatios = academicColumnRatios(model.academicColumns.length);
  const subjectWidth = LEFT_W * acadRatios[0] - 3;

  let ok = true;
  const acadRowHeights = acadNames.map((name) => {
    const nameLines = measureText(doc, name, subjectWidth, {
      size: acadFontSize,
      lineHeight: acadFontSize * 0.45,
    }).lines.length;
    if (nameLines > MAX_CELL_LINES) ok = false;
    const lines = Math.max(nameLines, 1);
    const textFloor = lines * acadFontSize * 0.45 + 1.4;
    return growRow(Math.max(acadBaseRow, textFloor), textFloor, fill, MAX_ROW_MM.academic);
  });

  const acadHeight = 7 + 7 + acadRowHeights.reduce((sum, h) => sum + h, 0);

  /* Grading scale legend wraps onto as many lines as needed. */
  const scaleBlock = measureText(doc, `GRADING SCALE: ${model.gradeScale}`, LEFT_W, {
    size: fontScale(scale, mmToPt(TYPE_MM.gradingScale)),
  });
  const scaleHeight = scaleBlock.height + 2.5;

  const skillRowHeight = growRow(
    Math.max(3.4, 4.6 * scale),
    TEXT_ROW_FLOOR,
    fill,
    MAX_ROW_MM.skills,
  );
  const skillsRows = Math.max(model.personality.length, model.learning.length, 1);
  const skillsHeight = 6.5 + skillsRows * skillRowHeight;

  const leftHeight = acadHeight + scaleHeight + skillsHeight + 4;

  /* Right column: co-scholastic + attendance + overall. */
  const coFontSize = fontScale(scale, mmToPt(TYPE_MM.coScholastic));
  const coNameWidth = RIGHT_W - 15;
  const coRowHeights = model.coScholastic.map((row: ReportCardRow) => {
    const lines = Math.max(
      measureText(doc, String(row.name).toUpperCase(), coNameWidth, {
        size: coFontSize,
        lineHeight: coFontSize * 0.45,
      }).lines.length,
      1,
    );
    if (lines > MAX_CELL_LINES) ok = false;
    const textFloor = lines * coFontSize * 0.45 + 1.6;
    return growRow(Math.max(coFontSize * 0.45 + 2.4, textFloor), textFloor, fill, MAX_ROW_MM.co);
  });
  const coHeight = 7 + coRowHeights.reduce((sum, h) => sum + h, 0);

  const attendanceRowHeight = growRow(
    Math.max(4.6, 5.2 * scale),
    TEXT_ROW_FLOOR,
    fill,
    MAX_ROW_MM.attendance,
  );
  const attendanceHeight = 6.5 + Math.max(1, model.holisticDevelopment.length) * attendanceRowHeight + 1;
  const overallHeight = 6.5 + 13 + 3;

  const rightHeight = coHeight + attendanceHeight + overallHeight + 4;

  return {
    scale,
    fill,
    acadRowHeights,
    acadHeight,
    scaleHeight,
    skillsHeight,
    skillRowHeight,
    attendanceRowHeight,
    leftHeight,
    coRowHeights,
    coHeight,
    attendanceHeight,
    overallHeight,
    rightHeight,
    ok,
  };
}

/* ── header ───────────────────────────────────────────────────────────── */

const PHOTO_W = PHOTO_W_MM;
const PHOTO_H = PHOTO_H_MM;

function drawHeader(
  doc: jsPDF,
  model: ReportCardModel,
  colors: PdfColors,
  photoDataUrl?: string,
): number {
  const { header } = model;
  const headerTop = MARGIN_MM;
  const logoSize = LOGO_MM;

  drawLogoBox(doc, header.logoDataUrl, MARGIN_MM, headerTop, logoSize, colors);

  let logoBottom = headerTop + logoSize;
  if (header.tagline) {
    const taglineBlock = measureText(doc, header.tagline.toUpperCase(), logoSize + 4, {
      size: 5.5,
      lineHeight: 2.4,
    });
    drawTextBlock(doc, taglineBlock, MARGIN_MM + (logoSize + 4) / 2, logoBottom + 1, {
      size: 5.5,
      color: colors.muted,
      align: 'center',
    });
    logoBottom += taglineBlock.height + 1;
  }

  const sessionW = SESSION_W_MM;
  const textLeft = MARGIN_MM + logoSize + 3;
  /* Right gutter reserves room for the student photo so the centred text never
   * runs under it, and the session box stays centred on the text column. */
  const textRight = A4_W_MM - MARGIN_MM - PHOTO_W - 3;
  const textWidth = textRight - textLeft;
  const textCenterX = textLeft + textWidth / 2;
  const sessionX = textCenterX - sessionW / 2;

  /* School name: shrink the font (never truncate) so it stays on ≤ 3 lines. */
  let nameSize = 17;
  let nameBlock: TextBlock = measureText(doc, header.schoolName || 'School Name', textWidth, {
    size: nameSize,
    style: 'bold',
    lineHeight: 6.4,
  });
  for (const candidate of [15, 13, 11, 10]) {
    if (nameBlock.lines.length <= 3) break;
    nameSize = candidate;
    nameBlock = measureText(doc, header.schoolName || 'School Name', textWidth, {
      size: nameSize,
      style: 'bold',
      lineHeight: nameSize * 0.4,
    });
  }

  let y = headerTop + Math.max(nameBlock.lineHeight * 0.8, 4.4);
  y = drawTextBlock(doc, nameBlock, textCenterX, headerTop + 1, {
    size: nameSize,
    style: 'bold',
    color: colors.primary,
    align: 'center',
  });

  if (header.address) {
    y = drawWrapped(doc, header.address, textCenterX, y + 0.6, textWidth, {
      size: 8,
      color: colors.text,
      align: 'center',
      lineHeight: 3.4,
    });
  }

  const affiliation = [
    header.affiliationText,
    header.schoolCode ? `SCHOOL CODE: ${header.schoolCode}` : '',
    header.affiliationNo ? `AFFILIATION NO.: ${header.affiliationNo}` : '',
  ]
    .filter(Boolean)
    .join(' | ');

  if (affiliation) {
    y = drawWrapped(doc, affiliation, textCenterX, y + 1.2, textWidth, {
      size: 7.5,
      color: colors.text,
      align: 'center',
      lineHeight: 3.2,
    });
  }

  /* Academic session box — centred directly under the address, matching the
   * on-screen preview. */
  const sessionTop = y + 1.5;
  fillRect(doc, sessionX, sessionTop, sessionW, 6, colors.primary);
  drawWrapped(doc, 'ACADEMIC SESSION', sessionX + sessionW / 2, sessionTop + 0.7, sessionW - 2, {
    size: 7,
    style: 'bold',
    color: [255, 255, 255],
    align: 'center',
    lineHeight: 3,
  });
  strokeRect(doc, sessionX, sessionTop + 6, sessionW, 9, colors.primary, 0.3);
  drawWrapped(doc, header.academicSession || '—', sessionX + sessionW / 2, sessionTop + 7, sessionW - 2, {
    size: 11,
    style: 'bold',
    color: colors.text,
    align: 'center',
    maxLines: 2,
    lineHeight: 4.4,
  });
  const sessionBottom = sessionTop + 15;

  /* Student photo — top-aligned in the right gutter, never over any text. */
  const photoX = A4_W_MM - MARGIN_MM - PHOTO_W;
  const photoTop = headerTop;
  drawPhotoBox(doc, photoDataUrl, photoX, photoTop, PHOTO_W, PHOTO_H, colors);

  return Math.max(logoBottom, sessionBottom, photoTop + PHOTO_H) + 2;
}

/* ── body drawing ─────────────────────────────────────────────────────── */

function drawAcademicTable(
  doc: jsPDF,
  model: ReportCardModel,
  layout: BodyLayout,
  colors: PdfColors,
  top: number,
): number {
  const x = LEFT_X;
  const w = LEFT_W;
  const acadFontSize = fontScale(layout.scale, mmToPt(TYPE_MM.academic));
  const columns = academicColumnRatios(model.academicColumns.length).map(
    (ratio) => ratio * w,
  );
  let y = top;

  fillRect(doc, x, y, w, 7, colors.headerFill);
  strokeRect(doc, x, y, w, 7, colors.line, 0.2);
  drawWrapped(doc, 'ACADEMIC PERFORMANCE', x + w / 2, y + 1.6, w - 2, {
    size: mmToPt(TYPE_MM.sectionBar),
    style: 'bold',
    color: colors.text,
    align: 'center',
    lineHeight: 3.6,
  });
  y += 7;

  /* Headers mirror the workbook: Subject + its own component columns + Total. */
  const headers = ['Subject', ...model.academicColumns.map((column) => column.label)];
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(acadFontSize);
  doc.setTextColor(...colors.text);
  doc.setFillColor(248, 250, 252);
  /*
   * The header row is as tall as its tallest wrapped title: a column now names
   * what it is out of ("SA1 (80)"), which wraps in a narrow column and would
   * otherwise spill onto the first subject row.
   */
  const headerBlocks = headers.map((header, index) =>
    measureText(doc, header, columns[index] - 2, {
      size: acadFontSize,
      style: 'bold',
      lineHeight: acadFontSize * 0.45,
      maxLines: 2,
    }),
  );
  const headerHeight = Math.max(7, ...headerBlocks.map((block) => block.height + 2.6));
  doc.rect(x, y, w, headerHeight, 'F');
  let cx = x;
  headers.forEach((header, index) => {
    strokeRect(doc, cx, y, columns[index], headerHeight, colors.line, 0.2);
    drawTextBlock(doc, headerBlocks[index], index === 0 ? cx + 1.5 : cx + columns[index] / 2, y + 1.4, {
      size: acadFontSize,
      style: 'bold',
      color: colors.text,
      align: index === 0 ? 'left' : 'center',
    });
    cx += columns[index];
  });
  y += headerHeight;

  model.academic.forEach((row, rowIndex) => {
    const height = layout.acadRowHeights[rowIndex] ?? 5;
    if (row.isGrandTotal) {
      fillRect(doc, x, y, w, height, colors.totalFill);
    }
    const cells = [String(row.name), ...row.cells.map((cell) => String(cell))];
    let cellX = x;
    cells.forEach((cell, index) => {
      strokeRect(doc, cellX, y, columns[index], height, colors.line, 0.2);
      const block = measureText(doc, cell, columns[index] - 2, {
        size: acadFontSize,
        style: row.isGrandTotal ? 'bold' : 'normal',
        lineHeight: acadFontSize * 0.45,
        maxLines: MAX_CELL_LINES,
      });
      drawTextBlock(
        doc,
        block,
        index === 0 ? cellX + 1.5 : cellX + columns[index] / 2,
        y + (height - block.height) / 2,
        {
          size: acadFontSize,
          style: row.isGrandTotal ? 'bold' : 'normal',
          color: colors.text,
          align: index === 0 ? 'left' : 'center',
        },
      );
      cellX += columns[index];
    });
    y += height;
  });

  return y;
}

function drawCoScholastic(
  doc: jsPDF,
  model: ReportCardModel,
  layout: BodyLayout,
  colors: PdfColors,
  top: number,
): number {
  const x = RIGHT_X;
  const w = RIGHT_W;
  const fontSize = fontScale(layout.scale, mmToPt(TYPE_MM.coScholastic));
  let y = top;

  fillRect(doc, x, y, w, 7, colors.coFill);
  strokeRect(doc, x, y, w, 7, colors.line, 0.2);
  drawWrapped(doc, 'CO-SCHOLASTIC AREAS (GRADES)', x + w / 2, y + 1.8, w - 2, {
    size: mmToPt(TYPE_MM.sectionBar),
    style: 'bold',
    color: colors.text,
    align: 'center',
    lineHeight: 3.2,
  });
  y += 7;

  model.coScholastic.forEach((row, index) => {
    const height = layout.coRowHeights[index] ?? 5;
    strokeRect(doc, x, y, w, height, colors.line, 0.2);
    doc.setDrawColor(...colors.line);
    doc.setLineWidth(0.2);
    doc.line(x + w - CO_VALUE_W_MM, y, x + w - CO_VALUE_W_MM, y + height);

    const nameBlock = measureText(doc, String(row.name).toUpperCase(), w - (CO_VALUE_W_MM + 2), {
      size: fontSize,
      lineHeight: fontSize * 0.45,
      maxLines: MAX_CELL_LINES,
    });
    drawTextBlock(doc, nameBlock, x + 1.5, y + (height - nameBlock.height) / 2, {
      size: fontSize,
      color: colors.text,
    });

    drawWrapped(doc, String(row.value || '—'), x + w - 6.5, y + height / 2 - 1.4, 12, {
      size: fontSize,
      style: 'bold',
      color: colors.text,
      align: 'center',
      maxLines: 2,
      lineHeight: fontSize * 0.45,
    });
    y += height;
  });

  return y;
}

function drawSkillsBox(
  doc: jsPDF,
  title: string,
  rows: ReportCardRow[],
  x: number,
  top: number,
  w: number,
  headerFill: [number, number, number],
  rowHeight: number,
  colors: PdfColors,
  maxStars: number,
): number {
  const fontSize = mmToPt(TYPE_MM.skills);
  let y = top;

  fillRect(doc, x, y, w, 6.5, headerFill);
  strokeRect(doc, x, y, w, 6.5, colors.line, 0.2);
  drawWrapped(doc, title, x + w / 2, y + 1.7, w - 2, {
    size: mmToPt(TYPE_MM.sectionBar),
    style: 'bold',
    color: colors.text,
    align: 'center',
    lineHeight: 3,
  });
  y += 6.5;

  rows.forEach((row) => {
    strokeRect(doc, x, y, w, rowHeight, colors.line, 0.2);
    const nameBlock = measureText(doc, String(row.name).toUpperCase(), w - 20, {
      size: fontSize,
      lineHeight: fontSize * 0.45,
      maxLines: MAX_CELL_LINES,
    });
    drawTextBlock(doc, nameBlock, x + 1.5, y + (rowHeight - nameBlock.height) / 2, {
      size: fontSize,
      color: colors.text,
    });
    drawStars(
      doc,
      x + w - maxStars * 3.0 - 0.6,
      y + rowHeight / 2,
      row.stars ?? 0,
      maxStars,
      colors.accent,
    );
    y += rowHeight;
  });

  return y;
}

/**
 * Holistic Development Profile — the four graded development areas that
 * replaced the old (duplicated) attendance block on the holistic card.
 */
function drawHolisticProfile(
  doc: jsPDF,
  model: ReportCardModel,
  x: number,
  top: number,
  w: number,
  colors: PdfColors,
  rowHeight: number,
): number {
  let y = top;
  fillRect(doc, x, y, w, 6.5, colors.coFill);
  strokeRect(doc, x, y, w, 6.5, colors.line, 0.2);
  drawWrapped(doc, 'HOLISTIC DEVELOPMENT PROFILE', x + w / 2, y + 1.8, w - 2, {
    size: mmToPt(TYPE_MM.sectionBar),
    style: 'bold',
    color: colors.text,
    align: 'center',
    lineHeight: 3.2,
  });
  y += 6.5;

  model.holisticDevelopment.forEach((row) => {
    strokeRect(doc, x, y, w, rowHeight, colors.line, 0.2);
    doc.setDrawColor(...colors.line);
    doc.setLineWidth(0.2);
    doc.line(x + w - CO_VALUE_W_MM, y, x + w - CO_VALUE_W_MM, y + rowHeight);

    const nameBlock = measureText(doc, String(row.name).toUpperCase(), w - (CO_VALUE_W_MM + 2), {
      size: mmToPt(TYPE_MM.holisticValue),
      lineHeight: 3.2,
      maxLines: 2,
    });
    drawTextBlock(doc, nameBlock, x + 1.5, y + (rowHeight - nameBlock.height) / 2, {
      size: mmToPt(TYPE_MM.holisticValue),
      color: colors.text,
    });
    drawWrapped(doc, String(row.value || '—'), x + w - 6.5, y + rowHeight / 2 - 1.3, 12, {
      size: mmToPt(TYPE_MM.holisticValue),
      style: 'bold',
      color: colors.text,
      align: 'center',
      maxLines: 2,
      lineHeight: 3.2,
    });
    y += rowHeight;
  });

  return y;
}

function drawOverall(
  doc: jsPDF,
  label: string,
  x: number,
  top: number,
  w: number,
  colors: PdfColors,
  /** The panel may grow to absorb the right column's slack (default 19.5mm). */
  height: number = OVERALL_BOX_H,
  /**
   * Summary printed under the performance label — the model's `summaryShort`
   * (percentage · grade · result), or null to hide the line.
   */
  summary: string | null = null,
): number {
  const labelHeight = 6.5;
  fillRect(doc, x, top, w, labelHeight, colors.overall);
  drawWrapped(doc, 'OVERALL PERFORMANCE', x + w / 2, top + 1.8, w - 2, {
    size: mmToPt(TYPE_MM.sectionBar),
    style: 'bold',
    color: [255, 255, 255],
    align: 'center',
    lineHeight: 3.2,
  });
  fillRect(doc, x, top + labelHeight, w, height - labelHeight, colors.overallSoft);
  strokeRect(doc, x, top, w, height, colors.overall, 0.3);
  /* Keep the resting offset, sliding down as the panel grows. */
  drawWrapped(doc, label, x + w / 2, top + 8 + (height - OVERALL_BOX_H) / 2, w - 3, {
    size: mmToPt(TYPE_MM.overallValue),
    style: 'bold',
    color: colors.overall,
    align: 'center',
    maxLines: 2,
    lineHeight: 4.6,
  });
  if (summary !== null) {
    drawWrapped(
      doc,
      summary,
      x + w / 2,
      top + 14.5 + (height - OVERALL_BOX_H) / 2,
      w - 3,
      {
        size: mmToPt(TYPE_MM.overallLabel),
        style: 'bold',
        color: colors.overall,
        align: 'center',
        maxLines: 1,
        lineHeight: 3,
      },
    );
  }
  return top + 19.5;
}

/* ── multi-page flow (very long mark sheets) ──────────────────────────── */

/**
 * Flow layout used when the card does not fit on a single A4 page.
 *
 * Blocks are stacked at full content width and a page break is inserted
 * whenever the next block would not fit, so nothing ever overlaps whatever the
 * number of subjects. Returns the page count used (for diagnostics).
 */
function renderHolisticFlow(
  opts: ThemeRenderOptions,
  colors: PdfColors,
  layout: BodyLayout,
  firstPageTop: number,
  remarksHeight: number,
): number {
  const { doc, model, school } = opts;
  const maxStars = model.assessment.maxStars;
  const bottomLimit = A4_H_MM - MARGIN_MM - 10;

  let y = firstPageTop;
  const newPage = () => {
    doc.addPage('a4', 'portrait');
    y = MARGIN_MM + 2;
  };
  const ensure = (needed: number) => {
    if (y + needed > bottomLimit) newPage();
  };

  /* ── Academic table, paginated ─────────────────────────────────────── */
  const columns = academicColumnRatios(model.academicColumns.length).map(
    (ratio) => ratio * CONTENT_W,
  );
  const acadFontSize = fontScale(layout.scale, mmToPt(TYPE_MM.academic));

  const drawTableHead = () => {
    fillRect(doc, MARGIN_MM, y, CONTENT_W, 6.5, colors.headerFill);
    strokeRect(doc, MARGIN_MM, y, CONTENT_W, 6.5, colors.line, 0.2);
    drawWrapped(doc, 'ACADEMIC PERFORMANCE', MARGIN_MM + CONTENT_W / 2, y + 1.6, CONTENT_W - 2, {
      size: mmToPt(TYPE_MM.sectionBar),
      style: 'bold',
      color: colors.text,
      align: 'center',
      lineHeight: 3.4,
    });
    y += 6.5;

    const headers = ['Subject', ...model.academicColumns.map((column) => column.label)];
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(acadFontSize);
    doc.setFillColor(248, 250, 252);
    /* Tall enough for the tallest wrapped column title (see the note above). */
    const headerBlocks = headers.map((header, index) =>
      measureText(doc, header, columns[index] - 2, {
        size: acadFontSize,
        style: 'bold',
        lineHeight: acadFontSize * 0.45,
        maxLines: 2,
      }),
    );
    const headerHeight = Math.max(6, ...headerBlocks.map((block) => block.height + 2.4));
    doc.rect(MARGIN_MM, y, CONTENT_W, headerHeight, 'F');
    let headerX = MARGIN_MM;
    headers.forEach((header, index) => {
      strokeRect(doc, headerX, y, columns[index], headerHeight, colors.line, 0.2);
      drawTextBlock(
        doc,
        headerBlocks[index],
        index === 0 ? headerX + 1.5 : headerX + columns[index] / 2,
        y + 1.2,
        { size: acadFontSize, style: 'bold', color: colors.text, align: index === 0 ? 'left' : 'center' },
      );
      headerX += columns[index];
    });
    y += headerHeight;
  };

  drawTableHead();

  model.academic.forEach((row, rowIndex) => {
    const height = layout.acadRowHeights[rowIndex] ?? 5;
    if (y + height > bottomLimit) {
      newPage();
      drawTableHead();
    }
    if (row.isGrandTotal) fillRect(doc, MARGIN_MM, y, CONTENT_W, height, colors.totalFill);

    const cells = [String(row.name), ...row.cells.map((cell) => String(cell))];
    let cellX = MARGIN_MM;
    cells.forEach((cell, index) => {
      strokeRect(doc, cellX, y, columns[index], height, colors.line, 0.2);
      const block = measureText(doc, cell, columns[index] - 2, {
        size: acadFontSize,
        style: row.isGrandTotal ? 'bold' : 'normal',
        lineHeight: acadFontSize * 0.45,
        maxLines: MAX_CELL_LINES,
      });
      drawTextBlock(
        doc,
        block,
        index === 0 ? cellX + 1.5 : cellX + columns[index] / 2,
        y + (height - block.height) / 2,
        {
          size: acadFontSize,
          style: row.isGrandTotal ? 'bold' : 'normal',
          color: colors.text,
          align: index === 0 ? 'left' : 'center',
        },
      );
      cellX += columns[index];
    });
    y += height;
  });

  /* ── Grading scale ─────────────────────────────────────────────────── */
  const scaleBlock = measureText(doc, `GRADING SCALE: ${model.gradeScale}`, CONTENT_W, {
    size: mmToPt(TYPE_MM.gradingScale),
    lineHeight: 3,
  });
  ensure(scaleBlock.height + 3);
  y =
    drawTextBlock(doc, scaleBlock, MARGIN_MM, y + 2, {
      size: mmToPt(TYPE_MM.gradingScale),
      color: colors.text,
    }) + 1;

  /* ── Co-scholastic (full width) ────────────────────────────────────── */
  if (model.coScholastic.length > 0) {
    /* One uniform row height for the flow table: never shorter than the
     * tallest measured row, so no cell can overflow its box. */
    const rowHeight = Math.max(4, 4.8 * layout.scale, ...layout.coRowHeights);
    const boxHeight = 6.5 + model.coScholastic.length * rowHeight;
    ensure(boxHeight + 3);
    y =
      drawCoScholasticFull(doc, model.coScholastic, y, rowHeight, colors, mmToPt(TYPE_MM.coScholastic)) +
      2;
  }

  /* ── Skills side by side ───────────────────────────────────────────── */
  const skillRowHeight = layout.skillRowHeight;
  const skillsRows = Math.max(model.personality.length, model.learning.length, 0);
  if (skillsRows > 0) {
    const skillW = (CONTENT_W - SKILLS_GAP_MM) / 2;
    ensure(6.5 + skillsRows * skillRowHeight + 3);
    const skillsTop = y;
    const leftBottom = drawSkillsBox(
      doc,
      'PERSONALITY DEVELOPMENT',
      model.personality,
      MARGIN_MM,
      skillsTop,
      skillW,
      colors.skillsWarm,
      skillRowHeight,
      colors,
      maxStars,
    );
    const rightBottom = drawSkillsBox(
      doc,
      'LEARNING SKILLS',
      model.learning,
      MARGIN_MM + skillW + 3,
      skillsTop,
      skillW,
      colors.skillsCool,
      skillRowHeight,
      colors,
      maxStars,
    );
    y = Math.max(leftBottom, rightBottom) + 2;
  }

  /* ── Attendance + overall side by side ─────────────────────────────── */
  const halfW = (CONTENT_W - 3) / 2;
  ensure(26);
  const holisticBottom = drawHolisticProfile(
    doc,
    model,
    MARGIN_MM,
    y,
    halfW,
    colors,
    layout.attendanceRowHeight,
  );
  drawOverall(
    doc,
    model.overallPerformance,
    MARGIN_MM + halfW + 3,
    y,
    halfW,
    colors,
    OVERALL_BOX_H,
    model.totals.percentage !== null ? model.totals.summaryShort : null,
  );
  y = Math.max(holisticBottom, y + 19.5) + 4;

  /* ── Remarks + signatures ──────────────────────────────────────────── */
  const halfText = CONTENT_W / 2 - 6;
  const teacherBlock = measureText(doc, model.teacherRemarks || '—', halfText, {
    size: mmToPt(TYPE_MM.remarks),
  });
  const principalBlock = measureText(doc, model.principalRemarks || '—', halfText, {
    size: mmToPt(TYPE_MM.remarks),
  });
  const remarksBox = Math.max(remarksHeight, Math.max(teacherBlock.height, principalBlock.height) + 8.5);

  /* Keep the remarks and signatures together on the same page. */
  ensure(remarksBox + 3 + 24 + 10);

  strokeRect(doc, MARGIN_MM, y, CONTENT_W, remarksBox, colors.line, 0.2);
  doc.setDrawColor(...colors.line);
  doc.setLineWidth(0.2);
  doc.line(A4_W_MM / 2, y, A4_W_MM / 2, y + remarksBox);
  drawWrapped(doc, "TEACHER'S REMARKS", MARGIN_MM + 2, y + 1.4, CONTENT_W / 2 - 4, {
    size: mmToPt(TYPE_MM.remarksLabel),
    style: 'bold',
    color: colors.text,
    lineHeight: 3.4,
  });
  drawWrapped(doc, "PRINCIPAL'S REMARKS", A4_W_MM / 2 + 2, y + 1.4, CONTENT_W / 2 - 4, {
    size: mmToPt(TYPE_MM.remarksLabel),
    style: 'bold',
    color: colors.text,
    lineHeight: 3.4,
  });
  drawTextBlock(doc, teacherBlock, MARGIN_MM + 2, y + 5.6, {
    size: mmToPt(TYPE_MM.remarks),
    color: colors.muted,
  });
  drawTextBlock(doc, principalBlock, A4_W_MM / 2 + 2, y + 5.6, {
    size: mmToPt(TYPE_MM.remarks),
    color: colors.muted,
  });
  y += remarksBox + 4;

  const third = CONTENT_W / 3;
  drawSignatureBlock(doc, {
    image: school.teacherSignDataUrl,
    role: 'CLASS TEACHER',
    name: model.signatures.teacherName,
    x: MARGIN_MM,
    y,
    width: third - 2,
    colors,
  });
  drawSignatureBlock(doc, {
    image: school.checkedBySignDataUrl,
    role: 'CHECKED BY (VICE PRINCIPAL)',
    name: model.signatures.checkedByName,
    x: MARGIN_MM + third,
    y,
    width: third - 2,
    colors,
  });
  drawSignatureBlock(doc, {
    image: school.principalSignDataUrl,
    role: 'PRINCIPAL',
    name: model.signatures.principalName,
    stamp: school.stampDataUrl,
    x: MARGIN_MM + third * 2,
    y,
    width: third - 2,
    colors,
  });

  /* Footer only on the page that carries the signatures, right under them. */
  const footerY = Math.min(
    y + SIGNATURE_BLOCK_H + SIGNATURE_TO_FOOTER_GAP,
    A4_H_MM - MARGIN_MM - FOOTER_BAR_H,
  );
  drawWrapped(
    doc,
    'This Report Card reflects the holistic development of the child and is a shared responsibility of the school and parents.',
    A4_W_MM / 2,
    footerY + 1.2,
    CONTENT_W - 4,
    { size: mmToPt(TYPE_MM.footer), color: colors.muted, align: 'center', maxLines: 2 },
  );
  strokeRect(doc, MARGIN_MM, footerY, CONTENT_W, 6, colors.line, 0.2);

  return (doc as unknown as { internal: { getNumberOfPages: () => number } }).internal.getNumberOfPages();
}

/** Co-scholastic table over the full content width (flow layout). */
function drawCoScholasticFull(
  doc: jsPDF,
  rows: ReportCardRow[],
  top: number,
  rowHeight: number,
  colors: PdfColors,
  fontSize: number,
): number {
  let y = top;
  fillRect(doc, MARGIN_MM, y, CONTENT_W, 6.5, colors.coFill);
  strokeRect(doc, MARGIN_MM, y, CONTENT_W, 6.5, colors.line, 0.2);
  drawWrapped(doc, 'CO-SCHOLASTIC AREAS (GRADES)', MARGIN_MM + CONTENT_W / 2, y + 1.8, CONTENT_W - 2, {
    size: mmToPt(TYPE_MM.sectionBar),
    style: 'bold',
    color: colors.text,
    align: 'center',
    lineHeight: 3.2,
  });
  y += 6.5;

  const nameWidth = CONTENT_W - (CO_VALUE_W_MM + 5);
  rows.forEach((row) => {
    strokeRect(doc, MARGIN_MM, y, CONTENT_W, rowHeight, colors.line, 0.2);
    doc.setDrawColor(...colors.line);
    doc.setLineWidth(0.2);
    doc.line(MARGIN_MM + nameWidth, y, MARGIN_MM + nameWidth, y + rowHeight);
    const nameBlock = measureText(doc, String(row.name).toUpperCase(), nameWidth - 3, {
      size: fontSize,
      lineHeight: fontSize * 0.45,
      maxLines: MAX_CELL_LINES,
    });
    drawTextBlock(doc, nameBlock, MARGIN_MM + 1.5, y + (rowHeight - nameBlock.height) / 2, {
      size: fontSize,
      color: colors.text,
    });
    drawWrapped(
      doc,
      String(row.value || '—'),
      MARGIN_MM + nameWidth + 9,
      y + rowHeight / 2 - 1.4,
      16,
      { size: fontSize, style: 'bold', color: colors.text, align: 'center', maxLines: 2, lineHeight: fontSize * 0.45 },
    );
    y += rowHeight;
  });

  return y;
}

/* ── main ─────────────────────────────────────────────────────────────── */

export function renderHolisticLayout(opts: ThemeRenderOptions): void {
  const { doc, model, school, theme } = opts;
  const colors = colorsFromPalette(theme.palette);
  const maxStars = model.assessment.maxStars;

  const headerBottom = drawHeader(doc, model, colors, opts.photoDataUrl);

  /* Title bar. */
  let y = headerBottom;
  fillRect(doc, MARGIN_MM, y, CONTENT_W, 7, colors.primary);
  let titleSize = 11;
  let titleBlock = measureText(doc, model.title, CONTENT_W - 4, { size: titleSize, style: 'bold' });
  for (const candidate of [10, 9, 8]) {
    if (titleBlock.lines.length <= 1) break;
    titleSize = candidate;
    titleBlock = measureText(doc, model.title, CONTENT_W - 4, { size: titleSize, style: 'bold' });
  }
  drawWrapped(doc, model.title, A4_W_MM / 2, y + 1.5, CONTENT_W - 4, {
    size: titleSize,
    style: 'bold',
    color: [255, 255, 255],
    align: 'center',
    lineHeight: 3.6,
  });
  y += 9;

  /* Student information grid (wrapping, dynamic height — never overlapping). */
  const columnWidth = (CONTENT_W - INFO_PADDING * 2 - 4) / 2;
  const infoLayout = layoutInfoGrid(
    doc,
    [model.infoLeft, model.infoRight],
    columnWidth,
    { labelWidth: INFO_LABEL_W, fontSize: mmToPt(TYPE_MM.info), minRowHeight: 5 },
  );
  const infoBottom = drawInfoGrid(doc, infoLayout, MARGIN_MM, y, CONTENT_W, columnWidth, {
    labelWidth: INFO_LABEL_W,
    fontSize: mmToPt(TYPE_MM.info),
    padding: INFO_PADDING,
    colors,
  });
  y = infoBottom + 3;

  /* Reserve the bottom of the page: remarks, signatures, footer. */
  const maxRemarksWidth = CONTENT_W / 2 - 6;
  const teacherBlock = measureText(doc, model.teacherRemarks || '—', maxRemarksWidth, {
    size: mmToPt(TYPE_MM.remarks),
  });
  const principalBlock = measureText(doc, model.principalRemarks || '—', maxRemarksWidth, {
    size: mmToPt(TYPE_MM.remarks),
  });
  const remarksHeight = Math.max(
    20,
    Math.max(teacherBlock.height, principalBlock.height) + 8.5,
  );

  /*
   * The remarks and signature blocks are NOT pinned to the bottom of the sheet:
   * they are drawn directly under whichever column ends lowest, exactly like the
   * browser preview. What IS reserved is their height, so the card keeps its
   * one-page guarantee and can be auto-fitted into the remaining budget.
   */
  const sigBlockHeight = SIGNATURE_BLOCK_H;
  const footerTop = A4_H_MM - MARGIN_MM - FOOTER_BAR_H;
  /* Everything that sits below the two columns: remarks, signatures, footer. */
  const tail =
    CONTENT_TO_REMARKS_GAP +
    remarksHeight +
    REMARKS_TO_SIGNATURE_GAP +
    sigBlockHeight +
    SIGNATURE_TO_FOOTER_GAP +
    FOOTER_BAR_H;

  const bodyTop = y;
  const bodyBudget = Math.max(60, footerTop - bodyTop);
  const fits = (layout: BodyLayout) =>
    layout.ok && Math.max(layout.leftHeight, layout.rightHeight) + tail <= bodyBudget;

  /*
   * Auto-fit in two passes:
   *   1. the largest scale at which the columns fit — keeps the type as readable
   *      as the subject count allows (a long mark sheet shrinks, as before);
   *   2. then a fill factor that grows the ROW HEIGHTS — never the font — so the
   *      spare page height is used by the table itself instead of being left as
   *      an empty band above the footer.
   */
  let chosen = computeBody(doc, model, SCALES[SCALES.length - 1]);
  for (const scale of SCALES) {
    const candidate = computeBody(doc, model, scale);
    chosen = candidate;
    if (fits(candidate)) break;
  }

  /*
   * A very long mark sheet (30+ subjects, long subject names) does not fit on a
   * single A4 page at any scale. Fall back to the paginated flow layout so the
   * table can never run into the remarks/signature blocks.
   */
  if (!fits(chosen)) {
    renderHolisticFlow(opts, colors, chosen, bodyTop, remarksHeight);
    return;
  }

  /* Fill the page: largest row growth that still fits above the remarks. */
  let low = 1;
  let high = FILL_MAX;
  for (let step = 0; step < 18; step += 1) {
    const middle = (low + high) / 2;
    if (fits(computeBody(doc, model, chosen.scale, middle))) low = middle;
    else high = middle;
  }
  chosen = computeBody(doc, model, chosen.scale, low);

  /* Left column: academic table + grading scale + skills. */
  let leftY = drawAcademicTable(doc, model, chosen, colors, bodyTop);

  leftY = drawWrapped(
    doc,
    `GRADING SCALE: ${model.gradeScale}`,
    LEFT_X,
    leftY + 1.4,
    LEFT_W,
    {        size: fontScale(chosen.scale, mmToPt(TYPE_MM.gradingScale)), color: colors.text, maxLines: 4, lineHeight: 3 },
  ) + 1;

  const skillW = (LEFT_W - SKILLS_GAP_MM) / 2;
  const skillRowHeight = chosen.skillRowHeight;
  const personalityBottom = drawSkillsBox(
    doc,
    'PERSONALITY DEVELOPMENT',
    model.personality,
    LEFT_X,
    leftY,
    skillW,
    colors.skillsWarm,
    skillRowHeight,
    colors,
    maxStars,
  );
  const learningBottom = drawSkillsBox(
    doc,
    'LEARNING SKILLS',
    model.learning,
    LEFT_X + skillW + 3,
    leftY,
    skillW,
    colors.skillsCool,
    skillRowHeight,
    colors,
    maxStars,
  );

  /*
   * Right column: co-scholastic + attendance + overall, spread over the depth of
   * the left column so both columns end on the same line. Without this the whole
   * difference showed up as one blank area under the overall panel.
   */
  const rightFree = Math.max(0, chosen.leftHeight - chosen.rightHeight);
  const rightGap = Math.min(RIGHT_GAP_MAX, rightFree * 0.4);
  const overallBoxHeight = Math.min(
    OVERALL_BOX_H + Math.max(0, rightFree - rightGap * 2),
    OVERALL_BOX_MAX_H,
  );

  let rightY = drawCoScholastic(doc, model, chosen, colors, bodyTop);
  rightY = drawHolisticProfile(
    doc,
    model,
    RIGHT_X,
    rightY + 2 + rightGap,
    RIGHT_W,
    colors,
    chosen.attendanceRowHeight,
  );
  const overallBottom = drawOverall(
    doc,
    model.overallPerformance,
    RIGHT_X,
    rightY + 2 + rightGap,
    RIGHT_W,
    colors,
    overallBoxHeight,
    model.totals.percentage !== null ? model.totals.summaryShort : null,
  );

  /*
   * Flow the bottom blocks under the taller column. Previously they were pinned
   * to the page bottom, which left a large blank area between the assessment
   * tables and the remarks on every card with fewer than ~25 subjects.
   */
  const contentBottom = Math.max(personalityBottom, learningBottom, overallBottom);
  /* Anything the (capped) fill could not use is shared out over the gaps. */
  const leftover = Math.max(
    0,
    bodyBudget - (Math.max(chosen.leftHeight, chosen.rightHeight) + tail),
  );
  const extraGap = Math.min(FILL_GAP_MAX, leftover / 3);
  const remarksTop = contentBottom + CONTENT_TO_REMARKS_GAP + extraGap;
  const sigTop = remarksTop + remarksHeight + REMARKS_TO_SIGNATURE_GAP + extraGap;
  /* Never write the footer bar outside the card frame. */
  const footerBarTop = Math.min(
    sigTop + sigBlockHeight + SIGNATURE_TO_FOOTER_GAP + extraGap,
    footerTop,
  );

  /* Remarks — flowed under the assessment tables, sized from the actual text. */
  strokeRect(doc, MARGIN_MM, remarksTop, CONTENT_W, remarksHeight, colors.line, 0.2);
  doc.setDrawColor(...colors.line);
  doc.setLineWidth(0.2);
  doc.line(A4_W_MM / 2, remarksTop, A4_W_MM / 2, remarksTop + remarksHeight);

  drawWrapped(doc, "TEACHER'S REMARKS", MARGIN_MM + 2, remarksTop + 1.4, CONTENT_W / 2 - 4, {
    size: mmToPt(TYPE_MM.remarksLabel),
    style: 'bold',
    color: colors.text,
    lineHeight: 3.4,
  });
  drawWrapped(doc, "PRINCIPAL'S REMARKS", A4_W_MM / 2 + 2, remarksTop + 1.4, CONTENT_W / 2 - 4, {
    size: mmToPt(TYPE_MM.remarksLabel),
    style: 'bold',
    color: colors.text,
    lineHeight: 3.4,
  });
  drawTextBlock(doc, teacherBlock, MARGIN_MM + 2, remarksTop + 5.6, {
    size: mmToPt(TYPE_MM.remarks),
    color: colors.muted,
  });
  drawTextBlock(doc, principalBlock, A4_W_MM / 2 + 2, remarksTop + 5.6, {
    size: mmToPt(TYPE_MM.remarks),
    color: colors.muted,
  });

  /* Signatures. */
  const third = CONTENT_W / 3;
  drawSignatureBlock(doc, {
    image: school.teacherSignDataUrl,
    role: 'CLASS TEACHER',
    name: model.signatures.teacherName,
    x: MARGIN_MM,
    y: sigTop,
    width: third - 2,
    colors,
  });
  drawSignatureBlock(doc, {
    image: school.checkedBySignDataUrl,
    role: 'CHECKED BY (VICE PRINCIPAL)',
    name: model.signatures.checkedByName,
    x: MARGIN_MM + third,
    y: sigTop,
    width: third - 2,
    colors,
  });
  drawSignatureBlock(doc, {
    image: school.principalSignDataUrl,
    role: 'PRINCIPAL',
    name: model.signatures.principalName,
    stamp: school.stampDataUrl,
    x: MARGIN_MM + third * 2,
    y: sigTop,
    width: third - 2,
    colors,
  });

  drawFooterAndFrame(
    doc,
    colors,
    'This Report Card reflects the holistic development of the child and is a shared responsibility of the school and parents.',
    footerBarTop,
  );
}
