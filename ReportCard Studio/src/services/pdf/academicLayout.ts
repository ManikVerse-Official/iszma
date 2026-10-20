import type jsPDF from 'jspdf';
import { ACADEMIC_TOTAL_KEY, type ReportCardModel } from '../reportCardModel';
import type { ReportCardTheme } from '../../themes';
import type { ThemeRenderOptions } from './holisticLayout';
import { mmToPt, TYPE_MM } from '../../themes/typography';
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
  drawProgressBar,
  drawSignatureBlock,
  drawTextBlock,
  drawWrapped,
  fillRect,
  fillRoundRect,
  layoutInfoGrid,
  measureText,
  strokeRect,
  type PdfColors,
  type RGB,
  type TextBlock,
} from './pdfKit';

/**
 * Marks-focused layout used by the "Simple Academic" and "Modern School"
 * themes. Same guarantees as the holistic card: values wrap, nothing overlaps
 * and the sheet stays on one A4 page.
 */

const PHOTO_W = 18;
const PHOTO_H = 22;
const INFO_PADDING = 2;
const INFO_LABEL_W = 30;
const MAX_CELL_LINES = 4;
/** The marks / maximum / percentage / overall strip (mm). */
const SUMMARY_LABEL_H = 6.5;
const SUMMARY_VALUE_H = 13;
/** The strip's value row may grow this tall when a card has room to spare. */
const SUMMARY_VALUE_MAX_H = 23;
/**
 * Row heights may grow to use the spare page height, but never past this (mm),
 * and never shorter than the text inside them. The font size is untouched, so
 * filling the page never stretches the text.
 */
const MAX_TABLE_ROW_MM = 15;
/** Upper bound of the row-growth search. */
const FILL_MAX = 2.4;
/** Left over height is shared out over the three section gaps, at most this each. */
const FILL_GAP_MAX = 3;

function fontScale(scale: number, base: number): number {
  return Math.max(5.5, Math.round(base * scale * 10) / 10);
}

function percentText(row: { maxMarks: number | string; marks: number | string }): string {
  const max = typeof row.maxMarks === 'number' ? row.maxMarks : Number(row.maxMarks);
  const marks = typeof row.marks === 'number' ? row.marks : Number(row.marks);
  if (!Number.isFinite(max) || max <= 0 || !Number.isFinite(marks)) return '—';
  return `${Math.round((marks / max) * 10000) / 100}%`;
}

interface AcademicTableLayout {
  ok: boolean;
  scale: number;
  fill: number;
  rowHeights: number[];
  totalHeight: number;
}

interface AcademicColumnSpec {
  title: string;
  ratio: number;
  align: 'left' | 'center';
  kind: 'subject' | 'component' | 'total' | 'percentage';
}

/**
 * The marks table mirrors the uploaded workbook: a Subject column followed by
 * the sheet's own component columns (PT / NB / SEA / SA2 …) and the subject
 * Total, plus the optional computed Percentage. Grade and Remarks columns were
 * removed from the academic table entirely.
 */
function columnRatios(model: ReportCardModel, theme: ReportCardTheme): AcademicColumnSpec[] {
  const columns: AcademicColumnSpec[] = [
    { title: 'Subject', ratio: 0, align: 'left', kind: 'subject' },
  ];
  for (const column of model.academicColumns) {
    columns.push({
      title: column.label,
      ratio: 0,
      align: 'center',
      kind: column.key === ACADEMIC_TOTAL_KEY ? 'total' : 'component',
    });
  }
  if (theme.sections.subjectPercentage) {
    columns.push({ title: 'Percentage', ratio: 0, align: 'center', kind: 'percentage' });
  }

  /* Subject keeps a bounded share; the data columns split the remainder. */
  const dataCols = columns.length - 1;
  const subject = Math.min(0.34, Math.max(0.18, 0.36 - dataCols * 0.02));
  const rest = (1 - subject) / Math.max(1, dataCols);
  columns[0].ratio = subject;
  for (let i = 1; i < columns.length; i += 1) columns[i].ratio = rest;
  return columns;
}

function measureTable(
  doc: jsPDF,
  model: ReportCardModel,
  theme: ReportCardTheme,
  scale: number,
  fill = 1,
): AcademicTableLayout {
  const fontSize = fontScale(scale, mmToPt(TYPE_MM.academic));
  const columns = columnRatios(model, theme).map((column) => column.ratio * CONTENT_W);
  const subjectWidth = columns[0] - 3;
  const baseRow = Math.max(3.6, 5.2 * scale);

  let ok = true;
  const rowHeights = model.academic.map((row) => {
    const subjectLines = measureText(doc, row.name, subjectWidth, {
      size: fontSize,
      lineHeight: fontSize * 0.45,
    }).lines.length;
    /* Component / Total cells are short, but wrap if a school names them long. */
    let cellLines = 1;
    row.cells.forEach((cell, index) => {
      const width = columns[index + 1];
      if (!width) return;
      cellLines = Math.max(
        cellLines,
        measureText(doc, String(cell), width - 2, {
          size: fontSize,
          lineHeight: fontSize * 0.45,
        }).lines.length,
      );
    });
    if (subjectLines > MAX_CELL_LINES || cellLines > MAX_CELL_LINES) ok = false;
    const lines = Math.max(subjectLines, cellLines, 1);
    const textFloor = lines * fontSize * 0.45 + 1.4;
    return Math.max(textFloor, Math.min(Math.max(baseRow, textFloor) * fill, MAX_TABLE_ROW_MM));
  });

  return {
    ok,
    scale,
    fill,
    rowHeights,
    totalHeight: 7 + 7 + rowHeights.reduce((sum, h) => sum + h, 0),
  };
}

