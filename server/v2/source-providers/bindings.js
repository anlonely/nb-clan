import { requireFact, digest, safeError } from './transport.js';
const sources=['moose','scmm','rusthelp','inventory'];
function ordered(value) {
  if(Array.isArray(value)) return value.map(ordered);
  if(value && typeof value==='object') {requireFact(Object.getPrototypeOf(value)===Object.prototype);return Object.fromEntries(Object.keys(value).sort().filter(k=>value[k]!==undefined).map(k=>[k,ordered(value[k])]));}
  requireFact(value===null||['string','boolean','number'].includes(typeof value));requireFact(typeof value!=='number'||Number.isFinite(value));return value;
}
/** Feed this SAME function to SourceHost.readProviderBindings. Configuration and ledger changes must enter these snapshots. */
export function createProviderBindings({readConfiguration,readInventoryConfiguration=()=>readConfiguration('inventory')}={}) {
  requireFact(typeof readConfiguration==='function'&&typeof readInventoryConfiguration==='function','SOURCE_NOT_CONFIGURED');
  return () => {
    try {
      return Object.fromEntries(sources.map(source=>{
        const raw=(source==='inventory'?readInventoryConfiguration():readConfiguration(source)) ?? {enabled:false,revision:null};
        requireFact(raw && !raw.then && typeof raw==='object' && !Array.isArray(raw),'SOURCE_CONFIG_SYNC_REQUIRED');
        const canonical=ordered(raw);requireFact(JSON.stringify(canonical).length<=8192,'SOURCE_INVALID_DATA');
        const revision=typeof raw.revision==='string'&&raw.revision.length<=160||Number.isSafeInteger(raw.revision)?raw.revision:null;
        return [source,{enabled:raw.enabled===true,revision,binding:digest({providerVersion:1,source,configuration:canonical})}];
      }));
    } catch(e) { throw safeError(e); }
  };
}
