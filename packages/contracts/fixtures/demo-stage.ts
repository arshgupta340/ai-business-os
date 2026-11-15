// The three stage shops of the demo (Arsh, 2026-11-15): a pizza place, a barbershop and a salon. The judge
// picks one, the presenter uploads that shop's two PDFs, and the Build screen shows that shop's phone
// number. Each shop is a business of its own with its own agent and its own number, set up before the demo
// by `npm run seed:demo-stage`.
//
// All three are made up. The names are generic on purpose and no real San Luis Obispo business is meant.
// Payments are Square SANDBOX only.
//
// One source for the server, the seed, the stage PDFs and the web panel. Browser-safe: no Node-only module.
import { BARBER_BUSINESS_ID, PIZZA_BUSINESS_ID, type AgentSpec, type CatalogItem, type HoursKey, type HoursValue, type ServiceOffering } from '../src/index';
import { BARBER_CAPABILITIES, PIZZA_CAPABILITIES } from './agents';
import { CATALOG_SYNCED_AT } from './catalog';

export type StageShopKey = 'pizza' | 'barber' | 'salon';
export const STAGE_SHOP_KEYS: readonly StageShopKey[] = ['pizza', 'barber', 'salon'];

/** The salon is a third business. The pizza place and the barbershop reuse the two seeded businesses. */
export const SALON_BUSINESS_ID = 'biz_salon_01';

export type StageFact = { kind: 'hours' | 'policy' | 'contact' | 'faq' | 'service'; key: string; value: Record<string, string | number | boolean> };

export interface StageShop {
  key: StageShopKey;
  businessId: string;
  /** The name the agent says, the dashboard shows and the PDFs carry. */
  name: string;
  category: string;
  /** What the judge is offered: "Pizza place", "Barbershop", "Salon". */
  kindLabel: string;
  /** One line under the choice. */
  blurb: string;
  /** What a caller does on this line, for the panel and the script. */
  callerAction: string;
  address: string;
  hours: Record<HoursKey, HoursValue>;
  /** The hours in words, for the panel and the PDFs. */
  hoursText: string;
  /** The published agent's spec, without its version number (the seed assigns it). */
  agent: Omit<AgentSpec, 'version'>;
  /** What the phone line says at pickup (the AgentPhone agent's begin message). */
  beginMessage: string;
  /** The two stage files. Uploading either one selects this shop. */
  files: { info: string; faq: string };
  /** The title of the first file's content: "Menu" or "Services". */
  infoTitle: string;
  /** The sentence the presenter sends with the files. */
  prompt: string;
  catalog: CatalogItem[];
  services: ServiceOffering[];
  /** Verified facts besides the services: hours, address, policies, FAQs. */
  facts: StageFact[];
}

const everyDay = (open: string, close: string): Record<HoursKey, HoursValue> =>
  ({ mon: { open, close }, tue: { open, close }, wed: { open, close }, thu: { open, close }, fri: { open, close }, sat: { open, close }, sun: { open, close } });
const hoursFacts = (hours: Record<HoursKey, HoursValue>): StageFact[] =>
  (Object.keys(hours) as HoursKey[]).map((day) => ({ kind: 'hours', key: day, value: hours[day] }));
const faq = (key: string, question: string, answer: string): StageFact => ({ kind: 'faq', key, value: { question, answer } });

// ---- Main Street Pizza ----

export const STAGE_PIZZA_SIZES = [
  { code: 'SM', name: 'Small', inches: 10, priceMinor: 1500 },
  { code: 'MD', name: 'Medium', inches: 12, priceMinor: 2500 },
  { code: 'LG', name: 'Large', inches: 14, priceMinor: 3500 },
] as const;

/** [slug for the placeholder IDs, name, what is on it]. Every pizza costs the same in each size. */
const STAGE_PIZZAS: readonly (readonly [string, string, string])[] = [
  ['CHEESE', 'Cheese', 'Mozzarella and red sauce'],
  ['PEPPERONI', 'Pepperoni', 'Mozzarella and pepperoni'],
  ['MARGHERITA', 'Margherita', 'Fresh mozzarella, tomato and basil'],
  ['MEATLOVERS', 'Meat Lovers', 'Pepperoni, Italian sausage, bacon and ham'],
  ['VEGGIE', 'Veggie', 'Bell peppers, onions, mushrooms, black olives and tomatoes'],
  ['HAWAIIAN', 'Hawaiian', 'Ham and pineapple'],
  ['BBQCHICKEN', 'BBQ Chicken', 'BBQ sauce, grilled chicken, red onions and cilantro'],
  ['SUPREME', 'Supreme', 'Pepperoni, Italian sausage, bell peppers, onions and mushrooms'],
];

