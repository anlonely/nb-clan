import test from 'node:test';
import assert from 'node:assert/strict';
import { wipeServerCatalog } from '../server/v2/production/wipe-catalog.js';
import { createProductionNotificationOwner } from '../server/v2/production/notifications.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { draftForm, draftCommand, serverTemplatePatch } from '../src/v2/admin/model.js';

test('production wipe choices preserve usable snapshots through selection and draft normalization', async t => {
  let settings = {};
  const owner = createProductionNotificationOwner({ getIdentity: async () => ({}),
    getPlatformService: () => ({ identity: {}, config: () => ({ enabled: false, targets: [] }) }),
    publicOrigin: 'https://nb.example', readCredentials: () => ({}),
    readServerCatalog: () => wipeServerCatalog(settings, new Date('2026-09-21T08:00:00Z')), fetchImpl: () => { throw new Error('unexpected network'); } });
  t.after(() => owner.stop());
  const options = () => owner.catalog.listOptions('servers').items;
  const choices = options();
  assert.equal(choices.length, 12);
  const atlas=choices.find(row=>row.id==='atlas-eu-2x-medium').serverSnapshot;
  assert.equal(atlas.currentWipeAt, '2026-09-17T16:00:00.000Z');
  assert.equal(atlas.nextWipeAt, '2026-10-01T18:00:00.000Z');
  assert.equal(atlas.currentWipeSource, 'schedule_fallback');
  assert.equal(atlas.scheduleTimeZone, 'Europe/London');
  const vital=choices.find(row=>row.id==='16').serverSnapshot;
  assert.equal(vital.currentWipeAt, '2026-09-03T18:00:00.000Z');
  assert.equal(vital.nextWipeAt, '2026-09-24T16:00:00.000Z');
  assert.equal(vital.nextWipeSource, 'schedule_fallback');
  assert.equal(vital.scheduleTimeZone, 'Europe/London');
  assert.equal(choices.find(row => row.id === 'atlas-us-2x-medium').serverSnapshot.scheduleTimeZone, 'America/New_York');
  assert.deepEqual(choices.filter(row=>row.id.startsWith('moose-')).map(row=>row.label),['EU Mondays','EU Medium','EU Main','EU Monthly']);
  const moose=choices.find(row=>row.id==='moose-eu-main').serverSnapshot;
  assert.equal(moose.currentWipeAt, undefined);
  assert.equal(moose.nextWipeAt, undefined);
  assert.ok(choices.some(row => row.id === 'atlas-eu-2x-medium' && row.serverSnapshot.atlasId === '10'));
  assert.ok(choices.some(row => row.id === '19' && row.serverSnapshot.vitalServerId === '19'));
  assert.ok(choices.some(row => row.id === 'atlas-us-2x-medium' && row.serverSnapshot.atlasId === '33'));
  assert.ok(choices.some(row => row.id === 'moose-eu-main' && row.serverSnapshot.mooseServerId === 'eu-main'));
  assert.ok(!choices.some(row => ['4', '23'].includes(row.id)));
  for (const row of choices) {
    const form = { ...draftForm(null), title: 'Template selection', ...serverTemplatePatch(row) };
    assert.ok(form.serverSnapshot.name);
    assert.equal(typeof form.serverSnapshot.connectCommand, 'string');
    const saved = SchedulingService.prototype.normalizeWipe.call({}, draftCommand(form));
    assert.equal(saved.serverProfileId, row.id);
    assert.deepEqual(saved.serverSnapshot, row.serverSnapshot);
  }
  settings = { vitalServers: { overrides: [{ vitalServerId: '23', status: 'active' }, { vitalServerId: '19', name: 'Configured Medium',
    directConnect: 'client.connect configured.example:28015' }, { vitalServerId: '16', status: 'hidden' }] } };
  assert.equal(options().find(row => row.id === '19').serverSnapshot.connectCommand, 'client.connect configured.example:28015');
  assert.equal(options().find(row => row.id === '19').label, 'Configured Medium');
  assert.equal(options().find(row => row.id === '23').serverSnapshot.vitalServerId, '23');
  assert.ok(!options().some(row => row.id === '16'));
  // Older cached API responses must still be selectable without crashing the editor.
  const fallback = serverTemplatePatch({ id: 'legacy', label: 'Legacy server' });
  assert.equal(draftCommand({ ...draftForm(null), ...fallback }).serverSnapshot.name, 'Legacy server');
});
