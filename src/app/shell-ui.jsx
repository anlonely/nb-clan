import React, { useCallback, useEffect } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { LANGUAGES, languageOptionLabel } from '../i18n/languages.js';
import { PageLoadingState } from '../shared/ui/PageLoadingState.jsx';
import { cx } from '../shared/ui/cx.js';

export const THEME_MODES = ['system', 'light', 'dark'];

export function useToastMessage(timeoutMs = 2200) {
  const [toast, setToastState] = React.useState(null);
  const showToast = useCallback((message) => {
    const text = String(message || '').trim();
    setToastState(text ? { id: `${Date.now()}:${Math.random()}`, message: text } : null);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToastState(null), timeoutMs);
    return () => clearTimeout(timer);
  }, [timeoutMs, toast]);

  return [toast, showToast];
}

export function ToastMessage({ toast }) {
  if (!toast?.message) return null;
  return React.createElement('div', { className: 'toast' }, toast.message);
}

export function Splash({ t }) {
  return (
    <main className="splash">
      <PageLoadingState title="NB Clan" t={t} compact />
    </main>
  );
}

export function LanguageSwitcher({ lang, setLang, t }) {
  return (
    <label className="language-switcher" title={t('langLabel')}>
      <span>{t('langLabel')}</span>
      <select value={lang} onChange={(event) => setLang(event.target.value)} aria-label={t('langLabel')}>
        {LANGUAGES.map((item) => (
          <option key={item.id} value={item.id}>
            {languageOptionLabel(item, lang)}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ThemeSwitcher({ themeMode, setThemeMode, t }) {
  const modes = [
    { id: 'system', icon: Monitor, label: t('themeSystem') },
    { id: 'light', icon: Sun, label: t('themeLight') },
    { id: 'dark', icon: Moon, label: t('themeDark') }
  ];
  return (
    <div className="theme-switcher" role="group" aria-label={t('themeLabel')}>
      {modes.map((mode) => {
        const Icon = mode.icon;
        return (
          <button
            key={mode.id}
            type="button"
            className={cx('theme-toggle-button', themeMode === mode.id && 'active')}
            title={mode.label}
            aria-label={mode.label}
            aria-pressed={themeMode === mode.id}
            onClick={() => setThemeMode(mode.id)}
          >
            <Icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
