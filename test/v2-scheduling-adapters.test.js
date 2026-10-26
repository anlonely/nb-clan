import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createWebAdapter, createPlatformAdapter } from '../server/v2/scheduling/adapters.js';
import { hash } from '../server/v2/scheduling/service.js';
import { IdentityError, requireValue } from '../server/v2/identity/errors.js';
import { IdentityRepository, installIdentitySchema } from '../server/v2/identity/repository.js';
import { IdentityService } from '../server/v2/identity/service.js';
import { applyIdentityMigration, planIdentityMigration } from '../server/v2/identity/migration.js';
import { CAPABILITIES, grant } from '../server/v2/identity/permissions.js';
import { SchedulingRepository, installSchedulingSchema } from '../server/v2/scheduling/repository.js';
import { SchedulingService } from '../server/v2/scheduling/service.js';
import { parseMemberLocation } from '../src/v2/router.js';
import { safeAuthReturnTo } from '../src/v2/auth-flow.js';

function assertMemberConfirmationRoute(url, wipeId) {
  const login = parseMemberLocation(`/login?returnTo=${encodeURIComponent(url)}`);
  const returned = safeAuthReturnTo(login.searchParams.get('returnTo'));
  const route = parseMemberLocation(returned);
  assert.equal(returned, url);
  assert.equal(route.wipeId, wipeId);
  assert.equal(route.searchParams.get('tab'), 'plan');
  assert.equal(route.hash, '#signup');
}

