import React, { useEffect, useMemo, useState } from 'react';
import { Clipboard, Download, Save, Trash2 } from 'lucide-react';
import { copyText, downloadFetchResponse } from '../../shared/browser.js';
import { api } from '../../shared/api.js';
import { formatCopy, formatStatNumber, formatTime, localizeError } from '../../shared/format.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { InfoGrid } from '../../shared/ui/InfoGrid.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

function RustplusRelaySettingsPanel({ settings, onSettingsChange, lang, setToast, t, canEdit = false, onError = null }) {
  const [relayToken, setRelayToken] = useState('');
  const [saving, setSaving] = useState(false);
  const relayEndpoint = useMemo(() => {
    const endpoint = settings?.endpoint || '/api/integrations/rustplus/relay';
    if (typeof window === 'undefined') return endpoint;
    return `${window.location.origin}${endpoint}`;
  }, [settings?.endpoint]);

  async function saveToken(event) {
    event.preventDefault();
    if (!canEdit) return;
    setSaving(true);
    onError?.('');
    try {
      const payload = await api('/api/settings/rustplus-relay', { method: 'PUT', body: { token: relayToken } });
      onSettingsChange?.(payload.rustplusRelay || null);
      setRelayToken('');
      setToast(t('rustplusRelayTokenSaved'));
    } catch (err) {
      onError?.(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  async function clearToken() {
    if (!canEdit) return;
    setSaving(true);
    onError?.('');
    try {
      const payload = await api('/api/settings/rustplus-relay', { method: 'DELETE' });
      onSettingsChange?.(payload.rustplusRelay || null);
      setRelayToken('');
      setToast(t('rustplusRelayTokenCleared'));
    } catch (err) {
      onError?.(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="tool-panel public-api-panel rustplus-relay-settings-panel" onSubmit={saveToken}>
      <div className="section-heading span-2">
        <div>
          <h2>{t('rustplusRelaySettings')}</h2>
          <p>{t('rustplusRelayTokenHint')}</p>
        </div>
        <span className={cx('status-badge', settings?.enabled && 'active')}>
          {settings?.enabled ? t('publicApiEnabled') : t('publicApiDisabled')}
        </span>
      </div>
      <label className="api-endpoint-field span-2">
        <span>{t('rustplusRelayEndpoint')}</span>
        <div className="endpoint-copy-row">
          <input value={relayEndpoint} readOnly />
          <button type="button" className="action-button" onClick={() => copyText(relayEndpoint, setToast, t)} title={t('copyEndpoint')}>
            <Clipboard size={16} />
            <span>{t('copyEndpoint')}</span>
          </button>
        </div>
      </label>
      <label>
        <span>{t('rustplusRelayToken')}</span>
        <input
          value={relayToken}
          onChange={(event) => setRelayToken(event.target.value)}
          minLength={16}
          maxLength={256}
          placeholder={settings?.enabled ? '********' : t('rustplusRelayTokenPlaceholder')}
          type="password"
          autoComplete="new-password"
          disabled={!canEdit || saving}
          required={canEdit}
        />
      </label>
      <div className="api-token-actions">
        <button type="submit" className="primary-button" disabled={!canEdit || saving || !relayToken.trim()}>
          <Save size={17} />
          <span>{saving ? t('saving') : t('saveToken')}</span>
        </button>
        <button type="button" className="action-button danger" onClick={clearToken} title={t('clearToken')} disabled={!canEdit || saving || !settings?.enabled}>
          <Trash2 size={16} />
          <span>{t('clearToken')}</span>
        </button>
      </div>
      <InfoGrid className="span-2 system-settings-info" items={[
        [t('rustplusRelayLastReceived'), formatTime(settings?.lastReceivedAt, lang) || t('notSyncedYet')],
        [t('apiKeyUpdatedAt'), formatTime(settings?.tokenUpdatedAt, lang) || '-'],
        [t('rustplusRelayStorageLimit'), settings?.chatStorageLimitLabel || '-'],
        [t('discordLastPushAt'), formatTime(settings?.lastDiscordPushAt, lang) || t('notSyncedYet')],
        [t('rustplusRelayReportedClients'), formatStatNumber(settings?.clientCount || 0, lang)],
        [t('rustplusRelayReportedServers'), formatStatNumber(settings?.serverCount || 0, lang)],
        [t('rustplusRelayReportedChats'), formatStatNumber(settings?.chatCount || 0, lang)],
        [t('rustplusRelayReportedInviteRecords'), formatStatNumber(settings?.inviteRecordCount || 0, lang)],
        [t('rustplusRelayLastError'), settings?.lastError || '-']
      ]} />
    </form>
  );
}

export default function ApiSettingsView({ lang, setToast, t, canEdit = false }) {
  const [settings, setSettings] = useState({ publicApi: null, rustplusRelay: null, battlemetrics: null, steamWebApi: null });
  const [publicApiToken, setPublicApiToken] = useState('');
  const [battlemetricsKey, setBattlemetricsKey] = useState('');
  const [battlemetricsKeyLabel, setBattlemetricsKeyLabel] = useState('');
  const [steamWebApiKey, setSteamWebApiKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const publicApiEndpoint = useMemo(() => {
    const endpointPath = settings.publicApi?.endpoint || '/api/integrations/public-query';
    if (typeof window === 'undefined') return endpointPath;
    return `${window.location.origin}${endpointPath}`;
  }, [settings.publicApi?.endpoint]);

  async function load() {
    setLoading(true);
    try {
      const payload = await api('/api/settings/api');
      setSettings({
        publicApi: payload.publicApi,
        rustplusRelay: payload.rustplusRelay,
        battlemetrics: payload.battlemetrics,
        steamWebApi: payload.steamWebApi
      });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((err) => setError(localizeError(err.message, t)));
  }, []);

  async function savePublicApiToken(event) {
    event.preventDefault();
    if (!canEdit) return;
    setError('');
    try {
      const payload = await api('/api/settings/public-api', { method: 'PUT', body: { token: publicApiToken } });
      setSettings((current) => ({ ...current, publicApi: payload.publicApi }));
      setPublicApiToken('');
      setToast(t('publicApiTokenSaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function clearPublicApiToken() {
    if (!canEdit) return;
    setError('');
    try {
      const payload = await api('/api/settings/public-api', { method: 'DELETE' });
      setSettings((current) => ({ ...current, publicApi: payload.publicApi }));
      setPublicApiToken('');
      setToast(t('publicApiTokenCleared'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function saveBattlemetricsKey(event) {
    event.preventDefault();
    if (!canEdit) return;
    setError('');
    try {
      const payload = await api('/api/settings/battlemetrics', { method: 'PUT', body: { apiKey: battlemetricsKey, label: battlemetricsKeyLabel } });
      setSettings((current) => ({ ...current, battlemetrics: payload.battlemetrics }));
      setBattlemetricsKey('');
      setBattlemetricsKeyLabel('');
      setToast(t('battlemetricsApiKeySaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function clearBattlemetricsKey(id = '') {
    if (!canEdit) return;
    setError('');
    try {
      const payload = await api('/api/settings/battlemetrics', { method: 'DELETE', body: id ? { id } : {} });
      setSettings((current) => ({ ...current, battlemetrics: payload.battlemetrics }));
      setBattlemetricsKey('');
      setBattlemetricsKeyLabel('');
      setToast(t('battlemetricsApiKeyCleared'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function saveSteamWebApiKey(event) {
    event.preventDefault();
    if (!canEdit) return;
    setError('');
    try {
      const payload = await api('/api/settings/steam-web-api', { method: 'PUT', body: { apiKey: steamWebApiKey } });
      setSettings((current) => ({ ...current, steamWebApi: payload.steamWebApi }));
      setSteamWebApiKey('');
      setToast(t('steamWebApiKeySaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function clearSteamWebApiKey() {
    if (!canEdit) return;
    setError('');
    try {
      const payload = await api('/api/settings/steam-web-api', { method: 'DELETE' });
      setSettings((current) => ({ ...current, steamWebApi: payload.steamWebApi }));
      setSteamWebApiKey('');
      setToast(t('steamWebApiKeyCleared'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function downloadApiDoc() {
    setError('');
    try {
      const response = await fetch('/api/settings/api-doc', { credentials: 'include' });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || t('requestFailed'));
      }
      await downloadFetchResponse(response, 'NB-Clan-API.md');
      setToast(t('apiDocDownloaded'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  if (loading) {
    return (
      <section className="page-stack">
        <PageLoadingState title={t('apiSettings')} t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack">
      <div className="section-heading">
        <h3>{t('apiSettings')}</h3>
        <button type="button" className="ghost-button" onClick={downloadApiDoc} title={t('downloadApiDoc')}>
          <Download size={17} />
          <span>{t('downloadApiDoc')}</span>
        </button>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <form className="tool-panel public-api-panel" onSubmit={savePublicApiToken}>
        <div className="section-heading span-2">
          <div>
            <h2>{t('publicApiSettings')}</h2>
            <p>{t('rootOnlySetting')}</p>
          </div>
          <span className={cx('status-badge', settings.publicApi?.enabled && 'active')}>
            {settings.publicApi?.enabled ? t('publicApiEnabled') : t('publicApiDisabled')}
          </span>
        </div>
        <label className="api-endpoint-field span-2">
          <span>{t('publicApiEndpoint')}</span>
          <div className="endpoint-copy-row">
            <input value={publicApiEndpoint} readOnly />
            <button type="button" className="action-button" onClick={() => copyText(publicApiEndpoint, setToast, t)} title={t('copyEndpoint')}>
              <Clipboard size={16} />
              <span>{t('copyEndpoint')}</span>
            </button>
          </div>
        </label>
        <label>
          <span>{t('publicApiToken')}</span>
          <input
            type="password"
            value={publicApiToken}
            onChange={(event) => setPublicApiToken(event.target.value)}
            minLength={16}
            maxLength={256}
            placeholder={settings.publicApi?.enabled ? '********' : t('publicApiTokenPlaceholder')}
            autoComplete="new-password"
            disabled={!canEdit}
            required={canEdit}
          />
        </label>
        <div className="api-token-actions">
          <button className="primary-button" title={t('saveToken')} disabled={!canEdit}>
            <Save size={17} />
            <span>{t('saveToken')}</span>
          </button>
          <button type="button" className="action-button danger" onClick={clearPublicApiToken} title={t('clearToken')} disabled={!canEdit || !settings.publicApi?.enabled}>
            <Trash2 size={16} />
            <span>{t('clearToken')}</span>
          </button>
        </div>
        <p className="form-hint span-2">{t('publicApiTokenHint')}</p>
      </form>

      <RustplusRelaySettingsPanel
        settings={settings.rustplusRelay}
        onSettingsChange={(rustplusRelay) => setSettings((current) => ({ ...current, rustplusRelay }))}
        lang={lang}
        setToast={setToast}
        t={t}
        canEdit={canEdit}
        onError={setError}
      />

      <form className="tool-panel public-api-panel" onSubmit={saveSteamWebApiKey}>
        <div className="section-heading span-2">
          <div>
            <h2>{t('steamWebApiSettings')}</h2>
            <p>{t('steamWebApiHint')}</p>
          </div>
          <span className={cx('status-badge', settings.steamWebApi?.enabled && 'active')}>
            {settings.steamWebApi?.enabled ? t('publicApiEnabled') : t('publicApiDisabled')}
          </span>
        </div>
        <label>
          <span>{t('steamWebApiKey')}</span>
          <input
            type="password"
            value={steamWebApiKey}
            onChange={(event) => setSteamWebApiKey(event.target.value)}
            minLength={16}
            maxLength={128}
            placeholder={settings.steamWebApi?.enabled ? '********' : t('steamWebApiKeyPlaceholder')}
            autoComplete="new-password"
            disabled={!canEdit}
            required={canEdit}
          />
        </label>
        <div className="api-token-actions">
          <button className="primary-button" title={t('saveKey')} disabled={!canEdit || !steamWebApiKey.trim()}>
            <Save size={17} />
            <span>{t('saveKey')}</span>
          </button>
          <button type="button" className="action-button danger" onClick={clearSteamWebApiKey} title={t('clearKey')} disabled={!canEdit || !settings.steamWebApi?.storeConfigured}>
            <Trash2 size={16} />
            <span>{t('clearKey')}</span>
          </button>
        </div>
        <InfoGrid className="span-2" items={[
          [t('steamWebApiSource'), settings.steamWebApi?.source === 'store' ? t('proxySourceStore') : (settings.steamWebApi?.source === 'env' ? t('proxySourceEnv') : '-')],
          [t('apiKeyUpdatedAt'), formatTime(settings.steamWebApi?.apiKeyUpdatedAt, lang) || '-']
        ]} />
      </form>

      <form className="tool-panel public-api-panel battlemetrics-token-panel" onSubmit={saveBattlemetricsKey}>
        <div className="section-heading span-2">
          <div>
            <h2>{t('battlemetricsApiSettings')}</h2>
            <p>{t('battlemetricsApiHint')}</p>
          </div>
          <span className={cx('status-badge', settings.battlemetrics?.enabled && 'active')}>
            {settings.battlemetrics?.enabled ? t('publicApiEnabled') : t('publicApiDisabled')}
          </span>
        </div>
        {(settings.battlemetrics?.keys || []).length > 0 && (
          <div className="saved-token-list span-2">
            <div className="saved-token-list-head">
              <span>{t('battlemetricsSavedTokens')}</span>
              <strong>{formatCopy(t('battlemetricsTokenCount'), { count: formatStatNumber(settings.battlemetrics?.keyCount || settings.battlemetrics.keys.length, lang) })}</strong>
            </div>
            {settings.battlemetrics.keys.map((key) => (
              <div className="saved-token-row" key={key.id}>
                <label>
                  <span>{key.label || t('battlemetricsApiKey')}</span>
                  <input type="password" value={key.masked || '********'} readOnly />
                </label>
                <span className="saved-token-meta">{formatTime(key.updatedAt, lang) || '-'}</span>
                <button type="button" className="action-button danger token-delete-button" onClick={() => clearBattlemetricsKey(key.id)} title={t('battlemetricsDeleteToken')} disabled={!canEdit}>
                  <Trash2 size={16} />
                  <span>{t('battlemetricsDeleteToken')}</span>
                </button>
              </div>
            ))}
          </div>
        )}
        <label className="battlemetrics-token-label-field">
          <span>{t('battlemetricsTokenLabel')}</span>
          <input
            value={battlemetricsKeyLabel}
            onChange={(event) => setBattlemetricsKeyLabel(event.target.value)}
            maxLength={80}
            placeholder={t('battlemetricsTokenLabelPlaceholder')}
            autoComplete="off"
            disabled={!canEdit}
          />
        </label>
        <label className="battlemetrics-token-key-field">
          <span>{t('battlemetricsApiKey')}</span>
          <input
            type="password"
            value={battlemetricsKey}
            onChange={(event) => setBattlemetricsKey(event.target.value)}
            minLength={24}
            maxLength={2048}
            placeholder={t('battlemetricsApiKeyPlaceholder')}
            autoComplete="new-password"
            disabled={!canEdit}
            required={canEdit}
          />
        </label>
        <div className="api-token-actions">
          <button className="primary-button" title={t('battlemetricsAddToken')} disabled={!canEdit || !battlemetricsKey.trim()}>
            <Save size={17} />
            <span>{t('battlemetricsAddToken')}</span>
          </button>
        </div>
        <InfoGrid className="span-2" items={[
          [t('apiKeyUpdatedAt'), formatTime(settings.battlemetrics?.apiKeyUpdatedAt, lang) || '-'],
          [t('lastSyncAt'), formatTime(settings.battlemetrics?.lastSyncAt, lang) || t('notSyncedYet')]
        ]} />
      </form>

    </section>
  );
}
