import {jobResult,rankingResult,mapResult} from './results.js';
import {communityLanguage,nativeText} from '../notification-platforms/native-language.js';
import { need,UNAVAILABLE } from './model.js';
const result=(items=[],reference=null)=>({schema:'platform-result/1',state:'succeeded',items,reference});
const omit=(input,keys)=>Object.fromEntries(Object.entries(input).filter(([k])=>!keys.includes(k)));
// The root injects existing service instances, including its write/cache owner.
// These are calls into G03/G04/G05/G07, never copies of their records or rules.
export function createPublishedPlatformAdapters({identity,scheduling,memberSpace,stats,executeStatsJob,sync,write=fn=>fn()}){
 const platform={},mini={};
 for(const s of [scheduling,memberSpace,stats,sync].filter(Boolean))need(s.identity===identity,'PLATFORM_SETUP_REQUIRED',503);
 if(memberSpace)mini.profile={me:({actor})=>memberSpace.me(actor),read:({actor})=>memberSpace.me(actor),save:({actor,input,operationId,assertCurrent})=>write(()=>{assertCurrent();return memberSpace.patchMe(actor,input,{operationId});})};
 if(scheduling){
  platform.scheduling={map:args=>{const w=scheduling.getWipe(args.actor,args.input.wipeId);return mapResult(w,communityLanguage(args));}};
  const command=name=>({actor,input,operationId,assertCurrent})=>write(()=>{assertCurrent();return scheduling.transition(actor,input.wipeId,name,omit(input,['wipeId']),{operationId,source:'wechat'});});
  mini.scheduling={list:({actor,input})=>scheduling.listWipes(actor,input),map:({actor,input})=>scheduling.getWipe(actor,input.wipeId),participants:({actor,input})=>scheduling.listSignups(actor,input.wipeId,input),
   create:({actor,input,operationId,assertCurrent})=>write(()=>{assertCurrent();return scheduling.createWipe(actor,input,{operationId,source:'wechat'});}),
   edit:({actor,input,operationId,assertCurrent})=>write(()=>{assertCurrent();return scheduling.updateWipe(actor,input.wipeId,omit(input,['wipeId']),{operationId,source:'wechat'});}),publish:command('publish'),open:command('reopen-signup'),closeSignup:command('close-signup'),end:command('end'),
   delegate:async({actor,input,operationId,assertCurrent})=>{const options={operationId,source:'wechat',delegate:true};await scheduling.prepareSignupTarget(actor,input.wipeId,input.memberId,options);assertCurrent();return write(()=>scheduling.saveSignup(actor,input.wipeId,input.memberId,omit(input,['wipeId','memberId']),options));},
   withdraw:async({actor,input,operationId,assertCurrent})=>{const options={operationId,source:'wechat',delegate:true};await scheduling.prepareSignupTarget(actor,input.wipeId,input.memberId,options);assertCurrent();return write(()=>scheduling.saveSignup(actor,input.wipeId,input.memberId,{...omit(input,['wipeId','memberId']),response:null},options));}
  };
 }
 if(stats){const ranking=({actor,input})=>stats.list(actor,{...input,sourceId:input.sourceId||'vital',metricVersion:'nb-kda-1'});mini.stats={ranking};platform.stats={ranking:args=>{const r=ranking(args);return rankingResult(r,args.input.sort||args.input.metric,communityLanguage(args));}};
  const query=async({actor,input,operationId,assertCurrent})=>{need(typeof executeStatsJob==='function',UNAVAILABLE,503);assertCurrent();const body={sourceId:input.sourceId||'official',steamInput:input.steamInput||input.steamId,...(input.serverId?{serverId:input.serverId}:{}),...(input.providerWipeId?{providerWipeId:input.providerWipeId}:{})};const queued=await write(()=>stats.createJob(actor,'query',body,operationId));await executeStatsJob(queued.jobId);assertCurrent();return stats.readJob(actor,queued.jobId);};mini.queries={query};platform.queries={query:async args=>{const r=await query(args);return jobResult(r,communityLanguage(args));}};
 }
 if(sync){const request=({actor,input,operationId,assertCurrent})=>{assertCurrent();return sync.request(actor,input,{operationId});};mini.sync={request,list:({actor,input})=>sync.list(actor,input)};platform.sync={request:async args=>{const r=await request(args);need(r.job?.id,'PLATFORM_ADAPTER_CONTRACT',503);return result([{id:r.job.id,label:nativeText(communityLanguage(args),'syncQueued'),status:r.job.status}],r.job.id);}};}
 return {platform,mini};
}
