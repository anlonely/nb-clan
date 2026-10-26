import {requireValue as need} from '../identity/errors.js';
import {nativeText,nativeDescription} from './native-language.js';
import { ownsOpenWipeInteraction } from '../discord-open-wipe/interaction-input.js';
import { ownsSteamLinksInteraction } from '../discord-steam-links/interaction-input.js';
import { steamLinksCommandSchemas } from './steam-links-command-schemas.js';
export const VIP_PREFIX='nb_vital_vip';
export const RANKING_PREFIX='nb_kook_member_ranking';
export const rankingMetrics=Object.freeze({kda:'kda',kd:'kd',kills:'kills',t3Kills:'t3Kills',deaths:'deaths',online_minutes:'onlineSeconds',rockets:'rockets',sulfur:'sulfur',metalOre:'metalOre',building:'building'});
// Route the unchanged signed bytes from the configured compatibility endpoint.
// This only selects the owner; the verifier and canonical configuration still
// validate the event, command, channel and every business permission.
export function managedDiscordInteraction(event,config={}){
 if(ownsOpenWipeInteraction(event)||ownsSteamLinksInteraction(event))return true;
 const custom=event?.data?.custom_id;
 if(event?.type===3&&typeof custom==='string'&&(/^[A-Za-z0-9_-]{43}$/.test(custom)||/^nbconfirm:[A-Za-z0-9_-]{43}$/.test(custom)||/^nblate:[A-Za-z0-9_-]{43}:[0-9]{1,16}$/.test(custom)||custom.startsWith('nblang:')))return true;
 if(event?.type===5&&new RegExp('^'+VIP_PREFIX+':submit:(vital|rustinity|atlas):(none|queue_skip|priority):[a-f0-9]{32}$').test(custom||''))return true;
 if(!config.enabled)return false;
 const targets=(config.targets||[]).filter(target=>target.enabled&&target.guildId===event?.guild_id&&[target.channelId,target.kdaQueryChannelId,target.memberRankingChannelId,target.mapChannelId,target.signupCardChannelId].includes(event?.channel_id));
 if(targets.length!==1)return false;
 const enabled=targets[0].enabledCommandIds||[];
 if(event?.type===3&&typeof custom==='string'&&custom.startsWith(VIP_PREFIX+':'))return enabled.includes('vip');
 return event?.type===2&&typeof event.data?.name==='string'&&(['kda','ranking','map'].includes(event.data.name)?enabled.includes(event.data.name):(config.commands||[]).some(command=>command.enabled&&command.type==='event_command'&&command.slashCommand===event.data.name&&enabled.includes(command.id)));
}
const providers=['vital','rustinity','atlas'];
const good=(v)=>typeof v==='string'&&v.length>0&&v.length<=160&&!/[\x00-\x1f\x7f]/.test(v);
const valid=(ok)=>need(ok,'PLATFORM_PAYLOAD_INVALID',422);
export function retainedDiscordCommandSchemas(config={}){
 const string=(name,key,required=false)=>({name,...nativeDescription(key),type:3,required});
 const common=[string('source','sourceDescription'),string('server','serverDescription'),string('provider_wipe','providerWipeDescription')];
 const builtins=[{name:'kda',...nativeDescription('kdaDescription'),type:1,options:[string('steam_input','steamDescription',true),...common]},
 {name:'ranking',...nativeDescription('rankingDescription'),type:1,options:[string('wipe','wipeIdDescription',true),string('source','sourceDescription'),string('metric','metricDescription')]},
 {name:'map',...nativeDescription('mapDescription'),type:1,options:[string('wipe','wipeIdDescription',true),string('source','sourceDescription')]}];
 const enabled=new Set((config.targets||[]).filter(t=>t.enabled).flatMap(t=>t.enabledCommandIds||[]));
 const openWipe=(config.commands||[]).some(c=>c.id==='newwipe'&&c.enabled&&enabled.has(c.id))?[{
   name:'newwipe',type:1,description:'Create an open wipe sign-up',description_localizations:{
     'zh-CN':'创建无需绑定账号的开放报名','zh-TW':'建立無需綁定帳號的公開報名',ru:'Открыть запись на вайп',tr:'Herkese açık wipe kaydı oluştur',th:'เปิดลงชื่อไวป์สำหรับทุกคน',ko:'누구나 참여할 수 있는 와이프 신청 만들기'},options:[]
 }]:[];
 const steamLinks=steamLinksCommandSchemas().filter(schema=>(config.commands||[]).some(c=>c.id===schema.name&&c.slashCommand===schema.name&&c.type==='slash_command'&&c.enabled&&enabled.has(c.id)));
 return [...builtins.filter(c=>enabled.has(c.name)|| (config.commands||[]).some(def=>def.enabled&&def.slashCommand===c.name&&enabled.has(def.id))),...openWipe,...steamLinks,...(config.commands||[]).filter(c=>c.enabled&&c.type==='event_command'&&enabled.has(c.id)&&/^[a-z0-9_-]{1,32}$/.test(c.slashCommand)&&!['kda','ranking','map','newwipe','setsteam','view'].includes(c.slashCommand)).map(c=>({name:c.slashCommand,type:1,...nativeDescription('wipeDescription'),options:[string('wipe','wipeIdDescription',true),{name:'mention_everyone',...nativeDescription('mentionDescription'),type:5,required:false}]}))];
}
export function retainedSlash(data){
 valid(data&&/^[a-z0-9_-]{1,32}$/.test(data.name));valid(Array.isArray(data.options)&&data.options.length>=1&&data.options.length<=2);
 const result={kind:'community',command:'wipe_card',slashCommand:data.name,mentionEveryone:false};const seen=new Set();
 for(const o of data.options){valid(!seen.has(o.name));seen.add(o.name);if(o.name==='wipe'){valid(o.type===3&&good(o.value));result.wipeId=o.value;}else{valid(o.name==='mention_everyone'&&o.type===5&&typeof o.value==='boolean');result.mentionEveryone=o.value;}}
 valid(result.wipeId);return result;
}
export function retainedDiscordComponent(event){
 const d=event.data,custom=d?.custom_id;if(typeof custom!=='string'||!custom.startsWith(VIP_PREFIX+':'))return null;
 const parts=custom.split(':'),step=parts[1],payload={kind:'community',command:'vip',nativeAction:step};
 if(step==='open'){valid(event.type===3&&d.component_type===2&&parts.length===2);return payload;}
 if(step==='provider'){valid(event.type===3&&d.component_type===3&&parts.length===2&&d.values?.length===1&&providers.includes(d.values[0]));return {...payload,provider:d.values[0]};}
 const provider=parts[2]||'vital';valid(providers.includes(provider));payload.provider=provider;
 if(step==='type'){valid(event.type===3&&d.component_type===3&&parts.length<=3&&d.values?.length===1);payload.type=d.values[0];}
 else{
  valid(step==='submit'&&event.type===5&&parts.length===5&&/^[a-f0-9]{32}$/.test(parts[4]));payload.type=parts[3];payload.contextToken=parts[4];
  valid(Array.isArray(d.components)&&d.components.length===2);const values={};
  for(const row of d.components){const field=row.type===18?row.component:row.type===1&&row.components?.length===1?row.components[0]:null;valid(field&&['date_month','date_day'].includes(field.custom_id)&&!Object.hasOwn(values,field.custom_id));const value=field.type===3&&field.values?.length===1?field.values[0]:field.type===4?field.value:null;valid(typeof value==='string'&&/^\d{1,2}$/.test(value));values[field.custom_id]=Number(value);}
  valid(Object.keys(values).length===2);payload.month=values.date_month;payload.day=values.date_day;
 }
 valid(['none','queue_skip','priority'].includes(payload.type)&&(provider!=='rustinity'||payload.type!=='priority'));return payload;
}
export function retainedKookButton(clicked){
 if(typeof clicked.value!=='string'||!clicked.value.startsWith(RANKING_PREFIX+':'))return null;
 const parts=clicked.value.split(':');valid(parts.length===3&&parts[1]==='metric'&&Object.hasOwn(rankingMetrics,parts[2]));
 return {kind:'community',command:'ranking_switch',metric:rankingMetrics[parts[2]],messageId:clicked.msg_id};
}
export function vipInteraction(input,contextToken,language='zh-CN'){
 const text=(key,values)=>nativeText(language,key,values),labels={none:'vipNone',queue_skip:'vipQueueSkip',priority:'vipPriority'};
 const select=(custom_id,options)=>({type:4,data:{flags:64,content:text('vipEdit'),allowed_mentions:{parse:[]},components:[{type:1,components:[{type:3,custom_id,min_values:1,max_values:1,options:options.map(value=>({label:labels[value]?text(labels[value]):value,value}))}]}]}});
 if(input.nativeAction==='open')return select(VIP_PREFIX+':provider',providers);
 if(input.nativeAction==='provider')return select(VIP_PREFIX+':type:'+input.provider,input.provider!=='rustinity'?['none','queue_skip','priority']:['none','queue_skip']);
 return {type:9,data:{title:text('vipTitle',{provider:input.provider}),custom_id:`${VIP_PREFIX}:submit:${input.provider}:${input.type}:${contextToken}`,components:[{type:18,label:text('vipMonth'),component:{type:3,custom_id:'date_month',min_values:1,max_values:1,options:Array.from({length:12},(_,i)=>({label:String(i+1),value:String(i+1)}))}},{type:18,label:text('vipDay'),component:{type:4,custom_id:'date_day',style:1,min_length:1,max_length:2,required:true}}]}};
}
