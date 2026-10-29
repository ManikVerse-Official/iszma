/**
 * Site-wide decorative watermark.
 *
 * Uses the supplied handwritten stamp exactly as provided (`/logos/iszma-stamp-logo.png`)
 * as a repeating texture, tinted lavender and kept at ~8% opacity. It sits at a
 * negative z-index inside an isolated page root, so it paints above the page's
 * dark gradient but BEHIND all content and behind the sticky navigation.
 *
 * Safety properties:
 *   • `pointer-events-none` — it can never intercept a click, tap or scroll;
 *   • `aria-hidden` — never announced by a screen reader;
 *   • `overflow-hidden` and a fixed layer — cannot create horizontal scroll;
 *   • no animation, one small cached image request (repeated by CSS).
 *
 * The parent element must create a stacking context (add `relative isolate` to
 * the page root) for the negative z-index to stay behind the content.
 */
export const IsZmaWatermarkBg: React.FC = () => (
  <div
    aria-hidden="true"
    className="pointer-events-none fixed inset-0 -z-10 select-none overflow-hidden"
  >
    <div
      className="absolute inset-0"
      style={{
        backgroundImage: "url('/logos/iszma-stamp-logo.png')",
        backgroundRepeat: 'repeat',
        backgroundPosition: 'center',
        backgroundSize: 'clamp(190px, 20vw, 320px) auto',
        opacity: 0.08,
        /*
         * The supplied stamp is dark navy. Invert + tint turns the same artwork
         * into a lavender mark that reads on the dark theme without editing the
         * original file. Browsers that ignore the filter still show the faint
         * untinted texture, never a solid block.
         */
        filter: 'invert(1) sepia(1) saturate(5) hue-rotate(215deg)',
      }}
    />
  </div>
);

export default IsZmaWatermarkBg;
