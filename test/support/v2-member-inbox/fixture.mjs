import { fixtureIdentity } from '../scoped-identity-fake.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IdentityRepository, installIdentitySchema } from '../../../server/v2/identity/repository.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { SchedulingService } from '../../../server/v2/scheduling/service.js';
import { installPlatformAdminSchema } from '../../../server/v2/platform-admin/repository.js';
import { MemberInboxService, installMemberInboxSchema, createMemberInboxDomainAdapters } from '../../../server/v2/member-inbox/index.js';
import { upsertSqliteCollectionRecord } from '../../../server/storage/sqlite-migrate.js';

export function fixture({ install = true, scopeContract = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'nb-member-inbox-')), db = new DatabaseSync(join(directory, 'isolated.sqlite'));
  installIdentitySchema(db); installSchedulingSchema(db); installPlatformAdminSchema(db);
  const repo = new IdentityRepository(db), sr = new SchedulingRepository(db);
  repo.setScalar('v2IdentityMigration', { isolated: true }); sr.setScalar('v2SchedulingMigration', { isolated: true });
  const now = () => Date.parse('2030-09-08T10:00:00.000Z');
  const identity = fixtureIdentity(repo, { scopeContract, now });
  for (const accountId of ['alice', 'bob']) {
    repo.put('accounts', { id: accountId, status: 'active', memberId: null, revision: 1, permissionVersion: 1, grants: [] });
    for (const appId of ['app-a', 'app-b']) {
      // Existing shared schema still has a global legacy openid unique index.
      const openid = `${accountId}-${appId}-openid`;
      repo.put('identities', { id: `${accountId}:${appId}`, provider: `wechat:${appId}`, externalId: openid,
        accountId, verifiedAt: '2030-01-01T00:00:00Z', revision: 1 });
      repo.put('wechatUsers', { id: `${accountId}-${appId}`, appId, openid, accountId,
        status: 'guest', revision: 1, nickname: accountId, subscriptionPreferences: {} });
    }
  }
  const config = { appId: 'app-a', enabled: true, revision: 1, subscriptionTemplates: { wipeReminder: 'template-reminder', wipeOpen: 'template-open' } };
  const state = { db, repo, identity, config, directory, now, cache: {}, queueCalls: 0,
    actor: id => identity.actorForAccount(id), close() { db.close(); rmSync(directory, { recursive: true, force: true }); } };
  let tail = Promise.resolve();
  state.queue = fn => { state.queueCalls++; const r = tail.then(fn); tail = r.catch(() => {}); return r; };
  state.options = { identity, appId: 'app-a', now, readConfig: () => config,
    runStoreWriteTask: state.queue, patchStoreCache: fn => { if (state.cacheFailure) throw new Error('isolated cache failure'); fn(state.cache); } };
  if (install) { installMemberInboxSchema(db); state.service = new MemberInboxService(state.options);
    state.adapters = createMemberInboxDomainAdapters({ service: state.service }); }
  state.scheduling = new SchedulingService(sr, identity);
  state.putNotification = (id, owner = 'alice-app-a', extra = {}) => {
    const row = { id, wechatUserId: owner, type: 'review_result', title: '审核结果', body: '请查看资料',
      status: 'need_more', adminNote: `仅收件人可见-${owner}`, createdAt: '2030-09-08T09:00:00.000Z', readAt: '', ...extra };
    upsertSqliteCollectionRecord(state.db, 'wechatNotifications', id, row);
    return row;
  };
  return state;
}
