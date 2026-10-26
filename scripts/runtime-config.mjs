import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { assertLocalMode } from '../server/local-mode.js';

export function loadRuntimeEnvironment() {
  try { loadEnvFile(process.env.NB_ENV_FILE || path.resolve('.env')); }
  catch (error) { if (error.code !== 'ENOENT' || process.env.NB_ENV_FILE) throw error; }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 16) throw new Error('NODE_22_16_OR_NEWER_REQUIRED');
  process.env.NB_DATA_DIR = path.resolve(process.env.NB_DATA_DIR || 'data');
  process.env.NB_SQLITE_FILE = path.resolve(process.env.NB_SQLITE_FILE || path.join(process.env.NB_DATA_DIR, 'nb-clan.sqlite'));
  return process.env;
}
export async function runtimeConfiguration({ development = false } = {}) {
  const env = loadRuntimeEnvironment();
  if (development) {
    if (env.NB_LOCAL_MODE !== '1' || env.NB_LOCAL_CONTAINER === '1') throw new Error('DEVELOPMENT_REQUIRES_LOCAL_MODE');
    assertLocalMode(env);
    env.NB_V2_PUBLIC_ORIGIN = 'http://127.0.0.1:5173';
    env.NB_PUBLIC_BASE_URL = env.NB_V2_PUBLIC_ORIGIN;
  }
  if (env.NB_OWNER_STEAM_ID && !/^7656119\d{10}$/.test(env.NB_OWNER_STEAM_ID)) throw new Error('OWNER_STEAM_ID_INVALID');
  if (env.NB_V2_PRODUCTION_ENABLED !== '1' || env.NB_V2_IDENTITY_ENABLED !== '1' || !['sqlite', 'sqlite-primary'].includes(env.NB_STORAGE_MODE))
    throw new Error('V2_AND_SQLITE_CONFIGURATION_REQUIRED');
  const { publicOrigin } = await import('../server/v2/identity/providers.js');
  const { assertNotificationOrigin } = await import('../server/v2/notification-platforms/runtime-mode.js');
  const origin = publicOrigin(env.NB_V2_PUBLIC_ORIGIN || env.NB_PUBLIC_BASE_URL);
  const local = assertLocalMode(env);
  assertNotificationOrigin(origin, local ? 'isolated' : 'production');
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT_INVALID');
  const { productionConfig } = await import('../server/v2/production/migrations.js');
  return { ...productionConfig({ dataDirectory: env.NB_DATA_DIR, databaseFile: env.NB_SQLITE_FILE }), origin, local, port };
}
export function commandError(error) {
  return [error.errorCode, error.message, error.code].find(code => /^[A-Z][A-Z0-9_]+$/.test(code || '')) || 'COMMAND_FAILED';
}
