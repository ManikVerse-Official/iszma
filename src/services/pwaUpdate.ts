/**
 * Service-worker lifecycle for the installed PWA.
 *
 * The app is installed on phones and kept open for days, so a freshly deployed
 * build must not sit behind a stale service worker (which is what forced users
 * to uninstall and reinstall after a rebrand). Two things fix that:
 *
 *  • the generated worker uses `skipWaiting` + `clients.claim`, so a new version
 *    takes over as soon as it is downloaded;
 *  • this module keeps *asking* the browser to look for that new version — on
 *    load, on focus, when the tab becomes visible, and every 30 minutes — so an
 *    update is found even in a long-lived tab.
 *
 * When the new worker takes control, the page reloads exactly once so the new
 * HTML (and the new manifest, name, icons and theme colour) is what the user
 * sees. The reload is skipped on the very first install, where there was no
 * controller before and the page is already the new build.
 */

import { registerSW } from 'virtual:pwa-register';

/** How often an open tab re-checks for a new deploy. */
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

/** Delayed first check, so the initial page load is not competing for bandwidth. */
const INITIAL_CHECK_DELAY_MS = 5000;

export const setupPwaUpdates = (): void => {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;

  const reloadOnce = (): void => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      // Auto-apply: activate the waiting worker, which triggers the reload below.
      void updateSW(true);
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;

      const check = (): void => {
        if (document.visibilityState !== 'visible') return;
        registration.update().catch(() => undefined);
      };

      window.setInterval(check, UPDATE_CHECK_INTERVAL_MS);
      window.setTimeout(check, INITIAL_CHECK_DELAY_MS);
      window.addEventListener('focus', check);
      document.addEventListener('visibilitychange', check);
    },
    onRegisterError(error) {
      console.warn('[pwa] service worker registration failed', error);
    },
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) reloadOnce();
  });
};
