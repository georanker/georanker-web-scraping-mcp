export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryAfterSeconds?: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
