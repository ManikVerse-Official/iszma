import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { supabase, isSupabaseConfigured, supportsRealtime } from '../services/supabase';
import { SiteSettings } from '../types';

const DEFAULT_LOGO = '/ishmaverse.png';

const defaultBrand: SiteSettings = {
  id: 'default',
  site_name: 'Ishmaverse',
  brand_tagline: 'Ishmaverse Ecosystem',
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
        const safeBrand: SiteSettings = {
          ...defaultBrand,
          ...data,
          logo_url:
            typeof data.logo_url === 'string' && data.logo_url.trim()
              ? data.logo_url.trim()
              : DEFAULT_LOGO,
        };

        setBrand(safeBrand);
        document.title = safeBrand.site_name || 'Ishmaverse';
      } else {
        setBrand(defaultBrand);
        document.title = defaultBrand.site_name;
      }
    } catch {
      // Keep the application usable with local/default branding.
      setBrand(defaultBrand);
      document.title = defaultBrand.site_name;
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