// A controlled signer/session replacement: no platform SDK, credentials, HTTP,
// cookies, real member data, or outbound sends participate in these tests.
function fixture() {
  const calls = [], accounts = new Map(), mappings = new Map(), contexts = new Map(), slots = new Map(), receipts = new Map();
  const state = { now: Date.parse('2026-09-10T06:00:00.000Z'), eligible: true, closed: false, afterCheck: null, failAfterCommit: false };
  const wipe = { id: 'wipe-one', contentRevision: 1, timeZone: 'Asia/Shanghai', musterAt: '2026-09-10T08:00:00.000Z' };
  const providers = ['discord', 'kook', 'wechat:test-app'];
  const a = { id: 'account-one', memberId: 'member-one', memberStatus: 'active', status: 'active', permissionVersion: 1 };
  const b = { id: 'account-two', memberId: 'member-two', memberStatus: 'active', status: 'active', permissionVersion: 1 };
  const admin = { id: 'admin', memberId: null, memberStatus: null, status: 'active', permissionVersion: 1, canDelegate: true };
  for (const actor of [a, b, admin]) {
    accounts.set(actor.id, actor);
    for (const provider of providers) mappings.set(`${provider}/${actor.id}`, { accountId: actor.id });
  }
  const identity = {
    identity(provider, externalId) { calls.push('identity'); return mappings.get(`${provider}/${externalId}`); },
    actorForAccount(accountId) {
      calls.push('actor');
      const actor = accounts.get(accountId);
      requireValue(actor?.status === 'active', 'ACCOUNT_DISABLED', 403);
      requireValue(actor.memberStatus !== 'left' && actor.memberStatus !== 'blocked', 'ACCESS_RESTRICTED', 403);
      return structuredClone(actor);
    },
    async checkEligibility() {
      calls.push('eligibility');
      requireValue(state.eligible, 'ELIGIBILITY_DENIED', 403);
      if (state.afterCheck) state.afterCheck();
    },
    assertMemberParticipation(actor) {
      calls.push('participation');
      requireValue(actor.memberId && actor.memberStatus === 'active', 'MEMBERSHIP_INACTIVE', 403);
    }
  };
  // The double implements only enough revision/receipt behavior to observe the
  // adapter protocol. Domain/SQL rules are covered by the scheduling suite.
  const service = {
    repo: {
      get(name, id) {
        if (name === 'receipts') return [...receipts.entries()].find(([key]) => hash(key.split('/')) === id)?.[1];
        assert.equal(name, 'signupContexts'); return contexts.get(id) && structuredClone(contexts.get(id));
      },
      put(name, value) { assert.equal(name, 'signupContexts'); contexts.set(value.id, structuredClone(value)); return value; }
    },
    getWipe(actor, wipeId) {
      calls.push('getWipe'); requireValue(wipeId === wipe.id, 'RESOURCE_NOT_FOUND', 404); return structuredClone(wipe);
    },
    getSignup(actor, wipeId, memberId) {
      calls.push('getSignup'); requireValue(wipeId === wipe.id, 'RESOURCE_NOT_FOUND', 404);
      return structuredClone(slots.get(`${wipeId}/${memberId}`) || { wipeId, memberId, response: null, signupRevision: 0,
        confirmedContentRevision: null, needsReconfirmation: false });
    },
    getOperation(actor, operationId) {
      calls.push('getOperation'); const receipt = receipts.get(`${actor.id}/${operationId}`);
      requireValue(receipt, 'RESOURCE_NOT_FOUND', 404); return structuredClone(receipt);
    },
    saveSignup(actor, wipeId, memberId, input, options) {
      calls.push({ method: 'saveSignup', actor: structuredClone(actor), wipeId, memberId, input: structuredClone(input), options });
      const fresh = identity.actorForAccount(actor.id);
      if (options.delegate) requireValue(fresh.canDelegate, 'CAPABILITY_DENIED', 403);
      else identity.assertMemberParticipation(fresh);
      requireValue(options.operationId, 'IDEMPOTENCY_KEY_REQUIRED', 422);
      const receiptKey = `${actor.id}/${options.operationId}`;
      const body = JSON.stringify({ wipeId, memberId, input, source: options.source, delegate: options.delegate });
      const previous = receipts.get(receiptKey);
      if (previous) {
        requireValue(previous.body === body, 'IDEMPOTENCY_CONFLICT', 409);
        return { operationReceipt: previous.operationReceipt, current: this.getSignup(actor, wipeId, memberId), replayed: true };
      }
      requireValue(!state.closed, 'SIGNUP_CLOSED', 409);
      const current = this.getSignup(actor, wipeId, memberId);
      requireValue(input.expectedSignupRevision === current.signupRevision, 'REVISION_CONFLICT', 409);
      const result = { ...input, confirmedContentRevision: wipe.contentRevision, wipeId, memberId, signupRevision: current.signupRevision + 1, actorAccountId: actor.id };
      slots.set(`${wipeId}/${memberId}`, result);
      const operationReceipt = { operationId: options.operationId, signupRevision: result.signupRevision,
        confirmedContentRevision: result.confirmedContentRevision, committedAt: new Date(state.now).toISOString(), result: 'saved' };
      receipts.set(receiptKey, { body, operationReceipt, digest: hash({ action: 'signup.self', wipeId, memberId, input }) });
      if (state.failAfterCommit) { state.failAfterCommit = false; throw new Error('controlled response lost after commit'); }
      return { operationReceipt, current: structuredClone(result), replayed: false };
    }
  };
  const secret = 'controlled-local-fixture-secret';
  function sign(provider, payload, { externalId = a.id, interactionId = 'click-1' } = {}) {
    const rawBody = JSON.stringify({ provider, externalId, interactionId, payload });
    return { rawBody, signature: createHmac('sha256', secret).update(rawBody).digest('hex') };
  }
  async function verify(envelope) {
    calls.push('verify');
    const expected = createHmac('sha256', secret).update(envelope.rawBody || '').digest();
    const received = Buffer.from(envelope.signature || '', 'hex');
    requireValue(received.length === expected.length && timingSafeEqual(expected, received), 'PLATFORM_SIGNATURE_INVALID', 401);
    return JSON.parse(envelope.rawBody);
  }
  const adapter = provider => createPlatformAdapter({ provider, identity, service, verify, now: () => state.now });
  const publicCard = (extra = {}) => ({ kind: 'public', adapterVersion: 2, wipeId: wipe.id, contentRevision: wipe.contentRevision,
    action: 'attending_on_time', timeZone: 'Asia/Shanghai', ...extra });
  return { calls, accounts, mappings, contexts, slots, receipts, state, wipe, a, b, admin, identity, service, sign, verify, adapter, publicCard };
}

