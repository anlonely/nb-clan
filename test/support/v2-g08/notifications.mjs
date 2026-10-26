import {generateKeyPairSync,randomUUID} from 'node:crypto';
import {createDiscordVerifier,createKookVerifier} from '../../../server/v2/notification-platforms/verifiers.js';
import {createIsolatedNotificationTransport} from '../../../server/v2/notification-platforms/isolated-transport.js';
export function notificationBindings(){
  const native=createIsolatedNotificationTransport();
  const key=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
  const transport={runtimeMode:'isolated',request(args){native.enqueue({kind:'success',delayMs:200});return native.request(args);},respondPrivate(){throw Error('G08_PRIVATE_RESPONSE_UNUSED');}};
  return {native,bindings:{transport,verifiers:{discord:createDiscordVerifier({publicKey:key,applicationId:'111111111111111111'}),kook:createKookVerifier({verifyToken:'g08-isolated-verify-token'})},transportKey:(p,t)=>`${p}:${t.id}`}};
}
export function configureNotifications(system,identity){
  const platform=system.platforms.service,c=platform.config('discord');
  if(c.targets?.some(t=>t.id==='g08-local-target'))return;
  platform.repo.put('config','discord','discord','user_root',Date.now(),{...c,enabled:true,revision:c.revision+1,targets:[{id:'g08-local-target',guildId:'100000000000000001',channelId:'200000000000000001',name:'G08 隔离队列',enabled:true}]});
}
export function enqueueNotification(owner,identity,wipeId,schedule=null){
  const service=owner.getSystem(identity).service,actor=identity.actorForAccount('user_root'),wipe=service.wipe(actor,wipeId);
  const input={expectedContentRevision:wipe.contentRevision,templateId:'wipe-notification',templateRevision:1,purpose:'signup_open',purposeInstance:'primary',repeatOfIntentId:null,reason:null,duplicateRiskAcknowledged:false,targets:[{targetId:'g08-local-target',language:'zh-CN',mentionMode:'none',roleIds:[]}],audience:structuredClone(wipe.audience),schedule};
  const preview=service.createPreview(actor,wipeId,input,{operationId:randomUUID()}).current;
  const intent=service.createIntent(actor,wipeId,{previewId:preview.id,contentHash:preview.contentHash,expectedContentRevision:preview.contentRevision,purpose:preview.purpose,purposeInstance:preview.purposeInstance},{operationId:randomUUID()}).current;
  return {intentId:intent.id,deliveries:service.repo.forWipe('deliveries',wipeId).filter(d=>d.intentId===intent.id).map(d=>d.id)};
}
