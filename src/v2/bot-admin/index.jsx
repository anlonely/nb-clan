import React, {useState} from 'react';
import {Bot, ChevronRight, ExternalLink, Plus, Search, X} from 'lucide-react';
import {t} from '../i18n.js';
import {useApp, AppLink} from '../context.jsx';
import {useQuery} from '../use-query.jsx';
import {Badge, Button, Modal, Notice, Panel, Title} from '../ui.jsx';
import {Select} from '../select.jsx';
import {errorCopy} from '../format.js';
import {PlatformWorkspace} from '../platform-admin/index.jsx';
import {commandLabel} from '../platform-admin/community-server.jsx';
import Electricians from '../platform-admin/electricians.jsx';
import OpenSignups from './open-signups.jsx';
import {botDetailPath, botListPath, botListReturnPath, botPlatform, botSectionPath, canCreateBotConfig} from './list-model.js';
import './style.css';

const tabs = [['features', '功能与指令'], ['servers', '服务器与权限'], ['open-signups', '开放报名'], ['electricians', '电工 ID'], ['tools', '运行工具'], ['activity', '操作记录']];
const descriptions = {
  features: '管理功能配置、启用状态与服务器使用范围。',
  servers: '按服务器绑定分配功能、频道与使用权限。',
  'open-signups': '查看 /newwipe 创建的报名卡和当前人员名单。',
  electricians: '统一管理电工好友，两端卡片共用同一份名单。',
  tools: '选择平台和目标，检查指令、预览卡片或执行操作。',
  activity: '按动作、结果和日期查看操作记录与回执。'
};
const types = {slash_command: '斜杠指令', event_command: '事件指令', persistent_card: '常驻卡片', event_card: '事件卡片'};
const platformName = id => id === 'discord' ? 'Discord' : 'KOOK';

