import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A4 is 210mm wide — wider than any phone. Instead of forcing the user to
 * scroll sideways, the preview is scaled down to the available width while
 * keeping the exact A4 proportions (the PDF is unaffected).
 */
const A4_WIDTH_PX = (210 / 25.4) * 96; // 210mm at 96dpi ≈ 793.7px

export default function ReportCardScaler({ children }: { children: ReactNode }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [naturalHeight, setNaturalHeight] = useState(0);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    /*
     * The scaled wrapper is sized from its CONTENT, so the content must be
     * measured — never the wrapper.
     *
     * The wrapper's own `offsetHeight` is the value this component sets (scale ×
     * natural height). Measuring it therefore returns 0/1px on the very first
     * pass, which used to freeze the wrapper at a sub-pixel height: the card was
     * then clipped away by the frame's `overflow-hidden` and the whole preview
     * collapsed to a thin strip with the space beneath it left blank. Reading the
     * card (`scrollHeight` keeps working even while the box is clipped) and
     * re-measuring when IT resizes fixes that.
     */
    const measure = () => {
      const available = element.clientWidth;
      if (available <= 0) return;
      setScale(Math.min(1, available / A4_WIDTH_PX));
      const wrapper = element.firstElementChild as HTMLElement | null;
      if (!wrapper) return;
      const card = (wrapper.firstElementChild as HTMLElement | null) ?? wrapper;
      const measured = Math.max(card.offsetHeight, card.scrollHeight, wrapper.scrollHeight);
      if (measured > 0) setNaturalHeight(measured);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    const wrapper = element.firstElementChild as HTMLElement | null;
    const card = (wrapper?.firstElementChild as HTMLElement | null) ?? null;
    if (wrapper) observer.observe(wrapper);
    if (card) observer.observe(card);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [children]);

  useEffect(() => {
    if (naturalHeight > 0) setHeight(naturalHeight * scale);
  }, [naturalHeight, scale]);

  return (
    <div ref={containerRef} className="w-full overflow-hidden">
      <div
        style={{
          width: '210mm',
          transform: `scale(${scale})`,
          transformOrigin: 'top left',
          height,
        }}
      >
        {children}
      </div>
    </div>
  );
}
