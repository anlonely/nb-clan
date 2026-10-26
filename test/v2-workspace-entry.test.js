import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import express from 'express';
import { installIdentitySchema, IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { legacyFingerprint } from '../server/v2/identity/migration.js';
import { createIdentityRouter } from '../server/v2/identity/routes.js';
import { installSchedulingSchema, SchedulingRepository } from '../server/v2/scheduling/repository.js';
import { grant } from '../server/v2/identity/permissions.js';
import { MemberSpaceService } from '../server/v2/member-space/service.js';
import { createMemberSpaceRouter } from '../server/v2/member-space/routes.js';
import { workspaceForLocation, needsWorkspaceSession, workspaceAuthReturnTo, canOpenWorkspace } from '../src/v2/router.js';
import { createAuthFlow, sessionAuthReturnTo } from '../src/v2/auth-flow.js';
import { createQueryClient } from '../src/v2/query-client.js';

const all = { type: 'all' }, squads = (...ids) => ({ type: 'squads', ids }), wipes = (...ids) => ({ type: 'wipes', ids });
const allow = (cap, scope = all) => grant(cap, scope), deny = (cap, scope = all) => ({ capability: cap, scope, effect: 'deny' });

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  installIdentitySchema(db); installSchedulingSchema(db);
  t.after(() => db.close());
  const repo = new IdentityRepository(db), sr = new SchedulingRepository(db);
  repo.setScalar('v2IdentityMigration', { sourceHash: 'isolated-workspace-test' });
  sr.setScalar('v2SchedulingMigration', { sourceHash: 'isolated-workspace-test' });
  const identity = new IdentityService(repo, { ownerPasswordLogin: true }), service = new MemberSpaceService(identity);
  for (const id of ['s1', 's2']) repo.put('squads', { id, name: id });
  function account(id, grants = [], memberId = null, roleId = 'member') {
    const a = { id, memberId, status: 'active', permissionVersion: 1, revision: 1, roleId, grants };
    repo.put('accounts', a);
    if (memberId) {
      const steamId = `7656119800000${memberId === 'm1' ? '0001' : '0002'}`;
      repo.put('members', { id: memberId, displayName: `private-name-${memberId}`, avatar: 'private-avatar', steamId,
        memberStatus: 'active', revision: 1, phone: 'private-phone', internalNote: 'private-note' });
      repo.put('bindings', { id: `b-${id}`, accountId: id, memberId, steamId, status: 'verified' });
      repo.put('squadMembers', { id: `sm-${memberId}`, memberId, squadId: memberId === 'm1' ? 's1' : 's2' });
    }
    return a;
  }
  function wipe(id, squadIds) {
    sr.put('wipes', { id, revision: 1, contentRevision: 1, lifecycle: 'draft',
      audience: { squadIds, memberIds: [], includeUnassigned: false } });
  }
  const bootstrap = id => service.bootstrap(identity.actorForAccount(id), 'local-csrf');
  return { db, repo, sr, identity, service, account, wipe, bootstrap };
}

test('workspace navigation ignores legacy custom grants and untrusted owner labels', t => {
  const f=fixture(t);
  f.account('member',[], 'm1');
  assert.deepEqual(f.bootstrap('member').workspaces,{member:true,admin:false});
  for (const [id,roleId,grants] of [['forged-owner','owner',[allow('system.permissions')]],['legacy-admin','admin',[allow('wipes.create')]],['scoped-member','member',[allow('sync.read'),allow('wipes.create',squads('s1'))]]]) {
    f.account(id,grants,null,roleId);
    assert.deepEqual(f.bootstrap(id).managementSections,[]);
    assert.deepEqual(f.bootstrap(id).workspaces,{member:false,admin:false});
  }
  const actor=f.identity.actorForAccount('member');
  assert.equal(f.service.bootstrap({...actor,grants:[allow('system.permissions')]},'csrf').workspaces.admin,false);
});

test('owner-assigned administrator can enter the empty workspace without exposing member records', t => {
  const f=fixture(t);f.account('private-member',[],'m1');
  const admin=f.account('admin',[],null,'admin');f.repo.put('accounts',{...admin,adminAssignedByOwner:true});
  const before=f.db.prepare('SELECT total_changes() n').get().n;f.db.exec('PRAGMA query_only=ON');
  const dto=f.bootstrap('admin');
  assert.deepEqual(dto.workspaces,{member:false,admin:true});assert.equal(dto.member,null);
  assert.ok(dto.managementSections.some(section=>section.path==='/admin/wipes'));
  assert.equal(JSON.stringify(dto).includes('private-name'),false);
  assert.throws(()=>f.service.me(f.identity.actorForAccount('admin')),{errorCode:'MEMBER_VERIFICATION_REQUIRED'});
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
});

test('workspace authority rechecks owner assignment and permission revision rather than accepting a stale actor', t => {
  const f=fixture(t);const admin=f.account('admin',[],null,'admin');
  f.repo.put('accounts',{...admin,adminAssignedByOwner:true});const actor=f.identity.actorForAccount('admin');
  assert.equal(f.bootstrap('admin').workspaces.admin,true);
  f.repo.put('accounts',{...admin,adminAssignedByOwner:false,permissionVersion:2});
  assert.throws(()=>f.service.bootstrap(actor,'csrf'),{errorCode:'PERMISSIONS_CHANGED'});
  assert.deepEqual(f.bootstrap('admin').workspaces,{member:false,admin:false});
});

