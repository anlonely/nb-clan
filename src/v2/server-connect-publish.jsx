import React, {useEffect, useRef, useState} from 'react';
import {Send, Eye, CheckCircle2} from 'lucide-react';
import {t} from './i18n.js';
import {useApp} from './context.jsx';
import {useQuery} from './use-query.jsx';
import {Select as Dropdown} from './select.jsx';
import {Button, Modal, Notice} from './ui.jsx';
import {arrivalTime, errorCopy, localInput} from './format.js';
import {createServerConnectOperation} from './server-connect-operation.js';
import {DiscordTimestampText} from './discord-timestamp-text.jsx';
import './server-connect-publish.css';

const emptyState = {preview:null, previewBusy:false, publishBusy:false, operationId:null, result:null, error:null};
function initialDraft(wipe) {
  const snapshot = wipe.serverSnapshot || {};
  return {
    name: snapshot.name || snapshot.label || '',
    time: Number.isFinite(Date.parse(wipe.serverScheduledWipeAt)) ? localInput(wipe.serverScheduledWipeAt, 'Asia/Shanghai') : '',
    command: snapshot.connectCommand || snapshot.directConnect || snapshot.connect || '',
  };
}
function previewError(error) {
  return ({
    SERVER_CONNECT_UNAVAILABLE:t('请填写服务器名称、有效 WIPE 时间和直连命令。'),
    SERVER_CONNECT_INPUT_INVALID:t('请检查卡片内容，直连命令只能填写一条 connect 或 client.connect 命令。'),
    PREVIEW_EXPIRED:t('预览已过期，请重新生成后发送。'),
    PREVIEW_STALE:t('频道配置或卡片内容已变化，请重新生成预览。'),
    REVISION_CONFLICT:t('频道配置已更新，请重新读取频道。'),
    TARGET_NOT_CONFIGURED:t('该频道已不可用，请重新选择频道。'),
    MESSAGE_REFERENCE_REQUIRED:t('未找到可更新的原卡，请先发布直连卡片。'),
    CARD_UPDATE_PENDING:t('原卡仍有更新正在执行或等待确认，请稍后重新生成预览。'),
    CARD_DELIVERY_PENDING:t('已有卡片正在投递或等待确认，请先核实投递结果，避免重复发送。'),
  })[error?.errorCode] || errorCopy(error);
}

