import '../results.mjs';
import {spawn} from 'node:child_process';import {randomUUID} from 'node:crypto';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {candidateConfig,candidateEnvironment} from '../../../server/v2/candidate-host/config.js';
const root=fileURLToPath(new URL('../../../',import.meta.url)),runtime=path.join(root,'test/support/v2-candidate-providers-vip/.runtime'),tree=root,mode=process.argv[2]||'provider-enabled';
fs.mkdirSync(path.join(root,'test/support/v2-candidate-providers-vip/.runtime'),{recursive:true});
const config=candidateConfig({dataDirectory:path.join(runtime,'nb-v2-candidate-'+randomUUID()),port:0,intervalMs:mode==='vip-auto-tick'?1000:60000});
async function invoke(childMode){
 const script=childMode.startsWith('migration')?'migration-probe.mjs':childMode.startsWith('vip')?'vip-probe.mjs':'provider-probe.mjs';
 const child=spawn(process.execPath,['--import',path.join(tree,'test/support/v2-stats/resolve.mjs'),path.join(tree,'test/support/v2-candidate-providers-vip',script),JSON.stringify(config),childMode],{cwd:tree,env:candidateEnvironment(config,{searchPath:process.env.PATH}),stdio:['ignore','pipe','pipe']});
 let stdout='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.pipe(process.stderr);const timer=setTimeout(()=>child.kill('SIGKILL'),90000);const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',code=>{clearTimeout(timer);r(code??1);});});if(code)throw Error('Candidate probe failed: '+childMode+' exit '+code);return JSON.parse(stdout);
}
try{
 let report;
 if(mode==='vip-restart'){const before=await invoke('vip-restart-prepare'),after=await invoke('vip-restart-reopen');if(JSON.stringify(before.deliveries.map(d=>d.id))!==JSON.stringify(after.deliveries.map(d=>d.id)))throw Error('Restart changed delivery identity');report={...after,mode,restart:{freshProcesses:2,sameDeliveryIds:true,beforeNativeSends:before.calls.length,afterNativeSends:after.calls.length,beforeChecks:before.checks}};}
 else report=await invoke(mode);
 fs.writeFileSync(path.join(root,'output/test-results/g07-candidate-providers-vip',mode+'-verification.json'),JSON.stringify(report,null,2)+'\n');
}catch(error){console.error(error.message);process.exitCode=1;}
