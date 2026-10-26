import { createHash, createHmac, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
export class SystemError extends Error {
  constructor(code, status = 422, current) { super(code); this.errorCode = code; this.status = status; this.current = current; }
}
export const need = (condition, code, status = 422, current) => { if (!condition) throw new SystemError(code, status, current); };
export const sha = value => createHash('sha256').update(value).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const signature = (key, value) => createHmac('sha256', key).update(JSON.stringify(canonical(value))).digest('hex');
export function text(value, max = 160, required = false) {
  need(typeof value === 'string' && value.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(value) && (!required || value.trim()), 'INVALID_TEXT');
  return value.trim();
}
export function fields(input, allowed) {
  need(input && !Array.isArray(input) && typeof input === 'object' && Object.keys(input).every(k => allowed.includes(k)), 'INVALID_FIELDS');
}
export function revision(expected, current = 0) {
  need(Number.isSafeInteger(expected) && expected >= 0, 'EXPECTED_REVISION_REQUIRED');
  need(expected === current, 'REVISION_CONFLICT', 409, { revision: current });
}
export function operationId(value) { need(typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value), 'OPERATION_ID_REQUIRED'); return value.toLowerCase(); }
export async function hashSecret(value, { min = 8, max = 128 } = {}) {
  need(typeof value === 'string' && value.length >= min && value.length <= max, 'INVALID_SECRET_LENGTH');
  const salt = randomBytes(16).toString('hex'), key = await promisify(scryptCallback)(value, salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export function safeText(value, max = 500) {
  return String(value || '').slice(0, max)
    .replace(/(?:Bearer\s+|(?:token|secret|password|api[_-]?key|authorization|code|phone|openid)\s*[=:]\s*)[^\s,;]+/gi, '[redacted]')
    .replace(/\b(?:https?|socks5h?):\/\/[^\s]+/gi, '[url]')
    .replace(/\b1[3-9]\d{9}\b/g, '[phone]').replace(/scrypt\$[^\s]+/g, '[redacted]');
}
export const nowIso = () => new Date().toISOString();
export function logoUrl(value) {
  text(value, 2048);
  if (!value || /^\/uploads\/[a-zA-Z0-9_./-]+$/.test(value) && !value.includes('..')) return value;
  let u; try { u = new URL(value); } catch { throw new SystemError('INVALID_LOGO_URL'); }
  need(u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash, 'INVALID_LOGO_URL');
  return u.href;
}
export function displayLogoUrl(value) {
  try { return /^\/api\/v2\/system-admin\/brand\/logo\/[a-f0-9-]{36}$/i.test(value || '') ? value : logoUrl(value || ''); }
  catch { return ''; }
}
export function proxyUrl(value) {
  text(value, 2048); if (!value) return '';
  let u; try { u = new URL(value); } catch { throw new SystemError('INVALID_PROXY_URL'); }
  need(['http:', 'https:', 'socks5:', 'socks5h:'].includes(u.protocol) && u.hostname && !u.search && !u.hash && ['','/'].includes(u.pathname), 'INVALID_PROXY_URL');
  return u.href;
}
export function maskedProxy(value) {
  if (!value) return '';
  try { const u = new URL(value); return `${u.protocol}//${u.username || u.password ? '***@' : ''}${u.host}`; } catch { return '[configured]'; }
}
