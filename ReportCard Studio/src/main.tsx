import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App'
import './index.css'
import {
  getBridgedToken,
  installAuthBridge,
  subscribeToBridgedSession,
} from './services/authBridge'
import { setSessionToken } from './services/supabase'
import { useEntitlement } from './store/entitlementStore'

/*
 * Admin session bridge.
 *
 * The Studio is embedded in Ishmaverse, and only Ishmaverse holds the real
 * Supabase session. We ask the parent for it and attach it to our server calls,
 * so the ENTITLEMENT function can verify who is calling and decide about admin
 * access itself. No admin flag is ever derived in the browser — but every time
 * the token changes we re-ask, because admin status is a server answer.
 */
installAuthBridge()
setSessionToken(getBridgedToken())

/*
 * Re-ask the server as soon as the session actually arrives.
 *
 * The parent answers `ishmaverse:auth-request` asynchronously, so the first
 * entitlement call of a page load can still be anonymous: admin status is only
 * ever learned from the server, and without this the store kept its initial
 * `isAdmin: false` until a generation was attempted — the dashboard therefore
 * showed "7 of 7 free generations left" to the owner.
 */
subscribeToBridgedSession((session) => {
  setSessionToken(session?.accessToken ?? null)
  void useEntitlement.getState().refreshFromServer()
})

/* A reload with an already-stored session/account still needs one check. */
void useEntitlement.getState().refreshFromServer()

/*
 * `basename` follows the build's base path: "/" when hosted at the domain root
 * and "/reportcard/" when embedded inside Ishmaverse. Without it the router
 * sees the "/reportcard/" prefix as part of the route and matches nothing —
 * which rendered a blank page inside the embed.
 */
const basename = import.meta.env.BASE_URL.replace(/\/$/, '') || '/'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={basename}>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
)

/*
 * PWA: register the shell service worker after load so it never competes with
 * the first paint. Only in production builds (a dev server would otherwise
 * serve stale shells). Registration is skipped silently on browsers that do
 * not support it — the app itself works without it.
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`
    navigator.serviceWorker.register(swUrl).catch(() => {
      /* Offline shell unavailable; the app keeps working online. */
    })
  })
}
