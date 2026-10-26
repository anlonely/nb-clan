import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
export const need = (ok, code, status = 422) => { if (!ok) throw new IdentityError(code, status); };
export const digest = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const fields = (input, allowed) => need(input && typeof input === 'object' && !Array.isArray(input) &&
  Object.keys(input).every(k => allowed.includes(k)), 'MEDIA_INPUT_INVALID');
export const integer = (value, fallback, min, max) => {
  const n = value ?? fallback; need(Number.isSafeInteger(n) && n >= min && n <= max, 'MEDIA_LIMIT_INVALID'); return n;
};
export const identifier = value => need(typeof value === 'string' && /^[A-Za-z0-9:_-]{1,200}$/.test(value), 'MEDIA_IDENTIFIER_INVALID');
export const METRICS = Object.freeze(['kda', 'kd', 'kills', 't3Kills', 'deaths', 'online_minutes', 'rockets', 'sulfur', 'metalOre', 'building']);
export const SHARE_PAGE = 'pages/rankings/index/index';
export const error = (code, status = 503) => new IdentityError(code, status);
