const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { parseLinkQr, hours, arrivalIso, wipe } = require('../miniprogram/utils/presentation');
function loadPage(name, api, linked = true) {
  const file = path.resolve(__dirname, `../miniprogram/pages/${name}/index/index.js`);
  const localRequire = createRequire(file);
  let definition;
  const wx = { showToast() {}, stopPullDownRefresh() {}, getStorageSync() {}, setStorageSync() {}, removeStorageSync() {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: value => { definition = value; }, require: request => request.endsWith('/services/api') ? api : request.endsWith('/utils/page') ? { access: async page => { page.setData({ linked }); return { complete: true, linked, nickName: '微信名' }; }, goLink() {} } : localRequire(request), wx, console, setTimeout, clearTimeout, setInterval, clearInterval, Date });
  const page = { ...definition, data: structuredClone(definition.data), active: true, setData(patch) { Object.assign(this.data, patch); } };
  return { page, wx };
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }
test('wipe display and default arrival use 05:00 server time over 04:00 legacy muster', () => {
  const startsAt = '2026-09-24T20:00:00.000Z', serverStartsAt = '2026-09-24T21:00:00.000Z';
  const current = wipe({ startsAt, serverStartsAt });
  assert.equal(current.startsAtText, '2026-09-25 05:00');
  assert.equal(wipe({ startsAt }).startsAtText, '2026-09-25 04:00');
  const { page } = loadPage('wipe', {});
  page.active = false;
  page.applyCurrent(current);
  assert.equal(page.data.arrivalDate, '2026-09-25');
  assert.equal(page.data.arrivalTime, '05:00');
});
test('wipe server copy uses the current selection and skips missing or unlinked values', () => {
  const { page, wx } = loadPage('wipe', {}), copied = [];
  wx.setClipboardData = ({ data }) => copied.push(data);
  const copy = field => page.copyServerInfo({ currentTarget: { dataset: { field } } });
  page.setData({ linked: true, current: { connectCommand: 'connect rust.example.com:28015', mapUrl: 'https://rustmaps.com/map/first' } });
  copy('connectCommand'); copy('mapUrl'); copy('title');
  page.setData({ current: { connectCommand: '', mapUrl: 'https://rustmaps.com/map/second' } });
  copy('connectCommand'); copy('mapUrl');
  page.setData({ linked: false }); copy('mapUrl');
  page.setData({ linked: true, current: null }); copy('connectCommand');
  assert.deepEqual(copied, ['connect rust.example.com:28015', 'https://rustmaps.com/map/first', 'https://rustmaps.com/map/second']);
});
test('unlinked tabs retain empty UI without association prompts or member requests', async () => {
  for (const name of ['mine', 'members', 'wipe', 'rankings']) {
    let reads = 0;
    const { page } = loadPage(name, { readCommand: async () => { reads++; return {}; }, avatarDisplayUrl: async () => '' }, false);
    await page.load();
    assert.equal(reads, 0, name);
    assert.equal(page.data.linked, false, name);
    assert.equal(page.data.loading, false, name);
    assert.equal(page.data.errorText, '', name);
    const markup = fs.readFileSync(path.resolve(__dirname, `../miniprogram/pages/${name}/index/index.wxml`), 'utf8');
    assert.doesNotMatch(markup, /is="unlinked"|bindtap="goLink"/);
    if (name === 'members' || name === 'rankings') { await page.fetch(true); await page.fetch(false); assert.equal(page.data.total, 0); assert.equal(page.data.hasMore, false); }
    if (name === 'wipe') { await page.refreshWipes(); await page.loadParticipants(true); assert.equal(page.data.current, null); }
    if (name === 'mine') { assert.equal(page.data.wechat, null); assert.equal(page.data.wechatAvatar, ''); assert.equal(page.data.member.recentWipes.length, 0); }
    assert.equal(reads, 0, name);
  }
});
test('directory defaults to all squads and sends selected squad plus query and pagination', async () => {
  const calls = [];
  const { page } = loadPage('members', { readCommand: async (command, input) => { calls.push({ command, input }); return { items: [{ id: 'm1', name: '成员', specialties: ['pvp'], squads: [{ id: 's1', name: '一队' }] }], squads: [{ id: 's1', name: '一队' }], total: 1 }; } });
  await page.load();
  assert.equal(calls[0].command, 'member_directory'); assert.equal(calls[0].input.squadId, '');
  assert.equal(page.data.items[0].specialtiesText, 'PVP');
  page.setData({ squadIndex: 1, query: 'Steam' }); await page.fetch(true);
  assert.deepEqual(plain(calls[1].input), { q: 'Steam', squadId: 's1', offset: 0, limit: 40 });
});
test('re-clicking attending is not withdrawal and network retry reuses displayed versions and operation key', async () => {
  const calls = []; let attempts = 0;
  const record = { id: 'w1', title: '开荒', lifecycle: 'active', contentRevision: 9, signupWindow: 'open', mySignup: { signupRevision: 4, response: 'attending_on_time' } };
  const { page } = loadPage('wipe', { operationId: () => `op-${calls.length}`, readCommand: async command => command === 'member_wipes' ? { items: [record] } : { wipeId: 'w1', items: [], counts: {}, total: 0 }, submitWipeSignup: async (...args) => { calls.push(args); if (attempts++ === 0) throw new Error('网络失败'); return { current: { signupRevision: 5, response: args[1] } }; } });
  await page.load();
  await page.signup({ currentTarget: { dataset: { response: 'attending_on_time' } } });
  await page.signup({ currentTarget: { dataset: { response: 'attending_on_time' } } });
  assert.equal(calls.length, 2); assert.equal(calls[0][1], 'attending_on_time'); assert.equal(calls[1][1], 'attending_on_time');
  assert.equal(calls[0][3], calls[1][3]); assert.equal(calls[0][0].contentRevision, 9); assert.equal(calls[0][0].mySignup.signupRevision, 4);
});
test('revision conflict refreshes display but never silently submits a changed version', async () => {
  let reads = 0, writes = 0;
  const { page } = loadPage('wipe', { operationId: () => 'op', readCommand: async command => command === 'member_wipes' ? { items: [{ id: 'w1', title: '开荒', lifecycle: 'active', contentRevision: ++reads, signupWindow: 'open', mySignup: { signupRevision: 0 } }] } : { wipeId: 'w1', items: [], counts: {}, total: 0 }, submitWipeSignup: async () => { writes++; throw Object.assign(new Error('conflict'), { statusCode: 409 }); } });
  await page.load(); await page.signup({ currentTarget: { dataset: { response: 'not_attending' } } });
  assert.equal(writes, 1); assert.equal(page.data.current.contentRevision, 2); assert.match(page.data.errorText, /核对.*重新选择/);
});
test('mine distinguishes missing playtime from zero and renders at most 3 historical records with stale data marked', async () => {
  const { page } = loadPage('mine', { avatarDisplayUrl: async () => 'wxfile://avatar', readCommand: async () => ({ member: { id: 'm1', specialties: ['building'], rustTotalMinutes: null, wipeMinutes: 0, official: { status: 'stale', values: { kills: 0 } }, recentWipes: Array.from({ length: 4 }, (_, i) => ({ id: String(i), response: 'attending_on_time' })) } }) });
  await page.load();
  assert.equal(page.data.member.rustTotalText, '暂无数据'); assert.equal(page.data.member.wipeTimeText, undefined);
  assert.equal(page.data.member.recentWipes.length, 3); assert.equal(page.data.member.officialStale, true); assert.equal(page.data.member.officialRows[0].value, '0');
});
test('QR parser only accepts the website association payload and unknown hours remain unknown', () => {
  const code = `nbclan:wechat-link:${'x'.repeat(43)}`;
  assert.equal(parseLinkQr(code), code);
  for (const input of ['https://example.com', 'nbclan:wechat-link:bad', 'javascript:alert(1)']) assert.throws(() => parseLinkQr(input));
  assert.equal(hours(null), '暂无数据'); assert.equal(hours(0), '0.0 小时');
  assert.equal(arrivalIso('2026-09-24', '20:30'), '2026-09-24T12:30:00.000Z');
  assert.equal(wipe({ lifecycle: 'ended', signupWindow: 'open' }).canSignup, false);
});
test('manifest has exactly the 5 requested tabs and no registration or management route', () => {
  const manifest = require('../miniprogram/app.json');
  assert.deepEqual(manifest.tabBar.list.map(item => item.text), ['关联', '开荒', '队伍', '排行', '我的']);
  assert.equal(manifest.pages.some(page => /admin|join-application/.test(page)), false);
});
test('association page recovers from hiding during an in-flight load', async () => {
  let finish, count = 0;
  const { page } = loadPage('link', { ensureCanEnterApp: () => ++count === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ complete: true, linked: false }) });
  const first = page.load();
  assert.equal(page.data.loading, true);
  page.onHide();
  finish({ complete: true, linked: false }); await first;
  assert.equal(page.data.loading, false);
  page.active = true; await page.load();
  assert.equal(count, 2); assert.equal(page.data.loading, false);
});
test('silent association polling removes expired or invalidated tickets and stops polling', async () => {
  for (const code of ['WECHAT_LINK_EXPIRED', 'WECHAT_LINK_CONFIG_CHANGED']) {
    const { page, wx } = loadPage('link', { getLinkStatus: async () => { throw Object.assign(new Error('关联已失效'), { code, statusCode: code.endsWith('EXPIRED') ? 410 : 409 }); } });
    let removed = false;
    wx.removeStorageSync = () => { removed = true; };
    page.setData({ link: { linkId: 'link1', expiresAt: new Date(Date.now() + 60000).toISOString() } });
    page.startPolling();
    await page.checkStatus({ silent: true });
    assert.equal(page.data.link, null); assert.equal(page.timer, null); assert.equal(page.data.checking, false); assert.equal(removed, true); assert.match(page.data.errorText, /失效/);
  }
});
test('polling an old code cannot replace a newly generated association target', async () => {
  let finish;
  const { page } = loadPage('link', { getLinkStatus: () => new Promise(resolve => { finish = resolve; }) });
  page.setData({ link: { linkId: 'old', expiresAt: new Date(Date.now() + 60000).toISOString() } });
  const poll = page.checkStatus({ silent: true });
  page.setData({ link: { linkId: 'new', expiresAt: new Date(Date.now() + 60000).toISOString() } });
  finish({ linkId: 'old', status: 'awaiting_confirmation', target: { steamId: 'wrong' } });
  await poll;
  assert.equal(page.data.link.linkId, 'new'); assert.equal(page.data.link.target, undefined);
});
test('specialty labels match the canonical member vocabulary and retain unknown values', async () => {
  const canonical = await import('../../shared/member-preferences.js');
  const { specialties } = require('../miniprogram/utils/presentation');
  for (const [key, label] of Object.entries(canonical.specialties)) assert.equal(specialties([key]), label);
  assert.equal(specialties(['new-specialty']), 'new-specialty');
  assert.equal(specialties([]), '暂无专长');
});
test('association status recovers a successful confirmation whose response was lost', async () => {
  const { page } = loadPage('link', { getLinkStatus: async () => ({ linkId: 'linked', status: 'linked' }), readCommand: async () => ({ identities: [{ provider: 'steam', externalId: '7656119' }], member: { roles: [] } }) });
  page.setData({ link: { linkId: 'linked', expiresAt: new Date(Date.now() + 60000).toISOString() } });
  await page.checkStatus({ silent: true });
  assert.equal(page.data.linked, true); assert.equal(page.data.link, null); assert.equal(page.data.identities[0].externalId, '7656119'); assert.equal(page.data.checking, false);
});

