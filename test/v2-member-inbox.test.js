import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { IdentityRepository } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { fixture } from './support/v2-member-inbox/fixture.mjs';
import { MemberInboxService, installMemberInboxSchema } from '../server/v2/member-inbox/index.js';
const setup = (t, options) => { const x = fixture(options); t.after(() => x.close()); return x; };
const op = () => randomUUID();
const opts = (id = op()) => ({ operationId: id, assertCurrent() {} });
const fail = (fn, code) => assert.throws(fn, e => e.errorCode === code);
const rejects = (p, code) => assert.rejects(p, e => e.errorCode === code);
const preference = x => ({ expectedRevision: 1, expectedConfigRevision: x.service.settings(x.actor('alice')).configRevision,
  subscriptions: { wipeReminder: 'accept' } });

test('explicit schema is idempotent and GET/service construction never migrates', t => {
  const x = setup(t, { install: false });
  fail(() => new MemberInboxService(x.options), 'INBOX_MIGRATION_REQUIRED');
  installMemberInboxSchema(x.db); const secret = x.db.prepare('SELECT cursor_secret FROM v2_member_inbox_meta').get().cursor_secret;
  installMemberInboxSchema(x.db); assert.equal(x.db.prepare('SELECT cursor_secret FROM v2_member_inbox_meta').get().cursor_secret, secret);
  const s = new MemberInboxService(x.options), before = x.db.prepare('SELECT total_changes() n').get().n;
  s.settings(x.actor('alice')); s.list(x.actor('alice'));
  assert.equal(x.db.prepare('SELECT total_changes() n').get().n, before);
});
test('settings use server templates, write canonical preferences without notification creation or verified claim', async t => {
  const x = setup(t), input = preference(x), key = op();
  const r = await x.service.saveSettings(x.actor('alice'), input, opts(key));
  assert.equal(r.current.preferencesRevision, 2); assert.equal(r.current.subscriptions.wipeReminder.platformVerified, false);
  assert.equal(r.current.subscriptions.wipeReminder.state, 'client_reported');
  assert.equal(x.repo.get('wechatUsers', 'alice-app-a').subscriptionPreferences.wipeReminder.templateId, 'template-reminder');
  assert.deepEqual(x.repo.get('wechatUsers', 'alice-app-b').subscriptionPreferences, {});
  assert.equal(x.db.prepare("SELECT count(*) n FROM json_records WHERE collection='wechatNotifications'").get().n, 0);
  assert.equal(x.db.prepare("SELECT count(*) n FROM json_records WHERE collection='operationRuns'").get().n, 0);
  const replay = await x.service.saveSettings(x.actor('alice'), input, opts(key)); assert.equal(replay.replayed, true);
  assert.equal(x.db.prepare('SELECT count(*) n FROM v2_member_inbox_audit').get().n, 1);
  assert.equal(x.queueCalls, 2);
});
test('client owner/app/account and arbitrary template fields cannot select another subject', t => {
  const x = setup(t);
  for (const field of ['accountId', 'appId', 'wechatUserId', 'userId', 'openid', 'actor']) {
    fail(() => x.service.settings(x.actor('alice'), { [field]: 'bob' }), 'INBOX_FIELD_NOT_WRITABLE');
    fail(() => x.service.saveSettings(x.actor('alice'), { ...preference(x), [field]: 'bob' }, opts()), 'INBOX_FIELD_NOT_WRITABLE');
  }
});
test('config changes before submission or while queued reject old template consent; old successful receipt replays with new current', async t => {
  const x = setup(t), old = preference(x), key = op();
  await x.service.saveSettings(x.actor('alice'), old, opts(key));
  x.config.subscriptionTemplates.wipeReminder = 'replacement-template'; x.config.revision++;
  const replay = await x.service.saveSettings(x.actor('alice'), old, opts(key));
  assert.equal(replay.replayed, true); assert.equal(replay.current.subscriptions.wipeReminder.state, 'template_changed');
  assert.equal(replay.current.subscriptions.wipeReminder.status, '');
  await rejects(x.service.saveSettings(x.actor('alice'), { ...old, expectedRevision: 2 }, opts()), 'INBOX_CONFIG_CHANGED');
  const next = { ...preference(x), expectedRevision: 2 };
  x.queue(() => { x.config.revision++; });
  await rejects(x.service.saveSettings(x.actor('alice'), next, opts()), 'INBOX_CONFIG_CHANGED');
});
test('current templateId aliases, unknown reports and disabled templates retain safe semantics', async t => {
  const x = setup(t), base = preference(x);
  const r = await x.service.saveSettings(x.actor('alice'), { ...base, subscriptions: { 'template-reminder': 'unexpected' } }, opts());
  assert.equal(r.current.subscriptions.wipeReminder.status, 'unknown');
  await rejects(x.service.saveSettings(x.actor('alice'), { ...base, expectedRevision: 2, subscriptions: { adminJoinReview: 'accept' } }, opts()), 'INBOX_TEMPLATE_UNAVAILABLE');
  await rejects(x.service.saveSettings(x.actor('alice'), { ...base, expectedRevision: 2, subscriptions: { wipeReminder: 'accept', 'template-reminder': 'reject' } }, opts()), 'INBOX_PREFERENCE_CONFLICT');
});
test('SQL scopes before page and count; tie-breaker cursor does not leak cross-account/app adminNote', t => {
  const x = setup(t); for (let i = 0; i < 8; i++) x.putNotification(`a-${i}`);
  for (let i = 0; i < 30; i++) x.putNotification(`z-${i}`, i % 2 ? 'bob-app-a' : 'alice-app-b');
  x.putNotification('bad-explicit-app', 'alice-app-a', { appId: 'app-b' });
  const first = x.service.list(x.actor('alice'), { limit: 3 });
  assert.equal(first.total, 8); assert.equal(first.notifications.length, 3); assert.equal(first.latestNotification.id, 'a-7');
  assert.ok(first.notifications.every(n => n.adminNote === '仅收件人可见-alice-app-a'));
  assert.equal(JSON.stringify(first).includes('openid'), false);
  const second = x.service.list(x.actor('alice'), { limit: 3, cursor: first.nextCursor });
  assert.deepEqual(second.notifications.map(n => n.id), ['a-4', 'a-3', 'a-2']);
  fail(() => x.service.list(x.actor('bob'), { cursor: first.nextCursor }), 'CURSOR_EXPIRED');
  const appB = new MemberInboxService({ ...x.options, appId: 'app-b', readConfig: () => ({ ...x.config, appId: 'app-b' }) });
  fail(() => appB.list(x.actor('alice'), { cursor: first.nextCursor }), 'CURSOR_EXPIRED');
  fail(() => x.service.list(x.actor('alice'), { cursor: first.nextCursor + 'x' }), 'CURSOR_EXPIRED');
});
test('readAt belongs to canonical item, respects observed version and stable replay', async t => {
  const x = setup(t), row = x.putNotification('note-1'), key = op(), input = { expectedRevision: 1 };
  const r = await x.service.markRead(x.actor('alice'), row.id, input, opts(key));
  assert.equal(r.current.revision, 2); assert.equal(r.current.readAt, new Date(x.now()).toISOString());
  const next = x.service.repo.get('wechatNotifications', row.id); next.title = '后续标题'; next.revision = 3; x.service.repo.put('wechatNotifications', next);
  const replay = await x.service.markRead(x.actor('alice'), row.id, input, opts(key));
  assert.equal(replay.operationReceipt.revision, 2); assert.equal(replay.current.revision, 3); assert.equal(replay.current.title, '后续标题');
  await rejects(x.service.markRead(x.actor('alice'), row.id, input, opts()), 'REVISION_CONFLICT');
  assert.equal((await x.service.markRead(x.actor('alice'), row.id, { expectedRevision: 3 }, opts())).current.revision, 3);
});
test('nonowner and explicit cross-app item are always 404, even for a known identifier', async t => {
  const x = setup(t); x.putNotification('bob-note', 'bob-app-a'); x.putNotification('app-note', 'alice-app-b');
  x.putNotification('wrong-app', 'alice-app-a', { appId: 'app-b' });
  for (const id of ['bob-note', 'app-note', 'wrong-app', 'missing']) await rejects(x.service.markRead(x.actor('alice'), id, { expectedRevision: 1 }, opts()), 'RESOURCE_NOT_FOUND');
  assert.equal(x.db.prepare('SELECT count(*) n FROM v2_member_inbox_receipts').get().n, 0);
});
test('concurrent preference/read versions allow only one commit, keys bind command and payload', async t => {
  const x = setup(t), input = preference(x);
  const results = await Promise.allSettled([x.service.saveSettings(x.actor('alice'), input, opts()), x.service.saveSettings(x.actor('alice'), input, opts())]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.errorCode, 'REVISION_CONFLICT');
  x.putNotification('n1'); x.putNotification('n2'); const key = op();
  await x.service.markRead(x.actor('alice'), 'n1', { expectedRevision: 1 }, opts(key));
  await rejects(x.service.markRead(x.actor('alice'), 'n2', { expectedRevision: 1 }, opts(key)), 'IDEMPOTENCY_CONFLICT');
  await rejects(x.service.markRead(x.actor('alice'), 'n1', { expectedRevision: 2 }, opts(key)), 'IDEMPOTENCY_CONFLICT');
});
test('permission changes, session assertion and mapping changes are fenced after queue wait', async t => {
  const x = setup(t), actor = x.actor('alice'), input = preference(x);
  x.queue(() => x.repo.put('accounts', { ...x.repo.get('accounts', 'alice'), permissionVersion: 2 }));
  await rejects(x.service.saveSettings(actor, input, opts()), 'PERMISSIONS_CHANGED');
  const a = x.actor('alice');
  x.queue(() => x.repo.put('identities', { ...x.repo.get('identities', 'alice:app-a'), revision: 2 }));
  await rejects(x.service.saveSettings(a, input, opts()), 'PERMISSIONS_CHANGED');
  let valid = true; x.queue(() => { valid = false; });
  await assert.rejects(x.service.saveSettings(a, input, { operationId: op(), assertCurrent() { if (!valid) throw new Error('expired'); } }));
  assert.equal(x.repo.get('wechatUsers', 'alice-app-a').subscriptionPreferencesRevision, undefined);
});
test('disabled accounts, ambiguous same-app identities and missing app namespace fail closed', t => {
  const x = setup(t), actor = x.actor('alice');
  x.repo.put('identities', { id: 'second', accountId: 'alice', provider: 'wechat:app-a', externalId: 'other', revision: 1 });
  fail(() => x.service.settings(actor), 'INBOX_SUBJECT_UNAVAILABLE');
  x.repo.remove('identities', 'second');
  x.repo.put('wechatUsers', { ...x.repo.get('wechatUsers', 'alice-app-a'), appId: '' });
  fail(() => x.service.settings(actor), 'INBOX_SUBJECT_UNAVAILABLE');
  x.repo.put('accounts', { ...x.repo.get('accounts', 'alice'), status: 'disabled' });
  fail(() => x.service.settings(actor), 'ACCOUNT_DISABLED');
});
test('transaction failure after canonical write rolls back preference/readAt and receipt/audit', async t => {
  const x = setup(t), input = preference(x), original = x.service.repo.put.bind(x.service.repo);
  x.putNotification('n1');
  x.service.repo.put = (...args) => { original(...args); throw new Error('after canonical write'); };
  await assert.rejects(x.service.saveSettings(x.actor('alice'), input, opts()));
  await assert.rejects(x.service.markRead(x.actor('alice'), 'n1', { expectedRevision: 1 }, opts()));
  assert.deepEqual(x.repo.get('wechatUsers', 'alice-app-a').subscriptionPreferences, {});
  assert.equal(x.service.repo.get('wechatNotifications', 'n1').readAt, '');
  assert.equal(x.db.prepare('SELECT count(*) n FROM v2_member_inbox_receipts').get().n, 0);
  assert.equal(x.db.prepare('SELECT count(*) n FROM v2_member_inbox_audit').get().n, 0);
  assert.deepEqual(x.cache, {});
});
test('unknown cache failure recovers same receipt and latest canonical state without overwriting newer preference', async t => {
  const x = setup(t), key = op(), input = preference(x); x.cacheFailure = true;
  await assert.rejects(x.service.saveSettings(x.actor('alice'), input, opts(key)));
  const user = x.repo.get('wechatUsers', 'alice-app-a'); user.nickname = '后来更新'; x.repo.put('wechatUsers', user);
  x.cacheFailure = false; const result = await x.service.saveSettings(x.actor('alice'), input, opts(key));
  assert.equal(result.replayed, true); assert.equal(x.cache.wechatUsers[0].nickname, '后来更新');
  assert.equal(x.db.prepare('SELECT count(*) n FROM v2_member_inbox_receipts').get().n, 1);
});

