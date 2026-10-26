import { authorize,can } from '../identity/permissions.js';
import { authorizeSteamTeamConfiguration, canConfigureSteamTeams } from './steam-team-config.js';
import { IdentityError } from '../identity/errors.js';
import { electricianRosterDetail, saveElectricianRoster } from './electrician-roster.js';
import { steamAvatarUrl } from './electrician-avatars.js';
import { scopedConfigInput, pruneRemovedCommands } from './config-sections.js';
import { listOpenSignups, openSignupDetail, openSignupRoster } from './open-signups-admin.js';
import { readAuditPage } from './audit-query.js';
import { PlatformAdminRepository } from './repository.js';
import { ACTIONS,UNAVAILABLE,defaults,hash,identifier,ids,need,normalizeConfig,scopeId,secretFields,text,stripRetiredRegistrationConfig } from './model.js';
// Adapters perform domain authorization again. Browser permissions never authorize a platform session.
export class PlatformAdminService{
 constructor({identity,adapters={},now=Date.now,electricianAvatars}){need(identity?.repo?.db,'PLATFORM_SETUP_REQUIRED',503);this.identity=identity;this.repo=new PlatformAdminRepository(identity.repo.db);this.adapters=adapters;this.now=now;this.electricianAvatars=electricianAvatars;this.adapters.identity={savePolicy:({actor,platform,input,assertCurrent})=>{assertCurrent();const p=this.identity.savePolicy(actor,{...input.policy,provider:platform,defaultRoleId:'member',expectedRevision:input.expectedPolicyRevision});return {schema:'platform-result/1',state:'succeeded',items:[{id:p.id,label:'登录准入已更新；该平台会话需要重新登录',status:'succeeded'}]};}};}
 actor(a,id,write=false){need(ids.includes(id),'RESOURCE_NOT_FOUND',404);const current=this.identity.actorForAccount(a.id);authorize(current,write?'platforms.configure':'platforms.read',{kind:'platformTarget',id:scopeId(id)},this.identity.relations());return current;}
 openSignups(a,query){return listOpenSignups(this,a,query);}
 openSignup(a,id){return openSignupDetail(this,a,id);}
 openSignupRoster(a,id,query){return openSignupRoster(this,a,id,query);}
 electricianRosterDetail(a){return electricianRosterDetail(this,a);}
 async electricianRosterDetailWithAvatars(a){
  const detail=this.electricianRosterDetail(a);
  if(!this.electricianAvatars)return detail;
  let images;
  try{images=await this.electricianAvatars.read(detail.resolved);}catch{/* Avatars are optional; the current roster remains usable. */}
  // The remote wait cannot authorize a stale member or roster. Project the
  // current permission-filtered detail and attach only validated matching URLs.
  const current=this.electricianRosterDetail(a),byUrl=new Map(Object.values(images||{}).flat().map(row=>[row.url,steamAvatarUrl(row.avatar)]));
  const resolved=Object.fromEntries(Object.entries(current.resolved).map(([group,rows])=>[group,rows.map(row=>({...row,avatar:steamAvatarUrl(row.avatar)||byUrl.get(row.url)||''}))]));
  const selected=new Map(Object.values(resolved).flat().map(row=>[row.url,row.avatar]));
  return {...current,resolved,members:current.members.map(member=>({...member,avatar:steamAvatarUrl(member.avatar)||selected.get(`https://steamcommunity.com/profiles/${member.steamId}/`)||''}))};
 }
 saveElectricianRoster(a,input,{operationId}={}){return saveElectricianRoster(this,a,input,operationId);}
 steamActor(a,write=false){const current=this.identity.actorForAccount(a.id);authorize(current,write?'platforms.configure':'platforms.read',{kind:'platformTarget',id:'steam'},this.identity.relations());return current;}
 steamLoginDetail(a){a=this.steamActor(a);const steam=this.identity.repo.scalar('settings')?.thirdPartyLogin?.steam||{},origin=this.identity.origin||'';return {enabled:steam.enabled!==false,updatedAt:steam.updatedAt||'',canConfigure:can(a,'platforms.configure',{kind:'platformTarget',id:'steam'},this.identity.relations()),method:'OpenID 2.0',providerUrl:'https://steamcommunity.com/openid/login',startUrl:`${origin}/api/v2/auth/steam/start`,callbackUrl:`${origin}/api/v2/auth/steam/login-callback`};}
 saveSteamLogin(a,input,{operationId}={}){
  a=this.steamActor(a,true);need(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(key=>['enabled','expectedUpdatedAt'].includes(key)),'PLATFORM_INPUT_INVALID');
  need(typeof input.enabled==='boolean'&&typeof input.expectedUpdatedAt==='string'&&input.expectedUpdatedAt.length<=40,'PLATFORM_INPUT_INVALID');identifier(operationId);
  const digest=hash({action:'steam_login_save',input}),old=this.repo.get('operation',operationId);
  if(old){need(old.actorId===a.id&&old.digest===digest,'IDEMPOTENCY_CONFLICT',409);return {...old,current:this.steamLoginDetail(a)};}
  return this.repo.transaction(()=>{
   this.steamActor(a,true);
   const settings=this.identity.repo.scalar('settings')||{},steam=settings.thirdPartyLogin?.steam||{};
   need((steam.updatedAt||'')===input.expectedUpdatedAt,'REVISION_CONFLICT',409,{updatedAt:steam.updatedAt||''});
   const updatedAt=new Date(Math.max(this.now(),(Date.parse(steam.updatedAt)||0)+1)).toISOString();
   this.identity.repo.setScalar('settings',{...settings,thirdPartyLogin:{...settings.thirdPartyLogin,steam:{...steam,enabled:input.enabled,updatedAt}}});
   const record={operationId,platform:'steam',actorId:a.id,digest,action:'steam_login_save',status:'succeeded',enabled:input.enabled,updatedAt};
   this.repo.put('operation',operationId,'steam',a.id,this.now(),record);
   this.audit('steam',a,operationId,'steam_login_save','succeeded');
   this.identity.audit('steam_login_settings_changed',a.id,{enabled:input.enabled});
   return {...record,current:this.steamLoginDetail(a)};
  });
 }
 root(a){return this.identity.actorForAccount(a.id).roleId==='owner';}
 config(id){return stripRetiredRegistrationConfig(id,this.repo.get('config',id)||defaults(id));}
 secretStatus(id){const saved=this.repo.get('secret-status',id)||{},effective=this.adapters.vault?.statusSync?.({db:this.repo.db,platform:id})||{};return {...saved,...Object.fromEntries((secretFields[id]||[]).filter(key=>typeof effective[key]==='boolean').map(key=>[key,effective[key]]))};}
 detail(a,id){a=this.actor(a,id);const c=this.config(id),state=this.repo.get('status',id),community=['discord','kook'].includes(id),relations=this.identity.relations(),loginPolicy=community&&can(a,'platforms.configure',{kind:'platformTarget',id},relations)?this.identity.repo.all('policies').find(p=>p.provider===id)||null:null;return {...c,secretStatus:this.secretStatus(id),configurationState:c.revision?'saved':'missing',validation:state||{state:'unverified',observedAt:null},websiteOAuth:id==='wechat'?{state:'unavailable',reason:'WEBSITE_OAUTH_NOT_VERIFIED'}:undefined,canConfigure:can(a,'platforms.configure',{kind:'platformTarget',id:scopeId(id)},relations),canEditTranslationCredentials:this.root(a),canManageSystemRoleMappings:this.root(a),canConfigureSteamTeams:id==='discord'&&canConfigureSteamTeams(a,relations),squadCatalog:community?this.identity.repo.all('squads').filter(s=>!s.archivedAt&&can(a,'squads.read',{kind:'squad',id:s.id},relations)).map(s=>({id:s.id,name:s.name,canManage:can(a,'squads.manage',{kind:'squad',id:s.id},relations)})):[],loginPolicy,channelCatalogs:this.channelCatalogs(id,c),guildCatalog:this.guildCatalog(id,c),loginRoleCatalog:loginPolicy?this.loginRoleCatalog(id,loginPolicy.guildId,c):null,lastExecution:this.repo.get('health',id),actions:Object.entries(ACTIONS).filter(([,v])=>!v.platforms||v.platforms.includes(id)).map(([key,v])=>({id:key,available:typeof this.adapters[v.adapter]?.[v.method]==='function'})),callbackOwner:'G06 notification-platforms',notificationUrl:'/admin/wipes',updatedAt:c.updatedAt||null};}
 // Display-only adapter metadata: eligibility continues to use policy role IDs only.
 loginRoleCatalog(platform,guildId,config=this.config(platform)){
  const cached=this.repo.get('role-catalog',JSON.stringify([platform,guildId]));
  if(cached?.guildId===guildId)return {guildId,items:roleItems(cached.items)};
  const targetIds=new Set((config.targets||[]).filter(t=>t.guildId===guildId).map(t=>t.id));
  // Legacy receipts did not retain metadata kind/page; only role-shaped successful
  // results from the current config revision can safely identify historical names.
  const rows=this.repo.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='operation' AND platform=? AND json_extract(payload,'$.action')='metadata' AND json_extract(payload,'$.revision')=? AND json_extract(payload,'$.status')='succeeded' AND json_extract(payload,'$.result.state')='succeeded' ORDER BY rowid").all(platform,config.revision);
  const items=new Map();
  for(const row of rows){const r=JSON.parse(row.payload);if(r.resource?.kind==='platformTarget'&&targetIds.has(r.resource.id))for(const item of roleItems(r.result?.items))items.set(item.id,item);}
  return {guildId,items:[...items.values()]};
 }
 cacheLoginRoles(platform,input,dto,actor){
  if(!['discord','kook'].includes(platform)||input.kind!=='roles'||dto.state!=='succeeded')return;
  const target=this.config(platform).targets?.find(t=>t.id===input.targetId);if(!target?.guildId)return;
  const key=JSON.stringify([platform,target.guildId]),previous=this.repo.get('role-catalog',key);
  const items=new Map((input.page==null||input.page===1?[]:roleItems(previous?.items)).map(item=>[item.id,item]));
  for(const item of roleItems(dto.items))items.set(item.id,item);
  this.repo.put('role-catalog',key,platform,actor.id,this.now(),{guildId:target.guildId,items:[...items.values()]});
 }
 // Catalogs contain only successful, projected adapter metadata, never config labels.
 metadataReceipts(platform,config){return this.repo.db.prepare("SELECT payload FROM platform_admin_records WHERE kind='operation' AND platform=? AND json_extract(payload,'$.action')='metadata' AND json_extract(payload,'$.revision')=? AND json_extract(payload,'$.status')='succeeded' AND json_extract(payload,'$.result.state')='succeeded' ORDER BY rowid").all(platform,config.revision).map(row=>JSON.parse(row.payload));}
 channelCatalogs(platform,config=this.config(platform)){
  if(!['discord','kook'].includes(platform))return [];
  const rows=this.metadataReceipts(platform,config);
  return [...new Set((config.targets||[]).map(t=>t.guildId).filter(Boolean))].map(guildId=>{
   const cached=this.repo.get('channel-catalog',JSON.stringify([platform,guildId]));
   const targets=new Set(config.targets.filter(t=>t.guildId===guildId).map(t=>t.id)),items=new Map();
   for(const r of rows)if(r.resource?.kind==='platformTarget'&&targets.has(r.resource.id))for(const item of channelItems(r.result?.items))items.set(item.id,item);
   for(const item of channelItems(cached?.items))items.set(item.id,item);
   return {guildId,items:[...items.values()]};
  });
 }
 guildCatalog(platform,config=this.config(platform)){
  if(!['discord','kook'].includes(platform))return {items:[]};
  const items=new Map();
  for(const r of this.metadataReceipts(platform,config))if(r.resource?.kind==='platformTarget'&&r.resource.id===platform)for(const item of guildItems(r.result?.items))items.set(item.id,item);
  for(const item of guildItems(this.repo.get('guild-catalog',platform)?.items))items.set(item.id,item);
  return {items:[...items.values()]};
 }
 preserveMetadata(platform,actor){
  for(const catalog of this.channelCatalogs(platform))if(catalog.items.length)this.repo.put('channel-catalog',JSON.stringify([platform,catalog.guildId]),platform,actor.id,this.now(),catalog);
  const guilds=this.guildCatalog(platform);if(guilds.items.length)this.repo.put('guild-catalog',platform,platform,actor.id,this.now(),guilds);
 }
 cacheMetadata(platform,input,dto,actor){
  this.cacheLoginRoles(platform,input,dto,actor);
  if(!['discord','kook'].includes(platform)||dto.state!=='succeeded')return;
  if(input.kind==='guilds'){
   const items=new Map(this.guildCatalog(platform).items.map(item=>[item.id,item]));for(const item of guildItems(dto.items))items.set(item.id,item);
   this.repo.put('guild-catalog',platform,platform,actor.id,this.now(),{items:[...items.values()]});
  }else if(input.kind===undefined||input.kind==='channels'){
   const target=this.config(platform).targets?.find(t=>t.id===input.targetId);if(!target?.guildId)return;
   const previous=this.channelCatalogs(platform).find(c=>c.guildId===target.guildId),items=new Map((previous?.items||[]).map(item=>[item.id,item]));
   for(const item of channelItems(dto.items))items.set(item.id,item);
   this.repo.put('channel-catalog',JSON.stringify([platform,target.guildId]),platform,actor.id,this.now(),{guildId:target.guildId,items:[...items.values()]});
  }
 }
 list(a){const actor=this.identity.actorForAccount(a.id);return {items:ids.filter(id=>can(actor,'platforms.read',{kind:'platformTarget',id:scopeId(id)},this.identity.relations())).map(id=>this.detail(actor,id))};}
 audit(id,a,operationId,action,status){this.repo.put('audit',`${operationId}:${status}`,id,a.id,this.now(),{id:`${operationId}:${status}`,platform:id,actorId:a.id,operationId,action,status,at:new Date(this.now()).toISOString()});}
 receipt(a,id){const r=this.repo.get('operation',id);need(r&&r.actorId===a.id,'RESOURCE_NOT_FOUND',404);const current=r.platform==='steam'?this.steamActor(a,true):this.actor(a,r.platform,true);if(r.extraCapability)authorize(current,r.extraCapability,r.resource,this.identity.relations());if(['card_publish','card_refresh'].includes(r.action)&&this.adapters.cards?.receipt){const fresh=this.adapters.cards.receipt({actor:current,operation:r});if(fresh){const dto=projectResult(fresh);return {...r,status:dto.state==='unknown'?'result_unknown':dto.state,result:dto,replayed:true};}}return r.result?{...r,result:{schema:'platform-result/1',state:r.result.state,reference:r.result.reference,items:[],counts:null,preview:null},replayed:true}:r;}
 begin(a,id,input,operationId,action){identifier(operationId);const digest=hash({id,input,action});const old=this.repo.get('operation',operationId);if(old){need(old.actorId===a.id&&old.digest===digest,'IDEMPOTENCY_CONFLICT',409);return {old};}need(input.expectedRevision===this.config(id).revision,'REVISION_CONFLICT',409,{revision:this.config(id).revision});return {digest};}
 save(a,id,input,{operationId}){a=this.actor(a,id,true);const scoped=scopedConfigInput(id,input);const {old,digest}=this.begin(a,id,input,operationId,'save');if(old)return {...old,current:this.detail(a,id)};const current=this.config(id),normalized=pruneRemovedCommands(current,normalizeConfig(id,scoped),input.configSection);
  if(['discord','kook'].includes(id))for(const key of ['roleSpecialtyMappings','roleSquadMappings','roleSystemMappings'])if(!Object.hasOwn(input.config,key))delete normalized[key];
  if(id==='discord')authorizeSteamTeamConfiguration(this.identity,a,current,normalized);
  if(id==='bridge'&&Object.hasOwn(normalized,'translationBaseUrl'))need(this.root(a)||normalized.translationBaseUrl===current.translationBaseUrl,'ROOT_REQUIRED',403);
  if(['discord','kook'].includes(id)){
   const changed=key=>Object.hasOwn(normalized,key)&&JSON.stringify(normalized[key])!==JSON.stringify(current[key]||[]);
   if(changed('roleSystemMappings'))need(this.root(a),'ROOT_REQUIRED',403);
   const relations=this.identity.relations();
   if(changed('roleSquadMappings'))for(const rule of [...current.roleSquadMappings||[],...normalized.roleSquadMappings||[]])authorize(a,'squads.manage',{kind:'squad',id:rule.squadId},relations);
   for(const rule of [...normalized.roleSquadMappings||[]])need(this.identity.repo.get('squads',rule.squadId)&&!this.identity.repo.get('squads',rule.squadId).archivedAt,'SQUAD_UNAVAILABLE',422);
   const policy=this.identity.repo.all('policies').find(p=>p.provider===id);
   for(const rule of [...normalized.roleSpecialtyMappings||[],...normalized.roleSquadMappings||[],...normalized.roleSystemMappings||[]])if(rule.roleId)need(policy?.guildId===rule.guildId,'ROLE_GUILD_MISMATCH',422);
  }
  return this.repo.transaction(()=>{this.preserveMetadata(id,a);const c={...this.config(id),...normalized,revision:this.config(id).revision+1,updatedAt:new Date(this.now()).toISOString()};this.repo.put('config',id,id,a.id,this.now(),c);this.repo.put('status',id,id,a.id,this.now(),{state:'unverified',observedAt:null});const receipt={operationId,platform:id,actorId:a.id,digest,status:'succeeded',revision:c.revision};this.repo.put('operation',operationId,id,a.id,this.now(),receipt);this.audit(id,a,operationId,'save','succeeded');return {...receipt,current:this.detail(a,id)};});}
 secrets(a,id,input,{operationId}){a=this.actor(a,id,true);if(id==='bridge'&&Object.keys(input.values||{}).includes('translationApiKey'))need(this.root(a),'ROOT_REQUIRED',403);need(this.adapters.vault?.writeSync,UNAVAILABLE,503);need(input.values&&Object.keys(input.values).length>0);for(const [key,value]of Object.entries(input.values)){need(secretFields[id].includes(key)||id==='bridge'&&/^route:[A-Za-z0-9_-]+:kookAccessToken$/.test(key));text(value,4096);}const {old,digest}=this.begin(a,id,{expectedRevision:input.expectedRevision,values:Object.fromEntries(Object.entries(input.values).map(([k,v])=>[k,hash(v)]))},operationId,'secrets');if(old)return old;
  return this.repo.transaction(()=>{this.preserveMetadata(id,a);this.adapters.vault.writeSync({db:this.repo.db,platform:id,values:input.values,operationId});const flags={...(this.repo.get('secret-status',id)||{}),...Object.fromEntries(Object.entries(input.values).map(([k,v])=>[k,Boolean(v)]))};this.repo.put('secret-status',id,id,a.id,this.now(),flags);const c={...this.config(id),revision:this.config(id).revision+1};this.repo.put('config',id,id,a.id,this.now(),c);this.repo.put('status',id,id,a.id,this.now(),{state:'unverified',observedAt:null});const r={operationId,platform:id,actorId:a.id,digest,status:'succeeded',revision:c.revision};this.repo.put('operation',operationId,id,a.id,this.now(),r);this.audit(id,a,operationId,'secrets','succeeded');return r;});
 }
 resource(input){if(input.memberId)return {kind:'member',id:identifier(input.memberId)};if(input.wipeId)return {kind:'wipe',id:identifier(input.wipeId)};return {kind:'platformTarget',id:input.targetId||'invalid'};}
 async execute(a,id,action,input,{operationId}){
  a=this.actor(a,id,true);const spec=ACTIONS[action];need(spec&&(!spec.platforms||spec.platforms.includes(id)),'RESOURCE_NOT_FOUND',404);
  const resource=action==='metadata'&&input.kind==='guilds'?{kind:'platformTarget',id}:action.startsWith('card_')?{kind:'platformTarget',id:input.targetId}:this.resource(input);if(spec.extra)authorize(a,spec.extra,resource,this.identity.relations());
  if(['card_publish','card_refresh'].includes(action))need(input.mentionMode===undefined||input.mentionMode==='none','MENTIONS_REQUIRE_G06',422);
  if(action.startsWith('card_'))need(['ranking','map','custom','server_connect','electrician_ids','welcome_guide','wipe_notice'].includes(input.cardType),'USE_G06_WIPE_NOTIFICATIONS',422);
  const fn=this.adapters[spec.adapter]?.[spec.method];need(typeof fn==='function',UNAVAILABLE,503);
  const {old,digest}=this.begin(a,id,input,operationId,action);if(old)return this.receipt(a,operationId);
  const revision=this.config(id).revision,record={operationId,platform:id,actorId:a.id,digest,status:'running',action,revision,resource,extraCapability:spec.extra||null};
  this.repo.transaction(()=>{this.repo.put('operation',operationId,id,a.id,this.now(),record);this.audit(id,a,operationId,action,'running');});
  const assertCurrent=()=>{const current=this.actor(a,id,true);need(this.config(id).revision===revision,'REVISION_CONFLICT',409);if(spec.extra)authorize(current,spec.extra,resource,this.identity.relations());return current;};
  try{
   const result=await fn.call(this.adapters[spec.adapter],{actor:a,platform:id,input,config:this.config(id),operationId,assertCurrent});assertCurrent();
   // Adapter DTO must be projected by its domain service. Never serialize vendor responses or errors.
   need(result&&typeof result==='object'&&result.schema==='platform-result/1','PLATFORM_ADAPTER_CONTRACT',503);
   const dto=projectResult(result);const r={...record,status:['failed','cancelled','queued','running','unknown'].includes(dto.state)?(dto.state==='unknown'?'result_unknown':dto.state):'succeeded',result:dto};
   this.repo.transaction(()=>{this.repo.put('operation',operationId,id,a.id,this.now(),r);if(action==='metadata')this.cacheMetadata(id,input,dto,a);this.audit(id,a,operationId,action,r.status);this.repo.put('health',id,id,a.id,this.now(),{action,state:dto.state,observedAt:new Date(this.now()).toISOString()});if(action==='verify')this.repo.put('status',id,id,a.id,this.now(),{state:result.verified===true?'verified_adapter':'unverified',observedAt:new Date(this.now()).toISOString(),evidenceLevel:result.evidenceLevel==='live'?'live':'isolated'});});return r;
  }catch(e){const status=e.definitelyNotApplied===true?'failed':'result_unknown';const r={...record,status,errorCode:e instanceof IdentityError?e.errorCode:'PLATFORM_EXECUTION_UNAVAILABLE'};this.repo.transaction(()=>{this.repo.put('operation',operationId,id,a.id,this.now(),r);this.audit(id,a,operationId,action,status);this.repo.put('health',id,id,a.id,this.now(),{action,state:status,errorCode:r.errorCode,observedAt:new Date(this.now()).toISOString()});});return r;}
 }
 history(a,id,query){this.actor(a,id);return readAuditPage(this.repo,id,query);}
}
export function projectResult(r){return {preview:r.preview?{id:text(r.preview.id),contentHash:text(r.preview.contentHash),title:text(r.preview.title,200),body:text(r.preview.body,4000)}:null,schema:'platform-result/1',errorCode:/^[A-Z0-9_]{1,80}$/.test(r.errorCode||'')?r.errorCode:null,state:['succeeded','failed','cancelled','queued','running','partial','skipped','unknown','unavailable'].includes(r.state)?r.state:'unknown',reference:typeof r.reference==='string'?text(r.reference,200):null,items:Array.isArray(r.items)?r.items.slice(0,50).map(x=>({id:text(String(x.id||'')),label:text(String(x.label||''),300),status:text(String(x.status||''),80),...(x.status==='guild'&&sanitizeGuildIcon(x.iconUrl)?{iconUrl:sanitizeGuildIcon(x.iconUrl)}:{})})):[],counts:r.counts?Object.fromEntries(['total','succeeded','failed','skipped','unknown'].map(k=>[k,Number.isSafeInteger(r.counts[k])&&r.counts[k]>=0?r.counts[k]:0])):null};}

function roleItems(items){return Array.isArray(items)?items.filter(item=>item?.status==='role'&&typeof item.id==='string'&&item.id&&typeof item.label==='string').map(({id,label})=>({id,label,status:'role'})):[];}

function channelItems(items){return Array.isArray(items)?items.filter(item=>item&&(item.status==='category'||/^channel:\d{1,2}$/.test(item.status))&&typeof item.id==='string'&&item.id&&typeof item.label==='string').map(({id,label,status})=>({id,label,status})):[];}
function guildItems(items){return Array.isArray(items)?items.filter(item=>item?.status==='guild'&&typeof item.id==='string'&&item.id&&typeof item.label==='string').map(({id,label,iconUrl})=>({id,label,status:'guild',...(sanitizeGuildIcon(iconUrl)?{iconUrl:sanitizeGuildIcon(iconUrl)}:{})})):[];}
export function sanitizeGuildIcon(value){
 if(typeof value!=='string'||value.length>2048)return null;
 try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&!u.hash&&['cdn.discordapp.com','media.discordapp.net','img.kookapp.cn','img.kaiheila.cn'].includes(u.hostname)?u.href:null;}catch{return null;}
}
