import { createHash, randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
export const need = (value, code, status = 409, options) => { if (!value) throw new IdentityError(code, status, options); };
export function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (value && Object.getPrototypeOf(value) === Object.prototype) return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  throw new IdentityError('NOTIFICATION_INPUT_INVALID', 422);
}
export const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export const newId = prefix => `${prefix}_${randomUUID()}`;
export const stamp = now => new Date(now()).toISOString();
export const identifier = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
export const reason = value => { need(typeof value === 'string' && value.trim().length > 0 && value.length <= 2000, 'REASON_REQUIRED', 422); return value.trim(); };
export const statuses = ['queued','sending','sent','retry_wait','failed','delivery_unknown','cancelled'];
export const purposes = ['signup_open','reminder','schedule_changed','signup_closed','cancelled','result'];
export const languages = ['zh-CN','en','ru','tr','th','ko'];
export function page(rows, query = {}, key = row => row.id) {
  const limit = Math.max(1, Math.min(50, Number(query.limit) || 20));
  const cursor = query.cursor || '';
  if (cursor) { const offset = rows.findIndex(row => key(row) === cursor); rows = offset < 0 ? [] : rows.slice(offset + 1); }
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? key(items.at(-1)) : null };
}
