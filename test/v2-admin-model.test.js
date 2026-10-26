import test from 'node:test';
import assert from 'node:assert/strict';
import {matchAdminLocation,adminWipeTab,draftForm,draftCommand,serverTemplatePatch,manualTimePatch,timeZonePatch,availableCommands,invalidateWipe} from '../src/v2/admin/model.js';
for(const [path,page,id] of [['/admin','list'],['/admin/wipes','list'],['/admin/wipes/new','new'],['/admin/wipes/wipe_1?edit=1&step=3#signup','wipe','wipe_1'],['/admin/wipes/%E6%B5%8B%E8%AF%95/notifications','notifications','测试'],['/admin/publish-intents/intent_1','intent','intent_1'],['/admin/deliveries/d_1','delivery','d_1']])test(`admin route ${path}`,()=>{const r=matchAdminLocation(path);assert.equal(r.page,page);if(id)assert.equal(r.wipeId||r.intentId||r.deliveryId,id);});
test('admin routes reject external, malformed, normalized and multi-decoded ids',()=>{for(const path of ['https://evil/admin','//evil/admin','/admin/wipes/..','/admin/wipes/a%2Fb','/admin/wipes/%252F','/admin/wipes/%ZZ','/admin/wipes/a\\b','/admin/deliveries/a/notifications','/app/wipes/a','/admin/wipes/a/extra'])assert.equal(matchAdminLocation(path),null,path);});
test('admin wipe deep links preserve valid tabs and fall back for retired or unknown tabs',()=>{
  for(const tab of ['overview','roster','materials','stats','notifications','history']){
    const route=matchAdminLocation(`/admin/wipes/wipe_1?tab=${tab}&view=archive#content`);
    assert.equal(adminWipeTab(route.searchParams.get('tab')),tab);
    assert.equal(route.searchParams.get('view'),'archive');assert.equal(route.hash,'#content');
  }
  for(const suffix of ['', '?tab=', '?tab=plan', '?tab=unknown', '?tab=__proto__']){
    const route=matchAdminLocation(`/admin/wipes/wipe_139f9de8-e441-49fd-9b91-d4102b23e069${suffix}`);
    assert.equal(route.page,'wipe');assert.equal(adminWipeTab(route.searchParams.get('tab')),'overview');
  }
});
test('new arrangement creates with immediate signup for all members',()=>{const f=draftForm(null),body=draftCommand(f);assert.equal(f.autoStart,false);assert.equal(body.publishImmediately,true);assert.equal(body.autoOpenSignup,true);assert.deepEqual(body.audience,{allMembers:true,squadIds:[],memberIds:[],includeUnassigned:true});assert.equal(Object.hasOwn(body,'signupOpensAt'),false);assert.equal(Object.hasOwn(f.times,'signupOpensAt'),false);});
test('draft roundtrip preserves server details and avoids a hidden legacy time change',()=>{const w={revision:7,timeZone:'Asia/Shanghai',musterAt:'2026-10-01T10:00:00.000Z',serverScheduledWipeAt:'2026-10-01T11:00:00.000Z',signupOpensAt:'2026-09-30T10:00:00.000Z',signupClosesAt:'2026-10-01T09:00:00.000Z',serverProfileId:'real-server',serverSnapshot:{name:'Atlas',connectCommand:'client.connect example:28015'},audience:{squadIds:['s1'],memberIds:[],includeUnassigned:false},autoOpenSignup:false};const f=draftForm(w),body=draftCommand(f,w);assert.equal(body.expectedRevision,7);assert.equal(body.serverProfileId,'real-server');assert.deepEqual(body.serverSnapshot,w.serverSnapshot);assert.equal(Object.hasOwn(f.times,'musterAt'),false);assert.equal(body.musterAt,w.musterAt);assert.equal(Object.hasOwn(body.rawTimeInputs,'musterAt'),false);assert.deepEqual(body.audience,w.audience);body.audience.squadIds.push('other');assert.deepEqual(f.audience.squadIds,['s1']);});
test('editing the opening time also updates the legacy scheduling field',()=>{const w={revision:7,timeZone:'Asia/Shanghai',musterAt:'2026-10-01T10:00:00.000Z',serverScheduledWipeAt:'2026-10-01T11:00:00.000Z'};const f=draftForm(w);const changed={...f,...manualTimePatch(f,'serverScheduledWipeAt','2026-10-01T20:00')};const body=draftCommand(changed,w);assert.equal(body.musterAt,body.serverScheduledWipeAt);assert.deepEqual(body.rawTimeInputs.musterAt,body.rawTimeInputs.serverScheduledWipeAt);});
test('DST gap rejected; fold requires deliberate offset',()=>{const f=draftForm(null,'America/New_York');f.times.serverScheduledWipeAt='2026-03-08T02:30';assert.throws(()=>draftCommand(f),e=>e.errorCode==='TIME_NONEXISTENT');f.times.serverScheduledWipeAt='2026-11-01T01:30';assert.throws(()=>draftCommand(f),e=>e.errorCode==='TIME_AMBIGUOUS');f.offsets.serverScheduledWipeAt='-05:00';assert.equal(draftCommand(f).musterAt,'2026-11-01T06:30:00.000Z');});
test('signup deadline follows expected opening until manually changed',()=>{
  let f=draftForm(null);
  f={...f,...manualTimePatch(f,'serverScheduledWipeAt','2026-10-01T20:00')};
  assert.equal(f.times.signupClosesAt,'2026-10-01T20:00');
  f={...f,...manualTimePatch(f,'serverScheduledWipeAt','2026-10-02T20:00')};
  assert.equal(f.times.signupClosesAt,'2026-10-02T20:00');
  f={...f,...manualTimePatch(f,'signupClosesAt','2026-10-02T18:00')};
  f={...f,...serverTemplatePatch(template('2026-10-04T12:00:00Z'),f)};
  f={...f,...manualTimePatch(f,'serverScheduledWipeAt','2026-10-05T20:00')};
  assert.equal(f.times.signupClosesAt,'2026-10-02T18:00');
});
test('saved draft finishes atomically while published edit keeps its audience and lifecycle',()=>{
  const draft={lifecycle:'draft',revision:2,audience:{squadIds:['s1'],memberIds:[],includeUnassigned:false}};
  const body=draftCommand(draftForm(draft),draft);assert.equal(body.publishImmediately,true);assert.equal(body.audience.allMembers,true);
  const published={...draft,lifecycle:'scheduled'},edit=draftCommand(draftForm(published),published);
  assert.equal(Object.hasOwn(edit,'publishImmediately'),false);assert.deepEqual(edit.audience,published.audience);
});
test('phase commands distinguish cancellation, abort via end, archive and actual start',()=>{assert.deepEqual(availableCommands({lifecycle:'draft'}),['publish','cancel']);assert.ok(!availableCommands({lifecycle:'active'}).includes('cancel'));assert.ok(availableCommands({lifecycle:'active'}).includes('end'));assert.ok(availableCommands({lifecycle:'active'}).includes('confirm-server-start'));assert.deepEqual(availableCommands({lifecycle:'archived'}),['revise-archive']);});
test('successful scheduling edits invalidate shared member and admin facts',()=>{const keys=[];invalidateWipe({invalidateQueries:k=>keys.push(k)},'w1');for(const key of [['wipe','w1'],['signups','w1'],['home'],['wipes'],['history'],['admin-wipes']])assert.ok(keys.some(x=>JSON.stringify(x)===JSON.stringify(key)));});

