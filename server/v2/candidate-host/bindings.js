import {validateHex} from './hex.js';
import {validateProviders,validateVip} from './external-bindings.js';
import {validateWechat} from './wechat.js';
import {need} from './config.js';
import {validateCollection} from '../management-adapters/source-policy/model.js';
const fields=(v,keys)=>need(v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k)),'CANDIDATE_BINDINGS_INVALID',422);
export function validateBindings(value={}){
  fields(value,['notifications','sources','platforms','vault','realtime','collection','wechat','providers','vipNotifications','hexQuery','adminExtras','platformMetadata']);
  validateCollection(value.collection);
  validateHex(value.hexQuery);
  need(!value.hexQuery||!value.sources?.readHexCard,'CANDIDATE_HEX_OWNER_AMBIGUOUS',422);
  need(!value.hexQuery?.enabled||value.notifications,'CANDIDATE_HEX_NOTIFICATION_TRANSPORT_REQUIRED',422);
  if(value.adminExtras){fields(value.adminExtras,['readCatalog']);need(typeof value.adminExtras.readCatalog==='function','CANDIDATE_CATALOG_READER_REQUIRED',422);}
  if(value.platformMetadata){fields(value.platformMetadata,['metadata','registerCommands']);need(Object.keys(value.platformMetadata).length>0&&Object.values(value.platformMetadata).every(v=>typeof v==='function'),'CANDIDATE_METADATA_BINDING_INVALID',422);}
  validateWechat(value.wechat);
  validateProviders(value.providers);validateVip(value.vipNotifications);
  need(!(value.providers?.capabilities?.moose&&value.sources?.mooseEngine)&&!(value.providers?.capabilities?.inventory&&value.sources?.inventoryEnrichment),'CANDIDATE_PROVIDER_OWNER_AMBIGUOUS',422);
  if(value.notifications){const n=value.notifications;fields(n,['transport','verifiers','transportKey']);
    need(n.transport?.runtimeMode==='isolated'&&['request','respondPrivate'].every(k=>typeof n.transport[k]==='function')&&['discord','kook'].every(k=>typeof n.verifiers?.[k]==='function')&&typeof n.transportKey==='function','CANDIDATE_NOTIFICATION_BINDINGS_INVALID',422);}
  if(value.sources){const s=value.sources;fields(s,['fetchImpl','proxyFetch','readCredentials','capabilities','readHexCard','mooseEngine','memberLookup','inventoryEnrichment','timeoutMs','maxBytes','maxActive']);
    fields(s.capabilities||{},['steam','battlemetrics','vital','hexaytron','moose','scmm','rusthelp','discordMembershipAudit','kookMemberSync','memberRisk','steamRisk','inventory','inventoryEnrichment','storeCatalog','dlcCatalog']);
    need(Object.values(s.capabilities||{}).every(v=>typeof v==='boolean'),'CANDIDATE_BINDINGS_INVALID',422);
    for(const k of ['fetchImpl','proxyFetch','readCredentials','readHexCard','mooseEngine','memberLookup','inventoryEnrichment'])need(s[k]===undefined||typeof s[k]==='function','CANDIDATE_BINDINGS_INVALID',422);
    for(const [k,min,max]of [['timeoutMs',20,120000],['maxBytes',128,8*1024*1024],['maxActive',1,100]])need(s[k]===undefined||Number.isInteger(s[k])&&s[k]>=min&&s[k]<=max,'CANDIDATE_BINDINGS_INVALID',422);
  }
  if(value.platforms)fields(value.platforms,['community','forwarding']);
  if(value.vault)need(typeof value.vault.writeSync==='function','CANDIDATE_VAULT_BINDING_INVALID',422);
  if(value.realtime){fields(value.realtime,['sourceReset']);need(typeof value.realtime.sourceReset==='function','CANDIDATE_BINDINGS_INVALID',422);}
  return value;
}
