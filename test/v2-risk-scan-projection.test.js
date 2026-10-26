// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-member-admin/fixtures.mjs';
import { riskScanDTO } from '../server/v2/member-admin/risk-scan.js';
test('risk projection keeps private current status with old numeric observation and rejects identity mismatch', t => {
  const f = fixture({scopeContract:true}); t.after(() => f.db.close());
  const member = f.ir.get('members','m001'), profile = f.service.repo.get('memberProfiles','profile-m001');
  const old = '2020-01-01T00:00:00.000Z', current = '2030-09-08T09:00:00.000Z';
  f.service.repo.put('memberProfiles',{...profile,steamId:member.steamId,inventoryValue:1,inventoryPublic:true,inventoryVisibility:'public',
    accountSignals:{...profile.accountSignals,inventoryValue:1,inventoryPublic:true,inventoryVisibility:'public'},fetchedAt:current,
    riskScan:{steamId:member.steamId,quality:'partial',checkedAt:current,lastCompleteAt:old,token:'must-not-leak',
      sources:{inventory:{status:'private',required:true,checkedAt:current,error:'SOURCE_PRIVATE',token:'must-not-leak'}},
      fields:{inventoryValue:{status:'private',required:true,observedAt:old,checkedAt:current,retained:true,context:{steamId:member.steamId,token:'must-not-leak'}}}}});
  const detail = f.service.detail(f.actor('admin'),member.id);
  assert.equal(detail.riskScan.sources.inventory.status,'private');
  assert.equal(JSON.stringify(detail.riskScan).includes('must-not-leak'),false);
  const alert = detail.risks.find(e=>e.type==='inventory_value'); assert.ok(alert);
  assert.equal(alert.observedAt,old); assert.equal(alert.retained,true); assert.equal(alert.currentStatus,'private');
  assert.equal(alert.freshness,'stale');
  f.ir.put('accounts',{...f.ir.get('accounts','viewer'),grants:[{capability:'members.read',scope:{type:'all'},effect:'allow'}]});
  assert.equal(f.service.detail(f.actor('viewer'),member.id).riskScan,undefined);
  const updated = f.service.repo.get('memberProfiles','profile-m001');
  assert.equal(riskScanDTO(updated,{...member,steamId:'76561198000009999'}),null);
  f.service.repo.put('memberProfiles',{...updated,steamId:'76561198000009999'});
  assert.equal(f.service.riskProfile(member),undefined);
});
