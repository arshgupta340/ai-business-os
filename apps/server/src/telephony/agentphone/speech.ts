// What the AgentPhone path adds to the phone prompt, and the fixed lines the server speaks itself (D-12).
// AgentPhone speaks our reply text with its own speech engine, so the reply must read well aloud. The phone
// prompt (voice/prompt.ts buildInstructions) is used unchanged; these lines follow it and only this path
// gets them. The greeting, the closing line after a stored proposal and the line for a later stray turn
// come from the server, never from the model, so the AI disclosure and the hangup do not depend on its words.
import type { AgentSpec } from '@abos/contracts';

/** The disclosure the greeting must carry. An override without it is not used. */
export const GREETING_DISCLOSURE = 'This is an AI assistant.';

function nameSentence(businessName: string): string {
  const name = businessName.trim() || 'the shop';
  return name.endsWith('.') ? name : `${name}.`;
}

/**
 * The short opening line, about 14 words, with the AI disclosure. `override` is AGENTPHONE_GREETING; it is
 * used only when it carries the words "AI assistant" (any case), otherwise the default is used.
 */
export function agentPhoneGreeting(businessName: string, template: AgentSpec['template'] | undefined, override?: string | undefined): string {
  const custom = override?.trim();
  if (custom && /\bAI assistant\b/i.test(custom) && custom.length <= 300) return custom;
  const ask = template === 'appointment_booker' ? 'How can I help you?' : 'What can I get you?';
  return `Thanks for calling ${nameSentence(businessName)} ${GREETING_DISCLOSURE} ${ask}`;
}

/**
 * The opening for a call whose first words are already a request: the shop name and the AI disclosure,
 * without the question, so the answer that follows is not a second question.
 */
export function agentPhoneGreetingLead(businessName: string): string {
  return `Thanks for calling ${nameSentence(businessName)} ${GREETING_DISCLOSURE}`;
}

const HELLO_WORDS = new Set(['hello', 'hi', 'hey', 'hiya', 'yo', 'yes', 'yeah', 'um', 'uh', 'ok', 'okay', 'good', 'morning', 'afternoon', 'evening',
  'is', 'are', 'you', 'there', 'anyone', 'anybody', 'somebody', 'someone', 'can', 'hear', 'me']);
/**
 * True when a caller's first words are only a hello ("Hello?", "Hi, is anyone there?"). AgentPhone stays
 * silent until the caller speaks, so most calls start this way; the server then answers with the greeting
 * alone, at once, without a model turn.
 */
export function isHelloOnly(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z ]+/g, ' ').split(' ').filter(Boolean);
  return words.length > 0 && words.length <= 6 && words.every((w) => HELLO_WORDS.has(w));
}

/** The lines this channel needs, after the phone prompt. */
export function agentPhoneChannelLines(greeting: string, businessName?: string | undefined): string {
  const name = businessName?.trim();
  return [
    'Channel rules for this call. They replace any line above that disagrees.',
    'A phone service reads your reply aloud with a speech engine. Write only words to be said: plain short sentences, no symbols, no lists, no Markdown, no emoji.',
    'Write numbers, prices and times the way a person says them: "twelve dollars and fifty cents", "six thirty tonight", "two large pizzas". Never write a dollar sign, a percent sign, a decimal point or a digit.',
    // A scripted call on 2026-11-14: "close tonight" reached the server as other words and the model asked which month.
    'The caller\'s words reach you through speech recognition, which makes mistakes. Read them by sound and by what a caller of this shop would mean: after "close" or "open", "the ninth" or "to ninth" means "tonight"; a menu item that is almost right is that item. Answer the likely meaning. Ask the caller to say it again only when you cannot tell what they meant.',
    'Tool results give every amount twice: in cents (a name ending in "Minor") and in dollars (the same name ending in "Dollars", such as totalDollars "554.60"). Read the dollars value and say it in words. Never convert cents yourself.',
    'There are no server status messages on this call. No message or payment link is sent to the caller by text; the payment link is shown at the counter.',
    `The call was already opened for you with this greeting: "${greeting}" Do not greet the caller again and do not repeat the greeting or the AI disclosure. Ignore the line above that tells you to speak first or how to open.`,
    'After propose_order or propose_booking succeeds, the server says the closing line and ends the call. Reply with one word, "Done.", and nothing else.',
    // The spec's own greeting can carry an older name (a call on 2026-11-14 said "Demo Pizza Co." after the rename).
    ...(name ? [`The shop is called "${name}". Say only that name for the shop, also where a line above uses another name. If the caller asks who you are or what your name is, say you are the AI assistant for ${name}.`] : []),
  ].join('\n');
}

/** A caller name that is safe to say back: letters, spaces, apostrophes, hyphens and full stops, at most 40 characters. */
export function sayableName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name === '' || name.length > 40 || !/^[\p{L}][\p{L} '.-]*$/u.test(name)) return undefined;
  return name;
}

function withName(line: string, name: string | undefined): string {
  return name === undefined ? line.replace('Thanks, {name}.', 'Thanks.') : line.replaceAll('{name}', name);
}

/**
 * The order wait line on this path (Arsh, 2026-11-14): short, for the demo call. It says the order waits
 * for the shop and claims nothing more (not placed, not paid). The Twilio path keeps orderWaitScript.
 */
export const ORDER_CLOSING_WAIT = "Thanks, {name}. Your order is awaiting the shop's confirmation.";
/** The booking wait line on this path, as short as the order's. It claims nothing more: the appointment is not booked yet. */
export const BOOKING_CLOSING_WAIT = "Thanks, {name}. Your booking is awaiting the shop's confirmation.";

/**
 * The reply of the turn whose proposal was stored: the wait line, then a short goodbye. The webhook answer
 * carries hangup with it.
 */
export function closingLine(template: AgentSpec['template'], businessName: string, name: string | undefined): string {
  const wait = template === 'appointment_booker' ? BOOKING_CLOSING_WAIT : ORDER_CLOSING_WAIT;
  return `${withName(wait, name)} Thanks for calling ${nameSentence(businessName)} Goodbye.`;
}

/**
 * A later turn on a call whose proposal is already stored, when the closing line itself is not at hand
 * (a call continued after a restart). Otherwise the call repeats its closing line (voice.ts).
 */
export function afterProposalLine(template: AgentSpec['template'], businessName?: string | undefined): string {
  const what = template === 'appointment_booker' ? 'booking' : 'order';
  return `Your ${what} is awaiting the shop's confirmation.${businessName ? ` Thanks for calling ${nameSentence(businessName)}` : ''} Goodbye.`;
}

/** The call reached its cap on tool calls (issue #95 item 8): the call ends. */
export function toolLimitLine(businessName: string, sentToShop: boolean): string {
  return `I am sorry, I cannot continue with this call.${sentToShop ? ' The shop will review the request I already sent.' : ''} Please call back, or ask the shop directly. Thanks for calling ${nameSentence(businessName)} Goodbye.`;
}
