import React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink } from 'lucide-react';
import { AppLink } from '../context.jsx';
import { t } from '../i18n.js';
import { Avatar, Button, Modal, Panel } from '../ui.jsx';
import { sortRealtimeMembers } from './member-sort.js';

const status = member => member.online === null || member.online === undefined ? t('未知') : member.online ? t('在线') : t('离线');

function SortHeading({ label, field, sort, onSort }) {
  const active = sort.key === field;
  const Icon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;
  return <th scope="col" aria-sort={active ? sort.direction === 'asc' ? 'ascending' : 'descending' : 'none'}>
    <button type="button" className="rt-sort" onClick={() => onSort(field)}>{t(label)}<Icon size={14} aria-hidden="true" /></button>
  </th>;
}

export function RealtimeMembersTable({ members, commands, sort, onSort, onProfile, onImport, time }) {
  return <Panel className="rt-members-panel">
    <div className="rt-heading"><h2>{t('当前战队成员')}</h2><span className="caption">{members.length} {t('成员')}</span></div>
    <div className="rt-table"><table><thead><tr>
      <th scope="col">{t('成员')}</th>
      <SortHeading label="组织关系 / 游戏战队" field="relationship" sort={sort} onSort={onSort} />
      <SortHeading label="状态" field="status" sort={sort} onSort={onSort} />
      <SortHeading label="最近在线" field="lastOnlineAt" sort={sort} onSort={onSort} />
      <SortHeading label="最近离线" field="lastOfflineAt" sort={sort} onSort={onSort} />
      <th scope="col">{t('操作')}</th>
    </tr></thead><tbody>{sortRealtimeMembers(members, sort).map(member =>
      <tr key={member.steamId || member.displayName}>
        <td><button className="rt-person" onClick={() => onProfile(member)}><Avatar name={member.displayName} src={member.avatar}/><span><strong>{member.displayName}</strong><small>{member.steamId}</small></span></button></td>
        <td><span className="rt-relationship">{member.registered ? member.squadName || t('已登记') : t('未登记成员')}</span><small>{member.gameClanName || '—'}</small></td>
        <td><span className={`rt-status rt-status-${member.online === true ? 'online' : member.online === false ? 'offline' : 'unknown'}`}>{status(member)}</span></td>
        <td className="rt-date">{time(member.lastOnlineAt)}</td>
        <td className="rt-date">{time(member.lastOfflineAt)}</td>
        <td>{!member.registered && commands.importMember && <Button onClick={() => onImport(member)}>{t('导入成员')}</Button>}</td>
      </tr>
    )}</tbody></table>{!members.length && <p className="rt-table-empty">{t('尚无成员观察记录。')}</p>}</div>
  </Panel>;
}

export function RealtimeMemberModal({ member, onClose, time }) {
  const name = member.displayName || member.inviteeName || member.steamId || t('未知成员');
  const canOpenSteam = /^\d{17}$/.test(member.steamId || '');
  return <Modal className="rt-member-modal" title={t('实时成员详情')} onClose={onClose} actions={<>
    {canOpenSteam && <a className="button" href={`https://steamcommunity.com/profiles/${member.steamId}`} target="_blank" rel="noreferrer">{t('查看 Steam 公开资料')}<ExternalLink size={15} /></a>}
    {member.memberId && <AppLink className="button primary" to={`/admin/members/profile/${encodeURIComponent(member.memberId)}`} onClick={onClose}>{t('查看站内成员资料')}</AppLink>}
  </>}>
    <div className="rt-member-hero">
      <Avatar className="rt-member-avatar" name={name} src={member.avatar} size={58}/>
      <div className="rt-member-identity"><h3>{name}</h3><p>Steam ID · <span>{member.steamId || '—'}</span></p></div>
      <span className={`rt-status rt-status-${member.online === true ? 'online' : member.online === false ? 'offline' : 'unknown'}`}>{status(member)}</span>
    </div>
    <dl className="rt-member-facts">
      <div><dt>{t('组织关系')}</dt><dd>{member.registered ? member.squadName || t('已登记') : t('未登记成员')}</dd></div>
      <div><dt>{t('游戏战队')}</dt><dd>{member.gameClanName || '—'}</dd></div>
      <div><dt>{t('最近在线')}</dt><dd>{time(member.lastOnlineAt)}</dd></div>
      <div><dt>{t('最近离线')}</dt><dd>{time(member.lastOfflineAt)}</dd></div>
    </dl>
  </Modal>;
}
