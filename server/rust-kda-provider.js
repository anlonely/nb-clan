const RUST_APPID = 252490;
const STEAM_API_BASE_URL = String(process.env.NB_STEAM_WEB_API_BASE_URL || 'https://api.steampowered.com').replace(/\/+$/, '');
const SCMM_BASE_URL = 'https://rust.scmm.app/api';
const RUSTHELP_API_BASE_URL = 'https://api.rusthelp.com/v1';
const VITAL_API_BASE_URL = 'https://playerstatistics.vitalgamenetwork.com';
const STEAM_ITEMSTORE_URL = `https://store.steampowered.com/itemstore/${RUST_APPID}/ajaxgetitemdefs/`;
const DEFAULT_STEAM_INVENTORY_PAGE_SIZE = Math.max(1, Math.min(100, Number(process.env.NB_STEAM_INVENTORY_PAGE_SIZE || 75)));
const STEAM_INVENTORY_RETRY_PAGE_SIZES = [75, 50, 25];
const STEAM_INVENTORY_MAX_RETRIES = Math.max(1, Number(process.env.NB_STEAM_INVENTORY_MAX_RETRIES || 4));
const STEAM_INVENTORY_RETRY_DELAY_MS = Math.max(0, Number(process.env.NB_STEAM_INVENTORY_RETRY_DELAY_MS || 1500));
const STEAM_INVENTORY_PAGE_DELAY_MS = Math.max(0, Number(process.env.NB_STEAM_INVENTORY_PAGE_DELAY_MS || 750));
const STEAM_MARKET_FALLBACK_MAX_ITEMS = Math.max(0, Number(process.env.NB_STEAM_MARKET_FALLBACK_MAX_ITEMS || 100));
const DEFAULT_TIMEOUT_MS = Math.max(1000, Number(process.env.NB_INTERNAL_KDA_FETCH_TIMEOUT_MS || 15_000));
const VITAL_TIMEOUT_MS = Math.max(1000, Number(process.env.NB_INTERNAL_VITAL_FETCH_TIMEOUT_MS || 18_000));
const CACHE_MAX_ENTRIES = Math.max(50, Number(process.env.NB_INTERNAL_KDA_CACHE_MAX_ENTRIES || 1000));

const requestCache = new Map();
const inFlightRequests = new Map();

const RUST_DLCS = {
  1409640: { name: 'Sunburn Pack', nameCN: '烈日灼烧包', type: 'pack', category: '扩展包' },
  1364310: { name: 'Instrument Pack', nameCN: '乐器包', type: 'pack', category: '扩展包' },
  1670430: { name: 'Voice Props Pack', nameCN: '语音道具包', type: 'pack', category: '扩展包' },
  2104200: { name: 'Frontier Pack', nameCN: '前沿边境包', type: 'pack', category: '扩展包' },
  2199580: { name: 'Arctic Pack', nameCN: '极地冰原包', type: 'pack', category: '扩展包' },
  2568580: { name: 'Nomad Pack', nameCN: '游牧者包', type: 'pack', category: '扩展包' },
  2650780: { name: 'Jungle Pack', nameCN: '丛林包', type: 'pack', category: '扩展包' },
  2804910: { name: 'Devastated Pack', nameCN: '废墟包', type: 'pack', category: '扩展包' },
  2963480: { name: 'Industrial Pack', nameCN: '工业包', type: 'pack', category: '扩展包' },
  3045860: { name: 'Warhammer 40K Pack', nameCN: '战锤40K包', type: 'pack', category: '联动扩展包' },
  600850: { name: 'Rust Soundtrack', nameCN: '原声音乐', type: 'soundtrack', category: '原声带' }
};

const RUST_ITEMSTORE_TRANSLATIONS = {
  'Abyss Pack': '深渊包',
  'Adobe Building Skin': '土坯建筑皮肤',
  'Adobe Gate and Wall Pack': '土坯大门与围墙包',
  'Arctic Pack': '极地冰原包',
  'Artist Pack': '艺术家包',
  'Brick Building Skin': '砖砌建筑皮肤',
  'Brutalist Building Skin': '粗野主义建筑皮肤',
  'Exhibit Decor Pack': '展陈装饰包',
  'Floor & Ceiling Wallpaper Pack': '地板与天花板壁纸包',
  'Frontier Decor Pack': '边境装饰包',
  'Frontiersman Pack': '拓荒者包',
  'Graffiti Pack': '涂鸦包',
  'Ice King Pack': '冰雪之王包',
  'Industrial Lights': '工业灯具',
  'Jungle Building Skin': '丛林建筑皮肤',
  'Jungle Pack': '丛林包',
  'Legacy Wood Building Skin': '经典木质建筑皮肤',
  'Legacy Wood Gate and Wall Pack': '经典木质大门与围墙包',
  'Lumberjack Pack': '伐木工包',
  'Medieval Pack': '中世纪包',
  'Nomad Outfit': '游牧装束',
  'Retro Tool Cupboard': '复古工具柜',
  'Shipping Container Building Skin': '集装箱建筑皮肤',
  'Space Station Building Skin': '空间站建筑皮肤',
  'Storage Box Pack': '储物箱包',
  'Wallpaper Starter Pack': '壁纸入门包',
  'Weapon Racks': '武器架'
};

for (const dlc of Object.values(RUST_DLCS)) {
  if (dlc.name && dlc.nameCN) RUST_ITEMSTORE_TRANSLATIONS[dlc.name] ||= dlc.nameCN;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isSteamId64(value) {
  return /^\d{17}$/.test(String(value || '').trim());
}

function steamApiKey(options = {}) {
  return String(
    options.steamApiKey ||
    options.steamWebApiKey ||
    process.env.NB_STEAM_WEB_API_KEY ||
    process.env.STEAM_WEB_API_KEY ||
    process.env.STEAM_API_KEY ||
    ''
  ).trim();
}

function requireSteamApiKey(options = {}) {
  const key = steamApiKey(options);
  if (!key) throw Object.assign(new Error('Steam API Key 未配置'), { status: 503 });
  return key;
}

function buildUrl(base, params = null) {
  const url = new URL(base);
  if (params && typeof params === 'object') {
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function cacheKey(method, url, body = '') {
  return `${method.toUpperCase()} ${url} ${body || ''}`;
}

function readCache(key) {
  const entry = requestCache.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    if (entry) requestCache.delete(key);
    return null;
  }
  return entry.payload;
}

function writeCache(key, payload, ttlMs) {
  if (!ttlMs || ttlMs <= 0) return;
  if (requestCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = requestCache.keys().next().value;
    if (firstKey) requestCache.delete(firstKey);
  }
  requestCache.set(key, { payload, expiresAt: Date.now() + ttlMs });
}

async function requestJson(urlInput, {
  method = 'GET',
  params = null,
  headers = {},
  body = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ttlMs = 300_000,
  cache = true
} = {}) {
  const url = buildUrl(urlInput, params);
  const serializedBody = body ? JSON.stringify(body) : '';
  const key = cacheKey(method, url.toString(), serializedBody);
  if (cache && method.toUpperCase() === 'GET') {
    const cached = readCache(key);
    if (cached) return cached;
  }
  const inFlight = inFlightRequests.get(key);
  if (inFlight) return inFlight;

  const request = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers
        },
        ...(body ? { body: serializedBody } : {})
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { error: text.slice(0, 500) };
        }
      } else {
        payload = {};
      }
      if (!response.ok) {
        const error = Object.assign(new Error(`HTTP ${response.status}`), {
          status: response.status,
          payload,
          body: text
        });
        throw error;
      }
      if (cache && method.toUpperCase() === 'GET') writeCache(key, payload, ttlMs);
      return payload;
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw Object.assign(new Error(`request timeout after ${timeoutMs}ms`), { status: 504 });
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      inFlightRequests.delete(key);
    }
  })();
  inFlightRequests.set(key, request);
  return request;
}

function finiteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function roundMoney(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(2)) : 0;
}

function normalizeItemName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function translateRustItemName(name) {
  return RUST_ITEMSTORE_TRANSLATIONS[name] || name;
}

function classifyRustStoreItem(name) {
  const lowered = String(name || '').toLowerCase();
  if (lowered.includes('building skin')) return '建筑皮肤';
  if (lowered.includes('gate and wall pack')) return '大门与围墙包';
  if (lowered.includes('decor pack')) return '装饰包';
  if (lowered.includes('wallpaper')) return '壁纸包';
  if (lowered.endsWith(' pack') || lowered.includes(' pack')) return '扩展包';
  if (lowered.includes('costume') || lowered.includes('outfit')) return '服装';
  if (['door', 'box', 'cupboard', 'lights', 'sofa', 'racks', 'grill', 'furnace'].some((token) => lowered.includes(token))) {
    return '建造与装饰';
  }
  return '商城物品';
}

function parsePriceValue(priceText) {
  const cleaned = String(priceText || '').replace(/[^\d,.-]/g, '');
  if (!cleaned) return null;
  const normalized = cleaned.includes(',') && !cleaned.includes('.') ? cleaned.replace(',', '.') : cleaned.replace(/,/g, '');
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? roundMoney(numeric) : null;
}

function statValue(stats, ...names) {
  for (const name of names) {
    if (Object.hasOwn(stats, name)) return Number(stats[name] || 0);
  }
  return 0;
}

function statSum(stats, ...names) {
  return names.reduce((sum, name) => sum + statValue(stats, name), 0);
}

function buildStatSection(id, title, items) {
  return {
    id,
    title,
    items: items.map(([itemId, label, value]) => ({ id: itemId, label, value }))
  };
}

function buildRustStatsStylePayload(stats, { playtime = {}, achievementsCount = null } = {}) {
  const kills = statValue(stats, 'kill_player');
  const deaths = statValue(stats, 'deaths');
  const headshots = statValue(stats, 'headshots', 'headshot');
  const bulletsFired = statValue(stats, 'bullet_fired');
  const bulletHits = {
    players: statValue(stats, 'bullet_hit_player'),
    buildings: statValue(stats, 'bullet_hit_building'),
    signs: statValue(stats, 'bullet_hit_sign'),
    wolves: statValue(stats, 'bullet_hit_wolf'),
    bears: statValue(stats, 'bullet_hit_bear'),
    boars: statValue(stats, 'bullet_hit_boar'),
    deer: statValue(stats, 'bullet_hit_stag'),
    horses: statValue(stats, 'bullet_hit_horse'),
    dead_players: statSum(stats, 'bullet_hit_playercorpse', 'bullet_hit_corpse')
  };
  const knownBulletHits = Object.values(bulletHits).reduce((sum, value) => sum + Number(value || 0), 0);
  const bulletHitEntity = statValue(stats, 'bullet_hit_entity');
  bulletHits.other = Math.max(0, bulletHitEntity ? bulletHitEntity - knownBulletHits : 0);

  return {
    is_private: false,
    minutes_played: playtime.playtimeMinutes ?? null,
    achievement_count: achievementsCount,
    kdr: deaths > 0 ? Number((kills / deaths).toFixed(2)) : (kills > 0 ? 999 : 0),
    kills,
    deaths,
    headshots,
    bullets: {
      fired: bulletsFired,
      hits: bulletHits,
      total_hits: bulletHitEntity || Object.values(bulletHits).reduce((sum, value) => sum + Number(value || 0), 0),
      player_accuracy: bulletsFired > 0 ? Number(((bulletHits.players / bulletsFired) * 100).toFixed(2)) : 0,
      headshot_rate: bulletHits.players > 0 ? Number(((headshots / bulletHits.players) * 100).toFixed(2)) : 0
    },
    weapons: {
      rockets_fired: statValue(stats, 'rocket_fired'),
      arrows_fired: statValue(stats, 'arrows_shot', 'arrow_fired'),
      shotgun_fired: statValue(stats, 'shotgun_fired')
    },
    resources: {
      wood: statValue(stats, 'harvest.wood', 'harvested_wood'),
      stones: statValue(stats, 'harvest.stones', 'harvested_stones'),
      metal_ore: statValue(stats, 'harvest.metal_ore', 'acquired_metal.ore'),
      sulfur_ore: statValue(stats, 'harvest.sulfur_ore', 'harvested_sulfur_ore'),
      scrap: statValue(stats, 'acquired_scrap'),
      lowgradefuel: statValue(stats, 'acquired_lowgradefuel'),
      cloth: statValue(stats, 'harvest.cloth', 'harvested_cloth'),
      leather: statValue(stats, 'harvested_leather')
    },
    building: {
      placed_blocks: statValue(stats, 'placed_blocks'),
      upgraded_blocks: statValue(stats, 'upgraded_blocks'),
      blueprint_studied: statValue(stats, 'blueprint_studied')
    },
    misc: {
      destroyed_barrels: statValue(stats, 'destroyed_barrels'),
      item_drop: statValue(stats, 'item_drop'),
      inventory_opened: statValue(stats, 'INVENTORY_OPENED'),
      crafting_opened: statValue(stats, 'CRAFTING_OPENED'),
      map_opened: statValue(stats, 'MAP_OPENED'),
      cupboard_opened: statValue(stats, 'CUPBOARD_OPENED')
    },
    raw_stats: stats
  };
}

function statusText(personaState) {
  return ['离线', '在线', '忙碌', '离开', '打盹', '交易', '游戏中'][Number(personaState || 0)] || '离线';
}

function isoFromUnix(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric * 1000).toISOString() : undefined;
}

async function getRustPlaytime(steamId, options = {}) {
  const key = requireSteamApiKey(options);
  const data = await requestJson(`${STEAM_API_BASE_URL}/IPlayerService/GetOwnedGames/v0001/`, {
    params: {
      key,
      steamid: steamId,
      include_played_free_games: 1,
      include_appinfo: 0
    },
    ttlMs: 60 * 60_000
  });
  const games = Array.isArray(data?.response?.games) ? data.response.games : [];
  const rust = games.find((game) => Number(game?.appid) === RUST_APPID);
  if (!rust) {
    return {
      playtimeMinutes: null,
      playtimeHours: null,
      playtimeTwoWeeksMinutes: null,
      playtimeTwoWeeksHours: null
    };
  }
  const total = rust.playtime_forever ?? null;
  const recent = rust.playtime_2weeks ?? null;
  return {
    playtimeMinutes: total,
    playtimeHours: total !== null ? Number((Number(total) / 60).toFixed(1)) : null,
    playtimeTwoWeeksMinutes: recent,
    playtimeTwoWeeksHours: recent !== null ? Number((Number(recent) / 60).toFixed(1)) : null
  };
}