/** Marks / maximum / percentage / overall strip. Returns the bottom y. */
function drawSummaryStrip(
  doc: jsPDF,
  model: ReportCardModel,
  colors: PdfColors,
  top: number,
  valueHeight: number = SUMMARY_VALUE_H,
): number {
  /*
   * Five boxes across: obtained, maximum, percentage, overall performance and
   * grade/result. Every value comes from the model, so the strip, the on-screen
   * card and the sidebar always print the same calculation.
   */
  const cells: { label: string; value: string; overall: boolean; valueSize: number }[] = [
    { label: 'Marks Obtained', value: String(model.totals.obtained), overall: false, valueSize: 13 },
    {
      label: 'Maximum Marks',
      value: model.totals.max > 0 ? String(model.totals.max) : '—',
      overall: false,
      valueSize: 13,
    },
    {
      label: 'Percentage',
      value: model.totals.percentage !== null ? `${model.totals.percentage}%` : '—',
      overall: false,
      valueSize: 13,
    },
    {
      label: 'Overall Performance',
      value: model.overallPerformance,
      overall: true,
      valueSize: 11,
    },
    {
      label: 'Grade / Result',
      value: `${model.totals.grade} \u00b7 ${model.totals.result}`,
      overall: true,
      valueSize: 11,
    },
  ];

  const gap = 2;
  const boxW = (CONTENT_W - (cells.length - 1) * gap) / cells.length;
  const valueTop = SUMMARY_LABEL_H + 3 + (valueHeight - SUMMARY_VALUE_H) / 2;

  cells.forEach((cell, index) => {
    const x = MARGIN_MM + index * (boxW + gap);
    const labelFill = cell.overall ? colors.overall : colors.headerFill;
    const valueFill = cell.overall ? colors.overallSoft : undefined;

    fillRect(doc, x, top, boxW, 6.5, labelFill);
    strokeRect(doc, x, top, boxW, 6.5, cell.overall ? colors.overall : colors.line, 0.2);
    drawWrapped(doc, cell.label, x + boxW / 2, top + 1.7, boxW - 2, {
      size: cell.overall ? 7.2 : 7.4,
      style: 'bold',
      color: cell.overall ? [255, 255, 255] : colors.text,
      align: 'center',
      lineHeight: 3,
    });

    if (valueFill) fillRect(doc, x, top + SUMMARY_LABEL_H, boxW, valueHeight, valueFill);
    strokeRect(
      doc,
      x,
      top + SUMMARY_LABEL_H,
      boxW,
      valueHeight,
      cell.overall ? colors.overall : colors.line,
      0.2,
    );
    drawWrapped(
      doc,
      cell.value,
      x + boxW / 2,
      cell.overall ? top + 9 + (valueHeight - SUMMARY_VALUE_H) / 2 : top + valueTop,
      boxW - 3,
      {
        size: cell.valueSize,
        style: 'bold',
        color: cell.overall ? colors.overall : colors.text,
        align: 'center',
        maxLines: 2,
        lineHeight: cell.overall ? 4.4 : 4.8,
      },
    );
  });

  return top + SUMMARY_LABEL_H + valueHeight;
}

/**
 * Paginated fallback used when the mark sheet is too long to fit on one A4
 * page (e.g. 30+ subjects with long names). The table flows onto further pages,
 * and the summary / remarks / signature blocks stay together, so nothing can
 * ever overlap the remarks area pinned to the bottom of the first page.
 */
