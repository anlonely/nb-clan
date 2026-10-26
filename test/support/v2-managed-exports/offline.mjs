// Test-only Node egress guard. Chromium has separate request/CSP/proxy controls.
import net from 'node:net';
import { syncBuiltinESMExports, registerHooks, createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  const opts = typeof a[0] === 'object' ? a[0] : { port: a[0], host: typeof a[1] === 'string' ? a[1] : 'localhost' };
  if (opts.path || !['127.0.0.1', '::1', 'localhost'].includes(opts.host || 'localhost')) {
    throw Object.assign(new Error('Managed export tests block non-loopback connections'), { code: 'MANAGED_EXPORT_EGRESS_BLOCKED' });
  }
  return original.apply(this, args);
};
syncBuiltinESMExports();
// Optional read-only fallback for isolated worktrees without node_modules. No install or env file loading.
if (process.env.MANAGED_EXPORT_DEPENDENCY_ROOT) {
  const require = createRequire(process.env.MANAGED_EXPORT_DEPENDENCY_ROOT + '/package.json');
  registerHooks({ resolve(specifier, context, next) {
    try { return next(specifier, context); }
    catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) throw e;
      return next(pathToFileURL(require.resolve(specifier)).href, context);
    }
  } });
}
