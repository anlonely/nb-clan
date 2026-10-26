// One definition for the legacy seven Vital leaderboards, the current UI and
// exported reports. Values retain their stored units; missing values stay null.
export const VITAL_LEADERBOARDS = Object.freeze([
  { id: 'kills', metric: 'kills', label: { zh: '击杀排行', en: 'Kills leaderboard' } },
  { id: 't3Kills', metric: 't3Kills', label: { zh: 'T3 击杀排行', en: 'T3 kills leaderboard' } },
  { id: 'rockets', metric: 'rockets', label: { zh: '火箭排行', en: 'Rockets leaderboard' } },
  { id: 'metalOre', metric: 'metalOre', label: { zh: '金属矿石排行', en: 'Metal ore leaderboard' } },
  { id: 'sulfur', metric: 'sulfur', label: { zh: '硫磺排行', en: 'Sulfur leaderboard' } },
  { id: 'building', metric: 'building', label: { zh: '建筑排行', en: 'Building leaderboard' } },
  { id: 'online_minutes', metric: 'onlineSeconds', unit: 'seconds', label: { zh: '在线时间排行', en: 'Server playtime leaderboard' } }
]);

export const VITAL_CATEGORIES = Object.freeze([
  { id: 'combat', label: { zh: '战斗与伤亡', en: 'Combat and deaths' }, metrics: ['kills', 'deaths', 't3Kills', 'kd', 'assists', 'kda'] },
  { id: 'raiding', label: { zh: '拆家与爆炸物', en: 'Raiding and explosives' }, metrics: ['rockets'] },
  { id: 'farming', label: { zh: '采集与资源', en: 'Gathering and resources' }, metrics: ['metalOre', 'sulfur'] },
  { id: 'building', label: { zh: '建造与工程', en: 'Building and engineering' }, metrics: ['building'] },
  { id: 'pve', label: { zh: 'PVE 与环境', en: 'PvE and wildlife' }, metrics: [] },
  { id: 'general', label: { zh: '在线与其他数据', en: 'Playtime and other stats' }, metrics: ['onlineSeconds', 'playTimeSeconds'] }
]);

export function leaderboardById(id) {
  return VITAL_LEADERBOARDS.find(spec => spec.id === id || spec.metric === id) || null;
}

export function leaderboardLabel(spec, language = 'zh') {
  const definition = typeof spec === 'string' ? leaderboardById(spec) : spec;
  return definition?.label[language] || definition?.label.en || '';
}

export function rankLeaderboardRows(items, spec) {
  const definition = typeof spec === 'string' ? leaderboardById(spec) : spec;
  if (!definition) return [];
  const rows = items.map((row, index) => {
    const value = row.values?.[definition.metric];
    return { row, index, value: row.capabilities?.[definition.metric] !== false && Number.isFinite(value) && value >= 0 ? value : null };
  }).sort((a, b) => (a.value === null) - (b.value === null) || (b.value ?? 0) - (a.value ?? 0) ||
    String(a.row.id || a.row.memberId || a.row.steamId || '').localeCompare(String(b.row.id || b.row.memberId || b.row.steamId || '')) || a.index - b.index);
  let previousValue, previousRank;
  return rows.map(({ row, value }, index) => {
    const rank = value === null ? null : value === previousValue ? previousRank : index + 1;
    if (value !== null) { previousValue = value; previousRank = rank; }
    return { row, value, rank };
  });
}
