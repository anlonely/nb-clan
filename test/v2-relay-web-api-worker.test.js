import test from 'node:test';
import assert from 'node:assert/strict';
import { createRustgoWebApiWorker, rustgoSourceId } from '../server/v2/relay-admin/web-api-worker.js';

const CLOCK = Date.parse('2026-09-27T10:00:00.000Z');
const at = offset => new Date(CLOCK + offset).toISOString();
const clone = value => structuredClone(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const message = (id = 'message-1', extra = {}) => ({
  id, rustServerId: 'server-1', channel: 'clan', direction: 'inbound', targetVersion: 7,
  message: '北门集合', messageTime: at(-10000), authorSteamId: '76561198000000001', authorName: 'Player',
  ...extra
});
const snapshot = extra => ({
  state: 'observed', rustServerId: 'server-1', channel: 'clan', clanId: '12345678901234567',
  name: 'RSG', motd: '战队公告', maxMemberCount: 100, observedAt: at(-1000), staleAfter: at(60000),
  members: [{ steamId: '76561198000000001', name: 'Player', role: 'leader', online: true, lastSeenAt: null }],
  ...extra
});
function fixture(options = {}) {
  let config = {
    revision: 1, baseUrl: 'https://rust.example.test/api/v1', tenantId: '', apiKey: 'rgk_fixture',
    serverIds: ['server-1'], infoEnabled: true, chatEnabled: true,
    updatedAt: at(-120000), chatStartAt: at(-120000), serverActivatedAt: { 'server-1': at(-120000) },
    ...options.config
  };
  let progress = options.progress || null, clock = CLOCK;
  const calls = { list: [], clan: [], invites: [], chat: [], ingest: [], invalidate: [], writes: [] };
  const durable = new Map();
  const hooks = options.hooks || {};
  const client = {
    async listServers(connection, request) {
      calls.list.push({ connection: clone(connection), request });
      if (hooks.list) return hooks.list(connection, request);
      return { items: [{ id: 'server-1', name: 'Atlas', state: 'running', clanAvailable: true, targetVersion: 7, primaryPairingId: 'pairing-1' }], checkedAt: at(0) };
    },
    async readClan(connection, id, request) {
      calls.clan.push({ id, request });
      return hooks.clan ? hooks.clan(connection, id, request) : snapshot();
    },
    async readInvites(connection, id, request) {
      calls.invites.push({ id, ...request });
      return hooks.invites ? hooks.invites(connection, id, request) : { items: [], hasMore: false };
    },
    async readChat(connection, id, request) {
      calls.chat.push({ id, ...request });
      return hooks.chat ? hooks.chat(connection, id, request) : { items: [message()], hasMore: false };
    }
  };
  const create = () => createRustgoWebApiWorker({
    readConfig: () => clone(config), readProgress: () => clone(progress),
    async writeProgress(next, guard) {
      if (hooks.write) await hooks.write(next, guard);
      guard(); progress = clone(next); calls.writes.push(clone(next));
    },
    async ingest(payload, context) {
      if (hooks.ingest) await hooks.ingest(payload, context);
      context.assertCredentialsCurrent();
      calls.ingest.push(clone(payload));
      if (payload.type === 'clan_chat_message') durable.set(`${payload.clientId}/${payload.serverId}/${payload.messageId}`, clone(payload));
    },
    async invalidateSource(sourceId, id, guard) {
      if (hooks.invalidate) await hooks.invalidate(sourceId, id, guard);
      guard(); calls.invalidate.push({ sourceId, id });
    },
    client, now: () => clock, maxPages: options.maxPages ?? 5
  });
  return { calls, durable, hooks, create, config: () => clone(config), progress: () => clone(progress),
    update(patch) { config = { ...config, revision: config.revision + 1, ...patch }; },
    advance(ms) { clock += ms; } };
}

test('information and chat switches independently gate upstream reads and canonical writes', async t => {
  for (const [infoEnabled, chatEnabled] of [[false, false], [true, false], [false, true], [true, true]]) {
    await t.test(`information=${infoEnabled}, chat=${chatEnabled}`, async () => {
      const f = fixture({ config: { infoEnabled, chatEnabled } }), worker = f.create();
      await worker.tick(); await worker.stop();
      assert.equal(f.calls.list.length > 0, infoEnabled || chatEnabled);
      assert.equal(f.calls.clan.length, Number(infoEnabled));
      assert.equal(f.calls.invites.length, Number(infoEnabled));
      assert.equal(f.calls.chat.length, Number(chatEnabled));
      assert.equal(f.calls.ingest.filter(row => row.type === 'clan_snapshot').length, Number(infoEnabled));
      assert.equal(f.durable.size, Number(chatEnabled));
      assert.equal(worker.status().state, infoEnabled || chatEnabled ? 'ok' : 'disabled');
    });
  }
});

test('a non-running server performs no clan/chat read and invalidates its retained roster', async () => {
  const f = fixture({ hooks: { list: async () => ({ items: [] }) } });
  const sourceId = rustgoSourceId(f.config());
  const g = fixture({ progress: { sourceId, servers: { 'server-1': { infoActive: true, name: 'Atlas', targetVersion: 7 } } }, hooks: f.hooks });
  const worker = g.create(); await worker.tick(); await worker.stop();
  assert.equal(g.calls.clan.length, 0); assert.equal(g.calls.chat.length, 0);
  assert.deepEqual(g.calls.invalidate, [{ sourceId, id: 'server-1' }]);
  assert.equal(g.progress().servers['server-1'].infoActive, false);
  assert.equal(worker.status().servers[0].errorCode, 'WEB_API_SERVER_NOT_RUNNING');
});

test('invitation history pagination resumes after restart and rescans for old status updates', async () => {
  const invite = (id, status = 'pending') => ({ id, inviteeSteamId: '76561198000000001',
    firstSeenAt: at(-60000), invitedAt: null, updatedAt: at(-1000), status });
  let accepted = false;
  const f = fixture({ maxPages: 1, config: { chatEnabled: false }, hooks: {
    invites: async (_config, _id, { cursor }) => cursor ? { items: [invite('older')], hasMore: false }
      : { items: [invite('newer', accepted ? 'accepted' : 'pending')], hasMore: true, nextCursor: 'older-page' }
  } });
  const first = f.create(); await first.tick(); await first.stop();
  assert.equal(f.progress().servers['server-1'].inviteWindow.cursor, 'older-page');
  assert.equal(first.status().state, 'syncing');
  f.advance(10000); const restarted = f.create(); await restarted.tick();
  assert.equal(f.progress().servers['server-1'].inviteWindow, null);
  accepted = true; f.advance(10000); await restarted.tick(); await restarted.stop();
  assert.deepEqual(f.calls.invites.map(row => [row.until, row.cursor]), [[at(0), null], [at(0), 'older-page'], [at(20000), null]]);
  assert.deepEqual(f.calls.ingest.filter(row => row.type === 'clan_invite_record').map(row => [row.invite.webApiInviteId, row.invite.status]),
    [['newer', 'pending'], ['older', 'pending'], ['newer', 'accepted']]);
});

test('a source changed during invitation history fetch cannot import those records', async () => {
  let changed = false;
  const f = fixture({ config: { chatEnabled: false }, hooks: {
    list: async () => ({ items: [{ id: 'server-1', name: 'Atlas', clanAvailable: true, targetVersion: changed ? 8 : 7 }] }),
    invites: async () => { changed = true; return { items: [], hasMore: false }; }
  } });
  const worker = f.create(); await worker.tick(); await worker.stop();
  assert.equal(worker.status().servers[0].errorCode, 'WEB_API_SOURCE_CHANGED');
  assert.equal(f.calls.ingest.filter(row => row.type === 'clan_invite_record').length, 0);
  assert.equal(f.progress().servers['server-1'].inviteWindow.cursor, null);
});

test('chat imports only the selected server, channel, current target generation and inclusive time window', async () => {
  const items = [
    message('valid'), message('wrong-server', { rustServerId: 'server-2' }),
    message('wrong-channel', { channel: 'team' }), message('queued', { direction: 'outbound_queued' }),
    message('old-generation', { targetVersion: 6 }), message('unknown-generation', { targetVersion: undefined }),
    message('too-old', { messageTime: at(-120001) }), message('future', { messageTime: at(1) }),
    message('from-boundary', { messageTime: at(-120000) }), message('until-boundary', { messageTime: at(0) })
  ];
  const f = fixture({ config: { infoEnabled: false }, hooks: { chat: async () => ({ items, hasMore: false }) } });
  const worker = f.create(); await worker.tick(); await worker.stop();
  assert.deepEqual([...f.durable.values()].map(row => row.messageId).sort(), ['from-boundary', 'until-boundary', 'valid']);
});

test('bounded pagination resumes its frozen window across ticks and a worker restart without losing messages', async () => {
  const pages = {
    first: { items: [message('6', { messageTime: at(-10000) }), message('5', { messageTime: at(-20000) })], hasMore: true, nextCursor: 'older-2' },
    'older-2': { items: [message('4', { messageTime: at(-30000) }), message('3', { messageTime: at(-40000) })], hasMore: true, nextCursor: 'older-3' },
    'older-3': { items: [message('2', { messageTime: at(-50000) }), message('1', { messageTime: at(-60000) })], hasMore: false }
  };
  const f = fixture({ maxPages: 1, config: { infoEnabled: false }, hooks: { chat: async (_config, _id, request) => clone(pages[request.cursor || 'first']) } });
  const first = f.create(); await first.tick(); await first.stop();
  assert.equal(f.progress().servers['server-1'].window.cursor, 'older-2');
  assert.equal(first.status().state, 'syncing');
  f.advance(10000); const restarted = f.create(); await restarted.tick();
  assert.equal(f.progress().servers['server-1'].window.cursor, 'older-3');
  f.advance(10000); await restarted.tick(); await restarted.stop();
  assert.equal(f.progress().servers['server-1'].window, null);
  assert.equal(f.progress().servers['server-1'].since, at(0));
  assert.deepEqual(f.calls.chat.map(row => [row.from, row.until, row.cursor]), [
    [at(-120000), at(0), null], [at(-120000), at(0), 'older-2'], [at(-120000), at(0), 'older-3']
  ]);
  assert.deepEqual([...f.durable.values()].map(row => row.messageId).sort(), ['1', '2', '3', '4', '5', '6']);
});

test('a partial ingest failure leaves the page checkpoint unchanged and safe replay completes the page', async () => {
  let fail = true;
  const f = fixture({ config: { infoEnabled: false }, hooks: {
    chat: async () => ({ items: [message('newest'), message('oldest')], hasMore: false }),
    ingest: async payload => { if (fail && payload.messageId === 'newest') throw Error('store unavailable'); }
  } });
  const worker = f.create(); await worker.tick();
  assert.equal(f.progress().servers['server-1'].window.cursor, null);
  assert.equal(f.progress().servers['server-1'].since, at(-120000));
  assert.equal(f.durable.size, 1);
  fail = false; await worker.tick(); await worker.stop();
  assert.equal(f.progress().servers['server-1'].window, null);
  assert.equal(f.durable.size, 2);
  assert.equal(f.calls.ingest.filter(row => row.messageId === 'oldest').length, 2);
});

test('a configuration change during upstream fetch prevents old-source ingest and progress writes', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ hooks: { clan: async () => { entered.resolve(); await release.promise; return snapshot(); } } });
  const worker = f.create(), tick = worker.tick(); await entered.promise;
  f.update({ apiKey: 'rgk_other_tenant' }); release.resolve(); await tick; await worker.stop();
  assert.equal(f.calls.ingest.length, 0); assert.equal(f.calls.writes.length, 0); assert.equal(f.calls.chat.length, 0);
});

