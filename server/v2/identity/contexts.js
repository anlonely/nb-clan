import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { IdentityError, requireValue } from './errors.js';

export const randomToken = () => randomBytes(32).toString('base64url');
export const digest = value => createHash('sha256').update(String(value || '')).digest('hex');
export function constantEqual(a, b) {
  return typeof a === 'string' && typeof b === 'string' &&
    Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function safeReturnTo(value) {
  if (typeof value !== 'string' || value.length > 2048) return '/app/home';
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { return '/app/home'; }
  if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.includes('%') ||
      !/^\/(app|admin)\//.test(decoded) || /(?:^|\/)\.{1,2}(?:\/|$)/.test(decoded.split(/[?#]/)[0]) ||
      /(?:callback|\/auth\/)/i.test(decoded)) return '/app/home';
  const url = new URL(value, 'https://local.invalid');
  return url.origin === 'https://local.invalid' && /^\/(app|admin)\//.test(url.pathname)
    ? `${url.pathname}${url.search}${url.hash}` : '/app/home';
}

// Single API process only. Restart intentionally invalidates unfinished logins.
// Only hashes of bearer tokens, browser bindings and CSRF secrets are retained.
export class AuthContexts {
  constructor({ now = Date.now, max = 5000, ttl = 600_000 } = {}) {
    this.now = now; this.max = max; this.ttl = ttl; this.entries = new Map();
    this.generation = 0; this.providerGenerations = new Map();
  }
  capture(provider) { return `${this.generation}:${this.providerGenerations.get(provider) || 0}`; }
  assertCurrent(generation, provider) {
    requireValue(generation === this.capture(provider), 'AUTH_CONTEXT_EXPIRED', 410);
  }
  invalidateProvider(provider) {
    this.providerGenerations.set(provider, (this.providerGenerations.get(provider) || 0) + 1);
  }
  clear() { this.generation++; this.entries.clear(); }
  issue({ browser, browserHash, purpose, provider, ...payload }, ttl = this.ttl) {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(key);
    requireValue(this.entries.size < this.max, 'AUTH_CAPACITY_EXCEEDED', 503);
    const token = randomToken();
    this.entries.set(digest(token), { ...payload, purpose, provider,
      browserBindingHash: browserHash || digest(browser), expiresAt: this.now() + ttl });
    return token;
  }
  read(token, { browser, purpose, provider, accountId } = {}) {
    requireValue(typeof token === 'string' && (!token || /^[A-Za-z0-9_-]{43}$/.test(token)), 'AUTH_INVALID_CALLBACK', 401);
    const entry = this.entries.get(digest(token));
    if (!entry || entry.expiresAt <= this.now()) throw new IdentityError('AUTH_CONTEXT_EXPIRED', 410);
    requireValue(entry.purpose === purpose && (!provider || entry.provider === provider) &&
      (!browser || constantEqual(entry.browserBindingHash, digest(browser))) &&
      (accountId === undefined || entry.accountId === accountId), 'AUTH_INVALID_CALLBACK', 401);
    return entry;
  }
  consume(token, checks) {
    const entry = this.read(token, checks);
    this.entries.delete(digest(token)); // Before any await/network call.
    return entry;
  }
  revoke(token) { this.entries.delete(digest(token)); }
}
