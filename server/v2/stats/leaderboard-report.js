import { deploymentText } from '../../branding.js';
import { LEADERBOARD_STYLE } from './leaderboard-style.js';

const BRAND = deploymentText("Clan Portal");
const SUMMARY_METRICS = ['kills', 't3Kills', 'rockets', 'sulfur', 'metalOre', 'building'];
const TABLE_METRICS = ['kills', 't3Kills', 'deaths', 'kda', 'rockets', 'sulfur', 'metalOre', 'building'];
const RESOURCE_METRICS = new Set(['sulfur', 'metalOre']);
const COPY = {
  zh: {
    title: 'KDA 数据', days: '档期天数', online: '在线时长', hour: '小时',
    missing: '- 表示未观测或不支持；0 为真实观测值。缺失值不参与排名或合计，同值并列；合计仅覆盖当前授权筛选范围。',
    formula: 'KD = 击杀 / max(死亡, 1)；KDA = (击杀 + 助攻) / max(死亡, 1)。助攻未被来源观测时，KDA 保持缺失。'
  },
  en: {
    title: 'KDA data', days: 'Wipe duration (days)', online: 'Server playtime', hour: 'h',
    missing: 'A dash means unobserved or unsupported; 0 is an observed value. Missing values are excluded from ranks and totals, and equal values tie. Totals cover only the authorized, filtered rows.',
    formula: 'KD = kills / max(deaths, 1); KDA = (kills + assists) / max(deaths, 1). KDA is unavailable when the source has not observed assists.'
  },
  ru: {
    title: 'Данные KDA', days: 'Длительность вайпа (дни)', online: 'Время на сервере', hour: 'ч',
    missing: 'Прочерк означает отсутствие наблюдений или поддержки; 0 — наблюдаемое значение. Пропуски не участвуют в рейтинге и сумме; равные значения делят место. Суммы охватывают только доступные после проверки прав и фильтрации строки.',
    formula: 'KD = убийства / max(смерти, 1); KDA = (убийства + помощь) / max(смерти, 1). Если источник не наблюдал помощь, KDA отсутствует.'
  },
  tr: {
    title: 'KDA verileri', days: 'Wipe süresi (gün)', online: 'Sunucuda oyun süresi', hour: 'sa.',
    missing: 'Tire, gözlemlenmeyen veya desteklenmeyen değeri gösterir; 0 gözlemlenen bir değerdir. Eksik değerler sıralamaya ve toplama katılmaz; eşit değerler aynı sırayı paylaşır. Toplamlar yalnızca yetkilendirilmiş ve filtrelenmiş satırları kapsar.',
    formula: 'KD = öldürme / max(ölüm, 1); KDA = (öldürme + asist) / max(ölüm, 1). Kaynak asist gözlemlemediyse KDA mevcut değildir.'
  },
  th: {
    title: 'ข้อมูล KDA', days: 'ระยะเวลารอบ (วัน)', online: 'เวลาเล่นบนเซิร์ฟเวอร์', hour: 'ชม.',
    missing: 'ขีดหมายถึงยังไม่มีข้อมูลหรือไม่รองรับ ส่วน 0 คือค่าที่มีข้อมูล ค่าที่ไม่มีข้อมูลจะไม่นำมาจัดอันดับหรือรวมยอด และค่าเท่ากันจะได้อันดับร่วม ยอดรวมครอบคลุมเฉพาะแถวที่ได้รับอนุญาตและผ่านตัวกรองแล้ว',
    formula: 'KD = จำนวนฆ่า / max(จำนวนตาย, 1); KDA = (จำนวนฆ่า + จำนวนช่วย) / max(จำนวนตาย, 1) หากแหล่งข้อมูลไม่ได้เก็บจำนวนช่วย จะไม่มีค่า KDA'
  },
  ko: {
    title: 'KDA 데이터', days: '와이프 기간 (일)', online: '서버 플레이 시간', hour: '시간',
    missing: '대시는 관측되지 않았거나 지원되지 않는 값을 뜻하며, 0은 실제 관측값입니다. 누락값은 순위와 합계에서 제외되며 같은 값은 공동 순위입니다. 합계는 권한 확인과 필터링을 거친 행만 포함합니다.',
    formula: 'KD = 킬 / max(데스, 1); KDA = (킬 + 어시스트) / max(데스, 1). 출처에서 어시스트를 관측하지 않았다면 KDA는 표시되지 않습니다.'
  }
};

const medalClass = rank => ({ 1: 'gold', 2: 'silver', 3: 'bronze' })[rank] || '';
const scalar = value => value == null ? '' : typeof value === 'object'
  ? Object.entries(value).map(([key, entry]) => `${key}: ${scalar(entry)}`).join('; ')
  : String(value);

function wipeDays(data, meta) {
  const start = data.timeRange?.from || data.wipe?.startedAt;
  const end = data.timeRange?.to || data.wipe?.closedAt ||
    (data.wipe?.lifecycle === 'active' ? meta.generatedAt : null);
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration / 86_400_000 : null;
}

function rankingTitle(board, language, metricLabel, copy) {
  const label = board.metric === 'onlineSeconds' ? copy.online : metricLabel(board.metric);
  if (language === 'zh') return String(board.title || `${label}排行`).replace(/排行(?!榜)/g, '排行榜');
  if (language === 'en') return board.title || `${label} leaderboard`;
  if (language === 'ru') return `Таблица лидеров · ${label}`;
  if (language === 'tr') return `${label} sıralaması`;
  if (language === 'th') return `อันดับ${label}`;
  if (language === 'ko') return `${label} 순위`;
  return board.title || `${label} leaderboard`;
}