test('the canonical write guard rejects a configuration change while ingest waits in its write queue', async () => {
  const entered = deferred(), release = deferred();
  const f = fixture({ config: { chatEnabled: false }, hooks: {
    ingest: async (_payload, context) => { entered.resolve(); await release.promise; context.assertCredentialsCurrent(); }
  } });
  const worker = f.create(), tick = worker.tick(); await entered.promise;
  f.update({ infoEnabled: false }); release.resolve(); await tick; await worker.stop();
  assert.equal(f.calls.ingest.length, 0); assert.equal(f.calls.writes.length, 0);
});

test('stop aborts an in-flight upstream request and prevents subsequent writes', async () => {
  const entered = deferred(); let aborted = false;
  const f = fixture({ config: { infoEnabled: false }, hooks: {
    chat: async (_config, _id, { signal }) => {
      entered.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true }));
    }
  } });
  const worker = f.create(), tick = worker.tick(); await entered.promise; await worker.stop(); await tick;
  assert.equal(aborted, true); assert.equal(f.calls.ingest.length, 0); assert.equal(f.calls.writes.length, 0);
  const reads = f.calls.chat.length; await worker.tick(); assert.equal(f.calls.chat.length, reads);
});

test('unobserved or expired clan state invalidates the roster and blocks that tick from importing chat', async t => {
  for (const invalid of [{ state: 'unobserved', members: [], reason: 'snapshot_expired' }, { staleAfter: at(-1) }]) {
    await t.test(JSON.stringify(invalid), async () => {
      const f = fixture({ hooks: { clan: async () => snapshot(invalid) } }), worker = f.create();
      await worker.tick(); await worker.stop();
      assert.equal(f.calls.invalidate.length, 1);
      assert.equal(f.calls.ingest.length, 0);
      assert.equal(f.calls.chat.length, 0);
      assert.equal(worker.status().servers[0].errorCode, 'WEB_API_CLAN_UNAVAILABLE');
    });
  }
});

