// Business facts for both businesses (SPEC 2.7 and 2.9): one hours fact per weekday, policies,
// contact facts, FAQs and, for the barbershop, services as facts of kind `service`.
// Plus the uploaded menu, its draft menu_item fact and the open conflict it causes (AC-02).
import {
  BARBER_BUSINESS_ID,
  PIZZA_BUSINESS_ID,
  type BusinessFact,
  type FactConflict,
  type FactKind,
  type FactSourceType,
  type FileRecord,
  type HoursKey,
  type HoursValue,
  type JsonValue,
  type ServiceOffering,
} from '../src/index';
import { SQ } from './catalog';
import { SEEDED_AT } from './world';

type FactInput = {
  id: string;
  businessId: string;
  kind: FactKind;
  key: string;
  value: JsonValue;
  sourceType: FactSourceType;
  sourceRef: string;
};

function verifiedFact(f: FactInput): BusinessFact {
  return { ...f, status: 'verified', confidence: 1, version: 1, verifiedAt: SEEDED_AT, createdAt: SEEDED_AT, updatedAt: SEEDED_AT };
}

function hoursFacts(businessId: string, prefix: string, week: Record<HoursKey, HoursValue>): BusinessFact[] {
  return (Object.keys(week) as HoursKey[]).map((day) =>
    verifiedFact({ id: `fact_${prefix}_hours_${day}`, businessId, kind: 'hours', key: day, value: week[day], sourceType: 'seed', sourceRef: 'seed:hours' }),
  );
}

// ---- Demo Pizza Co. ----

export const pizzaHours: Record<HoursKey, HoursValue> = {
  mon: { open: '11:00', close: '21:00' },
  tue: { open: '11:00', close: '21:00' },
  wed: { open: '11:00', close: '21:00' },
  thu: { open: '11:00', close: '21:00' },
  fri: { open: '11:00', close: '22:00' },
  sat: { open: '11:00', close: '22:00' },
  sun: { open: '12:00', close: '20:00' },
};

const pizzaPolicyFacts: BusinessFact[] = [
  verifiedFact({ id: 'fact_pizza_policy_pickup_only', businessId: PIZZA_BUSINESS_ID, kind: 'policy', key: 'pickup_only',
    value: { pickupOnly: true, text: 'Pickup only. We do not deliver.' }, sourceType: 'owner_chat', sourceRef: 'bld_demo_00' }),
  verifiedFact({ id: 'fact_pizza_policy_pickup_window', businessId: PIZZA_BUSINESS_ID, kind: 'policy', key: 'pickup_window',
    value: { minutes: 20 }, sourceType: 'owner_chat', sourceRef: 'bld_demo_00' }),
  verifiedFact({ id: 'fact_pizza_policy_special_requests', businessId: PIZZA_BUSINESS_ID, kind: 'policy', key: 'special_requests',
    value: { allowed: true, maxLength: 140 }, sourceType: 'owner_chat', sourceRef: 'bld_demo_00' }),
  verifiedFact({ id: 'fact_pizza_policy_no_phone_refunds', businessId: PIZZA_BUSINESS_ID, kind: 'policy', key: 'no_refunds_by_phone',
    value: { text: 'Refunds are handled in the shop, not over the phone.' }, sourceType: 'owner_ui', sourceRef: 'knowledge_review' }),
  verifiedFact({ id: 'fact_pizza_policy_message_consent', businessId: PIZZA_BUSINESS_ID, kind: 'policy', key: 'message_consent',
    value: { required: true, wording: 'May we send you one text message with your payment link at that number?' }, sourceType: 'owner_chat', sourceRef: 'bld_demo_00' }),
];