test('cold admin and login routes request the common session and preserve safe management returnTo', () => {
  for (const path of ['/admin', '/admin/wipes/w1?tab=history#row', '/app/home', '/login?returnTo=%2Fadmin%2Fwipes', '/help'])
    assert.equal(needsWorkspaceSession(path), true, path);
  for (const path of ['/auth/continue', '/administrator', '//evil.invalid/admin', '/admin/%2e%2e/login'])
    assert.equal(needsWorkspaceSession(path), false, path);
  assert.equal(workspaceForLocation('/admin/wipes/w1'), 'admin');
  assert.equal(workspaceAuthReturnTo('/admin'), '/admin/wipes');
  assert.equal(workspaceAuthReturnTo('/admin/?tab=history#row'), '/admin/wipes?tab=history#row');
  assert.equal(workspaceAuthReturnTo('/admin/wipes/w1?tab=history#row'), '/admin/wipes/w1?tab=history#row');
  assert.equal(workspaceAuthReturnTo('/login?returnTo=%2Fadmin%2Fwipes%2Fw1%3Ftab%3Dhistory%23row'), '/admin/wipes/w1?tab=history#row');
  for (const target of ['https://evil.invalid', '//evil.invalid', '/admin/%2e%2e/login', '/admin/a%2fb'])
    assert.equal(workspaceAuthReturnTo(target), '/app/home');
});

test('page access uses only explicit bootstrap workspace booleans and keeps safe default navigation', () => {
  assert.equal(canOpenWorkspace({ roleId: 'admin', grants: [allow('wipes.create')] }, '/admin/wipes'), false);
  assert.equal(canOpenWorkspace({ workspaces: { admin: 'true' } }, '/admin/wipes'), false);
  assert.equal(canOpenWorkspace({ workspaces: { admin: true } }, '/admin/wipes'), true);
  assert.equal(canOpenWorkspace({ workspaces: { member: true, admin: false } }, '/admin/wipes'), false);
  const manager = { workspaces: { member: false, admin: true } };
  assert.equal(sessionAuthReturnTo(null, manager), '/admin/wipes');
  assert.equal(sessionAuthReturnTo('/admin/wipes/w1?tab=history#row', manager), '/admin/wipes/w1?tab=history#row');
  assert.equal(sessionAuthReturnTo('/app/wipes/w1', manager), '/app/wipes/w1');
  assert.equal(sessionAuthReturnTo('//evil.invalid', manager), '/admin/wipes');
});

test('successful password adoption sends an unbound manager to the authorized workspace', async () => {
  const adopted = { accountId: 'admin', workspaces: { member: false, admin: true } }, navigation = [];
  const client = createQueryClient({ fetchImpl: async () => ({ ok: true, status: 200,
    json: async () => ({ data: { returnTo: '/app/home' }, meta: {} }) }) });
  const flow = createAuthFlow({ client, continuing: false, returnTo: '/app/home', onChange() {},
    go: (path, options) => navigation.push({ path, options }), refreshSession: async () => { client.setIdentity({ accountId: adopted.accountId, scopeVersion: 1 }); return adopted; } });
  await flow.passwordLogin({ username: 'admin', password: 'isolated' });
  assert.deepEqual(navigation, [{ path: '/admin/wipes', options: { replace: true } }]);
  flow.dispose();
});

test('real HTTP bootstrap is read-only for the installed owner and rejects retired password sessions', async t => {
  const f = fixture(t);
  const root = {id:'user_root',username:'root',role:'admin'};
  f.repo.put('users',root);
  f.repo.put('accounts',{...f.account('user_root',[],null,'admin'),legacyUserId:'user_root',legacyFingerprint:legacyFingerprint(root,f.repo.all('permissionRoles'))});
  f.repo.setScalar('v2InstallationOwner',{version:1,accountId:'user_root'});
  f.account('ordinary',[], 'm1');
  const app = express(), server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const auth = createIdentityRouter({service:f.identity,origin,providers:{},steam:{}});
  app.use('/api/v2',(req,_res,next)=>{req.v2Identity={service:f.identity,authenticate:options=>auth.authenticate(options)(req)};next();});
  app.use('/api/v2',auth,createMemberSpaceRouter());
  const request=async(path,session)=>{
    const response=await fetch(`${origin}/api/v2${path}`,{headers:session?{cookie:`nb_v2_session=${session.token}; nb_v2_csrf=${session.csrfToken}`}:{}});
    return {response,body:await response.json()};
  };
  assert.equal((await request('/bootstrap')).response.status,401);
  const owner=f.identity.issueSession(f.repo.get('accounts','user_root'),{provider:'owner_password'});
  const ordinary=f.identity.issueSession(f.repo.get('accounts','ordinary'));
  const before=f.db.prepare('SELECT total_changes() n').get().n;
  f.db.exec('PRAGMA query_only=ON');
  const {response,body}=await request('/bootstrap',owner);
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(body.data.csrfToken,owner.csrfToken);assert.equal(body.data.member,null);
  assert.deepEqual(body.data.workspaces,{member:false,admin:true});
  assert.equal(JSON.stringify(body).includes('private-name'),false);
  assert.equal((await request('/me/home',owner)).response.status,403);
  assert.equal((await request('/bootstrap',ordinary)).response.status,403);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
  f.db.exec('PRAGMA query_only=OFF');
  f.identity.ownerPasswordLogin=false;
  assert.equal((await request('/bootstrap',owner)).response.status,403);
});
