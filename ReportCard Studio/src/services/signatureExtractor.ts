/**
 * Signature / stamp background removal — local, in-browser, no upload.
 *
 * A phone photo of a handwritten signature or a rubber stamp carries the paper
 * it was shot on: grey/white paper, shadows, uneven lighting, a table edge,
 * sometimes printed text from the page behind it. Stamping that whole rectangle
 * onto a report card is what made the drawn cards look wrong.
 *
 * This module keeps the OWNER'S OWN INK and throws the paper away. It never
 * redraws, traces, beautifies or "improves" the strokes: every opaque pixel is
 * the original pixel the camera captured, only its alpha changes. Nothing is
 * uploaded anywhere and no paid API is involved.
 *
 * How the background is estimated (this is the part that makes grey paper and
 * shadows disappear):
 *
 *   1. a sliding-window MAXIMUM per colour channel (a greyscale dilation) of
 *      ~1–3 % of the image width produces a "paper brightness" map. A thin ink
 *      stroke is removed by the max filter, an A4 sheet's vignette or a cast
 *      shadow is kept, because both vary far slower than the stroke width;
 *   2. that map is box-blurred so the background is smooth and cannot imprint
 *      its own texture into the alpha;
 *   3. each pixel is divided by its LOCAL background per channel, which is a
 *      white-balance correction at every point of the photo — a yellow-tinted
 *      or shadowed sheet therefore maps to (near) white, not to grey ink;
 *   4. alpha is the darkness that is left, shaped by a soft ramp, so edges keep
 *      natural anti-aliasing instead of a jagged hard cut;
 *   5. 'auto' and 'colour' ink modes additionally keep saturated (blue / red /
 *      green) marks that a pure brightness test would drop.
 *
 * Deterministic failure handling: if the extraction finds nothing, or finds ink
 * over almost the whole frame (i.e. the "background" was darker than the ink, so
 * the photo is unusable), the caller keeps the user's ORIGINAL image and asks
 * them to adjust it by hand. A signature is never silently destroyed.
 *
 * The pixel maths lives in `extractInk`, which takes and returns plain typed
 * arrays, so it is exercised by `scripts/check-signature-extraction.ts` in Node
 * without a DOM. Only `decodeImageFile` / `renderExtractedPng` touch the canvas.
 */

export interface InkExtractionOptions {
  /** 0–100. Lower keeps only solid, dark strokes; higher also keeps faint ones. */
  threshold: number;
  /** 0–100. Width of the alpha ramp — higher gives softer, more natural edges. */
  edge: number;
  /** 0–100. Size of the local paper-estimation window (bigger = more flattening). */
  background: number;
  /** 'auto' keeps dark ink and saturated marks; 'dark' only brightness; 'colour' favours saturated ink. */
  ink: 'auto' | 'dark' | 'colour';
  /** 0–100. Speckle removal strength (isolated pixels that are not real ink). */
  despeckle: number;
}

export const DEFAULT_INK_OPTIONS: InkExtractionOptions = {
  threshold: 45,
  edge: 35,
  background: 45,
  ink: 'auto',
  despeckle: 40,
};

/** A crop rectangle in fractions (0–1) of the analysed image. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const FULL_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };

export interface InkBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InkExtractionResult {
  /** False when the photo is unusable — the caller must keep the original. */
  ok: boolean;
  /** Human-readable explanation when `ok` is false. */
  reason?: string;
  width: number;
  height: number;
  /** RGBA pixels; RGB is untouched original colour, only alpha was computed. */
  rgba: Uint8ClampedArray;
  /** Bounding box of the surviving ink (null when there is none). */
  bounds: InkBounds | null;
  /** Share of pixels that carry ink (0–1). */
  coverage: number;
}

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

const smoothstep = (low: number, high: number, value: number): number => {
  if (high <= low) return value >= high ? 1 : 0;
  const t = clamp01((value - low) / (high - low));
  return t * t * (3 - 2 * t);
};

/**
 * Map the sliders onto the darkness thresholds.
 *
 * `low` is where ink starts to appear and `high` where it becomes fully opaque.
 * A high threshold keeps faint pencil strokes; a low one keeps only solid ink
 * (and is the safest choice for a grey, low-contrast phone photo). The `edge`
 * slider only widens the ramp, never moves the start, so raising softness cannot
 * suddenly flood the card with paper.
 */
