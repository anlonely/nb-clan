import { createHash } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
export const TYPES={discord_membership_audit:'discord',kook_member_sync:'kook',battlemetrics_identity:'battlemetrics',battlemetrics_playtime:'battlemetrics',kda:'kda',hexaytron_profile:'hexaytron',member_profile:'steam',steam_profile_backfill:'steam',local_consistency:'local'};
export const LABELS={discord_membership_audit:'Discord 成员资料更新',kook_member_sync:'KOOK 成员角色更新',battlemetrics_identity:'BM 玩家匹配',battlemetrics_playtime:'BM 在线时长',kda:'本档战绩',hexaytron_profile:'Hexaytron 资料',member_profile:'成员资料',steam_profile_backfill:'Steam 资料补偿',local_consistency:'本地一致性检查'};
// Retain type metadata solely for historical jobs and legacy migrations.
export const RETIRED_TYPES = ['hexaytron_profile','local_consistency'];
export const supportedType = type => Object.hasOwn(TYPES, type) && !RETIRED_TYPES.includes(type);
export const ACTIVE=['queued','running','retry_wait','paused'];
export const COMPLETED_ITEMS=['succeeded','partial','failed','skipped'];
export const INCOMPLETE_JOBS=['partial','partial_failed','failed'];
export const need=(ok,code='SYNC_INPUT_INVALID',status=422,current=null)=>{if(!ok)throw new IdentityError(code,status,{current});};
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const sync=value=>{need(!value?.then,'SYNC_ADAPTER_ATOMICITY_REQUIRED',503);return value;};
export function scopeInput(s={kind:'current_wipe'}) {need(['current_wipe','squad','members','all_members','missing_only','failed'].includes(s.kind));return {kind:s.kind,...(s.id?{id:String(s.id).slice(0,160)}:{}),...(s.memberIds?{memberIds:[...new Set(s.memberIds)].sort()}:{}),...(s.wipeId?{wipeId:s.wipeId}:{})};}
export function counts(job) {const c={total:job.items.length,succeeded:0,partial:0,failed:0,skipped:0,pendingOrRunning:0};for(const i of job.items){if(COMPLETED_ITEMS.includes(i.status))c[i.status]++;else c.pendingOrRunning++;}return c;}
export function finish(job,now,forced) {const c=counts(job);if(forced){for(const i of job.items)if(!COMPLETED_ITEMS.includes(i.status)){i.status='skipped';i.reason=forced.toUpperCase();}job.status=forced;}else if(c.pendingOrRunning)return;else job.status=c.failed?(c.succeeded||c.partial?'partial_failed':'failed'):c.partial?'partial':c.succeeded?'succeeded':'no_work';job.finishedAt=now;job.leaseUntil=0;job.owner=null;}
export function sourceDefaults(id){return {id,source:id,revision:1,concurrency:id==='battlemetrics'?2:1,reservedManual:id==='battlemetrics'?1:0,minIntervalMs:id==='kook'?3000:1000,timeoutMs:id==='kook'?30000:15000,maxAttempts:3,priority:50,paused:false,pauseReason:null,nextAllowedAt:0,updatedAt:0};}
export const iso=n=>n?new Date(n).toISOString():null;
export const projection=j=>({id:j.id,type:j.type,source:j.source,trigger:j.trigger,scope:j.scope,status:j.status,counts:j.legacyCounts||counts(j),revision:j.revision,createdAt:iso(j.createdAt),startedAt:iso(j.startedAt),finishedAt:iso(j.finishedAt),updatedAt:iso(j.updatedAt),deadlineAt:iso(j.deadlineAt),retryAt:iso(j.retryAt),cancelRequested:Boolean(j.cancelRequested),parentJobId:j.parentJobId||null,legacy:Boolean(j.legacy),recoveryRequired:Boolean(j.recoveryRequired),operationId:j.operationId,reason:j.reason||null});
