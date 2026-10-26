// Frozen scope-engine unit contract: this file explicitly opts into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createFixture} from './support/v2-notifications/fixture.js';
import {PlatformAdminService} from '../server/v2/platform-admin/service.js';
import {installPlatformAdminSchema} from '../server/v2/platform-admin/repository.js';
import {electricianProfile,readElectricianRoster,resolveElectricianRoster} from '../server/v2/platform-admin/electrician-roster.js';
import {grant} from '../server/v2/identity/permissions.js';
import {upsertSqliteCollectionRecord} from '../server/storage/sqlite-migrate.js';
const sid='76561198000000001';
function setup(t){const f=createFixture({scopeContract:true,adminRole:true});installPlatformAdminSchema(f.db);const service=new PlatformAdminService({identity:f.identity});t.after(()=>f.close());f.identity.repo.put('members',{id:'electrician',customName:'Electrician A',steamId:sid,memberStatus:'active',specialties:['electricity']});return {...f,service};}
const manual=(group='CN')=>({kind:'manual',group,name:'Manual A',url:sid});

test('manual input normalizes profile URLs; same Steam profile is deduplicated across groups and member selection',t=>{
 const f=setup(t);const saved=f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[manual(),manual('EU'),{kind:'member',group:'EU',memberId:'electrician'}]},{operationId:'roster-save'});
 assert.equal(saved.current.resolved.china.length,1);assert.equal(saved.current.resolved.foreign.length,0);
 assert.equal(saved.current.entries.length,2);assert.equal(saved.current.resolved.china[0].url,`https://steamcommunity.com/profiles/${sid}/`);
 assert.equal(electricianProfile('https://steamcommunity.com/id/player/?l=english'),'https://steamcommunity.com/id/player/');
 for(const url of ['http://steamcommunity.com/id/aa/','https://steamcommunity.com.evil/id/aa/','https://steamcommunity.com/id/aa/?redirect=x','https://steamcommunity.com/id/aa/#x','javascript:alert(1)'])assert.equal(electricianProfile(url),null);
});

test('selected specialty dynamically follows names, Steam IDs, new members, departures and current squad membership',t=>{
 const f=setup(t);f.identity.repo.put('squads',{id:'cn-team',name:'CN'});f.identity.repo.put('squadMembers',{id:'sm1',memberId:'electrician',squadId:'cn-team'});
 f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[{kind:'specialty',group:'CN',specialty:'electricity',squadId:'cn-team'}]},{operationId:'specialty'});
 const current=()=>resolveElectricianRoster(f.service.repo,f.identity);
 assert.equal(current().china[0].name,'Electrician A');
 f.identity.repo.put('members',{...f.identity.repo.get('members','electrician'),customName:'Renamed'});assert.equal(current().china[0].name,'Renamed');
 f.identity.repo.put('members',{id:'new-electrician',steamId:'76561198000000002',customName:'New member',memberStatus:'active',specialties:['电工']});
 assert.equal(current().china.length,1);f.identity.repo.put('squadMembers',{id:'sm2',memberId:'new-electrician',squadId:'cn-team'});assert.equal(current().china.length,2);
 f.identity.repo.put('squadMembers',{id:'sm2',memberId:'new-electrician',squadId:'cn-team',validTo:'2026-10-01'});assert.equal(current().china.length,1);
 f.identity.repo.put('members',{...f.identity.repo.get('members','electrician'),memberStatus:'left'});assert.equal(current().china.length,0);
});

test('save is revision-checked, idempotent and preserves the existing legacy list before first save',t=>{
 const f=setup(t);f.service.repo.put('config','kook','kook','admin',Date.now(),{commands:[{id:'electrician_ids_card',electriciansCn:'Saved A | https://steamcommunity.com/id/saved_a/',electriciansForeign:'Saved B | https://steamcommunity.com/id/saved_b/'}]});
 assert.equal(f.service.electricianRosterDetail(f.actor()).entries.length,2);
 const input={expectedRevision:0,entries:[manual()]};f.service.saveElectricianRoster(f.actor(),input,{operationId:'same'});
 assert.equal(f.service.saveElectricianRoster(f.actor(),input,{operationId:'same'}).revision,1);
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),input,{operationId:'other'}),e=>e.errorCode==='REVISION_CONFLICT');
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),{...input,entries:[]},{operationId:'same'}),e=>e.errorCode==='IDEMPOTENCY_CONFLICT');
 assert.equal(f.service.electricianRosterDetail(f.actor()).resolved.china.length,1);
});

