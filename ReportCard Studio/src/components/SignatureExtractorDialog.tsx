import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Crop, Eraser, RotateCcw, RotateCw, Sparkles, X } from 'lucide-react';
import {
  DEFAULT_INK_OPTIONS,
  FULL_CROP,
  cropPixels,
  decodeImageFile,
  extractSignaturePng,
  readFileAsDataUrl,
  rotateCanvas,
  type CropRect,
  type InkExtractionOptions,
} from '../services/signatureExtractor';

/**
 * Signature / stamp extraction dialog.
 *
 * Shown right after a signature or stamp photo is chosen. The photo never leaves
 * the browser: it is decoded, the paper is removed locally, and the user sees the
 * result BEFORE anything is stored on the school profile.
 *
 * Every control exists because automatic extraction can be imperfect on a real
 * phone photo:
 *   • the ink threshold keeps faint pencil or drops paper shading,
 *   • paper flattening widens the local-background window (useful for a sheet
 *     with a big shadow across one corner),
 *   • the crop box is draggable, so a second signature or a corner of printed
 *     text in the same picture can be excluded,
 *   • quarter turns and a fine-angle slider fix a slightly rotated photo,
 *   • and if the extraction cannot find usable ink the dialog says so and offers
 *     the ORIGINAL image instead — a signature is never destroyed or redrawn.
 */

type InkMode = InkExtractionOptions['ink'];

const CHECKERBOARD: React.CSSProperties = {
  backgroundColor: '#ffffff',
  backgroundImage:
    'linear-gradient(45deg, #e2e8f0 25%, transparent 25%), linear-gradient(-45deg, #e2e8f0 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e2e8f0 75%), linear-gradient(-45deg, transparent 75%, #e2e8f0 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
};

export interface SignatureExtractorDialogProps {
  open: boolean;
  /** Only changes the wording — the processing is identical. */
  kind: 'signature' | 'stamp';
  label: string;
  file: File | null;
  onCancel: () => void;
  /** Applies the extracted transparent PNG. */
  onApply: (dataUrl: string) => void;
  /** Fallback: keep the untouched photo because extraction is not usable. */
  onKeepOriginal: (dataUrl: string) => void;
}

