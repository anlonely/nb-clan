import {
  createId,
  normalizeText,
  nowIso,
  patchStoreCache,
  readStore,
  runStoreWriteTask,
  updateStore
} from './store.js';
import {
  getSqliteCollection,
  getSqliteRecord,
  getSqliteRecordsByJsonField,
  getSqliteRecordsByJsonFields,
  writeSqliteStorePatch
} from './storage/repository.js';
import { sqliteEnabled, sqlitePrimaryMode } from './storage/sqlite.js';
import { mergeRecordsById, readSqliteRecordsByIds } from './sqlite-read-utils.js';
import { persistTraceRecordWithFallback } from './trace-record-persistence.js';

const INTEGRATION_EVENT_HISTORY_LIMIT = 1000;
const INTEGRATION_EVENT_FAILED_HISTORY_LIMIT = 500;
const INTEGRATION_EVENT_FAILED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const INTEGRATION_EVENT_STATUSES = new Set(['received', 'queued', 'processing', 'processed', 'failed', 'duplicate', 'skipped']);
const INTEGRATION_EVENT_TERMINAL_STATUSES = new Set(['processed', 'failed', 'duplicate', 'skipped']);
const INTEGRATION_EVENT_PLATFORMS = new Set(['discord', 'kook', 'rustplus', 'wechat', 'system']);

function timestampForSort(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeIntegrationEventStatus(value) {
  const status = normalizeText(value, 40);
  return INTEGRATION_EVENT_STATUSES.has(status) ? status : 'received';
}

function normalizeIntegrationEventPlatform(value) {
  const platform = normalizeText(value, 40);
  return INTEGRATION_EVENT_PLATFORMS.has(platform) ? platform : 'system';
}

function integrationEventIsTerminal(status) {
  return INTEGRATION_EVENT_TERMINAL_STATUSES.has(normalizeIntegrationEventStatus(status));
}

function integrationEventNeedsRetentionCheck(event = {}, previous = null) {
  return integrationEventIsTerminal(event?.status) || integrationEventIsTerminal(previous?.status);
}

function sanitizeIntegrationEventMetadata(value, depth = 0) {
  if (value === null || value === undefined) return {};
  if (depth > 2) return {};
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => (
      item && typeof item === 'object'
        ? sanitizeIntegrationEventMetadata(item, depth + 1)
        : normalizeText(item, 240)
    ));
  }
  if (typeof value !== 'object') return normalizeText(value, 240);
  const blocked = /token|secret|password|openid|unionid|authorization|cookie|signature/i;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 80)) {
    const safeKey = normalizeText(key, 80);
    if (!safeKey || blocked.test(safeKey)) continue;
    result[safeKey] = item && typeof item === 'object'
      ? sanitizeIntegrationEventMetadata(item, depth + 1)
      : normalizeText(item, 500);
  }
  return result;
}

export function ensureIntegrationEvents(store = {}) {
  store.integrationEvents ||= [];
  const nowMs = Date.now();
  const sorted = store.integrationEvents
    .filter((event) => event?.id)
    .toSorted((left, right) => timestampForSort(right.updatedAt || right.processedAt || right.receivedAt) - timestampForSort(left.updatedAt || left.processedAt || left.receivedAt));
  const retained = [];
  let failed = 0;
  let other = 0;
  for (const event of sorted) {
    const status = normalizeIntegrationEventStatus(event.status);
    if (status === 'failed') {
      const ageMs = nowMs - timestampForSort(event.updatedAt || event.processedAt || event.receivedAt);
      if (failed < INTEGRATION_EVENT_FAILED_HISTORY_LIMIT || ageMs <= INTEGRATION_EVENT_FAILED_RETENTION_MS) {
        retained.push(event);
        failed += 1;
      }
      continue;
    }
    if (other < INTEGRATION_EVENT_HISTORY_LIMIT) {
      retained.push(event);
      other += 1;
    }
  }
  store.integrationEvents = retained.slice(0, INTEGRATION_EVENT_HISTORY_LIMIT + INTEGRATION_EVENT_FAILED_HISTORY_LIMIT);
  return store.integrationEvents;
}

