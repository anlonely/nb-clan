import { fixtureIdentity } from '../scoped-identity-fake.mjs';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { IdentityRepository, installIdentitySchema } from '../../../server/v2/identity/repository.js';
import { applyIdentityMigration, planIdentityMigration } from '../../../server/v2/identity/migration.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { SchedulingRepository, installSchedulingSchema } from '../../../server/v2/scheduling/repository.js';
import { applySchedulingMigration, planSchedulingMigration } from '../../../server/v2/scheduling/migration.js';
import { MemberSpaceService } from '../../../server/v2/member-space/service.js';
import { seedIdentities } from '../v2-member-space/fixtures.mjs';
import { createPlatformMediaOwner, installPlatformMediaSchema, createPinnedMediaFetch, nodePinnedMediaRequest } from '../../../server/v2/platform-media/index.js';
import { digest, need } from '../../../server/v2/platform-media/model.js';
export const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
export const delay = ms => new Promise(r => setTimeout(r, ms));
export const png = await readFile(new URL('./images/avatar.png', import.meta.url));
export const jpeg = await readFile(new URL('./images/avatar.jpg', import.meta.url));
export const webp = await readFile(new URL('./images/avatar.webp', import.meta.url));
export const upload = (expectedRevision = 0, bytes = png, contentType = 'image/png') => ({ expectedRevision, sha256: digest(bytes), dataUrl: `data:${contentType};base64,${bytes.toString('base64')}` });
export const response = (bytes = png, type = 'image/png', status = 200) => ({ status, headers: new Headers({ 'content-type': type }), body: (async function* () { yield bytes; })() });

export function fixture({ file = ':memory:', schema = true, options = {}, scopeContract = false } = {}) {
  const db = new DatabaseSync(file); installIdentitySchema(db); const repo = new IdentityRepository(db);
  applyIdentityMigration(repo, planIdentityMigration({})); installSchedulingSchema(db); const sr = new SchedulingRepository(db);
  applySchedulingMigration(sr, planSchedulingMigration({})); seedIdentities(repo);
  if (schema) installPlatformMediaSchema(db);
  for (const appId of ['appA', 'appB']) for (const name of ['alpha', 'beta', 'foreign']) {
    const suffix = appId === 'appB' ? '_appB' : '', memberId = `g05_${name}${suffix}`, accountId = `g05_account_${name}${suffix}`;
    if (suffix) {
      const steamId = String(BigInt(repo.get('members', `g05_${name}`).steamId) + 100n);
      repo.put('members', { ...repo.get('members', `g05_${name}`), id: memberId, steamId });
      repo.put('accounts', { ...repo.get('accounts', `g05_account_${name}`), id: accountId, memberId });
      repo.put('bindings', { ...repo.get('bindings', `binding_${name}`), id: `binding_${name}_appB`, accountId, memberId, steamId });
    }
    repo.put('identities', { id: `wx_${appId}_${name}`, accountId, provider: `wechat:${appId}`, externalId: `open_${name}${suffix}`,
      verifiedAt: new Date().toISOString(), proofSource: 'isolated_fixture_not_real_auth', revision: 1 });
    repo.put('wechatUsers', { id: `wxuser_${appId}_${name}`, appId, openid: `open_${name}${suffix}`, memberId, avatarUrl: '', nickname: name });
  }
  const identity = fixtureIdentity(repo, { scopeContract, providers: {} }), memberSpace = new MemberSpaceService(identity);
  const configs = { appA: { enabled: true, appId: 'appA', generation: 1 }, appB: { enabled: true, appId: 'appB', generation: 1 } };
  const state = { cache: { wechatUsers: [], uploads: [] }, writes: 0, cacheWrites: 0, tokenCalls: [], exchanges: [], cacheFailure: false, ready: true };
  let chain = Promise.resolve();
  const runStoreWriteTask = fn => { state.writes++; const job = chain.then(fn); chain = job.catch(() => {}); return job; };
  const owners = [];
  const owner = (appId = 'appA', extra = {}) => {
    const value = createPlatformMediaOwner({ identity, memberSpace, appId, readConfig: () => configs[appId], runStoreWriteTask,
      patchStoreCache: async apply => { state.cacheWrites++; if (state.cacheFailure) throw Error('cache failed'); await apply(state.cache); },
      getAccessToken: async args => { state.tokenCalls.push({ appId: args.appId, generation: args.generation }); return { appId, generation: args.generation, accessToken: `isolated-token-${appId}-${args.generation}` }; },
      exchangeCode: async args => { state.exchanges.push({ appId: args.appId, page: args.page, scene: args.scene, token: args.accessToken }); return response(); }, ...options, ...extra });
    owners.push(value); return value;
  };
  const args = (input = {}, name = 'alpha', appId = 'appA', operationId = 'media-operation-1') => {
    const suffix = appId === 'appB' ? '_appB' : '', accountId = `g05_account_${name}${suffix}`;
    return { input, operationId, actor: identity.actorForAccount(accountId),
      assertCurrent: () => { need(state.ready, 'MINI_SESSION_REVOKED', 401); return identity.actorForAccount(accountId); },
      subject: () => ({ verified: true, appId, externalId: `open_${name}${suffix}`, accountId }) };
  };
  return { db, repo, identity, memberSpace, configs, state, owner, args, runStoreWriteTask,
    close: async () => { await Promise.all(owners.map(o => o.stop())); await chain; db.close(); } };
}
export async function loopbackServer(handler) {
  const server = http.createServer(handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: () => new Promise(r => { server.closeAllConnections(); server.close(r); }),
    fetch: createPinnedMediaFetch({ loopbackTestOrigin: origin, lookup: async () => [{ address: '127.0.0.1', family: 4 }], request: nodePinnedMediaRequest }) };
}
