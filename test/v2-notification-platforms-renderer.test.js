import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { canonicalJson, hashPayload } from '../server/v2/notification-platforms/canonical.js';
import { listNotificationTemplates, renderNotification } from '../server/v2/notification-platforms/renderer.js';
import { NotificationService } from '../server/v2/notifications/service.js';
import { createDiscordVerifier, createKookVerifier } from '../server/v2/notification-platforms/verifiers.js';

const LANGUAGES = ['zh-CN', 'en', 'ru', 'tr', 'th', 'ko'];
const PURPOSES = ['signup_open', 'reminder', 'schedule_changed', 'signup_closed', 'cancelled', 'result'];
const ACTIONS = ['attending_on_time', 'attending_later', 'not_attending'];
const DISCORD_ACTIONS = ['attending_on_time', 'attending_later', 'join_8h', 'join_16h', 'not_attending', 'copy_connect'];
function fixture(platform = 'discord', language = 'en', purpose = 'signup_open') {
  return {
    schemaVersion: 1, templateId: 'wipe-notification', templateRevision: 1, purpose, mode: 'send',
    target: { id: 'target-1', platform, guildId: '100000000000000001', channelId: '100000000000000002', languages: [...LANGUAGES],
      capabilities: { preview: true, send: true, mentionRoles: true, mentionEveryone: true },
      roleOptions: [{ id: '100000000000000004', label: 'Team' }, { id: '100000000000000003', label: 'Guests' }], runtimeMode: 'isolated', transportKey: 'must-not-leak' },
    selection: { targetId: 'target-1', language, mentionMode: 'none', roleIds: [] },
    snapshot: { wipeId: 'wipe-1', title: 'Thursday wipe', description: 'Meet at the outpost.', serverLabel: 'Fixture server',
      musterAt: '2026-09-10T12:00:00.000Z', signupClosesAt: '2026-09-10T11:00:00.000Z', serverScheduledWipeAt: '2026-09-10T13:00:00.000Z',
      timeZone: 'Asia/Shanghai', lifecycle: 'scheduled', effectiveSignupWindow: 'open', contentRevision: 3, rosterRevision: 8,
      counts: { eligibleTotal: 15, unanswered: 5, onTime: 6, later: 2, notAttending: 2, responseTotal: 10, plannedAttending: 8,
        confirmedAttending: 5, pendingReconfirmationAttending: 3, pendingReconfirmation: 4 },
      teamCounts: { CN: { onTime: 4, later: 1, notAttending: 1 }, EU: { onTime: 2, later: 1, notAttending: 1 } },
      teamAttendance: [{ name: 'CN', onTime: 4 }, { name: 'EU', onTime: 2 }],
      attendanceRows: [
        ...Array.from({ length: 6 }, (_, i) => ({ response: 'attending_on_time', name: `Member ${i+1}`, discordId: '', expectedArrivalAt: null, vipBadge: i === 0 ? '🟣' : '' })),
        { response: 'attending_later', name: 'Eight', discordId: '', expectedArrivalAt: '2026-09-10T21:00:00.000Z', vipBadge: '' },
        { response: 'attending_later', name: 'Sixteen', discordId: '', expectedArrivalAt: '2026-09-11T05:00:00.000Z', vipBadge: '' },
        ...Array.from({ length: 2 }, (_, i) => ({ response: 'not_attending', name: `Absent ${i+1}`, discordId: '', expectedArrivalAt: null, vipBadge: '' })),
      ],
      countScope: 'notification_audience', evaluatedAt: '2026-09-08T12:00:00.000Z', memberUrl: 'http://127.0.0.1:4999/app/wipes/wipe-1?tab=plan#signup' },
    actionRefs: [...(platform === 'discord' ? DISCORD_ACTIONS : ACTIONS), ...(platform === 'kook' ? ['withdraw'] : [])]
      .map((action, i) => ({ action, token: `public_ref_${i}` })),
  };
}

function nativeActions(result, platform) {
  return platform === 'discord' ? result.payload.components.flatMap(row => row.components)
    : JSON.parse(result.payload.content).flatMap(card => card.modules)
      .filter(module => module.type === 'action-group').flatMap(module => module.elements);
}

