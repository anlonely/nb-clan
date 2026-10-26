import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createServer} from 'node:http';
import express from 'express';
import {fixture} from './support/v2-platform-host/fixture.mjs';
import {createNotificationRuntime} from '../server/v2/notification-runtime/index.js';
import {createDiscordVerifier} from '../server/v2/notification-platforms/verifiers.js';

test('real signed slash HTTP uses current G03/Stats and actor-private results; forgery, replay and channel denial',async()=>{
 const f=fixture(),keys=generateKeyPairSync('ed25519');let runtime,server;
 try{
  await f.start();const config=f.platformService.config('discord');
  f.platformService.save(f.actor('admin'),'discord',{expectedRevision:1,config:{targets:config.targets.map(t=>({...t,enabledCommandIds:[...t.enabledCommandIds,'kda']}))}},{operationId:'closure-enable-kda'});
  f.ir.put('identities',{id:'closure-discord',provider:'discord',externalId:'closure-actor',accountId:'admin',revision:1});
  f.ir.put('policies',{id:'closure-policy',provider:'discord',enabled:true,guildId:'100000000000000001',allowedRoleIds:['closure-role'],matchMode:'any',policyRevision:1});
  f.identity.providers={discord:{roles:async(externalId,guildId)=>({externalId,guildId,roleIds:['closure-role']})}};
  const steamId=f.ir.get('members','m001').steamId;let queries=0;
  f.stats.providers.official=async()=>{queries++;return {steamId,rows:[{kills:0,deaths:7,syncedAt:new Date(f.now()).toISOString()}]};};
  const verify=createDiscordVerifier({publicKey:keys.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),applicationId:'closure-app',now:f.now});
  runtime=createNotificationRuntime({getIdentity:async()=>f.identity,catalog:f.notifications.catalog,transport:f.transport,verifiers:{discord:verify,kook:()=>{}},publicOrigin:'http://127.0.0.1',now:f.now,
   getCommunityHandler:(identity,platform)=>{assert.equal(identity,f.identity);return proof=>f.host.community[platform].handleVerified(proof);}});
  const app=express();app.use('/api',runtime.callbackRouter);server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const event=(id,channel='200000000000000001')=>({id,type:2,locale:'zh-CN',application_id:'closure-app',guild_id:'100000000000000001',channel_id:channel,member:{user:{id:'closure-actor'}},token:'fixture-private-token',data:{name:'kda',options:[{name:'steam_input',type:3,value:steamId}]}});
  async function send(value,tamper=false){let body=Buffer.from(JSON.stringify(value));const ts=String(f.now()/1000),signature=sign(null,Buffer.concat([Buffer.from(ts),body]),keys.privateKey).toString('hex');if(tamper)body=Buffer.concat([body,Buffer.from(' ')]);const r=await fetch(`http://127.0.0.1:${server.address().port}/api/integrations/v2/notifications/discord`,{method:'POST',headers:{'Content-Type':'application/json','x-signature-timestamp':ts,'x-signature-ed25519':signature},body});return {status:r.status,body:await r.json()};}
  async function replies(n){const until=Date.now()+3000;while(f.transport.getPrivateReplies().length<n&&Date.now()<until)await new Promise(r=>setTimeout(r,5));assert.equal(f.transport.getPrivateReplies().length,n);return f.transport.getPrivateReplies().at(-1);}
  const first=await send(event('closure-slash-1'));assert.equal(first.status,200);assert.equal(first.body.data.flags,64);assert.match((await replies(1)).payload.content,/0 击杀/);
  await send(event('closure-slash-1'));await replies(2);assert.equal(queries,1);
  await send(event('closure-wrong-channel','outside'));assert.match((await replies(3)).payload.content,/无法完成/);assert.equal(queries,1);
  const bad=await send(event('closure-forged'),true);assert.equal(bad.status,401);assert.equal(queries,1);
  assert.throws(()=>f.host.community.discord.handleVerified({provider:'discord',verified:true,payload:{kind:'community',command:'kda'}}),e=>e.errorCode==='PLATFORM_AUTH_INVALID');
  f.stats.providers.official=async()=>{throw Error('private detail');};await send(event('closure-query-fail'));const failed=await replies(4);assert.match(failed.payload.content,/查询失败/);assert.ok(!failed.payload.content.includes('查询完成'));assert.ok(!failed.payload.content.includes('private detail'));
  assert.equal(f.transport.getCalls().length,0);assert.ok(f.transport.getPrivateReplies().every(x=>x.externalId==='closure-actor'));
 }finally{await runtime?.stop();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await f.close();}
});
