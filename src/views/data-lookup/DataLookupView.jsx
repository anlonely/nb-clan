import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Database, ExternalLink, Search, Server } from 'lucide-react';
import { api } from '../../shared/api.js';
import { copyText } from '../../shared/browser.js';
import { formatCurrencyValue, useCurrencyContext } from '../../shared/currency.js';
import {
  OFFICIAL_KDA_EXTRA_GROUP_ORDER,
  OFFICIAL_KDA_ITEM_LABELS,
  OFFICIAL_KDA_METRICS,
  OFFICIAL_KDA_SECTION_LABELS,
  OFFICIAL_KDA_SUMMARY_GROUPS,
  OFFICIAL_KDA_UNSUPPORTED_RESOURCE_KEYS,
  officialKdaExtraGroupIdForKey,
  officialKdaExtraGroupTitle,
  VITAL_LOOKUP_GROUPS
} from '../../shared/data-lookup/labels.js';
import { formatOfficialKdaMetric } from '../../shared/data-lookup/official-kda.jsx';
import {
  formatCompactResource,
  formatDateTimeWithYear,
  formatPlayTimeMinutes,
  formatStatNumber,
  formatTime,
  localizeError
} from '../../shared/format.js';
import {
  SteamBanStatusMetricCard,
  steamBanYesNoText
} from '../../shared/member/steam-ban.jsx';
import { canViewModule } from '../../shared/permissions.js';
import { Avatar } from '../../shared/member/Avatar.jsx';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { InfoGrid } from '../../shared/ui/InfoGrid.jsx';
import { MetricCard } from '../../shared/ui/MetricCard.jsx';
import { cx } from '../../shared/ui/cx.js';

function rustKdaDisplayName(item, lang = 'zh') {
  return lang === 'zh'
    ? item?.nameCN || item?.name || '-'
    : item?.name || item?.nameCN || '-';
}

function RustKdaLookupForm({ steamInput, onSteamInputChange, loading, onSubmit, t }) {
  return (
    <form className="tool-panel rust-kda-query-panel" onSubmit={onSubmit}>
      <label className="rust-kda-input-field">
        <span>{t('steamId')}</span>
        <input
          value={steamInput}
          onChange={(event) => onSteamInputChange(event.target.value)}
          placeholder={t('steamPlaceholder')}
          autoComplete="off"
        />
      </label>
      <button className="primary-button align-end" title={t('querySteamAccount')} disabled={loading || !steamInput.trim()}>
        <Search size={17} />
        <span>{loading ? t('loading') : t('queryShort')}</span>
      </button>
    </form>
  );
}

