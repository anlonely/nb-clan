import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, Clipboard, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { api } from '../../shared/api.js';
import { formatCopy, formatStatNumber, formatTime, localizeError } from '../../shared/format.js';
import { createLatestRequestController, isAbortError } from '../../shared/request-control.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';
import { SpecialtyBadge } from '../../shared/member/specialty.jsx';
import { MemberName } from '../../shared/member/MemberName.jsx';
import { MemberProfileModal } from '../../shared/member/dialogs.jsx';

const WECHAT_BOUND_MEMBER_PAGE_SIZE = 30;

const WECHAT_REVIEW_FILTERS = ['pending', 'need_more', 'approved', 'rejected', 'cancelled', 'all'];
const WECHAT_BOUND_MEMBER_FILTERS = ['any', 'wechat', 'discord', 'both'];

function wechatStatusLabel(status, t) {
  const key = {
    all: 'wechatStatusAll',
    pending: 'wechatStatusPending',
    need_more: 'wechatStatusNeedMore',
    approved: 'wechatStatusApproved',
    rejected: 'wechatStatusRejected',
    cancelled: 'wechatStatusCancelled',
    blocked: 'wechatStatusBlocked',
    guest: 'wechatStatusGuest'
  }[status || 'pending'] || 'wechatStatusPending';
  return t(key);
}

function wechatBoundMemberFilterLabel(filter, t) {
  if (filter === 'wechat') return t('wechatBoundFilterWechat');
  if (filter === 'discord') return t('wechatBoundFilterDiscord');
  if (filter === 'both') return t('wechatBoundFilterBoth');
  return t('wechatBoundFilterAny');
}

function wechatStatusTone(status) {
  if (status === 'approved') return 'active';
  if (status === 'rejected' || status === 'cancelled' || status === 'blocked') return 'closed';
  if (status === 'need_more' || status === 'pending' || status === 'guest') return 'pending';
  return 'neutral';
}

function WechatReviewStatusBadge({ status, t }) {
  return <span className={cx('status-badge', wechatStatusTone(status))}>{wechatStatusLabel(status, t)}</span>;
}

function wechatDisplayName(value = {}) {
  return value.displayName || value.memberName || value.name || value.steamNickname || value.steamId || '-';
}

function reviewSteamMemberFromItem(item = {}) {
  const steamId = item.steamId || '';
  const displayName = item.memberName ||
    item.name ||
    item.steamNickname ||
    (item.type === 'discord_member' ? '' : item.displayName) ||
    steamId ||
    '-';
  return {
    id: item.memberId || item.targetMemberId || '',
    displayName,
    steamNickname: item.steamNickname || '',
    customName: item.memberName || item.name || '',
    steamId,
    avatar: item.steamAvatar || item.avatar || ''
  };
}

function WechatSteamCell({ item, setToast, t, onProfileClick = null }) {
  const steamMember = reviewSteamMemberFromItem(item);
  return (
    <MemberName
      member={steamMember}
      t={t}
      setToast={setToast}
      showSteamId
      onProfileClick={onProfileClick}
    />
  );
}

function DiscordUserCell({ application, t }) {
  const displayName = application?.displayName || application?.discordUsername || application?.discordName || '';
  const discordId = application?.discordUserId || application?.discordId || '';
  const discordAvatarUrl = application?.discordAvatarUrl || application?.avatarUrl || '';
  const displayLabel = displayName || discordId;
  const avatarLabel = displayLabel || 'D';
  return (
    <div className="wechat-user-cell">
      {discordAvatarUrl ? <img src={discordAvatarUrl} alt="" loading="lazy" /> : <span className="placeholder-avatar">{String(avatarLabel).slice(0, 1).toUpperCase()}</span>}
      <span>
        <strong>Discord：{displayLabel || t('wechatNotProvided')}</strong>
        <small>ID：{discordId || t('wechatNotProvided')}</small>
      </span>
    </div>
  );
}

