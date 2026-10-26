// Frozen scope-engine unit contract: fixtures explicitly opt into the scoped identity fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './support/v2-stats/fixture.mjs';
import { normalizeRow, intervalDelta, sessionSeconds, parseSteamInput, parseImport, hash } from '../server/v2/stats/model.js';
import { migrateStats } from '../server/v2/stats/migration.js';
import { StatsService } from '../server/v2/stats/service.js';
import { exportDocument } from '../server/v2/stats/exports.js';
const setup = (t, { scopeContract = true } = {}) => {
  const f = fixture({scopeContract});
  t.after(() => f.db.close());
  return f;
};
const q = {
  wipeId: 'g07_active',
  sourceId: 'vital',
  metricVersion: 'nb-kda-1'
};
// The runtime now derives grants from member/admin/owner roles and deliberately
// ignores legacy account.grants. These isolated domain tests inject a trusted
// identity actor to exercise scoped SQL/projection rules; no request or persisted
// account can supply these grants in the real role-based runtime.
const trustedStatsActor = (f, actor, grants) => {
  const readActor = f.identity.actorForAccount.bind(f.identity);
  f.identity.actorForAccount = id => {
    const current = readActor(id);
    return id === actor.id ? { ...current, grants: structuredClone(grants) } : current;
  };
  return f.identity.actorForAccount(actor.id);
};
test('zero, missing, unsupported assists, raw 999 and stale are distinct', () => {
  const r = normalizeRow({
    kills: 10,
    deaths: 0,
    assists: null,
    kda: 999,
    capturedAt: '2020-01-01'
  });
  assert.equal(r.values.kd, 10);
  assert.equal(r.values.kda, null);
  assert.equal(r.sourceRaw.kda, 999);
  assert.equal(r.status, 'stale');
  assert.equal(r.values.rockets, null);
  assert.equal(normalizeRow({
    kills: 0,
    deaths: 0,
    assists: 0
  }).values.kda, 0);
});
test('interval same scope, monotonic versions, source reset and overlapping server sessions', () => {
  const a = normalizeRow({
      memberId: 'm',
      source: 'vital',
      capabilities: {
        assists: true
      },
      sourceRevision: 1,
      kills: 10,
      deaths: 2,
      assists: 2,
      capturedAt: '2026-01-01'
    }),
    b = normalizeRow({
      ...a,
      values: {
        kills: 20,
        deaths: 4,
        assists: 5
      },
      sourceRevision: 2,
      capturedAt: '2026-01-02'
    });
  assert.equal(intervalDelta(a, b).values.kda, 6.5);
  assert.throws(() => intervalDelta(a, {
    ...b,
    serverId: 'foreign'
  }), /SCOPE_MISMATCH/);
  assert.equal(intervalDelta(a, {
    ...b,
    values: {
      ...b.values,
      kills: 1
    }
  }).coverage, 'discontinuity');
  assert.equal(sessionSeconds([{
    serverId: 's',
    start: '2026-01-01T00:00Z',
    end: '2026-01-01T00:20Z'
  }, {
    serverId: 's',
    start: '2026-01-01T00:10Z',
    end: null
  }, {
    serverId: 'other',
    start: '2026-01-01T00:00Z',
    end: '2026-01-01T01:00Z'
  }], {
    serverId: 's',
    from: '2026-01-01T00:05Z',
    to: '2026-01-01T01:00Z',
    observedAt: '2026-01-01T00:30Z'
  }), 1500);
});
test('Steam input SSRF boundary and quoted multilingual CSV validation', () => {
  assert.deepEqual(parseSteamInput('https://steamcommunity.com/profiles/76561198000000501/'), {
    steamId: '76561198000000501'
  });
  assert.deepEqual(parseSteamInput('https://steamcommunity.com/id/example'), {
    vanity: 'example'
  });
  for (const s of ['http://127.0.0.1/x', 'https://steamcommunity.com.evil/id/a', 'https://steamcommunity.com:444/id/a']) assert.throws(() => parseSteamInput(s));
  assert.equal(parseImport({
    text: 'Steam ID,击杀,死亡\n76561198000000501,0,2'
  })[0].kills, 0);
  assert.throws(() => parseImport({
    rows: [{
      steamId: '76561198000000501',
      kills: -1
    }]
  }), /INVALID_METRIC/);
});
test('GET-like service reads leave all SQLite facts and collection counts unchanged; member scope before limit', t => {
  const f = setup(t),
    before = f.db.prepare('SELECT total_changes() n').get().n;
  const rows = f.service.list(f.member(), {
    ...q,
    limit: 1
  });
  assert.equal(rows.items.length, 1);
  assert.equal(rows.items[0].memberId, 'g05_alpha');
  assert.equal(rows.nextCursor, null);
  f.service.catalog(f.member());
  f.service.sources(f.member(), 'g07_active');
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.sourceCalls(), 0);
});
test('stats avatars resolve member aliases and matching Steam profile caches without external calls or writes', t => {
  const f = setup(t), members = f.ir.all('members');
  const avatars = members.map((_, i) => `https://avatars.steamstatic.com/${String(i + 1).repeat(40)}_full.jpg`);
  f.ir.put('members', { ...members[0], avatar: avatars[0] });
  f.ir.put('members', { ...members[1], avatar: 'javascript:alert(1)', steamAvatar: avatars[1] });
  f.ir.put('members', { ...members[2], avatarUrl: avatars[2] });
  f.put('memberProfiles', { id: 'matching-avatar-cache', memberId: members[3].id, steamId: members[3].steamId,
    avatar: avatars[3], fetchedAt: '2026-10-16T00:00:00Z' });
  f.put('memberProfiles', { id: 'wrong-member-cache', memberId: members[0].id, steamId: members[4].steamId,
    avatar: avatars[4], fetchedAt: '2026-10-16T01:00:00Z' });
  f.put('memberProfiles', { id: 'unsafe-avatar-cache', memberId: members[4].id, steamId: members[4].steamId,
    avatar: 'https://untrusted.example/avatar.png', fetchedAt: '2026-10-16T00:00:00Z' });
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  const rows = new Map(f.service.list(f.admin(), q).items.map(row => [row.memberId, row]));
  for (let i = 0; i < 4; i++) assert.equal(rows.get(members[i].id).avatarUrl, avatars[i]);
  assert.equal(rows.get(members[4].id).avatarUrl, '', 'another member cache and untrusted image hosts must not be exposed');
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  assert.equal(f.sourceCalls(), 0);
  f.put('memberProfiles', { id: 'legacy-steam-cache', steamId: members[4].steamId, avatar: avatars[4] });
  assert.equal(f.service.list(f.admin(), { ...q, memberId: members[4].id }).items[0].avatarUrl, avatars[4], 'Steam-keyed legacy caches may omit memberId');
});
test('avatar normalization preserves snapshot and provider identities but rejects unsafe URLs', t => {
  const avatar = 'https://avatars.akamai.steamstatic.com/1234567890123456789012345678901234567890_full.jpg';
  for (const row of [{ avatarUrl: avatar }, { avatar }, { steamAvatar: avatar }, { member: { avatar } }, { steamProfile: { avatar } }]) {
    assert.equal(normalizeRow(row).avatarUrl, avatar);
  }
  for (const unsafe of ['javascript:alert(1)', 'http://avatars.steamstatic.com/a.jpg', 'https://avatars.steamstatic.com.evil/a.jpg',
    'https://user:pass@avatars.steamstatic.com/a.jpg', 'https://avatars.steamstatic.com:8080/a.jpg', '/api/private/avatar', 'data:image/png;base64,abc']) {
    assert.equal(normalizeRow({ avatarUrl: unsafe }).avatarUrl, '');
  }
  const f = setup(t), row = f.service.list(f.admin(), q).items[0];
  f.service.repo.saveArchive({ wipeId: q.wipeId, revision: 1, sourceId: 'vital' }, [{ ...row, avatarUrl: avatar }]);
  const member = f.ir.get('members', row.memberId);
  f.ir.put('members', { ...member, avatar: 'https://avatars.steamstatic.com/new-avatar.jpg' });
  assert.equal(f.service.list(f.admin(), { ...q, revision: 1 }).items[0].avatarUrl, avatar, 'historical avatars remain frozen with the snapshot');
  for (let sourceRevision = 1; sourceRevision <= 2; sourceRevision++) f.put('kdaSnapshots', {
    ...row, id: `avatar-interval-${sourceRevision}`, avatarUrl: avatar, sourceRevision,
    capturedAt: `2026-10-16T0${sourceRevision}:00:00.000Z`
  });
  const interval = { ...q, memberId: row.memberId, from: '2026-10-16T00:00:00.000Z', to: '2026-10-16T03:00:00.000Z' };
  assert.equal(f.service.interval(f.admin(), interval).item.avatarUrl, avatar);
  const actor = trustedStatsActor(f, f.admin(), [...f.admin().grants, { capability: 'members.read', effect: 'deny', scope: { type: 'all' } }]);
  for (const revision of [0, 1]) assert.ok(f.service.list(actor, { ...q, revision }).items.every(item => item.avatarUrl === ''), 'member identity redaction also removes avatar URLs');
  assert.equal(f.service.interval(actor, interval).item.avatarUrl, '', 'interval statistics must apply the same avatar redaction');
});
test('Vital wipe catalog excludes Moose schedules and refuses Vital stats on a Moose wipe', async t => {
  const f = setup(t);
  const existing = f.service.repo.get('v2Wipes', 'g07_active');
  f.put('v2Wipes', {
    ...existing, title: 'Rusty Moose |EU Mondays|',
    serverProfileId: 'moose-eu-mondays',
    serverSnapshot: { name: 'Rusty Moose |EU Mondays|', provider: 'moose', kdaProvider: 'manual', mooseServerId: 'eu-mondays' }
  });
  f.put('v2Wipes', {
    ...f.service.repo.get('v2Wipes', 'g07_history'),
    serverSnapshot: { name: 'Vital 2X', provider: 'vital', kdaProvider: 'vital', vitalServerId: '16' }
  });
  const catalog = f.service.catalog(f.admin(), { provider: 'vital' });
  assert.ok(catalog.items.some(w => w.id === 'g07_history'));
  assert.ok(!catalog.items.some(w => w.id === 'g07_active'));
  assert.equal(f.service.sources(f.admin(), 'g07_active').wipe.supportsVitalStats, false);
  assert.equal(f.service.sources(f.admin(), 'g07_history').wipe.supportsVitalStats, true);
  assert.equal(f.service.sources(f.admin(), 'g07_history').actions.sync, false);
  assert.equal(f.service.sources(f.admin(), 'g07_active').actions.sync, false);
  f.service.repo.saveArchive({ wipeId: 'g07_history', revision: 1, sourceId: 'moose' }, []);
  f.service.repo.saveArchive({ wipeId: 'g07_history', revision: 2, sourceId: 'vital' }, []);
  assert.deepEqual(f.service.history(f.admin(), 'g07_history', { sourceId: 'vital' }).items.map(row => row.revision), [2]);
  assert.throws(() => f.service.history(f.admin(), 'g07_active', { sourceId: 'vital' }), { errorCode: 'SOURCE_WIPE_MISMATCH' });
  assert.throws(() => f.service.list(f.admin(), {
    wipeId: 'g07_active', sourceId: 'vital', metricVersion: 'nb-kda-1'
  }), { errorCode: 'SOURCE_WIPE_MISMATCH' });
  assert.throws(() => f.service.list(f.admin(), {
    wipeId: 'g07_history', sourceId: 'vital', metricVersion: 'nb-kda-1', revision: 1
  }), { errorCode: 'SOURCE_WIPE_MISMATCH' });
  await assert.rejects(f.service.sync(f.admin(), {
    wipeId: 'g07_active', sourceId: 'vital'
  }, 'moose-sync-attempt'), { errorCode: 'SOURCE_WIPE_MISMATCH' });
});
test('wipe catalog defaults to the latest active wipe and paginates in that same order', t => {
  const f = setup(t), base = f.service.repo.get('v2Wipes', 'g07_active');
  for (const [id, lifecycle, startedAt] of [
    ['aaa-old-history', 'ended', '2026-09-01T16:00:00Z'],
    ['zzz-current', 'active', '2026-10-15T16:00:00Z'],
    ['bbb-older-active', 'active', '2026-10-01T16:00:00Z'],
    ['aaa-upcoming', 'scheduled', '2026-10-29T16:00:00Z']
  ]) f.put('v2Wipes', { ...base, id, lifecycle, serverScheduledWipeAt: startedAt,
    serverSnapshot: { provider: 'vital', vitalServerId: '19' } });
  const query = { provider: 'vital', limit: 2 };
  const first = f.service.catalog(f.admin(), query);
  assert.deepEqual(first.items.map(w => w.id), ['zzz-current', 'bbb-older-active']);
  const second = f.service.catalog(f.admin(), { ...query, cursor: first.nextCursor });
  assert.deepEqual(second.items.map(w => w.id), ['g07_active', 'aaa-upcoming']);
  const third = f.service.catalog(f.admin(), { ...query, cursor: second.nextCursor });
  assert.deepEqual(third.items.map(w => w.id), ['aaa-old-history', 'g07_history']);
  assert.equal(third.nextCursor, null);
  f.put('v2Wipes', { ...f.service.repo.get('v2Wipes', 'zzz-current'), lifecycle: 'ended' });
  assert.throws(() => f.service.catalog(f.admin(), { ...query, cursor: first.nextCursor }), { errorCode: 'CURSOR_EXPIRED' });
});
test('stable cursors bind filter account scope version and data version; SQL injection treated as data', t => {
  const f = setup(t),
    page = f.service.list(f.admin(), {
      ...q,
      limit: 2
    });
  assert.ok(page.nextCursor);
  const next = f.service.list(f.admin(), {
    ...q,
    limit: 2,
    cursor: page.nextCursor
  });
  assert.ok(!next.items.some(r => page.items.some(p => r.id === p.id)));
  assert.throws(() => f.service.list(f.member(), {
    ...q,
    cursor: page.nextCursor
  }), /CURSOR_EXPIRED/);
  assert.throws(() => f.service.list(f.admin(), {
    ...q,
    sort: 'deaths',
    cursor: page.nextCursor
  }), /CURSOR_EXPIRED/);
  assert.equal(f.service.list(f.admin(), {
    ...q,
    q: "' OR 1=1 --"
  }).items.length, 0);
  const row = f.service.repo.get('kdaRows', 'g07_active:g05_alpha');
  f.put('kdaRows', {
    ...row,
    kills: 99
  });
  assert.throws(() => f.service.list(f.admin(), {
    ...q,
    cursor: page.nextCursor
  }), /CURSOR_EXPIRED/);
});
test('import explicit permission, row revision, replay and atomic validation', t => {
  const f = setup(t);
  const body = {
      wipeId: 'g07_active',
      rows: [{
        steamId: '76561198000000501',
        kills: 12,
        deaths: 3,
        assists: 5
      }]
    },
    preview = f.service.importPreview(f.admin(), body),
    command = {
      wipeId: body.wipeId,
      ...preview
    };
  const out = f.service.import(f.admin(), command, 'import-op-1');
  assert.equal(out.imported, 1);
  assert.equal(f.service.import(f.admin(), command, 'import-op-1').replayed, true);
  assert.equal(f.service.repo.get('kdaRows', 'g07_active:g05_alpha').kills, 12);
  assert.throws(() => f.service.import(f.admin(), command, 'import-op-2'), /ROW_REVISION_CONFLICT/);
  assert.throws(() => f.service.import(f.member(), command, 'import-op-3'), /STATS_WRITE_NOT_GRANTED/);
  const denied = new StatsService(f.identity, {
    writeCurrent: f.options.writeCurrent
  });
  assert.throws(() => denied.import(f.admin(), command, 'import-op-4'), /STATS_WRITE_NOT_GRANTED/);
  assert.throws(() => f.service.import(f.admin(), {
    ...command,
    rows: [...command.rows, {
      steamId: '76561198000000999',
      kills: 7
    }]
  }, 'import-op-5'), /ROW_REVISION_CONFLICT|MEMBER_NOT_FOUND/);
});
test('immutable history revisions, stale revision, logical hide/restore, ordinary member cannot read hidden', t => {
  const f = setup(t),
    body = {
      wipeId: 'g07_history',
      sourceId: 'vital',
      expectedRevision: 0,
      reason: '首次冻结',
      completeness: 'missing_data'
    };
  const first = f.service.archive(f.admin(), body, 'archive-op-1');
  assert.equal(first.current.revision, 1);
  const frozen = f.service.repo.archive('g07_history', 1);
  f.service.archive(f.admin(), {
    ...body,
    expectedRevision: 1,
    reason: '补数说明'
  }, 'archive-op-2');
  assert.deepEqual(f.service.repo.archive('g07_history', 1), frozen);
  assert.throws(() => f.service.archive(f.admin(), body, 'archive-op-3'), /REVISION_CONFLICT/);
  f.service.visibility(f.admin(), {
    wipeId: 'g07_history',
    expectedRevision: 0,
    reason: '隐藏旧档',
    hidden: true
  }, 'visibility-op-1');
  assert.throws(() => f.service.list(f.member(), {
    ...q,
    wipeId: 'g07_history',
    revision: 1
  }), /RESOURCE_NOT_FOUND/);
  assert.equal(f.service.catalog(f.member(), {
    hidden: '1'
  }).items.some(w => w.id === 'g07_history'), false);
  f.service.visibility(f.admin(), {
    wipeId: 'g07_history',
    expectedRevision: 1,
    reason: '恢复旧档',
    hidden: false
  }, 'visibility-op-2');
  assert.equal(f.service.list(f.member(), {
    ...q,
    wipeId: 'g07_history',
    revision: 1
  }).items.length, 1);
});
test('migration dry-run no writes, exact raw snapshot retained, idempotent replay and conflict stops', t => {
  const f = setup(t),
    raw = {
      id: 'settle-a',
      wipeId: 'g07_history',
      generatedAt: '2026-01-01T00:00:00.000Z',
      kdaSnapshot: [{
        id: 'old-row',
        memberId: 'g05_alpha',
        kills: 7,
        deaths: 0,
        source: 'vital'
      }],
      participantsSnapshot: [{
        memberId: 'g05_alpha',
        displayName: '旧昵称',
        internalNote: 'must stay private'
      }]
    };
  f.put('wipeSettlements', raw);
  const before = f.db.prepare('SELECT total_changes() n').get().n;
  assert.equal(migrateStats(f.db).items[0].status, 'capture');
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n, before);
  migrateStats(f.db, {
    dryRun: false
  });
  assert.deepEqual(f.service.repo.archive('g07_history', 1).legacyRaw, raw);
  assert.equal(migrateStats(f.db, {
    dryRun: false
  }).items[0].status, 'reused');
  f.put('wipeSettlements', {
    ...raw,
    generatedAt: '2026-02-01'
  });
  assert.throws(() => migrateStats(f.db, {
    dryRun: false
  }), /MIGRATION_CONFLICT/);
  assert.equal(JSON.stringify(f.service.history(f.member(), 'g07_history')).includes('must stay private'), false);
});
test('independent official/Vital/Moose/inventory/catalog queries persist only private jobs, never member facts', async t => {
  const f = setup(t),
    before = f.db.prepare("SELECT collection,id,hash FROM json_records ORDER BY collection,id").all();
  for (const sourceId of ['official', 'vital', 'moose', 'inventory', 'catalog', 'member']) {
    const r = f.service.createJob(f.admin(), 'query', {
      sourceId,
      steamInput: '76561198000000501',
      serverId: 's',
      providerWipeId: 'p'
    }, `query-op-${sourceId}`);
    await f.service.runJob(r.jobId);
    assert.equal(f.service.readJob(f.admin(), r.jobId).status, 'succeeded');
    assert.throws(() => f.service.readJob(f.member(), r.jobId), /RESOURCE_NOT_FOUND/);
  }
  assert.deepEqual(f.db.prepare('SELECT collection,id,hash FROM json_records ORDER BY collection,id').all(), before);
});
test('failed inventory query preserves a bounded source retry time without rerunning itself',async t=>{
  const f=setup(t);
  const account=f.ir.get('accounts','g05_account_admin');
  f.ir.put('accounts',{...account,adminAssignedByOwner:true});
  let calls=0;
  f.service.providers.inventory=async()=>{calls++;throw Object.assign(new Error('upstream private detail'),{errorCode:'RATE_LIMITED',sourceId:'community',retryAfterMs:2000,retryAfterKnown:true});};
  const op=f.service.createJob(f.admin(),'query',{sourceId:'inventory',steamInput:'76561198000000501'},'inventory-limited');
  await f.service.runJob(op.jobId);
  const job=f.service.readJob(f.admin(),op.jobId);
  assert.equal(job.status,'failed');assert.equal(job.result.errorCode,'RATE_LIMITED');
  assert.equal(job.result.sourceId,'community');assert.equal(job.result.retryAfterMs,2000);
  assert.equal(job.result.retryAfterKnown,true);
  assert.ok(Date.parse(job.result.retryAt)>Date.now());assert.equal(calls,1);
  await f.service.runJob(op.jobId);assert.equal(calls,1);
});
test('inventory failure can persist fresh Steam identity without inventing inventory facts',async t=>{
  const f=setup(t);
  const account=f.ir.get('accounts','g05_account_admin');
  f.ir.put('accounts',{...account,adminAssignedByOwner:true});
  f.service.providers.inventory=async input=>({
    steamId:input.steamId,displayName:'Steam 测试账号',status:'partial',
    steamProfile:{avatar:'https://avatars.steamstatic.com/example.jpg',createdAt:'2020-01-01T00:00:00.000Z',playtimeMinutes:0,secret:'must not persist'},
    inventory:{status:'unavailable',currency:null,total:null,items:[]},
    errors:[{sourceId:'community',errorCode:'RATE_LIMITED',retryAfterMs:60000,retryAfterKnown:false}]
  });
  const op=f.service.createJob(f.admin(),'query',{sourceId:'inventory',steamInput:'76561198000000501'},'inventory-profile-only');
  await f.service.runJob(op.jobId);
  const job=f.service.readJob(f.admin(),op.jobId);
  assert.equal(job.status,'succeeded');assert.equal(job.result.status,'partial');
  assert.equal(job.result.displayName,'Steam 测试账号');
  assert.equal(job.result.steamProfile.createdAt,'2020-01-01T00:00:00.000Z');
  assert.equal(job.result.steamProfile.playtimeMinutes,0);
  assert.equal(job.result.inventory.status,'unavailable');assert.equal(job.result.inventory.total,null);
  assert.deepEqual(job.result.inventory.items,[]);
  assert.equal(job.result.errors[0].errorCode,'RATE_LIMITED');
  assert.equal(job.result.errors[0].retryAt,undefined);
  assert.ok(!JSON.stringify(job.result).includes('must not persist'));
});
test('in-flight completion after revoke is fenced and restart does not blindly rerun', async t => {
  const f = setup(t);
  let release;
  f.service.providers.official = () => new Promise(r => release = r);
  const op = f.service.createJob(f.admin(), 'query', {
      sourceId: 'official',
      steamInput: '76561198000000501'
    }, 'query-revoke-1'),
    pending = f.service.runJob(op.jobId);
  const account = f.ir.get('accounts', 'g05_account_admin');
  f.ir.put('accounts', {
    ...account,
    permissionVersion: 2
  });
  release({
    steamId: '76561198000000501',
    rows: []
  });
  await pending;
  assert.equal(f.service.repo.job(op.jobId).status, 'failed');
  assert.throws(() => f.service.readJob({
    ...f.admin(),
    permissionVersion: 1
  }, op.jobId), /PERMISSIONS_CHANGED/);
});
test('export job CSV HTML JSON are scoped, escaped, metadata versioned and replay safe', async t => {
  const f = setup(t);
  for (const format of ['csv', 'html', 'json']) {
    const op = f.service.createJob(f.admin(), 'export', {
      ...q,
      format,
      language: 'zh',
      timeZone: 'Asia/Shanghai'
    }, 'export-op-' + format);
    await f.service.runJob(op.jobId);
    const out = f.service.readJob(f.admin(), op.jobId);
    assert.equal(out.status, 'succeeded');
    assert.ok(out.result.base64);
    assert.equal(out.result.meta.sourceId, 'vital');
  }
  const doc = exportDocument({
    wipe: {
      id: 'a',
      title: '<script>alert(1)</script>'
    },
    items: [{
      memberId: 'm',
      displayName: '=HYPERLINK("bad")',
      values: {
        kills: 1
      },
      status: 'fresh'
    }]
  });
  assert.ok(doc.html.includes('&lt;script&gt;'));
  assert.ok(doc.csv.includes("'=HYPERLINK"));
});
test('history corrections append new values without altering current or original revision', t => {
  const f = setup(t),
    body = {
      wipeId: 'g07_history',
      sourceId: 'vital',
      expectedRevision: 0,
      reason: '修正击杀',
      completeness: 'missing_data',
      corrections: [{
        memberId: 'g05_alpha',
        values: {
          kills: 111
        }
      }]
    };
  f.service.archive(f.admin(), body, 'correct-one');
  assert.equal(f.service.list(f.admin(), {
    ...q,
    wipeId: 'g07_history',
    revision: 1,
    memberId: 'g05_alpha'
  }).items[0].values.kills, 111);
  assert.notEqual(f.service.repo.get('kdaRows', 'g07_history:g05_alpha').kills, 111);
});
test('provider ingestion fences old revision and uses explicit per member write authorization', t => {
  const f = setup(t);
  f.service.authorizeWrite = () => true;
  const old = f.service.repo.get('kdaRows', 'g07_active:g05_alpha');
  const body = {
    wipeId: 'g07_active',
    sourceId: 'vital',
    serverId: 'local-server-1',
    providerWipeId: 'period-9',
    expectedRevision: 1,
    expectedRows: {
      g05_alpha: hash(old)
    },
    rows: [{
      memberId: 'g05_alpha',
      sourceRevision: 4,
      capturedAt: new Date(Date.now() + 1000).toISOString(),
      kills: 42,
      deaths: 2
    }]
  };
  assert.equal(f.service.ingest(f.admin(), body, 'ingest-one').accepted, 1);
  assert.equal(f.service.ingest(f.admin(), body, 'ingest-one').replayed, true);
  const updated = f.service.repo.get('kdaRows', 'g07_active:g05_alpha');
  assert.throws(() => f.service.ingest(f.admin(), {
    ...body,
    expectedRows: {
      g05_alpha: hash(updated)
    },
    rows: [{
      ...body.rows[0],
      sourceRevision: 3
    }]
  }, 'ingest-stale'), /STALE_SOURCE_REVISION/);
});
test('DB immutable guards and projected audit; private visibility reason is management-only', t => {
  const f = setup(t);
  f.service.archive(f.admin(), {
    wipeId: 'g07_history',
    sourceId: 'vital',
    expectedRevision: 0,
    reason: '审阅',
    completeness: 'missing_data'
  }, 'immutable-one');
  assert.throws(() => f.db.prepare("UPDATE v2_stats_archives SET payload='{}'").run(), /STATS_IMMUTABLE/);
  assert.throws(() => f.db.prepare('DELETE FROM v2_stats_archive_rows').run(), /STATS_IMMUTABLE/);
  assert.equal(f.service.audit(f.admin(), 'g07_history').items.length, 1);
  assert.throws(() => f.service.audit(f.member(), 'g07_history'), /ACCESS_DENIED/);
});
test('queued revoked job becomes terminal so a worker can advance; local member query projects fields', async t => {
  const f = setup(t),
    job = f.service.createJob(f.admin(), 'query', {
      sourceId: 'official',
      steamInput: '76561198000000501'
    }, 'queued-revoke');
  const account = f.ir.get('accounts', 'g05_account_admin');
  f.ir.put('accounts', {
    ...account,
    permissionVersion: 2
  });
  await f.service.runJob(job.jobId);
  assert.equal(f.service.repo.job(job.jobId).status, 'failed');
  assert.equal(f.sourceCalls(), 0);
  const result = f.service.memberQuery('76561198000000501', {
    actor: f.admin()
  });
  assert.equal(result.displayName, '阿北');
  assert.equal(JSON.stringify(result).includes('internalNote'), false);
});
test('member role rejects legacy export grants; trusted scoped export retains only the authorized member', async t => {
  const f = setup(t,{scopeContract:false}),
    account = f.ir.get('accounts', 'g05_account_alpha');
  f.ir.put('accounts', {
    ...account,
    grants: [...account.grants, {
      capability: 'stats.export',
      scope: {
        type: 'self'
      },
      effect: 'allow'
    }]
  });
  const actualMember = f.member();
  assert.equal(actualMember.roleId, 'member');
  assert.equal(actualMember.grants.some(g => g.capability === 'stats.export'), false);
  assert.throws(() => f.service.createJob(actualMember, 'export', { ...q, format: 'json' }, 'denied-member-export'), { errorCode: 'ACCESS_DENIED' });
  const member = trustedStatsActor(f, actualMember, [...actualMember.grants, {
      capability: 'stats.export', scope: { type: 'self' }, effect: 'allow'
    }]),
    op = f.service.createJob(member, 'export', {
      ...q,
      format: 'json',
      language: 'zh',
      timeZone: 'Asia/Shanghai'
    }, 'member-export');
  await f.service.runJob(op.jobId);
  const job = f.service.readJob(member, op.jobId);
  assert.equal(job.status, 'succeeded');
  const content = JSON.parse(Buffer.from(job.result.base64, 'base64').toString());
  assert.equal(content.items.length, 1);
  assert.equal(content.items[0].memberId, 'g05_alpha');
});
test('admin role ignores legacy deny; trusted field redaction fences name and SteamID searches', t => {
  const f = setup(t,{scopeContract:false}),
    account = f.ir.get('accounts', 'g05_account_admin');
  f.ir.put('accounts', {
    ...account,
    grants: [...account.grants, {
      capability: 'members.read',
      effect: 'deny',
      scope: {
        type: 'all'
      }
    }]
  });
  const actualAdmin = f.admin();
  assert.equal(actualAdmin.roleId, 'admin');
  assert.equal(actualAdmin.grants.some(g => g.effect === 'deny'), false);
  assert.ok(f.service.list(actualAdmin, q).items.every(r => r.displayName && r.steamId));
  const a = trustedStatsActor(f, actualAdmin, [...actualAdmin.grants, {
    capability: 'members.read', effect: 'deny', scope: { type: 'all' }
  }]);
  assert.equal(f.service.list(a, q).items.length, 5);
  assert.ok(f.service.list(a, q).items.every(r => r.displayName === '' && r.steamId === ''));
  assert.equal(f.service.list(a, {
    ...q,
    q: '阿北'
  }).items.length, 0);
  assert.equal(f.service.list(a, {
    ...q,
    q: '76561198000000501'
  }).items.length, 0);
});

