import express from 'express';
import { randomUUID } from 'node:crypto';
import { need } from './model.js';
// Mount under /api BEFORE the old /wechat router when V2 is enabled. No legacy
// write may fall through to old arrays. Existing old sessions must log in again.
export function createLegacyMiniProgramRouter({adapter}){
 const router=express.Router();router.use('/wechat',express.json({limit:'32kb'}));
 router.use(['/wechat/admin','/wechat/join-applications'],(req,res)=>res.status(410).json({ok:false,error:'小程序审核与管理功能已移除。',errorCode:'MINI_MANAGEMENT_RETIRED'}));
 const wrap=fn=>async(req,res)=>{res.set('Cache-Control','no-store');try{need(adapter,'MINI_PROGRAM_NOT_CONFIGURED',503);const token=req.get('x-nb-wechat-session');const result=await fn(req,{token,operationId:req.get('Idempotency-Key')||`legacy-${randomUUID()}`});if(result?.status==='confirmation_required')return res.status(409).json({ok:false,error:'请在网站确认本次报名，不会直接覆盖现有安排。',errorCode:'SIGNUP_CONFIRMATION_REQUIRED',confirmationUrl:result.confirmationUrl});res.json({ok:true,...result});}catch(e){res.status(e.status||503).json({ok:false,error:e.errorCode==='MINI_SESSION_INVALID'?'登录已失效，请重新登录。':e.errorCode||'平台服务暂不可用',errorCode:e.errorCode||'PLATFORM_UNAVAILABLE'});}};
 router.post('/wechat/login',wrap(async r=>{const result=await adapter.login({code:r.body.code,clientVersion:1});return {sessionToken:result.token,expiresAt:result.expiresAt,capabilities:result.capabilities,accessStatus:{state:result.memberId?'verified_member':'unlinked',memberId:result.memberId},profile:result.profile};}));
 router.get('/wechat/capabilities',wrap(()=>({capabilities:adapter.capabilities()})));
 router.post('/wechat/wipes/:id/signup',wrap(async(r,e)=>{
  adapter.authenticate(e);need(r.params.id!=='current','EXPLICIT_WIPE_REQUIRED',409);
  const status=r.body.status;
  if(['cancel','cancelled','not_attending'].includes(status)){
   // Old client supplies no versions and cannot display a confirmation context.
   // Only the actor's confirmed Website view may turn this into a G04 command.
   await adapter.wipe(e,r.params.id);return {status:'confirmation_required',confirmationUrl:`/app/wipes/${encodeURIComponent(r.params.id)}?tab=plan#signup`};
  }
  const legacyStatus={on_time:'join',join:'join',join_8h:'join_8h',join_16h:'join_16h',late:'late'}[status];need(legacyStatus,'SIGNUP_ACTION_INVALID');
  return adapter.submit({...e,payload:{kind:'legacy',adapterVersion:1,wipeId:r.params.id,legacyStatus,legacyToggle:false,timeZone:'Asia/Shanghai'}});
 }));
 router.get('/wechat/wipes/:id',wrap((r,e)=>adapter.wipe(e,r.params.id)));
 // Remaining legacy endpoints are a controlled compatibility dispatch. The
 // adapter returns its actual domain DTO; no mock or generic success fallback.
 const routes=[['get','/me','me'],['get','/access-status','access_status'],['get','/member-specialties','specialties'],['get','/profile','profile'],['put','/profile','profile_save'],['post','/avatar','avatar'],['get','/notification-settings','notification_settings'],['put','/notification-settings','notification_settings_save'],['get','/notifications','notifications'],['post','/notifications/:notificationId/read','notification_read'],['get','/members','members'],['get','/rankings','rankings'],['get','/share-code','share_code'],['get','/avatar-image','avatar_image'],['post','/profile/refresh','profile_refresh'],['get','/wipes/:wipeId/participants','participants'],['get','/wipes/:wipeId/map-image','map']];
 const writes=new Set(['post','put','delete']);
 for(const[method,path,command]of routes)router[method]('/wechat'+path,wrap((r,e)=>{if(writes.has(method)){need(r.get('Idempotency-Key'),'CLIENT_UPGRADE_REQUIRED',409);need(Number.isSafeInteger(r.body?.expectedRevision),'CLIENT_UPGRADE_REQUIRED',409);}return adapter.command(e,command,{...r.query,...r.body,...r.params,...(path.endsWith('/sync-kda')?{type:'kda'}:path.endsWith('/sync-playtime')?{type:'battlemetrics_playtime'}:{}),provider:path.endsWith('/discord-user')?'discord':path.endsWith('/wechat-user')?'wechat':r.body?.provider});}));
 router.use('/wechat',(r,res)=>res.status(410).json({ok:false,error:'此旧入口已迁移，请更新客户端。',errorCode:'LEGACY_ENDPOINT_RETIRED'}));return router;
}
