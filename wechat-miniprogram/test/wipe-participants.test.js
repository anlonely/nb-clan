const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const wipe = id => ({ id, title: id, lifecycle: 'active', contentRevision: 1, signupWindow: 'open',
  startsAt: '2030-09-08T11:00:00Z', mySignup: { response: null, signupRevision: 0 } });
const respondent = (memberId, response = 'attending_on_time') => ({ memberId, name: memberId, squadName: '先锋队', response, needsReconfirmation: false });
const roster = (wipeId, items = [], extra = {}) => ({ wipeId, items, total: items.length, nextCursor: null, rosterRevision: 1, countScope: 'audience',
  counts: { eligibleTotal: 50, onTime: 20, later: 10, notAttending: 10, unanswered: 10, responseTotal: 40, confirmedAttending: 28, pendingReconfirmation: 2, pendingReconfirmationAttending: 2 }, ...extra });
function loadPage(api) {
  const file = path.resolve(__dirname, '../miniprogram/pages/wipe/index/index.js'), localRequire = createRequire(file);
  let definition; const clipboard = [];
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { definition = value; },
    require: request => request.endsWith('/services/api') ? { operationId: () => 'test-operation', ...api } : request.endsWith('/utils/page') ? {
      access: async page => { page.setData({ linked: true }); return { linked: true }; }, goLink() {}
    } : localRequire(request), wx: { stopPullDownRefresh() {}, setClipboardData({ data }) { clipboard.push(data); } }, Date });
  return { ...definition, clipboard, data: structuredClone(definition.data), active: true, setData(patch) { Object.assign(this.data, patch); } };
}
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('signup page uses server totals and loads further respondents without replacing the first page', async () => {
  const calls = [];
  const page = loadPage({ readCommand: async (command, input) => {
    calls.push({ command, input });
    if (command === 'member_wipes') return { items: [wipe('w1')] };
    return input.cursor ? roster('w1', [respondent('m2', 'attending_later')], { total: 40 }) :
      roster('w1', [respondent('m1')], { nextCursor: 'm1', total: 40, regionCounts: { cn: 15, eu: 10, unknown: 5 } });
  } });
  await page.load();
  assert.equal(page.data.participantCounts.responseTotal, 40); assert.equal(page.data.participantItems.length, 1);
  assert.equal(page.data.participantCounts.unanswered, 10); assert.equal(page.data.participantTotal, 40);
  assert.deepEqual(page.data.participantRegionCounts, { cn: 15, eu: 10, unknown: 5 });
  await page.loadMoreParticipants();
  assert.deepEqual(Array.from(page.data.participantItems, row => row.memberId), ['m1', 'm2']);
  assert.equal(calls.at(-1).input.cursor, 'm1'); assert.equal(page.data.participantsCursor, null);
  assert.equal(page.data.participantCounts.responseTotal, 40); assert.equal(page.data.participantsLoading, false);
});

test('a delayed response for the previous wipe cannot replace the selected wipe roster', async () => {
  const old = deferred(); let delayed = false;
  const page = loadPage({ readCommand: async (command, input) => {
    if (command === 'member_wipes') return { items: [wipe('w1'), wipe('w2')] };
    if (delayed && input.wipeId === 'w1') return old.promise;
    return roster(input.wipeId, [respondent(input.wipeId === 'w1' ? 'old' : 'new')]);
  } });
  await page.load(); delayed = true;
  const refresh = page.refreshParticipants();
  await page.selectWipe({ detail: { value: 1 } });
  old.resolve(roster('w1', [respondent('wrong')])); await refresh;
  assert.equal(page.data.current.id, 'w2'); assert.equal(page.data.participantItems[0].memberId, 'new');
  assert.equal(page.data.participantsLoading, false); assert.equal(page.data.participantsError, '');
});

test('hiding during a roster request does not leave the page busy or allow an old response after returning', async () => {
  const old = deferred(); let reads = 0;
  const page = loadPage({ readCommand: async command => {
    if (command === 'member_wipes') return { items: [wipe('w1')] };
    return ++reads === 1 ? old.promise : roster('w1', [respondent('fresh')]);
  } });
  const first = page.load(); await tick();
  page.onHide(); assert.equal(page.data.loading, false); assert.equal(page.data.participantsLoading, false);
  page.active = true; await page.load();
  old.resolve(roster('w1', [respondent('stale')])); await first;
  assert.equal(page.data.participantItems[0].memberId, 'fresh'); assert.equal(page.data.loading, false);
});

