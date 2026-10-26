import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { closeSqliteDatabasesForTests, openSqliteDatabase, sqliteRuntimeStats } from '../server/storage/sqlite.js';
import {
  ensureSqliteSchema,
  findSqliteCollectionRecordByJsonField,
  listSqliteCollectionRecordsByJsonField,
  listSqliteCollectionRecordsByJsonFieldNoCase,
  listSqliteCollectionRecordsByJsonFields,
  listSqliteCollectionRecordsWhereJsonFieldPresent,
  upsertSqliteCollectionRecord
} from '../server/storage/sqlite-migrate.js';

const execFileAsync = promisify(execFile);

async function seedSqlite(sqliteFile, collections, { allowInvalidBusinessDuplicates = false } = {}) {
  const db = await openSqliteDatabase(sqliteFile);
  ensureSqliteSchema(db);
  if (allowInvalidBusinessDuplicates) {
    const uniqueIndexes = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
        AND tbl_name = 'json_records'
        AND sql LIKE 'CREATE UNIQUE INDEX%'
    `).all();
    for (const { name } of uniqueIndexes) {
      if (!/^uidx_json_records_[A-Za-z0-9_]+$/.test(name)) {
        throw new Error(`Unexpected SQLite unique index name: ${name}`);
      }
      db.exec(`DROP INDEX IF EXISTS "${name}"`);
    }
  }
  for (const [collection, records] of Object.entries(collections)) {
    records.forEach((record, index) => {
      upsertSqliteCollectionRecord(db, collection, record.id || record.key || `${collection}_${index}`, record, {
        position: index,
        updatedAt: record.updatedAt || record.createdAt || '2026-07-07T00:00:00.000Z'
      });
    });
  }
  await closeSqliteDatabasesForTests();
}

async function runIntegrity(sqliteFile) {
  try {
    const result = await execFileAsync(process.execPath, [
      'scripts/sqlite-integrity-check.js',
      '--sqlite',
      sqliteFile,
      '--max-samples',
      '5'
    ], { cwd: path.resolve('.') });
    return {
      code: 0,
      payload: JSON.parse(result.stdout)
    };
  } catch (error) {
    return {
      code: error.code || 1,
      payload: JSON.parse(error.stdout)
    };
  }
}

async function runIndexCheck(sqliteFile) {
  try {
    const result = await execFileAsync(process.execPath, [
      'scripts/sqlite-index-check.js',
      '--sqlite',
      sqliteFile
    ], { cwd: path.resolve('.') });
    return {
      code: 0,
      payload: JSON.parse(result.stdout)
    };
  } catch (error) {
    return {
      code: error.code || 1,
      payload: JSON.parse(error.stdout)
    };
  }
}

async function withTempSqlite(name, fn) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), `nb-clan-${name}-`));
  const sqliteFile = path.join(dataDir, 'nb-clan.sqlite');
  try {
    return await fn(sqliteFile);
  } finally {
    await closeSqliteDatabasesForTests();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('sqlite index check covers composite indexes and business uniqueness constraints', async () => {
  await withTempSqlite('sqlite-index-coverage', async (sqliteFile) => {
    await seedSqlite(sqliteFile, {});

    const result = await runIndexCheck(sqliteFile);
    assert.equal(result.code, 0, JSON.stringify(result.payload));
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.fields.missing.length, 0);
    assert.equal(result.payload.nocase.missing.length, 0);
    assert.equal(result.payload.composites.missing.length, 0);
    assert.equal(result.payload.businessUniqueConstraints.missing.length, 0);
    assert.equal(result.payload.businessUniqueConstraints.covered, result.payload.businessUniqueConstraints.expected);
    assert.equal(result.payload.nocase.expected > 0, true);
    assert.equal(result.payload.composites.expected > 0, true);
    assert.equal(result.payload.businessUniqueConstraints.expected > 0, true);
  });
});

test('sqlite schema replaces the legacy sync job uniqueness index for Vital Wipe rollover', async () => {
  await withTempSqlite('sqlite-sync-job-index-migration', async (sqliteFile) => {
    await seedSqlite(sqliteFile, {});
    let db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    db.exec(`
      DROP INDEX IF EXISTS uidx_json_records_syncJobs_type_scope_targetWipeId_targetVitalWipeId_targetServerId;
      CREATE UNIQUE INDEX uidx_json_records_syncJobs_type_scope_targetWipeId_targetServerId
      ON json_records(
        COALESCE(NULLIF(TRIM(CAST(json_extract(payload_json, '$.type') AS TEXT)), ''), 'custom'),
        COALESCE(NULLIF(TRIM(CAST(json_extract(payload_json, '$.scope') AS TEXT)), ''), 'custom'),
        COALESCE(NULLIF(TRIM(CAST(json_extract(payload_json, '$.targetWipeId') AS TEXT)), ''), '-'),
        COALESCE(NULLIF(TRIM(CAST(json_extract(payload_json, '$.targetServerId') AS TEXT)), ''), '-')
      )
      WHERE collection = 'syncJobs'
        AND NULLIF(TRIM(CAST(json_extract(payload_json, '$.status') AS TEXT)), '') IN ('queued', 'running');
    `);
    await closeSqliteDatabasesForTests();

    db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    const indexes = new Set(db.prepare("PRAGMA index_list('json_records')").all().map((row) => row.name));
    assert.equal(indexes.has('uidx_json_records_syncJobs_type_scope_targetWipeId_targetServerId'), false);
    assert.equal(indexes.has('uidx_json_records_syncJobs_type_scope_targetWipeId_targetVitalWipeId_targetServerId'), true);
  });
});

test('sqlite nocase username index preserves login lookup semantics', async () => {
  await withTempSqlite('sqlite-username-nocase-index', async (sqliteFile) => {
    await seedSqlite(sqliteFile, {
      users: [
        { id: 'user_username_nocase', username: 'RootCaseUser', role: 'admin' }
      ]
    });
    const result = await runIndexCheck(sqliteFile);
    assert.equal(result.code, 0, JSON.stringify(result.payload));
    assert.equal(result.payload.nocase.missing.length, 0);

    const db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    const rows = listSqliteCollectionRecordsByJsonFieldNoCase(db, 'users', 'username', ['rootcaseuser'], { limit: 0 });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'user_username_nocase');
  });
});

test('sqlite id field reads use the collection primary key path without changing lookup semantics', async () => {
  await withTempSqlite('sqlite-id-field-read', async (sqliteFile) => {
    await seedSqlite(sqliteFile, {
      members: [
        { id: 'member_id_read_1', steamId: '76561198001004001', nickname: 'First' },
        { id: 'member_id_read_2', steamId: '76561198001004002', nickname: 'Second' }
      ]
    });
    const db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);

    const rows = listSqliteCollectionRecordsByJsonField(db, 'members', 'id', [
      'member_id_read_2',
      'member_id_read_1'
    ], { limit: 0 });
    assert.deepEqual(rows.map((row) => row.id), ['member_id_read_1', 'member_id_read_2']);

    const found = findSqliteCollectionRecordByJsonField(db, 'members', 'id', 'member_id_read_2');
    assert.equal(found.nickname, 'Second');
  });
});

test('sqlite repeated dynamic collection reads reuse prepared statements', async () => {
  await withTempSqlite('sqlite-dynamic-read-cache', async (sqliteFile) => {
    await seedSqlite(sqliteFile, {
      members: [
        { id: 'member_dynamic_read_1', steamId: '76561198001005001', nickname: 'First' },
        { id: 'member_dynamic_read_2', steamId: '76561198001005002', nickname: 'Second' }
      ]
    });
    const db = await openSqliteDatabase(sqliteFile);
    ensureSqliteSchema(db);
    const before = await sqliteRuntimeStats();
    const prepareCount = (stats, name) => Number(stats.prepares.byName[name] || 0);

    for (let index = 0; index < 3; index += 1) {
      assert.equal(listSqliteCollectionRecordsByJsonField(db, 'members', 'steamId', ['76561198001005001'], { limit: 0 }).length, 1);
      assert.equal(listSqliteCollectionRecordsByJsonField(db, 'members', 'id', ['member_dynamic_read_1'], { limit: 0 }).length, 1);
      assert.equal(listSqliteCollectionRecordsByJsonFields(db, 'members', {
        steamId: '76561198001005001',
        nickname: 'First'
      }, { limit: 0 }).length, 1);
      assert.equal(listSqliteCollectionRecordsWhereJsonFieldPresent(db, 'members', 'steamId', { limit: 0 }).length, 2);
    }

    const after = await sqliteRuntimeStats();
    assert.equal(
      prepareCount(after, 'listCollectionRecordsByJsonField_steamId_1') - prepareCount(before, 'listCollectionRecordsByJsonField_steamId_1'),
      1
    );
    assert.equal(
      prepareCount(after, 'listCollectionRecordsByIds_1') - prepareCount(before, 'listCollectionRecordsByIds_1'),
      1
    );
    assert.equal(
      prepareCount(after, 'listCollectionRecordsByJsonFields_steamId1_nickname1') -
        prepareCount(before, 'listCollectionRecordsByJsonFields_steamId1_nickname1'),
      1
    );
    assert.equal(
      prepareCount(after, 'listCollectionRecordsWhereJsonFieldPresent_steamId') -
        prepareCount(before, 'listCollectionRecordsWhereJsonFieldPresent_steamId'),
      1
    );
  });
});

test('sqlite integrity check passes clean business invariants', async () => {
  await withTempSqlite('sqlite-integrity-clean', async (sqliteFile) => {
    await seedSqlite(sqliteFile, {
      members: [
        { id: 'member_integrity_1', steamId: '76561198001001001', discordId: 'discord_integrity_1', wechatUserId: 'wechat_integrity_1', battlemetricsId: 'bm_integrity_1' },
        { id: 'member_integrity_2', steamId: '76561198001001002', discordId: 'discord_integrity_2', wechatUserId: 'wechat_integrity_2', battlemetricsId: 'bm_integrity_2' }
      ],
      squads: [
        { id: 'squad_integrity_1', name: 'Integrity Squad', archivedAt: '' }
      ],
      squadMembers: [
        { id: 'squad_member_integrity_1', squadId: 'squad_integrity_1', memberId: 'member_integrity_1' }
      ],
      wipes: [
        { id: 'wipe_integrity_live', status: 'active', name: 'Integrity Live' },
        { id: 'wipe_integrity_closed', status: 'closed', name: 'Integrity Closed' }
      ],
      wipeParticipants: [
        { id: 'participant_integrity_1', wipeId: 'wipe_integrity_live', memberId: 'member_integrity_1', squadId: 'squad_integrity_1' }
      ],
      kdaRows: [
        { id: 'kda_integrity_1', wipeId: 'wipe_integrity_live', memberId: 'member_integrity_1', steamId: '76561198001001001' }
      ],
      memberProfiles: [
        { id: 'profile_integrity_1', memberId: 'member_integrity_1', steamId: '76561198001001001' }
      ],
      wipeSettlements: [
        { id: 'settlement_integrity_1', wipeId: 'wipe_integrity_closed' }
      ],
      wechatUsers: [
        { id: 'wechat_integrity_1', openid: 'openid_integrity_1', unionid: 'unionid_integrity_1', memberId: 'member_integrity_1' }
      ],
      wechatSessions: [
        { id: 'wechat_session_integrity_1', tokenHash: 'wechat_session_token_hash_integrity_1', wechatUserId: 'wechat_integrity_1' }
      ],
      syncJobs: [
        { id: 'sync_job_integrity_done', type: 'kda', scope: 'current_wipe', status: 'completed', targetWipeId: 'wipe_integrity_live', targetServerId: 'server_integrity_1' }
      ],
      operationRuns: [
        {
          id: 'operation_run_integrity_done',
          type: 'kda_sync',
          platform: 'battlemetrics',
          source: 'manual',
          status: 'succeeded',
          dedupeKey: 'kda:wipe_integrity_live',
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:01:00.000Z'
        }
      ],
      integrationEvents: [
        {
          id: 'integration_event_integrity_processed',
          platform: 'discord',
          eventType: 'member_review_card',
          dedupeKey: 'discord:member_review_card:application_integrity_1',
          status: 'processed',
          receivedAt: '2026-07-07T00:00:00.000Z',
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:01:00.000Z'
        },
        {
          id: 'integration_event_integrity_duplicate',
          platform: 'discord',
          eventType: 'member_review_card',
          dedupeKey: 'discord:member_review_card:application_integrity_1',
          status: 'duplicate',
          receivedAt: '2026-07-07T00:02:00.000Z',
          createdAt: '2026-07-07T00:02:00.000Z',
          updatedAt: '2026-07-07T00:02:00.000Z'
        }
      ],
      integrationMessageRefs: [
	        {
	          id: 'discord:member_review_card:application_integrity_1:channel_integrity_1:message_integrity_1',
	          platform: 'discord',
	          kind: 'member_review_card',
	          targetType: 'discord_member_application',
	          targetId: 'application_integrity_1',
	          channelId: 'channel_integrity_1',
	          messageId: 'message_integrity_1',
	          status: 'active'
	        },
	        {
	          id: 'discord:wipe_attendance_card:wipe_integrity_live:channel_integrity_2:message_integrity_2',
	          platform: 'discord',
	          kind: 'wipe_attendance_card',
	          targetType: 'wipe',
	          targetId: 'wipe_integrity_live',
	          channelId: 'channel_integrity_2',
	          messageId: 'message_integrity_2',
	          status: 'active'
	        },
        {
          id: 'wechat:subscribe_message:wipe_integrity_1:wechat_user_integrity_1:operation_run_integrity_1_1',
          platform: 'wechat',
          kind: 'subscribe_message',
          targetType: 'wechat_subscribe_message',
          targetId: 'wipe_integrity_1',
          channelId: 'wechat_user_integrity_1',
          messageId: 'operation_run_integrity_1_1',
          status: 'delivered'
        },
        {
          id: 'kook:discord_kook_bridge_message:bridge_route_integrity_1:kook_channel_integrity_1:kook_bridge_integrity_1',
          platform: 'kook',
          kind: 'discord_kook_bridge_message',
          targetType: 'discord_kook_bridge_route',
          targetId: 'bridge_route_integrity_1',
          channelId: 'kook_channel_integrity_1',
          messageId: 'kook_bridge_integrity_1',
          status: 'active'
        },
        {
          id: 'kook:discord_kook_bridge_message:bridge_route_integrity_1:kook_channel_integrity_1:kook_bridge_integrity_2',
          platform: 'kook',
          kind: 'discord_kook_bridge_message',
          targetType: 'discord_kook_bridge_route',
          targetId: 'bridge_route_integrity_1',
          channelId: 'kook_channel_integrity_1',
          messageId: 'kook_bridge_integrity_2',
          status: 'active'
        },
        {
          id: 'discord:rustplus_relay_chat_forward:chat_integrity_1:channel_integrity_3:message_integrity_3',
          platform: 'discord',
          kind: 'rustplus_relay_chat_forward',
          targetType: 'rustplus_relay_chat_message',
          targetId: 'chat_integrity_1',
          channelId: 'channel_integrity_3',
          messageId: 'message_integrity_3',
          status: 'active'
        },
        {
          id: 'kook:rustplus_relay_chat_forward:chat_integrity_2:kook_channel_integrity_2:kook_message_integrity_2',
          platform: 'kook',
          kind: 'rustplus_relay_chat_forward',
          targetType: 'rustplus_relay_chat_message',
          targetId: 'chat_integrity_2',
          channelId: 'kook_channel_integrity_2',
          messageId: 'kook_message_integrity_2',
          status: 'active'
        }
      ]
    });

    const result = await runIntegrity(sqliteFile);
    assert.equal(result.code, 0, JSON.stringify(result.payload));
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.invariants.ok, true);
    assert.equal(result.payload.invariants.collectionsChecked.includes('operationRuns'), true);
    assert.equal(result.payload.invariants.collectionsChecked.includes('integrationEvents'), true);
    assert.deepEqual(result.payload.invariants.errors, []);
    assert.deepEqual(result.payload.invariants.warnings, []);
  });
});

test('sqlite integrity check fails duplicate core identities and active live orphans', async () => {
  await withTempSqlite('sqlite-integrity-duplicates', async (sqliteFile) => {
    await seedSqlite(sqliteFile, {
      members: [
        { id: 'member_integrity_dup_1', steamId: '76561198001002001' },
        { id: 'member_integrity_dup_2', steamId: '76561198001002001' }
      ],
      wipes: [
        { id: 'wipe_integrity_dup_live', status: 'active', name: 'Integrity Duplicate Live' }
      ],
      wipeParticipants: [
        { id: 'participant_integrity_dup_1', wipeId: 'wipe_integrity_dup_live', memberId: 'member_integrity_dup_1' },
        { id: 'participant_integrity_dup_2', wipeId: 'wipe_integrity_dup_live', memberId: 'member_integrity_dup_1' }
      ],
      kdaRows: [
        { id: 'kda_integrity_dup_1', wipeId: 'wipe_integrity_dup_live', memberId: 'member_integrity_dup_1', steamId: '76561198001002001' },
        { id: 'kda_integrity_dup_2', wipeId: 'wipe_integrity_dup_live', memberId: 'member_integrity_dup_1', steamId: '76561198001002001' },
        { id: 'kda_integrity_missing_live', wipeId: 'wipe_integrity_dup_live', memberId: 'member_integrity_missing', steamId: '76561198001009999' }
      ],
      syncJobs: [
        { id: 'sync_job_integrity_dup_1', type: 'kda', scope: 'current_wipe', status: 'running', targetWipeId: 'wipe_integrity_dup_live', targetServerId: 'server_integrity_dup' },
        { id: 'sync_job_integrity_dup_2', type: 'kda', scope: 'current_wipe', status: 'queued', targetWipeId: 'wipe_integrity_dup_live', targetServerId: 'server_integrity_dup' }
      ],
      operationRuns: [
        {
          id: 'operation_run_integrity_dup_1',
          type: 'discord_review_card',
          platform: 'discord',
          source: 'manual',
          status: 'running',
          dedupeKey: 'discord:review:application_integrity_dup',
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z'
        },
        {
          id: 'operation_run_integrity_dup_2',
          type: 'discord_review_card',
          platform: 'discord',
          source: 'manual',
          status: 'queued',
          dedupeKey: 'discord:review:application_integrity_dup',
          createdAt: '2026-07-07T00:00:01.000Z',
          updatedAt: '2026-07-07T00:00:01.000Z'
        },
        {
          id: 'operation_run_integrity_invalid',
          type: 'wechat_push',
          platform: 'wechat4',
          source: 'timer',
          status: 'stuck'
        }
      ],
      integrationEvents: [
        {
          id: 'integration_event_integrity_dup_1',
          platform: 'discord',
          eventType: 'member_review_card',
          dedupeKey: 'discord:member_review_card:application_integrity_dup',
          status: 'processed',
          receivedAt: '2026-07-07T00:00:00.000Z',
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z'
        },
        {
          id: 'integration_event_integrity_dup_2',
          platform: 'discord',
          eventType: 'member_review_card',
          dedupeKey: 'discord:member_review_card:application_integrity_dup',
          status: 'failed',
          receivedAt: '2026-07-07T00:00:01.000Z',
          createdAt: '2026-07-07T00:00:01.000Z',
          updatedAt: '2026-07-07T00:00:01.000Z'
        },
        {
          id: 'integration_event_integrity_invalid',
          platform: 'discord4',
          eventType: 'member_review_card',
          status: 'retrying'
        }
      ],
      integrationMessageRefs: [
        {
          id: 'discord:member_review_card:application_integrity_dup:channel_integrity_dup:message_integrity_dup',
          platform: 'discord',
          kind: 'member_review_card',
          targetType: 'discord_member_application',
          targetId: 'application_integrity_dup',
          channelId: 'channel_integrity_dup',
          messageId: 'message_integrity_dup',
          status: 'active'
        },
        {
          id: 'discord:member_review_card:application_integrity_dup:channel_integrity_dup:message_integrity_dup_copy',
          platform: 'discord',
          kind: 'member_review_card',
          targetType: 'discord_member_application',
          targetId: 'application_integrity_dup',
          channelId: 'channel_integrity_dup',
          messageId: 'message_integrity_dup',
          status: 'active'
        },
        {
          id: 'integration_ref_integrity_missing',
          platform: 'discord',
          kind: 'member_review_card',
          targetType: 'discord_member_application',
          targetId: 'application_integrity_missing',
          status: 'active'
        },
        {
          id: 'integration_ref_integrity_invalid_status',
          platform: 'discord',
          kind: 'member_review_card',
          targetType: 'discord_member_application',
          targetId: 'application_integrity_invalid',
          channelId: 'channel_integrity_invalid',
          messageId: 'message_integrity_invalid',
          status: 'stale'
        },
        {
          id: 'integration_ref_integrity_invalid_combo',
          platform: 'wechat',
          kind: 'unknown_card',
          targetType: 'wechat_target',
          targetId: 'application_integrity_invalid_combo',
          channelId: 'channel_integrity_invalid_combo',
          messageId: 'message_integrity_invalid_combo',
          status: 'active'
        }
      ]
    }, { allowInvalidBusinessDuplicates: true });

    const result = await runIntegrity(sqliteFile);
    const rules = result.payload.invariants.errors.map((issue) => issue.rule);
    assert.notEqual(result.code, 0);
    assert.equal(result.payload.ok, false);
    assert.equal(rules.includes('members.steamId.unique'), true);
    assert.equal(rules.includes('wipeParticipants.wipeId_memberId.unique'), true);
    assert.equal(rules.includes('kdaRows.wipe_member.unique'), true);
    assert.equal(rules.includes('syncJobs.active.duplicate'), true);
    assert.equal(rules.includes('operationRuns.active.dedupeKey.duplicate'), true);
    assert.equal(rules.includes('operationRuns.required_fields'), true);
    assert.equal(rules.includes('operationRuns.status.valid'), true);
    assert.equal(rules.includes('operationRuns.platform.valid'), true);
    assert.equal(rules.includes('operationRuns.source.valid'), true);
    assert.equal(rules.includes('integrationEvents.dedupeKey.original.unique'), true);
    assert.equal(rules.includes('integrationEvents.required_fields'), true);
    assert.equal(rules.includes('integrationEvents.status.valid'), true);
    assert.equal(rules.includes('integrationEvents.platform.valid'), true);
    assert.equal(rules.includes('kdaRows.live.member.exists'), true);
    assert.equal(rules.includes('integrationMessageRefs.active.message.unique'), true);
    assert.equal(rules.includes('integrationMessageRefs.required_fields'), true);
    assert.equal(rules.includes('integrationMessageRefs.status.valid'), true);
    assert.equal(rules.includes('integrationMessageRefs.platform_kind_targetType.valid'), true);
  });
});

test('sqlite integrity check allows archived KDA and participants for deleted members', async () => {
  await withTempSqlite('sqlite-integrity-archived-orphans', async (sqliteFile) => {
    await seedSqlite(sqliteFile, {
      wipes: [
        { id: 'wipe_integrity_archived', status: 'closed', name: 'Integrity Archived' }
      ],
      wipeParticipants: [
        { id: 'participant_integrity_archived_orphan', wipeId: 'wipe_integrity_archived', memberId: 'deleted_member_integrity' }
      ],
      kdaRows: [
        { id: 'kda_integrity_archived_orphan', wipeId: 'wipe_integrity_archived', memberId: 'deleted_member_integrity', steamId: '76561198001003001' }
      ]
    });

    const result = await runIntegrity(sqliteFile);
    assert.equal(result.code, 0, JSON.stringify(result.payload));
    assert.equal(result.payload.ok, true);
    assert.equal(result.payload.invariants.errors.some((issue) => issue.rule.includes('live.member.exists')), false);
  });
});
