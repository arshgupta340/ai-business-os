import type { RenderedMessage } from './types';

// SPEC 2.9 "Message wording": a customer message ends with the link on its own, with no
// punctuation after it, so a phone cannot fold a full stop into the link. SPEC 2.9 takes
// precedence over the older FLOWS B21 example, which put punctuation after the URL.
// Templates never take a customer name or order contents.

function text(value: string, field: string): string {
  const trimmed = value.trim();
  // A line break would let a value add its own lines to the customer message.
  if (!trimmed || /[\r\n]/.test(trimmed)) throw new Error(`Invalid template field: ${field}`);
  return trimmed;
}

function link(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error();
    if (/\s/.test(value)) throw new Error();
    // A link that itself ends in punctuation would defeat the rule above.
    if (/[.,;:!?)\]'"]$/.test(value)) throw new Error();
    return value;
  } catch {
    // Never echo the value.
    throw new Error('Invalid template field: url');
  }
}

export function renderCheckoutMessage(input: { businessName: string; url: string }): RenderedMessage {
  return {
    templateKey: 'checkout_link',
    body: `${text(input.businessName, 'businessName')}: pay for your pickup order here. Sandbox test payment.\n${link(input.url)}`,
  };
}

/** No payment and no link are mentioned. The body still ends without punctuation, like every template. */
export function renderBookingConfirmation(input: { businessName: string; serviceName: string; startLocal: string; timezone: string }): RenderedMessage {
  return {
    templateKey: 'booking_confirmed',
    body: `${text(input.businessName, 'businessName')}: your ${text(input.serviceName, 'serviceName')} appointment is confirmed for ${text(input.startLocal, 'startLocal')}, time zone ${text(input.timezone, 'timezone')}`,
  };
}