const pizzaContactFacts: BusinessFact[] = [
  verifiedFact({ id: 'fact_pizza_contact_phone', businessId: PIZZA_BUSINESS_ID, kind: 'contact', key: 'phone', value: { phone: '+15555550100' }, sourceType: 'seed', sourceRef: 'seed:contact' }),
  verifiedFact({ id: 'fact_pizza_contact_address', businessId: PIZZA_BUSINESS_ID, kind: 'contact', key: 'address',
    value: { address: '100 Demo Street, San Luis Obispo, CA 93401' }, sourceType: 'seed', sourceRef: 'seed:contact' }),
];

const pizzaFaqFacts: BusinessFact[] = [
  verifiedFact({ id: 'fact_pizza_faq_gluten_free', businessId: PIZZA_BUSINESS_ID, kind: 'faq', key: 'gluten_free',
    value: { question: 'Do you have gluten-free crust?', answer: 'Not yet. All our crusts contain wheat.' }, sourceType: 'owner_ui', sourceRef: 'knowledge_review' }),
  verifiedFact({ id: 'fact_pizza_faq_parking', businessId: PIZZA_BUSINESS_ID, kind: 'faq', key: 'parking',
    value: { question: 'Is there parking?', answer: 'There are two pickup spots in front of the shop.' }, sourceType: 'owner_ui', sourceRef: 'knowledge_review' }),
];

/** The uploaded menu (P-12). Its extraction produced one draft menu_item fact and one conflict. */
export const menuFile = {
  id: 'file_menu_01',
  businessId: PIZZA_BUSINESS_ID,
  name: 'menu.pdf',
  mime: 'application/pdf',
  sizeBytes: 182044,
  sha256: 'sha256:4be05c7d1f2a9e83b6c0d4e7f81a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c',
  extractionState: 'EXTRACTED',
  draftFactIds: ['fact_pizza_menu_marg_lg_d1'],
  conflictIds: ['cfl_pizza_01'],
  createdAt: '2026-11-14T18:05:00Z',
} satisfies FileRecord;

/** A `menu_item` fact comes only from an upload, stays draft and is never a price source (SPEC 2.9). */
export const menuItemDraftFact = {
  id: 'fact_pizza_menu_marg_lg_d1',
  businessId: PIZZA_BUSINESS_ID,
  kind: 'menu_item',
  key: 'margherita_large',
  value: { itemName: 'Margherita', variationName: 'Large', priceMinor: 2100, currency: 'USD' },
  sourceType: 'upload',
  sourceRef: 'menu.pdf page 1',
  fileId: menuFile.id,
  status: 'draft',
  confidence: 0.82,
  version: 1,
  createdAt: '2026-11-14T18:05:30Z',
  updatedAt: '2026-11-14T18:05:30Z',
} satisfies BusinessFact;

/** The menu says Large Margherita 2100; Square says 2000. Open and required, so publish is blocked. */
export const menuPriceConflict = {
  id: 'cfl_pizza_01',
  businessId: PIZZA_BUSINESS_ID,
  kind: 'menu_item',
  key: 'margherita_large',
  required: true,
  candidates: [
    { factId: menuItemDraftFact.id, sourceType: 'upload', sourceRef: 'menu.pdf page 1', value: { priceMinor: 2100, variationId: SQ.varMargheritaLarge } },
    { sourceType: 'square', sourceRef: 'cat_marg_lg', value: { priceMinor: 2000, variationId: SQ.varMargheritaLarge } },
  ],
  state: 'open',
  createdAt: '2026-11-14T18:05:30Z',
} satisfies FactConflict;

/** The same conflict after the owner kept the Square price (response of POST /api/conflicts/:id/resolve). */
export const menuPriceConflictResolved = {
  ...menuPriceConflict,
  state: 'resolved',
  resolvedBy: 'usr_owner_01',
  resolvedAt: '2026-11-14T20:31:00Z',
} satisfies FactConflict;

