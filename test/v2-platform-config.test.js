import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createPlatformConfigReaders } from '../server/v2/management-adapters/platform-config/index.js';
import { defaults, normalizeConfig, normalizeSubscriptionTemplates, WECHAT_SUBSCRIPTION_TEMPLATE_KEYS } from '../server/v2/platform-admin/model.js';
import { TEMPLATE_KEYS } from '../server/v2/member-inbox/service.js';
import { fixture } from './support/v2-platform-config/fixture.mjs';
const error = code => e => e.errorCode === code;
async function setup(t) { const f = await fixture(); t.after(() => f.close()); return f; }

test('four synchronous projections read the same canonical service revision without writes or secret exposure', async t => {
  const f = await setup(t), before = f.db.prepare('SELECT total_changes() n').get().n, schema = f.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all();
  assert.deepEqual(f.readers.readMini(), { enabled: true, appId: 'host_app', revision: 1, minClientVersion: 1 });
  assert.deepEqual(f.readers.readMedia(), { enabled: true, appId: 'host_app', generation: 1 });
  assert.equal(f.readers.readInbox().revision, 1); assert.equal(f.readers.readInbox().then, undefined);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.deepEqual(f.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all(), schema);
  await f.secrets('constructed-private-value');
  for (const read of [f.readers.readMini, f.readers.readMedia, f.readers.readInbox]) assert.ok(!JSON.stringify(read()).includes('constructed-private-value'));
  assert.equal(f.readers.readMedia().generation, 2);
  assert.equal(f.readers.readInbox().revision, 2); assert.equal(f.readers.readMini().revision, 2);
});

test('factory pins service, identity, database and app; missing or corrupt generation fails closed', async t => {
  const f = await setup(t), otherDb = new DatabaseSync(':memory:'); t.after(() => otherDb.close());
  assert.throws(() => createPlatformConfigReaders({ platformService: { identity: f.identity, repo: { db: f.db }, config: () => f.platformService.config('wechat') }, appId: 'host_app' }), error('PLATFORM_CONFIG_HOST_REQUIRED'));
  assert.throws(() => createPlatformConfigReaders({ platformService: f.platformService, identity: { repo: { db: otherDb } }, appId: 'host_app' }), error('PLATFORM_CONFIG_HOST_REQUIRED'));
  for (const read of [f.readers.readMini, f.readers.readMedia, f.readers.readInbox]) {
    assert.throws(() => read({ appId: 'other_app' }), error('PLATFORM_CONFIG_APP_MISMATCH'));
    assert.throws(() => read({ db: otherDb }), error('PLATFORM_CONFIG_DB_MISMATCH'));
    assert.throws(() => read({ revision: 900 }), error('PLATFORM_CONFIG_CONTEXT_INVALID'));
  }
  const original = f.platformService.config('wechat');
  for (const revision of [0, -1, 1.2, '1', Number.MAX_SAFE_INTEGER + 1]) {
    f.platformService.repo.put('config', 'wechat', 'wechat', '', f.now(), { ...original, revision });
    assert.throws(() => f.readers.readMini(), error(revision === 0 ? 'PLATFORM_CONFIG_UNSAVED' : 'PLATFORM_CONFIG_INVALID'));
  }
  f.platformService.repo.put('config', 'wechat', 'wechat', '', f.now(), original);
  await f.save({ appId: 'other_app' });
  assert.throws(() => f.readers.readInbox(), error('PLATFORM_CONFIG_APP_MISMATCH'));
  const other = createPlatformConfigReaders({ platformService: f.platformService, appId: 'other_app' }); assert.equal(other.readMedia().generation, 2);
});

test('real save/secrets receipts replay without revision or vault write; failed transaction rolls vault and config back', async t => {
  const f = await setup(t);
  await f.save({ minClientVersion: 2 }, { expectedRevision: 1, operationId: 'same-config-save' });
  await f.save({ minClientVersion: 2 }, { expectedRevision: 1, operationId: 'same-config-save' });
  assert.equal(f.readers.readMini().revision, 2);
  await assert.rejects(() => f.save({ minClientVersion: 1 }, { expectedRevision: 1, operationId: 'same-config-save' }), error('IDEMPOTENCY_CONFLICT'));
  await f.secrets('constructed-first', { expectedRevision: 2, operationId: 'same-secret-write' });
  await f.secrets('constructed-first', { expectedRevision: 2, operationId: 'same-secret-write' });
  assert.equal(f.state.vaultWrites, 1); assert.equal(f.readers.readMedia().generation, 3);
  f.state.failAfterVault = true;
  await assert.rejects(() => f.secrets('constructed-second'), /isolated post-vault failure/);
  assert.equal(f.db.prepare("SELECT value FROM platform_config_fixture_vault WHERE platform='wechat' AND field='appSecret'").get().value, 'constructed-first');
  assert.equal(f.platformService.repo.list('audit', 'wechat').filter(row => row.action === 'secrets').length, 1);
  assert.deepEqual(f.platformService.repo.get('secret-status', 'wechat'), { appSecret: true });
  assert.equal(f.db.isTransaction, false);
});

