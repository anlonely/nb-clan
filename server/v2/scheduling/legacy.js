import { v2IdentityEnabled } from '../identity/legacy.js';
export function legacySchedulingGuard(req, res, next) {
  if (v2IdentityEnabled() && !['GET','HEAD','OPTIONS'].includes(req.method) &&
    (/^\/wechat\/admin\/wipes(?:\/|$)/.test(req.path) || /^\/wechat\/wipes\/[^/]+\/signup$/.test(req.path))) {
    return res.status(410).json({ error: { errorCode: 'LEGACY_SCHEDULING_READONLY', messageKey: 'LEGACY_SCHEDULING_READONLY', retryable: false },
      next: '/app/home' });
  }
  next();
}
export function legacySignupInteractionNotice(customId) {
  if (!v2IdentityEnabled() || !String(customId).startsWith('nb_wipe_signup:')) return null;
  const wipeId = String(customId).split(':')[2];
  return { type: 4, data: { flags: 64, content: `报名规则已升级，请在网站确认此档期后提交：/app/wipes/${encodeURIComponent(wipeId || '')}` } };
}