function WechatUserCell({ user, t }) {
  const nickname = user?.nickname || '';
  const avatarLabel = nickname || user?.id || t('unknown');
  return (
    <div className="wechat-user-cell">
      {user?.avatarUrl ? <img src={user.avatarUrl} alt="" loading="lazy" /> : <span className="placeholder-avatar">{String(avatarLabel).slice(0, 1).toUpperCase()}</span>}
      <span>
        <strong>{t('wechatNickname')}：{nickname || t('wechatNotProvided')}</strong>
        <small>{t('wechatSystemId')}：{user?.id || t('wechatNotProvided')}</small>
      </span>
    </div>
  );
}

function WechatContactCell({ item, t }) {
  const wechatContact = item && Object.hasOwn(item, 'wechatContactId') ? item.wechatContactId : item?.wechatId;
  const contacts = [
    wechatContact ? `${t('platformWechat')}: ${wechatContact}` : '',
    item?.discordId ? `${t('platformDiscord')}: ${item.discordId}` : ''
  ].filter(Boolean);
  return <div className="wechat-contact-list">{contacts.length ? contacts.map((contact) => <span key={contact}>{contact}</span>) : <span className="wechat-empty-text">{t('wechatNotProvided')}</span>}</div>;
}

function MemberPlatformInfoCell({ member, t }) {
  const hasWechat = Boolean(member?.wechatBound || member?.wechatUser || member?.wechatId || member?.wechatContactId);
  const hasDiscord = Boolean(member?.discordBound || member?.discordId || member?.discordName);
  if (!hasWechat && !hasDiscord) {
    return <span className="wechat-empty-text">{t('wechatNotProvided')}</span>;
  }
  return (
    <div className="platform-info-stack">
      {hasWechat && (
        <div className="platform-info-row">
          <span className="status-badge neutral">{t('platformWechat')}</span>
          <WechatUserCell user={member.wechatUser || {
            id: member.wechatId || member.wechatUserId || '',
            nickname: member.wechatNickname || ''
          }} t={t} />
        </div>
      )}
      {hasDiscord && (
        <div className="platform-info-row">
          <span className="status-badge neutral">{t('platformDiscord')}</span>
          <DiscordUserCell application={{
            displayName: member.discordName || '',
            discordUserId: member.discordId || '',
            discordAvatarUrl: member.discordAvatarUrl || ''
          }} t={t} />
        </div>
      )}
    </div>
  );
}

function WechatReviewNoteCell({ inviterText, note, adminNote, t }) {
  const hasInviter = Boolean(inviterText);
  const hasNote = Boolean(note);
  return (
    <div className="wechat-note-stack">
      {hasInviter && <strong>{inviterText}</strong>}
      {hasNote && <span>{note}</span>}
      {!hasInviter && !hasNote && <span className="wechat-empty-text">{t('wechatNotProvided')}</span>}
      {adminNote && <small>{t('wechatReviewNote')}：{adminNote}</small>}
    </div>
  );
}

function WechatReviewedCell({ reviewedAt, adminNote, lang, t }) {
  return (
    <span className="status-stack">
      <small>{formatTime(reviewedAt, lang) || t('wechatNotProvided')}</small>
      {adminNote && <small>{t('wechatReviewNote')}：{adminNote}</small>}
    </span>
  );
}

function WechatReviewActions({ type, id, draft, busyAction, t, onDraftChange, onReview }) {
  const busy = Boolean(busyAction);
  const currentBusy = busyAction === `${type}:${id}`;
  return (
    <div className="wechat-review-actions">
      <textarea
        value={draft || ''}
        rows={2}
        placeholder={t('wechatAdminNotePlaceholder')}
        onChange={(event) => onDraftChange(type, id, event.target.value)}
        disabled={busy}
      />
      <div className="row-actions toolbar-compact">
        <button type="button" className="action-button success" disabled={busy} onClick={() => onReview(type, id, 'approved')}>
          <CheckSquare size={16} />
          <span>{currentBusy ? t('wechatReviewing') : t('wechatApprove')}</span>
        </button>
        <button type="button" className="action-button" disabled={busy} onClick={() => onReview(type, id, 'need_more')}>
          <Clipboard size={16} />
          <span>{t('wechatNeedMore')}</span>
        </button>
        <button type="button" className="action-button danger" disabled={busy} onClick={() => onReview(type, id, 'rejected')}>
          <X size={16} />
          <span>{t('wechatReject')}</span>
        </button>
      </div>
    </div>
  );
}