async function getRustAchievementCount(steamId, options = {}) {
  const key = requireSteamApiKey(options);
  try {
    const data = await requestJson(`${STEAM_API_BASE_URL}/ISteamUserStats/GetPlayerAchievements/v0001/`, {
      params: { appid: RUST_APPID, key, steamid: steamId },
      ttlMs: 60 * 60_000
    });
    const achievements = Array.isArray(data?.playerstats?.achievements) ? data.playerstats.achievements : [];
    return achievements.length ? achievements.filter((item) => Number(item?.achieved) === 1).length : null;
  } catch (error) {
    if (error.status === 500) return null;
    throw error;
  }
}

export async function getPlayerSummary(steamId, options = {}) {
  if (!isSteamId64(steamId)) throw Object.assign(new Error('无效的 Steam ID'), { status: 400 });
  const key = requireSteamApiKey(options);
  const data = await requestJson(`${STEAM_API_BASE_URL}/ISteamUser/GetPlayerSummaries/v0002/`, {
    params: { key, steamids: steamId },
    ttlMs: 5 * 60_000
  });
  const player = Array.isArray(data?.response?.players) ? data.response.players[0] : null;
  if (!player) return null;

  const summary = {
    steamId: player.steamid || steamId,
    name: player.personaname || 'Unknown',
    avatar: player.avatarfull || '',
    avatarMedium: player.avatarmedium || '',
    profileUrl: player.profileurl || `https://steamcommunity.com/profiles/${steamId}`,
    status: statusText(player.personastate),
    gameId: player.gameid,
    gameInfo: player.gameextrainfo,
    created: player.timecreated,
    country: player.loccountrycode || '',
    lastLogoff: player.lastlogoff
  };
  if (summary.created) summary.createdAt = isoFromUnix(summary.created);
  if (summary.lastLogoff) summary.lastLogoffAt = isoFromUnix(summary.lastLogoff);

  const [playtimeResult, achievementsResult] = await Promise.allSettled([
    getRustPlaytime(steamId, options),
    getRustAchievementCount(steamId, options)
  ]);
  Object.assign(summary, playtimeResult.status === 'fulfilled' ? playtimeResult.value : {
    playtimeMinutes: null,
    playtimeHours: null,
    playtimeTwoWeeksMinutes: null,
    playtimeTwoWeeksHours: null
  });
  summary.achievementsCount = achievementsResult.status === 'fulfilled' ? achievementsResult.value : null;
  return summary;
}

export async function getPlayerKda(steamId, options = {}) {
  if (!isSteamId64(steamId)) throw Object.assign(new Error('无效的 Steam ID'), { status: 400 });
  const key = requireSteamApiKey(options);
  let data = null;
  try {
    data = await requestJson(`${STEAM_API_BASE_URL}/ISteamUserStats/GetUserStatsForGame/v0002/`, {
      params: { appid: RUST_APPID, key, steamid: steamId },
      ttlMs: 5 * 60_000
    });
  } catch (error) {
    if (error.status === 400 || error.status === 500) return { error: '玩家资料未公开或无 Rust 游戏数据' };
    throw error;
  }
  const [playtimeResult, achievementsResult] = await Promise.allSettled([
    getRustPlaytime(steamId, options),
    getRustAchievementCount(steamId, options)
  ]);
  const playtime = playtimeResult.status === 'fulfilled' ? playtimeResult.value : {};
  const achievementsCount = achievementsResult.status === 'fulfilled' ? achievementsResult.value : null;
  const statsList = Array.isArray(data?.playerstats?.stats) ? data.playerstats.stats : [];
  const stats = Object.fromEntries(statsList.map((item) => [item.name, Number(item.value || 0)]));
  const rustStats = buildRustStatsStylePayload(stats, { playtime, achievementsCount });
  const kills = statValue(stats, 'kill_player');
  const deaths = statValue(stats, 'deaths');
  const headshots = statValue(stats, 'headshots', 'headshot');
  const bulletsFired = statValue(stats, 'bullet_fired');
  const bulletHitsTotal = statValue(stats, 'bullet_hit_entity') || statSum(
    stats,
    'bullet_hit_player',
    'bullet_hit_bear',
    'bullet_hit_boar',
    'bullet_hit_stag',
    'bullet_hit_wolf',
    'bullet_hit_horse',
    'bullet_hit_building',
    'bullet_hit_sign',
    'bullet_hit_playercorpse',
    'bullet_hit_corpse'
  );
  const bulletHitsPlayer = statValue(stats, 'bullet_hit_player');
  const arrowsFired = statValue(stats, 'arrows_shot', 'arrow_fired');
  const shotgunFired = statValue(stats, 'shotgun_fired');
  const resources = {
    metalOre: statValue(stats, 'harvest.metal_ore', 'acquired_metal.ore'),
    sulfurOre: statValue(stats, 'harvest.sulfur_ore'),
    stone: statValue(stats, 'harvest.stones', 'harvested_stones'),
    wood: statValue(stats, 'harvest.wood', 'harvested_wood'),
    scrap: statValue(stats, 'acquired_scrap'),
    lowGradeFuel: statValue(stats, 'acquired_lowgradefuel'),
    cloth: statValue(stats, 'harvest.cloth', 'harvested_cloth'),
    leather: statValue(stats, 'harvested_leather')
  };
  const building = {
    placed: statValue(stats, 'placed_blocks'),
    upgraded: statValue(stats, 'upgraded_blocks'),
    blueprints: statValue(stats, 'blueprint_studied')
  };
  const misc = {
    rocketsFired: statValue(stats, 'rocket_fired'),
    destroyedBarrels: statValue(stats, 'destroyed_barrels'),
    itemDrop: statValue(stats, 'item_drop'),
    inventoryOpened: statValue(stats, 'INVENTORY_OPENED'),
    craftingOpened: statValue(stats, 'CRAFTING_OPENED'),
    mapOpened: statValue(stats, 'MAP_OPENED'),
    cupboardOpened: statValue(stats, 'CUPBOARD_OPENED')
  };

  return {
    stats,
    rustStats,
    is_private: rustStats.is_private,
    minutes_played: rustStats.minutes_played,
    achievement_count: rustStats.achievement_count,
    kdr: rustStats.kdr,
    bullets: rustStats.bullets,
    raw_stats: stats,
    summary: {
      kills,
      deaths,
      headshots,
      kdRatio: deaths > 0 ? Number((kills / deaths).toFixed(2)) : 999,
      headshotRate: bulletHitsPlayer > 0 ? Number(((headshots / bulletHitsPlayer) * 100).toFixed(2)) : 0,
      accuracy: bulletsFired > 0 ? Number(((bulletHitsPlayer / bulletsFired) * 100).toFixed(2)) : 0,
      bulletsFired,
      bulletsHit: bulletHitsTotal,
      bulletsHitPlayer: bulletHitsPlayer,
      rocketsFired: misc.rocketsFired,
      arrowsFired,
      shotgunFired
    },
    resources,
    building,
    misc,
    sections: [
      buildStatSection('pvp', 'PVP', [
        ['kills', '击杀', kills],
        ['deaths', '死亡', deaths],
        ['kd', 'KD', deaths > 0 ? Number((kills / deaths).toFixed(2)) : 999],
        ['bulletFired', '子弹发射', bulletsFired],
        ['bulletHitPlayer', '子弹命中', bulletHitsPlayer],
        ['headshots', '子弹爆头', headshots]
      ]),
      buildStatSection('bullets', 'RustStats 子弹命中', [
        ['fired', '开火数', rustStats.bullets.fired],
        ['players', '玩家命中', rustStats.bullets.hits.players],
        ['buildings', '建筑命中', rustStats.bullets.hits.buildings],
        ['signs', '牌子命中', rustStats.bullets.hits.signs],
        ['wolves', '狼命中', rustStats.bullets.hits.wolves],
        ['bears', '熊命中', rustStats.bullets.hits.bears],
        ['boars', '野猪命中', rustStats.bullets.hits.boars],
        ['deer', '鹿命中', rustStats.bullets.hits.deer],
        ['horses', '马命中', rustStats.bullets.hits.horses],
        ['deadPlayers', '尸体命中', rustStats.bullets.hits.dead_players],
        ['other', '其他命中', rustStats.bullets.hits.other],
        ['totalHits', '总命中', rustStats.bullets.total_hits]
      ]),
      buildStatSection('resources', '采集资源', [
        ['wood', '木头', resources.wood],
        ['stone', '石头', resources.stone],
        ['metalOre', '金属矿石', resources.metalOre],
        ['sulfurOre', '硫磺矿石', resources.sulfurOre],
        ['scrap', '废料', resources.scrap]
      ]),
      buildStatSection('building', '建筑统计', [
        ['placed', '建筑建造', building.placed],
        ['upgraded', '建筑升级', building.upgraded],
        ['blueprints', '学习蓝图', building.blueprints]
      ])
    ]
  };
}