export default function SignatureExtractorDialog({
  open,
  kind,
  label,
  file,
  onCancel,
  onApply,
  onKeepOriginal,
}: SignatureExtractorDialogProps) {
  const [originalUrl, setOriginalUrl] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [decoded, setDecoded] = useState<HTMLCanvasElement | null>(null);
  const [source, setSource] = useState<HTMLCanvasElement | null>(null);
  const [quarterTurns, setQuarterTurns] = useState(0);
  const [fineAngle, setFineAngle] = useState(0);
  const [options, setOptions] = useState<InkExtractionOptions>(DEFAULT_INK_OPTIONS);
  const [crop, setCrop] = useState<CropRect>(FULL_CROP);
  const [result, setResult] = useState<{
    ok: boolean;
    reason?: string;
    dataUrl?: string;
    width: number;
    height: number;
    coverage: number;
  } | null>(null);
  const [showOriginalPreview, setShowOriginalPreview] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const overlayRef = useRef<HTMLDivElement | null>(null);

  /* ── decode the photo (and re-decode when it is rotated) ──────────────── */
  useEffect(() => {
    if (!open || !file) return;
    let active = true;
    setLoading(true);
    setError('');
    setQuarterTurns(0);
    setFineAngle(0);
    setCrop(FULL_CROP);
    setOptions(DEFAULT_INK_OPTIONS);
    setShowOriginalPreview(false);

    void readFileAsDataUrl(file)
      .then((url) => {
        if (active) setOriginalUrl(url);
      })
      .catch(() => {
        if (active) setOriginalUrl('');
      });
    return () => {
      active = false;
    };
  }, [open, file]);

  useEffect(() => {
    if (!open || !file) {
      setDecoded(null);
      setSource(null);
      setSourceUrl('');
      return;
    }
    let active = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void decodeImageFile(file, quarterTurns)
        .then((image) => {
          if (!active) return;
          setDecoded(image.canvas);
          setLoading(false);
        })
        .catch(() => {
          if (!active) return;
          setDecoded(null);
          setSource(null);
          setSourceUrl('');
          setLoading(false);
          setError('That file could not be decoded. Please use a JPG, JPEG or PNG photo.');
        });
    }, 120);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [open, file, quarterTurns]);

  /* Straightening is applied on the already-decoded canvas, so dragging the
   * fine-angle slider never re-reads the original file. */
  useEffect(() => {
    if (!decoded) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const straightened = rotateCanvas(decoded, fineAngle);
      if (!active) return;
      setSource(straightened);
      setSourceUrl(straightened.toDataURL('image/png'));
    }, 140);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [decoded, fineAngle]);

  /* ── extract (debounced so dragging a slider stays smooth) ────────────── */
  useEffect(() => {
    if (!open || !source) return;
    const timer = window.setTimeout(() => {
      const output = extractSignaturePng({ source, options, crop });
      setResult(output);
    }, 90);
    return () => window.clearTimeout(timer);
  }, [open, source, options, crop]);

  const cropPreview = useMemo(
    () => (source ? cropPixels(crop, source.width, source.height) : null),
    [source, crop],
  );

  /* ── crop box dragging ────────────────────────────────────────────────── */
  const dragRef = useRef<{
    mode: 'move' | 'nw' | 'ne' | 'sw' | 'se';
    startX: number;
    startY: number;
    start: CropRect;
    rect: DOMRect;
  } | null>(null);

  const beginDrag = (mode: 'move' | 'nw' | 'ne' | 'sw' | 'se') => (event: React.PointerEvent) => {
    const container = overlayRef.current;
    if (!container) return;
    event.preventDefault();
    event.stopPropagation();
    (event.target as HTMLElement).setPointerCapture?.(event.pointerId);
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      start: crop,
      rect: container.getBoundingClientRect(),
    };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.rect.width === 0 || drag.rect.height === 0) return;
    const dx = (event.clientX - drag.startX) / drag.rect.width;
    const dy = (event.clientY - drag.startY) / drag.rect.height;
    const min = 0.06;

    const next: CropRect = { ...drag.start };
    if (drag.mode === 'move') {
      next.x = Math.min(Math.max(0, drag.start.x + dx), 1 - drag.start.width);
      next.y = Math.min(Math.max(0, drag.start.y + dy), 1 - drag.start.height);
    } else {
      let left = drag.start.x;
      let top = drag.start.y;
      let right = drag.start.x + drag.start.width;
      let bottom = drag.start.y + drag.start.height;
      if (drag.mode === 'nw' || drag.mode === 'sw') left = Math.min(Math.max(0, left + dx), right - min);
      if (drag.mode === 'ne' || drag.mode === 'se') right = Math.max(Math.min(1, right + dx), left + min);
      if (drag.mode === 'nw' || drag.mode === 'ne') top = Math.min(Math.max(0, top + dy), bottom - min);
      if (drag.mode === 'sw' || drag.mode === 'se') bottom = Math.max(Math.min(1, bottom + dy), top + min);
      next.x = left;
      next.y = top;
      next.width = right - left;
      next.height = bottom - top;
    }
    setCrop(next);
  };

  const endDrag = () => {
    dragRef.current = null;
  };

  const applyExtracted = useCallback(() => {
    if (result?.ok && result.dataUrl) onApply(result.dataUrl);
  }, [onApply, result]);

  if (!open || !file) return null;

  const noun = kind === 'stamp' ? 'stamp' : 'signature';

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-3 py-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${label} — remove the photo background`}
    >
      <div className="relative w-full max-w-5xl bg-white rounded-2xl shadow-card">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-ink-900 flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-brand-600" />
              Clean up the {noun} — {label}
            </h3>
            <p className="text-xs text-ink-500 mt-1">
              The paper, shadows and background are removed in this browser. Your photo is never
              uploaded. Only the ink is kept, at its original shape.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="text-ink-400 hover:text-ink-700 shrink-0"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 px-5 py-4">
          {/* ── source + crop ─────────────────────────────────────────── */}
          <div className="lg:col-span-2 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                Original photo — drag the box to crop
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="btn-ghost !py-1 !px-2 text-xs"
                  onClick={() => setQuarterTurns((value) => value - 90)}
                  title="Rotate a quarter turn anticlockwise"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="btn-ghost !py-1 !px-2 text-xs"
                  onClick={() => setQuarterTurns((value) => value + 90)}
                  title="Rotate a quarter turn clockwise"
                >
                  <RotateCw className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="btn-ghost !py-1 !px-2 text-xs"
                  onClick={() => setCrop(FULL_CROP)}
                  title="Use the whole photo"
                >
                  <Crop className="h-3.5 w-3.5" /> Full
                </button>
              </div>
            </div>

            <div
              ref={overlayRef}
              className="relative select-none rounded-xl border border-slate-200 bg-slate-100 overflow-hidden touch-none"
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              {sourceUrl ? (
                <img src={sourceUrl} alt={`${label} photo`} className="block w-full" draggable={false} />
              ) : (
                <div className="h-64 flex items-center justify-center text-sm text-ink-500">
                  {loading ? 'Reading the photo…' : 'No preview'}
                </div>
              )}

              {sourceUrl && (
                <div
                  className="absolute border-2 border-brand-500 shadow-[0_0_0_9999px_rgba(15,23,42,0.45)] cursor-move"
                  style={{
                    left: `${crop.x * 100}%`,
                    top: `${crop.y * 100}%`,
                    width: `${crop.width * 100}%`,
                    height: `${crop.height * 100}%`,
                  }}
                  onPointerDown={beginDrag('move')}
                >
                  {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                    <span
                      key={corner}
                      onPointerDown={beginDrag(corner)}
                      className="absolute h-4 w-4 rounded-sm bg-brand-600 border border-white cursor-pointer"
                      style={{
                        left: corner === 'nw' || corner === 'sw' ? -8 : undefined,
                        right: corner === 'ne' || corner === 'se' ? -8 : undefined,
                        top: corner === 'nw' || corner === 'ne' ? -8 : undefined,
                        bottom: corner === 'sw' || corner === 'se' ? -8 : undefined,
                        cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
                      }}
                    />
                  ))}
                </div>
              )}
            </div>

            <p className="text-xs text-ink-500">
              {cropPreview
                ? `Analysing ${cropPreview.width} × ${cropPreview.height} px of the photo.`
                : 'Waiting for the photo…'}
            </p>

            {originalUrl && showOriginalPreview && (
              <div className="rounded-xl border border-slate-200 p-3">
                <p className="text-xs font-semibold text-ink-600 mb-2">Original (untouched)</p>
                <img src={originalUrl} alt="original" className="max-h-40 object-contain" />
              </div>
            )}
          </div>

          {/* ── controls ──────────────────────────────────────────────── */}
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-500">
                  Extracted {noun} — transparent PNG
                </span>
              </div>
              <div
                className="rounded-xl border border-slate-200 h-40 flex items-center justify-center p-2"
                style={CHECKERBOARD}
              >
                {result?.ok && result.dataUrl ? (
                  <img src={result.dataUrl} alt={`extracted ${noun}`} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="text-xs text-center text-ink-600 px-2">
                    {loading ? 'Working…' : result?.reason ?? 'No ink detected yet.'}
                  </span>
                )}
              </div>
            </div>

            <Slider
              label="Ink threshold"
              hint="Left = only solid strokes. Right = also keep faint pencil."
              value={options.threshold}
              onChange={(threshold) => setOptions((current) => ({ ...current, threshold }))}
            />
            <Slider
              label="Edge softness"
              hint="Higher keeps the natural anti-aliased edge of the strokes."
              value={options.edge}
              onChange={(edge) => setOptions((current) => ({ ...current, edge }))}
            />
            <Slider
              label="Paper flattening"
              hint="Higher removes bigger patches of shading and grey paper."
              value={options.background}
              onChange={(background) => setOptions((current) => ({ ...current, background }))}
            />
            <Slider
              label="Speckle removal"
              hint="Deletes dust and JPEG noise that is not part of the ink."
              value={options.despeckle}
              onChange={(despeckle) => setOptions((current) => ({ ...current, despeckle }))}
            />

            <div>
              <label className="label" htmlFor="ink-mode">
                Ink type
              </label>
              <select
                id="ink-mode"
                className="input"
                value={options.ink}
                onChange={(e) => setOptions((current) => ({ ...current, ink: e.target.value as InkMode }))}
              >
                <option value="auto">Auto (black or coloured ink)</option>
                <option value="dark">Dark ink only</option>
                <option value="colour">Coloured ink / stamp only</option>
              </select>
            </div>

            <Slider
              label="Fine rotation"
              hint="Straighten a slightly tilted photo."
              min={-30}
              max={30}
              value={fineAngle}
              onChange={setFineAngle}
            />

            {error && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </p>
            )}

            {result && !result.ok && (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                <p className="font-semibold">Automatic removal did not work on this photo.</p>
                <p className="mt-1">
                  Your original {noun} is untouched. Adjust the sliders or the crop, or keep the
                  original photo and place it manually.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-5 py-4">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setShowOriginalPreview((value) => !value)}
          >
            <Eraser className="h-3.5 w-3.5" />
            {showOriginalPreview ? 'Hide original' : 'Compare with original'}
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onCancel} className="btn-secondary">
              Cancel
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={!originalUrl}
              onClick={() => onKeepOriginal(originalUrl)}
              title="Keep the photo exactly as it was taken"
            >
              Use original photo
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!result?.ok || !result.dataUrl}
              onClick={applyExtracted}
            >
              <Check className="h-4 w-4" />
              Apply extracted {noun}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  onChange,
  min = 0,
  max = 100,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-ink-700">{label}</span>
        <span className="text-[11px] tabular-nums text-ink-500">{Math.round(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-brand-600"
      />
      {hint && <p className="text-[11px] text-ink-500 leading-snug">{hint}</p>}
    </div>
  );
}
