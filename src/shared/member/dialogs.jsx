import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  BadgeCheck,
  CalendarClock,
  Crown,
  Database,
  ExternalLink,
  FileUp,
  Monitor,
  Pencil,
  RefreshCw,
  Save,
  Search,
  Server,
  ShieldCheck,
  UserCheck,
  Users,
  X
} from 'lucide-react';
import { api } from '../api.js';
import { formatCurrencyValue, useCurrencyContext } from '../currency.js';
import { OfficialKdaCompactCard } from '../data-lookup/official-kda.jsx';
import {
  battlemetricsPlayTimeMinutes,
  displayDataValue,
  formatCopy,
  formatPlayTimeMinutes,
  formatStatNumber,
  formatTime,
  localizeError
} from '../format.js';
import { CurrentQueryKdaPanel, ServerGameInfoPanel } from './game-info.jsx';
import { MemberName, normalizeMemberProfileCandidate } from './MemberName.jsx';
import { MemberProfileHero } from './MemberProfileHero.jsx';
import {
  AtlasVipSummary,
  RustinityVipSummary,
  VitalVipSummary,
  atlasVipRequiresPurchaseDate,
  memberVipPurchaseDateValidationError,
  rustinityVipRequiresPurchaseDate,
  updateAtlasVipForm,
  updateRustinityVipForm,
  updateVitalVipForm,
  vitalVipMonthDay,
  vitalVipRequiresPurchaseDate
} from './profile-form.jsx';
import { memberMatchesNormalizedSearch, normalizedMemberSearchQuery } from './search.js';
import { SpecialtyBadge, SpecialtySelect, normalizeSpecialtyValues } from './specialty.jsx';
import { SteamBanStatusMetricCard, steamBanYesNoText } from './steam-ban.jsx';
import { Alert } from '../ui/Alert.jsx';
import { InfoGrid } from '../ui/InfoGrid.jsx';
import { MetricCard } from '../ui/MetricCard.jsx';
import { ModalFrame } from '../ui/ModalFrame.jsx';
import { PageLoadingState } from '../ui/PageLoadingState.jsx';
import { cx } from '../ui/cx.js';

const HEXAYTRON_FEATURE_ENABLED = ['1', 'true', 'yes', 'on', 'enabled'].includes(String(import.meta.env.VITE_ENABLE_HEXAYTRON || '').trim().toLowerCase());
const HEXAYTRON_PROFILE_METRICS = [
  { key: 'atlas', label: 'Atlas', Icon: Crown },
  { key: 'vital', label: 'Vital', Icon: Activity },
  { key: 'rustinity', label: 'Rustinity', Icon: ShieldCheck },
  { key: 'building', label: 'Building', Icon: Server },
  { key: 'aimtrain', label: 'Aimtrain', Icon: Monitor },
  { key: 'official', label: 'Official', Icon: BadgeCheck },
  { key: 'rust', labelKey: 'hexaytronRustTotal', Icon: Database },
  { key: 'firstSeen', labelKey: 'hexaytronFirstSeen', Icon: CalendarClock }
];

function hexaytronNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function formatHexaytronHours(hours, lang = 'zh') {
  const numeric = hexaytronNumber(hours);
  if (numeric === null) return '-';
  return `${formatStatNumber(numeric, lang, { maximumFractionDigits: numeric < 100 ? 1 : 0 })} h`;
}

function formatHexaytronDaysAgo(days, lang = 'zh', t) {
  const numeric = hexaytronNumber(days);
  if (numeric === null) return '-';
  return formatCopy(t('hexaytronFirstSeenDaysAgo'), { days: formatStatNumber(Math.max(0, Math.round(numeric)), lang) });
}

function hasHexaytronProfileData(hexaytron = {}) {
  return Boolean(
    hexaytron?.fetchedAt ||
    hexaytron?.battlemetricsId ||
    (Array.isArray(hexaytron?.servers) && hexaytron.servers.length) ||
    hexaytronNumber(hexaytron?.rustHours) !== null ||
    hexaytronNumber(hexaytron?.firstSeenDaysAgo) !== null
  );
}

function hexaytronMetricRows(hexaytron = {}, lang, t) {
  const serverByKey = new Map((Array.isArray(hexaytron.servers) ? hexaytron.servers : []).map((server) => [server.key, server]));
  return HEXAYTRON_PROFILE_METRICS.map((definition) => {
    if (definition.key === 'rust') {
      return {
        ...definition,
        label: t(definition.labelKey),
        value: formatHexaytronHours(hexaytron.rustHours, lang)
      };
    }
    if (definition.key === 'firstSeen') {
      return {
        ...definition,
        label: t(definition.labelKey),
        value: formatHexaytronDaysAgo(hexaytron.firstSeenDaysAgo, lang, t)
      };
    }
    const server = serverByKey.get(definition.key);
    return {
      ...definition,
      label: definition.label,
      value: formatHexaytronHours(server?.hours, lang)
    };
  });
}

function HexaytronMetricCard({ metric }) {
  const Icon = metric.Icon;
  return (
    <div className="metric-card hexaytron-metric-card">
      <div className="hexaytron-metric-label">
        <span className="hexaytron-metric-icon"><Icon size={15} /></span>
        <span>{metric.label}</span>
      </div>
      <strong>{metric.value}</strong>
    </div>
  );
}

