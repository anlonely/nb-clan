import puppeteer from 'puppeteer-core';
import { chromiumExecutablePath, chromiumLaunchArgs, withChromiumSlot } from './chromium-runtime.js';

const MOOSE_STATS_URL = String(process.env.NB_MOOSE_STATS_URL || 'https://moose.gg/stats').trim();
const CACHE_TTL_MS = envInteger(process.env.NB_MOOSE_STATS_CACHE_TTL_MS, 180_000, 1_000, 3_600_000);
const CACHE_MAX_ENTRIES = envInteger(process.env.NB_MOOSE_STATS_CACHE_MAX_ENTRIES, 200, 10, 2_000);
const PERIOD_CACHE_TTL_MS = envInteger(process.env.NB_MOOSE_STATS_PERIOD_CACHE_TTL_MS, 300_000, 10_000, 7_200_000);
const REQUEST_TIMEOUT_MS = envInteger(process.env.NB_MOOSE_STATS_TIMEOUT_MS, 90_000, 10_000, 180_000);
const INTERACTION_DELAY_MS = envInteger(process.env.NB_MOOSE_STATS_INTERACTION_DELAY_MS, 250, 100, 3_000);

const MOOSE_SERVERS = Object.freeze([
  Object.freeze({ id: 'eu-mondays', name: 'EU Mondays', nameZh: 'Moose 欧服周一服' }),
  Object.freeze({ id: 'eu-medium', name: 'EU Medium', nameZh: 'Moose 欧服中型服' }),
  Object.freeze({ id: 'eu-main', name: 'EU Main', nameZh: 'Moose 欧服主服' }),
  Object.freeze({ id: 'eu-monthly', name: 'EU Monthly', nameZh: 'Moose 欧服月服' })
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

const FIELD_LABELS_ZH = Object.freeze({
  player: '玩家',
  kdr: 'K/D',
  kd: 'K/D',
  kills: '击杀',
  deaths: '死亡',
  suicides: '自杀',
  wounded: '倒地',
  'wounded recoveries': '倒地恢复',
  headshots: '爆头',
  'shots fired': '开火数',
  'shots hit': '命中数',
  accuracy: '命中率',
  'syringes used': '使用医疗针',
  'bandages used': '使用绷带',
  'medkits used': '使用医疗包',
  scientists: '科学家',
  scientist: '科学家',
  heavies: '重装科学家',
  animals: '动物',
  bears: '熊',
  boars: '野猪',
  wolves: '狼',
  horses: '马',
  chickens: '鸡',
  deer: '鹿',
  crocodiles: '鳄鱼',
  tigers: '老虎',
  panthers: '黑豹',
  snakes: '蛇',
  wood: '木头',
  stone: '石头',
  metal: '金属',
  'metal ore': '金属矿',
  sulfur: '硫磺',
  'sulfur ore': '硫磺矿',
  hqm: '高金',
  'high quality metal': '高金',
  scrap: '废料',
  cloth: '布',
  leather: '皮革',
  charcoal: '木炭',
  'low grade fuel': '低级燃料',
  corn: '玉米',
  pumpkins: '南瓜',
  potatoes: '土豆',
  berries: '浆果',
  hemp: '大麻',
  barrels: '桶',
  crates: '箱子',
  'elite crates': '精英箱',
  components: '组件',
  recycled: '回收',
  rockets: '火箭弹',
  c4: 'C4',
  satchels: '豆包',
  'explosive ammo': '爆炸子弹',
  grenades: '手雷',
  cars: '汽车',
  boats: '船',
  minicopters: '迷你直升机',
  scrapcopters: '运输直升机',
  horses: '马',
  submarines: '潜艇',
  distance: '行驶距离',
  fish: '鱼',
  caught: '捕获',
  blackjack: '二十一点',
  poker: '扑克',
  slots: '老虎机',
  wheel: '转盘',
  won: '赢得',
  bet: '下注',
  'total won': '总赢取',
  'total bet': '总下注'
});

const resultCache = new Map();
const inFlight = new Map();
const periodCache = new Map();
const periodInFlight = new Map();

function envInteger(value, fallback, min, max) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'field';
}

function clone(value) {
  return structuredClone(value);
}

function publicNamedItem(item, active = false) {
  return { ...item, active };
}

export function mooseFieldLabelZh(header) {
  const normalized = collapseWhitespace(header).toLowerCase();
  if (FIELD_LABELS_ZH[normalized]) return FIELD_LABELS_ZH[normalized];
  const simplified = normalized.replace(/\s+(?:gathered|collected|harvested|looted|used|destroyed|killed)$/i, '');
  const base = FIELD_LABELS_ZH[simplified];
  if (!base) return collapseWhitespace(header);
  if (/gathered|collected|harvested/.test(normalized)) return `${base}采集`;
  if (/looted/.test(normalized)) return `${base}搜刮`;
  if (/used/.test(normalized)) return `${base}使用`;
  if (/destroyed/.test(normalized)) return `${base}摧毁`;
  if (/killed/.test(normalized)) return `${base}击杀`;
  return base;
}

export function mooseCatalog() {
  return {
    source: MOOSE_STATS_URL,
    servers: MOOSE_SERVERS.map((item, index) => publicNamedItem(item, index === 0)),
    categories: MOOSE_CATEGORIES.map((item, index) => publicNamedItem(item, index === 0)),
    count: MOOSE_SERVERS.length
  };
}

export function mooseServerDetail(serverId) {
  const server = resolveServer(serverId);
  return {
    server: publicNamedItem(server, true),
    periods: [{ id: 'all-time', name: 'All Time', nameZh: '全部时间', active: true }],
    categories: MOOSE_CATEGORIES.map((item, index) => publicNamedItem(item, index === 0))
  };
}

function periodItem(name, active = false) {
  const normalized = collapseWhitespace(name);
  return {
    id: normalized.toLowerCase() === 'all time' ? 'all-time' : slugify(normalized),
    name: normalized,
    nameZh: normalized.toLowerCase() === 'all time' ? '全部时间' : normalized,
    active
  };
}

function resolveServer(serverId) {
  const normalized = collapseWhitespace(serverId).toLowerCase();
  const server = MOOSE_SERVERS.find((item) => item.id === normalized || item.name.toLowerCase() === normalized);
  if (!server) throw Object.assign(new Error('Moose 服务器无效，仅支持 EU Mondays、EU Medium、EU Main、EU Monthly'), { status: 400 });
  return server;
}

function resolveCategories(categoryIds) {
  const requested = Array.isArray(categoryIds)
    ? categoryIds.map((item) => collapseWhitespace(item).toLowerCase()).filter(Boolean)
    : [];
  if (!requested.length || requested.includes('all')) return [...MOOSE_CATEGORIES];
  const resolved = requested.map((id) => MOOSE_CATEGORIES.find((item) => item.id === id || item.name.toLowerCase() === id));
  if (resolved.some((item) => !item)) throw Object.assign(new Error('Moose 统计分类无效'), { status: 400 });
  return [...new Map(resolved.map((item) => [item.id, item])).values()];
}

function cacheKey(params) {
  return JSON.stringify({
    serverId: params.server.id,
    period: collapseWhitespace(params.period || 'All Time').toLowerCase(),
    steamId: collapseWhitespace(params.steamId),
    categoryIds: params.categories.map((item) => item.id).sort()
  });
}

function getCached(key) {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    resultCache.delete(key);
    return null;
  }
  resultCache.delete(key);
  resultCache.set(key, entry);
  return clone(entry.value);
}

