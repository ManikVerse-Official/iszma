import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  ReactNode,
} from 'react';
import { GreetingTheme, Product } from '../types';
import {
  applyThemePatches,
  buildCustomTheme,
  CatalogState,
  CustomThemeInput,
  fetchRemoteProducts,
  fetchRemoteThemeCatalog,
  fetchRemoteThemePrices,
  loadCatalogState,
  mergeRemoteCatalog,
  normalizeProduct,
  persistCatalogState,
  pushRemoteCustomTheme,
  pushRemoteProduct,
  pushRemoteThemeOverride,
  pushRemoteThemePrice,
  RemoteWriteResult,
  removeRemoteCustomTheme,
  removeRemoteProduct,
  removeRemoteThemePrice,
  ThemePatch,
} from '../services/catalog';

export type NewProductInput = Omit<Product, 'id' | 'created_at' | 'updated_at'> & {
  id?: string;
};

interface CatalogContextType {
  /** Live, merged theme list (built-ins + admin edits + custom themes). */
  themes: GreetingTheme[];
  /** Live store product list. */
  products: Product[];
  loading: boolean;
  /**
   * Set when the last server write was rejected (e.g. the signed-in account is
   * not a Supabase admin). The change still shows here, but it will not reach
   * other visitors or the payment functions until the server accepts it.
   */
  syncWarning: string | null;
  dismissSyncWarning: () => void;
  /** Ids of built-in themes an admin has hidden (shown so they can be restored). */
  deletedThemeIds: string[];
  /** True when an admin has deleted a built-in theme (so it can be restored). */
  isThemeDeleted: (id: string) => boolean;
  addTheme: (input: CustomThemeInput) => GreetingTheme;
  updateTheme: (id: string, patch: ThemePatch) => void;
  deleteTheme: (id: string) => void;
  restoreTheme: (id: string) => void;
  addProduct: (input: NewProductInput) => Product;
  updateProduct: (id: string, patch: Partial<Product>) => void;
  deleteProduct: (id: string) => void;
  /**
   * Re-reads the server catalogue and applies the persisted state. Used after a
   * server-side Admin Joy write so the dashboard reflects what the backend
   * actually stored, rather than an optimistic local edit.
   *
   * `hint` names the entity that just changed; the server becomes authoritative
   * for that one id (its local "edited by me" marker is cleared) while every
   * unrelated in-browser edit is preserved.
   */
  refreshFromServer: (hint?: {
    kind: 'product' | 'theme';
    id?: string;
    /** Several ids changed together (e.g. a whole tier's prices). */
    ids?: string[];
  }) => Promise<void>;
}

const CatalogContext = createContext<CatalogContextType | undefined>(undefined);