function createIntegrationEventInStore(store, input = {}, options = {}) {
  const now = nowIso();
  const platform = normalizeIntegrationEventPlatform(input.platform);
  const eventType = normalizeText(input.eventType || input.type, 120) || 'event';
  const dedupeKey = normalizeText(input.dedupeKey, 240);
  const events = ensureIntegrationEvents(store);
  const previousEvent = options.dedupe && dedupeKey
    ? events.find((event) => event.platform === platform && event.dedupeKey === dedupeKey && event.status !== 'duplicate')
    : null;
  const status = previousEvent ? 'duplicate' : normalizeIntegrationEventStatus(input.status || 'received');
  const event = {
    id: normalizeText(input.id, 120) || createId('integration_event'),
    platform,
    eventType,
    dedupeKey,
    sourceId: normalizeText(input.sourceId, 160),
    status,
    receivedAt: input.receivedAt || now,
    processedAt: input.processedAt || (['processed', 'failed', 'duplicate', 'skipped'].includes(status) ? now : ''),
    operationRunId: normalizeText(input.operationRunId, 120),
    errorSummary: normalizeText(input.errorSummary, 500),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    metadata: sanitizeIntegrationEventMetadata({
      ...(input.metadata || {}),
      ...(previousEvent ? { duplicateOf: previousEvent.id } : {})
    })
  };
  events.unshift(event);
  ensureIntegrationEvents(store);
  return { event, duplicate: Boolean(previousEvent), previousEvent };
}

function updateIntegrationEventInStore(store, integrationEventId, patch = {}) {
  const id = normalizeText(integrationEventId, 120);
  if (!id) return null;
  const events = ensureIntegrationEvents(store);
  const index = events.findIndex((event) => event.id === id);
  if (index < 0) return null;
  const previous = events[index];
  const status = patch.status ? normalizeIntegrationEventStatus(patch.status) : normalizeIntegrationEventStatus(previous.status);
  const updatedAt = patch.updatedAt || nowIso();
  const metadata = patch.metadata
    ? sanitizeIntegrationEventMetadata({ ...(previous.metadata || {}), ...patch.metadata })
    : (previous.metadata || {});
  const next = {
    ...previous,
    ...patch,
    platform: patch.platform ? normalizeIntegrationEventPlatform(patch.platform) : previous.platform,
    eventType: patch.eventType ? normalizeText(patch.eventType, 120) : previous.eventType,
    dedupeKey: patch.dedupeKey ? normalizeText(patch.dedupeKey, 240) : previous.dedupeKey,
    sourceId: patch.sourceId ? normalizeText(patch.sourceId, 160) : previous.sourceId,
    operationRunId: patch.operationRunId ? normalizeText(patch.operationRunId, 120) : previous.operationRunId,
    errorSummary: Object.hasOwn(patch, 'errorSummary') ? normalizeText(patch.errorSummary, 500) : previous.errorSummary,
    status,
    processedAt: patch.processedAt || previous.processedAt || (['processed', 'failed', 'duplicate', 'skipped'].includes(status) ? updatedAt : ''),
    updatedAt,
    metadata
  };
  events[index] = next;
  ensureIntegrationEvents(store);
  return next;
}

function integrationEventRetentionTrimConfigs(nowMs = Date.now()) {
  const failedCutoff = new Date(nowMs - INTEGRATION_EVENT_FAILED_RETENTION_MS).toISOString();
  return [
    {
      field: 'updatedAt',
      limit: INTEGRATION_EVENT_FAILED_HISTORY_LIMIT,
      order: 'desc',
      filters: { status: 'failed' },
      afterOffsetRange: { field: 'updatedAt', to: failedCutoff }
    },
    {
      field: 'updatedAt',
      limit: INTEGRATION_EVENT_HISTORY_LIMIT,
      order: 'desc',
      filters: { status: ['received', 'queued', 'processing', 'processed', 'duplicate', 'skipped'] }
    }
  ];
}

