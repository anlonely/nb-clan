import fs from 'node:fs';
import {createProviderTransport,createMooseEngine,createInventoryEnrichment,createProviderBindings} from '../source-providers/index.js';
import {need,digest} from './config.js';
import {fields,validateProviders} from './external-bindings.js';
const sync=value=>{need(!value?.then,'CANDIDATE_PROVIDER_SYNC_READER_REQUIRED');return value;};
const signature=stat=>({device:stat.dev,inode:stat.ino,size:stat.size,mtimeMs:stat.mtimeMs,mode:stat.mode});
/** Own the actual provider factories and their complete native lifetimes; never import legacy browsers. */
export function createCandidateProviders({binding,sources={},identity}){
 validateProviders(binding);need(identity?.repo?.db,'CANDIDATE_PROVIDER_IDENTITY_REQUIRED');
 const owned={...binding?.capabilities},admitted=Boolean(binding?.enabled&&binding.readConfiguration&&binding.fetchImpl),pending=new Set();
 let stopped=false,stopping,chromiumPin=null,chromiumReason='CANDIDATE_CHROMIUM_UNBOUND';
 if(admitted&&owned.moose&&binding.chromium){
  try{
   const c=binding.chromium;need(c.allowedExecutablePaths.includes(c.executablePath),'CANDIDATE_CHROMIUM_NOT_ALLOWED');
   need(fs.realpathSync(c.executablePath)===c.executablePath,'CANDIDATE_CHROMIUM_NOT_ALLOWED');
   const s=fs.lstatSync(c.executablePath);need(s.isFile()&&!s.isSymbolicLink()&&(s.mode&0o111)&&[0,process.getuid()].includes(s.uid),'CANDIDATE_CHROMIUM_NOT_ALLOWED');
   chromiumPin={path:c.executablePath,allowlist:[...c.allowedExecutablePaths],file:signature(s)};chromiumReason=null;
  }catch(e){chromiumReason=e.errorCode||'CANDIDATE_CHROMIUM_UNAVAILABLE';}
 }
 const available={moose:admitted&&owned.moose===true&&Boolean(chromiumPin),inventory:admitted&&owned.inventory===true&&typeof binding.readInventoryConfiguration==='function'};
 function current(){need(!stopped&&binding?.enabled===true&&digest(binding.capabilities||{})===digest(owned),'CREDENTIALS_CHANGED');}
 function chromium(){
  current();need(chromiumPin&&binding.chromium.executablePath===chromiumPin.path&&digest(binding.chromium.allowedExecutablePaths)===digest(chromiumPin.allowlist),'CREDENTIALS_CHANGED');
  try{need(fs.realpathSync(chromiumPin.path)===chromiumPin.path&&digest(signature(fs.lstatSync(chromiumPin.path)))===digest(chromiumPin.file),'CREDENTIALS_CHANGED');}catch{need(false,'CREDENTIALS_CHANGED');}
 }
 function readConfiguration(source){
  need(['moose','scmm','rusthelp'].includes(source),'SOURCE_NOT_CONFIGURED');
  if(!admitted||source==='moose'&&!available.moose||source!=='moose'&&!available.inventory)return {enabled:false,revision:0};
  current();if(source==='moose')chromium();
  const raw=sync(binding.readConfiguration(source,{identity,db:identity.repo.db}))||{enabled:false,revision:0};
  fields(raw,['enabled','revision','proxyUrl','binding']);need(typeof raw.enabled==='boolean','SOURCE_NOT_CONFIGURED');
  // This exact reader also feeds createProviderBindings; all transport-affecting facts participate.
  return {...raw,binding:digest({configuration:raw,capabilities:owned,chromium:source==='moose'?chromiumPin:null})};
 }
 function readInventoryConfiguration(){
  if(!available.inventory)return {enabled:false,revision:0};current();
  const raw=sync(binding.readInventoryConfiguration({identity,db:identity.repo.db}))||{enabled:false,revision:0};
  fields(raw,['enabled','revision','prices','rusthelp','entitlements','ledgerVersion','observationMaxAgeMs','entitlementMaxAgeMs']);need(typeof raw.enabled==='boolean','SOURCE_NOT_CONFIGURED');
  return {...raw,entitlements:raw.entitlements===true&&typeof binding.readEntitlements==='function',candidateEntitlementsReaderBound:typeof binding.readEntitlements==='function'};
 }
 const transport=admitted?createProviderTransport({readConfiguration,fetchImpl:binding.fetchImpl,proxyFetch:binding.proxyFetch,proxyWebSocket:binding.proxyWebSocket,...binding.limits,now:identity.now}):null;
 const readProviderBindings=binding?createProviderBindings({readConfiguration,readInventoryConfiguration}):undefined;
 const own=(fn,capability)=>{const call=(...args)=>{current();need(sources.capabilities?.[capability]===true,'SOURCE_NOT_CONFIGURED');const work=Promise.resolve().then(()=>fn(...args)).then(result=>{current();need(sources.capabilities?.[capability]===true,'CREDENTIALS_CHANGED');return result;});pending.add(work);work.then(()=>pending.delete(work),()=>pending.delete(work));return work;};Object.defineProperty(call,'requiresProviderProjection',{value:true});return call;};
 const mooseEngine=available.moose?own(createMooseEngine({transport,executablePath:chromiumPin.path}),'moose'):undefined;
 const inventoryEnrichment=available.inventory?own(createInventoryEnrichment({transport,readConfiguration:readInventoryConfiguration,readEntitlements:binding.readEntitlements,now:identity.now}),'inventoryEnrichment'):undefined;
 const capabilities={...sources.capabilities,...(owned.moose?{moose:available.moose&&sources.capabilities?.moose===true}:{}),...(owned.inventory?{inventoryEnrichment:available.inventory&&sources.capabilities?.inventoryEnrichment===true}:{})};
 const sourceOptions=binding?{...sources,capabilities,...(owned.moose?{mooseEngine}:{}),...(owned.inventory?{inventoryEnrichment}:{}),...(readProviderBindings?{readProviderBindings}:{})}:sources;
 if(binding)Object.defineProperty(sourceOptions,'capabilities',{enumerable:true,get:()=>({...sources.capabilities,...(owned.moose?{moose:available.moose&&sources.capabilities?.moose===true}:{}),...(owned.inventory?{inventoryEnrichment:available.inventory&&sources.capabilities?.inventoryEnrichment===true}:{})})});
 function diagnostics(){
  const state=source=>{try{const c=readConfiguration(source);need(c.enabled===true,'SOURCE_NOT_CONFIGURED');need(!c.proxyUrl||typeof binding?.proxyFetch==='function','PROXY_UNAVAILABLE');need(source!=='moose'||!c.proxyUrl||typeof binding?.proxyWebSocket==='function','PROXY_UNAVAILABLE');return {available:!stopped,reason:stopped?'CANDIDATE_PROVIDER_STOPPED':null};}catch(e){return {available:false,reason:e.errorCode||'SOURCE_NOT_CONFIGURED'};}};
  const native=Object.fromEntries(['moose','scmm','rusthelp'].map(source=>[source,state(source)]));let inventoryReady=false,inventoryReason=null;
  try{inventoryReady=readInventoryConfiguration().enabled===true;if(!inventoryReady)inventoryReason='SOURCE_NOT_CONFIGURED';}catch(e){inventoryReason=e.errorCode||'SOURCE_NOT_CONFIGURED';}
  return {bound:admitted,stopped,capabilities:{moose:{available:available.moose&&sourceOptions.capabilities?.moose===true&&native.moose.available,reason:!owned.moose?'CANDIDATE_PROVIDER_CAPABILITY_UNBOUND':!admitted?'CANDIDATE_PROVIDER_PORTS_UNBOUND':chromiumReason||native.moose.reason},inventory:{available:available.inventory&&sourceOptions.capabilities?.inventoryEnrichment===true&&inventoryReady&&!stopped,reason:!owned.inventory?'CANDIDATE_PROVIDER_CAPABILITY_UNBOUND':!available.inventory?'CANDIDATE_PROVIDER_PORTS_UNBOUND':inventoryReason}},nativeSources:native,entitlementReaderBound:typeof binding?.readEntitlements==='function',activeCalls:pending.size,activeSessions:transport?.active||0,realExternalProvidersVerified:false};
 }
 return {sourceOptions,readProviderBindings,diagnostics,async stop(){if(stopping)return stopping;stopped=true;return stopping=(async()=>{await transport?.stop();await Promise.allSettled([...pending]);need((transport?.active||0)===0&&pending.size===0,'CANDIDATE_PROVIDER_DRAIN_FAILED');})();}};
}
