import {need} from './config.js';
/** Track native promises themselves, including when an owner's timeout wins a race. */
export function trackCandidatePorts(bindings){
  const pending=new Set();let accepting=true;
  const methods=(target,keys)=>{
    if(!target)return target;const result={...target};
    for(const key of keys)if(typeof target[key]==='function')result[key]=function(...args){
      need(accepting,'CANDIDATE_ADAPTER_STOPPED');const value=target[key].apply(target,args);
      if(value?.then){const work=Promise.resolve(value);pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work));}
      return value;
    };
    return result;
  };
  const liveMethods=(target,keys)=>{const wrapped=methods(target,keys);for(const key of Object.keys(target))if(!keys.includes(key))Object.defineProperty(wrapped,key,{enumerable:true,get:()=>target[key]});return wrapped;};
  const native={...bindings};
  if(bindings.hexQuery)native.hexQuery=liveMethods(bindings.hexQuery,['readConfig','readPrincipal','readChannelProof','readMessages']);
  if(bindings.adminExtras)native.adminExtras=methods(bindings.adminExtras,['readCatalog']);
  if(bindings.platformMetadata)native.platformMetadata=methods(bindings.platformMetadata,['metadata','registerCommands']);
  if(bindings.providers)native.providers=liveMethods(bindings.providers,['readConfiguration','readInventoryConfiguration','readEntitlements','fetchImpl','proxyFetch','proxyWebSocket']);
  if(bindings.vipNotifications)native.vipNotifications=liveMethods(bindings.vipNotifications,['readSourceConfig','readDmTarget']);
  if(bindings.wechat)native.wechat={...methods(bindings.wechat,['exchangeCode']),...(bindings.wechat.media?{media:methods(bindings.wechat.media,['fetchAvatar','getAccessToken','exchangeCode'])}:{})};
  if(bindings.notifications)native.notifications={...bindings.notifications,
    transport:methods(bindings.notifications.transport,['request','respondPrivate']),verifiers:methods(bindings.notifications.verifiers,['discord','kook'])};
  if(bindings.platforms){const p=bindings.platforms;native.platforms={...p,
    ...(p.community?{community:Object.fromEntries(Object.entries(p.community).map(([name,value])=>[name,methods(value,['verify'])]))}:{}),
    ...(p.forwarding?{forwarding:{...methods(p.forwarding,['translate']),source:methods(p.forwarding.source,['read','reset'])}}:{})};}
  return {bindings:native,get active(){return pending.size;},async drain(timeoutMs){
    accepting=false;const until=Date.now()+timeoutMs;
    while(pending.size){need(Date.now()<until,'CANDIDATE_NATIVE_IO_DRAIN_TIMEOUT');await new Promise(r=>setTimeout(r,5));}
  }};
}
