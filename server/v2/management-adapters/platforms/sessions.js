import { randomBytes } from 'node:crypto';
import { verifiedMiniIdentity } from '../../platform-admin/mini-program.js';
import { hash, identifier, need } from '../../platform-admin/model.js';
import { PlatformAdminRepository } from '../../platform-admin/repository.js';

// Synchronous, idempotent post-commit callback; root forwards ALL unlink events
// to this one DB owner, even when another app was unlinked on the same account.
export function createPlatformSessionInvalidator({ identity }) {
  const db = identity.repo.db, applied = new Set();
  let generation = 0;
  return {
    capture: () => generation,
    assertCurrent(value) { need(value === generation, 'AUTH_CONTEXT_EXPIRED', 410); },
    invalidate(event) {
      need(event && typeof event.id === 'string' && event.id, 'IDENTITY_EVENT_REQUIRED', 503);
      if (applied.has(event.id)) return;
      need(!db.isTransaction, 'IDENTITY_COMMIT_REQUIRED', 503);
      // Unknown subjects during exchange are conservatively fenced globally;
      // deletion itself is account/subject scoped and preserves other accounts.
      generation++;
      if (event.reason === 'platform_configuration_changed' && event.appId) {
        db.prepare("DELETE FROM platform_admin_records WHERE kind='mini-session' AND json_extract(payload,'$.appId')=?").run(event.appId);
      }

      if (event.accountId) db.prepare("DELETE FROM platform_admin_records WHERE kind='mini-session' AND json_extract(payload,'$.accountId')=?").run(event.accountId);
      if (event.provider === 'wechat' && event.appId) for (const externalId of event.externalIds || []) {
        const prefix = `${event.appId}:`;
        if (!externalId.startsWith(prefix)) continue;
        db.prepare("DELETE FROM platform_admin_records WHERE kind='mini-session' AND json_extract(payload,'$.appId')=? AND json_extract(payload,'$.externalId')=?")
          .run(event.appId, externalId.slice(prefix.length));
      }
      applied.add(event.id);
    }
  };
}

export function createQueuedMiniSessions({ identity, appId, exchangeCode, readConfig, raw, lifecycle,
  invalidator, runStoreWriteTask, now, sessionTtlMs = 3600000 }) {
  const repo = new PlatformAdminRepository(identity.repo.db);
  identifier(appId);
  need(Number.isSafeInteger(sessionTtlMs) && sessionTtlMs >= 1000 && sessionTtlMs <= 86400000, 'MINI_SESSION_TTL_INVALID', 422);
  const config = () => {
    const value = readConfig?.();
    need(value?.enabled === true && value.appId === appId, 'MINI_PROGRAM_NOT_CONFIGURED', 503);
    return value;
  };
  function fence() {
    lifecycle.assertReady();
    const generation = invalidator.capture(), fingerprint = hash(config());
    return () => { lifecycle.assertReady(); invalidator.assertCurrent(generation); need(hash(config()) === fingerprint, 'MINI_CONFIG_CHANGED', 409); };
  }
  return {
    login: input => lifecycle.track(async () => {
      need(input && Object.keys(input).every(k => ['code', 'clientVersion'].includes(k)), 'CLIENT_ACTOR_FORBIDDEN', 403);
      const { code, clientVersion = 2 } = input;
      need(typeof exchangeCode === 'function', 'MINI_EXCHANGE_UNAVAILABLE', 503);
      need([1, 2].includes(clientVersion), 'ADAPTER_VERSION_UNSUPPORTED', 409);
      need(typeof code === 'string' && code.length > 0 && code.length <= 256, 'MINI_CODE_INVALID', 422);
      const assertCurrent = fence(), key = hash({ appId, code });
      await runStoreWriteTask(() => {
        assertCurrent();
        repo.db.prepare("DELETE FROM platform_admin_records WHERE kind IN ('mini-session','mini-code') AND at<?").run(now() - Math.max(sessionTtlMs, 600000));
        need(repo.db.prepare("SELECT count(*) n FROM platform_admin_records WHERE kind='mini-code'").get().n < 5000, 'MINI_LOGIN_CAPACITY', 429);
        need(!repo.get('mini-code', key), 'MINI_CODE_REPLAY', 409);
        repo.put('mini-code', key, 'wechat', '', now(), { consumedAt: now() });
      });
      // A failed/aborted external exchange consumes the code. The client must
      // obtain a new code; retry never repeats an uncertain vendor exchange.
      const proof = await lifecycle.io(exchangeCode, { appId, code, assertCurrent });
      return runStoreWriteTask(() => {
        assertCurrent();
        need(proof?.verified === true && proof.appId === appId && typeof proof.openid === 'string' && proof.openid.length > 0 && proof.openid.length <= 256, 'MINI_AUTH_INVALID', 401);
        const mapping = identity.identity(`wechat:${appId}`, proof.openid);
        const actor = verifiedMiniIdentity(mapping) ? identity.actorForAccount(mapping.accountId) : null, token = randomBytes(32).toString('base64url');
        const session = { appId, externalId: proof.openid, accountId: actor?.id || null, permissionVersion: actor?.permissionVersion || null, expiresAt: now() + sessionTtlMs };
        repo.put('mini-session', hash(token), 'wechat', actor?.id || '', now(), session);
        return { token, memberId: actor?.memberId || null, expiresAt: new Date(session.expiresAt).toISOString(), capabilities: raw.capabilities() };
      });
    }),
    logout: envelope => lifecycle.track(() => runStoreWriteTask(() => { lifecycle.assertReady(); return raw.logout(envelope); }))
  };
}
