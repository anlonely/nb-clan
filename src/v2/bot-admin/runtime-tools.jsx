import React from 'react';
import {ClipboardCheck, Database, FileImage, Terminal} from 'lucide-react';
import {AppLink, useApp} from '../context.jsx';
import {t} from '../i18n.js';
import {Button, Badge, Panel, Notice} from '../ui.jsx';
import {Select} from '../select.jsx';
import {DiscordTimestampText} from '../discord-timestamp-text.jsx';
import {runtimeActionBody} from './config-sections.js';

const groups = [
  {id: 'commands', label: '指令检查与注册', description: '读取频道与角色，注册已配置的指令。', Icon: Terminal},
  {id: 'queries', label: '数据查询测试', description: '查询玩家、排行与地图数据。', Icon: Database},
  {id: 'cards', label: '卡片预览与投递', description: '确认卡片内容后，手动发布新卡。', Icon: FileImage},
  {id: 'recovery', label: '原卡更新与异常核实', description: '更新已有卡片，核实未确认的结果。', Icon: ClipboardCheck}
];
const groupActions = {commands: ['metadata', 'register_commands'], queries: ['query', 'ranking', 'map'], cards: ['card_preview', 'card_publish'], recovery: ['card_preview', 'card_refresh']};
const names = {metadata: '读取服务器与频道资源', register_commands: '注册指令', query: '查询玩家', ranking: '读取排行', map: '读取地图', card_preview: '预览卡片', card_publish: '发布新卡', card_refresh: '更新原卡'};
const cardTypes = [['ranking', '成员排行'], ['map', '地图信息'], ['custom', '自定义卡片'], ['server_connect', '服务器直连卡片'], ['electrician_ids', '电工 ID 卡片'], ['welcome_guide', '开荒须知卡片'], ['wipe_notice', 'Wipe 报名通知']];
const fields = {steamId: 'SteamID', sourceId: '来源 ID', wipeId: '档期 ID', commandId: '自定义功能 ID', serverId: '来源服务器 ID', providerWipeId: '来源档期 ID'};

export function RuntimeResult({result, platform, displayStatus}) {
  if (!result) return null;
  const state = result.result?.state;
  return <section role="status" className="platform-result bot-runtime-result">
    <div className="bot-runtime-result-heading"><h3>{t('操作回执')}</h3><Badge tone={state === 'unknown' || state === 'partial' ? 'warning' : result.status === 'succeeded' ? 'green' : ''}>{state === 'unknown' ? t('投递结果未知') : state === 'partial' ? t('部分完成') : displayStatus(result.status)}</Badge></div>
    <p className="caption">{t('操作号')} <code>{result.operationId || result.id}</code></p>
    {result.result?.preview && <div className="bot-runtime-preview"><h4>{result.result.preview.title}</h4><p className="bot-preview-body"><DiscordTimestampText platform={platform}>{result.result.preview.body}</DiscordTimestampText></p></div>}
    {result.result?.reference && <p>{t('引用：')}<code>{result.result.reference}</code></p>}
    {result.result?.counts && <p>{t('共')} {result.result.counts.total} · {t('成功')} {result.result.counts.succeeded} · {t('失败')} {result.result.counts.failed} · {t('未知')} {result.result.counts.unknown}</p>}
    {!!result.result?.items?.length && <div className="bot-runtime-items">{result.result.items.map((item, index) => <p key={`${item.id}:${index}`}><span>{item.label}</span><Badge>{displayStatus(item.status)}</Badge></p>)}</div>}
    {result.errorCode && <p><code>{result.errorCode}</code></p>}
  </section>;
}

