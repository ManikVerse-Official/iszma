import type jsPDF from 'jspdf';
import { hexToRgb, type ThemePalette } from '../../themes';
import { mmToPt, TYPE_MM } from '../../themes/typography';

/** A4 geometry (mm). Every layout works inside these bounds. */
export const A4_W_MM = 210;
export const A4_H_MM = 297;
export const MARGIN_MM = 8;
export const CONTENT_W = A4_W_MM - MARGIN_MM * 2;

/**
 * Vertical rhythm shared by the flowed layouts (mm): the gaps around the remarks
 * and signature blocks and the height of the footer bar. Keeping these in one
 * place lets every theme compute "how much room is left on the page" the same
 * way and fill it instead of leaving a blank region above the footer.
 */
export const CONTENT_TO_REMARKS_GAP = 3;
export const REMARKS_TO_SIGNATURE_GAP = 4;
export const SIGNATURE_TO_FOOTER_GAP = 4;
export const SIGNATURE_BLOCK_H = 24;
export const FOOTER_BAR_H = 6;

export type RGB = [number, number, number];

export interface PdfColors {
  primary: RGB;
  headerFill: RGB;
  totalFill: RGB;
  skillsWarm: RGB;
  skillsCool: RGB;
  coFill: RGB;
  overall: RGB;
  overallSoft: RGB;
  accent: RGB;
  text: RGB;
  muted: RGB;
  line: RGB;
}

export function colorsFromPalette(palette: ThemePalette): PdfColors {
  return {
    primary: hexToRgb(palette.primary),
    headerFill: hexToRgb(palette.headerFill),
    totalFill: hexToRgb(palette.totalFill),
    skillsWarm: hexToRgb(palette.skillsFillWarm),
    skillsCool: hexToRgb(palette.skillsFillCool),
    coFill: hexToRgb(palette.coScholasticFill),
    overall: hexToRgb(palette.overall),
    overallSoft: hexToRgb(palette.overallSoft),
    accent: hexToRgb(palette.accent),
    text: hexToRgb(palette.text),
    muted: hexToRgb(palette.muted),
    line: hexToRgb(palette.line),
  };
}

export type FontStyle = 'normal' | 'bold';

export interface TextStyle {
  size?: number;
  style?: FontStyle;
  color?: RGB;
  align?: 'left' | 'center' | 'right';
  /** Hard cap on the number of lines (default: unlimited — never truncate). */
  maxLines?: number;
  lineHeight?: number;
}

export interface TextBlock {
  lines: string[];
  lineHeight: number;
  height: number;
  truncated: boolean;
}

/** Split text to lines and report the vertical space it needs. */
export function measureText(
  doc: jsPDF,
  text: string,
  maxWidth: number,
  style: TextStyle = {},
): TextBlock {
  const size = style.size ?? 8;
  const fontStyle = style.style ?? 'normal';
  doc.setFont('helvetica', fontStyle);
  doc.setFontSize(size);
  const lineHeight = style.lineHeight ?? size * 0.42;
  const raw = String(text ?? '').trim();
  const all = raw === '' ? [] : (doc.splitTextToSize(raw, maxWidth) as string[]);
  const limited = style.maxLines ? all.slice(0, style.maxLines) : all;
  return {
    lines: limited,
    lineHeight,
    height: limited.length === 0 ? 0 : limited.length * lineHeight,
    truncated: limited.length < all.length,
  };
}

/** Draw a measured text block and return the y position after the last line. */
export function drawTextBlock(
  doc: jsPDF,
  block: TextBlock,
  x: number,
  y: number,
  style: TextStyle = {},
): number {
  if (block.lines.length === 0) return y;
  doc.setFont('helvetica', style.style ?? 'normal');
  doc.setFontSize(style.size ?? 8);
  doc.setTextColor(...(style.color ?? [0, 0, 0]));
  const align = style.align ?? 'left';
  block.lines.forEach((line, index) => {
    doc.text(line, x, y + index * block.lineHeight + (style.size ?? 8) * 0.35, {
      align,
    });
  });
  return y + block.height;
}

