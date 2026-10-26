import React, { useEffect, useState } from 'react';
import { LogIn, Search, ShieldCheck } from 'lucide-react';
import { normalizeLanguageId } from '../i18n/languages.js';
import { localizePublicError } from '../i18n/public-copy.js';
import { api } from '../shared/api.js';
import { Alert } from '../shared/ui/Alert.jsx';
import { BrandMark } from '../shared/ui/BrandMark.jsx';
import { PageLoadingState } from '../shared/ui/PageLoadingState.jsx';
import { LanguageSwitcher, ThemeSwitcher, ToastMessage, useToastMessage } from './shell-ui.jsx';
import { QueryView } from './lazyViews.jsx';

function PublicHeader({ lang, setLang, themeMode, setThemeMode, t, onLoginClick, onHome, mode = 'home' }) {
  return (
    <header className="public-header">
      <button className="brand-button" onClick={onHome || undefined} disabled={!onHome}>
        <BrandMark />
        <span>{t('appName')}</span>
      </button>
      <div className="public-actions">
        <LanguageSwitcher lang={lang} setLang={setLang} t={t} />
        <ThemeSwitcher themeMode={themeMode} setThemeMode={setThemeMode} t={t} />
        {mode === 'home' ? (
          <button className="ghost-button login-top-button" onClick={onLoginClick}>
            <ShieldCheck size={17} />
            {t('login')}
          </button>
        ) : (
          <button className="ghost-button login-top-button" onClick={onHome}>
            <Search size={17} />
            {t('backHome')}
          </button>
        )}
      </div>
    </header>
  );
}

export function HomeScreen({ onLoginClick, lang, setLang, themeMode, setThemeMode, t }) {
  const [toast, setToast] = useToastMessage();

  return (
    <main className="public-page">
      <PublicHeader lang={lang} setLang={setLang} themeMode={themeMode} setThemeMode={setThemeMode} t={t} onLoginClick={onLoginClick} />
      <section className="home-lookup">
        <div className="home-title">
          <h1>{t('appName')}</h1>
          <p>{t('homeLead')}</p>
        </div>
        <React.Suspense fallback={<PageLoadingState title={t('query')} t={t} compact />}>
          <QueryView setToast={setToast} lang={lang} t={t} publicHome />
        </React.Suspense>
      </section>
      <ToastMessage toast={toast} />
    </main>
  );
}

