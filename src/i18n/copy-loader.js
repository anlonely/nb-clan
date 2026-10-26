const COPY_IMPORTS = {
  zh: () => import('./copy-data/zh.js'),
  en: () => import('./copy-data/en.js'),
  ru: () => import('./copy-data/ru.js'),
  tr: () => import('./copy-data/tr.js'),
  th: () => import('./copy-data/th.js'),
  ko: () => import('./copy-data/ko.js')
};

export const COPY_LANGUAGES = Object.freeze(Object.keys(COPY_IMPORTS));

export function hasCopyLanguage(lang) {
  return Boolean(COPY_IMPORTS[lang]);
}

export async function loadLanguageCopy(lang) {
  const copyLang = hasCopyLanguage(lang) ? lang : 'en';
  const module = await COPY_IMPORTS[copyLang]();
  return {
    lang: copyLang,
    values: module.default || module[`COPY_${copyLang.toUpperCase()}`] || {}
  };
}
