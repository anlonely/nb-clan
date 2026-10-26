import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './support/v2-member-admin/fixtures.mjs';
import {PlatformAdminService} from '../server/v2/platform-admin/service.js';
import {installPlatformAdminSchema} from '../server/v2/platform-admin/repository.js';

const role=(id,label)=>({id,label,status:'role'});
function setup(t){
 const f=fixture({});t.after(()=>f.db.close());installPlatformAdminSchema(f.db);
 f.repo=f.ir;f.repo.put('accounts',{...f.repo.get('accounts','admin'),roleId:'admin',adminAssignedByOwner:true});f.actor=(id='admin')=>f.identity.actorForAccount(id);f.adapters={platform:{}};
 f.service=new PlatformAdminService({identity:f.identity,adapters:f.adapters});
 f.service.save(f.actor(),'kook',{expectedRevision:0,config:{enabled:true,targets:[{id:'kook-local',guildId:'100000000000000001',enabled:true}],commands:[]}},{operationId:randomUUID()});
 f.repo.put('policies',{id:'kook-policy',provider:'kook',guildId:'100000000000000001',allowedRoleIds:['1'],matchMode:'any',enabled:true,policyRevision:1});
 return f;
}
const metadata=(f,input={})=>f.service.execute(f.actor(),'kook','metadata',{expectedRevision:f.service.config('kook').revision,targetId:'kook-local',kind:'roles',...input},{operationId:randomUUID()});

test('role catalog persists in SQLite across service recreation and policy saves; pages merge and page one replaces',async t=>{
 const f=setup(t);let items=[role('1','队员')],state='succeeded';
 f.adapters.platform.metadata=async()=>({schema:'platform-result/1',state,items});
 assert.equal((await metadata(f)).status,'succeeded');
 items=[role('2','管理')];await metadata(f,{page:2});
 f.service=new PlatformAdminService({identity:f.identity,adapters:f.adapters});
 const expected=[role('1','队员'),role('2','管理')];
 assert.deepEqual(f.service.detail(f.actor(),'kook').loginRoleCatalog,{guildId:'100000000000000001',items:expected});
 const p=f.identity.policy('kook');
 await f.service.execute(f.actor(),'kook','policy_save',{expectedRevision:1,expectedPolicyRevision:p.policyRevision,policy:{guildId:p.guildId,allowedRoleIds:['1'],matchMode:'any',enabled:true}},{operationId:randomUUID()});
 assert.deepEqual(f.service.detail(f.actor(),'kook').loginRoleCatalog.items,expected);
 items=[role('1','不可信失败名称')];state='failed';await metadata(f);
 assert.deepEqual(f.service.detail(f.actor(),'kook').loginRoleCatalog.items,expected);
 state='succeeded';items=[role('1','新名称')];await metadata(f);
 assert.deepEqual(f.service.detail(f.actor(),'kook').loginRoleCatalog.items,items);
 assert.deepEqual(f.identity.policy('kook').allowedRoleIds,['1']);
});

test('legacy successful role metadata fallback is read-only and rejects stale revision, other guild, platform and failed receipts',t=>{
 const f=setup(t),revision=f.service.config('kook').revision;
 const put=(id,changes={},platform='kook')=>f.service.repo.put('operation',id,platform,f.actor().id,Date.now(),{action:'metadata',revision,status:'succeeded',resource:{kind:'platformTarget',id:'kook-local'},result:{state:'succeeded',items:[role(id,id)]},...changes});
 put('old-role');put('stale',{revision:revision-1});put('foreign',{resource:{kind:'platformTarget',id:'other-guild'}});put('wrong-platform',{},'discord');put('failed',{status:'failed'});put('failed-result',{result:{state:'failed',items:[role('bad','bad')]}});
 put('channel',{result:{state:'succeeded',items:[{id:'channel',label:'频道',status:'channel:0'}]}});
 const before=f.db.prepare('SELECT total_changes() n').get().n;
 assert.deepEqual(f.service.detail(f.actor(),'kook').loginRoleCatalog.items,[role('old-role','old-role')]);
 assert.equal(f.db.prepare('SELECT total_changes() n').get().n,before);
 assert.equal(f.db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='role-catalog'").get().n,0);
});

test('cached catalogs are isolated by guild and platform and remain hidden without login policy permission',async t=>{
 const f=setup(t);f.adapters.platform.metadata=async()=>({schema:'platform-result/1',state:'succeeded',items:[role('1','原服务器')]});await metadata(f);
 const p=f.identity.policy('kook');f.repo.put('policies',{...p,guildId:'other-guild'});
 assert.deepEqual(f.service.detail(f.actor(),'kook').loginRoleCatalog,{guildId:'other-guild',items:[]});
 f.service.repo.put('role-catalog',JSON.stringify(['discord','other-guild']),'discord',f.actor().id,Date.now(),{guildId:'other-guild',items:[role('1','其他平台')]});
 assert.deepEqual(f.service.detail(f.actor(),'kook').loginRoleCatalog.items,[]);
 assert.throws(()=>f.service.detail(f.actor('leader'),'kook'),/ACCESS_DENIED/);
});
