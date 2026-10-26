import { fixtureIdentity } from '../scoped-identity-fake.mjs';
import { installSchedulingSchema, SchedulingRepository } from '../../../server/v2/scheduling/repository.js';
import { applySchedulingMigration, planSchedulingMigration } from '../../../server/v2/scheduling/migration.js';
import { DatabaseSync } from 'node:sqlite';
import { installIdentitySchema, IdentityRepository } from '../../../server/v2/identity/repository.js';
import { applyIdentityMigration, planIdentityMigration } from '../../../server/v2/identity/migration.js';
import { IdentityService } from '../../../server/v2/identity/service.js';
import { seedIdentities } from '../v2-member-space/fixtures.mjs';
import { installRealtimeSchema, RealtimeRepository } from '../../../server/v2/realtime/repository.js';
import { createRelaySourceAdapter } from '../../../server/v2/realtime/source.js';
import { RealtimeService } from '../../../server/v2/realtime/service.js';
import { normalizeRustplusRelayPayload } from '../../../server/rustplus-relay.js';
export function fixture(file = ':memory:', { scopeContract = false } = {}) {
  if (file && typeof file === 'object') { scopeContract = file.scopeContract === true; file = file.file || ':memory:'; }
  const db = new DatabaseSync(file);
  installIdentitySchema(db);
  const ir = new IdentityRepository(db);
  applyIdentityMigration(ir, planIdentityMigration({}));
  seedIdentities(ir);
  installSchedulingSchema(db);
  applySchedulingMigration(new SchedulingRepository(db), planSchedulingMigration({}));
  installRealtimeSchema(db);
  let clock = Date.now();
  const now = () => clock,
    identity = fixtureIdentity(ir, {
      scopeContract, providers: {},
      now
    }),
    repo = new RealtimeRepository(db);
  for (const key of ['alpha', 'foreign']) {
    const a = ir.get('accounts', 'g05_account_' + key);
    ir.put('accounts', {
      ...a,
      grants: [...a.grants, ...['relay.read', 'relay.chat_read'].map(capability => ({
        capability,
        effect: 'allow',
        scope: {
          type: 'squads',
          ids: [key === 'alpha' ? 'g05_squad' : 'g05_foreign_squad']
        }
      }))]
    });
  }
  for (const [id, sourceId, serverId, squadId, label] of [['alpha', 'collector-a', 'server-a', 'g05_squad', '北境一服'], ['beta', 'collector-b', 'server-b', 'g05_foreign_squad', '北境二服'], ['empty', 'collector-a', 'empty', 'g05_squad', '未上报来源']]) repo.bind({
    id,
    sourceId,
    serverKey: `${sourceId}:${serverId}`,
    resource: {
      kind: 'squad',
      id: squadId
    },
    label
  });
  const source = createRelaySourceAdapter({
    repository: repo,
    normalizePayload: normalizeRustplusRelayPayload,
    now
  });
  const ingest = (id, payload) => {
    const s = repo.scope(id);
    return source.ingest(id, {
      ...payload,
      client: {
        id: s.source,
        name: s.source
      },
      server: {
        id: s.server.slice(s.source.length + 1),
        name: s.label
      }
    }, {
      sourceEpoch: s.epoch
    });
  };
  const seedSnapshot = (id, at = new Date(clock).toISOString()) => ingest(id, {
    type: 'clan_snapshot',
    snapshot: {
      capturedAt: at,
      clanId: 'constructed_clan_' + id,
      name: 'NB 北境战队',
      announcement: '今晚先集合，再进服。',
      members: [{
        steamId: id === 'alpha' ? '76561198000000501' : '76561198000000505',
        displayName: id === 'alpha' ? '阿北' : '另一队成员',
        online: true,
        lastOnlineAt: at,
        onlineTimeMinutes: 120
      }, {
        steamId: '76561198000000999',
        displayName: '尚未登记的访客',
        online: false,
        lastOfflineAt: at
      }],
      invites: [{
        steamId: '76561198000000888',
        displayName: '待加入队友'
      }]
    }
  });
  seedSnapshot('alpha');
  seedSnapshot('beta');
  function chat(id = 'alpha', n = 1) {
    return ingest(id, {
      type: 'clan_chat_message',
      message: {
        id: `${id}-message-${n}`,
        steamId: id === 'alpha' ? '76561198000000501' : '76561198000000505',
        displayName: id === 'alpha' ? '阿北' : '另一队成员',
        message: `Hold the north gate ${n}`,
        translatedMessage: `守住北门 ${n}`,
        sentAt: new Date(clock + n).toISOString(),
        channel: 'clan'
      }
    });
  }
  for (let n = 1; n <= 125; n++) chat('alpha', n);
  for (let n = 1; n <= 3; n++) chat('beta', n);
  for (let n = 1; n <= 65; n++) ingest('alpha', {
    type: 'clan_invite_record',
    invite: {
      id: `invite-${n}`,
      steamId: '76561198000000888',
      displayName: `待加入队友 ${n}`,
      inviterSteamId: '76561198000000501',
      inviterName: '阿北',
      status: n % 2 ? 'pending' : 'accepted',
      sentAt: new Date(clock + n).toISOString()
    }
  });
  const options = {
    repository: repo,
    now,
    authorizeLegacyAction: a => a.id === 'g05_account_admin',
    sourceReset: ({
      apply
    }) => apply()
  };
  const service = new RealtimeService(identity, options);
  return {
    db,
    ir,
    identity,
    repo,
    source,
    service,
    options,
    ingest,
    chat,
    seedSnapshot,
    now,
    advance: ms => clock += ms,
    actor: key => identity.actorForAccount('g05_account_' + key)
  };
}
