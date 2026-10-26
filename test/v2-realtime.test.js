// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-realtime/fixture.mjs';
import { RealtimeService } from '../server/v2/realtime/service.js';
import { emptyChat, reduceChat, visibleChat } from '../src/v2/realtime/chat-state.js';
const setup = t => {
  const f = fixture({scopeContract:true});
  t.after(() => f.db.close());
  return f;
};
const code = c => e => e.errorCode === c;
test('G03 scope, deny precedence, filtered source catalog, account-bound cursor', t => {
  const f = setup(t),
    a = f.actor('alpha');
  assert.deepEqual(f.service.catalog(a).items.map(s => s.id), ['alpha', 'empty']);
  assert.throws(() => f.service.summary(a, 'beta'), code('ACCESS_DENIED'));
  const p = f.service.page(a, 'alpha');
  assert.throws(() => f.service.page(f.actor('admin'), 'alpha', {
    before: p.nextCursor
  }), code('CURSOR_EXPIRED'));
  assert.throws(() => f.service.page(a, 'alpha', {
    before: p.nextCursor + 'x'
  }), code('CURSOR_EXPIRED'));
  const account = f.ir.get('accounts', a.id);
  f.ir.put('accounts', {
    ...account,
    grants: [...account.grants, {
      capability: 'relay.read',
      effect: 'deny',
      scope: {
        type: 'squads',
        ids: ['g05_squad']
      }
    }]
  });
  assert.throws(() => f.service.summary(a, 'alpha'), code('ACCESS_DENIED'));
});
test('stable history and real-time tail during insert; no duplicate or history replacement', t => {
  const f = setup(t),
    a = f.actor('alpha'),
    p = f.service.page(a, 'alpha');
  f.chat('alpha', 999);
  f.chat('alpha', 999);
  const older = f.service.page(a, 'alpha', {
    before: p.nextCursor
  });
  const tail = f.service.events(a, 'alpha', p.tailCursor);
  assert.equal(tail.events.length, 1);
  assert.equal(new Set([...p.items, ...older.items].map(m => m.id)).size, 100);
  assert.equal(older.items[0].message, 'Hold the north gate 75');
  let state = reduceChat(emptyChat('alpha'), {
    scope: 'alpha',
    type: 'initial',
    page: p
  });
  state = reduceChat(state, {
    scope: 'alpha',
    type: 'history',
    page: older
  });
  state = reduceChat(state, {
    scope: 'alpha',
    type: 'event',
    data: tail.events[0]
  });
  state = reduceChat(state, {
    scope: 'alpha',
    type: 'event',
    data: tail.events[0]
  });
  assert.equal(visibleChat(state).length, 101);
  assert.equal(state.before, older.nextCursor);
  assert.equal(reduceChat(state, {
    scope: 'beta',
    type: 'initial',
    page: older
  }), state);
});
test('stale/unavailable roster does not report online; stale snapshot and delta cannot roll back state', t => {
  const f = setup(t),
    a = f.actor('alpha');
  assert.equal(f.service.summary(a, 'empty').status, 'unavailable');
  const old = new Date(f.now() - 1000).toISOString();
  assert.equal(f.seedSnapshot('alpha', old).ignored, true);
  f.advance(121000);
  const stale = f.service.summary(a, 'alpha');
  assert.equal(stale.status, 'stale');
  assert.equal(stale.counts.online, null);
  assert.equal(stale.members[0].online, null);
  f.ingest('alpha', {
    type: 'member_offline',
    member: {
      steamId: '76561198000000501'
    },
    occurredAt: new Date(f.now()).toISOString()
  });
  assert.equal(f.service.summary(a, 'alpha').status, 'stale');
  assert.equal(f.seedSnapshot('alpha', new Date(f.now() - 1).toISOString()).ignored, true);
});
test('bounded replay resets; expired and wrong-scope cursor; prune floor survives restart-like repository reads', t => {
  const f = setup(t),
    a = f.actor('admin'),
    p = f.service.page(a, 'alpha');
  assert.equal(f.service.events(a, 'beta', p.tailCursor).resetRequired, true);
  for (let n = 2000; n < 2102; n++) f.chat('alpha', n);
  assert.equal(f.service.events(a, 'alpha', p.tailCursor).resetRequired, true);
  f.advance(86400001);
  f.repo.pruneEvents(f.now());
  assert.equal(f.service.events(a, 'alpha', p.tailCursor).resetRequired, true);
  assert.throws(() => f.service.page(a, 'alpha', {
    before: p.nextCursor
  }), code('CURSOR_EXPIRED'));
});
test('clear is scoped, atomic, audited and idempotent; source replay cannot resurrect cleared chat', async t => {
  const f = setup(t),
    a = f.actor('admin'),
    s = f.service.summary(a, 'alpha'),
    input = {
      expectedRevision: s.revision,
      reason: '隔离清理'
    },
    id = 'clear_operation_0001';
  await assert.rejects(f.service.command(f.actor('alpha'), 'alpha', 'clear-chat', input, id), code('ACCESS_DENIED'));
  const r = await f.service.command(a, 'alpha', 'clear-chat', input, id);
  assert.equal(r.revision, s.revision + 1);
  assert.equal((await f.service.command(a, 'alpha', 'clear-chat', input, id)).replayed, true);
  assert.equal(f.service.page(a, 'alpha').items.length, 0);
  assert.equal(f.service.page(a, 'beta').items.length, 3);
  assert.equal(f.chat('alpha', 125).ignored, true);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM v2_realtime_audit').get().n, 1);
  await assert.rejects(f.service.command(a, 'alpha', 'clear-chat', {
    ...input,
    reason: 'different'
  }, id), code('IDEMPOTENCY_CONFLICT'));
});
test('missing adapters fail closed; source reset rollback and source epoch fences; members never written directly', async t => {
  const f = setup(t),
    a = f.actor('admin'),
    s = f.service.summary(a, 'alpha'),
    input = {
      expectedRevision: s.revision,
      reason: '隔离重置'
    },
    oldEpoch = f.repo.scope('alpha').epoch;
  const unavailable = new RealtimeService(f.identity, {
    ...f.options,
    sourceReset: undefined
  });
  await assert.rejects(unavailable.command(a, 'alpha', 'reset', input, 'reset_operation_001'), code('SOURCE_RESET_ADAPTER_REQUIRED'));
  const broken = new RealtimeService(f.identity, {
    ...f.options,
    sourceReset: ({
      apply
    }) => {
      apply();
      throw new Error('rollback');
    }
  });
  await assert.rejects(broken.command(a, 'alpha', 'reset', input, 'reset_operation_002'));
  assert.equal(f.repo.scope('alpha').revision, s.revision);
  await f.service.command(a, 'alpha', 'reset', input, 'reset_operation_003');
  assert.equal(f.service.summary(a, 'alpha').status, 'unavailable');
  assert.throws(() => f.source.ingest('alpha', {}, {
    sourceEpoch: oldEpoch
  }), code('SOURCE_EPOCH_CHANGED'));
  await assert.rejects(f.service.command(a, 'beta', 'import-member', {
    steamId: '76561198000000999',
    squadId: 'g05_squad'
  }, 'import_operation_001'), code('MEMBERS_ADAPTER_REQUIRED'));
  const noLegacy = new RealtimeService(f.identity, {
    repository: f.repo
  });
  await assert.rejects(noLegacy.command(a, 'beta', 'clear-chat', input, 'legacy_operation_001'), code('LEGACY_AUTHORITY_REQUIRED'));
});
test('invite search pagination and accepted update use same stable record; projection strips secrets', t => {
  const f = setup(t),
    a = f.actor('admin');
  const p = f.service.page(a, 'alpha', {
    kind: 'invite',
    q: 'accepted'
  });
  assert.equal(p.items.length, 32);
  assert.equal(p.counts.accepted, 32);
  assert.throws(() => f.service.page(a, 'alpha', {
    kind: 'invite',
    q: 'pending',
    before: f.service.page(a, 'alpha', {
      kind: 'invite'
    }).nextCursor
  }), code('CURSOR_EXPIRED'));
  f.ingest('alpha', {
    type: 'clan_chat_message',
    message: {
      id: 'secret-projection',
      message: 'hello',
      token: 'NEVER_DTO',
      phone: 'PRIVATE',
      sentAt: new Date(f.now()).toISOString()
    }
  });
  assert.equal(JSON.stringify(f.service.page(a, 'alpha')).includes('NEVER_DTO'), false);
});
test('100k chat indexed page stays bounded; historical records outlive event retention', t => {
  const f = setup(t),
    a = f.actor('admin');
  f.repo.transaction(() => {
    const stmt = f.db.prepare('INSERT INTO v2_realtime_records(scope,kind,id,occurred,received,payload) VALUES(?,?,?,?,?,?)');
    for (let n = 0; n < 100000; n++) stmt.run('alpha', 'chat', 'scale-' + n, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z', JSON.stringify({
      id: 'scale-' + n,
      message: 'bounded chat ' + n
    }));
  });
  const page = f.service.page(a, 'alpha', {
    limit: 100
  });
  assert.equal(page.items.length, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) < 100 * 1024);
  assert.ok(f.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM v2_realtime_records WHERE scope=? AND kind=? AND seq<? ORDER BY seq DESC LIMIT 101').all('alpha', 'chat', 1e9).some(r => r.detail.includes('v2_realtime_records_page')));
  f.repo.pruneEvents(f.now() + 86400001);
  assert.equal(f.service.page(a, 'alpha', {
    limit: 100
  }).items.length, 100);
});