async function fetchScmmProfileInventoryValue(steamId) {
  return requestJson(`${SCMM_BASE_URL}/profile/${steamId}/inventory/value`, {
    headers: { Currency: 'USD' },
    params: { force: false },
    ttlMs: 30 * 60_000
  });
}

async function fetchScmmProfileInventoryItems(steamId) {
  const payload = await requestJson(`${SCMM_BASE_URL}/profile/${steamId}/inventory/items`, {
    headers: { Currency: 'USD' },
    ttlMs: 30 * 60_000
  });
  return Array.isArray(payload) ? payload : (Array.isArray(payload?.items) ? payload.items : []);
}

async function fetchRusthelpInventorySummary(steamId) {
  const payload = await requestJson(`${RUSTHELP_API_BASE_URL}/inventory/summary/${steamId}`, {
    headers: {
      'user-agent': 'nb-clan-inventory/1.0',
      'x-currency-code': 'USD'
    },
    ttlMs: 30 * 60_000
  });
  const data = payload?.data;
  if (!data || typeof data !== 'object') return null;
  if (data.totalValue == null && data.totalItems == null) return null;
  return {
    steamId,
    items: data.totalItems,
    marketValue: Math.round(Number(data.totalValue || 0) * 100),
    source: 'rusthelp-summary'
  };
}

async function fetchSteamMarketPrice(itemName) {
  const payload = await requestJson('https://steamcommunity.com/market/priceoverview/', {
    params: { appid: RUST_APPID, currency: 1, market_hash_name: itemName },
    ttlMs: 30 * 60_000
  });
  const price = Number(String(payload?.lowest_price || '$0').replace(/[^\d.]/g, '') || 0);
  return {
    price: roundMoney(price),
    source: 'steam-market',
    market: 'SteamCommunityMarket',
    itemId: null,
    url: null
  };
}

async function fetchScmmPrice(itemName) {
  const payload = await requestJson(`${SCMM_BASE_URL}/item`, {
    headers: { Currency: 'USD' },
    params: { filter: itemName, exactMatch: true, count: 1 },
    ttlMs: 30 * 60_000
  });
  const item = Array.isArray(payload?.items) ? payload.items[0] : null;
  const priceCents = item?.buyNowPrice ?? item?.originalPrice;
  if (!item || priceCents == null) return null;
  return {
    price: roundMoney(Number(priceCents) / 100),
    source: 'scmm',
    market: item.buyNowFrom,
    itemId: item.id,
    url: item.buyNowUrl
  };
}

async function getInventoryItemPrice(itemName) {
  try {
    const price = await fetchScmmPrice(itemName);
    if (price) return price;
  } catch {}
  try {
    return await fetchSteamMarketPrice(itemName);
  } catch {
    return null;
  }
}

function steamInventoryPageCounts(initialCount) {
  const counts = [];
  for (const candidate of [initialCount, ...STEAM_INVENTORY_RETRY_PAGE_SIZES]) {
    const value = Math.max(1, Math.min(100, Number(candidate || 1)));
    if (!counts.includes(value) && value <= initialCount) counts.push(value);
  }
  return counts.length ? counts : [Math.max(1, Math.min(100, Number(initialCount || 1)))];
}

async function fetchSteamInventoryPage(invUrl, baseParams, pageCount, startAssetId = '') {
  let lastError = null;
  for (const effectiveCount of steamInventoryPageCounts(pageCount)) {
    const params = { ...baseParams, count: effectiveCount };
    if (startAssetId) params.start_assetid = startAssetId;
    for (let attempt = 0; attempt < STEAM_INVENTORY_MAX_RETRIES; attempt += 1) {
      try {
        return [await requestJson(invUrl, { params, ttlMs: 10 * 60_000 }), effectiveCount];
      } catch (error) {
        if (error.status !== 429) throw error;
        lastError = error;
        if (attempt + 1 < STEAM_INVENTORY_MAX_RETRIES) {
          const retryAfter = Number(error?.headers?.['retry-after'] || 0);
          await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 15_000) : Math.min(STEAM_INVENTORY_RETRY_DELAY_MS * (attempt + 1), 8000));
        }
      }
    }
    if (effectiveCount > 25 && STEAM_INVENTORY_PAGE_DELAY_MS > 0) await sleep(STEAM_INVENTORY_PAGE_DELAY_MS);
  }
  throw lastError || Object.assign(new Error('Steam inventory unavailable'), { status: 502 });
}

