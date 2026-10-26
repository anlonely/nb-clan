import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import { electricianLanguage, electricianList, electricianTarget, steamAvatarUrl, steamProfileUrl } from '../public/guides/electricians.js';

const row = (id, name = id) => ({ name, url: `https://steamcommunity.com/id/${id}/` });

test('Steam profile URLs are canonical, HTTPS, and limited to a real profile path', () => {
  assert.equal(steamProfileUrl('https://steamcommunity.com/profiles/76561198302105600'), 'https://steamcommunity.com/profiles/76561198302105600/');
  assert.equal(steamProfileUrl('https://steamcommunity.com/id/rsg_player-1/'), 'https://steamcommunity.com/id/rsg_player-1/');
  for (const value of [
    '//steamcommunity.com/id/ab/', 'http://steamcommunity.com/id/ab/', 'javascript:alert(1)',
    'https://steamcommunity.com.evil.example/id/ab/', 'https://evil.example/id/ab/',
    'https://steamcommunity.com@evil.example/id/ab/', 'https://user@steamcommunity.com/id/ab/',
    'https://steamcommunity.com:443/id/ab/', 'https://steamcommunity.com:8443/id/ab/',
    'https://steamcommunity.com/id/ab/?', 'https://steamcommunity.com/id/ab/#',
    'https://steamcommunity.com/id/ab/?redirect=evil', 'https://steamcommunity.com/id/ab/#evil',
    'https://steamcommunity.com/id/a/', 'https://steamcommunity.com/profiles/123/',
    'https://steamcommunity.com/id/ab/../cd/', 'https://steamcommunity.com/id/%61b/',
    'https://steamcommunity.com/id/ab\n/', ' https://steamcommunity.com/id/ab/',
    'https://steamcommunity.com/id/ab/ ', 'https://steamcommunity.com/groups/ab/', null,
  ]) assert.equal(steamProfileUrl(value), null, String(value));
});

test('the list rejects malformed, oversized, and duplicate groups before any link is used', () => {
  const data = electricianList({ china: [row('china', '中国电工')], foreign: [row('foreign')] });
  assert.equal(data.china[0].name, '中国电工');
  assert.deepEqual(electricianList({ china: [], foreign: [] }), { china: [], foreign: [] });
  assert.equal(electricianList({ china: Array.from({ length: 500 }, (_, n) => row(`id-${n}`)), foreign: [] }).china.length, 500);
  assert.equal(electricianList({ china: [row('ab', 'x'.repeat(80))], foreign: [] }).china[0].name.length, 80);
  for (const invalid of [null, {}, { china: [], foreign: null },
    { china: [row('same')], foreign: [{ ...row('same'), url: 'https://steamcommunity.com/id/same' }] },
    { china: Array.from({ length: 501 }, (_, n) => row(`id-${n}`)), foreign: [] },
    { china: [row('ab', ' ')], foreign: [] }, { china: [row('ab', 'x'.repeat(81))], foreign: [] },
    { china: [{ name: 'Bad', url: 'https://evil.example/' }], foreign: [] },
  ]) assert.throws(() => electricianList(invalid), /INVALID_LIST/);
});

test('public page resolves explicit platforms and legacy KOOK IDs without losing their scope', () => {
  assert.equal(electricianTarget('?guildId=8900601550851301&channelId=8900601550851302&ignored=yes'), 'platform=kook&guildId=8900601550851301&channelId=8900601550851302');
  for (const platform of ['kook', 'discord']) assert.equal(electricianTarget(`?platform=${platform}&guildId=8900601550851301&channelId=8900601550851302`),
    `platform=${platform}&guildId=8900601550851301&channelId=8900601550851302`);
  for (const value of ['', '?platform=discord&guildId=8900601550851301', '?guildId=abc&channelId=8900601550851302',
    '?guildId=123&channelId=8900601550851302', '?guildId=123456789012345678901&channelId=8900601550851302',
    '?guildId=8900601550851301&guildId=8900601550851302&channelId=8900601550851302',
    '?platform=&guildId=8900601550851301&channelId=8900601550851302',
    '?platform=bridge&guildId=8900601550851301&channelId=8900601550851302',
    '?platform=discord&platform=kook&guildId=8900601550851301&channelId=8900601550851302',
    '?platform%5Bvalue%5D=discord&guildId=8900601550851301&channelId=8900601550851302',
  ]) assert.throws(() => electricianTarget(value), /INVALID_TARGET/);
});