async function patchIntegrationEventsCache(upserts = [], deleteIds = []) {
  try {
    await patchStoreCache((store) => {
      store.integrationEvents ||= [];
      const deleteSet = new Set(deleteIds || []);
      if (deleteSet.size) {
        store.integrationEvents = store.integrationEvents.filter((event) => !deleteSet.has(event?.id));
      }
      for (const event of upserts || []) {
        if (!event?.id) continue;
        if (deleteSet.has(event.id)) continue;
        const index = store.integrationEvents.findIndex((item) => item.id === event.id);
        if (index >= 0) store.integrationEvents[index] = event;
        else store.integrationEvents.unshift(event);
      }
      ensureIntegrationEvents(store);
    });
  } catch (error) {
    console.warn('[nb-clan] sqlite integration event cache patch failed:', error?.message || error);
  }
}

async function createIntegrationEventDirect(input = {}, options = {}) {
  const platform = normalizeIntegrationEventPlatform(input.platform);
  const dedupeKey = normalizeText(input.dedupeKey, 240);
  const dedupeEvents = options.dedupe && dedupeKey
    ? await getSqliteRecordsByJsonFields('integrationEvents', { platform, dedupeKey }, { limit: 0 })
    : [];
  const eventStore = {
    integrationEvents: dedupeEvents.filter((event) => (
      event.platform === platform && event.dedupeKey === dedupeKey && event.status !== 'duplicate'
    ))
  };
  const result = createIntegrationEventInStore(eventStore, input, options);
  const event = result?.event || null;
  const trims = integrationEventNeedsRetentionCheck(event)
    ? integrationEventRetentionTrimConfigs()
    : [];
  let deleteIds = [];
  if (event) {
    const patchResult = await writeSqliteStorePatch({
      reason: 'integration_event_create',
      upserts: { integrationEvents: [event] },
      trims: trims.length ? { integrationEvents: trims } : {}
    });
    deleteIds = patchResult.trimmed?.integrationEvents || [];
  }
  await patchIntegrationEventsCache(event ? [event] : [], deleteIds);
  return result;
}

function scopedIntegrationEventReadUnavailable(error) {
  return Object.assign(new Error(`integration event scoped read unavailable: ${error?.message || error}`), {
    code: 'sqlite_scoped_read_unavailable',
    cause: error
  });
}

async function readIntegrationEventByIdDirect(id) {
  try {
    return await getSqliteRecord('integrationEvents', id);
  } catch (error) {
    console.warn('[nb-clan] sqlite integration event get fallback:', error?.message || error);
    try {
      const [event] = await readSqliteRecordsByIds('integrationEvents', [id]);
      return event || null;
    } catch (scopedError) {
      throw scopedIntegrationEventReadUnavailable(scopedError);
    }
  }
}

async function updateIntegrationEventDirect(integrationEventId, patch = {}) {
  const id = normalizeText(integrationEventId, 120);
  if (!id) return null;
  const previous = await readIntegrationEventByIdDirect(id);
  if (!previous) return null;
  const eventStore = { integrationEvents: [previous] };
  const event = updateIntegrationEventInStore(eventStore, id, patch);
  if (!event) return null;
  const trims = integrationEventNeedsRetentionCheck(event, previous)
    ? integrationEventRetentionTrimConfigs()
    : [];
  const patchResult = await writeSqliteStorePatch({
    reason: 'integration_event_update',
    upserts: { integrationEvents: [event] },
    trims: trims.length ? { integrationEvents: trims } : {}
  });
  const deleteIds = patchResult.trimmed?.integrationEvents || [];
  await patchIntegrationEventsCache(event ? [event] : [], deleteIds);
  return event;
}

export async function createIntegrationEvent(input = {}, options = {}) {
  if (sqlitePrimaryMode()) {
    return persistTraceRecordWithFallback({
      name: 'integration_event_create',
      direct: () => runStoreWriteTask(() => createIntegrationEventDirect(input, options)),
      fallbackValue: null
    });
  }
  let result = null;
  await updateStore((store) => {
    result = createIntegrationEventInStore(store, input, options);
  });
  return result;
}