/** Square IDs are placeholders (`SQ_...`); the seed maps them to real sandbox IDs. No modifier list. */
export const stagePizzaCatalog: CatalogItem[] = STAGE_PIZZAS.map(([slug, name, description]) => ({
  squareItemId: `SQ_ITEM_MS_${slug}`,
  businessId: PIZZA_BUSINESS_ID,
  name,
  description,
  available: true,
  variations: STAGE_PIZZA_SIZES.map((s) => ({ id: `SQ_VAR_MS_${slug}_${s.code}`, name: s.name, priceMinor: s.priceMinor, currency: 'USD' as const })),
  modifierLists: [],
  syncedAt: CATALOG_SYNCED_AT,
}));

// Open until 2 AM (Arsh, 2026-11-15). A close at or before the open means the next morning: the pickup check
// and the phone prompt both read 11:00 to 02:00 as 11 AM to 2 AM the next morning.
const pizzaHours = everyDay('11:00', '02:00');

const pizzaShop: StageShop = {
  key: 'pizza',
  businessId: PIZZA_BUSINESS_ID,
  name: 'Main Street Pizza',
  category: 'restaurant',
  kindLabel: 'Pizza place',
  blurb: 'Takes pickup orders by phone',
  callerAction: 'Call to order a pizza for pickup',
  address: '123 Main Street, San Luis Obispo, CA 93401',
  hours: pizzaHours,
  hoursText: 'Open every day, 11 AM to 2 AM',
  agent: {
    id: 'agt_pizza_01',
    businessId: PIZZA_BUSINESS_ID,
    template: 'restaurant_order_taker',
    name: 'Pizza Order Assistant',
    channel: 'phone',
    goal: 'Answer menu and hours questions and take pickup orders, each sent to the owner for approval.',
    knowledgeScopes: ['business_profile', 'catalog', 'hours', 'order_policies', 'faq'],
    capabilities: PIZZA_CAPABILITIES,
    writePolicy: 'owner_approval_each_action_bundle',
    escalation: 'explain_unsupported_or_offer_callback',
    status: 'live',
    guardrailVersion: 'v1',
    greeting: 'Hi, thanks for calling Main Street Pizza. You are speaking with an AI assistant. I can answer menu questions and take pickup orders. What can I get for you?',
  },
  beginMessage: 'Thank you for calling Main Street Pizza. This is an AI assistant. How can I help you?',
  files: { info: 'MainStreetPizzaMenu.pdf', faq: 'MainStreetPizzaFAQs.pdf' },
  infoTitle: 'Menu',
  prompt: 'Create a voice calling agent for this pizza place using the attached menu and FAQs. It should answer customer questions, take pickup orders, confirm the details with the customer, and submit each order for my approval.',
  catalog: stagePizzaCatalog,
  services: [],
  facts: [
    ...hoursFacts(pizzaHours),
    { kind: 'contact', key: 'address', value: { address: '123 Main Street, San Luis Obispo, CA 93401' } },
    { kind: 'policy', key: 'pickup_only', value: { pickupOnly: true, text: 'This phone line takes pickup orders only.' } },
    { kind: 'policy', key: 'special_requests', value: { allowed: false, text: 'Phone orders are for the pizzas as they are listed on the menu. For changes to toppings, crust or sauce, please ask at the counter.' } },
    faq('hours', 'When are you open?', 'Every day, 11 AM to 2 AM.'),
    faq('sizes', 'What sizes do the pizzas come in?', 'Three sizes: Small is 10 inch, Medium is 12 inch and Large is 14 inch.'),
    faq('price', 'How much is a pizza?', 'Every pizza costs the same. A Small is $15, a Medium is $25 and a Large is $35, before tax.'),
    faq('no_meat', 'Which pizzas have no meat?', 'Cheese, Margherita and Veggie.'),
    faq('gluten_free', 'Do you have a gluten-free crust?', 'Yes, at the counter. Phone orders are for the pizzas as they are listed on the menu.'),
    faq('changes', 'Can I change the toppings on a phone order?', 'Not on this phone line. Phone orders are for the pizzas as they are listed on the menu. For changes, please ask at the counter.'),
    // Arsh, 2026-11-14: an order takes 20 minutes (ORDER_PREP_MINUTES in the server).
    faq('pickup_time', 'How long does a pickup order take?', 'About 20 minutes.'),
    faq('delivery', 'Do you deliver?', 'Not from this phone line. It takes pickup orders only.'),
    faq('confirmation', 'How is my phone order confirmed?', 'The shop reviews every phone order before it is accepted.'),
  ],
};

