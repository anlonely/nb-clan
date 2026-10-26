import path from 'node:path';
import {need} from './config.js';
export const fields=(value,keys,code='CANDIDATE_EXTERNAL_BINDINGS_INVALID')=>need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k)),code,422);
export const revision=value=>typeof value==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(value);
const absolute=value=>typeof value==='string'&&path.isAbsolute(value)&&path.normalize(value)===value;
export function validateProviders(p){
 if(p===undefined)return;
 fields(p,['enabled','capabilities','readConfiguration','readInventoryConfiguration','readEntitlements','fetchImpl','proxyFetch','proxyWebSocket','chromium','limits']);
 need(typeof p.enabled==='boolean','CANDIDATE_PROVIDER_CONTROL_REQUIRED',422);fields(p.capabilities||{},['moose','inventory']);
 need(Object.values(p.capabilities||{}).every(v=>typeof v==='boolean'),'CANDIDATE_PROVIDER_CONTROL_REQUIRED',422);
 for(const key of ['readConfiguration','readInventoryConfiguration','readEntitlements','fetchImpl','proxyFetch','proxyWebSocket'])need(p[key]===undefined||typeof p[key]==='function','CANDIDATE_PROVIDER_PORT_INVALID',422);
 if(p.chromium){fields(p.chromium,['executablePath','allowedExecutablePaths']);need(absolute(p.chromium.executablePath)&&Array.isArray(p.chromium.allowedExecutablePaths)&&p.chromium.allowedExecutablePaths.length<=10&&p.chromium.allowedExecutablePaths.every(absolute),'CANDIDATE_CHROMIUM_ALLOWLIST_REQUIRED',422);}
 if(p.limits){fields(p.limits,['timeoutMs','maxBytes','maxTotalBytes','maxRequests','maxSessions']);for(const [k,lo,hi] of [['timeoutMs',20,120000],['maxBytes',128,8388608],['maxTotalBytes',128,33554432],['maxRequests',1,1000],['maxSessions',1,12]])need(p.limits[k]===undefined||Number.isSafeInteger(p.limits[k])&&p.limits[k]>=lo&&p.limits[k]<=hi,'CANDIDATE_PROVIDER_LIMIT_INVALID',422);}
}
export function validateVip(v){
 if(v===undefined)return;
 fields(v,['enabled','revision','principal','sources','readSourceConfig','readDmTarget']);
 need(typeof v.enabled==='boolean'&&revision(v.revision),'CANDIDATE_VIP_POLICY_REQUIRED',422);
 if(v.enabled||v.principal){fields(v.principal,['accountId','permissionVersion']);need(revision(v.principal.accountId)&&Number.isSafeInteger(v.principal.permissionVersion)&&v.principal.permissionVersion>0,'CANDIDATE_VIP_PRINCIPAL_REQUIRED',422);}
 if(v.sources){fields(v.sources,['vital','rustinity','atlas']);for(const source of Object.values(v.sources)){fields(source,['enabled','revision']);need(typeof source.enabled==='boolean'&&revision(source.revision),'CANDIDATE_VIP_POLICY_REQUIRED',422);}}
 for(const key of ['readSourceConfig','readDmTarget'])need(v[key]===undefined||typeof v[key]==='function','CANDIDATE_VIP_PORT_INVALID',422);
}
