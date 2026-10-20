import { GreetingTheme, GreetingTier, Product } from '../types';
import { buildDesignForTier, greetingThemes, sortFreeThemeFirst } from '../data/greetingThemes';
import { defaultProducts } from '../data/products';
import { isSupabaseConfigured, supabase } from './supabase';

/**
 * The dynamic catalog.
 *
 * Everything the storefront shows — greeting themes and store products — is
 * driven by this store, so the Admin Panel can change any price, edit any item
 * or add/remove products and have it reflected immediately.
 *
 * Persistence strategy:
 *   • localStorage always (works with zero backend config).
 *   • Supabase `products` table when a real project is configured (best-effort;
 *     failures never break the UI).
 *
 * Theme edits are stored as *patches* over the built-in catalog so future code
 * updates to the shipped themes keep working without discarding admin changes.
 */

export type ThemePatch = Partial<Omit<GreetingTheme, 'id'>>;

export interface CustomThemeInput {
  name: string;
  tagline: string;
  category_id: string;
  tier: GreetingTier;
  price: number;
  price_usd: number;
  emoji: string;
  accent: string;
  gradient: string;
  animation: GreetingTheme['animation'];
  tags: string[];
  artwork_url?: string;
}

export interface CatalogState {
  version: 1;
  themePatches: Record<string, ThemePatch>;
  customThemes: GreetingTheme[];
  deletedThemeIds: string[];
  products: Product[];
  /**
   * Epoch ms of the last local admin price edit per theme id.
   *
   * Used to order the local edit against the server row: an edit made after the
   * `theme_prices` row was written must never be reverted by a later sync (for
   * example when the server write is rejected or has not landed yet).
   */
  priceEditedAt: Record<string, number>;
  /** Epoch ms of the last local admin edit per product id (same purpose). */
  productEditedAt: Record<string, number>;
}

const STORAGE_KEY = 'ishmaverse_catalog_v1';

export const createInitialCatalogState = (): CatalogState => ({
  version: 1,
  themePatches: {},
  customThemes: [],
  deletedThemeIds: [],
  products: defaultProducts,
  priceEditedAt: {},
  productEditedAt: {},
});

/**
 * Fallback USD price when one has not been set explicitly: a rough conversion
 * rounded to 2 decimals. Admins can override it per item.
 *
 * A genuinely FREE item (INR 0 with no positive USD override) stays free — it
 * must never be floored up to $1, otherwise the free Welcome Card would show a
 * $1 price to international visitors.
 */
export const deriveUsdPrice = (inr: number, usd?: number): number => {
  if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) return usd;
  const base = Number(inr) || 0;
  if (base <= 0) return 0;
  return Math.max(1, Math.round((base / 85) * 100) / 100);
};

/** Cleans a product row from Supabase/localStorage into the app shape. */
export const normalizeProduct = (raw: Partial<Product> & { id: string }): Product => {
  const price = Number(raw.price_inr ?? raw.price ?? 0) || 0;
  return {
    id: raw.id,
    category_id: raw.category_id ?? '1',
    name: raw.name ?? 'Untitled product',
    description: raw.description ?? '',
    price,
    price_inr: price,
    price_usd: deriveUsdPrice(price, raw.price_usd),
    currency: raw.currency ?? 'INR',
    product_file_url: raw.product_file_url ?? raw.download_url ?? '',
    download_url: raw.download_url ?? raw.product_file_url ?? '',
    image_url: raw.image_url ?? '',
    created_at: raw.created_at ?? new Date().toISOString(),
    updated_at: raw.updated_at ?? new Date().toISOString(),
  };
};

export const loadCatalogState = (): CatalogState => {
  if (typeof localStorage === 'undefined') return createInitialCatalogState();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialCatalogState();
    const parsed = JSON.parse(raw) as Partial<CatalogState>;
    return {
      version: 1,
      themePatches: parsed.themePatches ?? {},
      customThemes: parsed.customThemes ?? [],
      deletedThemeIds: parsed.deletedThemeIds ?? [],
      products: (parsed.products ?? defaultProducts).map((p) => normalizeProduct(p)),
      priceEditedAt: parsed.priceEditedAt ?? {},
      productEditedAt: parsed.productEditedAt ?? {},
    };
  } catch {
    return createInitialCatalogState();
  }
};

export const persistCatalogState = (state: CatalogState): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage full or unavailable — the in-memory catalog still works */
  }
};