async function fetchRustInventory(steamId, lang = 'schinese', count = DEFAULT_STEAM_INVENTORY_PAGE_SIZE) {
  const invUrl = `https://steamcommunity.com/inventory/${steamId}/${RUST_APPID}/2`;
  const baseParams = { l: lang, preserve_bbcode: 1, raw_asset_properties: 1 };
  let pageCount = Math.max(1, Math.min(100, Number(count || DEFAULT_STEAM_INVENTORY_PAGE_SIZE)));
  try {
    const first = await fetchSteamInventoryPage(invUrl, baseParams, pageCount);
    let firstPage = first[0];
    pageCount = first[1];
    if (!firstPage || typeof firstPage !== 'object') return [null, 'Rust 库存未公开、为空，或当前账号没有可访问的 Rust 物品库存'];
    const assets = [...(Array.isArray(firstPage.assets) ? firstPage.assets : [])];
    const descriptions = [...(Array.isArray(firstPage.descriptions) ? firstPage.descriptions : [])];
    const totalInventoryCount = firstPage.total_inventory_count || assets.reduce((sum, asset) => sum + Number(asset.amount || 1), 0);
    let lastAssetId = firstPage.last_assetid;
    let moreItems = Boolean(firstPage.more_items);
    let paginationWarning = '';
    while (moreItems && lastAssetId) {
      if (STEAM_INVENTORY_PAGE_DELAY_MS > 0) await sleep(STEAM_INVENTORY_PAGE_DELAY_MS);
      try {
        const next = await fetchSteamInventoryPage(invUrl, baseParams, pageCount, lastAssetId);
        const page = next[0];
        pageCount = next[1];
        if (!page || typeof page !== 'object') break;
        assets.push(...(Array.isArray(page.assets) ? page.assets : []));
        descriptions.push(...(Array.isArray(page.descriptions) ? page.descriptions : []));
        const nextAssetId = page.last_assetid;
        if (!nextAssetId || nextAssetId === lastAssetId) break;
        lastAssetId = nextAssetId;
        moreItems = Boolean(page.more_items);
      } catch (error) {
        if (error.status === 429) {
          paginationWarning = `Steam 库存分页触发限流，已返回已获取的 ${assets.length} 条库存记录；请稍后刷新以补全剩余库存`;
          break;
        }
        throw error;
      }
    }
    const descriptionMap = new Map();
    for (const description of descriptions) {
      descriptionMap.set(`${description.classid}_${description.instanceid}`, description);
    }
    const merged = {
      ...firstPage,
      assets,
      descriptions: [...descriptionMap.values()],
      more_items: 0,
      total_inventory_count: totalInventoryCount
    };
    if (paginationWarning) {
      merged.partialInventory = true;
      merged.paginationWarning = paginationWarning;
    }
    return [merged, null];
  } catch (error) {
    if ([400, 403, 404].includes(Number(error.status))) {
      return [null, 'Rust 库存未公开、为空，或当前账号没有可访问的 Rust 物品库存'];
    }
    if (Number(error.status) === 429) return [null, 'Steam 库存接口暂时限流，请稍后重试'];
    throw error;
  }
}

function rarityFromScmmItem(item = {}) {
  const originalPrice = Number(item.originalPrice || 0);
  if (originalPrice >= 2000) return 'legendary';
  if (originalPrice >= 1000) return 'epic';
  if (originalPrice >= 500) return 'rare';
  if (originalPrice >= 100) return 'uncommon';
  return 'common';
}

async function buildInventoryItemsFromSteamWeb(invData, scmmInventoryItems = [], enableMarketFallback = false) {
  const descriptions = Array.isArray(invData?.descriptions) ? invData.descriptions : [];
  const assets = Array.isArray(invData?.assets) ? invData.assets : [];
  const descMap = new Map(descriptions.map((description) => [`${description.classid}_${description.instanceid}`, description]));
  const scmmByName = new Map();
  for (const item of scmmInventoryItems || []) {
    const key = normalizeItemName(item?.name);
    if (key) scmmByName.set(key, item);
  }
  const grouped = new Map();
  const priceCache = new Map();
  for (const asset of assets) {
    const desc = descMap.get(`${asset.classid}_${asset.instanceid}`) || {};
    const englishName = desc.market_hash_name || desc.market_name || desc.name || 'Unknown';
    let localizedName = desc.name || desc.market_name || englishName;
    if (localizedName === englishName) localizedName = translateRustItemName(englishName);
    const key = normalizeItemName(englishName);
    if (!key) continue;
    let rarity = 'common';
    let itemType = '';
    for (const tag of Array.isArray(desc.tags) ? desc.tags : []) {
      if (tag.category === 'Rarity') {
        const internalName = String(tag.internal_name || '').toLowerCase();
        if (['mythical', 'legendary', 'ancient'].some((token) => internalName.includes(token))) rarity = 'legendary';
        else if (internalName.includes('rare')) rarity = 'rare';
        else if (internalName.includes('uncommon')) rarity = 'uncommon';
      }
      if (tag.category === 'Type') itemType = tag.localized_tag_name || tag.name || itemType;
    }
    const iconUrl = desc.icon_url ? `https://community.akamai.steamstatic.com/economy/image/${desc.icon_url}/96x96` : '';
    const entry = grouped.get(key) || {
      name: englishName,
      nameCN: localizedName,
      marketHashName: desc.market_hash_name || englishName,
      rarity,
      type: itemType,
      tradable: Number(desc.tradable || 0) === 1,
      marketable: Number(desc.marketable || 0) === 1,
      iconUrl,
      quantity: 0,
      price: 0,
      unitPrice: 0,
      priceSource: null,
      priceMarket: null,
      scmmItemId: null,
      source: 'steam-web'
    };
    entry.quantity += Number(asset.amount || 1);
    entry.tradable = entry.tradable || Number(desc.tradable || 0) === 1;
    entry.marketable = entry.marketable || Number(desc.marketable || 0) === 1;
    if (!entry.iconUrl && iconUrl) entry.iconUrl = iconUrl;
    if (entry.rarity === 'common') entry.rarity = rarity;
    if (!entry.type && itemType) entry.type = itemType;
    if (String(localizedName || '').length > String(entry.nameCN || '').length) entry.nameCN = localizedName;
    grouped.set(key, entry);
  }

  for (const [key, entry] of grouped.entries()) {
    const scmmItem = scmmByName.get(key);
    if (scmmItem) {
      const unitPrice = scmmItem.buyNowPrice != null ? Number(scmmItem.buyNowPrice) / 100 : 0;
      entry.unitPrice = roundMoney(unitPrice);
      entry.price = roundMoney(unitPrice * entry.quantity);
      entry.priceSource = 'scmm-profile';
      entry.priceMarket = scmmItem.buyNowFrom;
      entry.scmmItemId = scmmItem.id;
      entry.source = 'steam-web+scmm';
    } else if (enableMarketFallback && entry.marketable && entry.marketHashName) {
      if (!priceCache.has(entry.marketHashName)) {
        priceCache.set(entry.marketHashName, await getInventoryItemPrice(entry.marketHashName));
      }
      const priceInfo = priceCache.get(entry.marketHashName);
      if (priceInfo) {
        entry.unitPrice = roundMoney(priceInfo.price);
        entry.price = roundMoney(priceInfo.price * entry.quantity);
        entry.priceSource = priceInfo.source;
        entry.priceMarket = priceInfo.market;
        entry.scmmItemId = priceInfo.itemId;
        entry.source = 'steam-web+market';
      }
    }
    if (entry.nameCN === entry.name) entry.nameCN = translateRustItemName(entry.name);
  }
  return [...grouped.values()];
}

