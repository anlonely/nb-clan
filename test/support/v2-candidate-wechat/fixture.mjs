// Controlled local app exchange and pre-existing member proofs; no production module imports this fixture.
import '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID,generateKeyPairSync} from 'node:crypto';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,createCandidateHost} from '../../../server/v2/candidate-host/index.js';
import {createIsolatedNotificationTransport} from '../../../server/v2/notification-platforms/isolated-transport.js';
import {createDiscordVerifier,createKookVerifier} from '../../../server/v2/notification-platforms/verifiers.js';
import {seedIdentities} from '../v2-member-space/fixtures.mjs';
import {pngFixture} from '../v2-system-admin/image-fixture.mjs';
export const appId='candidate_wechat_app';
export async function fixture(config,{wechat=true,enabled=true,exchange=true,notification=true,inbox=true,mini=true,media=true,wrongApp=false,seedMember=false,mediaPorts=true,ignoreExchangeAbort=false,bindingAppId=appId,pinnedRevision=1}={}){
 const password='Synthetic-Candidate-Wechat-Root-Password';await initializeCandidate(config,{rootPassword:password});
 const store=await import('../../../server/store.js');await store.updateStore(data=>{data.settings.wechat={appId};data.settings.discord={enabled:true,targets:[{id:'candidate-notification-channel',enabled:true,name:'Controlled notification channel',guildId:'400000000000000001',channelId:'400000000000000003'}]};return true;});
 const storage=await import('../../../server/storage/sqlite.js');await storage.closeSqliteDatabases();const p=await planCandidateMigration(config);await applyCandidateMigration(config,p,{expectedDigest:p.digest,operatorId:'user_root'});
 if(seedMember){const {IdentityRepository}=await import('../../../server/v2/identity/repository.js'),repo=new IdentityRepository(await storage.openSqliteDatabase());seedIdentities(repo);repo.put('identities',{id:'candidate-mini-alpha',provider:`wechat:${appId}`,externalId:'controlled_existing_member',accountId:'g05_account_alpha',verifiedAt:new Date().toISOString(),revision:1});repo.put('wechatUsers',{id:'candidate-existing-wx',appId,openid:'controlled_existing_member',accountId:'g05_account_alpha',memberId:'g05_alpha',status:'approved',revision:1});}
 let interceptor;const calls=[],tickets=new Map();let f;
 const upstream=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');const chunks=[];for await(const c of req)chunks.push(c);const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
  calls.push({path:u.pathname,method:req.method,insideTransaction:f?.identity.repo.db.isTransaction===true});if(interceptor)await interceptor({path:u.pathname,body});
  if(u.pathname==='/controlled-code-exchange'){const openid=tickets.get(body.code);tickets.delete(body.code);res.setHeader('content-type','application/json');if(!openid){res.statusCode=401;res.end(JSON.stringify({error:'CODE_INVALID'}));return;}res.end(JSON.stringify({appId:wrongApp?'wrong_app':body.appId,openid}));}
  else if(u.pathname==='/controlled-access-token'){res.setHeader('content-type','application/json');res.end(JSON.stringify({accessToken:'controlled-share-access-token'}));}
  else if(u.pathname==='/controlled-share-code'){assert.equal(body.accessToken,'controlled-share-access-token');res.setHeader('content-type','image/png');res.end(pngFixture(16,16));}
  else{res.statusCode=404;res.end();}
 }catch(e){res.statusCode=500;res.end(JSON.stringify({error:'CONTROLLED_UPSTREAM_ERROR'}));}});
 await new Promise(r=>upstream.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${upstream.address().port}`;
 const native=async(path,body,signal)=>fetch(url+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
 const binding={enabled,appId:bindingAppId,configurationRevision:pinnedRevision,capabilities:{mini,inbox,media},
  ...(exchange?{exchangeCode:async args=>{args.assertCurrent();const response=await native('/controlled-code-exchange',{code:args.code,appId:args.appId},ignoreExchangeAbort?undefined:args.signal);assert.equal(response.status,200);const proof=await response.json();args.assertCurrent();return {...proof,verified:true};}}:{}),
  media:mediaPorts?{getAccessToken:async args=>{args.assertCurrent();const response=await native('/controlled-access-token',{},args.signal),body=await response.json();args.assertCurrent();return {appId:args.appId,generation:args.generation,accessToken:body.accessToken};},exchangeCode:async args=>{args.assertCurrent();return native('/controlled-share-code',{accessToken:args.accessToken},args.signal);}}:{}};
 const pair=generateKeyPairSync('ed25519'),transport=createIsolatedNotificationTransport(),bindings={...(wechat?{wechat:binding}:{}),...(notification?{notifications:{transport,transportKey:()=> 'controlled-notification-transport',verifiers:{discord:createDiscordVerifier({publicKey:pair.publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex'),applicationId:'400000000000000004'}),kook:createKookVerifier({verifyToken:'controlled-kook-verify-token'})}}}:{})};
 const host=createCandidateHost(config,{bindings}),status=await host.start(),origin=status.origin,owners=host.owners(),identity=await owners.api.v2Runtime.getIdentity(),managed=owners.management.getSystem(identity);let cookie='',csrf='';
 async function request(route,{body,method=body===undefined?'GET':'POST',key=randomUUID(),token,auth=true,csrfToken=csrf,originHeader=origin,raw=false}={}){const response=await fetch(origin+'/api/v2'+route,{method,headers:{...(auth?{Cookie:cookie}:{}),...(token?{Authorization:'Bearer '+token}:{}),Origin:originHeader,'Content-Type':'application/json','Idempotency-Key':key,'X-CSRF-Token':csrfToken},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:raw?Buffer.from(await response.arrayBuffer()):await response.json(),headers:response.headers};}
 identity.ownerPasswordLogin=true; // Explicit owner recovery login for this isolated HTTP fixture.
 const login=await request('/auth/owner-password',{body:{username:'root',password}});assert.equal(login.status,200,JSON.stringify(login.body));cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');csrf=login.body.data.csrfToken;
 const notice=owners.notifications.getSystem(identity);
 f={host,owners,identity,managed,notice,origin,request,binding,transport,calls,setInterceptor:fn=>interceptor=fn,
  code(openid='controlled_new_subject'){const code=randomUUID();tickets.set(code,openid);return code;},
  async drain(){await owners.management.tick();if(notification)await notice.worker.runOnce({workerId:'controlled-candidate-notification-worker',limit:100});},
  close:async()=>{try{await host.stop();}finally{upstream.closeAllConnections();await new Promise(r=>upstream.close(r));}}};return f;
}
