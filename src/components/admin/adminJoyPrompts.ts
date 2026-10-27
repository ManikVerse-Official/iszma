/**
 * Admin Joy copy shared by the full console and the floating dock.
 *
 * Kept dependency-free on purpose: the dock's view can be rendered in a test (or
 * before the admin session is known) without pulling in Supabase or the admin
 * service layer.
 */

export const ADMIN_JOY_WELCOME =
  'Admin assistant ready. I can change product and greeting prices (including a whole tier or the entire catalogue), add, rename, publish or delete items, switch the Game Zone on/off or into maintenance, set the brand name, tagline and logo, and read the sales and audit reports. Ask “what can you do” for the full list — I confirm before anything sensitive runs.';

/** One-tap commands shown by both the full console and the floating dock. */
export const ADMIN_JOY_EXAMPLES = [
  "Change product XYZ's price to ₹399.",
  'Change the Plus greeting card price to ₹89.',
  'Increase all theme prices by 10%.',
  'Turn off the Game Zone.',
  'Put the game in maintenance mode.',
  'Set the brand tagline to Cards that come alive.',
  'Show the audit log.',
  'Mujhe greeting card upload karna hai.',
  'Help me fix a pricing issue.',
];
