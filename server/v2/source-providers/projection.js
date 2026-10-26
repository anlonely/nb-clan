import { createHash } from 'node:crypto';
import { need, text } from '../stats/model.js';
import { mooseCatalog } from '../management-adapters/source-host/moose-catalog.js';
const observations = new WeakMap();
export const PROVIDER_PROJECTION = 1;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const same = (a,b) => hash(a) === hash(b);
const revision = v => typeof v === 'string' && v.length > 0 && v.length <= 160 || Number.isSafeInteger(v) && v >= 0;
export function inventoryScope(inventory) {
  need(Array.isArray(inventory?.skins) && inventory.skins.length <= 2000, 'SOURCE_INVALID_DATA', 503);
  const ids = new Set();
  const scope = inventory.skins.map(i => {
    need(i && typeof i.id === 'string' && /^\d{1,30}$/.test(i.id) && !ids.has(i.id) && typeof i.name === 'string' && i.name.length <= 240 && Number.isSafeInteger(i.quantity) && i.quantity > 0 && i.quantity <= 100000, 'SOURCE_INVALID_DATA', 503); ids.add(i.id);
    return { id:i.id, name:i.name, quantity:i.quantity };
  }).sort((a,b)=>a.id.localeCompare(b.id,'en'));
  return { scope, scopeHash:hash(scope), totalItems:scope.reduce((sum,i)=>sum+i.quantity,0) };
}
export function observationTime(value, now, maxAgeMs=300000) {
  const n = typeof value === 'string' ? Date.parse(value) : NaN;
  need(Number.isFinite(n) && n <= now && n >= now-maxAgeMs, 'SOURCE_EVIDENCE_EXPIRED', 503);
  return new Date(n).toISOString();
}
export function observationMaxAge(value) {
  need(value === undefined || Number.isSafeInteger(value) && value >= 1000 && value <= 1800000, 'SOURCE_INVALID_DATA',503);
  return value ?? 300000;
}
/** Process-local provenance only, never serialized. A clone is not proof; its enumerable marker still requires verification. */
export function issueObservation(raw, {kind, context, checkCurrent=()=>{}, now=Date.now}) {
  raw.providerProjection=PROVIDER_PROJECTION;
  observations.set(raw,{kind,context:structuredClone(context),checkCurrent,now,digest:hash(raw)});
  return raw;
}
export function inspectObservation(raw,kind,expectedSteamId,now=Date.now()) {
  const proof=raw && observations.get(raw);
  need(raw?.providerProjection===PROVIDER_PROJECTION && proof?.kind===kind && hash(raw)===proof.digest,'SOURCE_EVIDENCE_UNVERIFIED',503);
  need(!expectedSteamId || proof.context.steamId===expectedSteamId,'SOURCE_IDENTITY_MISMATCH',503);
  proof.checkCurrent();
  return proof;
}
export const requiresProjection = (reader,raw) => reader?.requiresProviderProjection===true || raw?.providerProjection!==undefined;
function common(raw,proof,id,scope,now) {
  const e=raw.evidence,c=proof.context;
  need(e?.steamId===id && e.appId===252490 && e.contextId===2 && e.currency==='USD' && e.binding===c.binding && e.revision===c.revision && revision(e.revision) && /^[a-f0-9]{64}$/.test(e.binding), 'SOURCE_EVIDENCE_UNVERIFIED',503);
  need(same(e.scope,scope.scope) && e.scopeHash===scope.scopeHash && c.scopeHash===scope.scopeHash,'SOURCE_EVIDENCE_UNVERIFIED',503);
  return {version:1,trust:'observed',steamId:id,appId:252490,contextId:2,scopeHash:scope.scopeHash,binding:e.binding,revision:e.revision,currency:'USD'};
}
function provenance(e,context,now) {
  const observedAt=observationTime(e.observedAt,now,context.maxAgeMs);
  const sourceObservedAt=e.sourceObservedAt==null?null:observationTime(e.sourceObservedAt,now,context.maxAgeMs);
  return {observedAt,sourceObservedAt,expiresAt:new Date(Math.min(Date.parse(observedAt),sourceObservedAt?Date.parse(sourceObservedAt):Infinity)+context.maxAgeMs).toISOString()};
}
/** Validate all values before touching the host's inventory result. No partial mutation on invalid evidence. */
export function projectInventoryEnrichment(raw,{steamId,inventory,now=Date.now()}) {
  const proof=inspectObservation(raw,'inventory_enrichment',steamId,now),scope=inventoryScope(inventory),metadata=common(raw,proof,steamId,scope,now),c=proof.context;
  metadata.inventoryObservedAt=observationTime(inventory.inventoryObservedAt,now,c.maxAgeMs);
  metadata.transportBindings=structuredClone(c.sourceBindings||{});
  need(Array.isArray(raw.prices) && raw.prices.length<=scope.scope.length && Array.isArray(raw.entitlements) && raw.entitlements.length<=40,'SOURCE_INVALID_DATA',503);
  const prices=[],seen=new Set(),items=new Map(scope.scope.map(i=>[i.id,i]));
  for(const p of raw.prices){
    const i=items.get(p.id),e=p.evidence;
    need(inventory.inventoryAvailable===true && inventory.inventoryComplete!==false && i && !seen.has(p.id) && finite(p.price) && p.currency==='USD','SOURCE_EVIDENCE_UNVERIFIED',503);seen.add(p.id);
    need(e?.source==='scmm-profile-items' && e.steamId===steamId && e.appId===252490 && e.contextId===2 && e.assetId===i.id && e.itemName===i.name && e.quantity===i.quantity && e.unitPrice===p.price && e.currency===p.currency && e.scopeHash===scope.scopeHash && e.binding===c.binding && e.revision===c.revision,'SOURCE_EVIDENCE_UNVERIFIED',503);
    const time=provenance(e,c,now);prices.push({id:p.id,price:p.price,currency:'USD',evidence:{sourceId:e.source,...time}});
  }
  let aggregate=null;
  if(raw.summary!==null && raw.summary!==undefined){
    const s=raw.summary;
    need(inventory.inventoryAvailable===true && inventory.inventoryComplete!==false && s.steamId===steamId && s.appId===252490 && s.contextId===2 && s.scopeHash===scope.scopeHash && s.binding===c.binding && s.revision===c.revision && s.currency==='USD' && s.totalItems===scope.totalItems && finite(s.totalValue) && s.totalValue<=1e12 && ['scmm-profile-value','rusthelp-summary'].includes(s.source),'SOURCE_EVIDENCE_UNVERIFIED',503);
    aggregate={kind:'aggregate',sourceId:s.source,currency:'USD',totalValue:s.totalValue,totalItems:s.totalItems,...provenance(s,c,now)};
  }
  let totalSummary={currency:null,totalValue:null},valuation={kind:'unknown',sourceId:null,observedAt:null,sourceObservedAt:null,expiresAt:null};
  if(scope.scope.length>0 && prices.length===scope.scope.length){
    const value=prices.reduce((sum,p)=>sum+p.price*items.get(p.id).quantity,0);need(finite(value)&&value<=1e12,'SOURCE_INVALID_DATA',503);
    totalSummary={currency:'USD',totalValue:value};
    valuation={kind:'item_prices',sourceId:'scmm-profile-items',observedAt:prices.map(p=>p.evidence.observedAt).sort()[0],sourceObservedAt:prices.every(p=>p.evidence.sourceObservedAt)?prices.map(p=>p.evidence.sourceObservedAt).sort()[0]:null,expiresAt:prices.map(p=>p.evidence.expiresAt).sort()[0]};
  }else if(aggregate){totalSummary={currency:aggregate.currency,totalValue:aggregate.totalValue};valuation={kind:'aggregate',sourceId:aggregate.sourceId,observedAt:aggregate.observedAt,sourceObservedAt:aggregate.sourceObservedAt,expiresAt:aggregate.expiresAt};}
  const dlcs=new Map((inventory.dlcs||[]).map(i=>[i.appid,i])),entitlements=[],apps=new Set();
  for(const item of raw.entitlements){const e=item.evidence;
    need(dlcs.has(item.appid)&&!apps.has(item.appid)&&typeof item.owned==='boolean'&&typeof item.evidenceId==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(item.evidenceId),'SOURCE_EVIDENCE_UNVERIFIED',503);apps.add(item.appid);
    need(e?.steamId===steamId&&e.revision===c.revision&&e.binding===c.binding&&['steam-license','trusted-license-ledger'].includes(e.authority),'SOURCE_EVIDENCE_UNVERIFIED',503);
    entitlements.push({appid:item.appid,owned:item.owned,evidenceId:item.evidenceId,evidence:{sourceId:e.authority,observedAt:observationTime(e.observedAt,now,c.entitlementMaxAgeMs),revision:e.revision}});
  }
  const status=inventory.inventoryAvailable!==true?'private':valuation.kind==='unknown'?'partial':prices.length===scope.scope.length?'complete':'partial';
  return {prices,entitlements,totalSummary,proof,providerEvidence:{...metadata,status,valuation,aggregate,pricedItems:prices.length,inventoryItems:scope.scope.length,totalItems:scope.totalItems}};
}
export function sealInventoryHost(result,proof) { return issueObservation(result,{...proof,kind:'inventory_host'}); }
function safeItem(i,category,modern){
  return { ...(category==='skins'?{id:typeof i.id==='string'?i.id:null}:{}),name:text(i.name,240),quantity:category==='dlc'?(i.owned===true?1:i.owned===false?0:null):(finite(i.quantity)?i.quantity:null),
    price:category==='dlc'?(finite(i.price?.final)?i.price.final:null):(finite(i.price)?i.price:null),currency:category==='dlc'?(typeof i.price?.currency==='string'?i.price.currency:null):(typeof i.currency==='string'?i.currency:null),
    tradable:typeof i.tradable==='boolean'?i.tradable:false,category,dlc:category==='dlc',...(modern&&i.priceEvidence?{priceEvidence:structuredClone(i.priceEvidence)}:{}),...(modern&&i.ownershipEvidence?{ownershipEvidence:structuredClone(i.ownershipEvidence)}:{})};
}
function projectedFresh(raw,proof,now){
  const metadata=raw.providerEvidence;
  observationTime(metadata?.inventoryObservedAt,now,proof.context.maxAgeMs);
  if(metadata?.valuation?.expiresAt)need(Date.parse(metadata.valuation.expiresAt)>=now,'SOURCE_EVIDENCE_EXPIRED',503);
  if(metadata?.aggregate?.expiresAt)need(Date.parse(metadata.aggregate.expiresAt)>=now,'SOURCE_EVIDENCE_EXPIRED',503);
  for(const item of raw.inventory?.items||[...(raw.skins||[]),...(raw.dlcs||[])]){
    if(item.priceEvidence)need(Date.parse(item.priceEvidence.expiresAt)>=now,'SOURCE_EVIDENCE_EXPIRED',503);
    if(item.ownershipEvidence)observationTime(item.ownershipEvidence.observedAt,now,proof.context.entitlementMaxAgeMs);
  }
}
export function projectInventoryQuery(raw,id,now=Date.now(),profile=null) {
  const modern=requiresProjection(null,raw),proof=modern?inspectObservation(raw,'inventory_host',id,now):null;
  if(proof)projectedFresh(raw,proof,now);
  const evidence=modern?structuredClone(raw.providerEvidence):{version:1,trust:'legacy_unverified'};
  const partial=Boolean(raw.errors?.length)||modern&&(evidence.status!=='complete'||raw.dlcOwnershipAvailable===false)||raw.dlcOwnershipAvailable===false;
  const state=raw.inventoryAvailable===false?'private':partial?'partial':'fresh';
  const result={steamId:id,status:state,providerEvidence:evidence,
    ...(profile?{displayName:profile.name,steamProfile:profile}:{}),
    ...(modern&&evidence.valuation.observedAt?{fetchedAt:evidence.valuation.observedAt}:{}),
    inventory:{status:raw.inventoryAvailable===false?'private':partial?'partial':'fresh',currency:raw.totalSummary?.currency||(modern?null:'USD'),total:finite(raw.totalSummary?.totalValue)?raw.totalSummary.totalValue:null,
      items:[...(raw.skins||[]).map(i=>safeItem(i,'skins',modern)),...(raw.dlcs||[]).map(i=>safeItem(i,'dlc',modern)),...(raw.storeCatalog||[]).map(i=>safeItem(i,'store',modern))]},
    errors:[...(raw.inventoryAvailable===false?[{sourceId:'inventory',errorCode:'INVENTORY_PRIVATE_OR_UNAVAILABLE'}]:[]),...(raw.errors||[])]};
  return modern?issueObservation(result,{...proof,kind:'inventory_query'}):result;
}
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
function categories(input){const catalog=mooseCatalog().categories.map(c=>c.id);need(Array.isArray(input)&&input.length<=12,'SOURCE_INVALID_DATA',503);need(input.every(id=>id==='all'||catalog.includes(id)),'SOURCE_INVALID_DATA',503);return !input.length||input.includes('all')?catalog:[...new Set(input)].sort();}
export function projectMooseQuery(raw,input,now=Date.now()) {
  const proof=inspectObservation(raw,'moose_player',input.steamId,now),c=proof.context,e=raw.evidence;
  need(raw.identity?.steamId===input.steamId && raw.server?.id===input.serverId && c.serverId===input.serverId && c.requestedPeriod===clean(input.providerWipeId) && same([...c.categoryIds].sort(),[...categories(input.categoryIds||[])].sort()),'SOURCE_EVIDENCE_UNVERIFIED',503);
  need(e?.source==='moose' && e.binding===c.binding && e.revision===c.revision && revision(e.revision) && e.steamId===input.steamId && e.serverId===input.serverId && e.period===raw.period?.name && same(e.categoryIds,c.categoryIds),'SOURCE_EVIDENCE_UNVERIFIED',503);
  const observedAt=observationTime(e.observedAt,now,c.maxAgeMs),list=raw.categories;
  need(Array.isArray(list)&&list.length===c.categoryIds.length&&new Set(list.map(i=>i.category?.id)).size===list.length&&list.every(i=>c.categoryIds.includes(i.category?.id)),'SOURCE_EVIDENCE_UNVERIFIED',503);
  const fields=[];let matched=0;
  for(const row of list){need(Array.isArray(row.fields)&&row.fields.length<=64,'SOURCE_INVALID_DATA',503);const match=row.selectedMatch;need(!match||match.steamId===input.steamId,'SOURCE_IDENTITY_MISMATCH',503);if(match)matched++;
    for(const f of row.fields){const value=match?.values?.[f.id]??null;need(value===null||typeof value==='string'&&value.length<=500||typeof value==='number'&&Number.isFinite(value),'SOURCE_INVALID_DATA',503);fields.push({name:text(`${row.category.name||row.category.id} · ${f.labelZh||f.label||f.id}`,120),value,status:match?'observed':'not_found'});}
  }
  const truncated=fields.length>200;
  const result={steamId:input.steamId,displayName:text(raw.identity.playerName,120),serverId:input.serverId,providerWipeId:input.providerWipeId,status:matched===list.length&&!truncated?'fresh':matched?'partial':'unavailable',fetchedAt:observedAt,rows:[],fields:fields.slice(0,200),
    providerEvidence:{version:1,trust:'observed',sourceId:'moose',steamId:input.steamId,serverId:input.serverId,periodId:text(raw.period.id,120),periodName:text(raw.period.name,120),categoryIds:[...c.categoryIds],binding:e.binding,revision:e.revision,observedAt,expiresAt:new Date(Date.parse(observedAt)+c.maxAgeMs).toISOString(),quality:matched===list.length&&!truncated?'complete':matched?'partial':'unknown',fieldCount:fields.length,truncatedFields:truncated}};
  return issueObservation(result,{...proof,kind:'moose_query'});
}
/** Root service seam: apply ONLY after its existing permission checks and normal closed projection. */
export function finalizeProviderQuery(raw,result,sourceId,now=Date.now()) {
  if(!['inventory','moose'].includes(sourceId))return result;
  if(!requiresProjection(null,raw)){return {...result,providerEvidence:{version:1,trust:'legacy_unverified'}};}
  const proof=inspectObservation(raw,`${sourceId}_query`,result.steamId,now),e=raw.providerEvidence;
  if(sourceId==='moose')observationTime(e.observedAt,now,proof.context.maxAgeMs);
  else projectedFresh(raw,proof,now);
  const projected={...result,providerEvidence:structuredClone(e)};
  if(sourceId==='inventory')projected.inventory={...result.inventory,items:result.inventory.items.map((item,index)=>{
    const original=raw.inventory.items[index];need(original && item.quantity===original.quantity && item.price===original.price,'SOURCE_EVIDENCE_UNVERIFIED',503);
    return {...item,...(original.id?{id:original.id}:{}),currency:original.currency||null,...(original.priceEvidence?{priceEvidence:structuredClone(original.priceEvidence)}:{}),...(original.ownershipEvidence?{ownershipEvidence:structuredClone(original.ownershipEvidence)}:{})};})};
  if(sourceId==='inventory'&&result.inventory.truncated){
    projected.status=projected.status==='private'?'private':'partial';
    projected.inventory.status=projected.inventory.status==='private'?'private':'partial';
    projected.providerEvidence.status=projected.providerEvidence.status==='private'?'private':'partial';
    projected.providerEvidence.truncatedItems=true;
  }
  return projected;
}
