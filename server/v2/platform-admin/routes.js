import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { need } from './model.js';
export function createPlatformAdminRouter({getSystem}){
 if(typeof getSystem!=='function')throw new TypeError('getSystem required');const router=express.Router();router.use('/platform-admin/electricians',express.json({limit:'160kb'}));router.use('/platform-admin',express.json({limit:'64kb'}));
 const wrap=fn=>async(req,res)=>{const requestId=req.v2RequestId||randomUUID();res.set('Cache-Control','no-store');try{need(req.v2Identity?.authenticate,'AUTH_REQUIRED',401);const {actor}=await req.v2Identity.authenticate(req.method==='GET'?undefined:{mutation:true});const system=await getSystem(req);need(system?.service?.identity===req.v2Identity.service,'PLATFORM_SETUP_REQUIRED',503);if(req.method!=='GET')need(req.body&&typeof req.body==='object'&&!Array.isArray(req.body),'PLATFORM_INPUT_INVALID',422);const operation=()=>fn(system.service,actor,req,{operationId:req.get('Idempotency-Key')});const data=await (system.runOperation?system.runOperation(operation):operation());res.json({data,meta:{schemaVersion:1,requestId,serverTime:new Date().toISOString(),scopeVersion:actor.permissionVersion}});}catch(e){sendError(res,e,requestId,req.get('Idempotency-Key'));}};
 router.get('/platform-admin',wrap((s,a)=>s.list(a)));
 router.get('/bot-admin/open-signups',wrap((s,a,r)=>s.openSignups(a,r.query)));
 router.get('/bot-admin/open-signups/:id/signups',wrap((s,a,r)=>s.openSignupRoster(a,r.params.id,r.query)));
 router.get('/bot-admin/open-signups/:id',wrap((s,a,r)=>s.openSignup(a,r.params.id)));
 router.get('/platform-admin/electricians',wrap((s,a)=>s.electricianRosterDetailWithAvatars(a)));
 router.post('/platform-admin/electricians',wrap((s,a,r,o)=>s.saveElectricianRoster(a,r.body,o)));
 router.get('/platform-admin/operations/:id',wrap((s,a,r)=>s.receipt(a,r.params.id)));
 router.get('/platform-admin/steam/login',wrap((s,a)=>s.steamLoginDetail(a)));
 router.post('/platform-admin/steam/login',wrap((s,a,r,o)=>s.saveSteamLogin(a,r.body,o)));
 router.get('/platform-admin/:id/audit',wrap((s,a,r)=>s.history(a,r.params.id,r.query)));
 router.get('/platform-admin/:id',wrap((s,a,r)=>s.detail(a,r.params.id)));
 router.post('/platform-admin/:id/config',wrap((s,a,r,o)=>s.save(a,r.params.id,r.body,o)));
 router.post('/platform-admin/:id/secrets',wrap((s,a,r,o)=>s.secrets(a,r.params.id,r.body,o)));
 router.post('/platform-admin/:id/actions/:action',wrap((s,a,r,o)=>s.execute(a,r.params.id,r.params.action,r.body,o)));
 router.use('/platform-admin',(e,r,res,next)=>sendError(res,new IdentityError('PLATFORM_INPUT_INVALID',e.status===413?413:422),r.v2RequestId||randomUUID()));return router;
}
export function sendError(res,e,requestId,operationId=null){const known=e instanceof IdentityError;res.status(known?e.status:503).json({error:{errorCode:known?e.errorCode:'PLATFORM_UNAVAILABLE',messageKey:known?e.errorCode:'PLATFORM_UNAVAILABLE',requestId,operationId,retryable:known?Boolean(e.retryable):true,current:known?e.current||null:null,fieldErrors:{}}});}
// Mount separately from G03 browser CSRF middleware. Bearer sessions are created
// only from a server-verified app-scoped code; a browser cookie is never accepted.
export function createMiniProgramRouter({adapter}){
 const router=express.Router();router.post('/mini-program/profile/avatar',express.json({limit:'1400kb',strict:true}));router.use('/mini-program',express.json({limit:'32kb'}));
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');const requestId=randomUUID();try{need(adapter,'MINI_PROGRAM_NOT_CONFIGURED',503);const token=/^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(req.get('Authorization')||'')?.[1];const data=await fn(req,{token,operationId:req.get('Idempotency-Key'),payload:req.body});res.json({data,meta:{schemaVersion:2,requestId}});}catch(e){sendError(res,e,requestId);}};
 router.get('/mini-program/profile',wrap((r,e)=>adapter.wechatLink.profile(e)));
 router.put('/mini-program/profile',wrap((r,e)=>adapter.wechatLink.saveProfile(e,r.body)));
 router.post('/mini-program/profile/avatar',wrap((r,e)=>adapter.wechatLink.avatar(e,r.body)));
 router.get('/mini-program/profile/avatar',async(r,res)=>{res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});try{const token=/^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(r.get('Authorization')||'')?.[1];const result=adapter.wechatLink.avatarImage({token});res.type(result.contentType).send(result.bytes);}catch(e){sendError(res,e,randomUUID());}});
 router.get('/mini-program/community-avatar/:provider',async(r,res)=>{
  const controller=new AbortController(),abort=()=>controller.abort(),closed=()=>{if(!res.writableEnded)abort();};
  r.once('aborted',abort);res.once('close',closed);
  res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});
  try{
   need(Object.keys(r.query).length===0&&(!r.body||Object.keys(r.body).length===0),'PLATFORM_INPUT_INVALID',422);
   need(adapter?.communityAvatar,'MEDIA_FETCH_UNAVAILABLE',503);
   const token=/^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(r.get('Authorization')||'')?.[1];
   const result=await adapter.communityAvatar.image({token},r.params.provider,controller.signal);
   if(!res.destroyed)res.type(result.contentType).send(result.bytes);
  }catch(e){if(!res.destroyed)sendError(res,e,randomUUID());}
  finally{r.removeListener('aborted',abort);res.removeListener('close',closed);}
 });
 router.post('/mini-program/link/code',wrap((r,e)=>adapter.wechatLink.createCode(e,r.body)));
 router.get('/mini-program/link/status',wrap((r,e)=>adapter.wechatLink.miniStatus(e,r.query.linkId)));
 router.post('/mini-program/link/scan',wrap((r,e)=>adapter.wechatLink.scan(e,r.body)));
 router.post('/mini-program/link/confirm',wrap((r,e)=>adapter.wechatLink.confirm(e,r.body)));
 router.get('/mini-program/capabilities',wrap(()=>adapter.capabilities()));router.post('/mini-program/login',wrap(r=>adapter.login(r.body)));router.post('/mini-program/logout',wrap((r,e)=>adapter.logout(e)));router.get('/mini-program/wipes/:id',wrap((r,e)=>adapter.wipe(e,r.params.id)));router.post('/mini-program/signup',wrap((r,e)=>adapter.submit(e)));router.post('/mini-program/commands/:id',wrap((r,e)=>adapter.command(e,r.params.id,r.body)));return router;
}

