import { Select as Dropdown } from '../select.jsx';
import { t } from '../i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Eye, Plus, Send, Trash2 } from 'lucide-react';
import { useApp, AppLink } from '../context.jsx';
import { useQuery } from '../use-query.jsx';
import { Button, Badge, Panel, Title, Notice, Empty, QueryState as SharedQueryState } from '../ui.jsx';
import { time, localInput, errorCopy } from '../format.js';
import { useAdminOperation } from './use-operation.jsx';
import { buildNotificationInput, buildReconcileInput, createNotificationForm, deliveryLabels, deliveryNeedsPolling,
  intentLabels, intentNeedsPolling, languageLabels, notificationError, pollDelay, previewInvalidReason,
  publishIntentInput, purposeLabels } from './notification-model.js';

import { countScopeLabel } from './model.js';
import './notification-wizard.css';
import { DiscordTimestampText } from '../discord-timestamp-text.jsx';

const messageOperationLabels = { queued:'已加入投递队列', running:'正在处理', unknown:'提交结果待核实', skipped:'操作已跳过', failed:'失败', succeeded:'已完成', cancelled:'已取消' };
const messageReasonLabels = {
  REFRESH_REQUESTED:'请求更新原卡', MANUAL_LOOKUP:'人工查询消息', MANUAL_RECONCILIATION:'人工核实投递结果',
  MANUAL_SENT_CONFIRMED:'人工确认消息已送达', LATE_EDIT_COMPENSATION:'补偿较晚完成的卡片更新',
  DISCORD_SIGNUP_CONFIGURATION_CHANGED:'Discord 报名配置已变化', DISCORD_SIGNUP_CHANGED:'Discord 报名已变化',
  SIGNUP_CHANGED:'报名变更', WIPE_CHANGED:'安排变更', MEMBER_ROSTER_CHANGED:'成员名单已变化',
  SEND_CANCELLATION_COMPENSATION:'发送期间请求取消，更新原卡', SEND_SNAPSHOT_REFRESH:'发送后更新最新安排', LOOKUP_FOUND_REFRESH:'核实送达后更新原卡',
  NEVER_DISPATCHED_BEFORE_EDIT_RECONCILIATION:'核实原卡更新前取消未发出的任务'
};
const messageRefLabels = { active:'原卡有效', update_unknown:'原卡更新结果未知', update_failed:'原卡更新失败', deleted:'原卡已删除' };
const previewWarningLabels = { TEXT_TRUNCATED:'部分文字已截短，完整安排请在网站查看。', ATTENDANCE_LIST_TRUNCATED:'报名名单过长，完整名单请在网站查看。', EDIT_MENTIONS_SUPPRESSED:'原卡更新已关闭所有提醒。' };
const enc = encodeURIComponent;
const describeError = error => notificationError(error) || errorCopy(error);
const safeUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' ? value : null; } catch { return null; } };
const restoredOffset = (value, zone) => {
  const minutes = Math.round((Date.parse(`${localInput(value, zone)}:00Z`) - Date.parse(value)) / 60_000);
  return `${minutes < 0 ? '-' : '+'}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2,'0')}:${String(Math.abs(minutes) % 60).padStart(2,'0')}`;
};
function beginSafely(action, options, onError) {
  try { Promise.resolve(action.begin(options)).catch(error => onError(describeError(error))); }
  catch (error) { onError(describeError(error)); }
}
function QueryState({ query, children }) {
  if ([401,403,404].includes(query.error?.status)) return <Notice tone="error" title={query.error.status === 403 ? t('当前没有读取这项通知的权限') : t('暂时无法读取这项通知')}
    action={<Button onClick={() => query.retry().catch(() => {})}>{t("重新核实")}</Button>}>{t(describeError(query.error))}</Notice>;
  return <SharedQueryState query={{...query,retry:()=>query.retry().catch(()=>{})}}>{children}</SharedQueryState>;
}

function OperationNotice({ action }) {
  const { state, operation, retry, reconcile } = action;
  if (state.status === 'submitting') return <Notice title={t("正在保存这次操作")}>{t("请等待服务器确认。")}</Notice>;
  if (state.status === 'unknown') return <Notice title={t("这次操作是否保存尚未确定")} action={<div className="admin-row"><Button onClick={reconcile}>{t("核对原操作回执")}</Button><Button onClick={retry}>{t("按原请求重试")}</Button></div>}>
    {t("暂未收到确定结果；核对返回未找到也不代表原请求不会提交。重试保留同一个操作键和原始内容，不会创建新的通知操作。操作编号：")}{operation?.operationId}
  </Notice>;
  if (['failed', 'conflict', 'cancelled'].includes(state.status)) return <Notice tone="error" title={state.status === 'conflict' ? t('记录已变化，请重新核对') : state.status === 'cancelled' ? t('会话已变化') : t('操作没有完成')}>{t(describeError(state.error))}</Notice>;
  return null;
}

