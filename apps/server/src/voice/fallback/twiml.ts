import { E164Schema } from '@abos/contracts';
import { FALLBACK_DIAL_TIMEOUT_SECONDS } from './constants';
import type { FallbackTwimlInput } from './types';

// Same five XML escapes as the voice spike, plus removal of invalid XML 1.0 characters.
function escapeXml(value: string): string {
  return Array.from(value).filter((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code === 9 || code === 10 || code === 13 ||
      (code >= 0x20 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) ||
      (code >= 0x10000 && code <= 0x10ffff);
  }).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Pure XML builder. An owned caller ID and a verified E.164 destination are both required. */
export function buildFallbackTwiml(input: FallbackTwimlInput): string {
  const destination = E164Schema.safeParse(input.fallbackNumber);
  const callerId = E164Schema.safeParse(input.callerId?.number);
  const canDial = destination.success && callerId.success && input.callerId?.accountOwned === true;
  const business = input.businessName || 'the business';
  if (!canDial) {
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(`Sorry, ${business} cannot take your call right now. Please try again later. Goodbye.`)}</Say><Hangup /></Response>`;
  }
  const line = input.reason === 'caller_requested_person'
    ? `Please hold while I try to connect you to someone at ${business}.`
    : `Sorry, I cannot continue. Please hold while I try to connect you to someone at ${business}.`;
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(line)}</Say><Dial timeout="${FALLBACK_DIAL_TIMEOUT_SECONDS}" callerId="${escapeXml(callerId.data)}"><Number>${escapeXml(destination.data)}</Number></Dial><Hangup /></Response>`;
}
