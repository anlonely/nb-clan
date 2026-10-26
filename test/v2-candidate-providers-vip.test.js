import './support/results.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import fs from 'node:fs/promises';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {validateBindings} from '../server/v2/candidate-host/bindings.js';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { chromiumExecutablePath } from '../server/chromium-runtime.js';
import { createCandidateProviders } from '../server/v2/candidate-host/providers.js';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const providers={enabled:true,capabilities:{moose:true,inventory:true},readConfiguration:()=>({enabled:false,revision:1})};
for(const [name,value] of Object.entries({testOrigins:{origins:{moose:'http://127.0.0.1'}},testBypass:{allowLoopbackForTests:true},engine:{mooseEngine:()=>{}},jsonReader:{readConfiguration:{verified:true}},unknownLaunch:{chromium:{executablePath:'/bin/sh',allowedExecutablePaths:['/bin/sh'],userDataDir:'/user/profile'}},secret:{token:'forbidden'},ambient:{env:{}},badCapability:{capabilities:{inventory:'true'}}}))test('provider binding rejects '+name,()=>assert.throws(()=>validateBindings({providers:{...providers,...value}})));
for(const value of [{enabled:true,revision:'one'},{enabled:false,revision:'one',legacySchedulerDisabled:true},{enabled:false,revision:'one',readDmTarget:{verified:true}},{enabled:false,revision:'one',now:()=>1},{enabled:false,revision:'one',principal:{accountId:'admin',permissionVersion:0}}])test('VIP binding refuses fabricated authority '+JSON.stringify(value),()=>assert.throws(()=>validateBindings({vipNotifications:value})));
test('new factories own declared providers; unchanged legacy injection remains explicit',()=>{assert.throws(()=>validateBindings({providers,sources:{mooseEngine:()=>{}}}),e=>e.errorCode==='CANDIDATE_PROVIDER_OWNER_AMBIGUOUS');assert.throws(()=>validateBindings({providers,sources:{inventoryEnrichment:()=>{}}}),e=>e.errorCode==='CANDIDATE_PROVIDER_OWNER_AMBIGUOUS');assert.doesNotThrow(()=>validateBindings({sources:{inventoryEnrichment:async()=>({prices:[]})}}));});
test('candidate Chromium pin rejects executable aliases and admits the explicitly canonical browser', async t => {
 const executable = await fs.realpath(chromiumExecutablePath());
 const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'nb-provider-browser-pin-'));
 const alias = path.join(directory, 'browser-alias'); await fs.symlink(executable, alias);
 const db = new DatabaseSync(':memory:'); installIdentitySchema(db);
 const identity = new IdentityService(new IdentityRepository(db)), owners = [];
 t.after(async () => { await Promise.all(owners.map(owner => owner.stop())); db.close(); await fs.rm(directory, { recursive: true, force: true }); });
 let requests = 0;
 const owner = configuredPath => {
  const value = createCandidateProviders({ identity,
   sources: { capabilities: { moose: true } }, binding: {
    enabled: true, capabilities: { moose: true, inventory: false },
    readConfiguration: () => ({ enabled: true, revision: 1 }),
    fetchImpl: async () => { requests++; throw new Error('Pin validation must not perform network I/O'); },
    chromium: { executablePath: configuredPath, allowedExecutablePaths: [configuredPath] }
   } }); owners.push(value); return value;
 };
 const aliased = owner(alias), canonical = owner(executable);
 assert.equal(aliased.diagnostics().capabilities.moose.available, false);
 assert.equal(aliased.diagnostics().capabilities.moose.reason, 'CANDIDATE_CHROMIUM_NOT_ALLOWED');
 assert.equal(canonical.diagnostics().capabilities.moose.available, true);
 assert.equal(canonical.diagnostics().capabilities.moose.reason, null);
 assert.equal(canonical.diagnostics().activeSessions, 0); assert.equal(requests, 0);
});
const modes=['migration-table','migration-trigger','migration-marker','provider-enabled','provider-disabled','provider-missing-reader','provider-missing-proxy','provider-missing-ws','provider-untrusted-chromium','provider-missing-ledger','provider-legacy','provider-config-drift','provider-ledger-drift','provider-cancel','provider-stop','vip-enabled','vip-disabled','vip-all-sources','vip-missing-transport','vip-missing-dm-reader','vip-missing-source-reader','vip-missing-eligibility','vip-unverified-dm','vip-wrong-recipient','vip-expired-dm','vip-expired-term','vip-config-drift','vip-principal-drift','vip-identity-drift','vip-policy-drift','vip-term-drift','vip-dm-drift','vip-stop','vip-unknown','vip-restart','vip-combined','vip-group-dm','vip-native-key-drift','vip-renewal','vip-auto-tick'];
for(const mode of modes)test('actual candidate providers/VIP HTTP '+mode,{timeout:95000},async()=>{const child=spawn(process.execPath,['test/support/v2-candidate-providers-vip/run-probe.mjs',mode],{cwd:root,env:{...process.env,NB_DATA_DIR:'/must-not-inherit',NB_DISCORD_BOT_TOKEN:'constructed-not-inherited',HTTPS_PROXY:'http://127.0.0.1:9'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);const code=await new Promise((r,j)=>{child.once('error',j);child.once('exit',r);});assert.equal(code,0,output);const report=JSON.parse(await fs.readFile(path.join(root,'output/test-results/g07-candidate-providers-vip',mode+'-verification.json'),'utf8'));assert.ok(report.checks.length>=3);assert.equal(report.observations.forbiddenAttempts,0);assert.equal(report.observations.externalNetworkAttempts,0);if(mode.startsWith('provider'))assert.equal(report.realExternalProvidersVerified,false);if(mode.startsWith('vip')){assert.equal(report.realExternalDmVerified,false);assert.equal(report.createsDmChannels,false);}if(mode==='vip-restart'){assert.equal(report.restart.beforeNativeSends,1);assert.equal(report.restart.afterNativeSends,0);}});
