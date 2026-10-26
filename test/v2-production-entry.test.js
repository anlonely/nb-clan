import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function entry(t, overrides = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'nb-production-entry-'));
  const files = {
    'package.json': '{"type":"module"}',
    'dist/index.html': '<!doctype html><title>production-entry-fixture</title>',
    'server/trace.js': `import fs from 'node:fs'; export const trace = value => fs.appendFileSync(process.env.TRACE_FILE,value+'\\n');`,
    'server/store.js': `import {trace} from './trace.js'; export const DATA_DIR=process.env.NB_DATA_DIR,ROOT_CREDENTIALS_FILE=DATA_DIR+'/root-credentials.txt'; export async function ensureStore(){trace('ensure');} export async function readStore(){trace('read');} export async function drainStoreWrites(){trace('writes-drained');}`,
    'server/storage/sqlite.js': `import {trace} from '../trace.js'; export const sqlitePrimaryMode=()=>process.env.NB_STORAGE_MODE==='sqlite-primary'; export const sqliteFilePath=()=>process.env.NB_SQLITE_FILE; export async function closeSqliteDatabases(){trace('db-closed');}`,
    'server/background-task-queue.js': `import {trace} from './trace.js'; export async function drainBackgroundTaskQueues(){trace('queues-drained');}`,
    'server/request-context.js': 'export const trustProxySetting=()=>null;',
    'server/data-backup.js': `import {trace} from './trace.js'; export function startServerDataBackupSchedule(){trace('backup-start'); return {stop(){trace('backup-stop');},async drain(){trace('backup-drained');}};}`,
    'server/rustplus-relay-stream.js': `import {trace} from './trace.js'; trace('relay-import:'+process.env.NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS); export function installRustplusRelayWebSocket(){trace('relay-installed');}`,
    'server/api.js': `import express from 'express'; import {trace} from './trace.js'; trace('api-import:'+process.env.NB_DISABLE_BACKGROUND_JOBS); export function createApiRouter(options){if(!options.expected)throw Error('FACTORY_NOT_INJECTED'); trace('api-created'); const router=express.Router();router.get('/readyz',(_q,s)=>s.json({ok:true}));router.get('/legacy',(_q,s)=>s.json({preserved:true}));router.v2Runtime={async start(){trace('api-started');},async stop(){trace('api-stopped');}};return router;} export function stopBackgroundJobs(){trace('legacy-stopped');} export function forwardRustplusRelayChatToDiscord(){}`, 
    'server/v2/production/migrations.js': `import {trace} from '../../trace.js'; export async function acquireProductionLease(_config,{mode}){trace('lease:'+mode);return {async release(){trace('lease-released');}};} export async function validateProductionReady(){trace('validated'); if(process.env.FAIL_READY==='1')throw Error('SCHEMA_MISSING');}`,
    'server/v2/production/runtime.js': `import {trace} from '../../trace.js'; export function createProductionComposition({publicOrigin}){if(publicOrigin!=='https://nb.example')throw Error('ORIGIN_CHANGED');trace('composition');return {ingestRelay(){throw Error('UNUSED_FIXTURE');},factories:{expected:true},async start(api){trace('start-begin');await new Promise(r=>setTimeout(r,50));if(process.env.FAIL_START==='1')throw Error('START_REJECTED');await api.v2Runtime.start();trace('start-complete');},async stop(){trace('composition-stopped');if(process.env.FAIL_DRAIN==='1')throw Error('DRAIN_REJECTED');}};}`
  };
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(directory, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, contents);
  }
  await mkdir(path.join(directory, 'data'));
  await mkdir(path.join(directory, 'server/v2/identity'));
  await mkdir(path.join(directory, 'server/v2/notification-platforms'));
  await symlink(path.join(root, 'server/v2/identity/providers.js'), path.join(directory, 'server/v2/identity/providers.js'));
  await symlink(path.join(root, 'server/v2/notification-platforms/runtime-mode.js'), path.join(directory, 'server/v2/notification-platforms/runtime-mode.js'));
  await symlink(path.join(root, 'node_modules'), path.join(directory, 'node_modules'));
  for (const file of ['index.js', 'local-mode.js', 'static-cache.js']) await copyFile(path.join(root, 'server', file), path.join(directory, 'server', file));
  const traceFile = path.join(directory, 'trace.txt'); await writeFile(traceFile, '');
  let output = '';
  const child = spawn(process.execPath, ['server/index.js'], { cwd: directory, env: {
    PATH: process.env.PATH, PORT: '0', NB_BIND_HOST: '127.0.0.1', NB_SHUTDOWN_GRACE_MS: '1000',
    NB_DATA_DIR: path.join(directory, 'data'), NB_SQLITE_FILE: path.join(directory, 'data/nb-clan.sqlite'),
    NB_STORAGE_MODE: 'sqlite-primary', NB_V2_IDENTITY_ENABLED: '1', NB_V2_PRODUCTION_ENABLED: '1',
    NB_V2_PUBLIC_ORIGIN: 'https://nb.example', TRACE_FILE: traceFile, ...overrides
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; await rm(directory, { recursive: true, force: true }); });
  const wait = async predicate => {
    for (let count = 0; count < 500; count++) {
      if (predicate()) return;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(output);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`Entry timeout: ${output}`);
  };
  return { child, exited, output: () => output, trace: async () => (await readFile(traceFile, 'utf8')).trim().split('\n'),
    async origin() { await wait(() => /NB Clan API listening/.test(output)); return output.match(/NB Clan API listening on (http:\/\/127\.0\.0\.1:\d+)/)[1]; } };
}