/** Pure HTML: no legacy store, browser process, remote avatar, or network access. */
export function renderLeaderboardReport({
  data, meta, rankings, labeledMeta, language, timeZone,
  t, status, metricLabel, number, date, observedValue, display, escapeHtml
}) {
  const copy = COPY[language] || COPY.en;
  const items = Array.isArray(data.items) ? data.items : [];
  const e = escapeHtml;
  const label = key => key === 'onlineSeconds' ? copy.online : metricLabel(key);
  const format = (value, key) => {
    if (value == null) return '-';
    if (key === 'onlineSeconds') return `${number(value / 3600)} ${copy.hour}`;
    if (RESOURCE_METRICS.has(key) && value >= 10000) return `${number(value / 10000)}w`;
    return number(value);
  };
  const total = key => {
    const values = items.map(row => observedValue(row, key)).filter(value => value !== null);
    return values.length ? values.reduce((sum, value) => sum + value, 0) : null;
  };
  const leader = key => {
    const rows = items.map(row => ({ row, value: observedValue(row, key) })).filter(entry => entry.value !== null);
    if (!rows.length) return { names: t('noData'), value: null };
    const maximum = rows.reduce((best, entry) => Math.max(best, entry.value), 0);
    return { names: rows.filter(entry => entry.value === maximum).map(entry => display(entry.row)).join(' / '), value: maximum };
  };
  const title = data.wipe?.title || meta.title || copy.title;
  const summary = [
    [t('members'), number(items.length)],
    ...SUMMARY_METRICS.map(key => [metricLabel(key), format(total(key), key)]),
    [copy.days, number(wipeDays(data, meta))]
  ];
  const leaders = SUMMARY_METRICS.map(key => {
    const best = leader(key);
    return `<div class="kv"><span class="label">${e(metricLabel(key))} · ${e(t('leader'))}</span><strong>${e(best.names)}</strong><div class="sub">${e(format(best.value, key))}</div></div>`;
  }).join('');
  const tables = rankings.map(board => {
    const primary = board.metric;
    const secondary = TABLE_METRICS.filter(key => key !== primary);
    const columns = [...(primary !== 'onlineSeconds' ? ['onlineSeconds'] : []), primary, ...secondary];
    const headers = [t('rank'), t('member'), t('squad'), ...columns.map(label)];
    const boardTitle = rankingTitle(board, language, metricLabel, copy);
    const rows = board.rows.map(({ row, value, rank }) => {
      const name = display(row) || '-';
      const medal = value !== null && rank != null ? medalClass(rank) : '';
      const rankText = value === null || rank == null ? '-' : `#${String(rank).padStart(2, '0')}`;
      const letter = Array.from(String(name).trim())[0]?.toUpperCase() || '?';
      const rowStatus = row.status && row.status !== 'fresh' ? `<div class="leaderboard-steam">${e(t('status'))}: ${e(status(row.status))}</div>` : '';
      return `<tr${medal ? ` class="rank-${medal}"` : ''}>
        <td class="leaderboard-rank">${e(rankText)}</td>
        <td class="leaderboard-player"><div class="leaderboard-identity"><span class="avatar-wrap"><span class="avatar-fallback">${e(letter)}</span>${medal ? `<span class="medal medal-${medal}" aria-label="${e(t('rank'))} ${e(rank)}">♛</span>` : ''}</span><div><div class="leaderboard-name">${e(name)}</div><div class="leaderboard-steam mono" aria-label="${e(t('steam'))}">${e(row.steamId || '')}</div>${rowStatus}</div></div></td>
        <td>${e(row.squadName || '-')}</td>
        ${columns.map(key => `<td${key === primary ? ' class="leaderboard-primary-stat"' : ''}>${e(format(key === primary ? value : observedValue(row, key), key))}</td>`).join('')}
      </tr>`;
    }).join('');
    return `<section class="ranking-page" data-ranking="${e(board.id)}"><div class="ranking-heading"><h2 class="ranking-title"><span>${BRAND} · ${e(boardTitle)}</span></h2></div>${board.rows.length ? `<section class="leaderboard"><table class="leaderboard-table"><colgroup><col class="leaderboard-rank"><col class="leaderboard-player"><col class="leaderboard-squad">${columns.map(key => `<col class="${key === primary ? 'leaderboard-primary-stat' : key === 'onlineSeconds' ? 'leaderboard-online' : ['sulfur','metalOre','building'].includes(key) ? 'leaderboard-wide-stat' : 'leaderboard-stat'}">`).join('')}</colgroup><thead><tr>${headers.map((header, index) => `<th${index >= 3 && columns[index - 3] === primary ? ' class="leaderboard-primary-stat"' : ''}>${e(header)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></section>` : `<div class="empty">${e(t('noData'))}</div>`}</section>`;
  }).join('');
  return `<!doctype html><html lang="${e(language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"><title>${BRAND} · ${e(title)}</title><style>${LEADERBOARD_STYLE}</style></head><body><main class="sheet"><section class="cover"><h1>${e(title)}</h1><div class="cover-brand">${BRAND}</div><div class="meta-chips">${labeledMeta.map(([name, value]) => `<span class="chip">${e(name)}: ${e(scalar(value))}</span>`).join('')}</div></section><section class="stats">${summary.map(([name, value]) => `<div class="stat"><label>${e(name)}</label><strong>${e(value)}</strong></div>`).join('')}</section><section class="section result"><h2>${e(t('leaders'))}</h2><div class="kv-grid">${leaders}</div></section><p class="report-note">${e(copy.missing)} 1w = 10000.</p><p class="report-note">${e(copy.formula)}</p>${tables}<footer class="footer">${BRAND} · ${e(date(meta.generatedAt))} · ${e(timeZone)}</footer></main></body></html>`;
}