export const alphaThresholds = (
  options: Pick<InkExtractionOptions, 'threshold' | 'edge'>,
): { low: number; high: number } => {
  const threshold = clamp01((options.threshold ?? 45) / 100);
  const edge = clamp01((options.edge ?? 35) / 100);
  const low = 0.06 + (1 - threshold) * 0.52;
  const ramp = 0.06 + edge * 0.3;
  return { low, high: Math.min(0.98, low + ramp) };
};

/** Window radius (in pixels) used to estimate the local paper brightness. */
export const backgroundRadius = (background: number, width: number): number => {
  const share = 0.008 + clamp01((background ?? 45) / 100) * 0.03;
  return Math.max(6, Math.round(Math.min(width, 1600) * share));
};

/**
 * Sliding-window maximum of one channel, separable (rows then columns).
 *
 * A monotonic deque makes each output O(1) amortised, so the paper-brightness
 * map of a 12 MP photo costs a single pass instead of one pass per pixel per
 * window. `edge`-sized borders are handled by clamping the window to the frame.
 */
const slidingMax = (
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number,
): void => {
  const tmp = new Float32Array(src.length);
  const cap = Math.max(width, height) + radius + 2;
  const values = new Float32Array(cap);
  const indices = new Int32Array(cap);

  // Rows.
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let head = 0;
    let tail = 0;
    for (let x = 0; x < width + radius; x += 1) {
      if (x < width) {
        const value = src[row + x];
        while (tail > head && values[tail - 1] <= value) tail -= 1;
        values[tail] = value;
        indices[tail] = x;
        tail += 1;
      }
      const out = x - radius;
      if (out >= 0) {
        while (indices[head] < out - radius) head += 1;
        tmp[row + out] = values[head];
      }
    }
  }

  // Columns.
  for (let x = 0; x < width; x += 1) {
    let head = 0;
    let tail = 0;
    for (let y = 0; y < height + radius; y += 1) {
      if (y < height) {
        const value = tmp[y * width + x];
        while (tail > head && values[tail - 1] <= value) tail -= 1;
        values[tail] = value;
        indices[tail] = y;
        tail += 1;
      }
      const out = y - radius;
      if (out >= 0) {
        while (indices[head] < out - radius) head += 1;
        dst[out * width + x] = values[head];
      }
    }
  }
};

/** In-place separable box blur (used to smooth the local-background estimate). */
const boxBlur = (
  data: Float32Array,
  width: number,
  height: number,
  radius: number,
): void => {
  if (radius < 1) return;
  const tmp = new Float32Array(data.length);
  const window = radius * 2 + 1;

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let sum = 0;
    for (let x = -radius; x <= radius; x += 1) sum += data[row + Math.min(width - 1, Math.max(0, x))];
    for (let x = 0; x < width; x += 1) {
      tmp[row + x] = sum / window;
      const outIndex = Math.min(width - 1, Math.max(0, x - radius));
      const inIndex = Math.min(width - 1, Math.max(0, x + radius + 1));
      sum += data[row + inIndex] - data[row + outIndex];
    }
  }

  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = -radius; y <= radius; y += 1) sum += tmp[Math.min(height - 1, Math.max(0, y)) * width + x];
    for (let y = 0; y < height; y += 1) {
      data[y * width + x] = sum / window;
      const outIndex = Math.min(height - 1, Math.max(0, y - radius));
      const inIndex = Math.min(height - 1, Math.max(0, y + radius + 1));
      sum += tmp[inIndex * width + x] - tmp[outIndex * width + x];
    }
  }
};

/**
 * Removes the paper from one RGBA frame.
 *
 * Pure function: the input is not modified, and everything it needs is in the
 * arguments, so the regression check can call it directly.
 */
