import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { callbackFixture, replyText, privateButtons } from './support/v2-notification-platforms/fixture.mjs';
import { nativeEnvelopes } from './support/v2-notification-platforms/native-envelopes.mjs';
import { createNotificationCallbackHandler } from '../server/v2/notification-platforms/index.js';

for (const platform of ['discord','kook']) {
  test(`${platform}: native raw verified button and private late confirmation call the exported handler and real G04`,async t=>{
    const f=await callbackFixture(t),native=nativeEnvelopes({now:()=>f.state.now});
    const handler=createNotificationCallbackHandler({platform,identity:f.identity,scheduling:f.scheduling,
      verify:native.verifiers[platform],resolveActionReference:f.resolveReference,transport:f.transport,
      publicOrigin:'http://127.0.0.1:4316',now:()=>f.state.now});
    const envelope=native[platform]('late');
    await handler(envelope,f.io);
    const button=privateButtons(f.privateReplies.at(-1)).find(b=>b.value?.startsWith('nblate:'));
    assert.ok(button);const confirm=native[platform](button.value);
    await handler(confirm,f.io);
    assert.equal(f.signup().response,'attending_later');assert.equal(f.signup().expectedArrivalAt,'2026-09-10T16:00:00.000Z');
    await handler(confirm,f.io);
    assert.match(replyText(f.privateReplies.at(-1)), platform === 'discord' ? /Original receipt retrieved/ : /原操作回执/);
    assert.equal(f.signup().signupRevision,1);
    assert.equal(f.scheduling.repo.all('receipts').filter(r=>r.memberId===f.actor.memberId).length,1);
    const mutated={...confirm,rawBody:Buffer.from(confirm.rawBody)};mutated.rawBody[mutated.rawBody.length-1]^=1;
    const ackCount=f.acks.length;
    await assert.rejects(handler(mutated,f.io));assert.equal(f.acks.length,ackCount);assert.equal(f.signup().signupRevision,1);
  });
}

test('kook: signed cancel button requires private confirmation and clears the signup once', async t => {
  const f = await callbackFixture(t), native = nativeEnvelopes({ now: () => f.state.now });
  const handler = createNotificationCallbackHandler({ platform: 'kook', identity: f.identity,
    scheduling: f.scheduling, verify: native.verifiers.kook, resolveActionReference: f.resolveReference,
    transport: f.transport, publicOrigin: 'http://127.0.0.1:4316', now: () => f.state.now });
  await handler(native.kook('on-time'), f.io);
  assert.equal(f.signup().response, 'attending_on_time');
  await handler(native.kook('withdraw'), f.io);
  assert.equal(f.signup().response, 'attending_on_time');
  const confirmation = f.privateReplies.at(-1);
  assert.match(replyText(confirmation), /本次选择：未回复/);
  const button = privateButtons(confirmation).find(item => item.value?.startsWith('nbconfirm:'));
  assert.ok(button);
  const confirm = native.kook(button.value);
  await handler(confirm, f.io);
  assert.equal(f.signup().response, null);
  assert.equal(f.signup().signupRevision, 2);
  await handler(confirm, f.io);
  assert.equal(f.signup().signupRevision, 2);
  assert.match(replyText(f.privateReplies.at(-1)), /原操作回执/);
});

test('kook: on-time and not-attending buttons save directly, including an existing reply', async t => {
  const f = await callbackFixture(t), native = nativeEnvelopes({ now: () => f.state.now });
  const handler = createNotificationCallbackHandler({ platform: 'kook', identity: f.identity,
    scheduling: f.scheduling, verify: native.verifiers.kook, resolveActionReference: f.resolveReference,
    transport: f.transport, publicOrigin: 'http://127.0.0.1:4316', now: () => f.state.now });
  await handler(native.kook('on-time'), f.io);
  assert.equal(f.signup().response, 'attending_on_time');
  const absent = native.kook('absent');
  await handler(absent, f.io);
  assert.equal(f.signup().response, 'not_attending');
  assert.equal(f.signup().signupRevision, 2);
  assert.match(replyText(f.privateReplies.at(-1)), /回复已保存/);
  assert.equal(privateButtons(f.privateReplies.at(-1)).some(button => button.value?.startsWith('nbconfirm:')), false);
  await handler(absent, f.io);
  assert.equal(f.signup().signupRevision, 2);
  assert.match(replyText(f.privateReplies.at(-1)), /原操作回执/);
});