function HexaytronProfileSection({ hexaytron = {}, lang, t }) {
  const hasData = hasHexaytronProfileData(hexaytron);
  const metrics = hexaytronMetricRows(hexaytron, lang, t);
  return (
    <section className="member-profile-section hexaytron-profile-section">
      <div className="section-heading compact-heading">
        <h3>{t('hexaytronTimeData')}</h3>
        <div className="account-privacy-badges">
          <span className={cx('account-privacy-badge', hasData ? 'public' : 'private')}>
            {hexaytron.fetchedAt ? formatTime(hexaytron.fetchedAt, lang) : t('notSyncedYet')}
          </span>
        </div>
      </div>
      {hasData ? (
        <>
          <div className="profile-metric-grid hexaytron-metric-grid">
            {metrics.map((metric) => <HexaytronMetricCard key={metric.key} metric={metric} />)}
          </div>
          {(hexaytron.battlemetricsId || hexaytron.battlemetricsUrl || hexaytron.sourceMessageUrl) && (
            <div className="hexaytron-link-row">
              {hexaytron.battlemetricsId && <span className="status-badge">BMID {hexaytron.battlemetricsId}</span>}
              {hexaytron.battlemetricsUrl && (
                <a className="ghost-button mini-text-button" href={hexaytron.battlemetricsUrl} target="_blank" rel="noreferrer" title={t('hexaytronBattlemetricsLink')}>
                  <ExternalLink size={13} />
                  <span>{t('hexaytronBattlemetricsLink')}</span>
                </a>
              )}
              {hexaytron.sourceMessageUrl && (
                <a className="ghost-button mini-text-button" href={hexaytron.sourceMessageUrl} target="_blank" rel="noreferrer" title={t('hexaytronDiscordSource')}>
                  <ExternalLink size={13} />
                  <span>{t('hexaytronDiscordSource')}</span>
                </a>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="empty-state compact-empty">{t('hexaytronNoData')}</div>
      )}
    </section>
  );
}

function DetailIconButton({ title, onClick, disabled = false }) {
  return (
    <button type="button" className="metric-detail-button" title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <ExternalLink size={12} />
    </button>
  );
}

function ProfileDetailMetricCard({ label, value, detailTitle, onDetail }) {
  return (
    <div className="metric-card profile-detail-metric-card">
      <div className="metric-card-head">
        <span>{label}</span>
        {onDetail && <DetailIconButton title={detailTitle} onClick={onDetail} />}
      </div>
      <strong>{value}</strong>
    </div>
  );
}

const MEMBER_PICKER_UNASSIGNED_GROUP_ID = 'unassigned';

export function MemberPicker({ title, members, loading = false, loadError = '', t, setToast, onConfirm, onClose }) {
  const [selected, setSelected] = useState(() => new Set());
  const [squadFilter, setSquadFilter] = useState(MEMBER_PICKER_UNASSIGNED_GROUP_ID);
  const [pickerSearch, setPickerSearch] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const mountedRef = useRef(true);
  const pickerSearchQuery = pickerSearch.trim();
  const deferredPickerSearchQuery = useDeferredValue(pickerSearchQuery);
  const normalizedDeferredPickerSearchQuery = useMemo(
    () => normalizedMemberSearchQuery(deferredPickerSearchQuery),
    [deferredPickerSearchQuery]
  );
  const groupIdForMember = (member) => member.squadId || MEMBER_PICKER_UNASSIGNED_GROUP_ID;
  const visibleMembers = useMemo(() => (
    members.filter((member) => (
      (!squadFilter || groupIdForMember(member) === squadFilter)
      && memberMatchesNormalizedSearch(member, normalizedDeferredPickerSearchQuery)
    ))
  ), [members, normalizedDeferredPickerSearchQuery, squadFilter]);
  const visibleMemberIds = useMemo(() => visibleMembers.map((member) => member.id), [visibleMembers]);
  const squadOptions = useMemo(() => {
    const groups = new Map();
    for (const member of members) {
      const id = groupIdForMember(member);
      if (!groups.has(id)) {
        groups.set(id, {
          id,
          name: member.squadName || t('unassignedSquad'),
          memberIds: []
        });
      }
      groups.get(id).memberIds.push(member.id);
    }
    if (!groups.has(MEMBER_PICKER_UNASSIGNED_GROUP_ID)) {
      groups.set(MEMBER_PICKER_UNASSIGNED_GROUP_ID, {
        id: MEMBER_PICKER_UNASSIGNED_GROUP_ID,
        name: t('unassignedSquad'),
        memberIds: []
      });
    }
    return [...groups.values()].sort((a, b) => {
      if (a.id === MEMBER_PICKER_UNASSIGNED_GROUP_ID) return -1;
      if (b.id === MEMBER_PICKER_UNASSIGNED_GROUP_ID) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [members, t]);
  const visibleSelectedCount = visibleMemberIds.filter((memberId) => selected.has(memberId)).length;
  const hasVisibleMembers = visibleMemberIds.length > 0;
  const allVisibleSelected = hasVisibleMembers && visibleSelectedCount === visibleMemberIds.length;
  const selectionDisabled = submitting || loading;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const validIds = new Set(members.map((member) => member.id));
    setSelected((current) => {
      const next = new Set([...current].filter((memberId) => validIds.has(memberId)));
      return next.size === current.size ? current : next;
    });
  }, [members]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape' && !submitting) onClose?.();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  function toggle(memberId) {
    if (selectionDisabled) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(memberId)) next.delete(memberId);
      else next.add(memberId);
      return next;
    });
  }

  function selectAll() {
    if (selectionDisabled) return;
    setSelected(new Set(visibleMemberIds));
  }

  function clearSelection() {
    if (selectionDisabled) return;
    setSelected(new Set());
  }

  function changeSquadFilter(nextFilter) {
    if (selectionDisabled) return;
    setSquadFilter(nextFilter);
    const nextSelectedIds = nextFilter
      ? members
        .filter((member) => groupIdForMember(member) === nextFilter && memberMatchesNormalizedSearch(member, normalizedDeferredPickerSearchQuery))
        .map((member) => member.id)
      : [];
    setSelected(new Set(nextSelectedIds));
  }

  function closePicker() {
    if (!submitting) onClose?.();
  }

  async function confirmSelection() {
    if (!selected.size || selectionDisabled) return;
    setSubmitError('');
    setSubmitting(true);
    try {
      await onConfirm?.([...selected]);
      if (mountedRef.current) setSubmitting(false);
    } catch (err) {
      if (!mountedRef.current) return;
      setSubmitError(localizeError(err.message, t));
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal wide-modal participant-picker-modal" aria-busy={selectionDisabled}>
        <div className="modal-title">
          <h3>{title}</h3>
          <button type="button" className="icon-button" title={t('close')} onClick={closePicker} disabled={submitting}>
            <X size={18} />
          </button>
        </div>
        <div className="picker-toolbar">
          <label className="picker-squad-select">
            <span>{t('selectSquad')}</span>
            <select value={squadFilter} onChange={(event) => changeSquadFilter(event.target.value)} disabled={selectionDisabled || !squadOptions.length}>
              <option value="">{t('allMembers')}</option>
              {squadOptions.map((squad) => (
                <option key={squad.id} value={squad.id}>
                  {squad.name} ({squad.memberIds.length})
                </option>
              ))}
            </select>
          </label>
          <div className="picker-toolbar-actions">
            <button type="button" className="ghost-button" onClick={selectAll} disabled={selectionDisabled || !hasVisibleMembers || allVisibleSelected}>
              <Users size={16} />
              <span>{t('selectAll')}</span>
            </button>
            <button type="button" className="action-button" onClick={clearSelection} disabled={selectionDisabled || !selected.size}>
              <X size={16} />
              <span>{t('clearSelection')}</span>
            </button>
          </div>
        </div>
        <div className="picker-table">
          <div className="picker-row picker-row-head">
            <span />
            <label className="picker-name-filter">
              <Search size={14} />
              <input
                value={pickerSearch}
                onChange={(event) => setPickerSearch(event.target.value)}
                placeholder={t('nickname')}
                aria-label={t('nickname')}
                disabled={selectionDisabled}
              />
            </label>
            <span className="picker-column-title picker-specialty-title">{t('specialty')}</span>
            <span className="picker-column-title picker-squad-title">{t('squadName')}</span>
          </div>
          {loading && !visibleMembers.length && (
            <div className="participant-picker-loading" role="status" aria-live="polite">
              <RefreshCw size={16} />
              <span>{t('loading')}</span>
            </div>
          )}
          {visibleMembers.map((member) => (
            <label key={member.id} className="picker-row">
              <input type="checkbox" checked={selected.has(member.id)} onChange={() => toggle(member.id)} disabled={selectionDisabled} />
              <MemberName member={member} t={t} setToast={setToast} showSteamId />
              <span className="picker-specialty-cell"><SpecialtyBadge value={member.specialty} t={t} /></span>
              <span className="picker-meta-stack picker-squad-cell">
                <span>{member.squadName || t('unassignedSquad')}</span>
                {member.notes && <small>{member.notes}</small>}
              </span>
            </label>
          ))}
          {!loading && !visibleMembers.length && <div className="empty-state">{t('noMembers')}</div>}
        </div>
        <div className="modal-actions">
          <span className="participant-picker-submit-message" role="status" aria-live="polite">
            {selectionDisabled ? t('loading') : formatCopy(t('selectedCount'), { count: selected.size })}
          </span>
          <button type="button" className="ghost-button" onClick={closePicker} disabled={submitting}>{t('cancel')}</button>
          <button type="button" className={cx('primary-button', submitting && 'loading-button')} title={t('confirm')} onClick={confirmSelection} disabled={!selected.size || selectionDisabled}>
            {submitting ? <RefreshCw size={17} /> : <UserCheck size={17} />}
            <span>{submitting ? t('loading') : t('confirmShort')}</span>
          </button>
        </div>
        {(loadError || submitError) && <div className="participant-picker-error" role="alert">{loadError || submitError}</div>}
      </div>
    </div>
  );
}

export function memberProfileCanSyncOnline(user) {
  return Boolean(user?.isRoot || user?.id === 'user_root' || user?.username === 'root');
}

export function MemberProfileDialogStack({
  member,
  user,
  lang,
  t,
  setToast,
  onClose,
  onMemberUpdated = null,
  onOpenRustKdaLookup = null,
  canSyncOnline = memberProfileCanSyncOnline(user)
}) {
  const [editingMember, setEditingMember] = useState(null);
  const [editorSquads, setEditorSquads] = useState([]);
  const editorOptionsLoadedRef = useRef(false);

  const loadEditorOptions = useCallback(async () => {
    if (editorOptionsLoadedRef.current) return editorSquads;
    const payload = await api('/api/member-options');
    const nextSquads = payload.squads || [];
    editorOptionsLoadedRef.current = true;
    setEditorSquads(nextSquads);
    return nextSquads;
  }, [editorSquads]);

  const openEditor = useCallback((targetMember) => {
    const nextMember = normalizeMemberProfileCandidate(targetMember);
    if (!nextMember.id) {
      setToast(t('errorMemberMissing'));
      return;
    }
    onClose?.();
    setEditingMember(nextMember);
    loadEditorOptions().catch((err) => setToast(localizeError(err.message, t)));
  }, [loadEditorOptions, onClose, setToast, t]);

  const handleMemberUpdated = useCallback(async (nextMember, payload) => {
    if (onMemberUpdated) await onMemberUpdated(nextMember, payload);
  }, [onMemberUpdated]);

  const handleEditorSaved = useCallback(async (payload) => {
    const nextMember = payload?.member || editingMember;
    setEditingMember(null);
    setToast(t('memberUpdated'));
    try {
      await handleMemberUpdated(nextMember, payload);
    } catch (err) {
      setToast(localizeError(err.message, t));
    }
  }, [editingMember, handleMemberUpdated, setToast, t]);

  return (
    <>
      {member && (
        <MemberProfileModal
          member={normalizeMemberProfileCandidate(member)}
          lang={lang}
          t={t}
          setToast={setToast}
          onEdit={openEditor}
          onMemberUpdated={handleMemberUpdated}
          canSyncOnline={canSyncOnline}
          onOpenRustKdaLookup={onOpenRustKdaLookup}
          onClose={onClose}
        />
      )}
      {editingMember && (
        <MemberEditor
          member={editingMember}
          squads={editorSquads}
          t={t}
          onClose={() => setEditingMember(null)}
          onSaved={handleEditorSaved}
        />
      )}
    </>
  );
}

export function MemberProfileModal({ member, lang, t, setToast, onClose, onEdit = null, onMemberUpdated = null, canSyncOnline = false, onOpenRustKdaLookup = null }) {
  const initialMember = useMemo(() => normalizeMemberProfileCandidate(member), [member]);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const currencyContext = useCurrencyContext(lang);
  const [bmEditing, setBmEditing] = useState(false);
  const [bmInput, setBmInput] = useState('');
  const [bmLoading, setBmLoading] = useState(false);
  const [bmError, setBmError] = useState('');
  const [onlineLoading, setOnlineLoading] = useState(false);
  const [onlineError, setOnlineError] = useState('');
  const [steamLoading, setSteamLoading] = useState(false);
  const [steamError, setSteamError] = useState('');
  const [kdaLoading, setKdaLoading] = useState(false);
  const [kdaError, setKdaError] = useState('');
  const [hexaytronLoading, setHexaytronLoading] = useState(false);
  const [hexaytronError, setHexaytronError] = useState('');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    setBmError('');
    setOnlineError('');
    setSteamError('');
    setKdaError('');
    setHexaytronError('');
    setDetail(null);
    if (!initialMember.id) {
      setError(t('errorMemberMissing'));
      setLoading(false);
      return () => {};
    }
    api(`/api/members/${initialMember.id}/profile`)
      .then((payload) => {
        if (!alive) return;
        setDetail(payload.member || null);
      })
      .catch((err) => {
        if (!alive) return;
        setError(localizeError(err.message, t));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [initialMember.id, t]);

  const profile = detail || initialMember || {};
  const profileStats = profile.profileStats || {};
  const profileSteamId = profile.steamId || initialMember.steamId || profileStats.steamId || '';
  const serverOnline = profile.serverOnline || profile.currentWipe?.serverOnline || {};
  const recentOnline = profile.recentHistoryServerOnline || profile.onlineSummary || profileStats.battlemetrics || {};
  const currentBattlemetricsId = profile.battlemetricsId || profile.onlineSummary?.battlemetricsPlayerId || profileStats.battlemetrics?.battlemetricsPlayerId || '';
  const inventoryText = profileStats.inventoryPublic
    ? formatCurrencyValue(profileStats.inventoryValue, profileStats.inventoryCurrency, lang, currencyContext)
    : t('privateData');
  const officialKda = profileStats.officialKda || null;
  const hexaytron = profileStats.hexaytron || {};
  const battlemetricsWipeMinutes = battlemetricsPlayTimeMinutes(profileStats, 'server');
  const battlemetricsTotalMinutes = battlemetricsPlayTimeMinutes(profileStats, 'total');
  const profileUrl = profile.profileUrl || (profile.steamId ? `https://steamcommunity.com/profiles/${profile.steamId}` : '');
  const canManageProfile = Boolean(profile.canManage);
  const canEditBattlemetricsId = canManageProfile;

  useEffect(() => {
    if (!bmEditing) setBmInput(currentBattlemetricsId);
  }, [bmEditing, currentBattlemetricsId]);

  function applyProfilePayload(payload) {
    const next = payload.member || null;
    setDetail(next);
    setBmInput(next?.battlemetricsId || next?.onlineSummary?.battlemetricsPlayerId || next?.profileStats?.battlemetrics?.battlemetricsPlayerId || '');
    return next;
  }

  async function notifyMemberUpdated(next, payload) {
    if (onMemberUpdated) await onMemberUpdated(next, payload);
  }

  async function saveBattlemetricsId() {
    if (!profile.id || bmLoading) return;
    setBmLoading(true);
    setBmError('');
    try {
      const payload = await api(`/api/members/${profile.id}/battlemetrics-id`, {
        method: 'PUT',
        body: { battlemetricsId: bmInput }
      });
      const next = applyProfilePayload(payload);
      setBmEditing(false);
      await notifyMemberUpdated(next, payload);
      setToast(t('battlemetricsIdSaved'));
    } catch (err) {
      setBmError(localizeError(err.message, t));
    } finally {
      setBmLoading(false);
    }
  }

  async function refreshBattlemetricsId() {
    if (!profile.id || bmLoading) return;
    setBmLoading(true);
    setBmError('');
    try {
      const payload = await api(`/api/members/${profile.id}/battlemetrics-id/refresh`, { method: 'POST' });
      const next = applyProfilePayload(payload);
      setBmEditing(false);
      if (!payload.queued) await notifyMemberUpdated(next, payload);
      setToast(payload.queued ? `${t('battlemetricsIdRefresh')} · ${t('syncJobQueued')}` : t('battlemetricsIdRefreshed'));
    } catch (err) {
      setBmError(localizeError(err.message, t));
    } finally {
      setBmLoading(false);
    }
  }

  async function refreshOnlineTime() {
    if (!profile.id || onlineLoading) return;
    setOnlineLoading(true);
    setOnlineError('');
    try {
      const syncPayload = await api('/api/settings/battlemetrics/sync-playtime', {
        method: 'POST',
        body: { memberIds: [profile.id] }
      });
      const detailPayload = await api(`/api/members/${profile.id}/profile`);
      const next = applyProfilePayload(detailPayload);
      await notifyMemberUpdated(next, { ...syncPayload, member: next });
      setToast(t('onlineTimeUpdated'));
    } catch (err) {
      setOnlineError(localizeError(err.message, t));
    } finally {
      setOnlineLoading(false);
    }
  }

  async function refreshSteamData() {
    if (!profile.id || steamLoading) return;
    setSteamLoading(true);
    setSteamError('');
    try {
      const payload = await api(`/api/members/${profile.id}/steam-profile/refresh`, { method: 'POST' });
      const next = applyProfilePayload(payload);
      await notifyMemberUpdated(next, payload);
      setToast(t('steamDataUpdated'));
    } catch (err) {
      setSteamError(localizeError(err.message, t));
    } finally {
      setSteamLoading(false);
    }
  }

  async function refreshKdaData() {
    if (!profile.id || kdaLoading) return;
    setKdaLoading(true);
    setKdaError('');
    try {
      const payload = await api(`/api/members/${profile.id}/kda/refresh`, { method: 'POST' });
      const next = applyProfilePayload(payload);
      await notifyMemberUpdated(next, payload);
      setToast(t('kdaDataUpdated'));
    } catch (err) {
      setKdaError(localizeError(err.message, t));
    } finally {
      setKdaLoading(false);
    }
  }

  async function refreshHexaytronData() {
    if (!HEXAYTRON_FEATURE_ENABLED || !profile.id || hexaytronLoading) return;
    setHexaytronLoading(true);
    setHexaytronError('');
    try {
      const payload = await api(`/api/members/${profile.id}/hexaytron/refresh`, { method: 'POST' });
      const next = applyProfilePayload(payload);
      await notifyMemberUpdated(next, payload);
      setToast(t('hexaytronDataUpdated'));
    } catch (err) {
      setHexaytronError(localizeError(err.message, t));
    } finally {
      setHexaytronLoading(false);
    }
  }

  function openRustKdaDetail(target) {
    if (!profileSteamId || !onOpenRustKdaLookup) return;
    onOpenRustKdaLookup(target, profile);
    onClose();
  }

  return (
    <ModalFrame className="wide-modal member-profile-modal" labelledBy="member-profile-title" onClose={onClose}>
        <div className="modal-title">
          <div>
            <h3 id="member-profile-title">{t('memberProfileTitle')}</h3>
          </div>
          <div className="modal-title-actions">
            <button type="button" className="icon-button" title={t('close')} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
        </div>

        <MemberProfileHero
          profile={profile}
          profileUrl={profileUrl}
          t={t}
          setToast={setToast}
          canSyncOnline={canSyncOnline}
          canManageProfile={canManageProfile}
          canEditProfile={Boolean(canManageProfile && onEdit)}
          showHexaytron={HEXAYTRON_FEATURE_ENABLED}
          loading={loading}
          onlineLoading={onlineLoading}
          steamLoading={steamLoading}
          kdaLoading={kdaLoading}
          hexaytronLoading={hexaytronLoading}
          onRefreshOnline={refreshOnlineTime}
          onRefreshSteam={refreshSteamData}
          onRefreshKda={refreshKdaData}
          onRefreshHexaytron={refreshHexaytronData}
          onEdit={() => onEdit?.(profile)}
        />

        {loading && <PageLoadingState title={t('memberProfileTitle')} t={t} compact />}
        {error && <Alert tone="danger">{error}</Alert>}
        {onlineError && <Alert tone="danger">{onlineError}</Alert>}
        {steamError && <Alert tone="danger">{steamError}</Alert>}
        {kdaError && <Alert tone="danger">{kdaError}</Alert>}
        {HEXAYTRON_FEATURE_ENABLED && hexaytronError && <Alert tone="danger">{hexaytronError}</Alert>}

        {!loading && !error && (
          <div className="member-profile-content">
            <section className="member-profile-section">
              <div className="section-heading compact-heading">
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
              <div className="profile-metric-grid">
                <MetricCard label={t('steamHours')} value={formatPlayTimeMinutes(profileStats.playTimeMinutes, lang)} />
                <MetricCard label={t('battlemetricsWipeHours')} value={formatPlayTimeMinutes(battlemetricsWipeMinutes, lang)} />
                <MetricCard label={t('battlemetricsTotalHours')} value={formatPlayTimeMinutes(battlemetricsTotalMinutes, lang)} />
                <OfficialKdaCompactCard
                  kda={officialKda}
                  loading={false}
                  lang={lang}
                  t={t}
                  onDetail={profileSteamId && onOpenRustKdaLookup ? () => openRustKdaDetail('officialKda') : null}
                />
                <ProfileDetailMetricCard
                  label={t('inventoryValue')}
                  value={inventoryText}
                  detailTitle={t('inventoryDetail')}
                  onDetail={profileSteamId && onOpenRustKdaLookup ? () => openRustKdaDetail('inventoryDetails') : null}
                />
                <SteamBanStatusMetricCard stats={profileStats} lang={lang} t={t} />
                <MetricCard label={t('communityBanStatus')} value={steamBanYesNoText(profileStats.communityBanned, profileStats, t)} />
                <MetricCard label={t('economyBanStatus')} value={steamBanYesNoText(profileStats.economyRestricted, profileStats, t)} />
                <MetricCard label={t('profileUpdatedAt')} value={formatTime(profileStats.fetchedAt, lang) || t('notSyncedYet')} />
              </div>
            </section>

            {HEXAYTRON_FEATURE_ENABLED && <HexaytronProfileSection hexaytron={hexaytron} lang={lang} t={t} />}

            <ServerGameInfoPanel recentOnline={recentOnline} currentOnline={serverOnline} lang={lang} t={t} />

            <CurrentQueryKdaPanel kda={profile.currentKda} fallbackSource={recentOnline || serverOnline} lang={lang} t={t} />

            <section className="member-profile-section">
              <div className="section-heading compact-heading">
                <h3>{t('memberDetails')}</h3>
              </div>
              <InfoGrid items={[
                [t('memberName'), profile.customName || '-'],
                [t('battlemetricsId'), (
                  <BattlemetricsIdControl
                    value={currentBattlemetricsId}
                    inputValue={bmInput}
                    editing={bmEditing}
                    loading={bmLoading}
                    error={bmError}
                    canEdit={canEditBattlemetricsId}
                    t={t}
                    onInputChange={setBmInput}
                    onEdit={() => {
                      setBmInput(currentBattlemetricsId);
                      setBmEditing(true);
                      setBmError('');
                    }}
                    onCancel={() => {
                      setBmInput(currentBattlemetricsId);
                      setBmEditing(false);
                      setBmError('');
                    }}
                    onSave={saveBattlemetricsId}
                    onRefresh={refreshBattlemetricsId}
                  />
                )],
                [t('specialty'), <SpecialtyBadge value={profile.specialty} t={t} />],
                [t('vitalVip'), <VitalVipSummary member={profile} t={t} />],
                [t('rustinityVip'), <RustinityVipSummary member={profile} t={t} />],
                [t('atlasVip'), <AtlasVipSummary member={profile} t={t} />],
                [t('squad'), profile.squadName || t('unassignedSquad')],
                [t('discordName'), profile.discordName || '-'],
                [t('discordId'), profile.discordId || '-'],
                ...(profile.wechatNickname ? [[t('wechatNickname'), profile.wechatNickname]] : []),
                [t('wechatId'), profile.wechatId || '-'],
                [t('phone'), profile.phone || '-'],
                [t('notes'), profile.notes || '-'],
                [t('inviter'), displayDataValue(profile.inviterName, t)],
                [t('createdAt'), formatTime(profile.createdAt, lang)],
                [t('updatedAt'), formatTime(profile.updatedAt, lang)]
              ]} />
            </section>
          </div>
        )}
    </ModalFrame>
  );
}

function BattlemetricsIdControl({
  value,
  inputValue,
  editing,
  loading,
  error,
  canEdit,
  t,
  onInputChange,
  onEdit,
  onCancel,
  onSave,
  onRefresh
}) {
  if (!canEdit) {
    return <span className="bm-id-value">{value || '-'}</span>;
  }

  return (
    <div className="bm-id-control">
      {editing ? (
        <>
          <input
            className="bm-id-input"
            value={inputValue}
            onChange={(event) => onInputChange(event.target.value)}
            placeholder={t('battlemetricsIdPlaceholder')}
            disabled={loading}
          />
          <div className="bm-id-actions">
            <button type="button" className="action-button" onClick={onSave} disabled={loading} title={t('save')}>
              <Save size={14} />
              <span>{loading ? t('saving') : t('save')}</span>
            </button>
            <button type="button" className="ghost-button mini-text-button" onClick={onCancel} disabled={loading} title={t('cancel')}>
              <X size={14} />
              <span>{t('cancel')}</span>
            </button>
          </div>
        </>
      ) : (
        <>
          <span className="bm-id-value">{value || '-'}</span>
          <div className="bm-id-actions">
            <button type="button" className="action-button" onClick={onEdit} disabled={loading} title={t('battlemetricsIdEdit')}>
              <Pencil size={14} />
              <span>{t('edit')}</span>
            </button>
            <button type="button" className="ghost-button mini-text-button" onClick={onRefresh} disabled={loading} title={t('battlemetricsIdRefresh')}>
              <RefreshCw size={14} />
              <span>{loading ? t('loading') : t('battlemetricsIdRefresh')}</span>
            </button>
          </div>
        </>
      )}
      {error && <span className="bm-id-error">{error}</span>}
    </div>
  );
}

export function BulkMemberImportModal({ squads, defaultSquadId, defaultSpecialty, t, onClose, onImported }) {
  const [text, setText] = useState('');
  const [squadId, setSquadId] = useState(defaultSquadId || '');
  const [specialty, setSpecialty] = useState(normalizeSpecialtyValues(defaultSpecialty));
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setLoading(true);
    setError('');
    let shouldClose = false;
    try {
      const payload = await api('/api/members/bulk?response=minimal', {
        method: 'POST',
        body: { text, squadId, specialty }
      });
      setResult(payload);
      await onImported(payload);
      shouldClose = true;
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
    if (shouldClose) onClose();
  }

  return (
    <ModalFrame onClose={onClose} className="wide-modal bulk-import-modal" labelledBy="bulk-import-title" as="form" onSubmit={submit}>
        <div className="modal-title">
          <div>
            <h3 id="bulk-import-title">{t('bulkImportMembers')}</h3>
            <span className="modal-subtitle">{t('bulkImportHint')}</span>
          </div>
          <button type="button" className="icon-button" title={t('close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="bulk-import-settings">
          <label>
            <span>{t('squad')}</span>
            <select value={squadId} onChange={(event) => setSquadId(event.target.value)}>
              <option value="">{t('unassignedSquad')}</option>
              {(squads || []).map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
            </select>
          </label>
          <label>
            <span>{t('specialty')}</span>
            <SpecialtySelect value={specialty} onChange={setSpecialty} t={t} />
          </label>
        </div>

        <label className="bulk-import-text-field">
          <span>{t('steamId')}</span>
          <textarea
            className="bulk-import-textarea mono"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={`76561198000000002\nhttps://steamcommunity.com/profiles/76561198000000003\nSTEAM_1:0:12345`}
            required
          />
        </label>

        {error && <Alert tone="danger">{error}</Alert>}

        {result && (
          <div className="bulk-import-summary">
            <strong>{formatCopy(t('bulkImportDone'), result)}</strong>
            <div className="bulk-import-results" aria-label={t('bulkImportResults')}>
              {(result.results || []).map((item, index) => (
                <div key={`${item.input}-${index}`} className="bulk-import-result-row">
                  <span className={cx('import-status', item.status)}>{t(`importStatus${item.status.slice(0, 1).toUpperCase()}${item.status.slice(1)}`)}</span>
                  <span className="mono break-cell">{item.steamId || item.input}</span>
                  <span className="break-cell">{localizeError(item.message, t)}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="modal-actions bulk-import-actions">
          <span>{t('bulkImportPlaceholder')}</span>
          <button type="button" className="ghost-button warning-button compact-form-button" onClick={onClose}>{t('cancel')}</button>
          <button className="primary-button compact-form-button" title={t('bulkImportMembers')} disabled={loading || !text.trim()}>
            <FileUp size={17} />
            <span>{loading ? t('adding') : t('bulkImportShort')}</span>
          </button>
        </div>
    </ModalFrame>
  );
}


export function MemberEditor({ member, squads, onClose, onSaved, t }) {
  const [form, setForm] = useState({
    steamInput: member.steamId,
    customName: member.customName || '',
    discordId: member.discordId || '',
    discordName: member.discordName || '',
    wechatId: member.wechatId || '',
    specialty: normalizeSpecialtyValues(member.specialty),
    phone: member.phone || '',
    notes: member.notes || '',
    vitalVipType: member.vitalVipType || member.vitalVip?.type || 'none',
    vitalVipPurchasedAt: member.vitalVipPurchasedAt || member.vitalVip?.purchasedAt || '',
    vitalVipExpiresAt: member.vitalVipExpiresAt || member.vitalVip?.expiresAt || '',
    rustinityVipType: member.rustinityVipType || member.rustinityVip?.type || 'none',
    rustinityVipPurchasedAt: member.rustinityVipPurchasedAt || member.rustinityVip?.purchasedAt || '',
    rustinityVipExpiresAt: member.rustinityVipExpiresAt || member.rustinityVip?.expiresAt || '',
    atlasVipType: member.atlasVipType || member.atlasVip?.type || 'none',
    atlasVipPurchasedAt: member.atlasVipPurchasedAt || member.atlasVip?.purchasedAt || '',
    atlasVipExpiresAt: member.atlasVipExpiresAt || member.atlasVip?.expiresAt || '',
    battlemetricsId: member.battlemetricsId || member.onlineSummary?.battlemetricsPlayerId || '',
    squadId: member.squadId || ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function save(event) {
    event.preventDefault();
    setError('');
    const vipError = memberVipPurchaseDateValidationError(form, t);
    if (vipError) {
      setError(vipError);
      return;
    }
    setLoading(true);
    try {
      const payload = await api(`/api/members/${member.id}?response=member`, { method: 'PUT', body: form });
      await onSaved(payload);
      onClose?.();
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  return (
    <ModalFrame as="form" className="member-edit-modal" labelledBy="member-edit-title" onSubmit={save} onClose={onClose}>
        <div className="modal-title">
          <h3 id="member-edit-title">{t('editMember')}</h3>
          <button type="button" className="icon-button" title={t('close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <label>
          <span>{t('steamId')}</span>
          <input value={form.steamInput} onChange={(event) => setForm({ ...form, steamInput: event.target.value })} required />
        </label>
        <label>
          <span>{t('memberName')}</span>
          <input value={form.customName} onChange={(event) => setForm({ ...form, customName: event.target.value })} />
        </label>
        <label>
          <span>{t('discordId')}</span>
          <input value={form.discordId} onChange={(event) => setForm({ ...form, discordId: event.target.value })} placeholder={t('optionalPlaceholder')} />
        </label>
        <label>
          <span>{t('discordName')}</span>
          <input value={form.discordName} onChange={(event) => setForm({ ...form, discordName: event.target.value })} placeholder={t('optionalPlaceholder')} />
        </label>
        <label>
          <span>{t('wechatId')}</span>
          <input value={form.wechatId} onChange={(event) => setForm({ ...form, wechatId: event.target.value })} placeholder={t('optionalPlaceholder')} />
        </label>
        <label>
          <span>{t('specialty')}</span>
          <SpecialtySelect value={form.specialty} onChange={(specialty) => setForm({ ...form, specialty })} t={t} />
        </label>
        <label>
          <span>{t('vitalVip')}</span>
          <select value={form.vitalVipType} onChange={(event) => setForm(updateVitalVipForm(form, { vitalVipType: event.target.value }))}>
            <option value="none">{t('vitalVipNone')}</option>
            <option value="priority">{t('vitalVipPriority')}</option>
            <option value="queue_skip">{t('vitalVipQueueSkip')}</option>
          </select>
        </label>
        <label>
          <span>{t('vitalVipPurchasedAt')}</span>
          <input value={vitalVipMonthDay(form.vitalVipPurchasedAt)} inputMode="numeric" pattern="[0-9]{1,2}-[0-9]{1,2}" maxLength={5} placeholder="MM-DD" onChange={(event) => setForm(updateVitalVipForm(form, { vitalVipPurchasedAt: event.target.value }))} disabled={form.vitalVipType === 'none'} required={vitalVipRequiresPurchaseDate(form)} />
        </label>
        <label>
          <span>{t('vitalVipExpiresAt')}</span>
          <input value={vitalVipMonthDay(form.vitalVipExpiresAt)} placeholder="MM-DD" readOnly disabled />
        </label>
        <label>
          <span>{t('rustinityVip')}</span>
          <select value={form.rustinityVipType} onChange={(event) => setForm(updateRustinityVipForm(form, { rustinityVipType: event.target.value }))}>
            <option value="none">{t('vitalVipNone')}</option>
            <option value="queue_skip">{t('vitalVipQueueSkip')}</option>
          </select>
        </label>
        <label>
          <span>{t('rustinityVipPurchasedAt')}</span>
          <input value={vitalVipMonthDay(form.rustinityVipPurchasedAt)} inputMode="numeric" pattern="[0-9]{1,2}-[0-9]{1,2}" maxLength={5} placeholder="MM-DD" onChange={(event) => setForm(updateRustinityVipForm(form, { rustinityVipPurchasedAt: event.target.value }))} disabled={form.rustinityVipType === 'none'} required={rustinityVipRequiresPurchaseDate(form)} />
        </label>
        <label>
          <span>{t('rustinityVipExpiresAt')}</span>
          <input value={vitalVipMonthDay(form.rustinityVipExpiresAt)} placeholder="MM-DD" readOnly disabled />
        </label>
        <label>
          <span>{t('atlasVip')}</span>
          <select value={form.atlasVipType} onChange={(event) => setForm(updateAtlasVipForm(form, { atlasVipType: event.target.value }))}>
            <option value="none">{t('vitalVipNone')}</option>
            <option value="priority">{t('vitalVipPriority')}</option>
            <option value="queue_skip">{t('vitalVipQueueSkip')}</option>
          </select>
        </label>
        <label>
          <span>{t('atlasVipPurchasedAt')}</span>
          <input value={vitalVipMonthDay(form.atlasVipPurchasedAt)} inputMode="numeric" pattern="[0-9]{1,2}-[0-9]{1,2}" maxLength={5} placeholder="MM-DD" onChange={(event) => setForm(updateAtlasVipForm(form, { atlasVipPurchasedAt: event.target.value }))} disabled={form.atlasVipType === 'none'} required={atlasVipRequiresPurchaseDate(form)} />
        </label>
        <label>
          <span>{t('atlasVipExpiresAt')}</span>
          <input value={vitalVipMonthDay(form.atlasVipExpiresAt)} placeholder="MM-DD" readOnly disabled />
        </label>
        <label>
          <span>{t('phone')}</span>
          <input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} placeholder={t('phonePlaceholder')} />
        </label>
        <label>
          <span>{t('notes')}</span>
          <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} placeholder={t('memberNotesPlaceholder')} />
        </label>
        <label>
          <span>{t('battlemetricsId')}</span>
          <input value={form.battlemetricsId} onChange={(event) => setForm({ ...form, battlemetricsId: event.target.value })} placeholder={t('battlemetricsIdPlaceholder')} />
        </label>
        <label>
          <span>{t('squad')}</span>
          <select value={form.squadId} onChange={(event) => setForm({ ...form, squadId: event.target.value })}>
            <option value="">{t('unassignedSquad')}</option>
            {(squads || []).map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
          </select>
        </label>
        {error && <Alert tone="danger">{error}</Alert>}
        <button className="primary-button fit-button" title={t('save')} disabled={loading}>
          <Save size={18} />
          <span>{loading ? t('saving') : t('saveShort')}</span>
        </button>
    </ModalFrame>
  );
}