/** Draw wrapped text in one call. */
export function drawWrapped(
  doc: jsPDF,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  style: TextStyle = {},
): number {
  return drawTextBlock(doc, measureText(doc, text, maxWidth, style), x, y, style);
}

export function fillRect(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RGB,
): void {
  doc.setFillColor(...color);
  doc.rect(x, y, w, h, 'F');
}

export function strokeRect(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RGB,
  lineWidth = 0.2,
): void {
  doc.setDrawColor(...color);
  doc.setLineWidth(lineWidth);
  doc.rect(x, y, w, h, 'S');
}

export function fillRoundRect(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
  color: RGB,
): void {
  doc.setFillColor(...color);
  doc.roundedRect(x, y, w, h, radius, radius, 'F');
}

/**
 * A slim progress track (used by the modern theme for the per-subject marks
 * bars). Both the track and the fill come from the theme palette.
 */
export function drawProgressBar(
  doc: jsPDF,
  x: number,
  y: number,
  w: number,
  h: number,
  ratio: number,
  track: RGB,
  fill: RGB,
): void {
  const clamped = Math.max(0, Math.min(1, ratio));
  fillRoundRect(doc, x, y, w, h, h / 2, track);
  if (clamped > 0.02) fillRoundRect(doc, x, y, Math.max(h, w * clamped), h, h / 2, fill);
}

/* ── student info grid ────────────────────────────────────────────────── */

export interface InfoItem {
  label: string;
  value: string;
}

export interface InfoGridLayout {
  height: number;
  rows: { labelBlock: TextBlock; valueBlock: TextBlock; rowHeight: number }[][];
}

/**
 * Measure the two-column student info grid.
 *
 * Values wrap onto as many lines as they need and each row grows with its
 * content, so a long father's name / address can never collide with the column
 * beside it (the historical "Father's Name over Admission No." bug).
 */
export function layoutInfoGrid(
  doc: jsPDF,
  columns: InfoItem[][],
  columnWidth: number,
  options: { labelWidth: number; fontSize: number; minRowHeight: number },
): InfoGridLayout {
  const { labelWidth, fontSize, minRowHeight } = options;
  const valueWidth = columnWidth - labelWidth - 4;

  const perColumn = columns.map((items) =>
    items.map((item) => {
      const labelBlock = measureText(doc, item.label, labelWidth, {
        size: fontSize,
        style: 'bold',
        lineHeight: fontSize * 0.42,
      });
      const valueBlock = measureText(doc, item.value || '—', valueWidth, {
        size: fontSize,
        lineHeight: fontSize * 0.42,
      });
      const rowHeight = Math.max(
        minRowHeight,
        Math.max(labelBlock.height, valueBlock.height) + 1.6,
      );
      return { labelBlock, valueBlock, rowHeight };
    }),
  );

  const maxRows = Math.max(...perColumn.map((rows) => rows.length), 0);
  let height = 0;
  for (let rowIndex = 0; rowIndex < maxRows; rowIndex++) {
    const rowHeight = Math.max(
      ...perColumn.map((rows) => rows[rowIndex]?.rowHeight ?? 0),
      minRowHeight,
    );
    height += rowHeight;
  }

  return { height, rows: perColumn };
}

