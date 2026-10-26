import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),runtime=path.join(root,'test/support/v2-candidate-host/.runtime');
test('actual launcher: init, review plan, digest apply, serve HTTP and signal drain in distinct clean children',{timeout:30000},async()=>{
  await fs.mkdir(runtime,{recursive:true});const directory=path.join(runtime,'nb-v2-candidate-cli-'+randomUUID());
  function child(action,args=[]){
    const proc=spawn(process.execPath,['--import',path.join(root,'test/support/v2-stats/resolve.mjs'),'--import',path.join(root,'test/support/v2-candidate-host/test-guard.mjs'),path.join(root,'test/support/v2-candidate-host/launch.mjs'),action,directory,'--port','0',...args],{cwd:root,env:{...process.env,NB_DISCORD_TOKEN:'synthetic-must-not-inherit',NB_DATA_DIR:'relative-unsafe-data'},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';proc.stdout.on('data',d=>stdout+=d);proc.stderr.on('data',d=>stderr+=d);
    const timer=setTimeout(()=>proc.kill('SIGKILL'),12000),done=new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('exit',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});});
    return {proc,done,output:()=>stdout};
  }
  const init=child('init');init.proc.stdin.end('Synthetic-CLI-Candidate-Password-2026\n');assert.equal((await init.done).code,0);
  const planned=child('plan');planned.proc.stdin.end();const observation=await planned.done;assert.equal(observation.code,0,observation.stderr);const p=JSON.parse(observation.stdout.trim());assert.match(p.digest,/^[a-f0-9]{64}$/);
  const applied=child('apply',['--digest',p.digest,'--operator','user_root']);applied.proc.stdin.end();const result=await applied.done;assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(result.stdout.trim()).g07FullAcceptance,false);
  const server=child('serve');server.proc.stdin.end();let ready;
  try{const until=Date.now()+8000;while(!ready){assert.ok(Date.now()<until,server.output());for(const line of server.output().trim().split('\n')){try{const status=JSON.parse(line);if(status.state==='ready')ready=status;}catch{}}if(!ready)await new Promise(r=>setTimeout(r,10));}
    assert.match(ready.origin,/^http:\/\/127\.0\.0\.1:\d+$/);const response=await fetch(ready.origin+'/api/v2/auth/me');assert.equal(response.status,401);
    for(const [action,args]of [['plan',[]],['apply',['--digest',p.digest,'--operator','user_root']],['serve',[]]]){const other=child(action,args);other.proc.stdin.end();const blocked=await other.done;assert.equal(blocked.code,1);assert.match(blocked.stderr,/CANDIDATE_IN_USE/);}
  }finally{server.proc.kill('SIGTERM');}
  const stopped=await server.done;assert.equal(stopped.code,0,stopped.stderr);const status=JSON.parse(stopped.stdout.trim().split('\n').at(-1));assert.equal(status.state,'stopped');assert.equal(status.events.at(-1),'shared-sqlite-closed');
  const after=child('plan');after.proc.stdin.end();assert.equal((await after.done).code,0);
  await fs.writeFile(path.join(root,'output/test-results/g07-candidate-host/cli-verification.json'),JSON.stringify({actions:['init','plan','apply','serve'],distinctCleanChildren:true,realOriginalHttpAuthRequired:true,parentContaminationRemoved:true,concurrentPlanApplyServeRejected:true,leaseReleasedAfterCleanStop:true,signalExitCode:stopped.code,stopEvents:status.events,g07FullAcceptance:false,externalAcceptance:false},null,2)+'\n');
});
