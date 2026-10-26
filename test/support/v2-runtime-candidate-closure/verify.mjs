import {observations} from '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createServer} from 'node:http';
import {randomUUID,generateKeyPairSync,sign} from 'node:crypto';
import {candidateConfig,paths} from '../../../server/v2/candidate-host/config.js';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,validateCandidateReady,createCandidateHost} from '../../../server/v2/candidate-host/index.js';
import {buildNativeNotificationRequest} from '../../../server/v2/notification-platforms/platforms.js';
import {createDiscordVerifier,createKookVerifier} from '../../../server/v2/notification-platforms/verifiers.js';
const [mode,raw]=process.argv.slice(2),config=candidateConfig(JSON.parse(raw)),active=mode==='active';
const password='Synthetic-Closure-Password-2026',checks=[],pass=x=>checks.push(x);
const catalog=[{serverProfileId:'local-profile',vitalServerId:'1',name:'Local test catalog',directConnect:'client.connect localhost:28015'}];
const c={enabled:true,revision:'candidate-hex-1',targetId:'synthetic-hex',guildId:'100000000000000001',channelId:'200000000000000001',senderBotId:'300000000000000001',replyBotId:'400000000000000001',replyApplicationId:'500000000000000001',transportKey:'local-discord',commandTemplate:'/player identifier:{steamId}',timeoutMs:5000,intervalMs:250,messageLimit:20};
let host,native,conn,releasePoll,enteredPoll,holdPoll=false,sequence=0n,pin,managementTurn,signingKey;const privateReplies=[];const calls=[],cards=[];
const waitFor=async(fn,label)=>{const until=Date.now()+8000;for(;;){const result=await fn();if(result)return result;assert.ok(Date.now()<until,label);await new Promise(r=>setTimeout(r,15));}};
try{
 await initializeCandidate(config,{rootPassword:password});
 const plan=await planCandidateMigration(config,active?{adminExtrasCatalog:catalog}:{});
 assert.equal(plan.version,'g07-candidate-host/5');
 await applyCandidateMigration(config,plan,{expectedDigest:plan.digest,operatorId:'user_root'});
 await (await import('../../../server/storage/sqlite.js')).closeSqliteDatabases();
 await validateCandidateReady(config);pass('explicit version-5 plan/apply installs Hex and relay with readiness gate');
 const bindings={};
 if(active){
  native=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;calls.push({method:req.method,path:req.url,body:body?JSON.parse(body):null});res.setHeader('Content-Type','application/json');
   if(req.method==='GET'){assert.match(req.url,/after=\d+&limit=20$/);res.end(JSON.stringify(cards));return;}
   assert.equal(req.method,'POST');assert.equal(conn.isTransaction,false);const payload=JSON.parse(body),steamId=payload.content.match(/7656119\d{10}/)[0];sequence+=10n;const id=String(900000000000000000n+sequence);
   assert.deepEqual(payload.allowed_mentions,{parse:[],roles:[],users:[],replied_user:false});
   cards.push({id:String(BigInt(id)+1n),channel_id:c.channelId,guild_id:c.guildId,timestamp:new Date().toISOString(),author:{id:c.replyBotId,bot:true},application_id:c.replyApplicationId,content:steamId,message_reference:{message_id:id,channel_id:c.channelId},embeds:[{fields:[...['atlas','vital','rustinity','building','aimtrain','official'].map((name,n)=>({name,value:`${n*10} hours`})),{name:'Rust',value:'1,250 hours'},{name:'First Seen',value:'500 days ago'}]}]});
   res.end(JSON.stringify({id,channel_id:c.channelId,guild_id:c.guildId}));
  });await new Promise(r=>native.listen(0,'127.0.0.1',r));const nativeOrigin=`http://127.0.0.1:${native.address().port}`;
  const keys=generateKeyPairSync('ed25519');signingKey=keys.privateKey;const publicKey=keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('hex');
  bindings.notifications={transport:{runtimeMode:'isolated',respondPrivate:async args=>{privateReplies.push(args);return {status:200,body:{}};},request:async args=>{const n=buildNativeNotificationRequest(args);const r=await fetch(nativeOrigin+n.path,{method:n.method,signal:args.context.signal,headers:{'Content-Type':'application/json'},...(n.body===null?{}:{body:JSON.stringify(n.body)})});return {status:r.status,headers:{},body:await r.json()};}},verifiers:{discord:createDiscordVerifier({publicKey,applicationId:c.replyApplicationId}),kook:createKookVerifier({verifyToken:'local-kook-verify',encryptKey:'local-kook-encrypt'})},transportKey:()=>c.transportKey};
  const proofAt=Date.now();
  bindings.hexQuery={enabled:true,readConfig:()=>c,readPrincipal:()=>pin,readChannelProof:()=>{const at=proofAt;return ({verified:true,guildId:c.guildId,channelId:c.channelId,channelType:0,senderBotId:c.senderBotId,transportKey:c.transportKey,canSend:true,canReadHistory:true,revision:'local-proof-1',verifiedAt:new Date(at).toISOString(),expiresAt:new Date(at+300000).toISOString()});},readMessages:async args=>{assert.equal(args.method,'GET');const r=await fetch(nativeOrigin+args.path,{signal:args.signal});const body=await r.json();if(holdPoll){enteredPoll?.();await new Promise(r=>releasePoll=r);assert.equal(conn.prepare('SELECT 1 n').get().n,1);}return {status:r.status,body};}};
  bindings.adminExtras={readCatalog:()=>catalog};
  bindings.platformMetadata={metadata:args=>{assert.equal(args.platform,'discord');assert.equal(args.assertCurrent().id,'user_root');return {schema:'platform-result/1',state:'succeeded',items:[{id:c.channelId,label:'Local verified metadata',status:'isolated'}]};}};
 }
 host=createCandidateHost(config,{bindings});const status=await host.start(),origin=status.origin;
 const owners=host.owners(),identity=await owners.api.v2Runtime.getIdentity(),managed=owners.management.getSystem(identity),notify=owners.notifications.getSystem(identity);conn=identity.repo.db;
 assert.equal(managed.service.authority,managed.sources.authority);assert.equal(managed.scheduling,notify.service.scheduling);assert.equal(managed.sourceHost.battlemetricsQueue,owners.sharedBattlemetricsQueue);
 const actor=identity.actorForAccount('user_root');pin={accountId:actor.id,permissionVersion:actor.permissionVersion};
 let cookie='',csrf='';const request=async(route,{body,key=randomUUID(),auth=true}={})=>{const r=await fetch(origin+'/api/v2'+route,{method:body===undefined?'GET':'POST',headers:{...(auth&&cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json','X-CSRF-Token':csrf,'Idempotency-Key':key})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json(),headers:r.headers};};
 assert.equal((await request('/relay-admin',{auth:false})).status,401);
 const login=await request('/auth/owner-password',{body:{username:'root',password}});assert.equal(login.status,200,JSON.stringify(login.body));cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');csrf=login.body.data.csrfToken;
 const store=await import('../../../server/store.js');
 notify.service.repo.requireBusinessSchema('platformCard');pass('candidate explicitly installs platformCard marker before PlatformHost');
 const relay=await request('/relay-admin');assert.equal(relay.status,200,JSON.stringify(relay.body));assert.equal(relay.body.data.authInvalidatorReady,true);
 const saved=await request('/relay-admin/commands/save',{body:{input:{expectedRevision:relay.body.data.revision,token:'synthetic-local-relay-token-2026'}}});assert.equal(saved.status,200,JSON.stringify(saved.body));assert.equal(saved.body.data.cacheState,'refreshed');assert.match(identity.repo.scalar('settings').rustplusRelay.tokenHash,/^scrypt\$/);assert.equal((await store.readStore()).settings.rustplusRelay.tokenHash,identity.repo.scalar('settings').rustplusRelay.tokenHash);pass('G03 HTTP relay save uses original invalidator, queue, SQLite and cache');
 if(!active){assert.equal(managed.hexQuery,null);assert.equal(owners.notifications.diagnostics().workerEnabled,false);assert.equal(managed.sourceHost.readSourceConfig({type:'hexaytron_profile'}).enabled,false);assert.equal(calls.length,0);pass('default Hex source and notification sender remain disabled');}
 else{
  const platform=await request('/platform-admin/discord');const setup=await request('/platform-admin/discord/config',{body:{expectedRevision:platform.body.data.revision,config:{enabled:true,targets:[{id:c.targetId,name:'Synthetic Hex',guildId:c.guildId,channelId:c.channelId,enabled:true}]}}});assert.equal(setup.status,200,JSON.stringify(setup.body));
  let verifiedCalls=0;const handleVerified=managed.platformHost.community.discord.handleVerified;
  managed.platformHost.community.discord.handleVerified=proof=>{verifiedCalls++;return handleVerified(proof);};
  const wire=Buffer.from(JSON.stringify({id:'600000000000000001',type:2,application_id:c.replyApplicationId,guild_id:c.guildId,channel_id:c.channelId,member:{user:{id:'700000000000000001'}},token:'synthetic-callback-token',data:{name:'map',options:[{name:'wipe',type:3,value:'synthetic-missing-wipe'}]}}));
  const timestamp=String(Math.floor(Date.now()/1000)),signature=sign(null,Buffer.concat([Buffer.from(timestamp),wire]),signingKey).toString('hex');
  const callback=await fetch(origin+'/api/integrations/v2/notifications/discord',{method:'POST',headers:{'Content-Type':'application/json','x-signature-timestamp':timestamp,'x-signature-ed25519':signature},body:wire});
  assert.equal(callback.status,200);assert.deepEqual(await callback.json(),{type:5,data:{flags:64}});await waitFor(()=>privateReplies.length===1,'private callback settles');assert.equal(verifiedCalls,1);
  assert.throws(()=>handleVerified({...privateReplies[0].verifiedInteraction}),e=>e.errorCode==='PLATFORM_AUTH_INVALID');assert.equal(notify.service.repo.all('deliveries').length,0);pass('signed native HTTP callback ACKs privately and hands original branded proof to original community handler; clone rejected, unmapped account cannot create delivery');
  const metadata=await request('/platform-admin/discord/actions/metadata',{body:{expectedRevision:setup.body.data.revision}});assert.equal(metadata.status,200,JSON.stringify(metadata.body));assert.equal(metadata.body.data.result.items[0].id,c.channelId);pass('candidate metadata binding reaches original authenticated platform action');
  assert.equal(managed.extras.service.identity,identity);const catalogBefore=managed.extras.service.servers(actor);const extras=await managed.extras.service.saveServer(actor,{serverProfileId:'local-profile',expectedRevision:catalogBefore.revision,name:'Changed local catalog'},randomUUID());assert.equal(extras.effects,'complete');assert.equal((await store.readStore()).settings.vitalServers.overrides[0].name,'Changed local catalog');assert.equal(managed.platformHost.mini.capabilities().commands.some(x=>x.id==='server_save'),false);pass('explicit extras catalog/schema binds original domain, queue, cache and event owner');
  await store.runStoreWriteTask(()=>{for(let n=1;n<=3;n++)identity.repo.put('members',{id:`closure-${n}`,steamId:`7656119800000000${n}`,displayName:`Synthetic ${n}`,memberStatus:'active'});});
  const source=await request('/sync-center/sources');
  assert.equal(source.body.data.items.some(row=>row.id==='hexaytron'),false);
  const callCount=calls.length;
  const retired=await request('/sync-center/jobs',{body:{type:'hexaytron_profile',scope:{kind:'members',memberIds:['closure-1']}}});
  assert.equal(retired.status,410,JSON.stringify(retired.body));
  assert.equal(calls.length,callCount);
  assert.equal(managed.sources.store.profile(identity.repo.get('members','closure-1')),null);
  await host.stop();assert.throws(()=>conn.prepare('SELECT 1'));
  pass('retired Hex source cannot create a job or native request; candidate drain closes SQLite');
 }
 if(host.status().state==='ready')await host.stop();assert.equal(host.status().state,'stopped');assert.equal(observations.forbiddenAttempts,0);assert.equal(observations.externalNetworkAttempts,0);
 console.log(JSON.stringify({mode,checks,observations,requests:calls.map(({method,path})=>({method,path})),state:host.status().state}));
}finally{releasePoll?.();await host?.stop().catch(()=>{});native?.closeAllConnections();if(native)await new Promise(r=>native.close(r));await(await import('../../../server/storage/sqlite.js')).closeSqliteDatabases();await fs.rm(config.dataDirectory,{recursive:true,force:true});}
