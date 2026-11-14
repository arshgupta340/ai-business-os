// D-13 demo message texts. Every one is labelled demo. SPEC 2.9 "Message wording": a message that carries
// a link ends with the link, with nothing after it, so a phone cannot fold a full stop into the link.
import type { CatalogItem } from '@abos/contracts';

export const MENU_MESSAGE_MAX = 1200;
const MENU_END = 'Demo message.';

/** "$12.50" from minor units. */
export function dollars(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

/** One line of owner or catalog text: no control characters or line breaks, trimmed, bounded. */
export function plain(value: string, max = 120): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The menu as one WhatsApp message: item names, sizes and prices in dollars, then the toppings. Built only
 * from the cached catalog. Under 1200 characters (items that do not fit are left out, and the message says
 * so), and it ends with "Demo message."
 */
export function buildMenuMessage(businessName: string, items: readonly CatalogItem[]): string {
  const available = items.filter((i) => i.available);
  const head = `${plain(businessName)} menu:`;
  const itemLines = available.map((i) => `${plain(i.name)}: ${i.variations.map((v) => `${plain(v.name, 40)} ${dollars(v.priceMinor)}`).join(', ')}`);
  const lists = new Map<string, { name: string; mods: string[] }>();
  for (const i of available) for (const l of i.modifierLists) {
    if (!lists.has(l.id)) lists.set(l.id, { name: plain(l.name, 40), mods: l.modifiers.map((m) => `${plain(m.name, 40)} +${dollars(m.priceMinor)}`) });
  }
  const listLines = [...lists.values()].filter((l) => l.mods.length > 0).map((l) => `${l.name}: ${l.mods.join(', ')}`);
  const more = 'More items at the shop.';
  const lines = [head];
  const fits = (extra: string[]) => [...lines, ...extra, more, MENU_END].join('\n').length <= MENU_MESSAGE_MAX;
  let cut = false;
  for (const line of [...itemLines, ...listLines]) {
    if (fits([line])) lines.push(line); else cut = true;
  }
  if (itemLines.length === 0) lines.push('The menu is not available right now.');
  if (cut) lines.push(more);
  lines.push(MENU_END);
  return lines.join('\n');
}

export function buildPayLinkMessage(businessName: string, totalMinor: number, link: string): string {
  return `${plain(businessName)}: your order total is ${dollars(totalMinor)}. Demo: no real money moves. Pay here: ${link}`;
}

export function buildConfirmationMessage(businessName: string, readyTime: string, link: string): string {
  return `${plain(businessName)}: your order is placed and will be ready by ${plain(readyTime, 40)}. Demo message. Track it: ${link}`;
}

/** "6:30 PM" in the shop's timezone. */
export function shopTime(iso: string | number, timeZone: string): string {
  const d = new Date(iso);
  try { return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d); }
  catch { return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }).format(d) + ' UTC'; }
}
