import { displayTimeZone, displayTimeZoneSnapshot, subscribeDisplayTimeZone } from './display-preferences.js';
import React, { useSyncExternalStore } from 'react';
import { getUiLocale, setUiLocale, subscribeUiLocale, t } from './i18n.js';

export function useUiLocale() {
  return useSyncExternalStore(subscribeUiLocale, getUiLocale, () => 'zh');
}
export function LanguageSwitch() {
  const locale = useUiLocale();
  return <div className="ui-language-switch" role="group" aria-label={t('界面语言')}>
    <button type="button" lang="zh-CN" aria-pressed={locale === 'zh'} onClick={() => setUiLocale('zh')}>中文</button>
    <button type="button" lang="en" aria-pressed={locale === 'en'} onClick={() => setUiLocale('en')}>English</button>
  </div>;
}

export function useDisplayTimeZone() {
  useSyncExternalStore(subscribeDisplayTimeZone, displayTimeZoneSnapshot, () => '|UTC');
  return displayTimeZone();
}
