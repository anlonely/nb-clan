// Dependency resolution only; package files are read from the installed tree.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import '../v2-baseline/loopback-only.mjs';
const fallback = createRequire(`${decodeURIComponent(new URL('../../../', import.meta.url).pathname)}/package.json`);
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || /^(\.|\/|node:)/.test(specifier)) throw error;
    return next(pathToFileURL(fallback.resolve(specifier)).href, context);
  }
} });
