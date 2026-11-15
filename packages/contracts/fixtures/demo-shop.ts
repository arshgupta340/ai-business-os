// The demo shop's menu and facts (issue #161): 16 pizzas in three sizes, every pizza the same price per
// size, pizzas only, no modifier list. The pizza names and toppings are from the public ordering page of
// Woodstock's Pizza in San Luis Obispo, read by Saina on 2026-11-14; the toppings text is her plain list,
// not the shop's wording. The sizes and prices are simplified for the demo and are NOT the shop's price
// list. Payments on this menu are Square SANDBOX only.
//
// This is a separate export from `pizzaCatalog` on purpose: many tests on both sides pin Margherita and
// Pepperoni from that fixture. `npm run seed:square -- --demo-shop` loads this menu and these facts for
// the pizza business in place of the two-pizza menu.
import { PIZZA_BUSINESS_ID, type CatalogItem, type HoursKey, type HoursValue } from '../src/index';
import { CATALOG_SYNCED_AT } from './catalog';

/** The shop's name (Arsh, 2026-11-14). The seed writes it to the business row; the phone agent reads it from there. */
export const DEMO_SHOP_NAME = "Woodstock's Pizza";

export const DEMO_SHOP_SIZES = [
  { code: 'SM', name: 'Small', inches: 8, priceMinor: 1495 },
  { code: 'MD', name: 'Medium', inches: 12, priceMinor: 2595 },
  { code: 'LG', name: 'Large', inches: 14, priceMinor: 3445 },
] as const;

/** [slug for the placeholder IDs, name, what is on it]. */
const DEMO_SHOP_PIZZAS: readonly (readonly [string, string, string])[] = [
  ['ALLMEAT', 'All Meat Orgy', 'Canadian-style bacon, pepperoni, Italian sausage, salami, applewood-smoked bacon'],
  ['BBQBIRD', 'BBQ Bird', 'BBQ sauce, BBQ chicken, red onions, applewood-smoked bacon'],
  ['BUTTERCHICKEN', 'Butter Chicken Makhani Pie', 'Butter chicken simmer sauce, cooked tomatoes, red onions, makhani grilled chicken, ranch drizzle, cilantro'],
  ['CHEESE', 'Cheese', 'Mozzarella and red sauce'],
  ['CLASSIC', 'Classic', 'Pepperoni, Italian sausage, black olives, mushrooms, white onions'],
  ['GARLICBIRD', 'Garlic Bird', 'Creamy garlic sauce, grilled chicken, mushrooms, red onions, roma tomatoes'],
  ['GRATEFULVEG', 'Grateful Veg', 'Bell peppers, white onions, roma tomatoes, black olives, mushrooms'],
  ['HAWAIIAN', 'Hawaiian', 'Canadian-style bacon, pineapple, extra mozzarella'],
  ['CARNITAS', "Kickin' Carnitas", 'Southern chipotle sauce, carnitas, bacon, red onions, cilantro'],
  ['MUSTANG', 'Mustang', 'Linguica, pepperoni, white onions, bell peppers, pineapple'],
  ['PEPPERONI', 'Pepperoni', 'Mozzarella and pepperoni'],
  ['PESTO', 'Pesto Primavera', 'Pesto sauce, broccoli, artichoke hearts, red onions, roma tomatoes'],
  ['SRIRACHA', 'Sriracha-Cha', 'Creamy sriracha sauce, applewood-smoked bacon, pineapple, green onions, sriracha swirl'],
  ['BOMB', 'The Bomb', 'Pepperoni, Italian sausage, bell peppers, white onions, mushrooms'],
  ['TGB', "Woody's TGB", 'Zesty red sauce, cooked tomatoes, roasted garlic, basil, light cheese, balsamic glaze'],
  ['WAUI', "Woody's Waui", 'Canadian-style bacon, pineapple, applewood-smoked bacon, red onions'],
];

