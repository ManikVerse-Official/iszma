import { useEffect } from 'react';
import { applyPageMeta, type PageMeta } from '../services/seo';

/**
 * Applies the page's SEO metadata for as long as it is mounted.
 *
 * Runs on title/description/path/noindex changes only, so re-renders (search
 * typing, currency switching) do not rewrite the document head.
 */
export const usePageMeta = (meta: PageMeta): void => {
  const { title, description, path, noindex, image, type } = meta;

  useEffect(() => {
    applyPageMeta({ title, description, path, noindex, image, type });
  }, [title, description, path, noindex, image, type]);
};