export const extractInk = (
  source: Uint8ClampedArray,
  width: number,
  height: number,
  options: InkExtractionOptions = DEFAULT_INK_OPTIONS,
): InkExtractionResult => {
  const total = width * height;
  const rgba = new Uint8ClampedArray(source.length);
  rgba.set(source);

  if (frameIsEmpty(source, width, height)) {
    return {
      ok: false,
      reason: 'That image has no usable pixels.',
      width,
      height,
      rgba,
      bounds: null,
      coverage: 0,
    };
  }

  const r = new Float32Array(total);
  const g = new Float32Array(total);
  const b = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    r[i] = source[i * 4];
    g[i] = source[i * 4 + 1];
    b[i] = source[i * 4 + 2];
  }

  const radius = backgroundRadius(options.background, width);
  const bgR = new Float32Array(total);
  const bgG = new Float32Array(total);
  const bgB = new Float32Array(total);
  slidingMax(r, bgR, width, height, radius);
  slidingMax(g, bgG, width, height, radius);
  slidingMax(b, bgB, width, height, radius);
  const smooth = Math.max(2, Math.round(radius * 0.6));
  boxBlur(bgR, width, height, smooth);
  boxBlur(bgG, width, height, smooth);
  boxBlur(bgB, width, height, smooth);

  const { low, high } = alphaThresholds(options);
  const inkMode = options.ink ?? 'auto';
  const saturationFloor = 0.22;

  const alpha = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    // Local white balance: divide each channel by the paper brightness there.
    const bgRc = Math.max(8, bgR[i]);
    const bgGc = Math.max(8, bgG[i]);
    const bgBc = Math.max(8, bgB[i]);
    const nr = Math.min(255, (r[i] * 255) / bgRc);
    const ng = Math.min(255, (g[i] * 255) / bgGc);
    const nb = Math.min(255, (b[i] * 255) / bgBc);

    const lum = 0.299 * nr + 0.587 * ng + 0.114 * nb;
    const brightness = (255 - lum) / 255;
    const sat = saturatedness(nr, ng, nb);

    let value: number;
    if (inkMode === 'dark') {
      value = brightness;
    } else if (inkMode === 'colour') {
      value = Math.max(brightness * 0.75, Math.max(0, sat - saturationFloor) * 2.2);
    } else {
      // 'auto': a dark stroke OR a clearly saturated mark counts as ink, so a
      // blue pen and a red rubber stamp survive a brightness-only test.
      value = Math.max(brightness, Math.max(0, sat - saturationFloor) * 1.6);
    }

    alpha[i] = smoothstep(low, high, value);
  }

  const despeckle = clamp01((options.despeckle ?? 40) / 100);
  if (despeckle > 0) {
    const minNeighbours = despeckle > 0.66 ? 4 : despeckle > 0.33 ? 2 : 1;
    removeSpecks(alpha, width, height, minNeighbours, despeckle > 0.66 ? 2 : 1);
  }

  let inkPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      let value = alpha[index];
      if (value < 0.02) value = 0;
      if (value > 0) {
        inkPixels += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      rgba[index * 4 + 3] = Math.round(clamp01(value) * 255);
    }
  }

  const coverage = inkPixels / total;

  if (inkPixels === 0) {
    return {
      ok: false,
      reason:
        'No signature ink was detected — the photo may be too light, too blurry or the wrong way up.',
      width,
      height,
      rgba,
      bounds: null,
      coverage: 0,
    };
  }

  /*
   * Ink over almost the entire frame means the "background" estimate was darker
   * than the marks (a very dark photo, or heavy shadow over the whole sheet).
   * Extracting that would tile the report card with grey, so refuse and let the
   * user keep/adjust the original instead.
   */
  if (coverage > 0.85) {
    return {
      ok: false,
      reason:
        'Almost the whole photo looks like ink — the picture is probably too dark or too shadowed. Keep the original and adjust it manually.',
      width,
      height,
      rgba,
      bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      coverage,
    };
  }

  return {
    ok: true,
    width,
    height,
    rgba,
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    coverage,
  };
};

const frameIsEmpty = (source: Uint8ClampedArray, width: number, height: number): boolean =>
  width < 2 || height < 2 || source.length < width * height * 4;

/** Chroma proxy: how far a pixel is from grey, 0–1. */
const saturatedness = (r: number, g: number, b: number): number => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max <= 0) return 0;
  return (max - min) / max;
};

/**
 * Deletes isolated pixels: real ink is a connected stroke, a JPEG artefact or a
 * dust speck is not. One or two passes are enough and are cheap.
 */
