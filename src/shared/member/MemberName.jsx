import React from 'react';
import { copyText } from '../browser.js';
import { cx } from '../ui/cx.js';
import { Avatar } from './Avatar.jsx';

export function normalizeMemberProfileCandidate(source = {}) {
  const nestedMember = source?.member && typeof source.member === 'object' ? source.member : null;
  const base = nestedMember || source || {};
  const id = base.id || base.memberId || source?.memberId || nestedMember?.memberId || '';
  const steamId = base.steamId || source?.steamId || nestedMember?.steamId || '';
  return {
    ...base,
    id,
    steamId,
    displayName: base.displayName || source?.displayName || base.customName || base.steamNickname || steamId || '',
    customName: base.customName || source?.customName || '',
    steamNickname: base.steamNickname || source?.steamNickname || '',
    avatar: base.avatar || source?.avatar || ''
  };
}

export function MemberName({ member, t, setToast, showSteamId = false, onProfileClick = null }) {
  const profileMember = normalizeMemberProfileCandidate(member || {});
  const steamLine = profileMember?.steamNickname && profileMember?.customName ? `${t('steamNicknamePrefix')}: ${profileMember.steamNickname}` : '\u00a0';
  const steamId = profileMember?.steamId || '';
  const avatar = <Avatar member={profileMember || {}} />;
  const canOpenProfile = Boolean(onProfileClick && profileMember?.id);
  return (
    <div className={cx('member-name-cell', showSteamId && 'member-name-cell-with-steam')}>
      {canOpenProfile ? (
        <button type="button" className="avatar-profile-button" title={t('viewProfile')} onClick={() => onProfileClick(profileMember)}>
          {avatar}
        </button>
      ) : avatar}
      <div className={cx('member-name-text', showSteamId && 'member-name-text-with-steam')}>
        <div className="strong-cell">{profileMember?.displayName || profileMember?.steamId || '-'}</div>
        <small className={cx('member-name-steam', !profileMember?.steamNickname || !profileMember?.customName ? 'placeholder-line' : '')}>{steamLine}</small>
        {showSteamId && (
          <button
            type="button"
            className="steam-copy-line mono"
            title={steamId ? t('copy') : undefined}
            onClick={() => steamId && copyText(steamId, setToast, t)}
            disabled={!steamId}
          >
            {steamId || '-'}
          </button>
        )}
      </div>
    </div>
  );
}
