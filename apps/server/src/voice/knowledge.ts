// What the phone agent knows before the caller speaks: the verified facts pinned with the call
// (hours, policies, services, contact, FAQs), the menu read when the call was pinned, and the
// current local time. Written into the system prompt so a basic question needs no tool call.
//
// Safety does not depend on this text (FLOWS 8). Totals still come only from quote_order, and
// propose_order checks every ID, the quote and the opening hours on the server. The block is
// labelled as data, every string in it is flattened and cut, and the whole block has a size cap.
import { HoursValueSchema, ServiceOfferingSchema, type CatalogItem, type HoursKey } from '@abos/contracts';
import type { FactsSnapshot } from './types';

export type Knowledge = {
  /** The data block for the prompt. */
  text: string;
  hasHours: boolean;
  hasMenu: boolean;
  hasServices: boolean;
};

/**
 * The whole block stays under this, so the session setup stays fast. Raised from 6000 for the demo shop
 * (issue #161): 16 pizzas with their IDs and toppings plus 10 FAQs come to about 5500 characters, and a
 * block over the cap loses its menu first.
 */
export const MAX_KNOWLEDGE_CHARS = 9000;
/** A menu of at least this many items, all with the same sizes and prices and no options, is written in the short form. */
export const UNIFORM_MENU_MIN_ITEMS = 6;
const MAX_FIELD_CHARS = 200;
const MAX_FAQS = 20;
const MAX_POLICIES = 20;
const MAX_SERVICES = 30;
/** Provider IDs go into the prompt as they are, so only this plain shape is let through. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

const DAYS: [HoursKey, string][] = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'], ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
];

/** One line of plain text: no line breaks, no control characters, no Markdown marks, bounded. */
function clean(value: unknown, max = MAX_FIELD_CHARS): string {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/[*_`#<>]+/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}.` : flat;
}

/** A sentence end without doubling the full stop. */
const stop = (s: string) => (/[.!?]$/.test(s) ? s : `${s}.`);

export function dollars(minor: number): string {
  return `$${(minor / 100).toFixed(2)}`;
}

/** "11:00" to "11 AM", "21:30" to "9:30 PM". "23:59" is how a midnight close is stored, and is said as "midnight". */
export function clock(hhmm: string): string {
  if (hhmm === '23:59') return 'midnight';
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const hour = h % 12 === 0 ? 12 : h % 12;
  const suffix = h % 24 < 12 ? 'AM' : 'PM';
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** The current local date and time, and the form the tools expect a time in. */
export function nowLine(nowMs: number, timeZone: string): string | undefined {
  try {
    const at = new Date(nowMs);
    const spoken = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(at);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'longOffset' }).formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    const raw = part('timeZoneName').replace('GMT', '');
    const offset = raw === '' ? '+00:00' : raw;
    const date = `${part('year')}-${part('month')}-${part('day')}`;
    return `Now: ${spoken}, shop time (${timeZone}). Today is ${date}. Give tools a time in this form: ${date}T18:30:00${offset}. That offset is for today; when a tool returns a slot time, copy it exactly.`;
  } catch {
    return undefined;
  }
}

function hoursLine(facts: FactsSnapshot): string | undefined {
  const days: string[] = [];
  for (const [key, label] of DAYS) {
    const fact = facts.facts.find((f) => f.kind === 'hours' && f.key === key);
    const parsed = fact === undefined ? undefined : HoursValueSchema.safeParse(fact.value);
    if (parsed === undefined || !parsed.success) continue;
    days.push('closed' in parsed.data ? `${label} closed` : `${label} ${clock(parsed.data.open)} to ${clock(parsed.data.close)}`);
  }
  // Every day must be readable. With a day missing, the agent keeps reading hours from the tool.
  return days.length === DAYS.length ? `Opening hours: ${days.join('. ')}.` : undefined;
}

