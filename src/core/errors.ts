export type GisErrorCode = 'INVALID_CONTAINER' | 'MAP_DISPOSED' | 'MAP_DESTROY_FAILED';

interface GisErrorOptions {
  readonly code: GisErrorCode;
  readonly module: string;
  readonly operation: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

export class GisError extends Error {
  readonly code: GisErrorCode;
  readonly module: string;
  readonly operation: string;
  readonly retryable: boolean;

  constructor(message: string, options: GisErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'GisError';
    this.code = options.code;
    this.module = options.module;
    this.operation = options.operation;
    this.retryable = options.retryable ?? false;
  }
}
