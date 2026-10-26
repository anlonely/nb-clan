import test from 'node:test';
import assert from 'node:assert/strict';
import {createProviders} from '../server/v2/identity/providers.js';
import {createKookRequestGate} from '../server/v2/identity/kook-request-gate.js';
for(const provider of ['kook','discord']) test(`${provider} onboarding resolves only the current member roles and keeps display failures optional`, async()=>{
 const discord=provider==='discord';let fail=false,hostile=false,calls=0;
 const adapters=createProviders({[provider]:{},[discord?'kook':'discord']:{}},{kookGate:createKookRequestGate({intervalMs:0}),kookGuildCacheMs:0,settings:async()=>({settings:{[provider]:{botToken:'secret'}}}),fetch:async(url,options)=>{
  calls++;assert.equal(options.headers.authorization,'Bot secret');
  if(url.includes('/members/')||url.includes('/user/view?'))return {ok:true,json:async()=>discord?{user:{id:'person'},roles:['7']}:{code:0,data:{id:'person',roles:[7]}}};
  if(fail)throw Error('unavailable');
  const guild={id:'guild',name:'战队服务器',icon:hostile?'https://evil.invalid/icon':discord?'a'.repeat(32):'https://img.kookapp.cn/icons/team.png',roles:[{id:'7',role_id:7,name:'队员'},{id:'8',role_id:8,name:'管理员'}]};
  return {ok:true,json:async()=>discord?guild:{code:0,data:guild}};
 }});
 const basic=await adapters[provider].roles('person','guild');assert.equal(calls,1);assert.equal(basic.community,undefined);
 const full=await adapters[provider].roles('person','guild',{includeCommunity:true});assert.deepEqual(full.community.roles,[{id:'7',name:'队员'}]);assert.equal(full.community.name,'战队服务器');assert(full.community.iconUrl.startsWith('https://'));assert.deepEqual(full.roleIds,['7']);
 hostile=true;assert.equal((await adapters[provider].roles('person','guild',{includeCommunity:true})).community.iconUrl,null);
 fail=true;const fallback=await adapters[provider].roles('person','guild',{includeCommunity:true});assert.deepEqual(fallback.roleIds,['7']);assert.equal(fallback.community.available,false);
});

test('KOOK scheduled role read verifies configured guild roles before checking membership', async () => {
  let guildRoles = [{ role_id: 7, name: '准入' }], guildMissing = false, memberCalls = 0;
  const adapters = createProviders({ kook: {}, discord: {} }, {
    kookGate: createKookRequestGate({ intervalMs: 0 }),
    settings: async () => ({ settings: { kook: { botToken: 'test-token' } } }),
    fetch: async url => {
      if (url.includes('/guild/view')) return guildMissing ? { ok: false, status: 404 } :
        { ok: true, json: async () => ({ code: 0, data: { id: 'guild', name: '测试群', roles: guildRoles } }) };
      memberCalls++;
      return { ok: false, status: 404 };
    }
  });
  await assert.rejects(adapters.kook.roles('person', 'guild', { admissionRoleIds: ['7'] }), { errorCode: 'ELIGIBILITY_DENIED' });
  assert.equal(memberCalls, 1);
  guildRoles = [{ role_id: 8, name: '其他' }];
  await assert.rejects(adapters.kook.roles('person', 'guild', { admissionRoleIds: ['7'] }), { errorCode: 'ADMISSION_ROLE_CONFIG_INVALID' });
  assert.equal(memberCalls, 1);
  guildMissing = true;
  await assert.rejects(adapters.kook.roles('person', 'guild', { admissionRoleIds: ['7'] }), { errorCode: 'ADMISSION_ROLE_CONFIG_INVALID' });
  assert.equal(memberCalls, 1);
});

test('KOOK 429 uses reset seconds and reports a retry delay', async () => {
  let calls = 0;
  const adapters = createProviders({ kook: {}, discord: {} }, {
    kookGate: createKookRequestGate({ intervalMs: 0 }),
    settings: async () => ({ settings: { kook: { botToken: 'test-token' } } }),
    fetch: async () => { calls++; return { ok: false, status: 429,
      headers: { get: name => name === 'x-rate-limit-reset' ? '14' : null } }; }
  });
  await assert.rejects(adapters.kook.roles('person', 'guild'), {
    errorCode: 'KOOK_RATE_LIMITED', retryAfterSeconds: 14
  });
  assert.equal(calls, 1);
});

test('simultaneous KOOK membership reads share optional guild metadata only', async () => {
  let members = 0, guilds = 0;
  const adapters = createProviders({ kook: {}, discord: {} }, {
    kookGate: createKookRequestGate({ intervalMs: 0 }),
    settings: async () => ({ settings: { kook: { botToken: 'test-token' } } }),
    fetch: async url => {
      if (url.includes('/user/view')) { members++; return { ok: true, json: async () => ({ code: 0,
        data: { id: new URL(url).searchParams.get('user_id'), roles: [7] } }) }; }
      guilds++; return { ok: true, json: async () => ({ code: 0,
        data: { id: 'guild', name: '测试群', roles: [{ role_id: 7, name: '队员' }] } }) };
    }
  });
  const results = await Promise.all(['one', 'two'].map(id => adapters.kook.roles(id, 'guild', { includeCommunity: true })));
  assert.deepEqual(results.map(result => result.externalId), ['one', 'two']);
  assert.equal(members, 2);
  assert.equal(guilds, 1);
});

test('KOOK queue rejects excess work with a retryable busy result', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const gate = createKookRequestGate({ intervalMs: 0, maxPending: 1 });
  const first = gate.run(() => blocked);
  await assert.rejects(gate.run(() => Promise.resolve()), { errorCode: 'KOOK_BUSY', retryable: true });
  release();
  await first;
});

test('forty KOOK bot reads are paced instead of fired together', async () => {
  let clock = 0;
  const starts = [];
  const gate = createKookRequestGate({ now: () => clock, sleep: async ms => { clock += ms; } });
  await Promise.all(Array.from({ length: 40 }, () => gate.run(() => { starts.push(clock); })));
  assert.equal(starts.length, 40);
  assert.deepEqual(starts, Array.from({ length: 40 }, (_, index) => index * 1_000));
});
