// The standard error envelope from docs/API.md.
// The full ErrorCode list arrives with the contracts package (task S-02).

export interface ErrorEnvelope {
  code: string;
  message: string;
  correlationId: string;
  retryable: boolean;
  details?: unknown;
}

export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
