// Only a dependency resolution fallback; reads the already installed lockfile dependencies.
import { registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../../package.json', import.meta.url));
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) throw error;
      return next(pathToFileURL(require.resolve(specifier)).href, context);
    }
  }
});
