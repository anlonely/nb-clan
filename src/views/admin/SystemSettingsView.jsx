import { roleOptionLabel } from '../../shared/permissions.js';
import React, { useEffect, useState } from 'react';
import { ImagePlus, RefreshCw, Save } from 'lucide-react';
import { fileToDataUrl } from '../../shared/browser.js';
import { api } from '../../shared/api.js';
import { formatBytes, formatCopy, formatStatNumber, formatTime, latestTimestamp, localizeError } from '../../shared/format.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { BrandMark } from '../../shared/ui/BrandMark.jsx';
import { InfoGrid } from '../../shared/ui/InfoGrid.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

function proxyScopeLabel(scope, t) {
  if (scope === 'battlemetrics') return t('proxyScopeBattlemetrics');
  if (scope === 'kda') return t('proxyScopeKda');
  return t('proxyScopeGlobal');
}

function proxySourceLabel(source, t) {
  if (source === 'store') return t('proxySourceStore');
  if (source === 'env') return t('proxySourceEnv');
  return t('publicApiDisabled');
}

function proxyActiveTargetsLabel(proxy, t) {
  const targets = [];
  if (proxy?.battlemetricsActive) targets.push(t('proxyTargetsBattlemetrics'));
  if (proxy?.kdaActive) targets.push(t('proxyTargetsKda'));
  if (proxy?.battlemetricsActive && proxy?.kdaActive) return t('proxyTargetsGlobal');
  return targets.length ? targets.join(' / ') : t('publicApiDisabled');
}

function proxySourceHint(source, t) {
  if (source === 'store') return t('proxySourceHintStore');
  if (source === 'env') return t('proxySourceHintEnv');
  return t('proxySourceHintNone');
}

function proxyScopeHint(scope, t) {
  if (scope === 'battlemetrics') return t('proxyScopeHintBattlemetrics');
  if (scope === 'kda') return t('proxyScopeHintKda');
  return t('proxyScopeHintGlobal');
}

function proxyRouteValue(route, t) {
  if (!route?.active) return t('proxyDirect');
  return `${t('proxyViaProxy')} · ${proxySourceLabel(route.source, t)}`;
}

function proxyRouteHint(route, t) {
  if (!route?.active) return t('proxySourceHintNone');
  return route.url || proxyScopeHint(route.scope, t);
}

function ProxyStatusGrid({ proxy, t }) {
  const cards = [
    {
      label: t('proxySource'),
      value: proxySourceLabel(proxy?.source, t),
      hint: proxySourceHint(proxy?.source, t)
    },
    {
      label: t('proxyCurrentEffective'),
      value: proxyActiveTargetsLabel(proxy, t),
      hint: proxy?.enabled ? proxyScopeHint(proxy?.scope, t) : t('proxySourceHintNone')
    },
    {
      label: t('proxySavedScope'),
      value: proxyScopeLabel(proxy?.savedScope || proxy?.scope, t),
      hint: proxy?.enabled ? proxyScopeHint(proxy?.scope, t) : t('proxySourceHintNone')
    },
    {
      label: t('proxyBattlemetricsRoute'),
      value: proxyRouteValue(proxy?.battlemetrics, t),
      hint: proxyRouteHint(proxy?.battlemetrics, t)
    },
    {
      label: t('proxyKdaRoute'),
      value: proxyRouteValue(proxy?.kda, t),
      hint: proxyRouteHint(proxy?.kda, t)
    }
  ];
  return (
    <div className="proxy-status-grid span-2" aria-label={t('proxyStatus')}>
      {cards.map((card) => (
        <div className="proxy-status-card" key={card.label}>
          <span>{card.label}</span>
          <strong>{card.value}</strong>
          <small>{card.hint}</small>
        </div>
      ))}
    </div>
  );
}