const removeSpecks = (
  alpha: Float32Array,
  width: number,
  height: number,
  minNeighbours: number,
  passes: number,
): void => {
  const alive = 0.16;
  for (let pass = 0; pass < passes; pass += 1) {
    const doomed: number[] = [];
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x;
        if (alpha[index] <= 0) continue;
        let neighbours = 0;
        for (let dy = -1; dy <= 1 && neighbours < minNeighbours; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            if (alpha[(y + dy) * width + (x + dx)] >= alive) neighbours += 1;
            if (neighbours >= minNeighbours) break;
          }
        }
        if (neighbours < minNeighbours) doomed.push(index);
      }
    }
    if (doomed.length === 0) return;
    for (const index of doomed) alpha[index] = 0;
  }
};

/**
 * Grows a bounding box around the detected ink so a crop never clips a stroke.
 *
 * A little padding is added because the soft ramp makes the outermost
 * anti-aliased pixels nearly transparent — cutting exactly at the first opaque
 * pixel would shave the stroke's edge.
 */
export const padBounds = (bounds: InkBounds, width: number, height: number): InkBounds => {
  const padding = Math.max(2, Math.round(Math.min(bounds.width, bounds.height) * 0.06));
  const x = Math.max(0, bounds.x - padding);
  const y = Math.max(0, bounds.y - padding);
  const right = Math.min(width, bounds.x + bounds.width + padding);
  const bottom = Math.min(height, bounds.y + bounds.height + padding);
  return { x, y, width: right - x, height: bottom - y };
};

/** Applies a fractional crop rectangle to pixel bounds, keeping 1 px minimums. */
export const cropPixels = (crop: CropRect, width: number, height: number): InkBounds => {
  const x = Math.round(Math.min(Math.max(0, crop.x), 0.99) * width);
  const y = Math.round(Math.min(Math.max(0, crop.y), 0.99) * height);
  const w = Math.round(Math.min(Math.max(0.01, crop.width), 1 - crop.x) * width);
  const h = Math.round(Math.min(Math.max(0.01, crop.height), 1 - crop.y) * height);
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, w)),
    height: Math.max(1, Math.min(height - y, h)),
  };
};

/* ── browser helpers (canvas) ─────────────────────────────────────────── */

export interface DecodedSignatureImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

const MAX_SOURCE_EDGE = 1400;

const rotationCanvasAngle = (degrees: number): number =>
  ((degrees % 360) + 360) % 360;

/** Draws an upright copy of a decoded bitmap, honouring a rotation in degrees. */
const drawRotated = (
  bitmap: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  degrees: number,
  targetWidth: number,
  targetHeight: number,
): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.imageSmoothingQuality = 'high';

  const angle = rotationCanvasAngle(degrees);
  if (angle % 90 === 0 && angle !== 0) {
    const swapped = angle === 90 || angle === 270;
    const drawWidth = swapped ? targetHeight : targetWidth;
    const drawHeight = swapped ? targetWidth : targetHeight;
    ctx.translate(targetWidth / 2, targetHeight / 2);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.drawImage(bitmap, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    return canvas;
  }

  ctx.translate(targetWidth / 2, targetHeight / 2);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.drawImage(bitmap, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
  return canvas;
};

/**
 * Decodes a JPG/JPEG/PNG (including a phone photo) to an upright canvas.
 *
 * `imageOrientation: 'from-image'` makes the browser apply the EXIF rotation of
 * a camera photo, so a picture shot sideways is not analysed on its side.
 * The longest edge is capped so the maths stays instant on a 12 MP shot.
 */
export const decodeImageFile = async (
  file: File | Blob,
  rotate = 0,
): Promise<DecodedSignatureImage> => {
  const bitmap = await createUprightBitmap(file);
  const scale = Math.min(1, MAX_SOURCE_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const turns = rotationCanvasAngle(rotate);
  const swaps = turns % 180 !== 0 && turns % 90 === 0;
  const canvas = drawRotated(
    bitmap,
    bitmap.width,
    bitmap.height,
    rotate,
    swaps ? height : width,
    swaps ? width : height,
  );
  if (typeof (bitmap as ImageBitmap).close === 'function') (bitmap as ImageBitmap).close();

  return { canvas, width: canvas.width, height: canvas.height };
};

const createUprightBitmap = async (file: File | Blob): Promise<ImageBitmap | HTMLImageElement> => {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    /* Safari/older browsers: fall back to an <img>, which applies EXIF itself. */
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('That image could not be read.'));
      image.src = url;
    });
    if (typeof image.decode === 'function') await image.decode().catch(() => {});
    return image;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
};