test('disabling information invalidates the previous roster while chat remains independently enabled', async () => {
  const f = fixture(), worker = f.create(); await worker.tick();
  f.update({ infoEnabled: false }); f.advance(10000); await worker.tick(); await worker.stop();
  assert.equal(f.calls.clan.length, 1); assert.equal(f.calls.chat.length, 2);
  assert.equal(f.calls.invalidate.length, 1);
  assert.equal(f.progress().servers['server-1'].infoActive, false);
});

test('a changed target generation invalidates the old roster and starts a new chat boundary', async () => {
  let targetVersion = 7;
  const f = fixture({ hooks: {
    list: async () => ({ items: [{ id: 'server-1', name: 'Atlas', state: 'running', clanAvailable: true, targetVersion }] }),
    chat: async () => ({ items: [message(`generation-${targetVersion}`, { targetVersion })], hasMore: false })
  } });
  const worker = f.create(); await worker.tick(); targetVersion = 8; f.advance(10000);
  await worker.tick(); await worker.stop();
  assert.equal(f.calls.invalidate.length, 1);
  assert.equal(f.progress().servers['server-1'].targetVersion, 8);
  assert.equal(f.calls.chat.at(-1).from, at(10000));
  assert.deepEqual([...f.durable.values()].map(row => row.messageId), ['generation-7']);
});