function useProgressPolling(key, query, active) {
  const { client, online } = useApp(), latest = useRef(query);
  latest.current = query;
  const keyId = JSON.stringify(key), generation = client.getGeneration();
  useEffect(() => {
    if (!active || online === false || !client.getIdentity()) return;
    let stopped = false, timer, failures = 0;
    const schedule = () => {
      clearTimeout(timer);
      if (!stopped && document.visibilityState === 'visible') timer = setTimeout(tick, pollDelay(failures));
    };
    async function tick() {
      if (stopped || document.visibilityState !== 'visible' || !client.getIdentity() || generation !== client.getGeneration()) return;
      try { await latest.current.retry(); failures = 0; }
      catch (error) { if ([401,403].includes(error.status)) { stopped = true; return; } failures++; }
      schedule();
    }
    const visibility = () => document.visibilityState === 'visible' ? schedule() : clearTimeout(timer);
    document.addEventListener('visibilitychange', visibility); schedule();
    const unsubscribe = client.subscribeIdentity(() => { stopped = true; clearTimeout(timer); });
    return () => { stopped = true; clearTimeout(timer); unsubscribe(); document.removeEventListener('visibilitychange', visibility); };
  }, [client, keyId, active, online, generation]);
}

function invalidateNotification(client, { wipeId, intentId, deliveryId }) {
  if (wipeId) client.invalidateQueries(['notification-intents', wipeId]);
  if (intentId) client.invalidateQueries(['notification-intent', intentId]);
  if (deliveryId) client.invalidateQueries(['notification-delivery', deliveryId]);
  client.invalidateQueries(['admin-wipes']);
}

export function NotificationWizard({ wipeId, repeatDeliveryId = null }) {
  const { client } = useApp();
  const wipe = useQuery(client, ['wipe', wipeId], `/api/v2/wipes/${enc(wipeId)}/summary`);
  const options = useQuery(client, ['notification-options', wipeId], `/api/v2/wipes/${enc(wipeId)}/notification-options`);
  const original = useQuery(client, ['notification-delivery', repeatDeliveryId], `/api/v2/deliveries/${enc(repeatDeliveryId || '')}`, { enabled: Boolean(repeatDeliveryId) });
  const originalIntentId = original.data?.delivery?.intentId;
  const originalIntent = useQuery(client, ['notification-intent', originalIntentId || '', { cursor: '' }], `/api/v2/publish-intents/${enc(originalIntentId || '')}`, { enabled: Boolean(repeatDeliveryId && originalIntentId) });
  return <div className="notification-wizard"><AppLink className="nw-back" to={`/admin/wipes/${enc(wipeId)}?tab=notifications`}><ArrowLeft size={17}/>{t("返回本场安排")}</AppLink>
    <Title eyebrow={t("档期通知")}>{repeatDeliveryId ? t('再次通知') : t('创建通知')}</Title>
    <QueryState query={wipe}>{data => <QueryState query={options}>{config => repeatDeliveryId
      ? <QueryState query={original}>{source => <QueryState query={originalIntent}>{intent => <WizardForm key={`${wipeId}:${repeatDeliveryId}`} wipe={data.wipe} options={config} repeatDelivery={source.delivery} repeatIntent={intent.intent} queryBlocked={Boolean(wipe.error || options.error || original.error || originalIntent.error)}/>}</QueryState>}</QueryState>
      : <WizardForm key={wipeId} wipe={data.wipe} options={config} queryBlocked={Boolean(wipe.error || options.error)}/>}</QueryState>}</QueryState></div>;
}

