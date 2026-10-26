import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateCollection,readNativeCredentials} from '../server/v2/management-adapters/source-policy/model.js';
import {createCanonicalSourcePolicy} from '../server/v2/management-adapters/source-policy/index.js';
import {validateBindings} from '../server/v2/candidate-host/bindings.js';
const root=fileURLToPath(new URL('../',import.meta.url));
for(const value of [{enabled:true},{enabled:true,principal:{accountId:'root'}},{enabled:true,principal:{accountId:'user_root',permissionVersion:0}},{enabled:false,actor:{id:'user_root'}},{enabled:false,discord:{targetId:'first'}}])test('reject implicit or incomplete authority '+JSON.stringify(value),()=>assert.throws(()=>validateCollection(value)));
test('construction has no readers, schema installation, credentials or worker effects',()=>{let calls=0;const unexpected=()=>{calls++;throw Error('unexpected read');};const p=createCanonicalSourcePolicy({identity:{repo:{db:{},scalar:unexpected}},getSystem:unexpected,readControl:unexpected,sourceBindings:{readCredentials:unexpected}});assert.equal(calls,0);assert.equal(typeof p.readPolicy,'function');assert.equal(p.start,undefined);});
test('trusted credentials are synchronous, whitelisted and never accept env-shaped options',()=>{for(const reader of [()=>Promise.resolve({}),()=>({NB_STEAM_API_KEY:'hidden'}),()=>({steamApiKey:'bad\nkey'})])assert.throws(()=>readNativeCredentials(reader));assert.deepEqual(readNativeCredentials(()=>({steamApiKey:'controlled'})),{steamApiKey:'controlled'});});
test('candidate permits original risk capabilities but rejects retired review bindings',()=>{assert.doesNotThrow(()=>validateBindings({collection:{enabled:false},sources:{capabilities:{memberRisk:true,steam:true,steamRisk:true,inventory:true,inventoryEnrichment:true,storeCatalog:true,dlcCatalog:true},readCredentials:()=>({})}}));for(const b of [{memberReview:{readWechatProof:{verified:true}}},{memberReview:{proof:{verified:true}}},{sources:{readSettings:()=>({})}},{collection:{enabled:true,principal:{accountId:'collector',permissionVersion:1},readPolicy:()=>({ready:true})}}])assert.throws(()=>validateBindings(b));});
for(const mode of ['migration','enabled','disabled','missing','paused','capability-drift','all-five','risk','key-drift','adapter-key-drift','rules-drift','control-drift','principal-drift','discord','discord-drift','discord-selection','discord-archive-drift','principal-version-drift','wipe-drift'])test('isolated original HTTP canonical sources: '+mode,{timeout:40000},async()=>{
  const child=spawn(process.execPath,['test/support/v2-canonical-sources/run-probe.mjs',mode],{cwd:root,env:{...process.env,NB_DATA_DIR:'/must-not-inherit',NB_ROOT_PASSWORD:'synthetic-must-not-inherit',NB_DISCORD_BOT_TOKEN:'synthetic-must-not-inherit',HTTPS_PROXY:'http://127.0.0.1:9'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});assert.equal(code,0,output);
  const report=JSON.parse(await fs.readFile(path.join(root,'output/test-results/g07-canonical-sources',mode+'-verification.json'),'utf8'));assert.ok(report.checks.length>=(mode==='migration'?3:5));assert.equal(report.realPlatformAcceptance,false);assert.equal(report.observations.forbiddenAttempts,0);assert.equal(report.observations.externalNetworkAttempts,0);if(mode!=='migration')assert.notEqual(report.principalId,report.eventActor);
  if(mode==='principal-drift'){assert.equal(report.rootWorkerRevocationFixVerified,true);}
});
