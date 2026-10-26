import '../v2-baseline/loopback-only.mjs';
import { build } from 'vite';
import { config } from './ui-config.mjs';
await build(config());
