import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { fixture } from './support/v2-platform-host/fixture.mjs';
import { createMiniMemberViews } from '../server/v2/management-adapters/platforms/mini-members.js';
import { specialties } from '../shared/member-preferences.js';

function setup(t) {
  const f = fixture(); t.after(() => f.close());
  for (const m of f.ir.all('members')) f.ir.put('members', { ...m, specialty: [], specialties: [] });
  const mine = f.ir.get('members', 'm002'), other = f.ir.get('members', 'm003');
  f.ir.put('members', { ...mine, specialty: ['electricity', '电工'], phone: 'hidden-phone' });
  f.ir.put('members', { ...other, specialty: ['电力'], notes: 'hidden-note' });
  for (const relation of f.ir.all('squadMembers').filter(row => row.memberId === other.id)) f.ir.remove('squadMembers', relation.id);
  f.ir.put('squadMembers', { id: 'specialty-other-squad', memberId: other.id, squadId: 's2', validTo: null });
  f.ir.put('members', { ...mine, id: 'specialty-member', steamId: '76561198000012345', customName: '专长队友', specialty: ['电工'] });
  f.ir.put('squadMembers', { id: 'specialty-squad-member', memberId: 'specialty-member', squadId: 's1', validTo: null });
  const views = createMiniMemberViews(f);
  return { ...f, mine, other, read: input => views.directory({ actor: f.actor('member'), input }) };
}

test('directory specialty filtering normalizes canonical and historical labels before pagination and totals', t => {
  const f = setup(t), all = f.read({ specialty: 'electricity', limit: 1 });
  assert.equal(all.total, 3); assert.equal(all.items.length, 1);
  const second = f.read({ specialty: '电工', offset: 1, limit: 1 });
  assert.equal(second.total, 3); assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].id, all.items[0].id);
  assert.deepEqual(second.items[0].specialties, ['electricity']);
  assert.equal(f.read({ specialty: '电力', offset: 3, limit: 1 }).items.length, 0);
  assert.deepEqual(all.specialtyOptions, Object.entries(specialties).map(([id, label]) => ({ id, label })));
  assert.ok(!JSON.stringify(all).includes('hidden-'));
  assert.deepEqual(Object.keys(all.items[0]).sort(), ['avatar', 'id', 'name', 'specialties', 'squads', 'steamId', 'steamNickname'].sort());
});

test('specialty, squad and Steam search combine without broadening unknown filters or inactive members', t => {
  const f = setup(t);
  const selected = f.read({ q: f.other.steamId, squadId: 's2', specialty: 'electricity' });
  assert.equal(selected.total, 1); assert.equal(selected.items[0].id, 'm003');
  assert.equal(f.read({ q: f.other.steamId, squadId: 's1', specialty: 'electricity' }).total, 0);
  assert.equal(f.read({ specialty: 'unknown-specialty' }).total, 0);
  assert.equal(f.read({ specialty: '神豪' }).total, 0);
  assert.throws(() => f.read({ specialty: ['electricity'] }), { errorCode: 'MINI_SPECIALTY_INVALID' });
  f.ir.put('members', { ...f.ir.get('members', 'm003'), memberStatus: 'left' });
  assert.equal(f.read({ specialty: 'electricity' }).total, 2);
  f.ir.put('restrictions', { id: 'specialty-deny', accountId: 'member', kind: 'deny_access', startsAt: new Date(f.now() - 1).toISOString() });
  assert.throws(() => f.read({ specialty: 'electricity' }), { errorCode: 'ACCESS_RESTRICTED' });
});

function pageHarness(readCommand) {
  const file = fileURLToPath(new URL('../wechat-miniprogram/miniprogram/pages/members/index/index.js', import.meta.url));
  const localRequire = createRequire(file), copied = [];
  let definition;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { definition = value; },
    require: request => request.endsWith('/services/api') ? { readCommand } : request.endsWith('/utils/page') ?
      { access: async page => { page.setData({ linked: true }); return { linked: true }; }, goLink() {} } : localRequire(request),
    wx: { setClipboardData: value => copied.push(value.data) }, setTimeout, clearTimeout });
  const page = { ...definition, active: true, data: structuredClone(definition.data), setData(patch) { Object.assign(this.data, patch); } };
  return { page, copied };
}

test('member page uses combined server filter for every page, resets pagination when selecting, and copies exact SteamID', async () => {
  const calls = [], options = [{ id: 'electricity', label: '电力' }];
  const { page, copied } = pageHarness(async (command, input) => {
    calls.push({ command, input });
    return { items: [{ id: `m${input.offset}`, name: '队友', steamId: '76561198000012345', specialties: ['electricity'], squads: [{ id: 's1', name: '一队' }] }],
      squads: [{ id: 's1', name: '一队' }], specialtyOptions: options, total: 2 };
  });
  await page.load();
  assert.equal(page.data.items[0].specialtyTags[0].label, '电力');
  assert.ok(page.data.items[0].specialtyTags[0].tone);
  assert.equal('specialty' in calls[0].input, false);
  page.setData({ squadIndex: 1, query: '7656' });
  await page.selectSpecialty({ detail: { value: '1' } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).input)), { q: '7656', squadId: 's1', specialty: 'electricity', offset: 0, limit: 40 });
  assert.equal(page.data.specialtyIndex, 1); assert.equal(page.data.hasMore, true);
  await page.fetch(false);
  assert.equal(calls.at(-1).input.specialty, 'electricity'); assert.equal(calls.at(-1).input.offset, 1);
  assert.equal(page.data.items.length, 2); assert.equal(page.data.hasMore, false);
  await page.selectSpecialty({ detail: { value: '0' } });
  assert.equal('specialty' in calls.at(-1).input, false); assert.equal(calls.at(-1).input.offset, 0);
  page.copySteamId({ currentTarget: { dataset: { steamid: '76561198000012345' } } });
  page.copySteamId({ currentTarget: { dataset: {} } });
  assert.deepEqual(copied, ['76561198000012345']);
});

test('late unfiltered result cannot replace a newer specialty-filtered result', async () => {
  let finish;
  const options = [{ id: 'electricity', label: '电力' }];
  const { page } = pageHarness(async (_command, input) => input.specialty ?
    { items: [{ id: 'filtered', specialties: ['electricity'] }], specialtyOptions: options, total: 1 } :
    new Promise(resolve => { finish = resolve; }));
  page.setData({ linked: true });
  const initial = page.fetch(true);
  page.setData({ specialtyOptions: [{ id: '', label: '全部专长' }, ...options] });
  await page.selectSpecialty({ detail: { value: '1' } });
  finish({ items: [{ id: 'old', specialties: [] }], specialtyOptions: options, total: 99 });
  await initial;
  assert.equal(page.data.items[0].id, 'filtered'); assert.equal(page.data.total, 1); assert.equal(page.data.specialtyIndex, 1);
});