function checkDlcOwnership(dlcAppids, invData = null) {
  if (!invData) return null;
  const owned = new Set();
  const keywords = {
    1409640: ['sunburn', 'inner tube', 'pool', 'water gun', 'boogie board'],
    1364310: ['instrument', 'piano', 'guitar', 'drum', 'trumpet', 'xylophone', 'sousaphone', 'jerry can guitar', 'pan flute', 'cowbell', 'canbourine', 'plumber'],
    1670430: ['voice props', 'boom box', 'cassette', 'megaphone', 'microphone', 'mobile phone', 'disco', 'laser light', 'connected speaker', 'disco floor'],
    2104200: ['frontier', 'barrel storage', 'wanted', 'saddle', 'hitchin'],
    2199580: ['arctic', 'sled', 'snowmobile seat', 'ice', 'fur'],
    2568580: ['nomad', 'yurt', 'tent', 'carpet', 'camel'],
    2650780: ['jungle', 'bamboo', 'tiki', 'tribal', 'vine', 'jungle pack'],
    2804910: ['devastated', 'ruin', 'rubble', 'debris'],
    2963480: ['industrial', 'conveyor', 'factory', 'pipe'],
    3045860: ['warhammer', '40k', '40,000', 'krieg', 'death korps']
  };
  for (const desc of Array.isArray(invData.descriptions) ? invData.descriptions : []) {
    const name = String(desc.name || '').toLowerCase();
    for (const [dlcIdText, values] of Object.entries(keywords)) {
      const dlcId = Number(dlcIdText);
      if (dlcAppids.has(dlcId) && values.some((keyword) => name.includes(keyword))) owned.add(dlcId);
    }
    const feeApp = Number(desc.market_fee_app || 0);
    if (feeApp && dlcAppids.has(feeApp)) owned.add(feeApp);
  }
  return owned;
}

async function fetchRustItemstoreCatalog() {
  const items = [];
  let start = 0;
  const pageSize = 12;
  const pattern = /<div class="item_def_name ellipsis"><a href="(?<url>[^"]+)"[^>]*>(?<name>.*?)<\/a><\/div>\s*<div class="item_def_price">\s*(?<price>.*?)\s*<\/div>/gis;
  while (true) {
    const data = await requestJson(STEAM_ITEMSTORE_URL, {
      params: { start, count: pageSize, filter: 'All', l: 'english', cc: 'us' },
      ttlMs: 24 * 60 * 60_000
    });
    const totalCount = Number(data.total_count || 0);
    const html = String(data.results_html || '');
    for (const match of html.matchAll(pattern)) {
      const name = htmlDecode(match.groups.name).trim();
      const url = match.groups.url;
      const priceText = htmlDecode(match.groups.price).replace(/\s+/g, ' ').trim();
      const detailMatch = url.match(/\/detail\/(\d+)\//);
      items.push({
        detailId: detailMatch ? detailMatch[1] : null,
        name,
        nameCN: translateRustItemName(name),
        category: classifyRustStoreItem(name),
        priceText,
        priceValue: parsePriceValue(priceText),
        storeUrl: url,
        source: 'steam-itemstore'
      });
    }
    start += pageSize;
    if (start >= totalCount) break;
  }
  return items;
}

