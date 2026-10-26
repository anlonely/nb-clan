import { openSqliteDatabase, sqlitePrimaryMode } from '../../storage/sqlite.js';
import { IdentityRepository } from './repository.js';
import { IdentityService } from './service.js';
import { createProviders, providerConfiguration } from './providers.js';
import { createIdentityRouter } from './routes.js';
import { v2IdentityEnabled } from './legacy.js';
import { runStoreWriteTask, patchStoreCache } from '../../store.js';
import { assertLocalMode } from '../../local-mode.js';
import { AuthContexts } from './contexts.js';

export function identityRuntimeMiddleware(deps) {
  const contextOwners = new WeakMap();
  let initialized, stopped = false;
  const getRuntime = async () => {
    if (stopped) throw new Error('Identity runtime stopped');
    if (!v2IdentityEnabled()) throw new Error('V2 identity disabled');
    try {
      if (!sqlitePrimaryMode()) throw new Error('SQLite primary required');
      initialized ||= (async () => {
        const config = providerConfiguration();
        const repo = new IdentityRepository(await openSqliteDatabase());
        if (!repo.scalar('v2IdentityMigration')) throw new Error('Identity migration has not completed');
        const providers = createProviders(config, { settings: deps.readSettingsRuntimeStore });
        const service = new IdentityService(repo, { providers, origin: config.origin, ownerPasswordLogin: process.env.NB_OWNER_PASSWORD_LOGIN === '1' });
        const contexts = new AuthContexts();
        contextOwners.set(service, contexts);
        const passwordProof = deps.createPasswordProof?.(service);
        const router = createIdentityRouter({ service, providers, origin: config.origin, ...deps, contexts, passwordProof, localMode: assertLocalMode(),
          writeIdentity: fn => runStoreWriteTask(async () => {
            const result = fn();
            const account = repo.get('accounts', result.accountId);
            const member = account?.memberId && repo.get('members', account.memberId);
            if (member) await patchStoreCache(store => {
              const position = store.members.findIndex(m => m.id === member.id);
              if (position < 0) store.members.push(member); else store.members[position] = member;
              const memberships = repo.all('squadMembers').filter(row => row.memberId === member.id);
              store.squadMembers = [...(store.squadMembers || []).filter(row => row.memberId !== member.id), ...memberships];
              if (result.closed) {
                const user = account.legacyUserId && repo.get('users', account.legacyUserId);
                if (user) { const index = store.users.findIndex(u => u.id === user.id); if (index >= 0) store.users[index] = user; }
              }
            });
            return result;
          })
        });
        return { router, service, contexts, invalidateAuthContexts: () => contexts.clear() };
      })();
      const runtime = await initialized;
      if (stopped) { await runtime.router.stopEvents(); throw new Error('Identity runtime stopped'); }
      return runtime;
    } catch (error) { initialized = null; throw error; }
  };
  const middleware = async (req, res, next) => {
    if (!v2IdentityEnabled()) return res.status(404).json({ error: { errorCode: 'V2_IDENTITY_DISABLED' } });
    try {
      const { router, service } = await getRuntime();
      // G04+ routes reuse the same server-authenticated actor and scope resolver.
      req.v2Identity = { service, authenticate: options => router.authenticate(options)(req),
        writeMember: fn => runStoreWriteTask(async () => {
          const result = await fn();
          const memberId = result.current?.profile?.id;
          const member = memberId && service.repo.get('members', memberId);
          if (member) await patchStoreCache(store => {
            const index = store.members.findIndex(m => m.id === member.id);
            if (index < 0) store.members.push(member); else store.members[index] = member;
          });
          return result;
        }) };
      router(req, res, next);
    } catch {
      res.status(503).json({ error: { errorCode: 'IDENTITY_SETUP_REQUIRED', messageKey: 'IDENTITY_SETUP_REQUIRED', retryable: true } });
    }
  };
  // Trusted runtime owners use this same service; this never authenticates a
  // browser or invents a worker actor, and ordinary initialization never migrates.
  middleware.getRuntime = getRuntime;
  middleware.legacyCallback = (req, res, next) => {
    if (!v2IdentityEnabled() || req.method !== 'GET' || !/^\/auth\/(discord|kook)\/callback$/.test(req.path)) return next();
    // No legacy authentication middleware or cookie write runs for this alias.
    return middleware(req, res, next);
  };
  middleware.getService = async () => (await getRuntime()).service;
  middleware.getAuthContexts = service => contextOwners.get(service);
  middleware.invalidateAuthContexts = async () => (await getRuntime()).invalidateAuthContexts();
  middleware.stop = async () => {
    stopped = true;
    const runtime = initialized && await initialized.catch(() => null);
    await runtime?.router.stopEvents();
  };
  return middleware;
}
