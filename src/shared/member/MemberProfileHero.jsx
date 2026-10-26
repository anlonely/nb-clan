import React from 'react';
import { BarChart3, Database, ExternalLink, Pencil, RefreshCw } from 'lucide-react';
import { copyText } from '../browser.js';
import { cx } from '../ui/cx.js';
import { Avatar } from './Avatar.jsx';

export function MemberProfileHero({
  profile,
  profileUrl,
  t,
  setToast,
  canSyncOnline,
  canManageProfile,
  canEditProfile,
  showHexaytron = false,
  loading,
  onlineLoading,
  steamLoading,
  kdaLoading,
  hexaytronLoading,
  onRefreshOnline,
  onRefreshSteam,
  onRefreshKda,
  onRefreshHexaytron,
  onEdit
}) {
  const steamId = profile?.steamId || '';
  const steamName = profile?.steamNickname || '';
  const nickname = profile?.customName || '';
  return (
    <div className="member-profile-hero">
      <div className="member-profile-identity">
        <Avatar member={profile || {}} />
        <div className="member-profile-identity-lines">
          <div className="member-profile-identity-row">
            <span>{t('steamName')}</span>
            <strong>{steamName || '-'}</strong>
          </div>
          <div className="member-profile-identity-row">
            <span>{t('profileNickname')}</span>
            <strong>{nickname || '\u00a0'}</strong>
          </div>
          <div className="member-profile-identity-row">
            <span>{t('steamId')}</span>
            <button
              type="button"
              className="member-profile-steamid mono"
              title={steamId ? t('copy') : undefined}
              disabled={!steamId}
              onClick={() => steamId && copyText(steamId, setToast, t)}
            >
              {steamId || '-'}
            </button>
          </div>
        </div>
      </div>
      <div className="member-profile-actions">
        <a
          className={cx('action-button', !profileUrl && 'disabled')}
          title={t('steamProfileLink')}
          href={profileUrl || undefined}
          target="_blank"
          rel="noreferrer"
          aria-disabled={!profileUrl}
        >
          <ExternalLink size={15} />
          <span>{t('steamProfileLink')}</span>
        </a>
        {canSyncOnline && (
          <button
            type="button"
            className="action-button"
            title={t('updateBmTime')}
            disabled={!profile?.id || loading || onlineLoading}
            onClick={onRefreshOnline}
          >
            <RefreshCw size={15} />
            <span>{onlineLoading ? t('updatingOnlineTime') : t('updateBmTime')}</span>
          </button>
        )}
        {canManageProfile && (
          <button
            type="button"
            className="action-button"
            title={t('refreshSteamData')}
            disabled={!profile?.id || !steamId || loading || steamLoading}
            onClick={onRefreshSteam}
          >
            <RefreshCw size={15} />
            <span>{steamLoading ? t('loading') : t('refreshSteamData')}</span>
          </button>
        )}
        {canManageProfile && (
          <button
            type="button"
            className="action-button"
            title={t('refreshKdaData')}
            disabled={!profile?.id || !steamId || loading || kdaLoading}
            onClick={onRefreshKda}
          >
            <BarChart3 size={15} />
            <span>{kdaLoading ? t('loading') : t('refreshKdaData')}</span>
          </button>
        )}
        {showHexaytron && canManageProfile && (
          <button
            type="button"
            className="action-button"
            title={t('refreshHexaytronData')}
            disabled={!profile?.id || !steamId || loading || hexaytronLoading}
            onClick={onRefreshHexaytron}
          >
            <Database size={15} />
            <span>{hexaytronLoading ? t('refreshingHexaytronData') : t('refreshHexaytronData')}</span>
          </button>
        )}
        {canEditProfile && (
          <button type="button" className="action-button" title={t('editMember')} onClick={onEdit}>
            <Pencil size={15} />
            <span>{t('edit')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
