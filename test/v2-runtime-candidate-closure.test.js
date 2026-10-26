import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {candidateConfig,candidateEnvironment} from '../server/v2/candidate-host/config.js';
import {createCandidateHost} from '../server/v2/candidate-host/index.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const config=(intervalMs=1000)=>candidateConfig({dataDirectory:path.join(root,'test/support/v2-runtime-candidate-closure/.runtime/nb-v2-candidate-'+randomUUID()),port:0,intervalMs,shutdownGraceMs:1000});
test('active Hex requires trusted complete readers and notification transport',()=>{const c=config();for(const bindings of [{hexQuery:{enabled:true}},{hexQuery:{enabled:true,readConfig(){},readPrincipal(){},readChannelProof(){},readMessages(){}}},{hexQuery:{enabled:false},sources:{readHexCard(){}}},{platformMetadata:{metadata:()=>{},actor:'root'}}])assert.throws(()=>createCandidateHost(c,{bindings}));assert.doesNotThrow(()=>createCandidateHost(c,{bindings:{hexQuery:{enabled:false}}}));});
for(const mode of ['off','active'])test('original candidate closure: '+mode,{timeout:45000},async()=>{
 const c=config(mode==='active'?60000:1000);await fs.mkdir(path.dirname(c.dataDirectory),{recursive:true});
 const child=spawn(process.execPath,['--import',path.join(root,'test/support/v2-stats/resolve.mjs'),path.join(root,'test/support/v2-runtime-candidate-closure/verify.mjs'),mode,JSON.stringify(c)],{cwd:root,env:candidateEnvironment(c,{searchPath:process.env.PATH}),stdio:['ignore','pipe','pipe']});
 let output='',error='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>error+=d);const timer=setTimeout(()=>child.kill('SIGKILL'),40000);const status=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});clearTimeout(timer);assert.equal(status,0,error+'\n'+output);const report=JSON.parse(output.trim().split('\n').at(-1));assert.equal(report.state,'stopped');assert.equal(report.observations.forbiddenAttempts,0);await fs.writeFile(path.join(root,'output/test-results/g07-runtime-candidate-closure',mode+'-verification.json'),JSON.stringify(report,null,2)+'\n');
});
