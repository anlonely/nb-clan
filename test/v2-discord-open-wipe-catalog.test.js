import test from 'node:test';
import assert from 'node:assert/strict';
import { wipeServerCatalog } from '../server/v2/production/wipe-catalog.js';
import { defaultsForServer, listOpenWipeServers, normalizeOpenWipeConnect, normalizeOpenWipeSettings } from '../server/v2/discord-open-wipe/catalog.js';

const now = Date.parse('2026-10-14T12:00:00Z');
const options = { now };
const catalog = { listOptions(kind) {
  assert.equal(kind, 'servers');
  return { items: wipeServerCatalog({}, new Date(now)), nextCursor: null };
}, prepareOptions() { throw new Error('No network preparation in a pure catalog read'); } };
const fixtureCatalog = (snapshot = {}) => ({ listOptions: () => ({ items: [{ id: 'manual', label: 'Manual server', serverSnapshot: snapshot }] }) });
const error = code => value => value.errorCode === code && value.status === 422;

test('open Wipe picks the next Vital date in its advertised zone and enables adaptive defaults', () => {
  const server = defaultsForServer(catalog, '19', options);
  assert.deepEqual(server, { id: '19', label: 'Vital Rust 2X EU Medium', nextWipeAt: '2026-10-15T16:00:00.000Z',
    timeZone: 'Europe/London', directConnect: 'client.connect eu-medium.vitalrust.com:28014',
    wipeAtLocal: '2026-10-15T17:00', utcOffset: '+01:00' });
  const settings = normalizeOpenWipeSettings({}, server, options);
  assert.equal(settings.wipeAt, server.nextWipeAt);
  assert.equal(settings.adaptiveDisplay, true);
  assert.equal(settings.autoConnect, true);
  assert.equal(settings.directConnect, server.directConnect);
  assert.equal(settings.serverId, '19');
  assert.equal(settings.notes, '');
  assert.equal(listOpenWipeServers(catalog, options).length, 12);
  assert.throws(() => defaultsForServer(catalog, 'unknown', options), error('OPEN_WIPE_SERVER_INVALID'));
});

test('missing and stale next dates stay empty until a valid future date is supplied manually', () => {
  for (const nextWipeAt of [undefined, '', 'bad', '2026-10-15T16:00', '2026-10-14T12:00:00Z', '2026-02-30T16:00:00Z']) {
    const server = defaultsForServer(fixtureCatalog({ nextWipeAt }), 'manual', options);
    assert.equal(server.nextWipeAt, null);
    assert.equal(server.wipeAtLocal, '');
    assert.equal(server.timeZone, 'UTC');
    assert.throws(() => normalizeOpenWipeSettings({}, server, options), error('OPEN_WIPE_TIME_REQUIRED'));
    assert.equal(normalizeOpenWipeSettings({ wipeAtLocal: '2026-10-15 18:00', timeZone: 'Europe/Amsterdam' }, server, options).wipeAt,
      '2026-10-15T16:00:00.000Z');
  }
  const server = defaultsForServer(catalog, '19', options);
  assert.throws(() => normalizeOpenWipeSettings({ wipeAtLocal: '2026-10-14T13:00' }, server, options), error('OPEN_WIPE_TIME_NOT_FUTURE'));
});

test('manual date and direct-connect values take precedence when choosing a different server', () => {
  const server = defaultsForServer(catalog, '16', options);
  const input = { wipeAtLocal: '15.10.2026 18:30', timeZone: 'Europe/Amsterdam',
    directConnect: 'connect Manual.Example:28016', notes: '  Bring building materials.\nMeet before wipe.  ' };
  const settings = normalizeOpenWipeSettings(input, server, options);
  assert.equal(settings.wipeAt, '2026-10-15T16:30:00.000Z');
  assert.notEqual(settings.wipeAt, server.nextWipeAt);
  assert.equal(settings.directConnect, 'client.connect manual.example:28016');
  assert.equal(settings.notes, 'Bring building materials.\nMeet before wipe.');
  assert.equal(input.directConnect, 'connect Manual.Example:28016');
  assert.equal(server.directConnect, 'client.connect eu-monthly.vitalrust.com:28014');
});

test('automatic connect can use the catalog, use a manual fallback, or remain absent', () => {
  const server = defaultsForServer(catalog, '19', options);
  assert.equal(normalizeOpenWipeSettings({ autoConnect: false }, server, options).directConnect, '');
  assert.equal(normalizeOpenWipeSettings({ autoConnect: false, directConnect: '168.100.161.200:28014' }, server, options).directConnect,
    'client.connect 168.100.161.200:28014');
  const missing = defaultsForServer(fixtureCatalog({ nextWipeAt: server.nextWipeAt, directConnect: 'client.connect missing-port.example' }), 'manual', options);
  assert.equal(missing.directConnect, '');
  assert.equal(normalizeOpenWipeSettings({}, missing, options).directConnect, '');
  assert.equal(normalizeOpenWipeSettings({ directConnect: 'steam://connect/manual.example:28016/' }, missing, options).directConnect,
    'client.connect manual.example:28016');
});

