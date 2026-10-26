import { formatCopy, formatStatNumber } from '../format.js';
import { cx } from '../ui/cx.js';

export function yesNoText(value, t) {
  return value ? t('fieldYes') : t('fieldNo');
}

export function steamBanYesNoText(value, stats = {}, t) {
  return stats.steamBanCheckedAt ? yesNoText(value, t) : t('notSyncedYet');
}

export function SteamBanStatusMetricCard({ stats = {}, lang, t }) {
  const checked = Boolean(stats.steamBanCheckedAt);
  const vacBans = Math.max(0, Math.floor(Number(stats.numberOfVacBans || 0)));
  const gameBans = Math.max(0, Math.floor(Number(stats.numberOfGameBans || 0)));
  const totalBans = vacBans + gameBans;
  const banned = checked && (Boolean(stats.vacBanned) || totalBans > 0);
  const days = Math.max(0, Math.floor(Number(stats.daysSinceLastBan || 0)));
  return (
    <div className={cx('metric-card steam-ban-metric-card', banned && 'danger')}>
      <span>{t('steamBanStatus')}</span>
      <strong>{checked ? (banned ? t('steamBanYes') : t('steamBanNo')) : t('notSyncedYet')}</strong>
      {banned && (
        <>
          <small>{totalBans === 1 ? t('steamBanSingle') : t('steamBanMultiple')}</small>
          <small>{formatCopy(t('steamBanDaysSinceLast'), { days: formatStatNumber(days, lang) })}</small>
        </>
      )}
    </div>
  );
}