// This face is mounted behind the existing browser identity middleware. Its
// mutations use that middleware's cookie, exact Origin and CSRF checks.
export function createWechatLinkRouter({service, identity}) {
 const router=express.Router();router.use('/wechat-link',express.json({limit:'8kb'}));
 const wrap=(fn,bytes=false)=>async(req,res)=>{const requestId=randomUUID();res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});try{
  need(req.v2Identity?.service===identity && req.v2Identity?.authenticate,'AUTH_REQUIRED',401);
  const {actor}=await req.v2Identity.authenticate(req.method==='GET'?undefined:{mutation:true});
  const data=await fn(actor,req);
  if(bytes)res.type(data.contentType).send(data.bytes);else res.json({data,meta:{schemaVersion:1,requestId}});
 }catch(error){sendError(res,error,requestId);}};
 router.post('/wechat-link/claim',wrap((actor,req)=>service.claim(actor,req.body,req.ip)));
 router.post('/wechat-link/qr',wrap((actor,req)=>service.createQr(actor,req.body)));
 router.get('/wechat-link/status',wrap((actor,req)=>service.webStatus(actor,req.query.linkId)));
 router.get('/wechat-link/avatar',wrap((actor,req)=>service.webAvatar(actor,req.query.linkId),true));
 router.use('/wechat-link',(error,req,res,next)=>sendError(res,new IdentityError('WECHAT_LINK_INPUT_INVALID',error.status===413?413:422),randomUUID()));
 return router;
}
