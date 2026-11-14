import { DAY_KEYS, type DayKey } from '../fixtures';
import { FactKindSchema, type FactKind } from '../pending-contracts';
import { ExtractedFactSchema, type ExtractedValue } from './model';

// Turns raw extractor output into safe draft fact candidates. This is the
// trust boundary for document text: whatever the document or the model wrote,
// only facts of a documented kind, with a key that fits that kind and a value
// that passes its shape, come out. Every string is length-capped and stripped
// of control characters. The result carries no status: the caller always
// saves it as a draft.

export const LIMITS = { facts: 200, text: 500, name: 80, variation: 40, sourceRef: 80, key: 60, priceMinor: 100_000 } as const;

export interface DraftCandidate {
  kind: FactKind;
  key: string;
  value: Record<string, unknown>;
  confidence: number;
  sourceRef: string;
}

// C0 and C1 control characters and the Unicode line and paragraph separators.
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]', 'g');

export function cleanText(raw: string | null, max: number): string | undefined {
  if (raw == null) return undefined;
  const cleaned = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return cleaned === '' ? undefined : cleaned;
}

// Lowercase words separated by single spaces. Used to compare item,
// variation and service names.
export function normalizeName(raw: string): string {
  return raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const slug = (raw: string) => normalizeName(raw).replace(/ /g, '_').slice(0, LIMITS.key);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_NAMES: Record<string, DayKey> = {
  monday: 'mon',
  tuesday: 'tue',
  wednesday: 'wed',
  thursday: 'thu',
  friday: 'fri',
  saturday: 'sat',
  sunday: 'sun',
};

function hhmm(raw: string | null): string | undefined {
  if (raw == null) return undefined;
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw.trim());
  if (!m) return undefined;
  const value = `${m[1]!.padStart(2, '0')}:${m[2]}`;
  return HHMM.test(value) ? value : undefined;
}

const intIn = (v: number | null, min: number, max: number) => (v != null && Number.isInteger(v) && v >= min && v <= max ? v : undefined);

function hoursFact(key: string, v: ExtractedValue): { key: string; value: Record<string, unknown> } | undefined {
  const k = key.trim().toLowerCase();
  const day = (DAY_KEYS as readonly string[]).includes(k) ? (k as DayKey) : DAY_NAMES[k];
  if (!day) return undefined;
  if (v.closed === true) return { key: day, value: { closed: true } };
  const open = hhmm(v.open);
  const close = hhmm(v.close);
  if (!open || !close) return undefined;
  return { key: day, value: { open, close } };
}

function menuItemFact(v: ExtractedValue): { key: string; value: Record<string, unknown> } | undefined {
  const itemName = cleanText(v.itemName, LIMITS.name);
  const priceMinor = intIn(v.priceMinor, 0, LIMITS.priceMinor);
  if (!itemName || priceMinor === undefined || !normalizeName(itemName)) return undefined;
  const variationName = cleanText(v.variationName, LIMITS.variation);
  const key = variationName && normalizeName(variationName) ? `${slug(itemName)}:${slug(variationName)}` : slug(itemName);
  return { key, value: { itemName, ...(variationName ? { variationName } : {}), priceMinor, currency: 'USD' } };
}

function serviceFact(v: ExtractedValue): { key: string; value: Record<string, unknown> } | undefined {
  const name = cleanText(v.itemName ?? v.text, LIMITS.name);
  if (!name || !normalizeName(name)) return undefined;
  const priceMinor = intIn(v.priceMinor, 0, LIMITS.priceMinor);
  const durationMinutes = intIn(v.durationMinutes, 1, 480);
  if (priceMinor === undefined && durationMinutes === undefined) return undefined;
  return {
    key: slug(name),
    value: {
      name,
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      ...(priceMinor !== undefined ? { priceMinor, currency: 'USD' } : {}),
    },
  };
}

function policyFact(key: string, v: ExtractedValue): { key: string; value: Record<string, unknown> } | undefined {
  const k = slug(key);
  if (!/^[a-z][a-z0-9_]*$/.test(k)) return undefined;
  const minutes = intIn(v.minutes, 0, 10_080);
  if (minutes !== undefined) return { key: k, value: { minutes } };
  if (typeof v.allowed === 'boolean') return { key: k, value: { allowed: v.allowed } };
  const text = cleanText(v.text, LIMITS.text);
  return text ? { key: k, value: { text } } : undefined;
}

function contactFact(key: string, v: ExtractedValue): { key: string; value: Record<string, unknown> } | undefined {
  const k = key.trim().toLowerCase();
  if (k !== 'phone' && k !== 'email' && k !== 'address') return undefined;
  const text = cleanText(v.text, k === 'address' ? 200 : 120);
  return text ? { key: k, value: { text } } : undefined;
}

function faqFact(key: string, v: ExtractedValue): { key: string; value: Record<string, unknown> } | undefined {
  const answer = cleanText(v.text, LIMITS.text);
  const question = cleanText(v.question, 200);
  const k = slug(question ?? key);
  if (!answer || !/^[a-z0-9][a-z0-9_]*$/.test(k)) return undefined;
  return { key: k, value: { ...(question ? { question } : {}), answer } };
}

export function sanitizeExtraction(raw: unknown): DraftCandidate[] {
  const facts = raw && typeof raw === 'object' && Array.isArray((raw as { facts?: unknown }).facts) ? (raw as { facts: unknown[] }).facts : [];
  const out: DraftCandidate[] = [];
  const seen = new Set<string>();
  for (const item of facts) {
    if (out.length >= LIMITS.facts) break;
    const parsed = ExtractedFactSchema.safeParse(item);
    if (!parsed.success) continue;
    const fact = parsed.data;
    const kind = FactKindSchema.safeParse(fact.kind.trim());
    if (!kind.success) continue; // kinds outside the documented list are dropped
    const key = fact.key.slice(0, 200);
    let shaped: { key: string; value: Record<string, unknown> } | undefined;
    switch (kind.data) {
      case 'hours':
        shaped = hoursFact(key, fact.value);
        break;
      case 'menu_item':
        shaped = menuItemFact(fact.value);
        break;
      case 'service':
        shaped = serviceFact(fact.value);
        break;
      case 'policy':
        shaped = policyFact(key, fact.value);
        break;
      case 'contact':
        shaped = contactFact(key, fact.value);
        break;
      case 'faq':
        shaped = faqFact(key, fact.value);
        break;
    }
    if (!shaped || !shaped.key) continue;
    const dedupe = `${kind.data}.${shaped.key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const confidence = Number.isFinite(fact.confidence) ? Math.round(Math.min(1, Math.max(0, fact.confidence)) * 100) / 100 : 0;
    const sourceRef = (cleanText(fact.sourceRef, LIMITS.sourceRef) ?? '').replace(/[^A-Za-z0-9 .,:#_()-]/g, '').trim() || 'document';
    out.push({ kind: kind.data, key: shaped.key, value: shaped.value, confidence, sourceRef });
  }
  return out;
}
