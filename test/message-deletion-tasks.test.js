import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMessageDeletionTaskRuntime,
  messageDeletionRetryDelayMs,
  messageDeletionTaskId,
  messageDeletionTaskTerminal
} from '../server/message-deletion-tasks.js';

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createInMemoryTaskStore(seedTasks = []) {
  const records = new Map(seedTasks.map((task) => [task.id, { ...task }]));
  const calls = {
    getCollection: 0,
    getRecordsByJsonField: 0
  };
  return {
    calls,
    records,
    async getRecord(collection, id) {
      assert.equal(collection, 'messageDeletionTasks');
      const record = records.get(id);
      return record ? { ...record } : null;
    },
    async getCollection(collection) {
      assert.equal(collection, 'messageDeletionTasks');
      calls.getCollection += 1;
      return [...records.values()].map((record) => ({ ...record }));
    },
    async getRecordsByJsonField(collection, field, values) {
      assert.equal(collection, 'messageDeletionTasks');
      assert.equal(field, 'status');
      calls.getRecordsByJsonField += 1;
      const allowed = new Set((Array.isArray(values) ? values : [values]).map((value) => String(value || '')));
      return [...records.values()]
        .filter((record) => allowed.has(String(record.status || '')))
        .map((record) => ({ ...record }));
    },
    async writePatch(patch) {
      for (const task of patch.upserts?.messageDeletionTasks || []) {
        records.set(task.id, { ...task });
      }
    }
  };
}

test('message deletion task helpers keep stable ids, terminal statuses, and retry delay rules', () => {
  const input = {
    platform: 'discord',
    messageType: 'kda_query',
    applicationId: 'app_1',
    token: 'token_1'
  };
  assert.equal(messageDeletionTaskId(input), messageDeletionTaskId(input));
  assert.notEqual(messageDeletionTaskId(input), messageDeletionTaskId({ ...input, messageType: 'member_ranking_mine' }));
  assert.equal(messageDeletionTaskTerminal('deleted'), true);
  assert.equal(messageDeletionTaskTerminal('not_found'), true);
  assert.equal(messageDeletionTaskTerminal('failed'), true);
  assert.equal(messageDeletionTaskTerminal('pending'), false);
  assert.equal(messageDeletionRetryDelayMs({ status: 429, headers: { get: () => '2' } }, 1), 2000);
  assert.equal(messageDeletionRetryDelayMs({ status: 500 }, 3), 4000);
});

test('message deletion runtime deletes original interactions without sqlite persistence', async () => {
  const calls = [];
  const runtime = createMessageDeletionTaskRuntime({
    discordApiBaseUrl: 'https://discord.test/api/v10',
    defaultDeleteDelayMs: 1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204 };
    },
    sqlitePrimaryModeImpl: () => false
  });

  try {
    await runtime.queueDiscordOriginalInteractionDelete({
      application_id: 'app id',
      token: 'token/value',
      channel_id: 'channel_1'
    }, 1, 'kda_query');
    await wait(20);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://discord.test/api/v10/webhooks/app%20id/token%2Fvalue/messages/@original');
    assert.equal(calls[0].options.method, 'DELETE');
  } finally {
    runtime.clearScheduledMessageDeletionTasksForTests();
  }
});

test('message deletion runtime reports sqlite persistence failures before fallback delete', async () => {
  const calls = [];
  const failures = [];
  const runtime = createMessageDeletionTaskRuntime({
    discordApiBaseUrl: 'https://discord.test/api/v10',
    defaultDeleteDelayMs: 1,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204 };
    },
    sqlitePrimaryModeImpl: () => true,
    getRecord: async () => null,
    writePatch: async (patch) => {
      if (patch.reason === 'message_deletion_task_upsert') {
        throw Object.assign(new Error('Injected sqlite patch failure for message_deletion_task_upsert'), {
          code: 'NB_TEST_SQLITE_PATCH_FAILURE',
          reason: patch.reason
        });
      }
    },
    recordPersistenceFailure: async (failure) => {
      failures.push(failure);
    },
    now: () => '2026-07-07T00:00:00.000Z'
  });

  try {
    await runtime.queueDiscordOriginalInteractionDelete({
      application_id: 'app_1',
      token: 'interaction_token_should_not_be_recorded',
      channel_id: 'channel_1'
    }, 1, 'member_ranking_mine');
    await wait(30);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://discord.test/api/v10/webhooks/app_1/interaction_token_should_not_be_recorded/messages/@original');
    assert.equal(failures.length, 1);
    assert.equal(failures[0].task.platform, 'discord');
    assert.equal(failures[0].task.messageType, 'member_ranking_mine');
    assert.match(failures[0].task.id, /^message_deletion_discord_/);
    assert.equal(failures[0].task.channelId, 'channel_1');
    assert.equal(failures[0].stage, 'upsert');
    assert.equal(failures[0].fallbackDeleteScheduled, true);
    assert.match(failures[0].error.message, /Injected sqlite patch failure for message_deletion_task_upsert/);
    assert.equal(JSON.stringify(failures).includes('interaction_token_should_not_be_recorded'), false);
  } finally {
    runtime.clearScheduledMessageDeletionTasksForTests();
  }
});

