import { brandName } from '../../branding.js';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { need, text } from './model.js';
import { REPORT_COPY } from './export-copy.js';
import { renderLeaderboardReport } from './leaderboard-report.js';
import { vitalFieldLabel } from '../../../shared/vital-field-labels.js';
import { VITAL_LEADERBOARDS, leaderboardById, leaderboardLabel, rankLeaderboardRows } from '../../../shared/vital-leaderboards.js';

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);
export const csvCell = value => '"' + String(value ?? '').replace(/^[\s]*[=+@\-]/, "'$&").replace(/"/g, '""') + '"';
const keys = ['kills', 'deaths', 'assists', 'kd', 'kda', 't3Kills', 'rockets', 'sulfur', 'metalOre', 'building', 'onlineSeconds', 'playTimeSeconds', 'steamTotalSeconds'];
const metricNames = {
  zh: ['击杀', '死亡', '助攻', 'KD', 'KDA', 'T3 击杀', '火箭', '硫磺', '金属矿', '建筑', '本服在线秒', '游戏时长秒', 'Steam 总游戏时长秒'],
  en: ['Kills', 'Deaths', 'Assists', 'KD', 'KDA', 'T3 kills', 'Rockets', 'Sulfur', 'Metal ore', 'Building', 'Server online seconds', 'Play time seconds', 'Steam lifetime seconds'],
  ru: ['Убийства', 'Смерти', 'Помощь', 'KD', 'KDA', 'T3', 'Ракеты', 'Сера', 'Металл', 'Строительство', 'Секунды на сервере', 'Время игры, сек.', 'Время Steam, сек.'],
  tr: ['Öldürme', 'Ölüm', 'Asist', 'KD', 'KDA', 'T3', 'Roket', 'Kükürt', 'Metal', 'İnşa', 'Sunucu saniye', 'Oyun süresi saniye', 'Steam toplam saniye'],
  th: ['ฆ่า', 'ตาย', 'ช่วย', 'KD', 'KDA', 'T3', 'จรวด', 'กำมะถัน', 'แร่โลหะ', 'ก่อสร้าง', 'วินาทีในเซิร์ฟเวอร์', 'เวลาเล่นวินาที', 'เวลา Steam ทั้งหมดวินาที'],
  ko: ['킬', '데스', '어시스트', 'KD', 'KDA', 'T3', '로켓', '유황', '금속 광석', '건축', '서버 접속 초', '플레이 시간 초', 'Steam 총 시간 초']
};
const locale = { zh: 'zh-CN', en: 'en-US', ru: 'ru-RU', tr: 'tr-TR', th: 'th-TH', ko: 'ko-KR' };
const statusNames = {
  zh: { fresh: '最新', stale: '过期', observed: '已观测', unavailable: '不可用', unsupported: '不支持', private: '私密', partial: '部分', not_found: '未找到', active: '进行中', planned: '计划中', ended: '已结束', closed: '已结束', authorized_stats_rows: '当前授权筛选范围', account_private_query: '本账户查询' },
  en: { fresh: 'Fresh', stale: 'Stale', observed: 'Observed', unavailable: 'Unavailable', unsupported: 'Unsupported', private: 'Private', partial: 'Partial', not_found: 'Not found', active: 'Active', planned: 'Planned', ended: 'Ended', closed: 'Ended', authorized_stats_rows: 'Authorized, filtered rows', account_private_query: 'Private account query' },
  ru: { fresh: 'Актуальные', stale: 'Устаревшие', observed: 'Наблюдаемые', unavailable: 'Недоступны', unsupported: 'Не поддерживается', private: 'Закрыто', partial: 'Частично', not_found: 'Не найдено', active: 'Активный', planned: 'Запланирован', ended: 'Завершен', closed: 'Завершен' },
  tr: { fresh: 'Güncel', stale: 'Eski', observed: 'Gözlemlenen', unavailable: 'Kullanılamıyor', unsupported: 'Desteklenmiyor', private: 'Özel', partial: 'Kısmi', not_found: 'Bulunamadı', active: 'Aktif', planned: 'Planlandı', ended: 'Bitti', closed: 'Bitti' },
  th: { fresh: 'ล่าสุด', stale: 'เก่า', observed: 'สังเกตแล้ว', unavailable: 'ไม่มีข้อมูล', unsupported: 'ไม่รองรับ', private: 'ส่วนตัว', partial: 'บางส่วน', not_found: 'ไม่พบ', active: 'กำลังดำเนิน', planned: 'ตามแผน', ended: 'สิ้นสุด', closed: 'สิ้นสุด' },
  ko: { fresh: '최신', stale: '오래됨', observed: '관측됨', unavailable: '사용 불가', unsupported: '미지원', private: '비공개', partial: '부분', not_found: '찾을 수 없음', active: '진행 중', planned: '예정', ended: '종료', closed: '종료' }
};
const css = `
@page{size:A4 landscape;margin:11mm}*{box-sizing:border-box}body{margin:0;padding:24px;color:#18283c;background:#eef2f6;font:13px/1.5 "Noto Sans CJK SC","PingFang SC","Microsoft YaHei",Arial,sans-serif}.report{max-width:1360px;margin:auto}h1{font-size:26px;line-height:1.25;margin:0 0 8px}h2{font-size:18px;margin:0 0 10px}h3{font-size:15px;margin:0 0 8px}.cover{padding:22px;color:#fff;background:#233f69;border-radius:12px;margin-bottom:16px;break-inside:avoid}.subtitle{margin:0;color:#cfdcee}.metadata{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 16px;margin-top:14px}.metadata div,.summary-card{min-width:0;overflow-wrap:anywhere}.metadata span{display:block;font-size:10px;color:#cad8e9}.metadata strong{font-size:12px;font-weight:500}.summary-grid,.leader-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:9px;margin-bottom:14px}.summary-card,.leader-card{background:#fff;border:1px solid #d6dfeb;border-radius:8px;padding:11px;break-inside:avoid}.summary-card small,.leader-card small{display:block;color:#64748b}.summary-card strong{display:block;font-size:20px;margin-top:4px}.leader-card strong{display:block;margin:4px 0;overflow-wrap:anywhere}.leader-card .value{color:#315591;font-weight:bold}.leader-grid{grid-template-columns:repeat(4,minmax(0,1fr))}.section,.ranking{margin:18px 0 0}.section h2,.ranking h2{color:#294c7e}.ranking-summary{display:flex;flex-wrap:wrap;gap:9px 20px;padding:9px 12px;background:#e6edf7;border-radius:6px;margin-bottom:8px;break-inside:avoid}.notes{break-inside:avoid}.note{font-size:11px;color:#53657d;margin:8px 0;overflow-wrap:anywhere}.empty{padding:16px;color:#65748b;border:1px dashed #b9c7d9;background:#fff}.table-wrap{background:#fff;border:1px solid #d6dfeb;border-radius:7px}table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{padding:8px 7px;border-bottom:1px solid #e0e7f0;text-align:right;vertical-align:top;overflow-wrap:anywhere}th{background:#edf2f9;font-size:11px;color:#50617b}td{font-size:12px}thead{display:table-header-group}tr{break-inside:avoid}th.identity,td.identity{text-align:left}td.primary,th.primary{background:#f0f5fd;color:#244c84;font-weight:bold}.first-rank td{background:#fff8e6}.muted{font-size:10px;color:#728097}.mono{font-family:ui-monospace,Menlo,monospace;font-size:10px}.table-title th{text-align:left;color:#294c7e;font-size:14px}.rank-col{width:5%}.member-col{width:21%}.steam-col{width:17%}.squad-col{width:14%}.status-col{width:12%}.field-col{width:54%}.metric-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}.metric-grid .summary-card strong{font-size:17px}.footer{margin-top:20px;font-size:10px;color:#65748b;overflow-wrap:anywhere}@media print{body{padding:0;background:#fff;font-size:11px}.cover{padding:15px;margin-bottom:11px}h1{font-size:22px}.metadata{gap:6px 12px}.summary-grid,.leader-grid{gap:6px;margin-bottom:10px}.summary-card,.leader-card{padding:8px}h2{break-after:avoid}.ranking+.ranking{break-before:page}.ranking{margin-top:12px}.section{margin-top:14px}th,td{padding:6px 5px}td{font-size:10px}th{font-size:9px}.report{max-width:none}.footer{display:none}.table-wrap{border-radius:0}.leader-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}@media(max-width:760px){.metadata,.leader-grid,.summary-grid,.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}body{padding:12px}}`;
for (const [language, label] of Object.entries({zh:'未观测',en:'Not observed',ru:'Не наблюдалось',tr:'Gözlemlenmedi',th:'ยังไม่สังเกต',ko:'관측되지 않음'})) statusNames[language].not_observed = label;
const observedValue = (row, key) => row?.capabilities?.[key] === false || typeof row?.values?.[key] !== 'number' || !Number.isFinite(row.values[key]) || row.values[key] < 0 ? null : row.values[key];
const unique = values => [...new Set(values.filter(v => v != null && v !== ''))];
const scalar = value => value == null ? '' : typeof value === 'object' ? Object.entries(value).map(([key, v]) => `${key}: ${scalar(v)}`).join('; ') : String(value);
const MAX_EXPORT_BYTES = 8 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fileStem = data => `stats-${text(data.wipe.id,80).replace(/[^a-zA-Z0-9_-]/g,'-') || 'wipe'}-r${Number.isSafeInteger(data.revision) && data.revision >= 0 ? data.revision : 0}`;

export function exportDocument(data, options = {}) {
  const language = options.language || 'zh', timeZone = options.timeZone || 'Asia/Shanghai';
  const t = key => REPORT_COPY[language]?.[key] || REPORT_COPY.en[key] || key;
  const status = value => statusNames[language]?.[value] || statusNames.en[value] || value || '';
  const names = metricNames[language] || metricNames.en;
  const metricLabel = key => names[keys.indexOf(key)] || key;
  const number = value => value == null ? '-' : new Intl.NumberFormat(locale[language] || 'en-US', { maximumFractionDigits: 2 }).format(value);
  const date = value => !value || !Number.isFinite(Date.parse(value)) ? '' : new Intl.DateTimeFormat(locale[language] || 'en-US', { timeZone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }).format(new Date(value));
  const display = row => row.displayName || row.steamId || row.memberId || '';
  const query = data.queryResult;
  const items = Array.isArray(data.items) ? data.items : [];
  const selection = options.ranking || 'all';
  const spec = selection === 'all' ? null : leaderboardById(selection);
  need(selection === 'all' || spec, 'INVALID_RANKING');
  const specifications = spec ? [spec] : VITAL_LEADERBOARDS;
  const captures = items.map(row => row.capturedAt).filter(value => value && Number.isFinite(Date.parse(value))).sort();
  const meta = {
    wipeId: data.wipe.id, title: query ? t('queryTitle') : data.wipe.title,
    sourceId: data.sourceId, metricVersion: data.metricVersion, revision: data.revision,
    dataRevision: data.dataRevision, countScope: data.countScope, language, timeZone,
    generatedAt: new Date().toISOString(), timeRange: data.timeRange || null,
    ranking: spec?.id || 'all', rowCount: items.length,
    serverId: data.wipe.serverId || query?.serverId || unique(items.map(row => row.serverId)).join(', ') || null,
    serverName: data.wipe.serverName || null,
    providerWipeId: data.wipe.providerWipeId || query?.providerWipeId || unique(items.map(row => row.providerWipeId)).join(', ') || null,
    capturedFrom: captures[0] || query?.fetchedAt || null,
    capturedTo: captures.at(-1) || query?.fetchedAt || null
  };
  const rankingName = board => language === 'zh' || language === 'en' ? leaderboardLabel(board, language) : metricLabel(board.metric);
  const rankings = query ? [] : specifications.map(board => {
    const rows = rankLeaderboardRows(items, board).map(entry => ({ ...entry, value: observedValue(entry.row, board.metric) }));
    const valid = rows.filter(entry => entry.value !== null);
    const total = valid.length ? valid.reduce((sum, entry) => sum + entry.value, 0) : null;
    return { id:board.id, metric:board.metric, title:rankingName(board), observed:valid.length, missing:items.length-valid.length, total, rows,
      leaders:valid.length ? valid.filter(entry => entry.value === valid[0].value).map(entry => display(entry.row)) : [] };
  });
  const labeledMeta = [
    [t('wipe'), query ? '' : data.wipe.title || data.wipe.id],
    [t('source'), ({vital:'Vital Rust',official:'Steam / Rust',inventory:'Steam Inventory',member:t('member'),moose:'Rusty Moose'})[data.sourceId] || data.sourceId],
    [t('server'), meta.serverName || meta.serverId], [t('period'), meta.providerWipeId],
    [t('lifecycle'), status(data.wipe.lifecycle)], [t('started'), date(data.wipe.startedAt)], [t('closed'), date(data.wipe.closedAt)],
    [t('captured'), [date(meta.capturedFrom), meta.capturedFrom !== meta.capturedTo ? date(meta.capturedTo) : ''].filter(Boolean).join(' / ')],
    [t('generated'), date(meta.generatedAt)], [t('zone'),timeZone],
    [t('revision'),data.revision], [t('metricVersion'),data.metricVersion], [t('scope'),status(data.countScope)],
    ...(data.timeRange ? [[t('coverage'),[date(data.timeRange.from),date(data.timeRange.to)].join(' / ')]] : []),
    ...(query ? [[t('steam'),query.steamId], [t('member'),query.displayName], [t('status'),status(query.status)]] : [])
  ].filter(([,value]) => value !== null && value !== undefined && value !== '');
  const fieldGroups = new Map();
  const groupName = name => ({combat:t('combat'),raiding:t('raiding'),farming:t('farming'),building:t('building'),pve:t('pve'),general:t('general'),inventory:t('inventory')})[name] || name || t('other');
  if (Array.isArray(query?.categories)) for (const category of query.categories) fieldGroups.set(category.id, category.fields || []);
  else for (const field of query?.fields || []) {
    const category = /^[a-z]+\./i.test(field.name) ? field.name.split('.')[0] : 'other';
    if (!fieldGroups.has(category)) fieldGroups.set(category, []);
    fieldGroups.get(category).push(field);
  }
  const fieldLabel = path => vitalFieldLabel(path, language);
  const detailTables = [...fieldGroups].map(([category,fields]) => `<section class="section"><h2>${escapeHtml(groupName(category))}</h2><div class="table-wrap"><table><colgroup><col class="field-col"><col><col class="status-col"></colgroup><thead><tr class="table-title"><th colspan="3">${escapeHtml(groupName(category))}</th></tr><tr><th class="identity">${escapeHtml(t('field'))}</th><th>${escapeHtml(t('value'))}</th><th>${escapeHtml(t('status'))}</th></tr></thead><tbody>${fields.map(field => `<tr><td class="identity">${escapeHtml(fieldLabel(field.name || field.id))}${fieldLabel(field.name || field.id) !== (field.name || field.id) ? `<div class="muted mono">${escapeHtml(field.name || field.id)}</div>` : ''}</td><td>${escapeHtml(field.value == null ? '-' : scalar(field.value))}</td><td>${escapeHtml(status(field.status))}</td></tr>`).join('')}</tbody></table></div></section>`).join('');
  const queryMetrics = query && items.length ? `<section class="section"><h2>${escapeHtml(t('summary'))}</h2>${items.map(row => `<h3>${escapeHtml(display(row) || query.displayName || query.steamId)}</h3><div class="metric-grid">${keys.map(key => `<div class="summary-card"><small>${escapeHtml(metricLabel(key))}</small><strong>${escapeHtml(number(observedValue(row,key)))}</strong></div>`).join('')}</div>`).join('')}</section>` : '';
  const inventory = query?.inventory ? `<section class="section"><h2>${escapeHtml(t('inventory'))}</h2><p>${escapeHtml(t('status'))}: ${escapeHtml(status(query.inventory.status))} · ${escapeHtml(t('total'))}: ${escapeHtml(scalar(query.inventory.total))} ${escapeHtml(query.inventory.currency)}</p><div class="table-wrap"><table><thead><tr><th class="identity">${escapeHtml(t('item'))}</th><th>${escapeHtml(t('quantity'))}</th><th>${escapeHtml(t('price'))}</th><th>${escapeHtml(t('currency'))}</th></tr></thead><tbody>${(query.inventory.items || []).map(item => `<tr><td class="identity">${escapeHtml(item.name)}</td><td>${escapeHtml(scalar(item.quantity))}</td><td>${escapeHtml(scalar(item.price))}</td><td>${escapeHtml(item.currency || query.inventory.currency)}</td></tr>`).join('')}</tbody></table></div></section>` : '';
  const notices = query?.errors?.length ? `<section class="section"><h2>${escapeHtml(t('errors'))}</h2><p>${query.errors.map(error => escapeHtml(`${error.sourceId || data.sourceId}: ${error.errorCode}`)).join('<br>')}</p></section>` : '';
  const html = query ? `<!doctype html><html lang="${escapeHtml(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><title>${escapeHtml(meta.title)}</title><style>${css}</style></head><body><main class="report"><header class="cover"><h1>${escapeHtml(t('queryTitle'))}</h1><p class="subtitle">${brandName()} · ${escapeHtml(query.displayName || query.steamId || '')}</p><div class="metadata">${labeledMeta.map(([label,value]) => `<div><span>${escapeHtml(label)}</span><strong>${escapeHtml(scalar(value))}</strong></div>`).join('')}</div></header><aside class="notes"><p class="note">${escapeHtml(t('missingNote'))}</p><p class="note">${escapeHtml(t('formula'))}</p></aside>${queryMetrics}${detailTables}${inventory}${notices}<footer class="footer">${brandName()} · ${escapeHtml(date(meta.generatedAt))} · ${escapeHtml(timeZone)} · ${escapeHtml(meta.metricVersion || '')}</footer></main></body></html>` : renderLeaderboardReport({
    data, meta, rankings, labeledMeta, language, timeZone, t, status, metricLabel, number, date, observedValue, display, escapeHtml
  });
  const csvMeta = labeledMeta.map(([label,value]) => [label,scalar(value)]);
  let csvNames, csvRows;
  if (query && !query.rows?.length && !items.length) {
    csvNames = [t('field'),t('value'),language === 'zh' ? '状态' : t('status')];
    csvRows = [['SteamID',query.steamId,query.status],[t('member'),query.displayName,query.status],...(query.fields || []).map(field => [field.name,field.value,field.status])];
  } else if (spec && !query) {
    csvNames = [t('rank'),t('member'),t('steam'),t('squad'),metricLabel(spec.metric),t('status')];
    csvRows = rankings[0].rows.map(({row,value,rank}) => [rank,display(row),row.steamId,row.squadName,value,row.status]);
  } else {
    csvNames = [t('member'),t('steam'),t('squad'),...names,t('status')];
    csvRows = items.map(row => [display(row),row.steamId,row.squadName,...keys.map(key => observedValue(row,key)),row.status]);
  }
  const csvLines = [...csvMeta,[],csvNames,...csvRows];
  if (query && items.length && query.fields?.length) csvLines.push([], [t('detail')], [t('field'),t('value'),t('status')], ...query.fields.map(field => [field.name,field.value,field.status]));
  const csv = '\uFEFF' + csvLines.map(row => row.map(csvCell).join(',')).join('\r\n');
  return { meta, csv, html, json:JSON.stringify({meta,items,...(rankings.length ? {rankings:rankings.map(({rows,...board}) => ({...board,rows:rows.map(({row,value,rank}) => ({memberId:row.memberId,steamId:row.steamId,rank,value}))}))} : {}), ...(query ? {queryResult:query} : {})},null,2) };
}

/** renderBinary is injected; no browser process, network, or worker starts at import time. */
export function createExportRenderer({ renderBinary } = {}) {
  return async (data, options = {}) => {
    const format = options.format || 'csv';
    need(['csv','html','pdf','png','json'].includes(format), 'INVALID_EXPORT_FORMAT');
    const doc = exportDocument(data, options);
    let bytes, mime, extension = format, meta = doc.meta;
    if (format === 'pdf' && !data.queryResult && doc.meta.ranking === 'all') {
      need(renderBinary, 'BINARY_RENDERER_REQUIRED', 503);
      const zip = new JSZip(), documents = [];
      let rawBytes = 0;
      // Render in sequence through the bounded browser queue. Do not publish
      // an archive if any individual report fails or the combined PDFs exceed
      // the same output limit as a single exported file.
      for (const board of VITAL_LEADERBOARDS) {
        const report = exportDocument(data, { ...options, ranking: board.id });
        const pdf = Buffer.from(await renderBinary(report.html, 'pdf', { layout: 'leaderboard' }));
        rawBytes += pdf.length;
        need(rawBytes <= MAX_EXPORT_BYTES, 'EXPORT_TOO_LARGE', 503);
        const fileName = `${fileStem(data)}-${board.id}.pdf`;
        zip.file(fileName, pdf);
        documents.push({ ranking: board.id, fileName, sizeBytes: pdf.length, sha256: digest(pdf) });
      }
      bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
      mime = 'application/zip';
      extension = 'zip';
      meta = { ...doc.meta, format: 'zip', documentFormat: 'pdf', fileCount: documents.length, documents };
    } else if (format === 'pdf' || format === 'png') {
      need(renderBinary, 'BINARY_RENDERER_REQUIRED', 503);
      bytes = Buffer.from(await renderBinary(doc.html, format, data.queryResult ? undefined : { layout: 'leaderboard' }));
      mime = format === 'pdf' ? 'application/pdf' : 'image/png';
    } else {
      bytes = Buffer.from(doc[format]);
      mime = {csv:'text/csv; charset=utf-8',html:'text/html; charset=utf-8',json:'application/json'}[format];
    }
    need(bytes.length <= MAX_EXPORT_BYTES, 'EXPORT_TOO_LARGE', 503);
    const category = data.queryResult ? 'query' : doc.meta.ranking === 'all' ? 'all-rankings' : doc.meta.ranking;
    return {fileName:`${fileStem(data)}-${category}.${extension}`,mime,base64:bytes.toString('base64'),sha256:digest(bytes),meta};
  };
}