/** The draft made by the Friday hours edit (Flow D, D3). The pending fact_edit approval points at it. */
export const fridayHoursDraftFact = {
  id: 'fact_pizza_hours_fri_d2',
  businessId: PIZZA_BUSINESS_ID,
  kind: 'hours',
  key: 'fri',
  value: { open: '11:00', close: '23:00' },
  sourceType: 'owner_chat',
  sourceRef: 'bld_demo_01',
  status: 'draft',
  confidence: 1,
  version: 2,
  supersedesId: 'fact_pizza_hours_fri',
  createdAt: '2026-11-14T20:28:00Z',
  updatedAt: '2026-11-14T20:28:00Z',
} satisfies BusinessFact;

export const pizzaVerifiedFacts: BusinessFact[] = [
  ...hoursFacts(PIZZA_BUSINESS_ID, 'pizza', pizzaHours),
  ...pizzaPolicyFacts,
  ...pizzaContactFacts,
  ...pizzaFaqFacts,
];

export const pickupWindowDraftFact: BusinessFact = { ...menuItemDraftFact, id: 'fact_pizza_draft_pickup', kind: 'policy', key: 'pickup_window', value: { minutes: 25 }, confidence: 0.58 };
export const pickupWindowConflict: FactConflict = {
  id: 'cfl_pizza_02', businessId: PIZZA_BUSINESS_ID, kind: 'policy', key: 'pickup_window', required: false, state: 'open', createdAt: menuPriceConflict.createdAt,
  candidates: [
    { factId: pickupWindowDraftFact.id, sourceType: 'upload', value: { minutes: 25 } },
    { factId: 'fact_pizza_policy_pickup_window', sourceType: 'owner_chat', value: { minutes: 20 } },
  ],
};
export const pizzaFacts: BusinessFact[] = [...pizzaVerifiedFacts, menuItemDraftFact, fridayHoursDraftFact, pickupWindowDraftFact];

// ---- Demo Barbershop ----

export const barberHours: Record<HoursKey, HoursValue> = {
  mon: { closed: true },
  tue: { open: '09:00', close: '18:00' },
  wed: { open: '09:00', close: '18:00' },
  thu: { open: '09:00', close: '18:00' },
  fri: { open: '09:00', close: '18:00' },
  sat: { open: '09:00', close: '16:00' },
  sun: { closed: true },
};

export const serviceHaircut = {
  id: 'svc_haircut',
  businessId: BARBER_BUSINESS_ID,
  name: 'Haircut',
  durationMinutes: 30,
  priceMinor: 3000,
  currency: 'USD',
  bufferMinutes: 5,
} satisfies ServiceOffering;

export const serviceBeardTrim = {
  id: 'svc_beard_trim',
  businessId: BARBER_BUSINESS_ID,
  name: 'Beard trim',
  durationMinutes: 15,
  priceMinor: 1500,
  currency: 'USD',
  bufferMinutes: 5,
} satisfies ServiceOffering;

export const serviceHaircutBeard = {
  id: 'svc_haircut_beard',
  businessId: BARBER_BUSINESS_ID,
  name: 'Haircut and beard',
  durationMinutes: 45,
  priceMinor: 4000,
  currency: 'USD',
  bufferMinutes: 5,
} satisfies ServiceOffering;

export const barberServices = [serviceHaircut, serviceBeardTrim, serviceHaircutBeard] satisfies ServiceOffering[];

const barberServiceFacts: BusinessFact[] = barberServices.map((s) =>
  verifiedFact({ id: `fact_barber_${s.id}`, businessId: BARBER_BUSINESS_ID, kind: 'service', key: s.id, value: { ...s }, sourceType: 'owner_chat', sourceRef: 'bld_demo_b0' }),
);