function RustKdaPlayerSummary({ result, lang, t, setToast }) {
  if (!result?.player) return null;
  const player = result.player;
  const member = result.member;
  return (
    <section className="tool-panel rust-kda-player-panel">
      <div className="rust-kda-player-main">
        <Avatar member={{ avatar: player.avatar, steamNickname: player.displayName, customName: player.displayName }} />
        <div className="rust-kda-player-lines">
          <strong>{player.displayName || player.steamId}</strong>
          <button
            type="button"
            className="steam-copy-line mono"
            title={t('copy')}
            onClick={() => copyText(player.steamId, setToast, t)}
          >
            {player.steamId}
          </button>
          <div className="rust-kda-chip-row">
            <span className={cx('status-badge', member ? 'active' : 'pending')}>
              {member ? t('linkedMember') : t('notLinkedMember')}
            </span>
            {member && (
              <span className={cx('status-badge', member.squadName ? 'active' : 'muted')}>
                {member.squadName || t('unassignedSquad')}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="rust-kda-player-actions">
        <a className="ghost-button" title={t('steamProfileLink')} href={player.profileUrl} target="_blank" rel="noreferrer">
          <ExternalLink size={16} />
          <span>{t('steamProfileLink')}</span>
        </a>
        {result.externalUrl && (
          <a className="ghost-button" title={t('openRustKda')} href={result.externalUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={16} />
            <span>{result.source === 'Moose.GG' ? t('openMooseStats') : t('openRustKda')}</span>
          </a>
        )}
      </div>
      <InfoGrid items={[
        [t('steamHours'), player.playTimeKnown ? formatPlayTimeMinutes(player.playTimeMinutes, lang) : '-'],
        [t('achievementsCount'), player.achievementsCount ?? '-'],
        [t('accountCreatedAt'), formatDateTimeWithYear(player.createdAt, lang) || '-'],
        [t('externalSource'), result.source || '-'],
        [t('fetchedAt'), formatTime(result.fetchedAt, lang) || '-']
      ]} />
    </section>
  );
}

function accountRestrictionStatusText(account = {}, t) {
  if (account.accountRestrictionCheckedAt) {
    return account.accountRestricted
      ? account.accountRestrictionStatus || t('steamAccountRestricted')
      : t('steamAccountNormal');
  }
  return account.accountRestrictionError || t('notSyncedYet');
}

function OfficialSteamAccountStatus({ account, lang, t }) {
  if (!account) return null;
  const accountErrors = [account.accountRestrictionError, account.steamBanError].filter(Boolean);
  return (
    <section className="tool-panel official-account-status-panel">
      <div className="section-heading compact-heading">
        <div>
          <h3>{t('steamAccountStatusTitle')}</h3>
          <small>{t('steamAccountStatusHint')}</small>
        </div>
      </div>
      <div className="profile-metric-grid query-profile-metric-grid official-account-status-grid">
        <MetricCard label={t('steamAccountRestrictionStatus')} value={accountRestrictionStatusText(account, t)} />
        <SteamBanStatusMetricCard stats={account} lang={lang} t={t} />
        <MetricCard label={t('communityBanStatus')} value={steamBanYesNoText(account.communityBanned, account, t)} />
        <MetricCard label={t('economyBanStatus')} value={steamBanYesNoText(account.economyRestricted, account, t)} />
        <MetricCard label={t('steamAccountRestrictionCheckedAt')} value={formatTime(account.accountRestrictionCheckedAt, lang) || t('notSyncedYet')} />
        <MetricCard label={t('steamBanCheckedAt')} value={formatTime(account.steamBanCheckedAt, lang) || t('notSyncedYet')} />
      </div>
      {accountErrors.length ? (
        <Alert tone="warning" className="official-account-status-alert">
          {accountErrors.join('；')}
        </Alert>
      ) : null}
    </section>
  );
}

function LookupMetricGroupSections({ title, hint = '', groups = [] }) {
  const visibleGroups = groups.filter((group) => Array.isArray(group.items) && group.items.length);
  if (!visibleGroups.length) return null;
  return (
    <section className="tool-panel vital-stat-panel lookup-stat-panel">
      <div className="section-heading compact-heading">
        <div>
          <h3>{title}</h3>
          {hint && <small>{hint}</small>}
        </div>
      </div>
      <div className="lookup-stat-group-stack">
        {visibleGroups.map((group) => (
          <section key={group.id || group.title} className="lookup-stat-group-card">
            <div className="lookup-stat-group-head">
              <h4>{group.title}</h4>
              {group.subtitle && <small>{group.subtitle}</small>}
            </div>
            <div className="lookup-kda-grid compact-metrics vital-stat-grid">
              {group.items.map((item) => (
                <div key={item.id || item.label} className={cx(item.accent && 'accent')}>
                  <span>{item.label}</span>
                  <strong>{item.value}</strong>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function officialKdaSectionTitle(section, lang = 'zh') {
  const id = String(section?.id || '').trim();
  const dictionary = OFFICIAL_KDA_SECTION_LABELS[lang] || OFFICIAL_KDA_SECTION_LABELS.en || {};
  const fallbackDictionary = OFFICIAL_KDA_SECTION_LABELS.en || {};
  return dictionary[id] || fallbackDictionary[id] || section?.title || id || '';
}

function officialKdaMetricLabelCandidates(id = '') {
  const raw = String(id || '').trim();
  const withoutPrefixes = raw.replace(/^(?:raw|rawStats|raw_stats|statistics|stats|data|result|player)\./i, '');
  const lastPart = withoutPrefixes.split('.').filter(Boolean).pop() || '';
  return [...new Set([raw, withoutPrefixes, lastPart].filter(Boolean))];
}

function officialKdaItemLabel(item, lang = 'zh') {
  const id = String(item?.id || '').trim();
  const dictionary = OFFICIAL_KDA_ITEM_LABELS[lang] || OFFICIAL_KDA_ITEM_LABELS.en || {};
  const fallbackDictionary = OFFICIAL_KDA_ITEM_LABELS.en || {};
  for (const key of officialKdaMetricLabelCandidates(id)) {
    if (dictionary[key]) return dictionary[key];
    if (fallbackDictionary[key]) return fallbackDictionary[key];
  }
  return item?.label || id || '';
}

function isUnsupportedOfficialKdaResourceKey(key = '') {
  const normalized = String(key || '').trim();
  const lastPart = normalized.split('.').pop();
  return OFFICIAL_KDA_UNSUPPORTED_RESOURCE_KEYS.has(normalized)
    || OFFICIAL_KDA_UNSUPPORTED_RESOURCE_KEYS.has(lastPart)
    || normalized.toLowerCase().includes('sulfur');
}

function officialKdaMetricDefinition(key) {
  return OFFICIAL_KDA_METRICS.find((metric) => metric.key === key) || null;
}

function officialKdaSummaryGroups(kda, lang, t) {
  return OFFICIAL_KDA_SUMMARY_GROUPS.map((group) => ({
    id: group.id,
    title: t(group.titleKey),
    items: group.metricKeys
      .map((key) => officialKdaMetricDefinition(key))
      .filter(Boolean)
      .map((metric, index) => ({
        id: metric.key,
        label: t(metric.labelKey),
        value: formatOfficialKdaMetric(metric.key, kda?.[metric.key], lang),
        accent: group.id === 'combat' && index === 0
      }))
  }));
}

function officialKdaSectionGroups(sections = [], lang = 'zh') {
  return sections.map((section) => ({
    id: section.id || section.title,
    title: officialKdaSectionTitle(section, lang),
    items: (section.items || [])
      .filter((item) => !isUnsupportedOfficialKdaResourceKey(item.id))
      .map((item) => ({
        id: item.id || item.label,
        label: officialKdaItemLabel(item, lang),
        value: formatStatNumber(item.value, lang, { maximumFractionDigits: 2 })
      }))
  })).filter((group) => group.items.length);
}

function OfficialKdaSections({ sections = [], lang, t }) {
  const groups = officialKdaSectionGroups(sections, lang);
  return (
    <LookupMetricGroupSections
      title={t('officialKdaDetail')}
      hint={t('officialKdaDetailHint')}
      groups={groups}
    />
  );
}

function formatOfficialKdaMetricRows(kda, lang) {
  return (kda?.metrics || [])
    .filter((item) => !OFFICIAL_KDA_METRICS.some((metric) => String(item.key || '').endsWith(metric.key)))
    .filter((item) => !isUnsupportedOfficialKdaResourceKey(item.key))
    .map((metric) => ({
      ...metric,
      valueText: formatStatNumber(metric.value, lang, { maximumFractionDigits: 2 })
    }));
}

function officialKdaExtraGroups(rows = [], lang = 'zh') {
  if (!rows.length) return [];
  const groupedRows = new Map();
  for (const metric of rows) {
    const groupId = officialKdaExtraGroupIdForKey(metric.key);
    if (!groupedRows.has(groupId)) groupedRows.set(groupId, []);
    groupedRows.get(groupId).push(metric);
  }
  return [...groupedRows.entries()]
    .map(([groupId, metrics]) => ({
      id: `extra:${groupId}`,
      title: officialKdaExtraGroupTitle(groupId, lang),
      items: metrics.map((metric) => ({
        id: metric.key,
        label: officialKdaItemLabel({ id: metric.key, label: metric.label }, lang),
        value: metric.valueText
      }))
    }))
    .sort((left, right) => {
      const leftGroupId = left.id.replace('extra:', '');
      const rightGroupId = right.id.replace('extra:', '');
      const leftIndex = OFFICIAL_KDA_EXTRA_GROUP_ORDER.indexOf(leftGroupId);
      const rightIndex = OFFICIAL_KDA_EXTRA_GROUP_ORDER.indexOf(rightGroupId);
      const leftSortIndex = leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex;
      const rightSortIndex = rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex;
      return leftSortIndex - rightSortIndex;
    });
}

function OfficialKdaMetricGroups({ rows = [], t, lang }) {
  const groups = officialKdaExtraGroups(rows, lang);
  if (!groups.length) return null;
  return (
    <LookupMetricGroupSections
      title={t('extraMetrics')}
      hint={t('officialKdaExtraHint')}
      groups={groups}
    />
  );
}

function OfficialKdaView({ lang, t, setToast, lookupRequest = null }) {
  const [steamInput, setSteamInput] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function queryOfficialKda(nextSteamInput) {
    const query = String(nextSteamInput || '').trim();
    if (!query) return;
    setSteamInput(query);
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ steamInput: query });
      const payload = await api(`/api/rust-kda/official?${params}`);
      setResult(payload);
    } catch (err) {
      setResult(null);
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (loading) return;
    queryOfficialKda(steamInput);
  }

  useEffect(() => {
    if (!lookupRequest?.steamInput) return;
    queryOfficialKda(lookupRequest.steamInput);
  }, [lookupRequest?.id]);

  const kda = result?.kda;
  const kdaSections = Array.isArray(kda?.sections) ? kda.sections : [];
  const metricRows = useMemo(() => formatOfficialKdaMetricRows(kda, lang), [kda, lang]);

  return (
    <section className="page-stack rust-kda-page">
      <RustKdaLookupForm
        steamInput={steamInput}
        onSteamInputChange={setSteamInput}
        loading={loading}
        onSubmit={submit}
        t={t}
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {!result && !error && <div className="empty-state">{t('officialKdaEmpty')}</div>}
      {result && <RustKdaPlayerSummary result={result} lang={lang} t={t} setToast={setToast} />}
      {result && <OfficialSteamAccountStatus account={result.account} lang={lang} t={t} />}
      {result && !kda && !error && <div className="empty-state compact">{t('officialKdaNoData')}</div>}
      {kda && (
        <>
          <LookupMetricGroupSections
            title={t('officialKdaOverview')}
            hint={t('officialKdaOverviewHint')}
            groups={officialKdaSummaryGroups(kda, lang, t)}
          />
          {kdaSections.length ? <OfficialKdaSections sections={kdaSections} lang={lang} t={t} /> : null}
          <OfficialKdaMetricGroups rows={metricRows} t={t} lang={lang} />
        </>
      )}
    </section>
  );
}

function InventoryDetailsView({ lang, t, setToast, lookupRequest = null }) {
  const [steamInput, setSteamInput] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const currencyContext = useCurrencyContext(lang);

  async function queryInventoryDetails(nextSteamInput) {
    const query = String(nextSteamInput || '').trim();
    if (!query) return;
    setSteamInput(query);
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ steamInput: query });
      const payload = await api(`/api/rust-kda/inventory?${params}`);
      setResult(payload);
    } catch (err) {
      setResult(null);
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (loading) return;
    queryInventoryDetails(steamInput);
  }

  useEffect(() => {
    if (!lookupRequest?.steamInput) return;
    queryInventoryDetails(lookupRequest.steamInput);
  }, [lookupRequest?.id]);

  const inventory = result?.inventory;
  const total = inventory?.totalSummary || {};
  const skins = inventory?.skinsSummary || {};
  const store = inventory?.storeSummary || {};

  return (
    <section className="page-stack rust-kda-page">
      <RustKdaLookupForm
        steamInput={steamInput}
        onSteamInputChange={setSteamInput}
        loading={loading}
        onSubmit={submit}
        t={t}
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {!result && !error && <div className="empty-state">{t('inventoryDetailsEmpty')}</div>}
      {result && <RustKdaPlayerSummary result={result} lang={lang} t={t} setToast={setToast} />}
      {result?.errors?.inventory && <Alert tone="danger">{t('inventoryUnavailable')}：{result.errors.inventory}</Alert>}
      {inventory && (
        <>
          <div className="rust-kda-metric-grid">
            <MetricCard label={t('totalAssetValue')} value={formatCurrencyValue(total.totalValue, inventory.currency, lang, currencyContext)} />
            <MetricCard label={t('tradableValue')} value={formatCurrencyValue(total.tradableValue, inventory.currency, lang, currencyContext)} />
            <MetricCard label={t('skinsValue')} value={formatCurrencyValue(total.skinsValue, inventory.currency, lang, currencyContext)} />
            <MetricCard label={t('storeOwnedValue')} value={formatCurrencyValue(store.ownedValue, inventory.currency, lang, currencyContext)} />
            <MetricCard label={t('skinItems')} value={`${formatStatNumber(skins.totalItems || 0, lang)} / ${formatStatNumber(skins.distinctItems || 0, lang)}`} />
            <MetricCard label={t('storeItems')} value={formatStatNumber(store.ownedCount || 0, lang)} />
          </div>
          {inventory.errors?.skins && <Alert>{t('inventoryUnavailable')}：{inventory.errors.skins}</Alert>}
          {inventory.errors?.store && <Alert>{t('storeUnavailable')}：{inventory.errors.store}</Alert>}
          {inventory.errors?.dlc && <Alert>{t('dlcUnavailable')}：{inventory.errors.dlc}</Alert>}
          <section className="page-stack">
            <div className="section-heading">
              <h3>{t('skinItems')}</h3>
            </div>
            <DataTable className="inventory-table" columns={[t('inventoryItem'), t('itemType'), t('quantity'), t('estimatedValue'), t('source')]} emptyText={t('noInventoryItems')}>
              {(inventory.skins || []).map((item) => (
                <tr key={item.id || item.name}>
                  <td><InventoryItemName item={item} lang={lang} /></td>
                  <td>{item.type || item.rarity || '-'}</td>
                  <td>{formatStatNumber(item.quantity || 1, lang)}</td>
                  <td>{item.price !== null && item.price !== undefined ? formatCurrencyValue(item.price, inventory.currency, lang, currencyContext) : item.priceText || '-'}</td>
                  <td>{item.source || item.priceSource || '-'}</td>
                </tr>
              ))}
            </DataTable>
          </section>
          <section className="page-stack">
            <div className="section-heading">
              <h3>{t('storeItems')}</h3>
            </div>
            <DataTable className="inventory-table" columns={[t('inventoryItem'), t('itemType'), t('estimatedValue'), t('source')]} emptyText={t('noStoreItems')}>
              {(inventory.storeItems || []).map((item) => (
                <tr key={item.id || item.name}>
                  <td><InventoryItemName item={item} lang={lang} /></td>
                  <td>{item.category || '-'}</td>
                  <td>{item.priceValue !== null && item.priceValue !== undefined ? formatCurrencyValue(item.priceValue, inventory.currency, lang, currencyContext) : item.priceText || '-'}</td>
                  <td>{item.scmmAvailable ? 'SCMM' : item.source || '-'}</td>
                </tr>
              ))}
            </DataTable>
          </section>
          <section className="page-stack">
            <div className="section-heading">
              <h3>{t('dlcItems')}</h3>
            </div>
            <DataTable className="inventory-table" columns={[t('inventoryItem'), t('ownedState'), t('estimatedValue')]} emptyText={t('noDlcItems')}>
              {(inventory.dlcs || []).map((item) => (
                <tr key={item.id || item.name}>
                  <td><InventoryItemName item={item} lang={lang} /></td>
                  <td>{item.owned === true ? t('owned') : item.owned === false ? t('notOwned') : t('unknown')}</td>
                  <td>{item.priceValue !== null && item.priceValue !== undefined ? formatCurrencyValue(item.priceValue, inventory.currency, lang, currencyContext) : item.priceText || '-'}</td>
                </tr>
              ))}
            </DataTable>
          </section>
        </>
      )}
    </section>
  );
}

function DataLookupView({ user, lang, t, setToast, lookupRequest = null }) {
  const tabs = useMemo(() => [
    ...(canViewModule(user, 'officialKda') ? [{ id: 'officialKda', label: t('dataLookupOfficialTab'), icon: BarChart3 }] : []),
    ...(canViewModule(user, 'inventoryDetails') ? [{ id: 'inventoryDetails', label: t('dataLookupInventoryTab'), icon: Database }] : []),
    ...(canViewModule(user, 'officialKda') ? [{ id: 'vital', label: t('dataLookupVitalTab'), icon: Activity }] : []),
    ...(canViewModule(user, 'officialKda') ? [{ id: 'moose', label: t('dataLookupMooseTab'), icon: Server }] : [])
  ], [t, user]);
  const [activeTab, setActiveTab] = useState(tabs[0]?.id || 'officialKda');

  useEffect(() => {
    if (tabs.some((tab) => tab.id === activeTab)) return;
    setActiveTab(tabs[0]?.id || 'officialKda');
  }, [activeTab, tabs]);

  useEffect(() => {
    if (!lookupRequest?.target) return;
    if (!tabs.some((tab) => tab.id === lookupRequest.target)) return;
    setActiveTab(lookupRequest.target);
  }, [lookupRequest?.id, lookupRequest?.target, tabs]);

  if (!tabs.length) return <div className="empty-state">{t('noPermission')}</div>;

  return (
    <section className="page-stack data-lookup-page">
      <div className="data-lookup-tabs" role="tablist" aria-label={t('navDataLookup')}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              className={cx('data-lookup-tab', selected && 'active')}
              role="tab"
              aria-selected={selected}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={18} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
      {activeTab === 'officialKda' && (
        <OfficialKdaView
          lang={lang}
          t={t}
          setToast={setToast}
          lookupRequest={lookupRequest?.target === 'officialKda' ? lookupRequest : null}
        />
      )}
      {activeTab === 'inventoryDetails' && (
        <InventoryDetailsView
          lang={lang}
          t={t}
          setToast={setToast}
          lookupRequest={lookupRequest?.target === 'inventoryDetails' ? lookupRequest : null}
        />
      )}
      {activeTab === 'vital' && (
        <VitalLookupView
          lang={lang}
          t={t}
          setToast={setToast}
          lookupRequest={lookupRequest?.target === 'vital' ? lookupRequest : null}
        />
      )}
      {activeTab === 'moose' && (
        <MooseLookupView
          lang={lang}
          t={t}
          setToast={setToast}
          lookupRequest={lookupRequest?.target === 'moose' ? lookupRequest : null}
        />
      )}
    </section>
  );
}

function mooseDisplayText(item, lang = 'zh') {
  if (!item) return '';
  return lang === 'zh' ? (item.nameZh || item.name || item.id) : (item.name || item.nameZh || item.id);
}

function MooseLookupView({ lang, t, setToast, lookupRequest = null }) {
  const [steamInput, setSteamInput] = useState('');
  const [servers, setServers] = useState([]);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [periods, setPeriods] = useState([]);
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [periodLoading, setPeriodLoading] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadServers() {
      setCatalogLoading(true);
      setCatalogError('');
      try {
        const payload = await api('/api/moose/servers');
        if (cancelled) return;
        const nextServers = Array.isArray(payload.servers) ? payload.servers : [];
        setServers(nextServers);
        setSelectedServerId((current) => (
          nextServers.some((server) => server.id === current) ? current : (nextServers[0]?.id || '')
        ));
      } catch (err) {
        if (!cancelled) setCatalogError(localizeError(err.message, t) || t('mooseLookupLoadFailed'));
      } finally {
        if (!cancelled) setCatalogLoading(false);
      }
    }
    loadServers();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!selectedServerId) {
      setPeriods([]);
      setSelectedPeriod('');
      return undefined;
    }
    let cancelled = false;
    async function loadPeriods() {
      setPeriodLoading(true);
      setCatalogError('');
      try {
        const payload = await api(`/api/moose/servers/${encodeURIComponent(selectedServerId)}/periods`);
        if (cancelled) return;
        const nextPeriods = Array.isArray(payload.periods) ? payload.periods : [];
        setPeriods(nextPeriods);
        setSelectedPeriod((current) => {
          if (nextPeriods.some((period) => period.name === current)) return current;
          return (nextPeriods.find((period) => period.active) || nextPeriods[0])?.name || '';
        });
      } catch (err) {
        if (!cancelled) {
          setPeriods([]);
          setSelectedPeriod('');
          setCatalogError(localizeError(err.message, t) || t('mooseLookupPeriodsFailed'));
        }
      } finally {
        if (!cancelled) setPeriodLoading(false);
      }
    }
    loadPeriods();
    return () => {
      cancelled = true;
    };
  }, [selectedServerId, t]);

  useEffect(() => {
    const requestedServerId = String(lookupRequest?.serverId || '').trim();
    if (requestedServerId && servers.some((server) => server.id === requestedServerId)) setSelectedServerId(requestedServerId);
  }, [lookupRequest?.id, lookupRequest?.serverId, servers]);

  useEffect(() => {
    const requestedPeriod = String(lookupRequest?.period || '').trim();
    if (requestedPeriod && periods.some((period) => period.name === requestedPeriod)) setSelectedPeriod(requestedPeriod);
  }, [lookupRequest?.id, lookupRequest?.period, periods]);

  useEffect(() => {
    setResult(null);
    setError('');
  }, [selectedServerId, selectedPeriod]);

  async function queryMoose(nextSteamInput) {
    const query = String(nextSteamInput || '').trim();
    if (!query || !selectedServerId || !selectedPeriod) return;
    setSteamInput(query);
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const payload = await api('/api/rust-kda/moose', {
        method: 'POST',
        body: {
          steamInput: query,
          serverId: selectedServerId,
          period: selectedPeriod
        }
      });
      setResult(payload);
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    void queryMoose(steamInput);
  }

  useEffect(() => {
    if (!lookupRequest?.id || !lookupRequest?.steamInput || !selectedServerId || !selectedPeriod) return;
    const requestedServerId = String(lookupRequest.serverId || '').trim();
    if (requestedServerId && requestedServerId !== selectedServerId) return;
    const requestedPeriod = String(lookupRequest.period || '').trim();
    if (requestedPeriod && requestedPeriod !== selectedPeriod) return;
    void queryMoose(lookupRequest.steamInput);
  }, [lookupRequest?.id, lookupRequest?.steamInput, lookupRequest?.serverId, lookupRequest?.period, selectedServerId, selectedPeriod]);

  const moose = result?.moose || null;
  const groups = (moose?.categories || [])
    .filter((entry) => entry?.selectedMatch)
    .map((entry) => ({
      id: entry.category?.id,
      title: mooseDisplayText(entry.category, lang),
      subtitle: entry.category?.name && entry.category?.name !== mooseDisplayText(entry.category, lang)
        ? entry.category.name
        : '',
      items: (entry.fields || []).map((field) => ({
        id: field.id,
        label: lang === 'zh' ? (field.labelZh || field.name || field.id) : (field.name || field.labelZh || field.id),
        value: entry.selectedMatch?.values?.[field.id] || '-'
      }))
    }));

  return (
    <section className="page-stack rust-kda-page">
      <form className="tool-panel rust-kda-query-panel moose-lookup-form" onSubmit={submit}>
        <label className="rust-kda-input-field">
          <span>{t('steamId')}</span>
          <input
            value={steamInput}
            onChange={(event) => setSteamInput(event.target.value)}
            placeholder={t('steamPlaceholder')}
            autoComplete="off"
          />
        </label>
        <label className="rust-kda-input-field">
          <span>{t('mooseLookupServer')}</span>
          <select
            value={selectedServerId}
            onChange={(event) => setSelectedServerId(event.target.value)}
            disabled={loading || catalogLoading || periodLoading || !servers.length}
          >
            <option value="">{catalogLoading ? t('loading') : t('mooseLookupServerPlaceholder')}</option>
            {servers.map((server) => (
              <option key={server.id} value={server.id}>{mooseDisplayText(server, lang)}</option>
            ))}
          </select>
        </label>
        <label className="rust-kda-input-field">
          <span>{t('mooseLookupPeriod')}</span>
          <select
            value={selectedPeriod}
            onChange={(event) => setSelectedPeriod(event.target.value)}
            disabled={loading || periodLoading || !periods.length}
          >
            <option value="">{periodLoading ? t('loading') : t('mooseLookupPeriodPlaceholder')}</option>
            {periods.map((period) => (
              <option key={period.id || period.name} value={period.name}>{mooseDisplayText(period, lang)}</option>
            ))}
          </select>
        </label>
        <button className="primary-button align-end" title={t('querySteamAccount')} disabled={loading || catalogLoading || periodLoading || !steamInput.trim() || !selectedServerId || !selectedPeriod}>
          <Search size={17} />
          <span>{loading ? t('loading') : t('queryShort')}</span>
        </button>
      </form>
      {catalogError && <Alert tone="danger">{catalogError}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {!result && !error && <div className="empty-state">{t('mooseLookupEmpty')}</div>}
      {result && <RustKdaPlayerSummary result={result} lang={lang} t={t} setToast={setToast} />}
      {moose && (
        <InfoGrid items={[
          [t('mooseLookupServer'), mooseDisplayText(moose.server, lang) || '-'],
          [t('mooseLookupPeriod'), mooseDisplayText(moose.period, lang) || '-'],
          [t('mooseMatchedCategories'), moose.matchedCategories ?? 0],
          [t('fetchedAt'), formatTime(result.fetchedAt, lang) || '-']
        ]} />
      )}
      {moose && !groups.length && <div className="empty-state compact">{t('mooseLookupNoData')}</div>}
      <LookupMetricGroupSections
        title={t('mooseLookupDetail')}
        hint={t('mooseLookupDetailHint')}
        groups={groups}
      />
    </section>
  );
}

function vitalLookupWipeOptions(server = null) {
  return (server?.wipeOptions || [])
    .filter((option) => option && (option.type === 'all' || option.vitalWipeId || option.type === 'current'))
    .map((option, index) => ({
      ...option,
      key: `${option.type || 'wipe'}:${option.vitalWipeId || 'current'}:${option.startedAt || index}:${index}`
    }));
}

function vitalLookupDefaultWipeKey(options = []) {
  return options.find((option) => option.type === 'current')?.key || options[0]?.key || '';
}

function vitalLookupMetricValue(row, stats, key) {
  if (row && row[key] !== null && row[key] !== undefined) return row[key];
  if (stats && stats[key] !== null && stats[key] !== undefined) return stats[key];
  return 0;
}

function vitalLookupLabelText(label, lang = 'zh') {
  if (!label || typeof label === 'string') return label || '';
  return label[lang] || label.en || label.zh || '';
}

function vitalLookupSplitStatPath(path) {
  const parts = String(path || '').split('.');
  if (parts[0] === 'farming' && (parts[1] === 'gathered' || parts[1] === 'looted') && parts.length > 3) {
    return ['farming', parts[1], parts.slice(2).join('.')];
  }
  if (parts[0] === 'building' && parts[1] === 'buildings' && parts.length > 3) {
    return ['building', 'buildings', parts.slice(2).join('.')];
  }
  return parts;
}

function vitalLookupStatValue(stats, path) {
  const parts = vitalLookupSplitStatPath(path);
  let cursor = stats || {};
  for (const part of parts) {
    if (cursor == null || cursor[part] == null) return 0;
    cursor = cursor[part];
  }
  const numeric = Number(cursor);
  return Number.isFinite(numeric) ? numeric : 0;
}

function vitalLookupEvaluateFormula(formula, stats) {
  const parts = String(formula || '').split('/').map((part) => part.trim());
  const numerator = vitalLookupFormulaPartValue(parts[0], stats);
  if (parts.length === 1) return numerator;
  if (parts.length !== 2) return 0;
  const denominator = vitalLookupFormulaPartValue(parts[1], stats);
  return denominator > 0 ? numerator / denominator : Infinity;
}

function vitalLookupFormulaPartValue(part, stats) {
  return String(part || '').split('+').reduce((total, rawTerm) => {
    const term = rawTerm.trim();
    const match = term.match(/^@([\w.]+)\|([\w.-]+)$/);
    if (match) return total + vitalLookupStatValue(stats, `${match[1]}.${match[2]}`);
    const numeric = Number(term);
    return total + (Number.isFinite(numeric) ? numeric : 0);
  }, 0);
}

function vitalLookupGroupMetricValue(metric, stats) {
  if (metric.formula) return vitalLookupEvaluateFormula(metric.formula, stats);
  return vitalLookupStatValue(stats, metric.path);
}

function formatVitalLookupGroupMetric(metric, stats, lang = 'zh') {
  const value = vitalLookupGroupMetricValue(metric, stats);
  if (value === Infinity) return '∞';
  if (metric.compact) return formatCompactResource(value, lang);
  return formatStatNumber(value, lang, {
    maximumFractionDigits: metric.decimals ?? 0,
    minimumFractionDigits: metric.decimals ?? 0
  });
}

function VitalLookupMetricGroups({ rawStats, lang, t }) {
  if (!rawStats) return null;
  const groups = VITAL_LOOKUP_GROUPS.map((group) => ({
    id: group.id,
    title: vitalLookupLabelText(group.label, lang),
    items: group.metrics.map((metric) => ({
      id: metric.path || metric.formula || vitalLookupLabelText(metric.label, lang),
      label: vitalLookupLabelText(metric.label, lang),
      value: formatVitalLookupGroupMetric(metric, rawStats, lang)
    }))
  }));
  return (
    <LookupMetricGroupSections
      title={t('vitalLookupDetail')}
      hint={t('vitalLookupDetailHint')}
      groups={groups}
    />
  );
}

function VitalLookupView({ lang, t, setToast, lookupRequest = null }) {
  const [steamInput, setSteamInput] = useState('');
  const [servers, setServers] = useState([]);
  const [selectedServerId, setSelectedServerId] = useState('');
  const [selectedWipeKey, setSelectedWipeKey] = useState('');
  const [serverLoading, setServerLoading] = useState(false);
  const [serverError, setServerError] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadVitalServers() {
      setServerLoading(true);
      setServerError('');
      try {
        const payload = await api('/api/vital-servers');
        if (cancelled) return;
        setServers(Array.isArray(payload.servers) ? payload.servers : []);
      } catch (err) {
        if (!cancelled) setServerError(localizeError(err.message, t) || t('vitalLookupLoadFailed'));
      } finally {
        if (!cancelled) setServerLoading(false);
      }
    }
    loadVitalServers();
    return () => {
      cancelled = true;
    };
  }, [t]);

  useEffect(() => {
    if (!servers.length) return;
    if (selectedServerId && servers.some((server) => String(server.vitalServerId) === selectedServerId)) return;
    const activeServer = servers.find((server) => server.status !== 'inactive') || servers[0];
    setSelectedServerId(String(activeServer?.vitalServerId || ''));
  }, [selectedServerId, servers]);

  useEffect(() => {
    const requestedServerId = String(lookupRequest?.vitalServerId || '').trim();
    if (!requestedServerId) return;
    setSelectedServerId(requestedServerId);
  }, [lookupRequest?.id, lookupRequest?.vitalServerId]);

  const selectedServer = useMemo(() => (
    servers.find((server) => String(server.vitalServerId) === selectedServerId) || null
  ), [selectedServerId, servers]);
  const wipeOptions = useMemo(() => vitalLookupWipeOptions(selectedServer), [selectedServer]);
  const selectedWipe = useMemo(() => (
    wipeOptions.find((option) => option.key === selectedWipeKey)
      || wipeOptions.find((option) => option.key === vitalLookupDefaultWipeKey(wipeOptions))
      || wipeOptions[0]
      || null
  ), [selectedWipeKey, wipeOptions]);

  useEffect(() => {
    if (!wipeOptions.length) {
      if (selectedWipeKey) setSelectedWipeKey('');
      return;
    }
    if (wipeOptions.some((option) => option.key === selectedWipeKey)) return;
    setSelectedWipeKey(vitalLookupDefaultWipeKey(wipeOptions));
  }, [selectedWipeKey, wipeOptions]);

  useEffect(() => {
    const requestedWipeId = String(lookupRequest?.vitalWipeId || '').trim();
    if (!requestedWipeId || !wipeOptions.length) return;
    const requestedOption = wipeOptions.find((option) => String(option.vitalWipeId || '') === requestedWipeId);
    if (requestedOption && requestedOption.key !== selectedWipeKey) setSelectedWipeKey(requestedOption.key);
  }, [lookupRequest?.id, lookupRequest?.vitalWipeId, selectedWipeKey, wipeOptions]);

  async function queryVital(nextSteamInput) {
    const query = String(nextSteamInput || '').trim();
    if (!query) return;
    if (!selectedServerId) {
      setError(t('vitalLookupNoServers'));
      return;
    }
    setSteamInput(query);
    setLoading(true);
    setError('');
    try {
      const payload = await api('/api/rust-kda/vital', {
        method: 'POST',
        body: {
          steamInput: query,
          vitalServerId: selectedServerId,
          vitalWipeId: selectedWipe?.vitalWipeId || ''
        }
      });
      setResult(payload);
    } catch (err) {
      setResult(null);
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  function submit(event) {
    event.preventDefault();
    if (loading) return;
    queryVital(steamInput);
  }

  useEffect(() => {
    if (!lookupRequest?.steamInput || !selectedServerId) return;
    const requestedServerId = String(lookupRequest?.vitalServerId || '').trim();
    if (requestedServerId && selectedServerId !== requestedServerId) return;
    const requestedWipeId = String(lookupRequest?.vitalWipeId || '').trim();
    if (requestedWipeId && selectedWipe?.vitalWipeId !== requestedWipeId) return;
    queryVital(lookupRequest.steamInput);
  }, [lookupRequest?.id, lookupRequest?.steamInput, lookupRequest?.vitalServerId, lookupRequest?.vitalWipeId, selectedServerId, selectedWipe?.vitalWipeId]);

  const vital = result?.vital;
  const row = vital?.row || null;
  const stats = vital?.stats || null;
  const rawVitalStats = vital?.raw?.statistics || stats?.raw?.statistics || null;
  const vitalOnlineTimeMinutes = Number(row?.onlineTimeMinutes || 0);

  return (
    <section className="page-stack rust-kda-page">
      <form className="tool-panel rust-kda-query-panel vital-lookup-form" onSubmit={submit}>
        <label className="rust-kda-input-field">
          <span>{t('steamId')}</span>
          <input
            value={steamInput}
            onChange={(event) => setSteamInput(event.target.value)}
            placeholder={t('steamPlaceholder')}
            autoComplete="off"
          />
        </label>
        <label className="rust-kda-input-field">
          <span>{t('vitalLookupServer')}</span>
          <select
            value={selectedServerId}
            onChange={(event) => setSelectedServerId(event.target.value)}
            disabled={serverLoading || !servers.length}
          >
            <option value="">{serverLoading ? t('loading') : t('vitalLookupServerPlaceholder')}</option>
            {servers.map((server) => (
              <option key={server.id || server.vitalServerId} value={String(server.vitalServerId)}>
                {server.name || server.vitalServerId}
              </option>
            ))}
          </select>
        </label>
        <label className="rust-kda-input-field">
          <span>{t('vitalLookupWipe')}</span>
          <select
            value={selectedWipe?.key || ''}
            onChange={(event) => setSelectedWipeKey(event.target.value)}
            disabled={serverLoading || !wipeOptions.length}
          >
            <option value="">{wipeOptions.length ? t('vitalLookupWipePlaceholder') : t('vitalLookupNoWipes')}</option>
            {wipeOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.type === 'all' ? t('vitalLookupAllWipes') : (option.label || option.vitalWipeId || option.type)}
              </option>
            ))}
          </select>
        </label>
        <button className="primary-button align-end" title={t('querySteamAccount')} disabled={loading || serverLoading || !steamInput.trim() || !selectedServerId}>
          <Search size={17} />
          <span>{loading ? t('loading') : t('queryShort')}</span>
        </button>
      </form>
      {serverError && <Alert tone="danger">{serverError}</Alert>}
      {!serverLoading && !serverError && !servers.length && <Alert>{t('vitalLookupNoServers')}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {!result && !error && <div className="empty-state">{t('vitalLookupEmpty')}</div>}
      {result?.errors?.vital && <Alert tone="danger">{result.errors.vital}</Alert>}
      {result && !vital && !error && <div className="empty-state compact">{t('vitalLookupNoData')}</div>}
      {vital && (
        <>
          <InfoGrid items={[
            [t('vitalLookupServer'), vital.serverName || vital.serverId || '-'],
            [t('vitalLookupWipe'), vital.wipeId ? (vital.wipeName || vital.wipeId) : t('vitalLookupAllWipes')],
            [t('externalSource'), result.source || '-'],
            [t('fetchedAt'), formatTime(result.fetchedAt, lang) || '-']
          ]} />
          <div className="rust-kda-metric-grid">
            <MetricCard label={t('kills')} value={formatStatNumber(vitalLookupMetricValue(row, stats, 'kills'), lang)} />
            <MetricCard label={t('deaths')} value={formatStatNumber(vitalLookupMetricValue(row, stats, 'deaths'), lang)} />
            <MetricCard label={t('kda')} value={formatStatNumber(vitalLookupMetricValue(row, stats, 'kda'), lang, { maximumFractionDigits: 2 })} />
            <MetricCard label={t('t3Kills')} value={formatStatNumber(vitalLookupMetricValue(row, stats, 't3Kills'), lang)} />
            <MetricCard label={t('rockets')} value={formatStatNumber(vitalLookupMetricValue(row, stats, 'rockets'), lang)} />
            <MetricCard label={t('sulfur')} value={formatCompactResource(vitalLookupMetricValue(row, stats, 'sulfur'), lang)} />
            <MetricCard label={t('metalOre')} value={formatCompactResource(vitalLookupMetricValue(row, stats, 'metalOre'), lang)} />
            <MetricCard label={t('building')} value={formatCompactResource(vitalLookupMetricValue(row, stats, 'building'), lang)} />
            {vitalOnlineTimeMinutes > 0 && <MetricCard label={t('onlineTime')} value={formatPlayTimeMinutes(vitalOnlineTimeMinutes, lang)} />}
          </div>
          {!vital.wipeId && <Alert>{t('vitalLookupAllWipesHint')}</Alert>}
          <VitalLookupMetricGroups rawStats={rawVitalStats} lang={lang} t={t} />
        </>
      )}
    </section>
  );
}

function InventoryItemName({ item, lang }) {
  const name = rustKdaDisplayName(item, lang);
  const subtitle = lang === 'zh' ? item.name : item.nameCN;
  return (
    <div className="inventory-item-name">
      {item.iconUrl || item.imageUrl ? <img src={item.iconUrl || item.imageUrl} alt="" loading="lazy" /> : <span className="inventory-item-placeholder">R</span>}
      <span>
        <strong>{name}</strong>
        {subtitle && subtitle !== name && <small>{subtitle}</small>}
      </span>
    </div>
  );
}

export default DataLookupView;
