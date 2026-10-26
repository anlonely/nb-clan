import '../v2-candidate-host/test-guard.mjs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {initializeCandidate,planCandidateMigration,applyCandidateMigration,createCandidateHost} from '../../../server/v2/candidate-host/index.js';
import {seedIdentities} from '../v2-member-space/fixtures.mjs';
export const memberId='g05_alpha',accountId='g05_account_alpha',steamId='76561198000000501';
const password='Controlled-Candidate-Providers-Vip-Password';
export async function fixture(config,{bindings={},seed=()=>{},reopen=false}={}){
 const storage=await import('../../../server/storage/sqlite.js');
 if(!reopen){await initializeCandidate(config,{rootPassword:password});const store=await import('../../../server/store.js');await store.updateStore(data=>{data.settings.steamWebApi={apiKey:'controlled-candidate-steam-key'};data.settings.accountRisk={revision:1,rules:[{id:'inventory',type:'inventory_value',enabled:true,threshold:10,operator:'gt'}]};return true;});await storage.closeSqliteDatabases();const plan=await planCandidateMigration(config);await applyCandidateMigration(config,plan,{expectedDigest:plan.digest,operatorId:'user_root'});
  const {IdentityRepository}=await import('../../../server/v2/identity/repository.js'),repo=new IdentityRepository(await storage.openSqliteDatabase());seedIdentities(repo);await seed(repo);
 }
 const host=createCandidateHost(config,{bindings}),status=await host.start(),owners=host.owners(),identity=await owners.api.v2Runtime.getIdentity(),system=owners.management.getSystem(identity),origin=status.origin;let cookie='',csrf='';
 async function request(route,{body,method=body===undefined?'GET':'POST',auth=true,key=randomUUID(),csrfToken=csrf,raw=false}={}){const response=await fetch(origin+'/api/v2'+route,{method,headers:{...(auth?{Cookie:cookie}:{}),Origin:origin,'content-type':'application/json','X-CSRF-Token':csrfToken,'Idempotency-Key':key},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=raw?null:await response.text();let parsed;if(!raw)try{parsed=JSON.parse(text);}catch{throw Error(route+' returned '+response.status+' non-JSON '+text.slice(0,120));}return {status:response.status,body:raw?Buffer.from(await response.arrayBuffer()):parsed,headers:response.headers};}
 identity.ownerPasswordLogin=true; // Explicit owner recovery login for this isolated HTTP fixture.
 const login=await request('/auth/owner-password',{body:{username:'root',password}});assert.equal(login.status,200,JSON.stringify(login.body));cookie=login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');csrf=login.body.data.csrfToken;
 const expect=async(route,args,status=200)=>{const r=await request(route,args);assert.equal(r.status,status,route+': '+JSON.stringify(r.body));return r.body.data;};
 return {host,owners,identity,system,origin,request,expect,tick:()=>owners.management.tick(),close:()=>host.stop()};
}
export async function bounded(p,label){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Timeout '+label)),20000))]);}finally{clearTimeout(timer);}}