function WechatMiniProgramView({
  lang,
  t,
  setToast,
  user = null,
  onMembersUpdated = null,
  onOpenRustKdaLookup = null,
  canManageReviews = false
}) {
  const [statusFilter, setStatusFilter] = useState('pending');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [memberSearchInput, setMemberSearchInput] = useState('');
  const [memberQuery, setMemberQuery] = useState('');
  const [profileMember, setProfileMember] = useState(null);
  const [joinApplications, setJoinApplications] = useState([]);
  const [joinCounts, setJoinCounts] = useState({});
  const [discordApplications, setDiscordApplications] = useState([]);
  const [discordCounts, setDiscordCounts] = useState({});
  const [boundMembers, setBoundMembers] = useState([]);
  const [boundMemberFilter, setBoundMemberFilter] = useState('any');
  const [boundMemberMeta, setBoundMemberMeta] = useState({ total: 0, offset: 0, limit: WECHAT_BOUND_MEMBER_PAGE_SIZE, hasMore: false });
  const [boundMembersLoadingMore, setBoundMembersLoadingMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [reviewDrafts, setReviewDrafts] = useState({});
  const dataRequestControlRef = useRef(null);
  const loadMoreRequestControlRef = useRef(null);
  const loadWechatMiniProgramDataRef = useRef(null);
  if (!dataRequestControlRef.current) dataRequestControlRef.current = createLatestRequestController();
  if (!loadMoreRequestControlRef.current) loadMoreRequestControlRef.current = createLatestRequestController();
  const dataConditionsKey = useMemo(
    () => JSON.stringify([statusFilter, query, boundMemberFilter, memberQuery]),
    [boundMemberFilter, memberQuery, query, statusFilter]
  );
  const dataConditionsKeyRef = useRef(dataConditionsKey);

  useLayoutEffect(() => {
    dataConditionsKeyRef.current = dataConditionsKey;
  }, [dataConditionsKey]);

  const boundMemberRequestPath = useCallback(({ offset = 0 } = {}) => {
    const memberParams = new URLSearchParams();
    memberParams.set('limit', String(WECHAT_BOUND_MEMBER_PAGE_SIZE));
    memberParams.set('offset', String(Math.max(0, Number(offset) || 0)));
    memberParams.set('binding', boundMemberFilter);
    if (memberQuery) memberParams.set('q', memberQuery);
    return `/api/wechat/admin/members?${memberParams}`;
  }, [boundMemberFilter, memberQuery]);

  const applyBoundMemberPayload = useCallback((memberPayload, { append = false } = {}) => {
    const nextMembers = memberPayload.members || [];
    setBoundMembers((current) => {
      if (!append) return nextMembers;
      const byId = new Map(current.map((member) => [member.id, member]));
      for (const member of nextMembers) byId.set(member.id, member);
      return [...byId.values()];
    });
    setBoundMemberMeta({
      total: Math.max(0, Number(memberPayload.total || 0) || 0),
      offset: Math.max(0, Number(memberPayload.offset || 0) || 0),
      limit: Math.max(1, Number(memberPayload.limit || WECHAT_BOUND_MEMBER_PAGE_SIZE) || WECHAT_BOUND_MEMBER_PAGE_SIZE),
      hasMore: Boolean(memberPayload.hasMore)
    });
  }, []);

  const loadWechatMiniProgramData = useCallback(async ({ silent = false } = {}) => {
    const requestConditionsKey = dataConditionsKey;
    if (dataConditionsKeyRef.current !== requestConditionsKey) return;
    const requestControl = dataRequestControlRef.current;
    const request = requestControl.begin();
    loadMoreRequestControlRef.current.cancel();
    setBoundMembersLoadingMore(false);
    setLoading(true);
    setError('');
    try {
      const reviewParams = new URLSearchParams();
      if (statusFilter) reviewParams.set('status', statusFilter);
      if (query) reviewParams.set('q', query);
      const [joinPayload, discordPayload, memberPayload] = await Promise.all([
        api(`/api/wechat/admin/join-applications?${reviewParams}`, { signal: request.signal }),
        api(`/api/third-party/admin/discord-member-applications?${reviewParams}`, { signal: request.signal }),
        api(boundMemberRequestPath({ offset: 0 }), { signal: request.signal })
      ]);
      if (!requestControl.isCurrent(request) || dataConditionsKeyRef.current !== requestConditionsKey) return;
      setJoinApplications(joinPayload.applications || []);
      setJoinCounts(joinPayload.counts || {});
      setDiscordApplications(discordPayload.applications || []);
      setDiscordCounts(discordPayload.counts || {});
      applyBoundMemberPayload(memberPayload);
      if (!silent) setToast(t('wechatMiniProgramDataLoaded'));
    } catch (err) {
      if (requestControl.isCurrent(request) && dataConditionsKeyRef.current === requestConditionsKey && !isAbortError(err)) {
        setError(localizeError(err.message, t));
      }
    } finally {
      const isCurrent = requestControl.isCurrent(request) && dataConditionsKeyRef.current === requestConditionsKey;
      requestControl.finish(request);
      if (isCurrent) {
        setLoading(false);
        setLoaded(true);
      }
    }
  }, [applyBoundMemberPayload, boundMemberRequestPath, dataConditionsKey, query, setToast, statusFilter, t]);

  useLayoutEffect(() => {
    loadWechatMiniProgramDataRef.current = loadWechatMiniProgramData;
  }, [loadWechatMiniProgramData]);

  useEffect(() => {
    dataRequestControlRef.current.activate();
    loadMoreRequestControlRef.current.activate();
    return () => {
      dataRequestControlRef.current.dispose();
      loadMoreRequestControlRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    loadWechatMiniProgramData({ silent: true }).catch(() => {});
  }, [loadWechatMiniProgramData]);

  function submitReviewSearch(event) {
    event.preventDefault();
    setQuery(searchInput.trim());
  }

  function submitMemberSearch(event) {
    event.preventDefault();
    setMemberQuery(memberSearchInput.trim());
  }

  const canLoadMoreBoundMembers = Boolean(boundMemberMeta.hasMore) && !loading && !boundMembersLoadingMore;

  const loadMoreBoundMembers = useCallback(async () => {
    if (!canLoadMoreBoundMembers) return;
    const requestConditionsKey = dataConditionsKey;
    if (dataConditionsKeyRef.current !== requestConditionsKey) return;
    const requestControl = loadMoreRequestControlRef.current;
    const request = requestControl.begin();
    const requestPath = boundMemberRequestPath({ offset: boundMembers.length });
    setBoundMembersLoadingMore(true);
    setError('');
    try {
      const payload = await api(requestPath, { signal: request.signal });
      if (!requestControl.isCurrent(request) || dataConditionsKeyRef.current !== requestConditionsKey) return;
      applyBoundMemberPayload(payload, { append: true });
    } catch (err) {
      if (requestControl.isCurrent(request) && dataConditionsKeyRef.current === requestConditionsKey && !isAbortError(err)) {
        setError(localizeError(err.message, t));
      }
    } finally {
      const isCurrent = requestControl.isCurrent(request) && dataConditionsKeyRef.current === requestConditionsKey;
      requestControl.finish(request);
      if (isCurrent) setBoundMembersLoadingMore(false);
    }
  }, [applyBoundMemberPayload, boundMemberRequestPath, boundMembers.length, canLoadMoreBoundMembers, dataConditionsKey, t]);

  function updateReviewDraft(type, id, value) {
    setReviewDrafts((current) => ({ ...current, [`${type}:${id}`]: value }));
  }

  async function reviewRequest(type, id, status) {
    if (!canManageReviews) return;
    const endpointByType = {
      join: `/api/wechat/admin/join-applications/${encodeURIComponent(id)}/review`,
      discord: `/api/third-party/admin/discord-member-applications/${encodeURIComponent(id)}/review`
    };
    const endpoint = endpointByType[type];
    if (!endpoint) return;
    const key = `${type}:${id}`;
    setBusyAction(key);
    setError('');
    try {
      const payload = await api(endpoint, {
        method: 'POST',
        body: { status, adminNote: reviewDrafts[key] || '' }
      });
      setReviewDrafts((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setToast(t('wechatReviewedDone'));
      if (status === 'approved' || payload.syncQueued) {
        await onMembersUpdated?.();
      }
      await loadWechatMiniProgramDataRef.current?.({ silent: true });
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setBusyAction('');
    }
  }

  async function unbindMemberPlatform(member, platform) {
    if (!canManageReviews) return;
    const name = wechatDisplayName(member);
    const platformLabel = platform === 'discord' ? t('platformDiscord') : t('platformWechat');
    if (!window.confirm(formatCopy(t('wechatConfirmUnbind'), { name, platform: platformLabel }))) return;
    setBusyAction(`unbind:${platform}:${member.id}`);
    setError('');
    try {
      const endpoint = platform === 'discord' ? 'discord-user' : 'wechat-user';
      await api(`/api/wechat/admin/members/${encodeURIComponent(member.id)}/${endpoint}`, { method: 'DELETE' });
      setToast(t('wechatUnboundDone'));
      await onMembersUpdated?.();
      await loadWechatMiniProgramDataRef.current?.({ silent: true });
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setBusyAction('');
    }
  }

  const joinPending = Number(joinCounts.pending || 0) + Number(joinCounts.need_more || 0);
  const discordPending = Number(discordCounts.pending || 0) + Number(discordCounts.need_more || 0);
  const pendingTotal = joinPending + discordPending;
  const canSyncOnline = Boolean(user?.isRoot || user?.username === 'root');

  async function refreshProfileMember() {
    const nextMembers = await onMembersUpdated?.();
    await loadWechatMiniProgramDataRef.current?.({ silent: true });
    if (profileMember?.id && Array.isArray(nextMembers)) {
      const nextProfileMember = nextMembers.find((member) => member.id === profileMember.id);
      if (nextProfileMember) setProfileMember(nextProfileMember);
    }
  }

  if (loading && !loaded) {
    return (
      <section className="page-stack wechat-admin-page">
        <PageLoadingState t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack wechat-admin-page">
      <div className="section-heading compact-heading">
        <div className="heading-stack">
          <p>{t('wechatMiniProgramHint')}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="ghost-button fit-button" disabled={loading} onClick={() => loadWechatMiniProgramData()}>
            <RefreshCw size={17} />
            <span>{t('wechatRefresh')}</span>
          </button>
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="wechat-summary-grid">
        <div className="metric-card">
          <span>{t('wechatPendingTotal')}</span>
          <strong>{formatStatNumber(pendingTotal, lang)}</strong>
        </div>
        <div className="metric-card">
          <span>{t('wechatJoinPending')}</span>
          <strong>{formatStatNumber(joinPending, lang)}</strong>
        </div>
        <div className="metric-card">
          <span>{t('discordMemberPending')}</span>
          <strong>{formatStatNumber(discordPending, lang)}</strong>
        </div>
        <div className="metric-card">
          <span>{t('wechatBoundMembers')}</span>
          <strong>{formatStatNumber(boundMemberMeta.total || boundMembers.length, lang)}</strong>
        </div>
      </div>

      <div className="tool-panel wechat-review-panel">
        <div className="section-heading compact-heading">
          <div className="heading-stack">
            <h3>{t('wechatReviewQueue')}</h3>
            <p>{t('wechatSearchPlaceholder')}</p>
          </div>
        </div>
        <form className="member-toolbar wechat-toolbar" onSubmit={submitReviewSearch}>
          <label className="member-squad-filter">
            <select value={statusFilter} aria-label={t('status')} onChange={(event) => setStatusFilter(event.target.value)}>
              {WECHAT_REVIEW_FILTERS.map((status) => (
                <option key={status} value={status}>{wechatStatusLabel(status, t)}</option>
              ))}
            </select>
          </label>
          <label className="member-search-field">
            <Search size={16} />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('wechatSearchPlaceholder')}
              aria-label={t('wechatSearchPlaceholder')}
            />
            {searchInput && (
              <button type="button" className="icon-button" title={t('clearSearch')} onClick={() => {
                setSearchInput('');
                setQuery('');
              }}>
                <X size={15} />
              </button>
            )}
          </label>
          <button className="ghost-button fit-button" disabled={loading}>
            <Search size={17} />
            <span>{t('search')}</span>
          </button>
        </form>

        <div className="wechat-review-grid">
          <div className="wechat-review-section">
            <div className="section-heading compact-heading">
              <h3>{t('discordMemberApplications')}</h3>
              <span className="status-badge pending">{formatStatNumber(discordApplications.length, lang)}</span>
            </div>
            <DataTable className="discord-member-application-table" columns={[t('wechatSteamInfo'), t('discordApplicant'), t('discordRegisterSquad'), t('specialty'), t('status'), t('wechatReviewNote'), t('manage')]} emptyText={loading ? t('loading') : t('discordNoMemberApplications')}>
              {discordApplications.map((application) => {
                const key = `discord:${application.id}`;
                return (
                  <tr key={application.id}>
                    <td><WechatSteamCell item={application} setToast={setToast} t={t} onProfileClick={setProfileMember} /></td>
                    <td><DiscordUserCell application={application} t={t} /></td>
                    <td>{application.squadName || t('wechatNotProvided')}</td>
                    <td><SpecialtyBadge value={application.specialties || application.specialty} t={t} /></td>
                    <td>
                      <div className="status-stack">
                        <WechatReviewStatusBadge status={application.status} t={t} />
                        <small>{formatTime(application.createdAt, lang) || '-'}</small>
                      </div>
                    </td>
                    <td className="break-cell note-cell">
                      <WechatReviewedCell reviewedAt={application.reviewedAt} adminNote={application.adminNote} lang={lang} t={t} />
                    </td>
                    <td>
                      {canManageReviews && (application.status === 'pending' || application.status === 'need_more') ? (
                        <WechatReviewActions
                          type="discord"
                          id={application.id}
                          draft={reviewDrafts[key]}
                          busyAction={busyAction}
                          t={t}
                          onDraftChange={updateReviewDraft}
                          onReview={reviewRequest}
                        />
                      ) : (
                        <WechatReviewedCell reviewedAt={application.reviewedAt} adminNote={application.adminNote} lang={lang} t={t} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </div>

          <div className="wechat-review-section">
            <div className="section-heading compact-heading">
              <h3>{t('wechatJoinApplications')}</h3>
              <span className="status-badge pending">{formatStatNumber(joinApplications.length, lang)}</span>
            </div>
            <DataTable className="wechat-application-table" columns={[t('wechatSteamInfo'), t('wechatWechatUser'), t('specialty'), t('status'), t('wechatReason'), t('manage')]} emptyText={loading ? t('loading') : t('wechatNoJoinApplications')}>
              {joinApplications.map((application) => {
                const key = `join:${application.id}`;
                return (
                  <tr key={application.id}>
                    <td><WechatSteamCell item={application} setToast={setToast} t={t} onProfileClick={setProfileMember} /></td>
                    <td><WechatUserCell user={application.wechatUser} t={t} /></td>
                    <td><SpecialtyBadge value={application.specialties} t={t} /></td>
                    <td>
                      <div className="status-stack">
                        <WechatReviewStatusBadge status={application.status} t={t} />
                        <small>{formatTime(application.createdAt, lang) || '-'}</small>
                      </div>
                    </td>
                    <td className="break-cell note-cell">
                      <WechatReviewNoteCell inviterText={application.inviterText} note={application.reason} adminNote={application.adminNote} t={t} />
                    </td>
                    <td>
                      {canManageReviews && (application.status === 'pending' || application.status === 'need_more') ? (
                        <WechatReviewActions
                          type="join"
                          id={application.id}
                          draft={reviewDrafts[key]}
                          busyAction={busyAction}
                          t={t}
                          onDraftChange={updateReviewDraft}
                          onReview={reviewRequest}
                        />
                      ) : (
                        <WechatReviewedCell reviewedAt={application.reviewedAt} adminNote={application.adminNote} lang={lang} t={t} />
                      )}
                    </td>
                  </tr>
                );
              })}
            </DataTable>
          </div>

        </div>
      </div>

      <div className="tool-panel wechat-bound-panel">
        <div className="section-heading compact-heading">
          <div className="heading-stack">
            <h3>{t('wechatBoundMemberList')}</h3>
            <p>{t('wechatMemberSearchPlaceholder')}</p>
          </div>
        </div>
        <form className="member-toolbar wechat-toolbar" onSubmit={submitMemberSearch}>
          <label className="member-squad-filter">
            <select value={boundMemberFilter} aria-label={t('wechatPlatformInfo')} onChange={(event) => setBoundMemberFilter(event.target.value)}>
              {WECHAT_BOUND_MEMBER_FILTERS.map((filter) => (
                <option key={filter} value={filter}>{wechatBoundMemberFilterLabel(filter, t)}</option>
              ))}
            </select>
          </label>
          <label className="member-search-field">
            <Search size={16} />
            <input
              value={memberSearchInput}
              onChange={(event) => setMemberSearchInput(event.target.value)}
              placeholder={t('wechatMemberSearchPlaceholder')}
              aria-label={t('wechatMemberSearchPlaceholder')}
            />
            {memberSearchInput && (
              <button type="button" className="icon-button" title={t('clearSearch')} onClick={() => {
                setMemberSearchInput('');
                setMemberQuery('');
              }}>
                <X size={15} />
              </button>
            )}
          </label>
          <button className="ghost-button fit-button" disabled={loading}>
            <Search size={17} />
            <span>{t('search')}</span>
          </button>
          <span className="member-filter-count">{formatCopy(t('memberFilterCount'), {
            shown: formatStatNumber(boundMembers.length, lang),
            total: formatStatNumber(boundMemberMeta.total || boundMembers.length, lang)
          })}</span>
        </form>
        <DataTable className="wechat-bound-table" columns={[t('memberIdentity'), t('wechatPlatformInfo'), t('specialty'), t('squad'), t('manage')]} emptyText={loading ? t('loading') : t('wechatNoBoundMembers')}>
          {boundMembers.map((member) => (
            <tr key={member.id}>
              <td><MemberName member={{ ...member, displayName: wechatDisplayName(member) }} t={t} setToast={setToast} showSteamId onProfileClick={setProfileMember} /></td>
              <td><MemberPlatformInfoCell member={member} t={t} /></td>
              <td><SpecialtyBadge value={member.specialty} t={t} /></td>
              <td>{member.squadName || member.squad || t('unassignedSquad')}</td>
              <td>
                <div className="row-actions">
                  {Boolean(member.wechatBound || member.wechatUser || member.wechatId || member.wechatContactId) && (
                    <button type="button" className="action-button danger" disabled={!canManageReviews || Boolean(busyAction)} title={t('platformWechat')} onClick={() => unbindMemberPlatform(member, 'wechat')}>
                      <Trash2 size={16} />
                      <span>{busyAction === `unbind:wechat:${member.id}` ? t('wechatReviewing') : t('wechatUnbindWechat')}</span>
                    </button>
                  )}
                  {Boolean(member.discordBound || member.discordId || member.discordName) && (
                    <button type="button" className="action-button danger" disabled={!canManageReviews || Boolean(busyAction)} title={t('platformDiscord')} onClick={() => unbindMemberPlatform(member, 'discord')}>
                      <Trash2 size={16} />
                      <span>{busyAction === `unbind:discord:${member.id}` ? t('wechatReviewing') : t('wechatUnbindDiscord')}</span>
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </DataTable>
        <div className="member-list-load-more wechat-bound-load-more" aria-live="polite">
          {boundMembersLoadingMore ? (
            t('loadingMoreMembers')
          ) : canLoadMoreBoundMembers ? (
            <button type="button" className="ghost-button fit-button" onClick={loadMoreBoundMembers}>
              <RefreshCw size={16} />
              <span>{t('wechatLoadMoreBoundMembers')}</span>
            </button>
          ) : (
            boundMembers.length ? t('allMembersLoaded') : ''
          )}
        </div>
      </div>

      {profileMember && (
        <MemberProfileModal
          member={profileMember}
          lang={lang}
          t={t}
          setToast={setToast}
          onMemberUpdated={refreshProfileMember}
          canSyncOnline={canSyncOnline}
          onOpenRustKdaLookup={onOpenRustKdaLookup}
          onClose={() => setProfileMember(null)}
        />
      )}

    </section>
  );
}

export default WechatMiniProgramView;
