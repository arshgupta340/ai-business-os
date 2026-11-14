/**
 * Shared checks for the label coverage tests. Not a test file: vitest only
 * collects *.test.ts and *.test.tsx.
 */
import {expect} from 'vitest';

/** Short words an owner knows that are written in capitals. Everything else in capitals is a raw code. */
const ALLOWED_CAPITALS = new Set(['QR', 'OK']);

/**
 * Asserts that `label` is text an owner can read, and not the raw contract
 * value `raw`: it exists, it is not empty, it is not the raw value, it has no
 * underscore and no word in capitals such as PAYMENT_PENDING or FAILED. It
 * also holds the UI text rules: no em dash and no contraction.
 */
export function expectOwnerLabel(label: unknown, raw: string): void {
  const hint = `label ${JSON.stringify(label)} for ${JSON.stringify(raw)}`;
  expect(typeof label, hint).toBe('string');
  const text = label as string;
  expect(text.trim().length, `${hint} is empty`).toBeGreaterThan(0);
  expect(text, `${hint} has spaces around it`).toBe(text.trim());
  expect(text, `${hint} is the raw value`).not.toBe(raw);
  expect(text, `${hint} has an underscore`).not.toContain('_');
  expect(text, `${hint} reads "undefined" or "null"`).not.toMatch(/\b(undefined|null|NaN)\b|\[object/);
  const capitals = (text.match(/\b[A-Z][A-Z0-9]+\b/g) ?? []).filter((word) => !ALLOWED_CAPITALS.has(word));
  expect(capitals, `${hint} has a word in capitals`).toEqual([]);
  // A raw value with a separator or capitals never appears inside a label either.
  if (/[_.]|[A-Z]{2}/.test(raw)) expect(text, `${hint} contains the raw value`).not.toContain(raw);
  expect(text, `${hint} has an em dash`).not.toMatch(/[\u2013\u2014]/);
  expect(text, `${hint} has a contraction`).not.toMatch(/['\u2019]/);
}

/**
 * Values no contract has today, shaped like the values a later contract
 * version could add, plus names every JavaScript object inherits.
 */
export const FUTURE_VALUES: readonly string[] = [
  'SOMETHING_NEW',
  'REFUND_PENDING',
  'PAID_VERIFIED_AGAIN',
  'refund_requested',
  'on_hold',
  'email.receipt.send',
  'needsReview',
  'constructor',
  'toString',
  'hasOwnProperty',
  '__proto__',
  'valueOf',
];

/** What an untyped row can hold where a state is expected. */
export const NOT_TEXT: readonly unknown[] = [undefined, null, '', '   ', '___', 42, {}, []];
