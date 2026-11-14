/**
 * Turns what the owner types ("19.99", "$20", "1,250.00") into minor units
 * (cents) without floating point math. The string is split into its dollar
 * and cent digits and each part is read as a whole number, so 19.99 is
 * always 1999 and never 1998.9999.
 */

/** The highest price this screen accepts: $1,000.00. A typo such as 2000 for 20.00 is caught. */
export const MAX_PRICE_MINOR = 100_000;

export type ParseResult = {ok: true; minor: number} | {ok: false; message: string};

const AMOUNT = /^(\d*)(?:\.(\d*))?$/;
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d*)?$/;

/** Dollars and cents as typed, to minor units. Rejects anything that is not a plain amount. */
export function parseDollarsToMinor(input: string): ParseResult {
  let text = input.trim();
  if (text.startsWith('$')) text = text.slice(1).trim();
  if (text === '') return {ok: false, message: 'Enter a price, for example 19.99.'};
  if (text.includes(',')) {
    if (!GROUPED.test(text)) return {ok: false, message: 'Enter the price as a number, for example 1250.00.'};
    text = text.replace(/,/g, '');
  }
  const match = AMOUNT.exec(text);
  if (!match) return {ok: false, message: 'Enter the price as a number, for example 19.99.'};
  const dollars = match[1] ?? '';
  let cents = match[2] ?? '';
  if (dollars === '' && cents === '') return {ok: false, message: 'Enter the price as a number, for example 19.99.'};
  if (cents.length > 2) {
    // Extra zeros at the end are harmless ("19.900"). Anything else is a fraction of a cent.
    if (/[^0]/.test(cents.slice(2))) return {ok: false, message: 'Use at most two digits after the decimal point.'};
    cents = cents.slice(0, 2);
  }
  const wholeDollars = dollars.replace(/^0+(?=\d)/, '');
  if (wholeDollars.length > 9) return {ok: false, message: 'That amount is too large.'};
  const minor = Number(wholeDollars || '0') * 100 + Number(cents.padEnd(2, '0'));
  return {ok: true, minor};
}

/** Minor units back to the plain form the field shows, for example 2000 to "20.00". */
export function minorToInput(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(minor));
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${Math.floor(abs / 100)}.${cents}`;
}

/** Validates a new price against the current one. The message is shown next to the field. */
export function validateNewPrice(input: string, currentMinor: number): ParseResult {
  const parsed = parseDollarsToMinor(input);
  if (!parsed.ok) return parsed;
  if (parsed.minor <= 0) return {ok: false, message: 'The price must be more than $0.00.'};
  if (parsed.minor > MAX_PRICE_MINOR) return {ok: false, message: 'The price must be $1,000.00 or less.'};
  if (parsed.minor === currentMinor) return {ok: false, message: 'This is already the current price.'};
  return parsed;
}
