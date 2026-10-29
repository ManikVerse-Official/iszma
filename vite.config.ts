import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, loadEnv, type Plugin, type Connect } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

/**
 * The canonical origin in `index.html` (canonical, Open Graph, JSON-LD) comes
 * from VITE_SITE_URL. Until the custom domain is verified and connected, this
 * intentionally falls back to the CURRENT live deployment rather than an
 * unverified domain.
 */
const siteUrlPlugin = (siteUrl: string): Plugin => {
  let outDir = 'dist'
  return {
    name: 'iszma-site-url',
    configResolved: (config) => {
      outDir = config.build.outDir
    },
    transformIndexHtml: (html) => html.replaceAll('__SITE_URL__', siteUrl),
    /*
     * robots.txt and sitemap.xml live in public/ so they are served as static
     * files. Their absolute URLs must match the canonical origin, so the same
     * token is replaced in the build output.
     */
    closeBundle: () => {
      for (const file of ['robots.txt', 'sitemap.xml']) {
        const path = resolve(outDir, file)
        if (!existsSync(path)) continue
        const contents = readFileSync(path, 'utf8')
        writeFileSync(path, contents.replaceAll('__SITE_URL__', siteUrl))
      }
    },
  }
}

/**
 * ReportCard Studio is embedded as a static sub-app at /reportcard/. It has its
 * own client-side router, so a deep link like /reportcard/dashboard must serve
 * the sub-app's shell — not Ishmaverse's — otherwise the iframe would render
 * the wrong app. This mirrors the production rewrite in vercel.json.
 */
const reportCardFallback = (): Plugin => {
  const middleware: Connect.NextHandleFunction = (req, _res, next) => {
    const url = req.url ?? '';
    // Serve the sub-app shell for /reportcard and extension-less
    // /reportcard/* paths (never for real assets like /reportcard/assets/*.js).
    if (url === '/reportcard' || /^\/reportcard\/(?!.*\.[a-zA-Z0-9]+(\?|$)).*$/.test(url)) {
      req.url = '/reportcard/index.html';
    }
    next();
  };

  return {
    name: 'reportcard-spa-fallback',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '.', '')
  const siteUrl = (env.VITE_SITE_URL || 'https://ishmaverse.vercel.app').replace(/\/+$/, '')

  return {
  plugins: [
    reportCardFallback(),
    siteUrlPlugin(siteUrl),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'logos/iszma-icon-48.png',
        'logos/iszma-icon-180.png',
        'logos/iszma-icon-512.png',
      ],
      manifest: {
        name: 'isZma — The Digital Mall',
        short_name: 'isZma',
        description: 'The Digital Mall — Tech, Art, Comics, Education, greeting cards and report card tools.',
        theme_color: '#6d28d9',
        background_color: '#0a0612',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        icons: [
          {
            src: '/logos/iszma-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/logos/iszma-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/logos/iszma-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          }
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}'],
        // The embedded ReportCard Studio SPA ships its own shell + service
        // worker, so keep it out of the main app's precache and navigation
        // fallback — otherwise the iframe could be served the mall page.
        globIgnores: ['**/reportcard/**'],
        navigateFallbackDenylist: [/^\/reportcard\//],
      },
    }),
  ],
  }
})
