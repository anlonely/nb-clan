import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { specialties } from '../../../shared/member-preferences.js';
import { ELECTRICIAN_COMMAND_ID, electricianDetails } from './electrician-card.js';
import { normalizeDiscordWipeConfig, WIPE_SIGNUP_MODES } from './wipe-command.js';
export const need=(ok,code='PLATFORM_INPUT_INVALID',status=422,current)=>{if(!ok)throw new IdentityError(code,status,{current});};
export const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export const ids=['discord','kook','bridge','wechat'];
export const scopeId=id=>id==='bridge'?'discord_kook_bridge':id;
export const text=(v,max=160)=>{need(typeof v==='string'&&v.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(v));return v;};
export const identifier=v=>{text(v);need(/^[A-Za-z0-9:_-]{1,160}$/.test(v));return v;};
const bool=v=>{need(typeof v==='boolean');return v;};
const strings=v=>{need(Array.isArray(v)&&v.length<=30);return [...new Set(v.map(x=>text(x)))];};
const discordIds=v=>{need(Array.isArray(v)&&v.length<=30);need(v.every(x=>typeof x==='string'&&/^\d{17,20}$/.test(x)));return [...new Set(v)];};
const integer=(v,min,max)=>{need(Number.isSafeInteger(v)&&v>=min&&v<=max);return v;};
const pick=(v,schema)=>{need(v&&typeof v==='object'&&!Array.isArray(v));need(Object.keys(v).every(k=>k in schema));return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,schema[k](x)]));};
const array=(v,schema)=>{need(Array.isArray(v)&&v.length<=30);const rows=v.map(x=>pick(x,schema));need(rows.every(x=>x.id)&&new Set(rows.map(x=>x.id)).size===rows.length);return rows;};
const newwipeTarget={newwipeAllowedRoleIds:discordIds,newwipeAllowedUserIds:discordIds,newwipeAllowAdministrators:bool,newwipeChannelIds:discordIds};
const steamTeamTarget={steamTeamCnRoleIds:discordIds,steamTeamEuRoleIds:discordIds,steamTeamCnSquadId:v=>v===''?'':identifier(v),steamTeamEuSquadId:v=>v===''?'':identifier(v)};
const steamLinksTarget={steamListAllowedRoleIds:discordIds,steamListAllowedUserIds:discordIds,...steamTeamTarget};
const target={id:identifier,name:v=>text(v,100),guildId:text,channelId:text,signupCardChannelId:text,serverConnectChannelId:text,electricianChannelId:text,welcomeGuideChannelId:text,enabled:bool,enabledCommandIds:strings,kdaQueryChannelId:text,memberRankingChannelId:text,mapChannelId:text,...newwipeTarget,...steamLinksTarget};
const command={id:identifier,name:v=>text(v,100),type:v=>{need(['slash_command','persistent_card','event_card','event_command'].includes(v));return v;},slashCommand:v=>text(v,80),signupMode:v=>{need(WIPE_SIGNUP_MODES.includes(v),'WIPE_SIGNUP_MODE_INVALID');return v;},autoMatchTeamByRole:bool,titleTemplate:v=>text(v,200),bodyTemplate:v=>text(v,4000),electriciansCn:v=>text(v,4000),electriciansForeign:v=>text(v,4000),enabled:bool};
const route={id:identifier,name:v=>text(v,100),enabled:bool,discordGuildId:text,discordChannelId:text,kookGuildId:text,kookChannelId:text,direction:v=>{need(['both','discord_to_kook','kook_to_discord'].includes(v));return v;},translate:bool,languages:strings,includeAttachments:bool};
const roleName=v=>{const name=text(v,100).trim();need(Boolean(name));return name;};
const roleSpecialtyMapping={id:identifier,roleName,roleId:identifier,guildId:identifier,specialty:v=>{need(typeof v==='string'&&Object.hasOwn(specialties,v));return v;}};
const roleMappingBase={id:identifier,roleName,roleId:identifier,guildId:identifier};
const roleSquadMapping={...roleMappingBase,squadId:identifier};
const roleSystemMapping={...roleMappingBase,systemRole:v=>{need(['member','admin'].includes(v));return v;}};
const roleRules=schema=>v=>{const rows=array(v,schema);need(rows.every(row=>Boolean(row.roleId)===Boolean(row.guildId)));if(schema===roleSpecialtyMapping)need(rows.every(row=>row.roleName&&row.specialty));else{need(rows.every(row=>row.roleId&&row.guildId&&row.roleName&&(schema===roleSquadMapping?row.squadId:row.systemRole)));need(new Set(rows.map(row=>`${row.guildId}:${row.roleId}`)).size===rows.length);}return rows;};
const base={enabled:bool};
export const secretFields={discord:['botToken','oauthSecret'],kook:['botToken','verifyToken','encryptKey','oauthSecret'],bridge:['translationApiKey'],wechat:['appSecret']};
export const WECHAT_SUBSCRIPTION_TEMPLATE_KEYS=Object.freeze(['wipeSignupStatus','wipeOpen','wipeReminder']);
// An explicit replacement map. The old unordered array cannot identify a
// business template; missing keys stay unconfigured, never guessed by position.
export function normalizeSubscriptionTemplates(input){
  need(input&&typeof input==='object'&&!Array.isArray(input)&&[Object.prototype,null].includes(Object.getPrototypeOf(input)),'PLATFORM_TEMPLATE_MAP_INVALID');
  need(Object.keys(input).every(key=>WECHAT_SUBSCRIPTION_TEMPLATE_KEYS.includes(key)),'PLATFORM_TEMPLATE_MAP_INVALID');
  return Object.fromEntries(WECHAT_SUBSCRIPTION_TEMPLATE_KEYS.map(key=>{
    const raw=Object.hasOwn(input,key)?input[key]:'';
    need(typeof raw==='string'&&raw.length<=160,'PLATFORM_TEMPLATE_MAP_INVALID');
    const value=raw.trim();need(value===''||/^[A-Za-z0-9_-]+$/.test(value),'PLATFORM_TEMPLATE_MAP_INVALID');
    return [key,value];
  }));
}
// Compatibility projection for old saved configuration; retired fields have no consumer.
const retiredCommands=new Set(['member','kookMember','register','registration','review','application','application_submit','application_edit']);
export function stripRetiredRegistrationConfig(id,input){
 if(!input||typeof input!=='object'||Array.isArray(input))return input;
 const next={...input};
 if(['discord','kook'].includes(id)){
  if(!Array.isArray(next.roleSpecialtyMappings))next.roleSpecialtyMappings=[];
  if(!Array.isArray(next.roleSquadMappings))next.roleSquadMappings=[];
  if(!Array.isArray(next.roleSystemMappings))next.roleSystemMappings=[];
  if(Array.isArray(next.targets))next.targets=next.targets.map(row=>{const {memberRegisterChannelId,memberReviewChannelId,memberManageRoleId,...target}=row;return {...target,...(Array.isArray(target.enabledCommandIds)?{enabledCommandIds:target.enabledCommandIds.filter(id=>!retiredCommands.has(id))}:{})};});
  if(Array.isArray(next.commands))next.commands=next.commands.filter(command=>!retiredCommands.has(command.id)&&!retiredCommands.has(command.slashCommand));
 }
 if(id==='wechat'&&next.subscriptionTemplates&&typeof next.subscriptionTemplates==='object'&&!Array.isArray(next.subscriptionTemplates)){
  const {joinReviewResult,adminJoinReview,...templates}=next.subscriptionTemplates;next.subscriptionTemplates=templates;
 }
 return id==='discord'?normalizeDiscordWipeConfig(next):next;
}
export function normalizeConfig(id,input){
  input=stripRetiredRegistrationConfig(id,input);
  const mappings={roleSpecialtyMappings:roleRules(roleSpecialtyMapping),roleSquadMappings:roleRules(roleSquadMapping),roleSystemMappings:roleRules(roleSystemMapping)};
  const schemas={discord:{...base,autoWipeCards:bool,applicationId:text,publicKey:v=>text(v,256),targets:v=>array(v,target),commands:v=>array(v,command),...mappings},kook:{...base,autoWipeCards:bool,targets:v=>array(v,target),commands:v=>array(v,command),...mappings},bridge:{...base,pollIntervalSeconds:v=>integer(v,5,300),translationModel:v=>text(v,100),translationBaseUrl:v=>{text(v,500);if(v){let u;try{u=new URL(v);}catch{need(false);}need(u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash);}return v;},routes:v=>array(v,route)},wechat:{...base,appId:identifier,minClientVersion:v=>integer(v,1,2),subscriptionTemplateIds:strings,subscriptionTemplates:normalizeSubscriptionTemplates}};
  need(ids.includes(id));const config=pick(input,schemas[id]);
  for(const row of config.commands||[])if(Object.hasOwn(row,'signupMode'))need(id==='discord'&&row.id==='wipe','WIPE_SIGNUP_MODE_INVALID');
  for(const row of config.targets||[])if(Object.keys(newwipeTarget).some(key=>Object.hasOwn(row,key)))need(id==='discord','NEWWIPE_CONFIG_INVALID');
  for(const row of config.commands||[])if(row.id==='newwipe'||row.slashCommand==='newwipe')need(id==='discord'&&row.id==='newwipe'&&row.type==='event_command'&&row.slashCommand==='newwipe','NEWWIPE_CONFIG_INVALID');
  for(const row of config.targets||[])if(Object.keys(steamLinksTarget).some(key=>Object.hasOwn(row,key)))need(id==='discord','STEAM_LINKS_CONFIG_INVALID');
  for(const row of config.targets||[])if(Object.keys(steamTeamTarget).some(key=>Object.hasOwn(row,key))){
    const cn=row.steamTeamCnRoleIds||[],eu=row.steamTeamEuRoleIds||[];
    need((!cn.length||row.steamTeamCnSquadId)&&(!eu.length||row.steamTeamEuSquadId),'STEAM_TEAM_CONFIG_INVALID');
    need(!cn.some(role=>eu.includes(role)),'STEAM_TEAM_CONFIG_INVALID');
    need(!row.steamTeamCnSquadId||!row.steamTeamEuSquadId||row.steamTeamCnSquadId!==row.steamTeamEuSquadId,'STEAM_TEAM_CONFIG_INVALID');
  }
  for(const row of config.commands||[]){
    if(Object.hasOwn(row,'autoMatchTeamByRole'))need(id==='discord'&&row.id==='setsteam','STEAM_TEAM_CONFIG_INVALID');
    const reserved=['setsteam','view'],name=row.slashCommand?.trim().replace(/^\//,'').toLowerCase();
    if(reserved.includes(row.id)||reserved.includes(name)){
      need(id==='discord'&&reserved.includes(row.id)&&row.type==='slash_command'&&row.slashCommand===row.id,'STEAM_LINKS_CONFIG_INVALID');
      row.enabled??=false;
      if(row.id==='setsteam')row.autoMatchTeamByRole??=false;
    }
  }
  if(['discord','kook'].includes(id))for(const row of config.commands||[])if(row.id===ELECTRICIAN_COMMAND_ID)need(row.type==='persistent_card'&&(!Object.hasOwn(row,'electriciansCn')&&!Object.hasOwn(row,'electriciansForeign')||electricianDetails(row)),'ELECTRICIAN_LIST_INVALID',422);
  return config;
}
export function defaults(id){return {id,revision:0,enabled:false,...(id==='bridge'?{pollIntervalSeconds:30,translationModel:'',translationBaseUrl:'',routes:[]}:id==='wechat'?{appId:'unconfigured',minClientVersion:1,subscriptionTemplateIds:[],subscriptionTemplates:normalizeSubscriptionTemplates({})}:{autoWipeCards:false,targets:[],commands:[],roleSpecialtyMappings:[],roleSquadMappings:[],roleSystemMappings:[],...(id==='discord'?{applicationId:'',publicKey:''}:{})})};}
export const ACTIONS={
 policy_save:{adapter:'identity',method:'savePolicy',platforms:['discord','kook']},metadata:{adapter:'platform',method:'metadata'},register_commands:{adapter:'platform',method:'registerCommands',platforms:['discord']},
 query:{adapter:'queries',method:'query',extra:'queries.run'},ranking:{adapter:'stats',method:'ranking',extra:'stats.read'},map:{adapter:'scheduling',method:'map',extra:'wipes.read'},
 card_preview:{adapter:'cards',method:'preview',extra:'notifications.preview'},card_publish:{adapter:'cards',method:'publish',extra:'notifications.send'},card_refresh:{adapter:'cards',method:'refresh',extra:'notifications.send'},
 forward_run:{adapter:'forwarding',method:'run',platforms:['bridge']},forward_reset:{adapter:'forwarding',method:'reset',platforms:['bridge']},forward_reconcile:{adapter:'forwarding',method:'reconcile',platforms:['bridge']},
 unbind:{adapter:'members',method:'unbind',extra:'members.review'},
 sync:{adapter:'sync',method:'request',extra:'sync.run'},verify:{adapter:'platform',method:'verify'}
};
export const UNAVAILABLE='PLATFORM_ADAPTER_UNAVAILABLE';