test('Web reads use G03 read authentication; writes use mutation authentication and its returned actor', async () => {
  const f = fixture(), authCalls = [];
  const req = { body: { response: 'not_attending', expectedSignupRevision: 0, confirmedContentRevision: 1, timeZone: 'UTC', expectedArrivalAt: null },
    actor: f.admin, get: name => name === 'Idempotency-Key' ? 'web-operation' : undefined,
    v2Identity: { async authenticate(options) { authCalls.push(options); return { actor: f.a }; } } };
  const web = createWebAdapter(f.service);
  await web.getWipe(req, f.wipe.id); await web.getSignup(req, f.wipe.id);
  const result = await web.saveSignup(req, f.wipe.id);
  assert.deepEqual(authCalls, [undefined, undefined, { mutation: true }]);
  assert.equal(result.current.actorAccountId, f.a.id); assert.equal(result.current.memberId, f.a.memberId);
  assert.equal(f.calls.find(c => c.method === 'saveSignup').options.source, 'web');
  req.v2Identity.authenticate = async () => { throw new IdentityError('CSRF_INVALID', 403); };
  await assert.rejects(() => web.saveSignup(req, f.wipe.id), /CSRF_INVALID/);
  assert.equal(f.receipts.size, 1);
});

test('Web and explicit platform delegation preserve a privileged actor without a participant identity', async () => {
  const f = fixture(); const body = { response: 'attending_on_time', expectedArrivalAt: null, timeZone: 'UTC',
    expectedSignupRevision: 0, confirmedContentRevision: 1, reason: '受成员委托' };
  const req = { body, get: () => 'delegate-web', v2Identity: { authenticate: async () => ({ actor: f.admin }) } };
  const first = await createWebAdapter(f.service).saveSignup(req, f.wipe.id, f.b.memberId);
  assert.equal(first.current.actorAccountId, f.admin.id); assert.equal(first.current.memberId, f.b.memberId);
  const next = await f.adapter('discord').submit(f.sign('discord', { kind: 'direct-v2', adapterVersion: 2,
    wipeId: f.wipe.id, memberId: f.b.memberId, input: { ...body, response: null, expectedSignupRevision: 1 } },
  { externalId: f.admin.id }));
  assert.equal(next.current.response, null); assert.equal(next.current.signupRevision, 2);
  assert.equal(f.calls.filter(c => c === 'participation').length, 0);
  await assert.rejects(() => f.adapter('discord').submit(f.sign('discord', f.publicCard(), { externalId: f.admin.id,
    interactionId: 'public-admin' })), /MEMBERSHIP_INACTIVE/);
});

test('a signature failure or tampered callback cannot reach identity mapping', async () => {
  const f = fixture(), adapter = f.adapter('discord');
  const envelope = f.sign('discord', f.publicCard()); envelope.rawBody = envelope.rawBody.replace('wipe-one', 'wipe-other');
  await assert.rejects(() => adapter.submit(envelope), /PLATFORM_SIGNATURE_INVALID/);
  assert.deepEqual(f.calls, ['verify']); assert.equal(f.receipts.size, 0);
  assert.throws(() => createPlatformAdapter({ provider: 'discord', identity: f.identity, service: f.service }), /PLATFORM_VERIFIER_REQUIRED/);
});

test('the authenticated provider namespace is exact and WeChat never guesses appId', async () => {
  const f = fixture();
  assert.throws(() => f.adapter('wechat'), /PLATFORM_PROVIDER_INVALID/);
  await assert.rejects(() => f.adapter('wechat:other-app').submit(f.sign('wechat:test-app', f.publicCard())), /PLATFORM_AUTH_INVALID/);
  assert.equal(f.calls.includes('identity'), false);
  const result = await f.adapter('wechat:test-app').submit(f.sign('wechat:test-app', f.publicCard()));
  assert.equal(result.current.memberId, f.a.memberId); assert.equal(f.calls.includes('eligibility'), false);
  assert.equal(f.calls.find(c => c.method === 'saveSignup').options.source, 'wechat');
});

test('Discord and KOOK recheck eligibility and account mapping after platform I/O', async () => {
  for (const provider of ['discord', 'kook']) {
    const f = fixture(); f.state.eligible = false;
    await assert.rejects(() => f.adapter(provider).submit(f.sign(provider, f.publicCard())), /ELIGIBILITY_DENIED/);
    assert.deepEqual(f.calls, ['verify', 'identity', 'actor', 'eligibility']);
    f.state.eligible = true;
    f.state.afterCheck = () => f.mappings.set(`${provider}/${f.a.id}`, { accountId: f.b.id });
    await assert.rejects(() => f.adapter(provider).submit(f.sign(provider, f.publicCard())), /IDENTITY_CONFLICT/);
    assert.equal(f.receipts.size, 0);
  }
});

