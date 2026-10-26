import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, gate, png, response } from './support/v2-platform-config/fixture.mjs';
const error = code => e => e.errorCode === code;
async function setup(t, options) { const f = await fixture(options); t.after(() => f.close()); return f; }

test('real mini session is revoked by existing root callback; replay does not revoke a newly issued session', async t => {
  const f = await setup(t), session = await f.login();
  await f.save({ minClientVersion: 2 }, { expectedRevision: 1, operationId: 'mini-config-update' });
  assert.throws(() => f.host.mini.authenticate(session), error('MINI_SESSION_INVALID'));
  const fresh = await f.login();
  await f.save({ minClientVersion: 2 }, { expectedRevision: 1, operationId: 'mini-config-update' });
  assert.equal(f.host.mini.authenticate(fresh).actor.id, 'member');
  await f.secrets(); assert.throws(() => f.host.mini.authenticate(fresh), error('MINI_SESSION_INVALID'));
});

test('canonical revision alone fences mini exchange when configuration or credentials change in flight', async t => {
  for (const kind of ['save', 'secrets']) {
    const entered = gate(), released = gate(); let seen;
    const f = await setup(t, { miniExchange: async args => { seen = args; entered.resolve(); await released.promise; return { verified: true, appId: args.appId, openid: 'openid-member' }; } });
    const attempt = f.login(), rejected = assert.rejects(attempt, error('MINI_CONFIG_CHANGED'));
    await entered.promise;
    // Deliberately isolate the readConfig fence from the root's separate
    // post-commit session invalidator, which is covered by the preceding test.
    if (kind === 'save') await f.save({ minClientVersion: 2 }, { invalidate: false }); else await f.secrets('constructed-rotation', { invalidate: false });
    released.resolve(); await rejected; assert.ok(seen.signal);
    assert.equal(f.db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='mini-session'").get().n, 0);
  }
});

test('real inbox exposes unavailable missing templates and rejects stale observed configuration versions', async t => {
  const f = await setup(t), actor = f.actor('member'), first = f.inbox.settings(actor);
  assert.deepEqual(first.availableTemplateIds, []); assert.equal(first.templates.wipeOpen, '');
  await assert.rejects(() => f.inbox.saveSettings(actor, { expectedRevision: first.revision, expectedConfigRevision: first.configRevision,
    subscriptions: { wipeOpen: 'accept' } }, { operationId: 'missing-template-save' }), error('INBOX_TEMPLATE_UNAVAILABLE'));
  await f.save({ subscriptionTemplates: { wipeOpen: 'explicit-template-open' } });
  await assert.rejects(() => f.inbox.saveSettings(actor, { expectedRevision: first.revision, expectedConfigRevision: first.configRevision,
    subscriptions: { wipeOpen: 'accept' } }, { operationId: 'stale-template-save' }), error('INBOX_CONFIG_CHANGED'));
  const current = f.inbox.settings(actor);
  const result = await f.inbox.saveSettings(actor, { expectedRevision: current.revision, expectedConfigRevision: current.configRevision,
    subscriptions: { wipeOpen: 'accept' } }, { operationId: 'configured-template-save' });
  assert.equal(result.current.subscriptions.wipeOpen.templateId, 'explicit-template-open');
  assert.equal(result.current.subscriptions.wipeOpen.platformVerified, false);
  await f.secrets(); assert.notEqual(f.inbox.settings(actor).configRevision, result.current.configRevision);
});

test('inbox write queued behind real config save rechecks expectedConfigRevision before canonical changes', async t => {
  const f = await setup(t); await f.save({ subscriptionTemplates: { wipeOpen: 'old-template' } });
  const actor = f.actor('member'), observed = f.inbox.settings(actor), entered = gate(), released = gate();
  const blocker = f.runStoreWriteTask(async () => { entered.resolve(); await released.promise; }); await entered.promise;
  const configWrite = f.save({ subscriptionTemplates: { wipeOpen: 'new-template' } });
  const pending = f.inbox.saveSettings(actor, { expectedRevision: observed.revision, expectedConfigRevision: observed.configRevision,
    subscriptions: { wipeOpen: 'accept' } }, { operationId: 'queued-inbox-config' });
  const rejected = assert.rejects(pending, error('INBOX_CONFIG_CHANGED')); released.resolve();
  await blocker; await configWrite; await rejected;
  assert.equal(f.db.prepare('SELECT count(*) n FROM v2_member_inbox_receipts').get().n, 0);
});

test('media uses durable generation for access token and cached bytes; disable/changeback and secrets cannot reuse cached image', async t => {
  const f = await setup(t), session = await f.login();
  const first = await f.media.shareCode(f.mediaArgs(session)); assert.deepEqual(first.bytes, png); assert.equal(first.cached, false);
  assert.equal((await f.media.shareCode(f.mediaArgs(session))).cached, true); assert.equal(f.state.images.length, 1);
  await f.save({ enabled: false }); await f.save({ enabled: true });
  let fresh = await f.login(); assert.equal((await f.media.shareCode(f.mediaArgs(fresh))).cached, false);
  assert.deepEqual(f.state.tokens.map(c => c.generation), [1, 3]);
  await f.secrets(); fresh = await f.login(); assert.equal((await f.media.shareCode(f.mediaArgs(fresh))).cached, false);
  assert.deepEqual(f.state.tokens.map(c => c.generation), [1, 3, 4]); assert.equal(f.state.images.length, 3);
  await f.media.stop(); assert.equal(f.media.diagnostics().cacheEntries, 0); assert.equal(f.db.prepare('SELECT 1 n').get().n, 1);
});

test('media in-flight response after credential rotation is disposed and never cached', async t => {
  const entered = gate(), released = gate(); let disposed = false;
  const f = await setup(t, { mediaExchange: async () => { entered.resolve(); await released.promise; return { ...response(), dispose: async () => { disposed = true; } }; } });
  const session = await f.login(), attempt = f.media.shareCode(f.mediaArgs(session)), rejected = assert.rejects(attempt, error('MEDIA_CONFIG_CHANGED'));
  await entered.promise; await f.secrets('constructed-rotation', { invalidate: false }); released.resolve(); await rejected;
  assert.equal(disposed, true); assert.equal(f.media.diagnostics().cacheEntries, 0); assert.equal(f.media.diagnostics().active, 0);
});

test('media rejects access token for a different durable generation', async t => {
  const f = await setup(t, { getAccessToken: async ({ appId, generation }) => ({ appId, generation: generation - 1, accessToken: 'isolated-obsolete-token' }) });
  const session = await f.login(); await assert.rejects(() => f.media.shareCode(f.mediaArgs(session)), error('MEDIA_TOKEN_INVALID'));
  assert.equal(f.state.images.length, 0);
});

test('appId change refuses every existing app-scoped owner instead of silently following another app', async t => {
  const f = await setup(t), session = await f.login();
  const mediaArgs = f.mediaArgs(session), actor = f.actor('member');
  await f.save({ appId: 'other_app' }, { invalidate: false });
  assert.throws(() => f.host.mini.authenticate(session), error('PLATFORM_CONFIG_APP_MISMATCH'));
  assert.throws(() => f.inbox.settings(actor), error('PLATFORM_CONFIG_APP_MISMATCH'));
  await assert.rejects(() => f.media.shareCode(mediaArgs), error('PLATFORM_CONFIG_APP_MISMATCH'));
  assert.equal(f.state.images.length, 0);
});