/**
 * Runs the whole pipeline and returns a transparent PNG data URL.
 *
 * `autoCrop` shrinks the result to the ink (plus padding) so the report card
 * shows the signature, not an empty sheet around it. The crop rectangle is
 * applied first so the user's manual selection always wins.
 */
export interface ExtractSignatureInput {
  source: HTMLCanvasElement;
  options: InkExtractionOptions;
  crop?: CropRect;
  autoCrop?: boolean;
}

export interface ExtractSignatureOutput {
  ok: boolean;
  reason?: string;
  dataUrl?: string;
  width: number;
  height: number;
  coverage: number;
  bounds: InkBounds | null;
}

export const extractSignaturePng = ({
  source,
  options,
  crop = FULL_CROP,
  autoCrop = true,
}: ExtractSignatureInput): ExtractSignatureOutput => {
  const full = source.getContext('2d', { willReadFrequently: true });
  if (!full) {
    return { ok: false, reason: 'This browser could not read the image.', width: 0, height: 0, coverage: 0, bounds: null };
  }

  const region = cropPixels(crop, source.width, source.height);
  const data = full.getImageData(region.x, region.y, region.width, region.height);
  const result = extractInk(data.data, region.width, region.height, options);

  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason,
      width: result.width,
      height: result.height,
      coverage: result.coverage,
      bounds: result.bounds,
    };
  }

  const box =
    autoCrop && result.bounds
      ? padBounds(result.bounds, result.width, result.height)
      : { x: 0, y: 0, width: result.width, height: result.height };

  const output = document.createElement('canvas');
  output.width = box.width;
  output.height = box.height;
  const ctx = output.getContext('2d');
  if (!ctx) {
    return { ok: false, reason: 'This browser could not export the image.', width: 0, height: 0, coverage: 0, bounds: null };
  }

  const trimmed = new ImageData(new Uint8ClampedArray(result.rgba), result.width, result.height);
  const scratch = document.createElement('canvas');
  scratch.width = result.width;
  scratch.height = result.height;
  const scratchCtx = scratch.getContext('2d');
  if (!scratchCtx) {
    return { ok: false, reason: 'This browser could not export the image.', width: 0, height: 0, coverage: 0, bounds: null };
  }
  scratchCtx.putImageData(trimmed, 0, 0);
  ctx.drawImage(scratch, box.x, box.y, box.width, box.height, 0, 0, box.width, box.height);

  return {
    ok: true,
    dataUrl: output.toDataURL('image/png'),
    width: output.width,
    height: output.height,
    coverage: result.coverage,
    bounds: box,
  };
};

/**
 * Rotates a decoded canvas by an arbitrary angle, growing the canvas so no
 * corner is clipped. Used for the fine "straighten" slider, which must not
 * re-read the original file on every drag.
 */
export const rotateCanvas = (source: HTMLCanvasElement, degrees: number): HTMLCanvasElement => {
  const angle = ((degrees % 360) + 360) % 360;
  if (angle === 0) return source;
  const radians = (angle * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  const width = Math.round(source.width * cos + source.height * sin);
  const height = Math.round(source.width * sin + source.height * cos);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return source;
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(width / 2, height / 2);
  ctx.rotate(radians);
  ctx.drawImage(source, -source.width / 2, -source.height / 2);
  return canvas;
};

/**
 * Decodes a file and reports how it looked before extraction, so the dialog can
 * show the untouched photo beside the preview.
 */
export const prepareSignatureSource = async (
  file: File | Blob,
  rotate = 0,
): Promise<{ source: HTMLCanvasElement; previewUrl: string }> => {
  const decoded = await decodeImageFile(file, rotate);
  return { source: decoded.canvas, previewUrl: decoded.canvas.toDataURL('image/png') };
};

export const readFileAsDataUrl = (file: File | Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('That file could not be read.'));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