function renderAcademicFlow(
  opts: ThemeRenderOptions,
  colors: PdfColors,
  scale: number,
  firstPageTop: number,
  remarksHeight: number,
): void {
  const { doc, model, school, theme } = opts;
  const modern = theme.variant === 'modern';
  const style = tableStyleFor(theme, colors);
  const columns = columnRatios(model, theme);
  const widths = columns.map((column) => column.ratio * CONTENT_W);
  const fontSize = fontScale(scale, mmToPt(TYPE_MM.academic));
  const rowHeights = measureTable(doc, model, theme, scale).rowHeights;
  const bottomLimit = A4_H_MM - MARGIN_MM - 10;

  let y = firstPageTop;
  const newPage = () => {
    doc.addPage('a4', 'portrait');
    y = MARGIN_MM + 2;
  };
  const ensure = (needed: number) => {
    if (y + needed > bottomLimit) newPage();
  };

  const drawHead = () => {
    y = drawTableLabel(doc, style, colors, y);
    y = drawTableHead(doc, columns, widths, fontSize, y, style, colors);
  };

  drawHead();

  model.academic.forEach((row, rowIndex) => {
    const height = rowHeights[rowIndex] ?? 5;
    if (y + height > bottomLimit) {
      newPage();
      drawHead();
    }
    drawTableRow(doc, row, rowIndex, columns, widths, fontSize, height, y, style, colors, theme);
    y += height;
  });

  /* Summary + grading scale — kept together. */
  ensure(SUMMARY_LABEL_H + SUMMARY_VALUE_H + 4);
  y =
    (modern
      ? drawModernResultBand(doc, model, colors, y + 3, SUMMARY_VALUE_H)
      : drawSummaryStrip(doc, model, colors, y + 3)) + 2;
  if (theme.sections.gradingScale) {
    const scaleBlock = measureText(doc, `GRADING SCALE: ${model.gradeScale}`, CONTENT_W, {
      size: fontScale(scale, mmToPt(TYPE_MM.gradingScale)),
      lineHeight: 3,
      maxLines: 3,
    });
    ensure(scaleBlock.height + 4);
    y = drawTextBlock(doc, scaleBlock, MARGIN_MM, y + 2, {
      size: fontScale(scale, mmToPt(TYPE_MM.gradingScale)),
      color: colors.text,
    });
  }

  /* Remarks. */
  if (theme.sections.remarks && remarksHeight > 0) {
    const halfText = CONTENT_W / 2 - 6;
    const teacherBlock = measureText(doc, model.teacherRemarks || '—', halfText, {
      size: mmToPt(TYPE_MM.remarks),
    });
    const principalBlock = measureText(doc, model.principalRemarks || '—', halfText, {
      size: mmToPt(TYPE_MM.remarks),
    });
    const box = Math.max(remarksHeight, Math.max(teacherBlock.height, principalBlock.height) + 8.5);
    ensure(box + 4 + SIGNATURE_BLOCK_H + 10);

    drawRemarks(doc, model, colors, y, box, teacherBlock, principalBlock, modern);
    y += box + 4;
  }

  /* Signatures + frame stay on the final page. */
  ensure(SIGNATURE_BLOCK_H + 10);
  drawSignatures(doc, model, school, colors, y, modern);

  drawFooterAndFrame(
    doc,
    colors,
    'This report card is generated from the marks recorded by the school.',
    Math.min(
      y + SIGNATURE_BLOCK_H + SIGNATURE_TO_FOOTER_GAP,
      A4_H_MM - MARGIN_MM - FOOTER_BAR_H,
    ),
    modern ? 'solid' : 'outline',
  );
}