function WizardForm({ wipe, options, repeatDelivery = null, repeatIntent = null, queryBlocked }) {
  const { client, online } = useApp();
  const [form, setForm] = useState(() => createNotificationForm(wipe, options, { delivery: repeatDelivery, intent: repeatIntent }));
  const [preview, setPreview] = useState(null), [accepted, setAccepted] = useState(null), [validation, setValidation] = useState('');
  const [clock, setClock] = useState(Date.now());
  const action = useAdminOperation(`notification-wizard:${wipe.id}:${repeatDelivery?.id || 'primary'}`);
  const consumed = useRef(null);
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { setForm(previous => ({ ...previous, audience: wipe.audience })); }, [wipe.id, wipe.revision]);
  useEffect(() => {
    if (action.state.status !== 'committed' || consumed.current === action.state.operationReceipt?.operationId) return;
    consumed.current = action.state.operationReceipt?.operationId;
    const current = action.state.current;
    if (current?.contentHash && current.targets) {
      const input = action.operation.body;
      setPreview({ dto: current, input }); setValidation('');
      // Restored operations retain their original acknowledged input, including the exact repeat instance.
      setForm(previous => ({ ...previous, purpose: input.purpose, purposeInstance: input.purposeInstance,
        repeatOfIntentId: input.repeatOfIntentId, reason: input.reason || '', duplicateRiskAcknowledged: input.duplicateRiskAcknowledged,
        targets: input.targets, audience: input.audience, scheduleMode: input.schedule ? 'scheduled' : 'now',
        dueAtLocal: input.schedule ? localInput(input.schedule.dueAt, wipe.timeZone) : '', expiresAtLocal: input.schedule ? localInput(input.schedule.expiresAt, wipe.timeZone) : '',
        utcOffset: input.schedule ? restoredOffset(input.schedule.dueAt, wipe.timeZone) : '' }));
    } else if (current?.deliveryIds) {
      setAccepted(current); invalidateNotification(client, { wipeId: wipe.id, intentId: current.id });
    }
    action.reset();
  }, [action.state, action.operation, client, wipe.id, wipe.timeZone]);
  useEffect(() => {
    if (['PREVIEW_STALE', 'PREVIEW_EXPIRED', 'REVISION_CONFLICT'].includes(action.state.error?.errorCode)) {
      setPreview(null); client.invalidateQueries(['wipe', wipe.id]); client.invalidateQueries(['notification-options', wipe.id]);
    }
  }, [action.state.error, client, wipe.id]);
  let input = null, inputError = '';
  try { input = buildNotificationInput(form, wipe, options, { now: clock, repeatDelivery }); }
  catch (error) { inputError = error.errorCode ? errorCopy(error) : error.message; }
  const invalidPreview = previewInvalidReason(preview?.dto, input, wipe, options, { now: clock, previewInput: preview?.input });
  const cannotSend = preview?.dto.targets.some(row => !options.targets.find(target => target.id === row.target.id)?.capabilities.send);
  const disabled = action.busy || queryBlocked || online === false || Boolean(accepted);
  const edit = patch => { setForm(previous => ({ ...previous, ...patch })); setValidation(''); };
  const editTarget = (index, patch) => edit({ targets: form.targets.map((target,i) => i === index ? { ...target, ...patch } : target) });
  const runPreview = () => {
    if (disabled) return;
    if (!input) { setValidation(inputError); return; }
    setPreview(null); beginSafely(action, { domain: 'notifications', path: `/api/v2/wipes/${enc(wipe.id)}/notification-previews`, body: input }, setValidation);
  };
  const runSend = () => {
    if (disabled || invalidPreview || cannotSend) return;
    beginSafely(action, { domain: 'notifications', path: `/api/v2/wipes/${enc(wipe.id)}/publish-intents`, body: publishIntentInput(preview.dto) }, setValidation);
  };
  const audienceLabel = wipe.audience.allMembers ? t('全体成员') : [
    wipe.audience.squadIds.length ? t('{count} 个队伍', { count: wipe.audience.squadIds.length }) : '',
    wipe.audience.memberIds.length ? t('{count} 个指定成员', { count: wipe.audience.memberIds.length }) : '',
    wipe.audience.includeUnassigned ? t('未分队成员') : '',
  ].filter(Boolean).join(' · ');
  const template = options.templates.find(row => row.id === 'wipe-notification' && row.revision === 1);
  const templateLabel = t(template?.label?.split(' / ')[0] || '模板暂不可用');
  const nextTargetSelection = options.targets.filter(row => row.enabled && row.capabilities.preview).flatMap(row =>
    row.languages.filter(language => template?.languages?.includes(language) && Object.hasOwn(languageLabels, language)).map(language => ({ targetId: row.id, language, mentionMode: 'none', roleIds: [] })))
    .find(candidate => !form.targets.some(row => row.targetId === candidate.targetId && row.language === candidate.language));
  const addTarget = () => { if (nextTargetSelection) edit({ targets: [...form.targets, nextTargetSelection] }); };
  const channelLabel = target => `${target.platform.toUpperCase()} · ${target.guildLabel || target.label || target.guildId} / #${target.channelLabel || target.channelId}${target.label?.endsWith('· 报名卡片') ? ` · ${t('报名卡片')}` : ''}`;
  const previewState = !preview ? t('待生成') : invalidPreview ? t('需要重新生成') : t('预览已生成');
  return <div className="admin-stack">
    <OperationNotice action={action}/>
    {accepted && <Notice title={t("已加入投递队列")} action={<AppLink className="button" to={`/admin/publish-intents/${enc(accepted.id)}`}>{t("查看逐频道进度")}</AppLink>}>{t("服务器已保存通知意图与目标。每个频道显示“已发送”后，才能确认该频道投递成功。")}{accepted.schedule ? t('计划发送：{time}（{zone}）。', { time: time(accepted.schedule.dueAt, wipe.timeZone), zone: wipe.timeZone }) : ''}</Notice>}
    {repeatDelivery && <Notice title={repeatDelivery.status === 'delivery_unknown' ? t('原消息可能已经送达') : t('将创建新的通知意图')}>{t("原投递记录会保留。再次通知可能让频道收到重复消息；请先尽量核实，再确认下方风险与原因。")}</Notice>}
    {options.targets.length === 0 && <Empty title={t("没有可用的通知频道")} to={`/admin/wipes/${enc(wipe.id)}`} action={t("返回安排")}>{t("当前账号没有可预览的频道，或隔离目录尚未配置。")}</Empty>}
    <div className="nw-context" aria-label={t("本场安排")}>
      <div><span>{t("当前档期")}</span><strong>{wipe.title || t('未命名档期')}</strong></div>
      <div><span>{t("服务器")}</span><strong>{wipe.serverSnapshot?.name || t('待填写')}</strong></div>
      <div><span>{t("计划开服")}</span><strong>{time(wipe.serverScheduledWipeAt, wipe.timeZone)}</strong></div>
      <div><span>{t("通知受众")}</span><strong>{audienceLabel || t('本场授权成员')}</strong></div>
    </div>
    <div className="nw-layout">
      <div className="nw-editor admin-stack">
        <Panel className="panel nw-panel">
          <header className="nw-panel-heading"><span className="nw-step">1</span><div><h2>{t("通知内容")}</h2><p>{t("从本场安排与报名记录生成")}</p></div></header>
          <fieldset className="nw-fieldset" disabled={disabled}>
            <div className="nw-purpose-grid">
              <label className="field">{t("用途")}<Dropdown value={form.purpose} onChange={e => edit({ purpose: e.target.value })}>{options.allowedPurposes.map(purpose => <option key={purpose} value={purpose}>{t(purposeLabels[purpose] || purpose)}</option>)}</Dropdown></label>
              <div className="nw-template"><span>{t("正式模板")}</span><strong>{templateLabel}</strong></div>
            </div>
            <div className="nw-audience"><Check size={16}/><span>{t("受众沿用本场安排：")}<strong>{audienceLabel || t('本场授权成员')}</strong></span></div>
          </fieldset>
        </Panel>
        <Panel className="panel nw-panel">
          <header className="nw-panel-heading"><span className="nw-step">2</span><div><h2>{t("投递频道")}</h2><p>{t("选择平台、语言和提醒范围")}</p></div>
            {!repeatDelivery && <Button disabled={disabled || form.targets.length >= 20 || !nextTargetSelection} onClick={addTarget}><Plus size={16}/>{t("添加频道")}</Button>}
          </header>
          <fieldset className="nw-fieldset" disabled={disabled}>
            {form.targets.length === 0 && <div className="nw-channel-empty"><strong>{t("尚未选择频道")}</strong><span>{t("添加频道后，可生成实际投递内容的预览。")}</span></div>}
            <div className="nw-target-list">{form.targets.map((selection,index) => {
              const target = options.targets.find(row => row.id === selection.targetId);
              return <div className="nw-target-card" key={`${selection.targetId}:${index}`}>
                <div className="nw-target-head"><strong>{t('频道 {number}', { number: index + 1 })}</strong><div>{target?.capabilities.send ? <Badge tone="green">{t("可发送")}</Badge> : <Badge>{t("仅可预览")}</Badge>}
                  {!repeatDelivery && <Button kind="ghost" aria-label={t('移除频道 {number}', { number: index + 1 })} onClick={() => edit({ targets: form.targets.filter((_,i) => i !== index) })}><Trash2 size={16}/></Button>}</div></div>
                <div className="nw-target-fields">
                  <label className="field nw-target-select">{t("频道")}<Dropdown value={selection.targetId} disabled={Boolean(repeatDelivery)} onChange={e => {
                    const next = options.targets.find(row => row.id === e.target.value); editTarget(index, { targetId: next.id, language: next.languages[0] || '', mentionMode: 'none', roleIds: [] });
                  }}>{options.targets.map(row => <option disabled={!row.enabled || !row.capabilities.preview} key={row.id} value={row.id}>{channelLabel(row)}</option>)}</Dropdown></label>
                  <label className="field">{t("语言")}<Dropdown value={selection.language} disabled={Boolean(repeatDelivery)} onChange={e => editTarget(index, { language: e.target.value })}>{target?.languages.map(language => <option key={language} value={language}>{t(languageLabels[language] || language)}</option>)}</Dropdown></label>
                  <label className="field">{t("提醒范围")}<Dropdown value={selection.mentionMode} onChange={e => editTarget(index, { mentionMode: e.target.value, roleIds: [] })}><option value="none">{t("不 @ 任何人")}</option><option value="roles" disabled={!target?.capabilities.mentionRoles}>{t("提醒指定角色")}</option><option value="everyone" disabled={!target?.capabilities.mentionEveryone}>{t("提醒全员")}</option></Dropdown></label>
                </div>
                {selection.mentionMode === 'roles' && <div className="nw-role-list">{target?.roleOptions.map(role => <label key={role.id}><input type="checkbox" checked={selection.roleIds.includes(role.id)} onChange={e => editTarget(index, { roleIds: e.target.checked ? [...selection.roleIds,role.id] : selection.roleIds.filter(id => id !== role.id) })}/>{role.label}</label>)}</div>}
              </div>;
            })}</div>
          </fieldset>
        </Panel>
        <Panel className="panel nw-panel">
          <header className="nw-panel-heading"><span className="nw-step">3</span><div><h2>{t("发送时间")}</h2><p>{t("预览后再确认投递")}</p></div></header>
          <fieldset className="nw-fieldset" disabled={disabled}>
            <div className="nw-schedule-options" role="radiogroup" aria-label={t("发送方式")}>
              <label className={`nw-schedule-choice${form.scheduleMode === 'now' ? ' selected' : ''}`}><input type="radio" name="notification-schedule" checked={form.scheduleMode === 'now'} onChange={() => edit({ scheduleMode: 'now' })}/><span><strong>{t("立即入队")}</strong><small>{t("确认后开始投递")}</small></span></label>
              <label className={`nw-schedule-choice${form.scheduleMode === 'scheduled' ? ' selected' : ''}`}><input type="radio" name="notification-schedule" checked={form.scheduleMode === 'scheduled'} onChange={() => edit({ scheduleMode: 'scheduled' })}/><span><strong>{t("指定时间")}</strong><small>{t("按本场时区投递")}</small></span></label>
            </div>
            {form.scheduleMode === 'scheduled' && <><div className="nw-time-grid"><label className="field">{t('发送时间（{zone}）', { zone: wipe.timeZone })}<input type="datetime-local" value={form.dueAtLocal} onChange={e => edit({ dueAtLocal: e.target.value })}/></label><label className="field">{t('失效时间（{zone}）', { zone: wipe.timeZone })}<input type="datetime-local" value={form.expiresAtLocal} onChange={e => edit({ expiresAtLocal: e.target.value })}/></label><label className="field">{t("UTC 偏移（夏令时重叠时填写）")}<input placeholder={t("例如 +08:00")} value={form.utcOffset} onChange={e => edit({ utcOffset: e.target.value })}/></label></div><p className="nw-hint">{t("过期、改期、取消或结束后不会补发。")}</p></>}
          </fieldset>
        </Panel>
        {repeatDelivery && <Panel className="panel nw-panel"><header className="nw-panel-heading"><div><h2>{t("再次通知确认")}</h2></div></header><fieldset className="nw-fieldset" disabled={disabled}><label className="field">{t("再次通知原因")}<textarea value={form.reason} onChange={e => edit({ reason: e.target.value })}/></label>
          {repeatDelivery.status === 'delivery_unknown' && <label className="nw-confirm-check"><input type="checkbox" checked={form.duplicateRiskAcknowledged} onChange={e => edit({ duplicateRiskAcknowledged: e.target.checked })}/>{t("我已核实可用证据，仍决定再次通知，并确认可能产生重复消息。")}</label>}</fieldset></Panel>}
      </div>
      <Panel className="panel nw-preview-panel" id="notification-preview">
        <header className="nw-preview-heading"><div><Eye size={19}/><h2>{t("正式预览")}</h2></div><Badge tone={preview && !invalidPreview ? 'green' : ''}>{previewState}</Badge></header>
        {validation && <Notice tone="error" title={t("请先核对通知设置")}>{t(validation)}</Notice>}
        {queryBlocked && <Notice tone="error" title={t("暂不能确认通知")}>{t("请先重新读取安排和通知权限。")}</Notice>}
        <Button kind={preview ? '' : 'primary'} disabled={disabled} onClick={runPreview}>{preview ? t('重新生成正式预览') : t('生成正式预览')}</Button>
        <p className="nw-preview-safety">{t("生成预览不会向频道发送消息。")}</p>
        {!preview ? <div className="nw-preview-empty"><Eye size={28}/><strong>{t("预览将显示在这里")}</strong><span>{t("核对频道、提醒范围和卡片内容后，再确认投递。")}</span></div> :
          <><p className="nw-preview-meta">{t("快照版本")} {preview.dto.contentRevision} {t("· 生成于")} {time(preview.dto.createdAt, wipe.timeZone)}<br/>{t("有效至")} {time(preview.dto.expiresAt, wipe.timeZone)}</p>
            <div className="nw-preview-list">{preview.dto.targets.map(row => {
              const target = options.targets.find(item => item.id === row.target.id);
              return <article className="nw-message" key={`${row.selection.targetId}:${row.selection.language}`}>
                <div className="nw-message-platform"><strong>{target ? channelLabel(target) : row.target.label}</strong><span>{t(languageLabels[row.selection.language] || row.selection.language)} · {row.selection.mentionMode === 'none' ? t('不 @ 任何人') : row.selection.mentionMode === 'everyone' ? t('@ 全员') : t('提醒 {count} 个角色', { count: row.selection.roleIds.length })}</span></div>
                <div className="nw-message-content"><h3>{row.rendered.title}</h3><p className="admin-notification-body"><DiscordTimestampText platform={row.target.platform}>{row.rendered.body}</DiscordTimestampText></p>
                  <dl>{row.rendered.fields.map((field,index) => <div key={index}><dt>{field.label}</dt><dd><DiscordTimestampText platform={row.target.platform}>{field.value}</DiscordTimestampText></dd></div>)}</dl>
                  <div className="nw-preview-actions" aria-label={t("卡片按钮预览")}>{row.rendered.actions.map((item,index) => <span key={index}>{item.label}{item.disabled ? t('（已禁用）') : ''}</span>)}</div>
                  <p className="nw-message-footer">{row.rendered.footer} · {t(countScopeLabel[row.rendered.countScope] || '当前授权范围')}</p>
                </div>{row.warnings.map((warning,index) => <Notice key={index} title={t(previewWarningLabels[warning.code] || warning.message)}>{warning.code}</Notice>)}
              </article>;
            })}</div>
            {invalidPreview && <Notice title={t("需要重新预览")}>{t(invalidPreview)}</Notice>}{cannotSend && <Notice tone="error" title={t("当前仅可预览")}>{t("所选频道中有未授予发送权限的目标。")}</Notice>}
            <div className="nw-send"><div><Send size={18}/><strong>{t("确认投递")}</strong><span>{preview.dto.schedule ? t('计划于 {time} 发送', { time: time(preview.dto.schedule.dueAt, wipe.timeZone) }) : t('确认后立即加入投递队列')}</span></div>
              <Button kind="primary" disabled={disabled || Boolean(invalidPreview) || cannotSend} onClick={runSend}>{preview.dto.schedule ? t('确认定时发送') : t('发送到 {count} 个频道', { count: new Set(preview.dto.targets.map(row => row.target.id)).size })}</Button>
            </div>
          </>}
      </Panel>
    </div>
  </div>;
}