const template=(date)=>({id:date||'manual',serverSnapshot:{name:'EU Mondays',...(date?{nextWipeAt:date}:{})}});
test('template defaults follow next wipe in the selected zone and update only automatic fields',()=>{
  let f=draftForm(null,'Asia/Shanghai');
  f={...f,...serverTemplatePatch(template('2026-09-21T14:00:00Z'),f)};
  assert.equal(f.times.serverScheduledWipeAt,'2026-09-21T22:00');
  assert.equal(Object.hasOwn(f.times,'musterAt'),false);
  assert.equal(f.times.signupClosesAt,f.times.serverScheduledWipeAt);
  assert.equal(draftCommand(f).musterAt,'2026-09-21T14:00:00.000Z');
  f={...f,...serverTemplatePatch(template('2026-09-24T14:00:00Z'),f)};
  assert.equal(f.times.serverScheduledWipeAt,'2026-09-24T22:00');
  f={...f,...serverTemplatePatch(template('2026-10-01T18:00:00Z'),f)};
  assert.equal(draftCommand(f).musterAt,'2026-10-01T18:00:00.000Z');
  f={...f,...serverTemplatePatch(template(null),f)};
  assert.equal(f.times.serverScheduledWipeAt,'');
});
test('loading an existing draft protects history including intentionally empty times',()=>{
  const f=draftForm({musterAt:'2026-09-21T12:00:00Z',timeZone:'Asia/Shanghai'});
  const changed={...f,...serverTemplatePatch(template('2026-09-21T14:00:00Z'),f)};
  assert.deepEqual(changed.times,f.times);
  assert.equal(changed.times.serverScheduledWipeAt,'');
});
test('zone changes preserve actual instants and template defaults resolve DST folds',()=>{
  let f=draftForm(null,'America/New_York');
  f={...f,...serverTemplatePatch(template('2026-11-01T06:30:00Z'),f)};
  assert.equal(f.times.serverScheduledWipeAt,'2026-11-01T01:30');
  assert.equal(Object.hasOwn(f.times,'musterAt'),false);
  assert.equal(f.offsets.serverScheduledWipeAt,'-05:00');
  assert.equal(f.offsets.signupClosesAt,'-05:00');
  assert.equal(draftCommand(f).signupClosesAt,draftCommand(f).serverScheduledWipeAt);
  assert.equal(draftCommand(f).musterAt,draftCommand(f).serverScheduledWipeAt);
  const before=draftCommand(f);
  f={...f,...timeZonePatch(f,'Asia/Shanghai')};
  assert.equal(f.times.serverScheduledWipeAt,'2026-11-01T14:30');
  assert.equal(Object.hasOwn(f.times,'musterAt'),false);
  assert.equal(draftCommand(f).musterAt,before.musterAt);
  assert.equal(draftCommand(f).serverScheduledWipeAt,before.serverScheduledWipeAt);
  assert.equal(draftCommand(draftForm(before)).serverScheduledWipeAt,before.serverScheduledWipeAt);
  assert.throws(()=>timeZonePatch(f,'Invalid/Zone'),e=>e.errorCode==='TIME_ZONE_INVALID');
});
