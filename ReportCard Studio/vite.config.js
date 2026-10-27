import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
/*
 * The app is a static SPA that can be dropped into an existing website either
 * at the domain root (base "/") or inside a folder on the domain, e.g.
 *   VITE_BASE=/reportcard/ npm run build
 * PWA asset paths (manifest, icons, service worker scope) follow this base.
 */
export default defineConfig({
    envDir: '../',
    base: process.env.VITE_BASE || '/',
    plugins: [react()],
    resolve: {
        alias: {
            '@': fileURLToPath(new URL('./src', import.meta.url)),
        },
    },
    server: {
        port: 5173,
    },
});
