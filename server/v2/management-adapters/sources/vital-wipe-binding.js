import { need, stamp, text } from '../../stats/model.js';

const START_TOLERANCE_MS = 2 * 60 * 60 * 1000;

/** Resolve the selected local period, never the provider's latest/all-time period. */
export function selectVitalWipeForStats(wipe, serverId, rows, now = Date.now()) {
  need(/^\d{1,8}$/.test(String(serverId)), 'VITAL_WIPE_INVALID_DATA', 503);
  const localStart = stamp(wipe.serverActualWipeAt || wipe.serverScheduledWipeAt || wipe.actualStartedAt || wipe.musterAt || wipe.legacyRaw?.startedAt);
  need(localStart, 'VITAL_WIPE_START_REQUIRED', 409);
  need(Date.parse(localStart) <= now, 'VITAL_WIPE_NOT_STARTED', 409);
  need(Array.isArray(rows) && rows.length <= 100, 'VITAL_WIPE_INVALID_DATA', 503);
  const candidates = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = text(String(row.id || row.wipeId || ''), 120);
    const remoteServer = String(row.gameServerId || row.serverId || '');
    const startTime = stamp(row.startTime), endTime = stamp(row.endTime);
    if (!id || !/^[A-Za-z0-9:_-]+$/.test(id) || remoteServer && remoteServer !== String(serverId) ||
      !startTime || Date.parse(startTime) > now || row.endTime && (!endTime || Date.parse(endTime) < Date.parse(startTime) || Date.parse(endTime) > now) ||
      Math.abs(Date.parse(startTime) - Date.parse(localStart)) > START_TOLERANCE_MS) continue;
    const candidate = { providerServerId: String(serverId), providerWipeId: id, startTime };
    need(!candidates.has(id) || candidates.get(id).startTime === startTime, 'VITAL_WIPE_INVALID_DATA', 503);
    candidates.set(id, candidate);
  }
  need(candidates.size, 'VITAL_WIPE_NOT_FOUND', 409);
  need(candidates.size === 1, 'VITAL_WIPE_AMBIGUOUS', 409);
  return [...candidates.values()][0];
}
