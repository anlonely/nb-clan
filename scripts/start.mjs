import { runtimeConfiguration, commandError } from './runtime-config.mjs';
try {
  await runtimeConfiguration({ development: process.argv.includes('--dev') });
  process.env.NODE_ENV ||= 'production';
  await import('../server/index.js');
} catch (error) {
  console.error(JSON.stringify({ ok: false, errorCode: commandError(error) }));
  process.exitCode = 1;
}
