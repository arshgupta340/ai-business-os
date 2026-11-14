/** The signed-in owner as the shell shows it. */
export type Owner = {
  /** The auth user id. Cached data belongs to this owner, so a change of id clears it. */
  id: string;
  email: string;
  displayName: string;
};

/**
 * Seeded demo owner for mock mode. It mirrors the one seeded owner in
 * docs/SPEC.md 2.1. The id and email are the placeholders used in the
 * contract examples and docs/API.md.
 */
export const DEMO_OWNER: Owner = {
  id: 'usr_owner_01',
  email: 'owner@example.com',
  displayName: 'Demo Owner',
};
