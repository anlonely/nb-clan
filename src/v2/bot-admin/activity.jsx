import React from 'react';
import {ArrowLeft, ArrowUpRight, History} from 'lucide-react';
import {t, dateLocale} from '../i18n.js';
import {useApp, AppLink} from '../context.jsx';
import {useQuery} from '../use-query.jsx';
import {Badge, Button, Notice, Panel, QueryState} from '../ui.jsx';
import {Select} from '../select.jsx';
import {RuntimeResult} from './runtime-tools.jsx';

const filterKeys = ['action', 'status', 'from', 'to'];

export default function Activity({platform, audit, previous, next, page, operationId, filterError, actionLabels, displayStatus}) {
  const {client, path, go, zone} = useApp();
  const params = new URL(path || '/admin/bot/activity', 'https://local.invalid').searchParams;
  params.set('platform', platform);
  const detail = useQuery(client, ['bot-operation', operationId], `/api/v2/platform-admin/operations/${encodeURIComponent(operationId || '')}`, {enabled: Boolean(operationId)});
  const update = (key, value) => {
    const query = new URLSearchParams(params);
    value ? query.set(key, value) : query.delete(key);
    go(`/admin/bot/activity?${query}`, {replace: true, scroll: false});
  };
  const clearFilters = () => {
    const query = new URLSearchParams(params);
    filterKeys.forEach(key => query.delete(key));
    go(`/admin/bot/activity?${query}`, {replace: true, scroll: false});
  };
  const hasFilters = filterKeys.some(key => params.get(key));

  if (operationId) return <Panel className="panel bot-operation-detail">
    <AppLink className="button ghost bot-row-action" to={`/admin/bot/activity?${params}`}><ArrowLeft size={15}/>{t('返回操作记录')}</AppLink>
    <div className="bot-list-heading"><div><h2>{t('操作详情')}</h2><p>{t('查看本次操作的执行结果与回执。')}</p></div><Badge>{platform === 'discord' ? 'Discord' : 'KOOK'}</Badge></div>
    <QueryState query={detail}>{data => <>
      <dl className="bot-operation-facts"><dt>{t('平台')}</dt><dd>{data.platform === 'discord' ? 'Discord' : data.platform === 'kook' ? 'KOOK' : data.platform}</dd><dt>{t('操作者')}</dt><dd><code>{data.actorId}</code></dd><dt>{t('动作')}</dt><dd>{t(actionLabels[data.action] || data.action || '保存配置')}</dd><dt>{t('目标')}</dt><dd>{data.resource?.id || t('未记录')}</dd></dl>
      <RuntimeResult result={data} platform={platform} displayStatus={displayStatus}/>
      <div className="platform-actions"><AppLink className="button ghost bot-row-action" to={`/admin/bot/tools?platform=${platform}&tool=recovery`}>{t('进入核实工具')}<ArrowUpRight size={15}/></AppLink></div>
    </>}</QueryState>
  </Panel>;

  return <Panel className="panel bot-activity">
    <div className="bot-list-heading"><div><h2>{t('操作记录')}</h2><p>{t('按动作、结果和日期查找操作，打开详情查看回执。')}</p></div></div>
    <div className="bot-filter-row">
      <label>{t('动作')}<Select aria-label={t('筛选操作')} value={params.get('action') || ''} onChange={event => update('action', event.target.value)}><option value="">{t('全部')}</option>{Object.entries(actionLabels).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</Select></label>
      <label>{t('结果')}<Select aria-label={t('筛选结果')} value={params.get('status') || ''} onChange={event => update('status', event.target.value)}><option value="">{t('全部')}</option>{['succeeded', 'failed', 'running', 'queued', 'result_unknown'].map(status => <option value={status} key={status}>{displayStatus(status)}</option>)}</Select></label>
      <label>{t('开始日期')}<input aria-label={t('开始日期')} type="date" value={params.get('from') || ''} onChange={event => update('from', event.target.value)}/></label>
      <label>{t('结束日期')}<input aria-label={t('结束日期')} type="date" value={params.get('to') || ''} onChange={event => update('to', event.target.value)}/></label>
      {hasFilters && <Button kind="ghost" onClick={clearFilters}>{t('清除筛选')}</Button>}
    </div>
    {filterError ? <Notice tone="error" title={t('请选择有效的日期范围。')}/> : <QueryState query={audit}>{data => data.items.length ? <div className="bot-table-scroll"><table className="bot-activity-table"><thead><tr>{['时间', '动作', '操作者', '结果', '操作'].map(label => <th key={label}>{t(label)}</th>)}</tr></thead><tbody>{data.items.map(row => <tr key={row.id}><td>{new Date(row.at).toLocaleString(dateLocale(), {timeZone: zone})}</td><td>{t(actionLabels[row.action] || row.action)}</td><td><code>{row.actorId}</code></td><td><Badge tone={row.status === 'succeeded' ? 'green' : row.status === 'result_unknown' ? 'warning' : ''}>{displayStatus(row.status)}</Badge></td><td><AppLink className="button ghost bot-row-action" to={`/admin/bot/activity/${platform}/${encodeURIComponent(row.operationId)}?${params}`}>{t('查看详情')}<ArrowUpRight size={15}/></AppLink></td></tr>)}</tbody></table></div> : <div className="bot-empty"><History size={28}/><h3>{t(hasFilters ? '没有匹配的操作记录。' : '暂无操作记录。')}</h3><p>{t(hasFilters ? '调整筛选条件，或清除筛选查看全部记录。' : '执行 Bot 操作后，可在这里查看进度与结果。')}</p></div>}</QueryState>}
    {!filterError && <nav className="platform-history-pagination bot-activity-pagination" aria-label={t('操作历史翻页')}><Button disabled={page === 1 || audit.loading || audit.refreshing} onClick={previous}>{t('上一页')}</Button><span>{t('第 {value0} 页', {value0: page})}</span><Button disabled={!audit.data?.nextCursor || audit.loading || audit.refreshing || Boolean(audit.error)} onClick={() => next(audit.data.nextCursor)}>{t('下一页')}</Button></nav>}
  </Panel>;
}
