import './support/owner-environment.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture } from './support/v2-system-admin/fixtures.mjs';
import { upsertSqliteCollectionRecord } from '../server/storage/sqlite-migrate.js';
import { grant, roleGrants, OWNER_STEAM_ID } from '../server/v2/identity/permissions.js';
import { migrateSystemAdmin } from '../server/v2/system-admin/repository.js';
const setup=async(t,options)=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'g07-system-test-'));const f=await fixture(dir,options);t.after(async()=>{await f.close();fs.rmSync(dir,{recursive:true,force:true});});return f;};
const command=(f,action,input,target='',actor='root',id=randomUUID())=>f.service.command(f.actor(actor),action,target,input,id);
const code=(c)=>e=>e.errorCode===c;

test('account batch changes are atomic and deleted accounts can be found and restored',async t=>{
 const f=await setup(t),root=f.repo.get('accounts','root');
 const entries=()=>['member','viewer'].map(id=>({id,expectedRevision:f.repo.get('accounts',id).revision}));
 await assert.rejects(command(f,'account.batch',{expectedRevision:0,mode:'delete',accounts:[entries()[0],{id:'viewer',expectedRevision:0}]}),code('REVISION_CONFLICT'));
 assert.equal(f.repo.get('accounts','member').deletedAt,undefined);
 const disabled=await command(f,'account.batch',{expectedRevision:0,mode:'status',status:'disabled',accounts:entries()});
 assert.deepEqual(disabled.items.map(a=>a.status),['disabled','disabled']);
 const removed=await command(f,'account.batch',{expectedRevision:1,mode:'delete',accounts:entries()});
 assert.ok(removed.items.every(a=>a.deleted));
 assert.ok(!f.service.read(f.actor('root'),'accounts').items.some(a=>a.id==='member'));
 assert.ok(f.service.read(f.actor('root'),'accounts',{deleted:'1'}).items.some(a=>a.id==='member'));
 const restored=await command(f,'account.batch',{expectedRevision:2,mode:'status',status:'active',accounts:entries()});
 assert.ok(restored.items.every(a=>a.status==='active'&&!a.deleted));
 const changed=await command(f,'account.batch',{expectedRevision:3,mode:'role',roleId:'admin',accounts:entries()});
 assert.ok(changed.items.every(a=>a.roleId==='admin'));
 await assert.rejects(command(f,'account.batch',{expectedRevision:4,mode:'delete',accounts:[{id:'root',expectedRevision:f.repo.get('accounts','root').revision}]}),code('PROTECTED_ACCOUNT'));
});

test('account list exposes and searches the linked Steam nickname',async t=>{
 const f=await setup(t),root=f.repo.get('accounts','root'),account=f.repo.get('accounts','member');
 f.repo.put('members',{id:'steam-nick-member',steamId:'76561198000000001',steamNickname:'Steam Nick',revision:1});
 f.repo.put('accounts',{...account,memberId:'steam-nick-member'});
 let item=f.service.read(f.actor('root'),'accounts',{q:'steam nick'}).items.find(row=>row.id==='member');
 assert.equal(item?.steamNickname,'Steam Nick');
 f.repo.put('members',{id:'steam-nick-member',steamId:'76561198000000001',steamNickname:'',revision:2});
 upsertSqliteCollectionRecord(f.db,'memberProfiles','wrong-steam-profile',{id:'wrong-steam-profile',memberId:'other-member',steamId:'76561198000000001',displayName:'Wrong Steam Nick'});
 assert.equal(f.service.read(f.actor('root'),'accounts').items.find(row=>row.id==='member').steamNickname,'');
 upsertSqliteCollectionRecord(f.db,'memberProfiles','steam-profile',{id:'steam-profile',memberId:'steam-nick-member',steamId:'76561198000000001',displayName:'Profile Nick'});
 item=f.service.read(f.actor('root'),'accounts',{q:'profile nick'}).items.find(row=>row.id==='member');
 assert.equal(item?.steamNickname,'Profile Nick');
});

