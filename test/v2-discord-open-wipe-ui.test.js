import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerModal, createSettingsModal, createPreviewPayload, createServerPickerPayload, text, localizeError, OPEN_WIPE_LANGUAGES } from '../server/v2/discord-open-wipe/interaction-ui.js';
import { parseOpenWipeInteraction, ownsOpenWipeInteraction, openWipeCustomId, OPEN_WIPE_BUTTON_ACTIONS } from '../server/v2/discord-open-wipe/interaction-input.js';
import { markOpenWipeProof, isOpenWipeProof, assertOpenWipeProof } from '../server/v2/discord-open-wipe/proof.js';

const token = 'a'.repeat(43);
const servers = [{ id: 'vital-eu-medium', label: 'Vital EU 2x Medium' }, { serverId: 'atlas-eu-main', serverName: 'Atlas EU Main' }];
const settings = { serverId: servers[0].id, serverName: servers[0].label, wipeAtLocal: '2026-10-15T18:00', timeZone: 'Europe/Amsterdam',
  directConnect: 'client.connect eu-medium.vitalrust.com:28014', notes: 'Bring tools.\nMeet before wipe.', adaptiveDisplay: true, autoConnect: true };
const parseError = error => error.errorCode === 'PLATFORM_PAYLOAD_INVALID' && error.status === 422;

function submitted(modal, overrides = {}) {
  return { type: 5, data: { custom_id: modal.data.custom_id, components: modal.data.components.map((row, i) => {
    const c = row.component, original = c.type === 4 ? { value: c.value } : { values: c.options.filter(option => option.default).map(option => option.value) };
    return { type: 18, id: i * 2 + 1, component: { type: c.type, id: i * 2 + 2, custom_id: c.custom_id,
      ...original, ...(Object.hasOwn(overrides, c.custom_id) ? c.type === 4 ? { value: overrides[c.custom_id] } : { values: overrides[c.custom_id] } : {}) } };
  }) } };
}

function validModal(modal) {
  assert.equal(modal.type, 9);
  assert.ok(modal.data.title.length > 0 && modal.data.title.length <= 45);
  assert.ok(modal.data.custom_id.length <= 100);
  assert.ok(modal.data.components.length >= 1 && modal.data.components.length <= 5);
  const ids = new Set();
  for (const row of modal.data.components) {
    assert.equal(row.type, 18);
    assert.ok(row.label.length > 0 && row.label.length <= 45, row.label);
    if (row.description) assert.ok(row.description.length <= 100, row.description);
    const c = row.component;
    assert.ok(!ids.has(c.custom_id)); ids.add(c.custom_id);
    assert.ok(c.custom_id.length <= 100);
    assert.equal(c.disabled, undefined);
    if (c.type === 3 || c.type === 22) {
      assert.ok(c.options.length >= 1 && c.options.length <= (c.type === 3 ? 25 : 10));
      for (const option of c.options) {
        assert.ok(option.label.length > 0 && option.label.length <= 100, option.label);
        assert.ok(option.value.length > 0 && option.value.length <= 100);
        if (option.description) assert.ok(option.description.length <= 100, option.description);
      }
    } else {
      assert.equal(c.type, 4);
      assert.ok(c.value.length <= c.max_length && c.max_length <= 4000);
      if (c.placeholder) assert.ok(c.placeholder.length <= 100);
    }
  }
}

test('all six languages produce valid native server and settings modals that parse the submitted values', () => {
  const titleLanguages = new Set();
  for (const locale of OPEN_WIPE_LANGUAGES) {
    const first = createServerModal({ token, servers, locale, defaults: settings });
    validModal(first); assert.equal(first.data.components.length, 4); titleLanguages.add(first.data.title);
    const parsed = parseOpenWipeInteraction(submitted(first));
    assert.deepEqual(parsed, { kind: 'open_wipe', action: 'create_submit', token,
      values: { adaptiveDisplay: true, autoConnect: true, directConnect: settings.directConnect, notes: settings.notes, serverId: settings.serverId } });
    const editing = createSettingsModal({ token, serverName: settings.serverName, settings, locale });
    validModal(editing); assert.equal(editing.data.components.length, 5);
    assert.equal(editing.data.components[0].component.value, '2026-10-15 18:00');
    assert.deepEqual(parseOpenWipeInteraction(submitted(editing)), { kind: 'open_wipe', action: 'settings_submit', token,
      values: { adaptiveDisplay: true, autoConnect: true, directConnect: settings.directConnect, notes: settings.notes,
        wipeAtLocal: settings.wipeAtLocal, timeZone: settings.timeZone } });
  }
  assert.equal(titleLanguages.size, 6);
});

