import { fixtureIdentity } from '../scoped-identity-fake.mjs';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { CAPABILITIES, grant } from '../../../server/v2/identity/permissions.js';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { readSqliteScalar, upsertSqliteScalar } from '../../../server/storage/sqlite-migrate.js';
import { migrateMemberAdmin } from '../../../server/v2/member-admin/migration.js';
import { MemberAdminService } from '../../../server/v2/member-admin/service.js';
export function fixture(filename = ':memory:', { scopeContract = false } = {}) {
  if (filename && typeof filename === 'object') { scopeContract = filename.scopeContract === true; filename = filename.filename || ':memory:'; }
  const db = new DatabaseSync(filename);
  installIdentitySchema(db);
  installSchedulingSchema(db);
  const ir = new IdentityRepository(db),
    sr = new SchedulingRepository(db);
  ir.setScalar('v2IdentityMigration', {
    isolated: true
  });
  sr.setScalar('v2SchedulingMigration', {
    isolated: true
  });
  const now = () => Date.parse('2030-09-08T10:00:00Z');
  const identity = fixtureIdentity(ir, {
    scopeContract, now
  });
  for (const [sid, name] of [['s1', '先锋一队'], ['s2', '后勤二队']]) ir.put('squads', {
    id: sid,
    name,
    leaderUserIds: [sid === 's1' ? 'leader' : 'other'],
    leaderUserId: sid === 's1' ? 'leader' : 'other',
    revision: 1,
    notes: '内部小队备注'
  });
  const names = ['林舟', '小雨', '阿北', '远山', '青禾'];
  for (let n = 1; n <= 65; n++) {
    const mid = `m${String(n).padStart(3, '0')}`,
      sid = n <= 35 ? 's1' : 's2';
    ir.put('members', {
      id: mid,
      steamId: `7656119800${String(n).padStart(7, '0')}`,
      customName: n <= 5 ? names[n - 1] : `构造成员 ${String(n).padStart(2, '0')}`,
      memberStatus: 'active',
      membershipStatus: 'active',
      specialty: ['building'],
      phone: 'private-phone',
      notes: 'private-notes',
      revision: 1,
      createdAt: '2030-08-01T10:00:00Z'
    });
    ir.put('squadMembers', {
      id: 'sm' + n,
      memberId: mid,
      squadId: sid,
      createdAt: '2030-08-01T10:00:00Z'
    });
  }
  const accounts = [['admin', null, CAPABILITIES.map(c => grant(c, {
    type: 'all'
  }))], ['root', null, CAPABILITIES.map(c => grant(c, {
    type: 'all'
  }))], ['leader', 'm001', ['members.read', 'members.basic_edit', 'squads.read', 'squads.manage', 'sync.run'].map(c => grant(c, {
    type: 'squads',
    ids: ['s1']
  }))], ['other', 'm036', []], ['member', 'm002', []], ['viewer', null, [grant('members.read', {
    type: 'all'
  })]]];
  for (const [aid, mid, grants] of accounts) {
    ir.put('accounts', {
      id: aid,
      roleId: ['admin', 'root'].includes(aid) ? 'admin' : 'member',
      adminAssignedByOwner: ['admin', 'root'].includes(aid),
      memberId: mid,
      status: 'active',
      revision: 1,
      permissionVersion: 1,
      grants
    });
    if (mid) ir.put('bindings', {
      id: 'binding-' + aid,
      accountId: aid,
      memberId: mid,
      steamId: ir.get('members', mid).steamId,
      status: 'verified'
    });
  }
  const adapters = {
    isTrustedRoot: a => a.id === 'root',
    saveRiskSettings({
      db,
      settings,
      tx
    }) {
      const old = readSqliteScalar(db, 'settings') || {};
      const next = {
        ...old,
        accountRisk: settings
      };
      upsertSqliteScalar(db, 'settings', next);
      tx.changes.push({
        collection: 'settings',
        scalar: true,
        record: next
      });
      return settings;
    },
    // Controlled platform-domain adapter. G07 must not mark these links verified or create website identity.
    linkWechat({
      member,
      wechatUser,
      tx
    }) {
      tx.put('members', {
        ...member,
        wechatUserId: wechatUser.id,
        wechatId: wechatUser.id
      });
      tx.put('wechatUsers', {
        ...wechatUser,
        memberId: member.id,
        status: 'approved',
        updatedAt: tx.stamp
      });
      return {
        memberId: member.id
      };
    }
  };
  const migration = migrateMemberAdmin(db, {
    apply: true,
    now: new Date(now()).toISOString()
  });
  const service = new MemberAdminService(identity, adapters);
  service.repo.put('memberProfiles', {
    id: 'profile-m001',
    memberId: 'm001',
    steamId: ir.get('members', 'm001').steamId,
    playTimeKnown: true,
    playTimeVisibility: 'public',
    playTimeMinutes: 3000,
    inventoryPublic: true,
    inventoryVisibility: 'public',
    inventoryValue: 12,
    accountRestricted: true,
    officialKda: {
      kda: 0.8,
      kills: 10,
      deaths: 12,
      rockets: 2
    },
    fetchedAt: '2030-09-08T09:00:00Z'
  });
  service.repo.put('wechatUsers', {
    id: 'wx1',
    status: 'pending',
    nickname: '待审核新人',
    openid: 'fixture-secret-not-for-http'
  });
  service.repo.put('joinApplications', {
    id: 'review1',
    steamId: '76561198999999001',
    steamNickname: '待审核新人',
    wechatUserId: 'wx1',
    specialties: ['pvp'],
    status: 'pending',
    revision: 1,
    reason: '参加周末开荒',
    notes: '擅长侦查',
    createdAt: '2030-09-08T09:00:00Z'
  });
  service.repo.put('discordMemberApplications', {
    id: 'archive1',
    steamId: '76561198999999002',
    displayName: '旧 Discord 申请',
    status: 'approved',
    reviewNote: '历史通过',
    createdAt: '2026-08-01T09:00:00Z',
    secret: 'must-not-return'
  });
  return {
    db,
    ir,
    sr,
    identity,
    service,
    adapters,
    migration,
    actor: aid => identity.actorForAccount(aid),
    now
  };
}
