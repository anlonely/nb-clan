import { IdentityError } from '../identity/errors.js';

export function assertNotificationTransport(transport, runtimeMode = 'isolated') {
  if (!['isolated', 'production'].includes(runtimeMode) || transport?.runtimeMode !== runtimeMode ||
      typeof transport.request !== 'function' || typeof transport.respondPrivate !== 'function') {
    throw new IdentityError(runtimeMode === 'isolated' ? 'ISOLATED_TRANSPORT_REQUIRED' : 'NOTIFICATION_TRANSPORT_MODE_MISMATCH', 503);
  }
}

export function assertNotificationOrigin(publicOrigin, runtimeMode = 'isolated') {
  let origin;
  try { origin = new URL(publicOrigin); } catch { throw new IdentityError('NOTIFICATION_SETUP_REQUIRED', 503); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
  const valid = origin.origin === publicOrigin && !origin.username && !origin.password &&
    (runtimeMode === 'isolated' ? ['http:', 'https:'].includes(origin.protocol) && local
      : runtimeMode === 'production' && origin.protocol === 'https:' && !local);
  if (!valid) throw new IdentityError(runtimeMode === 'isolated' ? 'ISOLATED_TRANSPORT_REQUIRED' : 'NOTIFICATION_PUBLIC_ORIGIN_INVALID', 503);
}
