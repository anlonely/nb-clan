import {upsertSqliteCollectionRecord} from '../../../server/storage/sqlite-migrate.js';
import {fixture as original} from '../v2-platform-host/fixture.mjs';
import {installNotificationBusinessSchema,installNotificationPlatformCardSchema} from '../../../server/v2/notifications/index.js';
import {createNotificationWorker} from '../../../server/v2/notifications/worker.js';
import {createPlatformHost} from '../../../server/v2/management-adapters/platforms/index.js';
import {listNotificationTemplates,renderNotification} from '../../../server/v2/notification-platforms/renderer.js';
import {grant} from '../../../server/v2/identity/permissions.js';
import {createDiscordVerifier,createKookVerifier} from '../../../server/v2/notification-platforms/verifiers.js';
import {createNotificationCallbackHandler} from '../../../server/v2/notification-platforms/callbacks.js';
import {generateKeyPairSync,sign} from 'node:crypto';
export async function fixture(){
 const f=original();await f.start();await f.host.stop();installNotificationBusinessSchema(f.db);installNotificationPlatformCardSchema(f.db);
 for(const id of ['host-wipe','other-wipe'])f.sr.put('wipes',{...f.sr.get('wipes',id),description:'既有构造档期',serverScheduledWipeAt:null});
 const targets=()=>f.g06.targets().map(t=>({...t,label:t.name,languages:['zh-CN'],roleOptions:[]}));Object.assign(f.notifications.catalog,{listTargets:targets,getTarget:id=>targets().find(t=>t.id===id)});
 f.notifications.templates=listNotificationTemplates();f.notifications.renderer=renderNotification;
 for(const platform of ['discord','kook']){
  const c=f.platformService.config(platform);f.platformService.save(f.actor('admin'),platform,{expectedRevision:c.revision,config:{targets:c.targets.map(t=>({...t,enabledCommandIds:[...t.enabledCommandIds,'attendance']})),commands:[{id:'attendance',name:'报名卡',type:'event_command',enabled:true,slashCommand:'gather'}]}},{operationId:platform+'-native-config'});
  for(const actor of ['admin','member','other'])f.ir.put('identities',{id:platform+'-native-'+actor,provider:platform,externalId:'native-'+actor,accountId:actor,revision:1});
  f.ir.put('policies',{id:platform+'-policy',provider:platform,enabled:true,guildId:'100000000000000001',allowedRoleIds:['native-role'],matchMode:'any',policyRevision:1});
 }
 f.identity.providers=Object.fromEntries(['discord','kook'].map(p=>[p,{roles:async(externalId,guildId)=>({externalId,guildId,roleIds:['native-role']})}]));
 const account=f.ir.get('accounts','member');f.ir.put('accounts',{...account,grants:[...account.grants,grant('stats.read',{type:'squads',ids:['s1']})]});
 upsertSqliteCollectionRecord(f.db,'kdaRows','native-row',{id:'native-row',memberId:'m002',steamId:f.ir.get('members','m002').steamId,wipeId:'host-wipe',sourceId:'vital',kills:3,deaths:2,rockets:19,syncedAt:new Date(f.now()).toISOString()});
 const host=createPlatformHost({...f});await host.start();const worker=createNotificationWorker(f.notifications),keys=generateKeyPairSync('ed25519');
 const verifiers={discord:createDiscordVerifier({publicKey:keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),applicationId:'native-app',now:f.now}),kook:createKookVerifier({verifyToken:'native-verify-token',compression:'none',now:f.now})};
 const handlers=Object.fromEntries(['discord','kook'].map(platform=>[platform,createNotificationCallbackHandler({platform,identity:f.identity,scheduling:f.scheduling,verify:verifiers[platform],resolveActionReference:()=>null,publicOrigin:'http://127.0.0.1',transport:f.transport,now:f.now,handleCommunity:p=>host.community[platform].handleVerified(p)})]));
 const discord=(id,type,data,actor='member',channel='200000000000000001')=>({id,type,data,application_id:'native-app',guild_id:'100000000000000001',channel_id:channel,member:{user:{id:'native-'+actor}},token:'constructed-private-token'});
 const kook=(id,messageId,metric='rockets',actor='member',channel='200000000000000002')=>({s:0,sn:Number(id.replace(/\D/g,'')),d:{type:255,channel_type:'PERSON',verify_token:'native-verify-token',msg_id:id,msg_timestamp:f.now(),extra:{type:'message_btn_click',body:{user_id:'native-'+actor,target_id:channel,msg_id:messageId,value:'nb_kook_member_ranking:metric:'+metric}}}});
 const raw=(platform,event)=>{const rawBody=Buffer.from(JSON.stringify(event));if(platform==='kook')return {rawBody,headers:{}};const timestamp=String(f.now()/1000);return {rawBody,headers:{'x-signature-timestamp':timestamp,'x-signature-ed25519':sign(null,Buffer.concat([Buffer.from(timestamp),rawBody]),keys.privateKey).toString('hex')}};};
 async function send(platform,event){let ack;await handlers[platform](raw(platform,event),{ack:value=>{ack=value;}});return {ack,reply:f.transport.getPrivateReplies().at(-1)};}
 return {...f,host,worker,discord,kook,raw,send,verifiers,async close(){await worker.stop();await host.stop();await f.close();}};
}
