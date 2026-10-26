import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { loadLanguageCopy } from './i18n/copy-loader.js';
import { detectLanguage, localeFor } from './i18n/languages.js';
import { PUBLIC_COPY, publicCopyValue } from './i18n/public-copy.js';
import { api } from './shared/api.js';
import Dashboard from './app/Dashboard.jsx';
import { HomeScreen, LoginScreen, KookBindingScreen } from './app/PublicScreens.jsx';
import { Splash, THEME_MODES } from './app/shell-ui.jsx';

function normalizeThemeMode(value) {
  return THEME_MODES.includes(value) ? value : 'system';
}

function readThemeMode() {
  return normalizeThemeMode(localStorage.getItem('nb-theme'));
}

function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [authPage, setAuthPage] = useState(() => new URLSearchParams(window.location.search).get('login') === '1' ? 'login' : 'home');
  const [lang, setLang] = useState(() => localStorage.getItem('nb-lang') || detectLanguage());
  const [themeMode, setThemeMode] = useState(readThemeMode);
  const [loadedCopy, setLoadedCopy] = useState({});
  const [copyLoadFailures, setCopyLoadFailures] = useState({});
  const copySource = useMemo(() => Object.fromEntries(
    Object.keys(PUBLIC_COPY).map(language => [language, { ...PUBLIC_COPY[language], ...loadedCopy[language] }])
  ), [loadedCopy]);
  const t = useMemo(() => (key) => publicCopyValue(copySource, lang, key), [copySource, lang]);
  const hasFullLanguageCopy = Boolean(loadedCopy[lang]);
  const languageCopyFailed = Boolean(copyLoadFailures[lang]);

  function changeLang(nextLang) {
    setLang(nextLang);
    localStorage.setItem('nb-lang', nextLang);
  }

  function changeTheme(nextTheme) {
    const normalizedTheme = normalizeThemeMode(nextTheme);
    setThemeMode(normalizedTheme);
    localStorage.setItem('nb-theme', normalizedTheme);
  }

  useEffect(() => {
    api('/api/auth/me')
      .then((payload) => setUser(payload.user))
      .catch(() => setUser(null))
      .finally(() => setBooting(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadLanguageCopy(lang)
      .then(({ lang: loadedLang, values }) => {
        if (cancelled) return;
        setLoadedCopy((current) => ({ ...current, [loadedLang]: values }));
        setCopyLoadFailures((current) => {
          if (!current[loadedLang]) return current;
          const next = { ...current };
          delete next[loadedLang];
          return next;
        });
      })
      .catch(() => {
        if (!cancelled) setCopyLoadFailures((current) => ({ ...current, [lang]: true }));
      });
    return () => {
      cancelled = true;
    };
  }, [lang]);

  useEffect(() => {
    document.documentElement.lang = localeFor(lang);
  }, [lang]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
  }, [themeMode]);

  if (booting) return <Splash t={t} />;
  if (new URLSearchParams(window.location.search).get('kookBind') === '1') {
    return <KookBindingScreen lang={lang} setLang={changeLang} themeMode={themeMode} setThemeMode={changeTheme} t={t} />;
  }
  if (!user && authPage === 'login') {
    return <LoginScreen onLogin={setUser} onHome={() => setAuthPage('home')} lang={lang} setLang={changeLang} themeMode={themeMode} setThemeMode={changeTheme} t={t} />;
  }
  if (!user) {
    return <HomeScreen onLoginClick={() => setAuthPage('login')} lang={lang} setLang={changeLang} themeMode={themeMode} setThemeMode={changeTheme} t={t} />;
  }
  if (!hasFullLanguageCopy && !languageCopyFailed) return <Splash t={t} />;
  return (
    <React.Suspense fallback={<Splash t={t} />}>
      <Dashboard
        user={user}
        onUserChange={(nextUser) => {
          setUser(nextUser);
          if (!nextUser) setAuthPage('home');
        }}
        lang={lang}
        setLang={changeLang}
        themeMode={themeMode}
        setThemeMode={changeTheme}
        t={t}
      />
    </React.Suspense>
  );
}

const rootElement = document.getElementById('root');
const appRoot = rootElement.__nbClanRoot || createRoot(rootElement);
rootElement.__nbClanRoot = appRoot;
appRoot.render(<App />);