test('new forms default both checkboxes on while saved off values survive modal and parsing', () => {
  const first = createServerModal({ token, servers, locale: 'en' });
  const options = first.data.components[1].component;
  assert.equal(options.type, 22); assert.equal(options.required, false); assert.equal(options.min_values, 0);
  assert.ok(options.options.every(option => option.default === true));
  const empty = parseOpenWipeInteraction(submitted(first, { serverId: ['vital-eu-medium'], preferences: [], directConnect: '', notes: '' }));
  assert.deepEqual(empty.values, { serverId: 'vital-eu-medium', adaptiveDisplay: false, autoConnect: false, directConnect: '', notes: '' });
  const editing = createSettingsModal({ token, settings: { ...settings, adaptiveDisplay: false, autoConnect: false }, locale: 'ko' });
  assert.deepEqual(parseOpenWipeInteraction(submitted(editing)).values, {
    adaptiveDisplay: false, autoConnect: false, directConnect: settings.directConnect, notes: settings.notes, wipeAtLocal: settings.wipeAtLocal, timeZone: settings.timeZone,
  });
});

test('client locale mapping supports Chinese variants and six languages with English fallback', () => {
  for (const [locale, expected] of [['zh-CN', 'zh-CN'], ['zh-TW', 'zh-CN'], ['en-US', 'en'], ['en-GB', 'en'], ['ru', 'ru'], ['tr', 'tr'], ['th', 'th'], ['ko', 'ko'], ['de', 'en'], ['fr', 'en'], [undefined, 'en'], ['<@everyone>', 'en']]) {
    assert.equal(text(locale, 'createTitle'), text(expected, 'createTitle'));
    assert.deepEqual(createServerModal({ token, servers, locale }), createServerModal({ token, servers, locale: expected }));
  }
  assert.throws(() => text('en', 'not_a_key'), error => error.errorCode === 'OPEN_WIPE_COPY_INVALID');
  for (const locale of OPEN_WIPE_LANGUAGES) assert.ok(text(locale, 'failed', { code: 'TEST_FAILURE' }).includes('TEST_FAILURE'));
});