test('current member suspension, departure, blocking, and account revocation cannot be bypassed by a signed interaction', async () => {
  for (const memberStatus of ['suspended', 'left', 'blocked']) {
    const f = fixture(); f.a.memberStatus = memberStatus;
    await assert.rejects(() => f.adapter('discord').submit(f.sign('discord', f.publicCard())),
      memberStatus === 'suspended' ? /MEMBERSHIP_INACTIVE/ : /ACCESS_RESTRICTED/);
    assert.equal(f.receipts.size, 0);
  }
  const f = fixture(); f.state.afterCheck = () => { f.a.status = 'disabled'; };
  await assert.rejects(() => f.adapter('discord').submit(f.sign('discord', f.publicCard())), /ACCOUNT_DISABLED/);
  assert.equal(f.receipts.size, 0);
});

test('KOOK changes an existing reply directly while other platforms retain confirmation', async () => {
  const f = fixture();
  const first = await f.adapter('discord').submit(f.sign('discord', f.publicCard({ expectedSignupRevision: 99, memberId: f.b.memberId })));
  assert.equal(first.current.signupRevision, 1); assert.equal(first.current.memberId, f.a.memberId);
  const kook = await f.adapter('kook').submit(f.sign('kook', f.publicCard({ action: 'not_attending' })));
  assert.equal(kook.current.response, 'not_attending'); assert.equal(kook.current.signupRevision, 2);
  const other = await f.adapter('wechat:test-app').submit(f.sign('wechat:test-app', f.publicCard({ action: 'attending_on_time' })));
  assert.equal(other.status, 'confirmation_required'); assertMemberConfirmationRoute(other.confirmationUrl, f.wipe.id);
  assert.equal(f.receipts.size, 2); assert.equal(f.slots.size, 1);
});

test('Discord 8h and 16h public buttons save the corresponding absolute arrival time', async () => {
  for (const [action, expectedArrivalAt] of [
    ['join_8h', '2026-09-10T16:00:00.000Z'],
    ['join_16h', '2026-09-11T00:00:00.000Z'],
  ]) {
    const f = fixture();
    const result = await f.adapter('discord').submit(f.sign('discord', f.publicCard({ action })));
    assert.equal(result.current.response, 'attending_later');
    assert.equal(result.current.expectedArrivalAt, expectedArrivalAt);
    assert.equal(f.receipts.size, 1);
  }
});

test('KOOK changes an existing reply directly after the schedule changes', async () => {
  const f = fixture();
  await f.adapter('kook').submit(f.sign('kook', f.publicCard()));
  f.wipe.contentRevision = 2;
  const changed = await f.adapter('kook').submit(f.sign('kook', f.publicCard({ action: 'not_attending', contentRevision: 1 }),
    { interactionId: 'after-schedule-change' }));
  assert.equal(changed.current.response, 'not_attending');
  assert.equal(changed.current.confirmedContentRevision, 2);
  assert.equal(f.contexts.size, 0);
});

test('KOOK direct reply and public retry preserve durable receipts', async () => {
  const f = fixture(); const discord = f.adapter('discord');
  const firstEnvelope = f.sign('discord', f.publicCard());
  const outcomes = await Promise.all([
    discord.submit(firstEnvelope), f.adapter('kook').submit(f.sign('kook', f.publicCard({ action: 'not_attending' })))
  ]);
  assert.equal(outcomes.filter(result => result.operationReceipt).length, 2);
  assert.equal(outcomes.filter(result => result.status === 'confirmation_required').length, 0);
  f.slots.get(`${f.wipe.id}/${f.a.memberId}`).signupRevision = 8;
  f.slots.get(`${f.wipe.id}/${f.a.memberId}`).response = 'not_attending';
  f.wipe.contentRevision = 5; f.state.closed = true;
  const replay = await f.adapter('discord').submit(firstEnvelope);
  assert.equal(replay.replayed, true); assert.equal(replay.operationReceipt.signupRevision, 1);
  assert.equal(replay.current.signupRevision, 8); assert.equal(replay.current.response, 'not_attending');
  assert.equal(f.receipts.size, 2);
  f.a.status = 'disabled';
  await assert.rejects(() => discord.submit(firstEnvelope), /ACCOUNT_DISABLED/);
});

test('the same interaction ID with different signed content is a conflict, never a confirmation', async () => {
  const f = fixture(), adapter = f.adapter('discord');
  await adapter.submit(f.sign('discord', f.publicCard()));
  await assert.rejects(() => adapter.submit(f.sign('discord', f.publicCard({ action: 'not_attending' }))), /IDEMPOTENCY_CONFLICT/);
  assert.equal(f.contexts.size, 0); assert.equal(f.receipts.size, 1);
});

