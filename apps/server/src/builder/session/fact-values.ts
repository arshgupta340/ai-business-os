import { canonicalJson, HoursValueSchema, type JsonValue } from '@abos/contracts';

// Typed fact values from an owner's chat answer. A chat answer that becomes a
// fact_edit approval must already have the shape the deployed readers expect,
// because the approval stores and hashes exactly that value:
//   hours.<day>              HoursValueSchema, read by the real toolset and the booking ports
//   policy.min_notice        { minutes }, read by the booking ports and the mock toolset
//   policy.pickup_window     { minutes }, the shape of the shared fixtures
//   policy.special_requests  { allowed }, the shape of the shared fixtures
//   policy.message_consent   { required, wording }, the shape of the shared fixtures
// When the text cannot be read with confidence the answer is refused and the
// builder asks again. Nothing here guesses.

export type FactValueResult = { ok: true; value: JsonValue } | { ok: false; hint: string };

const MINUTES_HINT = 'Please say a length of time, for example "20 minutes" or "2 hours".';
const HOURS_HINT = 'Please say the hours with am or pm, for example "11 am to 11 pm", or say "closed".';
const YES_NO_HINT = 'Please answer yes or no.';

export function typedFactValue(field: string, rawText: string): FactValueResult {
  const text = rawText.trim();
  if (field.startsWith('hours.')) return hoursValue(text);
  switch (field) {
    case 'policy.min_notice':
    case 'policy.pickup_window': {
      const minutes = parseMinutes(text);
      return minutes === undefined ? { ok: false, hint: MINUTES_HINT } : { ok: true, value: { minutes, text } };
    }
    case 'policy.special_requests': {
      const allowed = parseYesNo(text);
      return allowed === undefined ? { ok: false, hint: YES_NO_HINT } : { ok: true, value: { allowed, text } };
    }
    case 'policy.message_consent':
      return text ? { ok: true, value: { required: true, wording: text } } : { ok: false, hint: 'Please say how the agent should ask for consent.' };
    default:
      return { ok: true, value: { text } };
  }
}

// True when two values of one field mean the same thing to the readers, so a
// repeat does not open a second approval. The owner's original words (`text`)
// do not count.
export function sameFactMeaning(field: string, a: JsonValue, b: JsonValue): boolean {
  const pick = (v: JsonValue): JsonValue => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
    if (field === 'policy.min_notice' || field === 'policy.pickup_window') return v.minutes ?? null;
    if (field === 'policy.special_requests') return v.allowed ?? null;
    if (field === 'policy.message_consent') return typeof v.wording === 'string' ? v.wording.trim() : null;
    if (field.startsWith('hours.')) return v;
    return typeof v.text === 'string' ? v.text.trim() : v;
  };
  return canonicalJson(pick(a)) === canonicalJson(pick(b));
}

// True when a stored value has the shape the readers of its field expect. A
// draft written without proposeFactFromChat holds only `{ text }` and is never
// proposed for a field whose readers need structure.
export function readableFactValue(field: string, value: JsonValue): boolean {
  if (field.startsWith('hours.')) return HoursValueSchema.safeParse(value).success;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  switch (field) {
    case 'policy.min_notice':
    case 'policy.pickup_window':
      return typeof value.minutes === 'number' && Number.isInteger(value.minutes) && value.minutes >= 0;
    case 'policy.special_requests':
      return typeof value.allowed === 'boolean';
    case 'policy.message_consent':
      return value.required === true && typeof value.wording === 'string' && value.wording.trim() !== '';
    default:
      return true;
  }
}

// ---- hours

function hoursValue(text: string): FactValueResult {
  const times = [...text.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?|\b(noon)\b/gi)];
  if (times.length === 0) {
    return /\bclosed\b/i.test(text) ? { ok: true, value: { closed: true } } : { ok: false, hint: HOURS_HINT };
  }
  if (times.length !== 2 || /\bclosed\b/i.test(text)) return { ok: false, hint: HOURS_HINT };
  const parsed = times.map(toMinutes);
  const [open, close] = parsed;
  if (open === undefined || close === undefined || close <= open) return { ok: false, hint: HOURS_HINT };
  const value = { open: hhmm(open), close: hhmm(close) };
  return HoursValueSchema.safeParse(value).success ? { ok: true, value } : { ok: false, hint: HOURS_HINT };
}

// Minutes after midnight, or undefined when the time is not certain. A time
// without am or pm counts only in 24-hour form with minutes ("17:30").
function toMinutes(m: RegExpMatchArray): number | undefined {
  if (m[4]) return 12 * 60;
  const hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  if (minute > 59) return undefined;
  const meridiem = m[3]?.toLowerCase().replace(/[^ap]/g, '');
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    const h24 = (hour % 12) + (meridiem === 'p' ? 12 : 0);
    return h24 * 60 + minute;
  }
  if (m[2] === undefined || hour > 23) return undefined;
  return hour * 60 + minute;
}

function hhmm(total: number): string {
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ---- minutes

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, sixty: 60,
};
const UNIT_MINUTES: Record<string, number> = { minute: 1, min: 1, hour: 60, hr: 60, day: 1440 };

function parseMinutes(text: string): number | undefined {
  if (/\band a half\b/i.test(text)) return undefined;
  const lower = text.toLowerCase().replace(/\bhalf an? hour\b/g, '30 minutes');
  const found = [...lower.matchAll(/\b(\d+(?:\.\d+)?|forty-five|[a-z]+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/g)]
    .map((m) => {
      const n = /^\d/.test(m[1]!) ? Number(m[1]) : WORDS[m[1]!];
      const unit = m[2]!.replace(/s$/, '');
      const per = UNIT_MINUTES[unit];
      return n === undefined || per === undefined ? undefined : Math.round(n * per);
    });
  if (found.length === 0 || found.some((n) => n === undefined)) return undefined;
  const distinct = [...new Set(found)];
  return distinct.length === 1 && distinct[0]! >= 0 ? distinct[0] : undefined;
}

// ---- yes or no

function parseYesNo(text: string): boolean | undefined {
  const no = /\b(no|not|don't|dont|do not|never|none)\b/i.test(text);
  const yes = /\b(yes|yeah|sure|accept|allow|allowed|ok|okay|fine)\b/i.test(text);
  if (yes === no) return undefined;
  return yes;
}
