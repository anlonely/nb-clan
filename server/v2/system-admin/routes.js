import { brandName } from '../../branding.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { assertAccess } from './access.js';
import { need, SystemError } from './model.js';
export function createSystemAdminRouter({ service }) {
  need(service, 'SYSTEM_SERVICE_REQUIRED', 503);
  const router = express.Router(), base = '/system-admin';
  const wrap = fn => (req,res,next) => Promise.resolve().then(async () => {
    need(req.v2Identity?.service === service.identity, 'IDENTITY_CONTEXT_REQUIRED', 503);
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return fn(req,res);
  }).catch(next);
  const send = (req,res,data) => res.json({ data, meta: { schemaVersion: 1, requestId: req.v2RequestId || randomUUID(), serverTime: new Date().toISOString() } });
  router.get(base + '/access', wrap(async (req,res) => { const {actor} = await req.v2Identity.authenticate(); send(req,res,service.access(actor)); }));
  for (const [path,area] of [['brand','brand'],['proxy','proxy'],['public-api','api_keys'],['accounts','accounts'],['permissions','permissions'],['logs','logs'],['storage','storage']]) {
    router.get(base + '/' + path, wrap(async (req,res) => { const {actor} = await req.v2Identity.authenticate(); send(req,res,service.read(actor,area,req.query)); }));
  }
  router.get(base + '/accounts/roles', wrap(async (req,res) => { const {actor} = await req.v2Identity.authenticate(); send(req,res,service.identityAdmin.roles(service.actor(actor.id),{editable:false})); }));
  router.get(base + '/accounts/:id/restrictions', wrap(async (req,res) => {
    const {actor}=await req.v2Identity.authenticate();assertAccess(service.identity,service.actor(actor.id),'accounts',true);
    need(service.identity.repo.get('accounts',req.params.id),'RESOURCE_NOT_FOUND',404);
    send(req,res,{items:service.identity.repo.all('restrictions').filter(r=>r.accountId===req.params.id).map(r=>({id:r.id,revision:r.revision,startsAt:r.startsAt,endsAt:r.endsAt}))});
  }));
  router.get(base + '/accounts/:id/grants', wrap(async (req,res) => { const {actor} = await req.v2Identity.authenticate(); send(req,res,service.identityAdmin.grants(service.actor(actor.id),req.params.id)); }));
  router.get(base + '/storage/:id/preview', wrap(async (req,res) => { const {actor} = await req.v2Identity.authenticate(); send(req,res,service.preview(actor,req.params.id)); }));
  router.get(base + '/operations/:id', wrap(async (req,res) => { const {actor} = await req.v2Identity.authenticate(); send(req,res,service.getOperation(actor,req.params.id)); }));
  router.get(base + '/brand/logo/:id', wrap(async (req,res) => {
    const {actor} = await req.v2Identity.authenticate(); service.actor(actor.id);
    need(service.repo.meta('logoArtifactId',null) === req.params.id,'RESOURCE_NOT_FOUND',404);
    const a = service.repo.artifact(req.params.id); need(a,'RESOURCE_NOT_FOUND',404);
    res.set('Content-Security-Policy',"default-src 'none'").type(a.mimeType || 'application/octet-stream').send(service.storage.readLogo(a));
  }));
  router.get(base + '/public-api/doc', wrap(async (req,res) => {
    const {actor} = await req.v2Identity.authenticate(); assertAccess(service.identity,service.actor(actor.id),'api_keys');
    send(req,res,{ fileName:'NB-Clan-Public-API.md',contentType:'text/markdown',content: publicApiDocumentation });
  }));
  router.post(base + '/operations/:id/recover', wrap(async (req,res) => {
    const {actor} = await req.v2Identity.authenticate({mutation:true});
    need(req.get('Idempotency-Key') === req.params.id,'OPERATION_ID_REQUIRED');
    send(req,res,await service.recoverOperation(actor,req.params.id,{authenticate:()=>req.v2Identity.authenticate({mutation:true})}));
  }));
  router.post(base + '/commands/:action', express.json({limit:'30kb'}), wrap(async (req,res) => {
    const {actor} = await req.v2Identity.authenticate({mutation:true});
    need(req.body && typeof req.body === 'object' && Object.keys(req.body).every(k => ['target','input'].includes(k)),'INVALID_FIELDS');
    const data = await service.command(actor,req.params.action,req.body.target || '',req.body.input,req.get('Idempotency-Key'),
      {authenticate: () => req.v2Identity.authenticate({mutation:true})});
    send(req,res,data);
  }));
  router.use(base,(error,req,res,next) => {
    if (!error) return next();
    const known = error instanceof SystemError || typeof error.errorCode === 'string';
    const code = known ? error.errorCode : 'SYSTEM_UNAVAILABLE', status = known ? error.status || 503 : 503;
    res.status(status).set('Cache-Control','no-store').json({error:{ errorCode:code,messageKey:`system.${code}`,requestId:req.v2RequestId,
      operationId: /^[a-f0-9-]{36}$/i.test(req.get('Idempotency-Key') || '') ? req.get('Idempotency-Key') : undefined,
      retryable:status >= 500, ...(error.current ? {current:error.current} : {}) }});
  });
  return router;
}
export const publicApiDocumentation = `# ${brandName()} 公开查询 API

POST /api/integrations/public-query

由服务端验证公开 API Token，只可查询公开成员数据。此 Token 与 Rust+ relay、BattleMetrics、Steam 或 Bot 密钥不互通。

请求字段及响应投影由原公开查询适配器保持兼容；根入口须调用 SystemAdminService.verifyPublicToken，轮换或清空立即生效。

凭据使用 Authorization: Bearer <token> 或 X-NB-API-Token 请求头；body 为 {"steamInput":"7656119..."}。禁止放 URL 或日志。速率限制沿用原端点，不能借公开 API 读取账号、权限、手机号、内部备注、备份或代理配置。

系统管理端所有配置仅返回脱敏状态；密钥由 root 提供并保存，不回显。网站登录、平台 OAuth 与公开查询互相独立。
`;

/** Mount before the G03 router when system administration is enabled. These old G03
 * admin mutations lack the stable receipt and root/account guards introduced here.
 * Login, binding, auth events and platform eligibility-policy routes are unchanged. */
export function systemIdentityWriteCompatibilityGuard(req,res,next) {
  if (!['GET','HEAD','OPTIONS'].includes(req.method) && (/^\/identity\/accounts\/[^/]+$/.test(req.path) || req.path === '/identity/restrictions'))
    return res.status(410).set('Cache-Control','no-store').json({error:{errorCode:'SYSTEM_ADMIN_COMMAND_REQUIRED',messageKey:'system.useVersionedCommand',retryable:false}});
  next();
}
/** Use with the existing public-query DTO/Steam resolver/rate limiter, never a relay key. */
export function createPublicQueryTokenGuard(service) {
  return async (req,res,next) => {
    try {
      const bearer=String(req.get('authorization')||'').match(/^Bearer\s+(.+)$/i)?.[1];
      need(await service.verifyPublicToken((bearer||req.get('x-nb-api-token')||'').trim()),'PUBLIC_TOKEN_INVALID',401);
      next();
    } catch(e) {res.status(e.status||503).set('Cache-Control','no-store').json({error:{errorCode:e.errorCode||'PUBLIC_QUERY_UNAVAILABLE'}});}
  };
}
