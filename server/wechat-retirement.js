// The old entry points must not survive when the V2 host is unavailable.
// Browser management uses its existing routes; a mini Bearer cannot manage.
export function wechatRetirementGuard(req, res, next) {
  const path = req.path;
  const review = /^\/wechat\/(?:join-applications|admin\/(?:join-applications|member-bind-requests))(?:\/|$)/.test(path);
  const miniAdmin = /^\/wechat\/admin(?:\/|$)/.test(path) && Boolean(req.get('Authorization') || req.get('x-nb-wechat-session'));
  if (!review && !miniAdmin) return next();
  res.status(410).json({ ok: false, errorCode: 'MINI_FEATURE_RETIRED',
    error: review ? '小程序入队审核已下线，请在信息关联中关联战队账号。' : '小程序管理功能已下线，请使用网站管理端。' });
}
