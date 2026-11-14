import { ActivityEventSchema, IsoDateTimeSchema } from '@abos/contracts';
import type { QueryInterface } from './types';

// Preserve timestamps and identifiers. Redact free text as well as phone fields.
function redact(value: unknown, field = ''): unknown {
  if (typeof value === 'string') {
    if (/Id$|Ref$|Hash$/.test(field) || IsoDateTimeSchema.safeParse(value).success) return value;
    return value.replace(/\+?[1-9](?:[\d ()-]*\d){6,}/g, (match) => {
      const digits = match.replace(/\D/g, '');
      return !match.startsWith('+') && digits.length >= 13 ? '[redacted]' : digits.slice(-4);
    });
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, field));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !/card|cvv|cvc|^pan$|checkoutUrl/i.test(key))
      .map(([key, entry]) => [key, redact(entry, key)]));
  }
  return value;
}

export async function emitActivity(tx: QueryInterface, event: unknown): Promise<void> {
  // Schemas remove unknown fields, including raw contact objects and card details.
  const candidate = ActivityEventSchema.parse(event);
  const safe = ActivityEventSchema.parse({ ...candidate, payload: redact(candidate.payload) });
  await tx.query(`insert into activity_events
    (id, business_id, type, correlation_id, actor_type, occurred_at, payload)
    values ($1,$2,$3,$4,$5,$6,$7)`, [safe.id, safe.businessId, safe.type, safe.correlationId,
    safe.actorType, safe.occurredAt, JSON.stringify(safe.payload)]);
}
