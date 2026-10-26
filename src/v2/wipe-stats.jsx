import React from 'react';
import { t, getUiLocale } from './i18n.js';
import { useApp, AppLink } from './context.jsx';
import { useQuery } from './use-query.jsx';
import { Avatar, Badge, Button, Notice, Panel, QueryState } from './ui.jsx';
import { time } from './format.js';
import { observedMetric } from './stats/workspace-state.js';
import { VitalQueryCategories } from './stats/vital-result.jsx';
import './stats/style.css';

const metrics = {
  kills: '击杀', deaths: '死亡', kd: 'KD', t3Kills: 'T3 击杀',
  assists: '助攻', kda: 'KDA', rockets: '火箭', sulfur: '硫磺',
  metalOre: '金属矿', building: '建筑方块', onlineSeconds: '本服在线时间', playTimeSeconds: '游戏时长'
};

export default function WipeStats({ id }) {
  const { client, session } = useApp();
  const memberId = session.memberId;
  const sources = useQuery(client, ['stats', 'sources', id], `/api/v2/stats/wipes/${encodeURIComponent(id)}/sources`, { enabled: !!memberId });
  if (!memberId) return <Panel><Notice title={t('请先完成成员验证')}><AppLink to="/app/me">{t('查看我的资料')}</AppLink></Notice></Panel>;
  return <QueryState query={sources}>{data => data.wipe.supportsVitalStats
    ? <PersonalStatsRows id={id} memberId={memberId} revision={['ended', 'archived'].includes(data.wipe.lifecycle) ? data.archiveRevision || 0 : 0}/>
    : <Panel><h2>{t('本场战绩')}</h2><p className="muted">{t('此档期不是 Vital 战绩来源。')}</p></Panel>}</QueryState>;
}

function PersonalStatsRows({ id, memberId, revision }) {
  const { client, zone } = useApp();
  // Always bind the view to the authenticated member, including administrator accounts.
  // Signup participation is deliberately not part of this query.
  const params = { wipeId: id, memberId, sourceId: 'vital', metricVersion: 'nb-kda-1', revision: String(revision) };
  const rows = useQuery(client, ['stats', 'personal', params], `/api/v2/stats/rows?${new URLSearchParams(params)}`);
  return <Panel><div className="section-title"><h2>{t('我的本场战绩')}</h2>
    <Button disabled={rows.loading || rows.refreshing} onClick={() => rows.retry().catch(() => {})}>{t('刷新战绩')}</Button></div>
    <QueryState query={rows}>{data => <PersonalStatsResult items={data.items.filter(row => row.memberId === memberId)} zone={zone}/>}</QueryState>
  </Panel>;
}

export function PersonalStatsResult({ items = [], zone }) {
  const number = value => new Intl.NumberFormat(getUiLocale().startsWith('en') ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 }).format(value);
  if (!items.length) return <Notice title={t('本档暂未取得你的战绩')}>
    {t('请确认绑定的 Steam 账号正确，并已进入本档服务器；数据采集后会在这里显示。')}
    <AppLink to="/app/me">{t('查看我的资料')}</AppLink>
  </Notice>;
  return <div className="stack">{items.map(row => <div key={row.id}>
    <div className="profile-intro"><Avatar name={row.displayName} src={row.avatarUrl}/><div>
      <h3>{row.displayName || t('我的本场战绩')}</h3>
      <span className="caption">{row.steamId}</span> <Badge>Vital</Badge>
    </div></div>
    <p className="caption">{t('更新时间：{time}', { time: time(row.capturedAt, zone) })}
      {row.status === 'stale' ? ` · ${t('数据过期')}` : ''}</p>
    <dl className="stats-official-grid">{Object.entries(metrics).map(([key, label]) => {
      const value = observedMetric(row, key);
      return <div className="stats-official-field" key={key}><dt>{t(label)}</dt><dd>{value === null ? '—'
        : ['onlineSeconds', 'playTimeSeconds'].includes(key) ? t('{hours} 小时', { hours: number(value / 3600) }) : number(value)}</dd></div>;
    })}</dl>
    <p className="caption">{t('尚未采集的字段显示 —，真实零值显示 0。')}</p>
    <VitalQueryCategories result={row}/>
  </div>)}</div>;
}