// ---- Classic Cuts Barbershop ----

const bookingHours = everyDay('09:00', '19:00');
const bookingPolicy: StageFact = { kind: 'policy', key: 'min_notice', value: { minutes: 60, text: 'Bookings need at least one hour of notice.' } };

const barberServices: ServiceOffering[] = [
  { id: 'svc_haircut', businessId: BARBER_BUSINESS_ID, name: 'Haircut', durationMinutes: 30, priceMinor: 3000, currency: 'USD', bufferMinutes: 5 },
  { id: 'svc_beard_trim', businessId: BARBER_BUSINESS_ID, name: 'Beard trim', durationMinutes: 15, priceMinor: 1500, currency: 'USD', bufferMinutes: 5 },
  { id: 'svc_haircut_beard', businessId: BARBER_BUSINESS_ID, name: 'Haircut and beard', durationMinutes: 45, priceMinor: 4000, currency: 'USD', bufferMinutes: 5 },
  { id: 'svc_kids_cut', businessId: BARBER_BUSINESS_ID, name: 'Kids haircut', durationMinutes: 20, priceMinor: 2000, currency: 'USD', bufferMinutes: 5 },
];

const barberShop: StageShop = {
  key: 'barber',
  businessId: BARBER_BUSINESS_ID,
  name: 'Classic Cuts Barbershop',
  category: 'barbershop',
  kindLabel: 'Barbershop',
  blurb: 'Books haircut appointments by phone',
  callerAction: 'Call to book an appointment',
  address: '456 Main Street, San Luis Obispo, CA 93401',
  hours: bookingHours,
  hoursText: 'Open every day, 9 AM to 7 PM',
  agent: {
    id: 'agt_barber_01',
    businessId: BARBER_BUSINESS_ID,
    template: 'appointment_booker',
    name: 'Booking Assistant',
    channel: 'phone',
    goal: 'Book haircut and beard appointments on the shop calendar, each sent to the owner for approval.',
    knowledgeScopes: ['business_profile', 'hours', 'services', 'faq'],
    capabilities: BARBER_CAPABILITIES,
    writePolicy: 'owner_approval_each_action_bundle',
    escalation: 'explain_unsupported_or_offer_callback',
    status: 'live',
    guardrailVersion: 'v1',
    greeting: 'Hi, thanks for calling Classic Cuts Barbershop. You are speaking with an AI assistant. I can tell you about our services and book an appointment. How can I help?',
  },
  beginMessage: 'Thank you for calling Classic Cuts Barbershop. This is an AI assistant. How can I help you?',
  files: { info: 'ClassicCutsServices.pdf', faq: 'ClassicCutsFAQs.pdf' },
  infoTitle: 'Services',
  prompt: 'Create a voice calling agent for this barbershop using the attached services and FAQs. It should answer customer questions, book appointments, confirm the details with the customer, and submit each booking for my approval.',
  catalog: [],
  services: barberServices,
  facts: [
    ...hoursFacts(bookingHours),
    { kind: 'contact', key: 'address', value: { address: '456 Main Street, San Luis Obispo, CA 93401' } },
    bookingPolicy,
    faq('hours', 'When are you open?', 'Every day, 9 AM to 7 PM.'),
    faq('walk_ins', 'Do you take walk-ins?', 'When a chair is free. Booking is the sure way.'),
    faq('kids_cuts', 'Do you cut kids hair?', 'Yes. Book a kids haircut.'),
    faq('payment', 'How can I pay?', 'Cash or card, in the shop after your cut.'),
    faq('late', 'What if I am running late?', 'We hold your chair for ten minutes.'),
    faq('confirmation', 'How is my booking confirmed?', 'The shop reviews every phone booking before it is confirmed.'),
  ],
};