/** Square IDs are placeholders (`SQ_...`); the seed script maps them to real sandbox IDs. */
export const demoShopCatalog: CatalogItem[] = DEMO_SHOP_PIZZAS.map(([slug, name, description]) => ({
  squareItemId: `SQ_ITEM_WS_${slug}`,
  businessId: PIZZA_BUSINESS_ID,
  name,
  description,
  available: true,
  variations: DEMO_SHOP_SIZES.map((s) => ({ id: `SQ_VAR_WS_${slug}_${s.code}`, name: s.name, priceMinor: s.priceMinor, currency: 'USD' as const })),
  modifierLists: [],
  syncedAt: CATALOG_SYNCED_AT,
}));

/**
 * Opening hours. The shop closes at midnight Sunday to Thursday and at 1 AM on Friday and Saturday. An
 * `hours` fact cannot hold a close after midnight (LocalTime is 00:00 to 23:59, and the pickup check
 * compares within one local day), so every day closes at 23:59 here and the phone prompt says "midnight".
 * The `hours` FAQ below carries the 1 AM closing in words.
 */
export const demoShopHours: Record<HoursKey, HoursValue> = {
  mon: { open: '11:00', close: '23:59' },
  tue: { open: '11:00', close: '23:59' },
  wed: { open: '11:00', close: '23:59' },
  thu: { open: '11:00', close: '23:59' },
  fri: { open: '11:00', close: '23:59' },
  sat: { open: '11:00', close: '23:59' },
  sun: { open: '11:00', close: '23:59' },
};

export type DemoShopFact = { kind: 'hours' | 'policy' | 'contact' | 'faq'; key: string; value: Record<string, string | number | boolean> };

const faq = (key: string, question: string, answer: string): DemoShopFact => ({ kind: 'faq', key, value: { question, answer } });

/** The verified facts the demo shop needs, as (kind, key, value). The seed versions them over what is there. */
export const demoShopFacts: DemoShopFact[] = [
  ...(Object.keys(demoShopHours) as HoursKey[]).map((day): DemoShopFact => ({ kind: 'hours', key: day, value: demoShopHours[day] })),
  { kind: 'contact', key: 'address', value: { address: '1000 Higuera Street, San Luis Obispo, CA 93401' } },
  { kind: 'policy', key: 'pickup_only', value: { pickupOnly: true, text: 'This phone line takes pickup orders only. The shop delivers through its online ordering.' } },
  { kind: 'policy', key: 'special_requests', value: { allowed: false, text: 'Phone orders are for the pizzas as they are listed on the menu. For changes to toppings, crust or sauce, please ask at the counter.' } },
  faq('hours', 'When are you open?', 'Sunday to Thursday, 11 AM to midnight. Friday and Saturday, 11 AM to 1 AM. Phone pickup orders are taken until midnight.'),
  faq('sizes', 'What sizes do the pizzas come in?', 'Three sizes: Small is 8 inch, Medium is 12 inch and Large is 14 inch.'),
  faq('price', 'How much is a pizza?', 'Every pizza costs the same. A Small is $14.95, a Medium is $25.95 and a Large is $34.45, before tax.'),
  faq('no_meat', 'Which pizzas have no meat?', "Cheese, Grateful Veg, Pesto Primavera and Woody's TGB."),
  faq('gluten_free', 'Do you have a gluten-free crust?', 'Yes. The shop offers white, wheat and gluten-free crusts. Crust choices are made at the counter, not on this phone line.'),
  faq('vegan_cheese', 'Do you have vegan cheese?', 'Yes. Vegan cheese can replace the mozzarella. Please ask at the counter.'),
  faq('changes', 'Can I change the toppings, crust or sauce on a phone order?', 'Not on this phone line. Phone orders are for the pizzas as they are listed on the menu. For changes, please ask at the counter.'),
  // Arsh, 2026-11-14: an order takes 20 minutes (ORDER_PREP_MINUTES in the server). The shop's page said 35.
  faq('pickup_time', 'How long does a pickup order take?', 'About 20 minutes.'),
  faq('delivery', 'Do you deliver?', 'The shop delivers through its online ordering. This phone line takes pickup orders only.'),
  faq('confirmation', 'How is my phone order confirmed?', 'The shop reviews every phone order before it is accepted.'),
];

/** Verified facts of the two-pizza demo that do not hold for this shop. The seed marks them superseded. */
export const demoShopRetiredFacts: { kind: DemoShopFact['kind']; key: string }[] = [
  { kind: 'faq', key: 'parking' },
];
