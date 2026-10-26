import { displayTimeZone } from '../display-preferences.js';
import { t, getUiLocale } from '../i18n.js';
import { Select as Dropdown } from '../select.jsx';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useApp, AppLink } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { Button, Panel, Title, Badge, Notice, QueryState, Modal, Avatar } from '../ui.jsx';
import { notifySuccess } from '../toast.jsx';
import { responseLabel } from '../format.js';
import { OfficialQueryResult, SteamProfileCard } from './official-result.jsx';
import { createStatsOperation } from './operation.js';
import { ApiError } from '../query-client.js';
import { VITAL_LEADERBOARDS, leaderboardById } from '../../../shared/vital-leaderboards.js';
import { VitalQueryCategories, vitalWipeLabel } from './vital-result.jsx';
import { statsTimeRange } from './time-range.js';
import { statsWorkspaceParams } from './route.js';
import { RefreshCw, Download, ArrowUp, ArrowDown, ArrowUpDown, ChartNoAxesCombined, ExternalLink } from 'lucide-react';
import { observedMetric, statsPageSummary, requestStatsSync, statsSyncIsActive, statsSyncPollDelay, statsSyncProgressKey } from './workspace-state.js';
import './style.css';
const sourceNames = {
  official: '官服数据',
  vital: 'Vital',
  moose: 'Moose',
  inventory: '库存与 DLC',
  member: '成员查询',
  catalog: '来源目录',
  manual_import: '手动导入',
  legacy_unknown: '旧来源未确认'
};
const statuses = {
  fresh: '已更新',
  stale: '数据过期',
  unavailable: '尚无数据',
  unsupported: '来源不支持',
  private: '库存未公开',
  partial: '部分完成',
  queued: '等待执行',
  running: '正在查询',
  succeeded: '已完成',
  failed: '未完成'
};
const metrics = {
  kills: '击杀',
  deaths: '死亡',
  assists: '助攻',
  kd: 'KD',
  kda: 'KDA',
  t3Kills: 'T3',
  rockets: '火箭',
  sulfur: '硫磺',
  metalOre: '金属矿',
  building: '建筑方块',
  onlineSeconds: '本服在线秒',
  playTimeSeconds: '游戏时长秒'
};
const metricReason = { assists_unsupported: '来源不支持助攻', not_observed: '尚未采集' };
const rateLimitNames = { community: 'Steam 库存', store: 'Steam 商店 DLC', scmm: '库存估值', rusthelp: '库存估值', inventoryEnrichment: '库存估值' };
const rateLimitText = e => {
  const retryAt = Date.parse(e?.retryAt);
  const when = e?.retryAfterKnown === true && Number.isFinite(retryAt) && retryAt > Date.now() ? t('建议 {time} 后手动重试。', { time: time(e.retryAt) }) : t('请稍后手动重试。');
  return t('{source}请求过于频繁，暂时被限流。{when}页面不会自动重复查询。', { source: t(rateLimitNames[e?.sourceId] || '数据源'), when });
};
const errorText = e => e?.errorCode === 'RATE_LIMITED' ? rateLimitText(e) : t(({
  EXPORT_RENDER_FAILED: 'PDF / 图片文件生成失败，请重新提交导出；若再次失败，请联系管理员。',
  EXPORT_TIMEOUT: 'PDF / 图片生成超时，请稍后重新提交导出，或缩小导出范围。',
  EXPORT_RENDERER_STOPPED: '导出服务暂时不可用，请稍后重新提交。',
  EXPORT_CAPACITY: '导出服务正忙，请稍后手动重新提交。',
  EXPORT_GLOBAL_BUSY: '导出服务正忙，请稍后手动重新提交。',
  EXPORT_HTML_LIMIT: '导出内容过多，请缩小筛选或时间范围后重新生成。',
  EXPORT_DOM_LIMIT: '导出内容过多，请缩小筛选或时间范围后重新生成。',
  EXPORT_PAGE_LIMIT: '导出内容过多，请缩小筛选或时间范围后重新生成。',
  EXPORT_OUTPUT_LIMIT: '生成的文件过大，请缩小导出范围后重新生成。',
  EXPORT_TOO_LARGE: '生成的文件过大，请缩小导出范围后重新生成。',
  EXPORT_INVALID_OUTPUT: 'PDF / 图片文件校验失败，请重新提交导出；若再次失败，请联系管理员。',
  EXPORT_INVALID_INPUT: '导出请求无效，请重新选择范围与格式后提交。',
  INVALID_EXPORT_FORMAT: '导出格式无效，请重新选择格式。',
  BINARY_RENDERER_REQUIRED: 'PDF / 图片导出服务尚不可用，请联系管理员；也可改用 HTML、CSV 或 JSON。',
  QUERY_EXPORT_REGENERATE_REQUIRED:'查询内容或可见范围已变化，请重新生成导出文件。',
  MEMBER_QUERY_UNAVAILABLE:'成员查询未完成，请重新提交。',
  VANITY_RESOLVER_REQUIRED:'当前成员查询尚未接入短链接解析，请使用 SteamID 或 /profiles/ 个人主页链接。',
  ACCESS_DENIED:'当前账号没有这项操作的权限，请联系管理员。',
  SOURCE_CONTEXT_REQUIRED:'请填写服务器与来源档期。',
  SOURCE_CONTEXT_CHANGED: '档期的服务器或来源档期已变化，请刷新后重新采集。',
  VITAL_WIPE_CONTEXT_CHANGED: '档期的服务器或来源档期已变化，请刷新后重新采集。',
  VITAL_WIPE_START_REQUIRED: '此档期尚未设置开始时间，请先在档期管理中补全。',
  VITAL_WIPE_NOT_STARTED: '此档期尚未开始，开始后可获取 Vital 战绩。',
  VITAL_WIPE_NOT_FOUND: 'Vital 尚未提供与此服务器和开始时间匹配的档期，请稍后刷新重试。',
  VITAL_WIPE_AMBIGUOUS: 'Vital 返回了多个匹配档期，请由管理员核对来源档期后重试。',
  VITAL_WIPE_INVALID_DATA: 'Vital 档期目录暂时不可用，请稍后刷新重试。',
  SOURCE_WIPE_MISMATCH:'此档期不是 Vital 战绩来源。',
  INVALID_STEAM_INPUT:'请输入有效的 SteamID 或 Steam 个人主页链接。',
  IMPORT_MEMBER_NOT_FOUND:'导入名单中有尚未加入的成员，请核对后重新预览。',
  REVISION_CONFLICT: '版本已经变化，请重新读取并核对后再提交。',
  ROW_REVISION_CONFLICT: '战绩刚刚更新，请重新预览导入。',
  STATS_WRITE_NOT_GRANTED: '此账号未获该动作授权，请由调度接入已审核的权限适配器。',
  SOURCE_UNAVAILABLE: '数据源暂时不可用。可重新提交查询。',
  SOURCE_TIMEOUT: '读取超时，请稍后手动重试。',
  PROXY_UNAVAILABLE: '数据连接暂时不可用，请稍后手动重试。',
  SOURCE_PRIVATE: '库存未公开，暂时无法读取。',
  SOURCE_PAGE_LIMIT: '库存数据超过当前可读取的页数限制。',
  SOURCE_RESPONSE_TOO_LARGE: '库存返回数据过大，暂时无法完整读取。',
  SOURCE_NO_MATCH: '该账号在所选来源没有可读取的数据。',
  INVENTORY_PRIVATE_OR_UNAVAILABLE: '库存未公开或暂时无法读取。',
  CURSOR_EXPIRED: '列表已更新，请返回第一页。',
  STATS_FROZEN: '已结档的战绩不能直接导入，请通过快照修订保留历史。',
  WIPE_IMMUTABLE: '此档期已结束，不能采集新战绩；请查看历史快照。',
  INTERVAL_INSUFFICIENT_DATA: '该区间缺少两次可靠快照，无法计算。',
  INVALID_TIME_RANGE: '请同时填写区间开始和结束，结束须晚于开始。',
  TIME_ZONE_INVALID: '请选择有效时区。',
  INVALID_TIME_ZONE: '请选择有效时区。',
  TIME_INPUT_INVALID: '请选择完整的日期和时间。',
  TIME_AMBIGUOUS: '这个时间遇到夏令时回拨，请选择明确的 UTC 偏移。',
  TIME_NONEXISTENT: '这个当地时间因夏令时调整不存在，请另选时间。',
  TIME_OFFSET_MISMATCH: 'UTC 偏移与所选时区及时间不一致。',
  VITAL_SERVER_REQUIRED: '请输入有效的 Vital 服务器 ID。'
})[e?.errorCode] || '读取失败');
const time = v => v ? new Date(v).toLocaleString(getUiLocale().startsWith('en') ? 'en-US' : 'zh-CN', { timeZone: displayTimeZone(),
  hour12: false
}) : t('尚未观察');
function useOperation(scope = '') {
  const { client } = useApp();
  const [state, setState] = useState({});
  const operation = useRef(null);
  const generation = client.getGeneration();
  useEffect(() => {
    const current = createStatsOperation({ client, onChange: setState, onSaved: notifySuccess });
    operation.current = current; setState({});
    return () => { current.dispose(); if (operation.current === current) operation.current = null; };
  }, [client, generation, scope]);
  const run = useCallback((...args) => operation.current ? operation.current.run(...args)
    : Promise.reject(new ApiError('REQUEST_SUPERSEDED')), []);
  return { run, ...state };
}
const metricLabel = key => t(key === 'onlineSeconds' ? '本服在线时间' : key === 'playTimeSeconds' ? '游戏时长' : key === 't3Kills' ? 'T3 击杀' : metrics[key]);
const compactTime = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(getUiLocale().startsWith('en') ? 'en-US' : 'zh-CN', {
    timeZone: displayTimeZone(), month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date) : t('尚未采集');
};
export function StatsTable({ items = [], metricKeys = Object.keys(metrics), ranking = false,
  workspace = false, primaryMetric, sortOrder = 'desc', onSort, emptyContent }) {
  const number = value => new Intl.NumberFormat(getUiLocale().startsWith('en') ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 }).format(value);
  const metricValue = (row, key) => {
    const value = observedMetric(row, key);
    const label = value === null ? '—' : ['onlineSeconds', 'playTimeSeconds'].includes(key)
      ? t('{hours} 小时', { hours: number(value / 3600) }) : number(value);
    return workspace ? <span className={value === null ? 'stats-missing' : value === 0 ? 'stats-zero' : undefined}>{label}</span> : label;
  };
  if (workspace && !items.length) return emptyContent || <div className="stats-empty-state"><ChartNoAxesCombined aria-hidden="true"/><h3>{t('此范围暂无战绩')}</h3><p>{t('尚未采集的字段显示 —，真实零值显示 0。')}</p></div>;
  return <div className={`stats-table-scroll${workspace ? ' stats-workspace-scroll' : ''}`} tabIndex={workspace ? 0 : undefined} aria-label={workspace ? t('战绩数据表，可横向滚动') : undefined}>
    <table className={`stats-table${ranking ? ' stats-leaderboard-table' : ''}${workspace ? ' stats-dashboard-table' : ''}`}><thead><tr>
      {ranking && <th className={workspace ? 'stats-rank-cell' : undefined} title={t('范围内名次')}>{workspace ? '#' : t('范围内名次')}</th>}
      <th className={workspace ? 'stats-member-cell' : undefined}>{t('成员')}</th>
      {metricKeys.map(key => <th key={key} className={workspace && key === primaryMetric ? 'stats-metric-primary' : undefined}
        aria-sort={workspace && key === primaryMetric ? sortOrder === 'asc' ? 'ascending' : 'descending' : undefined}>
        {workspace && onSort ? <button type="button" className="stats-column-sort" onClick={() => onSort(key)} title={t('按{metric}排序', { metric: metricLabel(key) })}>
          {metricLabel(key)}{key === primaryMetric ? sortOrder === 'asc' ? <ArrowUp aria-hidden="true"/> : <ArrowDown aria-hidden="true"/> : <ArrowUpDown aria-hidden="true"/>}
        </button> : metricLabel(key)}
      </th>)}<th className={workspace ? 'stats-freshness-cell' : undefined}>{t(workspace ? '数据状态' : '来源 / 新鲜度')}</th></tr></thead>
      <tbody>{items.map(row => {
        const name = row.displayName || (row.memberId ? t('受限成员') : t('查询对象'));
        const steamId = /^7656119\d{10}$/.test(row.steamId || '') ? row.steamId : '';
        return <tr key={row.id}>
          {ranking && <td className={workspace ? 'stats-rank-cell' : undefined}>{observedMetric(row, metricKeys[0]) === null ? '—' : row.rank ?? '—'}</td>}
          <td className="stats-member-cell"><div className="stats-member-identity"><Avatar name={name} src={row.avatarUrl}/><div className="stats-member-copy">
            <strong>{name}</strong>{(row.squadName || !workspace && row.memberId) && <small>{row.squadName || row.memberId}</small>}
            {workspace && steamId && <a href={`https://steamcommunity.com/profiles/${steamId}/`} target="_blank" rel="noopener noreferrer" title={t('查看 Steam 个人资料')}>{steamId}<ExternalLink aria-hidden="true"/></a>}
          </div></div></td>
          {metricKeys.map(key => <td key={key} className={workspace && key === primaryMetric ? 'stats-metric-primary' : undefined} title={row.reasons?.[key] ? t(metricReason[row.reasons[key]] || '尚未采集') : ''}>{metricValue(row, key)}</td>)}
          <td className={workspace ? 'stats-freshness-cell' : undefined}><Badge tone={row.status === 'fresh' ? 'success' : ''}>{t(statuses[row.status] || row.status)}</Badge>
            {!workspace && <small>{t(sourceNames[row.sourceId] || row.sourceId)}</small>}
            <small title={time(row.capturedAt)}>{workspace ? compactTime(row.capturedAt) : time(row.capturedAt)}</small></td>
        </tr>;
      })}</tbody></table>
    {!items.length && <div className="empty"><h3>{t('此范围暂无战绩')}</h3><p>{t('可切换来源、档期或筛选；尚未采集的字段显示 —。')}</p></div>}
  </div>;
}
function StatsSquadFilter({ value, onChange }) {
  const { client } = useApp();
  const [cursor, setCursor] = useState(''), [previous, setPrevious] = useState([]);
  const directory = useQuery(client, ['stats', 'squads', cursor], `/api/v2/member-admin/squads?${new URLSearchParams({ limit: '100', archived: 'all', cursor })}`);
  const options = [...new Map([...previous, ...(directory.data?.items || [])].map(squad => [squad.id, squad])).values()];
  return <label>{t('队伍')}<Dropdown value={value} onChange={onChange} aria-label={t('队伍')}>
    <option value="">{t('全部授权队伍')}</option>
    {value && !options.some(squad => squad.id === value) && <option value={value}>{t('当前筛选队伍')}</option>}
    {options.map(squad => <option value={squad.id} key={squad.id}>{squad.name}{squad.archivedAt ? t(' · 已归档') : ''}</option>)}
  </Dropdown>{directory.data?.nextCursor && <Button onClick={() => { setPrevious(options); setCursor(directory.data.nextCursor); }}>{t('加载更多队伍')}</Button>}
    {directory.error && <small>{t('队伍列表读取失败')} <Button onClick={() => { if (cursor) { setPrevious([]); setCursor(''); } else directory.retry().catch(() => {}); }}>{t('重新加载队伍')}</Button></small>}
  </label>;
}

