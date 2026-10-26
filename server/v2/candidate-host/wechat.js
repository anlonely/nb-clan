import {createHash} from 'node:crypto';
import {IdentityError} from '../identity/errors.js';
const need=(ok,code,status=503)=>{if(!ok)throw new IdentityError(code,status);};
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fields=(v,keys)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)),'CANDIDATE_WECHAT_BINDINGS_INVALID',422);
const sync=v=>{need(!v?.then,'CANDIDATE_WECHAT_SYNC_READER_REQUIRED');return v;};
export function validateWechat(value){
  if(value===undefined)return;
  fields(value,['enabled','appId','configurationRevision','capabilities','exchangeCode','media']);
  need(typeof value.enabled==='boolean'&&typeof value.appId==='string'&&/^[A-Za-z0-9_-]{1,160}$/.test(value.appId)&&Number.isSafeInteger(value.configurationRevision)&&value.configurationRevision>0,'CANDIDATE_WECHAT_APP_PIN_REQUIRED',422);
  fields(value.capabilities||{},['mini','inbox','media']);need(Object.values(value.capabilities||{}).every(v=>typeof v==='boolean'),'CANDIDATE_WECHAT_BINDINGS_INVALID',422);
  need(value.exchangeCode===undefined||typeof value.exchangeCode==='function','CANDIDATE_WECHAT_EXCHANGE_PORT_REQUIRED',422);
  if(value.media){fields(value.media,['fetchAvatar','getAccessToken','exchangeCode']);for(const fn of Object.values(value.media))need(typeof fn==='function','CANDIDATE_WECHAT_MEDIA_PORT_REQUIRED',422);}
}
/** App pin and capability admission around the original owners; no identity/configuration/notification store. */
export function createCandidateWechat({binding,identity,getSystem}){
  validateWechat(binding);need(identity?.repo?.db&&typeof getSystem==='function','CANDIDATE_WECHAT_HOST_REQUIRED');
  const pin=binding?Object.freeze({appId:binding.appId,configurationRevision:binding.configurationRevision}):null;
  const admitted={...binding?.capabilities};
  const selected={mini:Boolean(binding?.enabled&&admitted.mini&&binding.exchangeCode),inbox:Boolean(binding?.enabled&&admitted.inbox),media:Boolean(binding?.enabled&&admitted.mini&&binding.exchangeCode&&admitted.media&&binding.media?.getAccessToken&&binding.media?.exchangeCode)};
  function system(){const s=getSystem();need(s?.identity===identity&&s.platforms?.service?.identity===identity&&s.platforms.service.repo.db===identity.repo.db,'CANDIDATE_WECHAT_OWNER_MISMATCH');return s;}
  function configuration(){
    need(pin&&binding.enabled===true,'CANDIDATE_WECHAT_DISABLED');
    need(binding.appId===pin.appId&&binding.configurationRevision===pin.configurationRevision&&hash(binding.capabilities||{})===hash(admitted),'CANDIDATE_WECHAT_BINDING_CHANGED');
    const c=sync(system().platforms.service.config('wechat'));
    need(c?.id==='wechat'&&c.appId===pin.appId,'CANDIDATE_WECHAT_APP_MISMATCH');
    need(c.enabled===true,'CANDIDATE_WECHAT_DISABLED');
    need(c.revision===pin.configurationRevision,'CANDIDATE_WECHAT_CONFIGURATION_CHANGED');return c;
  }
  function assertCapability(name){need(selected[name],'CANDIDATE_WECHAT_'+name.toUpperCase()+'_UNBOUND');return configuration();}
  const exchange=capability=>async args=>{assertCapability(capability);need(args?.appId===pin.appId&&typeof args.assertCurrent==='function','CANDIDATE_WECHAT_EXCHANGE_CONTEXT_REQUIRED');args.assertCurrent();
    const assertCurrent=()=>{assertCapability(capability);return args.assertCurrent();};
    const result=await binding.exchangeCode({...args,assertCurrent});assertCurrent();return result;};
  function mediaCall(method){return async(...args)=>{
    assertCapability('media');const context=method==='fetchAvatar'?args[1]:args[0];
    if(context?.appId!==undefined)need(context.appId===pin.appId,'CANDIDATE_WECHAT_APP_MISMATCH');
    const assertCurrent=()=>{assertCapability('media');need(!context?.signal?.aborted,'CANDIDATE_WECHAT_IO_CANCELLED');return context?.assertCurrent?.();};
    assertCurrent();const input={...context,assertCurrent};const result=await binding.media[method](...(method==='fetchAvatar'?[args[0],input]:[input]));assertCurrent();return result;
  };}
  function gate(path){
    const parts=/^\/v2\/(mini-program|member-inbox|platform-media)(?:\/|$)/.exec(path);if(!parts)return false;
    const cap={'mini-program':'mini','member-inbox':'inbox','platform-media':'media'}[parts[1]];assertCapability(cap);
    if(parts[1]==='mini-program'){
      const command=/^\/v2\/mini-program\/commands\/([^/]+)$/.exec(path)?.[1];
      if(['notifications','notification_settings','notification_settings_save','notification_read'].includes(command))assertCapability('inbox');
      if(['avatar','avatar_image','share_code'].includes(command))assertCapability('media');
    }
    return true;
  }
  function diagnostics(){let reason=null;try{configuration();}catch(e){reason=e.errorCode;}return {appId:pin?.appId||null,configurationRevision:pin?.configurationRevision||null,reason,capabilities:Object.fromEntries(Object.entries(selected).map(([key,value])=>[key,{available:value&&!reason,reason:value?reason:'CANDIDATE_WECHAT_'+key.toUpperCase()+'_UNBOUND'}])),realWechatAuthentication:false};}
  return {gate,diagnostics,configuration,assertCapability,
    miniOptions:pin?{appId:pin.appId,...(selected.mini?{exchangeCode:exchange('mini')}:{})}:undefined,
    inboxOptions:selected.inbox?{appId:pin.appId}:undefined,
    mediaOptions:selected.media?{appId:pin.appId,getAccessToken:mediaCall('getAccessToken'),exchangeCode:mediaCall('exchangeCode'),...(binding.media.fetchAvatar?{fetchAvatar:mediaCall('fetchAvatar')}:{})}:undefined};
}
