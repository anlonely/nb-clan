import {createHash} from 'node:crypto';
import {IdentityError} from '../../identity/errors.js';
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const need=(ok,code,status=503)=>{if(!ok)throw new IdentityError(code,status);};
export const fields=(value,keys)=>need(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(k=>keys.includes(k)),'CANONICAL_SOURCE_OPTIONS_INVALID',422);
const id=v=>typeof v==='string'&&v.length>0&&v.length<=160&&!/[\x00-\x20]/.test(v);
export function validateCollection(value){
  if(value===undefined)return;fields(value,['enabled','principal','discord']);need(typeof value.enabled==='boolean','CANONICAL_SOURCE_OPTIONS_INVALID',422);
  if(value.enabled||value.principal){fields(value.principal,['accountId','permissionVersion']);need(id(value.principal.accountId)&&Number.isSafeInteger(value.principal.permissionVersion)&&value.principal.permissionVersion>0,'CANONICAL_PRINCIPAL_REQUIRED',422);}
  if(value.discord){fields(value.discord,['targetId','configurationRevision','legacyRulesDigest']);need(id(value.discord.targetId)&&Number.isSafeInteger(value.discord.configurationRevision)&&value.discord.configurationRevision>0&&/^[a-f0-9]{64}$/.test(value.discord.legacyRulesDigest),'CANONICAL_DISCORD_BINDING_REQUIRED',422);}
}
export function readNativeCredentials(reader){
  if(!reader)return {};const value=reader();need(value&&!value.then,'CANONICAL_CREDENTIAL_READER_SYNC_REQUIRED');
  fields(value,['steamApiKey','battlemetricsApiKey','discordBotToken','kookBotToken','proxyUrl','kdaProxyUrl','battlemetricsProxyUrl','discordProxyUrl']);
  for(const v of Object.values(value))need(typeof v==='string'&&v.length<=4096&&!/[\x00-\x1f]/.test(v),'CANONICAL_CREDENTIAL_READER_INVALID');
  return value;
}