function setCached(key, value) {
  resultCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value: clone(value) });
  while (resultCache.size > CACHE_MAX_ENTRIES) {
    resultCache.delete(resultCache.keys().next().value);
  }
}

function attributeSelectorValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function innerText(handle) {
  return collapseWhitespace(await handle.evaluate((node) => node.innerText || node.textContent || ''));
}

async function tableSignature(page) {
  return page.evaluate(() => {
    const table = [...document.querySelectorAll('table')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    if (!table) return '';
    const rows = [...table.querySelectorAll('tr')].slice(0, 5);
    return rows.map((row) => [...row.querySelectorAll('th,td')].map((cell) => (cell.innerText || '').trim()).join('|')).join('\n');
  });
}

async function beginVisibleTableWatch(page) {
  const token = `${Date.now()}:${Math.random()}`;
  await page.evaluate((nextToken) => {
    window.__nbMooseTableWatch?.observer?.disconnect();
    const table = [...document.querySelectorAll('table')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    if (!table) return;
    const state = { token: nextToken, changed: false, observer: null };
    const observer = new MutationObserver(() => {
      state.changed = true;
    });
    observer.observe(table.parentElement || table, { childList: true, subtree: true, characterData: true, attributes: true });
    state.observer = observer;
    window.__nbMooseTableWatch = state;
  }, token);
  return token;
}

async function waitForTableSettled(page, previousSignature = '', requireTransition = false, watchToken = '') {
  await page.waitForFunction((previous, mustTransition, expectedWatchToken) => {
    const table = [...document.querySelectorAll('table')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    if (!table) return false;
    const busy = table.getAttribute('aria-busy') === 'true'
      || [...document.querySelectorAll('.rz-loading, .rz-datatable-loading, .rz-data-grid-loading')]
        .some((node) => node.getClientRects().length > 0);
    if (busy) return false;
    const rows = [...table.querySelectorAll('tr')].slice(0, 5);
    const signature = rows.map((row) => [...row.querySelectorAll('th,td')].map((cell) => (cell.innerText || '').trim()).join('|')).join('\n');
    const watch = window.__nbMooseTableWatch;
    const observedMutation = Boolean(expectedWatchToken && watch?.token === expectedWatchToken && watch.changed);
    return Boolean(signature) && (!mustTransition || signature !== previous || observedMutation);
  }, { timeout: Math.min(10_000, REQUEST_TIMEOUT_MS) }, previousSignature, requireTransition, watchToken);

  let stableSignature = await tableSignature(page);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, Math.min(200, INTERACTION_DELAY_MS)));
    const nextSignature = await tableSignature(page);
    if (nextSignature === stableSignature) return;
    stableSignature = nextSignature;
  }
  throw Object.assign(new Error('Moose 表格刷新未稳定'), { status: 504 });
}