export function LoginScreen({ onLogin, onHome, lang, setLang, themeMode, setThemeMode, t }) {
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [thirdPartyLogin, setThirdPartyLogin] = useState(null);
  const [error, setError] = useState('');
  const steamLoginEnabled = thirdPartyLogin?.steam?.enabled === true;
  const kookLoginEnabled = thirdPartyLogin?.kook?.enabled === true;
  const discordLoginEnabled = thirdPartyLogin?.discord?.enabled === true;

  useEffect(() => {
    api('/api/auth/third-party-login')
      .then((payload) => setThirdPartyLogin(payload.thirdPartyLogin || null))
      .catch(() => setThirdPartyLogin(null));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get('authError') || '';
    const authLang = normalizeLanguageId(params.get('authLang') || '');
    if (authLang && authLang !== lang) setLang(authLang);
    if (authError) {
      setError(localizePublicError(authError, t));
      params.delete('login');
      params.delete('authError');
      params.delete('authLang');
      const nextSearch = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${nextSearch ? `?${nextSearch}` : ''}`);
    }
  }, []);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setLoading(true);
    try {
      const payload = await api('/api/auth/login', {
        method: 'POST',
        body: { username, password }
      });
      onLogin(payload.user);
    } catch (err) {
      setError(localizePublicError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  function loginWithProvider(provider) {
    const startUrl = thirdPartyLogin?.[provider]?.startUrl || `/api/auth/${provider}/start`;
    const target = new URL(startUrl, window.location.origin);
    target.searchParams.set('lang', lang);
    window.location.href = `${target.pathname}${target.search}${target.hash}`;
  }

  return (
    <main className="public-page login-only-page">
      <PublicHeader lang={lang} setLang={setLang} themeMode={themeMode} setThemeMode={setThemeMode} t={t} onHome={onHome} mode="login" />
      <section className="login-panel">
        <div className="login-brand">
          <BrandMark />
          <div>
            <h1>{t('appName')}</h1>
            <p>{t('systemName')}</p>
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>
            <span>{t('account')}</span>
            <input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" />
          </label>
          <label>
            <span>{t('password')}</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              autoFocus
            />
          </label>
          {error && <Alert tone="danger">{error}</Alert>}
          <button className="primary-button wide" disabled={loading}>
            <ShieldCheck size={18} />
            {loading ? t('loggingIn') : t('login')}
          </button>
        </form>
        {(steamLoginEnabled || discordLoginEnabled || kookLoginEnabled) && (
          <div className="third-party-login-panel">
            <div className="login-divider"><span>{t('thirdPartyLogin')}</span></div>
            {steamLoginEnabled && (
              <button type="button" className="ghost-button wide steam-login-button" onClick={() => loginWithProvider('steam')}>
                <LogIn size={18} />
                <span>{t('steamLogin')}</span>
              </button>
            )}
            {discordLoginEnabled && (
              <button type="button" className="ghost-button wide steam-login-button" onClick={() => loginWithProvider('discord')}>
                <LogIn size={18} />
                <span>{t('discordLogin')}</span>
              </button>
            )}
            {kookLoginEnabled && (
              <button type="button" className="ghost-button wide steam-login-button" onClick={() => loginWithProvider('kook')}>
                <LogIn size={18} />
                <span>{t('kookLogin')}</span>
              </button>
            )}
          </div>
        )}
      </section>
    </main>
  );
}

export function KookBindingScreen({ lang, setLang, themeMode, setThemeMode, t }) {
  const [context, setContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(() => new URLSearchParams(window.location.search).get('kookBindError') || '');
  useEffect(() => {
    let cancelled = false;
    const authLang = normalizeLanguageId(new URLSearchParams(window.location.search).get('authLang') || '');
    if (authLang && authLang !== lang) setLang(authLang);
    api('/api/auth/kook/onboarding').then((payload) => {
      if (cancelled) return;
      setContext(payload);
    }).catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);
  async function submit(event) {
    event.preventDefault();
    if (!context || saving) return;
    setSaving(true);
    setError('');
    try {
      const payload = await api('/api/auth/kook/bind/start', {
        method: 'POST', body: { csrfToken: context.csrfToken }
      });
      window.location.assign(payload.authorizationUrl);
    } catch (err) {
      setError(err.message);
      if (err.status === 401) setContext(null);
      setSaving(false);
    }
  }
  return (
    <main className="public-page login-only-page">
      <PublicHeader lang={lang} setLang={setLang} themeMode={themeMode} setThemeMode={setThemeMode}
        t={t} onHome={() => window.location.assign('/')} mode="login" />
      <section className="login-panel">
        <div className="login-brand">
          <BrandMark />
          <div><h1>{t('kookBindTitle')}</h1><p>{context?.username || 'KOOK'}</p></div>
        </div>
        <p>{t('kookBindHint')}</p>
        {loading ? <PageLoadingState title={t('loading')} t={t} compact /> : (
          <form className="login-form" onSubmit={submit}>
            {error && <Alert tone="danger">{localizePublicError(error, t)}</Alert>}
            {context && (
              <>
                <button className="primary-button wide" disabled={saving}>
                  <ShieldCheck size={18} />
                  <span>{saving ? t('loading') : t('kookConfirmSteam')}</span>
                </button>
              </>
            )}
            <button type="button" className="ghost-button wide" disabled={saving}
              onClick={() => window.location.assign(`/api/auth/kook/start?lang=${encodeURIComponent(lang)}`)}>
              <LogIn size={18} /><span>{t('kookRestartLogin')}</span>
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