export function IntentPage({ intentId }) {
  const { client, online, zone } = useApp(), [cursor, setCursor] = useState(''), [pages, setPages] = useState([]), [reason, setReason] = useState(''), [validation, setValidation] = useState('');
  const [retryResult, setRetryResult] = useState(null);
  const key = ['notification-intent', intentId, { cursor }];
  const query = useQuery(client, key, `/api/v2/publish-intents/${enc(intentId)}?limit=20${cursor ? `&cursor=${enc(cursor)}` : ''}`);
  const action = useAdminOperation(`notification-intent:${intentId}`), consumed = useRef(null);
  useProgressPolling(key, query, intentNeedsPolling(query.data?.intent));
  useEffect(() => { setCursor(''); setPages([]); setRetryResult(null); }, [intentId]);
  useEffect(() => {
    if (action.state.status === 'committed' && consumed.current !== action.state.operationReceipt?.operationId) {
      consumed.current = action.state.operationReceipt?.operationId;
      setRetryResult(action.state.current);
      invalidateNotification(client, { wipeId: action.state.current?.intent?.wipeId, intentId });
      action.reset();
    }
  }, [action.state, client, intentId]);
  useEffect(() => { if (action.state.status === 'conflict') client.invalidateQueries(['notification-intent', intentId]); }, [action.state.error, client, intentId]);
  return <><Title eyebrow={t("通知记录")} subtitle={t("只统计当前账号可查看的目标。队列已保存不等于平台已送达。")}>{t("逐频道投递进度")}</Title><OperationNotice action={action}/>
    <QueryState query={query}>{({ intent, deliveries, nextCursor }) => <div className="admin-stack">
      <div className="admin-row"><AppLink to={`/admin/wipes/${enc(intent.wipeId)}?tab=notifications`}>{t("返回本场通知")}</AppLink><Badge>{t(intentLabels[intent.status] || intent.status)}</Badge></div>
      <Panel><h2>{t(purposeLabels[intent.purpose])} {t("· 内容版本")} {intent.contentRevision}</h2><p>{t("记录")} {intent.id} · {time(intent.createdAt, zone)}{intent.schedule ? t(' · 计划 {due} 发送，{expires} 失效', { due: time(intent.schedule.dueAt, zone), expires: time(intent.schedule.expiresAt, zone) }) : ''}</p>
        <div className="admin-row">{Object.entries(intent.counts).map(([status,count]) => <span key={status}>{t(status === 'total' ? '当前可见目标' : deliveryLabels[status] || status)}: <strong>{count}</strong></span>)}</div><p className="admin-muted">{t('统计口径：{scope}。', { scope: t(countScopeLabel[intent.countScope] || '当前授权可见通知目标') })}</p>
        {intent.counts.delivery_unknown > 0 && <Notice title={t("存在送达结果未知的频道")}>{t("请进入对应频道核实。批量重试会跳过这些频道，不会自动重复发送。")}</Notice>}
      </Panel>
      <Panel><h2>{t("目标结果")}</h2>{deliveries.length ? <table className="admin-table"><thead><tr><th>{t("频道")}</th><th>{t("语言")}</th><th>{t("投递状态")}</th><th>{t("尝试次数")}</th><th>{t("结果")}</th></tr></thead><tbody>{deliveries.map(delivery => <tr key={delivery.id}><td>{delivery.targetLabel}<br/><span className="admin-muted">{delivery.platform}</span></td><td>{t(languageLabels[delivery.language] || delivery.language)}</td><td>{t(deliveryLabels[delivery.status])}{delivery.nextAttemptAt && <p className="admin-muted">{t("下次尝试")} {time(delivery.nextAttemptAt, zone)}</p>}</td><td>{delivery.attemptCount}</td><td><AppLink to={`/admin/deliveries/${enc(delivery.id)}`}>{delivery.status === 'delivery_unknown' ? t('核实投递') : t('查看结果')}</AppLink>{delivery.lastErrorCode && <p className="admin-muted">{delivery.lastErrorCode}</p>}</td></tr>)}</tbody></table> : <p>{t("当前页没有可查看的目标。")}</p>}
        <div className="admin-row"><Button disabled={!pages.length} onClick={() => { setCursor(pages.at(-1)); setPages(previous => previous.slice(0,-1)); }}>{t("上一页")}</Button><Button disabled={!nextCursor} onClick={() => { setPages(previous => [...previous,cursor]); setCursor(nextCursor); }}>{t("下一页")}</Button></div>
      </Panel>
      {(intent.counts.failed > 0 || intent.counts.retry_wait > 0) && <Panel><h2>{t("重试已知失败")}</h2><label className="field">{t("重试原因")}<input value={reason} disabled={action.busy} onChange={e => setReason(e.target.value)}/></label><p className="admin-muted">{t("只重新排入明确未送达的失败目标；已发送、未知和已取消目标会跳过。服务器会复核每个目标的当前权限。")}</p>
        {validation && <Notice tone="error" title={t("请填写操作原因")}>{t(validation)}</Notice>}<Button disabled={action.busy || Boolean(query.error) || online === false} onClick={() => {
          if (!reason.trim()) { setValidation('重试须保留原因。'); return; } setValidation('');
          beginSafely(action, { domain: 'notifications', path: `/api/v2/publish-intents/${enc(intentId)}/retry-failed`, body: { expectedRevision: intent.revision, reason: reason.trim() } }, setValidation);
        }}>{t("重试已知失败目标")}</Button></Panel>}
      {retryResult?.queuedIds && <Notice title={t("重试请求已保存")}>{t('重新排队 {queued} 个目标；跳过 {skipped} 个。请继续查看各频道结果。', { queued: retryResult.queuedIds.length, skipped: retryResult.skippedIds.length })}</Notice>}
    </div>}</QueryState></>;
}

