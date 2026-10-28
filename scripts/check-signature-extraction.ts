/*
 * Signature & stamp background-removal regression check.
 *
 * Pins the behaviour the report card depends on:
 *
 *   • synthetic photos (grey paper, a shadow gradient, a coloured rubber stamp)
 *     lose their paper and keep the ink, with natural soft edges;
 *   • nothing is redrawn — the surviving pixels keep their ORIGINAL colour, only
 *     alpha changes;
 *   • a blank or unusable photo FAILS instead of producing a grey rectangle, so
 *     the caller keeps the user's original image;
 *   • the ink bounding box (used for auto-crop) actually contains the ink;
 *   • the whole pipeline is local: the service never uploads anything and never
 *     calls a paid API.
 *
 * Run: npm run check:signature
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_INK_OPTIONS,
  alphaThresholds,
  backgroundRadius,
  cropPixels,
  extractInk,
  padBounds,
} from '../ReportCard Studio/src/services/signatureExtractor.ts';

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    return;
  }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const source = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

/* ── synthetic photo helpers ───────────────────────────────────────────── */

interface Frame {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
}

const makeFrame = (
  width: number,
  height: number,
  paint: (x: number, y: number) => [number, number, number],
): Frame => {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = paint(x, y);
      const index = (y * width + x) * 4;
      pixels[index] = r;
      pixels[index + 1] = g;
      pixels[index + 2] = b;
      pixels[index + 3] = 255;
    }
  }
  return { pixels, width, height };
};

const alphaAt = (frame: Frame, data: Uint8ClampedArray, x: number, y: number): number =>
  data[(y * frame.width + x) * 4 + 3];

/** A horizontal stroke from x1..x2 at y, 2 px thick. */
const strokeBand = (y: number, thickness: number) =>
  (x: number, row: number) => row >= y && row < y + thickness && x > 0;

