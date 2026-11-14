import { ERROR_CODE_INFO, type ApiError, type ErrorCode } from '@abos/contracts';

export type ErrorEnvelope = ApiError;

export class AppError extends Error {
  public readonly status: number;
  public readonly retryable: boolean;
  constructor(
    public readonly code: ErrorCode,
    message: string,
    _status?: number,
    _retryable?: boolean,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_CODE_INFO[code].httpStatus;
    this.retryable = ERROR_CODE_INFO[code].retryable;
  }
}
