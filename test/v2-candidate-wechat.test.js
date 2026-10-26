import './support/results.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateBindings} from '../server/v2/candidate-host/bindings.js';
import {createCandidateWechat} from '../server/v2/candidate-host/wechat.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const binding=()=>({enabled:true,appId:'controlled_app',configurationRevision:1,capabilities:{mini:true,inbox:true},exchangeCode:async()=>null});
for(const [name,extra] of Object.entries({missingApp:{appId:''},noRevision:{configurationRevision:0},jsonProof:{exchangeCode:{verified:true}},fakeReader:{readConfig:()=>({enabled:true})},credentials:{appSecret:'forbidden'},claims:{verified:true},mediaProof:{media:{exchangeCode:{verified:true}}},reviewActor:{reviewNotifications:{enabled:true,actor:{id:'user_root'}}}}))test('candidate binding rejects '+name,()=>assert.throws(()=>validateBindings({wechat:{...binding(),...extra}})));
test('candidate rejects retired applicant proof owner',()=>{assert.throws(()=>validateBindings({wechat:binding(),memberReview:{readWechatProof:()=>({verified:true})}}),e=>e.errorCode==='CANDIDATE_BINDINGS_INVALID');assert.doesNotThrow(()=>validateBindings({wechat:binding()}));});
test('pure WeChat admission construction performs no I/O, reads or schema installation',()=>{let calls=0;const unexpected=()=>{calls++;throw Error('unexpected read');};const owner=createCandidateWechat({binding:binding(),identity:{repo:{db:{}}},getSystem:unexpected,getNotifications:unexpected});assert.equal(calls,0);assert.equal(typeof owner.gate,'function');assert.equal(owner.start,undefined);assert.equal(owner.reviewOptions,undefined);});
const modes=['migration-index','migration-marker','migration-version','mini-media','unbound','disabled','missing-exchange','missing-media-ports','wrong-proof-app','wrong-app-pin','wrong-revision-pin','config-drift','media-drift','exchange-config-drift','exchange-stop'];
for(const mode of modes)test('isolated original candidate WeChat HTTP: '+mode,{timeout:50000},async()=>{
 const child=spawn(process.execPath,['test/support/v2-candidate-wechat/run-probe.mjs',mode],{cwd:root,env:{...process.env,NB_DATA_DIR:'/must-not-inherit',NB_ROOT_PASSWORD:'synthetic-must-not-inherit',NB_WECHAT_APP_SECRET:'synthetic-must-not-inherit',HTTPS_PROXY:'http://127.0.0.1:9'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});assert.equal(code,0,output);
 const report=JSON.parse(await fs.readFile(path.join(root,'output/test-results/g07-candidate-wechat',mode+'-verification.json'),'utf8'));assert.ok(report.checks.length>=3);assert.equal(report.realWechatCodeExchange,false);assert.equal(report.externalWechatSubscription,'unsupported');assert.equal(report.observations.forbiddenAttempts,0);assert.equal(report.observations.externalNetworkAttempts,0);
 if(mode==='exchange-stop'){assert.equal(report.nativePromisesOwnedBeforeRelease,1);assert.equal(report.stopEvents.at(-1),'shared-sqlite-closed');}
});
