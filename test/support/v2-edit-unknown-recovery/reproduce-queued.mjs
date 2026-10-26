import '../results.mjs';
// Run against the preserved first candidate to reproduce its persisted-queue deadlock.
import {fixture} from './fixture.mjs';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,chmodSync} from 'node:fs';
import assert from 'node:assert/strict';
const f=await fixture();try{
 const ids=await f.prepare({queueWhileWaiting:true});assert.equal(ids.queuedWhileStatus,'running');
 const op=(await f.request('/deliveries/'+ids.deliveryId)).data.messageOperations.find(o=>o.id===ids.editId),count=f.calls.length;
 await f.worker.runOnce({workerId:'queued-repro',limit:10});const follower=f.notifications.repo.get('messageOperations',ids.queuedEditId);assert.equal(follower.status,'queued');assert.equal(follower.attemptCount,0);assert.equal(f.calls.length,count);
 const result=await f.request('/message-operations/'+op.id+'/commands/reconcile',{method:'POST',body:{expectedRevision:op.revision,expectedExecutionEpoch:op.executionEpoch,expectedStateFingerprint:op.stateFingerprint,messageRefId:op.messageRefId,expectedReferenceFingerprint:op.referenceFingerprint,expectedPayloadHash:op.payloadHash,decision:'confirmed_updated',reason:'复现持久队列互锁',evidence:'原消息已通过本地 GET 核实目标内容；后续编辑从未领取执行。'}});assert.equal(result.error?.errorCode,'EDIT_REFERENCE_BUSY');
 const evidence={reproduced:true,source:'original queueMessageOperation called while original native edit awaited loopback reply; persisted unknown + unclaimed queued afterwards',ids,unknownStatus:op.status,queuedStatus:follower.status,queuedAttemptCount:follower.attemptCount,workerPlatformCalls:0,reconcileStatus:result.status,errorCode:result.error.errorCode,firstCandidateEditRecoverySha256:createHash('sha256').update(readFileSync('server/v2/notifications/edit-recovery.js')).digest('hex')};writeFileSync('output/test-results/g08-edit-unknown/queued-deadlock-reproduced.json',JSON.stringify(evidence,null,2)+'\n',{mode:0o644});chmodSync('output/test-results/g08-edit-unknown/queued-deadlock-reproduced.json',0o644);console.log(JSON.stringify(evidence));
}finally{await f.close();}
