// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fixture} from './support/v2-member-admin/fixtures.mjs';
import {PlatformAdminService,projectResult} from '../server/v2/platform-admin/service.js';
import {installPlatformAdminSchema} from '../server/v2/platform-admin/repository.js';
import {createNativePlatformMetadata} from '../server/v2/management-adapters/platform-native/index.js';
const guild='100000000000000001';
const channel=(id,label)=>({id,label,status:'channel:0'});
function setup(t){const f=fixture({scopeContract:true});t.after(()=>f.db.close());installPlatformAdminSchema(f.db);f.ir.put('accounts',{...f.ir.get('accounts','admin'),roleId:'admin',adminAssignedByOwner:true});f.actor=f.identity.actorForAccount('admin');f.service=new PlatformAdminService({identity:f.identity});f.save=(platform,targets=[{id:'target',guildId:guild,enabled:true}])=>f.service.save(f.actor,platform,{expectedRevision:f.service.config(platform).revision,config:{enabled:true,targets,commands:[]}},{operationId:randomUUID()});f.run=(platform,input={})=>f.service.execute(f.actor,platform,'metadata',{expectedRevision:f.service.config(platform).revision,targetId:'target',kind:'channels',...input},{operationId:randomUUID()});return f;}
test('channel names survive config revision, service recreation, page one and isolate guild/platform; failed metadata cannot replace names',async t=>{
 const f=setup(t);f.save('discord');let items=[channel('selected','已选频道')],state='succeeded';f.service.adapters.platform={metadata:async()=>({schema:'platform-result/1',state,items})};await f.run('discord');
 items=[channel('first','第一页')];await f.run('discord',{page:1});f.save('discord');f.service=new PlatformAdminService({identity:f.identity,adapters:f.service.adapters});
 assert.deepEqual(f.service.detail(f.actor,'discord').channelCatalogs,[{guildId:guild,items:[channel('selected','已选频道'),channel('first','第一页')]}]);
 state='failed';items=[channel('selected','错误名字')];await f.run('discord');assert.equal(f.service.detail(f.actor,'discord').channelCatalogs[0].items[0].label,'已选频道');
 f.save('kook');assert.deepEqual(f.service.detail(f.actor,'kook').channelCatalogs[0].items,[]);
 f.save('discord',[{id:'target',guildId:'100000000000000002',enabled:true}]);assert.deepEqual(f.service.detail(f.actor,'discord').channelCatalogs[0].items,[]);
});
test('legacy channel receipts backfill across next save; wrong revision, guild, status and platform excluded',t=>{
 const f=setup(t);f.save('discord');const put=(id,changes={},platform='discord')=>f.service.repo.put('operation',id,platform,'admin',Date.now(),{action:'metadata',revision:1,status:'succeeded',resource:{kind:'platformTarget',id:'target'},result:{state:'succeeded',items:[channel(id,id)]},...changes});
 put('good');put('old',{revision:0});put('foreign',{resource:{kind:'platformTarget',id:'elsewhere'}});put('failed',{status:'failed'});put('other-platform',{},'kook');
 f.save('discord');assert.deepEqual(f.service.detail(f.actor,'discord').channelCatalogs[0].items,[channel('good','good')]);
});
test('native Discord hash and KOOK icon persist as guild DTO; hostile and non-guild icons are stripped',async t=>{
 const f=setup(t);f.save('discord');f.save('kook');const icon='0123456789abcdef0123456789abcdef';
 const native=createNativePlatformMetadata({getPlatformService:()=>f.service,readCredentials:()=>({botToken:'synthetic',revision:'1',transportKey:'native'}),fetchImpl:async url=>new Response(JSON.stringify(url.includes('discord.com')?[{id:guild,name:'Discord',icon}]:{code:0,data:{items:[{id:guild,name:'KOOK',icon:'https://img.kookapp.cn/assets/test.png'}],meta:{page:1,page_size:50,total:1,page_total:1}}}),{status:200})});t.after(()=>native.stop());f.service.adapters.platform=native.platformMetadata;
 for(const platform of ['discord','kook']){const r=await f.run(platform,{kind:'guilds',targetId:undefined});assert.equal(r.status,'succeeded');f.save(platform);assert.equal(f.service.detail(f.actor,platform).guildCatalog.items[0].iconUrl,platform==='discord'?`https://cdn.discordapp.com/icons/${guild}/${icon}.png?size=128`:'https://img.kookapp.cn/assets/test.png');}
 for(const iconUrl of ['http://img.kookapp.cn/a','https://img.kookapp.cn.evil.test/a','https://secret@img.kookapp.cn/a','javascript:alert(1)'])assert.equal(projectResult({items:[{id:'1',label:'bad',status:'guild',iconUrl}]}).items[0].iconUrl,undefined);
 assert.equal(projectResult({items:[{...channel('c','频道'),iconUrl:'https://img.kookapp.cn/a'}]}).items[0].iconUrl,undefined);
});