test('disable, appId change and changing back always advance a durable shared generation even without intermediate reads', async t => {
  const f = await setup(t), initial = f.readers.readMedia();
  await f.save({ enabled: false }); assert.equal(f.readers.readMini().enabled, false);
  await f.save({ enabled: true }); assert.equal(f.readers.readMedia().generation, initial.generation + 2);
  await f.save({ appId: 'other_app' }); await f.save({ appId: 'host_app' });
  const restartedReaders = createPlatformConfigReaders({ platformService: f.platformService, appId: 'host_app' });
  assert.equal(restartedReaders.readMedia().generation, 5);
  assert.notDeepEqual(restartedReaders.readMedia(), initial);
});

test('explicit template map is validated; old array is retained without positional inference', async t => {
  const f = await setup(t); assert.deepEqual(WECHAT_SUBSCRIPTION_TEMPLATE_KEYS, TEMPLATE_KEYS);
  const ids = ['legacy-first', 'legacy-second', 'legacy-third', 'legacy-fourth', 'legacy-fifth'];
  await f.save({ subscriptionTemplateIds: ids });
  const { subscriptionTemplates: ignored, ...legacy } = f.platformService.config('wechat');
  f.platformService.repo.put('config', 'wechat', 'wechat', '', f.now(), legacy);
  assert.deepEqual(f.platformService.config('wechat').subscriptionTemplateIds, ids);
  assert.deepEqual(f.readers.readInbox().subscriptionTemplates, Object.fromEntries(TEMPLATE_KEYS.map(k => [k, ''])));
  await f.save({ subscriptionTemplates: { wipeOpen: ' explicit-open ' } });
  assert.equal(f.readers.readInbox().subscriptionTemplates.wipeOpen, 'explicit-open');
  assert.deepEqual(f.platformService.config('wechat').subscriptionTemplateIds, ids);
  const result = f.readers.readInbox(); assert.throws(() => { result.subscriptionTemplates.wipeOpen = 'mutated'; }, TypeError);
  await f.save({ subscriptionTemplates: { wipeReminder: 'reminder-only' } });
  assert.equal(f.readers.readInbox().subscriptionTemplates.wipeOpen, '');
  await f.save({ minClientVersion: 2 }); assert.equal(f.readers.readInbox().subscriptionTemplates.wipeReminder, 'reminder-only');
});

test('template map rejects unsupported keys/types/IDs atomically and malformed persisted map stays unavailable', async t => {
  const f = await setup(t), before = f.readers.readMini().revision;
  const bad = [null, [], '', { unknown: 'id' }, { wipeOpen: null }, { wipeOpen: 4 }, { wipeOpen: 'x'.repeat(161) },
    { wipeOpen: 'bad id' }, { wipeOpen: 'https://template.invalid' }, { wipeOpen: 'bad\u0000id' }, JSON.parse('{"__proto__":"bad"}'), { constructor: 'bad' }];
  for (const subscriptionTemplates of bad) {
    assert.throws(() => normalizeSubscriptionTemplates(subscriptionTemplates), error('PLATFORM_TEMPLATE_MAP_INVALID'));
    await assert.rejects(() => f.save({ subscriptionTemplates }), error('PLATFORM_TEMPLATE_MAP_INVALID'));
  }
  assert.equal(f.readers.readMini().revision, before);
  assert.deepEqual(defaults('wechat').subscriptionTemplates, normalizeSubscriptionTemplates({}));
  assert.equal(normalizeConfig('wechat', { subscriptionTemplates: { wipeOpen: '' } }).subscriptionTemplates.wipeOpen, '');
  const row = f.platformService.config('wechat'); f.platformService.repo.put('config', 'wechat', 'wechat', '', f.now(), { ...row, subscriptionTemplates: { wipeOpen: null } });
  assert.throws(() => f.readers.readInbox(), error('PLATFORM_CONFIG_TEMPLATES_INVALID'));
});