test('KOOK guild-only mobile links retain KOOK scope for server-side unique-destination resolution', () => {
  for (const search of ['?guildId=8900601550851301', '?platform=kook&guildId=8900601550851301'])
    assert.equal(electricianTarget(search), 'platform=kook&guildId=8900601550851301');
  assert.throws(() => electricianTarget('?platform=discord&guildId=8900601550851301'), /INVALID_TARGET/);
});

test('electrician browser language uses the first preference, defaults to English, and supports Chinese locales', () => {
  for (const value of ['zh', 'zh-CN', 'zh-TW', ['zh-HK', 'en']]) assert.equal(electricianLanguage(value), 'zh-CN');
  for (const value of [undefined, [], 'en-GB', 'fr', ['en', 'zh-CN']]) assert.equal(electricianLanguage(value), 'en');
});

test('already delivered Discord target links resolve only to Discord and reject mixed or malformed targets', () => {
  const target = '1554983512321425488-1554985842970468423';
  const expected = 'platform=discord&guildId=1554983512321425488&channelId=1554985842970468423';
  for (const page of ['electricians.html', 'electricians-en.html']) {
    for (const hash of ['', '#tutorial']) assert.equal(electricianTarget(new URL(`https://clan.example.com/guides/${page}?target=${target}${hash}`).search), expected);
  }
  for (const value of ['', '123-1554985842970468423', '1554983512321425488-abc', `${target}-123`,
    '15549835123214254881554983512321425488-1554985842970468423']) {
    assert.throws(() => electricianTarget(`?target=${value}`), /INVALID_TARGET/);
  }
  for (const query of [`target=${target}&target=${target}`, `target=${target}&platform=discord`,
    `target=${target}&guildId=1554983512321425488`, `target=${target}&channelId=1554985842970468423`,
    `target%5Bvalue%5D=${target}`, `target=${target}&guildId%5Bvalue%5D=1554983512321425488`]) {
    assert.throws(() => electricianTarget(`?${query}`), /INVALID_TARGET/);
  }
});

test('avatar URLs accept Steam image hosts and reject arbitrary origins or active content', () => {
  for (const host of ['avatars.steamstatic.com', 'avatars.akamai.steamstatic.com', 'avatars.fastly.steamstatic.com']) {
    const url = `https://${host}/0123456789abcdef_full.jpg`;
    assert.equal(steamAvatarUrl(url), url);
  }
  for (const value of [undefined, null, '', {}, 'javascript:alert(1)', 'data:image/svg+xml,test',
    'http://avatars.steamstatic.com/player.jpg', 'https://avatars.steamstatic.com.evil.example/player.jpg',
    'https://evil.example/player.jpg', 'https://user@avatars.steamstatic.com/player.jpg',
    'https://avatars.steamstatic.com:8443/player.jpg', 'https://avatars.steamstatic.com/player.svg',
    'https://avatars.steamstatic.com/player.jpg?next=https://evil.example',
    'https://avatars.steamstatic.com/player.jpg#fragment', 'https://avatars.steamstatic.com/../player.jpg',
    'https://avatars.steamstatic.com/player.jpg\\n', 'https://avatars.steamstatic.com/player.jpg\n',
  ]) assert.equal(steamAvatarUrl(value), '', String(value));
});

test('missing or unsafe avatars fall back without discarding otherwise valid profiles', () => {
  const avatar = 'https://avatars.steamstatic.com/0123456789abcdef_full.jpg';
  const data = electricianList({ china: [{ ...row('china'), avatar }], foreign: [
    row('missing'), { ...row('unsafe'), avatar: 'https://evil.example/tracking.png' },
  ] });
  assert.equal(data.china[0].avatar, avatar);
  assert.deepEqual(data.foreign.map(item => item.avatar), ['', '']);
  assert.deepEqual(data.foreign.map(item => item.url), [row('missing').url, row('unsafe').url]);
});

