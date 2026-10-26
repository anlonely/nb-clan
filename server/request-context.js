import { normalizeText } from './store.js';

export function trustProxySetting(value = process.env.NB_TRUST_PROXY) {
  const configured = String(value || '').trim();
  const normalized = configured.toLowerCase();
  if (!configured || ['0', 'false', 'off', 'no'].includes(normalized)) return null;
  if (['1', 'true', 'on', 'yes'].includes(normalized)) {
    return ['loopback'];
  }
  const entries = configured.split(',').map((item) => item.trim()).filter(Boolean);
  const unsafeAliases = entries.filter((item) => ['linklocal', 'uniquelocal'].includes(item.toLowerCase()));
  if (unsafeAliases.length) {
    throw new Error(`NB_TRUST_PROXY must use explicit proxy IP/CIDR entries, not ${unsafeAliases.join(', ')}`);
  }
  return entries.length ? entries : null;
}

export function getIp(req = {}) {
  const socket = req?.socket || {};
  if (trustProxySetting()) {
    // Express resolves req.ip using the configured trusted proxy boundary.
    // Reading X-Forwarded-For directly would trust attacker-controlled hops.
    return String(req?.ip || socket.remoteAddress || 'unknown').trim();
  }
  return String(socket.remoteAddress || req?.ip || 'unknown').trim();
}

export function rateLimitKeyPart(value, maxLength = 160) {
  return normalizeText(value, maxLength).toLowerCase().replace(/\s+/g, ' ') || 'unknown';
}

export function wechatActorRateLimitKey(req) {
  return `wechat:${rateLimitKeyPart(req.wechatUser?.id || req.wechatSessionId || getIp(req))}`;
}

export function webOrWechatActorRateLimitKey(req) {
  return `actor:${rateLimitKeyPart(req.user?.id || req.wechatUser?.id || req.wechatSessionId || getIp(req))}`;
}

export function wechatRequestInputRateLimitKey(req) {
  const rawInput = req.body?.steamInput ?? req.body?.steamId ?? req.query?.q ?? req.query?.steamInput ?? '';
  return `input:${rateLimitKeyPart(rawInput)}`;
}

export function wechatActorInputRateLimitKey(req) {
  return `${wechatActorRateLimitKey(req)}:${wechatRequestInputRateLimitKey(req)}`;
}