export function drawInfoGrid(
  doc: jsPDF,
  layout: InfoGridLayout,
  x: number,
  top: number,
  totalWidth: number,
  columnWidth: number,
  options: { labelWidth: number; fontSize: number; colors: PdfColors; padding: number },
): number {
  const { labelWidth, fontSize, colors, padding } = options;

  strokeRect(doc, x, top, totalWidth, layout.height + padding * 2, colors.primary, 0.3);

  const columnX = [x + padding, x + padding + columnWidth + 4];

  layout.rows.forEach((rows, columnIndex) => {
    let y = top + padding;
    for (const row of rows) {
      drawTextBlock(doc, row.labelBlock, columnX[columnIndex], y, {
        size: fontSize,
        style: 'bold',
        color: colors.text,
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

/* ── stars ────────────────────────────────────────────────────────────── */

export function drawStars(
  doc: jsPDF,
  x: number,
  centerY: number,
  filled: number,
  maxStars: number,
  accent: RGB,
): void {
  const radius = 1.15;
  const gap = 3.0;
  for (let i = 0; i < maxStars; i++) {
    drawStar(doc, x + i * gap, centerY, radius, i < filled, accent);
  }
}

export function drawStar(
  doc: jsPDF,
  cx: number,
  cy: number,
  r: number,
  filled: boolean,
  accent: RGB,
): void {
  const inner = r * 0.42;
  const points: [number, number][] = [];
  for (let i = 0; i < 10; i++) {
    const angle = -Math.PI / 2 + (i * Math.PI) / 5;
    const radius = i % 2 === 0 ? r : inner;
    points.push([cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius]);
  }
  const deltas: [number, number][] = [];
  for (let i = 1; i < points.length; i++) {
    deltas.push([points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]]);
  }
  deltas.push([
    points[0][0] - points[points.length - 1][0],
    points[0][1] - points[points.length - 1][1],
  ]);

  doc.setLineWidth(0.15);
  if (filled) {
    doc.setFillColor(...accent);
    doc.setDrawColor(...accent);
    doc.lines(deltas, points[0][0], points[0][1], [1, 1], 'F', false);
  } else {
    doc.setDrawColor(203, 213, 225);
    doc.lines(deltas, points[0][0], points[0][1], [1, 1], 'S', false);
  }
}

/* ── signatures, footer, frame ────────────────────────────────────────── */

export function drawSignatureBlock(
  doc: jsPDF,
  opts: {
    image?: string;
    role: string;
    name?: string;
    stamp?: string;
    x: number;
    y: number;
    width: number;
    colors: PdfColors;
  },
): void {
  const { image, role, name, stamp, x, y, width, colors } = opts;
  const lineY = y + 12;

  doc.setDrawColor(...colors.line);
  doc.setLineWidth(0.2);
  doc.line(x, lineY, x + width, lineY);

  if (image) {
    try {
      doc.addImage(image, 'PNG', x + width / 2 - 13, lineY - 12, 26, 11, undefined, 'FAST');
    } catch {
      /* ignore broken signature images */
    }
  }
  if (stamp) {
    try {
      doc.addImage(stamp, 'PNG', x + width - 18, lineY - 22, 18, 18, undefined, 'FAST');
    } catch {
      /* ignore */
    }
  }

  drawWrapped(doc, name || '', x + width / 2, lineY + 3.6, width - 1, {
    size: mmToPt(TYPE_MM.signatureName),
    color: colors.text,
    align: 'center',
    maxLines: 2,
  });
  drawWrapped(doc, role, x + width / 2, lineY + 9.4, width - 1, {
    size: mmToPt(TYPE_MM.footer),
    style: 'bold',
    color: colors.muted,
    align: 'center',
    maxLines: 2,
  });
}

export function drawFooterAndFrame(
  doc: jsPDF,
  colors: PdfColors,
  text: string,
  /**
   * Where to place the footer bar. Defaults to the bottom of the content area;
   * flow layouts pass the y that follows their last block so the sheet does not
   * keep an empty gap between the signatures and the footer.
   */
  top?: number,
  /**
   * `solid` paints the bar in the theme colour with reversed text — used by the
   * modern theme, which anchors the sheet with a coloured strip instead of a
   * thin outlined box.
   */
  style: 'outline' | 'solid' = 'outline',
): void {
  const footerY = top ?? A4_H_MM - MARGIN_MM - 6;
  if (style === 'solid') {
    fillRect(doc, MARGIN_MM, footerY, CONTENT_W, 6, colors.primary);
    drawWrapped(doc, text, A4_W_MM / 2, footerY + 1.2, CONTENT_W - 4, {
      size: mmToPt(TYPE_MM.footer),
      color: [255, 255, 255],
      align: 'center',
      maxLines: 2,
    });
  } else {
    strokeRect(doc, MARGIN_MM, footerY, CONTENT_W, 6, colors.line, 0.2);
    drawWrapped(doc, text, A4_W_MM / 2, footerY + 1.2, CONTENT_W - 4, {
      size: mmToPt(TYPE_MM.footer),
      color: colors.muted,
      align: 'center',
      maxLines: 2,
    });
  }

  strokeRect(
    doc,
    MARGIN_MM - 2,
    MARGIN_MM - 2,
    CONTENT_W + 4,
    A4_H_MM - (MARGIN_MM - 2) * 2,
    style === 'solid' ? colors.line : colors.primary,
    0.4,
  );
}

export function drawLogoBox(
  doc: jsPDF,
  logoDataUrl: string | undefined,
  x: number,
  y: number,
  size: number,
  colors: PdfColors,
  label = 'Logo',
): void {
  if (logoDataUrl) {
    try {
      doc.addImage(logoDataUrl, 'PNG', x, y, size, size, undefined, 'FAST');
      return;
    } catch {
      /* fall through to the placeholder */
    }
  }
  doc.setDrawColor(...colors.line);
  doc.setFillColor(248, 250, 252);
  doc.rect(x, y, size, size, 'DF');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(100, 116, 139);
  doc.text(label, x + size / 2, y + size / 2 + 1, { align: 'center' });
  doc.setTextColor(...colors.text);
}

/* ── student photo ────────────────────────────────────────────────────── */

/**
 * Read the intrinsic pixel size of a PNG/JPEG data URL so the photo can be
 * fitted into its box without distorting the child's face.
 */
export function imageSizeFromDataUrl(
  dataUrl: string,
): { width: number; height: number } | null {
  try {
    const base64 = dataUrl.split(',')[1] ?? '';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    /* PNG: IHDR width/height at bytes 16..24. */
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) {
      const width = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const height = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      if (width > 0 && height > 0) return { width, height };
    }

    /* JPEG: walk the markers to the first SOF segment. */
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      let offset = 2;
      while (offset + 9 < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset++;
          continue;
        }
        const marker = bytes[offset + 1];
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        const isSof =
          marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSof) {
          const height = (bytes[offset + 5] << 8) | bytes[offset + 6];
          const width = (bytes[offset + 7] << 8) | bytes[offset + 8];
          if (width > 0 && height > 0) return { width, height };
          return null;
        }
        offset += 2 + length;
      }
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Draw the student photo (or an empty placeholder) inside an exact box.
 * The image is contained in the box, so it is never stretched or clipped.
 *
 * A missing photo always results in a blank placeholder box — never another
 * student's photo.
 */
export function drawPhotoBox(
  doc: jsPDF,
  dataUrl: string | undefined,
  x: number,
  y: number,
  w: number,
  h: number,
  colors: PdfColors,
  label = 'PHOTO',
): void {
  strokeRect(doc, x, y, w, h, colors.line, 0.25);

  if (dataUrl) {
    const size = imageSizeFromDataUrl(dataUrl);
    let drawW = w;
    let drawH = h;
    if (size) {
      const ratio = Math.min(w / size.width, h / size.height);
      drawW = size.width * ratio;
      drawH = size.height * ratio;
    }
    const format = /^data:image\/png/i.test(dataUrl)
      ? 'PNG'
      : /^data:image\/webp/i.test(dataUrl)
        ? 'WEBP'
        : 'JPEG';
    try {
      doc.addImage(
        dataUrl,
        format,
        x + (w - drawW) / 2,
        y + (h - drawH) / 2,
        drawW,
        drawH,
        undefined,
        'FAST',
      );
      return;
    } catch {
      /* fall through to the placeholder */
    }
  }

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(...colors.muted);
  doc.text(label, x + w / 2, y + h / 2 + 1, { align: 'center' });
  doc.setTextColor(...colors.text);
}

/** Fit factor for layouts that must stay on exactly one A4 page. */
export function pickScale(
  neededAtScale: (scale: number) => number,
  available: number,
  candidates: number[] = [1, 0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6],
): number {
  for (const scale of candidates) {
    if (neededAtScale(scale) <= available) return scale;
  }
  return candidates[candidates.length - 1];
}
