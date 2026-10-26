import {createWipeCardSync} from './wipe-card-sync.js';
import {discordWipeNoticePayload} from './wipe-notice-card.js';
import {createDurableCards} from './card-delivery.js';
import { readElectricianRoster, resolveElectricianRoster } from './electrician-roster.js';
import {rankingLabel,mapLines} from './results.js';
import { discordInteractionLanguage, interactionText } from '../notification-platforms/interaction-language.js';
import { randomUUID } from 'node:crypto';
import { authorize } from '../identity/permissions.js';
import { hashPayload } from '../notification-platforms/canonical.js';
import { PlatformAdminRepository } from './repository.js';
import { need,hash,UNAVAILABLE } from './model.js';
import { SERVER_CONNECT_COMMAND_ID, serverConnectTargetId, serverConnectDetails, discordServerConnectPayload, normalizeServerConnectOverride, resolveServerConnectIp } from './server-connect-card.js';
import { ELECTRICIAN_COMMAND_ID, ELECTRICIAN_INSTRUCTIONS, electricianTargetId, electricianDetails, electricianCardDetails, discordElectricianPayload } from './electrician-card.js';
import { WELCOME_GUIDE_COMMAND_ID, welcomeGuideTargetId, welcomeGuideDetails, discordWelcomeGuideDetails, discordWelcomeGuidePayload } from './welcome-guide-card.js';
export function createPlatformCards({identity,scheduling,stats,messages,notifications,platformService,runStoreWriteTask,resolveConnectIp=resolveServerConnectIp,now=Date.now}){
 const repo=new PlatformAdminRepository(identity.repo.db);
 function render({actor,platform,input,config,community=false}){
  const language=platform==='discord'?discordInteractionLanguage(input.language):'zh-CN';
  const t=key=>interactionText(platform,{locale:language},key);
  const connectCard=input.cardType==='server_connect';
  const hasConnectOverride=Object.hasOwn(input,'serverConnectOverride');
  const connectOverride=hasConnectOverride?normalizeServerConnectOverride(input.serverConnectOverride):null;
  need(!hasConnectOverride||connectCard&&connectOverride,'SERVER_CONNECT_INPUT_INVALID',422);
  const electricianCard=input.cardType==='electrician_ids';
  const guideCard=input.cardType==='welcome_guide';
  const target=config.targets.find(t=>t.enabled && (connectCard ? serverConnectTargetId(t.id,platform)===input.targetId : electricianCard ? electricianTargetId(t.id,platform)===input.targetId : guideCard ? welcomeGuideTargetId(t.id,platform)===input.targetId : t.id===input.targetId));need(target,'TARGET_NOT_CONFIGURED',422);
  if(connectCard)need(['discord','kook'].includes(platform)&&config.enabled&&target.serverConnectChannelId&&target.enabledCommandIds?.includes(SERVER_CONNECT_COMMAND_ID)&&config.commands.some(c=>c.id===SERVER_CONNECT_COMMAND_ID&&c.enabled&&c.type==='persistent_card'),'COMMAND_NOT_CONFIGURED',422);
  const electricianCommand=config.commands.find(c=>c.id===ELECTRICIAN_COMMAND_ID&&c.enabled&&c.type==='persistent_card');
  if(electricianCard)need(['discord','kook'].includes(platform)&&config.enabled&&target.electricianChannelId&&target.enabledCommandIds?.includes(ELECTRICIAN_COMMAND_ID)&&electricianCommand,'COMMAND_NOT_CONFIGURED',422);
  if(electricianCard)need(repo.get('electrician-roster','shared')||electricianDetails(platformService.config('kook').commands.find(c=>c.id===ELECTRICIAN_COMMAND_ID)),'ELECTRICIAN_LIST_INVALID',422);
  if(guideCard)need(['discord','kook'].includes(platform)&&config.enabled&&target.welcomeGuideChannelId&&target.enabledCommandIds?.includes(WELCOME_GUIDE_COMMAND_ID)&&config.commands.some(c=>c.id===WELCOME_GUIDE_COMMAND_ID&&c.enabled&&c.type==='persistent_card'),'COMMAND_NOT_CONFIGURED',422);
  if(platform==='kook'&&(connectCard||electricianCard||guideCard))need(!input.language||input.language==='zh-CN','LANGUAGE_UNSUPPORTED',422);
  const a=identity.actorForAccount(actor.id);if(community){need(input.cardType==='ranking','COMMAND_UNSUPPORTED',422);authorize(a,'stats.read',{kind:'wipe',id:input.wipeId},identity.relations());}else authorize(a,'notifications.preview',{kind:'platformTarget',id:input.targetId},identity.relations());
  let title,body,details=null,wipeBinding=null;
  if(input.cardType==='ranking'){need(stats?.list,UNAVAILABLE,503);const rows=stats.list(a,{wipeId:input.wipeId,sourceId:input.sourceId||'vital',metricVersion:'nb-kda-1',sort:input.metric||'kills',limit:20});title=`${rows.wipe.title} · ${t('rankingTitle')}`;body=rows.items.map((m,i)=>`${i+1}. ${rankingLabel(m,input.metric,language)}`).join('\n')||t('rankingEmpty');}
  else if(input.cardType==='map'){const w=scheduling.getWipe(a,input.wipeId);title=`${w.title} · ${t('mapTitle')}`;const snapshot=w.serverSnapshot||{};body=mapLines(w,language).join('\n')||t('mapEmpty');}
  else if(connectCard){const w=scheduling.getWipe(a,input.wipeId);const source=connectOverride?{...w,serverScheduledWipeAt:connectOverride.serverScheduledWipeAt,serverSnapshot:{...w.serverSnapshot,name:connectOverride.name,connectCommand:connectOverride.command}}:w;details=serverConnectDetails(source,input.serverConnectResolvedIp);need(details,'SERVER_CONNECT_UNAVAILABLE',422);if(connectOverride)wipeBinding={id:w.id,revision:w.revision,contentRevision:w.contentRevision};if(platform==='discord'){const embed=discordServerConnectPayload(details,language).embeds[0];title=embed.title;body=[embed.description,...embed.fields.map(field=>`${field.name}\n${field.value}`)].join('\n\n');}else{title='服务器直连';body=`${details.title && details.title!==details.name ? `${details.title}\n` : ''}${details.name}\nWIPE 时间：${details.wipeTime}\n服务器直连 · 点击代码块复制\n\`\`\`\n${details.command}\n\`\`\`${details.ipCommand ? `\nIP 直连 · 点击代码块复制\n\`\`\`\n${details.ipCommand}\n\`\`\`` : ''}`;}}
  else if(electricianCard){details=electricianCardDetails(electricianCommand,target,platform,resolveElectricianRoster(repo,identity),language);need(details,'ELECTRICIAN_LIST_INVALID',422);if(platform==='discord'){const card=discordElectricianPayload(details,language),embed=card.embeds[0];title=embed.title;body=[embed.description,...card.components.flatMap(row=>row.components).map(button=>`${button.label}: ${button.url}`),embed.footer.text].join('\n\n');}else{title='电工 Steam ID';body=`${ELECTRICIAN_INSTRUCTIONS}\n前往添加电工Steam好友：${details.profilesUrl}\n查看教程：${details.tutorialUrl}\n点击头像或昵称打开 Steam 主页`;}}
  else if(input.cardType==='wipe_notice'){
   need(platform==='discord'&&config.enabled&&target.enabledCommandIds?.includes('wipe')&&config.commands.some(c=>c.id==='wipe'&&c.type==='event_command'&&c.enabled),'COMMAND_NOT_CONFIGURED',422);
   details=discordWipeNoticePayload(scheduling.getWipe(a,input.wipeId),target,config,input.signupTargetId,language);need(details,'TARGET_NOT_CONFIGURED',422);title=details.embeds[0].title;body=JSON.stringify(details);
  }
  else if(guideCard){details=platform==='discord'?discordWelcomeGuideDetails(target,language):welcomeGuideDetails(target);need(details,'GUIDE_DESTINATIONS_UNAVAILABLE',422);if(platform==='discord'){const card=discordWelcomeGuidePayload(details,language),embed=card.embeds[0];title=embed.title;body=[...embed.fields.map(field=>`${field.name}\n${field.value}`),...card.components.flatMap(row=>row.components).map(button=>`${button.label}: ${button.url}`)].join('\n\n');}else{title='开荒前先看这三件事';body=`第一件事：绑定 KOOK & Steam\n前往战队网站，使用 KOOK 登录，再完成 Steam 验证。\n⚠️登录Steam账号需要加速Steam商店或者开启VPN\n前往网页绑定：${details.bindingUrl}\n查看教程：${details.tutorialUrl}\n第二件事：加电工 ID\n点击前往添加电工Steam好友按钮，根据教程添加全部电工Steam好友。\n前往添加电工Steam好友：${details.electricianProfilesUrl}\n查看教程：${details.electricianTutorialUrl}\n加了 → 炮台可能不揍你；没加 → 炮台一定揍你。\n第三件事：服务器 IP 和地图\n服务器 IP 和地图在 #服务器直连。${details.serverUrl}\n禁止收主家的床；不要随便清队友包；抄家炮楼没成型前不要进去。\n祝各位玩得开心，多多挖矿，少被炮台揍。`;}}
  else{need(input.cardType==='custom');const c=config.commands.find(c=>c.id===input.commandId&&c.enabled);need(c,'COMMAND_NOT_CONFIGURED');title=c.titleTemplate||c.name;body=c.bodyTemplate||'';}
  const clean=s=>String(s).replace(/@/g,'＠').replace(/\((met|rol)\)/gi,'（$1）');title=clean(title).slice(0,200);body=clean(body).slice(0,3500);
  const deliveryTarget=connectCard||electricianCard||guideCard?notifications.target(input.targetId):target;
  return {target:deliveryTarget,title,body,details,language,cardId:hash({platform,target:deliveryTarget.id,cardType:input.cardType,commandId:input.commandId||'',wipeId:input.wipeId||'',actor:actor.id}),cardType:input.cardType,...(connectOverride?{serverConnectOverride:connectOverride}:{}),contentHash:hash({platform,target:deliveryTarget,title,body,language,discordLocaleVersion:platform==='discord'?1:0,revision:config.revision,...(connectOverride?{details,wipeBinding}:electricianCard?{details,rosterRevision:readElectricianRoster(repo).revision}:{})}),revision:config.revision};
 }
 async function preview(args){
  try{args.assertCurrent();need(!Object.hasOwn(args.input,'serverConnectResolvedIp'),'SERVER_CONNECT_INPUT_INVALID',422);let r=render(args),input=r.serverConnectOverride?{...args.input,serverConnectOverride:r.serverConnectOverride}:args.input;if(args.input.cardType==='server_connect'){const resolvedIp=await resolveConnectIp(r.details.command);args.assertCurrent();if(resolvedIp){input={...input,serverConnectResolvedIp:resolvedIp};r=render({...args,input});}}const id=randomUUID();repo.put('card-preview',id,args.platform,args.actor.id,now(),{...r,id,actorId:args.actor.id,platform:args.platform,input,expiresAt:now()+600000});return {schema:'platform-result/1',state:'succeeded',reference:id,preview:{id,contentHash:r.contentHash,title:r.title,body:r.body},items:[]};}
  catch(error){if(['SERVER_CONNECT_INPUT_INVALID','ELECTRICIAN_LIST_INVALID'].includes(error.errorCode))error.definitelyNotApplied=true;throw error;}
 }
 const dnsCache=new Map();
 async function prepareAutoInput(record){
  if(record.input.cardType!=='server_connect')return record.input;
  const input={...record.input};
  const actor=identity.actorForAccount(record.principal.accountId),config=platformService.config(record.platform);
  if(record.followSource||config.autoWipeCards&&scheduling.repo.get('wipes',input.wipeId)?.revision!==record.sourceRevision)delete input.serverConnectOverride;
  const rendered=render({actor,platform:record.platform,input,config});
  const command=rendered.details.command,cached=dnsCache.get(command);
  if(!cached||cached.expiresAt<=now()){
   const ip=await resolveConnectIp(command);
   dnsCache.set(command,{ip,expiresAt:now()+300000});
  }
  const ip=dnsCache.get(command).ip;
  if(ip)input.serverConnectResolvedIp=ip;else delete input.serverConnectResolvedIp;
  return input;
 }
 let syncWipeCards;
 const durable=createDurableCards({identity,notifications,platformService,runStoreWriteTask,render,prepareAutoInput,refreshWipeCards:()=>syncWipeCards(),now});
 const cards={preview,...durable};
 syncWipeCards=createWipeCardSync({identity,scheduling,notifications,platformService,cards,runStoreWriteTask,now});
 return cards;
}
// Reuse G06's actual native platform classification and isolated transport contract.
export function createG06MessageGateway({platforms,targets}) {
 const targetFor=args=>{
  const matches=targets().filter(t=>t.enabled===true&&t.platform===args.platform&&t.channelId===args.channelId&&
    (!args.guildId||t.guildId===args.guildId)&&(!args.targetId||t.id===args.targetId));
  need(matches.length===1,'TARGET_NOT_CONFIGURED',422);return matches[0];
 };
 const contextFor=args=>({attemptId:args.attemptId||args.operationId,operationKey:args.operationId,executionEpoch:1,timeoutMs:5000,signal:args.signal||new AbortController().signal});
 const run=async(args,edit=false)=>{
  args.assertCurrent();const target=targetFor(args);
  const content=[args.content,...(args.translations||[]).map(x=>`${x.language}: ${x.text}`),...(args.attachments||[]).map(x=>`${x.name}: ${x.url}`)].join('\n').replace(/@/g,'＠').replace(/\((met|rol)\)/gi,'（$1）').slice(0,3800);
  const payload=args.platform==='discord'?{content,embeds:[],components:[],allowed_mentions:{parse:[],roles:[],users:[],replied_user:false}}:{type:10,target_id:target.channelId,content:JSON.stringify([{type:'card',theme:'secondary',size:'lg',modules:[{type:'section',text:{type:'plain-text',content}}]}])};
  const context=contextFor(args),payloadHash=hashPayload(payload),dispatch={platform:args.platform,targetId:target.id,guildId:target.guildId,channelId:target.channelId,
    targetHash:hashPayload(target),payloadHash,attemptId:context.attemptId,operationKey:context.operationKey};
  // Synchronous durable evidence hooks, owned by forwarding; cards need not supply them.
  const prepared=args.onPrepared?.(dispatch);need(!prepared?.then,'FORWARD_EVIDENCE_SYNC_REQUIRED',503);args.assertCurrent();
  const result=await platforms[args.platform][edit?'edit':'send']({target,payload,payloadHash,context,...(edit?{messageRef:{platform:args.platform,guildId:target.guildId,channelId:target.channelId,messageId:args.messageId}}:{})});
  const receipt={kind:'g06-native',attemptId:context.attemptId,operationKey:context.operationKey,
    outcome:['sent','updated','not_sent','not_updated'].includes(result?.outcome)?result.outcome:'unknown',
    ...(result?.messageRef?{messageRef:result.messageRef}:{}),errorCode:typeof result?.errorCode==='string'&&/^[A-Z0-9_]{1,80}$/.test(result.errorCode)?result.errorCode:null};
  const observed=args.onEvidence?.(receipt);need(!observed?.then,'FORWARD_EVIDENCE_SYNC_REQUIRED',503);
  if(result.outcome==='sent'||result.outcome==='updated')return {state:'succeeded',messageId:result.messageRef?.messageId||args.messageId};
  const e=new Error('G06_MESSAGE_UNCONFIRMED');e.definitelyNotApplied=result.outcome==='not_sent'||result.outcome==='not_updated';throw e;
 };
 async function reconcile(args) {
  args.assertCurrent();const r=args.record;
  need(r&&['discord','kook'].includes(r.to)&&typeof r.destination==='string','FORWARD_RECORD_SCOPE_REQUIRED',409);
  const target=targetFor({platform:r.to,channelId:r.destination,guildId:r.destinationGuildId||r.dispatch?.guildId,targetId:r.dispatch?.targetId});
  if(r.dispatch) need(r.dispatch.targetHash===hashPayload(target)&&r.dispatch.platform===r.to&&r.dispatch.channelId===r.destination&&
    r.dispatch.operationKey===args.operationId&&r.dispatch.attemptId===r.attemptId,'FORWARD_TARGET_CHANGED',409);
  const proof=r.delivery;
  if(r.version===2&&proof?.kind==='g06-native'&&proof.outcome==='not_sent'&&r.dispatch&&
    proof.attemptId===r.attemptId&&proof.operationKey===args.operationId)
    return {state:'not_delivered',proof:'G06_NOT_SENT',evidence:'ORIGINAL_SEND_DEFINITIVELY_REJECTED'};
  if(r.version===2&&r.phase==='preparation_failed'&&!r.dispatch&&proof?.kind==='local-not-dispatched'&&proof.attemptId===r.attemptId)
    return {state:'not_delivered',proof:'LOCAL_NOT_DISPATCHED',evidence:'FAILED_BEFORE_DESTINATION_DISPATCH'};
  const known=proof?.outcome==='sent'?proof.messageRef:null;
  const messageId=known?.messageId||r.messageId;
  const refs=messageId?[{platform:r.to,guildId:target.guildId,channelId:target.channelId,messageId}]:[];
  if(typeof platforms[r.to]?.lookup!=='function')return {state:'unknown',evidence:'LOOKUP_UNSUPPORTED'};
  const context=contextFor({...args,attemptId:r.attemptId||args.operationId});
  const result=await platforms[r.to].lookup({target,attemptId:context.attemptId,operationKey:args.operationId,messageRefs:refs,context});
  args.assertCurrent();
  if(result?.outcome==='found'&&refs.length&&result.messageRef?.messageId===messageId&&result.messageRef.platform===r.to&&
    result.messageRef.channelId===target.channelId&&result.messageRef.guildId===target.guildId)
    return {state:'delivered',messageId,evidence:'EXACT_MESSAGE_REFERENCE_FOUND'};
  // Native APIs cannot prove absence by our attempt key. Even exact-id 404 or a
  // transport-supplied not_sent classification of LOOKUP never proves send absence.
  return {state:'unknown',evidence:!refs.length?'NO_EXACT_MESSAGE_REFERENCE':result?.errorCode==='LOOKUP_UNSUPPORTED'?'LOOKUP_UNSUPPORTED':
    ['PLATFORM_TIMEOUT','PLATFORM_ABORTED','PLATFORM_TRANSPORT_ERROR'].includes(result?.errorCode)?'LOOKUP_INTERRUPTED':'LOOKUP_UNCONFIRMED'};
 }
 return {publish:a=>run(a),edit:a=>run(a,true),reconcile};
}