function htmlDecode(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchRustDlcList() {
  try {
    const data = await requestJson('https://store.steampowered.com/api/appdetails', {
      params: { appids: RUST_APPID, l: 'schinese' },
      ttlMs: 24 * 60 * 60_000
    });
    const dlcs = data?.[String(RUST_APPID)]?.data?.dlc;
    if (Array.isArray(dlcs) && dlcs.length) return dlcs.map(Number).filter(Boolean);
  } catch {}
  return Object.keys(RUST_DLCS).map(Number);
}

async function fetchDlcDetails(dlcAppid) {
  try {
    const data = await requestJson('https://store.steampowered.com/api/appdetails', {
      params: { appids: dlcAppid, l: 'schinese', cc: 'us' },
      ttlMs: 24 * 60 * 60_000
    });
    const details = data?.[String(dlcAppid)];
    if (details?.success) {
      const item = details.data || {};
      const price = item.price_overview || {};
      return {
        appid: dlcAppid,
        name: item.name || `DLC #${dlcAppid}`,
        type: item.type || 'dlc',
        shortDescription: item.short_description || '',
        headerImage: item.header_image || '',
        capsuleImage: item.capsule_image || '',
        capsuleImageV5: item.capsule_imagev5 || '',
        isFree: Boolean(item.is_free),
        price: {
          currency: price.currency || 'USD',
          initial: Number(price.initial || 0) / 100,
          final: Number(price.final || 0) / 100,
          discountPercent: Number(price.discount_percent || 0),
          formatted: price.final_formatted || ''
        },
        releaseDate: item.release_date?.date || '',
        website: item.website || '',
        storeUrl: `https://store.steampowered.com/app/${dlcAppid}`
      };
    }
  } catch {}
  const known = RUST_DLCS[dlcAppid] || {};
  return {
    appid: dlcAppid,
    name: known.name || `DLC #${dlcAppid}`,
    type: 'dlc',
    shortDescription: '',
    headerImage: '',
    price: { currency: 'USD', initial: 0, final: 0, discountPercent: 0, formatted: '' },
    storeUrl: `https://store.steampowered.com/app/${dlcAppid}`
  };
}

export async function getPlayerInventoryWithDlc(steamId) {
  if (!isSteamId64(steamId)) throw Object.assign(new Error('无效的 Steam ID'), { status: 400 });
  const result = {
    skins: [],
    dlcs: [],
    storeCatalog: [],
    skinsSummary: {},
    dlcSummary: {},
    storeSummary: {},
    totalSummary: {},
    inventoryAvailable: true,
    dlcOwnershipAvailable: true
  };
  let invData = null;
  let invError = null;
  let scmmInventoryValue = null;
  let scmmInventoryItems = null;
  let rusthelpInventorySummary = null;
  let marketFallbackSkipped = false;

  try {
    [scmmInventoryValue, scmmInventoryItems] = await Promise.all([
      fetchScmmProfileInventoryValue(steamId),
      fetchScmmProfileInventoryItems(steamId)
    ]);
  } catch (error) {
    if (![400, 401, 404].includes(Number(error.status))) {
      result.skinsSummary.error = `SCMM 库存获取失败: ${String(error.message || error).slice(0, 160)}`;
    }
    scmmInventoryValue = null;
    scmmInventoryItems = null;
  }
  if (!scmmInventoryValue) {
    try {
      rusthelpInventorySummary = await fetchRusthelpInventorySummary(steamId);
    } catch {}
  }
  try {
    [invData, invError] = await fetchRustInventory(steamId, 'schinese');
  } catch (error) {
    invError = `库存获取失败: ${String(error.message || error).slice(0, 180)}`;
  }

  try {
    if (invData?.assets?.length) {
      const steamAssetCount = invData.assets.length;
      const enableMarketFallback = !scmmInventoryItems?.length && steamAssetCount <= STEAM_MARKET_FALLBACK_MAX_ITEMS;
      marketFallbackSkipped = !scmmInventoryItems?.length && steamAssetCount > STEAM_MARKET_FALLBACK_MAX_ITEMS;
      result.skins = await buildInventoryItemsFromSteamWeb(invData, scmmInventoryItems, enableMarketFallback);
    } else if (scmmInventoryItems?.length) {
      result.skins = scmmInventoryItems.map((item) => {
        const quantity = Number(item.quantity || 1);
        const totalPriceCents = item.totalBuyNowPrice ?? ((item.buyNowPrice || 0) * quantity);
        const unitPriceCents = item.buyNowPrice || 0;
        const tradable = (Array.isArray(item.stacks) ? item.stacks : []).some((stack) => Boolean(stack.tradableAndMarketable));
        return {
          name: item.name || 'Unknown',
          nameCN: item.name || 'Unknown',
          marketHashName: item.name || '',
          rarity: rarityFromScmmItem(item),
          type: item.itemType || '',
          tradable,
          marketable: tradable,
          iconUrl: item.iconUrl || '',
          price: roundMoney(Number(totalPriceCents || 0) / 100),
          unitPrice: roundMoney(Number(unitPriceCents || 0) / 100),
          quantity,
          priceSource: 'scmm-profile',
          priceMarket: item.buyNowFrom,
          scmmItemId: item.id,
          source: 'scmm-profile'
        };
      });
    } else {
      result.inventoryAvailable = false;
      result.skinsSummary.error = invError || '库存为空或无法获取';
    }
  } catch (error) {
    result.inventoryAvailable = false;
    result.skinsSummary.error = `库存获取失败: ${String(error.message || error).slice(0, 180)}`;
  }

  try {
    result.storeCatalog = await fetchRustItemstoreCatalog();
  } catch (error) {
    result.storeSummary.error = `官方商城目录获取失败: ${String(error.message || error).slice(0, 180)}`;
  }

  try {
    const dlcIds = await fetchRustDlcList();
    const ownedDlcs = checkDlcOwnership(new Set(dlcIds), invData);
    const ownershipKnown = ownedDlcs !== null;
    if (!ownershipKnown) {
      result.dlcOwnershipAvailable = false;
      result.dlcSummary.error = '无法从公开库存确认 DLC 拥有状态';
    }
    const detailResults = await Promise.allSettled(dlcIds.map((dlcId) => fetchDlcDetails(dlcId)));
    result.dlcs = detailResults.map((detailResult, index) => {
      const dlcId = dlcIds[index];
      const details = detailResult.status === 'fulfilled' ? detailResult.value : { appid: dlcId, name: `DLC #${dlcId}`, price: {} };
      const known = RUST_DLCS[dlcId] || {};
      return {
        appid: dlcId,
        name: details.name || `DLC #${dlcId}`,
        nameCN: known.nameCN || details.name || '',
        category: known.category || 'DLC',
        description: details.shortDescription || '',
        headerImage: details.headerImage || '',
        capsuleImage: details.capsuleImageV5 || details.capsuleImage || '',
        price: details.price || {},
        releaseDate: details.releaseDate || '',
        storeUrl: details.storeUrl || '',
        owned: ownershipKnown ? ownedDlcs.has(dlcId) : null,
        source: 'dlc',
        tradable: false,
        marketable: false,
        boundToAccount: true
      };
    });
  } catch (error) {
    result.dlcOwnershipAvailable = false;
    result.dlcSummary.error = `DLC 查询失败: ${String(error.message || error).slice(0, 180)}`;
  }

  const inventoryNameSet = new Set(result.skins.map((item) => normalizeItemName(item.name)).filter(Boolean));
  const scmmNameSet = new Set((scmmInventoryItems || []).map((item) => normalizeItemName(item.name)).filter(Boolean));
  for (const item of result.storeCatalog) {
    const normalizedName = normalizeItemName(item.name);
    item.owned = normalizedName ? inventoryNameSet.has(normalizedName) : false;
    item.scmmAvailable = normalizedName ? scmmNameSet.has(normalizedName) : false;
  }

  let inventoryItemCount = result.skins.length;
  let skinTotal = result.inventoryAvailable ? result.skins.reduce((sum, item) => sum + Number(item.price || 0), 0) : null;
  if (invData?.assets?.length) {
    inventoryItemCount = Number(invData.total_inventory_count || result.skins.reduce((sum, item) => sum + Number(item.quantity || 1), 0));
    if (scmmInventoryValue) skinTotal = Number(scmmInventoryValue.marketValue || 0) / 100;
    else if (rusthelpInventorySummary) skinTotal = Number(rusthelpInventorySummary.marketValue || 0) / 100;
  } else if (scmmInventoryValue) {
    skinTotal = Number(scmmInventoryValue.marketValue || 0) / 100;
    inventoryItemCount = Number(scmmInventoryValue.items || result.skins.length);
  } else if (rusthelpInventorySummary) {
    skinTotal = Number(rusthelpInventorySummary.marketValue || 0) / 100;
    inventoryItemCount = Number(rusthelpInventorySummary.items || result.skins.length);
  }
  const skinTradable = result.inventoryAvailable ? result.skins.filter((item) => item.tradable).reduce((sum, item) => sum + Number(item.price || 0), 0) : null;
  const rarityCounts = {};
  for (const item of result.skins) {
    const rarity = item.rarity || 'common';
    rarityCounts[rarity] = (rarityCounts[rarity] || 0) + Number(item.quantity || 1);
  }
  const ownedDlcs = result.dlcs.filter((item) => item.owned === true);
  const notOwnedDlcs = result.dlcs.filter((item) => item.owned === false);
  const unknownDlcs = result.dlcs.filter((item) => item.owned === null);
  const dlcValue = result.dlcOwnershipAvailable ? ownedDlcs.reduce((sum, item) => sum + Number(item.price?.final || 0), 0) : null;
  const ownedStoreItems = result.storeCatalog.filter((item) => item.owned);
  const steamOnlyStoreItems = result.storeCatalog.filter((item) => !item.scmmAvailable);
  const ownedStoreValue = roundMoney(ownedStoreItems.reduce((sum, item) => sum + Number(item.priceValue || 0), 0));

  result.skinsSummary = {
    ...result.skinsSummary,
    totalItems: inventoryItemCount,
    distinctItems: result.skins.length,
    totalValue: skinTotal !== null ? roundMoney(skinTotal) : null,
    tradableValue: skinTradable !== null ? roundMoney(skinTradable) : null,
    rarityCounts,
    available: result.inventoryAvailable,
    source: invData && scmmInventoryValue
      ? 'steam-web+scmm'
      : (invData && rusthelpInventorySummary ? 'steam-web+rusthelp' : (invData ? 'steam-web' : (scmmInventoryValue ? 'scmm-profile' : (rusthelpInventorySummary ? 'rusthelp-summary' : null)))),
    steamWebOnlyDistinct: result.skins.filter((item) => item.source === 'steam-web').length,
    steamWebOnlyItems: result.skins.filter((item) => item.source === 'steam-web').reduce((sum, item) => sum + Number(item.quantity || 1), 0),
    pricedByScmmDistinct: result.skins.filter((item) => item.priceSource === 'scmm-profile').length,
    pricedByScmmItems: result.skins.filter((item) => item.priceSource === 'scmm-profile').reduce((sum, item) => sum + Number(item.quantity || 1), 0)
  };
  if (marketFallbackSkipped) {
    result.skinsSummary.priceFallbackSkipped = true;
    result.skinsSummary.priceWarning = `库存物品超过 ${STEAM_MARKET_FALLBACK_MAX_ITEMS} 件，已跳过逐个 Steam 市场补价以避免请求超时`;
  }
  if (invData?.paginationWarning) {
    result.skinsSummary.partialInventory = Boolean(invData.partialInventory);
    result.skinsSummary.paginationWarning = invData.paginationWarning;
  }

  result.dlcSummary = {
    ...result.dlcSummary,
    totalDlcs: result.dlcs.length,
    ownedCount: ownedDlcs.length,
    notOwnedCount: notOwnedDlcs.length,
    unknownCount: unknownDlcs.length,
    ownedValue: dlcValue !== null ? roundMoney(dlcValue) : null,
    available: result.dlcOwnershipAvailable
  };
  result.storeSummary = {
    ...result.storeSummary,
    totalItems: result.storeCatalog.length,
    ownedCount: ownedStoreItems.length,
    notOwnedCount: result.storeCatalog.length - ownedStoreItems.length,
    steamWebOnlyCount: steamOnlyStoreItems.length,
    ownedValue: ownedStoreValue,
    available: Boolean(result.storeCatalog.length)
  };
  const combinedTotal = skinTotal !== null || dlcValue !== null ? Number(skinTotal || 0) + Number(dlcValue || 0) : null;
  result.totalSummary = {
    totalValue: combinedTotal !== null ? roundMoney(combinedTotal) : null,
    skinsValue: skinTotal !== null ? roundMoney(skinTotal) : null,
    dlcValue: dlcValue !== null ? roundMoney(dlcValue) : null,
    tradableValue: skinTradable !== null ? roundMoney(skinTradable) : null,
    totalItems: inventoryItemCount,
    distinctItems: result.skins.length,
    totalDlcs: result.dlcs.length,
    ownedDlcs: ownedDlcs.length,
    unknownDlcs: unknownDlcs.length,
    storeCatalogItems: result.storeCatalog.length,
    ownedStoreItems: ownedStoreItems.length,
    ownedStoreValue,
    currency: 'USD'
  };
  result.skins.sort((left, right) => Number(right.price || 0) - Number(left.price || 0));
  result.dlcs.sort((left, right) => (
    Number(left.owned !== true) - Number(right.owned !== true) ||
    Number(left.owned === null) - Number(right.owned === null) ||
    Number(right.price?.final || 0) - Number(left.price?.final || 0)
  ));
  return result;
}

export function parseVitalServerCatalog(payload = {}) {
  return (Array.isArray(payload?.data) ? payload.data : [])
    .map((server) => {
      const id = String(server?.id || '').trim();
      const connectionHost = String(server?.connectionHost || '').trim();
      const connectionPort = Number(server?.connectionPort || 0);
      if (!/^\d{1,8}$/.test(id)) return null;
      return {
        id,
        name: String(server?.displayName || '').trim(),
        battlemetricsId: String(server?.battlemetricsServerId || '').trim(),
        connectionHost: /^[A-Za-z0-9.:-]+$/.test(connectionHost) ? connectionHost : '',
        connectionPort: Number.isInteger(connectionPort) && connectionPort >= 1 && connectionPort <= 65535
          ? connectionPort
          : 0
      };
    })
    .filter(Boolean);
}

export async function fetchVitalServerCatalog(options = {}) {
  const payload = await requestJson(`${VITAL_API_BASE_URL}/servers`, {
    headers: { 'user-agent': 'nb-clan-vital/1.0' },
    timeoutMs: VITAL_TIMEOUT_MS,
    ttlMs: 180_000,
    cache: options.fresh !== true
  });
  return parseVitalServerCatalog(payload);
}

export async function fetchVitalServerWipes(serverId, options = {}) {
  const value = String(serverId || '').trim();
  if (!/^\d{1,8}$/.test(value)) throw Object.assign(new Error('serverId must be numeric'), { status: 400 });
  const payload = await requestJson(`${VITAL_API_BASE_URL}/servers/${encodeURIComponent(value)}/wipes`, {
    headers: { 'user-agent': 'nb-clan-vital/1.0' },
    timeoutMs: VITAL_TIMEOUT_MS,
    ttlMs: 180_000,
    cache: options.fresh !== true
  });
  return Array.isArray(payload?.data) ? payload.data : [];
}

export async function fetchVitalPlayersOverview(body = {}) {
  const playerIds = Array.isArray(body.playerIds)
    ? body.playerIds.map((item) => String(item || '').trim()).filter(isSteamId64).slice(0, 10)
    : [];
  if (!playerIds.length) throw Object.assign(new Error('playerIds must contain valid 17-digit Steam64 IDs'), { status: 400 });
  const includes = Array.isArray(body.includes)
    ? body.includes.map((item) => String(item || '').trim()).filter((item) => /^[A-Za-z0-9_.:-]{1,120}$/.test(item)).slice(0, 256)
    : [];
  if (!includes.length) throw Object.assign(new Error('includes must contain stat paths'), { status: 400 });
  const payload = {
    playerIds,
    includes
  };
  if (body.serverId !== undefined && body.serverId !== null && body.serverId !== '') payload.serverId = Number(body.serverId);
  if (body.wipeId) payload.wipeId = String(body.wipeId).trim();
  const response = await requestJson(`${VITAL_API_BASE_URL}/players/overview`, {
    method: 'POST',
    body: payload,
    headers: { 'user-agent': 'nb-clan-vital/1.0' },
    timeoutMs: VITAL_TIMEOUT_MS,
    ttlMs: 45_000
  });
  return Array.isArray(response?.data) ? response.data : [];
}

export function isInternalRustKdaPath(pathname) {
  return /^\/?api\/(?:player|kda|inventory)\//.test(String(pathname || '')) ||
    /^\/?api\/vital\/servers\/\d{1,8}\/wipes\/?$/.test(String(pathname || ''));
}

export async function fetchInternalRustKdaJson(pathname, options = {}) {
  const path = `/${String(pathname || '').replace(/^\/+/, '')}`;
  let match = path.match(/^\/api\/player\/([^/?#]+)$/);
  if (match) return getPlayerSummary(decodeURIComponent(match[1]), options);
  match = path.match(/^\/api\/kda\/([^/?#]+)$/);
  if (match) return getPlayerKda(decodeURIComponent(match[1]), options);
  match = path.match(/^\/api\/inventory\/([^/?#]+)$/);
  if (match) return getPlayerInventoryWithDlc(decodeURIComponent(match[1]), options);
  match = path.match(/^\/api\/vital\/servers\/(\d{1,8})\/wipes\/?$/);
  if (match) return { data: await fetchVitalServerWipes(match[1]) };
  throw Object.assign(new Error(`Unsupported internal rust-kda path: ${path}`), { status: 404 });
}
