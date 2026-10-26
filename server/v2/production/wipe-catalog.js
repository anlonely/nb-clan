import { VITAL_RUST_2X_SERVERS } from '../../vital-server-catalog.js';
import { ATLAS_2X_SERVER_PRESETS } from '../../atlas-server-catalog.js';
import { atlasServerForPreset, fetchAtlasServerCatalog } from '../../atlas-server-provider.js';
import { mooseCatalog } from '../management-adapters/source-host/moose-catalog.js';
import { project } from '../platform-admin-extras/model.js';
import { computedWipeTimes } from '../../wipe-schedule.js';
import { normalizeTime } from '../scheduling/time.js';
import { readMooseWipeDates } from './moose-wipe-dates.js';

function scheduledWipeDates(server, now) {
  if (!server.schedule) return {};
  try {
    const dates = computedWipeTimes(server, now);
    return { currentWipeAt: dates.currentStart, nextWipeAt: dates.nextStart, scheduleTimeZone: server.wipeTimeZone || 'UTC',
      currentWipeSource: 'schedule_fallback', nextWipeSource: 'schedule_fallback' };
  } catch {
    // An unavailable rule must not become an invented date or break selection.
    return {};
  }
}

// Wipe choices reuse provider IDs and configured overrides. This read projection
// is independent of the migration-pinned Vital administration catalog.
export function wipeServerCatalog(settings = {}, now = new Date()) {
  const overrides = settings.vitalServers?.overrides || [];
  const vital = VITAL_RUST_2X_SERVERS.filter(server => /\b2x\b/i.test(server.name))
    .map(server => ({ ...server, ...project({ ...server, status: server.status || 'active' },
      overrides.find(row => row.vitalServerId === server.vitalServerId)), provider: 'vital', kdaProvider: 'vital' }))
    .filter(server => server.status !== 'hidden');
  const moose = mooseCatalog().servers.map(server => ({ id: `moose-${server.id}`,
    name: server.name, directConnect: server.directConnect, provider: 'moose', mooseServerId: server.id, kdaProvider: 'manual' }));
  return [...ATLAS_2X_SERVER_PRESETS, ...vital, ...moose].map(server => {
    const keys = ['name', 'directConnect', 'provider', 'kdaProvider', 'vitalServerId', 'battlemetricsId', 'atlasId',
      'atlasAlias', 'atlasRegion', 'atlasQueryPort', 'mooseServerId', 'vipUrl', 'mapLink', 'rustMapsLink', 'notes'];
    const serverSnapshot = Object.fromEntries(keys.filter(key => server[key] !== undefined).map(key => [key, server[key]]));
    serverSnapshot.connectCommand = server.directConnect || '';
    Object.assign(serverSnapshot, scheduledWipeDates(server, now));
    return { id: server.id, label: server.name, serverSnapshot, serverScheduleSource: null };
  });
}

// Provider I/O belongs to the existing prepareOptions phase; reads stay synchronous.
export function createProductionWipeCatalog({ readSettings = () => ({}), now = Date.now,
  env = process.env, fetchImpl = fetch, readAtlasCatalog = fetchAtlasServerCatalog,
  readMooseDates = readMooseWipeDates } = {}) {
  let atlasCatalog = [];
  const mooseWipeDates = new Map();
  const atlasEnabled = () => env.NB_DISABLE_EXTERNAL_ATLAS !== '1';

  async function prepareAtlas() {
    if (!atlasEnabled()) { atlasCatalog = []; return; }
    try {
      // The provider owns its existing 60-second cache and in-flight deduplication.
      const rows = await readAtlasCatalog({ fetchImpl });
      atlasCatalog = Array.isArray(rows) ? rows : [];
    } catch {
      atlasCatalog = []; // A failed refresh leaves the calendar fallback usable.
    }
  }

  async function prepare() {
    await Promise.all([prepareAtlas(), ...mooseCatalog().servers.map(async server => {
      const dates = await readMooseDates(server.id);
      if (dates) mooseWipeDates.set(server.id, dates);
      else mooseWipeDates.delete(server.id);
    })]);
  }

  function read() {
    const instant = new Date(now());
    return wipeServerCatalog(readSettings(), instant).map(row => {
      const dates = mooseWipeDates.get(row.serverSnapshot.mooseServerId);
      const name = dates?.serverName?.trim() || row.label;
      const serverSnapshot = { ...row.serverSnapshot, ...dates, name };
      if (atlasEnabled() && serverSnapshot.provider === 'atlas') {
        const official = atlasServerForPreset(serverSnapshot, atlasCatalog);
        try {
          const nextWipeAt = normalizeTime(official?.nextWipeAt, 'UTC');
          // Recheck at read time, including the exact rollover instant, without I/O.
          if (nextWipeAt && Date.parse(nextWipeAt) > instant.getTime()) {
            serverSnapshot.nextWipeAt = nextWipeAt;
            serverSnapshot.nextWipeSource = 'atlas_official';
          }
        } catch { /* Invalid provider dates must not replace a usable schedule. */ }
      }
      return { ...row, label: name, serverSnapshot };
    });
  }

  return { prepare, read };
}
