import { fixtureIdentity } from '../scoped-identity-fake.mjs';
import { fixtureSessionFactory } from '../authenticated-session.mjs';
import '../v2-source-main/offline.mjs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import express from 'express';
import { hashPassword, runStoreWriteTask } from '../../../server/store.js';
import { validateRustplusRelayTokenHash } from '../../../server/rustplus-relay.js';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { AuthContexts } from '../../../server/v2/identity/contexts.js';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { createSystemPasswordProofAdapter } from '../../../server/v2/system-admin/password-proof.js';
import { legacyFingerprint } from '../../../server/v2/identity/migration.js';
import { migrateLegacyGrants, grant } from '../../../server/v2/identity/permissions.js';
import { createRelayAdmin, createRelayAdminRouter, installRelayAdminSchema } from '../../../server/v2/relay-admin/index.js';
export const password='test-Isolated-Relay-Admin-Password-2026',tokenA='constructed-relay-token-alpha',tokenB='constructed-relay-token-bravo';
const base=fileURLToPath(new URL('./.runtime/',import.meta.url));
export async function fixture(options={}) {
 await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'run-')),databaseFile=path.join(directory,'fixture.sqlite'),db=new DatabaseSync(databaseFile);db.exec('PRAGMA journal_mode=WAL');installIdentitySchema(db);const repo=new IdentityRepository(db);repo.setScalar('v2IdentityMigration',{isolated:true});
 const roleRows=[['api_view',{api:{view:true}}],['api_edit',{api:{view:true,edit:true}}],['tools_view',{rustTools:{view:true}}],['tools_edit',{rustTools:{view:true,edit:true}}],['clan_only',{rustClanInfo:{view:true,edit:true}}],['deny_all',{}]];
 for(const [code,permissions] of roleRows)repo.put('permissionRoles',{id:code,code,name:code,permissions});
 const roles=repo.all('permissionRoles'),passwordHash=await hashPassword(password);
 for(const [id,role] of [['root','admin'],['admin','admin'],['viewer','viewer'],...roleRows.map(([id])=>[id,id])]){
  const user={id:id==='root'?'user_root':'legacy_'+id,username:id,role,passwordHash,createdAt:new Date().toISOString()};repo.put('users',user);
  repo.put('accounts',{id,legacyUserId:user.id,legacyFingerprint:legacyFingerprint(user,roles),roleId:role,status:'active',memberId:null,revision:1,permissionVersion:1,grants:migrateLegacyGrants(user,{permissionRoles:roles}).grants});
 }
 for(const [id,grants] of [['native_api',[grant('system.api_keys',{type:'all'})]],['native_relay',[grant('relay.read',{type:'all'})]],['native_scoped',[grant('system.api_keys',{type:'self'})]]])repo.put('accounts',{id,roleId:'custom',status:'active',revision:1,permissionVersion:1,memberId:null,grants});
 repo.setScalar('settings',{rustplusRelay:{tokenHash:'',tokenUpdatedAt:'',lastError:'previous-fixture-error',discordForwarding:{enabled:false},untouched:'keep'},publicApi:{tokenHash:'fixture-public-token-hash-untouched'},other:{nested:'keep'}});
 const identity=fixtureIdentity(repo,{scopeContract:options.scopeContract===true}),contexts=new AuthContexts();installRelayAdminSchema(db,{apply:true});
 const hooks={},cache={settings:structuredClone(repo.scalar('settings'))};let invalidations=0,patches=0,hashes=0,cachedHash=null;
 const invalidateRelayAuthCache=()=>{invalidations++;const value=hooks.invalidate?.();if(value!==undefined)return value;cachedHash=null;};
 const patchStoreCache=async fn=>{patches++;await hooks.beforeCache?.();fn(cache);};
 const hashToken=async token=>{hashes++;await hooks.beforeHash?.();return hashPassword(token);};
 const service=createRelayAdmin({identity,patchStoreCache,hashToken,...(options.missingInvalidator?{}:{invalidateRelayAuthCache})});service.start();
 const verify=async token=>{if(cachedHash===null)cachedHash=repo.scalar('settings').rustplusRelay?.tokenHash||'';await validateRustplusRelayTokenHash({headers:{authorization:'Bearer '+token}},cachedHash);};
 return {directory,databaseFile,db,repo,identity,contexts,service,hooks,cache,invalidateRelayAuthCache,patchStoreCache,hashToken,verify,actor:id=>identity.actorForAccount(id),revision:(id='root')=>service.read(identity.actorForAccount(id)).revision,counters:()=>({invalidations,patches,hashes}),async close(){await service.stop();db.close();await rm(directory,{recursive:true,force:true});}};
}
export async function httpFixture(options={}) {
 const f=await fixture(options),app=express(),server=createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin=`http://127.0.0.1:${server.address().port}`;
 for(const id of ['root','admin','api_edit','tools_edit']) f.repo.put('accounts',{...f.repo.get('accounts',id),roleId:'admin',adminAssignedByOwner:true});
 const auth=createIdentityRouter({service:f.identity,contexts:f.contexts,origin,providers:{},passwordProof:createSystemPasswordProofAdapter(f.identity),writeIdentity:runStoreWriteTask});
 app.use('/api/v2',(req,res,next)=>{req.v2Identity={service:f.identity,authenticate:opts=>auth.authenticate(opts)(req)};auth(req,res,next);});
 app.use('/api/v2',createRelayAdminRouter({service:f.service}));
 // Only an auth assertion sink; actual original verifier, no relay business/event handlers or messages.
 app.post('/fixture/relay-auth',async(req,res)=>{try{await f.verify(String(req.headers.authorization||'').replace(/^Bearer\s+/i,''));res.sendStatus(204);}catch(e){res.status(e.status||503).json({error:{errorCode:'RELAY_AUTH_DENIED'}});}});
 app.use((e,req,res,next)=>res.status(e.status||503).json({error:{errorCode:e.errorCode||'UNAVAILABLE'}}));
 const session=await fixtureSessionFactory(f.identity);
 return {...f,app,origin,session,async close(){await auth.stopEvents();server.closeAllConnections();await new Promise(r=>server.close(r));await f.close();}};
}