function policyLines(facts: FactsSnapshot): string[] {
  const out: string[] = [];
  for (const f of facts.facts) {
    if (f.kind !== 'policy' || f.key === 'message_consent') continue;
    const value = asRecord(f.value);
    if (value === undefined) continue;
    const text = clean(value.text);
    if (text !== '') { out.push(stop(text)); continue; }
    const label = clean(f.key.replace(/_/g, ' '), 60);
    if (typeof value.minutes === 'number') out.push(`${label}: ${value.minutes} minutes.`);
    else if (typeof value.allowed === 'boolean') out.push(`${label}: ${value.allowed ? 'allowed' : 'not allowed'}.`);
  }
  return [...new Set(out)].slice(0, MAX_POLICIES);
}

function contactLines(facts: FactsSnapshot): string[] {
  const out: string[] = [];
  for (const f of facts.facts) {
    if (f.kind !== 'contact') continue;
    const value = asRecord(f.value);
    const text = clean(value?.[f.key]);
    if (text !== '') out.push(`${clean(f.key, 40)}: ${stop(text)}`);
  }
  return out;
}

function faqLines(facts: FactsSnapshot): string[] {
  const out: string[] = [];
  for (const f of facts.facts) {
    if (f.kind !== 'faq') continue;
    const value = asRecord(f.value);
    const question = clean(value?.question);
    const answer = clean(value?.answer);
    if (question !== '' && answer !== '') out.push(`Q: ${question} A: ${stop(answer)}`);
  }
  return [...new Set(out)].slice(0, MAX_FAQS);
}

function serviceLines(facts: FactsSnapshot): string[] {
  const out: string[] = [];
  for (const f of facts.facts) {
    if (f.kind !== 'service') continue;
    const parsed = ServiceOfferingSchema.safeParse(f.value);
    if (!parsed.success) continue;
    const s = parsed.data;
    if (!SAFE_ID.test(s.id)) continue;
    out.push(`${clean(s.name, 80)}: ${s.durationMinutes} minutes, ${dollars(s.priceMinor)}, service id ${s.id}.`);
  }
  return out.slice(0, MAX_SERVICES);
}

const safeItem = (item: CatalogItem) => SAFE_ID.test(item.squareItemId) && item.variations.every((v) => SAFE_ID.test(v.id));

/** The sizes and prices every item shares, when the menu is long, has no options and all items cost the same. */
function uniformSizes(menu: readonly CatalogItem[]): { name: string; priceMinor: number }[] | undefined {
  const sold = menu.filter((i) => i.available && i.variations.length > 0 && clean(i.name, 80) !== '' && safeItem(i));
  if (sold.length < UNIFORM_MENU_MIN_ITEMS || sold.some((i) => i.modifierLists.length > 0)) return undefined;
  const signature = (i: CatalogItem) => i.variations.map((v) => `${v.name}|${v.priceMinor}`).join(',');
  const first = signature(sold[0]!);
  return sold.every((i) => signature(i) === first) ? sold[0]!.variations.map((v) => ({ name: v.name, priceMinor: v.priceMinor })) : undefined;
}

/**
 * The short form for a long menu whose items all cost the same: the size prices once, then one line per
 * item with its IDs and what is on it.
 */
function uniformMenuLines(menu: readonly CatalogItem[], sizes: { name: string; priceMinor: number }[]): string[] {
  const items: string[] = [];
  for (const item of menu) {
    const name = clean(item.name, 80);
    if (name === '' || item.variations.length === 0 || !safeItem(item)) continue;
    if (!item.available) { items.push(`${name}: not available today.`); continue; }
    const ids = item.variations.map((v) => `${clean(v.name, 40)} ${v.id}`).join(', ');
    const on = clean(item.description);
    items.push(`${name} (item id ${item.squareItemId}; variation ids: ${ids})${on === '' ? '.' : `: ${stop(on)}`}`);
  }
  return [`Menu, ${items.length} items, prices before tax. Every item costs the same: ${sizes.map((s) => `${clean(s.name, 40)} ${dollars(s.priceMinor)}`).join(', ')}.`, ...items];
}