test('an old card keeps its action after the schedule changes', async () => {
  const f = fixture(), adapter = f.adapter('discord'); f.wipe.contentRevision = 2;
  const result = await adapter.submit(f.sign('discord', f.publicCard({ contentRevision: 1 })));
  assert.equal(result.current.response, 'attending_on_time');
  assert.equal(result.current.confirmedContentRevision, 2);
  assert.equal(f.contexts.size, 0); assert.equal(f.receipts.size, 1);
});

test('withdrawal tombstones force a confirmation; intervening writes cannot be hidden by reading the latest version', async () => {
  const f = fixture(); f.slots.set(`${f.wipe.id}/${f.a.memberId}`, { wipeId: f.wipe.id, memberId: f.a.memberId,
    response: null, signupRevision: 4, confirmedContentRevision: 1 });
  const adapter = f.adapter('discord'), preview = await adapter.submit(f.sign('discord', f.publicCard()));
  assert.equal(preview.confirmation.proposedInput.expectedSignupRevision, 4);
  f.slots.get(`${f.wipe.id}/${f.a.memberId}`).signupRevision = 6;
  await assert.rejects(() => adapter.submit(f.sign('discord', { kind: 'confirm', contextToken: preview.confirmation.contextToken },
    { interactionId: 'confirm-after-concurrent-write' })), /REVISION_CONFLICT/);
  assert.equal(f.slots.get(`${f.wipe.id}/${f.a.memberId}`).response, null);
});

test('confirmation contexts bind actor, member, provider, action, wipe, both revisions and reject edited commands', async () => {
  const f = fixture(), adapter = f.adapter('discord'); f.wipe.contentRevision = 2;
  const preview = await adapter.submit(f.sign('discord', f.publicCard({ contentRevision: 1, action: 'withdraw' })));
  const payload = { kind: 'confirm', contextToken: preview.confirmation.contextToken };
  const context = [...f.contexts.values()][0];
  assert.equal(context.actorAccountId, f.a.id); assert.equal(context.memberId, f.a.memberId); assert.equal(context.wipeId, f.wipe.id);
  assert.equal(context.input.expectedSignupRevision, 0); assert.equal(context.input.confirmedContentRevision, 2);
  assert.equal(context.action, 'withdraw');
  assert.equal(JSON.stringify([...f.contexts.values()]).includes(payload.contextToken), false);
  await assert.rejects(() => adapter.submit(f.sign('discord', payload, { externalId: f.b.id })), /SIGNUP_CONFIRMATION_INVALID/);
  await assert.rejects(() => f.adapter('kook').submit(f.sign('kook', payload)), /SIGNUP_CONFIRMATION_INVALID/);
  await assert.rejects(() => adapter.submit(f.sign('discord', { ...payload, input: { response: 'not_attending', expectedSignupRevision: 99 } })),
    /SIGNUP_CONFIRMATION_INVALID/);
  f.a.memberId = 'member-rebound';
  await assert.rejects(() => adapter.submit(f.sign('discord', payload)), /SIGNUP_CONFIRMATION_INVALID/);
  assert.equal(f.receipts.size, 0);
});

test('expired unused confirmations cannot write; a committed response lost before delivery replays after expiration and adapter restart', async () => {
  const f = fixture(), adapter = f.adapter('discord'); f.wipe.contentRevision = 2;
  const preview = await adapter.submit(f.sign('discord', f.publicCard({ contentRevision: 1, action: 'withdraw' })));
  const payload = { kind: 'confirm', contextToken: preview.confirmation.contextToken };
  const request = f.sign('discord', payload, { interactionId: 'durable-confirm' });
  f.state.failAfterCommit = true;
  await assert.rejects(() => adapter.submit(request), /response lost/);
  f.state.now += 300_000; f.state.closed = true;
  const replay = await f.adapter('discord').submit(request);
  assert.equal(replay.replayed, true); assert.equal(replay.current.signupRevision, 1);
  await assert.rejects(() => f.adapter('discord').submit(f.sign('discord', payload, { interactionId: 'new-expired-confirm' })),
    /SIGNUP_CONFIRMATION_EXPIRED/);
  assert.equal(f.receipts.size, 1);
  f.state.eligible = false;
  await assert.rejects(() => f.adapter('discord').submit(request), /ELIGIBILITY_DENIED/);
});

