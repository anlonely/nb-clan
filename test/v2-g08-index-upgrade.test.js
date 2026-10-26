import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {candidateConfig,candidateEnvironment} from '../server/v2/candidate-host/config.js';
test('old candidate is rejected until an explicit authorized index-only upgrade preserves business facts',async()=>{
  await fs.mkdir(path.resolve('work/v2-g08'),{recursive:true});
  const config=candidateConfig({dataDirectory:path.resolve('work/v2-g08/nb-v2-candidate-index-'+randomUUID()),port:0});
  const child=spawn(process.execPath,['--import','./test/support/v2-stats/resolve.mjs','test/support/v2-g08/verify-index-upgrade.mjs',JSON.stringify(config)],{env:candidateEnvironment(config,{searchPath:process.env.PATH}),stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});assert.equal(code,0,err+'\n'+out);
  const result=JSON.parse(out.trim().split('\n').at(-1));await fs.writeFile('output/test-results/g08/index-upgrade.json',JSON.stringify(result,null,2)+'\n');
});
