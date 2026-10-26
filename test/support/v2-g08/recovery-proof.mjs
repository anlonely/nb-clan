import assert from 'node:assert/strict';
import {api} from './host.mjs';
import {configureSteam,syncJob,waitJob} from './recovery.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const held=async backend=>{for(let n=0;n<100;n++){if((await backend.control('native-state')).held)return;await sleep(50);}throw Error('G08 native hold not reached');};
export async function recoveryProof(backend){
  await configureSteam(backend);await backend.control('phase',{phase:'held'});
  const memberId='fixture_member_50',job=await syncJob(backend,[memberId]);await held(backend);
  const before=await backend.control('facts',{memberId,jobId:job.id});assert.equal(before.receipts.length,0);
  await configureSteam(backend,{paused:true});const expired=await backend.control('lease-expire',{jobId:job.id});await backend.control('release-native');
  await sleep(1200);const late=await backend.control('facts',{memberId,jobId:job.id});assert.deepEqual(late,before,'Lost executor changed current facts');
  await configureSteam(backend);const recovered=await waitJob(backend,job.id);assert.equal(recovered.status,'succeeded');
  const committed=await backend.control('facts',{memberId,jobId:job.id});assert.equal(committed.receipts.length,1);assert.equal(committed.member.revision,before.member.revision+1);
  assert.ok(recovered.diagnostics.generation>expired.generation);assert.equal(recovered.items[0].status,'succeeded');
  // Independent CAS fault: retain the live lease and change the member after
  // provider input capture. A generation fence cannot mask this assertion.
  const casMember='fixture_member_51';await backend.control('phase',{phase:'held'});const casJob=await syncJob(backend,[casMember]);await held(backend);
  await backend.control('member-revision',{memberId:casMember});const edited=await backend.control('facts',{memberId:casMember,jobId:casJob.id});
  await backend.control('release-native');const failed=await waitJob(backend,casJob.id);assert.equal(failed.status,'failed');
  const afterCAS=await backend.control('facts',{memberId:casMember,jobId:casJob.id});assert.deepEqual(afterCAS,edited,'Stale provider response overwrote a current member');
  return {lease:{jobId:job.id,memberId,expiredGeneration:expired.generation,before,afterLate:late,afterCommit:committed,job:recovered},cas:{jobId:casJob.id,memberId:casMember,beforeRelease:edited,after:afterCAS,job:failed}};
}