function assertNativeProjection(result, input) {
  const { payload, rendered } = result;
  if (input.target.platform === 'kook' || input.purpose !== 'signup_open') {
    const website = rendered.actions.at(-1);
    assert.deepEqual(website, { label: website.label, url: input.snapshot.memberUrl, action: null, disabled: false });
  }
  if (input.target.platform === 'discord') {
    assert.deepEqual(Object.keys(payload).sort(), ['allowed_mentions', 'components', 'content', 'embeds']);
    assert.equal(payload.embeds[0].title, rendered.title);
    assert.equal(payload.embeds[0].description, rendered.body);
    assert.deepEqual(payload.embeds[0].fields.map(({ name, value, inline }) => ({ label: name, value, inline })),
      rendered.fields.map(field => ({ ...field, inline: field.inline ?? true })));
    assert.equal(payload.embeds[0].footer.text, rendered.footer);
    assert.ok(payload.embeds[0].title.length <= 256);
    assert.ok(payload.embeds[0].description.length <= 4096);
    assert.ok(payload.embeds[0].fields.length <= 25);
    assert.ok(payload.embeds[0].fields.every(field => field.name.length <= 256 && field.value.length <= 1024));
    assert.ok(payload.components.every(row => row.type === 1 && row.components.length <= 5));
    for (const button of payload.components[0].components) {
      assert.equal(button.type, 2); assert.ok(button.label.length <= 80);
      assert.notEqual(Boolean(button.custom_id), Boolean(button.url));
      if (button.custom_id) assert.ok(button.custom_id.length <= 100);
    }
    assert.deepEqual(payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
    assert.equal(payload.content, '');
  } else {
    assert.deepEqual(Object.keys(payload).sort(), ['content', 'target_id', 'type']);
    assert.equal(payload.type, 10); assert.equal(payload.target_id, input.target.channelId);
    const cards = JSON.parse(payload.content), modules = cards.flatMap(card => card.modules);
    assert.equal(cards[0].type, 'card'); assert.ok(cards.length <= 5); assert.ok(modules.length <= 50);
    assert.equal(modules[0].text.content, rendered.title); assert.equal(modules[0].type, 'header');
    assert.ok(modules[0].text.content.length <= 100);
    assert.equal(modules[1].text.content, `${rendered.fields[0].label}  ${rendered.fields[0].value}`);
    assert.equal(modules[2].text.content, `${rendered.fields[1].label}  ${rendered.fields[1].value}`);
    assert.equal(modules[3].type, 'divider');
    assert.equal(modules[4].text.content, rendered.fields.slice(2).map(field => `**${field.label}**  ${field.value}`).join('\n'));
    assert.equal(modules.length, 5 + (rendered.actions.length > 3 ? 2 : 1));
    assert.ok(modules.filter(module => module.text).every(module => module.text.type === 'kmarkdown'
      ? module.text.content.length <= 5000 : module.text.type === 'plain-text' && module.text.emoji === false && module.text.content.length <= 2000));
    assert.ok(modules.filter(module => module.type === 'action-group').every(module => module.elements.length <= 4));
    assert.ok(payload.content.length <= 8000);
    assert.equal(canonicalJson(cards), payload.content);
  }
  assert.deepEqual(nativeActions(result, input.target.platform).map(action => input.target.platform === 'discord' ? action.label : action.text.content), rendered.actions.map(action => action.label));
  assert.equal(rendered.countScope, 'notification_audience');
  if (input.target.platform === 'discord') {
    if (input.purpose === 'signup_open') {
      assert.equal(rendered.fields.length, 7);
      assert.match(rendered.body, /<t:\d+:D>/u);
      assert.match(rendered.body, /<t:\d+:t>/u);
      assert.match(rendered.fields[0].value, /Member 1/u);
      assert.match(rendered.fields[4].value, /Eight/u);
      assert.match(rendered.fields[5].value, /Sixteen/u);
      assert.equal(payload.embeds[0].color, 0xf1c40f);
      assert.equal(payload.embeds[0].timestamp, input.snapshot.evaluatedAt);
      assert.deepEqual(payload.embeds[0].fields.map(field => field.inline), [true, true, true, false, true, true, true]);
      assert.deepEqual(payload.components.map(row => row.components.length), [4, 1]);
    } else {
      assert.equal(rendered.fields[13].value, '5');
      assert.equal(rendered.fields.length, 15);
      assert.equal(rendered.fields[1].value, `<t:${Date.parse(input.snapshot.signupClosesAt) / 1000}:F>`);
      assert.equal(rendered.fields[2].value, `<t:${Date.parse(input.snapshot.serverScheduledWipeAt) / 1000}:F>`);
      assert.equal(rendered.fields[14].value, `<t:${Date.parse(input.snapshot.evaluatedAt) / 1000}:F>`);
      assert.equal(rendered.fields[14].inline, false);
      assert.doesNotMatch(rendered.footer, /<t:|UTC|Asia\/Shanghai/u);
    }
  } else {
    assert.equal(rendered.fields.length, 6);
    assert.equal(rendered.fields[3].value, '6  ·  CN 4  /  EU 2');
    assert.match(rendered.fields[1].value, /^2026-09-10 21:00 \(Asia\/Shanghai, UTC\+08:00\)$/u);
  }
}

test('KOOK signup card shows the configured direct connect command as copyable code', () => {
  const input = fixture('kook', 'zh-CN');
  input.snapshot.directConnect = 'client.connect 2xmonthly.atlasrust.us:28010';
  const output = renderNotification(input);
  const modules = JSON.parse(output.payload.content)[0].modules;
  assert.equal(output.rendered.directConnect, input.snapshot.directConnect);
  assert.equal(modules[3].text.content,
    '**服务器直连**\n```\nclient.connect 2xmonthly.atlasrust.us:28010\n```');
  assert.equal(modules[3].text.type, 'kmarkdown');
  input.snapshot.directConnect = 'client.connect host:28010```(met)all(met)';
  assert.equal(renderNotification(input).rendered.directConnect, '');
});

test('Discord signup card restores old attendance layout, actual names and two button rows without pings', () => {
  const input = fixture('discord', 'zh-CN');
  input.snapshot.directConnect = 'client.connect 2xmonthly.atlasrust.us:28010';
  input.snapshot.vipUrl = 'https://atlasrust.us/vip';
  input.snapshot.directConnectIp = '216.39.240.89';
  const output = renderNotification(input), embed = output.payload.embeds[0];
  assert.equal(embed.fields.length, 7);
  assert.match(embed.title, /^🚨 .* 🚨$/u);
  assert.match(embed.description, /开荒报名/u);
  assert.match(embed.description, /CN 4 人到场/u);
  assert.doesNotMatch(embed.description, /NB-CN/u);
  assert.match(embed.description, /🔗 服务器直连: `client\.connect 2xmonthly\.atlasrust\.us:28010`/u);
  assert.match(embed.description, /\n🔗 备用直连: `client\.connect 216\.39\.240\.89:28010`/u);
  assert.match(embed.fields[0].value, /Member 1/u);
  assert.doesNotMatch(`${embed.description}\n${embed.fields.map(field => field.value).join('\n')}`, /VIP|🟣|🟡/u);
  assert.deepEqual(output.payload.components.map(row => row.components.map(button => button.style)), [[3, 2, 2, 4], [1, 5, 5]]);
  assert.equal(output.payload.components[1].components[1].url,
    'http://127.0.0.1:4999/api/v2/auth/discord/start?returnTo=%2Fapp%2Fme');
  assert.equal(output.payload.components[1].components[1].emoji.name, '📝');
  assert.equal(output.payload.components[1].components[2].url, input.snapshot.vipUrl);
  assert.deepEqual(output.payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
  input.snapshot.effectiveSignupWindow = 'closed';
  const closed = renderNotification(input);
  assert.match(closed.payload.embeds[0].title, /^报名截止/u);
  assert.deepEqual(closed.payload.components.map(row => row.components.map(button => button.style)), [[1, 5, 5]]);
});

test('Discord signup shows a validated IP below the domain and retains the existing copy control', () => {
  const input=fixture('discord','en');
  input.snapshot.directConnect='client.connect 2xmonthly.atlasrust.us:28010';
  input.snapshot.directConnectIp='216.39.240.89';
  const output=renderNotification(input);
  assert.match(output.rendered.body,/Direct connect: `client\.connect 2xmonthly\.atlasrust\.us:28010`\n🔗 Alternative direct connect: `client\.connect 216\.39\.240\.89:28010`/);
  assert.equal(nativeActions(output,'discord').some(button=>button.label==='Copy Direct Connect'),true);
  for(const ip of [null,'','host.example','216.39.240.89;quit']){
    input.snapshot.directConnectIp=ip;
    assert.doesNotMatch(renderNotification(input).rendered.body,/Alternative direct connect:/);
  }
});

test('Discord signup fixed copy, alternative address and branded footer follow all six selected languages', () => {
  const labels = { 'zh-CN': ['备用直连', '开荒报名'], en: ['Alternative direct connect', 'Wipe Attendance'],
    ru: ['Альтернативное подключение', 'Участие в вайпе'], tr: ['Alternatif bağlantı', 'Wipe Katılımı'],
    th: ['การเชื่อมต่อสำรอง', 'การเข้าร่วมไวป์'], ko: ['대체 연결', '와이프 참가'] };
  for (const [language, [alternative, heading]] of Object.entries(labels)) {
    const input = fixture('discord', language);
    input.snapshot.directConnect = 'client.connect server.example:28015';
    input.snapshot.directConnectIp = '203.0.113.4';
    const result = renderNotification(input);
    assert.ok(result.rendered.body.includes(`${alternative}: \`client.connect 203.0.113.4:28015\``));
    assert.ok(result.rendered.footer.startsWith(`Clan Portal · ${heading}\n`));
    assert.doesNotMatch(JSON.stringify(result.payload), /NB Clan|Direct Connect :/);
    assert.equal(input.snapshot.serverLabel, 'Fixture server');
  }
});

test('Discord language-view button reuses only an exact existing reference and is omitted from private translations', () => {
  const labels = { 'zh-CN': '查看我的语言版本', en: 'View in your language', ru: 'Показать на моём языке',
    tr: 'Kendi dilimde görüntüle', th: 'ดูในภาษาของฉัน', ko: '내 언어로 보기' };
  const token = 'a'.repeat(43);
  for (const purpose of PURPOSES) for (const [language, label] of Object.entries(labels)) {
    const input = fixture('discord', language, purpose);
    input.actionRefs[0].token = token;
    const before = structuredClone(input), result = renderNotification(input);
    const buttons = nativeActions(result, 'discord');
    const view = buttons.find(button => button.custom_id === `nblang:signup:${token}`);
    assert.equal(view?.label, label);
    assert.deepEqual(view.emoji, { name: '🌐' });
    assert.equal(view.disabled, false);
    assert.equal(buttons.at(-1), view);
    assert.ok(result.payload.components.every(row => row.components.length <= 5));
    assert.deepEqual(input, before, 'rendering must not alter references or snapshots');
    const privateResult = renderNotification({ ...input, omitLanguageButton: true });
    assert.ok(!nativeActions(privateResult, 'discord').some(button => button.custom_id?.startsWith('nblang:')));
    assert.deepEqual(nativeActions(privateResult, 'discord'), buttons.filter(button => button !== view));
  }
  const input = fixture('discord');
  for (const invalid of ['', 'a'.repeat(42), 'a'.repeat(44), 'public_ref_0']) {
    input.actionRefs[0].token = invalid || 'short';
    assert.ok(!nativeActions(renderNotification(input), 'discord').some(button => button.custom_id?.startsWith('nblang:')));
  }
  input.actionRefs = input.actionRefs.filter(ref => ref.action !== 'attending_on_time');
  input.snapshot.effectiveSignupWindow = 'closed';
  assert.ok(!nativeActions(renderNotification(input), 'discord').some(button => button.custom_id?.startsWith('nblang:')));
  const kook = fixture('kook'); kook.actionRefs[0].token = token;
  assert.ok(!nativeActions(renderNotification(kook), 'kook').some(button => button.value?.startsWith('nblang:')));
  assert.throws(() => renderNotification({ ...fixture('discord'), omitLanguageButton: 'true' }),
    error => error.errorCode === 'NOTIFICATION_INPUT_INVALID' && error.fieldErrors.omitLanguageButton === 'NOTIFICATION_INPUT_INVALID');
});

test('editing Discord signup preserves linked member names without forbidden mentions',()=>{
  const input=fixture('discord','en');input.mode='edit';
  input.snapshot.attendanceRows[0].discordId='977082574801350667';
  const output=renderNotification(input);
  assert.match(output.payload.embeds[0].fields[0].value,/Member 1/);
  assert.doesNotMatch(JSON.stringify(output.payload),/<@|@everyone|@here/);
  assert.deepEqual(output.payload.allowed_mentions,{parse:[],roles:[],users:[],replied_user:false});
});

test('discord: VIP buttons accept complete HTTP and HTTPS links and retain their query', () => {
  const platform = 'discord';
  for (const vipUrl of ['https://example.invalid/vip?server=16&ref=wipe#purchase', 'http://example.invalid/vip?server=16',
    'HTTPS://EXAMPLE.INVALID/vip?ref=encoded%20value', 'https://example.invalid:8443/vip']) {
    const input = fixture(platform, 'en'); input.snapshot.vipUrl = vipUrl;
    const output = renderNotification(input), expected = new URL(vipUrl).href;
    const action = output.rendered.actions.find(item => item.label === 'Buy VIP');
    assert.deepEqual(action, { label: 'Buy VIP', url: expected, action: null, disabled: false });
    const button = nativeActions(output, platform).find(item => platform === 'discord' ? item.url === expected : item.value === expected);
    assert.ok(button);
    if (platform === 'discord') {
      assert.equal(button.style, 5);
      assert.equal(button.custom_id, undefined);
      assert.deepEqual(output.payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
    } else assert.equal(button.click, 'link');
    assert.equal(input.snapshot.vipUrl, vipUrl);
  }
});

test('KOOK retains its existing buttons when the snapshot has a valid VIP URL', () => {
  const input = fixture('kook', 'en'), baseline = renderNotification(input);
  input.snapshot.vipUrl = 'https://example.invalid/vip?server=16';
  const output = renderNotification(input);
  assert.deepEqual(output.rendered.actions, baseline.rendered.actions);
  assert.deepEqual(nativeActions(output, 'kook'), nativeActions(baseline, 'kook'));
});

for (const platform of ['discord', 'kook']) test(`${platform}: an invalid VIP URL is omitted without blocking the signup card or changing its other buttons`, () => {
  const baseline = renderNotification(fixture(platform, 'en'));
  for (const vipUrl of [undefined, null, '', 'https://', 'http://', 'https:///vip', 'https://?server=16',
    'https:/example.invalid/vip', '//example.invalid/vip', '/vip', 'not-a-url', 'ftp://example.invalid/vip',
    'javascript:alert(1)', 'https://name@example.invalid/vip', 'https://name:password@example.invalid/vip',
    'https://example.invalid:65536/vip', 'https://example.invalid\\@other.invalid/vip',
    ' https://example.invalid/vip', 'https://example.invalid/has space',
    ...['\n', '\r', '\t', '\u0000', '\u001f', '\u007f'].map(char => `https://example.invalid/vi${char}p`),
    `https://example.invalid/${'x'.repeat(500)}`]) {
    const input = fixture(platform, 'en'); input.snapshot.vipUrl = vipUrl;
    const output = renderNotification(input);
    assert.deepEqual(output.rendered.actions, baseline.rendered.actions);
    assert.deepEqual(nativeActions(output, platform), nativeActions(baseline, platform));
    assert.equal(output.payloadHash, baseline.payloadHash);
  }
});

test('English Discord signup keeps classic attendance labels and button icons', () => {
  const output = renderNotification(fixture('discord', 'en'));
  const embed = output.payload.embeds[0];
  assert.match(embed.description, /✅ Attending\n🕒 Join in 8h\n🕒 Join in 16h\n❌ Not Attending/u);
  assert.match(embed.fields[0].name, /✅ Attending/u);
  assert.deepEqual(output.payload.components[0].components.map(button => [button.label, button.emoji?.name]),
    [['Attending', '✅'], ['Join in 8h', '🕒'], ['Join in 16h', '🕒'], ['Not Attending', '❌']]);
});

test('Discord team tally uses configured squad names and counts active members once', () => {
  const rows = [
    { memberId: 'm1', response: 'attending_on_time' },
    { memberId: 'm2', response: 'attending_on_time' },
    { memberId: 'm3', response: 'not_attending' },
  ];
  const squads = [{ id: 's1', name: 'CN 主队' }, { id: 's2', name: 'EU' }];
  const squadMembers = [
    { memberId: 'm1', squadId: 's1' }, { memberId: 'm1', squadId: 's1' },
    { memberId: 'm2', squadId: 's2' }, { memberId: 'm3', squadId: 's1' },
    { memberId: 'm2', squadId: 's1', validTo: '2026-09-01T00:00:00.000Z' },
  ];
  const teamAttendance = NotificationService.prototype.discordTeamAttendance.call({
    identity: { repo: { all: () => squads }, relations: () => ({ squadMembers }) },
  }, rows);
  assert.deepEqual(teamAttendance, [{ name: 'CN 主队', onTime: 1 }, { name: 'EU', onTime: 1 }]);
  const input = fixture('discord'); input.snapshot.teamAttendance = teamAttendance;
  const description = renderNotification(input).payload.embeds[0].description;
  assert.match(description, /CN 主队 1 attending/u);
  assert.doesNotMatch(description, /NB-CN/u);
});

test('Discord attendance snapshot uses authorized roster names, linked IDs and active server VIP only', () => {
  const members = new Map([
    ['m1', { discordId: '123456789012345678', vitalVipType: 'queue_skip', vitalVipExpiresAt: '2030-09-10' }],
    ['m2', { discordId: '', vitalVipType: 'priority', vitalVipExpiresAt: '2020-01-01' }],
  ]);
  const rows = [
    { memberId: 'm1', displayName: 'Alice', response: 'attending_on_time', expectedArrivalAt: null },
    { memberId: 'm2', displayName: 'Bob', response: 'attending_later', expectedArrivalAt: '2030-09-10T21:00:00.000Z' },
  ];
  const attendanceRows = NotificationService.prototype.discordAttendanceRows.call({
    identity: { repo: { get: (_, id) => members.get(id) } }, now: () => Date.parse('2030-09-08T00:00:00.000Z'),
  }, rows, { serverSnapshot: { name: 'Vital Rust 2X' } });
  assert.deepEqual(attendanceRows.map(row => [row.name, row.discordId, row.vipBadge]),
    [['Alice','123456789012345678','🟣'],['Bob','','']]);
  const input = fixture('discord'); input.snapshot.attendanceRows = attendanceRows;
  const output = renderNotification(input);
  assert.equal(output.payload.embeds[0].fields[0].value, '<@123456789012345678>');
  assert.doesNotMatch(output.payload.embeds[0].description, /VIP/u);
  assert.deepEqual(output.payload.allowed_mentions.users, []);
});

test('elapsed Discord quick-arrival buttons are disabled while future options remain available', () => {
  const input = fixture('discord');
  input.snapshot.evaluatedAt = '2026-09-10T22:00:00.000Z';
  const buttons = renderNotification(input).payload.components[0].components;
  assert.deepEqual(buttons.map(button => button.disabled), [false, true, false, false]);
});

test('canonical JSON sorts keys recursively and preserves arrays, including numeric string keys', () => {
  const value = { z: [{ b: 2, a: 1 }], 2: 'two', 10: 'ten', a: null };
  const expected = '{"10":"ten","2":"two","a":null,"z":[{"a":1,"b":2}]}';
  assert.equal(canonicalJson(value), expected);
  assert.equal(hashPayload(value), createHash('sha256').update(expected, 'utf8').digest('hex'));
  assert.equal(canonicalJson([2, 1]), '[2,1]');
  assert.equal(canonicalJson({ n: -0 }), '{"n":0}');
  const object = Object.create(null); object['__proto__'] = { safe: true };
  assert.equal(canonicalJson(object), '{"__proto__":{"safe":true}}');
});

test('canonical JSON rejects ambiguous or non-JSON values without executing accessors', () => {
  const cycle = {}; cycle.self = cycle;
  let reads = 0;
  const getter = Object.defineProperty({}, 'value', { enumerable: true, get() { reads++; return 'bad'; } });
  const symbol = { [Symbol('private')]: 'not JSON' };
  const extraArray = []; extraArray.secret = 'bad';
  for (const value of [undefined, NaN, Infinity, -Infinity, 1n, () => {}, Symbol('bad'), new Date(0), new Map(), new Set(), { value: undefined }, [undefined], new Array(1), cycle, getter, symbol, extraArray]) {
    assert.throws(() => canonicalJson(value), /CANONICAL_JSON/u);
  }
  assert.equal(reads, 0);
});

test('template catalogue exposes exactly six languages and six purposes with independent results', () => {
  const first = listNotificationTemplates();
  assert.deepEqual(first, [{ id: 'wipe-notification', revision: 1, label: '档期通知 / Wipe notification', languages: LANGUAGES, purposes: PURPOSES }]);
  first[0].languages.pop(); first[0].purposes.length = 0;
  assert.deepEqual(listNotificationTemplates()[0].languages, LANGUAGES);
  assert.deepEqual(listNotificationTemplates()[0].purposes, PURPOSES);
});

for (const platform of ['discord', 'kook']) for (const language of LANGUAGES) for (const purpose of PURPOSES) {
  test(`${platform}/${language}/${purpose}: native payload, projection and hash are deterministic`, () => {
    const input = fixture(platform, language, purpose), before = structuredClone(input);
    const first = renderNotification(input), second = renderNotification(structuredClone(input));
    assert.deepEqual(input, before); assert.deepEqual(first, second);
    assert.equal(first.payloadHash, hashPayload(first.payload));
    assert.match(first.payloadHash, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assertNativeProjection(first, input);
    const actions = nativeActions(first, platform);
    const open = !['signup_closed', 'cancelled', 'result'].includes(purpose);
    assert.equal(actions.length, platform === 'discord' && purpose === 'signup_open' ? open ? 5 : 1 : open ? 4 : 1);
    const tokens = actions.map(action => platform === 'discord' ? action.custom_id : action.click === 'return-val' ? action.value : undefined).filter(Boolean);
    assert.deepEqual(tokens, open ? platform === 'discord' && purpose === 'signup_open'
      ? ['public_ref_0', 'public_ref_2', 'public_ref_3', 'public_ref_4']
      : ['public_ref_0', 'public_ref_1', platform === 'discord' ? 'public_ref_4' : 'public_ref_2'] : []);
  });
}

for (const platform of ['discord', 'kook']) {
  test(`${platform}: exact none, roles and everyone mentions use only the explicit selection`, () => {
    const input = fixture(platform);
    input.snapshot.description = '@everyone @here <@&100000000000000003> (met)all(met) (rol)100000000000000003(rol)';
    const defaultInput = structuredClone(input); delete defaultInput.selection.mentionMode; delete defaultInput.selection.roleIds;
    assert.deepEqual(renderNotification(defaultInput), renderNotification(input));
    for (const mode of ['none', 'roles', 'everyone']) {
      input.selection.mentionMode = mode;
      input.selection.roleIds = mode === 'roles' ? ['100000000000000004', '100000000000000003'] : [];
      const { payload, rendered } = renderNotification(input);
      assert.doesNotMatch(rendered.body, /@|\((?:met|rol)\)/u);
      if (platform === 'discord') {
        assert.equal(payload.content, mode === 'everyone' ? '@everyone' : mode === 'roles' ? '<@&100000000000000004> <@&100000000000000003>' : '');
        assert.deepEqual(payload.allowed_mentions, { parse: mode === 'everyone' ? ['everyone'] : [], roles: input.selection.roleIds, users: [], replied_user: false });
      } else {
        const pings = JSON.parse(payload.content)[0].modules.filter(module => module.text?.type === 'kmarkdown' && /\((?:met|rol)\)/u.test(module.text.content));
        assert.deepEqual(pings.map(module => module.text.content), mode === 'everyone' ? ['(met)all(met)'] : mode === 'roles' ? ['(rol)100000000000000004(rol) (rol)100000000000000003(rol)'] : []);
      }
    }
  });

  test(`${platform}: edits suppress all mentions even after a role grant is revoked`, () => {
    for (const mentionMode of ['roles', 'everyone']) {
      const input = fixture(platform);
      input.mode = 'edit'; input.selection.mentionMode = mentionMode; input.selection.roleIds = ['100000000000000004'];
      input.target.capabilities.mentionRoles = false; input.target.capabilities.mentionEveryone = false; input.target.roleOptions = [];
      for (const key of ['title', 'description', 'serverLabel']) input.snapshot[key] = '@everyone @here <@&123> <@123> <@!123> (met)all(met) (met)here(met) (rol)123(rol)';
      const output = renderNotification(input);
      assert.doesNotMatch(canonicalJson(output.payload), /@everyone|@here|<@|\((?:met|rol)\)/u);
      assert.ok(output.warnings.some(warning => warning.code === 'EDIT_MENTIONS_SUPPRESSED'));
      if (platform === 'discord') assert.deepEqual(output.payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
    }
  });

  test(`${platform}: every terminal state or closed window removes all signup actions`, () => {
    for (const lifecycle of ['draft', 'scheduled', 'active', 'ended', 'archived', 'cancelled']) for (const window of ['not_open', 'open', 'closed']) {
      if (['scheduled', 'active'].includes(lifecycle) && window === 'open') continue;
      const input = fixture(platform); input.snapshot.lifecycle = lifecycle; input.snapshot.effectiveSignupWindow = window; input.actionRefs = [];
      const output = renderNotification(input), actions = nativeActions(output, platform);
      assert.equal(actions.length, 1); assert.equal(output.rendered.actions[0].action, null);
      assert.equal(platform === 'discord' ? actions[0].url : actions[0].value, input.snapshot.memberUrl);
      assert.doesNotMatch(canonicalJson(output.payload), /public_ref|return-val|custom_id/u);
    }
  });

  test(`${platform}: public projection excludes tokens, identities, member details and transport configuration`, () => {
    const input = fixture(platform);
    input.snapshot.contextToken = 'private-confirmation-secret'; input.snapshot.members = [{ name: 'private-member-name', steamId: 'private-steam-id' }];
    input.snapshot.counts.members = input.snapshot.members; input.snapshot.admission = 'private-admission-detail';
    const text = canonicalJson(renderNotification(input));
    for (const privateValue of ['private-confirmation-secret', 'private-member-name', 'private-steam-id', 'private-admission-detail', 'must-not-leak']) assert.ok(!text.includes(privateValue));
    assert.doesNotMatch(text, /contextToken|steamId|members|admission|transportKey/u);
    assert.ok(text.includes('public_ref_0'));
  });

  test(`${platform}: content limits shorten visible text explicitly without splitting surrogate pairs`, () => {
    const input = fixture(platform);
    input.snapshot.title = '😀'.repeat(500); input.snapshot.description = '😀'.repeat(10000); input.snapshot.serverLabel = '😀'.repeat(500);
    const output = renderNotification(input);
    assert.equal(output.warnings.filter(warning => warning.code === 'TEXT_TRUNCATED').length, 1);
    for (const text of [output.rendered.title, output.rendered.body, output.rendered.fields[0].value]) assert.equal(text.isWellFormed(), true);
    assertNativeProjection(output, input);
  });
}

test('rendering rejects unsupported versions, malformed snapshots, unapproved mentions and unsafe links', () => {
  const cases = [
    ['TEMPLATE_UNSUPPORTED', input => { input.templateId = 'other'; }],
    ['TEMPLATE_REVISION_UNSUPPORTED', input => { input.templateRevision = 2; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.purpose = 'unknown'; }],
    ['LANGUAGE_UNSUPPORTED', input => { input.selection.language = 'ja'; }],
    ['LANGUAGE_UNSUPPORTED', input => { input.target.languages = ['zh-CN']; }],
    ['LANGUAGE_UNSUPPORTED', input => { input.target.languages = 'en'; }],
    ['TARGET_INVALID', input => { input.selection.targetId = 'other-target'; }],
    ['MENTION_INVALID', input => { input.selection.mentionMode = 'roles'; input.selection.roleIds = ['999']; }],
    ['MENTION_INVALID', input => { input.selection.mentionMode = 'roles'; input.selection.roleIds = ['999']; input.target.roleOptions = '999'; }],
    ['MENTION_INVALID', input => { input.selection.mentionMode = 'everyone'; input.target.capabilities.mentionEveryone = false; }],
    ['MENTION_INVALID', input => { input.selection.roleIds = ['100000000000000003']; }],
    ['MENTION_INVALID', input => { input.selection.mentionMode = 'roles'; input.selection.roleIds = ['100000000000000003', '100000000000000003']; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.memberUrl = 'javascript:alert(1)'; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.memberUrl = 'http://127.0.0.1:4999/app/wipes/wipe-1/my-signup'; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.memberUrl += '&contextToken=secret'; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.memberUrl = 'http://user:secret@127.0.0.1:4999/app/wipes/wipe-1?tab=plan#signup'; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.serverScheduledWipeAt = '2026-02-30T12:00:00.000Z'; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.timeZone = 'Never/Exists'; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.evaluatedAt = null; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.counts.confirmedAttending = undefined; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.counts.confirmedAttending = NaN; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.counts.confirmedAttending = -1; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.snapshot.countScope = 'all_members'; }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.actionRefs.shift(); }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.actionRefs[0].token = 'x'.repeat(101); }],
    ['NOTIFICATION_INPUT_INVALID', input => { input.actionRefs[1].token = input.actionRefs[0].token; }],
  ];
  for (const [code, mutate] of cases) {
    const input = fixture(); mutate(input);
    assert.throws(() => renderNotification(input), error => error.errorCode === code && error.status === 422 && error.retryable === false);
  }
});

test('rendering uses snapshot time rather than ambient clock or randomness and hashes every native field', () => {
  const input = fixture(), first = renderNotification(input), originalNow = Date.now, originalRandom = Math.random;
  try {
    Date.now = () => { throw new Error('ambient clock must not be read'); };
    Math.random = () => { throw new Error('randomness must not be read'); };
    assert.deepEqual(renderNotification(input), first);
  } finally { Date.now = originalNow; Math.random = originalRandom; }
  for (const mutate of [
    value => { value.snapshot.contentRevision++; }, value => { value.snapshot.rosterRevision++; },
    value => { value.snapshot.attendanceRows[0].name += ' changed'; }, value => { value.snapshot.title += ' changed'; },
    value => { value.actionRefs[0].token += '_new'; }, value => { value.selection.mentionMode = 'everyone'; },
  ]) {
    const next = structuredClone(input); mutate(next);
    assert.notEqual(renderNotification(next).payloadHash, first.payloadHash);
  }
});

test('member deep links preserve encoded wipe IDs and nullable dates do not invent time', () => {
  const input = fixture(); input.snapshot.wipeId = 'wipe/测试';
  input.snapshot.memberUrl = `http://127.0.0.1:4999/app/wipes/${encodeURIComponent(input.snapshot.wipeId)}?tab=plan#signup`;
  input.snapshot.musterAt = null; input.snapshot.signupClosesAt = null; input.snapshot.serverScheduledWipeAt = null;
  const output = renderNotification(input);
  assert.equal(output.rendered.actions.at(-1).url,
    'http://127.0.0.1:4999/api/v2/auth/discord/start?returnTo=%2Fapp%2Fme');
  assert.match(output.rendered.body, /Date: To be confirmed/u);
  assert.match(output.rendered.body, /Time: To be confirmed/u);
});

test('explicit timezone offsets distinguish the two repeated hours at a DST transition', () => {
  const input = fixture(); input.snapshot.timeZone = 'America/New_York';
  input.snapshot.serverScheduledWipeAt = '2026-11-01T05:30:00.000Z';
  const first = renderNotification(input);
  input.snapshot.serverScheduledWipeAt = '2026-11-01T06:30:00.000Z';
  const second = renderNotification(input);
  assert.match(first.rendered.body, new RegExp(`<t:${Date.parse('2026-11-01T05:30:00.000Z') / 1000}:D>`));
  assert.match(second.rendered.body, new RegExp(`<t:${Date.parse('2026-11-01T06:30:00.000Z') / 1000}:D>`));
  assert.notEqual(first.payloadHash, second.payloadHash);
});

test('all Discord notification purposes keep absolute instants independent of the schedule timezone', () => {
  for (const purpose of PURPOSES) {
    const input = fixture('discord', 'en', purpose);
    const shanghai = renderNotification(input);
    input.snapshot.timeZone = 'America/New_York';
    const newYork = renderNotification(input);
    assert.deepEqual(newYork.payload, shanghai.payload, purpose);
    assert.doesNotMatch(JSON.stringify(newYork.payload), /Asia\/Shanghai|UTC\+08:00/u);
  }
  const input = fixture('kook', 'zh-CN', 'reminder');
  const shanghai = renderNotification(input);
  input.snapshot.timeZone = 'America/New_York';
  assert.notEqual(renderNotification(input).payload.content, shanghai.payload.content);
});

test('Discord timestamp rendering retains canonical snapshot validation and nullable-date fallback', () => {
  for (const purpose of PURPOSES) {
    const input = fixture('discord', 'en', purpose);
    input.snapshot.signupClosesAt = null;
    input.snapshot.serverScheduledWipeAt = null;
    const output = renderNotification(input);
    assert.doesNotMatch(JSON.stringify(output.payload), /<t:(?:NaN|undefined|null):/u);
    if (purpose !== 'signup_open') {
      assert.equal(output.rendered.fields[1].value, 'To be confirmed');
      assert.equal(output.rendered.fields[2].value, 'To be confirmed');
    }
    input.snapshot.signupClosesAt = '2026-09-10T11:00:00';
    assert.throws(() => renderNotification(input), error => error.errorCode === 'NOTIFICATION_INPUT_INVALID');
  }
  const input = fixture();
  input.snapshot.actualStartedAt = '2026-09-10T11:00:00';
  assert.throws(() => renderNotification(input), error => error.errorCode === 'NOTIFICATION_INPUT_INVALID');
});

test('native public reference tokens round-trip through real verifiers without entering private confirmation', () => {
  const current = Date.parse('2026-09-08T12:00:00.000Z'), now = () => current;
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const discord = createDiscordVerifier({ publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex'), now });
  const kook = createKookVerifier({ verifyToken: 'isolated-renderer-test', compression: 'none', now });
  for (const platform of ['discord', 'kook']) {
    const input = fixture(platform); input.actionRefs[0].token = `nbconfirm_${'A'.repeat(43)}`;
    const buttons = nativeActions(renderNotification(input), platform);
    const token = platform === 'discord' ? buttons[0].custom_id : buttons[0].value;
    const event = platform === 'discord'
      ? { id: 'interaction-renderer', application_id: 'application-renderer', type: 3, token: 'isolated-interaction-token', guild_id: input.target.guildId,
        channel_id: input.target.channelId, member: { user: { id: 'member-renderer' } }, data: { component_type: 2, custom_id: token } }
      : { s: 0, sn: 1, d: { type: 255, channel_type: 'PERSON', verify_token: 'isolated-renderer-test', msg_id: 'interaction-renderer', msg_timestamp: current,
        extra: { type: 'message_btn_click', body: { user_id: 'member-renderer', target_id: input.target.channelId, msg_id: 'card-renderer', value: token } } } };
    const rawBody = Buffer.from(JSON.stringify(event)), timestamp = String(current / 1000);
    const headers = platform === 'discord' ? { 'x-signature-timestamp': timestamp,
      'x-signature-ed25519': sign(null, Buffer.concat([Buffer.from(timestamp), rawBody]), privateKey).toString('hex') } : {};
    const result = (platform === 'discord' ? discord : kook)({ rawBody, headers, receivedAt: new Date(current).toISOString() });
    assert.equal(result.actionReference, token); assert.deepEqual(result.payload, { kind: 'public' });
    for (const privateToken of [`nbconfirm:${'A'.repeat(43)}`, `nblate:${'A'.repeat(43)}:${current}`]) {
      input.actionRefs[0].token = privateToken;
      assert.throws(() => renderNotification(input), error => error.errorCode === 'NOTIFICATION_INPUT_INVALID');
    }
  }
});
