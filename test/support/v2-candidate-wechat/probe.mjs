import {observations} from '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {fixture,appId} from './fixture.mjs';
import {pngFixture} from '../v2-system-admin/image-fixture.mjs';
const config=JSON.parse(process.argv[2]),mode=process.argv[3]||'mini-media';
const opts={wechat:mode!=='unbound',enabled:mode!=='disabled',exchange:mode!=='missing-exchange',notification:mode!=='missing-transport',inbox:mode!=='missing-inbox',wrongApp:mode==='wrong-proof-app',seedMember:['mini-media','missing-media-ports','config-drift','media-drift'].includes(mode),mediaPorts:mode!=='missing-media-ports',ignoreExchangeAbort:mode==='exchange-stop',bindingAppId:mode==='wrong-app-pin'?'other_app':appId,pinnedRevision:mode==='wrong-revision-pin'?2:1};
const f=await fixture(config,opts),checks=[],extra={};let release;
const expect=async(route,args,status=200)=>{const r=await f.request(route,args);assert.equal(r.status,status,JSON.stringify(r.body));return r.body.data;};
const counts=()=>({accounts:f.identity.repo.all('accounts').length,identities:f.identity.repo.all('identities').length,bindings:f.identity.repo.all('bindings').length});
const notices=()=>f.identity.repo.db.prepare("SELECT payload_json FROM json_records WHERE collection='wechatNotifications'").all().map(r=>JSON.parse(r.payload_json));
const allDeliveries=()=>f.notice.service.repo.all('deliveries');
const miniLogin=async()=>expect('/mini-program/login',{body:{code:f.code('controlled_existing_member')},auth:false});
const command=(token,name,body={})=>expect('/mini-program/commands/'+name,{body,token,auth:false});
const changeConfig=async(fields={})=>{const c=f.managed.platforms.service.config('wechat');return expect('/platform-admin/wechat/config',{body:{expectedRevision:c.revision,config:{enabled:true,appId,minClientVersion:2,...fields}}});};
const bounded=async(p,label)=>{let timer;try{return await Promise.race([p,new Promise((_,j)=>timer=setTimeout(()=>j(Error('Timed out '+label)),10000))]);}finally{clearTimeout(timer);}};
async function gate(match,work,change){let enter;const entered=new Promise(r=>enter=r),waiting=new Promise(r=>release=r);f.setInterceptor(async req=>{if(match(req.path)){enter(req);await waiting;}});const pending=work().then(value=>({value}),error=>({error}));try{await bounded(entered,'native input');await change();}finally{release();f.setInterceptor(null);}const result=await bounded(pending,'native completion');release=null;if(result.error)throw result.error;return result.value;}
try{
 await expect('/wechat-onboarding/exchange',{body:{code:'retired'},auth:false},410);
 checks.push('retired-application-surface-stays-410');
 const db=f.identity.repo.db,before=counts(),beforeChanges=db.prepare('SELECT total_changes() n').get().n;
 f.owners.wechat.diagnostics();await expect('/platform-admin/wechat');assert.equal(db.prepare('SELECT total_changes() n').get().n,beforeChanges);checks.push('candidate-diagnostics-and-canonical-GET-do-not-write-or-migrate');
 assert.equal(f.managed.identity,f.identity);assert.equal(f.managed.inbox?.identity||f.identity,f.identity);assert.equal(f.notice.service.identity,f.identity);assert.equal(f.managed.scheduling,f.notice.service.scheduling);checks.push('same-G03-canonical-config-scheduling-and-original-notification-owner');
 if(['unbound','disabled','missing-exchange','wrong-app-pin','wrong-revision-pin'].includes(mode)){
  for(const route of ['/mini-program/login'])await expect(route,{body:{code:f.code()},auth:false},503);
  assert.equal(f.calls.length,0);checks.push('unbound-disabled-or-missing-trusted-exchange-stays-unavailable');
 }else if(mode==='wrong-proof-app'){
  await expect('/mini-program/login',{body:{code:f.code()},auth:false},401);assert.deepEqual(counts(),before);assert.equal(f.identity.repo.all('wechatUsers').length,0);checks.push('wrong-app-native-proof-never-creates-subject-or-session');
 }else if(['mini-media','missing-media-ports','config-drift','media-drift'].includes(mode)){
  const login=await miniLogin(),token=login.token;const profile=await command(token,'me');assert.equal(profile.profile.id,'g05_alpha');checks.push('original-mini-native-exchange-authenticates-existing-constructed-member-proof');
  const settings=await command(token,'notification_settings');assert.ok(settings.subscriptions);for(const p of Object.values(settings.subscriptions))assert.equal(p.platformVerified,false);checks.push('local-inbox-settings-never-claim-external-subscription-grant');
  if(mode==='missing-media-ports'){await expect('/platform-media/share-code?metric=kda',{token,auth:false,raw:true},503);await expect('/mini-program/commands/avatar',{token,auth:false,body:{}},503);assert.equal(f.managed.media,null);checks.push('incomplete-media-ports-disable-media-without-disabling-mini');}
  if(mode==='mini-media'){
   const image=pngFixture(16,16);const {createHash}=await import('node:crypto');await expect('/platform-media/avatar',{body:{dataUrl:'data:image/png;base64,'+image.toString('base64'),sha256:createHash('sha256').update(image).digest('hex'),expectedRevision:0},token,auth:false});
   const result=await f.request('/platform-media/avatar-image',{token,auth:false,raw:true});assert.equal(result.status,200);assert.deepEqual(result.body,image);
   for(let i=0;i<2;i++){const result=await f.request('/platform-media/share-code?metric=kda',{token,auth:false,raw:true});assert.equal(result.status,200);assert.deepEqual(result.body,image);}
   assert.equal(f.calls.filter(c=>c.path==='/controlled-share-code').length,1);checks.push('optional-original-media-avatar-and-native-share-code-cache');
   f.managed.inbox.repo.put('wechatNotifications',{id:'constructed-existing-inbox',appId,wechatUserId:'candidate-existing-wx',title:'Controlled existing notice',body:'Local inbox',revision:1,createdAt:new Date().toISOString()});
   const page=await command(token,'notifications');assert.equal(page.notifications[0].id,'constructed-existing-inbox');await command(token,'notification_read',{notificationId:'constructed-existing-inbox',expectedRevision:1});assert.ok(notices()[0].readAt);checks.push('original-mini-inbox-read-and-mark-read-use-current-subject');
  }
  if(mode==='config-drift'){
   await changeConfig();
   await expect('/mini-program/commands/me',{token,auth:false,body:{}},503);
   assert.equal(db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='mini-session'").get().n,0);
  }
  if(mode==='media-drift'){
   const result=await gate(path=>path==='/controlled-share-code',()=>f.request('/platform-media/share-code?metric=kda',{token,auth:false,raw:true}),()=>changeConfig());assert.ok(result.status>=400);assert.equal(f.managed.media.diagnostics().cacheEntries,0);checks.push('inflight-media-config-change-prevents-old-generation-cache-or-response');
  }
 }else if(['exchange-config-drift','exchange-stop'].includes(mode)){
  let stopped;const result=await gate(path=>path==='/controlled-code-exchange',()=>f.request('/mini-program/login',{body:{code:f.code('controlled_existing_member')},auth:false}),async()=>{
   if(mode==='exchange-config-drift')await changeConfig();else{stopped=f.host.stop();await new Promise(r=>setTimeout(r,30));assert.notEqual(f.host.status().state,'stopped');extra.nativePromisesOwnedBeforeRelease=f.host.status().nativeCalls;assert.equal(extra.nativePromisesOwnedBeforeRelease,1);assert.equal(db.prepare('SELECT 1 n').get().n,1);}
  });assert.ok(result.status>=400);if(stopped)await stopped;
  if(mode!=='exchange-stop')assert.equal(db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='mini-session'").get().n,0);
  else{assert.equal(f.host.status().state,'stopped');assert.equal(f.host.status().events.at(-1),'shared-sqlite-closed');extra.stopEvents=f.host.status().events;}
  checks.push('inflight-native-exchange-'+mode+'-never-mints-stale-context');
 }else throw new Error('Unsupported probe mode: '+mode);
 assert.equal(observations.forbiddenAttempts,0);assert.equal(observations.externalNetworkAttempts,0);assert.ok(f.calls.every(c=>!c.insideTransaction));checks.push('no-default-data-env-or-external-network-no-native-IO-in-member-transaction');
 const report={mode,checks,eventAuthor:'user_root',...(mode!=='exchange-stop'?{diagnostics:f.owners.wechat.diagnostics(),accountCounts:counts(),notificationStates:allDeliveries().map(d=>({id:d.id,status:d.status,platform:d.platform,lastErrorCode:d.lastErrorCode}))}:{}),calls:f.calls,observations,...extra,constructedLocalCodeExchange:true,constructedPreexistingMemberProof:opts.seedMember,realWechatCodeExchange:false,externalWechatSubscription:'unsupported'};
 const text=JSON.stringify(report,null,2);assert.ok(!/controlled-share-access-token|controlled-kook-verify-token|controlled_existing_member|controlled_new_subject/.test(text));console.log(text);
}finally{release?.();await f.close();}
