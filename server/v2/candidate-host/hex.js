import {need} from './config.js';
import {configuration,sync} from '../hex-query/model.js';
const keys=['enabled','readConfig','readPrincipal','readChannelProof','readMessages'];
export function validateHex(binding){
  if(binding===undefined)return;
  need(binding&&typeof binding==='object'&&!Array.isArray(binding)&&Object.keys(binding).every(k=>keys.includes(k))&&typeof binding.enabled==='boolean','CANDIDATE_HEX_BINDINGS_INVALID',422);
  for(const key of keys.slice(1))need(binding[key]===undefined||typeof binding[key]==='function','CANDIDATE_HEX_BINDINGS_INVALID',422);
  if(binding.enabled)need(keys.slice(1).every(key=>typeof binding[key]==='function'),'CANDIDATE_HEX_READERS_REQUIRED',422);
}
/** Trusted current readers only. Original Hex domain validates G03, target and native proof. */
export function createCandidateHex({binding,notificationBinding,identity}){
  validateHex(binding);
  const bound=Boolean(binding&&notificationBinding&&keys.slice(1).every(key=>typeof binding[key]==='function'));
  const readConfig=()=>{
    validateHex(binding);
    if(!bound||binding.enabled!==true)return {enabled:false};
    return configuration(sync(binding.readConfig({identity,db:identity.repo.db})));
  };
  const principal=args=>sync(binding.readPrincipal({...args,identity,db:identity.repo.db}));
  return {bound,options:bound?{readConfig,readPrincipal:principal,
    readChannelProof:args=>sync(binding.readChannelProof({...args,identity,db:identity.repo.db})),
    readMessages:args=>{need(args.method==='GET'&&binding.enabled===true,'SOURCE_NOT_CONFIGURED');return binding.readMessages(args);}}:undefined,
    diagnostics:()=>({bound,enabled:bound&&binding.enabled===true,realExternalQueryVerified:false})};
}