/* ------------------------------------------------------------------ */
/* Themes                                                              */
/* ------------------------------------------------------------------ */

/** Merges built-in themes with admin patches, removals and custom themes. */
export const applyThemePatches = (state: CatalogState): GreetingTheme[] => {
  const deleted = new Set(state.deletedThemeIds);

  const builtIn = greetingThemes
    .filter((theme) => !deleted.has(theme.id))
    .map((theme) => ({ ...theme, ...state.themePatches[theme.id] }));

  const custom = state.customThemes.filter((theme) => !deleted.has(theme.id));

  // Older saved themes predate the USD field, so make sure every theme always
  // has a usable price_usd (falling back to a conversion of the INR price).
  const normalized = [...builtIn, ...custom].map((theme) => ({
    ...theme,
    price_usd: deriveUsdPrice(theme.price, theme.price_usd),
  }));

  // The free welcome card always leads the storefront — even after custom themes
  // are added or a remote catalog sync reorders the list.
  return sortFreeThemeFirst(normalized);
};

/* ------------------------------------------------------------------ */
/* Remote → local merge                                                */
/* ------------------------------------------------------------------ */

/** A price row as returned by the remote `theme_prices` table. */
export interface RemoteThemePrice {
  price: number;
  price_usd: number;
  /** Epoch ms of the server row's `updated_at`, when known. */
  updatedAt?: number;
}

/** Everything the remote catalog can hand back in one sync pass. */
export interface RemoteCatalogSnapshot {
  products: Product[] | null;
  themePrices: Record<string, RemoteThemePrice> | null;
  themeCatalog: {
    overrides: Record<string, RemoteThemeOverride>;
    customThemes: GreetingTheme[];
  } | null;
}

/**
 * True when a local admin edit is newer than the server row it would replace.
 *
 * A missing local timestamp means "never edited here", so the server wins. A
 * missing remote timestamp is treated as older than any local edit: the server
 * cannot prove it is newer, and losing an admin's change is worse than showing
 * a value the server has not caught up with yet.
 */
export const localEditWins = (
  localEditedAt: number | undefined,
  remoteUpdatedAt: number | undefined,
): boolean => {
  if (!localEditedAt) return false;
  if (!remoteUpdatedAt) return true;
  return localEditedAt > remoteUpdatedAt;
};

/**
 * Merges a remote snapshot into the local catalog.
 *
 * This is the fix for "the price reverts when I reload": remote theme prices and
 * products no longer blindly overwrite the admin's own edits. A local edit made
 * *after* the server row survives, while anything edited elsewhere (or never
 * touched locally) still comes from the server — so the storefront and the
 * payment functions keep agreeing on the price.
 */
export const mergeRemoteCatalog = (
  prev: CatalogState,
  remote: RemoteCatalogSnapshot,
): CatalogState => {
  const next: CatalogState = { ...prev };
  const themePatches = { ...prev.themePatches };

  if (remote.themeCatalog) {
    // Server edits first, so any edit made in this browser still wins.
    for (const [id, override] of Object.entries(remote.themeCatalog.overrides)) {
      themePatches[id] = { ...override.patch, ...themePatches[id] };
    }

    const byId = new Map<string, GreetingTheme>();
    for (const theme of remote.themeCatalog.customThemes) byId.set(theme.id, theme);
    for (const theme of prev.customThemes) byId.set(theme.id, theme);
    next.customThemes = [...byId.values()];

    const deleted = new Set([
      ...prev.deletedThemeIds,
      ...Object.entries(remote.themeCatalog.overrides)
        .filter(([, override]) => override.deleted)
        .map(([id]) => id),
    ]);
    next.deletedThemeIds = [...deleted];
  }

  if (remote.themePrices) {
    for (const [id, price] of Object.entries(remote.themePrices)) {
      if (localEditWins(prev.priceEditedAt[id], price.updatedAt)) continue;
      themePatches[id] = {
        ...themePatches[id],
        price: price.price,
        price_usd: price.price_usd,
      };
    }
  }
  next.themePatches = themePatches;

  if (remote.products && remote.products.length > 0) {
    const remoteById = new Map(remote.products.map((product) => [product.id, product]));
    const merged = remote.products.map((remoteProduct) => {
      const local = prev.products.find((product) => product.id === remoteProduct.id);
      const remoteAt = Date.parse(remoteProduct.created_at) || 0;
      if (local && localEditWins(prev.productEditedAt[remoteProduct.id], remoteAt)) {
        return local;
      }
      return remoteProduct;
    });
    // Products the admin created here but the server has not stored yet are kept,
    // while untouched built-in defaults are never resurrected over a live list.
    for (const product of prev.products) {
      if (!remoteById.has(product.id) && prev.productEditedAt[product.id]) merged.push(product);
    }
    next.products = merged;
  }

  return next;
};

