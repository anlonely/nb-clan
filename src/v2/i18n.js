import core from './locales/en-core.json' with { type: 'json' };
import admin from './locales/en-admin.json' with { type: 'json' };
import members from './locales/en-members.json' with { type: 'json' };
import platforms from './locales/en-platforms.json' with { type: 'json' };
import bot from './locales/en-bot.json' with { type: 'json' };

// UI preference only. Reuse the legacy Web key; never change message language or time zone.
export const UI_LANGUAGE_KEY = 'nb-lang';
export const englishCopy = Object.freeze({ ...admin, ...platforms, ...members, ...core, ...bot });
export const normalizeUiLocale = value => /^zh(?:[-_]|$)/i.test(String(value || '')) ? 'zh' : 'en';
export const browserUiLocale = () => normalizeUiLocale(globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'zh');
function initialLocale() {
  const requested = new URLSearchParams(globalThis.location?.search || '').get('lang');
  if (requested === 'en' || requested === 'zh') {
    try { globalThis.localStorage?.setItem(UI_LANGUAGE_KEY, requested); } catch { /* Explicit language still works without storage. */ }
    return requested;
  }
  try {
    const saved = globalThis.localStorage?.getItem(UI_LANGUAGE_KEY);
    if (saved) return normalizeUiLocale(saved);
  } catch { /* Storage may be unavailable in private browsing. */ }
  return null;
}
let manualLocale = initialLocale();
let locale = manualLocale || browserUiLocale();
const listeners = new Set();
export const getUiLocale = () => locale;
export const dateLocale = () => locale === 'en' ? 'en-US' : 'zh-CN';
export function setUiLocale(value) {
  const next = normalizeUiLocale(value);
  manualLocale = next;
  try { globalThis.localStorage?.setItem(UI_LANGUAGE_KEY, next); } catch { /* Keep the in-memory preference. */ }
  if (locale === next) return;
  locale = next;
  listeners.forEach(listener => listener());
}
function storageChanged(event) {
  if (event.key !== UI_LANGUAGE_KEY && event.key !== null) return;
  manualLocale = initialLocale();
  const next = manualLocale || browserUiLocale();
  if (locale !== next) { locale = next; listeners.forEach(listener => listener()); }
}
function browserLanguageChanged() {
  if (manualLocale) return;
  const next = browserUiLocale();
  if (locale !== next) { locale = next; listeners.forEach(listener => listener()); }
}
export function subscribeUiLocale(listener) {
  if (!listeners.size) { globalThis.addEventListener?.('storage', storageChanged); globalThis.addEventListener?.('languagechange', browserLanguageChanged); }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) { globalThis.removeEventListener?.('storage', storageChanged); globalThis.removeEventListener?.('languagechange', browserLanguageChanged); }
  };
}
export function t(source, values) {
  if (typeof source !== 'string') return source;
  const copy = locale === 'en' ? englishCopy[source] ?? source : source;
  return values ? copy.replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(values, key) ? String(values[key] ?? '') : match) : copy;
}
