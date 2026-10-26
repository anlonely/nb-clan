import '../v2-baseline/loopback-only.mjs';
import {fixture as base} from '../v2-member-admin/fixtures.mjs';
import {createNativePlatformMetadata} from '../../../server/v2/management-adapters/platform-native/index.js';
import {installPlatformAdminSchema} from '../../../server/v2/platform-admin/repository.js';
import {PlatformAdminService} from '../../../server/v2/platform-admin/service.js';
import {createPlatformAdminRouter} from '../../../server/v2/platform-admin/routes.js';
import {createIdentityRouter} from '../../../server/v2/identity/routes.js';
import {createServer} from 'node:http';
import express from 'express';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
export async function fixture(){
 const f=base();f.ir.put('accounts',{...f.ir.get('accounts','admin'),roleId:'admin',adminAssignedByOwner:true});installPlatformAdminSchema(f.db);f.service=new PlatformAdminService({identity:f.identity,now:f.now});f.calls=[];f.tokens={discord:{botToken:'synthetic-discord-secret',revision:'1',transportKey:'discord'},kook:{botToken:'synthetic-kook-secret',revision:'1',transportKey:'kook'}};
 // Exercise the current platform-login requirement with synthetic, verified identities.
 f.ir.put('policies',{id:'native-login',provider:'discord',enabled:true,guildId:'100000000000000001',allowedRoleIds:['native-member'],matchMode:'any',policyRevision:1});
 f.identity.providers={discord:{roles:async(externalId,guildId)=>({externalId,guildId,roleIds:['native-member']})}};
 const evidence={};
 for(const [accountId,memberId]of [['admin','m064'],['viewer','m065']]){
  f.ir.put('accounts',{...f.ir.get('accounts',accountId),memberId});
  f.ir.put('bindings',{id:'native-binding-'+accountId,accountId,memberId,steamId:f.ir.get('members',memberId).steamId,status:'verified',revision:1});
  f.ir.put('identities',{id:'native-identity-'+accountId,accountId,provider:'discord',externalId:'native-'+accountId,revision:1});
  evidence[accountId]=await f.identity.checkEligibility('discord','native-'+accountId);
 }
 f.fault=null;f.ignoreAbort=false;
 const native=createServer(async(req,res)=>{let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):null;
  const platform=req.url.startsWith('/api/v10/')?'discord':'kook';assert.equal(req.headers.authorization,`Bot ${f.tokens[platform].botToken}`);
  f.calls.push({method:req.method,path:req.url,body});res.setHeader('Content-Type','application/json');
  if(f.fault&&await f.fault({req,res,body}))return;
  if(req.method==='POST'){res.statusCode=201;res.end(JSON.stringify({...body,id:'800000000000000001',application_id:'500000000000000001',guild_id:'100000000000000001',token:'must-not-leak'}));return;}
  if(platform==='discord')res.end(JSON.stringify(req.url.endsWith('/roles')?[{id:'100000000000000001',name:'Role',permissions:'8',token:'must-not-leak'}]:[{id:'200000000000000001',guild_id:'100000000000000001',type:0,name:'Text channel',token:'must-not-leak'}]));
  else{const q=new URL('http://127.0.0.1'+req.url).searchParams,page=Number(q.get('page')),roles=req.url.includes('guild-role');res.end(JSON.stringify({code:0,data:{items:roles?[{role_id:702,name:'管理员',permissions:2048}]:[{id:'kook-channel-'+page,name:'频道 '+page,type:1,is_category:false}],meta:{page,page_size:50,total:roles?1:51,page_total:roles?1:2}}}));}
 });await new Promise(r=>native.listen(0,'127.0.0.1',r));const nativeOrigin=`http://127.0.0.1:${native.address().port}`;
 f.owner=createNativePlatformMetadata({getPlatformService:()=>f.service,readCredentials:({platform,identity,db})=>{assert.equal(identity,f.identity);assert.equal(db,f.db);return f.tokens[platform];},
  fetchImpl:(url,init)=>{const u=new URL(url);assert.ok(['https://discord.com','https://www.kookapp.cn'].includes(u.origin));assert.equal(init.redirect,'error');assert.deepEqual(Object.keys(init.headers).sort(),(init.body?['Accept','Authorization','Content-Type']:['Accept','Authorization']).sort());return fetch(nativeOrigin+u.pathname+u.search,{...init,...(f.ignoreAbort?{signal:undefined}:{})});}});
 f.service.adapters.platform=f.owner.platformMetadata;
 for(const platform of ['discord','kook'])f.service.save(f.identity.actorForAccount('admin'),platform,{expectedRevision:0,config:{enabled:true,...(platform==='discord'?{applicationId:'500000000000000001'}:{}),targets:[{id:platform+'-target',enabled:true,guildId:'100000000000000001',channelId:'200000000000000001',enabledCommandIds:['kda','ranking','map']}],commands:[]}},{operationId:randomUUID()});
 const app=express(),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 const identities=createIdentityRouter({service:f.identity,origin,providers:{}});
 app.use('/api/v2',(req,res,next)=>{req.v2Identity={service:f.identity,authenticate:opts=>identities.authenticate(opts)(req)};next();},identities,createPlatformAdminRouter({getSystem:()=>({service:f.service})}));
 f.request=async(platform,action,input={},operationId=randomUUID(),actorId='admin')=>{const session=f.identity.issueSession(f.ir.get('accounts',actorId),evidence[actorId]);const r=await fetch(origin+`/api/v2/platform-admin/${platform}/actions/${action}`,{method:'POST',headers:{Origin:origin,Cookie:`nb_v2_session=${session.token}`,'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'Idempotency-Key':operationId},body:JSON.stringify({expectedRevision:f.service.config(platform).revision,targetId:platform+'-target',...input})});return {status:r.status,...await r.json()};};
 f.close=async()=>{await f.owner.stop();await identities.stopEvents();native.closeAllConnections();server.closeAllConnections();await Promise.all([new Promise(r=>native.close(r)),new Promise(r=>server.close(r))]);f.db.close();};return f;
}