export default function BotAdmin({path: providedPath}) {
  const app = useApp(), path = providedPath || app.path;
  const [createPlatformOpen, setCreatePlatformOpen] = useState(false);
  const route = new URL(path, 'https://local.invalid'), parts = route.pathname.split('/').filter(Boolean);
  const section = tabs.some(([id]) => id === parts[2]) ? parts[2] : 'features';
  const params = route.searchParams, platform = botPlatform(params.get('platform'));
  const needsConfig = ['features', 'servers'].includes(section);
  const discord = useQuery(app.client, ['platform-admin', 'discord'], '/api/v2/platform-admin/discord', {enabled: needsConfig, ttlMs: 15000});
  const kook = useQuery(app.client, ['platform-admin', 'kook'], '/api/v2/platform-admin/kook', {enabled: needsConfig, ttlMs: 15000});
  const configs = [['discord', discord], ['kook', kook]], filtered = configs.filter(([id]) => !platform || platform === id);
  const detailId = parts[3] ? decodeURIComponent(parts[3]) : '';
  const serverPlatform = section === 'servers' ? botPlatform(parts[3]) || platform : platform;
  const currentPlatform = (section === 'servers' || section === 'activity') ? botPlatform(parts[3]) || platform : platform;
  const guildId = section === 'servers' && parts[4] ? decodeURIComponent(parts[4]) : '';
  const serverData = configs.find(([id]) => id === serverPlatform)?.[1].data;
  const target = serverData?.targets?.find(item => item.id === params.get('targetId')) || serverData?.targets?.find(item => item.guildId === guildId);
  const pageLabel = tabs.find(([id]) => id === section)[1];
  const featureLink = (id, commandId) => botDetailPath('features', params, id, {id: commandId});
  const targetLink = (id, item) => botDetailPath('servers', params, id, item);
  const update = (key, value) => {
    const next = new URLSearchParams(params);
    value ? next.set(key, value) : next.delete(key);
    if (section === 'features' && detailId && key === 'platform' && botPlatform(value)) {
      app.go(botDetailPath('features', next, value, {id: detailId}), {replace: true, scroll: false});
      return;
    }
    const destination = needsConfig ? botListPath(section, next) : `/admin/bot/${section}${next.size ? `?${next}` : ''}`;
    app.go(destination, {replace: true, scroll: false});
  };
  const sectionChange = (key, id) => app.go(botSectionPath(key === 'commands' ? 'features' : key === 'tools' ? 'tools' : 'servers', id));
  const configNotices = filtered.map(([id, query]) => query.error && <Notice key={id} tone="error" title={t('无法读取 {platform} 配置', {platform: platformName(id)})} action={<Button onClick={query.retry}>{t('重新读取')}</Button>}>{errorCopy(query.error)}</Notice>);
  const queryText = (params.get('search') || '').trim().toLowerCase(), kind = params.get('type');
  const featureRows = filtered.flatMap(([id, query]) => (query.data?.commands || []).map(command => ({platform: id, data: query.data, command})))
    .filter(({command}) => (!kind || command.type === kind) && (!queryText || `${commandLabel(command)} ${command.name} ${command.id} ${command.slashCommand || ''}`.toLowerCase().includes(queryText)));
  const serverRows = filtered.flatMap(([id, query]) => (query.data?.targets || []).map(item => ({platform: id, data: query.data, target: item})))
    .filter(({target}) => (!params.get('feature') || target.enabledCommandIds?.includes(params.get('feature'))) && (!queryText || `${target.name} ${target.guildId} ${target.id}`.toLowerCase().includes(queryText)));
  const platformSelect = (allowAll = true) => <label>{t('平台')}<Select aria-label={t('Bot 平台')} value={allowAll ? platform : currentPlatform} onChange={event => update('platform', event.target.value)}>
    <option value="">{t(allowAll ? '全部平台' : '请选择平台')}</option><option value="discord">Discord</option><option value="kook">KOOK</option>
  </Select></label>;
  const addLabel = section === 'features' ? '添加功能' : '添加服务器';
  const createEligible = ([, query]) => canCreateBotConfig(query.data, section);
  const canCreate = filtered.some(createEligible) && app.online !== false;
  const configLoading = filtered.some(([, query]) => !query.data && !query.error);
  const addDisabledReason = app.online === false ? '当前离线' : configLoading ? '正在加载配置…' : filtered.some(([, query]) => !query.data && query.error) ? '暂时无法读取' : filtered.some(([, query]) => query.data?.canConfigure === true) ? '此平台已达到配置数量上限。' : '仅有查看权限';
  const startCreate = id => {
    const data = configs.find(([key]) => key === id)?.[1].data;
    if (app.online === false || !canCreateBotConfig(data, section)) return;
    setCreatePlatformOpen(false);
    app.go(section === 'features' ? featureLink(id, 'new') : targetLink(id, {id: 'new', guildId: 'new'}));
  };
  const hasFilters = Boolean(params.get('search') || params.get(section === 'features' ? 'type' : 'feature'));
  const clearFilters = () => app.go(botSectionPath(section, platform), {replace: true, scroll: false});
  const listReturnPath = botListReturnPath(section, params);
  let content;

  if (section === 'open-signups') content = <OpenSignups path={path}/>;
  else if (section === 'electricians') content = <Electricians embedded/>;
  else if (section === 'features' && detailId) content = platform ? <>
    <nav className="bot-breadcrumbs" aria-label={t('面包屑')}><AppLink to={listReturnPath}>{t('功能与指令')}</AppLink><span>/</span><span>{detailId === 'new' ? t('添加功能') : commandLabel(configs.find(([id]) => id === platform)?.[1].data?.commands?.find(command => command.id === detailId), detailId)}</span><Badge>{platformName(platform)}</Badge></nav>
    <PlatformWorkspace key={`${platform}:commands`} id={platform} botView="commands" selectedFeatureId={detailId} onFeatureSelect={id => app.go(featureLink(platform, id))} onSectionChange={key => sectionChange(key, platform)}/>
  </> : <Notice title={t('请先选择功能所属平台')}>{platformSelect(false)}</Notice>;
  else if (section === 'servers' && detailId) content = serverPlatform ? <>
    <nav className="bot-breadcrumbs" aria-label={t('面包屑')}><AppLink to={listReturnPath}>{t('服务器与权限')}</AppLink><span>/</span><span>{target?.name || t('添加服务器')}</span><Badge>{platformName(serverPlatform)}</Badge></nav>
    <PlatformWorkspace key={`${serverPlatform}:servers`} id={serverPlatform} botView="servers" selectedTargetId={target?.id || params.get('targetId') || 'new'} onTargetSelect={id => {
      const row = serverData?.targets?.find(item => item.id === id);
      app.go(targetLink(serverPlatform, row || {id, guildId: 'new'}));
    }} onSectionChange={key => sectionChange(key, serverPlatform)}/>
    <p className="caption">{t('平台自动同步设置对所属平台全部目标生效。')} <AppLink to={botSectionPath('servers', serverPlatform)}>{t('管理平台自动卡片同步')}</AppLink></p>
  </> : <Notice title={t('请先选择服务器所属平台')}/>;
  else if (needsConfig) content = <>
    {configNotices}
    <Panel className="panel bot-list-panel">
      <div className="bot-list-heading"><div><h2>{t(pageLabel)}</h2><p>{t(section === 'features' ? '保存配置不会注册指令或发布卡片。' : '每条绑定独立管理频道和权限。')}</p></div>
        <Button kind="primary" disabled={!canCreate} title={!canCreate ? t(addDisabledReason) : undefined} onClick={() => platform ? startCreate(platform) : setCreatePlatformOpen(true)}><Plus size={16}/>{t(addLabel)}</Button>
      </div>
      <div className="bot-filter-row">
        {platformSelect()}
        {section === 'features' && <label>{t('功能类型')}<Select aria-label={t('筛选功能类型')} value={kind || ''} onChange={event => update('type', event.target.value)}><option value="">{t('全部')}</option>{Object.entries(types).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</Select></label>}
        <label className="bot-search">{t('搜索')}<span className="bot-search-control"><Search size={16}/><input aria-label={t(section === 'features' ? '搜索功能与指令' : '搜索社区服务器')} placeholder={t(section === 'features' ? '搜索名称、指令或 ID' : '搜索名称或服务器 ID')} value={params.get('search') || ''} onChange={event => update('search', event.target.value)}/></span></label>
        {hasFilters && <Button kind="ghost" onClick={clearFilters}><X size={15}/>{t('清除筛选')}</Button>}
      </div>
      <div className="bot-list-meta"><span role="status">{configLoading ? t('正在加载配置…') : t(section === 'features' ? '显示 {count} 项功能' : '显示 {count} 条服务器绑定', {count: section === 'features' ? featureRows.length : serverRows.length})}</span>{section === 'servers' && params.get('feature') && <Badge>{params.get('feature')}</Badge>}</div>
      <div className="bot-table-scroll"><table className="bot-config-table"><thead><tr>{(section === 'features' ? ['功能名称', '平台', '功能类型', '配置状态', '使用范围', '操作'] : ['社区服务器', '平台', '配置状态', '已分配功能', '频道配置', '操作']).map(label => <th scope="col" key={label}>{t(label)}</th>)}</tr></thead>
        <tbody>{section === 'features' ? featureRows.map(({platform: id, data, command}) => <tr key={`${id}:${command.id}`}>
          <td><AppLink className="bot-name-link" to={featureLink(id, command.id)}><strong>{commandLabel(command)}</strong></AppLink>{command.slashCommand && <small>/{command.slashCommand}</small>}</td>
          <td><span className={`bot-platform-label ${id}`}>{platformName(id)}</span></td><td>{t(types[command.type] || command.type)}</td>
          <td><Badge tone={command.enabled ? 'green' : ''}>{t(command.enabled ? '已启用' : '未启用')}</Badge>{id === 'discord' && ['slash_command', 'event_command'].includes(command.type) && <small>{t('注册状态未核实')}</small>}</td>
          <td>{t('{count} 条服务器绑定', {count: data.targets?.filter(item => item.enabledCommandIds?.includes(command.id)).length || 0})}</td>
          <td><AppLink className="button ghost bot-row-action" to={featureLink(id, command.id)}>{t('配置功能')}<ChevronRight size={15}/></AppLink></td>
        </tr>) : serverRows.map(({platform: id, target: item}) => <tr key={`${id}:${item.id}`}>
          <td><AppLink className="bot-name-link" to={targetLink(id, item)}><strong>{item.name || item.guildId || t('未命名服务器')}</strong></AppLink><small>{item.guildId} · {item.id}</small></td>
          <td><span className={`bot-platform-label ${id}`}>{platformName(id)}</span></td><td><Badge tone={item.enabled ? 'green' : ''}>{t(item.enabled ? '已启用' : '未启用')}</Badge></td>
          <td>{item.enabledCommandIds?.length || 0}</td><td>{t(item.channelId ? '已配置通用频道' : '未指定通用频道')}</td>
          <td><AppLink className="button ghost bot-row-action" to={targetLink(id, item)}>{t('配置范围与权限')}<ChevronRight size={15}/></AppLink></td>
        </tr>)}</tbody>
      </table>{(section === 'features' ? !featureRows.length : !serverRows.length) && <div className="bot-empty"><Bot size={28}/><h3>{t(configLoading ? '正在加载配置…' : '当前筛选没有配置')}</h3><p>{t(hasFilters ? '调整筛选条件后重试。' : '选择平台后可添加功能或服务器绑定。')}</p>{hasFilters && <Button onClick={clearFilters}>{t('清除筛选')}</Button>}</div>}</div>
    </Panel>
    {section === 'servers' && platform && <PlatformWorkspace key={`${platform}:automation`} id={platform} botView="automation"/>}
    {createPlatformOpen && <Modal className="bot-create-platform-modal" title={t(addLabel)} onClose={() => setCreatePlatformOpen(false)} actions={<Button onClick={() => setCreatePlatformOpen(false)}>{t('取消')}</Button>}>
      <p className="muted">{t(section === 'features' ? '请先选择功能所属平台' : '请先选择服务器所属平台')}</p><div className="bot-create-platform-options">{configs.map(([id, query]) => <button type="button" className="button bot-create-platform-choice" key={id} disabled={!canCreateBotConfig(query.data, section) || app.online === false} onClick={() => startCreate(id)}><Bot size={22}/><span><strong>{platformName(id)}</strong><small>{t(canCreateBotConfig(query.data, section) ? addLabel : query.data?.canConfigure === true ? '此平台已达到配置数量上限。' : !query.data && !query.error ? '正在加载配置…' : '仅有查看权限')}</small></span><ChevronRight size={17}/></button>)}</div>
    </Modal>}
  </>;
  else content = <>
    <div className="bot-tool-platform">{platformSelect(false)}<span className="muted">{t(section === 'tools' ? '平台和目标需要明确选择，进入页面不会执行动作。' : '操作记录保留原始提交和执行状态，以实际回执为准。')}</span></div>
    {currentPlatform ? <PlatformWorkspace key={`${currentPlatform}:${section}`} id={currentPlatform} botView={section} operationId={section === 'activity' ? parts[4] : undefined}/> : <Panel><p>{t('请先选择要管理的平台。')}</p></Panel>}
  </>;

  return <section className="bot-admin platform-admin">
    <Title eyebrow={t('管理空间')} actions={<AppLink className="button ghost" to={`/admin/platforms/${currentPlatform || 'discord'}`}><ExternalLink size={15}/>{t('平台接入')}</AppLink>}>{t('Bot 功能管理')}</Title>
    <p className="bot-page-description">{t(descriptions[section])}</p>
    <nav className="bot-tabs" aria-label={t('Bot 管理分区')}>{tabs.map(([id, label]) => <AppLink key={id} className={section === id ? 'active' : ''} aria-current={section === id ? 'page' : undefined} to={botSectionPath(id, currentPlatform)}>{t(label)}</AppLink>)}</nav>
    {content}
  </section>;
}