test('kook: unbound account receives a private Steam binding link', async t => {
  const f = await callbackFixture(t), native = nativeEnvelopes({ now: () => f.state.now });
  for (const binding of f.identity.repo.all('bindings')) f.identity.repo.remove('bindings', binding.id);
  const handler = createNotificationCallbackHandler({ platform: 'kook', identity: f.identity,
    scheduling: f.scheduling, verify: native.verifiers.kook, resolveActionReference: f.resolveReference,
    transport: f.transport, publicOrigin: 'https://nb-clan.example', now: () => f.state.now });
  await handler(native.kook('on-time'), f.io);
  assert.match(replyText(f.privateReplies.at(-1)), /绑定 Steam/);
  assert.equal(privateButtons(f.privateReplies.at(-1))[0].url,
    'https://nb-clan.example/api/auth/kook/start?lang=zh-CN');
  assert.equal(f.scheduling.repo.all('signups').length, 0);
});

for(const platform of ['discord','kook']) test(`${platform}: raw HTTP ACK is flushed while role work is pending; runtime retains the exported handler Promise`,async t=>{
  const f=await callbackFixture(t),native=nativeEnvelopes({now:()=>f.state.now});let release;
  f.state.wait=new Promise(resolve=>{release=resolve;});
  const jobs=new Set(),errors=[];
  const handler=createNotificationCallbackHandler({platform,identity:f.identity,scheduling:f.scheduling,
    verify:native.verifiers[platform],resolveActionReference:f.resolveReference,transport:f.transport,
    publicOrigin:'http://127.0.0.1:4316',now:()=>f.state.now});
  const server=http.createServer((req,res)=>{
    if(req.method!=='POST'||req.url!==`/api/integrations/v2/notifications/${platform}`){res.writeHead(404).end();return;}
    const chunks=[];req.on('data',c=>chunks.push(c));req.on('end',()=>{
      const job=handler({rawBody:Buffer.concat(chunks),headers:req.headers,receivedAt:new Date(f.state.now).toISOString()},
        {ack(payload){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));}});
      jobs.add(job);job.catch(e=>{errors.push(e.errorCode);if(!res.headersSent)res.writeHead(e.status||500).end();}).finally(()=>jobs.delete(job));
    });
  });
  t.after(async()=>{release();await Promise.allSettled([...jobs]);await new Promise(resolve=>server.close(resolve));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const signed=native[platform]('on-time');
  const response=await new Promise((resolve,reject)=>{
    const request=http.request({host:'127.0.0.1',port:server.address().port,path:`/api/integrations/v2/notifications/${platform}`,method:'POST',
      headers:{...signed.headers,'content-type':'application/json','content-length':signed.rawBody.length}},res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(Buffer.concat(chunks))}));
    });request.on('error',reject);request.end(signed.rawBody);
  });
  assert.equal(response.status,200);assert.deepEqual(response.body,platform==='discord'?{type:5,data:{flags:64}}:{});
  assert.equal(jobs.size,1);assert.equal(f.scheduling.repo.all('signups').length,0);
  release();await Promise.all([...jobs]);assert.deepEqual(errors,[]);assert.equal(f.signup().signupRevision,1);
});

test('native authenticated PING and encrypted Challenge ACK without invoking G03 or scheduling',async t=>{
  const f=await callbackFixture(t),native=nativeEnvelopes({now:()=>f.state.now});
  await f.handler('discord',{verify:native.verifiers.discord})(native.discord('unused',{type:1}),f.io);
  await f.handler('kook',{verify:native.verifiers.kook})(native.kook('unused',{channel_type:'WEBHOOK_CHALLENGE',challenge:'constructed-challenge'}),f.io);
  assert.deepEqual(f.acks,[{type:1},{challenge:'constructed-challenge'}]);
  assert.equal(f.privateReplies.length,0);assert.deepEqual(f.state.events,['ack','ack']);
});