export async function updateIntegrationEvent(integrationEventId, patch = {}) {
  if (sqlitePrimaryMode()) {
    return persistTraceRecordWithFallback({
      name: 'integration_event_update',
      direct: () => runStoreWriteTask(() => updateIntegrationEventDirect(integrationEventId, patch)),
      fallbackValue: null
    });
  }
  let event = null;
  await updateStore((store) => {
    event = updateIntegrationEventInStore(store, integrationEventId, patch);
  });
  return event;
}

export function publicIntegrationEvent(event = {}) {
  return {
    id: event.id || '',
    platform: normalizeIntegrationEventPlatform(event.platform),
    eventType: normalizeText(event.eventType, 120),
    dedupeKey: event.dedupeKey || '',
    sourceId: event.sourceId || '',
    status: normalizeIntegrationEventStatus(event.status),
    receivedAt: event.receivedAt || '',
    processedAt: event.processedAt || '',
    operationRunId: event.operationRunId || '',
    errorSummary: event.errorSummary || '',
    createdAt: event.createdAt || '',
    updatedAt: event.updatedAt || '',
    metadata: sanitizeIntegrationEventMetadata(event.metadata || {})
  };
}

function integrationEventPlatformSummary(events = []) {
  const summary = {};
  for (const event of events) {
    const platform = normalizeIntegrationEventPlatform(event.platform);
    summary[platform] ||= {
      total: 0,
      failed: 0,
      duplicate: 0,
      processed: 0,
      skipped: 0,
      latestAt: ''
    };
    const item = summary[platform];
    const status = normalizeIntegrationEventStatus(event.status);
    item.total += 1;
    if (status === 'failed') item.failed += 1;
    if (status === 'duplicate') item.duplicate += 1;
    if (status === 'processed') item.processed += 1;
    if (status === 'skipped') item.skipped += 1;
    const latest = event.updatedAt || event.processedAt || event.receivedAt || '';
    if (timestampForSort(latest) > timestampForSort(item.latestAt)) item.latestAt = latest;
  }
  for (const item of Object.values(summary)) {
    item.failureRate = item.total ? Number((item.failed / item.total).toFixed(4)) : 0;
    item.duplicateRate = item.total ? Number((item.duplicate / item.total).toFixed(4)) : 0;
    const terminal = item.failed + item.processed + item.skipped + item.duplicate;
    item.terminalFailureRate = terminal ? Number((item.failed / terminal).toFixed(4)) : 0;
  }
  return summary;
}

function integrationEventFailureRates(events = []) {
  const byPlatform = integrationEventPlatformSummary(events);
  const totals = Object.values(byPlatform).reduce((acc, item) => {
    acc.total += Number(item.total || 0);
    acc.failed += Number(item.failed || 0);
    acc.duplicate += Number(item.duplicate || 0);
    acc.processed += Number(item.processed || 0);
    acc.skipped += Number(item.skipped || 0);
    return acc;
  }, {
    total: 0,
    failed: 0,
    duplicate: 0,
    processed: 0,
    skipped: 0
  });
  const terminal = totals.failed + totals.processed + totals.skipped + totals.duplicate;
  return {
    ...totals,
    terminal,
    failureRate: totals.total ? Number((totals.failed / totals.total).toFixed(4)) : 0,
    duplicateRate: totals.total ? Number((totals.duplicate / totals.total).toFixed(4)) : 0,
    terminalFailureRate: terminal ? Number((totals.failed / terminal).toFixed(4)) : 0,
    byPlatform
  };
}

