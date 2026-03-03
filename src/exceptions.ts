export class Send2BooxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Send2BooxError';
  }
}

export class ConfigError extends Send2BooxError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class ApiError extends Send2BooxError {
  statusCode: number | null;
  status_code: number | null;
  payload: unknown;
  url: string | null;

  constructor(
    message: string,
    options?: {
      statusCode?: number | null;
      payload?: unknown;
      url?: string | null;
    }
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = options?.statusCode ?? null;
    this.status_code = this.statusCode;
    this.payload = options?.payload;
    this.url = options?.url ?? null;
  }
}

export class AuthenticationError extends ApiError {
  constructor(
    message: string,
    options?: {
      statusCode?: number | null;
      payload?: unknown;
      url?: string | null;
    }
  ) {
    super(message, options);
    this.name = 'AuthenticationError';
  }
}

export class ResponseFormatError extends ApiError {
  constructor(
    message: string,
    options?: {
      statusCode?: number | null;
      payload?: unknown;
      url?: string | null;
    }
  ) {
    super(message, options);
    this.name = 'ResponseFormatError';
  }
}

export class UploadError extends Send2BooxError {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}
