export const KDA_TABLE_COLUMNS = [
  { id: 'rank', label: 'rank' },
  { id: 'nickname', label: 'nickname', sortKey: 'displayName' },
  { id: 'squadName', label: 'squadName', sortKey: 'squadName' },
  { id: 'onlineTime', label: 'onlineTime', sortKey: 'onlineTimeMinutes' },
  { id: 'kills', label: 'kills', sortKey: 'kills' },
  { id: 't3Kills', label: 't3Kills', sortKey: 't3Kills' },
  { id: 'deaths', label: 'deaths', sortKey: 'deaths' },
  { id: 'kda', label: 'kda', sortKey: 'kda' },
  { id: 'rockets', label: 'rockets', sortKey: 'rockets' },
  { id: 'sulfur', label: 'sulfur', sortKey: 'sulfur' },
  { id: 'metalOre', label: 'metalOre', sortKey: 'metalOre' },
  { id: 'building', label: 'building', sortKey: 'building' }
];

export function firstPositiveMinutes(...values) {
  for (const value of values) {
    const minutes = Number(value || 0);
    if (Number.isFinite(minutes) && minutes > 0) return minutes;
  }
  return 0;
}

export function kdaRowOnlineMinutes(row = {}) {
  const summary = row?.onlineSummary && typeof row.onlineSummary === 'object' ? row.onlineSummary : {};
  return firstPositiveMinutes(
    row?.onlineTimeMinutes,
    summary.onlineTimeMinutes,
    summary.serverPlayTimeMinutes,
    summary.weeklyPlayTimeMinutes,
    Math.round(Number(summary.serverPlayTimeSeconds || 0) / 60),
    Math.round(Number(summary.weeklyPlayTimeSeconds || 0) / 60)
  );
}
