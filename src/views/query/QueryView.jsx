import React, { useState } from 'react';
import { BadgeCheck, Download, ExternalLink, Search } from 'lucide-react';
import { exportTimeZoneFor } from '../../i18n/languages.js';
import { api } from '../../shared/api.js';
import { copyText, downloadFetchResponse } from '../../shared/browser.js';
import { formatCurrencyValue, useCurrencyContext } from '../../shared/currency.js';
import { OfficialKdaCompactCard } from '../../shared/data-lookup/official-kda.jsx';
import {
  battlemetricsPlayTimeMinutes,
  displayDataValue,
  formatPlayTimeMinutes,
  formatPublicLabel,
  formatTime,
  localizeError
} from '../../shared/format.js';
import { CurrentQueryKdaPanel, ServerGameInfoPanel } from '../../shared/member/game-info.jsx';
import { MemberProfileHero } from '../../shared/member/MemberProfileHero.jsx';
import {
  SteamBanStatusMetricCard,
  steamBanYesNoText
} from '../../shared/member/steam-ban.jsx';
import { SpecialtyBadge } from '../../shared/member/specialty.jsx';
import { VitalVipSummary } from '../../shared/member/profile-form.jsx';
import { Alert } from '../../shared/ui/Alert.jsx';
import { InfoGrid } from '../../shared/ui/InfoGrid.jsx';
import { MetricCard } from '../../shared/ui/MetricCard.jsx';
import { cx } from '../../shared/ui/cx.js';

function normalizeParticipantStatus(status) {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'join_8h') return 'join_8h';
  if (['late', 'join_16h', 'bench', 'backup'].includes(value)) return 'join_16h';
  if (['skip', 'unsure', 'not_attending', 'absent', 'not_joining'].includes(value)) return 'not_attending';
  return 'on_time';
}

function participantStatusText(status, t) {
  const normalized = normalizeParticipantStatus(status);
  if (normalized === 'join_8h') return t('statusParticipantJoin8h');
  if (normalized === 'join_16h') return t('statusParticipantJoin16h');
  if (normalized === 'not_attending') return t('statusParticipantNotAttending');
  return t('statusParticipantActive');
}

function isWipeStarted(currentWipe, now = Date.now()) {
  const time = Date.parse(currentWipe?.startedAt || '');
  return Number.isFinite(time) && time <= now;
}

function currentWipeSignupText(currentWipe, t) {
  if (!currentWipe?.hasActiveWipe) return t('noActiveWipeStatus');
  if (currentWipe.wipeStatus === 'closed') {
    return currentWipe.isRegistered
      ? `${t('statusClosed')} · ${participantStatusText(currentWipe.status, t)}`
      : `${t('statusClosed')} · ${t('notRegisteredCurrentWipe')}`;
  }
  if (currentWipe.wipeStatus === 'planned') {
    if (!currentWipe.isRegistered) return `${t('statusPlanned')} · ${t('notRegisteredCurrentWipe')}`;
    return `${t('statusPlanned')} · ${t('registeredCurrentWipe')} · ${participantStatusText(currentWipe.status, t)}`;
  }
  if (!currentWipe.isRegistered) return t('notRegisteredCurrentWipe');
  return `${t('registeredCurrentWipe')} · ${participantStatusText(currentWipe.status, t)}`;
}

function publicCurrentWipeStatusText(currentWipe, t, now = Date.now()) {
  if (!currentWipe?.hasActiveWipe) return t('noActiveWipeStatus');
  if (currentWipe.wipeStatus === 'closed') return currentWipeSignupText(currentWipe, t);
  if (currentWipe.wipeStatus === 'planned') return currentWipeSignupText(currentWipe, t);
  if (!currentWipe.isRegistered) return t('notRegisteredCurrentWipe');
  if (isWipeStarted(currentWipe, now)) return t('playingNow');
  return currentWipeSignupText(currentWipe, t);
}

function squadLeaderProfiles(squad) {
  if (!squad) return [];
  const leaders = Array.isArray(squad.leaders) && squad.leaders.length
    ? squad.leaders
    : [squad.leader].filter(Boolean);
  return leaders.filter((leader) => leader?.displayName || leader?.steamId || leader?.profileUrl);
}

