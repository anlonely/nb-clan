import { TYPES,need,supportedType } from './model.js';
/** Integration supplies reviewed read-only collectors. Never pass legacy whole-job functions here. */
export function createSyncSourceAdapters(collectors={}) {
  return Object.fromEntries(Object.keys(TYPES).filter(supportedType).map(type=>[type,async request=>{
    const collector=collectors[type];need(typeof collector==='function','SYNC_SOURCE_SETUP_REQUIRED',503);
    if(request.signal.aborted)throw Object.assign(new Error('Aborted'),{errorCode:'SOURCE_TIMEOUT'});
    const response=await collector(request);
    need(response&&['success','failed','skipped','retry','common_failure','conflict'].includes(response.outcome),'SYNC_PROVIDER_RESULT_INVALID',503);
    if(request.signal.aborted)throw Object.assign(new Error('Aborted'),{errorCode:'SOURCE_TIMEOUT'});
    return response;
  }]));
}
