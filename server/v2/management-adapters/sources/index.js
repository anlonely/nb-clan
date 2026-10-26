import { need } from '../../stats/model.js';
import { authorize } from '../../identity/permissions.js';
import { createSyncSourceAdapters } from '../../sync-center/providers.js';
import { createSourceAuthority } from './authority.js';
import { createSourceCollectors } from './collectors.js';
import { createBattlemetricsReadTransport } from './transport.js';
import { readBattlemetricsIdentity, readBattlemetricsSessions } from './battlemetrics.js';
import { selectVitalWipeForStats } from './vital-wipe-binding.js';
export { installSourceAdapterSchema } from './authority.js';
export { createBattlemetricsReadTransport } from './transport.js';

export function createManagementSourceAdapters(options) {
  options = { ...options, readers: { battlemetricsIdentity: readBattlemetricsIdentity, battlemetricsSessions: readBattlemetricsSessions, ...options.readers } };
  const owner = createSourceAuthority(options);
  const bmRequest = options.battlemetricsQueue && options.readers?.battlemetricsGet
    ? createBattlemetricsReadTransport({ queue: options.battlemetricsQueue, get: options.readers.battlemetricsGet }) : null;
  const { collectors, statsProviders } = createSourceCollectors({ ...options, store: owner.store, bmRequest });
  return { ...owner, collectors, providers: createSyncSourceAdapters(collectors), statsProviders };
}
/** No worker/timer here. Host owns and stops the single SyncCenter worker. */
export function createStatsSyncBridge({ identity, syncService, readSourceConfig, readVitalWipes, bindVitalWipe }) {
  need(syncService?.identity === identity, 'SOURCE_IDENTITY_MISMATCH', 503);
  return {
    enqueueSync: async ({ actor, kind, wipeId, sourceId, operationId, expectedRevision }) => {
      need(kind === 'kda', 'INVALID_DATA');
      const command = ['stats-sync', kind, wipeId, sourceId, expectedRevision];
      // Replay uses the durable receipt before consulting an upstream or the now-newer wipe.
      if (syncService.repo.get('receipt', syncService.receipt(actor, operationId)))
        return syncService.command(actor, operationId, command, () => { need(false, 'OPERATION_NOT_FOUND', 404); });
      const fresh = syncService.fresh(actor), resource = { kind: 'wipe', id: wipeId };
      need(fresh.permissionVersion === actor.permissionVersion, 'PERMISSIONS_CHANGED', 401);
      authorize(fresh, 'wipes.read', resource, identity.relations());
      authorize(fresh, 'sync.run', resource, identity.relations());
      const expectedWipe = identity.repo.get('schedulingWipes', wipeId);
      need(expectedWipe && expectedWipe.revision === expectedRevision, 'REVISION_CONFLICT', 409);
      need(['scheduled', 'active'].includes(expectedWipe.lifecycle), 'WIPE_IMMUTABLE', 409);
      const context = { type: 'kda', scope: { kind: 'current_wipe', id: wipeId, wipeId } };
      const initial = readSourceConfig(context);
      need(initial && !initial.then && initial.sourceId === sourceId, 'SOURCE_CONTEXT_CHANGED', 409);
      let binding;
      if (sourceId === 'vital' && !initial.providerWipeId) {
        need(typeof readVitalWipes === 'function' && typeof bindVitalWipe === 'function', 'SOURCE_CONTEXT_CHANGED', 409);
        // Network I/O is outside the common writer and SQLite transaction.
        binding = selectVitalWipeForStats(expectedWipe, initial.providerServerId,
          await readVitalWipes(initial.providerServerId, { signal: AbortSignal.timeout(15000) }), syncService.now());
      }
      return syncService.command(actor, operationId, command, currentActor => {
        if (binding) bindVitalWipe({ actor: currentActor, expectedWipe, binding });
        else {
          const wipe = identity.repo.get('schedulingWipes', wipeId);
          need(wipe && wipe.revision === expectedRevision, 'REVISION_CONFLICT', 409);
        }
        const config = readSourceConfig(context);
        need(config && !config.then && config.enabled !== false && config.sourceId === sourceId, 'SOURCE_CONTEXT_CHANGED', 409);
        return syncService.insert(currentActor, { type: 'kda', scope: { kind: 'current_wipe', id: wipeId } }, { operationId });
      });
    },
    readSync: ({ actor, jobId }) => syncService.detail(actor, jobId)
  };
}