test('manual connect requires a valid explicit port and cannot carry console commands', () => {
  for (const input of ['connect host.example', 'host.example:0', 'host.example:65536', 'host.example:28015;quit',
    'host.example:28015\nquit', 'client.connect host.example:28015\t', 'user:pass@host.example:28015', 'http://host.example:28015',
    '256.1.1.1:28015', '-bad.example:28015', 'bad..example:28015', '[::gg]:28015', 'host.example:28015 @everyone']) {
    assert.throws(() => normalizeOpenWipeConnect(input), error('OPEN_WIPE_CONNECT_INVALID'), input);
  }
  assert.equal(normalizeOpenWipeConnect('client.connect [2001:db8::1]:28015'), 'client.connect [2001:db8::1]:28015');
  assert.equal(normalizeOpenWipeConnect(''), '');
});

test('manual times reject DST gaps and require an explicit choice for repeated local hours', () => {
  const server = defaultsForServer(fixtureCatalog(), 'manual', options);
  const early = { now: Date.parse('2026-01-01T00:00:00Z') };
  assert.throws(() => normalizeOpenWipeSettings({ wipeAtLocal: '2026-03-08T02:30', timeZone: 'America/New_York' }, server, early), error('TIME_NONEXISTENT'));
  const input = { wipeAtLocal: '2026-11-01T01:30', timeZone: 'America/New_York' };
  assert.throws(() => normalizeOpenWipeSettings(input, server, options), error('TIME_AMBIGUOUS'));
  assert.equal(normalizeOpenWipeSettings({ ...input, utcOffset: '-04:00' }, server, options).wipeAt, '2026-11-01T05:30:00.000Z');
  assert.equal(normalizeOpenWipeSettings({ ...input, utcOffset: '-05:00' }, server, options).wipeAt, '2026-11-01T06:30:00.000Z');
  const defaults = defaultsForServer(fixtureCatalog({ nextWipeAt: '2026-11-01T06:30:00Z', scheduleTimeZone: 'America/New_York' }), 'manual', options);
  assert.equal(defaults.utcOffset, '-05:00');
  assert.equal(normalizeOpenWipeSettings({ wipeAtLocal: defaults.wipeAtLocal, utcOffset: defaults.utcOffset }, defaults, options).wipeAt, defaults.nextWipeAt);
});

test('missing catalog zones default to UTC and client language never supplies a timezone', () => {
  const unknownZone = defaultsForServer(fixtureCatalog({ nextWipeAt: '2026-10-15T16:00:00Z', scheduleTimeZone: 'Europe/Nowhere' }), 'manual', options);
  assert.equal(unknownZone.timeZone, 'UTC');
  assert.equal(unknownZone.wipeAtLocal, '2026-10-15T16:00');
  assert.throws(() => normalizeOpenWipeSettings({ locale: 'zh-CN' }, unknownZone, options), error('OPEN_WIPE_SETTINGS_INVALID'));
  assert.throws(() => normalizeOpenWipeSettings({ timeZone: 'zh-CN' }, unknownZone, options), error('TIME_ZONE_INVALID'));
  assert.equal(normalizeOpenWipeSettings({ adaptiveDisplay: false }, unknownZone, options).adaptiveDisplay, false);
});

test('settings reject mismatched types, arbitrary routing fields, invalid dates and excessive notes', () => {
  const server = defaultsForServer(catalog, '19', options);
  for (const input of [{ autoConnect: 'true' }, { adaptiveDisplay: 1 }, { notes: [] }, { directConnect: {} }, { guildId: 'other' },
    { serverSnapshot: {} }, { wipeAtLocal: null }]) assert.throws(() => normalizeOpenWipeSettings(input, server, options), error('OPEN_WIPE_SETTINGS_INVALID'));
  assert.throws(() => normalizeOpenWipeSettings({ wipeAtLocal: '2026-11-31T17:00' }, server, options), error('TIME_INPUT_INVALID'));
  assert.throws(() => normalizeOpenWipeSettings({ notes: 'x'.repeat(2001) }, server, options), error('OPEN_WIPE_NOTES_INVALID'));
  assert.throws(() => normalizeOpenWipeSettings({ notes: 'A\u0000B' }, server, options), error('OPEN_WIPE_NOTES_INVALID'));
});
