import { displayTimeZone } from '../display-preferences.js';
import React from 'react';
import {t,getUiLocale} from '../i18n.js';
import './coverage-status.css';

const sourceNames = {
  battlemetrics: 'BattleMetrics',
  discord: 'Discord',
  kook: 'KOOK',
  steam: 'Steam',
  hexaytron: 'Hexaytron',
  kda: '战绩数据源',
  local: '本地成员数据'
};

const qualityNames = {
  complete: '全部覆盖',
  verified: '已核实',
  verified_fixture: '已核实',
  partial: '部分覆盖',
  conflicted: '有待核实数据',
  unknown: '尚未取得数据'
};

const errorNames = {
  SYNC_WIPE_REQUIRED: '当前没有可用档期，请选择其他范围',
  SYNC_WIPE_SELECTION_REQUIRED: '有多个可用档期，请指定要查看的档期',
  MISSING_IDENTITY: '部分成员尚未匹配 BattleMetrics 玩家',
  IDENTITY_CONFLICT: '存在多个匹配候选，需要人工核实',
  SOURCE_TIMEOUT: '数据来源响应超时',
  SOURCE_UNAVAILABLE: '数据来源暂时不可用',
  PROXY_UNAVAILABLE: '连接代理暂时不可用',
  CREDENTIALS_INVALID: '数据来源的连接凭据已失效',
  NO_APPLICABLE_DATA: '当前范围没有适用数据',
  RATE_LIMITED: '数据来源请求较多，正在等待恢复'
};

function formatTime(value) {
  if (!value) return t("尚无记录");
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? t("尚无记录")
    : date.toLocaleString(getUiLocale().startsWith('en')?'en-US':'zh-CN', { timeZone: displayTimeZone(),  hour12: false });
}

function formatScope(scope = {}) {
  const label = {
    current_wipe: t("当前档期"),
    squad: t("指定队伍"),
    members: t("已选成员（{value0} 人）", {value0:scope.memberIds?.length || 0}),
    missing_only: t("缺失数据的成员"),
    all_members: t("全部成员"),
    failed: t("上次更新失败的成员")
  }[scope.kind] || t("范围待核对");
  const scopeId = scope.id || scope.wipeId;
  return scopeId ? `${label} · ${scopeId}` : label;
}

function friendlySource(value) {
  if (!value) return t("尚未确定");
  return t(sourceNames[value] || "其他数据来源");
}

function friendlyQuality(value) {
  return t(qualityNames[value] || (value ? "状态待核对" : "尚未取得数据"));
}

function friendlyError(value) {
  if (!value) return t("最近没有记录到同步错误");
  return t(errorNames[value] || "最近一次更新未完成，请查看任务记录");
}

export function CoverageStatus({ data }) {
  const value = data || {};
  const hasError = Boolean(value.lastError);
  const hasSuccess = Boolean(value.lastSuccessAt);

  return <section className="panel coverage-status" aria-labelledby="coverage-status-title">
    <header className="coverage-status__header">
      <div>
        <p className="coverage-status__eyebrow">{t("数据状态")}</p>
        <h2 id="coverage-status-title">{t("来源与更新时间")}</h2>
      </div>
      <span className={`coverage-status__quality coverage-status__quality--${value.quality || 'unknown'}`}>
        {friendlyQuality(value.quality)}
      </span>
    </header>

    <dl className="coverage-status__summary">
      <div>
        <dt>{t("数据来源")}</dt>
        <dd>{friendlySource(value.source)}</dd>
      </div>
      <div>
        <dt>{t("数据范围")}</dt>
        <dd>{formatScope(value.scope)}</dd>
      </div>
      <div>
        <dt>{t("最近更新")}</dt>
        <dd>{formatTime(value.lastSuccessAt)}</dd>
      </div>
    </dl>

    <div className={`coverage-status__message${hasError ? ' coverage-status__message--error' : !hasSuccess ? ' coverage-status__message--empty' : ''}`} role={hasError ? 'alert' : 'status'}>
      <span>{hasError ? t("最近错误") : t("同步状态")}</span>
      <strong>{hasError || hasSuccess ? friendlyError(value.lastError) : t("尚未完成首次同步")}</strong>
    </div>

    <dl className="coverage-status__times">
      <div>
        <dt>{t("来源采集时间")}</dt>
        <dd>{formatTime(value.observedAt)}</dd>
      </div>
      <div>
        <dt>{t("系统保存时间")}</dt>
        <dd>{formatTime(value.receivedAt)}</dd>
      </div>
    </dl>
  </section>;
}
