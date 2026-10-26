import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('updateStore skips no-op writes but persists real changes', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-store-noop-'));
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';

  const storeModule = await import(`../server/store.js?store-noop-${Date.now()}`);
  const { STORE_FILE, ensureStore, readStore, updateStore } = storeModule;
  try {
    await ensureStore();
    const beforeStat = await stat(STORE_FILE);
    const beforeStore = await readStore();

    await updateStore(() => {});

    const afterNoopStat = await stat(STORE_FILE);
    const afterNoopStore = await readStore();
    assert.equal(afterNoopStat.mtimeMs, beforeStat.mtimeMs);
    assert.equal(afterNoopStore.updatedAt, beforeStore.updatedAt);

    await updateStore((store) => {
      store.settings.discord.commandHint = '/changed';
    });

    const afterChangeStore = await readStore();
    assert.equal(afterChangeStore.settings.discord.commandHint, '/changed');
    assert.notEqual(afterChangeStore.updatedAt, beforeStore.updatedAt);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('store runtime status aggregates read, write, and clone call sites', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'nb-clan-store-metrics-'));
  const previousEnv = {
    NB_DATA_DIR: process.env.NB_DATA_DIR,
    NB_ROOT_PASSWORD: process.env.NB_ROOT_PASSWORD,
    NB_STORE_SLOW_READ_MS: process.env.NB_STORE_SLOW_READ_MS,
    NB_STORE_SLOW_WRITE_MS: process.env.NB_STORE_SLOW_WRITE_MS,
    NB_STORE_SLOW_CLONE_MS: process.env.NB_STORE_SLOW_CLONE_MS
  };
  process.env.NB_DATA_DIR = dataDir;
  process.env.NB_ROOT_PASSWORD = 'RootPass123!';
  process.env.NB_STORE_SLOW_READ_MS = '0';
  process.env.NB_STORE_SLOW_WRITE_MS = '0';
  process.env.NB_STORE_SLOW_CLONE_MS = '0';

  const storeModule = await import(`../server/store.js?store-metrics-${Date.now()}`);
  const { ensureStore, readStore, updateStore, storeRuntimeStatus } = storeModule;
  try {
    await ensureStore();
    await readStore();
    await updateStore((store) => {
      store.settings.discord.commandHint = '/metrics';
    });

    const status = await storeRuntimeStatus({ sqliteSummary: false });
    assert.equal(status.metrics.reads.byName.read_store.total >= 1, true);
    assert.equal(status.metrics.reads.byName.read_store.slow >= 1, true);
    assert.equal(status.metrics.writes.byName.write_store_json.total >= 1, true);
    assert.equal(status.metrics.clones.byName.clone_store.total >= 1, true);
    assert.equal(Object.keys(status.metrics.reads.byCaller).length >= 1, true);
    assert.equal(Object.keys(status.metrics.writes.byCaller).length >= 1, true);
    assert.equal(Object.keys(status.metrics.clones.byCaller).length >= 1, true);
  } finally {
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
    await rm(dataDir, { recursive: true, force: true });
  }
});
