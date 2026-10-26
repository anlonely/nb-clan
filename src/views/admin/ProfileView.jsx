import { useEffect, useState } from 'react';
import { KeyRound, Save } from 'lucide-react';
import { api } from '../../shared/api.js';
import { localizeError } from '../../shared/format.js';
import { accountRoleLabel } from '../../shared/permissions.js';
import { Avatar } from '../../shared/member/Avatar.jsx';
import {
  VitalVipSummary,
  atlasVipRequiresPurchaseDate,
  editableProfileFormFromMember,
  memberVipPurchaseDateValidationError,
  rustinityVipRequiresPurchaseDate,
  updateAtlasVipForm,
  updateRustinityVipForm,
  updateVitalVipForm,
  vitalVipMonthDay,
  vitalVipRequiresPurchaseDate
} from '../../shared/member/profile-form.jsx';
import { SpecialtySelect } from '../../shared/member/specialty.jsx';
import { Alert } from '../../shared/ui/Alert.jsx';

function ProfileView({ user, onUserChange, setToast, t }) {
  const [profileMember, setProfileMember] = useState(null);
  const [profileForm, setProfileForm] = useState(() => editableProfileFormFromMember(null));
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [error, setError] = useState('');
  const canEditProfile = user.role !== 'viewer' && Boolean(profileMember?.id);
  const profileDisplayName = profileMember?.displayName ||
    profileMember?.customName ||
    profileMember?.steamNickname ||
    user.steamNickname ||
    user.username ||
    '-';
  const profileSteamId = profileMember?.steamId || user.boundSteamId || '';
  const profileSquadName = profileMember?.squadName || t('unassignedSquad');
  const profileDiscordName = profileMember?.discordName || profileMember?.discordId || '-';
  const avatarMember = profileMember || {
    displayName: profileDisplayName,
    steamId: profileSteamId || user.username
  };

  useEffect(() => {
    let cancelled = false;
    async function loadProfileMember() {
      if (!user.boundSteamId) {
        setProfileMember(null);
        setProfileForm(editableProfileFormFromMember(null));
        return;
      }
      try {
        const payload = await api(`/api/members?limit=10&q=${encodeURIComponent(user.boundSteamId)}`);
        if (cancelled) return;
        const member = (payload.members || []).find((item) => item.steamId === user.boundSteamId) || null;
        setProfileMember(member);
        setProfileForm(editableProfileFormFromMember(member));
      } catch (err) {
        if (!cancelled) setError(localizeError(err.message, t));
      }
    }
    loadProfileMember();
    return () => { cancelled = true; };
  }, [t, user.boundSteamId]);

  async function saveProfile(event) {
    event.preventDefault();
    if (!canEditProfile) return;
    setError('');
    const vipError = memberVipPurchaseDateValidationError(profileForm, t);
    if (vipError) {
      setError(vipError);
      return;
    }
    try {
      const payload = await api(`/api/members/${profileMember.id}?response=member`, {
        method: 'PUT',
        body: {
          customName: profileForm.customName,
          phone: profileForm.phone,
          notes: profileForm.notes,
          specialty: profileForm.specialty,
          vitalVipType: profileForm.vitalVipType,
          vitalVipPurchasedAt: profileForm.vitalVipPurchasedAt,
          vitalVipExpiresAt: profileForm.vitalVipExpiresAt,
          rustinityVipType: profileForm.rustinityVipType,
          rustinityVipPurchasedAt: profileForm.rustinityVipPurchasedAt,
          rustinityVipExpiresAt: profileForm.rustinityVipExpiresAt,
          atlasVipType: profileForm.atlasVipType,
          atlasVipPurchasedAt: profileForm.atlasVipPurchasedAt,
          atlasVipExpiresAt: profileForm.atlasVipExpiresAt
        }
      });
      const nextMember = payload.member || profileMember;
      setProfileMember(nextMember);
      setProfileForm(editableProfileFormFromMember(nextMember));
      setToast(t('profileSaved'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function changePassword(event) {
    event.preventDefault();
    setError('');
    try {
      await api('/api/profile/password', { method: 'POST', body: passwords });
      setPasswords({ currentPassword: '', newPassword: '' });
      setToast(t('passwordChanged'));
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  return (
    <section className="profile-grid">
      <section className="tool-panel profile-overview-panel">
        <div className="profile-overview-main">
          <Avatar member={avatarMember} />
          <div className="profile-overview-copy">
            <span className="profile-overview-kicker">{t('navProfile')}</span>
            <h2>{profileDisplayName}</h2>
            <div className="profile-overview-tags">
              <span className="status-badge active">{accountRoleLabel(user, t)}</span>
              <span className="status-badge neutral">{profileSquadName}</span>
              <VitalVipSummary member={profileMember || profileForm} t={t} />
            </div>
          </div>
        </div>
        <dl className="profile-overview-details">
          <div>
            <dt>{t('account')}</dt>
            <dd>{user.username || '-'}</dd>
          </div>
          <div>
            <dt>{t('steamId')}</dt>
            <dd className="mono break-cell">{profileSteamId || t('unbound')}</dd>
          </div>
          <div>
            <dt>{t('discordName')}</dt>
            <dd>{profileDiscordName}</dd>
          </div>
        </dl>
      </section>

      {error && <Alert tone="danger" className="profile-wide-alert">{error}</Alert>}

      <form className="tool-panel profile-edit-panel" onSubmit={saveProfile}>
        <div className="section-heading compact-heading">
          <h3>{t('profilePersonalInfo')}</h3>
          <button className="primary-button fit-button" title={t('saveProfileInfo')} disabled={!canEditProfile}>
            <Save size={18} />
            <span>{t('saveShort')}</span>
          </button>
        </div>
        {!profileMember && <Alert>{t('profileMemberMissing')}</Alert>}
        <label>
          <span>{t('memberName')}</span>
          <input value={profileForm.customName} onChange={(event) => setProfileForm({ ...profileForm, customName: event.target.value })} placeholder={t('memberNamePlaceholder')} disabled={!canEditProfile} />
        </label>
        <label>
          <span>{t('phone')}</span>
          <input value={profileForm.phone} onChange={(event) => setProfileForm({ ...profileForm, phone: event.target.value })} placeholder={t('phonePlaceholder')} disabled={!canEditProfile} />
        </label>
        <label>
          <span>{t('specialty')}</span>
          <SpecialtySelect value={profileForm.specialty} onChange={(specialty) => setProfileForm({ ...profileForm, specialty })} t={t} disabled={!canEditProfile} />
        </label>
        <label>
          <span>{t('vitalVip')}</span>
          <select value={profileForm.vitalVipType} onChange={(event) => setProfileForm(updateVitalVipForm(profileForm, { vitalVipType: event.target.value }))} disabled={!canEditProfile}>
            <option value="none">{t('vitalVipNone')}</option>
            <option value="priority">{t('vitalVipPriority')}</option>
            <option value="queue_skip">{t('vitalVipQueueSkip')}</option>
          </select>
        </label>
        <label>
          <span>{t('vitalVipPurchasedAt')}</span>
          <input value={vitalVipMonthDay(profileForm.vitalVipPurchasedAt)} inputMode="numeric" pattern="[0-9]{1,2}-[0-9]{1,2}" maxLength={5} placeholder="MM-DD" onChange={(event) => setProfileForm(updateVitalVipForm(profileForm, { vitalVipPurchasedAt: event.target.value }))} disabled={!canEditProfile || profileForm.vitalVipType === 'none'} required={vitalVipRequiresPurchaseDate(profileForm)} />
        </label>
        <label>
          <span>{t('vitalVipExpiresAt')}</span>
          <input value={vitalVipMonthDay(profileForm.vitalVipExpiresAt)} placeholder="MM-DD" readOnly disabled />
        </label>
        <label>
          <span>{t('rustinityVip')}</span>
          <select value={profileForm.rustinityVipType} onChange={(event) => setProfileForm(updateRustinityVipForm(profileForm, { rustinityVipType: event.target.value }))} disabled={!canEditProfile}>
            <option value="none">{t('vitalVipNone')}</option>
            <option value="queue_skip">{t('vitalVipQueueSkip')}</option>
          </select>
        </label>
        <label>
          <span>{t('rustinityVipPurchasedAt')}</span>
          <input value={vitalVipMonthDay(profileForm.rustinityVipPurchasedAt)} inputMode="numeric" pattern="[0-9]{1,2}-[0-9]{1,2}" maxLength={5} placeholder="MM-DD" onChange={(event) => setProfileForm(updateRustinityVipForm(profileForm, { rustinityVipPurchasedAt: event.target.value }))} disabled={!canEditProfile || profileForm.rustinityVipType === 'none'} required={rustinityVipRequiresPurchaseDate(profileForm)} />
        </label>
        <label>
          <span>{t('rustinityVipExpiresAt')}</span>
          <input value={vitalVipMonthDay(profileForm.rustinityVipExpiresAt)} placeholder="MM-DD" readOnly disabled />
        </label>
        <label>
          <span>{t('atlasVip')}</span>
          <select value={profileForm.atlasVipType} onChange={(event) => setProfileForm(updateAtlasVipForm(profileForm, { atlasVipType: event.target.value }))} disabled={!canEditProfile}>
            <option value="none">{t('vitalVipNone')}</option>
            <option value="priority">{t('vitalVipPriority')}</option>
            <option value="queue_skip">{t('vitalVipQueueSkip')}</option>
          </select>
        </label>
        <label>
          <span>{t('atlasVipPurchasedAt')}</span>
          <input value={vitalVipMonthDay(profileForm.atlasVipPurchasedAt)} inputMode="numeric" pattern="[0-9]{1,2}-[0-9]{1,2}" maxLength={5} placeholder="MM-DD" onChange={(event) => setProfileForm(updateAtlasVipForm(profileForm, { atlasVipPurchasedAt: event.target.value }))} disabled={!canEditProfile || profileForm.atlasVipType === 'none'} required={atlasVipRequiresPurchaseDate(profileForm)} />
        </label>
        <label>
          <span>{t('atlasVipExpiresAt')}</span>
          <input value={vitalVipMonthDay(profileForm.atlasVipExpiresAt)} placeholder="MM-DD" readOnly disabled />
        </label>
        <label className="span-2">
          <span>{t('notes')}</span>
          <textarea value={profileForm.notes} onChange={(event) => setProfileForm({ ...profileForm, notes: event.target.value })} placeholder={t('memberNotesPlaceholder')} disabled={!canEditProfile} />
        </label>
      </form>

      <section className="tool-panel profile-platform-panel">
        <h3>{t('profilePlatformInfo')}</h3>
        <p className="profile-meta">{t('profileReadOnlyIdentity')}</p>
        <dl className="info-grid profile-info-grid">
          <div><dt>{t('steamId')}</dt><dd className="mono break-cell">{profileMember?.steamId || user.boundSteamId || '-'}</dd></div>
          <div><dt>{t('steamNickname')}</dt><dd>{profileMember?.steamNickname || user.steamNickname || '-'}</dd></div>
          <div><dt>{t('discordId')}</dt><dd className="mono break-cell">{profileMember?.discordId || '-'}</dd></div>
          <div><dt>{t('discordName')}</dt><dd>{profileMember?.discordName || '-'}</dd></div>
          <div><dt>{t('kookId')}</dt><dd className="mono break-cell">{user.kook?.id || t('unbound')}</dd></div>
          <div><dt>{t('kookName')}</dt><dd>{user.kook?.username || '-'}</dd></div>
          <div><dt>{t('kookSteamVerified')}</dt><dd>{user.kook?.steamVerified ? t('kookVerified') : '-'}</dd></div>
          <div><dt>{t('wechatId')}</dt><dd className="mono break-cell">{profileMember?.wechatId || '-'}</dd></div>
          <div><dt>{t('wechatNickname')}</dt><dd>{profileMember?.wechatNickname || '-'}</dd></div>
          <div><dt>{t('squad')}</dt><dd>{profileMember?.squadName || t('unassignedSquad')}</dd></div>
        </dl>
      </section>

      <form className="tool-panel profile-password-panel" onSubmit={changePassword}>
        <h3>{t('profileAccountSecurity')}</h3>
        <label>
          <span>{t('currentPassword')}</span>
          <input
            type="password"
            value={passwords.currentPassword}
            onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })}
            required
          />
        </label>
        <label>
          <span>{t('newPassword')}</span>
          <input
            type="password"
            value={passwords.newPassword}
            onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })}
            required
          />
        </label>
        <button className="primary-button profile-password-button">
          <KeyRound size={18} />
          <span>{t('changePassword')}</span>
        </button>
      </form>
    </section>
  );
}

export default ProfileView;