test('production entry validates before opening store, starts owners before listen, routes root to V2 and releases only after DB closes', async t => {
  const f = await entry(t), origin = await f.origin();
  const order = await f.trace();
  assert.deepEqual(order.slice(0, 8), ['lease:runtime', 'validated', 'composition', 'ensure', 'read', 'api-import:1', 'api-created', 'start-begin']);
  assert.ok(order.includes('start-complete')); assert.ok(order.includes('relay-import:0'));
  for (const [url, expected] of [['/', '/app/home'], ['/index.html', '/app/home'], ['/?login=1', '/login']]) {
    const result = await fetch(origin + url, { redirect: 'manual' });
    assert.equal(result.status, 303); assert.equal(result.headers.get('location'), expected);
  }
  assert.deepEqual(await (await fetch(origin + '/api/workspace-entry')).json(), { defaultWorkspace: 'v2' });
  assert.deepEqual(await (await fetch(origin + '/api/legacy')).json(), { preserved: true });
  assert.equal((await fetch(origin + '/api/readyz')).status, 200);
  f.child.kill('SIGTERM'); assert.deepEqual(await f.exited, { code: 0, signal: null });
  const stopped = await f.trace();
  for (const phase of ['api-stopped', 'composition-stopped', 'queues-drained', 'writes-drained']) assert.ok(stopped.indexOf(phase) < stopped.indexOf('db-closed'));
  assert.ok(stopped.indexOf('db-closed') < stopped.indexOf('lease-released'));
});

test('failed owner startup never listens and drains constructed owners before releasing the lease', async t => {
  const f = await entry(t, { FAIL_START: '1' });
  assert.deepEqual(await f.exited, { code: 1, signal: null });
  assert.ok(!f.output().includes('NB Clan API listening'));
  const phases = await f.trace();
  assert.ok(phases.includes('api-stopped')); assert.ok(phases.includes('composition-stopped'));
  assert.ok(phases.indexOf('db-closed') < phases.indexOf('lease-released'));
});

test('failed owner drain preserves the production lease and does not close a possibly active database', async t => {
  const f = await entry(t, { FAIL_DRAIN: '1' }); await f.origin();
  f.child.kill('SIGTERM'); assert.deepEqual(await f.exited, { code: 1, signal: null });
  const phases = await f.trace(); assert.ok(phases.includes('api-stopped')); assert.ok(phases.includes('composition-stopped'));
  assert.ok(!phases.includes('db-closed')); assert.ok(!phases.includes('lease-released'));
});

test('production entry refuses disabled identity, non-SQLite storage and an unsafe public origin before acquiring ownership', async t => {
  for (const config of [{ NB_V2_IDENTITY_ENABLED: '0' }, { NB_STORAGE_MODE: 'json' }, { NB_V2_PUBLIC_ORIGIN: 'http://nb.example' }]) {
    const f = await entry(t, config); assert.deepEqual(await f.exited, { code: 1, signal: null });
    const phases = await f.trace();
    assert.ok(!phases.includes('lease:runtime')); assert.ok(!phases.includes('ensure')); assert.ok(!f.output().includes('NB Clan API listening'));
  }
});
