// Defense in depth for this isolated Node harness, not an OS-wide sandbox.
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = Array.isArray(args[0]) ? args[0] : args;
  const options = typeof a[0] === 'object' ? a[0] : { port: a[0], host: typeof a[1] === 'string' ? a[1] : 'localhost' };
  const host = options.host || 'localhost';
  if (options.path || !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw Object.assign(new Error('G01 harness blocks non-loopback connections'), { code: 'G01_EGRESS_BLOCKED' });
  }
  return original.apply(this, args);
};
syncBuiltinESMExports();