export default function RuntimeTools({platform, data, action, setAction, input, setInput, busy, online, pending, dirty, perform, result, displayStatus, recovery, invalidatePreview}) {
  const {path, go} = useApp();
  const route = new URL(path || '/admin/bot/tools', 'https://local.invalid');
  const requestedGroup = route.searchParams.get('tool'), feature = route.searchParams.get('feature');
  const group = groups.some(({id}) => id === requestedGroup) ? requestedGroup : ['newwipe', 'setsteam', 'view'].includes(feature) ? 'commands' : ['kda', 'kookKda'].includes(feature) ? 'queries' : 'cards';
  const selectedGroup = groups.find(({id}) => id === group);
  const available = groupActions[group].filter(id => data.actions.some(item => item.id === id) && !(platform === 'kook' && id === 'register_commands'));
  const chosen = available.includes(action) ? action : available[0];
  const locked = busy || pending || online === false || !data.canConfigure || dirty;
  const target = data.targets?.find(item => item.id === input.targetId);
  const cardType = input.cardType || 'ranking';
  const needsTarget = chosen?.startsWith('card_') || chosen === 'register_commands' || chosen === 'metadata';
  const needsWipe = chosen === 'ranking' || chosen === 'map' || chosen?.startsWith('card_') && ['ranking', 'map', 'server_connect', 'wipe_notice'].includes(cardType);
  const needsPreview = ['card_publish', 'card_refresh'].includes(chosen);
  const channelKey = {electrician_ids: 'electricianChannelId', welcome_guide: 'welcomeGuideChannelId', server_connect: 'serverConnectChannelId'}[cardType];
  const channelId = target?.[channelKey] || target?.channelId;
  const requiredFields = [
    ...(needsWipe ? ['wipeId'] : []),
    ...(chosen === 'query' ? ['steamId', ...(['vital', 'moose'].includes(input.sourceId) ? ['serverId', 'providerWipeId'] : [])] : []),
    ...(chosen?.startsWith('card_') && cardType === 'custom' ? ['commandId'] : [])
  ];
  const missingFields = requiredFields.filter(key => !input[key]?.trim());
  const previewReady = input.previewId && input.contentHash && input.previewRevision === data.revision;
  const disabledReason = busy ? t('正在执行，请等待本次操作完成。')
    : pending ? t('上次操作结果尚未核实，请先查询回执。')
    : !data.canConfigure ? t('当前账号仅可查看此配置。')
    : online === false ? t('当前离线，恢复连接后可执行。')
    : dirty ? t('配置尚未保存，请先保存或放弃改动。')
    : !chosen ? t('当前工具组没有可用动作。')
    : needsTarget && !target ? t('请先选择目标服务器。')
    : missingFields.length ? t('请填写必填内容：{fields}', {fields: missingFields.map(key => t(fields[key])).join(' / ')})
    : needsPreview && !previewReady ? t('请先对当前参数预览，再执行投递或更新。')
    : !data.actions.some(item => item.id === chosen && item.available) ? t('此动作暂不可用，请检查平台接入与功能配置。') : '';
  const change = (key, value) => {
    invalidatePreview?.();
    setInput(current => ({...current, [key]: value, previewId: '', contentHash: '', previewRevision: null}));
  };
  const selectGroup = id => {
    if (id === group || busy || pending) return;
    const params = new URLSearchParams(route.searchParams);
    params.set('platform', platform);
    params.set('tool', id);
    setAction(id === 'commands' && platform === 'discord' ? 'register_commands' : groupActions[id][0]);
    invalidatePreview?.();
    setInput(current => ({...current, previewId: '', contentHash: '', previewRevision: null}));
    go(`/admin/bot/tools?${params}`, {replace: true, scroll: false});
  };
  async function run() {
    if (disabledReason) return;
    const body = await runtimeActionBody({action: chosen, platform, input, target, revision: data.revision});
    await perform(`/api/v2/platform-admin/${platform}/actions/${chosen}`, body);
  }
  const inputFields = [
    ...(chosen === 'query' ? ['steamId', 'sourceId', ...(['vital', 'moose'].includes(input.sourceId) ? ['serverId', 'providerWipeId'] : [])] : needsWipe ? ['wipeId', 'sourceId'] : []),
    ...(chosen?.startsWith('card_') && cardType === 'custom' ? ['commandId'] : [])
  ];

  return <div className="bot-tools">
    <div className="bot-tool-groups" role="group" aria-label={t('选择运行工具')}>{groups.map(({id, label, description, Icon}) => <button type="button" key={id} aria-pressed={group === id} disabled={busy || pending} onClick={() => selectGroup(id)}><span className="bot-tool-group-icon"><Icon size={19}/></span><span className="bot-tool-group-copy"><strong>{t(label)}</strong><small>{t(description)}</small></span></button>)}</div>
    <Panel className="panel bot-runtime-panel">
      <div className="bot-list-heading"><div><h2>{t(selectedGroup.label)}</h2><p>{t('先选择平台和目标，再预览或检查；执行需要单独点击。')}</p></div><Badge>{platform === 'discord' ? 'Discord' : 'KOOK'}</Badge></div>
      <div className="platform-fields bot-runtime-fields">
        <label>{t('动作')}<Select aria-label={t('动作')} value={chosen || ''} disabled={locked} onChange={event => setAction(event.target.value)}>{available.map(id => <option key={id} value={id}>{t(names[id])}{data.actions.find(item => item.id === id)?.available ? '' : t(' · 暂不可用')}</option>)}</Select></label>
        {needsTarget && <label>{t('目标服务器绑定')}<Select aria-label={t('目标服务器绑定')} value={input.targetId || ''} disabled={locked} onChange={event => change('targetId', event.target.value)}><option value="">{t('请选择服务器')}</option>{data.targets?.map(item => <option key={item.id} value={item.id}>{item.name || item.guildId} · {item.id}{item.enabled ? '' : t(' · 未启用')}</option>)}</Select></label>}
        {chosen?.startsWith('card_') && <label>{t('卡片类型')}<Select aria-label={t('卡片类型')} value={cardType} disabled={locked} onChange={event => change('cardType', event.target.value)}>{cardTypes.filter(([id]) => id !== 'wipe_notice' || platform === 'discord').map(([id, name]) => <option key={id} value={id}>{t(name)}</option>)}</Select></label>}
        {chosen === 'metadata' && <label>{t('查询内容')}<Select aria-label={t('查询内容')} value={input.kind || 'channels'} disabled={locked} onChange={event => change('kind', event.target.value)}><option value="channels">{t('频道')}</option><option value="roles">{t('角色')}</option></Select></label>}
        {chosen === 'register_commands' && <label>{t('注册指定指令')}<input aria-label={t('注册指定指令')} disabled={locked} value={input.commandIds || ''} placeholder={t('例如 newwipe；留空注册目标已启用的指令')} onChange={event => change('commandIds', event.target.value)}/></label>}
        {inputFields.map(key => <label key={key}>{t(fields[key])}{key === 'sourceId' ? <Select aria-label={t(fields[key])} value={input.sourceId || (chosen === 'query' ? 'official' : 'vital')} disabled={locked} onChange={event => change(key, event.target.value)}>{['official', 'vital', 'moose', 'inventory', 'member'].map(id => <option key={id} value={id}>{id === 'vital' ? 'Vital' : id === 'moose' ? 'Rusty Moose' : t({official: '官方战绩', inventory: 'Steam 库存', member: '成员资料'}[id])}</option>)}</Select> : <input aria-label={t(fields[key])} value={input[key] || ''} disabled={locked} onChange={event => change(key, event.target.value)}/>}</label>)}
      </div>
      <div className="bot-target-summary"><strong>{t('执行目标')}</strong>{needsTarget ? target ? <><span>{target.name || target.guildId}</span><span>{t('服务器 ID：')} {target.guildId}</span>{channelId && <a href={platform === 'discord' ? `https://discord.com/channels/${target.guildId}/${channelId}` : `https://www.kookapp.cn/app/channels/${target.guildId}/${channelId}`} target="_blank" rel="noopener noreferrer">{t('打开目标频道')}</a>}{chosen?.startsWith('card_') && <span>{t(cardTypes.find(([type]) => type === cardType)?.[1] || '卡片预览')}</span>}{cardType === 'wipe_notice' && <span>{t('报名入口频道：{channel}', {channel: target.signupCardChannelId || target.channelId})}</span>}</> : <span>{t('尚未选择目标，不会执行投递。')}</span> : <span>{t('查询使用所选数据来源与现有资源权限。')}</span>}</div>
      {needsPreview && <p className="muted bot-tool-description">{t('请先对当前参数预览。发布新卡与更新原卡是不同操作；更新保留原消息和报名数据。')}</p>}
      <div className="bot-runtime-footer"><Button kind="primary" disabled={Boolean(disabledReason)} aria-describedby={disabledReason ? 'bot-runtime-disabled-reason' : undefined} onClick={run}>{busy ? t('正在处理…') : t(names[chosen] || '执行所选动作')}</Button>{disabledReason && <p id="bot-runtime-disabled-reason" className="bot-disabled-reason" role="status">{disabledReason}</p>}</div>
      <RuntimeResult result={result} platform={platform} displayStatus={displayStatus}/>
    </Panel>
    {['setsteam', 'view'].includes(feature) && group === 'commands' && <Notice title={t('Steam 原生指令验证')}>{t('注册只更新所选服务器的指定指令，不执行关联或读取成员名单。注册完成后，在已配置频道中使用 /setsteam、/view user、/view all 和 /view nosteam 验证原生交互。')}</Notice>}
    {group === 'recovery' && recovery}
    <p className="muted"><AppLink to={`/admin/platforms/${platform}#server-connection`}>{t('连接或凭据异常？前往平台接入')}</AppLink></p>
  </div>;
}
