import { parseMemberLocation } from '../router.js';
import { arrivalTime, localInput } from '../format.js';
const wipeTabs = new Set(['overview', 'roster', 'materials', 'stats', 'notifications', 'history']);
// Older links used tab=plan. Unknown or retired tabs still open the arrangement
// overview instead of rendering a header with no page content.
export const adminWipeTab = value => wipeTabs.has(value) ? value : 'overview';
export function matchAdminLocation(path) {
  const parsed=parseMemberLocation(path); if(!parsed.pathname)return null;
  const base={searchParams:parsed.searchParams,hash:parsed.hash},p=parsed.pathname;
  if(['/admin','/admin/','/admin/wipes'].includes(p))return {...base,page:'list'};
  if(p==='/admin/wipes/new')return {...base,page:'new'};
  const match=p.match(/^\/admin\/(wipes|publish-intents|deliveries)\/([^/]+)(\/notifications)?$/);
  if(!match||match[3]&&match[1]!=='wipes')return null;
  const id=decodeURIComponent(match[2]);
  return {...base,page:match[1]==='wipes'?(match[3]?'notifications':'wipe'):match[1]==='deliveries'?'delivery':'intent',
    [match[1]==='wipes'?'wipeId':match[1]==='deliveries'?'deliveryId':'intentId']:id};
}
export const timeFields={serverScheduledWipeAt:'服务器预计开服',signupClosesAt:'报名截止时间'};
// Only defaults owned by this editing session follow template changes. Loaded
// drafts and explicitly touched fields (including a deliberate clear) stay put.
function zonedInstant(value, zone) {
  const local=localInput(value,zone),minutes=Math.round((Date.parse(`${local}:00Z`)-Math.floor(Date.parse(value)/60000)*60000)/60000);
  return {local,offset:`${minutes<0?'-':'+'}${String(Math.floor(Math.abs(minutes)/60)).padStart(2,'0')}:${String(Math.abs(minutes)%60).padStart(2,'0')}`};
}
export function serverTemplatePatch(server,form) {
  const snapshot=server.serverSnapshot;
  const patch={serverProfileId:server.id,serverSnapshot:snapshot&&typeof snapshot==='object'&&!Array.isArray(snapshot)?structuredClone(snapshot):{name:server.label||''},
    serverScheduleSource:server.serverScheduleSource??form?.serverScheduleSource??null};
  if(!form)return patch;
  const next=Date.parse(patch.serverSnapshot.nextWipeAt),times={...form.times},offsets={...form.offsets},automaticTimes={...form.automaticTimes};
  for(const [key,delta] of [['serverScheduledWipeAt',0]]) {
    if(form.protectedTimes?.[key]||(!automaticTimes[key]&&times[key]))continue;
    const instant=Number.isFinite(next)?new Date(next+delta).toISOString():null;
    const zoned=instant?zonedInstant(instant,form.timeZone):{local:'',offset:''};
    times[key]=zoned.local;offsets[key]=zoned.offset;automaticTimes[key]=instant;
  }
  return withDefaultDeadline(form,{...patch,times,offsets,automaticTimes});
}
function withDefaultDeadline(form,patch) {
  if(form.protectedTimes?.signupClosesAt)return patch;
  const times={...form.times,...patch.times},offsets={...form.offsets,...patch.offsets};
  times.signupClosesAt=times.serverScheduledWipeAt;
  offsets.signupClosesAt=offsets.serverScheduledWipeAt||'';
  return {...patch,times,offsets};
}
export function manualTimePatch(form,key,value,isOffset=false) {
  const patch={times:{...form.times,...(!isOffset?{[key]:value}:{})},offsets:{...form.offsets,[key]:isOffset?value:''},
    protectedTimes:{...form.protectedTimes,[key]:true},automaticTimes:{...form.automaticTimes,[key]:null}};
  return key==='serverScheduledWipeAt'?withDefaultDeadline(form,patch):patch;
}
export function timeZonePatch(form,zone) {
  try {new Intl.DateTimeFormat('en',{timeZone:zone});}catch {throw {errorCode:'TIME_ZONE_INVALID'};}
  const times={...form.times},offsets={...form.offsets};
  for(const key of Object.keys(timeFields))if(times[key]) {
    const value=arrivalTime(times[key],form.timeZone,offsets[key]),zoned=zonedInstant(value,zone);
    times[key]=zoned.local;offsets[key]=zoned.offset;
  }
  return {timeZone:zone,times,offsets};
}
export function draftForm(wipe,zone='Asia/Shanghai') {
  const w=wipe||{},z=w.timeZone||zone,offsets={};
  const times=Object.fromEntries(Object.keys(timeFields).map(k=>{
    if(!w[k])return [k,''];
    const value=zonedInstant(w[k],z);offsets[k]=value.offset;return [k,value.local];
  }));
  return {title:w.title||'',description:w.description||'',serverProfileId:w.serverProfileId||'',serverSnapshot:w.serverSnapshot||{},serverScheduleSource:w.serverScheduleSource||null,
    timeZone:z,audience:!wipe||w.lifecycle==='draft'?{allMembers:true,squadIds:[],memberIds:[],includeUnassigned:true}:w.audience||{allMembers:true,squadIds:[],memberIds:[],includeUnassigned:true},autoStart:w.autoStart??false,autoOpenSignup:w.autoOpenSignup??true,
    times,offsets,automaticTimes:{},protectedTimes:Object.fromEntries(Object.keys(timeFields).map(k=>[k,Boolean(wipe)]))};
}
export function draftCommand(form,base=null,{reason='',majorChange=false}={}) {
  const rawTimeInputs={},times={};
  for(const key of Object.keys(timeFields)) {
    times[key]=form.times[key]?arrivalTime(form.times[key],form.timeZone,form.offsets[key]):null;
    if(times[key])rawTimeInputs[key]={localDateTime:form.times[key],timeZone:form.timeZone,...(form.offsets[key]?{utcOffset:form.offsets[key]}:{})};
  }
  // New schedules have one start time. Preserve the old internal time on
  // unrelated edits to keep the stored schedule consistent.
  const preserveLegacy=base?.musterAt&&base.serverScheduledWipeAt===times.serverScheduledWipeAt;
  times.musterAt=preserveLegacy?base.musterAt:times.serverScheduledWipeAt;
  if(!preserveLegacy&&rawTimeInputs.serverScheduledWipeAt)rawTimeInputs.musterAt={...rawTimeInputs.serverScheduledWipeAt};
  return {title:form.title,description:form.description,serverProfileId:form.serverProfileId||null,serverSnapshot:Object.keys(form.serverSnapshot).length?form.serverSnapshot:null,
    serverScheduleSource:form.serverScheduleSource,audience:structuredClone(form.audience),timeZone:form.timeZone,autoStart:form.autoStart,autoOpenSignup:form.autoOpenSignup,...times,rawTimeInputs,
    ...(!base||base.lifecycle==='draft'?{publishImmediately:true}:{}),
    ...(base?{expectedRevision:base.revision,reason,majorChange}:{})};
}
export function invalidateWipe(client,id) {
  for(const key of [['wipe',id],['admin-history',id],['signups',id],['home'],['wipes'],['history'],['admin-wipes'],['notification-options',id],['notification-intents',id]])client.invalidateQueries(key);
}
export const windowLabel={open:'报名开放',not_open:'报名未开放',closed:'报名已关闭'};
export const countScopeLabel={authorized_wipes:'当前授权可见档期',authorized_targets:'当前授权可见通知目标',audience:'本场全部有效受众',authorized_members:'当前授权可见成员',archived_audience:'归档时全部受众',authorized_archived_members:'当前可见归档成员'};
export const commandNames={publish:'发布安排',start:'开始本场',end:'结束本场',cancel:'取消安排','close-signup':'关闭报名','reopen-signup':'开放 / 延长报名','confirm-start':'确认实际开荒','confirm-server-start':'确认服务器已开服',archive:'归档本场','revise-archive':'新建归档修订'};
export function availableCommands(w) {
  return ({draft:['publish','cancel'],scheduled:['reopen-signup','close-signup','start','cancel'],active:['reopen-signup','close-signup','confirm-start','confirm-server-start','end'],ended:['archive'],archived:['revise-archive'],cancelled:[]})[w.lifecycle]||[];
}
