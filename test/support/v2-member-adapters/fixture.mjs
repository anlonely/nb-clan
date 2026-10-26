import { fixture as base } from '../v2-member-admin/fixtures.mjs';
import { AuthContexts } from '../../../server/v2/identity/contexts.js';
import { MemberAdminService } from '../../../server/v2/member-admin/service.js';
import { createMemberManagementAdapters, createMemberContextInvalidator, createMemberServiceBridges,
  createRealtimeMemberAdapter } from '../../../server/v2/management-adapters/members/index.js';
import { installSyncCenterSchema } from '../../../server/v2/sync-center/repository.js';
import { createSqliteSyncAuthority } from '../../../server/v2/sync-center/authority.js';
import { SyncCenterService } from '../../../server/v2/sync-center/service.js';
import { RealtimeRepository, installRealtimeSchema } from '../../../server/v2/realtime/repository.js';
import { RealtimeService } from '../../../server/v2/realtime/service.js';

export function fixture(options = {}) {
  const x = base({ scopeContract: options.scopeContract === true });
  let time = x.identity.now();
  x.identity.now = () => time;
  x.advance = ms => { time += ms; };
  let queue = Promise.resolve();
  x.queueCalls = 0;
  x.queue = fn => { x.queueCalls++; const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  x.cache = {}; x.events = []; x.contexts = new AuthContexts({ now: x.identity.now });
  x.contextInvalidator = createMemberContextInvalidator({ authContexts: x.contexts, invalidatePlatformSessions: () => {} });
  installSyncCenterSchema(x.db);
  x.sync = new SyncCenterService({ identity: x.identity, db: x.db, now: x.identity.now,
    authority: createSqliteSyncAuthority({ identity: x.identity, serializeWrite: x.queue }) });
  x.runtime = createMemberManagementAdapters({ identity: x.identity, syncService: x.sync,
    contexts: x.contextInvalidator,
    isTrustedRoot: actor => actor.id === 'root', runStoreWriteTask: x.queue,
    patchStoreCache: fn => { if (x.cacheFailure) throw new Error('isolated cache failure'); fn(x.cache); },
    publishDomainEvent: e => x.events.push(e), ...options });
  x.service = new MemberAdminService(x.identity, x.runtime.adapters);
  x.bridges = createMemberServiceBridges({ memberService: x.service, writeDomain: x.runtime.writeDomain });
  installRealtimeSchema(x.db);
  const repository = new RealtimeRepository(x.db);
  repository.bind({ id: 'scope-one', sourceId: 'relay-one', serverKey: 'server-one', resource: { kind: 'squad', id: 's1' } });
  x.db.prepare('UPDATE v2_realtime_scopes SET snapshot=?,observed=?,received=?,revision=7 WHERE id=?').run(
    JSON.stringify({ members: [{ steamId: '76561198999999888', displayName: '来源中的玩家' }] }),
    new Date(time).toISOString(), new Date(time).toISOString(), 'scope-one');
  x.realtime = new RealtimeService(x.identity, { repository, now: x.identity.now,
    authorizeLegacyAction: a => a.id === 'admin' });
  x.realtime.members = createRealtimeMemberAdapter({ memberService: x.service, realtimeService: x.realtime, writeDomain: x.runtime.writeDomain });
  x.write = fn => x.runtime.writeDomain(fn, { identity: x.identity });
  return x;
}
