import express from 'express';
import { createHash } from 'node:crypto';
import { CandidateError,need } from './config.js';
import { IdentityError } from '../identity/errors.js';
import { SchedulingRepository } from '../scheduling/repository.js';
import { SchedulingService } from '../scheduling/service.js';
import { createNotificationSystem } from '../notifications/index.js';
import { listNotificationTemplates,renderNotification } from '../notification-platforms/index.js';
import { createNotificationRuntime } from '../notification-runtime/index.js';
import { managedDiscordInteraction } from '../notification-platforms/native-interactions.js';
import { ELECTRICIAN_COMMAND_ID, electricianTargetId } from '../platform-admin/electrician-card.js';
import { WELCOME_GUIDE_COMMAND_ID, welcomeGuideTargetId } from '../platform-admin/welcome-guide-card.js';
import { SERVER_CONNECT_COMMAND_ID, serverConnectTargetId } from '../platform-admin/server-connect-card.js';
const unsupported=()=>{throw new IdentityError('NOTIFICATION_ADAPTER_UNAVAILABLE',503);};
/** Project the one PlatformAdminService; never cache another platform configuration. */
export function canonicalNotificationCatalog(getPlatformService,{enabled=false,transportKey}={}) {
  function targets() {
    const service=getPlatformService();need(service?.identity,'CANDIDATE_PLATFORM_OWNER_REQUIRED');const result=[];
    for(const platform of ['discord','kook']){const c=service.config(platform);
      const guildNames=new Map((service.guildCatalog?.(platform,c)?.items||[]).map(item=>[item.id,item.label]));
      const channelNames=new Map((service.channelCatalogs?.(platform,c)||[]).map(catalog=>[catalog.guildId,new Map((catalog.items||[]).map(item=>[item.id,item.label]))]));
      const wipeCommand=platform==='discord'?(c.commands||[]).find(command=>command.id==='wipe'&&command.type==='event_command'&&command.enabled):null;
      const signupCommandId=platform==='discord'?'wipe':'signup_card';
      const signupCardEnabled=platform==='discord'?Boolean(wipeCommand):(c.commands||[]).some(command=>command.id==='signup_card'&&command.type==='persistent_card'&&command.enabled);
      const electricianEnabled=platform==='kook'&&(c.commands||[]).some(command=>command.id===ELECTRICIAN_COMMAND_ID&&command.type==='persistent_card'&&command.enabled);
      const guideEnabled=(c.commands||[]).some(command=>command.id===WELCOME_GUIDE_COMMAND_ID&&command.type==='persistent_card'&&command.enabled);
      const connectEnabled=(c.commands||[]).some(command=>command.id===SERVER_CONNECT_COMMAND_ID&&command.type==='persistent_card'&&command.enabled);
      for(const t of c.targets||[])if(t.guildId){const base={id:t.id,platform,guildId:t.guildId,channelId:t.channelId,label:t.name||t.id,
        guildLabel:guildNames.get(t.guildId)||t.name||t.guildId,channelLabel:channelNames.get(t.guildId)?.get(t.channelId)||t.channelId,
        enabled:enabled&&c.enabled===true&&t.enabled===true,configurationRevision:c.revision,languages:platform==='discord'?['en','zh-CN','tr']:['zh-CN','tr','en'],roleOptions:[],
        runtimeMode:'isolated',...(platform==='discord'?{signupMode:t.enabledCommandIds?.includes('wipe')&&wipeCommand?.signupMode==='discord_only'?'discord_only':'member_required'}:{}),...(enabled?{transportKey:transportKey(platform,t)}:{})};if(t.channelId)result.push(base);
        if(signupCardEnabled&&t.enabledCommandIds?.includes(signupCommandId)&&t.signupCardChannelId){const id=`signup_card_${createHash('sha256').update(JSON.stringify(`${platform}:${t.id}`)).digest('hex').slice(0,24)}`;
          result.push({...base,id,channelId:t.signupCardChannelId,label:`${base.label} · 报名卡片`,channelLabel:channelNames.get(t.guildId)?.get(t.signupCardChannelId)||t.signupCardChannelId,
            ...(enabled?{transportKey:transportKey(platform,{...t,id,channelId:t.signupCardChannelId})}:{})});}
        if(connectEnabled&&t.enabledCommandIds?.includes(SERVER_CONNECT_COMMAND_ID)&&t.serverConnectChannelId){const id=serverConnectTargetId(t.id,platform);
          result.push({...base,id,channelId:t.serverConnectChannelId,label:`${base.label} · ${platform==='discord'?'Server Direct Connect':'服务器直连'}`,channelLabel:channelNames.get(t.guildId)?.get(t.serverConnectChannelId)||t.serverConnectChannelId,
            ...(enabled?{transportKey:transportKey(platform,{...t,id,channelId:t.serverConnectChannelId})}:{})});}
        if(electricianEnabled&&t.enabledCommandIds?.includes(ELECTRICIAN_COMMAND_ID)&&t.electricianChannelId){const id=electricianTargetId(t.id);
          result.push({...base,id,channelId:t.electricianChannelId,label:`${base.label} · 电工 ID`,channelLabel:channelNames.get(t.guildId)?.get(t.electricianChannelId)||t.electricianChannelId,
            ...(enabled?{transportKey:transportKey(platform,{...t,id,channelId:t.electricianChannelId})}:{})});}
        if(guideEnabled&&t.enabledCommandIds?.includes(WELCOME_GUIDE_COMMAND_ID)&&t.welcomeGuideChannelId){const id=welcomeGuideTargetId(t.id,platform);
          result.push({...base,id,channelId:t.welcomeGuideChannelId,label:`${base.label} · 开荒须知`,channelLabel:channelNames.get(t.guildId)?.get(t.welcomeGuideChannelId)||t.welcomeGuideChannelId,
            ...(enabled?{transportKey:transportKey(platform,{...t,id,channelId:t.welcomeGuideChannelId})}:{})});}
      }}
    need(result.length<=1000&&new Set(result.map(t=>t.id)).size===result.length,'CANDIDATE_TARGET_ID_CONFLICT');return result;
  }
  return {listTargets:targets,getTarget:id=>targets().find(t=>t.id===id)||null,
    listOptions:(kind,{q=''}={})=>{const identity=getPlatformService().identity;const collection={members:'members',squads:'squads'}[kind];
      if(kind==='servers')throw new CandidateError('CANDIDATE_SERVER_CATALOG_UNBOUND');
      need(collection,'CANDIDATE_CATALOG_KIND_INVALID',422);const rows=identity.repo.all(collection);need(rows.length<=10000,'CANDIDATE_CATALOG_TOO_LARGE');
      const memberships=kind==='members'?identity.repo.all('squadMembers'):[];
      const items=rows.map(r=>({id:r.id,label:r.displayName||r.name||r.customName||r.id,
        ...(kind==='members'?{squadIds:memberships.filter(m=>m.memberId===r.id).map(m=>m.squadId)}:{})}));
      return {items:items.filter(r=>r.label.toLowerCase().includes(String(q).slice(0,200).toLowerCase())),nextCursor:null};}};
}
export function createCandidateNotificationOwner({getIdentity,getPlatformService,publicOrigin,bindings,intervalMs,getCommunityHandler,getCardViewHandler}) {
  if(bindings){
    need(bindings.transport&&bindings.verifiers&&typeof bindings.transportKey==='function','CANDIDATE_NOTIFICATION_BINDINGS_INVALID');
    // The existing contract genuinely enforces runtimeMode=isolated and loopback origin;
    // it accepts native adapter methods, not only the test transport implementation.
    const catalog=canonicalNotificationCatalog(getPlatformService,{enabled:true,transportKey:bindings.transportKey});
    const runtime=createNotificationRuntime({getIdentity,publicOrigin,intervalMs,transport:bindings.transport,verifiers:bindings.verifiers,
      catalog,getCommunityHandler,getCardViewHandler});return Object.freeze({...runtime,catalog,ownsDiscordInteraction:event=>managedDiscordInteraction(event,getPlatformService().config('discord'))});
  }
  let identityRef,scheduling,system,stopped=false;
  const check=identity=>{need(!stopped,'NOTIFICATION_RUNTIME_STOPPED');need(identity?.repo?.db&&(!identityRef||identityRef===identity),'CANDIDATE_IDENTITY_MISMATCH');identityRef=identity;};
  function getScheduling(identity){check(identity);return scheduling||=(new SchedulingService(new SchedulingRepository(identity.repo.db),identity));}
  function getSystem(identity){const shared=getScheduling(identity);if(!system){
    system=createNotificationSystem({identity,scheduling:shared,catalog:canonicalNotificationCatalog(getPlatformService),renderer:renderNotification,
      templates:listNotificationTemplates(),platforms:{},publicOrigin});
    need(!system.service.repo.all('deliveries').some(d=>['queued','retry_wait','sending'].includes(d.status))&&!system.service.repo.all('messageOperations').some(o=>['queued','running'].includes(o.status)),'NOTIFICATION_PENDING_ADAPTER_REQUIRED');
    // One real notification core. No fabricated transport/verifier and no shadow queue.
    for(const name of ['createPreview','createIntent','retryFailed','commandDelivery','requeue','queueMessageOperation','executionContext','renderEdit','makeReferences','resolveReference'])system.service[name]=unsupported;
    const original=system.worker;system.worker=Object.fromEntries(Object.entries(original).map(([key,value])=>[key,key==='stop'?value:unsupported]));
    system.references.resolve=unsupported;
    const options=system.service.getOptions.bind(system.service);system.service.getOptions=(...args)=>({...options(...args),supported:false,reason:'NOTIFICATION_ADAPTER_UNAVAILABLE'});
  }return system;}
  const callbackRouter=express.Router();callbackRouter.all('/integrations/v2/notifications/:platform',(req,res)=>{req.resume();res.status(503).json({error:{errorCode:'NOTIFICATION_ADAPTER_UNAVAILABLE'}});});
  return Object.freeze({getSystem,getScheduling,callbackRouter,async start(){getSystem(await getIdentity());},tick:unsupported,
    async stop(){stopped=true;await system?.worker.stop();},diagnostics:()=>({runtimeMode:'isolated',externalAdapterBound:false,workerEnabled:false,stopped,instances:system?1:0})});
}
