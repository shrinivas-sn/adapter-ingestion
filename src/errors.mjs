export class IngestionError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'IngestionError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