test('invite acceptance does not regress on delayed pending replay', t => {
  const f=setup(t),a=f.actor('admin'),sentAt=new Date(f.now()).toISOString();
  const invite={id:'acceptance-proof',steamId:'76561198000000777',displayName:'验收邀请',inviterSteamId:'76561198000000501',sentAt};
  f.ingest('alpha',{type:'clan_invite_record',invite:{...invite,status:'pending'}});
  f.ingest('alpha',{type:'clan_invite_record',invite:{...invite,status:'accepted',acceptedAt:new Date(f.now()+1000).toISOString()}});
  assert.equal(f.ingest('alpha',{type:'clan_invite_record',invite:{...invite,status:'pending'}}).ignored,true);
  assert.equal(f.service.page(a,'alpha',{kind:'invite',q:'验收邀请'}).items[0].status,'accepted');
});
test('asynchronous reset adapter cannot mutate after transaction rollback', async t => {
  const f=setup(t),a=f.actor('admin'),revision=f.service.summary(a,'alpha').revision;
  const s=new RealtimeService(f.identity,{...f.options,sourceReset:async({apply})=>{await new Promise(r=>setImmediate(r));return apply();}});
  await assert.rejects(s.command(a,'alpha','reset',{expectedRevision:revision,reason:'隔离'},'async_reset_0000001'),code('INVALID_SOURCE_ADAPTER'));
  await new Promise(r=>setImmediate(r));assert.equal(f.repo.scope('alpha').revision,revision);assert.equal(f.service.page(a,'alpha').items.length,50);
});
