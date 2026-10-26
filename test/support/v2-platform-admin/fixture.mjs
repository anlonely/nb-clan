import { existsSync,chmodSync } from 'node:fs';
import { fixture as statsFixture } from '../v2-stats/fixture.mjs';
import { controlledProviders } from '../v2-member-space/fixtures.mjs';
import { SchedulingService } from '../../../server/v2/scheduling/service.js';
import { installPlatformAdminSchema } from '../../../server/v2/platform-admin/repository.js';
import { PlatformAdminService } from '../../../server/v2/platform-admin/service.js';
import { createForwardingAdapter } from '../../../server/v2/platform-admin/forwarding.js';
import { createMiniProgramAdapter } from '../../../server/v2/platform-admin/mini-program.js';
import { createPlatformCards,createG06MessageGateway } from '../../../server/v2/platform-admin/cards.js';
import { createNotificationPlatforms } from '../../../server/v2/notification-platforms/platforms.js';
import { createIsolatedNotificationTransport } from '../../../server/v2/notification-platforms/isolated-transport.js';
import { MemberSpaceService } from '../../../server/v2/member-space/service.js';
import { createPublishedPlatformAdapters } from '../../../server/v2/platform-admin/published-services.js';
import { need } from '../../../server/v2/platform-admin/model.js';
export function fixture({filename=':memory:',origin='http://127.0.0.1:4347',now=Date.now,discordWipeSignup=false,scopeContract=false}={}){
 if(filename!==':memory:'){need(!existsSync(filename),'FRESH_SQLITE_REQUIRED',503);}
 const base=statsFixture(filename,{scopeContract}),{db,identity,ir,sr}=base;if(filename!==':memory:')chmodSync(filename,0o600);installPlatformAdminSchema(db);
 const admin=ir.get('accounts','g05_account_admin');ir.put('accounts',{...admin,adminAssignedByOwner:true});
 const controlled=controlledProviders(origin);identity.providers=controlled.providers;identity.eligibilityTtl=3600000;identity.now=now;
 const scheduling=new SchedulingService(sr,identity,{now}),transport=createIsolatedNotificationTransport({now}),platforms=createNotificationPlatforms({transport,now});
 let service;const calls=[],sourceMessages=new Map(),translations=[];
 const targets=()=>['discord','kook'].flatMap(platform=>(service?.config(platform).targets||[]).map(t=>({...t,platform,runtimeMode:'isolated',transportKey:`${platform}-fixture`,configurationRevision:service.config(platform).revision})));
 const messages=createG06MessageGateway({platforms,targets});
 const forwarding=createForwardingAdapter({db,now,messages,source:{async read({platform,channelId}){calls.push({action:'source',platform,channelId});return {verified:true,items:structuredClone(sourceMessages.get(`${platform}:${channelId}`)||[]),nextCursor:'fixture-tail'};},async reset(){return {reference:'fixture-cursor-reset'};}},translate:async({text,languages})=>{translations.push({text,languages});return languages.map(language=>({language,text:`构造译文 ${text}`}));}});
 const result=(items=[])=>({schema:'platform-result/1',state:'succeeded',items});
 const adapters={forwarding,platform:{async verify({assertCurrent,platform}){assertCurrent();calls.push({action:'verify',platform});return {...result([{id:platform,label:'隔离外部替身响应正常',status:'succeeded'}]),verified:true,evidenceLevel:'isolated'};},async metadata({assertCurrent,config}){assertCurrent();calls.push({action:'metadata'});return result((config.targets||[]).map(t=>({id:t.id,label:`构造频道 ${t.channelId}`,status:'verified_fixture'})));},async registerCommands({assertCurrent,config}){assertCurrent();calls.push({action:'registerCommands'});return result(config.commands.map(c=>({id:c.id,label:c.name,status:c.enabled?'registered_fixture':'disabled'})));}},
  stats:{ranking({actor,input,assertCurrent}){assertCurrent();const r=base.service.list(actor,{wipeId:input.wipeId,sourceId:input.sourceId||'vital',metricVersion:'nb-kda-1',limit:20});return result(r.items.map(m=>({id:m.memberId,label:`${m.displayName} · ${m.kills} 击杀`,status:m.freshness?.state||'local'})));}},
  scheduling:{map({actor,input,assertCurrent}){assertCurrent();const w=scheduling.getWipe(actor,input.wipeId);return result([{id:w.id,label:w.title,status:'local'}]);}},
  // The only vault in this fixture stores constructed values in the isolated DB.
  // Production integration must supply an encrypted, synchronous transactional vault.
  vault:{writeSync({db,platform,values}){db.exec('CREATE TABLE IF NOT EXISTS platform_fixture_vault(platform TEXT,key TEXT,value TEXT,PRIMARY KEY(platform,key))');for(const[k,v]of Object.entries(values))db.prepare('INSERT INTO platform_fixture_vault VALUES(?,?,?) ON CONFLICT(platform,key) DO UPDATE SET value=excluded.value').run(platform,k,v);}}
 };
 const published=createPublishedPlatformAdapters({identity,scheduling,memberSpace:new MemberSpaceService(identity),stats:base.service,executeStatsJob:id=>base.service.runJob(id)});Object.assign(adapters,published.platform);
 service=new PlatformAdminService({identity,adapters,now});adapters.cards=createPlatformCards({identity,scheduling,stats:base.service,messages,now});
 const actor=(key='admin')=>identity.actorForAccount(`g05_account_${key}`),operation=prefix=>({operationId:`fixture-${prefix}`});
 const target=(id,channelId)=>({id,name:'战队公告',guildId:'100000000000000001',channelId,enabled:true,enabledCommandIds:['ranking','map']});
 for(const platform of ['discord','kook']){const wipeFixture=platform==='discord'&&discordWipeSignup;service.save(actor(),platform,{expectedRevision:0,config:{enabled:true,targets:[{...target(`${platform}-local`,platform==='discord'?'300000000000000001':'300000000000000002'),...(wipeFixture?{signupCardChannelId:'300000000000000003',enabledCommandIds:['ranking','map','signup_card']}:{})}],commands:[{id:'ranking',name:'战绩排行',enabled:true,type:'persistent_card',titleTemplate:'本档排行',bodyTemplate:''},{id:'map',name:'地图信息',enabled:true,type:'persistent_card',titleTemplate:'本档地图',bodyTemplate:''},...(wipeFixture?[{id:'wipe',name:'Wipe 登记',type:'slash_command',slashCommand:'wipe',enabled:false,signupMode:'discord_only',titleTemplate:'',bodyTemplate:''},{id:'signup_card',name:'Wipe Sign-up',type:'persistent_card',enabled:true,titleTemplate:'',bodyTemplate:''}]:[])]}},operation(platform));}
 service.save(actor(),'bridge',{expectedRevision:0,config:{enabled:true,routes:[{id:'local-route',name:'战队日常交流',enabled:true,discordGuildId:'100000000000000001',discordChannelId:'300000000000000001',kookGuildId:'100000000000000001',kookChannelId:'300000000000000002',direction:'both',translate:true,languages:['zh','tr'],includeAttachments:true}]}},operation('bridge'));
 sourceMessages.set('discord:300000000000000001',[{id:'local-message-1',channelId:'300000000000000001',content:'今晚八点集合 @everyone',author:'阿北',attachments:[]}]);
 service.save(actor(),'wechat',{expectedRevision:0,config:{enabled:true,appId:'fixture_app',minClientVersion:1,subscriptionTemplateIds:[]}},operation('wechat'));
 for(const key of ['alpha','beta','admin'])ir.put('identities',{id:`wechat_fixture_${key}`,provider:'wechat:fixture_app',externalId:`fixture_openid_${key}`,accountId:`g05_account_${key}`,revision:1,verifiedAt:new Date(now()).toISOString()});
 const mini=createMiniProgramAdapter({identity,scheduling,appId:'fixture_app',readConfig:()=>service.config('wechat'),now,exchangeCode:async({appId,code})=>{need(['alpha','beta','admin'].includes(code),'MINI_AUTH_INVALID',401);return {appId,openid:`fixture_openid_${code}`,verified:true};},adapters:published.mini});
 return {...base,repo:ir,service,identity,controlled,scheduling,mini,forwarding,transport,platforms,messages,adapters,calls,sourceMessages,translations,actor,published,async close(){await forwarding.stop();db.close();}};
}
