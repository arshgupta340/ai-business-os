import {describe, expect, it} from 'vitest';
import {ErrorCodeSchema} from '@abos/contracts';
import {ApiError, networkError} from './api/errors';
import {ERROR_TEXT, GENERIC_ERROR_TEXT, NETWORK_ERROR_TEXT, errorCodeText, errorText} from './error-text';
import {expectOwnerLabel, FUTURE_VALUES, NOT_TEXT} from './owner-label.test-helpers';

/** expectOwnerLabel, plus the sentence rules: no dotted identifier, no "Operation failed", ends with a full stop. */
function expectSentence(text: unknown, raw: string): void {
  expectOwnerLabel(text, raw);
  expect(text as string, `text for ${raw}`).not.toMatch(/\w\.\w/);
  expect(text as string, `text for ${raw}`).not.toMatch(/operation failed/i);
  expect(text as string, `text for ${raw}`).toMatch(/\.$/);
}

const apiError = (code: string, message: string) =>
  new ApiError({code: code as never, message, status: 409, retryable: false, kind: 'http'});

describe('ERROR_TEXT covers every contract error code', () => {
  it.each(ErrorCodeSchema.options)('%s', (code) => {
    expect(Object.hasOwn(ERROR_TEXT, code), 'no sentence in error-text.ts').toBe(true);
    expectSentence(ERROR_TEXT[code], code);
    expect(errorCodeText(code)).toBe(ERROR_TEXT[code]);
  });

  it('has no sentence for a code the contract does not have', () => {
    expect(Object.keys(ERROR_TEXT).sort()).toEqual([...ErrorCodeSchema.options].sort());
  });

  it('keeps the generic and network sentences plain', () => {
    expectSentence(GENERIC_ERROR_TEXT, 'GENERIC');
    expectSentence(NETWORK_ERROR_TEXT, 'NETWORK');
  });
});

describe('errorText', () => {
  it('returns the sentence for a known code', () => {
    expect(errorText(apiError('SLOT_CONFLICT', 'Slot taken'))).toBe(ERROR_TEXT.SLOT_CONFLICT);
    expect(errorText({code: 'RATE_LIMITED'})).toBe(ERROR_TEXT.RATE_LIMITED);
  });

  it('returns the generic sentence for a code it does not know', () => {
    for (const code of FUTURE_VALUES) expect(errorText({code, message: `Failed: ${code}`}), code).toBe(GENERIC_ERROR_TEXT);
  });

  it('never shows a server message that carries a code', () => {
    const message = 'Operation failed: INVALID_STATE.';
    expect(errorText(apiError('INVALID_STATE', message))).toBe(ERROR_TEXT.INVALID_STATE);
    expect(errorText({message})).toBe(GENERIC_ERROR_TEXT);
    expect(errorText({code: 'SOMETHING_NEW', message})).toBe(GENERIC_ERROR_TEXT);
    for (const code of ErrorCodeSchema.options) expectSentence(errorText(apiError(code, message)), code);
  });

  it('returns the generic sentence when fields are missing or not an error', () => {
    expect(errorText({})).toBe(GENERIC_ERROR_TEXT);
    expect(errorText(new Error('INTERNAL'))).toBe(GENERIC_ERROR_TEXT);
    for (const value of NOT_TEXT) expect(errorText(value), String(value)).toBe(GENERIC_ERROR_TEXT);
    for (const value of NOT_TEXT) expect(errorText({code: value}), String(value)).toBe(GENERIC_ERROR_TEXT);
  });

  it('says the server could not be reached for a network failure', () => {
    expect(errorText(networkError(new Error('offline')))).toBe(NETWORK_ERROR_TEXT);
  });
});
