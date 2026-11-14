import { describe, expect, it } from 'vitest';
import { ErrorCodeSchema } from '@abos/contracts';
import { ERROR_MESSAGES } from '../../src/error-messages';
import { PolicyError } from '../../src/policy/types';

/** A message an owner can read: not empty, not the code, no underscore, no word in capitals. */
function expectPlainSentence(message: string, code: string) {
  expect(message.trim(), code).not.toBe('');
  expect(message, code).not.toBe(code);
  expect(message, code).not.toContain('_');
  expect(message, code).not.toMatch(/[A-Z]{2,}/);
  expect(message, code).not.toMatch(/\s[-–—]\s/);
}

describe('plain error messages (issue #127)', () => {
  it('has one plain sentence for every contract error code', () => {
    expect(Object.keys(ERROR_MESSAGES).sort()).toEqual([...ErrorCodeSchema.options].sort());
    for (const code of ErrorCodeSchema.options) expectPlainSentence(ERROR_MESSAGES[code], code);
  });

  it('gives a PolicyError with no message the sentence for its code', () => {
    for (const code of ErrorCodeSchema.options) {
      const error = new PolicyError(code);
      expect(error.code).toBe(code);
      expect(error.message).toBe(ERROR_MESSAGES[code]);
    }
  });

  it('keeps a message the caller passes', () => {
    const error = new PolicyError('INVALID_STATE', 'The call has ended.');
    expect(error.code).toBe('INVALID_STATE');
    expect(error.message).toBe('The call has ended.');
  });
});
