import { createHmac } from 'node:crypto';
export class RelayAdminError extends Error {
  constructor(errorCode, status = 422) { super(errorCode); this.errorCode = errorCode; this.status = status; this.skipApiErrorLog = true; }
}
export const need = (ok, code, status) => { if (!ok) throw new RelayAdminError(code, status); };
export const signature = (key, value) => createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
export function fields(input, allowed) {
  need(input && Object.getPrototypeOf(input) === Object.prototype && Object.keys(input).every(k => allowed.includes(k)), 'INVALID_FIELDS');
}
export function operationId(value) { need(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value), 'OPERATION_ID_REQUIRED'); return value.toLowerCase(); }
export function normalizeInput(action, input) {
  need(['save','clear'].includes(action), 'UNKNOWN_RELAY_COMMAND', 404);
  fields(input, action === 'save' ? ['expectedRevision','token'] : ['expectedRevision']);
  need(typeof input.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(input.expectedRevision), 'EXPECTED_REVISION_REQUIRED');
  if (action === 'clear') return { expectedRevision: input.expectedRevision };
  // Same trim and 16..256 JS-string length semantics as saveRustplusRelayToken.
  need(typeof input.token === 'string', 'INVALID_TOKEN_LENGTH'); const token = input.token.trim();
  need(token.length >= 16 && token.length <= 256, 'INVALID_TOKEN_LENGTH');
  return { expectedRevision: input.expectedRevision, token };
}
export function safeError(error) {
  if (error instanceof RelayAdminError) return error;
  const allowed = ['AUTH_REQUIRED','AUTH_CHANGED','PERMISSIONS_CHANGED','ACCESS_DENIED','ACCESS_RESTRICTED','ACCOUNT_DISABLED','MEMBERSHIP_INACTIVE','IDENTITY_CONFLICT','SESSION_EXPIRED','SESSION_INVALID','SESSION_REVOKED','CSRF_INVALID','ORIGIN_INVALID'];
  return new RelayAdminError(allowed.includes(error?.errorCode) ? error.errorCode : 'RELAY_ADMIN_UNAVAILABLE', allowed.includes(error?.errorCode) ? error.status || 403 : 503);
}