export function DeliveryPage({ deliveryId }) {
  const { client, online, zone } = useApp(), query = useQuery(client, ['notification-delivery', deliveryId], `/api/v2/deliveries/${enc(deliveryId)}`);
  const action = useAdminOperation(`notification-delivery:${deliveryId}`), consumed = useRef(null);
  const [reason, setReason] = useState(''), [decision, setDecision] = useState('request_lookup'), [evidence, setEvidence] = useState(''), [validation, setValidation] = useState('');
  const [reference, setReference] = useState({ guildId: '', channelId: '', messageId: '', messageUrl: '' });
  useProgressPolling(['notification-delivery', deliveryId], query, deliveryNeedsPolling(query.data?.delivery, query.data?.messageOperations));
  useEffect(() => {
    if (action.state.status === 'committed' && consumed.current !== action.state.operationReceipt?.operationId) {
      consumed.current = action.state.operationReceipt?.operationId;
      invalidateNotification(client, { wipeId: action.state.current?.wipeId, intentId: action.state.current?.intentId, deliveryId });
      action.reset();
    }
  }, [action.state, client, deliveryId]);
  useEffect(() => { if (action.state.status === 'conflict') client.invalidateQueries(['notification-delivery', deliveryId]); }, [action.state.error, client, deliveryId]);
  const run = (delivery, command, body) => {
    if (action.busy || query.error || online === false) return;
    if (!reason.trim()) { setValidation('请填写操作原因。'); return; }
    if (command === 'retry' && !['failed','retry_wait'].includes(delivery.status)) { setValidation('仅已知未送达的失败目标允许重试。'); return; }
    setValidation(''); beginSafely(action, { domain: 'notifications', path: `/api/v2/deliveries/${enc(delivery.id)}/commands/${command}`, body: body || { expectedRevision: delivery.revision, reason: reason.trim() } }, setValidation);
  };
  return <><Title eyebrow={t("投递事实")} subtitle={t("消息链接只使用已核实的平台引用。")}>{t("单频道投递结果")}</Title><OperationNotice action={action}/>
    <QueryState query={query}>{({ delivery, messageOperations }) => <div className="admin-stack">
      <div className="admin-row"><AppLink to={`/admin/publish-intents/${enc(delivery.intentId)}`}>{t("返回本批投递")}</AppLink><Badge>{t(deliveryLabels[delivery.status])}</Badge></div>
      <Panel><h2>{delivery.targetLabel}</h2><p>{delivery.platform.toUpperCase()} · {t(languageLabels[delivery.language])} {t("· 记录")} {delivery.id}</p><dl><dt>{t("尝试次数")}</dt><dd>{delivery.attemptCount}</dd><dt>{t("最后更新")}</dt><dd>{time(delivery.updatedAt, zone)}</dd><dt>{t("确认送达")}</dt><dd>{delivery.sentAt ? time(delivery.sentAt, zone) : t('尚无确认')}</dd>{delivery.dueAt && <><dt>{t("计划发送")}</dt><dd>{time(delivery.dueAt, zone)}{t("；失效")} {time(delivery.expiresAt, zone)}</dd></>}</dl>
        {delivery.lastErrorCode && <Notice title={delivery.lastErrorCode}>{delivery.lastErrorMessage || t('请根据当前结果执行核实或恢复。')}</Notice>}
        {delivery.cancelRequested && <Notice title={t("取消请求已记录")}>{t("如果外部请求已经开始，消息仍可能送达；请等待最终结果，取消请求不能证明未送达。")}</Notice>}
      </Panel>
      <Panel><h2>{t("已核实的消息引用")}</h2>{delivery.messageRefs.length ? delivery.messageRefs.map(ref => <div className="admin-card" key={ref.id}><strong>{ref.messageId}</strong><p>{ref.platform} · {ref.guildId} / {ref.channelId} {t("· 内容版本")} {ref.contentRevision} · {t(messageRefLabels[ref.state] || ref.state)}</p>{safeUrl(ref.messageUrl) ? <a href={safeUrl(ref.messageUrl)} target="_blank" rel="noopener noreferrer">{t("打开已核实消息")}</a> : <span className="admin-muted">{t("平台没有提供消息链接。")}</span>}{['update_failed', 'update_unknown'].includes(ref.state) && <Notice title={t("原卡更新需要核实")}>{t("初次消息已送达；这项状态表示后续编辑结果，不能当作首发失败再次投递。")}</Notice>}</div>) : <p>{t("尚无已核实的消息引用。没有引用不等于没有发送。")}</p>}</Panel>
      {delivery.status === 'delivery_unknown' && <Notice title={t("消息可能已送达，禁止直接重试")}>{t("可请求平台核实，或根据可追溯证据人工判定。查找不支持或未找到且证据不足时，仍保留未知状态。")}</Notice>}
      {(delivery.actions.retry || delivery.actions.cancel || delivery.actions.lookup || delivery.actions.reconcile) && <Panel><h2>{t("核实与恢复")}</h2><fieldset disabled={action.busy || Boolean(query.error) || online === false}><label className="field">{t("操作原因")}<textarea value={reason} onChange={e => setReason(e.target.value)}/></label>
        <div className="admin-row">{delivery.actions.retry && ['failed','retry_wait'].includes(delivery.status) && <Button onClick={() => run(delivery,'retry')}>{t("重试已知未送达")}</Button>}{delivery.actions.cancel && <Button onClick={() => run(delivery,'cancel')}>{delivery.status === 'sending' ? t('请求取消后续投递') : t('取消待投递任务')}</Button>}</div>
        {delivery.status === 'delivery_unknown' && (delivery.actions.lookup || delivery.actions.reconcile) && <div className="admin-stack"><label className="field">{t("核实方式")}<Dropdown value={decision} onChange={e => setDecision(e.target.value)}><option value="request_lookup" disabled={!delivery.actions.lookup}>{t("请求平台核实（不会重发）")}</option><option value="confirmed_sent" disabled={!delivery.actions.reconcile}>{t("有证据确认已送达")}</option><option value="confirmed_not_sent" disabled={!delivery.actions.reconcile}>{t("有证据确认未送达")}</option></Dropdown></label>
          {decision !== 'request_lookup' && <label className="field">{t("核实证据")}<textarea placeholder={t("填写核实时间、核实人员、可追溯依据；不要填写凭据或私有令牌。")} value={evidence} onChange={e => setEvidence(e.target.value)}/></label>}
          {decision === 'confirmed_sent' && <div className="form-grid">{[['guildId',t('服务器 ID')],['channelId',t('频道 ID')],['messageId',t('消息 ID')],['messageUrl',t('平台消息链接（可留空）')]].map(([key,label]) => <label className="field" key={key}>{label}<input value={reference[key]} onChange={e => setReference(previous => ({ ...previous, [key]: e.target.value }))}/></label>)}</div>}
          <Button onClick={() => { try { run(delivery, 'reconcile', buildReconcileInput(delivery, { decision, reason, evidence, messageRef: { platform: delivery.platform, guildId: reference.guildId.trim(), channelId: reference.channelId.trim(), messageId: reference.messageId.trim(), messageUrl: reference.messageUrl.trim() || null } })); } catch (error) { setValidation(error.message); } }}>{decision === 'request_lookup' ? t('请求核实投递') : t('保存有证据的人工判定')}</Button>
        </div>}
      </fieldset>{validation && <Notice tone="error" title={t("请补充核实资料")}>{t(validation)}</Notice>}</Panel>}
      {delivery.actions.repeat && <Panel><h2>{t("明确再次通知")}</h2><p>{delivery.status === 'delivery_unknown' ? t('原消息可能已送达；再次通知可能产生重复。下一步需要填写原因并主动确认风险，再生成新预览。') : t('再次通知会建立新的意图，并保留原投递记录。')}</p><AppLink className="button" aria-disabled={action.busy} onClick={event => { if (action.busy) event.preventDefault(); }} to={`/admin/wipes/${enc(delivery.wipeId)}/notifications?repeatDeliveryId=${enc(delivery.id)}`}>{t("进入再次通知确认")}</AppLink></Panel>}
      <Panel><h2>{t("原卡维护与核实记录")}</h2>{messageOperations.length ? <table className="admin-table"><thead><tr><th>{t("类型")}</th><th>{t("状态")}</th><th>{t("原因")}</th><th>{t("更新于")}</th></tr></thead><tbody>{messageOperations.map(row => <tr key={row.id}><td>{{ edit: t('编辑原卡'), delete: t('删除原卡'), lookup: t('核实投递') }[row.kind]}</td><td>{t(messageOperationLabels[row.status] || row.status)}</td><td>{t(messageReasonLabels[row.reasonCode] || row.reasonCode) || '—'}</td><td>{time(row.updatedAt, zone)}</td></tr>)}</tbody></table> : <p>{t("暂无原卡维护或核实操作。")}</p>}</Panel>
    </div>}</QueryState></>;
}
