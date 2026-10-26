import {need} from './model.js';
/** Trusted server-only cache adapter. Replay reads CURRENT authoritative values rather
 * than applying a receipt's old snapshot. Host must invalidate settings-store's private
 * proxy cache as well as its broad store cache. Never return the patch to HTTP callers. */
export function createSystemCacheAdapter({identity,patchStoreCache,invalidateProxySettings,publishSystemEvent}) {
 need(identity?.repo && typeof patchStoreCache==='function' && typeof invalidateProxySettings==='function' && typeof publishSystemEvent==='function','SYSTEM_CACHE_ADAPTER_REQUIRED',503);
 return async change=>{
  const repo=identity.repo;
  const settings=change.settings?repo.scalar('settings'):undefined;
  const users=change.identity?repo.all('users'):undefined,roles=change.identity?repo.all('permissionRoles'):undefined;
  await patchStoreCache(cache=>{
   if(settings!==undefined)cache.settings=settings;
   if(users!==undefined)cache.users=users;
   if(roles!==undefined)cache.permissionRoles=roles;
  });
  if(change.settings)await invalidateProxySettings();
  await publishSystemEvent({type:'system.changed',area:change.area,operationId:change.operationId,clearClientCache:true});
 };
}
