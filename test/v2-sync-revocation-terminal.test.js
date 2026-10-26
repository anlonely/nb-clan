import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-sync-center/fixture.mjs';
import { createSyncCenterWorker } from '../server/v2/sync-center/worker.js';
for (const reason of ['disabled','admin-demoted']) test(`in-flight ${reason} ends owned job without writing source results`, async t => {
  const f = fixture();
  let start, release; const started = new Promise(r=>start=r), blocked = new Promise(r=>release=r);
  const worker = createSyncCenterWorker(f.service,{providers:{kda:async()=>{start();await blocked;return {outcome:'success',data:{}};}}});
  t.after(async()=>{await worker.stop();await f.close();}); const actor=f.actor();
  const {job}=await f.service.request(actor,{type:'kda',scope:{kind:'members',memberIds:['g05_alpha']}},{operationId:randomUUID()});
  const before=JSON.stringify(f.identity.repo.get('members','g05_alpha')); const running=worker.step(); await started;
  const account=f.identity.repo.get('accounts',actor.id);
  f.identity.repo.put('accounts',{...account,...(reason==='disabled'?{status:'disabled'}:{roleId:'member',adminAssignedByOwner:false,grants:[]})});release();
  const result=await running;assert.equal(result.status,'cancelled',JSON.stringify({result,job:f.service.repo.get('job',job.id)}));
  const final=f.service.repo.get('job',job.id);assert.equal(final.status,'cancelled');assert.equal(final.reason,'AUTHORIZATION_REVOKED');assert.equal(final.owner,null);assert.equal(final.leaseUntil,0);
  assert.equal(JSON.stringify(f.identity.repo.get('members','g05_alpha')),before);
});
