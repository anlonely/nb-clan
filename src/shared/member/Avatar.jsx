import React from 'react';
import { cx } from '../ui/cx.js';
import { activeVitalVipType } from './vip.js';

export function Avatar({ member = {} }) {
  const initial = String(member.displayName || member.steamId || '?').trim().slice(0, 1).toUpperCase();
  const vipType = activeVitalVipType(member);
  const badgeText = vipType === 'queue_skip' || vipType === 'priority' ? 'VIP' : '';
  const avatar = member.avatar
    ? <img className="member-avatar" src={member.avatar} alt="" loading="lazy" />
    : <span className="member-avatar placeholder-avatar">{initial}</span>;
  return (
    <span className={cx('member-avatar-wrap', badgeText && `vip-${vipType}`)}>
      {avatar}
      {badgeText && <span className="member-vip-badge">{badgeText}</span>}
    </span>
  );
}
