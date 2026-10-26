import net from 'node:net';
import { createRequire, registerHooks, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL } from 'node:url';
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args, opts = typeof values[0] === 'object' ? values[0] : { host: typeof values[1] === 'string' ? values[1] : 'localhost' };
  if (opts.path || !['127.0.0.1', '::1', 'localhost'].includes(opts.host || 'localhost')) throw new Error('PLATFORM_MEDIA_EGRESS_BLOCKED');
  return connect.apply(this, args);
};
syncBuiltinESMExports();
if (process.env.PLATFORM_MEDIA_DEPENDENCY_ROOT) {
  const require = createRequire(process.env.PLATFORM_MEDIA_DEPENDENCY_ROOT + '/package.json');
  registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context); } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) throw e;
      return next(pathToFileURL(require.resolve(specifier)).href, context);
    }
  } });
}
