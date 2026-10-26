import express from 'express';
import { randomUUID } from 'node:crypto';
import { IdentityError } from '../identity/errors.js';
import { SchedulingRepository } from '../scheduling/repository.js';
import { SchedulingService } from '../scheduling/service.js';
import { createNotificationSystem } from '../notifications/index.js';
import { createNotificationPlatforms, createNotificationCallbackHandler, listNotificationTemplates, renderNotification } from '../notification-platforms/index.js';
import { assertNotificationTransport, assertNotificationOrigin } from '../notification-platforms/runtime-mode.js';

const MAX_BODY_BYTES = 262_144;
const MAX_CALLBACK_JOBS = 64;
const safeErrors = new Set(['NOTIFICATION_RUNTIME_STOPPED', 'NOTIFICATION_RUNTIME_IDENTITY_CHANGED',
  'NOTIFICATION_SETUP_REQUIRED', 'ISOLATED_TRANSPORT_REQUIRED', 'PLATFORM_AUTH_INVALID',
  'PLATFORM_PAYLOAD_INVALID', 'PLATFORM_EVENT_UNSUPPORTED', 'PLATFORM_REQUEST_EXPIRED',
  'PLATFORM_REPLAY_CONFLICT', 'PLATFORM_REPLAY_CAPACITY', 'PLATFORM_PREFLIGHT_TIMEOUT',
  'PRIVATE_RESPONSE_UNKNOWN', 'CALLBACK_BODY_TOO_LARGE', 'CALLBACK_BODY_TIMEOUT', 'CALLBACK_BODY_ABORTED', 'CALLBACK_CAPACITY']);
const errorCode = error => safeErrors.has(error?.errorCode) ? error.errorCode : 'NOTIFICATION_RUNTIME_FAILURE';
const fail = (code, status = 503) => { throw new IdentityError(code, status); };

// Consume the original wire bytes: Express's raw parser otherwise inflates KOOK first.
function collectBody(req, signal) {
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks = [];
    const finish = (error, value) => {
      clearTimeout(timer);
      req.removeListener('data', data); req.removeListener('end', end);
      req.removeListener('error', broken); req.removeListener('aborted', broken);
      signal.removeEventListener('abort', stopped);
      if (error) { req.resume(); reject(error); } else resolve(value);
    };
    const data = chunk => {
      length += chunk.length;
      if (length > MAX_BODY_BYTES) finish(new IdentityError('CALLBACK_BODY_TOO_LARGE', 413));
      else chunks.push(Buffer.from(chunk));
    };
    const end = () => finish(null, Buffer.concat(chunks));
    const broken = () => finish(new IdentityError('CALLBACK_BODY_ABORTED', 400));
    const stopped = () => finish(new IdentityError('NOTIFICATION_RUNTIME_STOPPED', 503));
    const timer = setTimeout(() => finish(new IdentityError('CALLBACK_BODY_TIMEOUT', 408)), 5000);
    timer.unref();
    if (signal.aborted) return stopped();
    if (req.readableEnded || req.destroyed) return broken();
    req.on('data', data); req.once('end', end); req.once('error', broken); req.once('aborted', broken);
    signal.addEventListener('abort', stopped, { once: true });
  });
}

