import { access } from 'node:fs/promises';
import { runtimeConfiguration, commandError } from './runtime-config.mjs';
import { validateProductionReady } from '../server/v2/production/migrations.js';
try {
  const config = await runtimeConfiguration();
  await validateProductionReady(config);
  const warnings = [];
  try { await access(new URL('../dist/index.html', import.meta.url)); } catch { warnings.push('FRONTEND_BUILD_REQUIRED: npm run build'); }
  if (process.env.NB_OWNER_PASSWORD_LOGIN !== '1' && !process.env.NB_DISCORD_OAUTH_CLIENT_ID && !process.env.NB_KOOK_OAUTH_CLIENT_ID)
    warnings.push('LOGIN_CONFIGURATION_REQUIRED');
  console.log(JSON.stringify({ ok: true, mode: config.local ? 'local' : 'production', storage: 'sqlite-primary',
    ownerPasswordLogin: process.env.NB_OWNER_PASSWORD_LOGIN === '1', warnings }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, errorCode: commandError(error), hint: 'Check .env; use npm run setup only for a new empty data directory.' }));
  process.exitCode = 1;
}