test('private previews replace all live card buttons, suppress mentions, and require a configured time to publish', () => {
  const card = { content: '@everyone', embeds: [{ title: 'Vital EU', description: 'A card' }],
    components: [{ type: 1, components: [{ type: 2, custom_id: 'public-attendance', label: 'Attend', style: 1 }] }], allowed_mentions: { parse: ['everyone'] } };
  const before = structuredClone(card);
  for (const locale of OPEN_WIPE_LANGUAGES) {
    const preview = createPreviewPayload({ token, cardPayload: card, locale, canPublish: true });
    assert.equal(preview.flags, undefined);
    assert.deepEqual(preview.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
    assert.deepEqual(preview.components[0].components.map(button => button.custom_id.split(':')[1]), ['publish', 'edit_details', 'server']);
    assert.ok(preview.components[0].components.every(button => button.label.length <= 80 && button.custom_id.length <= 100));
    const missingTime = createPreviewPayload({ token, cardPayload: card, locale, canPublish: false });
    assert.deepEqual(missingTime.components[0].components.map(button => button.custom_id.split(':')[1]), ['edit_details', 'server']);
    assert.ok(missingTime.content.includes(text(locale, 'previewNeedsTime')));
    preview.embeds[0].title = 'Changed'; assert.deepEqual(card, before);
  }
});

test('server menus reject ambiguous catalogs and preserve stable IDs within Discord native limits', () => {
  for (const rows of [[], [...servers, servers[0]], Array.from({ length: 26 }, (_, i) => ({ id: `server-${i}` })), [{ id: 'x'.repeat(101) }], [{ id: 'spaces are unsafe' }]])
    assert.throws(() => createServerModal({ token, servers: rows }), error => error.errorCode === 'OPEN_WIPE_SERVERS_INVALID');
  const rows = Array.from({ length: 25 }, (_, i) => ({ id: `server-${i}`, label: '😀'.repeat(120) }));
  const modal = createServerModal({ token, servers: rows }); validModal(modal);
  assert.deepEqual(modal.data.components[0].component.options.map(option => option.value), rows.map(row => row.id));
  validModal(createSettingsModal({ token, serverName: '😀'.repeat(80), settings }));
});

test('only the newwipe slash command and owned component prefix route to the open-wipe handler', () => {
  assert.deepEqual(parseOpenWipeInteraction({ type: 2, data: { name: 'newwipe' } }), { kind: 'open_wipe', action: 'open' });
  assert.deepEqual(parseOpenWipeInteraction({ type: 2, data: { name: 'newwipe', type: 1, options: [] } }), { kind: 'open_wipe', action: 'open' });
  for (const event of [null, {}, { type: 2, data: { name: 'wipe-react' } }, { type: 3, data: { custom_id: 'nblang:card:test' } }]) {
    assert.equal(ownsOpenWipeInteraction(event), false); assert.equal(parseOpenWipeInteraction(event), null);
  }
  assert.throws(() => parseOpenWipeInteraction({ type: 2, data: { name: 'newwipe', options: [{ name: 'actor', value: 'admin' }] } }), parseError);
  for (const action of OPEN_WIPE_BUTTON_ACTIONS) {
    const data = { component_type: 2, custom_id: openWipeCustomId(action, token) };
    assert.deepEqual(parseOpenWipeInteraction({ type: 3, data }), { kind: 'open_wipe', action, token });
    assert.throws(() => parseOpenWipeInteraction({ type: 5, data }), parseError);
  }
});

test('parser fails closed on malformed action IDs and incorrect interaction shapes', () => {
  for (const custom_id of [`nbopen:publish:${token}:admin`, 'nbopen:publish:short', `nbopen:unknown:${token}`, `nbopen:publish:${'!'.repeat(43)}`])
    assert.throws(() => parseOpenWipeInteraction({ type: 3, data: { component_type: 2, custom_id } }), parseError);
  assert.throws(() => parseOpenWipeInteraction({ type: 3, data: { component_type: 3, custom_id: openWipeCustomId('publish', token), values: ['admin'] } }), parseError);
  assert.throws(() => parseOpenWipeInteraction({ type: 3, data: { component_type: 2, custom_id: openWipeCustomId('publish', token), values: [] } }), parseError);
  assert.throws(() => openWipeCustomId('unknown', token), parseError);
});

test('modal parsing rejects missing, duplicate, injected, oversized, and wrong-type fields', () => {
  const modal = createServerModal({ token, servers, defaults: settings });
  for (const mutate of [
    event => event.data.components.pop(),
    event => event.data.components.push(event.data.components[0]),
    event => { event.data.components[1] = event.data.components[0]; },
    event => { event.data.components[0].component.custom_id = 'actorId'; },
    event => { event.data.components[1].component.values = ['autoConnect', 'autoConnect']; },
    event => { event.data.components[1].component.values = ['admin']; },
    event => { event.data.components[1].component.type = 3; },
    event => { event.data.components[0].component.values = ['vital-eu-medium', 'atlas-eu-main']; },
    event => { event.data.components[0].component.values = [1]; },
    event => { event.data.components[2].component.value = 'x'.repeat(301); },
    event => { event.data.components[2].component.value = 'client.connect host:28015\nquit'; },
    event => { event.data.components[3].component.value = 'x'.repeat(1001); },
    event => { event.data.components[3].component.value = 'note\x00'; },
    event => { event.data.components[3].component.value = false; },
    event => { event.data.components[0] = { type: 1, components: [event.data.components[0].component] }; },
  ]) {
    const event = submitted(modal); mutate(event); assert.throws(() => parseOpenWipeInteraction(event), parseError);
  }
});

test('settings parser normalizes the explicit local format and refuses ambiguous free-form or missing time zones', () => {
  const modal = createSettingsModal({ token, settings });
  assert.equal(parseOpenWipeInteraction(submitted(modal, { wipeAtLocal: '2026-10-15T18:00' })).values.wipeAtLocal, '2026-10-15T18:00');
  for (const overrides of [{ wipeAtLocal: '' }, { wipeAtLocal: '10/11/26 18:00' }, { wipeAtLocal: '2026-10-15T18:00Z' }, { timeZone: '' }, { timeZone: 'local browser time' }, { timeZone: 'UTC\nadmin' }])
    assert.throws(() => parseOpenWipeInteraction(submitted(modal, overrides)), parseError);
});

test('native proof handoff accepts only the original verifier-marked object and open-wipe domain', () => {
  const proof = Object.freeze({ provider: 'discord', payload: Object.freeze({ kind: 'open_wipe', action: 'open' }) });
  assert.equal(isOpenWipeProof(proof), false);
  assert.throws(() => assertOpenWipeProof(proof), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
  assert.equal(markOpenWipeProof(proof), proof); assert.equal(assertOpenWipeProof(proof), proof);
  for (const forged of [{ ...proof }, structuredClone(proof), null, { provider: 'discord', payload: { kind: 'community' } }]) {
    assert.equal(isOpenWipeProof(forged), false);
    assert.throws(() => assertOpenWipeProof(forged), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
  }
  for (const invalid of [null, { provider: 'kook', payload: { kind: 'open_wipe' } }, { provider: 'discord', payload: { kind: 'community' } }])
    assert.throws(() => markOpenWipeProof(invalid), error => error.errorCode === 'PLATFORM_AUTH_INVALID');
});

test('six-language business errors explain corrections and queued responses do not claim delivery', () => {
  for (const locale of OPEN_WIPE_LANGUAGES) {
    for (const [code, key] of Object.entries({ TIME_INPUT_INVALID: 'timeInvalid', TIME_ZONE_INVALID: 'timeZoneInvalid',
      TIME_AMBIGUOUS: 'timeAmbiguous', TIME_NONEXISTENT: 'timeNonexistent', TIME_ZONE_MISMATCH: 'timeMismatch', TIME_OFFSET_MISMATCH: 'timeMismatch',
      OPEN_WIPE_TIME_REQUIRED: 'timeMissing', OPEN_WIPE_TIME_NOT_FUTURE: 'timeFuture', OPEN_WIPE_CONNECT_INVALID: 'connectInvalid',
      OPEN_WIPE_NOTES_INVALID: 'notesInvalid', OPEN_WIPE_SERVER_INVALID: 'serverUnavailable', OPEN_WIPE_PERMISSION_DENIED: 'denied',
      OPEN_WIPE_TOKEN_EXPIRED: 'expired', REVISION_CONFLICT: 'expired', OPEN_WIPE_SETTINGS_INVALID: 'settingsInvalid' })) {
      assert.equal(localizeError(locale, code), text(locale, key));
      assert.ok(!localizeError(locale, code).includes(code));
    }
    for (const unsafe of ['__proto__', 'constructor', 'https://discord.com/token/secret', { message: 'secret' }, undefined])
      assert.equal(localizeError(locale, unsafe), text(locale, 'unknownFailure'));
    assert.notEqual(text(locale, 'queued'), text(locale, 'published'));
    assert.notEqual(text(locale, 'updateQueued'), text(locale, 'updated'));
    assert.notEqual(text(locale, 'deliveryUnknown'), text(locale, 'deliveryFailed'));
    assert.equal(localizeError(locale, 'CARD_EDIT_RECONCILIATION_REQUIRED'), text(locale, 'updateUnknown'));
  }
  assert.match(text('en', 'queued'), /queued.*when Discord confirms/);
  assert.match(text('en', 'updateQueued'), /queued.*when Discord confirms/);
  assert.equal(localizeError('de', 'TIME_ZONE_INVALID'), localizeError('en', 'TIME_ZONE_INVALID'));
});

test('server picker shows immediate server details below the selector in all six languages', () => {
  const card = { content: '@everyone', embeds: [{ title: 'Public roster', fields: [{ name: 'Accepted', value: 'A member' }] }],
    components: [{ type: 1, components: [{ type: 2, custom_id: 'live-signup', label: 'Accepted', style: 3 }] }] };
  const before = structuredClone(card);
  for (const locale of OPEN_WIPE_LANGUAGES) {
    const initial = createServerPickerPayload({ token, servers, locale });
    assert.deepEqual(initial.components.map(component => component.type), [10, 1]);
    assert.match(initial.components[1].components[0].custom_id, /^nbopen:select_server:/);
    assert.equal(initial.components[1].components[0].type, 3);
    assert.equal(initial.components[1].components[0].required, undefined);
    assert.ok(initial.components[0].content.includes(text(locale, 'pickerPrompt')));
    assert.ok(initial.components[1].components[0].options.every(option => !option.default));
    const preview = createPreviewPayload({ token, servers, settings, locale, cardPayload: card, canPublish: true });
    assert.deepEqual(preview.components.map(component => component.type), [10, 1, 10, 1]);
    assert.deepEqual(preview.components[1].components[0].options.filter(option => option.default).map(option => option.value), [settings.serverId]);
    assert.ok(preview.components[2].content.includes(settings.serverName));
    assert.ok(preview.components[2].content.includes(settings.wipeAtLocal));
    assert.ok(preview.components[2].content.includes(settings.directConnect));
    assert.ok(preview.components[2].content.includes(settings.notes));
    assert.ok(!JSON.stringify(preview).includes('A member'));
    assert.ok(!JSON.stringify(preview).includes('@everyone'));
    assert.deepEqual(preview.components[3].components.map(button => button.custom_id.split(':')[1]), ['edit_details', 'publish']);
    assert.equal(preview.components[3].components[1].label, text(locale, 'publish'));
    const editing = createServerPickerPayload({ token, servers, settings, locale, cardPayload: card, canPublish: true, editing: true });
    assert.equal(editing.components[3].components[1].label, text(locale, 'save'));
    assert.ok(editing.components[0].content.includes(text(locale, 'editingPreview')));
    assert.ok(!editing.components[0].content.includes(text(locale, 'preview')));
    const missingTime = createServerPickerPayload({ token, servers, settings, locale });
    assert.deepEqual(missingTime.components[3].components.map(button => button.custom_id.split(':')[1]), ['edit_details']);
    assert.ok(missingTime.components[0].content.includes(text(locale, 'previewNeedsTime')));
    for (const payload of [initial, preview, editing, missingTime]) {
      assert.equal(payload.flags, 32768);
      assert.equal(payload.content, '');
      assert.deepEqual(payload.embeds, []);
      assert.deepEqual(payload.allowed_mentions, { parse: [], roles: [], users: [], replied_user: false });
      assert.ok(payload.components.filter(component => component.type === 10).reduce((total, component) => total + component.content.length, 0) <= 4000);
      for (const row of payload.components.filter(component => component.type === 1)) for (const component of row.components) {
        assert.ok(component.custom_id.length <= 100);
        if (component.label) assert.ok(component.label.length <= 80);
      }
    }
    preview.components[2].content = 'Changed';
    assert.deepEqual(card, before);
  }
});

test('picker supports selected-server compatibility, validated catalogs, fixed or adaptive dates and resolved IP', () => {
  const card = { embeds: [{ title: 'Selected server' }] };
  for (const selectedServer of [settings.serverId, settings]) {
    const payload = createPreviewPayload({ token, servers, selectedServer, cardPayload: card, locale: 'en' });
    assert.equal(payload.components[3].components[1].label, 'Publish');
    assert.equal(payload.components[1].components[0].options[0].default, true);
  }
  for (const rows of [[], [...servers, servers[0]], [{ id: 'space not allowed' }]])
    assert.throws(() => createServerPickerPayload({ token, servers: rows }), error => error.errorCode === 'OPEN_WIPE_SERVERS_INVALID');
  const resolved = { ...settings, wipeAt: '2026-10-15T16:00:00.000Z', resolvedIp: '168.100.161.200' };
  const payload = createServerPickerPayload({ token, servers, settings: resolved, locale: 'en' });
  assert.ok(payload.components[2].content.includes('<t:1792080000:F>'));
  assert.ok(payload.components[2].content.includes(settings.directConnect));
  assert.ok(payload.components[2].content.includes('client.connect 168.100.161.200:28014'));
  const fixed = createServerPickerPayload({ token, servers, settings: { ...resolved, adaptiveDisplay: false }, locale: 'en' });
  assert.ok(fixed.components[2].content.includes('2026-10-15T18:00 (Europe/Amsterdam)'));
  assert.ok(!fixed.components[2].content.includes('<t:'));
  const huge = createServerPickerPayload({ token, servers, settings: { ...resolved, serverName: '@everyone **'.repeat(100), notes: '😀'.repeat(4000) }, locale: 'th' });
  assert.ok(huge.components.filter(component => component.type === 10).reduce((total, component) => total + component.content.length, 0) <= 4000);
  assert.ok(!/[\uD800-\uDBFF]$/.test(huge.components[2].content));
  assert.ok(!huge.components[2].content.includes('@everyone'));
  assert.deepEqual(createServerPickerPayload({ token, servers, settings, locale: 'de' }), createServerPickerPayload({ token, servers, settings, locale: 'en' }));
});

test('attendance copy uses three localized response labels and removes the sign-in explanation', () => {
  assert.deepEqual(['signupOnTime', 'signupAbsent', 'signupLate', 'settings'].map(key => text('en', key)), ['Accepted', 'Declined', 'Late', 'Settings']);
  assert.deepEqual(['signupOnTime', 'signupAbsent', 'signupLate', 'settings'].map(key => text('zh-CN', key)), ['参加', '不参加', '迟到', '设置']);
  for (const locale of OPEN_WIPE_LANGUAGES) {
    for (const key of ['signupOnTime', 'signupAbsent', 'signupLate', 'settings', 'save', 'editDetails', 'pickerPrompt']) assert.ok(text(locale, key));
    assert.throws(() => text(locale, 'noBinding'), error => error.errorCode === 'OPEN_WIPE_COPY_INVALID');
  }
});
