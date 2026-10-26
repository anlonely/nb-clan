export const LANGUAGES = [
  {
    id: 'zh',
    label: '简体中文',
    locale: 'zh-CN',
    currency: 'CNY',
    labels: { zh: '简体中文', en: 'Chinese', ru: 'Китайский', tr: 'Çince', th: 'จีน', ko: '중국어' }
  },
  {
    id: 'en',
    label: 'English',
    locale: 'en-US',
    currency: 'USD',
    labels: { zh: '英语', en: 'English', ru: 'Английский', tr: 'İngilizce', th: 'อังกฤษ', ko: '영어' }
  },
  {
    id: 'ru',
    label: 'Русский',
    locale: 'ru-RU',
    currency: 'RUB',
    labels: { zh: '俄语', en: 'Russian', ru: 'Русский', tr: 'Rusça', th: 'รัสเซีย', ko: '러시아어' }
  },
  {
    id: 'tr',
    label: 'Türkçe',
    locale: 'tr-TR',
    currency: 'TRY',
    labels: { zh: '土耳其语', en: 'Turkish', ru: 'Турецкий', tr: 'Türkçe', th: 'ตุรกี', ko: '튀르키예어' }
  },
  {
    id: 'th',
    label: 'ไทย',
    locale: 'th-TH',
    currency: 'THB',
    labels: { zh: '泰语', en: 'Thai', ru: 'Тайский', tr: 'Tayca', th: 'ไทย', ko: '태국어' }
  },
  {
    id: 'ko',
    label: '한국어',
    locale: 'ko-KR',
    currency: 'KRW',
    labels: { zh: '韩语', en: 'Korean', ru: 'Корейский', tr: 'Korece', th: 'เกาหลี', ko: '한국어' }
  }
];
export const CURRENCY_RATE_CACHE_KEY = 'nb-usd-rates';
export const SUPPORTED_DISPLAY_CURRENCIES = ['USD', 'CNY', 'RUB', 'TRY', 'THB', 'KRW'];

export const EXPORT_TIME_ZONES = {
  zh: 'Asia/Shanghai',
  en: 'America/New_York',
  ru: 'Europe/Moscow',
  tr: 'Europe/Istanbul',
  th: 'Asia/Bangkok',
  ko: 'Asia/Seoul'
};

export const EXPORT_RANKINGS = [
  { id: 'all', labelKey: 'allRankings' },
  { id: 'kills', labelKey: 'rankKills' },
  { id: 't3Kills', labelKey: 'rankT3Kills' },
  { id: 'rockets', labelKey: 'rankRpg' },
  { id: 'metalOre', labelKey: 'rankMetalOre' },
  { id: 'sulfur', labelKey: 'rankSulfur' },
  { id: 'building', labelKey: 'rankBuilding' },
  { id: 'online_minutes', labelKey: 'rankOnlineTime' }
];

export const HTML_EXPORT_RANKINGS = EXPORT_RANKINGS.filter((item) => item.id !== 'all');


export function detectLanguage() {
  const browserLanguages = typeof navigator !== 'undefined' && Array.isArray(navigator.languages) && navigator.languages.length
    ? navigator.languages
    : [typeof navigator !== 'undefined' ? navigator.language || 'zh' : 'zh'];
  for (const browserLanguage of browserLanguages) {
    const normalized = String(browserLanguage || '').toLowerCase();
    const match = LANGUAGES.find((item) => normalized.startsWith(item.id));
    if (match) return match.id;
  }
  return 'zh';
}

export function normalizeLanguageId(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace('_', '-');
  if (!normalized) return '';
  if (normalized.startsWith('zh')) return 'zh';
  const base = normalized.split('-')[0];
  return LANGUAGES.some((item) => item.id === base) ? base : '';
}

export function localeFor(lang) {
  return LANGUAGES.find((item) => item.id === lang)?.locale || 'zh-CN';
}

export function currencyFor(lang) {
  return LANGUAGES.find((item) => item.id === lang)?.currency || 'USD';
}

export function exportTimeZoneFor(lang) {
  return EXPORT_TIME_ZONES[lang] || EXPORT_TIME_ZONES.zh;
}

export function languageOptionLabel(item, lang) {
  return item?.label || '';
}
