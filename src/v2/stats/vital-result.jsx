import React, { useState } from 'react';
import { t, getUiLocale } from '../i18n.js';
import { VITAL_CATEGORIES } from '../../../shared/vital-leaderboards.js';
import { vitalFieldLabel as sourceFieldLabel } from '../../../shared/vital-field-labels.js';
const statusNames = { observed: '已获取', not_found: '未找到', not_observed: '尚未采集', unavailable: '暂不可用' };
const valueText = value => value == null ? '—' : typeof value === 'number'
  ? new Intl.NumberFormat(getUiLocale().startsWith('en') ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 }).format(value)
  : String(value);

export function vitalFieldLabel(field) {
  const path = field.id || field.path || field.name;
  const label = sourceFieldLabel(path, getUiLocale().startsWith('en') ? 'en' : 'zh');
  return label === path ? t(field.name || path) : label;
}

export function vitalWipeLabel(wipe, locale, timeZone) {
  const start = Date.parse(wipe.startTime), end = Date.parse(wipe.endTime);
  const format = value => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'zh-CN', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).format(new Date(value));
  const name = wipe.name && ![wipe.id, wipe.providerWipeId, wipe.startTime].includes(wipe.name) && Date.parse(wipe.name) !== start ? wipe.name : '';
  if (!Number.isFinite(start)) return wipe.name || wipe.providerWipeId || wipe.id;
  const ending = Number.isFinite(end) ? format(end) : wipe.state === 'current' ? t('进行中') : t('结束时间未知');
  return [name, `${format(start)} — ${ending}`].filter(Boolean).join(' · ');
}

export function vitalResultCategories(result) {
  if (result.categories?.length) return result.categories;
  // Previously saved jobs only have flat fields. They remain readable without
  // re-querying or claiming that a missing category was observed.
  const categories = VITAL_CATEGORIES.map(category => ({ id: category.id,
    fields: (result.fields || []).filter(field => String(field.id || field.path || field.name).split('.')[0] === category.id)
  })).filter(category => category.fields.length);
  const other = (result.fields || []).filter(field => !VITAL_CATEGORIES.some(category => category.id === String(field.id || field.path || field.name).split('.')[0]));
  if (other.length) categories.push({ id: 'other', label: '其他字段', fields: other });
  return categories;
}

export function VitalQueryCategories({ result }) {
  const categories = vitalResultCategories(result);
  const [selected, setSelected] = useState(categories[0]?.id || '');
  const active = categories.find(category => category.id === selected) || categories[0];
  if (!active) return null;
  const categoryLabel = category => t(VITAL_CATEGORIES.find(spec => spec.id === category.id)?.label.zh || category.label || category.id);
  return <section className="stats-vital-categories" aria-label={t("Vital 数据分类")}>
    <div className="stats-official-section-heading"><div><h3>{t("Vital 数据分类")}</h3><p>{t("显示所选服务器与来源档期的原始统计；未提供的字段显示 —，真实零值保留为 0。")}</p></div></div>
    <nav className="stats-official-tabs" aria-label={t("Vital 数据分类")}>
      {categories.map(category => <button type="button" key={category.id} aria-pressed={category.id === active.id}
        onClick={() => setSelected(category.id)}>{categoryLabel(category)}<small>{category.fields.length}</small></button>)}
    </nav>
    <div className="stats-official-category">
      <div className="stats-official-category-heading"><h4>{categoryLabel(active)}</h4><span>{t("{count} 项指标", { count: active.fields.length })}</span></div>
      <dl className="stats-official-grid">{active.fields.map((field, index) => <div className="stats-official-field" key={field.id || field.path || `${field.name}:${index}`}>
        <dt title={field.id || field.path || field.name}>{vitalFieldLabel(field)}</dt><dd>{valueText(field.value)}</dd>
        <small className="muted">{t(statusNames[field.status] || field.status || '尚未采集')}</small>
      </div>)}</dl>
    </div>
  </section>;
}