function Job({
  id,
  onDone
}) {
  const [exportId, setExportId] = useState('');
  const [exportOpen, setExportOpen] = useState(false);
  const op = useOperation();
  const {
    client
  } = useApp();
  const q = useQuery(client, ['stats', 'job', id], `/api/v2/stats/jobs/${id}`);
  useEffect(() => {
    if (!['queued', 'running'].includes(q.data?.status)) return;
    const timer = setInterval(() => {
      if (!document.hidden) q.retry().catch(() => {});
    }, 1200);
    return () => clearInterval(timer);
  }, [q.data?.status, q.retry]);
  useEffect(() => {
    if (q.data?.status === 'succeeded') onDone?.(q.data);
  }, [q.data?.status]);
  return <QueryState query={q}>{job => {
    const noMatch = job.kind === 'query' && job.result?.errorCode === 'SOURCE_NO_MATCH';
    const rateLimited = job.result?.errorCode === 'RATE_LIMITED';
    const jobStatus = t(job.status === 'succeeded' && job.result?.status === 'partial' ? '部分完成' : statuses[job.status] || job.status);
    return <div className="stats-job">
      <div className="stats-job-head"><Badge>{noMatch ? t('尚无数据') : jobStatus}</Badge><span>{t("任务")} {job.id.slice(0, 8)}</span></div>
      {job.status === 'failed' && <Notice title={noMatch ? t('未查到来源数据') : rateLimited ? t('查询暂时受限') : t('任务未完成')} tone={noMatch || rateLimited ? undefined : 'error'}>{errorText(job.result)}</Notice>}
      {job.kind === 'export' && job.status === 'succeeded' && <a className="button primary" href={`/api/v2/stats/jobs/${id}/file`}>{t("下载")} {job.result.fileName}</a>}
      {job.kind === 'query' && job.status === 'succeeded' && job.result && !job.result.errorCode && <>
        <QueryResult result={job.result} />
        {job.result.sourceId === 'vital' && <div className="stats-job-actions"><Button onClick={() => setExportOpen(true)}>{t("导出查询结果")}</Button></div>}
        {job.result.sourceId !== 'vital' && job.result.status !== 'unavailable' && job.result.inventory?.status !== 'unavailable' && <div className="stats-job-actions"><Button disabled={op.busy} onClick={async () => {
          try {
            const r = await op.run('/api/v2/stats/exports', {
              queryJobId: id,
              format: 'png',
              language: getUiLocale(),
              timeZone: displayTimeZone()
            });
            setExportId(r.jobId);
          } catch {}
        }}>{t("导出查询图片")}</Button></div>}
        {op.error && <Notice title={t("图片未生成")}>{errorText(op.error)}</Notice>}
        {exportId && <Job id={exportId} />}
        {exportOpen && <ExportDialog query={{ queryJobId: id }} onClose={() => setExportOpen(false)} />}
      </>}
    </div>;
  }}</QueryState>;
}
function InventoryQueryResult({ result: r }) {
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const unavailable = r.inventory?.status === 'unavailable';
  const items = r.inventory?.items || [];
  const visible = items.filter(item => item.name.includes(filter));
  return <>
    <SteamProfileCard result={r} time={time}/>
    <p className="muted">{t("库存与 DLC · 查询于")} {time(r.fetchedAt)} · {t(statuses[r.status] || r.status)}</p>
    {unavailable && <Notice title={t("库存未取得")}>{t("Steam 基础信息已更新；库存物品、估值与 DLC 拥有情况仍未知。")}{r.errors?.length ? ` ${r.errors.map(errorText).join('; ')}` : ''}</Notice>}
    {r.inventory && !unavailable && <>
      <div className="stats-toolbar">
        <label>{t("筛选库存")}<input value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}/></label>
        <span>{t("估值")} {r.inventory.total ?? t('未知')} {r.inventory.currency || ''}</span>
        <span>{t(statuses[r.inventory.status] || r.inventory.status)} {r.inventory.truncated ? t('结果达到上限，请缩小查询范围') : ''}</span>
      </div>
      <table className="stats-table"><thead><tr><th>{t("物品 / DLC")}</th><th>{t("数量")}</th><th>{t("参考价")}</th><th>{t("交易状态")}</th></tr></thead>
        <tbody>{visible.slice(page * 50, page * 50 + 50).map((item, index) => <tr key={`${item.name}:${index}`}>
          <td>{item.name} {item.dlc ? '· DLC' : ''}</td><td>{item.quantity ?? '—'}</td><td>{item.price ?? '—'}</td>
          <td>{item.tradable === null ? t('未知') : item.tradable ? t('可交易') : t('不可交易')}</td>
        </tr>)}</tbody>
      </table>
      <Button disabled={!page} onClick={() => setPage(page - 1)}>{t("上一页")}</Button>
      <Button disabled={(page + 1) * 50 >= visible.length} onClick={() => setPage(page + 1)}>{t("下一页")}</Button>
    </>}
    {!unavailable && !!r.errors?.length && <Notice title={t("部分来源尚未完成")}>{r.errors.map(errorText).join('; ')}</Notice>}
  </>;
}
function QueryResult({ result: r }) {
  if (r.sourceId === 'official') return <OfficialQueryResult result={r} time={time}/>;
  if (r.sourceId === 'inventory') return <InventoryQueryResult result={r}/>;
  return <>
    <p className="muted">{[r.displayName, r.steamId, t(sourceNames[r.sourceId] || r.sourceId), time(r.fetchedAt), t(statuses[r.status] || r.status)].filter(Boolean).join(' · ')}</p>
    {r.sourceId === 'vital' && <p className="muted">{t("Vital 服务器 {server} · 来源档期 {wipe}", { server: r.serverId || t('未知'), wipe: r.providerWipeId || t('未知') })}</p>}
    {r.publicMember && <div className="stats-toolbar">{r.publicMember.avatar && <img src={r.publicMember.avatar} width="48" height="48" alt={t("Steam 头像")} referrerPolicy="no-referrer" onError={e => { e.currentTarget.hidden = true; }}/>}<a href={r.publicMember.profileUrl} target="_blank" rel="noopener noreferrer">{t("查看 Steam 公开主页")}</a></div>}
    {r.rows && r.sourceId !== 'member' && <StatsTable items={r.rows}/>}
    {r.sourceId === 'vital' ? <VitalQueryCategories result={r}/> : !!r.fields?.length && <dl className="stats-fields">{r.fields.map((field, index) => <React.Fragment key={index}><dt>{t(field.name)}</dt><dd>{field.value ?? '—'} <small>{{observed:t('已获取'),not_found:t('未找到'),unavailable:t('暂不可用')}[field.status] || field.status}</small></dd></React.Fragment>)}</dl>}
    {r.items && <ul>{r.items.map((item, index) => <li key={index}>{item.name} · {item.serverId} · {item.providerWipeId} · {item.category}</li>)}</ul>}
    {!!r.errors?.length && <Notice title={t("部分来源尚未完成")}>{r.errors.map(errorText).join('; ')}</Notice>}
  </>;
}
const queryToolSources = ['official', 'inventory', 'vital'];
const queryToolSource = value => queryToolSources.includes(value) ? value : '';
function VitalCatalogJob({ request, onDone, onStatus }) {
  const { client } = useApp();
  const q = useQuery(client, ['stats', 'job', request.id], `/api/v2/stats/jobs/${request.id}`);
  useEffect(() => {
    if (!['queued', 'running'].includes(q.data?.status)) return;
    const timer = setInterval(() => { if (!document.hidden) q.retry().catch(() => {}); }, 1200);
    return () => clearInterval(timer);
  }, [q.data?.status, q.retry]);
  useEffect(() => { if (q.data?.status === 'succeeded') onDone(request, q.data.result); }, [q.data?.status]);
  useEffect(() => { if (q.data?.status || q.error) onStatus(request.id, q.error ? 'failed' : q.data.status); }, [q.data?.status, q.error?.errorCode]);
  if (q.error) return <Notice title={t("目录暂不可用")} action={<Button onClick={q.retry}>{t("重试")}</Button>}>{errorText(q.error)}</Notice>;
  if (q.data?.status === 'failed') return <Notice title={t("目录暂不可用")}>{errorText(q.data.result)}</Notice>;
  if (q.data?.status !== 'succeeded') return <p role="status" className="muted">{t("正在读取 Vital 目录…")}</p>;
  return <p role="status" className="muted">{t("已读取 {count} 项目录；可从列表选择，也可填写来源 ID。", { count: q.data.result?.items?.length || 0 })}</p>;
}
function QueryTools() {
  const { path, go, client } = useApp();
  const params = new URLSearchParams(path.split('?')[1]);
  const [body, setBody] = useState({ sourceId: queryToolSource(params.get('source')),
    steamInput: params.get('steam') || '', serverId: params.get('server') || '', providerWipeId: params.get('providerWipe') || '' });
  const [job, setJob] = useState(params.get('job') || '');
  const [subject, setSubject] = useState(body.steamInput.trim());
  const [catalogRequest, setCatalogRequest] = useState(null), [vitalCatalog, setVitalCatalog] = useState({ servers: [], wipes: [], serverId: '' });
  const op = useOperation();
  useEffect(() => {
    const timer = setTimeout(() => setSubject(body.steamInput.trim()), 250);
    return () => clearTimeout(timer);
  }, [body.steamInput]);
  const permissions = useQuery(client, ['stats', 'query-capabilities', subject],
    '/api/v2/stats/query-capabilities?' + new URLSearchParams(subject ? { steamInput: subject } : {}));
  const currentPermissions = subject === body.steamInput.trim();
  const sources = permissions.data?.sources || [];
  const selected = sources.find(s => s.sourceId === body.sourceId);
  const permitted = currentPermissions && !permissions.error && selected?.read === true && selected?.run === true;
  const vital = body.sourceId === 'vital', contextReady = !vital || !!(body.serverId.trim() && body.providerWipeId.trim());
  const catalogRead = permissions.data?.catalogs?.some(catalog => catalog.provider === 'vital' && catalog.read);
  const wipes = vitalCatalog.serverId === body.serverId.trim() ? vitalCatalog.wipes : [];
  async function readCatalog(kind) {
    try {
      const serverId = kind === 'wipes' ? body.serverId.trim() : '';
      const result = await op.run('/api/v2/stats/queries', { sourceId: 'catalog', provider: 'vital', ...(serverId ? { serverId } : {}) });
      setCatalogRequest({ id: result.jobId, kind, serverId, status: 'queued' });
    } catch {}
  }
  const receivedCatalog = useCallback((request, result) => {
    setVitalCatalog(previous => request.kind === 'servers' ? { ...previous, servers: result?.items || [] }
      : { ...previous, wipes: result?.items || [], serverId: request.serverId });
  }, []);
  const catalogStatus = useCallback((id, status) => {
    setCatalogRequest(previous => previous?.id === id && previous.status !== status ? { ...previous, status } : previous);
  }, []);
  useEffect(() => {
    if (body.sourceId || !permissions.data) return;
    const first = sources.find(s => queryToolSources.includes(s.sourceId) && s.read && s.run);
    if (first) setBody(b => ({ ...b, sourceId: first.sourceId }));
  }, [permissions.data, body.sourceId]);
  useEffect(() => {
    const p = new URLSearchParams(path.split('?')[1]);
    setJob(p.get('job') || '');
    setBody(b => ({ ...b, sourceId: queryToolSource(p.get('source')),
      steamInput: p.get('steam') || '', serverId: p.get('server') || '', providerWipeId: p.get('providerWipe') || '' }));
  }, [path]);
  async function submit(e) {
    e.preventDefault();
    if (!permitted || !contextReady) return;
    try {
      const result = await op.run('/api/v2/stats/queries', { sourceId: body.sourceId, steamInput: body.steamInput.trim(),
        ...(vital ? { serverId: body.serverId.trim(), providerWipeId: body.providerWipeId.trim() } : {}) });
      setJob(result.jobId);
      go('/admin/stats/query?' + new URLSearchParams({ source: body.sourceId, steam: body.steamInput.trim(), job: result.jobId,
        ...(vital ? { server: body.serverId.trim(), providerWipe: body.providerWipeId.trim() } : {}) }));
    } catch {}
  }
  return <><Title eyebrow={t("查询工具")} subtitle={t("查询结果仅对本账号可见，保留一小时；不会创建成员或修改成员主档。")}>{t("独立查询")}</Title><Panel>
    <form onSubmit={submit} className="stats-query-form">
      <label>{t("查询来源")}<Dropdown menuWidth="content" aria-label={t("查询来源")} value={body.sourceId} onChange={e => setBody({ ...body, sourceId: e.target.value })}>
        {!body.sourceId && <option value="">{t("选择查询来源")}</option>}
        {queryToolSources.map(id => {
          const capability = sources.find(s => s.sourceId === id), enabled = capability?.read && capability?.run;
          return <option value={id} key={id} disabled={!!permissions.data && !enabled && !capability?.requiresSubject}>
            {t(sourceNames[id])}{permissions.data && !enabled && !capability?.requiresSubject ? t('（无执行权限）') : ''}</option>;
        })}
      </Dropdown></label>
      <label>{t("SteamID 或个人主页")}<input required placeholder={t("7656119… 或 https://steamcommunity.com/id/…")}
        value={body.steamInput} onChange={e => setBody({ ...body, steamInput: e.target.value })} /></label>
      {vital && <fieldset className="stats-vital-context"><legend>{t("Vital 服务器与历史档期")}</legend>
        <p className="muted">{t("此处选择 Vital 来源档期，不是网站中的战队档期；查询不会修改成员战绩。")}</p>
        <div className="stats-toolbar"><Button disabled={op.busy || !catalogRead || ['queued', 'running'].includes(catalogRequest?.status)} onClick={() => readCatalog('servers')}>{t("读取 Vital 服务器目录")}</Button>
          {!!vitalCatalog.servers.length && <label>{t("Vital 服务器")}<Dropdown menuWidth="content" aria-label={t("Vital 服务器")} value={body.serverId} onChange={e => setBody({ ...body, serverId: e.target.value, providerWipeId: '' })}>
            <option value="">{t("选择服务器")}</option>{vitalCatalog.servers.map(server => <option value={server.serverId} key={server.id}>{server.name} · {server.serverId}</option>)}
          </Dropdown></label>}
          <label>{t("Vital 服务器 ID")}<input required inputMode="numeric" pattern="[0-9]{1,8}" maxLength={8} value={body.serverId} onChange={e => setBody({ ...body, serverId: e.target.value, providerWipeId: '' })}/></label>
        </div>
        <div className="stats-toolbar"><Button disabled={op.busy || !catalogRead || !body.serverId.trim() || ['queued', 'running'].includes(catalogRequest?.status)} onClick={() => readCatalog('wipes')}>{t("读取来源历史档期")}</Button>
          {!!wipes.length && <label>{t("来源历史档期")}<Dropdown menuWidth="content" aria-label={t("来源历史档期")} value={body.providerWipeId} onChange={e => setBody({ ...body, providerWipeId: e.target.value })}>
            <option value="">{t("选择来源档期")}</option>{wipes.map(wipe => <option value={wipe.providerWipeId} key={wipe.id}>{vitalWipeLabel(wipe, getUiLocale(), displayTimeZone())}</option>)}
          </Dropdown></label>}
          <label>{t("Vital 来源档期 ID")}<input required maxLength={120} value={body.providerWipeId} onChange={e => setBody({ ...body, providerWipeId: e.target.value })}/></label>
        </div>
        {catalogRequest && <VitalCatalogJob key={catalogRequest.id} request={catalogRequest} onDone={receivedCatalog} onStatus={catalogStatus}/>}
      </fieldset>}
      <Button type="submit" kind="primary" disabled={op.busy || !permitted || !contextReady}>{op.busy ? t('正在提交…') : t('开始查询')}</Button>
    </form>
    {selected?.requiresSubject && permitted && body.steamInput.trim() && <p className="muted">{t("个人主页短链接将在查询时解析，并再次校验查询对象的权限。")}</p>}
    {selected?.requiresSubject && !permitted && <p className="muted">{t("请填写 SteamID，确认此查询对象是否在授权范围内。")}</p>}
    {permissions.data && currentPermissions && !permitted && !selected?.requiresSubject && !permissions.error && <Notice title={t("当前来源不可执行")}>{t("请切换到已获授权的来源。")}</Notice>}
    {permissions.error && <Notice title={t("权限暂不可用")} action={<Button onClick={permissions.retry}>{t("重新读取权限")}</Button>}>{errorText(permissions.error)}</Notice>}
    {op.error && <Notice title={t("查询未提交")} tone="error">{errorText(op.error)}</Notice>}
  </Panel>{job && <Panel><Job key={job} id={job} /></Panel>}</>;
}