/** An explicitly injected local owner. Factory/GET never install schema or start work. */
export function createNotificationRuntime({ getIdentity, catalog, transport, verifiers, publicOrigin,
  getCommunityHandler, getCardViewHandler, initializeSystem, getOpenWipeHandler, getSteamLinksHandler, bindSteamLinksMessage, now = Date.now, scheduledActorAccountId = null, intervalMs = 1000, runtimeMode = 'isolated' } = {}) {
  if (typeof getIdentity !== 'function' || typeof now !== 'function' ||
      !catalog || !['listTargets', 'getTarget', 'listOptions'].every(key => typeof catalog[key] === 'function') ||
      !['discord', 'kook'].every(platform => typeof verifiers?.[platform] === 'function') ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 60_000 ||
      !(scheduledActorAccountId === null || typeof scheduledActorAccountId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(scheduledActorAccountId))) {
    fail('NOTIFICATION_SETUP_REQUIRED');
  }
  assertNotificationTransport(transport, runtimeMode);
  assertNotificationOrigin(publicOrigin, runtimeMode);

  const controller = new AbortController(), callbackJobs = new Set();
  const workerId = `notification-runtime:${randomUUID()}`;
  const controlledTransport = {
    runtimeMode,
    request: args => transport.request({ ...args, context: { ...args.context,
      signal: AbortSignal.any([args.context.signal, controller.signal]) } }),
    respondPrivate: args => transport.respondPrivate({ ...args,
      signal: args.signal ? AbortSignal.any([args.signal, controller.signal]) : controller.signal })
  };
  const platforms = createNotificationPlatforms({ transport: controlledTransport, now, runtimeMode });
  let identityRef, scheduling, system, handlers, timer, tickPromise, stopPromise;
  let started = false, stopping = false, stopped = false;
  let ticks = 0, completedCallbacks = 0, failedCallbacks = 0, lastErrorCode = null, lastTick = null;
  const accepting = () => { if (stopping || stopped) fail('NOTIFICATION_RUNTIME_STOPPED'); };
  const recordError = error => { lastErrorCode = errorCode(error); };

  function getScheduling(identity) {
    accepting();
    if (!identity?.repo?.db || typeof identity.actorForAccount !== 'function') fail('NOTIFICATION_SETUP_REQUIRED');
    if (identityRef && identityRef !== identity) fail('NOTIFICATION_RUNTIME_IDENTITY_CHANGED');
    if (!scheduling) {
      const next = new SchedulingService(new SchedulingRepository(identity.repo.db), identity, { now });
      identityRef = identity; scheduling = next;
    }
    return scheduling;
  }
  function getSystem(identity) {
    const sharedScheduling = getScheduling(identity);
    if (!system) {
      const next = createNotificationSystem({ identity, scheduling: sharedScheduling, catalog,
        renderer: renderNotification, templates: listNotificationTemplates(), platforms, publicOrigin, now, options: { runtimeMode } });
      initializeSystem?.(next, identity);
      system = next;
    }
    return system;
  }
  function getHandler(identity, platform) {
    const sharedSystem = getSystem(identity);
    handlers ||= {};
    return handlers[platform] ||= createNotificationCallbackHandler({ platform, identity, scheduling,
      verify: verifiers[platform], resolveActionReference: sharedSystem.references.resolve,
      publicOrigin, transport: controlledTransport, now, runtimeMode,
      viewDiscordCard: proof => {
        if(proof.payload.cardKind==='signup')return sharedSystem.service.localizedDiscordView(proof);
        const handler=getCardViewHandler?.(identity);if(typeof handler!=='function')fail('COMMUNITY_HANDLER_UNAVAILABLE');return handler(proof);
      },
      submitDiscordSignup: verified => sharedSystem.service.submitDiscordSignup(verified),
      handleOpenWipe: proof => { const handler = getOpenWipeHandler?.(identity); if (typeof handler !== 'function') fail('OPEN_WIPE_UNAVAILABLE'); return handler(proof); },
      handleSteamLinks: proof => { const handler = getSteamLinksHandler?.(identity); if (typeof handler !== 'function') fail('STEAM_LINKS_UNAVAILABLE'); return handler(proof); },
      bindSteamLinksMessage,
      handleCommunity: proof => { const handler=getCommunityHandler?.(identity,platform); if(typeof handler!=='function') fail('COMMUNITY_HANDLER_UNAVAILABLE'); return handler(proof); } });
  }

  async function handleCallback(platform, envelope, io) {
    accepting();
    if (callbackJobs.size >= MAX_CALLBACK_JOBS) fail('CALLBACK_CAPACITY');
    const job = (async () => {
      const identity = await getIdentity();
      accepting();
      await getHandler(identity, platform)(envelope, io);
      completedCallbacks++;
    })();
    callbackJobs.add(job);
    try { return await job; }
    catch (error) { failedCallbacks++; recordError(error); throw error; }
    finally { callbackJobs.delete(job); }
  }

  const callbackRouter = express.Router();
  for (const platform of ['discord', 'kook']) callbackRouter.post(`/integrations/v2/notifications/${platform}`, (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (callbackJobs.size >= MAX_CALLBACK_JOBS) {
      req.resume();
      res.status(503).json({ error: { errorCode: 'CALLBACK_CAPACITY', messageKey: 'CALLBACK_CAPACITY', retryable: true } });
      return;
    }
    const job = (async () => {
      accepting();
      const rawBody = await collectBody(req, controller.signal);
      const identity = await getIdentity();
      accepting();
      await getHandler(identity, platform)({ rawBody, headers: req.headers, receivedAt: new Date(now()).toISOString() }, {
        ack(payload) {
          if (res.destroyed || res.writableEnded) fail('CALLBACK_BODY_ABORTED', 400);
          res.status(200).json(payload);
        }
      });
      completedCallbacks++;
    })();
    callbackJobs.add(job);
    job.then(() => callbackJobs.delete(job), error => {
      callbackJobs.delete(job); failedCallbacks++; recordError(error);
      if (!res.headersSent && !res.destroyed) {
        const code = errorCode(error);
        const status = error instanceof IdentityError && error.status >= 400 && error.status <= 599 ? error.status : 503;
        res.status(status).json({ error: { errorCode: code, messageKey: code, retryable: status >= 500 } });
      }
    });
  });

  function tick() {
    if (tickPromise) return tickPromise;
    if (stopping || stopped) return Promise.resolve({ skipped: true, reason: 'NOTIFICATION_RUNTIME_STOPPED' });
    const work = (async () => {
      const identity = await getIdentity();
      if (stopping || stopped) return { skipped: true, reason: 'NOTIFICATION_RUNTIME_STOPPED' };
      const sharedSystem = getSystem(identity);
      if (scheduledActorAccountId !== null) scheduling.advanceScheduled(identity.actorForAccount(scheduledActorAccountId));
      const result = await sharedSystem.worker.runOnce({ workerId, limit: 20 });
      ticks++; lastTick = structuredClone(result);
      return result;
    })();
    tickPromise = work;
    work.then(() => { tickPromise = null; }, error => { tickPromise = null; recordError(error); });
    return work;
  }
  function start() {
    accepting();
    if (started) return;
    started = true;
    timer = setInterval(() => { tick().catch(recordError); }, intervalMs);
    timer.unref();
  }
  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(timer); timer = null;
    controller.abort();
    // Keep SQLite open until every acknowledged callback has finished G03/G04 work.
    // A provider may ignore cancellation; draining it is safer than closing its database.
    stopPromise = (async () => {
      await Promise.allSettled([system?.worker.stop(), tickPromise, ...callbackJobs]);
      stopped = true;
    })();
    return stopPromise;
  }
  function diagnostics() {
    return { runtimeMode, started, stopping, stopped, timerActive: Boolean(timer),
      tickActive: Boolean(tickPromise), callbackJobs: callbackJobs.size, ticks,
      completedCallbacks, failedCallbacks, lastErrorCode, lastTick: lastTick && structuredClone(lastTick) };
  }
  return Object.freeze({ runtimeMode, getSystem, getScheduling, handleCallback, callbackRouter, start, tick, stop, diagnostics });
}
