import React, { useEffect, useState } from 'react';
import { ChevronDown, Plus, RefreshCw, RotateCcw, Save, Trash2 } from 'lucide-react';
import { api } from '../../shared/api.js';
import { formatTime, localizeError } from '../../shared/format.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { InfoGrid } from '../../shared/ui/InfoGrid.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';
import {
  BotCollapsibleHeader,
  createDiscordKookBridgeRouteForm,
  discordKookBridgeFormFromPayload,
  discordKookBridgeSavePayload
} from '../../shared/bot/settings.jsx';

function DiscordKookBridgeView({ lang, setToast, t, canEdit = false, isRoot = false }) {
  const [bridge, setBridge] = useState(null);
  const [form, setForm] = useState(() => discordKookBridgeFormFromPayload(null));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState('');
  const [error, setError] = useState('');
  const [openSections, setOpenSections] = useState({ translation: false, routes: true });
  const [openRoutes, setOpenRoutes] = useState({});

  async function load() {
    setLoading(true);
    setError('');
    try {
      const payload = await api('/api/settings/discord-kook-bridge');
      setBridge(payload.bridge || null);
      setForm(discordKookBridgeFormFromPayload(payload.bridge));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  async function save(options = {}) {
    if (!canEdit || saving) return;
    setSaving(true);
    setError('');
    try {
      const payload = await api('/api/settings/discord-kook-bridge', {
        method: 'PUT',
        body: discordKookBridgeSavePayload({
          ...form,
          resetCursors: Boolean(options.resetCursors),
          resetRouteIds: options.resetRouteIds || []
        }, { includeCredentials: isRoot })
      });
      setBridge(payload.bridge || null);
      setForm(discordKookBridgeFormFromPayload(payload.bridge));
      setToast(t('discordKookSaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  async function saveRoute(routeId) {
    if (!canEdit || saving) return;
    const targetRoute = (form.routes || []).find((route) => route.id === routeId);
    if (!targetRoute) return;
    setSaving(true);
    setError('');
    try {
      const persistedForm = bridge ? discordKookBridgeFormFromPayload(bridge) : { ...form, routes: [] };
      const persistedRoutes = Array.isArray(persistedForm.routes) ? persistedForm.routes : [];
      const routeIndex = persistedRoutes.findIndex((route) => route.id === routeId);
      const routes = routeIndex >= 0
        ? persistedRoutes.map((route, index) => (index === routeIndex ? targetRoute : route))
        : [...persistedRoutes, targetRoute];
      const payload = await api('/api/settings/discord-kook-bridge', {
        method: 'PUT',
        body: discordKookBridgeSavePayload({
          ...persistedForm,
          routes
        }, { includeCredentials: isRoot })
      });
      setBridge(payload.bridge || null);
      setForm(discordKookBridgeFormFromPayload(payload.bridge));
      setToast(t('discordKookRouteSaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  async function runOnce(routeId = '') {
    if (!canEdit || syncing) return;
    setSyncing(routeId || 'all');
    setError('');
    try {
      const payload = await api('/api/settings/discord-kook-bridge/sync', {
        method: 'POST',
        body: routeId ? { routeId } : {}
      });
      setBridge(payload.bridge || null);
      setForm(discordKookBridgeFormFromPayload(payload.bridge));
      setToast(t('discordKookSynced'));
    } catch (err) {
      setError(localizeError(err.message, t));
      load().catch(() => {});
    } finally {
      setSyncing('');
    }
  }

  function addRoute() {
    if (!canEdit) return;
    const nextRoute = createDiscordKookBridgeRouteForm();
    setForm((current) => ({
      ...current,
      routes: [...(current.routes || []), nextRoute]
    }));
    setOpenSections((current) => ({ ...current, routes: true }));
    setOpenRoutes((current) => ({ ...current, [nextRoute.id]: true }));
  }

  function updateRoute(routeId, patch) {
    setForm((current) => ({
      ...current,
      routes: (current.routes || []).map((route) => (route.id === routeId ? { ...route, ...patch } : route))
    }));
  }

  function removeRoute(routeId) {
    if (!canEdit) return;
    setForm((current) => ({
      ...current,
      routes: (current.routes || []).filter((route) => route.id !== routeId)
    }));
  }

  function toggleSection(section) {
    setOpenSections((current) => ({ ...current, [section]: !current[section] }));
  }

  function toggleRoute(routeId) {
    setOpenRoutes((current) => ({ ...current, [routeId]: !(current[routeId] ?? true) }));
  }

  if (loading && !bridge) {
    return <PageLoadingState title={t('discordKookSyncTitle')} t={t} />;
  }

  const routes = form.routes || [];
  const routePayloadById = new Map((bridge?.routes || []).map((route) => [route.id, route]));
  const configured = Boolean(bridge?.configured);
  const enabled = Boolean(form.enabled);
  const pollSeconds = bridge?.pollIntervalMs ? `${Math.round(bridge.pollIntervalMs / 1000)}s` : '-';
  const pollIntervalMinSeconds = Math.round(Number(bridge?.pollIntervalMinMs || 5000) / 1000);
  const pollIntervalMaxSeconds = Math.round(Number(bridge?.pollIntervalMaxMs || 300000) / 1000);
  const canAddRoute = routes.length < (bridge?.maxRoutes || 30);
  const canEditCredentials = canEdit && isRoot;
  const translationKeySourceLabel = bridge?.translationKeySource === 'web'
    ? t('discordKookTranslationKeySourceWeb')
    : bridge?.translationKeySource === 'env'
      ? t('discordKookTranslationKeySourceEnv')
      : t('discordKookTranslationKeySourceNone');

  return (
    <section className="page-stack discord-kook-bridge-page">
      <div className="section-heading compact-heading">
        <div className="heading-stack">
          <h3>{t('discordKookSyncTitle')}</h3>
          <p>{t('discordKookSyncHint')}</p>
        </div>
        <div className="heading-actions">
          <span className={cx('status-badge', configured ? 'complete' : (enabled ? 'pending' : 'closed'))}>
            {enabled ? (configured ? t('discordKookSyncConfigured') : t('discordKookSyncNotConfigured')) : t('discordKookSyncDisabled')}
          </span>
          <button type="button" className="ghost-button fit-button" disabled={loading} onClick={load}>
            <RefreshCw size={17} />
            <span>{t('refresh')}</span>
          </button>
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <section className="tool-panel discord-kook-status-panel">
        <div className="section-heading compact-heading">
          <div className="heading-stack">
            <h3>{t('discordKookControlPanel')}</h3>
            <p>{t('discordKookControlHint')}</p>
          </div>
          <div className="heading-actions">
            <label className="checkbox-row compact-checkbox">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
                disabled={!canEdit}
              />
              <span>{t('discordKookSyncEnabled')}</span>
            </label>
            <button type="button" className="ghost-button fit-button" disabled={!canEdit || Boolean(syncing) || !enabled} onClick={() => runOnce()}>
              <RefreshCw size={17} />
              <span>{syncing === 'all' ? t('loading') : t('discordKookRunOnce')}</span>
            </button>
            <button type="button" className="ghost-button fit-button danger" disabled={!canEdit || saving || !routes.length} onClick={() => save({ resetCursors: true })}>
              <RotateCcw size={17} />
              <span>{t('discordKookResetCursors')}</span>
            </button>
            <button type="button" className="primary-button fit-button" disabled={!canEdit || saving} onClick={() => save()}>
              <Save size={17} />
              <span>{saving ? t('saving') : t('discordKookSave')}</span>
            </button>
          </div>
        </div>
        <div className="discord-kook-control-form">
          <label>
            <span>{t('discordKookPollIntervalInput')}</span>
            <input
              type="number"
              min={pollIntervalMinSeconds}
              max={pollIntervalMaxSeconds}
              step="1"
              value={form.pollIntervalSeconds}
              onChange={(event) => setForm({ ...form, pollIntervalSeconds: event.target.value })}
              disabled={!canEdit}
            />
          </label>
        </div>
        <InfoGrid items={[
          [t('discordKookTranslationKeyStatus'), bridge?.translationConfigured ? t('fieldYes') : t('fieldNo')],
          [t('discordKookTranslationKeySource'), translationKeySourceLabel],
          [t('discordKookTranslationModel'), bridge?.translationModel || '-'],
          [t('discordKookTranslationBaseUrl'), bridge?.translationBaseUrl || '-'],
          [t('discordKookDiscordBotStatus'), bridge?.discordConfigured ? t('fieldYes') : t('fieldNo')],
          [t('discordKookKookBotStatus'), bridge?.kookConfigured ? t('fieldYes') : t('fieldNo')],
          [t('discordKookRouteCount'), bridge?.routeCount ?? routes.length],
          [t('discordKookEnabledRouteCount'), bridge?.enabledRouteCount ?? routes.filter((route) => route.enabled).length],
          [t('discordKookConfiguredRouteCount'), bridge?.configuredRouteCount ?? 0],
          [t('discordKookLastSyncAt'), formatTime(bridge?.lastSyncAt, lang) || '-'],
          [t('discordKookLastSyncError'), bridge?.lastSyncError || '-'],
          [t('discordKookPollInterval'), pollSeconds],
          [t('discordKookBatchLimit'), bridge?.batchLimit || '-']
        ]} />
        <p className="form-hint">{t('discordKookPollIntervalHint')}</p>
        <p className="form-hint">{t('discordKookResetCursorsHint')}</p>
      </section>

      <section className={cx('tool-panel discord-kook-translation-panel', !openSections.translation && 'collapsed')}>
        <BotCollapsibleHeader
          title={t('discordKookAiTranslation')}
          description={t('discordKookEveryoneHint')}
          open={openSections.translation}
          onToggle={() => toggleSection('translation')}
        />
        {openSections.translation && (
          <>
            <div className="discord-kook-translation-form">
              <label>
                <span>{t('discordKookTranslationKey')}</span>
                <input
                  type="password"
                  value={form.translationApiKey}
                  onChange={(event) => setForm({ ...form, translationApiKey: event.target.value })}
                  maxLength={4096}
                  placeholder={bridge?.translationKeyMasked || t('discordKookTranslationKeyPlaceholder')}
                  autoComplete="new-password"
                  disabled={!canEditCredentials || form.clearTranslationApiKey}
                />
              </label>
              <label>
                <span>{t('discordKookTranslationBaseUrl')}</span>
                <input
                  value={form.translationBaseUrl}
                  onChange={(event) => setForm({ ...form, translationBaseUrl: event.target.value })}
                  maxLength={240}
                  placeholder={bridge?.translationBaseUrl || 'https://api.example.com/v1'}
                  disabled={!canEditCredentials}
                />
              </label>
              <label>
                <span>{t('discordKookTranslationModel')}</span>
                <input
                  value={form.translationModel}
                  onChange={(event) => setForm({ ...form, translationModel: event.target.value })}
                  maxLength={120}
                  placeholder={bridge?.translationModel || 'gpt-5.4-mini'}
                  disabled={!canEdit}
                />
              </label>
              <label className="checkbox-row compact-checkbox discord-kook-clear-key">
                <input
                  type="checkbox"
                  checked={form.clearTranslationApiKey}
                  onChange={(event) => setForm({ ...form, clearTranslationApiKey: event.target.checked, translationApiKey: event.target.checked ? '' : form.translationApiKey })}
                  disabled={!canEditCredentials || bridge?.translationKeySource !== 'web'}
                />
                <span>{t('discordKookClearTranslationKey')}</span>
              </label>
            </div>
            <p className="form-hint">{t('discordKookTranslationKeyHint')}</p>
          </>
        )}
      </section>

      <section className={cx('tool-panel discord-kook-routes-panel', !openSections.routes && 'collapsed')}>
        <BotCollapsibleHeader
          title={t('discordKookRoutes')}
          description={t('discordKookSyncHint')}
          open={openSections.routes}
          onToggle={() => toggleSection('routes')}
          actions={(
            <button type="button" className="primary-button fit-button" disabled={!canEdit || !canAddRoute} onClick={addRoute}>
              <Plus size={17} />
              <span>{t('discordKookAddRoute')}</span>
            </button>
          )}
        />

        {openSections.routes && (
          <>
            {!routes.length && <div className="empty-state">{t('discordKookNoRoutes')}</div>}

            <div className="discord-kook-route-grid">
              {routes.map((route, index) => {
                const routePayload = routePayloadById.get(route.id) || {};
                const routeConfigured = Boolean(routePayload.configured);
                const routeTitle = route.name || `${t('discordKookRoute')} ${index + 1}`;
                const routeOpen = openRoutes[route.id] ?? true;
                return (
                  <article className={cx('discord-kook-route-card', !routeOpen && 'collapsed')} key={route.id}>
                    <div className="discord-kook-route-head">
                      <button
                        type="button"
                        className="discord-kook-route-title-button"
                        aria-expanded={routeOpen}
                        onClick={() => toggleRoute(route.id)}
                      >
                        <ChevronDown size={17} />
                        <span>
                          <strong>{routeTitle}</strong>
                          <small>{route.discordChannelId || '-'} ↔ {route.kookChannelId || '-'}</small>
                        </span>
                      </button>
                      <div className="heading-actions">
                        <span className={cx('status-badge', routeConfigured ? 'complete' : (route.enabled ? 'pending' : 'closed'))}>
                          {route.enabled ? (routeConfigured ? t('discordKookRouteReady') : t('discordKookRouteIncomplete')) : t('discordKookSyncDisabled')}
                        </span>
                        <button type="button" className="ghost-button fit-button" disabled={!canEdit || saving} onClick={() => saveRoute(route.id)}>
                          <Save size={16} />
                          <span>{saving ? t('saving') : t('discordKookSaveRoute')}</span>
                        </button>
                        <button type="button" className="ghost-button fit-button" disabled={!canEdit || Boolean(syncing) || !enabled || !route.enabled} onClick={() => runOnce(route.id)}>
                          <RefreshCw size={16} />
                          <span>{syncing === route.id ? t('loading') : t('discordKookSyncThisRoute')}</span>
                        </button>
                        <button type="button" className="ghost-button fit-button danger" disabled={!canEdit || saving} onClick={() => save({ resetRouteIds: [route.id] })}>
                          <RotateCcw size={16} />
                          <span>{t('discordKookResetThisRoute')}</span>
                        </button>
                        <button type="button" className="icon-button danger" title={t('discordKookRemoveRoute')} disabled={!canEdit} onClick={() => removeRoute(route.id)}>
                          <Trash2 size={17} />
                        </button>
                      </div>
                    </div>
                    {routeOpen && (
                      <>
                        <div className="discord-kook-route-form">
                          <label className="span-2">
                            <span>{t('discordKookRouteName')}</span>
                            <input value={route.name} onChange={(event) => updateRoute(route.id, { name: event.target.value })} maxLength={100} placeholder={t('discordKookRouteNamePlaceholder')} disabled={!canEdit} />
                          </label>
                          <label className="checkbox-row compact-checkbox discord-kook-route-enabled">
                            <input
                              type="checkbox"
                              checked={route.enabled}
                              onChange={(event) => updateRoute(route.id, { enabled: event.target.checked })}
                              disabled={!canEdit}
                            />
                            <span>{t('discordKookSyncEnabled')}</span>
                          </label>
                          <div className="discord-kook-route-channel-pair span-2">
                            <div className="discord-kook-route-endpoint">
                              <strong>{t('discordKookDiscordEndpoint')}</strong>
                              <label>
                                <span>{t('discordGuildId')}</span>
                                <input value={route.discordGuildId} onChange={(event) => updateRoute(route.id, { discordGuildId: event.target.value })} maxLength={32} placeholder={t('discordGuildIdPlaceholder')} disabled={!canEdit} />
                              </label>
                              <label>
                                <span>{t('discordKookDiscordForwardChannelId')}</span>
                                <input value={route.discordChannelId} onChange={(event) => updateRoute(route.id, { discordChannelId: event.target.value })} maxLength={32} placeholder={t('discordKookDiscordForwardChannelIdPlaceholder')} disabled={!canEdit} />
                              </label>
                            </div>
                            <div className="discord-kook-route-endpoint">
                              <strong>{t('discordKookKookEndpoint')}</strong>
                              <label>
                                <span>{t('discordKookKookForwardChannelId')}</span>
                                <input value={route.kookChannelId} onChange={(event) => updateRoute(route.id, { kookChannelId: event.target.value, kookGuildId: '' })} maxLength={80} placeholder={t('discordKookKookForwardChannelIdPlaceholder')} disabled={!canEdit} />
                              </label>
                              <label className="discord-kook-token-field">
                                <span>{t('discordKookAccessToken')}</span>
                                <input
                                  type="password"
                                  value={route.kookAccessToken || ''}
                                  onChange={(event) => updateRoute(route.id, { kookAccessToken: event.target.value })}
                                  maxLength={4096}
                                  placeholder={routePayload.kookAccessTokenMasked || t('discordKookAccessTokenPlaceholder')}
                                  autoComplete="new-password"
                                  disabled={!canEdit || route.clearKookAccessToken}
                                />
                              </label>
                              <small>{t('discordKookDirectSendHint')}</small>
                              <label className="checkbox-row compact-checkbox">
                                <input
                                  type="checkbox"
                                  checked={Boolean(route.clearKookAccessToken)}
                                  onChange={(event) => updateRoute(route.id, {
                                    clearKookAccessToken: event.target.checked,
                                    kookAccessToken: event.target.checked ? '' : route.kookAccessToken
                                  })}
                                  disabled={!canEdit || !routePayload.kookAccessTokenConfigured}
                                />
                                <span>{t('discordKookClearAccessToken')}</span>
                              </label>
                            </div>
                          </div>
                        </div>
                        <InfoGrid className="discord-kook-route-info" items={[
                          [t('discordKookLastSyncAt'), formatTime(routePayload.lastSyncAt, lang) || '-'],
                          [t('discordKookLastSyncError'), routePayload.lastSyncError || '-'],
                          [t('discordKookLastDiscordCursor'), routePayload.lastDiscordMessageId || '-'],
                          [t('discordKookLastKookCursor'), routePayload.lastKookMessageId || '-'],
                          [t('discordKookLastForwardedDiscord'), routePayload.lastForwardedDiscordMessageId || '-'],
                          [t('discordKookLastForwardedKook'), routePayload.lastForwardedKookMessageId || '-']
                        ]} />
                      </>
                    )}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </section>
    </section>
  );
}

export default DiscordKookBridgeView;