test('different API credentials on the same origin cannot share a canonical source identity', () => {
  const config = fixture().config();
  assert.notEqual(rustgoSourceId(config), rustgoSourceId({ ...config, apiKey: 'rgk_other_tenant' }));
  assert.equal(rustgoSourceId(config), rustgoSourceId(clone(config)));
  assert.ok(!rustgoSourceId(config).includes(config.apiKey));
});

test('an upstream target or collector change during a read discards its response before canonical import', async t => {
  for (const channel of ['clan', 'chat']) {
    for (const changedField of ['targetVersion', 'primaryPairingId', 'clanAvailable']) {
      await t.test(`${channel}: ${changedField}`, async () => {
        let changed = false;
        const f = fixture({ config: { infoEnabled: channel === 'clan', chatEnabled: channel === 'chat' }, hooks: {
          list: async () => ({ items: [{ id: 'server-1', name: 'Atlas', state: 'running', clanAvailable: true, targetVersion: 7,
            primaryPairingId: 'pairing-1', ...(changed ? { [changedField]: changedField === 'targetVersion' ? 8 : changedField === 'clanAvailable' ? false : 'pairing-2' } : {}) }] }),
          clan: async () => { changed = true; return snapshot(); },
          chat: async () => { changed = true; return { items: [message()], hasMore: false }; }
        } });
        const worker = f.create(); await worker.tick(); await worker.stop();
        assert.equal(f.calls.ingest.length, 0);
        assert.equal(worker.status().servers[0].errorCode, 'WEB_API_SOURCE_CHANGED');
        if (channel === 'chat') assert.equal(f.progress().servers['server-1'].window.cursor, null);
      });
    }
  }
});
