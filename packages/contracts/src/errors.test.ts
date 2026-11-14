import { describe, expect, it } from 'vitest';
import { ERROR_CODE_INFO, ErrorCodeSchema, ToolFailureReasonSchema, makeApiError } from './index';

describe('error codes', () => {
  it('equal the API.md section 2 table, with HTTP status and retryable flag', () => {
    const table: [string, number, boolean][] = [
      ['UNAUTHENTICATED', 401, false],
      ['FORBIDDEN_BUSINESS', 403, false],
      ['NOT_FOUND', 404, false],
      ['VALIDATION_FAILED', 400, false],
      ['INVALID_STATE', 409, false],
      ['CONFLICT_UNRESOLVED', 409, false],
      ['APPROVAL_EXPIRED', 409, false],
      ['APPROVAL_ALREADY_DECIDED', 409, false],
      ['PAYLOAD_HASH_MISMATCH', 409, false],
      ['CAPABILITY_NOT_ALLOWED', 422, false],
      ['INTEGRATION_UNAVAILABLE', 503, true],
      ['ENVIRONMENT_MISMATCH', 503, false],
      ['SIGNATURE_INVALID', 401, false],
      ['RATE_LIMITED', 429, true],
      ['INTERNAL', 500, true],
      ['QUOTE_EXPIRED', 409, false],
      ['ITEM_UNAVAILABLE', 409, false],
      ['SLOT_CONFLICT', 409, false],
    ];
    expect(ErrorCodeSchema.options).toEqual(table.map(([c]) => c));
    for (const [code, httpStatus, retryable] of table) {
      expect(ERROR_CODE_INFO[code as keyof typeof ERROR_CODE_INFO]).toEqual({ httpStatus, retryable });
    }
  });

  it('tool failure reasons are a subset of ErrorCode', () => {
    for (const r of ToolFailureReasonSchema.options) expect(ErrorCodeSchema.options).toContain(r);
    expect(ToolFailureReasonSchema.safeParse('INTERNAL').success).toBe(false);
  });

  it('makeApiError takes retryable from the table', () => {
    expect(makeApiError('INTEGRATION_UNAVAILABLE', 'Square timed out', 'c1', { provider: 'square' })).toEqual({
      code: 'INTEGRATION_UNAVAILABLE', message: 'Square timed out', correlationId: 'c1', retryable: true, details: { provider: 'square' },
    });
  });
});