/** Result of a best-effort server write, so callers can warn the admin. */
export interface RemoteWriteResult {
  ok: boolean;
  error?: string;
}

/** Turns a Supabase/network failure into a short, human message. */
export const describeRemoteError = (error: unknown): string => {
  const raw =
    typeof error === 'string'
      ? error
      : error && typeof error === 'object' && 'message' in error
        ? String((error as { message?: unknown }).message ?? '')
        : '';
  if (/row-level security|permission denied|violates row-level/i.test(raw)) {
    return 'The server rejected the change: this account is not an admin in Supabase (row-level security). Sign in with the admin account, or add your user to the admin_users table.';
  }
  if (/does not exist|Could not find the table|column/i.test(raw)) {
    return `The server rejected the change: ${raw}`;
  }
  return raw ? `The change could not be saved to the server: ${raw}` : 'The change could not be saved to the server.';
};

const newId = (prefix: string): string => {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${rand}`;
};

/** Builds a complete GreetingTheme from the admin form values. */
export const buildCustomTheme = (input: CustomThemeInput): GreetingTheme => ({
  id: newId('custom'),
  category_id: input.category_id,
  name: input.name.trim() || 'Untitled theme',
  tagline: input.tagline.trim(),
  price: Number(input.price) || 0,
  price_usd: deriveUsdPrice(input.price, input.price_usd),
  tier: input.tier,
  emoji: input.emoji || '✨',
  accent: input.accent || '#8b5cf6',
  gradient: input.gradient || 'from-violet-600 via-purple-500 to-pink-500',
  animation: input.animation,
  tags: input.tags,
  design: buildDesignForTier(input.tier, input.accent || '#8b5cf6'),
  artwork_url: input.artwork_url?.trim() || undefined,
});

/** The price to charge/show a visitor in the given region. */
export const themePriceForRegion = (theme: GreetingTheme, isIndia: boolean): number =>
  isIndia ? Number(theme.price) || 0 : deriveUsdPrice(theme.price, theme.price_usd);

/** The product price to charge/show a visitor in the given region. */
export const productPriceForRegion = (product: Product, isIndia: boolean): number => {
  const inr = Number(product.price_inr ?? product.price) || 0;
  return isIndia ? inr : deriveUsdPrice(inr, product.price_usd);
};

/** Lowest and highest prices in both currencies, for the storefront range badge. */
export const getThemePriceRanges = (
  themes: GreetingTheme[],
): { inrMin: number; inrMax: number; usdMin: number; usdMax: number } => {
  if (themes.length === 0) return { inrMin: 0, inrMax: 0, usdMin: 0, usdMax: 0 };
  // Free themes (price 0) are excluded so the storefront range badge shows the
  // real paid range rather than "₹0–₹157".
  const paid = themes.filter(
    (theme) => (Number(theme.price) || 0) > 0 || (Number(theme.price_usd) || 0) > 0,
  );
  const priced = paid.length > 0 ? paid : themes;
  const inr = priced.map((theme) => Number(theme.price) || 0);
  const usd = priced.map((theme) => deriveUsdPrice(theme.price, theme.price_usd));
  return {
    inrMin: Math.min(...inr),
    inrMax: Math.max(...inr),
    usdMin: Math.min(...usd),
    usdMax: Math.max(...usd),
  };
};

/* ------------------------------------------------------------------ */
/* Supabase (best-effort) product sync                                 */
/* ------------------------------------------------------------------ */

export const fetchRemoteProducts = async (): Promise<Product[] | null> => {
  if (!isSupabaseConfigured()) return null;
  try {
    const { data, error } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false });
    if (error || !data) return null;
    return data.map((row) => normalizeProduct(row));
  } catch {
    return null;
  }
};

export const pushRemoteProduct = async (product: Product): Promise<RemoteWriteResult> => {
  if (!isSupabaseConfigured()) return { ok: true };
  const price = Number(product.price_inr ?? product.price) || 0;
  const richPayload = {
    id: product.id,
    category_id: product.category_id,
    name: product.name,
    description: product.description,
    price_inr: price,
    image_url: product.image_url,
    product_file_url: product.product_file_url,
    updated_at: new Date().toISOString(),
    price_usd: product.price_usd,
  };
  // Minimal payload for the shipped `products` schema, which stores just the
  // name + prices. Without this fallback *every* product write failed with a
  // "column does not exist" error, so an edited price never reached the server
  // and the stale row reverted it on the next reload.
  const minimalPayload = {
    id: product.id,
    name: product.name,
    price,
    price_usd: product.price_usd,
  };
  try {
    const first = await supabase.from('products').upsert(richPayload);
    if (!first.error) return { ok: true };
    const second = await supabase.from('products').upsert(minimalPayload);
    if (second.error) return { ok: false, error: describeRemoteError(second.error) };
    return { ok: true };
  } catch (error) {
    /* offline — local state remains the source of truth */
    return { ok: false, error: describeRemoteError(error) };
  }
};

export const removeRemoteProduct = async (id: string): Promise<void> => {
  if (!isSupabaseConfigured()) return;
  try {
    await supabase.from('products').delete().eq('id', id);
  } catch {
    /* ignore */
  }
};

/* ------------------------------------------------------------------ */
/* Supabase (best-effort) theme price sync                             */
/* ------------------------------------------------------------------ */

/**
 * Loads admin-set theme prices from Supabase so the payment Edge Functions and
 * every visitor see the same INR/USD amounts, not just the admin's browser.
 */
export const fetchRemoteThemePrices = async (): Promise<
  Record<string, RemoteThemePrice> | null
> => {
  if (!isSupabaseConfigured()) return null;
  try {
    const { data, error } = await supabase
      .from('theme_prices')
      .select('theme_id, price_inr, price_usd, updated_at');
    if (error || !data) return null;

    const prices: Record<string, RemoteThemePrice> = {};
    for (const row of data as {
      theme_id?: string;
      price_inr?: number;
      price_usd?: number;
      updated_at?: string;
    }[]) {
      const id = row.theme_id ? String(row.theme_id) : '';
      if (!id) continue;
      const inr = Number(row.price_inr) || 0;
      const updatedAt = row.updated_at ? Date.parse(row.updated_at) : NaN;
      prices[id] = {
        price: inr,
        price_usd: deriveUsdPrice(inr, Number(row.price_usd)),
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
      };
    }
    return prices;
  } catch {
    return null;
  }
};

/** Upserts a theme's INR + USD price for the server-side price table. */
export const pushRemoteThemePrice = async (
  themeId: string,
  price: number,
  priceUsd: number,
): Promise<RemoteWriteResult> => {
  if (!isSupabaseConfigured()) return { ok: true };
  try {
    const { error } = await supabase.from('theme_prices').upsert({
      theme_id: themeId,
      price_inr: Number(price) || 0,
      price_usd: Number(priceUsd) || 0,
      updated_at: new Date().toISOString(),
    });
    if (error) return { ok: false, error: describeRemoteError(error) };
    return { ok: true };
  } catch (error) {
    /* offline — local state remains the source of truth */
    return { ok: false, error: describeRemoteError(error) };
  }
};

export const removeRemoteThemePrice = async (themeId: string): Promise<void> => {
  if (!isSupabaseConfigured()) return;
  try {
    await supabase.from('theme_prices').delete().eq('theme_id', themeId);
  } catch {
    /* ignore */
  }
};

/* ------------------------------------------------------------------ */
/* Supabase (best-effort) theme overrides + custom themes               */
/* ------------------------------------------------------------------ */

/** One admin edit for a built-in theme, as stored in `theme_overrides`. */
export interface RemoteThemeOverride {
  patch: ThemePatch;
  deleted: boolean;
}

/**
 * Loads every admin edit to the built-in themes plus all custom themes, so a
 * design uploaded from the dashboard (background artwork, colours, copy) shows
 * up for visitors and in the generated cards — not just in the admin's browser.
 */
export const fetchRemoteThemeCatalog = async (): Promise<{
  overrides: Record<string, RemoteThemeOverride>;
  customThemes: GreetingTheme[];
} | null> => {
  if (!isSupabaseConfigured()) return null;
  try {
    const [overrideRes, customRes] = await Promise.all([
      supabase.from('theme_overrides').select('theme_id, patch, deleted'),
      supabase.from('custom_themes').select('data'),
    ]);
    if (overrideRes.error && customRes.error) return null;

    const overrides: Record<string, RemoteThemeOverride> = {};
    for (const row of (overrideRes.data ?? []) as {
      theme_id?: string;
      patch?: unknown;
      deleted?: boolean;
    }[]) {
      const id = row.theme_id ? String(row.theme_id) : '';
      if (!id) continue;
      const patch =
        row.patch && typeof row.patch === 'object' ? (row.patch as ThemePatch) : {};
      overrides[id] = { patch, deleted: Boolean(row.deleted) };
    }

    const customThemes: GreetingTheme[] = [];
    for (const row of (customRes.data ?? []) as { data?: unknown }[]) {
      const theme = row.data as GreetingTheme | null;
      if (theme && typeof theme === 'object' && typeof theme.id === 'string') customThemes.push(theme);
    }

    return { overrides, customThemes };
  } catch {
    return null;
  }
};

/** Upserts an admin edit (or a delete flag) for a built-in theme. */
export const pushRemoteThemeOverride = async (
  themeId: string,
  patch: ThemePatch,
  deleted = false,
): Promise<void> => {
  if (!isSupabaseConfigured()) return;
  try {
    await supabase.from('theme_overrides').upsert({
      theme_id: themeId,
      patch: JSON.parse(JSON.stringify(patch ?? {})),
      deleted,
      updated_at: new Date().toISOString(),
    });
  } catch {
    /* offline / RLS — local state remains the source of truth */
  }
};

/** Publishes an admin-created theme so every visitor can use it. */
export const pushRemoteCustomTheme = async (theme: GreetingTheme): Promise<void> => {
  if (!isSupabaseConfigured()) return;
  try {
    await supabase.from('custom_themes').upsert({
      id: theme.id,
      data: JSON.parse(JSON.stringify(theme)),
      updated_at: new Date().toISOString(),
    });
  } catch {
    /* offline / RLS — local state remains the source of truth */
  }
};

export const removeRemoteCustomTheme = async (themeId: string): Promise<void> => {
  if (!isSupabaseConfigured()) return;
  try {
    await supabase.from('custom_themes').delete().eq('id', themeId);
  } catch {
    /* ignore */
  }
};

/**
 * Downscales + re-encodes a large photo in the browser before upload. Keeps
 * artwork uploads small (fast cards, no storage quota surprises) and avoids
 * tripping the localStorage size limit on the no-backend fallback.
 */
export const shrinkImageFile = async (
  file: File,
  maxWidth = 1600,
  quality = 0.82,
): Promise<File> => {
  if (typeof document === 'undefined') return file;
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return file;

  const bitmapUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Unsupported image'));
      img.src = bitmapUrl;
    });

    const scale = Math.min(1, maxWidth / (image.naturalWidth || maxWidth));
    if (scale >= 1 && file.size <= 900_000) return file;

    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round((image.naturalWidth || maxWidth) * scale));
    canvas.height = Math.max(1, Math.round((image.naturalHeight || maxWidth) * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', quality),
    );
    if (!blob) return file;
    const name = file.name.replace(/\.[^.]+$/, '') || 'artwork';
    return new File([blob], `${name}.jpg`, { type: 'image/jpeg' });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(bitmapUrl);
  }
};

/** Uploads theme background artwork to Supabase Storage and returns its public URL. */
export const uploadThemeArtwork = async (file: File): Promise<string> => {
  if (!isSupabaseConfigured()) {
    throw new Error('Artwork hosting requires a configured Supabase project.');
  }
  const ext = file.name.split('.').pop() ?? 'png';
  const path = `theme-artwork/${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  const { error } = await supabase.storage.from('theme-artwork').upload(path, file);
  if (error) throw error;
  const {
    data: { publicUrl },
  } = supabase.storage.from('theme-artwork').getPublicUrl(path);
  return publicUrl;
};

/** Reads a local file into a data URL (fallback when no image host is configured). */
export const fileToDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('Could not read the image file.'));
    reader.readAsDataURL(file);
  });

/** Uploads a product thumbnail to Supabase Storage and returns its public URL. */
export const uploadProductImage = async (file: File): Promise<string> => {
  if (!isSupabaseConfigured()) throw new Error('Image hosting requires a configured Supabase project.');
  const fileExt = file.name.split('.').pop() ?? 'png';
  const filePath = `product-thumbnails/${Date.now()}.${fileExt}`;
  const { error } = await supabase.storage.from('product-thumbnails').upload(filePath, file);
  if (error) throw error;
  const {
    data: { publicUrl },
  } = supabase.storage.from('product-thumbnails').getPublicUrl(filePath);
  return publicUrl;
};