function ImportDialog({
  wipeId,
  onClose,
  onSuccess
}) {
  const {
      client
    } = useApp(),
    [text, setText] = useState(''),
    [preview, setPreview] = useState(null),
    [error, setError] = useState(null);
  const op = useOperation();
  return <Modal title={t("导入战绩")} onClose={onClose} actions={<><Button onClick={onClose}>{t("取消")}</Button>{preview ? <Button kind="primary" disabled={op.busy} onClick={async () => {
      try {
        await op.run('/api/v2/stats/import', {
          wipeId,
          ...preview
        }, '导入已保存');
        onSuccess();
      } catch {}
    }}>{t("确认导入")} {preview.rows.length} {t("条")}</Button> : <Button kind="primary" onClick={async () => {
      try {
        setPreview((await client.request('/api/v2/stats/import/preview', {
          method: 'POST',
          body: {
            wipeId,
            text
          }
        })).data);
        setError(null);
      } catch (e) {
        setError(e);
      }
    }}>{t("校验并预览")}</Button>}</>}><p>{t("支持 CSV / JSON，SteamID 对应既有成员。缺字段保留原值，未知成员或不在本档的成员会拒绝整批。")}</p><label>{t("选择导入文件")}<input type="file" accept=".csv,.json" onChange={async e => {
        const f = e.target.files[0];
        if (f && f.size <= 250000) {
          setText(await f.text());
          setPreview(null);
        }
      }} /></label><label>{t("导入内容")}<textarea rows={9} value={text} onChange={e => {
        setText(e.target.value);
        setPreview(null);
      }} placeholder={'steamId,kills,deaths,assists\n76561198000000501,12,3,5'} /></label>{preview && <Notice title={t("校验通过")}>{t("将导入 {count} 名成员；档期版本 {revision}。", {count:preview.rows.length,revision:preview.expectedRevision})}</Notice>}{(error || op.error) && <Notice title={t("未保存")} tone="error">{errorText(error || op.error)}</Notice>}</Modal>;
}
export function ExportDialog({
  query,
  onClose
}) {
  const [format, setFormat] = useState('csv'),
    [ranking, setRanking] = useState(query.ranking || 'all'),
    [language, setLanguage] = useState(getUiLocale),
    [zone, setZone] = useState(displayTimeZone),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [fromOffset, setFromOffset] = useState(''),
    [toOffset, setToOffset] = useState(''),
    [localError, setLocalError] = useState(null),
    [job, setJob] = useState('');
  const op = useOperation();
  return <Modal title={t(query.queryJobId ? '导出分类查询报告' : '导出当前范围')} onClose={onClose} actions={<><Button onClick={onClose}>{t("关闭")}</Button><Button kind="primary" disabled={op.busy} onClick={async () => {
      try {
        setLocalError(null);
        const range = statsTimeRange({ from, to, timeZone: zone, fromOffset, toOffset });
        const r = await op.run('/api/v2/stats/exports', {
          ...query,
          format,
          language,
          ...(!query.queryJobId ? { ranking } : {}),
          timeZone: zone,
          ...range
        });
        setJob(r.jobId);
      } catch (error) { setLocalError(error); }
    }}>{t("生成导出")}</Button></>}><p>{t(query.queryJobId ? '导出此查询的所选服务器、来源档期与分类数据；保留缺失字段及来源时间。' : '保留筛选、来源、统计口径与快照版本；文件生成在任务中完成。')}</p>
    {!query.queryJobId && <><label>{t("导出榜单")}<Dropdown menuWidth="content" aria-label={t("导出榜单")} value={ranking} onChange={e => setRanking(e.target.value)}>
      <option value="all">{t("全部榜单")}</option>{VITAL_LEADERBOARDS.map(spec => <option value={spec.id} key={spec.id}>{t(spec.label.zh)}</option>)}
    </Dropdown></label>
    <p className="muted">{t("全部榜单选择 PDF 时，将打包七份独立 PDF 为 ZIP；选择单榜可单独导出。CSV 全部榜单保留完整字段表。")}</p></>}
    <div className="stats-toolbar"><label>{t("格式")}<Dropdown menuWidth="content" value={format} onChange={e => setFormat(e.target.value)}>{['csv', 'html', 'pdf', 'png', 'json'].map(k => <option key={k}>{k}</option>)}</Dropdown></label><label>{t("语言")}<Dropdown menuWidth="content" value={language} onChange={e => setLanguage(e.target.value)}>{[['zh', t('中文')], ['en', 'English'], ['ru', 'Русский'], ['tr', 'Türkçe'], ['th', 'ไทย'], ['ko', '한국어']].map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Dropdown></label><label>{t("时区")}<input value={zone} onChange={e => setZone(e.target.value)} /></label></div>
    {!query.queryJobId && <><p className="muted">{t("区间时间按上方所选时区解释，开始与结束必须同时填写。")}</p><div className="stats-toolbar"><label>{t("可选区间开始")}<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} /></label><label>{t("可选区间结束")}<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} /></label></div>
      {(fromOffset || toOffset || ['TIME_AMBIGUOUS', 'TIME_OFFSET_MISMATCH'].includes(localError?.errorCode)) && <div className="stats-toolbar"><label>{t("开始 UTC 偏移")}<input placeholder="-04:00" value={fromOffset} onChange={e => setFromOffset(e.target.value)}/></label><label>{t("结束 UTC 偏移")}<input placeholder="-05:00" value={toOffset} onChange={e => setToOffset(e.target.value)}/></label></div>}</>}
    {(localError || op.error) && <Notice title={t("导出未完成")}>{errorText(localError || op.error)}</Notice>}{job && <Job id={job} />}</Modal>;
}
function RevisionDialog({
  source,
  wipeId,
  revision,
  visibility,
  onClose,
  onSuccess
}) {
  const [corrections, setCorrections] = useState(''),
    [localError, setLocalError] = useState(null),
    [completeness, setCompleteness] = useState('missing_data'),
    op = useOperation();
  const reason = visibility === undefined ? '管理员确认保存历史快照修订' : visibility ? '管理员确认隐藏历史档案' : '管理员确认恢复历史档案';
  return <Modal title={visibility === undefined ? t('保存历史快照修订') : visibility ? t('隐藏历史档案') : t('恢复历史档案')} onClose={onClose} actions={<><Button onClick={onClose}>{t("取消")}</Button><Button kind="primary" disabled={op.busy} onClick={async () => {
      try {
        await op.run(visibility === undefined ? '/api/v2/stats/archives' : '/api/v2/stats/visibility', {
          wipeId,
          expectedRevision: revision,
          reason,
          ...(visibility === undefined ? {
            sourceId: source,
            completeness,
            ...(corrections.trim() ? {
              corrections: JSON.parse(corrections)
            } : {})
          } : {
            hidden: visibility
          })
        }, '保存成功');
        onSuccess();
      } catch (e) {
        setLocalError(e);
      }
    }}>{t("确认保存")}</Button></>}><p>{visibility === undefined ? t('确认后保存当前来源的新修订；原快照与原导出版本仍可查看。') : visibility ? t('确认后普通成员无法查询；管理员可恢复，原始记录始终保留。') : t('确认后普通成员将重新可以查询此档案；原始记录始终保留。')}</p>{visibility === undefined && <label>{t("数据完整度")}<Dropdown menuWidth="content" value={completeness} onChange={e => setCompleteness(e.target.value)}><option value="missing_data">{t("仍有缺数")}</option><option value="complete">{t("本来源数据已完整")}</option></Dropdown></label>}{visibility === undefined && <label>{t("可选战绩修正（JSON）")}<textarea rows={4} value={corrections} onChange={e => setCorrections(e.target.value)} placeholder={t('[{"memberId":"成员ID","values":{"kills":12}}]')} /></label>}{(op.error || localError) && <Notice title={t("未保存")} tone="error">{errorText(op.error || localError)}</Notice>}</Modal>;
}
function IntervalDialog({
  query,
  onClose
}) {
  const {
      client
    } = useApp(),
    [memberId, setMember] = useState(''),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [zone, setZone] = useState(displayTimeZone),
    [fromOffset, setFromOffset] = useState(''),
    [toOffset, setToOffset] = useState(''),
    [data, setData] = useState(null),
    [error, setError] = useState(null);
  return <Modal title={t("区间战绩")} onClose={onClose} actions={<Button onClick={async () => {
    try {
      setData((await client.request('/api/v2/stats/interval', {
        method: 'POST',
        body: {
          ...query,
          memberId,
          ...statsTimeRange({ from, to, timeZone: zone, fromOffset, toOffset, required: true })
        }
      })).data);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }}>{t("计算区间")}</Button>}><p>{t("仅使用同服、同来源、同来源档期且版本递增的两次采样；来源重置会标为断点。")}</p><label>{t("成员 ID")}<input value={memberId} onChange={e => setMember(e.target.value)} /></label><label>{t("时区")}<input value={zone} onChange={e => setZone(e.target.value)}/></label><label>{t("开始")}<input type="datetime-local" value={from} onChange={e => setFrom(e.target.value)} /></label><label>{t("结束")}<input type="datetime-local" value={to} onChange={e => setTo(e.target.value)} /></label>{(fromOffset || toOffset || ['TIME_AMBIGUOUS', 'TIME_OFFSET_MISMATCH'].includes(error?.errorCode)) && <div className="stats-toolbar"><label>{t("开始 UTC 偏移")}<input placeholder="-04:00" value={fromOffset} onChange={e => setFromOffset(e.target.value)}/></label><label>{t("结束 UTC 偏移")}<input placeholder="-05:00" value={toOffset} onChange={e => setToOffset(e.target.value)}/></label></div>}{data && <><p>{data.item.coverage === 'discontinuity' ? t('检测到来源重置，区间不可用') : t('{from} 至 {to}', { from: time(data.from), to: time(data.to) })}</p><StatsTable items={[data.item]} /></>}{error && <Notice title={t("无法计算")}>{errorText(error)}</Notice>}</Modal>;
}
function HistoryDetails({
  wipeId,
  revision,
  canAudit
}) {
  const {
    client
  } = useApp();
  const [open, setOpen] = useState(false),
    [after, setAfter] = useState(''),
    [before, setBefore] = useState('');
  const roster = useQuery(client, ['stats', 'archive-roster', wipeId, revision, after], `/api/v2/stats/wipes/${wipeId}/history/${revision}/participants?after=${encodeURIComponent(after)}`, {
    enabled: open && revision > 0
  });
  const audit = useQuery(client, ['stats', 'audit', wipeId, before], `/api/v2/stats/wipes/${wipeId}/audit?before=${before}`, {
    enabled: open && canAudit
  });
  return <div className="stats-archive-actions"><Button onClick={() => setOpen(true)}>{t("查看档案参与名单与操作记录")}</Button>{open && <Modal title={t("档案参与名单与操作记录")} onClose={() => setOpen(false)} actions={<Button onClick={() => setOpen(false)}>{t("关闭")}</Button>}><div className="stats-archive-records">{revision > 0 && <QueryState query={roster}>{data => <><table className="stats-table"><thead><tr><th>{t("归档成员")}</th><th>{t("原始回复")}</th><th>{t("预计到场")}</th></tr></thead><tbody>{data.items.map(r => <tr key={r.memberId}><td>{r.displayName || r.memberId}</td><td>{r.response ? t(responseLabel[r.response] || r.response) : t('未回复')}</td><td>{time(r.expectedArrivalAt)}</td></tr>)}</tbody></table>{!data.items.length && <p className="muted">{t("此快照没有可见参与记录，未用当前报名回填历史。")}</p>}{data.nextAfter && <Button onClick={() => setAfter(data.nextAfter)}>{t("更多参与者")}</Button>}</>}</QueryState>}{canAudit && <QueryState query={audit}>{data => <><ul>{data.items.map(r => <li key={r.id}>{time(r.occurredAt)} · {r.action} · {r.reason}</li>)}</ul>{!data.items.length && <p className="muted">{t('暂无可见操作记录')}</p>}{data.nextBefore && <Button onClick={() => setBefore(String(data.nextBefore))}>{t("更早操作")}</Button>}</>}</QueryState>}</div></Modal>}</div>;
}
export function StatsSyncNotice({ job, pending, error, onRetry }) {
  if (error) return <Notice title={t('战绩采集未完成')} tone="error" action={<Button onClick={onRetry}>{t('重试')}</Button>}>{errorText(error)}</Notice>;
  if (!job) return pending ? <Notice title={t('正在提交战绩采集…')}>{t('正在获取此档期全部授权成员的数据。')}</Notice> : null;
  const titles = { queued: '战绩采集已排队', running: '正在采集当前档期战绩', retry_wait: '战绩采集等待重试', paused: '战绩采集已暂停',
    succeeded: '战绩采集已完成', partial: '战绩采集部分完成', partial_failed: '战绩采集部分完成', failed: '战绩采集失败',
    cancelled: '战绩采集已取消', expired: '战绩采集已过期', no_work: '此档期暂无可采集成员' };
  const counts = job.counts;
  return <Notice title={t(titles[job.status] || '战绩采集已提交')} tone={['failed', 'expired'].includes(job.status) ? 'error' : undefined}>
    <span>{counts && <>{t('已处理 {done}/{total} 位成员 · 成功 {succeeded} · 部分完成 {partial} · 失败 {failed} · 跳过 {skipped}', {
      done: counts.total - counts.pendingOrRunning, total: counts.total, succeeded: counts.succeeded, partial: counts.partial || 0, failed: counts.failed, skipped: counts.skipped
    })}<br/></>}{['queued', 'running'].includes(job.status) && <>{t('采集期间会自动更新当前战绩。')}<br/></>}</span>
    {job.reason && <>{errorText({ errorCode: job.reason })}<br/></>}
    <AppLink to={`/admin/sync/jobs/${encodeURIComponent(job.id)}`}>{t('到同步中心查看任务')}</AppLink>
  </Notice>;
}
export default function StatsWorkspace() {
  const { path, go, client } = useApp();
  const isQuery = path.split('?')[0] === '/admin/stats/query';
  const params = new URLSearchParams(path.split('?')[1]);
  const wipeId = params.get('wipe') || '', source = 'vital', revision = Number(params.get('revision') || 0);
  const [dialog, setDialog] = useState(''), [syncState, setSyncState] = useState(null);
  const generation = client.getGeneration(), syncScope = `${generation}:${wipeId}`;
  const currentScope = useRef(syncScope), mounted = useRef(false), lastSyncProgress = useRef('');
  currentScope.current = syncScope;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const currentSync = syncState?.scope === syncScope ? syncState : null;
  const ranking = leaderboardById(params.get('ranking'));
  const metricKeys = ranking ? [ranking.metric] : Object.keys(metrics);
  const requestedSort = params.get('sort') || 'kills';
  const query = { wipeId, sourceId: source, metricVersion: 'nb-kda-1', revision,
    q: params.get('q') || '', sort: ranking?.metric || (metricKeys.includes(requestedSort) ? requestedSort : metricKeys[0]),
    order: ranking ? 'desc' : params.get('order') === 'asc' ? 'asc' : 'desc', squadId: params.get('squad') || '', cursor: params.get('cursor') || '' };
  const [draftQ, setDraftQ] = useState(query.q), [draftSquad, setDraftSquad] = useState(query.squadId);
  const filterDirty = draftQ.trim() !== query.q || draftSquad !== query.squadId;
  const filtered = !!(query.q || query.squadId);
  const catalog = useQuery(client, ['stats', 'wipes', 'vital', params.get('hidden'), params.get('wc')], `/api/v2/stats/wipes?${new URLSearchParams({ provider: 'vital', hidden: params.get('hidden') || '', cursor: params.get('wc') || '' })}`, { enabled: !isQuery });
  const sources = useQuery(client, ['stats', 'sources', wipeId], `/api/v2/stats/wipes/${encodeURIComponent(wipeId)}/sources`, { enabled: !!wipeId && !isQuery });
  const supported = sources.data?.wipe?.supportsVitalStats === true;
  const historyQuery = useQuery(client, ['stats', 'history', 'vital', wipeId, params.get('hb')], `/api/v2/stats/wipes/${encodeURIComponent(wipeId)}/history?${new URLSearchParams({ before: params.get('hb') || '', sourceId: 'vital' })}`, { enabled: !!wipeId && !isQuery && supported });
  const rows = useQuery(client, ['stats', 'rows', query], `/api/v2/stats/rows?${new URLSearchParams(query)}`, { enabled: !!wipeId && !isQuery && supported });
  const update = values => go('/admin/stats?' + statsWorkspaceParams(params, values), { scroll: Object.hasOwn(values, 'wipe') });
  useEffect(() => { setDraftQ(query.q); setDraftSquad(query.squadId); }, [wipeId, revision, query.q, query.squadId]);
  useEffect(() => { setDialog(''); }, [wipeId]);
  useEffect(() => {
    if (!wipeId && !isQuery && catalog.data?.items?.length) update({ wipe: (catalog.data.items.find(wipe => wipe.lifecycle === 'active') || catalog.data.items[0]).id, source: 'vital' });
  }, [catalog.data, wipeId, isQuery]);
  useEffect(() => {
    if (!isQuery && params.has('source') && params.get('source') !== 'vital') update({ source: 'vital', revision: '' });
  }, [path, isQuery]);
  const reload = () => {
    setDialog(''); client.invalidateQueries(['stats']);
    if (wipeId) sources.retry().catch(() => {});
    if (supported) { rows.retry().catch(() => {}); historyQuery.retry().catch(() => {}); }
    catalog.retry().catch(() => {});
  };
  const clearFilters = () => { setDraftQ(''); setDraftSquad(''); if (filtered) update({ q: '', squad: '' }); };
  const actions = sources.data?.actions || {};
  const terminal = ['ended', 'archived', 'cancelled'].includes(sources.data?.wipe?.lifecycle);
  const readBusy = catalog.loading || catalog.refreshing || (wipeId && (sources.loading || sources.refreshing || (supported && (rows.loading || rows.refreshing))));
  const expectedRevision = sources.data?.wipe?.revision;
  const requestSync = useCallback(async () => {
    if (!wipeId || !actions.sync || expectedRevision == null) return;
    setSyncState(previous => ({ ...(previous?.scope === syncScope ? previous : {}), scope: syncScope, pending: true, error: null }));
    const current = () => mounted.current && currentScope.current === syncScope && client.getGeneration() === generation;
    try {
      const job = await requestStatsSync(client, { wipeId, expectedRevision });
      if (current()) setSyncState({ scope: syncScope, job, pending: false });
    } catch (error) { if (current()) setSyncState({ scope: syncScope, error, pending: false }); }
  }, [client, generation, syncScope, wipeId, expectedRevision, actions.sync]);
  const jobId = currentSync?.job?.id;
  const syncStatus = useQuery(client, ['stats', 'sync-job', wipeId, jobId], `/api/v2/stats/sync/${encodeURIComponent(jobId || '')}`, { enabled: !!jobId && !isQuery && revision === 0 });
  const syncJob = syncStatus.data || currentSync?.job;
  const syncActive = revision === 0 && (currentSync?.pending || statsSyncIsActive(syncJob));
  useEffect(() => {
    if (!jobId || isQuery || revision !== 0 || syncStatus.error) return;
    const delay = statsSyncPollDelay(syncJob);
    if (delay === null) return;
    const timer = setTimeout(() => syncStatus.retry().catch(() => {}), delay);
    return () => clearTimeout(timer);
  }, [jobId, isQuery, revision, syncJob, syncStatus.error, syncStatus.retry]);
  const syncProgress = statsSyncProgressKey(syncStatus.data);
  const syncFinished = !!syncStatus.data && !statsSyncIsActive(syncStatus.data);
  useEffect(() => {
    if (!syncProgress || isQuery || revision !== 0) return;
    const progress = `${syncScope}:${syncProgress}`;
    if (lastSyncProgress.current === progress) return;
    lastSyncProgress.current = progress;
    client.invalidateQueries(['stats', 'rows']);
    if (syncFinished) {
      client.invalidateQueries(['stats', 'sources', wipeId]);
      client.invalidateQueries(['stats', 'history', 'vital', wipeId]);
    }
  }, [client, wipeId, syncScope, isQuery, revision, syncProgress, syncFinished]);
  const moreActions = [actions.import && !terminal && ['import', '导入战绩'], !revision && actions.sync && ['sync', '同步战绩'],
    actions.archive && terminal && ['revision', '保存快照修订'], actions.visibility && terminal && ['visibility', sources.data?.visibility.hidden ? '恢复档案' : '隐藏档案'],
    supported && ['interval', '区间战绩']].filter(Boolean);
  const nav = <nav className="stats-tabs" aria-label={t('战绩管理')}><AppLink to="/admin/stats" aria-current={!isQuery ? 'page' : undefined}>{t('档期战绩与历史')}</AppLink><AppLink to="/admin/stats/query" aria-current={isQuery ? 'page' : undefined}>{t('独立查询')}</AppLink></nav>;
  if (isQuery) return <div className="stats-workspace">{nav}<QueryTools key={path.split('?')[0]}/></div>;
  const summary = rows.data ? statsPageSummary(rows.data.items) : null;
  const snapshotWipe = rows.data?.wipe || sources.data?.wipe;
  const sortColumn = key => update({ sort: key, order: query.sort === key && query.order === 'desc' ? 'asc' : 'desc' });
  const emptyContent = <div className="stats-empty-state"><ChartNoAxesCombined aria-hidden="true"/>
    <h3>{t(filtered ? '没有匹配的成员' : revision ? '此快照暂无可见战绩' : '此档期尚无战绩')}</h3>
    <p>{t(filtered ? '试试其他姓名或队伍，或清除筛选查看当前授权范围。' : revision ? '历史快照只展示当时保存的数据，不会用当前战绩补齐。' : actions.sync || (actions.import && !terminal) ? '可以同步或导入此档期的 Vital 战绩，也可以先独立查询单个账号。' : '此档期尚未采集到可见战绩；可切换档期或独立查询账号。')}</p>
    <div className="stats-empty-actions">{filtered ? <Button onClick={clearFilters}>{t('清除筛选')}</Button> : <>
      {!revision && actions.sync && <Button kind="primary" disabled={syncActive} onClick={() => requestSync()}>{t(syncActive ? '正在采集…' : '同步战绩')}</Button>}
      {!revision && actions.import && !terminal && <Button onClick={() => setDialog('import')}>{t('导入战绩')}</Button>}
      <AppLink className="button" to="/admin/stats/query?source=vital">{t('独立查询')}</AppLink></>}</div>
  </div>;
  return <div className="stats-workspace stats-dashboard">{nav}
    <header className="stats-page-header"><div><p className="eyebrow">{t('管理空间 / 战绩')}</p><h1 tabIndex={-1}>{t('战绩与历史')}</h1><p>{t('按档期查看成员表现、七项榜单与历史快照。')}</p></div>
      <div className="stats-page-actions"><Button onClick={reload} disabled={!!readBusy} title={t('刷新已保存数据')}><RefreshCw size={15} aria-hidden="true"/>{t(readBusy ? '正在刷新…' : '刷新')}</Button>
        {actions.export && <Button kind="primary" disabled={!!readBusy || filterDirty} onClick={() => setDialog('export')} title={filterDirty ? t('请先应用筛选，再导出相同范围。') : undefined}><Download size={15} aria-hidden="true"/>{t('导出筛选范围')}</Button>}
        {!!moreActions.length && <Dropdown className="stats-more-control" value="" disabled={syncActive} aria-label={t('更多操作')} onChange={e => e.target.value === 'sync' ? requestSync() : setDialog(e.target.value)}><option value="">{t('更多操作')}</option>{moreActions.map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</Dropdown>}
      </div></header>
    <Panel className="panel stats-context-panel"><div className="stats-context-grid">
      <label>{t('档期')}<Dropdown menuWidth="content" value={wipeId} onChange={e => update({ wipe: e.target.value, revision: '', source: 'vital' })}><option value="">{t('选择档期')}</option>
        {wipeId && !catalog.data?.items?.some(wipe => wipe.id === wipeId) && <option value={wipeId}>{sources.data?.wipe?.title || wipeId}</option>}
        {catalog.data?.items?.map(wipe => <option value={wipe.id} key={wipe.id}>{wipe.title}{wipe.hidden ? t(' · 已隐藏') : ''}</option>)}
      </Dropdown></label>
      <label>{t('快照版本')}<Dropdown menuWidth="content" value={revision} disabled={!supported} onChange={e => update({ revision: e.target.value })}><option value="0">{t('当前战绩')}</option>
        {revision > 0 && !historyQuery.data?.items?.some(item => item.revision === revision) && <option value={revision}>{t('修订')} {revision}</option>}
        {historyQuery.data?.items?.map(item => <option value={item.revision} key={item.revision}>{t('修订')} {item.revision} · {time(item.createdAt)} · {t(item.reason)}</option>)}
      </Dropdown></label></div>
      <div className="stats-context-note"><Badge>Vital</Badge><span>{revision ? t('历史修订 {revision}', { revision }) : t('当前数据')}</span>{revision > 0 && <span>{snapshotWipe?.title}</span>}<span>{displayTimeZone()}</span>
        <label className="stats-check"><input type="checkbox" checked={params.get('hidden') === '1'} onChange={e => update({ hidden: e.target.checked ? '1' : '' })}/>{t('包含隐藏档案')}</label>
      </div>
      <div className="stats-history-links">{historyQuery.data?.nextBefore && <Button onClick={() => update({ hb: String(historyQuery.data.nextBefore) })}>{t('更早快照')}</Button>}{params.get('hb') && <Button onClick={() => update({ hb: '' })}>{t('最新快照列表')}</Button>}
        {catalog.data?.nextCursor && <Button onClick={() => update({ wc: catalog.data.nextCursor })}>{t('更多档期')}</Button>}{params.get('wc') && <Button onClick={() => update({ wc: '' })}>{t('返回最新档期')}</Button>}
      </div>
      {catalog.error && <Notice title={t('档期暂不可用')} action={<Button onClick={catalog.retry}>{t('重试')}</Button>}>{errorText(catalog.error)}</Notice>}
      {historyQuery.error && <Notice title={t('快照列表暂不可用')} action={<Button onClick={historyQuery.retry}>{t('重试')}</Button>}>{errorText(historyQuery.error)}</Notice>}
      {!wipeId && catalog.data?.items?.length === 0 && <Notice title={t('暂无 Vital 档期')}>{t('当前授权范围内没有可查询的 Vital 档期。')}</Notice>}
    </Panel>
    {!!wipeId && supported && <div><form className="stats-filter-form" onSubmit={event => { event.preventDefault(); if (filterDirty) update({ q: draftQ.trim(), squad: draftSquad }); }}>
      <label>{t('搜索成员')}<input value={draftQ} onChange={e => setDraftQ(e.target.value)} placeholder={t('姓名 / SteamID')}/></label>
      <StatsSquadFilter key={`${wipeId}:${client.getGeneration()}`} value={draftSquad} onChange={e => setDraftSquad(e.target.value)}/>
      <Button type="submit" kind="primary" disabled={!filterDirty || !!readBusy}>{t('应用筛选')}</Button><Button disabled={!filtered && !filterDirty} onClick={clearFilters}>{t('清除筛选')}</Button>
    </form><p className="stats-filter-status" role="status">{t(filterDirty ? '筛选尚未应用，按 Enter 或点击应用筛选。' : filtered ? '筛选已应用，榜单和导出使用相同范围。' : '当前显示全部授权成员，可按姓名或队伍筛选。')}</p></div>}
    {!revision && <StatsSyncNotice job={syncJob} pending={currentSync?.pending} error={currentSync?.error || syncStatus.error} onRetry={() => syncStatus.error && jobId ? syncStatus.retry().catch(() => {}) : requestSync()}/>}
    {wipeId && sources.error && <Notice title={t('档期来源读取失败')} tone="error" action={<Button onClick={sources.retry}>{t('重试')}</Button>}>{errorText(sources.error)}</Notice>}
    {wipeId && !sources.data && !sources.error && <div className="stats-loading-state" role="status">{t('正在读取战绩…')}</div>}
    {wipeId && sources.data?.wipe?.supportsVitalStats === false && <Panel><Notice title={t('此档期不支持 Vital 战绩')}>{sources.data.wipe.title} {t('使用其他服务器来源；当前档期战绩页仅查询 Vital 战绩。')}</Notice><AppLink className="button" to="/admin/stats">{t('查看 Vital 档期')}</AppLink></Panel>}
    {wipeId && supported && <Panel className="panel stats-results-panel" aria-busy={rows.loading || rows.refreshing || undefined}>
      {(!rows.data || rows.data.items.length > 0) && <div className="stats-page-summary">
        {[['本页成员', summary?.members], ['本页已更新', summary?.fresh], ['本页过期数据', summary?.stale]].map(([label, value]) => <div className="stats-summary-card" key={label}><span className="stats-summary-label">{t(label)}</span><strong className="stats-summary-value">{value ?? '—'}</strong></div>)}
        <div className="stats-summary-card stats-summary-time"><span className="stats-summary-label">{t('本页最近采集')}</span><strong className="stats-summary-value" title={summary?.lastCaptured ? time(summary.lastCaptured) : undefined}>{summary ? compactTime(summary.lastCaptured) : '—'}</strong></div>
      </div>}
      <nav className="stats-board-tabs" aria-label={t('Vital 榜单视图')}><button type="button" aria-pressed={!ranking} onClick={() => update({ ranking: '', category: '' })}>{t('数据总览')}</button>
        {VITAL_LEADERBOARDS.map(spec => <button type="button" key={spec.id} aria-pressed={ranking?.id === spec.id} title={t(spec.label.zh)} onClick={() => update({ ranking: spec.id, sort: spec.metric, order: 'desc', category: '' })}>{metricLabel(spec.metric)}</button>)}
      </nav>
      <div className="stats-results-heading"><div><h2>{t(ranking?.label.zh || '数据总览')}</h2><p>{t(ranking ? '名次仅在当前授权与筛选范围内计算；同分并列，未提供的字段不参与排名。' : '尚未采集的字段显示 —，真实零值显示 0。')}{rows.refreshing ? ` ${t('正在刷新…')}` : ''}</p></div>
        {ranking ? <Badge>{t('按{metric}从高到低', { metric: metricLabel(ranking.metric) })}</Badge> : <div className="stats-sort-controls"><label>{t('排序')}<Dropdown value={query.sort} onChange={e => update({ sort: e.target.value })}>{metricKeys.map(key => <option value={key} key={key}>{metricLabel(key)}</option>)}</Dropdown></label>
          <label>{t('顺序')}<Dropdown value={query.order} onChange={e => update({ order: e.target.value })}><option value="desc">{t('从高到低')}</option><option value="asc">{t('从低到高')}</option></Dropdown></label></div>}
      </div>
      {rows.error?.errorCode === 'CURSOR_EXPIRED' && query.cursor && <Notice title={t('列表已更新，请返回第一页。')} action={<Button onClick={() => update({ cursor: '' })}>{t('返回第一页')}</Button>}/>}
      {!rows.data && !rows.error ? <div className="stats-loading-state" role="status">{t('正在读取战绩…')}</div> : <QueryState query={rows}>{data => <>
        {data.archive && <Notice title={t('修订 {revision} · {status}', { revision: data.revision, status: data.archive.completeness === 'complete' ? t('数据完整') : t('保留缺数说明') })}>{data.archive.reason} · {time(data.archive.createdAt)}</Notice>}
        <StatsTable workspace items={data.items} metricKeys={metricKeys} ranking={!!ranking} primaryMetric={query.sort} sortOrder={query.order} onSort={ranking ? undefined : sortColumn} emptyContent={emptyContent}/>
        <div className="stats-results-footer"><div><p>{data.items.length ? t('显示第 {from}–{to} 位成员 · 仅当前授权与筛选范围', { from: (data.rowOffset || 0) + 1, to: (data.rowOffset || 0) + data.items.length }) : t('本页没有可见成员')}</p>{metricKeys.length > 6 && !!data.items.length && <p>{t('横向滚动可查看全部指标。')}</p>}
          {(revision > 0 || actions.visibility || actions.archive) && <HistoryDetails key={wipeId + ':' + revision} wipeId={wipeId} revision={revision} canAudit={actions.visibility || actions.archive}/>}
        </div><div className="stats-pagination"><Button disabled={!query.cursor || !!readBusy} onClick={() => update({ cursor: '' })}>{t('第一页')}</Button><Button disabled={!data.nextCursor || !!readBusy} onClick={() => { const next = new URLSearchParams(params); next.set('cursor', data.nextCursor); go('/admin/stats?' + next, { scroll: false }); }}>{t('下一页')}</Button></div></div>
      </>}</QueryState>}
      <details className="stats-rules"><summary>{t('指标说明与数据口径')}</summary><p>{t('KD = 击杀 ÷ max(死亡, 1)；缺助攻时 KDA 不计算。在线时长以小时展示。')}{summary?.unobserved ? ` ${t('本页 {count} 位成员尚无已采集指标。', { count: summary.unobserved })}` : ''}</p></details>
    </Panel>}
    {dialog === 'import' && <ImportDialog wipeId={wipeId} onClose={() => setDialog('')} onSuccess={reload}/>}
    {dialog === 'export' && <ExportDialog query={{ ...query, ranking: ranking?.id || 'all', expectedDataRevision: rows.data?.dataRevision, cursor: '' }} onClose={() => setDialog('')}/>}
    {dialog === 'revision' && <RevisionDialog source={source} wipeId={wipeId} revision={sources.data.archiveRevision} onClose={() => setDialog('')} onSuccess={reload}/>}
    {dialog === 'visibility' && <RevisionDialog wipeId={wipeId} revision={sources.data.visibility.revision} visibility={!sources.data.visibility.hidden} onClose={() => setDialog('')} onSuccess={reload}/>}
    {dialog === 'interval' && <IntervalDialog query={query} onClose={() => setDialog('')}/>}
  </div>;
}
