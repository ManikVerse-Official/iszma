import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { supabase, isSupabaseConfigured, supportsRealtime } from '../services/supabase';
import { SiteSettings } from '../types';

const DEFAULT_LOGO = '/logos/iszma-primary-logo.png';

const defaultBrand: SiteSettings = {
  id: 'default',
  site_name: 'isZma',
  brand_tagline: 'Create moments that matter.',
  logo_url: DEFAULT_LOGO,
  primary_color: '#8b5cf6',
  secondary_color: '#1a0b2e',
  accept_custom_orders: true,
  unavailable_days: 0,
  minimum_budget_threshold: 1000,
  admin_notification_webhook: '',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

interface BrandContextType {
  brand: SiteSettings;
  loading: boolean;
  refreshBrand: () => Promise<void>;
}

/**
 * Display migration for rows written before the rebrand.
 *
 * `site_settings` is production data and is deliberately not rewritten here.
 * When the stored values are still the old brand, the UI shows the current brand
 * instead; an admin who has set a genuinely different custom name keeps it.
 */
const LEGACY_SITE_NAME = /^ishmaverse(\s+(digital\s+)?ecosystem)?$/i;
const LEGACY_TAGLINE = /^ishmaverse(\s+(digital\s+)?ecosystem)?$/i;
/* The previous default tagline; the current tagline replaces it on display. */
const PREVIOUS_DEFAULT_TAGLINE = /^the\s+digital\s+mall$/i;
const LEGACY_LOGO = /(^|\/)ishmaverse\.png($|\?)/i;

const withCurrentBrand = (data: SiteSettings): SiteSettings => {
  const siteName = (data.site_name ?? '').trim();
  const tagline = (data.brand_tagline ?? '').trim();
  const logo = (data.logo_url ?? '').trim();

  return {
    ...defaultBrand,
    ...data,
    site_name: !siteName || LEGACY_SITE_NAME.test(siteName) ? defaultBrand.site_name : siteName,
    brand_tagline:
      !tagline || LEGACY_TAGLINE.test(tagline) || PREVIOUS_DEFAULT_TAGLINE.test(tagline)
        ? defaultBrand.brand_tagline
        : tagline,
    logo_url: !logo || LEGACY_LOGO.test(logo) ? DEFAULT_LOGO : logo,
  };
};

const BrandContext = createContext<BrandContextType | undefined>(undefined);

export const BrandProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [brand, setBrand] = useState<SiteSettings>(defaultBrand);
  const [loading, setLoading] = useState(false);

  const fetchBrand = async (): Promise<void> => {
    if (!isSupabaseConfigured()) {
      setBrand(defaultBrand);
      setLoading(false);
      return;
    }

    setLoading(true);

    try {
      const { data, error } = await supabase
        .from('site_settings')
        .select('*')
        .limit(1)
        .single();

      if (!error && data) {
        setBrand(withCurrentBrand(data as SiteSettings));
      } else {
        setBrand(defaultBrand);
      }
    } catch {
      // Keep the application usable with local/default branding.
      setBrand(defaultBrand);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    let subscription: ReturnType<typeof supabase.channel> | null = null;

    const initialize = async () => {
      if (!mounted) return;
      await fetchBrand();
    };

    initialize();

    if (isSupabaseConfigured() && supportsRealtime()) {
      try {
        subscription = supabase
          .channel('site_settings_changes')
          .on(
            'postgres_changes',
            {
              event: '*',
              schema: 'public',
              table: 'site_settings',
            },
            () => {
              if (mounted) {
                fetchBrand();
              }
            }
          )
          .subscribe();
      } catch {
        // Realtime is optional; the app works without it.
      }
    }

    return () => {
      mounted = false;

      if (subscription) {
        try {
          subscription.unsubscribe();
        } catch {
          // Ignore cleanup errors.
        }
      }
    };
  }, []);

  return (
    <BrandContext.Provider
      value={{
        brand,
        loading,
        refreshBrand: fetchBrand,
      }}
    >
      {children}
    </BrandContext.Provider>
  );
};

export const useBrand = () => {
  const context = useContext(BrandContext);

  if (context === undefined) {
    throw new Error('useBrand must be used within a BrandProvider');
  }

  return context;
};
