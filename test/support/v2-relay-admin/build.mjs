import '../v2-source-main/offline.mjs';
const { build } = await import('vite');
const { config } = await import('./ui-config.mjs');
await build(config());