export const CatalogProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [state, setState] = useState<CatalogState>(() => loadCatalogState());
  const [loading, setLoading] = useState(false);
  const [syncWarning, setSyncWarning] = useState<string | null>(null);

  // Persist every change locally, immediately.
  useEffect(() => {
    persistCatalogState(state);
  }, [state]);

  /** Records the outcome of a best-effort server write so the admin can see it. */
  const noteWrite = useCallback((result: RemoteWriteResult) => {
    setSyncWarning(result.ok ? null : result.error ?? 'The change could not be saved to the server.');
  }, []);

  // Pull remote products, admin theme edits (incl. uploaded artwork), custom
  // themes and admin-set prices once, when Supabase is configured.
  useEffect(() => {
    let active = true;
    (async () => {
      const [remoteProducts, remotePrices, remoteThemeCatalog] = await Promise.all([
        fetchRemoteProducts(),
        fetchRemoteThemePrices(),
        fetchRemoteThemeCatalog(),
      ]);
      if (!active) return;
      // Merge instead of overwrite: a price or product edit made here *after* the
      // server row was written must survive the reload (see mergeRemoteCatalog).
      setState((prev) =>
        mergeRemoteCatalog(prev, {
          products: remoteProducts,
          themePrices: remotePrices,
          themeCatalog: remoteThemeCatalog,
        }),
      );
    })();
    setLoading(false);
    return () => {
      active = false;
    };
  }, []);

  const themes = useMemo(() => applyThemePatches(state), [state]);

  const isThemeDeleted = useCallback(
    (id: string) => state.deletedThemeIds.includes(id),
    [state.deletedThemeIds],
  );

  const addTheme = useCallback(
    (input: CustomThemeInput): GreetingTheme => {
      const theme = buildCustomTheme(input);
      setState((prev) => ({
        ...prev,
        customThemes: [...prev.customThemes, theme],
        deletedThemeIds: prev.deletedThemeIds.filter((id) => id !== theme.id),
        priceEditedAt: { ...prev.priceEditedAt, [theme.id]: Date.now() },
      }));
      void pushRemoteThemePrice(theme.id, theme.price, theme.price_usd).then(noteWrite);
      void pushRemoteCustomTheme(theme);
      return theme;
    },
    [noteWrite],
  );

  const updateTheme = useCallback(
    (id: string, patch: ThemePatch) => {
      // The server write happens outside the state updater, so a rejected write
      // can be reported back to the dashboard instead of being swallowed.
      if (patch.price !== undefined || patch.price_usd !== undefined) {
        const current = themes.find((theme) => theme.id === id);
        void pushRemoteThemePrice(
          id,
          patch.price ?? current?.price ?? 0,
          patch.price_usd ?? current?.price_usd ?? 0,
        ).then(noteWrite);
      }
      setState((prev) => {
        const editedAt =
          patch.price !== undefined || patch.price_usd !== undefined
            ? { ...prev.priceEditedAt, [id]: Date.now() }
            : prev.priceEditedAt;
        const isCustom = prev.customThemes.some((theme) => theme.id === id);
        if (isCustom) {
          const updated = { ...prev.customThemes.find((theme) => theme.id === id)!, ...patch };
          void pushRemoteCustomTheme(updated);
          return {
            ...prev,
            priceEditedAt: editedAt,
            customThemes: prev.customThemes.map((theme) => (theme.id === id ? updated : theme)),
          };
        }
        const merged: ThemePatch = { ...prev.themePatches[id], ...patch };
        // Publish the edit (background artwork, colours, copy…) for every visitor.
        void pushRemoteThemeOverride(id, merged);
        return {
          ...prev,
          priceEditedAt: editedAt,
          themePatches: { ...prev.themePatches, [id]: merged },
        };
      });
    },
    [themes, noteWrite],
  );

  const deleteTheme = useCallback((id: string) => {
    void removeRemoteThemePrice(id);
    setState((prev) => {
      const wasCustom = prev.customThemes.some((theme) => theme.id === id);
      const themePatches = { ...prev.themePatches };
      delete themePatches[id];
      if (wasCustom) {
        void removeRemoteCustomTheme(id);
      } else {
        // Hide it for visitors too, keeping any edit so a restore brings it back.
        void pushRemoteThemeOverride(id, prev.themePatches[id] ?? {}, true);
      }
      return {
        ...prev,
        customThemes: prev.customThemes.filter((theme) => theme.id !== id),
        deletedThemeIds: wasCustom
          ? prev.deletedThemeIds
          : Array.from(new Set([...prev.deletedThemeIds, id])),
        themePatches,
      };
    });
  }, []);

  const restoreTheme = useCallback((id: string) => {
    setState((prev) => {
      void pushRemoteThemeOverride(id, prev.themePatches[id] ?? {}, false);
      return {
        ...prev,
        deletedThemeIds: prev.deletedThemeIds.filter((themeId) => themeId !== id),
      };
    });
  }, []);

  const addProduct = useCallback((input: NewProductInput): Product => {
    const product = normalizeProduct({
      ...input,
      id: input.id ?? `product-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    setState((prev) => ({
      ...prev,
      products: [product, ...prev.products],
      productEditedAt: { ...prev.productEditedAt, [product.id]: Date.now() },
    }));
    void pushRemoteProduct(product).then(noteWrite);
    return product;
  }, [noteWrite]);

  const updateProduct = useCallback(
    (id: string, patch: Partial<Product>) => {
      setState((prev) => {
        const products = prev.products.map((product) =>
          product.id === id
            ? normalizeProduct({ ...product, ...patch, updated_at: new Date().toISOString() })
            : product,
        );
        const updated = products.find((product) => product.id === id);
        if (updated) void pushRemoteProduct(updated).then(noteWrite);
        return {
          ...prev,
          products,
          productEditedAt: { ...prev.productEditedAt, [id]: Date.now() },
        };
      });
    },
    [noteWrite],
  );

  const deleteProduct = useCallback((id: string) => {
    setState((prev) => ({ ...prev, products: prev.products.filter((product) => product.id !== id) }));
    void removeRemoteProduct(id);
  }, []);

  const dismissSyncWarning = useCallback(() => setSyncWarning(null), []);

  /** Server-authoritative re-read; see `refreshFromServer` in the context type. */
  const refreshFromServer = useCallback(
    async (hint?: { kind: 'product' | 'theme'; id?: string; ids?: string[] }) => {
      const [remoteProducts, remotePrices, remoteThemeCatalog] = await Promise.all([
        fetchRemoteProducts(),
        fetchRemoteThemePrices(),
        fetchRemoteThemeCatalog(),
      ]);

      setState((prev) => {
        const merged = mergeRemoteCatalog(prev, {
          products: remoteProducts,
          themePrices: remotePrices,
          themeCatalog: remoteThemeCatalog,
        });

        /* Several records changed together: the server is authoritative for all of them. */
        if (hint?.ids) {
          const productEditedAt = { ...merged.productEditedAt };
          const priceEditedAt = { ...merged.priceEditedAt };
          for (const id of hint.ids) {
            delete priceEditedAt[id];
            delete productEditedAt[id];
          }
          return { ...merged, priceEditedAt, productEditedAt };
        }

        if (!hint?.id) return merged;

        const productEditedAt = { ...merged.productEditedAt };
        const priceEditedAt = { ...merged.priceEditedAt };
        if (hint.kind === 'product') {
          delete productEditedAt[hint.id];
        } else {
          delete priceEditedAt[hint.id];
          delete productEditedAt[hint.id];
        }

        let customThemes = merged.customThemes;
        let deletedThemeIds = merged.deletedThemeIds;

        if (hint.kind === 'theme') {
          const remoteCustomIds = new Set(
            (remoteThemeCatalog?.customThemes ?? []).map((theme) => theme.id),
          );
          const wasCustomLocally = prev.customThemes.some((theme) => theme.id === hint.id);
          if (wasCustomLocally && !remoteCustomIds.has(hint.id)) {
            // The row is gone server-side, so drop it here too.
            customThemes = merged.customThemes.filter((theme) => theme.id !== hint.id);
            deletedThemeIds = deletedThemeIds.filter((id) => id !== hint.id);
          } else {
            const hiddenOnServer = Boolean(remoteThemeCatalog?.overrides?.[hint.id]?.deleted);
            const set = new Set(deletedThemeIds);
            if (hiddenOnServer) set.add(hint.id);
            else set.delete(hint.id);
            deletedThemeIds = [...set];
          }
        }

        return { ...merged, priceEditedAt, productEditedAt, customThemes, deletedThemeIds };
      });
    },
    [],
  );

  const value = useMemo<CatalogContextType>(
    () => ({
      themes,
      products: state.products,
      loading,
      syncWarning,
      dismissSyncWarning,
      deletedThemeIds: state.deletedThemeIds,
      isThemeDeleted,
      addTheme,
      updateTheme,
      deleteTheme,
      restoreTheme,
      addProduct,
      updateProduct,
      deleteProduct,
      refreshFromServer,
    }),
    [
      themes,
      state.products,
      loading,
      syncWarning,
      dismissSyncWarning,
      state.deletedThemeIds,
      isThemeDeleted,
      addTheme,
      updateTheme,
      deleteTheme,
      restoreTheme,
      addProduct,
      updateProduct,
      deleteProduct,
      refreshFromServer,
    ],
  );

  return <CatalogContext.Provider value={value}>{children}</CatalogContext.Provider>;
};

export const useCatalog = (): CatalogContextType => {
  const context = useContext(CatalogContext);
  if (context === undefined) {
    throw new Error('useCatalog must be used within a CatalogProvider');
  }
  return context;
};