function StorageStatusPanel({ storage, lang, t }) {
  if (!storage) return null;
  const disk = storage.disk || {};
  const usedPercent = Math.max(0, Math.min(100, Number(disk.usedPercent || 0)));
  const cards = [
    {
      label: t('appStorageUsed'),
      value: formatBytes(storage.dataUsedBytes, lang),
      hint: formatCopy(t('storageFiles'), {
        files: formatStatNumber(storage.dataFileCount, lang),
        directories: formatStatNumber(storage.dataDirectoryCount, lang)
      })
    },
    {
      label: t('serverDiskUsed'),
      value: `${formatBytes(disk.usedBytes, lang)} · ${formatStatNumber(usedPercent, lang, { maximumFractionDigits: 1 })}%`,
      hint: t('storageStatusHint')
    },
    {
      label: t('serverDiskFree'),
      value: formatBytes(disk.availableBytes || disk.freeBytes, lang),
      hint: t('serverDiskFree')
    },
    {
      label: t('serverDiskTotal'),
      value: formatBytes(disk.totalBytes, lang),
      hint: t('serverDiskTotal')
    }
  ];
  return (
    <section className="tool-panel system-settings-panel storage-panel">
      <div className="section-heading span-2">
        <div>
          <h2>{t('storageStatus')}</h2>
          <p>{t('storageStatusHint')}</p>
        </div>
      </div>
      <div className="storage-meter span-2" aria-label={t('serverDiskUsed')}>
        <span style={{ width: `${usedPercent}%` }} />
      </div>
      <div className="storage-status-grid span-2">
        {cards.map((card) => (
          <div className="storage-status-card" key={card.label}>
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.hint}</small>
          </div>
        ))}
      </div>
      <InfoGrid className="span-2 system-settings-info" items={[
        [t('storageDataPath'), storage.dataDir || '-'],
        [t('storageCheckedAt'), formatTime(storage.checkedAt, lang) || '-']
      ]} />
    </section>
  );
}

function effectiveProxyInputValue(proxy = {}) {
  return proxy.url || proxy.battlemetrics?.url || proxy.kda?.url || '';
}

function thirdPartyLoginFormFromPayload(payload = null) {
  return {
    steamEnabled: payload?.steam?.enabled !== false,
    kookEnabled: Boolean(payload?.kook?.enabled),
    kookDefaultRole: payload?.kook?.defaultRole || 'member',
    discordEnabled: Boolean(payload?.discord?.enabled),
    wechatEnabled: Boolean(payload?.wechat?.enabled)
  };
}

