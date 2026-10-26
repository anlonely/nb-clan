import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { managedDiscordInteraction } from '../server/v2/notification-platforms/native-interactions.js';

test('signed Discord v2 card actions reach notification owner through the configured legacy endpoint', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nb-discord-notification-bridge-'));
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'test', NB_DATA_DIR: directory, NB_STORAGE_MODE: 'json',
    NB_ROOT_PASSWORD: 'Constructed-local-fixture-only', NB_DISABLE_BACKGROUND_JOBS: '1',
    NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1' });
  const { createApiRouter, stopBackgroundJobs } = await import('../server/api.js');
  const { ensureStore, updateStore, drainStoreWrites } = await import('../server/store.js');
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
  await ensureStore();
  await updateStore(store => { store.settings.discord = { ...store.settings.discord, publicKey }; });
  const forwarded = []; let failAfterAck=false;
  const notifications = { callbackRouter: express.Router(),
    ownsDiscordInteraction: payload => managedDiscordInteraction(payload, {enabled:true,targets:[{enabled:true,guildId:'123456789012345670',channelId:'123456789012345671',enabledCommandIds:['wipe','kda','ranking','map','vip']}],commands:[{id:'wipe',enabled:true,type:'event_command',slashCommand:'wipe-react'}]}),
    async handleCallback(platform, envelope, io) {
      forwarded.push({ platform, bytes: Buffer.from(envelope.rawBody), headers: envelope.headers });
      io.ack({ type: 5, data: { flags: 64 } });
      if(failAfterAck)throw Object.assign(new Error('Constructed post-ACK failure'),{skipApiErrorLog:true});
    },
    stop: async () => {} };
  const router = createApiRouter({ notificationRuntimeFactory: () => notifications });
  const app = express(); app.use('/api', router);
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    stopBackgroundJobs(); await router.v2Runtime.stop(); await drainStoreWrites();
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    await rm(directory, { recursive: true, force: true });
  });
  async function post(customId, validSignature = true, extra = {}) {
    const body = Buffer.from(JSON.stringify({ type: 3, id: `interaction-${forwarded.length}`, data: { custom_id: customId },
      application_id: '123456789012345672', token: 'constructed-interaction-token', locale: 'en-US',
      guild_id: '123456789012345670', channel_id: '123456789012345671',
      member: { user: { id: '123456789012345679' }, roles: [] }, ...extra }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.concat([Buffer.from(timestamp), body]), keys.privateKey).toString('hex');
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/integrations/discord/interactions`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'x-signature-ed25519': validSignature ? signature : '0'.repeat(128),
        'x-signature-timestamp': timestamp }, body });
    return { status: response.status, payload: await response.json(), body };
  }
  const token = 'A'.repeat(43);
  const cases = [token, `nbconfirm:${token}`, `nblate:${token}:1790283600000`, `nblang:signup:${token}`, 'nblang:card:'+'a'.repeat(64), 'nb_vital_vip:open'];
  for (const customId of cases) {
    const response = await post(customId);
    assert.equal(response.status, 200);
    assert.deepEqual(response.payload, { type: 5, data: { flags: 64 } });
    assert.equal(forwarded.at(-1).platform, 'discord');
    assert.deepEqual(forwarded.at(-1).bytes, response.body);
  }
  assert.equal(forwarded.length, cases.length);
  for (const extra of [
    {type:5,data:{custom_id:'nb_vital_vip:submit:vital:priority:'+'b'.repeat(32)}},
    ...['kda','ranking','map'].map(name=>({type:2,data:{name,options:[]}})),
    {type:2,data:{name:'wipe-react',options:[{name:'wipe',type:3,value:'existing-wipe'}]}},
  ]) {
    const response=await post(null,true,extra);assert.equal(response.status,200);
    assert.deepEqual(response.payload,{type:5,data:{flags:64}});
    assert.deepEqual(forwarded.at(-1).bytes,response.body);
  }
  const total=forwarded.length;
  const forged = await post(token, false);
  assert.equal(forged.status, 401);
  assert.equal(forwarded.length, total);
  const legacy = await post('not-a-v2-action');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.payload.type, 4);
  assert.equal(forwarded.length, total);
  for (const [locale,label] of [['zh-CN','这个按钮'],['ru','Эта кнопка'],['tr','Bu düğme'],['th','ปุ่มนี้'],['ko','이 버튼'],['de','This button'],[null,'This button']]) {
    const result=await post('legacy-invalid-button',true,{locale,guild_locale:'zh-CN'});
    assert.ok(result.payload.data.content.startsWith(label));
  }
  assert.equal(forwarded.length,total);
  failAfterAck=true;
  const acknowledged=await post(token);
  assert.equal(acknowledged.status,200);
  assert.deepEqual(acknowledged.payload,{type:5,data:{flags:64}});
});

test('managed command routing preserves unconfigured legacy VIP, DM forms, rankings and slash commands',()=>{
 const config={enabled:true,targets:[{enabled:true,guildId:'guild',channelId:'channel',enabledCommandIds:['wipe']}],commands:[{id:'wipe',enabled:true,type:'event_command',slashCommand:'wipe-react'}]};
 const event=(type,data,extra={})=>({type,data,guild_id:'guild',channel_id:'channel',...extra});
 for(const data of [{custom_id:'nb_vital_vip:open'},{custom_id:'nb_vital_vip:type:atlas'},{custom_id:'nb_member_ranking:metric:kills'},{custom_id:'nb_member_review:approve:member'}])assert.equal(managedDiscordInteraction(event(3,data),config),false);
 assert.equal(managedDiscordInteraction(event(5,{custom_id:'nb_vital_vip:submit:atlas:priority'}),config),false);
 assert.equal(managedDiscordInteraction(event(3,{custom_id:'nb_vital_vip:open'},{guild_id:undefined}),config),false);
 for(const name of ['kda','ranking','map','other'])assert.equal(managedDiscordInteraction(event(2,{name,options:[{name:'wipe',type:3,value:'existing'}]}),config),false);
 assert.equal(managedDiscordInteraction(event(2,{name:'wipe-react',options:[]}),config),true);
 assert.equal(managedDiscordInteraction(event(2,{name:'wipe-react'},{guild_id:'other'}),config),false);
 assert.equal(managedDiscordInteraction(event(3,{custom_id:'nblang:card:'+'a'.repeat(64)})),true);
});

test('retired Discord registration notice supports six languages and English fallback',async()=>{
 const {legacyRegistrationNotice}=await import('../server/v2/identity/legacy.js');
 const locales=['zh-CN','en-US','ru','tr','th','ko'];
 const messages=locales.map(locale=>legacyRegistrationNotice(locale));
 assert.equal(new Set(messages.map(result=>result.message)).size,6);
 assert.ok(messages.every(result=>result.loginUrl.includes('/api/v2/auth/discord/start')));
 for(const locale of ['de','<@everyone>','en'])assert.equal(legacyRegistrationNotice(locale).message,messages[1].message);
 assert.equal(legacyRegistrationNotice('zh-TW').message,messages[0].message);
});