test('message deletion runtime executes due sqlite tasks and reports status', async () => {
  const dueTask = {
    id: 'message_deletion_discord_due',
    platform: 'discord',
    messageType: 'kda_query',
    applicationId: 'app_1',
    interactionToken: 'token_1',
    deleteAt: '2020-01-01T00:00:00.000Z',
    attempts: 0,
    status: 'pending',
    lastError: '',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z'
  };
  const store = createInMemoryTaskStore([dueTask]);
  const calls = [];
  const runtime = createMessageDeletionTaskRuntime({
    discordApiBaseUrl: 'https://discord.test/api/v10',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 204 };
    },
    sqlitePrimaryModeImpl: () => true,
    getRecord: store.getRecord,
    getCollection: store.getCollection,
    getRecordsByJsonField: store.getRecordsByJsonField,
    writePatch: store.writePatch,
    now: () => '2026-07-07T00:00:00.000Z'
  });

  try {
    const result = await runtime.runDueMessageDeletionTasks();
    assert.equal(result.enabled, true);
    assert.equal(result.scanned, 1);
    assert.equal(result.due, 1);
    assert.equal(result.partial, false);
    assert.equal(result.readError, '');
    assert.equal(calls.length, 1);
    const stored = store.records.get(dueTask.id);
    assert.equal(stored.status, 'deleted');
    assert.equal(stored.attempts, 1);
    assert.equal(stored.lastError, '');
    assert.equal(store.calls.getCollection, 0);
    assert.equal(store.calls.getRecordsByJsonField, 1);

    const status = await runtime.messageDeletionTaskRuntimeStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.total, 1);
    assert.equal(status.due, 0);
    assert.equal(status.counts.deleted, 1);
    assert.equal(store.calls.getCollection, 0);
    assert.equal(store.calls.getRecordsByJsonField, 2);
  } finally {
    runtime.clearScheduledMessageDeletionTasksForTests();
  }
});

test('message deletion runtime exposes partial status when status and fallback scans fail', async () => {
  const runtime = createMessageDeletionTaskRuntime({
    sqlitePrimaryModeImpl: () => true,
    getRecordsByJsonField: async () => {
      throw new Error('status index unavailable');
    },
    getCollection: async () => {
      throw new Error('full scan unavailable');
    }
  });

  try {
    const dueResult = await runtime.runDueMessageDeletionTasks();
    assert.equal(dueResult.enabled, true);
    assert.equal(dueResult.scanned, 0);
    assert.equal(dueResult.due, 0);
    assert.equal(dueResult.partial, true);
    assert.match(dueResult.readError, /full scan unavailable/);

    const status = await runtime.messageDeletionTaskRuntimeStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.total, 0);
    assert.equal(status.partial, true);
    assert.match(status.readError, /full scan unavailable/);
  } finally {
    runtime.clearScheduledMessageDeletionTasksForTests();
  }
});

test('message deletion runtime retries transient sqlite task failures without exhausting attempts early', async () => {
  const dueTask = {
    id: 'message_deletion_discord_retry',
    platform: 'discord',
    messageType: 'member_ranking_mine',
    applicationId: 'app_2',
    interactionToken: 'token_2',
    deleteAt: '2020-01-01T00:00:00.000Z',
    attempts: 0,
    status: 'pending',
    lastError: '',
    createdAt: '2020-01-01T00:00:00.000Z',
    updatedAt: '2020-01-01T00:00:00.000Z'
  };
  const store = createInMemoryTaskStore([dueTask]);
  const runtime = createMessageDeletionTaskRuntime({
    discordApiBaseUrl: 'https://discord.test/api/v10',
    taskMaxAttempts: 2,
    fetchImpl: async () => ({ ok: false, status: 500 }),
    sqlitePrimaryModeImpl: () => true,
    getRecord: store.getRecord,
    getCollection: store.getCollection,
    getRecordsByJsonField: store.getRecordsByJsonField,
    writePatch: store.writePatch,
    now: () => '2026-07-07T00:00:00.000Z'
  });

  try {
    await runtime.runDueMessageDeletionTasks();
    const stored = store.records.get(dueTask.id);
    assert.equal(stored.status, 'pending');
    assert.equal(stored.attempts, 1);
    assert.equal(stored.lastError, 'HTTP 500');
    assert.equal(Date.parse(stored.deleteAt) > Date.parse(dueTask.deleteAt), true);
    assert.equal(store.calls.getCollection, 0);
    assert.equal(store.calls.getRecordsByJsonField, 1);
  } finally {
    runtime.clearScheduledMessageDeletionTasksForTests();
  }
});