function drawHeader(
  doc: jsPDF,
  model: ReportCardModel,
  colors: PdfColors,
  photoDataUrl?: string,
): number {
  const { header } = model;
  const headerTop = MARGIN_MM;
  const logoSize = 20;

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

  const sessionW = 32;
  const sessionX = A4_W_MM - MARGIN_MM - sessionW;
  const textLeft = MARGIN_MM + logoSize + 3;
  const textWidth = sessionX - 2 - textLeft;
  const textCenterX = textLeft + textWidth / 2;

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

  let y = drawTextBlock(doc, nameBlock, textCenterX, headerTop + 1, {
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

  fillRect(doc, sessionX, headerTop, sessionW, 6, colors.primary);
  drawWrapped(doc, 'ACADEMIC SESSION', sessionX + sessionW / 2, headerTop + 0.7, sessionW - 2, {
    size: 7,
    style: 'bold',
    color: [255, 255, 255],
    align: 'center',
    lineHeight: 3,
  });
  strokeRect(doc, sessionX, headerTop + 6, sessionW, 9, colors.primary, 0.3);
  drawWrapped(doc, header.academicSession || '—', sessionX + sessionW / 2, headerTop + 7, sessionW - 2, {
    size: 11,
    style: 'bold',
    color: colors.text,
    align: 'center',
    maxLines: 2,
    lineHeight: 4.4,
  });

  const photoX = A4_W_MM - MARGIN_MM - PHOTO_W;
  const photoTop = headerTop + 16;
  drawPhotoBox(doc, photoDataUrl, photoX, photoTop, PHOTO_W, PHOTO_H, colors);

  return Math.max(logoBottom, y, headerTop + 15, photoTop + PHOTO_H) + 2;
}

/* ── visual styles ────────────────────────────────────────────────────────
 *
 * "Simple Academic" (classic) is the formal printed marks statement; "Modern
 * School" re-skins the very same structure — colour header band, zebra table
 * with performance bars, wide result band, panel remarks. Both variants share
 * the measuring / auto-fit / pagination engine, so a new look can never break
 * the zero-overlap or one-page guarantees.
 */

const WHITE: RGB = [255, 255, 255];
/** Text on a coloured band (soft white). */
const BAND_SOFT: RGB = [224, 231, 255];
/** The classic table header row. */
const CLASSIC_HEAD_FILL: RGB = [248, 250, 252];

interface TableStyle {
  labelFill: RGB;
  labelText: RGB;
  labelAlign: 'left' | 'center';
  headFill: RGB;
  headText: RGB;
  /** Zebra striping for the body rows (never on the classic card). */
  zebra: RGB | null;
  cellLine: RGB;
  verticalRules: boolean;
  totalFill: RGB;
  totalText: RGB;
  marksText: RGB;
  /** Draw the percentage as a progress bar under the value. */
  bar: boolean;
  barTrack: RGB;
  barFill: RGB;
}

function tableStyleFor(theme: ReportCardTheme, colors: PdfColors): TableStyle {
  const base: TableStyle = {
    labelFill: colors.headerFill,
    labelText: colors.text,
    labelAlign: 'center',
    headFill: CLASSIC_HEAD_FILL,
    headText: colors.text,
    zebra: null,
    cellLine: colors.line,
    verticalRules: true,
    totalFill: colors.totalFill,
    totalText: colors.text,
    marksText: colors.text,
    bar: false,
    barTrack: colors.headerFill,
    barFill: colors.overall,
  };
  if (theme.variant !== 'modern') return base;
  return {
    ...base,
    labelText: colors.primary,
    labelAlign: 'left',
    headFill: colors.primary,
    headText: WHITE,
    zebra: colors.headerFill,
    verticalRules: false,
    totalFill: colors.primary,
    totalText: WHITE,
    marksText: colors.primary,
    bar: true,
  };
}

/** Modern header: a full-width colour band carrying the identity of the school. */
function drawModernHeader(
  doc: jsPDF,
  model: ReportCardModel,
  colors: PdfColors,
  photoDataUrl?: string,
): number {
  const { header } = model;
  const bandX = MARGIN_MM - 2;
  const bandW = CONTENT_W + 4;
  const bandTop = MARGIN_MM - 2;
  const bandH = 34;
  fillRect(doc, bandX, bandTop, bandW, bandH, colors.primary);

  /* Logo on a white tile. */
  const tile = 17;
  fillRoundRect(doc, MARGIN_MM + 1, bandTop + 4, tile, tile, 2.5, WHITE);
  drawLogoBox(doc, header.logoDataUrl, MARGIN_MM + 1.5, bandTop + 4.5, tile - 1, colors);

  /* Student photo, top right. */
  const photoX = bandX + bandW - PHOTO_W - 4;
  fillRoundRect(doc, photoX - 1.2, bandTop + 3.8, PHOTO_W + 2.4, PHOTO_H + 2.4, 2.5, WHITE);
  drawPhotoBox(doc, photoDataUrl, photoX, bandTop + 5, PHOTO_W, PHOTO_H, colors);

  /* School name / address / affiliation. */
  const textLeft = MARGIN_MM + 1 + tile + 5;
  const textRight = photoX - 4;
  const textWidth = textRight - textLeft;
  const textCenterX = textLeft + textWidth / 2;

  let nameSize = 15;
  let nameBlock: TextBlock = measureText(doc, header.schoolName || 'School Name', textWidth, {
    size: nameSize,
    style: 'bold',
    lineHeight: nameSize * 0.42,
  });
  for (const candidate of [13.5, 12, 11, 10]) {
    if (nameBlock.lines.length <= 2) break;
    nameSize = candidate;
    nameBlock = measureText(doc, header.schoolName || 'School Name', textWidth, {
      size: nameSize,
      style: 'bold',
      lineHeight: nameSize * 0.42,
    });
  }

  let y = drawTextBlock(doc, nameBlock, textCenterX, bandTop + 4.5, {
    size: nameSize,
    style: 'bold',
    color: WHITE,
    align: 'center',
  });

  if (header.address) {
    y = drawWrapped(doc, header.address, textCenterX, y + 0.8, textWidth, {
      size: 7,
      color: BAND_SOFT,
      align: 'center',
      lineHeight: 3.2,
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
    y = drawWrapped(doc, affiliation, textCenterX, y + 1, textWidth, {
      size: 6.5,
      color: BAND_SOFT,
      align: 'center',
      lineHeight: 3,
    });
  }

  /* Session chip, bottom right. */
  const chipW = 42;
  const chipH = 8.5;
  const chipX = bandX + (bandW - chipW) / 2; 
  const chipY = bandTop + bandH - chipH - 2.5;
  fillRoundRect(doc, chipX, chipY, chipW, chipH, 2, WHITE);
  drawWrapped(doc, 'ACADEMIC SESSION', chipX + chipW / 2, chipY + 1.1, chipW - 4, {
    size: 5.6,
    style: 'bold',
    color: colors.muted,
    align: 'center',
    lineHeight: 2.6,
    maxLines: 1,
  });
  drawWrapped(doc, header.academicSession || '—', chipX + chipW / 2, chipY + 3.9, chipW - 4, {
    size: 8.5,
    style: 'bold',
    color: colors.primary,
    align: 'center',
    lineHeight: 3.6,
    maxLines: 1,
  });

  return bandTop + bandH + 3;
}

/** Modern title: a light strip with a colour accent bar, left aligned. */
function drawModernTitle(doc: jsPDF, title: string, colors: PdfColors, top: number): number {
  const height = 8;
  const x = MARGIN_MM - 2;
  const w = CONTENT_W + 4;
  fillRect(doc, x, top, w, height, colors.headerFill);
  fillRect(doc, x, top, 3, height, colors.primary);

  let size = 10.5;
  let block = measureText(doc, title, w - 10, { size, style: 'bold' });
  for (const candidate of [9.5, 8.5, 7.5]) {
    if (block.lines.length <= 1) break;
    size = candidate;
    block = measureText(doc, title, w - 10, { size, style: 'bold' });
  }
  drawWrapped(doc, title, x + 5, top + 1.9, w - 10, {
    size,
    style: 'bold',
    color: colors.primary,
    align: 'left',
    lineHeight: 3.6,
    maxLines: 2,
  });
  return top + height;
}

/** Modern info grid: one tinted pill per field, no enclosing box. */
function drawModernInfoGrid(
  doc: jsPDF,
  layout: ReturnType<typeof layoutInfoGrid>,
  x: number,
  top: number,
  columnWidth: number,
  options: { labelWidth: number; fontSize: number; colors: PdfColors; padding: number },
): number {
  const { labelWidth, fontSize, colors, padding } = options;
  const columnX = [x + padding, x + padding + columnWidth + 4];

  layout.rows.forEach((rows, columnIndex) => {
    let y = top + padding;
    for (const row of rows) {
      fillRoundRect(
        doc,
        columnX[columnIndex] - 1,
        y - 0.7,
        columnWidth + 2,
        row.rowHeight,
        1.2,
        colors.headerFill,
      );
      drawTextBlock(doc, row.labelBlock, columnX[columnIndex], y, {
        size: fontSize,
        style: 'bold',
        color: colors.primary,
        align: 'left',
      });
      const colonX = columnX[columnIndex] + labelWidth;
      doc.setTextColor(...colors.muted);
      doc.setFontSize(fontSize);
      doc.text(':', colonX, y + fontSize * 0.38);
      drawTextBlock(doc, row.valueBlock, colonX + 3, y, {
        size: fontSize,
        color: colors.text,
        align: 'left',
      });
      y += row.rowHeight;
    }
  });

  return top + layout.height + padding * 2;
}

/** The "ACADEMIC PERFORMANCE" strip above the table. Returns the next y. */
function drawTableLabel(doc: jsPDF, style: TableStyle, colors: PdfColors, top: number): number {
  fillRect(doc, MARGIN_MM, top, CONTENT_W, 7, style.labelFill);
  strokeRect(doc, MARGIN_MM, top, CONTENT_W, 7, colors.line, 0.2);
  drawWrapped(
    doc,
    'ACADEMIC PERFORMANCE',
    style.labelAlign === 'left' ? MARGIN_MM + 2 : MARGIN_MM + CONTENT_W / 2,
    top + 1.6,
    CONTENT_W - 2,
    {
      size: mmToPt(TYPE_MM.sectionBar),
      style: 'bold',
      color: style.labelText,
      align: style.labelAlign,
      lineHeight: 3.6,
      maxLines: 1,
    },
  );
  return top + 7;
}

/** The table's column header row. Returns the next y. */
function drawTableHead(
  doc: jsPDF,
  columns: { title: string; ratio: number; align: 'left' | 'center' }[],
  widths: number[],
  fontSize: number,
  top: number,
  style: TableStyle,
  colors: PdfColors,
): number {
  /*
   * The header row grows with its content. A column title now carries what it
   * is out of ("PT (10)", "SA1 (80)"), which wraps in a narrow column — a fixed
   * 7mm row would let that second line spill onto the first subject row.
   */
  const blocks = columns.map((column, index) =>
    measureText(doc, column.title, widths[index] - 2, {
      size: fontSize,
      style: 'bold',
      lineHeight: fontSize * 0.45,
      maxLines: 2,
    }),
  );
  const height = Math.max(7, ...blocks.map((block) => block.height + 2.8));
  fillRect(doc, MARGIN_MM, top, CONTENT_W, height, style.headFill);
  let cx = MARGIN_MM;
  columns.forEach((column, index) => {
    if (style.verticalRules) strokeRect(doc, cx, top, widths[index], height, style.cellLine, 0.2);
    const block = blocks[index];
    drawTextBlock(
      doc,
      block,
      column.align === 'left' ? cx + 1.5 : cx + widths[index] / 2,
      top + 1.4,
      { size: fontSize, style: 'bold', color: style.headText, align: column.align },
    );
    cx += widths[index];
  });
  if (!style.verticalRules) {
    doc.setDrawColor(...style.cellLine);
    doc.setLineWidth(0.15);
    doc.line(MARGIN_MM, top + height, MARGIN_MM + CONTENT_W, top + height);
  }
  return top + height;
}

/** One body row of the marks table, painted in the active style. */
function drawTableRow(
  doc: jsPDF,
  row: ReportCardModel['academic'][number],
  rowIndex: number,
  columns: AcademicColumnSpec[],
  widths: number[],
  fontSize: number,
  height: number,
  top: number,
  style: TableStyle,
  colors: PdfColors,
  theme: ReportCardTheme,
): void {
  const percentIndex = columns.findIndex((column) => column.kind === 'percentage');
  const totalIndex = columns.findIndex((column) => column.kind === 'total');
  const cells: string[] = [row.name, ...row.cells.map((cell) => String(cell))];
  if (theme.sections.subjectPercentage) cells.push(percentText(row));

  if (row.isGrandTotal) {
    fillRect(doc, MARGIN_MM, top, CONTENT_W, height, style.totalFill);
  } else if (style.zebra && rowIndex % 2 === 1) {
    fillRect(doc, MARGIN_MM, top, CONTENT_W, height, style.zebra);
  }

  const bold = Boolean(row.isGrandTotal);
  let cellX = MARGIN_MM;
  cells.forEach((cell, index) => {
    const width = widths[index] ?? 0;
    const align = columns[index]?.align ?? 'center';
    const isPercentage = style.bar && index === percentIndex && !bold;
    const color = bold
      ? style.totalText
      : index === totalIndex
        ? style.marksText
        : colors.text;

    if (style.verticalRules) strokeRect(doc, cellX, top, width, height, style.cellLine, 0.2);

    /* Leave room for the progress bar under the value. */
    const areaHeight = isPercentage ? height - 2.6 : height;
    const block = measureText(doc, cell, width - 3, {
      size: fontSize,
      style: bold ? 'bold' : 'normal',
      lineHeight: fontSize * 0.45,
      maxLines: MAX_CELL_LINES,
    });
    drawTextBlock(
      doc,
      block,
      align === 'left' ? cellX + 1.5 : cellX + width / 2,
      top + Math.max(0, (areaHeight - block.height) / 2),
      {
        size: fontSize,
        style: bold ? 'bold' : 'normal',
        color,
        align,
      },
    );

    if (isPercentage) {
      const marks = Number(row.marks);
      const max = Number(row.maxMarks);
      const ratio = Number.isFinite(marks) && Number.isFinite(max) && max > 0 ? marks / max : 0;
      drawProgressBar(
        doc,
        cellX + 2.5,
        top + height - 2.3,
        Math.max(4, width - 5),
        1.3,
        ratio,
        style.barTrack,
        style.barFill,
      );
    }

    cellX += width;
  });

  if (!style.verticalRules) {
    doc.setDrawColor(...style.cellLine);
    doc.setLineWidth(0.15);
    doc.line(MARGIN_MM, top + height, MARGIN_MM + CONTENT_W, top + height);
  }
}

/** Modern result band: one colour panel with the headline marks. */
function drawModernResultBand(
  doc: jsPDF,
  model: ReportCardModel,
  colors: PdfColors,
  top: number,
  valueHeight: number,
): number {
  const height = SUMMARY_LABEL_H + valueHeight;
  fillRoundRect(doc, MARGIN_MM, top, CONTENT_W, height, 2.5, colors.headerFill);

  /*
   * Four cells: obtained, percentage, performance band and grade/result — all
   * values read from the model, so the band can never disagree with the card.
   */
  const cells: { label: string; value: string; color: RGB }[] = [
    {
      label: 'MARKS OBTAINED',
      value: model.totals.max > 0 ? `${model.totals.obtained} / ${model.totals.max}` : String(model.totals.obtained),
      color: colors.primary,
    },
    {
      label: 'PERCENTAGE',
      value: model.totals.percentage !== null ? `${model.totals.percentage}%` : '—',
      color: colors.overall,
    },
    { label: 'OVERALL PERFORMANCE', value: model.overallPerformance, color: colors.overall },
    {
      label: 'GRADE / RESULT',
      value: `${model.totals.grade} \u00b7 ${model.totals.result}`,
      color: colors.overall,
    },
  ];

  const cellW = CONTENT_W / cells.length;
  for (let i = 1; i < cells.length; i += 1) {
    doc.setDrawColor(...colors.line);
    doc.setLineWidth(0.2);
    doc.line(MARGIN_MM + cellW * i, top + 3, MARGIN_MM + cellW * i, top + height - 3);
  }

  cells.forEach((cell, index) => {
    const centerX = MARGIN_MM + cellW * index + cellW / 2;
    const width = cellW - 5;
    drawWrapped(doc, cell.label, centerX, top + 2.2, width, {
      size: mmToPt(TYPE_MM.summaryLabel),
      style: 'bold',
      color: colors.muted,
      align: 'center',
      lineHeight: 3,
      maxLines: 1,
    });
    drawWrapped(doc, cell.value, centerX, top + 7 + (valueHeight - SUMMARY_VALUE_H) / 2, width, {
      size: mmToPt(TYPE_MM.summaryValue),
      style: 'bold',
      color: cell.color,
      align: 'center',
      maxLines: 2,
      lineHeight: 5.4,
    });
  });

  return top + height;
}

/** Remarks: bordered box on the classic card, colour panels on the modern one. */
function drawRemarks(
  doc: jsPDF,
  model: ReportCardModel,
  colors: PdfColors,
  top: number,
  height: number,
  teacherBlock: TextBlock,
  principalBlock: TextBlock,
  modern: boolean,
): void {
  if (!modern) {
    strokeRect(doc, MARGIN_MM, top, CONTENT_W, height, colors.line, 0.2);
    doc.setDrawColor(...colors.line);
    doc.setLineWidth(0.2);
    doc.line(A4_W_MM / 2, top, A4_W_MM / 2, top + height);
    drawWrapped(doc, "TEACHER'S REMARKS", MARGIN_MM + 2, top + 1.4, CONTENT_W / 2 - 4, {
      size: mmToPt(TYPE_MM.remarksLabel),
      style: 'bold',
      color: colors.text,
      lineHeight: 3.4,
    });
    drawWrapped(doc, "PRINCIPAL'S REMARKS", A4_W_MM / 2 + 2, top + 1.4, CONTENT_W / 2 - 4, {
      size: mmToPt(TYPE_MM.remarksLabel),
      style: 'bold',
      color: colors.text,
      lineHeight: 3.4,
    });
    drawTextBlock(doc, teacherBlock, MARGIN_MM + 2, top + 5.6, {
      size: mmToPt(TYPE_MM.remarks),
      color: colors.muted,
    });
    drawTextBlock(doc, principalBlock, A4_W_MM / 2 + 2, top + 5.6, {
      size: mmToPt(TYPE_MM.remarks),
      color: colors.muted,
    });
    return;
  }

  const gap = 3;
  const panelW = (CONTENT_W - gap) / 2;
  [teacherBlock, principalBlock].forEach((block, index) => {
    const x = MARGIN_MM + index * (panelW + gap);
    fillRoundRect(doc, x, top, panelW, height, 2, colors.headerFill);
    /* Accent bar on the leading edge. */
    fillRect(doc, x + 0.4, top + 0.4, 1.6, height - 0.8, colors.primary);
    drawWrapped(
      doc,
      index === 0 ? "TEACHER'S REMARKS" : "PRINCIPAL'S REMARKS",
      x + 4.5,
      top + 1.6,
      panelW - 6.5,
      {
        size: mmToPt(TYPE_MM.remarksLabel),
        style: 'bold',
        color: colors.primary,
        lineHeight: 3.4,
        maxLines: 1,
      },
    );
    drawTextBlock(doc, block, x + 4.5, top + 5.8, {
      size: mmToPt(TYPE_MM.remarks),
      color: colors.muted,
    });
  });
}

/** Signatures: light rules on the classic card, colour rules on the modern one. */
function drawSignatures(
  doc: jsPDF,
  model: ReportCardModel,
  school: ThemeRenderOptions['school'],
  colors: PdfColors,
  top: number,
  modern: boolean,
): void {
  const third = CONTENT_W / 3;
  const specs: { image?: string; role: string; name?: string; stamp?: string }[] = [
    { image: school.teacherSignDataUrl, role: 'CLASS TEACHER', name: model.signatures.teacherName },
    {
      image: school.checkedBySignDataUrl,
      role: 'CHECKED BY (VICE PRINCIPAL)',
      name: model.signatures.checkedByName,
    },
    {
      image: school.principalSignDataUrl,
      role: 'PRINCIPAL',
      name: model.signatures.principalName,
      stamp: school.stampDataUrl,
    },
  ];

  specs.forEach((spec, index) => {
    const x = MARGIN_MM + third * index;
    const width = third - 2;
    if (!modern) {
      drawSignatureBlock(doc, { ...spec, x, y: top, width, colors });
      return;
    }
    const lineY = top + 12;
    doc.setDrawColor(...colors.primary);
    doc.setLineWidth(0.5);
    doc.line(x, lineY, x + width, lineY);
    if (spec.image) {
      try {
        doc.addImage(spec.image, 'PNG', x + width / 2 - 13, lineY - 12, 26, 11, undefined, 'FAST');
      } catch {
        /* ignore broken signature images */
      }
    }
    if (spec.stamp) {
      try {
        doc.addImage(spec.stamp, 'PNG', x + width - 18, lineY - 22, 18, 18, undefined, 'FAST');
      } catch {
        /* ignore */
      }
    }
    drawWrapped(doc, spec.name || '', x + width / 2, lineY + 3.4, width - 1, {
      size: mmToPt(TYPE_MM.signatureName),
      style: 'bold',
      color: colors.text,
      align: 'center',
      maxLines: 2,
    });
    drawWrapped(doc, spec.role, x + width / 2, lineY + 9.2, width - 1, {
      size: mmToPt(TYPE_MM.footer),
      style: 'bold',
      color: colors.primary,
      align: 'center',
      maxLines: 2,
    });
  });
}

export function renderAcademicLayout(opts: ThemeRenderOptions): void {
  const { doc, model, school, theme } = opts;
  const colors = colorsFromPalette(theme.palette);

  const modern = theme.variant === 'modern';
  const style = tableStyleFor(theme, colors);

  const headerBottom = modern
    ? drawModernHeader(doc, model, colors, opts.photoDataUrl)
    : drawHeader(doc, model, colors, opts.photoDataUrl);

  /* Title. */
  let y = headerBottom;
  if (modern) {
    y = drawModernTitle(doc, model.title, colors, y);
  } else {
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
  }

  const columnWidth = (CONTENT_W - INFO_PADDING * 2 - 4) / 2;
  const infoLayout = layoutInfoGrid(doc, [model.infoLeft, model.infoRight], columnWidth, {
    labelWidth: INFO_LABEL_W,
    fontSize: mmToPt(TYPE_MM.info),
    minRowHeight: 5,
  });
  const infoOptions = {
    labelWidth: INFO_LABEL_W,
    fontSize: mmToPt(TYPE_MM.info),
    padding: INFO_PADDING,
    colors,
  };
  y =
    (modern
      ? drawModernInfoGrid(doc, infoLayout, MARGIN_MM, y, columnWidth, infoOptions)
      : drawInfoGrid(doc, infoLayout, MARGIN_MM, y, CONTENT_W, columnWidth, infoOptions)) + 3;

  /* Bottom reservations (remarks, signatures, footer). */
  const halfWidth = CONTENT_W / 2 - 6;
  const teacherBlock = measureText(doc, model.teacherRemarks || '—', halfWidth, {
    size: mmToPt(TYPE_MM.remarks),
  });
  const principalBlock = measureText(doc, model.principalRemarks || '—', halfWidth, {
    size: mmToPt(TYPE_MM.remarks),
  });
  const remarksHeight = theme.sections.remarks
    ? Math.max(18, Math.max(teacherBlock.height, principalBlock.height) + 8.5)
    : 0;

  /*
   * Remarks and signatures are flowed after the content, never pinned to the
   * page bottom (that pin left a large blank gap above the remarks). Their
   * height is reserved here so the card can be auto-fitted into what is left.
   */
  const sigBlockHeight = SIGNATURE_BLOCK_H;
  const footerTop = A4_H_MM - MARGIN_MM - FOOTER_BAR_H;
  const gradingHeight = (scale: number) =>
    theme.sections.gradingScale
      ? measureText(doc, `GRADING SCALE: ${model.gradeScale}`, CONTENT_W, {
          size: fontScale(scale, mmToPt(TYPE_MM.gradingScale)),
          lineHeight: 3,
          maxLines: 3,
        }).height + 2
      : 0;
  /* The strip grows with the fill factor, so a sparse card uses the page too. */
  const stripValueHeight = (fill: number) =>
    Math.min(SUMMARY_VALUE_H * fill, SUMMARY_VALUE_MAX_H);
  const stripHeight = (fill: number) => SUMMARY_LABEL_H + stripValueHeight(fill);
  /* Everything below the table: summary strip, grading scale, remarks, signs. */
  const tail = (scale: number, fill: number) =>
    3 +
    stripHeight(fill) +
    gradingHeight(scale) +
    (theme.sections.remarks ? CONTENT_TO_REMARKS_GAP + remarksHeight : 0) +
    REMARKS_TO_SIGNATURE_GAP +
    sigBlockHeight +
    SIGNATURE_TO_FOOTER_GAP +
    FOOTER_BAR_H;

  const bodyTop = y;
  const bodyBudget = Math.max(80, footerTop - bodyTop);
  const fits = (candidate: AcademicTableLayout, fill: number) =>
    candidate.ok && candidate.totalHeight + tail(candidate.scale, fill) <= bodyBudget;

  /*
   * Auto-fit in two passes: first the most readable scale that fits, then a
   * fill factor that grows the TABLE ROW HEIGHTS — never the font — so a card
   * with few subjects uses the page instead of leaving a blank band.
   */
  const scaleCandidates = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55];
  let table = measureTable(doc, model, theme, 1);
  for (const scale of scaleCandidates) {
    const candidate = measureTable(doc, model, theme, scale);
    table = candidate;
    if (fits(candidate, 1)) break;
  }

  /*
   * Too many subjects to shrink onto one page — paginate instead of drawing
   * over the remarks/signature blocks.
   */
  if (!fits(table, 1)) {
    renderAcademicFlow(opts, colors, table.scale, bodyTop, remarksHeight);
    return;
  }

  /* Fill the page with row padding before falling back to section gaps. */
  let low = 1;
  let high = FILL_MAX;
  for (let step = 0; step < 18; step += 1) {
    const middle = (low + high) / 2;
    if (fits(measureTable(doc, model, theme, table.scale, middle), middle)) low = middle;
    else high = middle;
  }
  const chosenScale = table.scale;
  const chosenFill = low;
  table = measureTable(doc, model, theme, chosenScale, chosenFill);

  /* ── Academic table ─────────────────────────────────────────────────── */
  const columns = columnRatios(model, theme);
  const widths = columns.map((column) => column.ratio * CONTENT_W);
  const fontSize = fontScale(chosenScale, mmToPt(TYPE_MM.academic));

  y = drawTableLabel(doc, style, colors, y);
  y = drawTableHead(doc, columns, widths, fontSize, y, style, colors);

  const tableTop = y;
  model.academic.forEach((row, rowIndex) => {
    const height = table.rowHeights[rowIndex] ?? 5;
    drawTableRow(doc, row, rowIndex, columns, widths, fontSize, height, y, style, colors, theme);
    y += height;
  });
  /* Modern rows carry no vertical rules, so the table gets one clean outline. */
  if (!style.verticalRules) {
    strokeRect(doc, MARGIN_MM, tableTop, CONTENT_W, y - tableTop, style.cellLine, 0.2);
  }

  /* ── Summary ────────────────────────────────────────────────────────── */
  y = modern
    ? drawModernResultBand(doc, model, colors, y + 3, stripValueHeight(chosenFill))
    : drawSummaryStrip(doc, model, colors, y + 3, stripValueHeight(chosenFill));

  if (theme.sections.gradingScale) {
    y = drawWrapped(doc, `GRADING SCALE: ${model.gradeScale}`, MARGIN_MM, y + 2, CONTENT_W, {
      size: fontScale(chosenScale, mmToPt(TYPE_MM.gradingScale)),
      color: colors.text,
      maxLines: 3,
      lineHeight: 3,
    });
  }

  /*
   * Flow the remarks / signatures under the content instead of pinning them to
   * the bottom of the sheet.
   */
  const contentBottom = y;
  /* Anything the (capped) fill could not use is shared out over the gaps. */
  const leftover = Math.max(0, bodyBudget - (table.totalHeight + tail(chosenScale, chosenFill)));
  const extraGap = Math.min(FILL_GAP_MAX, leftover / 3);
  const remarksTop = contentBottom + (theme.sections.remarks ? CONTENT_TO_REMARKS_GAP + extraGap : 0);
  const sigTop = theme.sections.remarks
    ? remarksTop + remarksHeight + REMARKS_TO_SIGNATURE_GAP + extraGap
    : contentBottom + CONTENT_TO_REMARKS_GAP + extraGap;
  /* Never write the footer bar outside the card frame. */
  const footerBarTop = Math.min(
    sigTop + sigBlockHeight + SIGNATURE_TO_FOOTER_GAP + extraGap,
    footerTop,
  );

  /* ── Remarks ────────────────────────────────────────────────────────── */
  if (theme.sections.remarks) {
    drawRemarks(doc, model, colors, remarksTop, remarksHeight, teacherBlock, principalBlock, modern);
  }

  /* ── Signatures + frame ─────────────────────────────────────────────── */
  drawSignatures(doc, model, school, colors, sigTop, modern);

  drawFooterAndFrame(
    doc,
    colors,
    'This report card is generated from the marks recorded by the school.',
    footerBarTop,
    modern ? 'solid' : 'outline',
  );
}
