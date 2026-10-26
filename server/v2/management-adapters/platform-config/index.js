import { PlatformAdminService } from '../../platform-admin/service.js';
import { need, normalizeSubscriptionTemplates } from '../../platform-admin/model.js';

/** Synchronous projections from the ONE canonical PlatformAdminService.
 * No configuration cache, revision counter, vault lookup, migration or I/O.
 * The root's existing post-commit callback still owns mini-session revocation.
 */
export function createPlatformConfigReaders({ platformService, identity = platformService?.identity, appId } = {}) {
  const db = identity?.repo?.db;
  need(platformService instanceof PlatformAdminService && db && platformService.identity === identity &&
    platformService.repo?.db === db, 'PLATFORM_CONFIG_HOST_REQUIRED', 503);
  need(typeof appId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(appId), 'PLATFORM_CONFIG_APP_INVALID');
  function read(context) {
    need(platformService.identity === identity && platformService.repo.db === db && identity.repo.db === db,
      'PLATFORM_CONFIG_HOST_REQUIRED', 503);
    if (context !== undefined) {
      need(context && typeof context === 'object' && !Array.isArray(context) &&
        Object.keys(context).every(key => ['appId', 'db'].includes(key)), 'PLATFORM_CONFIG_CONTEXT_INVALID', 503);
      need(!Object.hasOwn(context, 'appId') || context.appId === appId, 'PLATFORM_CONFIG_APP_MISMATCH', 503);
      need(!Object.hasOwn(context, 'db') || context.db === db, 'PLATFORM_CONFIG_DB_MISMATCH', 503);
    }
    const current = platformService.config('wechat');
    need(current && !current.then && typeof current === 'object' && !Array.isArray(current) &&
      current.id === 'wechat' && typeof current.enabled === 'boolean' && Number.isSafeInteger(current.revision) &&
      current.revision >= 0 && [1, 2].includes(current.minClientVersion), 'PLATFORM_CONFIG_INVALID', 503);
    need(current.appId === appId, 'PLATFORM_CONFIG_APP_MISMATCH', 503);
    // Keep the reader tied to a saved canonical generation. A default or
    // hand-edited enabled row at revision zero cannot admit any owner.
    need(current.revision > 0, 'PLATFORM_CONFIG_UNSAVED', 503);
    return current;
  }
  const common = c => ({ enabled: c.enabled, appId: c.appId, revision: c.revision });
  return Object.freeze({ appId,
    readMini: context => { const c = read(context); return Object.freeze({ ...common(c), minClientVersion: c.minClientVersion }); },
    readMedia: context => { const c = read(context); return Object.freeze({ enabled: c.enabled, appId: c.appId, generation: c.revision }); },
    readInbox: context => {
      const c = read(context); let templates;
      try { templates = normalizeSubscriptionTemplates(c.subscriptionTemplates === undefined ? {} : c.subscriptionTemplates); }
      catch { need(false, 'PLATFORM_CONFIG_TEMPLATES_INVALID', 503); }
      return Object.freeze({ ...common(c), subscriptionTemplates: Object.freeze(templates) });
    }
  });
}