test('restart/second connection sees original canonical receipt and schema replay preserves it', async t => {
  const x = setup(t), input = preference(x), key = op();
  await x.service.saveSettings(x.actor('alice'), input, opts(key));
  const db = new DatabaseSync(join(x.directory,'isolated.sqlite'));
  try {
    installMemberInboxSchema(db);
    const identity = new IdentityService(new IdentityRepository(db), { now: x.now });
    const service = new MemberInboxService({ ...x.options, identity });
    const replay = await service.saveSettings(identity.actorForAccount('alice'), input, opts(key));
    assert.equal(replay.replayed,true); assert.equal(replay.current.preferencesRevision,2);
    assert.equal(db.prepare('SELECT count(*) n FROM v2_member_inbox_receipts').get().n,1);
  } finally { db.close(); }
});
test('same literal openid from another app never falls back to its canonical user', t => {
  const x = setup(t), actor = x.actor('alice');
  x.repo.put('identities',{...x.repo.get('identities','alice:app-b'),externalId:'alice-app-a-openid'});
  const other = new MemberInboxService({...x.options,appId:'app-b',readConfig:()=>({...x.config,appId:'app-b'})});
  fail(()=>other.settings(actor),'INBOX_SUBJECT_UNAVAILABLE');
  // Record the existing shared-schema limitation without dropping its index.
  assert.throws(()=>x.repo.put('wechatUsers',{id:'same-openid-second-app',appId:'app-b',openid:'alice-app-a-openid'}), /UNIQUE constraint/);
  x.repo.put('wechatUsers',{...x.repo.get('wechatUsers','alice-app-a'),openId:'bob-app-a-openid'});
  fail(()=>x.service.settings(actor),'INBOX_SUBJECT_UNAVAILABLE');
});
test('cursor survives new top insertion with tied dates, but expires with permission scope or age', t => {
  const x = setup(t); x.putNotification('one');x.putNotification('two');x.putNotification('three');
  const page=x.service.list(x.actor('alice'),{limit:1});
  x.putNotification('new-top','alice-app-a',{createdAt:'2030-09-08T10:00:00Z'});
  const next=x.service.list(x.actor('alice'),{limit:2,cursor:page.nextCursor});
  assert.equal(next.notifications.some(n=>n.id===page.notifications[0].id),false);
  x.repo.put('accounts',{...x.repo.get('accounts','alice'),permissionVersion:2});
  fail(()=>x.service.list(x.actor('alice'),{cursor:page.nextCursor}),'CURSOR_EXPIRED');
  const latest=x.service.list(x.actor('alice'),{limit:1});x.service.now=()=>x.now()+86400001;
  fail(()=>x.service.list(x.actor('alice'),{cursor:latest.nextCursor}),'CURSOR_EXPIRED');
});