/** The menu with the exact IDs a cart needs, so an order can be quoted without a search. */
export function menuLines(menu: readonly CatalogItem[]): string[] {
  const sizes = uniformSizes(menu);
  if (sizes !== undefined) return uniformMenuLines(menu, sizes);
  const lists = new Map<string, string>();
  const items: string[] = [];
  for (const item of menu) {
    const name = clean(item.name, 80);
    if (name === '' || item.variations.length === 0) continue;
    // An item whose IDs are not plain provider IDs is left out; the agent can still find it with read_catalog.
    if (!SAFE_ID.test(item.squareItemId) || item.variations.some((v) => !SAFE_ID.test(v.id))) continue;
    if (!item.available) { items.push(`${name}: not available today.`); continue; }
    const sizes = item.variations.map((v) => `${clean(v.name, 40)} ${dollars(v.priceMinor)} (variation id ${v.id})`).join(', ');
    const options: string[] = [];
    for (const list of item.modifierLists) {
      const label = clean(list.name, 60);
      if (label === '' || list.modifiers.length === 0) continue;
      if (!SAFE_ID.test(list.id) || list.modifiers.some((m) => !SAFE_ID.test(m.id))) continue;
      options.push(label);
      if (!lists.has(list.id)) {
        const choose = list.selectionType === 'SINGLE' ? 'choose one' : 'choose any';
        lists.set(list.id, `${label} (${choose}): ${list.modifiers.map((m) => `${clean(m.name, 40)} +${dollars(m.priceMinor)} (modifier id ${m.id})`).join(', ')}.`);
      }
    }
    items.push(`${name} (item id ${item.squareItemId}): ${sizes}.${options.length > 0 ? ` Options: ${options.join(', ')}.` : ''}`);
  }
  if (items.length === 0) return [];
  return ['Menu, prices before tax:', ...items, ...lists.values()];
}

/**
 * Builds the data block. The menu is dropped first when the block is too long, then the FAQs.
 * Returns undefined when there is nothing useful to bake in.
 */
export function buildKnowledge(args: { facts?: FactsSnapshot | undefined; menu?: readonly CatalogItem[] | undefined; nowMs?: number | undefined }): Knowledge | undefined {
  const { facts, menu, nowMs } = args;
  if (facts === undefined) return undefined;
  const now = nowMs === undefined ? undefined : nowLine(nowMs, facts.timezone);
  const hours = hoursLine(facts);
  const services = serviceLines(facts);
  const head = [now, hours, ...contactLines(facts), ...policyLines(facts)].filter((l): l is string => l !== undefined);
  const servicesBlock = services.length > 0 ? ['Services:', ...services] : [];
  const faqs = faqLines(facts);
  const menuBlock = menu === undefined ? [] : menuLines(menu);

  const candidates: { lines: string[]; hasMenu: boolean }[] = [
    { lines: [...head, ...servicesBlock, ...menuBlock, ...faqs], hasMenu: menuBlock.length > 0 },
    { lines: [...head, ...servicesBlock, ...faqs], hasMenu: false },
    { lines: [...head, ...servicesBlock], hasMenu: false },
  ];
  // Last resort: the time and the hours alone, which are always short.
  const core = [now, hours].filter((l): l is string => l !== undefined);
  for (const c of candidates) {
    const text = c.lines.join('\n');
    if (text === '' || text.length > MAX_KNOWLEDGE_CHARS) continue;
    return { text, hasHours: hours !== undefined, hasMenu: c.hasMenu, hasServices: services.length > 0 };
  }
  if (core.length > 0) return { text: core.join('\n'), hasHours: hours !== undefined, hasMenu: false, hasServices: false };
  return undefined;
}
