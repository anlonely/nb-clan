import React from 'react';
import {t} from '../i18n.js';
import {useApp, AppLink} from '../context.jsx';
import {useQuery} from '../use-query.jsx';
import {Badge, Notice} from '../ui.jsx';
import {time} from '../format.js';
export function AutomationImpact({platform, data, draft = data}) {
  const {client, zone} = useApp();
  const scheduled = useQuery(client, ['bot-sync-wipes', 'scheduled'], '/api/v2/admin/wipes?limit=50&lifecycle=scheduled', {ttlMs: 15000});
  const active = useQuery(client, ['bot-sync-wipes', 'active'], '/api/v2/admin/wipes?limit=50&lifecycle=active', {ttlMs: 15000});
  const targets = (draft.targets || []).filter(target => target.enabled);
  const commands = new Set((draft.commands || []).filter(command => command.enabled).map(command => command.id));
  const eligible = target => draft.enabled && (target.enabledCommandIds || []).some(id => commands.has(id) && (id === 'server_connect_card' && target.serverConnectChannelId || id === (platform === 'discord' ? 'wipe' : 'signup_card') && target.signupCardChannelId));
  const wipes = [...(scheduled.data?.items || []), ...(active.data?.items || [])].map(item => item.wipe);
  return <div className="bot-sync-impact"><strong>{t('平台自动同步的影响范围')}</strong><p>{t('开启后，后台会扫描此平台全部启用目标，以及已排期和进行中的网站档期，为符合条件且缺少卡片的目标补发报名或直连卡。此设置不包含 /newwipe 独立报名卡。')}</p><ul>{targets.map(target => <li key={target.id}><span>{target.name || target.guildId} · {target.id}</span><Badge>{eligible(target) ? t('符合卡片同步条件') : t('尚未配置完整的同步功能和频道')}</Badge></li>)}</ul>{!targets.length && <p>{t('当前没有启用的目标。')}</p>}<h4>{t('当前授权可见的既有档期')}</h4>{wipes.map(wipe => <p key={wipe.id}><AppLink to={`/admin/wipes/${encodeURIComponent(wipe.id)}`}>{wipe.title}</AppLink> · {time(wipe.serverScheduledWipeAt, zone)}</p>)}{scheduled.error || active.error ? <Notice title={t('暂时无法完整读取档期范围，请先检查档期管理。')}/> : !scheduled.data || !active.data ? <p>{t('正在读取档期范围…')}</p> : !wipes.length ? <p>{t('当前授权范围内没有已排期或进行中的档期。')}</p> : null}<p className="caption">{t('这里只展示当前授权可见的档期；后台同步仍按整个平台配置运行。')} <AppLink to="/admin/wipes">{t(scheduled.data?.nextCursor || active.data?.nextCursor ? '查看其余档期' : '打开档期管理')}</AppLink></p></div>;
}
export default function Automation({platform, data, draft, change, disabled, dirty, onSave, onReset}) {
  return <section className="panel bot-automation"><h2>{t('平台自动卡片同步')} · {platform === 'discord' ? 'Discord' : 'KOOK'}</h2><label className="cs-toggle"><span><strong>{t('档期卡片自动同步')}</strong><small>{t('这是平台级总开关，影响此平台所有符合条件的目标。')}</small></span><input aria-label={t('档期卡片自动同步')} type="checkbox" role="switch" checked={draft.autoWipeCards === true} disabled={disabled} onChange={event => change('autoWipeCards', event.target.checked)}/></label><AutomationImpact platform={platform} data={data} draft={draft}/><div className="platform-actions"><button type="button" className="button" disabled={disabled || !dirty} onClick={onReset}>{t('放弃改动')}</button><button type="button" className="button primary" disabled={disabled || !dirty} onClick={onSave}>{t('保存平台同步设置')}</button></div></section>;
}
