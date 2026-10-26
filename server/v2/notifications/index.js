import { IdentityError } from '../identity/errors.js';
import { NotificationRepository } from './repository.js';
import { NotificationService } from './service.js';
import { createNotificationWorker } from './worker.js';
import { assertNotificationOrigin } from '../notification-platforms/runtime-mode.js';
export { installNotificationSchema, installNotificationBusinessSchema, installNotificationVipSchema, installNotificationPlatformCardSchema, installNotificationOpenWipeSchema, installNotificationHexSchema } from './repository.js';
export { createNotificationRouter } from './routes.js';
export function createNotificationSystem({identity,scheduling,catalog,renderer,templates,platforms,publicOrigin,now = Date.now,options = {}}) {
  if (!identity?.repo?.db || identity.repo.db !== scheduling?.repo?.db) throw new IdentityError('NOTIFICATION_SETUP_REQUIRED',503);
  const repo = new NotificationRepository(identity.repo.db);
  if (!catalog || !['listTargets','getTarget','listOptions'].every(k => typeof catalog[k] === 'function') || typeof renderer !== 'function' || !Array.isArray(templates) || !platforms)
    throw new IdentityError('NOTIFICATION_SETUP_REQUIRED',503);
  assertNotificationOrigin(publicOrigin, options.runtimeMode || 'isolated');
  const settings = {runtimeMode:'isolated',previewTtlMs:600000,leaseMs:30000,maxAttempts:5,requestTimeoutMs:20000,...options};
  for (const key of ['previewTtlMs','leaseMs','maxAttempts','requestTimeoutMs']) if (!Number.isSafeInteger(settings[key]) || settings[key] <= 0) throw new IdentityError('NOTIFICATION_SETUP_REQUIRED',503);
  settings.previewTtlMs = Math.min(settings.previewTtlMs,600000);
  const service = new NotificationService({repo,identity,scheduling,catalog,renderer,templates,platforms,publicOrigin,now,options:settings});
  return {service,worker:createNotificationWorker(service),references:{resolve:(token,context) => service.resolveReference(token,context)}};
}
