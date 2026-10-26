import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { installIdentitySchema,IdentityRepository } from '../../../server/v2/identity/repository.js';
import { applyIdentityMigration,planIdentityMigration } from '../../../server/v2/identity/migration.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { seedIdentities,controlledProviders } from '../v2-member-space/fixtures.mjs';
import { grant,authorize } from '../../../server/v2/identity/permissions.js';
import { installSyncCenterSchema } from '../../../server/v2/sync-center/repository.js';
import { SyncCenterService } from '../../../server/v2/sync-center/service.js';
import { createSqliteSyncAuthority } from '../../../server/v2/sync-center/authority.js';
import { createSyncCenterWorker } from '../../../server/v2/sync-center/worker.js';
import { TYPES,need,hash } from '../../../server/v2/sync-center/model.js';
export function fixture({filename=':memory:',now=Date.now,origin='http://127.0.0.1:4337'}={}){
  if(filename!==':memory:'&&existsSync(filename))throw new Error('New isolated SQLite required');
  const db=new DatabaseSync(filename);installIdentitySchema(db);const repo=new IdentityRepository(db);applyIdentityMigration(repo,planIdentityMigration({}));seedIdentities(repo);
  // Match the current owner-granted administrator contract in an isolated fixture.
  const admin=repo.get('accounts','g05_account_admin');repo.put('accounts',{...admin,adminAssignedByOwner:true});
  const controlled=controlledProviders(origin),identity=new IdentityService(repo,{now,providers:controlled.providers,eligibilityTtl:86400000});
  const leader=repo.get('accounts','g05_account_leader');leader.grants.push(...['sync.read','sync.run'].map(c=>grant(c,{type:'squads',ids:['g05_squad']})));repo.put('accounts',leader);
  // Fixture's existing authority is the G03 member collection, not a second member database.
  db.prepare("INSERT INTO json_records(collection,id,payload_json,hash,position,updated_at) VALUES('v2Wipes',?,?,?,?,?)").run('fixture-wipe',JSON.stringify({id:'fixture-wipe',lifecycle:'active',musterAt:new Date(now()).toISOString(),audience:{squadIds:['g05_squad'],memberIds:[],includeUnassigned:false}}),'fixture',0,new Date(now()).toISOString());
  installSyncCenterSchema(db);const commits=[],cache=new Map();let tail=Promise.resolve();
  const serializeWrite=fn=>{const p=tail.then(fn);tail=p.catch(()=>{});return p;};
  const applyResult=({actor,type,memberId,result,operationId,assertCurrent})=>{assertCurrent();authorize(actor,'sync.run',{kind:'member',id:memberId},identity.relations());const receipt=db.prepare("SELECT payload FROM sync_center_records WHERE kind='fixture-receipt' AND id=?").get(operationId);if(receipt)return;const m=repo.get('members',memberId);need(m,'RESOURCE_NOT_FOUND',404);m.syncEvidence={...m.syncEvidence,[type]:{source:TYPES[type],observedAt:now(),receivedAt:now(),lastSuccessAt:now(),quality:'verified_fixture',revision:(m.syncEvidence?.[type]?.revision||0)+1}};if(type==='battlemetrics_identity')m.battlemetricsId=result.battlemetricsId;m.revision=(m.revision||1)+1;repo.put('members',m);db.prepare('INSERT INTO sync_center_records VALUES(?,?,?,?,?,?)').run('fixture-receipt',operationId,'','',now(),JSON.stringify({memberId,type}));commits.push(operationId);};
  const confirmBattlemetricsCandidate=({actor,memberId,candidate,expectedMemberRevision,operationId,assertCurrent})=>{assertCurrent();authorize(actor,'members.basic_edit',{kind:'member',id:memberId},identity.relations());const m=repo.get('members',memberId);need(m.revision===expectedMemberRevision,'REVISION_CONFLICT',409,{revision:m.revision});applyResult({actor,memberId,type:'battlemetrics_identity',result:{battlemetricsId:candidate.battlemetricsId},operationId,assertCurrent});};
  const authority=createSqliteSyncAuthority({identity,isMissing:({member,type})=>!member.syncEvidence?.[type]?.lastSuccessAt,serializeWrite:fn=>serializeWrite(()=>{const r=fn();for(const m of repo.all('members'))cache.set(m.id,m);return r;}),applyResult,confirmBattlemetricsCandidate,readCoverage:({type,scope,targets})=>{const ms=targets.map(t=>repo.get('members',t.memberId));const es=ms.map(m=>m.syncEvidence?.[type]).filter(Boolean);const latest=es.sort((a,b)=>b.lastSuccessAt-a.lastSuccessAt)[0];return {source:TYPES[type],scope,observedAt:latest?.observedAt||null,receivedAt:latest?.receivedAt||null,lastSuccessAt:latest?.lastSuccessAt||null,coverage:{total:ms.length,matched:es.length,missing:ms.length-es.length,conflicted:0,stale:es.filter(e=>now()-e.lastSuccessAt>3600000).length},quality:es.length?'partial':'unknown',revision:es.reduce((n,e)=>n+e.revision,0),lastError:null};}});
  const service=new SyncCenterService({db,identity,authority,now}),outcomes=new Map(),calls=[];
  const providers=Object.fromEntries(Object.keys(TYPES).map(type=>[type,async args=>{calls.push({type,memberId:args.memberId,operationId:args.operationId});const q=outcomes.get(`${type}:${args.memberId}`)||outcomes.get(type);if(q?.length){const r=q.shift();return typeof r==='function'?r(args):r;}
    if(type==='battlemetrics_playtime'&&!repo.get('members',args.memberId).battlemetricsId)return {outcome:'skipped',reason:'MISSING_IDENTITY'};
    return {outcome:'success',data:{battlemetricsId:repo.get('members',args.memberId).battlemetricsId||String(parseInt(hash(args.memberId).slice(0,10),16)),value:0},observedAt:now()};}]));
  const worker=createSyncCenterWorker(service,{providers});
  return {db,repo,identity,controlled,authority,service,worker,providers,outcomes,calls,commits,cache,actor:(key='admin')=>identity.actorForAccount(`g05_account_${key}`),async drain(limit=50){for(let i=0;i<limit;i++){if(!await worker.step())break;}},async close(){await worker.stop();db.close();}};
}