export default function ServerConnectPublish({wipe}) {
  const {client} = useApp();
  const options = useQuery(client, ['server-connect-options', wipe.id], `/api/v2/wipes/${encodeURIComponent(wipe.id)}/notification-options`, {ttlMs:30000});
  const targets = (options.data?.targets || []).filter(item => ['kook','discord'].includes(item.platform) && item.id.startsWith('server_connect_') && item.capabilities?.send)
    .sort((a,b) => Number(a.platform==='discord')-Number(b.platform==='discord'));
  const [open,setOpen] = useState(false), [selected,setSelected] = useState(''), [draft,setDraft] = useState(() => initialDraft(wipe));
  const [publishMode,setPublishMode] = useState('publish');
  const [state,setState] = useState(emptyState), [attempt,setAttempt] = useState(0);
  const operation = useRef(null), generation = client.getGeneration();
  const target = targets.find(item => item.id===selected);
  const locked = state.publishBusy || !!state.operationId;
  const finished = state.result?.status==='succeeded';

  useEffect(() => {
    const controller = createServerConnectOperation({client,onChange:setState});
    operation.current = controller; setState(controller.getState());
    return () => {controller.dispose(); if (operation.current===controller) operation.current=null;};
  }, [client,generation,wipe.id]);

  // Only a current server-rendered preview enables Send. This effect never publishes.
  useEffect(() => {
    const controller = operation.current;
    const current = controller?.getState();
    if (!open || current?.operationId || current?.publishBusy || current?.result?.status==='succeeded') return;
    controller?.invalidatePreview();
    if (!target || !draft.name.trim() || !draft.time || !draft.command.trim()) return;
    let instant;
    try {instant=arrivalTime(draft.time,'Asia/Shanghai');} catch {return;}
    const timer = setTimeout(() => controller?.preview({
      platform:target.platform, targetId:target.id, expectedRevision:target.configurationRevision,
      wipeId:wipe.id, cardType:'server_connect', language:target.platform==='discord'?'en':'zh-CN',
      serverConnectOverride:{name:draft.name.trim(),serverScheduledWipeAt:instant,command:draft.command.trim()},
    }), 400);
    return () => {clearTimeout(timer); controller?.invalidatePreview();};
  }, [open,selected,target?.platform,target?.configurationRevision,draft.name,draft.time,draft.command,attempt,client,generation,wipe.id]);

  function edit(field,value) {
    if (operation.current?.getState().operationId || operation.current?.getState().publishBusy) return;
    operation.current?.invalidatePreview(); setDraft(current => ({...current,[field]:value}));
  }
  function selectTarget(value) {
    if (operation.current?.getState().operationId || operation.current?.getState().publishBusy) return;
    operation.current?.invalidatePreview(); setSelected(value);
  }
  function show() {
    const current=operation.current?.getState();
    if (!current?.operationId && !current?.publishBusy) {
      operation.current?.invalidatePreview();
      setSelected(targets.some(item => item.id===selected) ? selected : targets[0]?.id || '');
      setDraft(initialDraft(wipe)); setPublishMode('publish'); setAttempt(value=>value+1);
    }
    setOpen(true);
  }
  function close() {
    const current=operation.current?.getState();
    if (current?.publishBusy) return;
    if (!current?.operationId) operation.current?.invalidatePreview(); setOpen(false);
  }
  const statusTitle = state.result?.status==='succeeded' ? t(publishMode==='refresh'?'原卡已更新':'卡片已送达') : ['queued','running'].includes(state.result?.status) ? t('卡片已提交，等待投递') : state.operationId ? t('投递结果待核实，请勿重复发布') : state.result?.errorCode==='CARD_UPDATE_PENDING' ? t('原卡更新尚未完成') : state.result?.errorCode==='CARD_DELIVERY_PENDING' ? t('已有投递尚未完成') : t('发布失败');
  if (options.data && !targets.length && !open && !state.operationId) return null;

  return <>
    <Button onClick={show} disabled={!options.data&&!options.error}><Send size={16}/>{t('发布直连卡片')}</Button>
    {open && <Modal title={t('发布直连卡片')} className="server-connect-modal" onClose={close} actions={<>
      <Button disabled={state.publishBusy} onClick={close}>{finished?t('完成'):t('取消')}</Button>
      {state.operationId ? <Button kind="primary" disabled={state.publishBusy} onClick={()=>operation.current?.checkReceipt()}>{state.publishBusy?(state.result?t('正在查询…'):t('正在提交…')):t('查询投递结果')}</Button>
        : !finished && <><Button kind="primary" disabled={state.publishBusy||state.previewBusy||!state.preview||!target} onClick={()=>{setPublishMode('publish');operation.current?.publish();}}><Send size={16}/>{state.publishBusy?t('正在提交…'):t('确认发送')}</Button>{target?.platform==='kook'&&<Button disabled={state.publishBusy||state.previewBusy||!state.preview} onClick={()=>{setPublishMode('refresh');operation.current?.publish('refresh');}}>{t('更新原卡')}</Button>}</>}
    </>}>
      {options.error && <Notice tone="error" title={t('暂时无法读取频道')} action={<Button onClick={()=>options.retry().catch(()=>{})}>{t('重新读取频道')}</Button>}>{errorCopy(options.error)}</Notice>}
      {!targets.length && options.data && <Notice title={t('暂无可发布的直连频道')}>{t('请先在 Bot 功能管理中启用服务器直连卡片并配置频道。')}</Notice>}
      {state.result && <Notice tone={['failed','unknown'].includes(state.result.status)?'error':''} title={statusTitle} action={!locked&&!finished&&<Button onClick={()=>setAttempt(value=>value+1)}>{t('重新生成预览')}</Button>}>{state.result.errorCode ? previewError({errorCode:state.result.errorCode}) : null}</Notice>}
      <div className="server-connect-editor">
        <div className="server-connect-fields">
          <label className="field">{t('发布频道')}<Dropdown aria-label={t('发布频道')} value={target?.id||''} disabled={locked||finished||!targets.length} onChange={event=>selectTarget(event.target.value)}>
            {!target && <option value="">{t('请选择频道')}</option>}
            {targets.map(item=><option key={item.id} value={item.id}>{item.platform.toUpperCase()} · {item.guildLabel} · #{item.channelLabel}</option>)}
          </Dropdown></label>
          <label className="field">{t('服务器名称')}<input value={draft.name} maxLength={180} disabled={locked||finished} onChange={event=>edit('name',event.target.value)}/></label>
          <label className="field">{t('WIPE 时间（UTC+8）')}<input type="datetime-local" value={draft.time} disabled={locked||finished} onChange={event=>edit('time',event.target.value)}/></label>
          <label className="field">{t('直连命令')}<textarea rows={3} value={draft.command} maxLength={300} placeholder="client.connect host:28015" disabled={locked||finished} onChange={event=>edit('command',event.target.value)}/></label>
          <p className="caption">{t('编辑仅用于本次卡片。')}</p>
        </div>
        <section className="server-connect-preview" aria-label={t('卡片预览')} aria-busy={state.previewBusy}>
          <header><span><Eye size={17}/>{t('卡片预览')}</span><small>{target?.platform==='discord'?t('Discord · 英文'):t('KOOK · 简体中文')}</small></header>
          {state.preview ? <article className={`server-connect-card ${target?.platform||''}`}>
            <h3>{state.preview.title}</h3><div className="server-connect-card-body">{state.preview.body.split('```').map((part,index)=>index%2 ? <pre key={index}>{part.trim()}</pre> : <span key={index}><DiscordTimestampText platform={target?.platform}>{part}</DiscordTimestampText></span>)}</div>
          </article> : finished ? <div className="server-connect-placeholder"><CheckCircle2 size={28}/><strong>{t('卡片已送达')}</strong></div>
            : <div className="server-connect-placeholder" role="status">{state.previewBusy?t('正在生成预览…'):t('填写内容后生成预览')}</div>}
          {state.error && !state.result && <Notice tone="error" title={t('暂时无法生成预览')} action={<Button onClick={()=>{options.retry().catch(()=>{});setAttempt(value=>value+1);}}>{t('重新生成预览')}</Button>}>{previewError(state.error)}</Notice>}
          {state.preview && !locked && <p className="server-connect-ready"><CheckCircle2 size={15}/>{t('请检查内容与频道，确认后发送。')}</p>}
        </section>
      </div>
    </Modal>}
  </>;
}
