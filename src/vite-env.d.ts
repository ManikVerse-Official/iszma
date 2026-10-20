/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_RAZORPAY_KEY_ID: string;
  readonly VITE_PAYPAL_CLIENT_ID: string;
  /** Stripe publishable key — its presence enables the Stripe option for non-India buyers. */
  readonly VITE_STRIPE_PUBLISHABLE_KEY: string;
  /** Set to "demo" to exercise the flow without real gateway keys. */
  readonly VITE_PAYMENT_MODE: string;
  readonly VITE_GREETING_DOMAIN: string;
  /*
   * Deliberately absent — these are backend-only now:
   *   VITE_ADMIN_EMAIL / VITE_ADMIN_PASSWORD  -> admin_users (bcrypt) + admin-login
   *   VITE_IMGBB_API_KEY                      -> Edge secret + upload-image
   */
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
