import { fixtureSessionFactory } from '../authenticated-session.mjs';
import express from 'express';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fixture as base } from '../v2-member-admin/fixtures.mjs';
import { IdentityRepository } from '../../../server/v2/identity/repository.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { MemberAdminService } from '../../../server/v2/member-admin/service.js';
import { createMemberAdminRouter } from '../../../server/v2/member-admin/routes.js';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { createMemberManagementAdapters } from '../../../server/v2/management-adapters/members/index.js';
import { createMemberOutboxConsumer } from '../../../server/v2/management-runtime/member-outbox.js';
import { createManagementSourceAdapters, installSourceAdapterSchema } from '../../../server/v2/management-adapters/sources/index.js';
import { installSyncCenterSchema } from '../../../server/v2/sync-center/repository.js';
import { installStatsSchema } from '../../../server/v2/stats/repository.js';
import { SyncCenterService } from '../../../server/v2/sync-center/service.js';
import { createMemberFollowups, installMemberFollowupsSchema, FOLLOWUP_TYPES } from '../../../server/v2/member-followups/index.js';

export async function fixture({ filename = ':memory:', startWorker = true } = {}) {
  const reopening = filename !== ':memory:' && existsSync(filename);
  const f = reopening ? { db: new DatabaseSync(filename) } : base(filename);
  f.ir ||= new IdentityRepository(f.db);
  let now = Date.parse('2030-09-08T10:00:00Z'); f.advance = ms => { now += ms; };
  f.identity = new IdentityService(f.ir, { now: () => now }); f.actor = (id = 'admin') => f.identity.actorForAccount(id);
  let tail = Promise.resolve(); f.queue = fn => { const task = tail.then(fn); tail = task.catch(() => {}); return task; };
  installSyncCenterSchema(f.db); installStatsSchema(f.db); installSourceAdapterSchema(f.db); installMemberFollowupsSchema(f.db);
  if (!reopening) {
    f.ir.setScalar('fixtureFollowupPolicy', { enabled: true, revision: 'policy-1', tasks: Object.fromEntries(FOLLOWUP_TYPES.map(type => [type,
      { enabled: type.includes('profile'), ready: true, identity: 'isolated-config-1' }])) });
    f.ir.setScalar('fixtureFollowupPrincipal', { accountId: 'admin', permissionVersion: 1 });
  }
  f.policy = () => f.ir.scalar('fixtureFollowupPolicy');
  f.setPolicy = value => f.ir.setScalar('fixtureFollowupPolicy', value);
  f.calls = []; f.responses = new Map(); f.cache = {};
  const app = express(), server = createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r));
  f.origin = `http://127.0.0.1:${server.address().port}`;
  app.use((req, res, next) => req.get('host') === new URL(f.origin).host && req.socket.remoteAddress === '127.0.0.1' ? next() : res.sendStatus(403));
  app.get('/__source/steam', async (req, res) => {
    f.calls.push({ path: req.path, steamId: req.query.steamId, memberTransaction: f.db.isTransaction });
    const response = f.responses.get('steam'); if (response) return response(req, res);
    res.json({ steamId: req.query.steamId, nickname: 'Loopback 已采集昵称', avatar: 'https://avatars.steamstatic.com/local.png', profilePublic: true });
  });
  f.readSourceConfig = ({ type }) => ({ enabled: f.policy().tasks[type]?.ready === true,
    sourceId: type === 'kda' ? 'vital' : type.startsWith('battlemetrics_') ? 'battlemetrics' : 'steam' });
  f.adapters = createManagementSourceAdapters({ identity: f.identity, now: () => now, runWrite: f.queue,
    patchCache: records => { for (const r of records) f.cache[r.collection + ':' + r.id] = r.record; },
    authorizeStatsWrite: () => true, readSourceConfig: args => f.readSourceConfig(args),
    readers: { steamProfile: async ({ member, signal }) => {
      const response = await fetch(f.origin + '/__source/steam?steamId=' + member.steamId, { signal });
      if (!response.ok) throw Object.assign(new Error('isolated-source-failed'), { status: response.status });
      return response.json();
    } }
  });
  f.sync = new SyncCenterService({ identity: f.identity, db: f.db, authority: f.adapters.authority, now: () => now });
  f.runtime = createMemberManagementAdapters({ identity: f.identity, syncService: f.sync, runStoreWriteTask: f.queue,
    patchStoreCache: fn => fn(f.cache), publishDomainEvent: () => {}, isTrustedRoot: a => a.id === 'root' });
  f.members = new MemberAdminService(f.identity, f.runtime.adapters);
  f.followups = createMemberFollowups({ identity: f.identity, syncService: f.sync,
    readPolicy: f.policy, readPrincipal: () => f.ir.scalar('fixtureFollowupPrincipal'), readSourceConfig: args => f.readSourceConfig(args) });
  if (startWorker) f.worker = f.followups.startWorker({ providers: f.adapters.providers });
  const identities = createIdentityRouter({ service: f.identity, origin: f.origin, providers: {} });
  app.use('/api/v2', (req, res, next) => { req.v2Identity = { service: f.identity, authenticate: opts => identities.authenticate(opts)(req) }; next(); });
  app.use('/api/v2', identities, createMemberAdminRouter({ getService: () => f.members, writeDomain: f.runtime.writeDomain }));
  f.consumer = createMemberOutboxConsumer({ identity: f.identity, members: f.members, runWrite: f.queue, bundle: {
    // Fixture seam models root's hook after canonical domain replay and before
    // the unchanged original consumer advances its checkpoint.
    writeDomain: async (...args) => {
      const receipt = await f.runtime.writeDomain(...args);
      const rows = f.db.prepare('SELECT seq FROM v2_member_admin_outbox WHERE operation_id=?').all(receipt.operationId);
      if (rows.length !== 1) throw new Error('Fixture requires unique operation ID');
      await f.followups.consume(rows[0].seq); return receipt;
    }
  } });
  f.create = (steamId = '76561198999999111') => f.runtime.writeDomain(() => f.members.create(f.actor(), { steamInput: steamId, fields: {} }, randomUUID()));
  f.latestSeq = () => f.db.prepare('SELECT MAX(seq) n FROM v2_member_admin_outbox').get().n;
  f.jobs = () => f.sync.repo.rows('job', { limit: 501 });
  const sessionFor = await fixtureSessionFactory(f.identity);
  f.headers = (id = 'admin') => { const session = sessionFor(id);
    return { Cookie: `nb_v2_session=${session.token}`, Origin: f.origin, 'Content-Type': 'application/json',
      'X-CSRF-Token': session.csrfToken, 'Idempotency-Key': randomUUID() }; };
  f.drain = async () => { for (let i = 0; i < 30; i++) { if (!await f.worker.step()) break; f.advance(2000); } };
  f.close = async () => { await f.followups.stop(); await identities.stopEvents(); server.closeAllConnections(); await new Promise(r => server.close(r)); f.db.close(); };
  return f;
}
