import { text, stamp } from './model.js';

// Keep the explicit leaf paths used by the legacy detailed Vital lookup,
// including PVE, which was absent from the V2 request.
export const VITAL_STAT_PATHS = [
  'combat::kills', 'combat::killsT3', 'combat::deaths', 'combat::headshots',
  'combat::hits', 'combat::shots', 'combat::wounds', 'combat::suicides',
  'raiding::rockets', 'raiding::rocketsHighVelocity', 'raiding::rocketsIncendiary',
  'raiding::explosivesTimed', 'raiding::explosivesSatchel', 'raiding::grenadesBeancan',
  'raiding::grenadesF1', 'raiding::grenadesMolotov', 'raiding::ammoExplosive',
  'raiding::ammoGrenadesHE', 'raiding::ammoGrenadesSmoke', 'raiding::grenadesFlashbang',
  ...['sulfur.ore', 'metal.ore', 'hq.metal.ore', 'wood', 'cloth', 'mushroom',
    'pumpkin', 'corn', 'diesel_barrel', 'red.berry', 'blue.berry'].map(id => `farming::gathered::${id}`),
  'farming::looted::scrap',
  ...['wall', 'foundation', 'floor', 'foundation.triangle', 'floor.triangle',
    'wall.doorway', 'wall.window', 'wall.half', 'wall.low', 'roof', 'ramp',
    'block.stair.ushape'].map(id => `building::buildings::${id}`),
  ...['scientistnpc_roam_nvg_variant', 'scientistnpc_oilrig', 'scientistnpc_full_shotgun',
    'scientistnpc_patrol', 'scientistnpc_excavator', 'scientistnpc_roam',
    'scientistnpc_junkpile_pistol', 'scientistnpc_roamtethered', 'scientistnpc_heavy',
    'scientistnpc_full_lr300', 'npc_tunneldweller', 'npc_underwaterdweller',
    'patrolhelicopter', 'bradleyapc', 'wolf', 'bear', 'polarbear', 'stag', 'chicken',
    'crocodile'].map(id => `pve::killsNPC::${id}`),
  'pve::cratesHackedRig', 'pve::scrapRecycled', 'pve::scrapWheelWagered',
  'pve::scrapSlotsWagered', 'pve::scrapWheelWon', 'pve::scrapSlotsWon'
];

export function vitalValue(object, path) {
  let current = object;
  const parts = path.split('.');
  for (let i = 0; i < parts.length; i++) {
    if (current && Object.hasOwn(current, parts.slice(i).join('.'))) return current[parts.slice(i).join('.')];
    current = current?.[parts[i]];
  }
  return current ?? null;
}
export const vitalNumber = value => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') &&
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export function vitalBuildingCount(stats) {
  const observed = [];
  const walk = (value, depth = 0) => {
    if (depth > 5) return;
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.values(value).forEach(item => walk(item, depth + 1));
    else if (vitalNumber(value) !== null) observed.push(vitalNumber(value));
  };
  walk(vitalValue(stats, 'building.buildings'));
  return observed.length ? observed.reduce((sum, n) => sum + n, 0) : null;
}
export function vitalPlayTimeSeconds(raw) {
  // Explicit units only. An unqualified general.playTime is not evidence of
  // server online time, and must never populate the online-time leaderboard.
  for (const [unit, scale] of [['Seconds', 1], ['Minutes', 60], ['Hours', 3600]]) {
    for (const parent of ['', 'player.', 'statistics.', 'statistics.general.']) {
      for (const key of [`playTime${unit}`, `playtime${unit}`]) {
        const n = vitalNumber(vitalValue(raw, parent + key));
        if (n !== null) return n * scale;
      }
    }
    const n = vitalNumber(vitalValue(raw, `statistics.playtime.${unit.toLowerCase()}`));
    if (n !== null) return n * scale;
  }
  return null;
}
export function vitalCategories(stats) {
  const observed = new Map();
  const walk = (value, prefix = '', depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5) return;
    for (const [key, v] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, name, depth + 1);
      else if (observed.size < 200 && vitalNumber(v) !== null) observed.set(name, vitalNumber(v));
    }
  };
  walk(stats);
  const names = [...new Set([...VITAL_STAT_PATHS.map(path => path.replaceAll('::', '.')), ...observed.keys()])].slice(0, 200);
  const categories = new Map();
  for (const name of names) {
    const id = name.split('.')[0];
    if (!categories.has(id)) categories.set(id, { id, fields: [] });
    const value = vitalNumber(vitalValue(stats, name));
    categories.get(id).fields.push({ id: name, name, value, status: value === null ? 'not_observed' : 'observed' });
  }
  return [...categories.values()];
}

export function vitalWipeCatalog(raw, serverId, now = Date.now()) {
  const scope = String(serverId);
  const seen = new Set();
  const valid = raw.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const id = text(String(row.id || row.wipeId || ''), 120);
    const rowServer = text(String(row.gameServerId || row.serverId || ''), 80);
    const startTime = stamp(row.startTime), endTime = stamp(row.endTime);
    if (!id || rowServer && rowServer !== scope || row.startTime && !startTime || row.endTime && !endTime ||
      startTime && Date.parse(startTime) > now || endTime && (!startTime || Date.parse(endTime) < Date.parse(startTime) || Date.parse(endTime) > now)) return [];
    return [{ id, name: text(row.name || row.displayName, 120) || startTime || id,
      serverId: scope, providerWipeId: id, startTime, endTime,
      state: endTime ? 'archived' : startTime ? 'current' : 'unknown' }];
  }).sort((a, b) => (Date.parse(b.startTime) || 0) - (Date.parse(a.startTime) || 0));
  let currentAccepted = false;
  return valid.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id);
    if (row.state === 'current') {
      if (currentAccepted) return false;
      currentAccepted = true;
    }
    return true;
  });
}
