import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {candidateConfig,paths,need,assertEnvironment,checkDirectory,noSymlinks} from '../../../server/v2/candidate-host/config.js';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,createCandidateHost} from '../../../server/v2/candidate-host/index.js';
export async function run(action,config,args=[]){
  assertEnvironment(config);
  if(action==='init'){
    let secret='';for await(const chunk of process.stdin){secret+=chunk;need(secret.length<=130,'CANDIDATE_ROOT_PASSWORD_REQUIRED',422);}secret=secret.replace(/\r?\n$/,'');
    console.log(JSON.stringify(await initializeCandidate(config,{rootPassword:secret})));return;
  }
  if(action==='plan'){
    const plan=await planCandidateMigration(config);await fs.writeFile(path.join(paths(config).control,`plan-${plan.digest}.json`),JSON.stringify(plan),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({digest:plan.digest,review:plan.review,identityAlreadyApplied:plan.identityAlreadyApplied}));return;
  }
  if(action==='apply'){
    const [expectedDigest,operatorId]=args;need(/^[a-f0-9]{64}$/.test(expectedDigest),'CANDIDATE_PLAN_REQUIRED',422);
    await checkDirectory(config);const file=path.join(paths(config).control,`plan-${expectedDigest}.json`);await noSymlinks(file);
    const stat=await fs.stat(file);need(stat.isFile()&&stat.size<=20*1024*1024&&(stat.mode&0o077)===0,'CANDIDATE_PLAN_REQUIRED',422);
    const plan=JSON.parse(await fs.readFile(file,'utf8'));
    try{console.log(JSON.stringify(await applyCandidateMigration(config,plan,{expectedDigest,operatorId})));}
    finally{const storage=await import('../../../server/storage/sqlite.js');await storage.closeSqliteDatabases();}return;
  }
  need(action==='serve','CANDIDATE_ACTION_INVALID',422);const host=createCandidateHost(config);
  let signal;const stopped=new Promise(resolve=>signal=resolve);process.once('SIGINT',signal);process.once('SIGTERM',signal);
  try{console.log(JSON.stringify(await host.start()));await stopped;}
  finally{console.log(JSON.stringify(await host.stop()));process.removeListener('SIGINT',signal);process.removeListener('SIGTERM',signal);}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  try{await run(process.argv[2],candidateConfig(JSON.parse(process.argv[3])),process.argv.slice(4));}
  catch(e){console.error(JSON.stringify({errorCode:/^[A-Z][A-Z0-9_]+$/.test(e.errorCode||'')?e.errorCode:'CANDIDATE_COMMAND_FAILED'}));process.exitCode=1;}
}
