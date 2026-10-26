export class IdentityError extends Error {
  constructor(errorCode, status = 403, options = {}) {
    super(errorCode);
    this.errorCode = errorCode;
    this.status = status;
    this.retryable = status === 503;
    Object.assign(this, options);
  }
}

export function requireValue(condition, code, status = 403) {
  if (!condition) throw new IdentityError(code, status);
}
