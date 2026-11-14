import { z } from 'zod';

/** CONTRACTS 1: ISO 8601 UTC ending in `Z`. Offsets are refused. */
export const IsoDateTimeSchema = z.iso.datetime();
/** `YYYY-MM-DD`, read in the business timezone. */
export const LocalDateSchema = z.iso.date();
/** Local wall-clock time `HH:MM` (24 hour), used in hours facts. */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, { error: 'must be HH:MM' });
/** IANA timezone name, for example `America/Los_Angeles`. */
export const TimezoneSchema = z.string().min(1);
/** E.164, the same check as the database: `^\+[1-9][0-9]{6,14}$`. */
export const E164Schema = z.string().regex(/^\+[1-9][0-9]{6,14}$/, { error: 'must be an E.164 phone number' });
/** Last four digits of a phone number, the only form events may carry. */
export const Last4Schema = z.string().regex(/^[0-9]{4}$/);
/** SPEC 2.9 and DATA-MODEL 1: `sha256:` followed by 64 lowercase hex characters. */
export const Sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/, { error: 'must be sha256: plus 64 hex characters' });
/** SPEC 2.9 idempotency key: 64 lowercase hex characters, no prefix. */
export const IdempotencyKeySchema = z.string().regex(/^[0-9a-f]{64}$/, { error: 'must be 64 lowercase hex characters' });
/** CONTRACTS 1: the only currency. */
export const CurrencySchema = z.literal('USD');
export type Currency = z.infer<typeof CurrencySchema>;
/** Integer minor units, never negative. */
export const MinorAmountSchema = z.int().min(0);
/** Milliseconds from `from` to `to` (both ISO UTC strings already validated by `IsoDateTimeSchema`). */
export function msBetween(from: string, to: string): number {
  return Date.parse(to) - Date.parse(from);
}

/** Any JSON value (jsonb columns). */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;