test('a late-arrival confirmation accepts an explicit absolute time, keeps shown revisions and action', async () => {
  const f = fixture(), adapter = f.adapter('discord');
  const preview = await adapter.submit(f.sign('discord', f.publicCard({ action: 'attending_later' })));
  assert.equal(preview.confirmation.needsArrivalInput, true); assert.equal(f.receipts.size, 0);
  const result = await adapter.submit(f.sign('discord', { kind: 'confirm', contextToken: preview.confirmation.contextToken,
    input: { expectedArrivalAt: '2026-09-10T09:00:00.000Z', timeZone: 'Asia/Shanghai' } }, { interactionId: 'late-confirm' }));
  assert.equal(result.current.response, 'attending_later'); assert.equal(result.current.expectedArrivalAt, '2026-09-10T09:00:00.000Z');
  assert.equal(result.current.confirmedContentRevision, 1);
});

test('legacy cards preserve the explicit original wipe, require confirmation and never infer late absolute time', async () => {
  const f = fixture(), adapter = f.adapter('kook');
  for (const legacyStatus of ['join', 'join_8h', 'join_16h', 'late']) {
    const result = await adapter.submit(f.sign('kook', { kind: 'legacy', adapterVersion: 1, wipeId: f.wipe.id,
      legacyStatus, expectedArrivalAt: '2099-01-01T00:00:00.000Z' }, { interactionId: legacyStatus }));
    assert.equal(result.status, 'confirmation_required'); assert.equal(result.confirmation.wipe.id, f.wipe.id);
    assert.equal(result.confirmation.proposedInput.expectedArrivalAt, null);
    assert.equal(result.confirmation.legacyRawStatus, legacyStatus);
    assert.equal(result.confirmation.needsArrivalInput, legacyStatus !== 'join');
  }
  const unsupported = await adapter.submit(f.sign('kook', { kind: 'legacy', wipeId: f.wipe.id, legacyStatus: 'skip' }));
  assert.equal(unsupported.reasonCode, 'LEGACY_ACTION_UNSUPPORTED');
  const supported = await adapter.submit(f.sign('kook', { kind: 'legacy', wipeId: f.wipe.id, legacyStatus: 'skip', skipMeansNotAttending: true }));
  assert.equal(supported.confirmation.proposedInput.response, 'not_attending');
  await assert.rejects(() => adapter.submit(f.sign('kook', { kind: 'legacy', legacyStatus: 'join' })), /WIPE_REQUIRED/);
  await assert.rejects(() => adapter.submit(f.sign('kook', { kind: 'legacy', wipeId: 'missing', legacyStatus: 'join' })), /RESOURCE_NOT_FOUND/);
  assert.equal(f.receipts.size, 0);
});

test('legacy same-option toggle is an explicit confirmed withdrawal; different late options are not conflated', async () => {
  const f = fixture(), adapter = f.adapter('kook');
  f.slots.set(`${f.wipe.id}/${f.a.memberId}`, { wipeId: f.wipe.id, memberId: f.a.memberId, response: 'attending_later',
    signupRevision: 3, confirmedContentRevision: 1, legacyRawStatus: 'join_8h' });
  const legacy = { kind: 'legacy', wipeId: f.wipe.id, legacyStatus: 'join_8h', legacyToggle: true };
  const first = await adapter.submit(f.sign('kook', legacy));
  assert.equal(first.confirmation.action, 'withdraw'); assert.equal(first.confirmation.proposedInput.response, null);
  const next = await adapter.submit(f.sign('kook', { ...legacy, legacyStatus: 'join_16h' }, { interactionId: 'other-late-option' }));
  assert.equal(next.confirmation.action, 'attending_later'); assert.equal(next.confirmation.needsArrivalInput, true);
  assert.equal(f.receipts.size, 0);
});

test('unsupported mini-program versions and versionless new cards return an explicit original-wipe confirmation entry', async () => {
  const f = fixture(), adapter = f.adapter('wechat:test-app');
  for (const payload of [
    { kind: 'direct-v2', adapterVersion: 1, wipeId: f.wipe.id, input: {} },
    f.publicCard({ contentRevision: undefined })
  ]) {
    await assert.rejects(() => adapter.submit(f.sign('wechat:test-app', payload)), error => {
      assert.ok(['ADAPTER_VERSION_UNSUPPORTED', 'CONTENT_REVISION_REQUIRED'].includes(error.errorCode));
      assertMemberConfirmationRoute(error.confirmationUrl, f.wipe.id); return true;
    });
  }
  assert.equal(f.receipts.size, 0);
});

