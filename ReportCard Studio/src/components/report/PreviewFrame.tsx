import { useEffect, useState, type ReactNode } from 'react';
import { Maximize2, X } from 'lucide-react';
import ReportCardScaler from './ReportCardScaler';

/**
 * The viewport the report card is previewed in.
 *
 * On a phone the A4 card is far wider than the screen, so `ReportCardScaler`
 * shrinks it to fit rather than making the page scroll sideways. Shrinking is
 * fine for a glance but too small to read the detail, so the same frame also
 * offers an explicit **Expand preview** control: the card is shown in a
 * full-screen overlay, still scaled to the screen width, and the page behind it
 * scrolls normally. The PDF is untouched by any of this — it is always A4.
 */
export default function PreviewFrame({
  children,
  title = 'Report card preview',
  caption,
}: {
  children: ReactNode;
  title?: string;
  caption?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  /* Escape closes the overlay, and the page behind it must not scroll. */
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [expanded]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2 no-print">
        {caption ? <div className="text-xs text-ink-500 min-w-0">{caption}</div> : <span />}
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="btn-secondary !py-1 !px-3 text-xs shrink-0"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Expand preview
        </button>
      </div>

      <div className="rounded-lg border border-slate-200 bg-slate-50 p-1.5 sm:p-2 overflow-x-hidden">
        <ReportCardScaler>{children}</ReportCardScaler>
      </div>

      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-slate-900/80 overflow-y-auto overscroll-contain no-print"
          role="dialog"
          aria-modal="true"
          aria-label={title}
        >
          <div className="min-h-full p-2 sm:p-6">
            <div className="max-w-4xl mx-auto bg-white rounded-xl shadow-card p-2 sm:p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <span className="text-sm font-semibold text-ink-900 min-w-0 rc-wrap">{title}</span>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="shrink-0 inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-ink-700 hover:bg-slate-50"
                >
                  <X className="h-3.5 w-3.5" /> Close
                </button>
              </div>
              {/* Scroll through the complete card; the page never scrolls sideways. */}
              <div className="overflow-x-hidden">
                <ReportCardScaler>{children}</ReportCardScaler>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
