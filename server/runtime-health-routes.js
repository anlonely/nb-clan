import { isIP } from 'node:net';
import { readIntegrationEventsHealthStore } from './integration-events.js';
import { readOperationRunsHealthStore } from './operation-runs.js';
import { buildReadyzPayload, compactReadyzPayload } from './runtime-health.js';
import { readSyncJobsHealthStore } from './sync-job-store.js';
import { normalizeText, nowIso, storeRuntimeStatus } from './store.js';

function normalizeAddress(value) {
  let address = String(value || '').trim().replace(/^"|"$/g, '');
  if (address.toLowerCase().startsWith('for=')) address = address.slice(4).replace(/^"|"$/g, '');
  if (address.startsWith('[')) {
    const closingBracket = address.indexOf(']');
    if (closingBracket > 0) address = address.slice(1, closingBracket);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) {
    address = address.slice(0, address.lastIndexOf(':'));
  }
  address = address.split('%')[0];
  if (address.toLowerCase().startsWith('::ffff:')) address = address.slice(7);
  return address.toLowerCase();
}

export function isLoopbackAddress(value) {
  const address = normalizeAddress(value);
  if (address === '::1') return true;
  if (isIP(address) !== 4) return false;
  return address.split('.')[0] === '127';
}

function requestHostIsLoopback(req) {
  const hosts = [req.headers?.host, req.headers?.['x-forwarded-host']]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  return hosts.every((host) => {
    try {
      const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
      return hostname === 'localhost' || isLoopbackAddress(hostname);
    } catch {
      return false;
    }
  });
}

function forwardedClientAddresses(req) {
  const addresses = [
    req.headers?.['x-forwarded-for'],
    req.headers?.['x-real-ip'],
    req.headers?.['cf-connecting-ip'],
    req.headers?.['true-client-ip']
  ]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);
  const forwarded = String(req.headers?.forwarded || '');
  if (forwarded) {
    const matches = [...forwarded.matchAll(/(?:^|[;,]\s*)for=("?\[[^\]]+\]"?|"?[^;,\s"]+"?)/gi)];
    if (!matches.length) addresses.push('invalid-forwarded-header');
    else addresses.push(...matches.map((match) => match[1]));
  }
  return addresses;
}

export function isLoopbackHealthRequest(req = {}) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return false;
  if (!requestHostIsLoopback(req)) return false;
  return forwardedClientAddresses(req).every((address) => isLoopbackAddress(address));
}

export function registerRuntimeHealthRoutes(router, {
  battlemetricsQueueSnapshot = () => ({}),
  messageDeletionTaskRuntimeStatus = async () => ({})
} = {}) {
  router.get('/healthz', (_req, res) => {
    res.json({
      ok: true,
      check: 'liveness',
      status: 'alive',
      service: 'nb-clan-member-system',
      time: nowIso()
    });
  });

  router.get('/readyz', async (req, res, next) => {
    try {
      const fullDiagnostics = normalizeText(req.query?.detail, 20) === 'full';
      if (fullDiagnostics && !isLoopbackHealthRequest(req)) {
        res.status(403).json({
          ok: false,
          error: 'full_diagnostics_loopback_only',
          service: 'nb-clan-member-system',
          time: nowIso()
        });
        return;
      }
      const [status, messageDeletionTasks, syncStore, operationStore, integrationEventStore] = await Promise.all([
        storeRuntimeStatus({ sqliteSummary: fullDiagnostics }),
        messageDeletionTaskRuntimeStatus(),
        readSyncJobsHealthStore(8),
        readOperationRunsHealthStore(8),
        readIntegrationEventsHealthStore(8)
      ]);
      const readyz = buildReadyzPayload({
        status,
        messageDeletionTasks,
        syncStore,
        operationStore,
        integrationEventStore,
        battlemetricsQueue: battlemetricsQueueSnapshot()
      });
      res.status(readyz.statusCode).json(
        fullDiagnostics ? readyz.payload : compactReadyzPayload(readyz.payload)
      );
    } catch (error) {
      next(error);
    }
  });
}