async function sqliteFixture(t) {
  const directory = mkdtempSync(join(process.cwd(), '.tmp-v2-adapters-'));
  const databasePath = join(directory, 'controlled.sqlite');
  let db = new DatabaseSync(databasePath);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  installIdentitySchema(db); installSchedulingSchema(db);
  const state = { now: Date.parse('2026-09-10T06:00:00.000Z'), roles: ['member-role'], calls: 0 };
  const providers = Object.fromEntries(['discord', 'kook'].map(provider => [provider, { async roles(externalId, guildId) {
    state.calls++; return { externalId, guildId, roleIds: state.roles };
  } }]));
  let identity = new IdentityService(new IdentityRepository(db), { providers, now: () => state.now });
  applyIdentityMigration(identity.repo, planIdentityMigration({}));
  identity.repo.setScalar('v2SchedulingMigration', { version: 1, fixture: true });
  identity.repo.setScalar('v2RosterRevision', 1);
  for (const policy of identity.repo.all('policies')) identity.repo.put('policies', { ...policy,
    enabled: true, guildId: 'controlled-guild', allowedRoleIds: ['member-role'] });
  const profile = { provider: 'discord', id: 'external-one', displayName: '本地受控成员' };
  const evidence = await identity.checkEligibility(profile.provider, profile.id);
  const bound = identity.bind(profile, '76561198000000001', evidence, identity.login(profile, evidence));
  const actor = identity.session(bound.token).actor;
  for (const provider of ['kook', 'wechat:test-app']) identity.repo.put('identities', {
    id: `fixture-${provider}`, provider, externalId: profile.id, accountId: actor.id, revision: 1
  });
  identity.repo.put('accounts', { id: 'operator', memberId: null, status: 'active', roleId: 'admin',
    permissionVersion: 1, revision: 1, adminAssignedByOwner: true, grants: CAPABILITIES.map(cap => grant(cap, { type: 'all' })) });
  let service = new SchedulingService(new SchedulingRepository(db), identity, { now: () => state.now });
  const operator = identity.actorForAccount('operator');
  let wipe = service.createWipe(operator, { title: '本地跨端验证档期', serverProfileId: 'controlled-server',
    serverSnapshot: { name: '受控替身' }, timeZone: 'Asia/Shanghai', audience: { squadIds: [], memberIds: [actor.memberId], includeUnassigned: false },
    musterAt: '2026-09-10T08:00:00.000Z', signupOpensAt: '2026-09-10T05:00:00.000Z',
    signupClosesAt: '2026-09-10T09:00:00.000Z' }, { operationId: 'fixture-create' }).current;
  wipe = service.transition(operator, wipe.id, 'publish', { expectedRevision: wipe.revision }, { operationId: 'fixture-publish' }).current;
  const signed = fixture();
  const sign = (provider, payload, interactionId) => signed.sign(provider, payload, { externalId: profile.id, interactionId });
  return {
    state, actor, operator, wipe, token: bound.token,
    get identity() { return identity; }, get service() { return service; },
    adapter(provider) { return createPlatformAdapter({ provider, identity, service, verify: signed.verify, now: () => state.now }); }, sign,
    publicCard(extra = {}) { return { kind: 'public', adapterVersion: 2, wipeId: wipe.id, contentRevision: 1,
      action: 'attending_on_time', timeZone: 'Asia/Shanghai', ...extra }; },
    request(input, operationId) { return { body: input, get: name => name === 'Idempotency-Key' ? operationId : null,
      v2Identity: { authenticate: async () => identity.session(bound.token) } }; },
    restart() {
      db.close(); db = new DatabaseSync(databasePath);
      identity = new IdentityService(new IdentityRepository(db), { providers, now: () => state.now });
      service = new SchedulingService(new SchedulingRepository(db), identity, { now: () => state.now });
    }
  };
}

