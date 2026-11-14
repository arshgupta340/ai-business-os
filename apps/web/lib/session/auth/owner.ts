/** The signed-in owner as the shell shows it. */
export type Owner = {
  email: string;
  displayName: string;
};

/**
 * Seeded demo owner for mock mode. It mirrors the one seeded owner in
 * docs/SPEC.md 2.1. The email is the placeholder used in docs/API.md.
 */
export const DEMO_OWNER: Owner = {
  email: 'owner@example.com',
  displayName: 'Demo Owner',
};
