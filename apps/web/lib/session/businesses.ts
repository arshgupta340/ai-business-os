/**
 * The owner's businesses for the top bar selector.
 *
 * This is a seeded list from docs/SPEC.md 2.1 and docs/DATA-MODEL.md 6.1.
 * A later task replaces SEEDED_BUSINESSES with the result of
 * `GET /api/businesses` (docs/API.md 3.1). Field names follow docs/API.md:
 * the list item carries id, name, category and timezone. The full `Business`
 * (GET /api/businesses/:id) also carries
 * `contact: { phone?, email?, address? }`, where `contact.address` is the
 * business location. The list does not return contact, so it is optional here
 * and the seeded list leaves it out rather than invent values.
 * When packages/contracts ships the Business schema, import it here instead.
 */
export type BusinessContact = {
  phone?: string;
  email?: string;
  address?: string;
};

export type BusinessSummary = {
  id: string;
  name: string;
  category: string;
  timezone: string;
  contact?: BusinessContact;
};

export const DEFAULT_BUSINESS_ID = 'biz_pizza_01';

export const SEEDED_BUSINESSES: readonly BusinessSummary[] = [
  {
    id: 'biz_pizza_01',
    name: 'Demo Pizza Co.',
    category: 'restaurant',
    timezone: 'America/Los_Angeles',
  },
  {
    id: 'biz_barber_01',
    name: 'Demo Barbershop',
    category: 'barbershop',
    timezone: 'America/Los_Angeles',
  },
];