test('real SQLite and G03 identity: Web, Discord, KOOK and WeChat write one slot, one audit and outbox per committed change', async t => {
  const f = await sqliteFixture(t);
  const first = await f.adapter('discord').submit(f.sign('discord', f.publicCard(), 'first'));
  assert.equal(first.current.signupRevision, 1);
  const input = { response: 'not_attending', expectedArrivalAt: null, timeZone: 'Asia/Shanghai',
    expectedSignupRevision: 1, confirmedContentRevision: 1 };
  const second = await createWebAdapter(f.service).saveSignup(f.request(input, 'web-second'), f.wipe.id);
  assert.equal(second.current.signupRevision, 2);
  const third = await f.adapter('kook').submit(f.sign('kook', f.publicCard(), 'kook-public'));
  assert.equal(third.current.signupRevision, 3);
  const fourth = await f.adapter('wechat:test-app').submit(f.sign('wechat:test-app', { kind: 'direct-v2', adapterVersion: 2,
    wipeId: f.wipe.id, input: { ...input, response: null, expectedSignupRevision: 3 } }, 'wechat-withdraw'));
  assert.equal(fourth.current.signupRevision, 4); assert.equal(fourth.current.response, null);
  assert.equal(f.service.repo.all('signups').length, 1);
  const events = f.service.repo.all('events').filter(e => e.type === 'signup.changed');
  assert.equal(events.length, 4); assert.deepEqual(events.map(e => e.source).sort(), ['discord', 'kook', 'web', 'wechat']);
  assert.ok(events.every(e => e.memberId === f.actor.memberId && e.actorAccountId === f.actor.id));
  assert.equal(f.service.repo.all('outbox').filter(e => e.type === 'signup.changed').length, 4);
  assert.equal(f.service.repo.all('receipts').filter(e => e.memberId === f.actor.memberId).length, 4);
});

test('real SQLite: a Web and platform race shares revision checks, and old successful public retries survive later updates and closure', async t => {
  const f = await sqliteFixture(t);
  const envelope = f.sign('discord', f.publicCard(), 'first-success');
  await f.adapter('discord').submit(envelope);
  const input = { response: 'not_attending', expectedArrivalAt: null, timeZone: 'UTC', expectedSignupRevision: 1, confirmedContentRevision: 1 };
  const results = await Promise.allSettled([
    createWebAdapter(f.service).saveSignup(f.request(input, 'web-race'), f.wipe.id),
    f.adapter('kook').submit(f.sign('kook', { kind: 'direct-v2', adapterVersion: 2, wipeId: f.wipe.id,
      input: { ...input, response: null } }, 'kook-race'))
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.errorCode, 'REVISION_CONFLICT');
  f.state.now = Date.parse(f.wipe.signupClosesAt);
  f.restart();
  const replay = await f.adapter('discord').submit(envelope);
  assert.equal(replay.replayed, true); assert.equal(replay.operationReceipt.signupRevision, 1); assert.equal(replay.current.signupRevision, 2);
  assert.equal(f.service.repo.all('signups').length, 1);
  assert.equal(f.service.repo.all('events').filter(e => e.type === 'signup.changed').length, 2);
});

test('real SQLite: committed private confirmation and identity remain verifiable after database reopen; fresh eligibility still gates replay', async t => {
  const f = await sqliteFixture(t);
  const updated = f.service.updateWipe(f.operator, f.wipe.id, { expectedRevision: f.wipe.revision,
    musterAt: '2026-09-10T08:30:00.000Z' }, { operationId: 'reschedule' }).current;
  assert.equal(updated.contentRevision, 2);
  const preview = await f.adapter('kook').submit(f.sign('kook', f.publicCard({ action: 'withdraw' }), 'old-card'));
  const envelope = f.sign('kook', { kind: 'confirm', contextToken: preview.confirmation.contextToken }, 'confirmed');
  const result = await f.adapter('kook').submit(envelope);
  assert.equal(result.current.confirmedContentRevision, 2);
  f.state.now = Date.parse(f.wipe.signupClosesAt); f.restart();
  const replay = await f.adapter('kook').submit(envelope);
  assert.equal(replay.replayed, true); assert.equal(replay.operationReceipt.signupRevision, 1);
  f.state.roles = [];
  await assert.rejects(() => f.adapter('kook').submit(envelope), /ELIGIBILITY_DENIED/);
  const current = f.service.getSignup(f.identity.actorForAccount(f.actor.id), f.wipe.id, f.actor.memberId);
  assert.equal(current.signupRevision, 1); assert.equal(f.service.repo.all('signups').length, 1);
});