// ---- Glow Hair Salon ----

const salonServices: ServiceOffering[] = [
  { id: 'svc_salon_cut', businessId: SALON_BUSINESS_ID, name: 'Haircut and style', durationMinutes: 60, priceMinor: 6500, currency: 'USD', bufferMinutes: 10 },
  { id: 'svc_salon_blowout', businessId: SALON_BUSINESS_ID, name: 'Blowout', durationMinutes: 45, priceMinor: 4500, currency: 'USD', bufferMinutes: 10 },
  { id: 'svc_salon_color', businessId: SALON_BUSINESS_ID, name: 'Color touch-up', durationMinutes: 90, priceMinor: 9500, currency: 'USD', bufferMinutes: 10 },
  { id: 'svc_salon_treatment', businessId: SALON_BUSINESS_ID, name: 'Deep conditioning treatment', durationMinutes: 30, priceMinor: 3500, currency: 'USD', bufferMinutes: 10 },
];

const salonShop: StageShop = {
  key: 'salon',
  businessId: SALON_BUSINESS_ID,
  name: 'Glow Hair Salon',
  category: 'salon',
  kindLabel: 'Salon',
  blurb: 'Books hair appointments by phone',
  callerAction: 'Call to book an appointment',
  address: '789 Main Street, San Luis Obispo, CA 93401',
  hours: bookingHours,
  hoursText: 'Open every day, 9 AM to 7 PM',
  agent: {
    id: 'agt_salon_01',
    businessId: SALON_BUSINESS_ID,
    template: 'appointment_booker',
    name: 'Booking Assistant',
    channel: 'phone',
    goal: 'Book hair appointments on the salon calendar, each sent to the owner for approval.',
    knowledgeScopes: ['business_profile', 'hours', 'services', 'faq'],
    capabilities: BARBER_CAPABILITIES,
    writePolicy: 'owner_approval_each_action_bundle',
    escalation: 'explain_unsupported_or_offer_callback',
    status: 'live',
    guardrailVersion: 'v1',
    greeting: 'Hi, thanks for calling Glow Hair Salon. You are speaking with an AI assistant. I can tell you about our services and book an appointment. How can I help?',
  },
  beginMessage: 'Thank you for calling Glow Hair Salon. This is an AI assistant. How can I help you?',
  files: { info: 'GlowHairSalonServices.pdf', faq: 'GlowHairSalonFAQs.pdf' },
  infoTitle: 'Services',
  prompt: 'Create a voice calling agent for this salon using the attached services and FAQs. It should answer customer questions, book appointments, confirm the details with the customer, and submit each booking for my approval.',
  catalog: [],
  services: salonServices,
  facts: [
    ...hoursFacts(bookingHours),
    { kind: 'contact', key: 'address', value: { address: '789 Main Street, San Luis Obispo, CA 93401' } },
    bookingPolicy,
    faq('hours', 'When are you open?', 'Every day, 9 AM to 7 PM.'),
    faq('walk_ins', 'Do you take walk-ins?', 'When a stylist is free. Booking is the sure way.'),
    faq('color', 'Do I need a consultation for color?', 'Not for a color touch-up. For a full color change, book a haircut and style first and ask your stylist.'),
    faq('payment', 'How can I pay?', 'Cash or card, in the salon after your appointment.'),
    faq('late', 'What if I am running late?', 'We hold your appointment for ten minutes.'),
    faq('confirmation', 'How is my booking confirmed?', 'The salon reviews every phone booking before it is confirmed.'),
  ],
};

export const STAGE_SHOPS: Record<StageShopKey, StageShop> = { pizza: pizzaShop, barber: barberShop, salon: salonShop };
export const stageShops: readonly StageShop[] = STAGE_SHOP_KEYS.map((k) => STAGE_SHOPS[k]);

/** The shop a stage file belongs to, by its file name (either of the shop's two files). Undefined for any other file. */
export function stageShopForFileName(fileName: string): StageShop | undefined {
  const name = fileName.trim().toLowerCase();
  return stageShops.find((s) => s.files.info.toLowerCase() === name || s.files.faq.toLowerCase() === name);
}

/** The shop of a business, if the business is one of the three stage shops. */
export function stageShopForBusiness(businessId: string): StageShop | undefined {
  return stageShops.find((s) => s.businessId === businessId);
}
