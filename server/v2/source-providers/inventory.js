import { issueObservation, inventoryScope, observationMaxAge } from './projection.js';
import { requireFact, digest, fault, safeError } from './transport.js';
const money = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1e9;
const integer = v => Number.isSafeInteger(v) && v >= 0;
const currency = value => { const values=[value?.currency,value?.currencyCode,value?.currency_code].filter(x=>x!==undefined&&x!==null);return values.length && new Set(values).size===1 ? values[0] : null; };
const usd = (...values) => values.some(v=>currency(v)==='USD') && values.every(v=>['currency','currencyCode','currency_code'].every(k=>v?.[k]===undefined||v?.[k]===null||v[k]==='USD'));
const checkIdentity = (value, id) => { for (const key of ['steamId','steamID','steamid','steam_id']) if(value?.[key] !== undefined) requireFact(value[key] === id); };
function time(value, now) { if(value === undefined || value === null) return null; requireFact(typeof value==='string' && Number.isFinite(Date.parse(value)) && Date.parse(value)<=now+60000);return new Date(value).toISOString(); }
/** SCMM profile quotes / Rusthelp aggregate. No name-based entitlement inference, aggregate apportioning or price-zero fallback. */
export function createInventoryEnrichment({ transport, readConfiguration, readEntitlements, now=Date.now }={}) {
  requireFact(typeof readConfiguration==='function','SOURCE_NOT_CONFIGURED');
  const config = () => {try {const c=readConfiguration();requireFact(!c?.then,'SOURCE_CONFIG_SYNC_REQUIRED');requireFact(c?.enabled===true && (typeof c.revision==='string' && c.revision.length>0 && c.revision.length<=160 || Number.isSafeInteger(c.revision) && c.revision>=0),'SOURCE_NOT_CONFIGURED');return structuredClone(c);}catch(e){throw safeError(e);}};
  const enrichment = async (original, options={}) => {
    const input=structuredClone(original), binding=digest(input), start=config(), configBinding=digest(start), id=input.steamId, inventory=input.inventory;
    requireFact(/^7656119\d{10}$/.test(id) && inventory && Array.isArray(inventory.skins) && inventory.skins.length<=2000 && Array.isArray(inventory.dlcs) && inventory.dlcs.length<=40);
    checkIdentity(inventory,id);
    requireFact(new Set(inventory.skins.map(x=>x.id)).size===inventory.skins.length && inventory.skins.every(x=>/^\d+$/.test(x.id) && typeof x.name==='string' && x.name.length<=240 && integer(x.quantity) && x.quantity>0 && x.quantity<=100000));
    const scopes=inventoryScope(inventory),sourceBindings=new Map(),sourceRevisions=new Map(),maxAgeMs=observationMaxAge(start.observationMaxAgeMs),entitlementMaxAgeMs=Math.min(3600000,Math.max(1000,start.entitlementMaxAgeMs||300000));
    const checkCurrent = () => {requireFact(digest(config())===configBinding && digest(original)===binding,'CREDENTIALS_CHANGED');for(const [source,binding] of sourceBindings)requireFact(transport.binding(source)===binding,'CREDENTIALS_CHANGED');};
    const check = () => { requireFact(!options.signal?.aborted,'SOURCE_TIMEOUT'); checkCurrent(); };
    check(); const out={prices:[],entitlements:[],summary:null,evidence:{steamId:id,appId:252490,contextId:2,currency:'USD',revision:start.revision,binding:configBinding,scope:scopes.scope,scopeHash:scopes.scopeHash,sources:{},cached:false}};
    const read = async (source,path,query) => {
      check(); let session;
      try {
        session=transport?.open(source,{signal:options.signal});
        if(session){requireFact(!sourceBindings.has(source)||sourceBindings.get(source)===session.binding,'CREDENTIALS_CHANGED');sourceBindings.set(source,session.binding);sourceRevisions.set(source,session.revision);}
        // Compatibility hook is safe only when the host itself applies the source-specific USD constants.
        const raw=session ? await session.json(path,{query}) : (requireFact(typeof options.request==='function','SOURCE_NOT_CONFIGURED'), await options.request(source,path,{query,currency:'USD'}));
        check(); checkIdentity(raw,id); checkIdentity(raw?.data,id);
        return {raw,observedAt:new Date(now()).toISOString(),sourceObservedAt:time(raw?.observedAt ?? raw?.updatedAt ?? raw?.data?.observedAt,now()),...(session?{transportBinding:session.binding}:{})};
      }finally{await session?.close();}
    };
    const recordError=(source,e)=>{check();const error=safeError(e);if(['RATE_LIMITED','SOURCE_TIMEOUT','CREDENTIALS_CHANGED','SOURCE_REDIRECT_REJECTED'].includes(error.errorCode))throw error;out.evidence.sources[source]={status:'unavailable',observedAt:null,error:error.errorCode};};
    const quantities=inventory.skins.reduce((n,x)=>n+x.quantity,0);
    let valueRecord;
    if(inventory.inventoryAvailable===true && start.prices!==false){
      // SCMM's reads are cached. The summary binds the owner and the actual
      // import time; a successful fetch must not turn an old inventory fresh.
      let snapshot;
      try {
        const r=await read('scmm',`/api/inventory/${id}/summary`);
        requireFact(r.raw?.steamId===id);
        const sourceObservedAt=time(r.raw.lastUpdatedInventoryOn,now());
        requireFact(sourceObservedAt && Date.parse(sourceObservedAt)<=now() && now()-Date.parse(sourceObservedAt)<=maxAgeMs,'SOURCE_EVIDENCE_EXPIRED');
        snapshot={sourceObservedAt};
        out.evidence.sources.scmmSummary={status:'observed',observedAt:r.observedAt,sourceObservedAt};
      }catch(e){recordError('scmmSummary',e);}
      if(snapshot){
        try {
          const byName=new Map(), pageSize=500, maxItems=2000;
          let total=null, received=0, observedAt=null, sourceObservedAt=snapshot.sourceObservedAt;
          for(let page=1;page<=maxItems/pageSize;page++){
            const r=await read('scmm',`/api/inventory/${id}`,{currency:'USD',market:'steam',includeUnpriced:true,page,pageSize}),raw=r.raw;
            requireFact(raw && Array.isArray(raw.items) && raw.page===page && raw.pageSize===pageSize && integer(raw.total) && typeof raw.hasMore==='boolean');
            requireFact(raw.total<=maxItems && raw.items.length<=pageSize,'SOURCE_PAGE_LIMIT');
            requireFact(total===null||raw.total===total);total=raw.total;
            requireFact(raw.items.length===Math.min(pageSize,Math.max(0,total-received)) && raw.hasMore===(received+raw.items.length<total));
            observedAt ||= r.observedAt;
            if(r.sourceObservedAt){requireFact(Date.parse(r.sourceObservedAt)<=now(),'SOURCE_EVIDENCE_EXPIRED');if(r.sourceObservedAt<sourceObservedAt)sourceObservedAt=r.sourceObservedAt;}
            for(const row of raw.items){
              checkIdentity(row,id);
              // Inventory rows currently expose name; the catalogue uses nameHash.
              const name=row?.nameHash??row?.name;
              requireFact(typeof name==='string' && name.length>0 && name.length<=240 && integer(row.quantity) && row.quantity>0 && row.quantity<=100000);
              const quoted=usd(row,raw) && integer(row.marketPrice) && money(row.marketPrice),prior=byName.get(name);
              if(prior){prior.priced=prior.priced&&quoted&&prior.price===row.marketPrice;prior.quantity+=row.quantity;}
              else byName.set(name,{price:row.marketPrice,quantity:row.quantity,priced:quoted});
            }
            received+=raw.items.length;
            if(!raw.hasMore)break;
          }
          requireFact(received===total,'SOURCE_PAGE_LIMIT');
          requireFact(Date.parse(sourceObservedAt)<=now() && now()-Date.parse(sourceObservedAt)<=maxAgeMs,'SOURCE_EVIDENCE_EXPIRED');
          const owned=new Map();for(const skin of inventory.skins)owned.set(skin.name,(owned.get(skin.name)||0)+skin.quantity);
          for(const skin of inventory.skins){const quote=byName.get(skin.name);if(!quote?.priced||quote.quantity!==owned.get(skin.name))continue;
            // marketPrice is the per-unit value in integer hundredths, never the stack total.
            out.prices.push({id:skin.id,price:quote.price/100,currency:'USD',evidence:{source:'scmm-profile-items',steamId:id,appId:252490,contextId:2,assetId:skin.id,itemName:skin.name,quantity:skin.quantity,unitPrice:quote.price/100,currency:'USD',scopeHash:scopes.scopeHash,binding:configBinding,observedAt,sourceObservedAt,revision:start.revision}});
          }
          out.evidence.sources.scmmItems={status:out.prices.length===inventory.skins.length?'observed':'partial',observedAt,sourceObservedAt,pricedItems:out.prices.length};
        }catch(e){recordError('scmmItems',e);}
        try {
          const r=await read('scmm',`/api/inventory/${id}/value`,{currency:'USD',market:'steam'});
          requireFact(r.raw && typeof r.raw==='object');
          if(r.sourceObservedAt)requireFact(Date.parse(r.sourceObservedAt)<=now(),'SOURCE_EVIDENCE_EXPIRED');
          const sourceObservedAt=r.sourceObservedAt && r.sourceObservedAt<snapshot.sourceObservedAt?r.sourceObservedAt:snapshot.sourceObservedAt;
          requireFact(Date.parse(sourceObservedAt)<=now() && now()-Date.parse(sourceObservedAt)<=maxAgeMs,'SOURCE_EVIDENCE_EXPIRED');
          if(usd(r.raw) && integer(r.raw.totalValue) && money(r.raw.totalValue) && integer(r.raw.itemCount) && r.raw.itemCount===quantities) valueRecord={currency:'USD',totalValue:r.raw.totalValue/100,totalItems:r.raw.itemCount,source:'scmm-profile-value',observedAt:r.observedAt,sourceObservedAt};
          out.evidence.sources.scmmValue={status:valueRecord?'observed':'unknown',observedAt:r.observedAt,sourceObservedAt};
        }catch(e){recordError('scmmValue',e);}
      }
      if(!valueRecord && start.rusthelp!==false){
        try {
          const r=await read('rusthelp',`/v1/inventory/summary/${id}`), data=r.raw?.data;
          requireFact(data&&typeof data==='object');
          if(usd(data,r.raw) && money(data.totalValue) && integer(data.totalItems) && data.totalItems===quantities) valueRecord={currency:'USD',totalValue:data.totalValue,totalItems:data.totalItems,source:'rusthelp-summary',observedAt:r.observedAt,sourceObservedAt:r.sourceObservedAt};
          out.evidence.sources.rusthelp={status:valueRecord?'observed':'unknown',observedAt:r.observedAt,sourceObservedAt:r.sourceObservedAt};
        }catch(e){recordError('rusthelp',e);}
      }
      if(valueRecord) out.summary={...valueRecord,steamId:id,appId:252490,contextId:2,scopeHash:digest(out.evidence.scope),binding:configBinding,revision:start.revision};
    }
    if(inventory.dlcs.length && start.entitlements===true && typeof readEntitlements==='function'){
      try {
        const appids=inventory.dlcs.map(d=>d.appid);requireFact(appids.every(integer)&&new Set(appids).size===appids.length);
        const r=await readEntitlements({steamId:id,appids:[...appids]},{signal:options.signal,revision:start.revision,binding:configBinding});check();
        requireFact(r?.steamId===id && r.revision===start.revision && ['steam-license','trusted-license-ledger'].includes(r.authority));
        const observedAt=time(r.observedAt,now());requireFact(observedAt && now()-Date.parse(observedAt)<=Math.min(3600000,Math.max(1000,start.entitlementMaxAgeMs||300000)));
        requireFact(Array.isArray(r.appids)&&r.appids.length===appids.length&&new Set(r.appids).size===appids.length&&r.appids.every(a=>appids.includes(a)));
        requireFact(Array.isArray(r.entitlements)&&r.entitlements.length<=appids.length&&new Set(r.entitlements.map(e=>e.appid)).size===r.entitlements.length);
        requireFact(r.entitlements.every(e=>appids.includes(e.appid)&&typeof e.owned==='boolean'&&typeof e.evidenceId==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(e.evidenceId)));
        out.entitlements=r.entitlements.map(e=>({...e,evidence:{steamId:id,authority:r.authority,observedAt,revision:r.revision,binding:configBinding}}));
        out.evidence.sources.entitlements={status:r.entitlements.length===appids.length?'observed':'partial',observedAt,authority:r.authority};
      }catch(e){recordError('entitlements',e);}
    }else out.evidence.sources.entitlements={status:'not_configured',observedAt:null};
    check();return issueObservation(out,{kind:'inventory_enrichment',context:{steamId:id,binding:configBinding,revision:start.revision,scopeHash:scopes.scopeHash,maxAgeMs,entitlementMaxAgeMs,sourceBindings:Object.fromEntries([...sourceBindings].map(([source,binding])=>[source,{binding,revision:sourceRevisions.get(source)}]))},checkCurrent,now});
  };
  Object.defineProperty(enrichment,'requiresProviderProjection',{value:true});return enrichment;
}
