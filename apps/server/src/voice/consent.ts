// Consent to one text message on a phone call (PROPOSED, SPEC 2.9 "Consent evidence on a phone call").
// The server reads the caller's answer itself: the transcript of the one caller turn right after the
// offer, or a keypad press. The model's claim of consent is never evidence. This file holds the pure
// parts: the spoken-answer matcher and the eligibility check. The relay holds the state.
import { E164Schema, type AgentSpec, type MessageChannelSetting } from '@abos/contracts';

export type SpokenAnswer = 'agreed' | 'declined' | 'unclear';

/** Longer turns are never read as a clear answer. */
export const MAX_ANSWER_WORDS = 8;

/** Sounds that carry no answer. A turn of only these is unclear. */
const FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'oh', 'hmm', 'hm', 'mm', 'well']);
/** Any of these anywhere in the turn means the caller did not give a plain yes. */
const NEGATION = new Set(['no', 'not', 'dont', 'never', 'nope', 'nah', 'cant', 'wont', 'shouldnt', 'nothing', 'none']);
/** Any of these anywhere in the turn makes it unclear, whatever else was said. */
const HEDGE = new Set(['maybe', 'later', 'stop', 'wait', 'guess', 'perhaps', 'unsure', 'probably', 'think', 'hold', 'cancel', 'actually', 'but', 'or', 'if']);
/** Words that lean to yes. Together with a negation the turn is unclear, never a decline. */
const AFFIRMATIVE_WORDS = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'okay', 'ok', 'absolutely', 'fine', 'works', 'ahead', 'good', 'definitely']);

/** The whole turn, after fillers are removed, must be one of these, or two or three of them in a row. */
const AFFIRMATIVE_PHRASES = new Set([
  'yes', 'yeah', 'yep', 'yup', 'yes please', 'yeah please', 'sure', 'sure thing', 'okay', 'ok', 'please do',
  'that works', 'go ahead', 'absolutely', 'definitely', 'of course', 'sounds good', 'thats fine', 'that is fine',
  'yes thanks', 'yes thank you', 'send it', 'please send it', 'please', 'yes sir', 'yes maam', 'alright', 'all right',
  'text me', 'text it to me', 'send me the link', 'send me a text', 'send me the text',
]);

/** Lower case, apostrophes dropped ("don't" is "dont"), every other mark a space. */
export function normalizeAnswer(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
}

/** True when the words are one to three affirmative phrases in a row and nothing else. */
function isAffirmativeSequence(words: string[]): boolean {
  const best: number[] = Array(words.length + 1).fill(Infinity);
  best[0] = 0;
  for (let end = 1; end <= words.length; end++) {
    for (let start = Math.max(0, end - 4); start < end; start++) {
      if (best[start] !== Infinity && AFFIRMATIVE_PHRASES.has(words.slice(start, end).join(' '))) best[end] = Math.min(best[end]!, best[start]! + 1);
    }
  }
  return best[words.length]! <= 3;
}

/**
 * The caller's spoken answer to the text offer, from the server's own transcript of that one turn.
 * Strict and fail closed: agreed only for a short, plain affirmative with no negation or hedge; a
 * negation without any affirmative word is a decline; everything else, including an empty or missing
 * transcript, is unclear. The text is used here and dropped; it is never logged or stored.
 */
export function matchSpokenAnswer(transcript: string | undefined): SpokenAnswer {
  if (transcript === undefined) return 'unclear';
  // A question ("yes?", "sure?") asks for clarification. Checked before punctuation is dropped.
  if (/[?？¿]/.test(transcript)) return 'unclear';
  const all = normalizeAnswer(transcript);
  if (all.length === 0 || all.length > MAX_ANSWER_WORDS) return 'unclear';
  const words = all.filter((w) => !FILLER.has(w));
  if (words.length === 0) return 'unclear';
  const negated = words.some((w) => NEGATION.has(w));
  const leansYes = words.some((w) => AFFIRMATIVE_WORDS.has(w));
  if (words.some((w) => HEDGE.has(w))) return 'unclear';
  if (negated) return leansYes ? 'unclear' : 'declined';
  return isAffirmativeSequence(words) ? 'agreed' : 'unclear';
}

/** Twilio's `StirVerstat` for full (A) attestation on an incoming call. Read from Twilio's docs on 2026-11-14; untested. */
export const FULL_ATTESTATION = 'TN-Validation-Passed-A';

/** The caller's full number from the signed webhook's `From`, or undefined when it is not a usable E.164 number. */
export function callerNumberFrom(from: string | undefined): string | undefined {
  if (from === undefined) return undefined;
  const parsed = E164Schema.safeParse(from.trim());
  return parsed.success ? parsed.data : undefined;
}

/**
 * Whether a call may offer the text step: the server channel sends messages, a usable caller number
 * was pinned, and the agent spec carries the message capability that its approval bundle sends with.
 */
export function textOfferAllowed(spec: Pick<AgentSpec, 'template' | 'capabilities'>, channel: MessageChannelSetting, callerNumber: string | undefined): boolean {
  if (channel === 'qr_only' || callerNumber === undefined || !E164Schema.safeParse(callerNumber).success) return false;
  const caps: readonly string[] = spec.capabilities;
  if (spec.template === 'restaurant_order_taker') return caps.includes('order.propose') && caps.includes('message.checkout.send');
  if (spec.template === 'appointment_booker') return caps.includes('booking.propose') && caps.includes('message.booking.confirm');
  return false;
}

/** "3 7 1 6": the last four digits spaced, so the model reads them one by one. */
export function spacedLast4(number: string): string {
  return number.replace(/\D/g, '').slice(-4).split('').join(' ');
}

const DIGIT_WORDS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9' };

/** Lower-case letters and digits only, with spoken digits turned into digits. */
function compact(text: string): string {
  return normalizeAnswer(text).map((w) => DIGIT_WORDS[w] ?? w).join('');
}

/**
 * Whether the model's own output transcript for the offer response carries the fixed line: for the
 * offer, its key phrase and the last four digits; for the re-ask, "yes or a no". Model output, used
 * in memory only and never logged.
 */
export function offerLineSpoken(line: 'offer' | 'reask', transcript: string | undefined, last4: string): boolean {
  if (transcript === undefined) return false;
  const said = compact(transcript);
  if (line === 'reask') return said.includes('yesorano');
  const digits = last4.replace(/\D/g, '');
  return digits.length === 4 && said.includes('wouldyoulike') && said.includes('numberyouarecallingfrom') && said.includes(digits);
}
