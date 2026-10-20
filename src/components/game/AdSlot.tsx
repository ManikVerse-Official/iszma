/**
 * Advertising integration point.
 *
 * Ishmaverse has NO ad provider connected, and this component refuses to
 * pretend otherwise: unless a provider is explicitly configured it renders
 * NOTHING — no empty box, no "Sponsored" label, no third-party script, and
 * certainly no estimated impressions or revenue.
 *
 * Wiring a real provider later means two things only:
 *   1. set the public, non-secret site/slot ids in the environment
 *      (VITE_ADS_PROVIDER, VITE_ADS_SLOT), and
 *   2. render that provider's own markup inside the single branch below.
 *
 * Anything secret (account tokens, report API keys) must live in Supabase Edge
 * secrets and be read server-side. A frontend bundle can never hold it, so
 * revenue reporting has to come from the provider's own API through an Edge
 * Function — never from numbers typed into this file.
 */

export interface AdSlotProps {
  /** Where the slot sits, for the provider's own reporting. */
  placement: 'lobby' | 'result';
  className?: string;
}

export const AdSlot: React.FC<AdSlotProps> = ({ placement, className }) => {
  const provider = (import.meta.env.VITE_ADS_PROVIDER as string | undefined)?.trim();
  const slot = (import.meta.env.VITE_ADS_SLOT as string | undefined)?.trim();

  // Fail closed. No provider ⇒ nothing is rendered and nothing is requested.
  if (!provider || !slot) return null;

  return (
    <div
      data-ad-provider={provider}
      data-ad-slot={slot}
      data-ad-placement={placement}
      className={className}
      aria-hidden="true"
    >
      {/* The provider's own markup belongs here. It is only ever reached once a
          real provider is configured, so it can never ship as dead scaffolding. */}
    </div>
  );
};

/** True when a real ad provider is configured. Used to label the admin panel. */
export const isAdProviderConfigured = (): boolean => {
  const provider = (import.meta.env.VITE_ADS_PROVIDER as string | undefined)?.trim();
  const slot = (import.meta.env.VITE_ADS_SLOT as string | undefined)?.trim();
  return Boolean(provider && slot);
};