test('revisiting an unlinked tab clears previous member data, counts and options', async () => {
  for (const name of ['members', 'rankings', 'wipe', 'mine']) {
    const {page} = loadPage(name, {readCommand:async()=>{throw new Error('must not read');}}, false);
    page.setData({linked:true,items:[{id:'old'}],total:10,hasMore:true,wipes:[{id:'old'}],current:{id:'old'},participantItems:[{memberId:'old'}],participantCounts:{eligibleTotal:10},member:{name:'old'},wechat:{nickName:'old'},wechatAvatar:'old'});
    await page.load();
    assert.equal(page.data.linked,false); assert.equal(page.data.errorText,'');
    if(name==='mine'){assert.equal(page.data.member.name,undefined);assert.equal(page.data.wechat,null);}
    else assert.equal(page.data.items.length,0);
    if(name==='wipe'){assert.equal(page.data.participantItems.length,0);assert.equal(page.data.participantCounts,null);}
  }
});
test('shared page access requires a verified KOOK link, not just a website association', async () => {
  const file=path.resolve(__dirname,'../miniprogram/utils/page.js');
  for(const profile of [{linked:false,kookLinked:false},{linked:true,kookLinked:false},{linked:true},{linked:true,kookLinked:true}]){
    const module={exports:{}};
    vm.runInNewContext(fs.readFileSync(file,'utf8'),{module,require:()=>({ensureCanEnterApp:async()=>profile}),wx:{}});
    const page={active:true,data:{},setData(patch){Object.assign(this.data,patch);}};
    const result=await module.exports.access(page);
    assert.equal(result.linked,profile.kookLinked===true && profile.linked===true);
    assert.equal(page.data.linked,result.linked);
  }
});

test('a late signup result cannot repopulate a tab after its contents were cleared', async () => {
  let finish;
  const {page}=loadPage('wipe',{operationId:()=> 'op',submitWipeSignup:()=>new Promise(resolve=>{finish=resolve;})});
  page.setData({linked:true,current:{id:'w1',canSignup:true,mySignup:{signupRevision:1}},items:[]});
  const pending=page.signup({currentTarget:{dataset:{response:'attending_on_time'}}});
  page.onHide();page.setData({linked:false,current:null,items:[]});
  finish({current:{response:'attending_on_time',signupRevision:2}});await pending;
  assert.equal(page.data.current,null);assert.equal(page.data.items.length,0);assert.equal(page.data.resultText,'');
});