function publicSteamIdentity(source = {}) {
  const steamId = source?.steamId || '';
  return {
    displayName: source?.displayName || source?.steamNickname || steamId || '-',
    steamId,
    avatar: source?.avatar || '',
    profileUrl: source?.profileUrl || (steamId ? `https://steamcommunity.com/profiles/${steamId}` : '')
  };
}

function PublicSteamIdentityCard({ label, role = '', profile, t }) {
  const identity = publicSteamIdentity(profile);
  const initial = String(identity.displayName || identity.steamId || '?').trim().slice(0, 1).toUpperCase();
  return (
    <div className="public-identity-card">
      <div className="public-identity-kicker">
        <span>{label}</span>
        {role && <b>{role}</b>}
      </div>
      <div className="public-identity-main">
        {identity.avatar ? (
          <img className="public-identity-avatar" src={identity.avatar} alt="" loading="lazy" />
        ) : (
          <span className="public-identity-avatar placeholder-avatar">{initial}</span>
        )}
        <div className="public-identity-text">
          <strong>{identity.displayName}</strong>
        </div>
      </div>
    </div>
  );
}

function LeaderProfilesList({ leaders, t, showMeta = false, primaryLabel = '', simple = false }) {
  const profiles = (leaders || []).map((leader) => publicSteamIdentity(leader));
  if (!profiles.length) return <span>-</span>;
  return (
    <div className={cx('leader-profile-list', showMeta && 'with-meta', simple && 'simple')}>
      {profiles.map((identity, index) => {
        const initial = String(identity.displayName || identity.steamId || '?').trim().slice(0, 1).toUpperCase();
        return (
          <div key={`${identity.steamId || identity.displayName}-${index}`} className="leader-profile-row">
            {identity.avatar ? (
              <img className="leader-profile-avatar" src={identity.avatar} alt="" loading="lazy" />
            ) : (
              <span className="leader-profile-avatar placeholder-avatar">{initial}</span>
            )}
            <span className="leader-profile-text">
              <strong>{identity.displayName || identity.steamId || '-'}</strong>
              {showMeta && <small className="mono">{identity.steamId || t('unbound')}</small>}
            </span>
            {primaryLabel && index === 0 && <b className="primary-leader-badge">{primaryLabel}</b>}
            {showMeta && identity.profileUrl && (
              <a className="leader-profile-link" href={identity.profileUrl} target="_blank" rel="noreferrer" title={t('steamProfileLink')}>
                <ExternalLink size={14} />
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PublicSquadLeadersCard({ label, role = '', leaders, t }) {
  return <PublicSteamIdentityCard label={label} role={role} profile={(leaders || [])[0]} t={t} />;
}

function PublicUnassignedRiskCard({ label, t }) {
  return (
    <div className="public-identity-card public-unassigned-risk-card">
      <div className="public-identity-kicker">
        <span>{label}</span>
        <b>{t('publicUnassignedRiskTitle')}</b>
      </div>
      <div className="public-risk-message">
        <span>{t('publicUnassignedRiskText')}</span>
      </div>
    </div>
  );
}

function InternalQueryMemberResult({ member, leaders, lang, t, setToast, currencyContext }) {
  const profileStats = member?.profileStats || {};
  const officialKda = profileStats.officialKda || null;
  const battlemetricsWipeMinutes = battlemetricsPlayTimeMinutes(profileStats, 'server');
  const battlemetricsTotalMinutes = battlemetricsPlayTimeMinutes(profileStats, 'total');
  const inventoryText = profileStats.inventoryPublic
    ? formatCurrencyValue(profileStats.inventoryValue, profileStats.inventoryCurrency, lang, currencyContext)
    : t('privateData');
  return (
    <div className="lookup-detail-stack lookup-detail-full">
      <MemberProfileHero
        profile={member}
        profileUrl={member?.profileUrl}
        t={t}
        setToast={setToast}
        canSyncOnline={false}
        canManageProfile={false}
        canEditProfile={false}
        loading={false}
        onlineLoading={false}
        steamLoading={false}
      />

      <section className="query-detail-section">
        <div className="section-heading compact-heading member-profile-heading-row">
          <h3>{t('gameInfo')}</h3>
          <div className="account-privacy-badges">
            <span className={cx('account-privacy-badge', profileStats.profilePublic ? 'public' : 'private')}>
              {profileStats.profilePublic ? t('publicAccount') : t('privateAccount')}
            </span>
            <span className={cx('account-privacy-badge', profileStats.inventoryPublic ? 'public' : 'private')}>
              {profileStats.inventoryPublic ? t('publicInventory') : t('privateInventory')}
            </span>
            <span className={cx('account-privacy-badge', profileStats.playTimeKnown ? 'public' : 'private')}>
              {profileStats.playTimeKnown ? t('publicPlayTime') : t('privatePlayTime')}
            </span>
          </div>
        </div>
        <div className="profile-metric-grid query-profile-metric-grid">
          <MetricCard label={t('steamHours')} value={formatPlayTimeMinutes(profileStats.playTimeMinutes, lang)} />
          <MetricCard label={t('battlemetricsWipeHours')} value={formatPlayTimeMinutes(battlemetricsWipeMinutes, lang)} />
          <MetricCard label={t('battlemetricsTotalHours')} value={formatPlayTimeMinutes(battlemetricsTotalMinutes, lang)} />
          <OfficialKdaCompactCard kda={officialKda} loading={false} lang={lang} t={t} />
          <MetricCard label={t('inventoryValue')} value={inventoryText} />
          <SteamBanStatusMetricCard stats={profileStats} lang={lang} t={t} />
          <MetricCard label={t('communityBanStatus')} value={steamBanYesNoText(profileStats.communityBanned, profileStats, t)} />
          <MetricCard label={t('economyBanStatus')} value={steamBanYesNoText(profileStats.economyRestricted, profileStats, t)} />
          <MetricCard label={t('profileUpdatedAt')} value={formatTime(profileStats.fetchedAt, lang) || t('notSyncedYet')} />
        </div>
      </section>

      <section className="query-detail-section">
        <div className="section-heading compact-heading">
          <h3>{t('memberIdentity')}</h3>
        </div>
        <InfoGrid className="query-info-grid" items={[
          [t('memberName'), member.customName || '-'],
          [t('steamName'), member.steamNickname || member.displayName || '-'],
          [t('steamId'), (
            <button
              type="button"
              className="inline-copy-value mono"
              title={t('copy')}
              onClick={() => member.steamId && copyText(member.steamId, setToast, t)}
              disabled={!member.steamId}
            >
              {member.steamId || '-'}
            </button>
          )],
          [t('battlemetricsId'), member.battlemetricsId || '-'],
          [t('specialty'), <SpecialtyBadge value={member.specialty} t={t} />],
          [t('vitalVip'), <VitalVipSummary member={member} t={t} />],
          [t('squad'), member.squadName || t('unassignedSquad')],
          [t('squadLeaderIdentity'), <LeaderProfilesList leaders={leaders} t={t} simple />],
          [t('currentWipeStatus'), publicCurrentWipeStatusText(member.currentWipe, t)]
        ]} />
      </section>

      <section className="query-detail-section">
        <div className="section-heading compact-heading">
          <h3>{t('contactInfo')}</h3>
        </div>
        <InfoGrid className="query-info-grid" items={[
          [t('discordName'), member.discordName || '-'],
          [t('discordId'), member.discordId || '-'],
          ...(member.wechatNickname ? [[t('wechatNickname'), member.wechatNickname]] : []),
          [t('wechatId'), member.wechatId || '-'],
          [t('phone'), member.phone || '-'],
          [t('notes'), member.notes || '-'],
          [t('inviter'), displayDataValue(member.inviterName, t)],
          [t('invitedAt'), formatTime(member.invitedAt, lang) || '-'],
          [t('createdAt'), formatTime(member.createdAt, lang) || '-'],
          [t('updatedAt'), formatTime(member.updatedAt, lang) || '-']
        ]} />
      </section>

      <ServerGameInfoPanel recentOnline={member.recentHistoryServerOnline} currentOnline={member.serverOnline} lang={lang} t={t} />
      <CurrentQueryKdaPanel kda={member.currentKda} fallbackSource={member.recentHistoryServerOnline || member.serverOnline} lang={lang} t={t} />
    </div>
  );
}

export default function QueryView({ setToast, lang, t, compact = false, publicHome = false }) {
  const [steamInput, setSteamInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [exportingDetail, setExportingDetail] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const currencyContext = useCurrencyContext(lang);
  const publicSquad = result?.member?.currentWipe?.squad || result?.member?.squad || null;
  const publicPrimaryLeader = squadLeaderProfiles(publicSquad).slice(0, 1);
  const detailSquad = result?.member?.squad || result?.member?.currentWipe?.squad || null;
  const detailSquadLeaders = squadLeaderProfiles(detailSquad);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setResult(null);
    setLoading(true);
    try {
      const payload = await api('/api/query', {
        method: 'POST',
        body: { steamInput, detailed: !publicHome }
      });
      setResult(payload);
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  async function exportDetailImage() {
    const exportSteamInput = result?.member?.steamId || result?.steamId || steamInput;
    if (!exportSteamInput || exportingDetail) return;
    setExportingDetail(true);
    setError('');
    try {
      const response = await fetch('/api/query/export-image', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steamInput: exportSteamInput,
          language: lang,
          timeZone: exportTimeZoneFor(lang)
        })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || t('requestFailed'));
      }
      await downloadFetchResponse(response, 'NB-Clan-member-detail.png');
      setToast(t('detailImageExported'));
    } catch (err) {
      setError(localizeError(err.message, t) || t('detailImageFailed'));
    } finally {
      setExportingDetail(false);
    }
  }

  return (
    <section className={cx('query-screen', compact && 'compact-query', publicHome && 'home-query')}>
      <form className="query-box" onSubmit={submit}>
        <div className="query-input-wrap">
          <Search size={22} />
          <input
            value={steamInput}
            onChange={(event) => setSteamInput(event.target.value)}
            placeholder={t('steamPlaceholder')}
            aria-label="Steam ID"
            required
          />
        </div>
        <button className={cx('primary-button query-button', loading && 'loading')} title={t('query')} disabled={loading}>
          <Search size={20} />
          <span>{loading ? t('querying') : t('queryShort')}</span>
        </button>
      </form>

      {error && <Alert tone="danger">{error}</Alert>}

      {result && (
        <div className={cx('lookup-card', result.isMember ? 'member-ok' : 'member-miss', publicHome && 'public-lookup-card')}>
          <div className="lookup-card-head">
            <div className="lookup-head-main">
              <span className="lookup-status-icon"><BadgeCheck size={22} /></span>
              <div>
                <strong>{result.isMember ? (publicHome ? t('lookupConfirmed') : t('memberHit')) : (publicHome ? t('lookupNotFound') : t('memberMiss'))}</strong>
                <span>{result.isMember ? (publicHome ? t('publicQueryResultHint') : t('memberDetails')) : result.steamId}</span>
              </div>
            </div>
            {result.isMember && (
              <button type="button" className="ghost-button detail-image-button" onClick={exportDetailImage} disabled={exportingDetail}>
                <Download size={16} />
                <span>{exportingDetail ? t('exportingImage') : t('exportDetailImage')}</span>
              </button>
            )}
          </div>
          {result.isMember && publicHome && (
            <div className="public-lookup-body">
              <div className="public-profile-grid">
                <PublicSteamIdentityCard label={t('memberIdentity')} profile={result.member} t={t} />
                {publicSquad ? (
                  <PublicSquadLeadersCard
                    label={formatPublicLabel(t('squad'), publicSquad.name || t('unassignedSquad'), lang)}
                    role={t('leader')}
                    leaders={publicPrimaryLeader}
                    t={t}
                  />
                ) : (
                  <PublicUnassignedRiskCard label={formatPublicLabel(t('squad'), t('unassignedSquad'), lang)} t={t} />
                )}
              </div>
              <div className={cx('lookup-signup-card', result.member?.currentWipe?.isRegistered && 'active', isWipeStarted(result.member?.currentWipe) && 'playing')}>
                <span>{t('currentWipeStatus')}</span>
                <strong>{publicCurrentWipeStatusText(result.member?.currentWipe, t)}</strong>
              </div>
            </div>
          )}
          {result.isMember && !publicHome && (
            <InternalQueryMemberResult
              member={result.member}
              leaders={detailSquadLeaders}
              lang={lang}
              t={t}
              setToast={setToast}
              currencyContext={currencyContext}
            />
          )}
        </div>
      )}
    </section>
  );
}
