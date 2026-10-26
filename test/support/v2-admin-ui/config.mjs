import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export function optionsFrom(args) {
  const options = { port: 4326 };
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--port') throw new Error(`Unknown argument: ${args[i]}`);
    assert.match(args[++i] || '', /^\d+$/, 'Port must be an integer');
    options.port = Number(args[i]);
    assert.ok(options.port === 0 || options.port >= 1024 && options.port <= 65535, 'Port must be 0 or 1024–65535');
  }
  return options;
}
export function runtimeEnvironment(runDir, { port = 4326 } = {}, inherited = process.env) {
  assert.ok(typeof runDir === 'string' && path.dirname(runDir) === path.join(root, 'work/g06-a') && /^runtime-[A-Za-z0-9_-]+$/.test(path.basename(runDir)), 'Isolated G06-A run directory required');
  return {
    PATH: inherited.PATH || '/usr/bin:/bin', LANG: 'en_US.UTF-8', TZ: 'Asia/Shanghai', NODE_ENV: 'development',
    ...(process.platform === 'darwin' ? { __CF_USER_TEXT_ENCODING: `0x${process.getuid().toString(16)}:0x0:0x0` } : {}),
    NB_DATA_DIR: path.join(runDir, 'data'), NB_SQLITE_FILE: path.join(runDir, 'data/nb-clan.sqlite'),
    NB_STORAGE_MODE: 'sqlite-primary', NB_V2_IDENTITY_ENABLED: '1', NB_V2_PUBLIC_ORIGIN: `http://127.0.0.1:${port}`,
    NB_DISABLE_BACKGROUND_JOBS: '1', NB_DISABLE_EXTERNAL_VITAL: '1', NB_DISABLE_EXTERNAL_ATLAS: '1', NB_RUSTPLUS_RELAY_CHAT_FLUSH_INTERVAL_MS: '0',
    NODE_OPTIONS: `--import=${path.join(root, 'test/support/v2-baseline/loopback-only.mjs')}`,
    G06_A_RUN_DIR: runDir, G06_A_PORT: String(port), G06_A_ISOLATED_RUNTIME: '1'
  };
}
export function validateRuntimeEnvironment(env = process.env) {
  const expected = runtimeEnvironment(env.G06_A_RUN_DIR, optionsFrom(['--port', env.G06_A_PORT]), env);
  assert.deepEqual(Object.keys(env).filter(key => !Object.hasOwn(expected, key)), [], 'Unexpected inherited environment keys');
  for (const [key,value] of Object.entries(expected)) assert.equal(env[key], value, `Unsafe ${key}`);
  return expected;
}
