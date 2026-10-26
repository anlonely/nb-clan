import React, {useEffect, useState} from 'react';
import {t} from '../i18n.js';
import {Button, Notice} from '../ui.jsx';
import {Select} from '../select.jsx';
import {AppLink} from '../context.jsx';

export const steamLinkCommandNames = {setsteam: ['Steam 关联'], view: ['Steam 关联查询']};
export const isSteamLinkCommand = id => ['setsteam', 'view'].includes(id);
export function steamLinkCommand(id) {
  return {id, name: steamLinkCommandNames[id][0], type: 'slash_command', slashCommand: id,
    enabled: false, ...(id === 'setsteam' ? {autoMatchTeamByRole: false} : {}), titleTemplate: '', bodyTemplate: ''};
}
export const steamTeamDefaults = () => ({steamTeamCnRoleIds: [], steamTeamEuRoleIds: [], steamTeamCnSquadId: '', steamTeamEuSquadId: ''});
function IdList({label, values, disabled, onChange, hint = '每行一个 ID，或用逗号分隔；最多 30 个。角色或用户匹配任意一项即可。'}) {
  const parse = raw => [...new Set(raw.split(/[\s,，]+/).filter(Boolean))];
  const serialized = JSON.stringify(values), [raw, setRaw] = useState(values.join('\n'));
  useEffect(() => {setRaw(current => JSON.stringify(parse(current)) === serialized ? current : values.join('\n'));}, [serialized]);
  return <label className="cs-field"><span>{label}</span><textarea aria-label={label} value={raw} maxLength={1000} disabled={disabled}
    onChange={event => {setRaw(event.target.value); onChange(parse(event.target.value));}}/>
    <small>{t(hint)}</small></label>;
}
export function SteamLinksAccess({target, roles, disabled, canLoad, onLoad, onChange}) {
  const allowed = target.steamListAllowedRoleIds || [];
  return <section className="cs-mapping-group" aria-label={t('Steam 关联与名单权限')}>
    <div className="cs-mapping-heading"><div><h4>{t('Steam 关联与名单权限')}</h4>
      <p>{t('/setsteam 与 /view user 对当前服务器普通成员开放；仅在此绑定启用的通用通知频道使用。')}</p></div>
      <Button disabled={!canLoad} onClick={() => onLoad('roles')}>{t('读取此服务器角色')}</Button></div>
    <Notice title={t('批量名单权限')}>
      {t('/view all 与 /view nosteam 允许拥有 Discord“管理员”或“管理服务器”权限的成员使用，也允许下方指定的角色或用户。留空时仅管理员可查看名单。')}
    </Notice>
    <div className="cs-fields"><div><h4>{t('允许查看 Steam 名单的角色')}</h4>
      {!!roles?.items?.some(item => item.status === 'role') && <div className="cs-command-options">{roles.items.filter(item => item.status === 'role').map(role =>
        <label key={role.id}><input type="checkbox" aria-label={t('允许查看 Steam 名单的角色 {name}', {name: role.label})}
          checked={allowed.includes(role.id)} disabled={disabled} onChange={event => onChange('steamListAllowedRoleIds', event.target.checked ? [...new Set([...allowed, role.id])] : allowed.filter(id => id !== role.id))}/>
          <span>{role.label}<small>{role.id}</small></span></label>)}</div>}
      {roles?.next && <Button disabled={!canLoad} onClick={() => onLoad('roles', true)}>{t('加载更多角色')}</Button>}
      <IdList label={t('Steam 名单允许角色 ID')} values={allowed} disabled={disabled} onChange={values => onChange('steamListAllowedRoleIds', values)}/></div>
      <IdList label={t('Steam 名单允许 Discord 用户 ID')} values={target.steamListAllowedUserIds || []} disabled={disabled} onChange={values => onChange('steamListAllowedUserIds', values)}/>
    </div>
    <p className="cs-hint">{t('批量名单需要机器人在 Discord Developer Portal 启用 Server Members Intent，并能完整读取当前服务器成员；读取失败会明确报错，不会显示空名单。')}</p>
  </section>;
}
export function SteamTeamMapping({target, command, roles, squads = [], disabled, canConfigure, canLoad, onLoad, onChange}) {
  const locked = disabled || canConfigure !== true, cn = target.steamTeamCnRoleIds || [], eu = target.steamTeamEuRoleIds || [];
  const availableSquads = squads.filter(squad => squad.canManage);
  const groups = [['Cn', 'CN', cn, eu], ['Eu', 'EU', eu, cn]];
  const issues = [
    ...(cn.length && !target.steamTeamCnSquadId ? ['已选择 CN 角色，请同时指定 CN 对应的网站队伍。'] : []),
    ...(eu.length && !target.steamTeamEuSquadId ? ['已选择 EU 角色，请同时指定 EU 对应的网站队伍。'] : []),
    ...(cn.some(role => eu.includes(role)) ? ['同一 Discord 角色不能同时分配给 CN 和 EU。'] : []),
    ...(target.steamTeamCnSquadId && target.steamTeamCnSquadId === target.steamTeamEuSquadId ? ['CN 和 EU 必须选择不同的网站队伍。'] : [])
  ];
  return <section className="cs-mapping-group" aria-label={t('Steam 关联自动分队')}>
    <div className="cs-mapping-heading"><div><h4>{t('Steam 关联自动分队')}</h4>
      <p>{t('为此服务器选择 CN / EU 的 Discord 角色与对应网站队伍。每组可选多个角色，网站队伍必须由管理员明确选择。')}</p></div>
      <Button disabled={locked || !canLoad} onClick={() => onLoad('roles')}>{t('读取分队角色')}</Button></div>
    <p className="cs-hint">{t(command?.enabled && command?.autoMatchTeamByRole === true && target.enabled && target.enabledCommandIds?.includes('setsteam')
      ? '自动分队已启用；成功关联 Steam 时按本服务器配置匹配。'
      : '自动分队当前未生效，可先配置角色和网站队伍，再到 /setsteam 功能设置启用。')} <AppLink to="/admin/bot/features/setsteam?platform=discord">{t('打开 /setsteam 功能设置')}</AppLink></p>
    {canConfigure !== true && <p className="cs-hint">{t('当前账号无权配置 Steam 自动分队；普通指令设置仍可按原权限编辑。')}</p>}
    <div className="cs-fields">{groups.map(([key, team, selected, other]) => {
      const roleKey = `steamTeam${key}RoleIds`, squadKey = `steamTeam${key}SquadId`, squadId = target[squadKey] || '';
      const otherSquad = target[`steamTeam${key === 'Cn' ? 'Eu' : 'Cn'}SquadId`];
      return <div key={team} className="cs-mapping-group"><h4>{t('{team} 角色与网站队伍', {team})}</h4>
        <label className="cs-field"><span>{t('{team} 对应的网站队伍', {team})}</span>
          <Select aria-label={t('{team} 对应的网站队伍', {team})} value={squadId} disabled={locked} onChange={event => onChange(squadKey, event.target.value)}>
            <option value="">{t('未指定网站队伍')}</option>
            {squadId && !availableSquads.some(squad => squad.id === squadId) && <option value={squadId} disabled>{t('当前队伍不可选：{id}', {id: squadId})}</option>}
            {availableSquads.map(squad => <option key={squad.id} value={squad.id} disabled={squad.id === otherSquad}>{squad.name}</option>)}
          </Select><small>{t('仅列出当前账号可管理的现有队伍，不按名称自动推断 CN / EU。')}</small></label>
        {!!roles?.items?.some(role => role.status === 'role') && <div className="cs-command-options">{roles.items.filter(role => role.status === 'role').map(role =>
          <label key={role.id}><input type="checkbox" aria-label={t('{team} 匹配角色 {name}', {team, name: role.label})} checked={selected.includes(role.id)} disabled={locked || other.includes(role.id)}
            onChange={event => onChange(roleKey, event.target.checked ? [...new Set([...selected, role.id])] : selected.filter(id => id !== role.id))}/>
            <span>{role.label}<small>{role.id}</small></span></label>)}</div>}
        <IdList label={t('{team} Discord 角色 ID', {team})} values={selected} disabled={locked} onChange={values => onChange(roleKey, values)}
          hint="每行一个角色 ID，或用逗号分隔，最多 30 个。拥有本组任意角色即可命中本组。"/>
      </div>;
    })}</div>
    {roles?.next && <Button disabled={locked || !canLoad} onClick={() => onLoad('roles', true)}>{t('加载更多角色')}</Button>}
    {issues.map(issue => <p role="alert" key={issue}>{t(issue)}</p>)}
    <p className="cs-hint">{t('仅唯一命中 CN 或 EU 时同步网站成员与组织队伍；无匹配或同时命中时不更改现有队伍，手动分队优先。')}</p>
    <p className="cs-hint">{t('新的 Discord 成员可建立网站成员档案；手动提交的 Steam 关联仍为自行声明，不视为已验证身份，也不会授予网站登录权限。')}</p>
  </section>;
}
export function SteamLinksFeature({command, disabled, canConfigureSteamTeams, onNameChange, onAutoMatchChange, section = 'all'}) {
  const isSet = command.id === 'setsteam';
  const description = t(isSet ? '成员使用 /setsteam 打开表单，填写自己的 Steam ID 或个人资料链接。关联仅属于当前 Discord 服务器，独立于网站登录绑定；手动关联不证明账号归属。' : '/view user 查询一名成员；/view all 查看已关联名单；/view nosteam 查看未关联名单。仅统计当前服务器的人类成员，排除机器人和已离开成员。');
  const Guide = section === 'guide' ? 'details' : 'section';
  return <>
    {section !== 'settings' && <>
    {section === 'guide' ? <p className="cs-feature-summary">{description}</p> : <Notice title={t(isSet ? 'Steam 关联' : 'Steam 关联查询')}>{description}</Notice>}
    </>}
    {section !== 'guide' && <>
    <label className="cs-field"><span>{t('功能名称')}</span><input value={command.name || ''} maxLength={100} disabled={disabled} onChange={event => onNameChange(event.target.value)}/></label>
    {isSet && <section className="cs-mapping-group" aria-label={t('自动匹配队伍设置')}>
      <label className="cs-toggle"><span><strong>{t('根据 Discord 角色自动匹配队伍')}</strong><small>{t('默认关闭。开启后，成功关联 Steam 时按当前服务器的 CN / EU 角色配置同步网站成员与组织队伍。')}</small></span>
        <input type="checkbox" role="switch" aria-label={t('根据 Discord 角色自动匹配队伍')} checked={command.autoMatchTeamByRole === true}
          disabled={disabled || canConfigureSteamTeams !== true} onChange={event => onAutoMatchChange(event.target.checked)}/></label>
      {canConfigureSteamTeams !== true && <p className="cs-hint">{t('当前账号无权配置 Steam 自动分队；普通指令设置仍可按原权限编辑。')}</p>}
      <p className="cs-hint">{t('仅唯一命中 CN 或 EU 时同步网站成员与组织队伍；无匹配或同时命中时不更改现有队伍，手动分队优先。')}</p>
      <p className="cs-hint">{t('新的 Discord 成员可建立网站成员档案；手动提交的 Steam 关联仍为自行声明，不视为已验证身份，也不会授予网站登录权限。')}</p>
      <AppLink to="/admin/bot/servers?platform=discord&feature=setsteam">{t('配置各服务器的 CN / EU 角色与队伍')}</AppLink>
    </section>}
    </>}
    {section !== 'settings' && <>
    <p className="cs-hint">{t('此功能默认停用。启用后，在“服务器与权限”分配功能与通用通知频道；保存后到“运行工具”注册指令。')}</p>
    <Guide className="cs-mapping-group cs-feature-guide-details" aria-label={t('功能说明与交互预览')}>{section === 'guide' ? <summary>{t('功能说明与交互预览')}</summary> : <h4>{t('功能说明与交互预览')}</h4>}
      {isSet ? <>
        <code>/setsteam</code><p>{t('打开“关联 Steam 账号”表单 → 输入 17 位 Steam ID 或 steamcommunity.com 资料链接 → 保存并返回资料卡。')}</p>
        <p>{t('重复提交同一账号保留当前关联；更换账号前显示旧值和新值，确认后再保存。取消保留原关联。')}</p>
      </> : <dl>
        <dt><code>/view user</code></dt><dd>{t('选择一个 Discord 用户，或填写 identifier：17 位 Steam ID / Steam 资料链接。两项必须且只能填写一项。')}</dd>
        <dt><code>/view all</code></dt><dd>{t('按固定顺序分页展示当前服务器已关联成员，每页最多 20 人。')}</dd>
        <dt><code>/view nosteam</code></dt><dd>{t('完整读取当前服务器成员后，分页展示尚未关联 Steam 的人类成员；不会发送提醒。')}</dd>
      </dl>}
      <p>{t('四项操作均仅执行者可见。关联与查询结果由原生交互自动生成，资料不可用时显示实际状态。')}</p>
      {!isSet && <p>{t('批量名单需要名单权限和 Server Members Intent；请在“服务器与权限”中检查。')}</p>}
    </Guide>
    </>}
  </>;
}