test('a roster revision change during pagination restarts the list instead of mixing snapshots', async () => {
  let reads = 0; const cursors = [];
  const page = loadPage({ readCommand: async (command, input) => {
    if (command === 'member_wipes') return { items: [wipe('w1')] };
    cursors.push(input.cursor); reads++;
    if (reads === 1) return roster('w1', [respondent('old-first')], { nextCursor: 'old-first', rosterRevision: 1 });
    if (input.cursor) return roster('w1', [respondent('new-second')], { rosterRevision: 2 });
    return roster('w1', [respondent('new-first')], { rosterRevision: 2 });
  } });
  await page.load(); await page.loadMoreParticipants();
  assert.deepEqual(cursors, ['', 'old-first', '']);
  assert.deepEqual(Array.from(page.data.participantItems, row => row.memberId), ['new-first']);
  assert.equal(page.data.participantsLoading, false);
});

test('a saved signup refreshes the roster and preserves arrival labels', async () => {
  let saved = false, reads = 0;
  const page = loadPage({ readCommand: async command => {
    if (command === 'member_wipes') return { items: [wipe('w1')] };
    reads++;
    return roster('w1', saved ? [{ ...respondent('me', 'attending_later'), expectedArrivalAt: '2030-09-08T13:30:00Z' }] : []);
  }, submitWipeSignup: async () => { saved = true; return { current: { response: 'attending_on_time', signupRevision: 1 } }; } });
  await page.load(); await page.signup({ currentTarget: { dataset: { response: 'attending_on_time' } } });
  assert.equal(reads, 2); assert.equal(page.data.participantItems[0].statusText, '晚点参加');
  assert.equal(page.data.participantItems[0].arrivalText, '2030-09-08 21:30'); assert.equal(page.data.participantItems[0].needsReconfirmation, false);
  assert.match(page.data.resultText, /已保存/); assert.equal(page.data.submitting, false);
});

test('a failed later page preserves loaded members and totals, with a retryable error', async () => {
  const page = loadPage({ readCommand: async (command, input) => {
    if (command === 'member_wipes') return { items: [wipe('w1')] };
    if (input.cursor) throw new Error('暂时断网');
    return roster('w1', [respondent('m1')], { total: 40, nextCursor: 'm1' });
  } });
  await page.load(); await page.loadMoreParticipants();
  assert.equal(page.data.participantItems[0].memberId, 'm1'); assert.equal(page.data.participantCounts.responseTotal, 40);
  assert.equal(page.data.participantsError, '暂时断网'); assert.equal(page.data.participantsLoading, false);
});

test('member dialog exposes the listed Steam ID and shared colorful specialties, and copies only the selected ID', async () => {
  const steamId = '76561198000000001';
  const page = loadPage({ readCommand: async command => command === 'member_wipes' ? { items: [wipe('w1')] } :
    roster('w1', [{ ...respondent('m1'), steamId, specialties: ['pvp', 'building'] }]) });
  await page.load(); page.openParticipant({ currentTarget: { dataset: { memberId: 'm1' } } });
  assert.equal(page.data.selectedParticipant.steamId, steamId);
  assert.deepEqual(Array.from(page.data.selectedParticipant.specialtyTags, tag => tag.label), ['PVP', '建筑']);
  assert.ok(page.data.selectedParticipant.specialtyTags.every(tag => ['blue', 'violet', 'teal', 'amber', 'rose', 'cyan'].includes(tag.tone)));
  page.copyParticipantSteamId(); assert.deepEqual(page.clipboard, [steamId]);
  page.closeParticipant(); page.copyParticipantSteamId(); assert.equal(page.clipboard.length, 1);
  page.openParticipant({ currentTarget: { dataset: { memberId: 'not-visible' } } }); assert.equal(page.data.selectedParticipant, null);
  page.openParticipant({ currentTarget: { dataset: { memberId: 'm1' } } });
  await page.refreshParticipants(); assert.equal(page.data.selectedParticipant, null);
});

test('the mini signup page retains not-attending but never submits the removed withdrawal action', async () => {
  const writes = [];
  const page = loadPage({ readCommand: async command => command === 'member_wipes' ? { items: [wipe('w1')] } : roster('w1'),
    submitWipeSignup: async (_wipe, response) => { writes.push(response); return { current: { response, signupRevision: 1 } }; } });
  await page.load();
  await page.signup({ currentTarget: { dataset: { response: 'withdraw' } } });
  assert.deepEqual(writes, []);
  await page.signup({ currentTarget: { dataset: { response: 'not_attending' } } });
  assert.deepEqual(writes, ['not_attending']); assert.equal(page.data.resultText, '报名状态已保存。');
});
