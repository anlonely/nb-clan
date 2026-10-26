import { can } from '../identity/permissions.js';
import { need } from './model.js';
const field = key => `json_extract(w.payload_json,'$.${key}')`;
const hint = key => `COALESCE(${['serverSnapshot.', '', 'legacyRaw.'].map(prefix => `NULLIF(trim(${field(prefix + key)}),'')`).join(',')},'')`;
const provider = `lower(COALESCE(${['serverSnapshot.provider', 'serverSnapshot.serverProvider', 'provider', 'serverProvider', 'legacyRaw.provider', 'legacyRaw.serverProvider'].map(key => `NULLIF(trim(${field(key)}),'')`).join(',')},''))`;
// Match statistics' explicit source precedence. Historical rows alone do not
// configure a live collector; missing bindings must remain visible setup errors.
const vitalCollection = `(${provider}='vital' OR ${provider}='' AND
  (lower(${hint('kdaProvider')})='vital' OR ${hint('kdaProvider')}='' AND ${hint('vitalServerId')}!=''))`;
/** Read-only SQLite authority. No GET calls legacy API functions with hidden scheduling/repair. */
export function createSqliteSyncAuthority({identity,serializeWrite,applyResult,confirmBattlemetricsCandidate,readCoverage,isMissing}) {
  const db=identity.repo.db;
  const records=(collection,limit=501)=>db.prepare('SELECT payload_json FROM json_records WHERE collection=? ORDER BY id LIMIT ?').all(collection,limit).map(r=>JSON.parse(r.payload_json));
  const get=(collection,id)=>{const r=db.prepare('SELECT payload_json FROM json_records WHERE collection=? AND id=?').get(collection,id);return r?JSON.parse(r.payload_json):null;};
  function resolveScope({actor,type,scope,limit=501}) {
    let selected=null,wipeId=scope.wipeId||null;
    if(scope.kind==='members'){need(Array.isArray(scope.memberIds)&&scope.memberIds.length<=500);selected=scope.memberIds.map(id=>get('members',id));need(selected.every(Boolean),'RESOURCE_NOT_FOUND',404);}
    if(scope.kind==='failed')need(false,'SYNC_USE_RETRY_COMMAND');
    if(scope.kind==='current_wipe'){
      let wipe=scope.id?get('v2Wipes',scope.id):null;
      if(!scope.id){
        const active=db.prepare(`SELECT w.payload_json FROM json_records w WHERE w.collection='v2Wipes'
          AND json_extract(w.payload_json,'$.lifecycle') IN ('active','scheduled')
          ${type==='kda'?`AND ${vitalCollection}`:''}
          ORDER BY json_extract(w.payload_json,'$.musterAt') LIMIT 2`).all().map(r=>JSON.parse(r.payload_json));
        need(active.length<=1,'SYNC_WIPE_SELECTION_REQUIRED',409);wipe=active[0];
      }
      need(wipe,'SYNC_WIPE_REQUIRED',409);wipeId=wipe.id;const a=wipe.audience||{};
      const rows=db.prepare(`SELECT m.payload_json FROM json_records m WHERE m.collection='members' AND (? OR m.id IN (SELECT value FROM json_each(?)) OR EXISTS(SELECT 1 FROM json_records s WHERE s.collection='squadMembers' AND json_extract(s.payload_json,'$.memberId')=m.id AND COALESCE(json_extract(s.payload_json,'$.validTo'),'')='' AND json_extract(s.payload_json,'$.squadId') IN (SELECT value FROM json_each(?))) OR (? AND NOT EXISTS(SELECT 1 FROM json_records s WHERE s.collection='squadMembers' AND json_extract(s.payload_json,'$.memberId')=m.id AND COALESCE(json_extract(s.payload_json,'$.validTo'),'')=''))) ORDER BY m.id LIMIT ?`).all(a.allMembers === true?1:0,JSON.stringify(a.memberIds||[]),JSON.stringify(a.squadIds||[]),a.includeUnassigned?1:0,limit);selected=rows.map(r=>JSON.parse(r.payload_json));
    }
    if(scope.kind==='squad'){need(scope.id);selected=db.prepare("SELECT m.payload_json FROM json_records m WHERE m.collection='members' AND EXISTS(SELECT 1 FROM json_records s WHERE s.collection='squadMembers' AND json_extract(s.payload_json,'$.memberId')=m.id AND json_extract(s.payload_json,'$.squadId')=? AND COALESCE(json_extract(s.payload_json,'$.validTo'),'')='') ORDER BY m.id LIMIT ?").all(scope.id,limit).map(r=>JSON.parse(r.payload_json));}
    if(!selected)selected=records('members',limit);
    const hasMore=selected.length>=limit;
    if(wipeId&&scope.kind!=='current_wipe'){const w=get('v2Wipes',wipeId);need(w,'RESOURCE_NOT_FOUND',404);const rel=identity.relations();for(const m of selected){const squads=rel.squadMembers.filter(s=>s.memberId===m.id&&!s.validTo).map(s=>s.squadId);need(w.audience?.allMembers === true||w.audience?.memberIds?.includes(m.id)||w.audience?.squadIds?.some(s=>squads.includes(s))||w.audience?.includeUnassigned&&!squads.length,'SYNC_SCOPE_MISMATCH',403);}}
    if(scope.kind==='missing_only'){need(typeof isMissing==='function','SYNC_COVERAGE_ADAPTER_REQUIRED',503);selected=selected.filter(member=>{const missing=isMissing({actor,type,scope,member});need(typeof missing==='boolean','SYNC_ADAPTER_ATOMICITY_REQUIRED',503);return missing;});}
    return {scope:{...scope,...(wipeId?{wipeId}:{})},targets:selected.map(m=>({memberId:m.id,label:m.displayName||m.customName||m.steamNickname||m.id})),hasMore};
  }
  return {resolveScope,serializeWrite,applyResult,confirmBattlemetricsCandidate,readCoverage:readCoverage||(()=>{need(false,'SYNC_COVERAGE_ADAPTER_REQUIRED',503);})};
}