const runTests = () => {
  /* ------------------------------------------------------------------ */
  /* 1. Grey paper + dark handwriting                                    */
  /* ------------------------------------------------------------------ */
  const paper = makeFrame(160, 60, (x, y) =>
    strokeBand(28, 3)(x, y) ? [28, 28, 34] : [198, 196, 190],
  );
  const onPaper = extractInk(paper.pixels, paper.width, paper.height, DEFAULT_INK_OPTIONS);

  check('grey paper with handwriting is extracted', onPaper.ok, onPaper.reason ?? '');
  check(
    'the paper becomes fully transparent',
    alphaAt(paper, onPaper.rgba, 5, 5) === 0 && alphaAt(paper, onPaper.rgba, 150, 55) === 0,
  );
  check('the handwriting becomes opaque', alphaAt(paper, onPaper.rgba, 40, 29) > 200);
  check(
    'ink coverage is small (no full-frame slab)',
    onPaper.coverage > 0.01 && onPaper.coverage < 0.2,
    `coverage=${onPaper.coverage.toFixed(3)}`,
  );
  check(
    'the surviving pixels keep their ORIGINAL colour',
    onPaper.rgba[(29 * 160 + 40) * 4] === paper.pixels[(29 * 160 + 40) * 4] &&
      onPaper.rgba[(29 * 160 + 40) * 4 + 1] === paper.pixels[(29 * 160 + 40) * 4 + 1],
  );
  check(
    'the ink bounding box contains the stroke',
    onPaper.bounds !== null &&
      onPaper.bounds.y <= 28 &&
      onPaper.bounds.y + onPaper.bounds.height >= 31,
    JSON.stringify(onPaper.bounds),
  );

  /* ------------------------------------------------------------------ */
  /* 2. Uneven lighting: a shadow that darkens half the sheet            */
  /* ------------------------------------------------------------------ */
  const shadowed = makeFrame(160, 60, (x, y) => {
    // Paper brightness falls from 245 to 120 across the page.
    const brightness = Math.round(245 - (x / 159) * 125);
    return strokeBand(30, 3)(x, y) ? [brightness - 160, brightness - 160, brightness - 155] : [brightness, brightness, brightness];
  });
  const onShadow = extractInk(shadowed.pixels, shadowed.width, shadowed.height, DEFAULT_INK_OPTIONS);

  check('a shadowed photo is extracted', onShadow.ok, onShadow.reason ?? '');
  check(
    'the shadow itself does not become ink',
    alphaAt(shadowed, onShadow.rgba, 150, 5) === 0 && alphaAt(shadowed, onShadow.rgba, 10, 55) === 0,
  );
  check(
    'ink survives inside the darkest part of the shadow',
    alphaAt(shadowed, onShadow.rgba, 150, 31) > 150 && alphaAt(shadowed, onShadow.rgba, 10, 31) > 150,
  );

  /* ------------------------------------------------------------------ */
  /* 3. Coloured rubber stamp (red on white)                             */
  /* ------------------------------------------------------------------ */
  const stamped = makeFrame(80, 40, (x, y) =>
    x > 18 && x < 62 && y > 10 && y < 30 ? [186, 28, 34] : [248, 248, 246],
  );
  const onStamp = extractInk(stamped.pixels, stamped.width, stamped.height, {
    ...DEFAULT_INK_OPTIONS,
    ink: 'auto',
  });

  check('a red stamp is extracted', onStamp.ok, onStamp.reason ?? '');
  check(
    'the stamp imprint stays red (not flattened to grey)',
    onStamp.rgba[(20 * 80 + 40) * 4] > 150 && onStamp.rgba[(20 * 80 + 40) * 4 + 1] < 80,
  );
  check('the stamp paper is removed', alphaAt(stamped, onStamp.rgba, 2, 2) === 0);

  /* ------------------------------------------------------------------ */
  /* 4. Failure is safe: blank paper, and an all-dark frame              */
  /* ------------------------------------------------------------------ */
  const blank = makeFrame(60, 30, () => [240, 240, 238]);
  const onBlank = extractInk(blank.pixels, blank.width, blank.height, DEFAULT_INK_OPTIONS);
  check('blank paper is reported as "no ink", not as an image', !onBlank.ok);

  const dark = makeFrame(60, 30, () => [18, 18, 20]);
  const onDark = extractInk(dark.pixels, dark.width, dark.height, DEFAULT_INK_OPTIONS);
  check('an unusable (all-dark) photo is refused rather than extracted', !onDark.ok);

  /* ------------------------------------------------------------------ */
  /* 5. Sliders do what they claim                                       */
  /* ------------------------------------------------------------------ */
  const faint = makeFrame(120, 40, (x, y) =>
    strokeBand(18, 3)(x, y) ? [150, 150, 150] : [230, 230, 230],
  );
  const keepFaint = extractInk(faint.pixels, faint.width, faint.height, {
    ...DEFAULT_INK_OPTIONS,
    threshold: 85,
  });
  const dropFaint = extractInk(faint.pixels, faint.width, faint.height, {
    ...DEFAULT_INK_OPTIONS,
    threshold: 5,
  });
  const keepAlpha = alphaAt(faint, keepFaint.rgba, 60, 19);
  const dropAlpha = alphaAt(faint, dropFaint.rgba, 60, 19);
  check(
    'raising the threshold keeps more of a faint stroke',
    keepAlpha > dropAlpha,
    `high=${keepAlpha} low=${dropAlpha}`,
  );
  check(
    'the alpha ramp widens with edge softness',
    alphaThresholds({ threshold: 50, edge: 100 }).high >
      alphaThresholds({ threshold: 50, edge: 0 }).high,
  );
  check(
    'a bigger paper-flattening window is used on a wider photo',
    backgroundRadius(10, 1200) < backgroundRadius(90, 1200),
  );

  /* ------------------------------------------------------------------ */
  /* 6. Despeckle: a lone pixel disappears, a stroke does not            */
  /* ------------------------------------------------------------------ */
  const speckled = makeFrame(60, 30, (x, y) => {
    if (x === 7 && y === 7) return [20, 20, 20];
    return strokeBand(20, 3)(x, y) ? [25, 25, 28] : [235, 235, 235];
  });
  const despeckled = extractInk(speckled.pixels, speckled.width, speckled.height, {
    ...DEFAULT_INK_OPTIONS,
    despeckle: 100,
  });
  check('an isolated dust speck is removed', alphaAt(speckled, despeckled.rgba, 7, 7) === 0);
  check('the stroke survives despeckling', alphaAt(speckled, despeckled.rgba, 30, 21) > 150);

  /* ------------------------------------------------------------------ */
  /* 7. Crop maths                                                       */
  /* ------------------------------------------------------------------ */
  const cropped = cropPixels({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, 400, 200);
  check(
    'a fractional crop maps onto pixels',
    cropped.x === 100 && cropped.y === 100 && cropped.width === 200 && cropped.height === 50,
    JSON.stringify(cropped),
  );
  check(
    'a crop cannot exceed the frame',
    (() => {
      const edge = cropPixels({ x: 0.9, y: 0.9, width: 0.9, height: 0.9 }, 100, 100);
      return edge.x + edge.width <= 100 && edge.y + edge.height <= 100;
    })(),
  );
  const padded = padBounds({ x: 10, y: 10, width: 20, height: 20 }, 100, 100);
  check(
    'padding grows the box and clamps to the frame',
    padded.x < 10 && padded.y < 10 && padded.x + padded.width <= 100,
    JSON.stringify(padded),
  );
  check(
    'padding at the edge never produces negative coordinates',
    padBounds({ x: 0, y: 0, width: 4, height: 4 }, 100, 100).x === 0,
  );

  /* ------------------------------------------------------------------ */
  /* 8. Local processing + wiring (source assertions)                    */
  /* ------------------------------------------------------------------ */
  const extractorSource = source('ReportCard Studio/src/services/signatureExtractor.ts');
  check(
    'extraction never uploads the signature to a server',
    !/\bfetch\s*\(/.test(extractorSource) &&
      !/XMLHttpRequest/.test(extractorSource) &&
      !/https?:\/\/(?!esm\.sh)/.test(extractorSource.replace(/\/\*\*[\s\S]*?\*\//g, '')),
  );
  check(
    'the result is exported as a transparent PNG',
    /toDataURL\('image\/png'\)/.test(extractorSource),
  );

  const profileSource = source('ReportCard Studio/src/pages/SchoolProfile.tsx');
  check(
    'signature and stamp uploads open the extraction dialog',
    /signatureExtractor/.test(profileSource) === false &&
      profileSource.includes('SignatureExtractorDialog') &&
      profileSource.includes('onKeepOriginal'),
  );
  check(
    'all four signature/stamp fields are listed for extraction',
    ['principalSignDataUrl', 'teacherSignDataUrl', 'checkedBySignDataUrl', 'stampDataUrl'].every(
      (field) => profileSource.includes(field),
    ),
  );

  const dialogSource = source('ReportCard Studio/src/components/SignatureExtractorDialog.tsx');
  check(
    'the dialog previews before applying, and can keep the original',
    dialogSource.includes('Use original photo') && dialogSource.includes('Apply extracted'),
  );
  check(
    'the dialog exposes threshold, crop and rotation controls',
    dialogSource.includes('Ink threshold') &&
      dialogSource.includes('Paper flattening') &&
      dialogSource.includes('Fine rotation') &&
      dialogSource.includes('beginDrag'),
  );

  const kitSource = source('ReportCard Studio/src/services/pdf/pdfKit.ts');
  check(
    'the PDF keeps PNG transparency and fits the image instead of stretching it',
    kitSource.includes('imageFormatFromDataUrl') &&
      kitSource.includes('drawImageContained') &&
      /drawImageContained\(doc, image/.test(kitSource),
  );
  check(
    'a JPEG signature is no longer forced through the PNG decoder',
    !/doc\.addImage\(image, 'PNG'/.test(kitSource) && !/doc\.addImage\(stamp, 'PNG'/.test(kitSource),
  );

  const academicSource = source('ReportCard Studio/src/services/pdf/academicLayout.ts');
  check(
    'the modern card uses the same fitted drawing path',
    academicSource.includes('drawImageContained') &&
      !/doc\.addImage\(spec\.(image|stamp), 'PNG'/.test(academicSource),
  );
};

runTests();

console.log(`\ncheck-signature-extraction: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