const barberPolicyFacts: BusinessFact[] = [
  verifiedFact({ id: 'fact_barber_policy_min_notice', businessId: BARBER_BUSINESS_ID, kind: 'policy', key: 'min_notice',
    value: { minutes: 120, text: 'Bookings need at least two hours of notice.' }, sourceType: 'owner_chat', sourceRef: 'bld_demo_b0' }),
  verifiedFact({ id: 'fact_barber_policy_no_phone_refunds', businessId: BARBER_BUSINESS_ID, kind: 'policy', key: 'no_refunds_by_phone',
    value: { text: 'Refunds are handled in the shop, not over the phone.' }, sourceType: 'owner_ui', sourceRef: 'knowledge_review' }),
  verifiedFact({ id: 'fact_barber_policy_message_consent', businessId: BARBER_BUSINESS_ID, kind: 'policy', key: 'message_consent',
    value: { required: true, wording: 'May we send you one text message to confirm your booking at that number?' }, sourceType: 'owner_chat', sourceRef: 'bld_demo_b0' }),
];

const barberContactFacts: BusinessFact[] = [
  verifiedFact({ id: 'fact_barber_contact_phone', businessId: BARBER_BUSINESS_ID, kind: 'contact', key: 'phone', value: { phone: '+15555550200' }, sourceType: 'seed', sourceRef: 'seed:contact' }),
  verifiedFact({ id: 'fact_barber_contact_address', businessId: BARBER_BUSINESS_ID, kind: 'contact', key: 'address',
    value: { address: '200 Demo Avenue, San Luis Obispo, CA 93401' }, sourceType: 'seed', sourceRef: 'seed:contact' }),
];

const barberFaqFacts: BusinessFact[] = [
  verifiedFact({ id: 'fact_barber_faq_kids', businessId: BARBER_BUSINESS_ID, kind: 'faq', key: 'kids_cuts',
    value: { question: 'Do you cut kids hair?', answer: 'Yes. Book a regular haircut.' }, sourceType: 'owner_ui', sourceRef: 'knowledge_review' }),
  verifiedFact({ id: 'fact_barber_faq_walk_ins', businessId: BARBER_BUSINESS_ID, kind: 'faq', key: 'walk_ins',
    value: { question: 'Do you take walk-ins?', answer: 'When a chair is free. Booking is the sure way.' }, sourceType: 'owner_ui', sourceRef: 'knowledge_review' }),
];

export const barberFacts: BusinessFact[] = [
  ...hoursFacts(BARBER_BUSINESS_ID, 'barber', barberHours),
  ...barberServiceFacts,
  ...barberPolicyFacts,
  ...barberContactFacts,
  ...barberFaqFacts,
];

export const servicesFile: FileRecord = {
  id: 'file_services_01', businessId: BARBER_BUSINESS_ID, name: 'services.csv', mime: 'text/csv', sizeBytes: 912,
  sha256: 'sha256:9a3e5f1c0b2d4e6f8a1c3e5d7b9f0a2c4e6d8f0b1a3c5e7d9f1b3a5c7e9d1f3a',
  extractionState: 'EXTRACTED', draftFactIds: ['fact_barber_draft_kids'], conflictIds: [], createdAt: '2026-11-14T17:30:00Z',
};
export const kidsServiceDraftFact: BusinessFact = {
  id: 'fact_barber_draft_kids', businessId: BARBER_BUSINESS_ID, kind: 'service', key: 'svc_kids',
  value: { id: 'svc_kids', businessId: BARBER_BUSINESS_ID, name: 'Kids cut', durationMinutes: 20, priceMinor: 2000, currency: 'USD' },
  sourceType: 'upload', fileId: servicesFile.id, status: 'draft', confidence: 0.71, version: 1,
  createdAt: servicesFile.createdAt, updatedAt: servicesFile.createdAt,
};
// The draft stays out of barberFacts, which the database seed (packages/db/src/seed/world.ts) stores as
// the verified barbershop facts with no files row; allFacts carries it.
export const allFacts: BusinessFact[] = [...pizzaFacts, ...barberFacts, kidsServiceDraftFact];
export const factConflicts: FactConflict[] = [menuPriceConflict, pickupWindowConflict];
export const files: FileRecord[] = [menuFile, servicesFile];
