import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './support/v2-platform-host/fixture.mjs';

const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function setup(t, options = {}) { const f = fixture({ ...options }); t.after(() => f.close()); await f.start(); return f; }
const run = (f, operationId = randomUUID()) => f.host.adapters.forwarding.run({ actor: f.actor('admin'), config: f.platformService.config('bridge'), input: {}, operationId,
  assertCurrent: () => f.actor('admin') });

test('forwarding consumes verified channel source and sends through real G06 native isolated transport', async t => {
  const f = await setup(t);
  f.sourcePages.set('discord:200000000000000001', { verified: true, items: [
    { id: 'isolated-message', channelId: '200000000000000001', content: '隔离源 @everyone', author: '构造作者' },
    { id: 'bot-message', channelId: '200000000000000001', content: '机器人输出', bot: true }
  ], nextCursor: 'isolated-cursor' });
  assert.equal(f.transport.getCalls().length, 0);
  const sent = await run(f);
  assert.equal(sent.counts.succeeded, 1, JSON.stringify(sent)); assert.equal(sent.counts.skipped, 1);
  assert.equal(f.transport.getCalls().length, 1);
  const message = f.transport.getMessages()[0];
  assert.ok(JSON.stringify(message).includes('＠everyone')); assert.ok(!JSON.stringify(message).includes('@everyone'));
  const replay = await run(f); assert.equal(replay.counts.succeeded, 0); assert.equal(f.transport.getCalls().length, 1);
});

test('forwarding rejects source channel forgery, unverified pages and mismatched configured guild', async t => {
  const f = await setup(t);
  f.sourcePages.set('discord:200000000000000001', { verified: true, items: [{ id: 'wrong-source', channelId: 'outside-channel', content: '不可发送' }] });
  await assert.rejects(() => run(f), e => e.errorCode === 'FORWARD_SOURCE_SCOPE');
  f.sourcePages.set('discord:200000000000000001', { verified: false, items: [] });
  await assert.rejects(() => run(f), e => e.errorCode === 'FORWARD_SOURCE_INVALID');
  const config = f.platformService.config('bridge'); config.routes[0].kookGuildId = 'outside-guild';
  await assert.rejects(() => f.host.adapters.forwarding.run({ actor: f.actor('admin'), config, input: {}, operationId: randomUUID(), assertCurrent: () => f.actor('admin') }), e => e.errorCode === 'PLATFORM_TARGET_SCOPE_MISMATCH');
  assert.equal(f.transport.getCalls().length, 0);
});

test('stop aborts forwarding source/reset I/O without closing shared G06 or database', async t => {
  const entered = gate(); let aborted = 0;
  const f = await setup(t, { options: { forwarding: { source: {
    read: ({ signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted++; reject(new Error('isolated source aborted')); }, { once: true }); entered.resolve(); }),
    reset: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('isolated reset aborted')); }, { once: true }))
  } } } });
  const running = run(f), rejected = assert.rejects(running);
  await entered.promise;
  const reset = f.host.adapters.forwarding.reset({ actor: f.actor('admin'), config: f.platformService.config('bridge'), input: { reason: '隔离重置' }, operationId: randomUUID(), assertCurrent: () => f.actor('admin') });
  const resetRejected = assert.rejects(reset);
  await new Promise(resolve => setImmediate(resolve)); await f.host.stop(); await rejected; await resetRejected;
  assert.equal(aborted, 2); assert.equal(f.host.diagnostics().externalCalls, 0);
  assert.equal(f.transport.getCalls().length, 0); assert.equal(f.db.prepare('SELECT 1 n').get().n, 1);
});

function communityIdentity(f) {
  f.ir.put('identities', { id: 'community-member', provider: 'discord', externalId: 'community-openid', accountId: 'member', revision: 1 });
  f.ir.put('policies', { id: 'discord-policy', provider: 'discord', enabled: true, guildId: '100000000000000001', allowedRoleIds: ['isolated-role'], matchMode: 'any', policyRevision: 1 });
  f.identity.providers = { discord: { roles: async (externalId, guildId) => ({ externalId, guildId, roleIds: ['isolated-role'] }) } };
}
const proof = (payload, extra = {}) => ({ provider: 'discord', verified: true, externalId: 'community-openid', interactionId: randomUUID(),
  guildId: '100000000000000001', channelId: '200000000000000001', payload, ...extra });

test('community verifier output is authority; VIP uses real self bridge and actor-private replay', async t => {
  const proofs = new Map();
  const f = await setup(t, { options: { community: { discord: { verify: async envelope => proofs.get(envelope.ticket) } } } });
  communityIdentity(f);
  const verified = proof({ command: 'vip', provider: 'vital', type: '免排队', purchasedAt: '2030-09-08', expectedRevision: 1 }); proofs.set('vip-ticket', verified);
  const result = await f.host.community.discord.handle({ ticket: 'vip-ticket', accountId: 'admin' });
  assert.equal(result.status, 'succeeded'); assert.equal(result.privacy, 'actor_only'); assert.equal(result.actorAccountId, 'member');
  assert.equal(f.ir.get('members', 'm002').vitalVipType, 'queue_skip'); assert.equal(f.ir.get('members', 'm001').vitalVipType, undefined);
  const replay = await f.host.community.discord.handle({ ticket: 'vip-ticket' }); assert.deepEqual(replay, result);
  assert.equal(f.ir.get('members', 'm002').revision, 2); assert.equal(f.transport.getCalls().length, 0);
  proofs.set('wrong-channel', proof({ command: 'map', wipeId: 'host-wipe' }, { channelId: 'outside-channel' }));
  await assert.rejects(() => f.host.community.discord.handle({ ticket: 'wrong-channel' }), e => e.errorCode === 'PLATFORM_CHANNEL_DENIED');
  proofs.set('forged-actor', proof({ command: 'vip', actor: { id: 'admin' } }));
  await assert.rejects(() => f.host.community.discord.handle({ ticket: 'forged-actor' }), e => e.errorCode === 'CLIENT_ACTOR_FORBIDDEN');
});

test('community permission changes during eligibility lookup cannot mutate or replay old receipt', async t => {
  const proofs = new Map(), entered = gate(), finish = gate();
  const f = await setup(t, { options: { community: { discord: { verify: async e => proofs.get(e.ticket) } } } });
  communityIdentity(f);
  proofs.set('racing-vip', proof({ command: 'vip', provider: 'atlas', type: 'priority', expectedRevision: 1 }));
  f.identity.providers.discord.roles = async (externalId, guildId) => { entered.resolve(); await finish.promise; return { externalId, guildId, roleIds: ['isolated-role'] }; };
  const call = f.host.community.discord.handle({ ticket: 'racing-vip' }), rejected = assert.rejects(call, e => e.errorCode === 'PERMISSIONS_CHANGED');
  await entered.promise;
  const account = f.ir.get('accounts', 'member'); f.ir.put('accounts', { ...account, permissionVersion: account.permissionVersion + 1 });
  finish.resolve(); await rejected;
  assert.equal(f.ir.get('members', 'm002').atlasVipType, undefined);
});

test('community has no native verifier by default; G06 signup callbacks stay with their owner', async t => {
  const f = await setup(t);
  await assert.rejects(() => f.host.community.discord.handle({ accountId: 'admin', verified: true }), e => e.errorCode === 'PLATFORM_ADAPTER_UNAVAILABLE');
  assert.equal(f.transport.getCalls().length, 0);
});