test('storage metadata pagination reaches every artifact without an unbounded response',async t=>{
 const f=await setup(t);for(let i=0;i<205;i++)f.service.repo.putArtifact({id:randomUUID(),kind:'logo',state:'active',revision:1,bytes:10,sha256:'a'.repeat(64),createdAt:new Date().toISOString()});
 const ids=new Set();let cursor='',pages=0;
 do{const page=f.service.read(f.actor('root'),'storage',{cursor});assert.ok(page.artifacts.length<=100);for(const a of page.artifacts){assert.ok(!ids.has(a.id));ids.add(a.id);}cursor=page.nextCursor;pages++;}while(cursor);
 assert.equal(ids.size,205);assert.equal(pages,3);assert.throws(()=>f.service.read(f.actor('member'),'storage',{cursor:randomUUID()}),code('ACCESS_DENIED'));
});

test('explicit migration is idempotent and GET never changes settings or schema',async t=>{
 const f=await setup(t),before=f.db.prepare('SELECT total_changes() n').get().n;
 for(const area of ['brand','storage','proxy','logs','api_keys','accounts','permissions'])f.service.read(f.actor('root'),area);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(migrateSystemAdmin(f.db).required,false);assert.equal(migrateSystemAdmin(f.db,{apply:true}).schemaVersion,1);
});
test('only the verified owner can manage permissions and unassigned labels remain unprivileged',async t=>{
 const f=await setup(t);
 for(const actor of ['admin','impostor']) assert.throws(()=>f.service.read(f.actor(actor),'permissions'),code('ACCESS_DENIED'));
 assert.equal((await command(f,'storage.backup',{expectedRevision:0},'','admin')).state,'succeeded');
 await assert.rejects(command(f,'proxy.save',{expectedRevision:0,url:'',scope:'global'},'','impostor'),code('ACCESS_DENIED'));
 assert.ok(f.service.read(f.actor('admin'),'brand'));
 const unverified=await setup(t,{trustedRoot:false});
 assert.throws(()=>unverified.service.read(unverified.actor('root'),'permissions'),code('ACCESS_DENIED'));
});
test('legacy role labels do not grant member accounts access to system management',async t=>{
 const f=await setup(t);
 for(const id of ['viewer','operator','member']){
  for(const area of ['accounts','logs','permissions'])assert.throws(()=>f.service.read(f.actor(id),area),code('ACCESS_DENIED'));
  await assert.rejects(command(f,'brand.reset',{expectedRevision:0},'',id),code('ACCESS_DENIED'));
 }
});
test('revoking assigned administrator status denies reads, writes, exports and receipt reads',async t=>{
 const f=await setup(t),op=await command(f,'brand.reset',{expectedRevision:0},'','admin');
 const admin=f.repo.get('accounts','admin');f.repo.put('accounts',{...admin,adminAssignedByOwner:false});
 for(const area of ['logs','brand'])assert.throws(()=>f.service.read(f.actor('admin'),area),code('ACCESS_DENIED'));
 await assert.rejects(command(f,'logs.export',{expectedRevision:0,query:{}},'','admin'),code('ACCESS_DENIED'));
 await assert.rejects(command(f,'brand.reset',{expectedRevision:1},'','admin'),code('ACCESS_DENIED'));
 assert.throws(()=>f.service.getOperation(f.actor('admin'),op.operationId),code('ACCESS_DENIED'));
});
test('brand commands keep other settings intact; replay stable; conflict rolls back',async t=>{
 const f=await setup(t),key=randomUUID(),input={expectedRevision:0,teamLogoUrl:'/uploads/team-logo/example.png'};
 const a=await command(f,'brand.save',input,'','root',key),b=await command(f,'brand.save',input,'','root',key);
 assert.equal(a.current.revision,1);assert.equal(b.replayed,true);assert.equal(f.repo.scalar('settings').battlemetrics.apiKey,'fixture-source-key-not-for-browser');
 await assert.rejects(command(f,'brand.reset',{expectedRevision:0}),code('REVISION_CONFLICT'));
 await assert.rejects(command(f,'brand.reset',{expectedRevision:1},'','root',key),code('OPERATION_CONFLICT'));
 assert.equal(f.db.prepare('SELECT count(*) n FROM v2_system_audits').get().n,1);
});
test('competing same-version configuration commands yield one winner',async t=>{
 const f=await setup(t);const results=await Promise.allSettled([command(f,'brand.reset',{expectedRevision:0}),command(f,'brand.save',{expectedRevision:0,teamLogoUrl:'/uploads/second.png'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.errorCode,'REVISION_CONFLICT');
});
test('secrets are write-only, correctly hashed and scoped; rotation invalidates old public token',async t=>{
 const f=await setup(t),secret='Local-private-token-20260908';
 const r=await command(f,'public.save',{expectedRevision:0,token:secret});assert.equal(r.current.enabled,true);
 assert.equal(await f.service.verifyPublicToken(secret),true);assert.equal(await f.service.verifyPublicToken('fixture-source-key-not-for-browser'),false);
 assert.ok(!JSON.stringify(r).includes(secret));assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM v2_system_operations').all()).includes(secret));
 await command(f,'public.clear',{expectedRevision:1});assert.equal(await f.service.verifyPublicToken(secret),false);
});
test('proxy effective precedence, safe credentials and explicit controlled probe',async t=>{
 const f=await setup(t,{trustedRoot:true});assert.equal(f.probes.length,0);
 const r=await command(f,'proxy.save',{expectedRevision:0,url:'http://user:private-proxy-pass@127.0.0.1:9999',scope:'battlemetrics'});
 assert.equal(r.current.effective.battlemetrics.source,'store');assert.equal(r.current.effective.kda.source,'env');
 assert.ok(!JSON.stringify(r).includes('private-proxy-pass'));assert.ok(!JSON.stringify(r).includes('env-secret'));
 const id=randomUUID();await command(f,'proxy.probe',{expectedRevision:1,service:'battlemetrics'},'','root',id);
 await command(f,'proxy.probe',{expectedRevision:1,service:'battlemetrics'},'','root',id);assert.equal(f.probes.length,1);
 await assert.rejects(command(f,'proxy.save',{expectedRevision:2,url:'file:///etc/passwd',scope:'global'}),code('INVALID_PROXY_URL'));
});
test('proxy selection stores only a catalog ID and respects service scope',async t=>{
 const node={id:'1234567890abcdef',name:'Fixture node',port:18000};
 const f=await setup(t,{proxyNodes:()=>[node],trustedRoot:true});
 const selected=await command(f,'proxy.select',{expectedRevision:0,nodeId:node.id,scope:'battlemetrics'});
 assert.deepEqual(selected.current.nodes,[{id:node.id,name:node.name}]);
 assert.equal(selected.current.saved.nodeId,node.id);
 assert.equal(selected.current.effective.battlemetrics.source,'node');
 assert.equal(selected.current.effective.kda.source,'env');
 assert.ok(!JSON.stringify(selected).includes('nb-egress:18000'));
 assert.deepEqual(f.repo.scalar('settings').system.proxy,{nodeId:node.id,scope:'battlemetrics',updatedAt:selected.current.updatedAt});
 await assert.rejects(command(f,'proxy.select',{expectedRevision:1,nodeId:'0000000000000000',scope:'global'}),code('PROXY_NODE_UNAVAILABLE'));
 assert.equal(f.repo.scalar('settings').system.proxy.nodeId,node.id);
});
test('proxy master toggle preserves configuration, is versioned and replays one audited write',async t=>{
 const node={id:'1234567890abcdef',name:'Fixture node',port:18000},f=await setup(t,{proxyNodes:()=>[node]});
 assert.equal(f.service.proxy().enabled,true);assert.equal(f.service.proxy().effective.kda.source,'env');
 const selected=await command(f,'proxy.select',{expectedRevision:0,nodeId:node.id,scope:'battlemetrics'});
 const before=f.repo.scalar('settings'),key=randomUUID(),input={expectedRevision:1,enabled:false};
 const off=await command(f,'proxy.toggle',input,'','root',key),replay=await command(f,'proxy.toggle',input,'','root',key);
 assert.equal(replay.replayed,true);assert.equal(off.current.revision,2);assert.equal(off.current.enabled,false);
 assert.equal(off.current.saved.enabled,true);assert.equal(off.current.saved.nodeId,node.id);assert.equal(off.current.saved.scope,'battlemetrics');
 for(const p of Object.values(off.current.effective))assert.deepEqual(p,{enabled:false,endpoint:'',source:'disabled',scope:'battlemetrics'});
 assert.equal(f.repo.scalar('settings').system.proxy.nodeId,before.system.proxy.nodeId);
 assert.deepEqual(f.repo.scalar('settings').battlemetrics,before.battlemetrics);
 assert.equal(f.db.prepare("SELECT count(*) n FROM v2_system_audits WHERE action='proxy.toggle'").get().n,1);
 assert.ok(f.service.read(f.actor('root'),'logs',{source:'system'}).items.some(row=>JSON.stringify(row).includes('切换代理总开关')));
 await assert.rejects(command(f,'proxy.toggle',{expectedRevision:1,enabled:true}),code('REVISION_CONFLICT'));
 await assert.rejects(command(f,'proxy.toggle',{expectedRevision:2,enabled:true},'','root',key),code('OPERATION_CONFLICT'));
 const on=await command(f,'proxy.toggle',{expectedRevision:2,enabled:true});
 assert.equal(on.current.enabled,true);assert.equal(on.current.effective.battlemetrics.source,'node');assert.equal(on.current.effective.kda.source,'env');
 assert.equal(f.repo.scalar('settings').system.proxy.scope,selected.current.saved.scope);
});
test('saving, selecting and clearing proxy settings never re-enable a disabled master',async t=>{
 const node={id:'1234567890abcdef',name:'Fixture node',port:18000},f=await setup(t,{proxyNodes:()=>[node]});
 await command(f,'proxy.toggle',{expectedRevision:0,enabled:false});
 const saved=await command(f,'proxy.save',{expectedRevision:1,url:'http://user:private-pass@127.0.0.1:9999',scope:'global'});
 assert.equal(saved.current.enabled,false);assert.equal(f.repo.scalar('settings').system.proxy.enabled,false);
 assert.ok(saved.current.saved.endpoint.includes('***@'));assert.ok(!JSON.stringify(saved).includes('private-pass'));
 const selected=await command(f,'proxy.select',{expectedRevision:2,nodeId:node.id,scope:'kda'});
 assert.equal(selected.current.enabled,false);assert.equal(f.repo.scalar('settings').system.proxy.enabled,false);
 const cleared=await command(f,'proxy.save',{expectedRevision:3,url:'',scope:'kda'});
 assert.equal(cleared.current.enabled,false);assert.equal(cleared.current.saved.enabled,false);
 assert.ok(Object.values(cleared.current.effective).every(p=>!p.enabled&&p.source==='disabled'));
});
test('proxy can be disabled even when the node catalog is corrupt and no selected node is resolved',async t=>{
 const f=await setup(t,{proxyNodes:()=>{throw Error('PROXY_CATALOG_INVALID');}}),settings=f.repo.scalar('settings');
 settings.system.proxy={nodeId:'missing-node',url:'broken-proxy-url',scope:'kda'};f.repo.setScalar('settings',settings);
 const off=await command(f,'proxy.toggle',{expectedRevision:0,enabled:false});
 assert.equal(off.current.enabled,false);assert.deepEqual(off.current.nodes,[]);assert.equal(off.current.saved.nodeId,'missing-node');
 assert.equal(f.repo.scalar('settings').system.proxy.url,'broken-proxy-url');
 assert.ok(Object.values(f.service.read(f.actor('root'),'proxy').effective).every(p=>!p.enabled&&p.source==='disabled'));
 f.service.proxyNodes=()=>[{id:'missing-node',name:'Saved node',get port(){throw Error('must not resolve disabled node');}}];
 assert.equal(f.service.proxy().enabled,false);
});
test('proxy toggle enforces boolean input, current authority and competing revisions',async t=>{
 const f=await setup(t);
 for(const enabled of ['false',0,null])await assert.rejects(command(f,'proxy.toggle',{expectedRevision:0,enabled}),code('INVALID_PROXY_ENABLED'));
 await assert.rejects(command(f,'proxy.toggle',{expectedRevision:0,enabled:false},'','impostor'),code('ACCESS_DENIED'));
 const results=await Promise.allSettled([command(f,'proxy.toggle',{expectedRevision:0,enabled:false}),command(f,'proxy.toggle',{expectedRevision:0,enabled:true})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.errorCode,'REVISION_CONFLICT');
 assert.equal(f.repo.scalar('settings').system.proxy.enabled,false);
});
test('G03 status/role changes revoke sessions and pending contexts atomically',async t=>{
 const f=await setup(t),session=f.identity.issueSession(f.repo.get('accounts','member'));
 f.contexts.issue({browser:'fixture',purpose:'onboarding',provider:'kook',accountId:'member'});
 const r=await command(f,'account.status',{expectedRevision:1,status:'disabled'},'member');
 assert.equal(r.current.status,'disabled');assert.throws(()=>f.identity.session(session.token));assert.equal(f.contexts.entries.size,0);assert.ok(f.counters().invalidations>0);
 assert.ok(f.repo.all('events').some(e=>e.accountId==='member'));
 await command(f,'account.status',{expectedRevision:2,status:'active'},'member');
 const s2=f.identity.issueSession(f.repo.get('accounts','member'));
 await command(f,'account.role',{expectedRevision:3,roleId:'admin'},'member');
 assert.throws(()=>f.identity.session(s2.token));
});
test('account writes keep root and legacy admin/self boundaries',async t=>{
 const f=await setup(t);
 await assert.rejects(command(f,'account.status',{expectedRevision:1,status:'disabled'},'root'),code('ROOT_PERMISSIONS_PROTECTED'));
 await assert.rejects(command(f,'account.delete',{expectedRevision:1,reason:'test'},'root'),code('PROTECTED_ACCOUNT'));
 await assert.rejects(command(f,'account.password',{expectedRevision:1,password:'Local-New-Password'},'admin','admin'),code('PROTECTED_ACCOUNT'));
 await assert.rejects(command(f,'account.password',{expectedRevision:1,password:'Local-New-Password'},'root','admin'),code('PROTECTED_ACCOUNT'));
 await assert.rejects(command(f,'account.create',{expectedRevision:0,username:'newroot',password:'Local-New-Password',roleId:'admin'},'','admin'),code('ROLE_ESCALATION'));
});
test('managed account create/password/delete are real authority writes with stable receipt and tombstone restore',async t=>{
 const f=await setup(t),key=randomUUID(),input={expectedRevision:0,username:'local-new',password:'Local-New-Password',roleId:'member'};
 const created=await command(f,'account.create',input,'','root',key),id=created.current.id;
 assert.equal((await command(f,'account.create',input,'','root',key)).current.id,id);
 const a=f.repo.get('accounts',id),u=f.repo.get('users',a.legacyUserId);assert.ok(u.passwordHash.startsWith('scrypt$'));assert.equal(created.current.passwordConfigured,true);
 const s=f.identity.issueSession(a);await command(f,'account.password',{expectedRevision:1,password:'Other-New-Password'},id);assert.throws(()=>f.identity.session(s.token));
 const del=await command(f,'account.delete',{expectedRevision:2,reason:'本地删除演练'},id);assert.equal(del.current.status,'disabled');assert.ok(f.repo.get('accounts',id).deletedAt);
 await command(f,'account.status',{expectedRevision:3,status:'active'},id);assert.equal(f.actor(id).status,'active');
});
test('fixed role permissions reject custom role and grant mutations without changing authority',async t=>{
 const f=await setup(t),before=f.repo.get('accounts','member');
 for(const [action,target,input] of [
  ['role.save','custom',{expectedRevision:0,name:'custom',permissions:{}}],
  ['role.delete','admin',{expectedRevision:0}],
  ['account.grants','member',{expectedRevision:1,grants:[grant('system.brand',{type:'all'})]}]
 ])await assert.rejects(command(f,action,input,target),code('FIXED_ROLE_PERMISSIONS'));
 assert.deepEqual(f.repo.get('accounts','member'),before);
 assert.equal(f.repo.get('permissionRoles','custom'),null);
});
test('unverified Steam candidate does not create proof or duplicate member facts',async t=>{
 const f=await setup(t);const r=await command(f,'account.binding',{expectedRevision:1,steamId:'76561198000000001',reason:'候选关联'},'member');
 assert.equal(r.current.bindingStatus,'legacy_unverified');assert.equal(f.actor('member').memberId,null);
 await assert.rejects(command(f,'account.binding',{expectedRevision:1,steamId:'76561198000000001',reason:'冲突关联'},'viewer'),code('IDENTITY_CONFLICT'));
});
test('bounded log cursor filters tie breaks and exports apply projection',async t=>{
 const f=await setup(t),a=f.service.read(f.actor('root'),'logs',{limit:10}),b=f.service.read(f.actor('root'),'logs',{limit:10,cursor:a.nextCursor});
 assert.equal(new Set([...a.items,...b.items].map(x=>x.id)).size,20);
 assert.throws(()=>f.service.read(f.actor('root'),'logs',{limit:10,cursor:a.nextCursor,q:'changed'}),code('CURSOR_EXPIRED'));
 const exported=await command(f,'logs.export',{expectedRevision:0,query:{source:'runtime'}});
 assert.ok(!exported.content.includes('fixture-probe-secret'));assert.ok(!exported.content.includes('must-not-return'));
});
test('WAL-aware backup, verified restore candidate, preview quarantine and recovery preserve bytes',async t=>{
 const f=await setup(t);const saved=await command(f,'brand.save',{expectedRevision:0,teamLogoUrl:'/uploads/before.png'});
 const backup=await command(f,'storage.backup',{expectedRevision:0}),a=backup.current;
 await command(f,'brand.reset',{expectedRevision:saved.current.revision});
 const restore=await command(f,'storage.restore',{expectedRevision:1,artifactRevision:1},a.id),candidate=f.service.repo.artifact(restore.current.id);
 const restored=new DatabaseSync(f.storage.candidatePath(candidate),{readOnly:true});
 assert.equal(JSON.parse(restored.prepare("SELECT payload_json FROM json_scalars WHERE key='settings'").get().payload_json).system.teamLogoUrl,'/uploads/before.png');restored.close();
 assert.equal(f.service.brand().teamLogoUrl,'');
 const preview=f.service.preview(f.actor('root'),a.id);
 const quarantined=await command(f,'storage.quarantine',{expectedRevision:preview.revision,artifactRevision:1,preview:preview.preview},a.id);
 assert.equal(quarantined.current.state,'quarantined');assert.equal(quarantined.current.sha256,a.sha256);
 const recovered=await command(f,'storage.recover',{expectedRevision:3,artifactRevision:2},a.id);assert.equal(recovered.current.state,'active');assert.equal(recovered.current.sha256,a.sha256);
});
test('post-commit cache failure retains successful receipt and replay repairs cache without duplicate write',async t=>{
 let fail=true;const f=await setup(t,{patchCache:()=>{if(fail){fail=false;throw Error('cache failure');}}}),id=randomUUID();
 await assert.rejects(command(f,'brand.reset',{expectedRevision:0},'','root',id));
 assert.equal(f.service.repo.operation(id).state,'succeeded');const r=await command(f,'brand.reset',{expectedRevision:0},'','root',id);
 assert.equal(r.replayed,true);assert.equal(r.current.revision,1);assert.equal(f.counters().patches,2);
});
test('owner stop rejects new writes and drains in-flight work before close',async t=>{
 const f=await setup(t);await f.owner.stop();await assert.rejects(command(f,'brand.reset',{expectedRevision:0}),code('SYSTEM_OWNER_STOPPED'));f.owner.start();
});
test('orphan cleanup selects only reviewed missing-member accounts and retains identity tombstones',async t=>{
 const f=await setup(t),orphan={id:'orphan-test',roleId:'member',status:'active',memberId:'missing-member',grants:[],revision:1,permissionVersion:1};f.repo.put('accounts',orphan);
 const page=f.service.read(f.actor('root'),'accounts',{orphan:'1'});assert.deepEqual(page.items.map(a=>a.id),['orphan-test']);
 await assert.rejects(command(f,'account.cleanup',{expectedRevision:0,accountIds:['member']}),code('NOT_ORPHAN'));
 const r=await command(f,'account.cleanup',{expectedRevision:0,accountIds:['orphan-test']});assert.deepEqual(r.disabledOrphans,['orphan-test']);assert.equal(f.repo.get('accounts','orphan-test').status,'disabled');
});
test('legacy permissions cannot promote unassigned administrator labels',async t=>{
 const f=await setup(t),admin=f.repo.get('accounts','admin');
 f.repo.put('accounts',{...admin,adminAssignedByOwner:false,grants:roleGrants('admin')});
 assert.throws(()=>f.service.read(f.actor('admin'),'brand'),code('ACCESS_DENIED'));
 assert.throws(()=>f.service.read(f.actor('admin'),'accounts'),code('ACCESS_DENIED'));
 assert.ok(f.service.read(f.actor('root'),'brand'));
});
test('failed identity transaction rolls back authority, sessions, contexts, audit and receipt together',async t=>{
 const f=await setup(t),s=f.identity.issueSession(f.repo.get('accounts','member')),id=randomUUID();
 f.contexts.issue({browser:'test',purpose:'onboarding',provider:'kook',accountId:'member'});
 f.db.exec("CREATE TRIGGER v2_system_test_fail BEFORE INSERT ON v2_system_audits BEGIN SELECT RAISE(ABORT,'injected'); END");
 await assert.rejects(command(f,'account.status',{expectedRevision:1,status:'disabled'},'member','root',id));
 assert.equal(f.repo.get('accounts','member').status,'active');assert.ok(f.identity.session(s.token));assert.equal(f.contexts.entries.size,1);assert.equal(f.service.repo.operation(id),undefined);
 f.db.exec('DROP TRIGGER v2_system_test_fail');await command(f,'account.status',{expectedRevision:1,status:'disabled'},'member','root',id);assert.throws(()=>f.identity.session(s.token));
});
test('storage symlink and stale preview are rejected without reading or moving outside files',async t=>{
 const f=await setup(t),b=await command(f,'storage.backup',{expectedRevision:0}),a=f.service.repo.artifact(b.current.id);
 const p=f.service.preview(f.actor('root'),a.id);await command(f,'storage.backup',{expectedRevision:1});
 await assert.rejects(command(f,'storage.quarantine',{expectedRevision:2,artifactRevision:1,preview:p.preview},a.id),code('CLEANUP_PREVIEW_REQUIRED'));
 const file=path.join(f.artifactDir,a.fileName),elsewhere=path.join(path.dirname(f.artifactDir),'symlink-target.sqlite');fs.renameSync(file,elsewhere);fs.symlinkSync(elsewhere,file);
 assert.throws(()=>f.storage.restore(randomUUID(),a),code('STORAGE_SYMLINK_FORBIDDEN'));assert.ok(fs.existsSync(elsewhere));fs.unlinkSync(file);fs.renameSync(elsewhere,file);
});
test('config export omits all raw credentials and source settings',async t=>{
 const f=await setup(t);await command(f,'proxy.save',{expectedRevision:0,url:'http://local:private@127.0.0.1:8080',scope:'global'});
 const r=await command(f,'storage.export-config',{expectedRevision:0});assert.ok(!r.content.includes('private@'));assert.ok(!r.content.includes('fixture-source-key'));assert.equal(JSON.parse(r.content).secrets,'omitted');
});
test('verified recovery candidate reopens as the authoritative G03 database and accepts new management writes',async t=>{
 const f=await setup(t);await command(f,'brand.save',{expectedRevision:0,teamLogoUrl:'/uploads/recover-target.png'});
 const b=await command(f,'storage.backup',{expectedRevision:0}),r=await command(f,'storage.restore',{expectedRevision:1,artifactRevision:1},b.current.id);
 const candidate=f.service.repo.artifact(r.current.id),activated=path.join(path.dirname(f.artifactDir),'activated-rehearsal.sqlite');
 fs.copyFileSync(f.storage.candidatePath(candidate),activated,fs.constants.COPYFILE_EXCL);
 const db=new DatabaseSync(activated);
 const {IdentityRepository}=await import('../server/v2/identity/repository.js'),{IdentityService}=await import('../server/v2/identity/service.js');
 const {createSystemIdentityAdapter}=await import('../server/v2/system-admin/identity-adapter.js'),{createLocalSystemStorage}=await import('../server/v2/system-admin/storage.js');
 const {createSystemWriteOwner,SystemAdminService}=await import('../server/v2/system-admin/service.js');
 const identity=new IdentityService(new IdentityRepository(db)),owner=createSystemWriteOwner({runWrite:fn=>fn(),patchCache:()=>{},invalidateAuthContexts:()=>{}});owner.start();
 const restored=new SystemAdminService({identity,identityAdmin:createSystemIdentityAdapter(identity),owner,storage:createLocalSystemStorage({db,directory:f.artifactDir,databaseFile:activated})});
 try {
  assert.equal(restored.read(identity.actorForAccount('root'),'brand').teamLogoUrl,'/uploads/recover-target.png');
  await restored.command(identity.actorForAccount('root'),'brand.reset','',{expectedRevision:1},randomUUID());
  assert.equal(restored.brand().teamLogoUrl,'');assert.equal(f.service.brand().teamLogoUrl,'/uploads/recover-target.png');
 } finally {await owner.stop();db.close();}
});
test('access restriction can be created and revoked through the G03 authority with versioned audit',async t=>{
 const f=await setup(t),root=f.actor('root');
 const r=await command(f,'account.restriction',{expectedRevision:1,restrictionRevision:0,startsAt:'2020-01-01T00:00:00.000Z',reason:'local test'},'member');
 assert.throws(()=>f.actor('member'),code('ACCESS_RESTRICTED'));
 const released=await command(f,'account.restriction.remove',{expectedRevision:2,restrictionRevision:1,restrictionId:r.current.id,reason:'local release'},'member');
 assert.equal(released.current.revision,3);assert.equal(f.actor('member').status,'active');assert.ok(f.repo.all('audits').some(a=>a.action==='access_restriction_removed'));
});
test('password proof is one-use and reset between verification and session creation invalidates it',async t=>{
 const f=await setup(t),{createSystemPasswordProofAdapter}=await import('../server/v2/system-admin/password-proof.js'),p=createSystemPasswordProofAdapter(f.identity);
 const stale=await p.authenticate('admin','Fixture-only-Password-2026');
 await command(f,'account.password',{expectedRevision:1,password:'New-Test-Password'},'admin');assert.throws(()=>p.consume(stale),code('PASSWORD_PROOF_REVOKED'));
 const proof=await p.authenticate('admin','New-Test-Password');assert.equal(p.consume(proof).id,'admin');assert.throws(()=>p.consume(proof),code('PASSWORD_PROOF_EXPIRED'));
 const memberProof=await p.authenticate('viewer','Fixture-only-Password-2026');assert.throws(()=>p.consume(memberProof),code('PLATFORM_LOGIN_REQUIRED'));
});
