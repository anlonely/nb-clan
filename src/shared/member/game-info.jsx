import { BarChart3, Monitor } from 'lucide-react';
import {
  formatCompactResource,
  formatPlayTimeMinutes,
  formatStatNumber,
  formatTime
} from '../format.js';
import { firstPositiveMinutes } from '../kda.js';
import { wipeStatusText } from '../wipes.js';

export function onlineSourceMinutes(source = {}) {
  return firstPositiveMinutes(
    source?.onlineTimeMinutes,
    source?.serverPlayTimeMinutes,
    source?.weeklyPlayTimeMinutes,
    Math.round(Number(source?.serverPlayTimeSeconds || 0) / 60),
    Math.round(Number(source?.weeklyPlayTimeSeconds || 0) / 60)
  );
}

export function onlineLastOfflineText(source = {}, lang, t) {
  if (source?.lastOfflineAt) return formatTime(source.lastOfflineAt, lang);
  if (source?.lastOnlineAt && source?.wipeStatus !== 'closed') return t('notOfflineYet');
  return '-';
}

export function CurrentQueryKdaPanel({ kda, fallbackSource = null, lang, t }) {
  const metricItems = [
    ['onlineTimeMinutes', 'onlineTime', 'time'],
    ['kills', 'kills', 0],
    ['t3Kills', 't3Kills', 0],
    ['rockets', 'rockets', 0],
    ['sulfur', 'sulfur', 'resource'],
    ['metalOre', 'metalOre', 'resource'],
    ['building', 'building', 0],
    ['deaths', 'deaths', 0],
    ['kda', 'kda', 2]
  ];
  const valueForMetric = (key, kind) => {
    if (kind === 'time') return formatPlayTimeMinutes(onlineSourceMinutes({
      ...(kda?.onlineSummary || {}),
      onlineTimeMinutes: kda?.[key]
    }), lang);
    if (kind === 'resource') return formatCompactResource(kda?.[key], lang);
    return formatStatNumber(kda?.[key], lang, { maximumFractionDigits: kind });
  };
  const sourceName = kda?.serverName || fallbackSource?.serverName || fallbackSource?.wipeName || t('recentHistoryServer');
  return (
    <section className="lookup-kda-card">
      <div className="lookup-kda-head">
        <span><BarChart3 size={18} /></span>
        <div>
          <strong>{t('currentKdaStats')}</strong>
          <small>{sourceName} · {t('kdaDataTime')}: {formatTime(kda?.syncedAt, lang) || t('notSyncedYet')}</small>
        </div>
      </div>
      {kda ? (
        <div className="lookup-kda-grid">
          {metricItems.map(([key, labelKey, kind]) => (
            <div key={key} className={key === 'kda' ? 'accent' : ''}>
              <span>{t(labelKey)}</span>
              <strong>{valueForMetric(key, kind)}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="lookup-kda-empty">{t('noCurrentKda')}</div>
      )}
    </section>
  );
}

function ServerGameInfoRow({ label, source, lang, t }) {
  const serverName = source?.serverName || source?.wipeName || '-';
  const status = source?.wipeStatus ? wipeStatusText(source.wipeStatus, t) : '';
  return (
    <div className="server-game-row">
      <div className="server-game-source">
        <strong>{label}</strong>
        <small>{status ? `${serverName} · ${status}` : serverName}</small>
      </div>
      <div className="server-game-metric accent">
        <span>{t('onlineTotalTime')}</span>
        <strong>{formatPlayTimeMinutes(onlineSourceMinutes(source), lang)}</strong>
      </div>
      <div className="server-game-metric">
        <span>{t('lastOnlineAt')}</span>
        <strong>{formatTime(source?.lastOnlineAt, lang) || '-'}</strong>
      </div>
      <div className="server-game-metric">
        <span>{t('lastOfflineAt')}</span>
        <strong>{onlineLastOfflineText(source, lang, t)}</strong>
      </div>
    </div>
  );
}

export function ServerGameInfoPanel({ recentOnline, currentOnline, lang, t }) {
  const syncedAt = currentOnline?.syncedAt || recentOnline?.syncedAt || '';
  return (
    <section className="member-profile-section">
      <div className="section-heading compact-heading member-profile-heading-row">
        <h3>{t('gameTimeGroup')}</h3>
        <small>{t('lastSyncAt')}: {formatTime(syncedAt, lang) || t('notSyncedYet')}</small>
      </div>
      <div className="server-game-list">
        <ServerGameInfoRow label={t('recentHistoryServer')} source={recentOnline || {}} lang={lang} t={t} />
        <ServerGameInfoRow label={t('currentServer')} source={currentOnline || {}} lang={lang} t={t} />
      </div>
    </section>
  );
}

export function QueryServerOnlinePanel({ online, lang, t }) {
  if (!online) return null;
  return (
    <section className="lookup-kda-card query-online-card">
      <div className="lookup-kda-head">
        <span><Monitor size={18} /></span>
        <div>
          <strong>{t('currentServerOnline')}</strong>
          <small>{online.serverName || t('currentServer')} · {wipeStatusText(online.wipeStatus, t)} · {t('lastSyncAt')}: {formatTime(online.syncedAt, lang) || t('notSyncedYet')}</small>
        </div>
      </div>
      <div className="lookup-kda-grid compact-metrics">
        <div className="accent">
          <span>{t('onlineTotalTime')}</span>
          <strong>{formatPlayTimeMinutes(online.onlineTimeMinutes, lang)}</strong>
        </div>
        <div>
          <span>{t('lastOnlineAt')}</span>
          <strong>{formatTime(online.lastOnlineAt, lang) || '-'}</strong>
        </div>
        <div>
          <span>{t('lastOfflineAt')}</span>
          <strong>{onlineLastOfflineText(online, lang, t)}</strong>
        </div>
      </div>
    </section>
  );
}