test('shared source requires both platform scopes and member selection obeys member read scopes',t=>{
 const f=setup(t),original=f.identity.actorForAccount.bind(f.identity);
 let grants=[grant('platforms.read',{type:'all'}),grant('platforms.configure',{type:'platformTargets',ids:['kook']})];
 f.identity.actorForAccount=id=>({...original(id),grants});
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[manual()]},{operationId:'denied-platform'}),e=>e.errorCode==='ACCESS_DENIED');
 grants=[grant('platforms.read',{type:'all'}),grant('platforms.configure',{type:'all'})];
 assert.equal(f.service.electricianRosterDetail(f.actor()).members.length,0);
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[{kind:'member',group:'CN',memberId:'electrician'}]},{operationId:'denied-member'}),e=>e.errorCode==='ACCESS_DENIED');
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[{kind:'specialty',group:'CN',specialty:'electricity'}]},{operationId:'denied-specialty'}),e=>e.errorCode==='ACCESS_DENIED');
 assert.equal(f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[manual()]},{operationId:'manual-allowed'}).status,'succeeded');
});


test('member avatars use Steam cache with profile ownership and safe URL validation',t=>{
 const f=setup(t),avatar='https://avatars.steamstatic.com/'+ 'b'.repeat(40)+'_full.jpg';
 const putProfile=record=>upsertSqliteCollectionRecord(f.db,'memberProfiles',record.id,record);
 putProfile({id:'wrong-owner',memberId:'other-member',steamId:sid,avatar});
 assert.equal(f.service.electricianRosterDetail(f.actor()).members[0].avatar,'');
 putProfile({id:'own-profile',memberId:'electrician',steamId:'76561198000000999',avatar});
 assert.equal(f.service.electricianRosterDetail(f.actor()).members[0].avatar,'');
 putProfile({id:'own-profile',memberId:'electrician',steamId:sid,avatar});
 assert.equal(f.service.electricianRosterDetail(f.actor()).members[0].avatar,avatar);
 putProfile({id:'own-profile',memberId:'electrician',steamId:sid,avatar:'https://unsafe.example/image.jpg'});
 assert.equal(f.service.electricianRosterDetail(f.actor()).members[0].avatar,'');
});

test('existing shared sources and revision take precedence without migrating or rewriting on read',t=>{
 const f=setup(t),stored={revision:7,updatedAt:'2026-10-01T00:00:00Z',entries:[{kind:'member',group:'CN',memberId:'electrician'},{kind:'specialty',group:'EU',specialty:'electricity',squadId:''}]};
 f.service.repo.put('electrician-roster','shared','shared','earlier-admin',1,stored);
 f.service.repo.put('config','kook','kook','admin',1,{commands:[{id:'electrician_ids_card',electriciansCn:'Different | https://steamcommunity.com/id/different/',electriciansForeign:''}]});
 assert.deepEqual(readElectricianRoster(f.service.repo),stored);
 assert.deepEqual(f.service.electricianRosterDetail(f.actor()).entries,stored.entries);
 assert.equal(f.service.electricianRosterDetail(f.actor()).revision,7);
 assert.deepEqual(f.service.repo.get('electrician-roster','shared'),stored);
 assert.equal(f.service.repo.list('electrician-operation','shared').length,0);
});