test('admin role ignores legacy catalog-only grants; trusted catalog access does not grant player queries', t => {
  const f = setup(t,{scopeContract:false});
  const account = f.ir.get('accounts', 'g05_account_admin');
  f.ir.put('accounts', {...account, grants: [{capability:'queries.read', effect:'allow', scope:{type:'all'}}]});
  const actualAdmin = f.admin();
  assert.equal(actualAdmin.roleId, 'admin');
  assert.doesNotThrow(() => f.service.queryAuth(actualAdmin, {sourceId:'vital', steamInput:'76561198000000501'}));
  const actor = trustedStatsActor(f, actualAdmin, [{capability:'queries.read', effect:'allow', scope:{type:'all'}}]);
  for (const provider of ['vital', 'moose']) {
    assert.doesNotThrow(() => f.service.queryAuth(actor, {sourceId:'catalog', provider}));
    assert.throws(() => f.service.queryAuth(actor, {sourceId:provider, steamInput:'76561198000000501'}), /ACCESS_DENIED/);
  }
  assert.throws(() => f.service.queryAuth(actor, {sourceId:'catalog', provider:'unexpected'}), /INVALID_SOURCE/);
  f.ir.put('accounts', {...account, grants: []});
  trustedStatsActor(f, actualAdmin, []);
  assert.throws(() => f.service.queryAuth(f.admin(), {sourceId:'catalog'}), /ACCESS_DENIED/);
});
