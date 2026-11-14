import { describe, expect, it } from 'vitest';
import { ERROR_CODE_INFO } from '@abos/contracts';
import { AppError } from '../../src/errors';

describe('AppError retryable', () => {
  it('takes the contract default when the caller passes none', () => {
    expect(new AppError('INTEGRATION_UNAVAILABLE', 'x').retryable).toBe(ERROR_CODE_INFO.INTEGRATION_UNAVAILABLE.retryable);
    expect(new AppError('VALIDATION_FAILED', 'x', undefined, undefined).retryable).toBe(false);
  });

  it('lets an explicit value win over the contract default', () => {
    expect(ERROR_CODE_INFO.INTEGRATION_UNAVAILABLE.retryable).toBe(true);
    expect(new AppError('INTEGRATION_UNAVAILABLE', 'x', undefined, false).retryable).toBe(false);
    expect(new AppError('VALIDATION_FAILED', 'x', undefined, true).retryable).toBe(true);
  });

  it('keeps the HTTP status from the contract', () => {
    expect(new AppError('INTEGRATION_UNAVAILABLE', 'x', 400, false).status).toBe(503);
  });
});
