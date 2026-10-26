const timestamp = value => {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : 0;
};
const category = { inventory_value:'inventory', private_inventory:'inventory',
  playtime_hours:'playtime', private_playtime:'playtime',
  kd:'official', kills:'official', deaths:'official', rockets:'official' };

export function groupRiskAlerts(alerts) {
  const groups = new Map();
  for (const alert of alerts || []) {
    const type = category[alert.type] || alert.type || alert.id;
    if (!groups.has(type)) groups.set(type, { type, alerts: [] });
    groups.get(type).alerts.push(alert);
  }
  return [...groups.values()].map(group => ({
    ...group,
    latest: group.alerts.reduce((latest, alert) => timestamp(alert.observedAt) > timestamp(latest?.observedAt) ? alert : latest, group.alerts[0]),
    unread: group.alerts.filter(alert => alert.state === 'unread').length,
    read: group.alerts.filter(alert => alert.state === 'read').length
  }));
}
