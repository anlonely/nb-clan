import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const runtimeBase = path.join(root, 'work/g06-integration');
export function optionsFrom(args) {
  const result = { port: 0, mode: 'static' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') {
      assert.match(args[++i] || '', /^\d+$/);
      result.port = Number(args[i]);
      assert.ok(result.port === 0 || result.port >= 1024 && result.port <= 65535);
    } else if (args[i] === '--dev') result.mode = 'dev';
    else if (args[i] === '--static') result.mode = 'static';
    else throw new Error('UNSUPPORTED_RUNTIME_ARGUMENT');
  }
  return result;
}
export function runtimeEnvironment(runDir, { port = 0, mode = 'static' } = {}, inherited = process.env) {
  assert.equal(path.dirname(runDir), runtimeBase);
  assert.match(path.basename(runDir), /^runtime-[A-Za-z0-9]+$/);
  return {
    PATH: inherited.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'development',
    ...(process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16)}:0x0:0x0` } : {}),
    NB_DATA_DIR: path.join(runDir, 'data'), NB_SQLITE_FILE: path.join(runDir, 'data/nb-clan.sqlite'),
    NB_STORAGE_MODE: 'sqlite-primary', NB_V2_IDENTITY_ENABLED: '1', NB_V2_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_DATA_BACKUP: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1',
    NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0',
    NODE_OPTIONS: `--import=${path.join(root, 'test/support/v2-baseline/loopback-only.mjs')}`,
    G06_RUN_DIR: runDir, G06_PORT: String(port), G06_FRONTEND_MODE: mode, G06_ISOLATED_RUNTIME: '1'
  };
}
export function validateEnvironment(env = process.env) {
  const expected = runtimeEnvironment(env.G06_RUN_DIR, { port: Number(env.G06_PORT), mode: env.G06_FRONTEND_MODE }, env);
  assert.deepEqual(Object.keys(env).filter(key => !Object.hasOwn(expected, key)), [], 'Unexpected inherited environment');
  for (const [key, value] of Object.entries(expected)) assert.equal(env[key], value, `Unsafe ${key}`);
  optionsFrom(['--port', env.G06_PORT]);
  assert.ok(['dev', 'static'].includes(env.G06_FRONTEND_MODE));
}