function ThirdPartyLoginSettingsPanel({ lang, setToast, t, canEdit = false }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState(() => thirdPartyLoginFormFromPayload(null));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const payload = await api('/api/settings/third-party-login');
      setSettings(payload.thirdPartyLogin || null);
      setForm(thirdPartyLoginFormFromPayload(payload.thirdPartyLogin || null));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  async function save(event) {
    event.preventDefault();
    if (!canEdit || saving) return;
    setSaving(true);
    setError('');
    try {
      const payload = await api('/api/settings/third-party-login', {
        method: 'PUT',
        body: {
          steam: {
            enabled: form.steamEnabled
          },
          discord: { enabled: form.discordEnabled },
          kook: { enabled: form.kookEnabled, defaultRole: form.kookDefaultRole },
          wechat: { enabled: form.wechatEnabled }
        }
      });
      setSettings(payload.thirdPartyLogin || null);
      setForm(thirdPartyLoginFormFromPayload(payload.thirdPartyLogin || null));
      setToast(t('thirdPartyLoginSaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="tool-panel public-api-panel system-settings-panel third-party-login-settings-panel" onSubmit={save}>
      <div className="section-heading span-2">
        <div>
          <h2>{t('thirdPartyLoginSettings')}</h2>
          <p>{t('thirdPartyLoginSettingsHint')}</p>
        </div>
        <button type="button" className="ghost-button fit-button" disabled={loading} onClick={load}>
          <RefreshCw size={17} />
          <span>{t('refresh')}</span>
        </button>
      </div>
      {error && <Alert tone="danger" className="span-2">{error}</Alert>}
      <div className="third-party-platform-list span-2">
        <div className="third-party-platform-card active">
          <div>
            <strong>{t('platformSteam')}</strong>
            <small>{t('currentDevelopment')}</small>
          </div>
          <label className="switch-row">
            <input type="checkbox" checked={form.steamEnabled} onChange={(event) => setForm((current) => ({ ...current, steamEnabled: event.target.checked }))} disabled={!canEdit} />
            <span>{t('steamLoginEnabled')}</span>
          </label>
        </div>
        <div className="third-party-platform-card">
          <div>
            <strong>{t('platformDiscord')}</strong>
            <small>{settings?.discord?.configured ? t('currentDevelopment') : t('discordLoginNotConfigured')}</small>
          </div>
          <label className="switch-row">
            <input type="checkbox" checked={form.discordEnabled} onChange={(event) => setForm((current) => ({ ...current, discordEnabled: event.target.checked }))} disabled={!canEdit} />
            <span>{t('discordLoginEnabled')}</span>
          </label>
        </div>
        <div className="third-party-platform-card kook-login-settings-card">
          <div>
            <strong>KOOK</strong>
            <small>{settings?.kook?.configured ? t('currentDevelopment') : t('kookLoginNotConfigured')}</small>
          </div>
          <label className="switch-row">
            <input type="checkbox" checked={form.kookEnabled} onChange={(event) => setForm((current) => ({ ...current, kookEnabled: event.target.checked }))} disabled={!canEdit} />
            <span>{t('kookLoginEnabled')}</span>
          </label>
          <label>
            <span>{t('kookDefaultRole')}</span>
            <select value={form.kookDefaultRole} disabled={!canEdit || loading || saving} onChange={(event) => setForm((current) => ({ ...current, kookDefaultRole: event.target.value }))}>
              {!(settings?.kook?.roleOptions || []).some((role) => role.code === form.kookDefaultRole) && <option value={form.kookDefaultRole}>{roleOptionLabel({ code: form.kookDefaultRole }, t)}</option>}
              {(settings?.kook?.roleOptions || []).map((role) => <option key={role.code} value={role.code}>{roleOptionLabel(role, t)}</option>)}
            </select>
            <small>{t('kookDefaultRoleHint')}</small>
          </label>
        </div>
        <div className="third-party-platform-card">
          <div>
            <strong>{t('platformWechat')}</strong>
            <small>{t('plannedPlatform')}</small>
          </div>
        </div>
      </div>
      <p className="form-hint span-2">{t('steamAdminFromAccountsHint')}</p>
      <InfoGrid className="span-2 system-settings-info" items={[
        [t('steamLogin'), settings?.steam?.enabled === false ? t('publicApiDisabled') : t('publicApiEnabled')],
        [t('platformDiscord'), settings?.discord?.enabled ? t('publicApiEnabled') : t('publicApiDisabled')],
        ['KOOK', settings?.kook?.enabled ? t('publicApiEnabled') : t('publicApiDisabled')],
        [t('apiKeyUpdatedAt'), formatTime(latestTimestamp([settings?.steam?.updatedAt, settings?.discord?.updatedAt, settings?.kook?.updatedAt]), lang) || '-']
      ]} />
      <div className="api-token-actions span-2">
        <button className="primary-button" disabled={!canEdit || saving} title={t('save')}>
          <Save size={17} />
          <span>{saving ? t('saving') : t('save')}</span>
        </button>
      </div>
    </form>
  );
}

export default function SystemSettingsView({ lang, setToast, systemSettings, onSystemUpdated, t, canEdit = false, canEditProxy = canEdit, canEditBranding = canEdit }) {
  const fallbackSettings = { teamLogoUrl: '', proxy: { scope: 'global', url: '' } };
  const [settings, setSettings] = useState(systemSettings || fallbackSettings);
  const [form, setForm] = useState({
    proxyUrl: effectiveProxyInputValue(systemSettings?.proxy),
    proxyScope: systemSettings?.proxy?.savedScope || systemSettings?.proxy?.scope || 'global',
    teamLogoUrl: systemSettings?.teamLogoUrl || ''
  });
  const [savingProxy, setSavingProxy] = useState(false);
  const [savingLogo, setSavingLogo] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  function applySettings(nextSettings) {
    const normalized = nextSettings || fallbackSettings;
    setSettings(normalized);
    setForm({
      proxyUrl: effectiveProxyInputValue(normalized.proxy),
      proxyScope: normalized.proxy?.savedScope || normalized.proxy?.scope || 'global',
      teamLogoUrl: normalized.teamLogoUrl || ''
    });
    onSystemUpdated(normalized);
  }

  async function load() {
    setLoading(true);
    try {
      const payload = await api('/api/settings/system');
      applySettings(payload.system);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch((err) => setError(localizeError(err.message, t)));
  }, []);

  async function saveProxySettings(event) {
    event.preventDefault();
    if (!canEditProxy) return;
    setSavingProxy(true);
    setError('');
    try {
      const payload = await api('/api/settings/system', {
        method: 'PUT',
        body: {
          proxyUrl: form.proxyUrl,
          proxyScope: form.proxyScope,
          teamLogoUrl: settings.teamLogoUrl || ''
        }
      });
      applySettings(payload.system);
      setToast(t('proxySettingsSaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSavingProxy(false);
    }
  }

  async function saveBrandingSettings(event) {
    event.preventDefault();
    if (!canEditBranding) return;
    setSavingLogo(true);
    setError('');
    try {
      const payload = await api('/api/settings/system', {
        method: 'PUT',
        body: {
          proxyUrl: form.proxyUrl,
          proxyScope: settings.proxy?.savedScope || settings.proxy?.scope || 'global',
          teamLogoUrl: form.teamLogoUrl
        }
      });
      applySettings(payload.system);
      setToast(t('teamLogoSaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSavingLogo(false);
    }
  }

  async function resetBrandingSettings() {
    if (!canEditBranding) return;
    setSavingLogo(true);
    setError('');
    try {
      const payload = await api('/api/settings/system', {
        method: 'PUT',
        body: {
          proxyUrl: form.proxyUrl,
          proxyScope: settings.proxy?.savedScope || settings.proxy?.scope || 'global',
          teamLogoUrl: ''
        }
      });
      applySettings(payload.system);
      setToast(t('teamLogoReset'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSavingLogo(false);
    }
  }

  async function uploadTeamLogo(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !canEditBranding) return;
    setUploadingLogo(true);
    setError('');
    try {
      const dataUrl = await fileToDataUrl(file);
      const payload = await api('/api/settings/system/team-logo', {
        method: 'POST',
        body: { originalName: file.name, mimeType: file.type, dataUrl }
      });
      applySettings(payload.system);
      setToast(t('teamLogoUploaded'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setUploadingLogo(false);
    }
  }

  if (loading) {
    return (
      <section className="page-stack">
        <PageLoadingState title={t('systemSettings')} t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack">
      <div className="section-heading">
        <h3>{t('systemSettings')}</h3>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <form className="tool-panel public-api-panel system-settings-panel" onSubmit={saveBrandingSettings}>
        <div className="section-heading span-2 system-branding-heading">
          <div>
            <h2>{t('teamBranding')}</h2>
            <p>{t('adminOnlySetting')}</p>
          </div>
          <div className="team-logo-preview">
            <BrandMark logoUrl={form.teamLogoUrl} />
          </div>
        </div>
        <label className="span-2">
          <span>{t('teamLogoUrl')}</span>
          <input
            value={form.teamLogoUrl}
            onChange={(event) => setForm((current) => ({ ...current, teamLogoUrl: event.target.value }))}
            maxLength={2048}
            placeholder={t('teamLogoUrlPlaceholder')}
            autoComplete="off"
            disabled={!canEditBranding}
          />
        </label>
        <InfoGrid className="span-2 system-settings-info" items={[
          [t('teamLogoUpdatedAt'), formatTime(settings.teamLogoUpdatedAt, lang) || t('publicApiDisabled')]
        ]} />
        <div className="api-token-actions span-2">
          <label className={cx('file-button ghost-button', (!canEditBranding || uploadingLogo) && 'disabled')} title={t('uploadLogo')}>
            <ImagePlus size={17} />
            <span>{uploadingLogo ? t('uploading') : t('uploadLogoShort')}</span>
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadTeamLogo} disabled={!canEditBranding || uploadingLogo} />
          </label>
          <button className="primary-button" disabled={!canEditBranding || savingLogo} title={t('saveLogo')}>
            <Save size={17} />
            <span>{savingLogo ? t('saving') : t('saveLogo')}</span>
          </button>
          <button
            type="button"
            className="ghost-button"
            disabled={!canEditBranding || savingLogo || uploadingLogo || (!settings.teamLogoUrl && !form.teamLogoUrl)}
            title={t('resetLogo')}
            onClick={resetBrandingSettings}
          >
            <RefreshCw size={17} />
            <span>{t('resetLogo')}</span>
          </button>
        </div>
      </form>

      <StorageStatusPanel storage={settings.storage} lang={lang} t={t} />

      {canEditBranding && (
        <ThirdPartyLoginSettingsPanel lang={lang} setToast={setToast} t={t} canEdit={canEditBranding} />
      )}

      <form className="tool-panel public-api-panel system-settings-panel" onSubmit={saveProxySettings}>
        <div className="section-heading span-2">
          <div>
            <h2>{t('proxySettings')}</h2>
            <p>{t('rootOnlySetting')}</p>
          </div>
          <span className={cx('status-badge', settings.proxy?.enabled && 'active')}>
            {settings.proxy?.enabled ? t('publicApiEnabled') : t('publicApiDisabled')}
          </span>
        </div>
        <label className="span-2">
          <span>{t('proxyUrl')}</span>
          <input
            value={form.proxyUrl}
            onChange={(event) => setForm((current) => ({ ...current, proxyUrl: event.target.value }))}
            maxLength={2048}
            placeholder={t('proxyUrlPlaceholder')}
            autoComplete="off"
            disabled={!canEditProxy}
          />
        </label>
        <label>
          <span>{t('proxyScope')}</span>
          <select value={form.proxyScope} onChange={(event) => setForm((current) => ({ ...current, proxyScope: event.target.value }))} disabled={!canEditProxy}>
            <option value="global">{t('proxyScopeGlobal')}</option>
            <option value="battlemetrics">{t('proxyScopeBattlemetrics')}</option>
            <option value="kda">{t('proxyScopeKda')}</option>
          </select>
        </label>
        <div className="api-token-actions align-end">
          <button className="primary-button" disabled={!canEditProxy || savingProxy} title={t('saveProxy')}>
            <Save size={17} />
            <span>{savingProxy ? t('saving') : t('saveProxy')}</span>
          </button>
        </div>
        <ProxyStatusGrid proxy={settings.proxy} t={t} />
      </form>
    </section>
  );
}
