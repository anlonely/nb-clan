// DOM protocol extracted from the legacy provider; no browser/global cache/environment imports.
import { requireFact } from './transport.js';
const REQUEST_TIMEOUT_MS = 120000, INTERACTION_DELAY_MS = 150;
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

function collapseWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function slugify(value) {
  return collapseWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'field';
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

function attributeSelectorValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export async function innerText(handle) {
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

export async function waitForTableSettled(page, previousSignature = '', requireTransition = false, watchToken = '') {
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

export async function combobox(page, index) {
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

export async function waitForMooseHydration(page) {
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

export async function waitForComboboxEnabled(page, index) {
  await page.waitForFunction((targetIndex) => {
    const boxes = [...document.querySelectorAll('[role="combobox"]')].filter((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    return boxes[targetIndex]?.getAttribute('aria-disabled') !== 'true';
  }, { timeout: Math.min(12_000, REQUEST_TIMEOUT_MS) }, index);
}

export async function dropdownOptions(page, index) {
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

export async function selectDropdown(page, index, target) {
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

export async function selectCategory(page, category) {
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

export async function searchPlayer(page, query) {
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

export async function extractTable(page, categoryId) {
  const extracted = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const table = [...document.querySelectorAll('table')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && node.getClientRects().length > 0;
    });
    if (!table) return { headers: [], rows: [] };
    if (table.querySelectorAll('thead th').length > 65 || table.querySelectorAll('tbody tr').length > 100) throw new Error('SOURCE_PAGE_LIMIT');
    const headers = [...table.querySelectorAll('thead th')].map((cell) => clean(cell.innerText || cell.textContent));
    const rows = [];
    for (const row of table.querySelectorAll('tbody tr')) {
      const cells = [...row.querySelectorAll('td')];
      const texts = cells.map((cell) => clean(cell.innerText || cell.textContent));
      if (!texts.length || (texts.length === 1 && texts[0].toLowerCase() === 'no items to display.')) continue;
      const link = cells[0]?.querySelector('a');
      const image = cells[0]?.querySelector('img');
      const playerUrl = link?.href || '';
      let steamMatch;
      try { const u = new URL(playerUrl); if (u.origin === 'https://steamcommunity.com' && !u.username && !u.password) steamMatch = u.pathname.match(/^\/profiles\/(7656119\d{10})\/?$/); } catch {}
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
  requireFact(extracted.headers.length > 1 && extracted.headers.length <= 65 && extracted.rows.length <= 100);
  requireFact(extracted.rows.every(r => r.cells.length === extracted.headers.length - 1 && r.cells.every(v => v.length <= 500)));
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

export function exactPlayerMatch(rows, steamId) {
  return rows.find((row) => row.steamId && row.steamId === steamId) || null;
}
