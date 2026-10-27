/**
 * ReportCard Studio subscription plans.
 *
 * Prices are set by Ishmaverse. INR is the base price; the USD figure is the
 * international price shown to visitors outside India. All plans currently run
 * for six months. Admins never pay (see ADMIN_EMAILS).
 *
 * IMPORTANT: the values below are only a fallback for an offline/dev build. The
 * authoritative prices live in the `studio_plan_prices` table (migration
 * 20261023_step17) and are edited from Ishmaverse Admin Joy. The pricing screens
 * call `fetchLivePlans()` (services/planPricing.ts) and show the server value, so
 * changing a price here will NOT change what a customer is charged.
 */

export interface StudioPlan {
  id: string;
  name: string;
  /** Price in Indian Rupees (base). */
  priceInr: number;
  /** Price in US Dollars (international). */
  priceUsd: number;
  /** Length of the subscription in months. */
  durationMonths: number;
  tagline: string;
  /** Highlighted as the recommended plan. */
  recommended?: boolean;
  features: string[];
}

export const PLAN_DURATION_MONTHS = 6;

/** How many free report-card generations a signed-in account gets before paying. */
export const FREE_USE_LIMIT = 7;

/**
 * Emails that always get unlimited, free access (Ishmaverse staff / owner).
 * Compared case-insensitively. Add more addresses as needed.
 */
export const ADMIN_EMAILS: string[] = ['admin@ishmaverse.com'];

export const STUDIO_PLANS: StudioPlan[] = [
  {
    id: 'simple',
    name: 'Simple Academic',
    priceInr: 369,
    priceUsd: 4.99,
    durationMonths: PLAN_DURATION_MONTHS,
    tagline: 'Marks-focused report cards',
    features: [
      'Simple Academic theme',
      'Unlimited report cards for 6 months',
      'Excel import + photo matching',
      'Print-ready PDF per student',
      'Download-all ZIP bundle',
    ],
  },
  {
    id: 'modern',
    name: 'Modern School',
    priceInr: 578,
    priceUsd: 6.99,
    durationMonths: PLAN_DURATION_MONTHS,
    tagline: 'Bold contemporary card',
    features: [
      'Everything in Simple',
      'Modern School theme (performance bars)',
      'Unlimited report cards for 6 months',
      'Priority layout engine',
    ],
  },
  {
    id: 'holistic',
    name: 'Holistic Progress',
    priceInr: 859,
    priceUsd: 10.99,
    durationMonths: PLAN_DURATION_MONTHS,
    recommended: true,
    tagline: 'The complete holistic card',
    features: [
      'Everything in Modern',
      'Holistic Progress Card (co-scholastic, skills, stars)',
      'Unlimited report cards for 6 months',
      'All future themes included',
      'Priority support',
    ],
  },
];

export const getPlanById = (id?: string | null): StudioPlan | undefined =>
  id ? STUDIO_PLANS.find((plan) => plan.id === id) : undefined;

export const isAdminEmail = (email: string): boolean =>
  ADMIN_EMAILS.some((adminEmail) => adminEmail.toLowerCase() === email.trim().toLowerCase());