function languagePage({search = '?platform=discord&guildId=1554983512321425488&channelId=1554985842970468423', hash = '', languages = ['zh-CN'], preference} = {}) {
  const elements = new Map(), preferences = new Map(preference ? [['rsg-electricians-language', preference]] : []), calls = [];
  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map(), node = {id, children: [], dataset: {}, textContent: '', open: false,
      setAttribute(key, value) {this[key] = value;}, append(...items) {this.children.push(...items);}, replaceChildren() {this.children = [];},
      addEventListener(type, callback) {listeners.set(type, callback);}, emit(type) {listeners.get(type)?.();},
      showModal() {this.open = true;}, close() {this.open = false; this.emit('close');}, pause() {this.paused = true;},
      querySelector: () => element(`${id}-video`), querySelectorAll: () => [zh, en], remove() {}};
    elements.set(id, node); return node;
  }
  const zh = element('choose-zh'), en = element('choose-en'); zh.dataset.language = 'zh-CN'; en.dataset.language = 'en';
  const location = {search, hash, pathname: '/guides/electricians.html'}, document = {documentElement: {}, getElementById: element,
    querySelector: () => element('brand'), createElement: tag => element(`new-${tag}-${elements.size}`), createTextNode: text => ({textContent: text})};
  const history = {replaceState(_state, _unused, value) {const url = new URL(value, 'https://nb.example'); Object.assign(location, {search: url.search, hash: url.hash, pathname: url.pathname});}};
  const source = readFileSync(new URL('../public/guides/electricians.js', import.meta.url), 'utf8').replace(/^export /gm, '');
  vm.runInNewContext(source, {URL, URLSearchParams, AbortController, document, location, history, navigator: {languages},
    localStorage: {getItem: key => preferences.get(key), setItem: (key, value) => preferences.set(key, value)},
    window: {addEventListener() {}}, setTimeout: () => 1, clearTimeout() {},
    fetch: async (url, options) => {calls.push({url, options}); return {ok: true, json: async () => ({china: [row('alpha', 'Alpha')], foreign: []})};}});
  return {element, document, location, calls, zh, en, preferences};
}

test('explicit manual language can switch on the same page and never sends lang to the scoped API', async () => {
  const page = languagePage({search: '?platform=discord&guildId=1554983512321425488&channelId=1554985842970468423&lang=en', hash: '#tutorial', preference: 'zh-CN'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.document.documentElement.lang, 'en');
  assert.equal(page.element('tutorial-dialog-en').open, true); assert.equal(page.element('tutorial-dialog').open, false);
  assert.equal(page.calls[0].url, '/api/v2/public/electricians?platform=discord&guildId=1554983512321425488&channelId=1554985842970468423');
  assert.equal(page.calls[0].options.credentials, 'omit');
  page.zh.emit('click');
  assert.equal(page.document.documentElement.lang, 'zh-CN');
  const params = new URLSearchParams(page.location.search);
  assert.equal(params.get('platform'), 'discord'); assert.equal(params.get('channelId'), '1554985842970468423'); assert.equal(params.get('lang'), 'zh-CN');
  assert.equal(page.location.hash, '#tutorial'); assert.equal(page.calls.length, 1, 'language switching reuses the same roster');
  page.element('tutorial-dialog-en').close(); assert.equal(page.element('tutorial-dialog-en-video').paused, true);
  assert.equal(page.location.hash, '');
  page.element('show-tutorial').emit('click'); assert.equal(page.element('tutorial-dialog').open, true);
  page.element('tutorial-dialog').close(); page.element('show-tutorial-en').emit('click'); assert.equal(page.element('tutorial-dialog-en').open, true);
});

test('both platforms default to browser language despite an old saved preference and open the matching tutorial', () => {
  for (const search of ['?guildId=8900601550851301&channelId=1630990274298012', '?platform=discord&guildId=1554983512321425488&channelId=1554985842970468423']) {
    for (const [languages, preference, expected] of [[['zh-TW', 'en'], 'en', 'zh-CN'], [['en-US', 'zh-CN'], 'zh-CN', 'en']]) {
      const page = languagePage({search, hash: '#tutorial', languages, preference});
      assert.equal(page.document.documentElement.lang, expected);
      assert.equal(page.element(expected === 'en' ? 'tutorial-dialog-en' : 'tutorial-dialog').open, true);
      assert.equal(new URLSearchParams(page.location.search).has('lang'), false);
      assert.equal(page.preferences.get('rsg-electricians-language'), preference, 'automatic selection does not persist a forced language');
    }
  }
});

test('malformed mixed platform links cannot issue a roster request', async () => {
  const invalid = languagePage({search: '?target=1554983512321425488-1554985842970468423&platform=kook&lang=en'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(invalid.calls.length, 0); assert.equal(invalid.element('load-message').textContent, 'Incomplete link. Open this page from the electrician card.');
});
