import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { can } from '../identity/permissions.js';

const BATCH_SIZE = 100;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const number = value => Number.isSafeInteger(value) && value >= 0;

// This projection is deliberately independent of history payload size. It contains
// only the current relationships used by G03 can(), never before/after snapshots.
function relationships(db) {
  const wipes = db.prepare(`SELECT id,json_extract(payload_json,'$.audience') AS audience
    FROM json_records WHERE collection='v2Wipes' ORDER BY id`).all()
    .map(row => ({ id: row.id, audience: row.audience ? JSON.parse(row.audience) : null }));
  const squadMembers = db.prepare(`SELECT json_extract(payload_json,'$.memberId') AS memberId,
    json_extract(payload_json,'$.squadId') AS squadId FROM json_records
    WHERE collection='squadMembers' AND COALESCE(json_extract(payload_json,'$.validTo'),'') IN ('',0)`).all();
  return { wipes, squadMembers };
}

function currentScope(identity, actor, system) {
  const relations = relationships(identity.repo.db);
  const wipes = new Set(relations.wipes.filter(wipe => can(actor, 'wipes.read', { kind: 'wipe', id: wipe.id }, relations)).map(wipe => wipe.id));
  const targets = new Map();
  for (const target of system?.service.catalog.listTargets() || []) {
    if (!validId(target.id) || target.enabled !== true || !['preview', 'send', 'reconcile'].some(action =>
      can(actor, `notifications.${action}`, { kind: 'platformTarget', id: target.id }, relations))) continue;
    targets.set(target.id, target);
  }
  // Scope changes clear private caches without disclosing the removed IDs. Target
  // configuration changes also invalidate old references to a replaced channel.
  return { relations, wipes, targets, targetHash: digest(
    [...targets.values()].map(target => [target.id, target.platform, target.guildId,
      target.channelId, target.configurationRevision]).sort((a, b) => a[0].localeCompare(b[0]))
  ) };
}

function watermarks(db, system) {
  const scheduling = db.prepare("SELECT COALESCE(MAX(rowid),0) AS value FROM json_records WHERE collection='v2SchedulingEvents'").get().value;
  const notifications = system ? db.prepare('SELECT cursor AS value FROM v2_notification_clock WHERE id=1').get()?.value : 0;
  if (!number(scheduling) || !number(notifications)) throw new IdentityError('BUSINESS_EVENTS_UNAVAILABLE', 503);
  return { scheduling, notifications };
}

/** Mount after the existing G03 identity middleware. No schema installation, job
 * dispatch or external transport is performed here. Await stop() before DB close. */
