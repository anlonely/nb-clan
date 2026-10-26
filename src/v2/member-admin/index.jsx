import { displayTimeZone } from '../display-preferences.js';
import { t, getUiLocale } from '../i18n.js';
import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { useApp, AppLink } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { Title, Panel, Button, Badge, Notice, Modal, QueryState, Avatar } from '../ui.jsx';
import { memberOperations } from './operation.js';
import './style.css';
import { Select } from '../select.jsx';
import { specialties, timeZoneOptions } from '../../../shared/member-preferences.js';
import { visibleHistory, historyDescription } from './history.js';
import { groupRiskAlerts } from './risk-view.js';
const root = '/admin/members',
  api = '/api/v2/member-admin';
const statusLabels = {
  active: '正常',
  suspended: '暂停',
  left: '离队',
  blocked: '黑名单'
};
const tabs = [['', '成员名单'], ['squads', '队伍管理'], ['risks', '风险复核'], ['departed', '离队检测']];
function SpecialtyChips({ values, labels }) {
  return <span className="ma-specialty-chips" aria-label={t('专长')}>
    {values?.length ? values.map((key, index) => <span className={`specialty-chip tone-${index % 4}`} key={key}>{t(labels[key] || key)}</span>) : <span className="specialty-chip empty">{t('未填写专长')}</span>}
  </span>;
}
const messages = {
  REVISION_CONFLICT: '资料已被其他人更新。重新读取后再确认修改。',
  CURSOR_EXPIRED: '列表内容或权限已变化，请返回第一页。',
  ACCESS_DENIED: '当前账号无此操作权限。',
  PROTECTED_ACCOUNT: '此成员关联受保护的管理账号，无法执行该操作。',
  CANNOT_DELETE_CURRENT_MEMBER: '不能删除当前登录账号的成员档案，请由另一名有权限的管理员操作。',
  MEMBER_EXISTS: '该 SteamID 已存在。',
  VERIFIED_IDENTITY_IMMUTABLE: '此 Steam 归属已有身份记录，请通过身份复核处理。',
  MEMBER_INACTIVE: '此成员已暂停、离队或受限。',
  RISK_EVIDENCE_CHANGED: '风险证据已变化，请刷新后重新复核。',
  STEAM_RESOLUTION_REQUIRED: '请输入 17 位 SteamID 或数字 Steam 个人主页链接；别名链接需先解析。',
  IMPORT_PREVIEW_CHANGED: '名单在预览后已变化，请重新校验预览。',
  SYNC_ADAPTER_REQUIRED: '同步服务尚未接线，未启动采集。',
  IDENTITY_ADAPTER_REQUIRED: '身份解绑服务尚未接线，未修改身份。',
  IDENTITY_OBSERVATION_REQUIRED: '请先读取当前平台关联，再确认解绑。',
  IDENTITY_OBSERVATION_CHANGED: '平台关联已变化，请重新读取并确认。',
  TRUSTED_ROOT_REQUIRED: '此操作仅超管可执行。',
  OPERATION_NOT_FOUND: '暂未找到已提交回执。可按原操作编号重试。'
};
const errorText = e => t(messages[e?.errorCode] || e?.errorCode || '操作失败，请重试。');
const date = s => s ? new Date(s).toLocaleString(getUiLocale().startsWith('en') ? 'en-US' : 'zh-CN', { timeZone: displayTimeZone(),
  hour12: false
}) : t('未记录');
function Field({
  label,
  children
}) {
  return <label className="ma-field"><span>{label}</span>{children}</label>;
}
function useData(name, path) {
  const {
    client
  } = useApp();
  return useQuery(client, ['member-admin', name, path], api + path, {
    ttlMs: 15000
  });
}
function Pages({
  data,
  params,
  path
}) {
  const {
    go
  } = useApp();
  return <footer className="ma-pagination"><span>{t('授权范围内 {count} 条', { count: data.total })}</span><Button onClick={() => {
      const p = new URLSearchParams(params);
      p.delete('cursor');
      go(path + '?' + p);
    }} disabled={!params.get('cursor')}>{t("第一页")}</Button><Button disabled={!data.nextCursor} onClick={() => {
      const p = new URLSearchParams(params);
      p.set('cursor', data.nextCursor);
      go(path + '?' + p);
    }}>{t("下一页")}</Button></footer>;
}
function OperationNotice({
  ops,
  state
}) {
  if (['idle', 'success'].includes(state.status)) return null;
  return <Notice tone={['error', 'conflict'].includes(state.status) ? 'error' : ''} title={{
    submitting: t('正在保存…'),
    unknown: t('提交结果待确认'),
    conflict: t('需要重新确认'),
    error: t('操作未完成')
  }[state.status]} action={<div className="ma-actions">{state.status === 'unknown' ? <><Button onClick={() => ops.recover()}>{t("查询提交结果")}</Button><Button onClick={() => ops.retry()}>{t("使用原编号重试")}</Button></> : state.status !== 'submitting' && <Button onClick={() => ops.dismiss()}>{t("收起")}</Button>}</div>}>{state.error ? errorText(state.error) : state.status === 'unknown' ? t('保持原操作编号，确认结果后再进行下一项操作。') : state.data?.requested !== undefined ? t('共 {requested} 行：导入 {imported}，跳过 {skipped}，失败 {failed}。', { requested: state.data.requested, imported: state.data.imported, skipped: state.data.skipped, failed: state.data.failed }) : state.data?.recovered ? t('已从持久回执确认保存成功。') : null}{state.data?.results?.filter(r => r.status !== 'imported').map((r, i) => <span className="ma-result" key={i}>{r.input} · {r.status === 'skipped' ? t('跳过') : t('失败')} · {errorText({
        errorCode: r.code
      })}</span>)}</Notice>;
}
export default function MemberAdmin() {
  const {
    client,
    path
  } = useApp();
  const url = new URL(path, 'http://local'),
    parts = url.pathname.slice(root.length).split('/').filter(Boolean),
    section = parts[0] || 'list';
  const options = useData('options', '/options');
  const [ops] = useState(() => memberOperations(client)),
    state = useSyncExternalStore(ops.subscribe, ops.snapshot, ops.snapshot);
  useEffect(() => ops.restore(), [ops]);
  const busy = ['unknown', 'submitting'].includes(state.status);
  const act = async (...args) => ops.begin(...args);
  if (['reviews', 'archive'].includes(section)) return <Notice title={t("此功能已移除")}><AppLink to={root}>{t("返回成员名单")}</AppLink></Notice>;
  return <section className="ma-workspace"><nav className="ma-tabs" aria-label={t("成员管理")}>{tabs.map(([slug, label]) => <AppLink className={section === 'list' && !slug || section === slug ? 'active' : ''} key={slug} to={root + (slug ? '/' + slug : '')}>{t(label)}</AppLink>)}</nav><OperationNotice ops={ops} state={state} /><QueryState query={options}>{o => section === 'profile' ? <MemberDetail key={parts[1]} id={parts[1]} options={o} act={act} busy={busy} operationState={state} operations={ops} /> : section === 'squads' ? <SquadPage options={o} act={act} busy={busy} /> : section === 'risks' ? <RiskPage options={o} params={url.searchParams} act={act} busy={busy} /> : <MemberList departed={section === 'departed'} options={o} params={url.searchParams} act={act} busy={busy} />}</QueryState></section>;
}
function SpecialtyFields({
  options,
  value,
  onChange
}) {
  return <fieldset className="ma-specialties"><legend>{t("专长（可多选）")}</legend>{Object.entries(specialties).map(([k, v]) => <label key={k}><input type="checkbox" checked={value.includes(k)} onChange={e => onChange(e.target.checked ? [...value, k] : value.filter(x => x !== k))} />{t(v)}</label>)}</fieldset>;
}
function MemberSteamValue({member}) {
  const id = member.steamId || member.declaredSteamId;
  return id ? <><a className="ma-steam" href={'https://steamcommunity.com/profiles/' + id} target="_blank" rel="noreferrer">{id}</a>{!member.steamId && <small className="ma-steam-declaration">{t("Discord 自行登记，未验证")}</small>}</> : <span>{t("尚未验证 Steam")}</span>;
}
function MemberForm({
  member,
  options,
  onSave,
  busy,
  close
}) {
  const {
    client
  } = useApp();
  const [resolveError, setResolveError] = useState(''),
    [resolving, setResolving] = useState(false);
  const [fields, set] = useState(() => Object.fromEntries(['customName', 'discordId', 'discordName', 'wechatId', 'phone', 'notes', 'region', 'timezone', 'battlemetricsId', 'vitalVipType', 'vitalVipPurchasedAt', 'vitalVipExpiresAt', 'atlasVipType', 'atlasVipPurchasedAt', 'atlasVipExpiresAt'].map(k => [k, member?.[k] || (k.endsWith('VipType') ? 'none' : '')]))),
    [specialty, setSpecialty] = useState(member?.specialty || []),
    [steam, setSteam] = useState(member?.steamId || '');
  const change = (k, v) => set(prev => ({
    ...prev,
    [k]: v
  }));
  return <form onSubmit={e => {
    e.preventDefault();
    const next = {
      ...fields,
      specialty
    };
    if (member) for (const k of Object.keys(next)) if (JSON.stringify(next[k]) === JSON.stringify(member[k] ?? (k.endsWith('VipType') ? 'none' : ''))) delete next[k];
    onSave({
      steamInput: steam,
      fields: next,
      ...(member ? {
        expectedRevision: member.revision
      } : {})
    });
  }}><div className="ma-form-grid"><Field label={t("SteamID / 数字主页链接")}><input required={!member} value={steam} onChange={e => setSteam(e.target.value)} readOnly={member?.identity?.steamBinding === 'verified'} />{!member && <Button disabled={resolving || !steam} onClick={async () => {
          setResolving(true);
          setResolveError('');
          try {
            const r = await client.request(api + '/resolve-steam', {
              method: 'POST',
              body: {
                steamInput: steam
              },
              headers: {
                'Idempotency-Key': crypto.randomUUID()
              }
            });
            setSteam(r.data.steamId);
          } catch (e) {
            setResolveError(e);
          } finally {
            setResolving(false);
          }
        }}>{t("解析 Steam 链接")}</Button>}{resolveError && <span role="alert">{errorText(resolveError)}</span>}</Field><Field label={t("站内名称")}><input maxLength={80} value={fields.customName} onChange={e => change('customName', e.target.value)} /></Field>{[['phone', t('联系电话')], ['discordId', 'Discord ID'], ['discordName', t('Discord 名称')], ['wechatId', t('微信号')], ['battlemetricsId', 'BattleMetrics ID'], ['region', t('地区')]].map(([k, l]) => <Field label={l} key={k}><input maxLength={160} value={fields[k]} onChange={e => change(k, e.target.value)} /></Field>)}<Field label={t("时区")}><Select value={fields.timezone} onChange={e => change('timezone', e.target.value)}><option value="">{t("未设置（由成员浏览器确定）")}</option>{timeZoneOptions(fields.timezone).map(zone => <option key={zone} value={zone}>{zone}</option>)}</Select></Field>{[['vital', 'Vital'], ['atlas', 'Atlas']].map(([prefix, title]) => <React.Fragment key={prefix}><Field label={title + t(' VIP 类型')}><Select value={fields[prefix + 'VipType']} onChange={e => change(prefix + 'VipType', e.target.value)}><option value="none">{t("无")}</option><option value="priority">{t("优先通道")}</option><option value="queue_skip">{t("免排队")}</option></Select></Field><Field label={title + t(' VIP 购买日期')}><input type="date" value={fields[prefix + 'VipPurchasedAt']} onChange={e => change(prefix + 'VipPurchasedAt', e.target.value)} required={fields[prefix + 'VipType'] !== 'none'} /></Field><Field label={title + t(' VIP 到期日期')}><input type="date" value={fields[prefix + 'VipExpiresAt']} onChange={e => change(prefix + 'VipExpiresAt', e.target.value)} /></Field></React.Fragment>)}</div><SpecialtyFields options={options} value={specialty} onChange={setSpecialty} /><Field label={t("内部备注")}><textarea value={fields.notes} onChange={e => change('notes', e.target.value)} maxLength={1000} /></Field><div className="ma-actions"><Button type="submit" kind="primary" disabled={busy}>{t("保存成员")}</Button>{close && <Button onClick={close}>{t("取消")}</Button>}</div></form>;
}
function MemberList({
  departed,
  options,
  params,
  act,
  busy
}) {
  const {
      go,
      client
    } = useApp(),
    [adding, setAdding] = useState(false),
    [importing, setImporting] = useState(false),
    [exporting, setExporting] = useState(false),
    [deleting, setDeleting] = useState(false),
    [assigning, setAssigning] = useState(false),
    [bulkSquad, setBulkSquad] = useState(''),
    [selected, setSelected] = useState({}),
    [selectionScope, setSelectionScope] = useState('none'),
    [selectionBusy, setSelectionBusy] = useState(false),
    [selectionError, setSelectionError] = useState(''),
    [q, setQ] = useState(params.get('q') || ''),
    [scanning, setScanning] = useState(false),
    [scanProgress, setScanProgress] = useState(null),
    [scanError, setScanError] = useState('');
  const selectionRequest = useRef(0), scanController = useRef(null);
  const query = new URLSearchParams(params);
  if (departed) query.set('departure', '1');
  query.set('limit', '20');
  const data = useData('members', '/members?' + query),
    squads = useData('squads', '/squads?limit=100');
  const base = root + (departed ? '/departed' : ''),
    selectedItems = Object.values(selected),
    selectionKeyParams = new URLSearchParams(params);
  selectionKeyParams.delete('cursor');
  selectionKeyParams.delete('from');
  const selectionKey = selectionKeyParams.toString();
  const clearSelection = () => {
    selectionRequest.current += 1;
    setSelected({});
    setSelectionScope('none');
    setSelectionBusy(false);
    setSelectionError('');
  };
  const filter = (k, v) => {
    const p = new URLSearchParams(params);
    p.delete('cursor');
    v ? p.set(k, v) : p.delete(k);
    clearSelection();
    go(base + '?' + p);
  };
  useEffect(() => {
    clearSelection();
  }, [selectionKey, departed]);
  useEffect(() => {
    setQ(params.get('q') || '');
  }, [params.get('q')]);
  const togglePage = items => {
    const every = items.length > 0 && items.every(member => selected[member.id]);
    selectionRequest.current += 1;
    const next = {
      ...selected
    };
    for (const member of items) every ? delete next[member.id] : next[member.id] = member;
    setSelected(next);
    setSelectionScope(Object.keys(next).length ? every || Object.keys(selected).length ? 'manual' : 'page' : 'none');
    setSelectionBusy(false);
    setSelectionError('');
  };
  const toggleMember = (member, checked) => {
    selectionRequest.current += 1;
    const next = {
      ...selected
    };
    checked ? next[member.id] = member : delete next[member.id];
    setSelected(next);
    setSelectionScope(Object.keys(next).length ? 'manual' : 'none');
    setSelectionBusy(false);
    setSelectionError('');
  };
  const selectFiltered = async expectedTotal => {
    if (expectedTotal > 100) return;
    const request = ++selectionRequest.current,
      generation = client.getGeneration();
    setSelectionBusy(true);
    setSelectionError('');
    try {
      const all = new URLSearchParams(query);
      all.delete('cursor');
      all.delete('from');
      all.set('limit', '100');
      const result = await client.request(api + '/members?' + all);
      if (request !== selectionRequest.current || generation !== client.getGeneration()) return;
      if (result.data.total > 100 || result.data.nextCursor) throw new Error('当前筛选结果已超过 100 人，请缩小筛选范围后再全选。');
      setSelected(Object.fromEntries(result.data.items.map(member => [member.id, member])));
      setSelectionScope('filtered');
    } catch (error) {
      if (request === selectionRequest.current && generation === client.getGeneration()) setSelectionError(error);
    } finally {
      if (request === selectionRequest.current) setSelectionBusy(false);
    }
  };
  useEffect(() => () => scanController.current?.abort(), [departed]);
  const scanAll = async () => {
    if (scanning) return;
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    setScanError('');
    let cursor = '', progress = { scannedMembers: 0, checkedBindings: 0, flagged: 0, failed: 0, skipped: 0 };
    try {
      do {
        const result = await client.request(api + '/members/departure-scan', {
          method: 'POST', body: cursor ? { cursor } : {}, signal: controller.signal, timeoutMs: 90000
        });
        for (const key of Object.keys(progress)) progress[key] += result.data[key] || 0;
        setScanProgress({ ...progress, running: Boolean(result.data.nextCursor) });
        cursor = result.data.nextCursor || '';
      } while (cursor && !controller.signal.aborted);
      if (!controller.signal.aborted) await data.retry();
    } catch (error) {
      if (!controller.signal.aborted) setScanError(error);
    } finally {
      if (scanController.current === controller) scanController.current = null;
      setScanning(false);
    }
  };
  const squadContext = params.get('from') === 'squads' && params.get('squadId') ? squads.data?.items.find(squad => squad.id === params.get('squadId')) : null;
  return <><Title eyebrow={t("成员管理")} subtitle={departed ? t('按当前 Discord 与 KOOK 准入角色核验；仅列出已确认失去准入的在队成员。') : t('查找成员，维护组织归属与资料。')} actions={<div className="ma-actions">{departed ? <><Button kind="primary" disabled={scanning} onClick={scanAll}>{scanning ? t('正在核验…') : t('核验平台身份')}</Button></> : <><Button onClick={() => setExporting(true)}>{t("导出名单")}</Button>{options.permissions.create && <><Button onClick={() => setImporting(true)}>{t("批量导入")}</Button><Button kind="primary" onClick={() => setAdding(true)}>{t("新增成员")}</Button></>}</>}</div>}>{departed ? t('离队检测') : t('成员名单')}</Title>{departed && <Panel className="panel ma-departure-guide"><p>{t("分别使用 Discord、KOOK 的网站登录准入服务器和角色规则，核验成员当前是否仍在群且具有准入角色。角色查询失败不会判定为离队。")}</p><div className="ma-actions"><AppLink className="button" to="/admin/platforms/discord#login">{t("配置 Discord 准入角色")}</AppLink><AppLink className="button" to="/admin/platforms/kook#login">{t("配置 KOOK 准入角色")}</AppLink><a className="button" href="#departure-results">{t("查看核验结果")}</a></div></Panel>}{departed && scanProgress && <Notice title={scanning ? t('准入角色核验中') : t('准入角色核验完成')}>{t('已扫描 {members} 名成员、{bindings} 个平台绑定；本轮发现 {flagged} 项准入失效，{failed} 项查询失败（未判定为离队）。', { members: scanProgress.scannedMembers, bindings: scanProgress.checkedBindings, flagged: scanProgress.flagged, failed: scanProgress.failed })}</Notice>}{departed && scanError && <Notice title={t("核验未完成")} tone="error">{errorText(scanError)}</Notice>}{squadContext && <div className="ma-squad-context"><div><small>{t("正在查看队伍成员")}</small><strong>{squadContext.name}</strong><span>{t("仅展示当前权限可见的成员。")}</span></div><Button onClick={() => go(root + '/squads')}>{t("← 返回队伍列表")}</Button></div>}<Panel id={departed ? "departure-results" : undefined}>{departed && <h2 className="ma-departure-results-title">{t("核验结果")}</h2>}<form className="ma-filters" onSubmit={e => {
        e.preventDefault();
        filter('q', q);
      }}><Field label={t("搜索名称或 SteamID")}><input value={q} onChange={e => setQ(e.target.value)} placeholder={t("输入名称或 SteamID")} /></Field><Button type="submit">{t("搜索")}</Button><Field label={t("成员状态")}><Select value={query.get('status') || ''} onChange={e => filter('status', e.target.value)}><option value="">{t("全部状态")}</option>{Object.entries(statusLabels).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field><Field label={t("所属队伍")}><Select value={params.get('squadId') || ''} onChange={e => filter('squadId', e.target.value)}><option value="">{t("全部队伍")}</option><option value="__unassigned">{t("未分队")}</option>{squads.data?.items.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field><Field label={t("专长")}><Select value={params.get('specialty') || ''} onChange={e => filter('specialty', e.target.value)}><option value="">{t("全部专长")}</option>{Object.entries(specialties).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field><Field label="VIP"><Select value={params.get('vip') || ''} onChange={e => filter('vip', e.target.value)}><option value="">{t("全部")}</option><option value="none">{t("无")}</option><option value="priority">{t("优先")}</option><option value="queue_skip">{t("免排队")}</option></Select></Field></form><QueryState query={data}>{d => <>{d.items.length ? <><div className="ma-selection-bar"><label><input type="checkbox" aria-label={t("全选当前页")} disabled={selectionBusy} checked={d.items.every(member => selected[member.id])} onChange={() => togglePage(d.items)} />{t('当前页（{count}）', { count: d.items.length })}</label><Button disabled={selectionBusy || d.total > 100 || selectionScope === 'filtered' && selectedItems.length === d.total} onClick={() => selectFiltered(d.total)}>{selectionBusy ? t('正在选择…') : t('全选当前筛选（{count}）', { count: d.total })}</Button><span>{t('选择范围：{scope} · 已选 {count} 人', { scope: ({ none:t('未选择'), page:t('当前页'), filtered:t('当前筛选全部'), manual:t('手动选择') })[selectionScope], count: selectedItems.length })}</span>{selectedItems.length > 0 && <Button onClick={clearSelection}>{t("清除选择")}</Button>}{d.total > 100 && <small>{t("当前筛选超过 100 人，请缩小范围后再全选。")}</small>}{selectedItems.length > 100 && <small role="alert">{t("已手动选择超过 100 人，请减少选择后再执行批量操作。")}</small>}{selectionError && <small role="alert">{typeof selectionError === 'string' ? t(selectionError) : selectionError.message ? t(selectionError.message) : errorText(selectionError)}</small>}</div><div className="ma-table"><table><thead><tr><th><input type="checkbox" aria-label={t("全选当前页成员")} title={t("仅选择当前页")} disabled={selectionBusy} checked={d.items.every(member => selected[member.id])} onChange={() => togglePage(d.items)} /></th><th>{t("成员 / SteamID")}</th><th>{t("队伍")}</th><th>{t("专长")}</th><th>{t("状态")}</th>{!departed && <><th>{t("风险摘要")}</th></>}{departed && <th>{t("平台核验")}</th>}<th>{t("操作")}</th></tr></thead><tbody>{d.items.map(m => <tr key={m.id}><td><input aria-label={t('选择 {name}', { name: m.displayName })} type="checkbox" disabled={selectionBusy} checked={Boolean(selected[m.id])} onChange={e => toggleMember(m, e.target.checked)} /></td><td><div className="ma-member"><AppLink to={root + '/profile/' + m.id} aria-label={t('查看 {name}', { name: m.displayName })}><Avatar name={m.displayName} src={m.avatar}/></AppLink><div><AppLink className="ma-name" to={root + '/profile/' + m.id}>{m.displayName}</AppLink><MemberSteamValue member={m}/></div></div></td><td>{m.squadId ? m.squadName : t('未分队')}</td><td><SpecialtyChips values={m.specialty} labels={options.specialties} /></td><td><Badge tone={m.memberStatus === 'active' ? 'success' : 'warning'}>{t(statusLabels[m.memberStatus])}</Badge></td>{!departed && <><td>{m.riskSummary ? t('{count} 条待复核', { count: m.riskSummary.count }) : '—'}</td></>}{departed && <td>{m.platformAudits?.filter(a => ['missing_role', 'not_in_guild'].includes(a.status)).map(a => <div className="ma-platform-audit" key={a.provider}><strong>{a.provider === 'discord' ? 'Discord' : 'KOOK'}</strong><span>{a.status === 'missing_role' ? t('准入角色已丢失') : t('不在准入群组')}</span><small>{t("核验于")} {date(a.checkedAt)}</small></div>)}</td>}<td><AppLink to={root + '/profile/' + m.id}>{t("查看档案 →")}</AppLink></td></tr>)}</tbody></table></div><div className="ma-actions"><Button disabled={!selectedItems.length || selectedItems.length > 100 || busy} onClick={() => setAssigning(true)}>{t("批量调整队伍")}</Button>{options.permissions.create && <Button disabled={!selectedItems.length || selectedItems.length > 100 || busy || selectedItems.some(m => !m.canDelete)} onClick={() => setDeleting(true)}>{t('删除所选（{count}）', { count: selectedItems.length })}</Button>}</div></> : <div className="ma-empty">{departed ? t('当前没有经核验确认失去准入角色的在队成员。可点击“核验平台身份”更新结果。') : t('当前筛选没有成员。调整筛选条件或新增成员。')}</div>}<Pages data={d} params={params} path={base} />{assigning && <ConfirmDialog title={t("批量调整队伍")} description={t('将同时核验 {count} 名成员的版本与来源/目标队伍权限；仅在全部通过后保存。', { count: selectedItems.length })} busy={busy} close={() => setAssigning(false)} onConfirm={() => act('/members/assign', {
            targets: selectedItems.map(m => ({
              id: m.id,
              expectedRevision: m.revision
            })),
            squadId: bulkSquad || null
          }).then(r => {
            if (r) {
              setAssigning(false);
              clearSelection();
            }
          })}><Field label={t("批量目标队伍")}><Select value={bulkSquad} onChange={e => setBulkSquad(e.target.value)}><option value="">{t("未分队")}</option>{squads.data?.items.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field></ConfirmDialog>}{deleting && <ConfirmDialog title={t("删除所选成员")} confirmLabel={t('确认删除 {count} 人', { count: selectedItems.length })} description={t('将永久删除 {count} 名成员的个人资料和绑定投影，并撤销关联访问。历史游玩、排行榜与报名记录保留。此操作无法恢复。', { count: selectedItems.length })} busy={busy} close={() => setDeleting(false)} onConfirm={() => act('/members/delete', {
            targets: selectedItems.map(m => ({
              id: m.id,
              expectedRevision: m.revision
            }))
          }).then(r => {
            if (r) {
              setDeleting(false);
              clearSelection();
            }
          })} />}</>}</QueryState></Panel>{adding && <Modal title={t("新增成员")} onClose={() => setAdding(false)}><MemberForm options={options} busy={busy} close={() => setAdding(false)} onSave={body => act('/members', body).then(r => {
        if (r) {
          setAdding(false);
          go(root + '/profile/' + r.id);
        }
      })} /></Modal>}{importing && <ImportDialog options={options} busy={busy} act={act} close={() => setImporting(false)} />} {exporting && <ExportDialog params={query} close={() => setExporting(false)} />}</>;
}
function ConfirmDialog({
  title,
  description,
  busy,
  close,
  onConfirm,
  confirmLabel = '确认操作',
  children
}) {
  return <Modal title={title} onClose={close}><form onSubmit={e => {
      e.preventDefault();
      onConfirm();
    }}><div className="ma-confirm-warning" role="note"><strong>{t("请确认操作范围与后果")}</strong><p>{description}</p></div>{children}<div className="ma-actions"><Button type="submit" kind="primary" disabled={busy}>{t(confirmLabel)}</Button><Button onClick={close}>{t("取消")}</Button></div></form></Modal>;
}
const platformNames = { discord: 'Discord', kook: 'KOOK', wechat: '微信' };
function UnlinkDialog({ id, provider, busy, act, close, operationState, operations }) {
  const { client } = useApp();
  const [submitting, setSubmitting] = useState(false), [error, setError] = useState(null);
  const locked = useRef(false), controller = useRef(null);
  const unlinkPath = '/api/v2/member-admin/members/' + encodeURIComponent(id) + '/unlink';
  const isPendingUnlink = state => state.status === 'unknown' && state.provider === provider && state.path === unlinkPath;
  useEffect(() => () => controller.current?.abort(), []);
  const confirm = async () => {
    const current = operations.snapshot(), pendingUnlink = isPendingUnlink(current);
    if ((busy || ['unknown', 'submitting'].includes(current.status)) && !pendingUnlink || locked.current) return;
    locked.current = true; setSubmitting(true); setError(null);
    const generation = client.getGeneration();
    controller.current = new AbortController();
    const active = () => !controller.current.signal.aborted && generation === client.getGeneration();
    try {
      if (pendingUnlink) {
        await operations.recover();
        if (!active()) return;
        if (operations.snapshot().status === 'unknown') await operations.retry();
        if (!active()) return;
        if (operations.snapshot().status === 'success') close();
        else setError(operations.snapshot().error);
        return;
      }
      const { data: observation } = await client.request(`/api/v2/member-adapters/members/${encodeURIComponent(id)}/unlink-observation?provider=${provider}`, { signal: controller.current.signal });
      if (!active()) return;
      if (observation?.memberId !== id || observation.provider !== provider ||
        !Number.isSafeInteger(observation.expectedRevision) || observation.expectedRevision < 0 ||
        typeof observation.expectedIdentityFingerprint !== 'string' || !observation.expectedIdentityFingerprint) throw {errorCode: 'INVALID_RESPONSE'};
      const result = await act('/members/' + encodeURIComponent(id) + '/unlink', {
        provider, expectedRevision: observation.expectedRevision,
        expectedIdentityFingerprint: observation.expectedIdentityFingerprint
      });
      if (!active()) return;
      if (operations.snapshot().status === 'unknown') await operations.recover();
      if (!active()) return;
      if (operations.snapshot().status === 'unknown') await operations.retry();
      if (!active()) return;
      if (result || operations.snapshot().status === 'success') close();
      else setError(operations.snapshot().error);
    } catch (e) {
      if (active()) setError(e);
    } finally { locked.current = false; setSubmitting(false); }
  };
  return <Modal title={t('请确认操作')} onClose={() => { if (!locked.current) close(); }}><form onSubmit={e => { e.preventDefault(); return confirm(); }}>
    <p>{t('解除 {provider} 的关联并撤销相关登录会话。Steam 归属保留。', { provider: t(platformNames[provider]) })}</p>
    {error && <Notice tone="error" title={errorText(error)} />}
    {operationState.status === 'unknown' && <p role="status">{t('解绑结果待确认')}</p>}
    <div className="ma-actions"><Button type="submit" kind="primary" disabled={submitting || busy && !isPendingUnlink(operationState)}>{t('确认解绑')}</Button><Button disabled={submitting} onClick={() => {if (!locked.current) close();}}>{t('取消')}</Button></div>
  </form></Modal>;
}
function ImportDialog({
  options,
  busy,
  act,
  close
}) {
  const {
    client
  } = useApp();
  const [preview, setPreview] = useState(null),
    [previewError, setPreviewError] = useState(''),
    [previewBusy, setPreviewBusy] = useState(false);
  const [text, setText] = useState(''),
    [specialty, setSpecialty] = useState([]),
    [squadId, setSquadId] = useState(''),
    [vip, setVip] = useState({});
  const squads = useData('squads', '/squads?limit=100');
  return <Modal title={t("批量导入成员")} onClose={close}><form onChange={() => setPreview(null)} onSubmit={async e => {
      e.preventDefault();
      if (!preview) {
        setPreviewBusy(true);
        setPreviewError('');
        try {
          const r = await client.request(api + '/members/import/preview', {
            method: 'POST',
            body: {
              text,
              fields: {
                specialty,
                ...vip
              },
              squadId: squadId || null
            }
          });
          setPreview(r.data);
        } catch (error) {
          setPreviewError(error);
        } finally {
          setPreviewBusy(false);
        }
        return;
      }
      act('/members/import', {
        text,
        fields: {
          specialty,
          ...vip
        },
        squadId: squadId || null,
        previewHash: preview.previewHash
      }).then(r => {
        if (r) close();
      });
    }}><p>{t("每行一个 17 位 SteamID 或数字主页链接，最多 200 行。重复条目跳过，失败条目单独列出。")}</p><Field label={t("导入文本")}><textarea className="ma-import" required value={text} onChange={e => setText(e.target.value)} maxLength={60000} /></Field><Field label={t("导入目标队伍")}><Select value={squadId} onChange={e => setSquadId(e.target.value)}><option value="">{t("未分队")}</option>{squads.data?.items.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field><div className="ma-form-grid">{[['vital', 'Vital'], ['atlas', 'Atlas']].map(([prefix, title]) => <React.Fragment key={prefix}><Field label={title + t(' VIP 类型')}><Select value={vip[prefix + 'VipType'] || 'none'} onChange={e => setVip({
              ...vip,
              [prefix + 'VipType']: e.target.value
            })}><option value="none">{t("无")}</option><option value="priority">{t("优先通道")}</option><option value="queue_skip">{t("免排队")}</option></Select></Field><Field label={title + t(' VIP 购买日期')}><input type="date" value={vip[prefix + 'VipPurchasedAt'] || ''} onChange={e => setVip({
              ...vip,
              [prefix + 'VipPurchasedAt']: e.target.value
            })} required={Boolean(vip[prefix + 'VipType'] && vip[prefix + 'VipType'] !== 'none')} /></Field></React.Fragment>)}</div><SpecialtyFields options={options} value={specialty} onChange={setSpecialty} />{previewError && <Notice title={errorText(previewError)} tone="error" />}{preview && <Notice title={t("预览：新增 ") + preview.added + t(" / 重复 ") + preview.skipped + t(" / 无效 ") + preview.failed}>{preview.rows.map((r, i) => <span className="ma-result" key={i}>{r.input} · {r.status === 'new' ? t('新增') : r.status === 'skipped' ? t('跳过') : t('无效')}</span>)}</Notice>}<Button type="submit" kind="primary" disabled={busy || previewBusy}>{preview ? t('执行导入') : t('校验并预览')}</Button></form></Modal>;
}
function ExportDialog({
  params,
  close
}) {
  const {
      client
    } = useApp(),
    [fields, setFields] = useState(['displayName', 'steamId', 'squadName', 'specialty', 'memberStatus']),
    [result, setResult] = useState(null),
    [error, setError] = useState(null),
    [loading, setLoading] = useState(false);
  const available = {
    displayName: '名称',
    steamId: 'SteamID',
    squadName: '队伍',
    specialty: '专长',
    memberStatus: '状态',
    phone: '电话（管理权限）',
    notes: '备注（管理权限）',
    discordId: 'Discord',
    wechatId: '微信',
    battlemetricsId: 'BMID',
    vitalVipType: 'VIP 类型',
    vitalVipPurchasedAt: 'VIP 购买',
    vitalVipExpiresAt: 'VIP 到期',
    atlasVipType: 'Atlas VIP',
    atlasVipPurchasedAt: 'Atlas 购买',
    atlasVipExpiresAt: 'Atlas 到期'
  };
  const run = async cursor => {
    setLoading(true);
    setError(null);
    try {
      const q = new URLSearchParams(params);
      q.set('fields', fields.join(','));
      q.set('limit', '100');
      q.delete('cursor');
      if (cursor) q.set('cursor', cursor);
      const r = await client.request(api + '/members/export?' + q);
      const blob = new Blob([r.data.csv], {
          type: 'text/csv;charset=utf-8'
        }),
        url = URL.createObjectURL(blob),
        a = document.createElement('a');
      a.href = url;
      a.download = '成员名单.csv';
      a.click();
      URL.revokeObjectURL(url);
      setResult(r.data);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  };
  return <Modal title={t("导出成员名单")} onClose={close}><p>{t("按当前筛选和权限导出，每批最多 100 人。敏感字段必须具备成员编辑权限。")}</p><div className="ma-specialties">{Object.entries(available).map(([k, v]) => <label key={k}><input type="checkbox" checked={fields.includes(k)} onChange={e => {
          setResult(null);
          setFields(e.target.checked ? [...fields, k] : fields.filter(f => f !== k));
        }} />{t(v)}</label>)}</div>{error && <Notice tone="error" title={errorText(error)} />}<div className="ma-actions"><Button disabled={!fields.length || loading} onClick={() => run()}>{t("下载 CSV")}</Button>{result?.nextCursor && <Button onClick={() => run(result.nextCursor)} disabled={loading}>{t("下载下一批")}</Button>}</div>{result && <p>{t('本次筛选共 {count} 人，', { count: result.total })}{result.nextCursor ? t('还有下一批。') : t('已到最后一批。')}</p>}</Modal>;
}
function PlatformBindings({ bindings, canUnlink, onUnlink }) {
  const status = { verified: '已验证', historical: '历史关联，未验证', record_only: '仅有资料记录', unlinked: '未关联' };
  return <section className="panel ma-platform-bindings"><h2>{t("平台关联")}</h2>{!bindings ? <p className="muted">{t("当前账号无法查看平台关联。")}</p> : <div className="ma-platform-binding-list">{bindings.map(binding =>
    <article className="ma-platform-binding" key={binding.provider}>
      <div className="ma-platform-binding-heading"><strong>{t(platformNames[binding.provider])}</strong><Badge tone={binding.status === 'verified' ? 'success' : ''}>{t(status[binding.status] || '未关联')}</Badge></div>
      {binding.externalId && <p><span>{t("平台 ID")}</span><code>{binding.externalId}</code></p>}
      {binding.recordedId && <p><span>{t("资料记录")}</span><code>{binding.recordedId}</code></p>}
      {binding.displayName && <p><span>{t("名称")}</span>{binding.displayName}</p>}
      {binding.verifiedAt && <p><span>{t("验证时间")}</span>{date(binding.verifiedAt)}</p>}
      {canUnlink && binding.canUnlink && <Button onClick={() => onUnlink(binding.provider)}>{t("解除")} {t(platformNames[binding.provider])} {t("关联")}</Button>}
    </article>)}
  </div>}</section>;
}
function MemberDetail({
  id,
  options,
  act,
  busy,
  operationState,
  operations
}) {
  const { go } = useApp();
  const data = useData('detail', '/members/' + id),
    history = useData('history', '/history/member/' + id),
    squads = useData('squads', '/squads?limit=100');
  const [editing, setEditing] = useState(false),
    [action, setAction] = useState(null),
    [nextStatus, setNextStatus] = useState('active'),
    [squadId, setSquad] = useState(''),
    [unlinkProvider, setUnlinkProvider] = useState(null);
  return <><AppLink className="ma-back-link" to={root}><span aria-hidden="true">←</span> {t("返回成员名单")}</AppLink><QueryState query={data}>{m => <><Title eyebrow={t("成员档案")} subtitle={`${m.steamId || m.declaredSteamId || t("尚未验证 Steam")} · ${m.squadId ? m.squadName : t('未分队')}`} ><span className="ma-member"><Avatar name={m.displayName} src={m.avatar}/>{m.displayName}</span></Title>{m.canEdit && !m.deletedAt && <div className="ma-profile-toolbar"><div className="ma-profile-toolbar-sync">{m.steamId && <><SyncControls kind="steam" memberIds={[id]} label={t("更新Steam资料")} /><SyncControls kind="battlemetrics" memberIds={[id]} label={t("更新BMID")} /><SyncControls kind="kda" memberIds={[id]} label={t("更新KD")} /></>}</div><div className="ma-profile-toolbar-actions"><Button kind="primary" onClick={() => setEditing(true)}>{t("编辑资料")}</Button>{m.canDelete && <Button onClick={() => setAction('delete')}>{t("删除成员")}</Button>}</div></div>}<div className="ma-detail-grid"><Panel><h2>{t("身份与组织")}</h2><dl className="ma-info"><dt>SteamID</dt><dd><MemberSteamValue member={m}/></dd><dt>{t("当前队伍")}</dt><dd>{m.squadId ? m.squadName : t('未分队')}</dd><dt>{t("成员状态")}</dt><dd>{t(statusLabels[m.memberStatus])}{m.deletedAt ? t(' · 已删除') : ''}</dd><dt>{t("Steam 归属")}</dt><dd>{m.identity?.steamBinding === 'verified' ? t('已验证') : m.declaredSteamId ? t('Discord 自行登记，未验证') : m.steamId ? t('历史手工关联，未验证') : t('尚未验证 Steam')}</dd><dt>{t("访问限制")}</dt><dd>{m.identity?.restrictionPresent ? t('存在独立限制（恢复状态不会清除）') : t('无已记录的独立限制')}</dd><dt>{t("专长")}</dt><dd><SpecialtyChips values={m.specialty} labels={options.specialties} /></dd><dt>{t("最近更新")}</dt><dd>{date(m.updatedAt)}</dd></dl><div className="ma-actions">{m.canChangeStatus && !m.deletedAt && <Button onClick={() => {
                setNextStatus(m.memberStatus);
                setAction('status');
              }}>{t("调整状态")}</Button>}{m.canEdit && !m.deletedAt && <Button onClick={() => {
                setSquad(m.squadId || '');
                setAction('squad');
              }}>{t("调整队伍")}</Button>}</div></Panel><Panel><h2>{t("管理资料")}</h2>{m.phone !== undefined ? <dl className="ma-info">{[['phone', t('电话')], ['battlemetricsId', 'BMID'], ['region', t('地区')], ['timezone', t('时区')], ['vitalVipType', 'Vital VIP'], ['vitalVipPurchasedAt', t('Vital 购买')], ['vitalVipExpiresAt', t('Vital 到期')], ['atlasVipType', 'Atlas VIP'], ['atlasVipPurchasedAt', t('Atlas 购买')], ['atlasVipExpiresAt', t('Atlas 到期')], ['notes', t('内部备注')]].map(([k, v]) => <React.Fragment key={k}><dt>{v}</dt><dd>{m[k] || '—'}</dd></React.Fragment>)}</dl> : <p>{t("当前账号仅可读取基础资料。")}</p>}</Panel><PlatformBindings bindings={m.platformBindings} canUnlink={m.canUnlink} onUnlink={provider => { setUnlinkProvider(provider); setAction('unlink'); }}/></div><Panel><h2>{t("组织与操作历史")}</h2><HistoryPanel kind="member" id={id} /></Panel>{m.risks && <Panel><h2>{t("风险证据")}</h2><RiskAlerts member={m} alerts={m.risks} act={act} busy={busy} /></Panel>}{editing && <Modal title={t("编辑成员资料")} onClose={() => setEditing(false)}><MemberForm member={m} options={options} busy={busy} close={() => setEditing(false)} onSave={body => act('/members/' + id, body, 'PATCH').then(r => {
            if (r) setEditing(false);
          })} /></Modal>}{action === 'unlink' && <UnlinkDialog key={unlinkProvider} id={id} provider={unlinkProvider} busy={busy} act={act} close={() => setAction(null)} operationState={operationState} operations={operations}/>} {action === 'delete' && <ConfirmDialog title={t('删除成员：') + m.displayName} confirmLabel={t("确认永久删除")} description={t('永久删除 ') + m.displayName + '（' + m.steamId + t('）的个人资料和绑定投影，并撤销关联访问。历史游玩、排行榜与报名记录保留，删除无法恢复。')} busy={busy} close={() => setAction(null)} onConfirm={() => act('/members/delete', { targets: [{ id, expectedRevision: m.revision }] }).then(result => { if (result) go(root); })}/>} {action && !['unlink','delete'].includes(action) && <ConfirmDialog title={{
          status: t('调整成员状态'),
          squad: t('调整组织归属'),
          unlink: t('解绑平台关联')
        }[action]} description={action === 'status' ? t('将更改成员状态，访问限制不会因恢复状态而自动清除。操作记录将保存到成员历史。') : t('将更改成员的当前队伍归属，历史关系保留。')} busy={busy} close={() => setAction(null)} onConfirm={() => act('/members/' + id + '/' + action, {
          expectedRevision: m.revision,
          ...(action === 'status' ? {
            status: nextStatus
          } : action === 'squad' ? {
            squadId: squadId || null
          } : {})
        }).then(r => {
          if (r) setAction(null);
        })}>{action === 'status' && <Field label={t("目标状态")}><Select value={nextStatus} onChange={e => setNextStatus(e.target.value)}>{Object.entries(statusLabels).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field>}{action === 'squad' && <Field label={t("目标队伍")}><Select value={squadId} onChange={e => setSquad(e.target.value)}><option value="">{t("未分队")}</option>{squads.data?.items.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>}</ConfirmDialog>}</>}</QueryState></>;
}
function HistoryPanel({
  kind,
  id
}) {
  const [before, setBefore] = useState(0);
  const query = useData('history', '/history/' + kind + '/' + id + '?before=' + before);
  return <><HistoryList query={query} />{(before || query.data?.nextBefore) && <div className="ma-actions"><Button disabled={!before} onClick={() => setBefore(0)}>{t("返回最新")}</Button><Button disabled={!query.data?.nextBefore} onClick={() => setBefore(query.data.nextBefore)}>{t("更早记录")}</Button></div>}</>;
}
function HistoryList({
  query
}) {
  return <QueryState query={query}>{d => {
    const items = visibleHistory(d.items);
    return items.length ? <ol className="ma-history">{items.map(r => { const display = historyDescription(r); return <li key={r.seq}><div className="ma-history-heading"><strong>{display.title}</strong><time dateTime={r.createdAt}>{date(r.createdAt)}</time></div><p>{display.detail}</p><span>{t('操作人：{name}', { name: r.actorName || t('管理员') })}</span></li>; })}</ol> : <p className="muted">{d.items.length ? t('本页没有实际资料或归属变更。') : t('暂无操作记录。')}</p>;
  }}</QueryState>;
}
function SquadPage({
  options,
  act,
  busy
}) {
  const {
      path,
      go
    } = useApp(),
    params = new URL(path, 'http://local').searchParams;
  const data = useData('squads', '/squads?' + params),
    [editing, setEditing] = useState(null),
    [archive, setArchive] = useState(null),
    [historySquad, setHistorySquad] = useState(null);
  return <><Title eyebrow={t("组织管理")} subtitle={t("一个当前组织归属，多名队长，历史关系保留。")} actions={options.permissions.createSquad && <Button kind="primary" onClick={() => setEditing({})}>{t("新建队伍")}</Button>}>{t("队伍管理")}</Title><Panel><QueryState query={data}>{d => <><div className="ma-squad-grid">{d.items.map(s => <article key={s.id}><div className="ma-squad-heading"><div><h2>{s.name}</h2><Badge>{s.archivedAt ? t('已归档') : t('组织中')}</Badge></div><Button kind="primary" onClick={() => go(root + '?squadId=' + encodeURIComponent(s.id) + '&from=squads')}>{t("查看成员 →")}</Button></div><p>{t("队长顺序：")}{s.leaderUserIds.join(' → ')}</p><p>{s.notes || t('暂无备注')}</p><div className="ma-actions">{s.canManage && !s.archivedAt && <Button onClick={() => setEditing(s)}>{t("编辑队伍")}</Button>}{options.permissions.createSquad && !s.archivedAt && <Button onClick={() => setArchive(s)}>{t("解散队伍")}</Button>}<Button onClick={() => setHistorySquad(s)}>{t("记录")}</Button></div></article>)}</div>{!d.items.length && <p>{t("暂无队伍。")}</p>}<Pages data={d} params={params} path={root + '/squads'} /></>}</QueryState></Panel>{historySquad && <Modal title={historySquad.name + t(' · 关系历史')} onClose={() => setHistorySquad(null)}><HistoryPanel kind="squad" id={historySquad.id} /></Modal>}{editing && <SquadDialog squad={editing} options={options} act={act} busy={busy} close={() => setEditing(null)} />} {archive && <ConfirmDialog title={t("解散队伍")} confirmLabel={t("确认解散队伍")} description={t("当前成员归属将移除，成员档案与报名历史保留。")} busy={busy} close={() => setArchive(null)} onConfirm={() => act('/squads/' + archive.id + '/archive', {
      expectedRevision: archive.revision
    }).then(r => {
      if (r) setArchive(null);
    })} />}</>;
}
function SquadDialog({
  squad,
  options,
  act,
  busy,
  close
}) {
  const [name, setName] = useState(squad.name || ''),
    [notes, setNotes] = useState(squad.notes || ''),
    [leaders, setLeaders] = useState(squad.leaderUserIds || []);
  const leadersQuery = useData('leaders', '/leaders?limit=100');
  return <Modal title={squad.id ? t('编辑队伍') : t('新建队伍')} onClose={close}><form onSubmit={e => {
      e.preventDefault();
      act('/squads' + (squad.id ? '/' + squad.id : ''), {
        name,
        notes,
        leaderUserIds: leaders,
        expectedRevision: squad.revision
      }).then(r => {
        if (r) close();
      });
    }}><Field label={t("队伍名称")}><input required value={name} onChange={e => setName(e.target.value)} maxLength={80} /></Field><Field label={t("队伍备注")}><textarea value={notes} onChange={e => setNotes(e.target.value)} maxLength={500} /></Field><h3>{t("队长顺序")}</h3><ol>{leaders.map((uid, i) => <li key={uid}>{leadersQuery.data?.items.find(a => a.id === uid)?.name || uid}<Button aria-label={t('上移 ') + uid} disabled={i === 0 || !options.permissions.createSquad} onClick={() => setLeaders(a => {
            const b = [...a];
            [b[i - 1], b[i]] = [b[i], b[i - 1]];
            return b;
          })}>↑</Button><Button disabled={!options.permissions.createSquad} onClick={() => setLeaders(a => a.filter(v => v !== uid))}>{t("移除")}</Button></li>)}</ol>{options.permissions.createSquad && <Field label={t("添加队长")}><Select value="" onChange={e => {
          if (e.target.value && !leaders.includes(e.target.value)) setLeaders([...leaders, e.target.value]);
        }}><option value="">{t("选择网站账号")}</option>{leadersQuery.data?.items.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</Select></Field>}<Button type="submit" kind="primary" disabled={!leaders.length || busy}>{t("保存队伍")}</Button></form></Modal>;
}
const riskSourceStatus = {observed:'已获取',partial:'部分获取',private:'私密',unavailable:'未能获取',not_required:'本次无需采集'};
const riskTypeNames = {account_restricted:'Steam 账号限制',steam_ban_or_restriction:'Steam 封禁',unassigned_squad:'队伍归属',playtime:'游戏时长',inventory:'库存',no_online_days:'服务器在线',official:'官方战绩'};
function RiskActions({member,alert,act,busy,onConfirm}) {
  const disabled = busy || member.canRiskManage === false;
  return <div className="ma-actions"><Button disabled={disabled} onClick={() => act('/risks/' + member.id + '/state', {
    alertId: alert.id, evidenceHash: alert.evidenceHash, expectedRevision: alert.stateRevision,
    status: alert.state === 'unread' ? 'read' : 'unread', note: ''
  })}>{alert.state === 'unread' ? t('标为已读') : t('恢复未读')}</Button><Button disabled={disabled} onClick={onConfirm}>{t("人工确认")}</Button></div>;
}
function RiskAlerts({
  member,
  alerts,
  act,
  busy
}) {
  const [selected, setSelected] = useState(null);
  const [openType, setOpenType] = useState(null);
  const groups = groupRiskAlerts(alerts), opened = groups.find(group => group.type === openType);
  const summary = e => `${e.value === null ? t('数据不可用') : typeof e.value === 'boolean' ? t(e.value ? '是' : '否') : String(e.value)} · ${date(e.observedAt)}${e.retained ? t(' · 保留旧证据') : ''}${e.currentStatus && e.currentStatus !== 'observed' ? t(' · 本次{status}', { status: t(riskSourceStatus[e.currentStatus] || '未确认') }) : ''}`;
  const confirm = e => { setOpenType(null); setSelected(e); };
  return <><h3 className="ma-section-label">{t("命中规则")}</h3>{groups.length ? <div className="ma-risk-types">{groups.map(group => <article className="ma-risk-type" key={group.type}><div className="ma-risk-type-main"><h3>{riskTypeNames[group.type] ? t(riskTypeNames[group.type]) : t(group.latest.name)}</h3><p>{group.alerts.length === 1 ? t(group.latest.name) : t('{count} 条规则命中', { count: group.alerts.length })}</p><small>{t("最近证据：")}{summary(group.latest)}</small>{group.latest.suppressed && <small>{t("已满足旧规则信任条件，保留证据供复核。")}</small>}{group.alerts.length === 1 && group.latest.note && <small>{t(group.latest.note)}</small>}</div><div className="ma-risk-type-controls"><Badge>{group.unread ? t('{count} 未读', { count: group.unread }) : group.read ? t('{count} 已读', { count: group.read }) : t('已确认')}</Badge>{group.alerts.length === 1 ? <RiskActions member={member} alert={group.latest} act={act} busy={busy} onConfirm={() => confirm(group.latest)} /> : <Button onClick={() => setOpenType(group.type)}>{t('查看并处理 {count} 条规则', { count: group.alerts.length })}</Button>}</div></article>)}</div> : <p>{t("当前规则未命中风险。")}</p>}{opened && <Modal title={t('{name} · {count} 条规则', { name: riskTypeNames[opened.type] ? t(riskTypeNames[opened.type]) : t(opened.latest.name), count: opened.alerts.length })} onClose={() => setOpenType(null)}><div className="ma-risk-rule-list">{opened.alerts.map(e => <article className="ma-risk-rule" key={e.id}><strong>{t(e.name)}</strong><p>{summary(e)}</p>{e.note && <p>{t(e.note)}</p>}<Badge>{{unread:t('未读'),read:t('已读'),done:t('已确认')}[e.state]}</Badge><RiskActions member={member} alert={e} act={act} busy={busy} onConfirm={() => confirm(e)} /></article>)}</div></Modal>}{selected && <ConfirmDialog title={t("人工确认风险")} description={t('{name}。确认仅记录复核，不修改成员资格。', {name:t(selected.name)})} busy={busy} close={() => setSelected(null)} onConfirm={() => act('/risks/' + member.id + '/state', {
      alertId: selected.id,
      evidenceHash: selected.evidenceHash,
      expectedRevision: selected.stateRevision,
      status: 'done'
    }).then(r => {
      if (r) setSelected(null);
    })} />}</>;
}
function RiskPage({
  options,
  params,
  act,
  busy
}) {
  const data = useData('risks', '/risks?' + params),
    [rules, setRules] = useState(false),
    [reset, setReset] = useState(false),
    [globalReset, setGlobalReset] = useState(false);
  return <><Title eyebrow={t("成员风险")} subtitle={t("仅展示当前启用规则命中的成员与风险。")} actions={<div className="ma-actions"><AppLink className="button" to="/admin/sync/data?type=member_profile&scope=all_members">{t("到同步中心检测")}</AppLink><Button onClick={() => setRules(true)}>{t("风险规则")}</Button><Button onClick={() => setReset(true)}>{t("清除我的确认")}</Button><Button onClick={() => setGlobalReset(true)}>{t("清除全局历史确认")}</Button></div>}>{t("风险复核")}</Title><QueryState query={data}>{d => <>{d.items.map(({
          member,
          alerts
        }) => <Panel className="panel ma-risk-panel" key={member.id}><h2><AppLink to={root + '/profile/' + member.id}>{member.displayName}</AppLink> <small>{member.squadName}</small></h2><RiskAlerts member={member} alerts={alerts} act={act} busy={busy} /></Panel>)}{!d.items.length && <Panel>{t("当前权限范围内没有规则命中风险。")}</Panel>}<Pages data={d} params={params} path={root + '/risks'} /></>}</QueryState>{globalReset && <ConfirmDialog title={t("清除全局历史确认")} description={t("将清除旧账号风险确认记录，重新展示当前规则命中的风险。需要全局风险管理权限。")} busy={busy} close={() => setGlobalReset(false)} onConfirm={() => act('/risks/clear-confirmations', {}).then(r => {
      if (r) setGlobalReset(false);
    })} />} {rules && <RulesDialog options={options} busy={busy} act={act} close={() => setRules(false)} />} {reset && <ConfirmDialog title={t("清除我的风险确认")} description={t("仅清除此账号的复核状态。其他管理员记录保留。")} busy={busy} close={() => setReset(false)} onConfirm={() => act('/risks/reset', {}).then(r => {
      if (r) setReset(false);
    })} />}</>;
}
const ruleTypes = {
  account_restricted: 'Steam 受限',
  steam_ban_or_restriction: 'Steam 封禁',
  unassigned_squad: '未分队',
  playtime_hours: '游戏时长(h)',
  inventory_value: '库存(USD)',
  no_online_days: '未在线天数',
  kd: 'KD',
  kills: '击杀',
  deaths: '死亡',
  rockets: '火箭',
  private_inventory: '库存不可见',
  private_playtime: '时长不可见'
};
function RulesDialog({
  options,
  busy,
  act,
  close
}) {
  const query = useData('rules', '/risk-rules');
  return <Modal title={t("风险规则")} onClose={close}><QueryState query={query}>{d => <RulesEditor key={d.revision} initial={d} options={options} busy={busy} act={act} close={close} />}</QueryState></Modal>;
}
function RulesEditor({
  initial,
  options,
  busy,
  act,
  close
}) {
  const [rules, setRules] = useState(initial.rules),
    [squadFilter, setFilter] = useState(initial.squadFilter),
    [selected, setSelected] = useState(0);
  const editable = options.permissions.rules && !busy,
    r = rules[selected];
  const change = patch => setRules(rules.map((v, i) => i === selected ? {
    ...v,
    ...patch
  } : v));
  return <form onSubmit={e => {
    e.preventDefault();
    act('/risk-rules', {
      rules,
      squadFilter,
      expectedRevision: initial.revision
    }).then(r => {
      if (r) close();
    });
  }}>{!editable && <p>{t("规则可查看，仅超管可编辑全局规则。")}</p>}<Field label={t("规则列表")}><Select disabled={!rules.length || busy} value={selected} onChange={e => setSelected(Number(e.target.value))}>{rules.map((v, i) => <option key={v.id} value={i}>{v.enabled ? '●' : '○'} {t(v.name)}</option>)}</Select></Field>{!rules.length && <p>{t("暂无风险规则，保存后生效。")}</p>}{r && <div className="ma-form-grid"><Field label={t("规则名称")}><input value={r.name} disabled={!editable} onChange={e => change({
          name: e.target.value
        })} /></Field><Field label={t("指标")}><Select disabled={!editable} value={r.type} onChange={e => change({
          type: e.target.value,
          operator: e.target.value.startsWith('private_') ? 'unavailable' : ['account_restricted', 'steam_ban_or_restriction', 'unassigned_squad'].includes(e.target.value) ? 'is' : 'lt'
        })}>{Object.entries(ruleTypes).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field><Field label={t("比较方式")}><Select disabled={!editable} value={r.operator} onChange={e => change({
          operator: e.target.value
        })}>{[['lt', t('小于')], ['lte', t('小于等于')], ['gt', t('大于')], ['gte', t('大于等于')], ['eq', t('等于')], ['is', t('命中')], ['unavailable', t('不可用')]].map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}</Select></Field><Field label={t("阈值")}><input type="number" min="0" step="any" value={r.threshold} disabled={!editable} onChange={e => change({
          threshold: Number(e.target.value)
        })} /></Field><Field label={t("此规则队伍范围（空为全部）")}><input value={r.squadFilter || ''} disabled={!editable} onChange={e => change({
          squadFilter: e.target.value
        })} /></Field><label><input type="checkbox" disabled={!editable} checked={r.enabled} onChange={e => change({
          enabled: e.target.checked
        })} />{t("启用规则")}</label></div>}<Field label={t("全局队伍范围（空为全部）")}><input disabled={!editable} value={squadFilter} onChange={e => setFilter(e.target.value)} /></Field>{editable && <div className="ma-actions"><Button onClick={() => {
        setRules([...rules, {
          id: crypto.randomUUID(),
          name: t('新规则'),
          type: 'playtime_hours',
          operator: 'lt',
          threshold: 500,
          enabled: true,
          squadFilter: ''
        }]);
        setSelected(rules.length);
      }} disabled={rules.length >= 50}>{t("添加规则")}</Button><Button onClick={() => {
        setRules(rules.filter((_, i) => i !== selected));
        setSelected(0);
      }} disabled={!rules.length || busy}>{t("删除规则")}</Button><Button type="submit" kind="primary" disabled={busy}>{t("保存规则")}</Button></div>}</form>;
}
function SyncControls({
  kind,
  memberIds,
  label
}) {
  const {
      client
    } = useApp(),
    [job, setJob] = useState(null),
    [error, setError] = useState(null),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(null);
  const run = async action => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const command = pending || {
      operationId: crypto.randomUUID(),
      body: {
        kind,
        memberIds,
        jobId: job?.jobId
      },
      action
    };
    setPending(command);
    try {
      const r = await client.request(api + '/sync/' + command.action, {
        method: 'POST',
        body: command.body,
        headers: {
          'Idempotency-Key': command.operationId
        }
      });
      setJob(r.data);
      setPending(null);
    } catch (e) {
      setError(e);
      if (!e.retryable) setPending(null);
    } finally {
      setBusy(false);
    }
  };
  return <div className="ma-sync"><Button disabled={busy || !memberIds.length} onClick={() => run('request')}>{pending ? t('重试原同步请求') : label}</Button>{job && <><span>{job.status || t('已请求')} {t("· 成功")} {job.succeeded ?? 0} {t("/ 失败")} {job.failed ?? 0} {t("/ 跳过")} {job.skipped ?? 0}</span><Button disabled={busy} onClick={() => run('status')}>{t("刷新任务状态")}</Button><Button disabled={busy} onClick={() => run('cancel')}>{t("取消任务")}</Button></>}{error && <span role="alert">{errorText(error)}</span>}</div>;
}
