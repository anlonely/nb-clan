import { createRustgoWebApiWorker } from '../relay-admin/web-api-worker.js';

export function createProductionRustgoWebApi({ identity, repository, configuration, client, ingestRelay, runOperation, serializeWrite }) {
  const write = fn => runOperation(() => serializeWrite(fn));
  return createRustgoWebApiWorker({ client, readConfig: () => configuration.readPrivate(),
    readProgress: () => identity.repo.scalar('v2RustgoWebApiProgress'),
    writeProgress: (progress, assertCurrent) => write(() => { assertCurrent(); identity.repo.setScalar('v2RustgoWebApiProgress', progress); }),
    ingest: ingestRelay,
    invalidateSource: (sourceId, serverId, assertCurrent) => write(() => {
      assertCurrent();
      const scope = repository.scopes().find(row => row.source === sourceId && row.server === `${sourceId}:${serverId}`);
      if (!scope?.snapshot || Date.parse(scope.snapshot.expiresAt) <= Date.now()) return;
      repository.transaction(() => {
        scope.snapshot.expiresAt = new Date().toISOString();
        repository.db.prepare('UPDATE v2_realtime_scopes SET snapshot=?,revision=revision+1 WHERE id=?').run(JSON.stringify(scope.snapshot), scope.id);
        repository.emit(scope.id, 'roster.changed', {}, Date.now());
      });
      repository.notify(scope.id);
    })
  });
}