export function createBusinessEventsHub({ getNotificationSystem, intervalMs = 2000, maxConnections = 64,
  maxConnectionsPerAccount = 4, authorizationTimeoutMs = 15_000 } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 20 || intervalMs > 60_000 ||
      !Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 256 ||
      !Number.isSafeInteger(maxConnectionsPerAccount) || maxConnectionsPerAccount < 1 || maxConnectionsPerAccount > maxConnections ||
      !Number.isSafeInteger(authorizationTimeoutMs) || authorizationTimeoutMs < 20 || authorizationTimeoutMs > 60_000)
    throw new TypeError('Invalid business event limits');
  const router = express.Router(), connections = new Set(), pending = new Set();
  const counters = { sent: 0, backpressureClosed: 0, authorizationRevoked: 0, unavailableClosed: 0 };
  let stopped = false, timer = null;
  function close(connection) {
    if (connection.closed) return;
    connection.closed = true; connections.delete(connection);
    connection.res.off('close', connection.onClose);
    connection.res.end();
    if (!connections.size && timer) { clearInterval(timer); timer = null; }
  }
  function write(connection, event, data) {
    if (stopped || connection.closed || connection.res.destroyed || connection.res.writableEnded) return false;
    const frame = `id: ${connection.streamId}:${++connection.sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    if (Buffer.byteLength(frame) > 32768 || connection.res.writableLength > 32768 || !connection.res.write(frame)) {
      counters.backpressureClosed++; close(connection); return false;
    }
    counters.sent++; connection.lastWriteAt = Date.now(); return true;
  }
  function revoke(connection) {
    counters.authorizationRevoked++;
    write(connection, 'authorization-revoked', { schemaVersion: 1, scopeVersion: connection.permissionVersion });
    close(connection);
  }
  function resolveSystem(identity) {
    const system = getNotificationSystem?.(identity) || null;
    if (system && (system.then || system.service?.repo?.db !== identity.repo.db ||
      typeof system.service?.repo?.listChanges !== 'function' || typeof system.service?.catalog?.listTargets !== 'function'))
      throw new IdentityError('BUSINESS_EVENTS_UNAVAILABLE', 503);
    return system;
  }
  function currentActor(connection, authenticated) {
    const actor = connection.identity.actorForAccount(authenticated.actor.id);
    if (actor.id !== connection.accountId || actor.permissionVersion !== connection.permissionVersion ||
        connection.identity.scopeDigest(actor) !== connection.scopeDigest)
      throw new IdentityError('PERMISSIONS_CHANGED', 401);
    return actor;
  }
  async function processConnection(connection) {
    try {
      // The request retains its original cookie. Re-authentication rechecks expiry,
      // restrictions, policy freshness and the current server-owned session.
      const authenticated = await connection.req.v2Identity.authenticate();
      if (stopped || connection.closed) return;
      const actor = currentActor(connection, authenticated);
      const system = resolveSystem(connection.identity), db = connection.identity.repo.db;
      const scope = currentScope(connection.identity, actor, system);
      // A newly created wipe adds data, not authority over an existing record.
      // Reset for visibility changes of every previously known wipe (including
      // removal), while letting new wipes use the ordinary invalidation stream.
      const visibilityChanged = [...connection.knownWipes].some(id => scope.wipes.has(id) !== connection.visibleWipes.has(id));
      if (visibilityChanged || scope.targetHash !== connection.targetHash || system !== connection.system) {
        write(connection, 'reset', { schemaVersion: 1, scopeVersion: actor.permissionVersion, reason: 'scope_changed' });
        close(connection); return;
      }
      connection.knownWipes = new Set(scope.relations.wipes.map(wipe => wipe.id));
      connection.visibleWipes = scope.wipes;
      if (connection.catalogInvalidated) {
        connection.catalogInvalidated = false;
        if (can(actor, 'wipes.read', { kind: 'serverCatalog', id: 'global' }, connection.identity.relations())) connection.domainInvalidated = true;
      }
      if (connection.domainInvalidated) {
        connection.domainInvalidated = false;
        write(connection, 'reset', { schemaVersion: 1, scopeVersion: actor.permissionVersion, reason: 'domain_changed' });
      }
      const changes = new Map();
      const rows = db.prepare(`SELECT rowid AS cursor,json_extract(payload_json,'$.type') AS type,
        json_extract(payload_json,'$.wipeId') AS wipeId,json_extract(payload_json,'$.memberId') AS memberId
        FROM json_records WHERE collection='v2SchedulingEvents' AND rowid>? ORDER BY rowid LIMIT ?`)
        .all(connection.cursor.scheduling, BATCH_SIZE);
      for (const row of rows) {
        connection.cursor.scheduling = row.cursor;
        if (!validId(row.wipeId) || !scope.wipes.has(row.wipeId)) continue;
        if (row.type === 'signup.changed') {
          if (!validId(row.memberId) || !can(actor, 'signups.read', { kind: 'signup', wipeId: row.wipeId, memberId: row.memberId }, scope.relations)) continue;
          const hint = { kind: 'signup', wipeId: row.wipeId }; changes.set(JSON.stringify(hint), hint);
        } else if (row.type === 'wipe.changed') {
          const hint = { kind: 'wipe', wipeId: row.wipeId }; changes.set(JSON.stringify(hint), hint);
        }
      }
      if (system) {
        const result = system.service.repo.listChanges({ after: connection.cursor.notifications, limit: BATCH_SIZE });
        for (const row of result.items) {
          if (!validId(row.wipeId) || !scope.wipes.has(row.wipeId) || !scope.targets.has(row.targetId)) continue;
          // Cross-check the current delivery rather than trusting a stale event's
          // target or wipe linkage. No message reference/token enters this DTO.
          const delivery = validId(row.deliveryId) && system.service.repo.get('deliveries', row.deliveryId);
          if (!delivery || delivery.wipeId !== row.wipeId || delivery.targetId !== row.targetId ||
              delivery.intentId !== row.intentId || !validId(row.intentId)) continue;
          const hint = { kind: 'notification', wipeId: row.wipeId, intentId: row.intentId, deliveryId: row.deliveryId };
          changes.set(JSON.stringify(hint), hint);
        }
        connection.cursor.notifications = result.nextCursor;
      }
      // There are no awaits between this fresh actor check and the final write.
      currentActor(connection, authenticated);
      const hints = [...changes.values()];
      for (let offset = 0; offset < hints.length && !connection.closed; offset += BATCH_SIZE)
        write(connection, 'invalidate', { schemaVersion: 1, scopeVersion: actor.permissionVersion, changes: hints.slice(offset, offset + BATCH_SIZE) });
      if (!hints.length && Date.now() - connection.lastWriteAt >= 15_000) {
        if (!connection.res.write(': keepalive\n\n')) { counters.backpressureClosed++; close(connection); }
        else connection.lastWriteAt = Date.now();
      }
    } catch (error) {
      if (stopped || connection.closed) return;
      if (error.status === 401 || error.status === 403) revoke(connection);
      else { counters.unavailableClosed++; close(connection); }
    }
  }
  function launch(connection) {
    if (connection.busy) {
      if (Date.now() - connection.startedAt > authorizationTimeoutMs) {
        if (!connection.res.headersSent) connection.res.status(503).json({ error: { errorCode: 'BUSINESS_EVENTS_UNAVAILABLE', retryable: true } });
        counters.unavailableClosed++; close(connection);
      }
      return connection.busy;
    }
    if (!connection.ready || connection.closed || stopped || pending.size >= maxConnections) return Promise.resolve();
    connection.startedAt = Date.now();
    const task = processConnection(connection).finally(() => { connection.busy = null; pending.delete(task); });
    connection.busy = task; pending.add(task); return task;
  }
  async function poll() {
    const jobs = [];
    for (const connection of [...connections]) {
      if (stopped) break;
      jobs.push(launch(connection));
      // Each connection still reauthenticates on every poll. Yield between
      // subscribers so their synchronous SQLite work cannot monopolize one turn.
      await new Promise(resolve => setImmediate(resolve));
    }
    return Promise.allSettled(jobs);
  }
  function arm() {
    if (!timer && !stopped && connections.size) {
      timer = setInterval(() => { void poll(); }, intervalMs);
      timer.unref?.();
    }
  }
  router.get('/events', async (req, res) => {
    if (stopped || connections.size >= maxConnections || pending.size >= maxConnections) return res.status(503).json({ error: { errorCode: 'BUSINESS_EVENTS_UNAVAILABLE', retryable: true } });
    const connection = { req, res, streamId: randomUUID(), sequence: 0, ready: false, closed: false, lastWriteAt: Date.now(), startedAt: Date.now() };
    connection.onClose = () => close(connection);
    connections.add(connection); res.once('close', connection.onClose);
    const initialization = (async () => {
      try {
        const identity = req.v2Identity?.service;
        if (!identity || typeof req.v2Identity.authenticate !== 'function') throw new IdentityError('AUTH_REQUIRED', 401);
        // Read markers only. GET cannot create or advance schema state.
        if (!identity.repo.scalar('v2IdentityMigration') || !identity.repo.scalar('v2SchedulingMigration') || identity.repo.scalar('v2SchedulingSchemaVersion') !== 1)
          throw new IdentityError('SCHEDULING_MIGRATION_REQUIRED', 503);
        const authenticated = await req.v2Identity.authenticate();
        if (stopped || connection.closed) return;
        const actor = identity.actorForAccount(authenticated.actor.id);
        if (actor.permissionVersion !== authenticated.actor.permissionVersion) throw new IdentityError('PERMISSIONS_CHANGED', 401);
        if ([...connections].filter(item => item.accountId === actor.id).length >= maxConnectionsPerAccount)
          throw new IdentityError('BUSINESS_EVENTS_UNAVAILABLE', 503);
        const system = resolveSystem(identity), scope = currentScope(identity, actor, system);
        Object.assign(connection, { identity, accountId: actor.id, permissionVersion: actor.permissionVersion,
          scopeDigest: identity.scopeDigest(actor), targetHash: scope.targetHash,
          knownWipes: new Set(scope.relations.wipes.map(wipe => wipe.id)), visibleWipes: scope.wipes,
          system, cursor: watermarks(identity.repo.db, system) });
        res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store',
          Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        res.flushHeaders?.(); connection.ready = true;
        write(connection, 'reset', { schemaVersion: 1, scopeVersion: actor.permissionVersion, reason: req.get('Last-Event-ID') ? 'reconnect' : 'initial' });
        arm();
      } catch (error) {
        if (stopped || connection.closed) return;
        res.status(error.status === 401 || error.status === 403 || error.status === 503 ? error.status : 503)
          .json({ error: { errorCode: error.errorCode || 'BUSINESS_EVENTS_UNAVAILABLE', retryable: error.status !== 401 && error.status !== 403 } });
        close(connection);
      }
    })();
    connection.busy = initialization; pending.add(initialization); arm();
    await initialization.finally(() => { connection.busy = null; pending.delete(initialization); });
  });
  return { router, poll,
    invalidateCatalog(identity) {
      if (stopped) return;
      for (const connection of connections) if (connection.identity === identity) connection.catalogInvalidated = true;
    },
    invalidateDomain(identity) {
      if (stopped) return;
      // No IDs, counts or payload leave the domain. Poll re-authenticates before
      // emitting the hint; reconnect already invalidates all cached queries.
      for (const connection of connections) if (connection.identity === identity) connection.domainInvalidated = true;
    },
    diagnostics: () => ({ connections: connections.size, timerActive: Boolean(timer), pending: pending.size, stopped, ...counters }),
    async stop() {
      stopped = true; if (timer) clearInterval(timer); timer = null;
      for (const connection of [...connections]) close(connection);
      await Promise.allSettled([...pending]);
    }
  };
}