async function combobox(page, index) {
  await page.waitForSelector('[role="combobox"]');
  const boxes = await page.$$('[role="combobox"]');
  const visibleBoxes = [];
  for (const box of boxes) {
    if (await box.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    })) visibleBoxes.push(box);
  }
  const box = visibleBoxes[index];
  if (!box) throw Object.assign(new Error('Moose 页面下拉菜单结构已变化'), { status: 502 });
  return box;
}

async function clickDomNode(handle) {
  await handle.evaluate((node) => node.click());
}

async function waitForMooseHydration(page) {
  await page.waitForFunction(() => {
    const visibleBoxes = [...document.querySelectorAll('[role="combobox"]')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    return visibleBoxes.length >= 2 && visibleBoxes.slice(0, 2).every((node) => (
      [...node.attributes].some((attribute) => attribute.name.startsWith('_bl_'))
    ));
  }, { timeout: Math.min(15_000, REQUEST_TIMEOUT_MS) });
}

async function waitForComboboxEnabled(page, index) {
  await page.waitForFunction((targetIndex) => {
    const boxes = [...document.querySelectorAll('[role="combobox"]')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    return boxes[targetIndex]?.getAttribute('aria-disabled') !== 'true';
  }, { timeout: Math.min(12_000, REQUEST_TIMEOUT_MS) }, index);
}

async function dropdownOptions(page, index) {
  const box = await combobox(page, index);
  if (await box.evaluate((node) => node.getAttribute('aria-disabled')) === 'true') return [];
  await clickDomNode(box);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const controlsId = await box.evaluate((node) => node.getAttribute('aria-controls'));
  if (!controlsId) throw Object.assign(new Error('Moose 页面下拉菜单结构已变化'), { status: 502 });
  const selector = `[id="${attributeSelectorValue(controlsId)}"] [role="option"]`;
  await page.waitForSelector(selector, { timeout: 5_000 });
  const options = await page.$$(selector);
  const labels = [];
  for (const option of options) labels.push(await innerText(option));
  await page.keyboard.press('Escape');
  return labels.filter(Boolean);
}

async function selectDropdown(page, index, target) {
  const targetLabel = collapseWhitespace(target);
  const box = await combobox(page, index);
  if ((await innerText(box)) === targetLabel) return;
  const previousSignature = await tableSignature(page);
  const watchToken = await beginVisibleTableWatch(page);
  await clickDomNode(box);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const controlsId = await box.evaluate((node) => node.getAttribute('aria-controls'));
  if (!controlsId) throw Object.assign(new Error('Moose 页面下拉菜单结构已变化'), { status: 502 });
  const selector = `[id="${attributeSelectorValue(controlsId)}"] [role="option"]`;
  await page.waitForSelector(selector, { timeout: 5_000 });
  const options = await page.$$(selector);
  let selected = false;
  for (const option of options) {
    if ((await innerText(option)) !== targetLabel) continue;
    await clickDomNode(option);
    selected = true;
    break;
  }
  if (!selected) {
    await page.keyboard.press('Escape');
    throw Object.assign(new Error(`Moose 页面找不到选项：${targetLabel}`), { status: 404 });
  }
  await page.waitForFunction((targetText, targetIndex) => {
    const boxes = [...document.querySelectorAll('[role="combobox"]')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    return (boxes[targetIndex]?.innerText || boxes[targetIndex]?.textContent || '').replace(/\s+/g, ' ').trim() === targetText;
  }, { timeout: 8_000 }, targetLabel, index);
  await waitForTableSettled(page, previousSignature, true, watchToken);
}

async function selectCategory(page, category) {
  const tabs = await page.$$('[role="tab"]');
  for (const tab of tabs) {
    const visible = await tab.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    if (!visible) continue;
    if (slugify(await innerText(tab)) !== category.id) continue;
    const selected = await tab.evaluate((node) => node.getAttribute('aria-selected') === 'true');
    if (selected) return;
    const previousSignature = await tableSignature(page);
    const watchToken = await beginVisibleTableWatch(page);
    await clickDomNode(tab);
    await page.waitForFunction((id) => {
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      return [...document.querySelectorAll('[role="tab"]')].some((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0
          && rect.height > 0
          && node.getClientRects().length > 0
          && normalize(node.innerText || node.textContent) === id
          && node.getAttribute('aria-selected') === 'true';
      });
    }, { timeout: 8_000 }, category.id);
    await waitForTableSettled(page, previousSignature, true, watchToken);
    return;
  }
  throw Object.assign(new Error(`Moose 页面找不到统计分类：${category.name}`), { status: 502 });
}

async function searchPlayer(page, query) {
  await page.waitForSelector('input[placeholder="Search..."]');
  const inputs = await page.$$('input[placeholder="Search..."]');
  let input = null;
  for (const candidate of inputs) {
    if (await candidate.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    })) {
      input = candidate;
      break;
    }
  }
  if (!input) throw Object.assign(new Error('Moose 页面搜索框结构已变化'), { status: 502 });
  const current = await input.evaluate((node) => node.value || '');
  if (current === query) return;
  const previousSignature = await tableSignature(page);
  const watchToken = await beginVisibleTableWatch(page);
  await input.evaluate((node, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(node, value);
    else node.value = value;
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    node.focus();
  }, query);
  await page.waitForFunction((expectedValue) => {
    const visibleInput = [...document.querySelectorAll('input[placeholder="Search..."]')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    return visibleInput?.value === expectedValue;
  }, { timeout: 5_000 }, query);
  await page.keyboard.press('Enter');
  await waitForTableSettled(page, previousSignature, true, watchToken);
}

function parseSteamId(url) {
  const match = String(url || '').match(/\/profiles\/(\d{17})(?:[/?#]|$)/);
  return match?.[1] || '';
}

function serializeFields(headers, categoryId) {
  const seen = new Map();
  return headers.slice(1).map((name) => {
    const baseId = slugify(name);
    const count = (seen.get(baseId) || 0) + 1;
    seen.set(baseId, count);
    return {
      id: count === 1 ? baseId : `${baseId}-${count}`,
      name,
      labelZh: mooseFieldLabelZh(name),
      categoryId,
      kind: 'text'
    };
  });
}

async function extractTable(page, categoryId) {
  const extracted = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const table = [...document.querySelectorAll('table')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    if (!table) return { headers: [], rows: [] };
    const headers = [...table.querySelectorAll('thead th')].map((cell) => clean(cell.innerText || cell.textContent));
    const rows = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = [...row.querySelectorAll('td')];
      const texts = cells.map((cell) => clean(cell.innerText || cell.textContent));
      if (!texts.length || (texts.length === 1 && texts[0].toLowerCase() === 'no items to display.')) continue;
      const link = cells[0]?.querySelector('a');
      const image = cells[0]?.querySelector('img');
      const playerUrl = link?.href || '';
      const steamMatch = playerUrl.match(/\/profiles\/(\d{17})(?:[/?#]|$)/);
      rows.push({
        playerName: texts[0] || '',
        avatar: image?.src || '',
        playerUrl,
        steamId: steamMatch?.[1] || '',
        cells: texts.slice(1)
      });
    }
    return { headers, rows };
  });
  const fields = serializeFields(extracted.headers, categoryId);
  const rows = extracted.rows.map((row, index) => ({
    rank: index + 1,
    playerName: row.playerName,
    avatar: row.avatar,
    playerUrl: row.playerUrl,
    steamId: row.steamId,
    values: Object.fromEntries(fields.map((field, fieldIndex) => [field.id, row.cells[fieldIndex] ?? '']))
  }));
  return { headers: extracted.headers, fields, rows };
}

function exactPlayerMatch(rows, steamId) {
  return rows.find((row) => row.steamId && row.steamId === steamId) || null;
}

async function navigateMoosePage(page) {
  try {
    await page.goto(MOOSE_STATS_URL, { waitUntil: 'domcontentloaded', timeout: Math.min(30_000, REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name !== 'TimeoutError' || !(await page.$('body'))) throw error;
  }
}

async function prepareMoosePage(page, server, period) {
  await page.setViewport({ width: 1440, height: 1800 });
  page.setDefaultTimeout(Math.min(15_000, REQUEST_TIMEOUT_MS));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    if (['font', 'image', 'media'].includes(request.resourceType())) request.abort();
    else request.continue();
  });
  await navigateMoosePage(page);
  await page.waitForFunction(() => [...document.querySelectorAll('table')].some((node) => {
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
  }));
  await waitForMooseHydration(page);
  await waitForTableSettled(page);
  await selectDropdown(page, 0, server.name);
  await waitForComboboxEnabled(page, 1);

  const requestedPeriod = collapseWhitespace(period);
  if (!requestedPeriod) throw Object.assign(new Error('请选择 Moose 档期'), { status: 400 });
  if (requestedPeriod.toLowerCase() !== 'all time' && requestedPeriod.toLowerCase() !== 'all-time') {
    const options = await dropdownOptions(page, 1);
    const resolved = options.find((item) => item.toLowerCase() === requestedPeriod.toLowerCase());
    if (!resolved) throw Object.assign(new Error('Moose 时间范围无效'), { status: 400 });
    await selectDropdown(page, 1, resolved);
    return { id: slugify(resolved), name: resolved, nameZh: resolved, active: true };
  }
  const periodOptions = await dropdownOptions(page, 1);
  if (periodOptions.some((item) => item.toLowerCase() === 'all time')) await selectDropdown(page, 1, 'All Time');
  return { id: 'all-time', name: 'All Time', nameZh: '全部时间', active: true };
}

async function withMooseBrowser(task) {
  return withChromiumSlot(async () => {
    let browser;
    let timedOut = false;
    let timeoutId;
    try {
      browser = await puppeteer.launch({
        executablePath: chromiumExecutablePath(),
        args: chromiumLaunchArgs(),
        headless: true
      });
      timeoutId = setTimeout(() => {
        timedOut = true;
        void browser?.close().catch(() => {});
      }, REQUEST_TIMEOUT_MS);
      const page = await browser.newPage();
      return await task(page);
    } catch (error) {
      if (timedOut || error?.name === 'TimeoutError') {
        throw Object.assign(new Error('Moose 数据源响应超时'), { status: 504, cause: error });
      }
      if (error?.status) throw error;
      throw Object.assign(new Error(`Moose 数据查询失败：${collapseWhitespace(error?.message) || '未知错误'}`), { status: 502, cause: error });
    } finally {
      clearTimeout(timeoutId);
      await browser?.close().catch(() => {});
    }
  }, {
    busyMessage: 'Moose 查询繁忙，请稍后重试',
    busyCode: 'moose_query_busy'
  });
}

async function queryMoosePeriodsWithBrowser(server) {
  return withMooseBrowser(async (page) => {
    await page.setViewport({ width: 1440, height: 1800 });
    page.setDefaultTimeout(Math.min(15_000, REQUEST_TIMEOUT_MS));
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      if (['font', 'image', 'media'].includes(request.resourceType())) request.abort();
      else request.continue();
    });
    await navigateMoosePage(page);
    await page.waitForFunction(() => [...document.querySelectorAll('table')].some((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    }));
    await waitForMooseHydration(page);
    await waitForTableSettled(page);
    await selectDropdown(page, 0, server.name);
    await waitForComboboxEnabled(page, 1);
    const activeBox = await combobox(page, 1);
    const activeName = await innerText(activeBox);
    const options = await dropdownOptions(page, 1);
    if (!options.length) throw Object.assign(new Error('Moose 档期列表暂不可用'), { status: 502 });
    const names = [...new Set(['All Time', activeName, ...options].map(collapseWhitespace).filter(Boolean))];
    const preferredActiveName = activeName && activeName.toLowerCase() !== 'all time'
      ? activeName
      : (names.find((name) => name.toLowerCase() !== 'all time') || activeName || 'All Time');
    return {
      source: MOOSE_STATS_URL,
      server: publicNamedItem(server, true),
      periods: names.map((name) => periodItem(name, name === preferredActiveName)),
      categories: MOOSE_CATEGORIES.map((item, index) => publicNamedItem(item, index === 0))
    };
  });
}

async function queryMoosePlayerWithBrowser(params) {
  return withMooseBrowser(async (page) => {
    const period = await prepareMoosePage(page, params.server, params.period);
    const categories = [];
    let identity = null;
    let activeSearch = params.steamId;

    for (let index = 0; index < params.categories.length; index += 1) {
      const category = params.categories[index];
      await selectCategory(page, category);
      await searchPlayer(page, activeSearch);
      let table = await extractTable(page, category.id);
      let selectedMatch = exactPlayerMatch(table.rows, params.steamId);
      if (!selectedMatch && params.playerName && activeSearch !== params.playerName) {
        activeSearch = params.playerName;
        await searchPlayer(page, activeSearch);
        table = await extractTable(page, category.id);
        selectedMatch = exactPlayerMatch(table.rows, params.steamId);
      }
      if (selectedMatch && !identity) {
        identity = {
          playerName: selectedMatch.playerName,
          avatar: selectedMatch.avatar,
          playerUrl: selectedMatch.playerUrl,
          steamId: selectedMatch.steamId || params.steamId
        };
      }
      categories.push({
        category: publicNamedItem(category, index === 0),
        fields: table.fields,
        matchCount: selectedMatch ? 1 : 0,
        exactMatchCount: selectedMatch ? 1 : 0,
        selectedMatch,
        matches: selectedMatch ? [selectedMatch] : []
      });
    }

    return {
      source: MOOSE_STATS_URL,
      server: publicNamedItem(params.server, true),
      period,
      identity,
      categories,
      matchedCategories: categories.filter((item) => item.selectedMatch).length
    };
  });
}

let queryImplementation = queryMoosePlayerWithBrowser;
let periodQueryImplementation = queryMoosePeriodsWithBrowser;

export async function fetchMoosePeriods(serverId) {
  const server = resolveServer(serverId);
  const cached = periodCache.get(server.id);
  if (cached && cached.expiresAt > Date.now()) return { ...clone(cached.value), cached: true };
  if (cached) periodCache.delete(server.id);
  if (periodInFlight.has(server.id)) return clone(await periodInFlight.get(server.id));
  const pending = periodQueryImplementation(server).then((value) => {
    periodCache.set(server.id, { expiresAt: Date.now() + PERIOD_CACHE_TTL_MS, value: clone(value) });
    return { ...value, cached: false };
  });
  periodInFlight.set(server.id, pending);
  try {
    return clone(await pending);
  } finally {
    periodInFlight.delete(server.id);
  }
}

export async function fetchMoosePlayerStats(input = {}) {
  const server = resolveServer(input.serverId);
  const steamId = collapseWhitespace(input.steamId);
  if (!/^\d{17}$/.test(steamId)) throw Object.assign(new Error('SteamID64 无效'), { status: 400 });
  const period = collapseWhitespace(input.period);
  if (!period) throw Object.assign(new Error('请选择 Moose 档期'), { status: 400 });
  const playerName = collapseWhitespace(input.playerName);
  const categories = resolveCategories(input.categoryIds);
  const params = { server, steamId, playerName, categories, period };
  const key = cacheKey(params);
  const cached = getCached(key);
  if (cached) return { ...cached, cached: true };
  if (inFlight.has(key)) return clone(await inFlight.get(key));

  const pending = queryImplementation(params).then((value) => {
    const result = { ...value, cached: false };
    setCached(key, result);
    return result;
  });
  inFlight.set(key, pending);
  try {
    return clone(await pending);
  } finally {
    inFlight.delete(key);
  }
}

export const __mooseStatsProviderForTests = {
  catalog: mooseCatalog,
  cacheSize: () => resultCache.size,
  inFlightSize: () => inFlight.size,
  reset() {
    queryImplementation = queryMoosePlayerWithBrowser;
    periodQueryImplementation = queryMoosePeriodsWithBrowser;
    resultCache.clear();
    inFlight.clear();
    periodCache.clear();
    periodInFlight.clear();
  },
  setQueryImplementation(implementation) {
    queryImplementation = implementation;
    resultCache.clear();
    inFlight.clear();
  },
  setPeriodQueryImplementation(implementation) {
    periodQueryImplementation = implementation;
    periodCache.clear();
    periodInFlight.clear();
  },
  serializeFields,
  parseSteamId,
  searchPlayer,
  extractTable
};