export function integrationEventsPayload(store, { limit = 20 } = {}) {
  const events = ensureIntegrationEvents(store)
    .slice()
    .map(publicIntegrationEvent)
    .toSorted((left, right) => timestampForSort(right.updatedAt || right.processedAt || right.receivedAt) - timestampForSort(left.updatedAt || left.processedAt || left.receivedAt));
  const max = Math.max(1, Math.min(100, Number(limit) || 20));
  const failureRates = integrationEventFailureRates(events);
  const partial = Boolean(store.integrationEventsPartial);
  const readError = normalizeText(store.integrationEventsReadError, 500);
  return {
    failed: events.filter((event) => event.status === 'failed').slice(0, max),
    duplicates: events.filter((event) => event.status === 'duplicate').slice(0, max),
    recent: events.slice(0, max),
    byPlatform: failureRates.byPlatform,
    failureRates,
    partial,
    readError,
    updatedAt: nowIso()
  };
}

function integrationEventsPartialStore(error, source = '') {
  return {
    integrationEvents: [],
    integrationEventsPartial: true,
    integrationEventsReadError: normalizeText(error?.message || error, 500),
    integrationEventsReadSource: normalizeText(source, 120)
  };
}

export async function readIntegrationEventsListStore() {
  if (!sqliteEnabled()) return readStore();
  try {
    return {
      integrationEvents: await getSqliteRecordsByJsonField('integrationEvents', 'status', [...INTEGRATION_EVENT_STATUSES], { limit: 0 })
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite integration events partial fallback:', error?.message || error);
    return integrationEventsPartialStore(error, 'list');
  }
}

export async function readIntegrationEventsHealthStore(limit = 100) {
  if (!sqliteEnabled()) return readStore();
  try {
    const max = Math.max(8, Math.min(100, Number(limit) || 100));
    const [recentEvents, failedEvents, duplicateEvents] = await Promise.all([
      getSqliteRecordsByJsonField('integrationEvents', 'status', [...INTEGRATION_EVENT_STATUSES], { limit: max }),
      getSqliteRecordsByJsonField('integrationEvents', 'status', ['failed'], { limit: max }),
      getSqliteRecordsByJsonField('integrationEvents', 'status', ['duplicate'], { limit: max })
    ]);
    return {
      integrationEvents: mergeRecordsById(recentEvents, failedEvents, duplicateEvents)
    };
  } catch (error) {
    console.warn('[nb-clan] sqlite integration events health partial fallback:', error?.message || error);
    return integrationEventsPartialStore(error, 'health');
  }
}

export function rustplusIntegrationEventInput(input = {}, result = {}, error = null, options = {}) {
  const event = result?.event || {};
  const raw = input && typeof input === 'object' ? input : {};
  const eventType = normalizeText(event.type || raw.type || raw.event || raw.kind, 120) || 'relay_event';
  const sourceId = normalizeText(
    options.eventId ||
      event.chatMessageId ||
      event.inviteRecordId ||
      raw.eventId ||
      raw.id ||
      raw.messageId ||
      raw.clientId ||
      event.clientId,
    160
  );
  const dedupeKey = [
    'rustplus',
    eventType,
    event.serverKey || raw.serverKey || raw.server?.key || raw.serverId || '',
    sourceId || event.memberSteamId || raw.steamId || raw.member?.steamId || ''
  ].map((item) => normalizeText(item, 160)).filter(Boolean).join(':');
  const skipped = Boolean(event.skipped || event.skipReason);
  return {
    platform: 'rustplus',
    eventType,
    dedupeKey,
    sourceId,
    status: error ? 'failed' : (skipped ? 'duplicate' : 'processed'),
    receivedAt: event.receivedAt || options.receivedAt || nowIso(),
    processedAt: nowIso(),
    errorSummary: error ? normalizeText(error.message || error, 500) : '',
    metadata: {
      transport: options.transport || 'http',
      clientId: event.clientId || raw.clientId || raw.client?.id || '',
      serverKey: event.serverKey || raw.serverKey || raw.server?.key || '',
      skipped,
      skipReason: event.skipReason || '',
      inserted: event.inserted,
      applied: event.applied,
      memberSteamId: event.memberSteamId || raw.member?.steamId || '',
      payloadBytes: Buffer.byteLength(JSON.stringify(raw || {}), 'utf8')
    }
  };
}
