import { formatPlayTimeMinutes, formatTime } from '../format.js';
import { cx } from '../ui/cx.js';
import { wipeStatusText } from '../wipes.js';

export function StatusBadge({ status, t }) {
  const tone = status === 'closed' ? 'closed' : (status === 'planned' ? 'pending' : 'active');
  return <span className={cx('status-badge', tone)}>{wipeStatusText(status, t)}</span>;
}

export function normalizeParticipantStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'active') return 'on_time';
  if (value === 'late' || value === 'bench' || value === 'left' || value === 'unavailable') return 'join_16h';
  if (value === 'join_8h') return 'join_8h';
  if (value === 'join_16h') return 'join_16h';
  if (value === 'skip' || value === 'unsure') return 'not_attending';
  if (value === 'not_attending') return 'not_attending';
  return 'on_time';
}

export function participantSourceLabel(source, t) {
  if (source === 'wechat') return t('sourceWechat');
  if (source === 'discord') return t('sourceDiscord');
  if (source === 'admin') return t('sourceAdmin');
  if (source === 'web') return t('sourceWeb');
  return source || '-';
}

export function ParticipantStatusBadge({ status, t }) {
  const normalized = normalizeParticipantStatus(status);
  const key = normalized === 'join_8h'
    ? 'statusParticipantJoin8h'
    : (normalized === 'join_16h'
        ? 'statusParticipantJoin16h'
        : (normalized === 'not_attending' ? 'statusParticipantNotAttending' : 'statusParticipantActive'));
  const tone = normalized === 'not_attending' ? 'neutral' : (normalized === 'on_time' ? 'active' : 'pending');
  return <span className={cx('status-badge', tone)}>{t(key)}</span>;
}

export function memberOnlineState(summary = {}) {
  const lastOnlineMs = Date.parse(summary.lastOnlineAt || '');
  const lastOfflineMs = Date.parse(summary.lastOfflineAt || '');
  if (!Number.isFinite(lastOnlineMs) || Date.now() - lastOnlineMs > 24 * 60 * 60 * 1000) return 'stale';
  if (!Number.isFinite(lastOfflineMs) || lastOfflineMs < lastOnlineMs) return 'online';
  return 'offline';
}

export function MemberOnlineGameStatus({ summary = {}, t }) {
  const state = memberOnlineState(summary);
  if (state === 'online') return <span className="status-badge active">{t('gameOnline')}</span>;
  if (state === 'offline') return <span className="status-badge closed">{t('gameOffline')}</span>;
  return <span className="status-badge pending">{t('noOnlineData24h')}</span>;
}

export function MemberOnlineSummary({ summary = {}, lang, t }) {
  const weeklyMinutes = Number(summary.weeklyPlayTimeMinutes ?? Math.round(Number(summary.weeklyPlayTimeSeconds || 0) / 60));
  const lastOffline = summary.lastOfflineAt
    ? formatTime(summary.lastOfflineAt, lang)
    : (summary.lastOnlineAt ? t('notOfflineYet') : '-');
  return (
    <div className="online-summary-cell">
      <span><strong>{t('lastOnlineAt')}</strong>{formatTime(summary.lastOnlineAt, lang) || '-'}</span>
      <span><strong>{t('lastOfflineAt')}</strong>{lastOffline}</span>
      <span><strong>{t('recentWeekPlayTime')}</strong>{formatPlayTimeMinutes(weeklyMinutes, lang)}</span>
    </div>
  );
}
