// Pure catalog extracted from moose-stats-provider.js; no browser/env imports.
// Moose-owned DNS records and Steam GetServersAtAddress gameport verified 2026-09-21.
// Port 28015 is the query port; client.connect must use the game port, 28010.
const MOOSE_SERVERS = Object.freeze([
  Object.freeze({ id: 'eu-mondays', name: 'EU Mondays', nameZh: 'Moose 欧服周一服', directConnect: 'client.connect monday.eu.moose.gg:28010' }),
  Object.freeze({ id: 'eu-medium', name: 'EU Medium', nameZh: 'Moose 欧服中型服', directConnect: 'client.connect medium.eu.moose.gg:28010' }),
  Object.freeze({ id: 'eu-main', name: 'EU Main', nameZh: 'Moose 欧服主服', directConnect: 'client.connect main.eu.moose.gg:28010' }),
  Object.freeze({ id: 'eu-monthly', name: 'EU Monthly', nameZh: 'Moose 欧服月服', directConnect: 'client.connect monthly.eu.moose.gg:28010' })
]);

const MOOSE_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'pvp', name: 'PvP', nameZh: '玩家对战' }),
  Object.freeze({ id: 'pve', name: 'PvE', nameZh: '环境战斗' }),
  Object.freeze({ id: 'gambling', name: 'Gambling', nameZh: '赌博' }),
  Object.freeze({ id: 'resources', name: 'Resources', nameZh: '资源' }),
  Object.freeze({ id: 'building', name: 'Building', nameZh: '建造' }),
  Object.freeze({ id: 'farming', name: 'Farming', nameZh: '种植' }),
  Object.freeze({ id: 'looting', name: 'Looting', nameZh: '搜刮' }),
  Object.freeze({ id: 'recycling', name: 'Recycling', nameZh: '回收' }),
  Object.freeze({ id: 'boom', name: 'Boom', nameZh: '爆破' }),
  Object.freeze({ id: 'vehicles', name: 'Vehicles', nameZh: '载具' }),
  Object.freeze({ id: 'vehicle-combat', name: 'Vehicle Combat', nameZh: '载具战斗' }),
  Object.freeze({ id: 'fishing', name: 'Fishing', nameZh: '钓鱼' })
]);

export function mooseCatalog() {
  return { servers: MOOSE_SERVERS.map(x => ({...x})), categories: MOOSE_CATEGORIES.map(x => ({...x})) };
}
