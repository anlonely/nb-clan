import { createSystemCacheAdapter } from '../system-admin/cache-adapter.js';
import { createSystemIdentityAdapter } from '../system-admin/identity-adapter.js';
import { createSystemWriteOwner, SystemAdminService } from '../system-admin/service.js';
import { createSystemAdminRouter } from '../system-admin/routes.js';

export function createManagedSystem({ identity, runStoreWriteTask, patchStoreCache,
  invalidateAuthContexts, invalidateProxySettings, publishDomainEvent, options }) {
  const patchCache = createSystemCacheAdapter({ identity, patchStoreCache, invalidateProxySettings,
    publishSystemEvent: () => publishDomainEvent(identity) });
  const owner = createSystemWriteOwner({ runWrite: runStoreWriteTask, patchCache, invalidateAuthContexts });
  const service = new SystemAdminService({ ...options, identity, identityAdmin: createSystemIdentityAdapter(identity), owner });
  return { service, owner, router: createSystemAdminRouter({ service }) };
}
