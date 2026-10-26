import {need,digest} from './config.js';
import {validateVip} from './external-bindings.js';
const sync=value=>{need(!value?.then,'VIP_SYNC_READER_REQUIRED');return value;};
/** Only trusted current policy/proof readers; no clock, legacy-owner or authority supplied by HTTP. */
export function createCandidateVip({binding,notificationBinding,identity,isLegacyQuiesced}){
 validateVip(binding);need(identity?.repo?.db&&typeof isLegacyQuiesced==='function','CANDIDATE_VIP_HOST_REQUIRED');
 const bound=Boolean(binding&&notificationBinding&&typeof binding.readSourceConfig==='function'&&typeof binding.readDmTarget==='function');
 function principal(){validateVip(binding);const p=binding.principal;need(p,'CANDIDATE_VIP_PRINCIPAL_REQUIRED');const actor=identity.actorForAccount(p.accountId);need(actor.status==='active'&&!actor.restricted&&actor.permissionVersion===p.permissionVersion,'CANDIDATE_VIP_PRINCIPAL_CHANGED',403);return {accountId:actor.id,permissionVersion:actor.permissionVersion};}
 function policy(){validateVip(binding);const sources=Object.fromEntries(['vital','rustinity','atlas'].map(source=>[source,binding.sources?.[source]||{enabled:source==='vital',revision:'legacy-default'}]));const legacySchedulerDisabled=isLegacyQuiesced()===true;
  return {enabled:binding.enabled&&bound,revision:digest({revision:binding.revision,enabled:binding.enabled,sources,principal:binding.principal||null,legacySchedulerDisabled}),sources,legacySchedulerDisabled};}
 function sourceConfig({source,db}){need(db===identity.repo.db,'CANDIDATE_VIP_OWNER_MISMATCH');return sync(binding.readSourceConfig({source,identity,db}));}
 function dmTarget(args){const config=sourceConfig({source:args.source,db:identity.repo.db}),proof=sync(binding.readDmTarget({...args,identity,db:identity.repo.db}));
  if(!proof)return null;
  const key=sync(notificationBinding.transportKey('discord',{id:proof.targetId,kind:'directMessage',guildId:null,channelId:proof.channel?.id,recipientId:args.externalId}));
  need(key===config?.transportKey&&key===proof.transportKey,'VIP_SOURCE_CONFIGURATION_CHANGED',409);
  return proof; // Original domain alone validates verified/type-1/unique recipient/bot/time/G03 facts.
 }
 function diagnostics(){let reason=!binding?'CANDIDATE_VIP_UNBOUND':!notificationBinding?'CANDIDATE_VIP_NOTIFICATION_TRANSPORT_REQUIRED':!bound?'CANDIDATE_VIP_READERS_REQUIRED':!isLegacyQuiesced()?'VIP_LEGACY_OWNER_ACTIVE':!binding.enabled?'VIP_NOTIFICATIONS_DISABLED':null;if(!reason)try{principal();}catch(e){reason=e.errorCode;}
  return {bound,enabled:bound&&!reason,reason,legacySchedulerDisabled:isLegacyQuiesced()===true,currentEligibilityAndDmCheckedPerMember:true,createsDmChannels:false,realExternalDmVerified:false};}
 return {bound,principal,diagnostics,options:bound?{readPolicy:policy,readPrincipal:principal,readSourceConfig:sourceConfig,readDmTarget:dmTarget}:undefined};
}
