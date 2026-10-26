import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {candidateConfig,candidateEnvironment,paths,need,noSymlinks,checkDirectory} from '../../../server/v2/candidate-host/config.js';
const [action,directory,expectedDigest,operatorId]=process.argv.slice(2),config=candidateConfig({dataDirectory:directory,port:0});
need(['plan','apply','child-plan','child-apply'].includes(action),'CANDIDATE_INDEX_ACTION_INVALID',422);
if(!action.startsWith('child-')){
  const child=spawn(process.execPath,['--import',fileURLToPath(new URL('../v2-stats/resolve.mjs',import.meta.url)),fileURLToPath(import.meta.url),'child-'+action,directory,...(action==='apply'?[expectedDigest,operatorId]:[])],{stdio:'inherit',env:candidateEnvironment(config,{searchPath:process.env.PATH})});
  process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',c=>resolve(c??1));});
}else{
  const {planCandidatePerformanceIndexes,applyCandidatePerformanceIndexes}=await import('../../../server/v2/candidate-host/performance-indexes.js');
  if(action==='child-plan'){
    const plan=await planCandidatePerformanceIndexes(config),file=path.join(paths(config).control,'performance-indexes-'+plan.digest+'.json');
    await fs.writeFile(file,JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});console.log(JSON.stringify({file,digest:plan.digest,before:plan.before,required:plan.required}));
  }else{
    need(/^[a-f0-9]{64}$/.test(expectedDigest||''),'CANDIDATE_INDEX_PLAN_INVALID',422);await checkDirectory(config);
    const file=path.join(paths(config).control,'performance-indexes-'+expectedDigest+'.json');await noSymlinks(file);const stat=await fs.stat(file);
    need(stat.isFile()&&stat.size<32768&&(stat.mode&0o077)===0,'CANDIDATE_INDEX_PLAN_INVALID',422);
    console.log(JSON.stringify(await applyCandidatePerformanceIndexes(config,JSON.parse(await fs.readFile(file,'utf8')),{expectedDigest,operatorId})));
  }
}
