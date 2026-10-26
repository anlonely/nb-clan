import { RISK_FIELDS, RISK_ERRORS } from '../management-adapters/source-host/risk-model.js';
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const safe = value => typeof value === 'string' ? value.slice(0, 180) : null;
const statuses = ['observed', 'partial', 'private', 'unavailable', 'not_required'];
export function riskScanDTO(profile, member) {
  const raw = profile?.riskScan;
  if (!raw || profile.steamId !== member.steamId || raw.steamId !== member.steamId) return null;
  const sources = {}, fields = {};
  for (const [source, names] of Object.entries(RISK_FIELDS)) {
    const row = raw.sources?.[source];
    if (row) sources[source] = { status: statuses.includes(row.status) ? row.status : 'unavailable', required: row.required === true,
      checkedAt: date(row.checkedAt), error: RISK_ERRORS.includes(row.error) ? row.error : null };
    for (const name of names) {
      const field = raw.fields?.[name] || (name === 'officialKda.kd' ? raw.fields?.['officialKda.kda'] : null); if (!field) continue;
      const context = Object.fromEntries(['steamId','playerId','serverId','wipeId','from','to'].filter(key => typeof field.context?.[key] === 'string').map(key => [key, safe(field.context[key])]));
      fields[name] = { source, status: statuses.includes(field.status) ? field.status : 'unavailable',
        required: field.required === true, checkedAt: date(field.checkedAt), observedAt: date(field.observedAt),
        retained: field.retained === true, error: RISK_ERRORS.includes(field.error) ? field.error : null, context };
    }
  }
  return { quality: ['complete','partial','unknown'].includes(raw.quality) ? raw.quality : 'unknown',
    checkedAt: date(raw.checkedAt), lastCompleteAt: date(raw.lastCompleteAt), sources, fields };
}
export function riskFieldEvidence(scan, type) {
  if (scan && type === 'steam_ban_or_restriction') {
    const rows = RISK_FIELDS.bans.map(key => scan.fields[key]).filter(Boolean);
    if (!rows.length) return null;
    return { status: rows.every(row => row.status === 'observed') ? 'observed' : 'unavailable',
      retained: rows.some(row => row.retained),
      observedAt: rows.every(row => row.observedAt) ? rows.map(row => row.observedAt).sort()[0] : null,
      context: rows[0].context };
  }
  const name = { inventory_value:'inventoryValue', playtime_hours:'playTimeMinutes', no_online_days:'battlemetricsLastOnlineAt',
    account_restricted:'accountRestricted', steam_ban_or_restriction:'vacBanned', kd:'officialKda.kd', kills:'officialKda.kills',
    deaths:'officialKda.deaths', rockets:'officialKda.rockets', private_inventory:'inventoryVisibility', private_playtime:'playTimeVisibility' }[type];
  return name ? scan?.fields[name] || (name === 'officialKda.kd' ? scan?.fields['officialKda.kda'] : null) || null : null;
}
