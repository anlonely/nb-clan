import nodeFetch from 'node-fetch';
import { pathToFileURL } from 'node:url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

const DEFAULT_API_BASE = 'https://api.battlemetrics.com';
const DEFAULT_DELAY_MS = 850;
const DEFAULT_MAX_PAGES = 80;
const MAX_OPEN_SESSION_MS = 72 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

function printHelp() {
  console.log(`Usage:
  node scripts/battlemetrics-player-hours.js <steamid64> [--names name1,name2] [--json]

Options:
  --names       Extra aliases to search when BattleMetrics SteamID match is empty.
  --delay-ms    Delay between BattleMetrics requests. Default: ${DEFAULT_DELAY_MS}.
  --max-pages   Max session pages per candidate. Default: ${DEFAULT_MAX_PAGES}.
  --json        Print raw JSON only.

The script reads the existing BattleMetrics API key and proxy from app settings/env.
It is read-only and does not write member/profile data.`);
}

function normalizeText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeSteamId(value) {
  const text = normalizeText(value, 32);
  return /^\d{17}$/.test(text) ? text : '';
}

function csv(value) {
  return normalizeText(value)
    .split(',')
    .map((item) => normalizeText(item, 120))
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadReadStore() {
  try {
    return await import('../server/store.js');
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    return import(pathToFileURL(`${process.cwd()}/server/store.js`).href);
  }
}

function createProxyAgent(proxyUrl) {
  if (!proxyUrl) return undefined;
  const parsed = new URL(proxyUrl);
  if (['socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
    return new SocksProxyAgent(parsed);
  }
  if (['http:', 'https:'].includes(parsed.protocol)) {
    return new HttpsProxyAgent(parsed);
  }
  throw new Error(`Unsupported proxy protocol: ${parsed.protocol}`);
}

function battlemetricsApiKey(store) {
  const settings = store.settings?.battlemetrics || {};
  return [
    process.env.NB_BATTLEMETRICS_API_KEY,
    process.env.BATTLEMETRICS_API_KEY,
    settings.apiKey,
    ...(settings.apiKeys || []).map((item) => item?.value || item?.key || item?.token || '')
  ].map((value) => normalizeText(value, 2000)).find(Boolean) || '';
}

export function battlemetricsProxyUrl(store) {
  const systemProxy = store.settings?.system?.proxy || store.settings?.proxy || {};
  if (systemProxy.enabled === false) return '';
  const envProxy = normalizeText(process.env.NB_BATTLEMETRICS_PROXY_URL, 1000);
  if (envProxy) return envProxy;
  const proxyUrl = normalizeText(systemProxy.url, 1000);
  const scope = normalizeText(systemProxy.scope || 'global', 80).toLowerCase();
  if (proxyUrl && (!scope || scope === 'global' || scope === 'battlemetrics')) return proxyUrl;
  return normalizeText(process.env.NB_PROXY_URL, 1000);
}

export function createBattlemetricsFetch({ readSettings, fetchImpl = nodeFetch, agentFactory = createProxyAgent }) {
  let activeProxy = '', agent;
  return async (url, options = {}) => {
    const current = await readSettings();
    if (current.settingsPartial) throw new Error('Proxy settings are temporarily unavailable');
    const nextProxy = battlemetricsProxyUrl(current);
    if (nextProxy !== activeProxy) {
      agent?.destroy();
      agent = agentFactory(nextProxy);
      activeProxy = nextProxy;
    }
    return fetchImpl(url, { ...options, agent });
  };
}

function bmUrl(route, query = {}) {
  const url = new URL(route, process.env.NB_BATTLEMETRICS_API_BASE_URL || DEFAULT_API_BASE);
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function battlemetricsRows(document) {
  const rows = [];
  if (Array.isArray(document?.data)) rows.push(...document.data);
  else if (document?.data) rows.push(document.data);
  if (Array.isArray(document?.included)) rows.push(...document.included);
  return rows;
}

function battlemetricsPlayerRefs(relationships = {}) {
  const refs = [];
  for (const value of Object.values(relationships || {})) {
    const data = value?.data;
    if (Array.isArray(data)) {
      refs.push(...data.filter((item) => item?.type === 'player' && item.id));
    } else if (data?.type === 'player' && data.id) {
      refs.push(data);
    }
  }
  return refs;
}

function extractBattlemetricsPlayers(document) {
  const players = new Map();
  for (const row of battlemetricsRows(document)) {
    if (row?.type === 'player' && row.id) players.set(row.id, row);
  }
  for (const row of battlemetricsRows(document)) {
    for (const ref of battlemetricsPlayerRefs(row?.relationships)) {
      if (!players.has(ref.id)) players.set(ref.id, { type: 'player', id: ref.id, attributes: {} });
    }
  }
  return [...players.values()];
}

function extractBattlemetricsPlayerMatches(document) {
  const players = new Map(extractBattlemetricsPlayers(document).map((player) => [player.id, player]));
  const matches = [];
  for (const row of battlemetricsRows(document)) {
    if (row?.type !== 'identifier') continue;
    const identifier = normalizeText(row?.attributes?.identifier || row?.id, 80);
    const playerRef = battlemetricsPlayerRefs(row?.relationships)[0];
    const player = playerRef?.id ? players.get(playerRef.id) : null;
    if (identifier && player?.id) matches.push({ identifier, player });
  }
  return matches;
}

function playerName(player) {
  return normalizeText(player?.attributes?.name || player?.attributes?.displayName || player?.attributes?.nickname, 120);
}

function comparableName(value) {
  return normalizeText(value, 120).toLowerCase();
}

function parseXmlTag(xml, tag) {
  const match = String(xml || '').match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  if (!match) return '';
  return match[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
}

async function fetchSteamProfile(steamId) {
  const profileUrl = `https://steamcommunity.com/profiles/${steamId}/?xml=1`;
  const aliasesUrl = `https://steamcommunity.com/profiles/${steamId}/ajaxaliases/`;
  const profile = {
    steamId,
    profileUrl: `https://steamcommunity.com/profiles/${steamId}/`,
    steamName: '',
    privacyState: '',
    visibilityState: '',
    vacBanned: '',
    memberSince: '',
    rustHoursOnRecord: '',
    rustHoursPlayed2Wk: '',
    aliases: [],
    error: ''
  };

  try {
    const response = await nodeFetch(profileUrl, { headers: { accept: 'application/xml,text/xml,*/*' } });
    const xml = await response.text();
    if (!response.ok) throw new Error(`Steam profile HTTP ${response.status}`);
    profile.steamName = parseXmlTag(xml, 'steamID');
    profile.privacyState = parseXmlTag(xml, 'privacyState');
    profile.visibilityState = parseXmlTag(xml, 'visibilityState');
    profile.vacBanned = parseXmlTag(xml, 'vacBanned');
    profile.memberSince = parseXmlTag(xml, 'memberSince');
    const games = [...xml.matchAll(/<mostPlayedGame>([\s\S]*?)<\/mostPlayedGame>/gi)];
    for (const game of games) {
      if (parseXmlTag(game[1], 'gameName').toLowerCase() === 'rust') {
        profile.rustHoursOnRecord = parseXmlTag(game[1], 'hoursOnRecord');
        profile.rustHoursPlayed2Wk = parseXmlTag(game[1], 'hoursPlayed2Wk');
      }
    }
  } catch (error) {
    profile.error = normalizeText(error?.message || error, 300);
  }

  try {
    const response = await nodeFetch(aliasesUrl, { headers: { accept: 'application/json' } });
    if (response.ok) {
      const aliases = await response.json();
      profile.aliases = Array.isArray(aliases)
        ? aliases.map((item) => normalizeText(item?.newname, 120)).filter(Boolean)
        : [];
    }
  } catch {
    // Alias lookup is optional.
  }

  return profile;
}

function addCandidate(candidates, player, via, searchName = '') {
  if (!player?.id) return;
  const id = String(player.id);
  if (!candidates.has(id)) {
    candidates.set(id, { player, via: [], searchNames: new Set(), score: 0 });
  }
  const item = candidates.get(id);
  if (player?.attributes && Object.keys(player.attributes).length) item.player = player;
  item.via.push(via);
  if (searchName) item.searchNames.add(searchName);
}

function scoreCandidate(item, steamName, aliases) {
  const names = [steamName, ...aliases].map(comparableName).filter(Boolean);
  const name = comparableName(playerName(item.player));
  let score = 0;
  if (item.via.includes('steamid-match')) score += 1000;
  if (item.player?.attributes?.positiveMatch) score += 200;
  if (name && names.includes(name)) score += 150;
  if ([...item.searchNames].some((value) => comparableName(value) === name)) score += 60;
  return score;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    return;
  }

  const steamId = normalizeSteamId(args._[0] || args.steamid || args.steamId);
  if (!steamId) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const delayMs = Math.max(0, Number(args['delay-ms'] || DEFAULT_DELAY_MS));
  const maxPages = Math.max(1, Number(args['max-pages'] || DEFAULT_MAX_PAGES));
  const { readStore } = await loadReadStore();
  const store = await readStore();
  const apiKey = battlemetricsApiKey(store);
  if (!apiKey) throw new Error('Missing BattleMetrics API key. Configure app settings or NB_BATTLEMETRICS_API_KEY.');
  const { readSettingsRuntimeStore } = await import('../server/settings-store.js');
  const bmFetch = createBattlemetricsFetch({ readSettings: readSettingsRuntimeStore });
  const steam = await fetchSteamProfile(steamId);
  const extraNames = csv(args.names);
  const searchNames = [...new Set([steam.steamName, ...steam.aliases, ...extraNames].map((value) => normalizeText(value, 120)).filter(Boolean))];
  const candidates = new Map();

  async function bmJson(route, options = {}) {
    const url = route.startsWith('http') ? route : bmUrl(route, options.query || {});
    const response = await bmFetch(url, {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(options.body ? { 'content-type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`BattleMetrics HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  const matchDocument = await bmJson('/players/match', {
    method: 'POST',
    body: {
      data: [{
        type: 'identifier',
        attributes: { type: 'steamID', identifier: steamId }
      }]
    }
  });
  const directMatches = extractBattlemetricsPlayerMatches(matchDocument).map((item) => item.player);
  const fallbackPlayers = directMatches.length ? [] : extractBattlemetricsPlayers(matchDocument);
  for (const player of [...directMatches, ...fallbackPlayers]) addCandidate(candidates, player, 'steamid-match');

  await sleep(delayMs);
  const steamSearchDocument = await bmJson('/players', {
    query: { 'filter[search]': steamId, 'page[size]': 10 }
  });
  for (const player of extractBattlemetricsPlayers(steamSearchDocument)) addCandidate(candidates, player, 'steamid-search', steamId);

  for (const name of searchNames) {
    await sleep(delayMs);
    const document = await bmJson('/players', {
      query: { 'filter[search]': name, 'page[size]': 10 }
    });
    for (const player of extractBattlemetricsPlayers(document)) addCandidate(candidates, player, `name-search:${name}`, name);
  }

  async function fetchPlayerDetails(playerId) {
    const document = await bmJson(`/players/${encodeURIComponent(playerId)}`);
    return document?.data || null;
  }

  function sessionSeconds(session, now = new Date()) {
    const startedAt = new Date(session?.attributes?.start || '');
    const stopRaw = session?.attributes?.stop || '';
    const stoppedAt = stopRaw ? new Date(stopRaw) : now;
    if (Number.isNaN(startedAt.getTime()) || Number.isNaN(stoppedAt.getTime())) return 0;
    const durationMs = stoppedAt.getTime() - startedAt.getTime();
    if (durationMs <= 0) return 0;
    if (!stopRaw && durationMs > MAX_OPEN_SESSION_MS) return 0;
    return Math.round(durationMs / 1000);
  }

  async function fetchSessions(playerId) {
    let url = bmUrl(`/players/${encodeURIComponent(playerId)}/relationships/sessions`, { 'page[size]': 100 });
    const seen = new Set();
    const sessions = [];
    let pages = 0;
    while (url && pages < maxPages && !seen.has(url)) {
      seen.add(url);
      if (pages > 0) await sleep(delayMs);
      const document = await bmJson(url);
      const rows = Array.isArray(document?.data) ? document.data : [];
      sessions.push(...rows);
      pages += 1;
      url = document?.links?.next || '';
    }
    const seconds = sessions.reduce((sum, session) => sum + sessionSeconds(session), 0);
    const starts = sessions
      .map((session) => Date.parse(session?.attributes?.start || ''))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    const stops = sessions
      .map((session) => Date.parse(session?.attributes?.stop || session?.attributes?.start || ''))
      .filter(Number.isFinite)
      .sort((left, right) => left - right);
    return {
      sessions: sessions.length,
      pages,
      truncated: Boolean(url),
      seconds,
      hours: Math.round(seconds / 36) / 100,
      earliest: starts[0] ? new Date(starts[0]).toISOString() : '',
      latest: stops.at(-1) ? new Date(stops.at(-1)).toISOString() : '',
      openSessions: sessions.filter((session) => !session?.attributes?.stop).length
    };
  }

  const results = [];
  for (const [id, item] of candidates) {
    await sleep(delayMs);
    let player = item.player;
    if (!player?.attributes || !Object.keys(player.attributes).length) {
      player = await fetchPlayerDetails(id).catch(() => player);
    }
    item.player = player;
    item.score = scoreCandidate(item, steam.steamName, steam.aliases);
    const stats = await fetchSessions(id);
    results.push({
      id,
      name: playerName(player),
      positiveMatch: Boolean(player?.attributes?.positiveMatch),
      private: Boolean(player?.attributes?.private),
      createdAt: normalizeText(player?.attributes?.createdAt, 80),
      via: [...new Set(item.via)],
      searchNames: [...item.searchNames],
      score: item.score,
      ...stats,
      profileUrl: `https://www.battlemetrics.com/players/${id}`
    });
  }

  results.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.hours - left.hours;
  });

  const output = {
    queriedAt: new Date().toISOString(),
    steam,
    battlemetrics: {
      directSteamIdMatch: results.some((item) => item.via.includes('steamid-match')),
      candidates: results
    },
    best: results[0] || null
  };

  if (args.json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`SteamID: ${steamId}`);
  console.log(`Steam name: ${steam.steamName || '-'}`);
  console.log(`Steam aliases: ${steam.aliases.join(', ') || '-'}`);
  console.log(`Steam Rust hours: ${steam.rustHoursOnRecord || '-'}`);
  console.log(`BM direct SteamID match: ${output.battlemetrics.directSteamIdMatch ? 'yes' : 'no'}`);
  if (!output.best) {
    console.log('No BattleMetrics candidates found.');
    return;
  }
  console.log('');
  console.log(`Best BMID: ${output.best.id}`);
  console.log(`BM name: ${output.best.name || '-'}`);
  console.log(`BM hours: ${output.best.hours} h`);
  console.log(`Sessions: ${output.best.sessions}, pages: ${output.best.pages}, truncated: ${output.best.truncated ? 'yes' : 'no'}`);
  console.log(`Earliest: ${output.best.earliest || '-'}`);
  console.log(`Latest: ${output.best.latest || '-'}`);
  console.log(`Open sessions: ${output.best.openSessions}`);
  console.log(`Profile: ${output.best.profileUrl}`);
  console.log('');
  console.log('Top candidates:');
  for (const item of results.slice(0, 8)) {
    console.log(`- ${item.id} ${item.name || '-'} | ${item.hours} h | score ${item.score} | ${item.via.join(', ')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
