import { fixtureSessionFactory } from '../authenticated-session.mjs';
import express from 'express';
import { createServer } from 'node:http';
import { fixture as statsFixture } from '../v2-stats/fixture.mjs';
import { grant } from '../../../server/v2/identity/permissions.js';
import { StatsService } from '../../../server/v2/stats/service.js';
import { createIdentityRouter } from '../../../server/v2/identity/routes.js';
import { createStatsRouter } from '../../../server/v2/stats/routes.js';
import { createMemberSpaceRouter } from '../../../server/v2/member-space/routes.js';
import { createBusinessEventsHub } from '../../../server/v2/business-events/index.js';
export const steam = '76561198000000501';
export const publicGrants = () => ['queries.read', 'queries.run'].map(cap => grant(cap, { type: 'querySources', ids: ['member'] }));
export const secrets = ['PRIVATE_PHONE_555', 'PRIVATE_NOTES_555', 'PRIVATE_RISK_555', 'PRIVATE_KOOK_555', 'PRIVATE_WECHAT_555', 'PRIVATE_VIP_DATE_555', 'PRIVATE_MISSED_555'];
export function fixture({ file = ':memory:', renderBinary, providers = {}, scopeContract = false } = {}) {
  const f = statsFixture(file, { renderBinary, scopeContract });
  const member = f.ir.get('members', 'g05_alpha');
  f.ir.put('members', { ...member, phone: secrets[0], notes: secrets[1], riskEvidence: secrets[2], kookId: secrets[3], wechatContactId: secrets[4],
    vitalVipPurchasedAt: secrets[5], lastNotAttendingAt: secrets[6], notAttendingCount: 73,
    avatar: 'https://avatars.steamstatic.com/fixture-public.jpg', profileUrl: 'https://private.invalid/PRIVATE_NOTES_555' });
  const addAccount = (id, grants, extra = {}) => f.ir.put('accounts', { id, roleId: 'test_custom', status: 'active', memberId: null,
    permissionVersion: 1, revision: 1, grants, ...extra });
  addAccount('query_only', publicGrants());
  addAccount('catalog_only', [grant('queries.read', { type: 'querySources', ids: ['vital', 'moose'] })]);
  addAccount('inventory_only', ['inventory.read', 'inventory.query'].map(cap => grant(cap, { type: 'querySources', ids: ['inventory'] })));
  const calls = [];
  const defaults = Object.fromEntries(['official', 'inventory', 'vital', 'moose', 'catalog'].map(sourceId => [sourceId, async input => {
    calls.push({ sourceId, provider: input.provider, steamId: input.steamId });
    return sourceId === 'inventory' ? { steamId: input.steamId, inventory: { status: 'fresh', items: [{ name: '隔离库存物品', quantity: 1 }] } } :
      sourceId === 'catalog' ? { items: [{ id: 'catalog-server', name: `${input.provider || 'vital'} 隔离目录`, serverId: 'fixture-server', providerWipeId: 'fixture-period' }] } :
      { steamId: input.steamId, displayName: '隔离来源玩家', fields: [{ name: '来源', value: sourceId }], rows: [] };
  }]));
  const options = { ...f.options, providers: { ...defaults, ...providers } };
  const service = new StatsService(f.identity, options);
  return { ...f, options, service, calls, addAccount, actor: id => f.identity.actorForAccount(id),
    changes: () => f.db.prepare('SELECT total_changes() n').get().n };
}
export async function httpFixture(f, { worker = false } = {}) {
  const sessionFor = await fixtureSessionFactory(f.identity);
  const app = express(), server = createServer(app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const identityRouter = createIdentityRouter({ service: f.identity, origin, providers: {} });
  const events = createBusinessEventsHub();
  app.use((req, res, next) => {
    if (req.get('host') !== new URL(origin).host || req.socket.remoteAddress !== '127.0.0.1') return res.sendStatus(403);
    res.set('Cache-Control', 'no-store'); next();
  });
  app.get('/__fixture/login/:account', (req, res) => {
    const account = f.ir.get('accounts', req.params.account);
    if (!account) return res.sendStatus(404);
    const session = sessionFor(account.id);
    for (const [key, value] of [['nb_v2_session', session.token], ['nb_v2_csrf', session.csrfToken]])
      res.cookie(key, value, { httpOnly: true, sameSite: 'strict', path: '/api/v2' });
    res.redirect('/admin/stats/query');
  });
  app.use('/api/v2', (req, _res, next) => {
    req.v2Identity = { service: f.identity, authenticate: opts => identityRouter.authenticate(opts)(req) }; next();
  });
  app.use('/api/v2', identityRouter, events.router, createMemberSpaceRouter(), createStatsRouter({}, { getService: () => f.service }));
  app.use('/api', (_req, res) => res.status(404).json({ error: { errorCode: 'ISOLATED_ROUTE_NOT_FOUND' } }));
  let active = null, stopped = false;
  const tick = () => {
    if (active || stopped) return;
    const job = f.db.prepare("SELECT id FROM v2_stats_jobs WHERE status='queued' ORDER BY rowid LIMIT 1").get();
    if (job) active = f.service.runJob(job.id).finally(() => { active = null; });
  };
  const timer = worker ? setInterval(tick, 100) : null;
  return { app, server, origin, identityRouter,
    headers(id, operation = 'public-query-http-operation') {
      const s = sessionFor(id);
      return { Cookie: `nb_v2_session=${s.token}; nb_v2_csrf=${s.csrfToken}`, Origin: origin,
        'Content-Type': 'application/json', 'X-CSRF-Token': s.csrfToken, 'Idempotency-Key': operation };
    },
    async close() { stopped = true; clearInterval(timer); await active; await events.stop(); await identityRouter.stopEvents(); server.closeAllConnections(); await new Promise(r => server.close(r)); }
  };
}
