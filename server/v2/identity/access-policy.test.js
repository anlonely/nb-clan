import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from './repository.js';
import { IdentityService } from './service.js';
import { legacyFingerprint } from './migration.js';
import { roleGrants, can } from './permissions.js';
import { createSystemIdentityAdapter } from '../system-admin/identity-adapter.js';
import { isTrustedRoot, allowed } from '../system-admin/access.js';
const OWNER_STEAM_ID = '76561198000000009';
function fixture(t) {
 const db=new DatabaseSync(':memory:');installIdentitySchema(db);t.after(()=>db.close());const repo=new IdentityRepository(db);
 let roles=['eligible'];const providers=Object.fromEntries(['discord','kook'].map(provider=>[provider,{roles:async(externalId,guildId)=>({externalId,guildId,roleIds:roles})}]));
 const service=new IdentityService(repo,{providers});
 repo.setScalar('v2InstallationOwner',{version:1,accountId:'user_root'});
 repo.put('users',{id:'user_root',username:'root'});
 for(const provider of ['discord','kook'])repo.put('policies',{id:provider,provider,enabled:true,guildId:'g',allowedRoleIds:['eligible'],matchMode:'any',defaultRoleId:'member',policyRevision:1});
 function account(id,steam,extra={}){if(id==='owner')id='user_root';repo.put('members',{id:'m'+id,steamId:steam,memberStatus:'active',revision:1});repo.put('accounts',{id,memberId:'m'+id,status:'active',roleId:'member',revision:1,permissionVersion:1,...(id==='user_root'?{legacyUserId:'user_root',legacyFingerprint:legacyFingerprint(repo.get('users','user_root'),[])}:{}),...extra});repo.put('bindings',{id:'b'+id,accountId:id,memberId:'m'+id,steamId:steam,status:'verified',revision:1});repo.put('identities',{id:'i'+id,accountId:id,provider:'kook',externalId:'k'+id,revision:1});return service.actorForAccount(id);}
 return {repo,service,account,setRoles:r=>{roles=r;}};
}
test('only the explicitly installed owner has authority; legacy grants cannot promote other accounts',t=>{
 const f=fixture(t),owner=f.account('owner',OWNER_STEAM_ID),old=f.account('old-root','76561198000000001',{roleId:'admin',grants:roleGrants('owner')});
 assert.equal(owner.roleId,'owner');assert.equal(isTrustedRoot(f.service,owner),true);assert.equal(old.roleId,'member');assert.equal(allowed(f.service,old,'accounts'),false);
 assert.equal(can(old,'members.read',{kind:'member',id:'mowner'},f.service.relations()),false);
 assert.equal(can(old,'members.read',{kind:'member',id:old.memberId},f.service.relations()),true);
 const a=f.repo.get('accounts','user_root');f.repo.setScalar('v2InstallationOwner',null);assert.equal(f.service.actorForAccount(a.id).roleId,'member');
});
test('owner appoints/removes admins; admin cannot promote, modify owner, or edit a custom matrix',t=>{
 const f=fixture(t),owner=f.account('owner',OWNER_STEAM_ID),member=f.account('member','76561198000000001'),adapter=createSystemIdentityAdapter(f.service);
 const tx=()=>({events:[],changedAccounts:new Set()});
 adapter.apply(owner,'account.role',member.id,{expectedRevision:1,roleId:'admin'},tx());
 const admin=f.service.actorForAccount(member.id);assert.equal(admin.roleId,'admin');assert.equal(allowed(f.service,admin,'accounts'),true);assert.equal(allowed(f.service,admin,'permissions'),false);
 const other=f.account('other','76561198000000002');assert.throws(()=>adapter.apply(admin,'account.role',other.id,{expectedRevision:1,roleId:'admin'},tx()),/ROLE_ESCALATION/);
 assert.throws(()=>adapter.apply(admin,'account.password',owner.id,{expectedRevision:1,passwordHash:'x'},tx()),/PROTECTED_ACCOUNT/);
 assert.throws(()=>adapter.apply(owner,'role.save','custom',{},tx()),/FIXED_ROLE_PERMISSIONS/);
 adapter.apply(owner,'account.role',member.id,{expectedRevision:2,roleId:'member'},tx());assert.equal(f.service.actorForAccount(member.id).roleId,'member');
});
test('Steam-only account is denied; bound community roles are rechecked for Steam login',async t=>{
 const f=fixture(t);f.account('member','76561198000000001');const candidate=f.service.steamLoginAccount('76561198000000001');
 const proof=await f.service.steamLoginEvidence(candidate);const result=f.service.completeSteamLogin('76561198000000001',candidate,proof,{});assert.equal(f.service.session(result.token).session.identityProvider,'kook');
 f.setRoles([]);await assert.rejects(f.service.steamLoginEvidence(candidate),/ELIGIBILITY_DENIED/);
 f.repo.remove('identities','imember');assert.throws(()=>f.service.steamLoginAccount('76561198000000001'),/PLATFORM_LOGIN_REQUIRED/);
 f.repo.put('members',{id:'standalone',steamId:'76561198000000002',memberStatus:'active'});assert.throws(()=>f.service.steamLoginAccount('76561198000000002'),/PLATFORM_LOGIN_REQUIRED/);
});
test('platform onboarding requires Steam proof before login and old password sessions fail',async t=>{
 const f=fixture(t),profile={provider:'discord',id:'new',displayName:'New'};const evidence=await f.service.checkEligibility('discord','new');const context=f.service.login(profile,evidence);assert.equal(context.step,'steam');assert.equal(f.repo.all('sessions').length,0);
 const result=f.service.bind(profile,'76561198000000001',evidence,context);const state=f.service.session(result.token);assert.equal(state.actor.roleId,'member');await f.service.requireFreshEligibility(state.session);
 await assert.rejects(f.service.requireFreshEligibility({...state.session,identityProvider:'password'}),/PLATFORM_LOGIN_REQUIRED/);
});
test('self closure leaves clan, disables own account and revokes sessions; owner cannot close',async t=>{
 const f=fixture(t),owner=f.account('owner',OWNER_STEAM_ID),member=f.account('member','76561198000000001');const evidence=await f.service.checkEligibility('kook','kmember');const login=f.service.issueSession(f.repo.get('accounts',member.id),evidence);
 f.repo.put('squadMembers',{id:'sm',memberId:member.memberId,squadId:'s',validTo:null});
 assert.throws(()=>f.service.closeAccount(owner),/PROTECTED_ACCOUNT/);assert.equal(f.service.closeAccount(member).closed,true);assert.equal(f.repo.get('members',member.memberId).memberStatus,'left');assert.equal(f.repo.get('accounts',member.id).status,'disabled');assert.ok(f.repo.get('squadMembers','sm').validTo);assert.throws(()=>f.service.session(login.token),/AUTH_REQUIRED/);
});
test('owner password sessions require explicit runtime opt-in and reject legacy passwords and other accounts', async t => {
 const f=fixture(t),owner=f.account('owner',OWNER_STEAM_ID),member=f.account('member','76561198000000001');
 f.service.ownerPasswordLogin=true;
 const result=f.service.issueSession(f.repo.get('accounts',owner.id),{provider:'owner_password'});
 const state=f.service.session(result.token);
 await f.service.requireFreshEligibility(state.session);
 await assert.rejects(f.service.requireFreshEligibility({...state.session,identityProvider:'password'}),/PLATFORM_LOGIN_REQUIRED/);
 await assert.rejects(f.service.requireFreshEligibility({...state.session,accountId:member.id}),/PLATFORM_LOGIN_REQUIRED/);
 f.service.ownerPasswordLogin=false;
 await assert.rejects(f.service.requireFreshEligibility(state.session),/PLATFORM_LOGIN_REQUIRED/);
});
