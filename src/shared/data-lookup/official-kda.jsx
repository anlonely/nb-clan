import { ExternalLink } from 'lucide-react';
import { formatCompactResource, formatPlayTimeMinutes, formatStatNumber } from '../format.js';
import { cx } from '../ui/cx.js';

export function formatOfficialKdaMetric(key, value, lang = 'zh') {
  if (key === 'playTimeMinutes') return formatPlayTimeMinutes(value, lang);
  if (key === 'sulfur' || key === 'metalOre' || key === 'wood' || key === 'stone') return formatCompactResource(value, lang);
  if (key === 'kda') return formatStatNumber(value, lang, { maximumFractionDigits: 2 });
  if (key === 'accuracy' || key === 'headshotRate') {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return '-';
    const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
    return `${formatStatNumber(percent, lang, { maximumFractionDigits: 2 })}%`;
  }
  return formatStatNumber(value, lang);
}

export function officialKdaMetricNumber(kda, keys = []) {
  if (!kda) return null;
  for (const key of keys) {
    const value = Number(kda[key]);
    if (Number.isFinite(value)) return value;
  }
  const normalizedKeys = keys.map((key) => String(key).toLowerCase());
  const metric = (kda.metrics || []).find((item) => {
    const key = String(item.key || '').toLowerCase();
    return normalizedKeys.some((candidate) => key === candidate || key.endsWith(`.${candidate}`));
  });
  const value = Number(metric?.value);
  return Number.isFinite(value) ? value : null;
}

export function formatOfficialKdaRate(value, lang = 'zh') {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  const percent = numeric > 0 && numeric <= 1 ? numeric * 100 : numeric;
  return `${formatStatNumber(percent, lang, { maximumFractionDigits: 2 })}%`;
}

export function formatOfficialKdaRatio(kills, deaths, lang = 'zh') {
  const killCount = Number(kills);
  const deathCount = Number(deaths);
  if (!Number.isFinite(killCount) || !Number.isFinite(deathCount)) return '-';
  const ratio = deathCount > 0 ? killCount / deathCount : killCount;
  return formatStatNumber(ratio, lang, { maximumFractionDigits: 2 });
}

function DetailIconButton({ title, onClick, disabled = false }) {
  return (
    <button type="button" className="metric-detail-button" title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <ExternalLink size={12} />
    </button>
  );
}

export function OfficialKdaCompactCard({ kda, loading = false, lang, t, onDetail }) {
  return (
    <div className="metric-card official-kda-compact-card">
      <div className="metric-card-head official-kda-compact-head">
        <span>{t('officialKdaCompactTitle')}</span>
        <span className="official-kda-head-slot">
          <OfficialKdaHeadMetric kda={kda} lang={lang} t={t} />
          {onDetail && <DetailIconButton title={t('officialKdaDetail')} onClick={onDetail} />}
        </span>
      </div>
      <OfficialKdaCompactContent kda={kda} loading={loading} lang={lang} t={t} />
    </div>
  );
}

function OfficialKdaHeadMetric({ kda, lang, t }) {
  const kills = officialKdaMetricNumber(kda, ['kills', 'playerKills']);
  const deaths = officialKdaMetricNumber(kda, ['deaths']);
  return kda ? <span className="official-kda-head-metric">{t('kda')}: <b>{formatOfficialKdaRatio(kills, deaths, lang)}</b></span> : null;
}

export function OfficialKdaCompactContent({ kda, loading = false, lang, t, className = '', showHeadMetric = false }) {
  const kills = officialKdaMetricNumber(kda, ['kills', 'playerKills']);
  const deaths = officialKdaMetricNumber(kda, ['deaths']);
  const headshotRate = officialKdaMetricNumber(kda, ['headshotRate']);
  const accuracy = officialKdaMetricNumber(kda, ['accuracy']);
  const headshots = officialKdaMetricNumber(kda, ['headshots', 'headshotKills']);
  const hits = officialKdaMetricNumber(kda, ['hits']);
  const shots = officialKdaMetricNumber(kda, ['bulletsFired', 'shots']);
  const fallbackHeadshotRate = hits > 0 && headshots !== null ? (headshots / hits) * 100 : null;
  const fallbackAccuracy = shots > 0 && hits !== null ? (hits / shots) * 100 : null;
  const hasData = Boolean(kda);
  const summary = loading ? t('officialKdaLoading') : (!hasData ? t('officialKdaNoData') : '');
  return (
    <div className={cx('official-kda-compact-content', className)}>
      {showHeadMetric && hasData && (
        <div className="official-kda-inline-head">
          <OfficialKdaHeadMetric kda={kda} lang={lang} t={t} />
        </div>
      )}
      {summary ? (
        <strong className="official-kda-empty-text">{summary}</strong>
      ) : (
        <div className="official-kda-compact-grid">
          <span>{t('kills')}: <b>{formatStatNumber(kills, lang)}</b></span>
          <span>{t('deaths')}: <b>{formatStatNumber(deaths, lang)}</b></span>
          <span>{t('headshotRate')}: <b>{formatOfficialKdaRate(headshotRate ?? fallbackHeadshotRate, lang)}</b></span>
          <span>{t('accuracyRate')}: <b>{formatOfficialKdaRate(accuracy ?? fallbackAccuracy, lang)}</b></span>
        </div>
      )}
    </div>
  );
}