test('management detail excludes unreadable member sources, resolved identities and squad memberships',t=>{
 const f=setup(t);
 f.identity.repo.put('members',{id:'hidden-electrician',customName:'Hidden private name',steamId:'76561198000000002',memberStatus:'active',specialties:['electricity']});
 f.identity.repo.put('squadMembers',{id:'visible-hidden-squad',memberId:'electrician',squadId:'sq2'});
 const stored={revision:3,entries:[{kind:'member',group:'CN',memberId:'electrician'},{kind:'member',group:'EU',memberId:'hidden-electrician'},{kind:'specialty',group:'EU',specialty:'electricity',squadId:''}]};
 f.service.repo.put('electrician-roster','shared','shared','admin',1,stored);
 const original=f.identity.actorForAccount.bind(f.identity);
 f.identity.actorForAccount=id=>({...original(id),memberId:'electrician',grants:[grant('platforms.read',{type:'all'}),grant('platforms.configure',{type:'all'}),grant('members.read',{type:'self'}),grant('squads.read',{type:'squads',ids:['sq1']}),{capability:'squads.read',scope:{type:'squads',ids:['sq2']},effect:'deny'}]});
 const detail=f.service.electricianRosterDetail(f.actor());
 assert.deepEqual(detail.entries,[stored.entries[0]]);
 assert.equal(detail.members.length,1);assert.deepEqual(detail.members[0].squadIds,[]);
 assert.equal(detail.resolved.china[0].name,'Electrician A');assert.deepEqual(detail.resolved.foreign,[]);
 assert.equal(detail.canConfigure,false);assert.equal(detail.canSelectSpecialty,false);assert.equal(detail.hasRestrictedSources,true);
 for(const privateValue of ['hidden-electrician','Hidden private name','76561198000000002','sq2'])assert.ok(!JSON.stringify(detail).includes(privateValue));
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),{expectedRevision:3,entries:[]},{operationId:'filtered-replace'}),e=>e.errorCode==='ACCESS_DENIED');
 assert.deepEqual(f.service.repo.get('electrician-roster','shared'),stored);
 assert.equal(resolveElectricianRoster(f.service.repo,f.identity).foreign.length,1);
});

test('individual deny cannot be bypassed through an all-member specialty rule',t=>{
 const f=setup(t),original=f.identity.actorForAccount.bind(f.identity);
 f.identity.actorForAccount=id=>({...original(id),grants:[grant('platforms.read',{type:'all'}),grant('platforms.configure',{type:'all'}),grant('members.read',{type:'all'}),{capability:'members.read',scope:{type:'self'},effect:'deny'}],memberId:'electrician'});
 assert.equal(f.service.electricianRosterDetail(f.actor()).canSelectSpecialty,false);
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[{kind:'specialty',group:'CN',specialty:'electricity'}]},{operationId:'denied-rule'}),e=>e.errorCode==='ACCESS_DENIED');
 assert.equal(f.service.repo.get('electrician-roster','shared'),null);
});

test('missing shared and legacy lists stay empty, and invalid input never writes a default roster',t=>{
 const f=setup(t);
 assert.deepEqual(readElectricianRoster(f.service.repo),{revision:0,updatedAt:'',entries:[]});
 for(const input of [[],{expectedRevision:-1,entries:[]},{expectedRevision:0,entries:[{kind:'manual',group:'CN',name:'Unsafe',url:'https://evil.example/'}]},{expectedRevision:0,entries:[{kind:'member',group:'CN',memberId:''}]},{expectedRevision:0,entries:[{kind:'specialty',group:'CN',specialty:'unknown'}]}])assert.throws(()=>f.service.saveElectricianRoster(f.actor(),input,{operationId:'invalid'}),e=>e.errorCode==='ELECTRICIAN_INPUT_INVALID');
 assert.equal(f.service.repo.get('electrician-roster','shared'),null);
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[]}),e=>e.errorCode==='IDEMPOTENCY_KEY_REQUIRED');
 const saved=f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[]},{operationId:'empty-save'});
 assert.deepEqual(saved.current.resolved,{china:[],foreign:[]});
 assert.equal(saved.current.revision,1);
});

test('oversized resolved specialty list rolls back both configuration and idempotency receipt',t=>{
 const f=setup(t);
 for(let i=0;i<501;i++)f.identity.repo.put('members',{id:`many-${i}`,customName:`Electrician ${i}`,steamId:String(76561198000010000n+BigInt(i)),memberStatus:'active',specialties:['electricity']});
 assert.throws(()=>f.service.saveElectricianRoster(f.actor(),{expectedRevision:0,entries:[{kind:'specialty',group:'CN',specialty:'electricity'}]},{operationId:'too-large'}),e=>e.errorCode==='ELECTRICIAN_LIST_TOO_LARGE');
 assert.equal(f.service.repo.get('electrician-roster','shared'),null);
 assert.equal(f.service.repo.get('electrician-operation','too-large'),null);
});
