/**
 * Per-route SEO metadata for the single-page app.
 *
 * `index.html` carries the crawlable defaults; this module updates the same
 * tags when the visitor moves between routes so shared links and search results
 * describe the page they actually open.
 *
 * The canonical origin comes from `VITE_SITE_URL` at build time. Until the
 * custom domain is verified and connected, it falls back to the CURRENT live
 * deployment — never an unverified domain.
 */

const rawSiteUrl = (import.meta.env.VITE_SITE_URL as string | undefined) ?? '';
export const SITE_URL = (rawSiteUrl.trim() || 'https://ishmaverse.vercel.app').replace(/\/+$/, '');

export const SITE_NAME = 'isZma';
export const SITE_TAGLINE = 'The Digital Mall';
export const DEFAULT_TITLE = 'isZma — The Digital Mall';
export const DEFAULT_DESCRIPTION =
  'isZma is The Digital Mall for Tech, Art, Comics, Education, animated digital greeting cards, and school report card tools.';
export const DEFAULT_IMAGE = `${SITE_URL}/logos/iszma-og.png`;

export interface PageMeta {
  title: string;
  description: string;
  /** Route path beginning with `/`, used to build the canonical URL. */
  path?: string;
  /** Keep private/transactional screens out of search results. */
  noindex?: boolean;
  image?: string;
  type?: 'website' | 'article';
}

const setMeta = (attribute: 'name' | 'property', key: string, content: string): void => {
  let element = document.head.querySelector<HTMLMetaElement>(`meta[${attribute}="${key}"]`);
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attribute, key);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
};

const setLink = (rel: string, href: string): void => {
  let element = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!element) {
    element = document.createElement('link');
    element.setAttribute('rel', rel);
    document.head.appendChild(element);
  }
  element.setAttribute('href', href);
};

/** Applies one route's title, description, canonical and social tags. */
export const applyPageMeta = (meta: PageMeta): void => {
  const canonical = `${SITE_URL}${meta.path ?? '/'}`;
  const image = meta.image ?? DEFAULT_IMAGE;
  const robots = meta.noindex ? 'noindex, nofollow' : 'index, follow, max-image-preview:large';

  document.title = meta.title;

  setMeta('name', 'description', meta.description);
  setMeta('name', 'robots', robots);

  setLink('canonical', canonical);

  setMeta('property', 'og:site_name', SITE_NAME);
  setMeta('property', 'og:type', meta.type ?? 'website');
  setMeta('property', 'og:title', meta.title);
  setMeta('property', 'og:description', meta.description);
  setMeta('property', 'og:url', canonical);
  setMeta('property', 'og:image', image);

  setMeta('name', 'twitter:card', 'summary_large_image');
  setMeta('name', 'twitter:title', meta.title);
  setMeta('name', 'twitter:description', meta.description);
  setMeta('name', 'twitter:image', image);
};

/** A short, unique title keeps tabs and search snippets readable. */
export const pageTitle = (page: string): string => `${page} | ${SITE_NAME} — ${SITE_TAGLINE}`;
