import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckSquare,
  Database,
  Download,
  FileUp,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  UserCheck,
  UserPlus,
  UserRound,
  X
} from 'lucide-react';
import { api } from '../../shared/api.js';
import {
  BulkMemberImportModal,
  MemberEditor,
  MemberProfileModal
} from '../../shared/member/dialogs.jsx';
import {
  formatCopy,
  formatStatNumber,
  formatTime,
  latestTimestamp,
  localizeError
} from '../../shared/format.js';
import {
  AtlasVipSummary,
  RustinityVipSummary,
  VitalVipSummary,
  atlasVipRequiresPurchaseDate,
  emptyMemberForm,
  memberVipPurchaseDateValidationError,
  rustinityVipRequiresPurchaseDate,
  updateAtlasVipForm,
  updateRustinityVipForm,
  updateVitalVipForm,
  vitalVipMonthDay,
  vitalVipRequiresPurchaseDate
} from '../../shared/member/profile-form.jsx';
import { MemberName } from '../../shared/member/MemberName.jsx';
import {
  SPECIALTY_OPTIONS,
  SpecialtyBadge,
  SpecialtySelect
} from '../../shared/member/specialty.jsx';
import { MemberOnlineSummary } from '../../shared/member/status.jsx';
import { createLatestRequestController, isAbortError } from '../../shared/request-control.js';
import {
  KDA_SYNC_COOLDOWN_SECONDS,
  deferPollWhileHidden,
  isPageHidden,
  schedulePollTimeout,
  shouldShowFinishedSyncState,
  syncProgressFromServer,
  syncUiStateFromServer,
  syncVisualProgressPercent
} from '../../shared/sync-status.js';
import { wipeStatusText } from '../../shared/wipes.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { ModalFrame } from '../../shared/ui/ModalFrame.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

const BATTLEMETRICS_MEMBER_REQUEST_ESTIMATE_MS = 800;
const MEMBER_SEARCH_DEBOUNCE_MS = 280;
const MEMBER_EXPORT_PAGE_SIZE = 100;

function downloadTextFile(fileName, text, contentType = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: contentType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

function rowsToCsv(rows = []) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function safeFilePart(value, fallback = 'all') {
  const normalized = String(value || '').trim()
    .replace(/[\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.slice(0, 60) || fallback;
}

function compactFileTimestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function onlineSourceFromObject(value = {}) {
  if (!value) return null;
  const source = {
    wipeId: value.wipeId || value.battlemetricsWipeId || '',
    wipeName: value.wipeName || value.battlemetricsWipeName || '',
    wipeStatus: value.wipeStatus || value.battlemetricsWipeStatus || '',
    serverId: value.serverId || value.battlemetricsServerId || '',
    serverName: value.serverName || value.battlemetricsServerName || '',
    syncedAt: value.syncedAt || value.updatedAt || ''
  };
  if (!source.wipeId && !source.wipeName && !source.serverId && !source.serverName && !source.syncedAt) return null;
  return source;
}

function latestOnlineSource(members = []) {
  const sources = members
    .map((member) => onlineSourceFromObject(member.onlineSummary))
    .filter(Boolean)
    .toSorted((left, right) => {
      const rightTime = Date.parse(right.syncedAt || '');
      const leftTime = Date.parse(left.syncedAt || '');
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    });
  return sources[0] || null;
}

function sameOnlineSource(left, right) {
  if (!left || !right) return false;
  if (left.wipeId && right.id && left.wipeId === right.id) return true;
  if (left.serverId && right.battlemetricsId && String(left.serverId) === String(right.battlemetricsId)) return true;
  if (left.wipeId || right.id) return false;
  const leftName = String(left.serverName || left.wipeName || '').trim().toLowerCase();
  const rightName = String(right.serverName || right.name || '').trim().toLowerCase();
  return Boolean(leftName && rightName && leftName === rightName);
}

function estimateBattlemetricsSyncSeconds(total) {
  const normalizedTotal = Math.max(0, Math.floor(Number(total) || 0));
  if (!normalizedTotal) return 3;
  return Math.max(3, Math.ceil((normalizedTotal * BATTLEMETRICS_MEMBER_REQUEST_ESTIMATE_MS) / 1000));
}

function MemberOnlineDataSource({ source, plannedWipe, showPlannedWipe, lang, t }) {
  const sourceName = source?.serverName || source?.wipeName || t('notSyncedYet');
  const sourceStatus = source?.wipeStatus ? wipeStatusText(source.wipeStatus, t) : t('notSyncedYet');
  const plannedName = plannedWipe?.serverName || plannedWipe?.name || '';
  return (
    <div className="member-online-data-source">
      <span className="member-online-data-chip primary">
        <Database size={14} />
        <span>{t('memberOnlineCurrentData')}</span>
        <strong>{sourceName}</strong>
      </span>
      <span className="member-online-data-chip">
        <span>{sourceStatus}</span>
        <span>{t('lastSyncAt')}: {formatTime(source?.syncedAt, lang) || t('notSyncedYet')}</span>
      </span>
      {showPlannedWipe && plannedName && (
        <span className="member-online-data-chip planned">
          <span>{t('memberOnlinePlannedData')}</span>
          <strong>{plannedName}</strong>
        </span>
      )}
    </div>
  );
}

const MemberTable = React.memo(function MemberTable({
  bulkEditMode,
  bulkDeleting,
  canDeleteMembers = true,
  columns,
  deletingMemberId = '',
  emptyText,
  filteredMembers,
  selectedMemberIdSet,
  lang,
  t,
  setToast,
  onToggleMemberSelection,
  onOpenProfile,
  onEdit,
  onRemove
}) {
  return (
    <DataTable
      className={cx('member-table', bulkEditMode && 'bulk-edit')}
      columns={columns}
      emptyText={emptyText}
    >
      {filteredMembers.map((member) => {
        const isDeleting = deletingMemberId === member.id;
        return (
          <tr key={member.id}>
            {bulkEditMode && (
              <td className="member-select-cell">
                <input
                  type="checkbox"
                  className="member-select-checkbox"
                  checked={selectedMemberIdSet.has(member.id)}
                  disabled={!member.canManage || bulkDeleting || isDeleting}
                  aria-label={formatCopy(t('selectMember'), { name: member.displayName })}
                  onChange={() => onToggleMemberSelection(member.id)}
                />
              </td>
            )}
            <td><MemberName member={member} t={t} setToast={setToast} showSteamId onProfileClick={onOpenProfile} /></td>
            <td><SpecialtyBadge value={member.specialty} t={t} /></td>
            <td><VitalVipSummary member={member} t={t} /></td>
            <td>{member.squadName || t('unassignedSquad')}</td>
            <td className="break-cell note-cell">{member.notes || '-'}</td>
            <td><MemberOnlineSummary summary={member.onlineSummary} lang={lang} t={t} /></td>
            <td>
              <div className="row-actions">
                <button type="button" className="action-button" title={t('viewProfile')} onClick={() => onOpenProfile(member)}>
                  <UserRound size={17} />
                  <span>{t('viewProfile')}</span>
                </button>
                {member.canManage && (
                  <button className="action-button" title={t('edit')} onClick={() => onEdit(member)}>
                    <Pencil size={17} />
                    <span>{t('edit')}</span>
                  </button>
                )}
                {member.canManage && canDeleteMembers && (
                  <button className="action-button danger" title={t('delete')} onClick={() => onRemove(member)} disabled={bulkDeleting || isDeleting}>
                    <Trash2 size={17} />
                    <span>{isDeleting ? t('deletingSelectedMembers') : t('delete')}</span>
                  </button>
                )}
              </div>
            </td>
          </tr>
        );
      })}
    </DataTable>
  );
});

const MEMBER_EXPORT_FIELDS = [
  {
    id: 'steamId',
    labelKey: 'steamId',
    value: (member) => member?.steamId || ''
  },
  {
    id: 'nickname',
    labelKey: 'nickname',
    value: (member) => member?.displayName || member?.customName || member?.steamNickname || ''
  },
  {
    id: 'squad',
    labelKey: 'squad',
    value: (member, t) => member?.squadName || t('unassignedSquad')
  }
];

function memberExportRows(members = [], selectedFields = [], t) {
  return members.map((member) => selectedFields.map((field) => field.value(member, t)));
}

async function loadAllExportMembers(squadId = '') {
  const members = [];
  let offset = 0;
  for (let page = 0; page < 500; page += 1) {
    const params = new URLSearchParams();
    params.set('limit', String(MEMBER_EXPORT_PAGE_SIZE));
    params.set('offset', String(offset));
    if (squadId) params.set('squadId', squadId);
    const payload = await api(`/api/members?${params}`);
    const pageMembers = payload.members || [];
    members.push(...pageMembers);
    if (!payload.hasMore || !pageMembers.length) break;
    offset += pageMembers.length;
  }
  return members;
}

function MemberExportModal({ squads = [], t, setToast, onClose }) {
  const [squadId, setSquadId] = useState('');
  const [fieldIds, setFieldIds] = useState(['steamId']);
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const selectedFields = useMemo(
    () => MEMBER_EXPORT_FIELDS.filter((field) => fieldIds.includes(field.id)),
    [fieldIds]
  );
  const selectedSquadName = squadId
    ? squadId === '__unassigned'
      ? t('unassignedSquad')
      : (squads.find((squad) => squad.id === squadId)?.name || squadId)
    : t('allSquads');
  const rows = useMemo(
    () => memberExportRows(members, selectedFields, t),
    [members, selectedFields, t]
  );
  const previewText = rows.map((row) => row.map(csvCell).join(',')).join('\n');

  useEffect(() => {
    let cancelled = false;
    async function loadExportMembers() {
      setLoading(true);
      setError('');
      try {
        const exportMembers = await loadAllExportMembers(squadId);
        if (!cancelled) setMembers(exportMembers);
      } catch (err) {
        if (!cancelled) {
          setMembers([]);
          setError(localizeError(err.message, t));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    loadExportMembers();
    return () => {
      cancelled = true;
    };
  }, [squadId, t]);

  function toggleField(fieldId) {
    setFieldIds((current) => (
      current.includes(fieldId)
        ? current.filter((id) => id !== fieldId)
        : [...current, fieldId]
    ));
  }

  function exportMembers() {
    if (!selectedFields.length || !members.length) return;
    const header = selectedFields.map((field) => t(field.labelKey));
    const csv = rowsToCsv([header, ...rows]);
    const fileName = `NB-Clan-members-${safeFilePart(selectedSquadName)}-${compactFileTimestamp()}.csv`;
    downloadTextFile(fileName, `\ufeff${csv}`, 'text/csv;charset=utf-8');
    setToast(formatCopy(t('memberExportDone'), { count: members.length }));
    onClose();
  }

  const disableExport = loading || !selectedFields.length || !members.length;

  return (
    <ModalFrame className="wide-modal member-export-modal" labelledBy="member-export-title" onClose={onClose}>
      <div className="modal-title">
        <div>
          <h3 id="member-export-title">{t('memberExportTitle')}</h3>
          <span className="modal-subtitle">{selectedSquadName}</span>
        </div>
        <button type="button" className="icon-button" title={t('close')} onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <p className="modal-hint">{t('memberExportHint')}</p>

      <div className="export-modal-fields">
        <label>
          <span>{t('memberExportSquad')}</span>
          <select value={squadId} onChange={(event) => setSquadId(event.target.value)} disabled={loading}>
            <option value="">{t('allSquads')}</option>
            <option value="__unassigned">{t('unassignedSquad')}</option>
            {squads.map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
          </select>
        </label>
        <section className="member-export-field-section" aria-label={t('memberExportFields')}>
          <span>{t('memberExportFields')}</span>
          <div className="member-export-field-list">
            {MEMBER_EXPORT_FIELDS.map((field) => {
              const checked = fieldIds.includes(field.id);
              return (
                <label key={field.id} className={cx('export-squad-option member-export-field-option', checked && 'active')}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleField(field.id)}
                  />
                  <span><strong>{t(field.labelKey)}</strong></span>
                </label>
              );
            })}
          </div>
        </section>
      </div>

      <section className="member-export-preview-section" aria-label={t('memberExportPreview')}>
        <div className="export-time-head">
          <span>{t('memberExportPreview')}</span>
          <b>{loading ? t('loading') : formatCopy(t('memberExportPreviewCount'), { count: members.length })}</b>
        </div>
        <textarea
          className="member-export-preview mono"
          value={loading ? t('loading') : previewText}
          readOnly
          aria-label={t('memberExportPreview')}
          placeholder={t('memberExportNoMembers')}
        />
      </section>

      {error && <Alert tone="danger">{error}</Alert>}
      {!loading && !selectedFields.length && <Alert tone="warning">{t('memberExportNoFields')}</Alert>}
      {!loading && !error && selectedFields.length > 0 && !members.length && <Alert tone="warning">{t('memberExportNoMembers')}</Alert>}

      <div className="modal-actions">
        <span>{t('memberExportPreview')}: {loading ? t('loading') : formatCopy(t('memberExportPreviewCount'), { count: members.length })}</span>
        <button type="button" className="ghost-button warning-button" onClick={onClose}>{t('cancel')}</button>
        <button type="button" className="primary-button" title={t('downloadCsv')} onClick={exportMembers} disabled={disableExport}>
          <Download size={17} />
          <span>{t('downloadCsv')}</span>
        </button>
      </div>
    </ModalFrame>
  );
}

function loadedMemberResult(result, fallbackLimit) {
  if (Array.isArray(result)) {
    return {
      members: result,
      meta: { total: result.length, offset: 0, limit: fallbackLimit, hasMore: false, paged: true }
    };
  }
  const members = Array.isArray(result?.members) ? result.members : [];
  const meta = result?.meta || result?.payload || {};
  return {
    members,
    meta: {
      total: meta.total ?? members.length,
      offset: meta.offset ?? 0,
      limit: meta.limit ?? fallbackLimit,
      hasMore: Boolean(meta.hasMore),
      paged: Object.hasOwn(meta, 'paged') ? Boolean(meta.paged) : true
    }
  };
}

function memberListMetaAfterRemoval(meta = {}, removedCount = 0, nextLength = 0) {
  const currentTotal = Math.max(0, Number(meta?.total ?? nextLength + removedCount) || 0);
  return {
    ...meta,
    total: Math.max(nextLength, currentTotal - Math.max(0, removedCount)),
    hasMore: Boolean(meta?.hasMore),
    paged: Boolean(meta?.paged)
  };
}

export default function MembersView({ user, members, memberListMeta, loadMembers, applyMembers, replaceMember, setToast, lang, t, onOpenRustKdaLookup = null, pageSize = 5 }) {
  const memberPageSize = Math.max(1, Number(pageSize) || 5);
  const [form, setForm] = useState(emptyMemberForm);
  const [squads, setSquads] = useState([]);
  const [editing, setEditing] = useState(null);
  const [profileMember, setProfileMember] = useState(null);
  const [bulkImportOpen, setBulkImportOpen] = useState(false);
  const [memberExportOpen, setMemberExportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [memberSearch, setMemberSearch] = useState('');
  const [memberListQueryText, setMemberListQueryText] = useState('');
  const [memberSquadFilter, setMemberSquadFilter] = useState('');
  const [memberSpecialtyFilter, setMemberSpecialtyFilter] = useState('');
  const [memberVipFilter, setMemberVipFilter] = useState('');
  const [bulkEditMode, setBulkEditMode] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState([]);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [deletingMemberId, setDeletingMemberId] = useState('');
  const [syncState, setSyncState] = useState('idle');
  const [syncProgress, setSyncProgress] = useState({ total: 0, completed: 0, percent: 0, etaSeconds: 0 });
  const syncStateRef = useRef('idle');
  const [profileSyncStatus, setProfileSyncStatus] = useState({});
  const [currentWipeInfo, setCurrentWipeInfo] = useState(null);
  const [onlineSyncSource, setOnlineSyncSource] = useState(null);
  const syncTimerRef = useRef(null);
  const syncPollRef = useRef(null);
  const profileSyncPollRef = useRef(null);
  const profileSyncResetRef = useRef(null);
  const activeRef = useRef(true);
  const onlinePollRequestControlRef = useRef(null);
  const profilePollRequestControlRef = useRef(null);
  if (!onlinePollRequestControlRef.current) onlinePollRequestControlRef.current = createLatestRequestController();
  if (!profilePollRequestControlRef.current) profilePollRequestControlRef.current = createLatestRequestController();
  const memberListSentinelRef = useRef(null);
  const memberListLoadSeqRef = useRef(0);
  const memberListLoadMoreSeqRef = useRef(0);
  const memberListFilterKeyRef = useRef('');
  const memberOnlineSource = useMemo(
    () => onlineSyncSource || latestOnlineSource(members),
    [members, onlineSyncSource]
  );
  const memberOnlineDataTime = useMemo(
    () => memberOnlineSource?.syncedAt || latestTimestamp(members, (member) => member.onlineSummary?.syncedAt),
    [memberOnlineSource?.syncedAt, members]
  );
  const plannedWipeInfo = currentWipeInfo?.status === 'planned' ? currentWipeInfo : null;
  const showPlannedWipeInfo = useMemo(
    () => Boolean(plannedWipeInfo && !sameOnlineSource(memberOnlineSource, plannedWipeInfo)),
    [memberOnlineSource, plannedWipeInfo]
  );
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [memberListLoading, setMemberListLoading] = useState(true);
  const [memberListLoadingMore, setMemberListLoadingMore] = useState(false);
  const isMemberRole = user.role === 'member';
  const canCreateMembers = user.role !== 'viewer' && !isMemberRole;
  const canDeleteMembers = !isMemberRole;
  const canSyncOnline = Boolean(user?.isRoot || user?.username === 'root');
  const memberSearchQuery = memberSearch.trim();
  const memberListFilterKey = useMemo(
    () => JSON.stringify([memberListQueryText, memberSquadFilter, memberSpecialtyFilter, memberVipFilter, memberPageSize]),
    [memberListQueryText, memberPageSize, memberSpecialtyFilter, memberSquadFilter, memberVipFilter]
  );
  const filteredMembers = members;
  const memberTotalCount = Math.max(Number(memberListMeta?.total ?? filteredMembers.length) || 0, filteredMembers.length);
  const syncTargetMemberCount = Math.max(memberTotalCount, members.length);
  const canLoadMoreMembers = Boolean(memberListMeta?.hasMore) && !memberListLoading && !memberListLoadingMore;
  const manageableFilteredMemberIds = useMemo(
    () => filteredMembers.filter((member) => member.canManage).map((member) => member.id),
    [filteredMembers]
  );
  const manageableMemberIdSet = useMemo(
    () => new Set(members.filter((member) => member.canManage).map((member) => member.id)),
    [members]
  );
  const selectedMemberIdSet = useMemo(() => new Set(selectedMemberIds), [selectedMemberIds]);
  const allFilteredMembersSelected = manageableFilteredMemberIds.length > 0
    && manageableFilteredMemberIds.every((id) => selectedMemberIdSet.has(id));
  const memberTableColumns = useMemo(() => ([
    ...(bulkEditMode ? [{ key: 'select', content: '', label: '' }] : []),
    t('nickname'),
    t('specialty'),
    t('vitalVip'),
    t('squad'),
    t('notes'),
    t('onlineTime'),
    t('manage')
  ]), [bulkEditMode, t]);
  const hasMemberListFilter = Boolean(memberSearchQuery || memberSquadFilter || memberSpecialtyFilter || memberVipFilter);
  const memberTableEmptyText = memberListLoading ? t('loading') : (hasMemberListFilter ? t('noMemberSearchResults') : t('noMembers'));

  useEffect(() => {
    const nextQuery = memberSearchQuery;
    const timer = setTimeout(() => {
      setMemberListQueryText((current) => (current === nextQuery ? current : nextQuery));
    }, nextQuery ? MEMBER_SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [memberSearchQuery]);

  useEffect(() => {
    memberListFilterKeyRef.current = memberListFilterKey;
  }, [memberListFilterKey]);

  function updateOnlineSyncState(nextState) {
    syncStateRef.current = nextState;
    setSyncState(nextState);
  }

  async function loadOptions() {
    const payload = await api('/api/member-options');
    if (!activeRef.current) return;
    const nextSquads = payload.squads || [];
    setSquads(nextSquads);
    setForm((current) => {
      if (current.squadId || nextSquads.length !== 1) return current;
      return { ...current, squadId: nextSquads[0].id };
    });
  }

  const refreshMembersAndSelection = useCallback(async () => {
    const requestFilterKey = memberListFilterKeyRef.current;
    const result = await loadMembers({
      force: true,
      limit: memberPageSize,
      offset: 0,
      q: memberListQueryText,
      squadId: memberSquadFilter,
      specialty: memberSpecialtyFilter,
      vitalVipType: memberVipFilter,
      apply: false,
      returnPayload: true
    });
    if (!activeRef.current || memberListFilterKeyRef.current !== requestFilterKey) return [];
    const next = loadedMemberResult(result, memberPageSize);
    const nextMembers = applyMembers?.(next.members, next.meta) || next.members;
    if (profileMember?.id && Array.isArray(nextMembers)) {
      const nextProfileMember = nextMembers.find((member) => member.id === profileMember.id);
      if (nextProfileMember) setProfileMember(nextProfileMember);
    }
    if (editing?.id && Array.isArray(nextMembers)) {
      const nextEditing = nextMembers.find((member) => member.id === editing.id);
      if (nextEditing) setEditing(nextEditing);
    }
    return nextMembers;
  }, [applyMembers, editing?.id, loadMembers, memberListQueryText, memberPageSize, memberSpecialtyFilter, memberSquadFilter, memberVipFilter, profileMember?.id]);

  function applyMemberListAndSelection(nextMembers, nextMeta = undefined) {
    if (!Array.isArray(nextMembers) || !applyMembers) return null;
    applyMembers(nextMembers, nextMeta);
    if (profileMember?.id) {
      const nextProfileMember = nextMembers.find((member) => member.id === profileMember.id);
      if (nextProfileMember) setProfileMember(nextProfileMember);
    }
    if (editing?.id) {
      const nextEditing = nextMembers.find((member) => member.id === editing.id);
      if (nextEditing) setEditing(nextEditing);
    }
    return nextMembers;
  }

  async function refreshMembersFromPayload(payload) {
    if (payload?.member && replaceMember) {
      if (memberListMeta?.paged || memberListQueryText || memberSquadFilter || memberSpecialtyFilter || memberVipFilter) {
        return refreshMembersAndSelection();
      }
      const nextMembers = replaceMember(payload.member);
      if (profileMember?.id === payload.member.id) setProfileMember(payload.member);
      if (editing?.id === payload.member.id) setEditing(payload.member);
      return nextMembers;
    }
    if (payload?.members && memberListMeta?.paged && payload.members.length > memberPageSize) {
      return refreshMembersAndSelection();
    }
    if (payload?.members) {
      const next = loadedMemberResult({ members: payload.members, payload }, memberPageSize);
      if (applyMemberListAndSelection(next.members, next.meta)) return next.members;
    }
    return refreshMembersAndSelection();
  }

  async function loadCurrentWipeInfo() {
    const payload = await api('/api/wipes/current');
    if (!activeRef.current) return;
    setCurrentWipeInfo(payload.wipe || null);
  }

  useEffect(() => {
    activeRef.current = true;
    onlinePollRequestControlRef.current.activate();
    profilePollRequestControlRef.current.activate();
    return () => {
      activeRef.current = false;
      if (syncTimerRef.current) clearInterval(syncTimerRef.current);
      if (syncPollRef.current) clearTimeout(syncPollRef.current);
      if (profileSyncPollRef.current) clearTimeout(profileSyncPollRef.current);
      if (profileSyncResetRef.current) clearTimeout(profileSyncResetRef.current);
      onlinePollRequestControlRef.current.dispose();
      profilePollRequestControlRef.current.dispose();
    };
  }, []);

  useEffect(() => {
    loadOptions().catch(() => {});
    loadCurrentWipeInfo().catch(() => {});
    pollOnlineSyncStatus().catch(() => {});
    pollProfileSyncStatus().catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const requestId = memberListLoadSeqRef.current + 1;
    memberListLoadSeqRef.current = requestId;
    memberListLoadMoreSeqRef.current += 1;
    setMemberListLoading(true);
    setMemberListLoadingMore(false);
    setError('');
    loadMembers({
      force: true,
      limit: memberPageSize,
      offset: 0,
      q: memberListQueryText,
      squadId: memberSquadFilter,
      specialty: memberSpecialtyFilter,
      vitalVipType: memberVipFilter,
      apply: false,
      returnPayload: true
    }).then((result) => {
      if (cancelled || memberListLoadSeqRef.current !== requestId) return;
      const next = loadedMemberResult(result, memberPageSize);
      applyMembers?.(next.members, next.meta);
    }).catch((err) => {
      if (!cancelled && memberListLoadSeqRef.current === requestId) setError(localizeError(err.message, t));
    }).finally(() => {
      if (!cancelled && memberListLoadSeqRef.current === requestId) setMemberListLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [applyMembers, loadMembers, memberListQueryText, memberPageSize, memberSpecialtyFilter, memberSquadFilter, memberVipFilter, t]);

  const loadMoreMemberPage = useCallback(async () => {
    if (!canLoadMoreMembers) return;
    const requestFilterKey = memberListFilterKey;
    const requestId = memberListLoadMoreSeqRef.current + 1;
    memberListLoadMoreSeqRef.current = requestId;
    setMemberListLoadingMore(true);
    try {
      const result = await loadMembers({
        limit: memberPageSize,
        offset: members.length,
        append: true,
        q: memberListQueryText,
        squadId: memberSquadFilter,
        specialty: memberSpecialtyFilter,
        vitalVipType: memberVipFilter,
        apply: false,
        returnPayload: true
      });
      if (memberListLoadMoreSeqRef.current !== requestId || memberListFilterKeyRef.current !== requestFilterKey) return;
      const next = loadedMemberResult(result, memberPageSize);
      applyMembers?.(next.members, next.meta);
    } catch (err) {
      if (memberListLoadMoreSeqRef.current === requestId && memberListFilterKeyRef.current === requestFilterKey) {
        setError(localizeError(err.message, t));
      }
    } finally {
      if (memberListLoadMoreSeqRef.current === requestId) setMemberListLoadingMore(false);
    }
  }, [applyMembers, canLoadMoreMembers, loadMembers, memberListFilterKey, memberListQueryText, memberPageSize, memberSpecialtyFilter, memberSquadFilter, memberVipFilter, members.length, t]);

  useEffect(() => {
    const node = memberListSentinelRef.current;
    if (!node || !canLoadMoreMembers) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreMemberPage().catch(() => {});
      }
    }, { rootMargin: '240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [canLoadMoreMembers, loadMoreMemberPage]);

  useEffect(() => {
    setSelectedMemberIds((current) => current.filter((id) => manageableMemberIdSet.has(id)));
  }, [manageableMemberIdSet]);

  function stopSyncProgressTimer() {
    if (syncTimerRef.current) {
      clearInterval(syncTimerRef.current);
      syncTimerRef.current = null;
    }
  }

  function scheduleProfileSyncReset(delayMs) {
    if (profileSyncResetRef.current) clearTimeout(profileSyncResetRef.current);
    profileSyncResetRef.current = setTimeout(() => {
      profileSyncResetRef.current = null;
      if (activeRef.current) setProfileSyncStatus({});
    }, delayMs);
  }

  function beginOnlineSyncProgress(total, estimatedSeconds) {
    stopSyncProgressTimer();
    const normalizedTotal = Math.max(0, Math.floor(Number(total) || 0));
    const normalizedEstimate = Math.max(3, Math.ceil(Number(estimatedSeconds) || estimateBattlemetricsSyncSeconds(normalizedTotal)));
    const startedAt = Date.now();
    setSyncProgress({ total: normalizedTotal, completed: 0, percent: normalizedTotal ? 4 : 18, etaSeconds: normalizedEstimate });
    syncTimerRef.current = setInterval(() => {
      if (isPageHidden()) return;
      const elapsedSeconds = Math.max(0, (Date.now() - startedAt) / 1000);
      const ratio = Math.min(0.92, elapsedSeconds / normalizedEstimate);
      const completed = normalizedTotal
        ? Math.min(Math.max(0, normalizedTotal - 1), Math.floor(normalizedTotal * ratio))
        : 0;
      setSyncProgress({
        total: normalizedTotal,
        completed,
        percent: Math.max(normalizedTotal ? 6 : 18, Math.round(ratio * 100)),
        etaSeconds: Math.max(1, Math.ceil(normalizedEstimate - elapsedSeconds))
      });
    }, 320);
  }

  function completeOnlineSyncProgress(payload = {}) {
    stopSyncProgressTimer();
    const total = Math.max(0, Math.floor(Number(payload.requested ?? syncProgress.total) || 0));
    const completed = Math.max(0, Math.min(total || Number(payload.completed || 0), Math.floor(Number(payload.completed ?? total) || 0)));
    setSyncProgress({ total, completed: total ? completed : 0, percent: 100, etaSeconds: 0 });
  }

  function failOnlineSyncProgress() {
    stopSyncProgressTimer();
    setSyncProgress((current) => ({
      total: current.total,
      completed: Math.min(current.completed, current.total),
      percent: 100,
      etaSeconds: 0
    }));
  }

  function beginOnlineRateLimitCountdown(seconds, { total = 0, completed = 0, phase = 'rateLimited' } = {}) {
    stopSyncProgressTimer();
    if (syncPollRef.current) {
      clearTimeout(syncPollRef.current);
      syncPollRef.current = null;
    }
    const totalSeconds = Math.max(1, Math.ceil(Number(seconds) || 180));
    const normalizedTotal = Math.max(0, Math.floor(Number(total) || 0));
    const normalizedCompleted = Math.max(0, Math.min(normalizedTotal || Number(completed || 0), Math.floor(Number(completed) || 0)));
    const startedAt = Date.now();
    updateOnlineSyncState('rateLimited');
    setSyncProgress({ total: normalizedTotal, completed: normalizedCompleted, percent: 0, etaSeconds: totalSeconds, phase });
    syncTimerRef.current = setInterval(() => {
      if (isPageHidden()) return;
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
      const percent = Math.min(100, Math.round(((totalSeconds - remainingSeconds) / totalSeconds) * 100));
      setSyncProgress({ total: normalizedTotal, completed: normalizedCompleted, percent, etaSeconds: remainingSeconds, phase });
      if (remainingSeconds <= 0) {
        stopSyncProgressTimer();
        setError('');
        updateOnlineSyncState('idle');
      }
    }, 1000);
  }

  function applyOnlineSyncStatus(status = {}) {
    const nextState = syncUiStateFromServer(status);
    const nextSource = onlineSourceFromObject(status);
    if (nextSource) setOnlineSyncSource(nextSource);
    if (nextState === 'idle' || !shouldShowFinishedSyncState(status)) return false;
    const nextProgress = syncProgressFromServer(status, syncTargetMemberCount);
    const currentState = syncStateRef.current;
    if (nextState === 'complete') {
      if (currentState === 'syncing') {
        beginOnlineRateLimitCountdown(KDA_SYNC_COOLDOWN_SECONDS, {
          total: nextProgress.total,
          completed: nextProgress.completed || nextProgress.total,
          phase: 'recovery'
        });
      }
      return false;
    }
    if (nextState === 'rateLimited') {
      beginOnlineRateLimitCountdown(nextProgress.etaSeconds || KDA_SYNC_COOLDOWN_SECONDS);
      return false;
    }
    if (nextState === 'syncing' || nextState === 'error') {
      stopSyncProgressTimer();
    }
    updateOnlineSyncState(nextState);
    setSyncProgress(nextProgress);
    if (nextState === 'error' && status.error) setError(localizeError(status.error, t));
    return nextState === 'syncing';
  }

  async function pollOnlineSyncStatus({ reloadOnFinish = false } = {}) {
    if (!activeRef.current) return;
    if (syncPollRef.current) {
      clearTimeout(syncPollRef.current);
      syncPollRef.current = null;
    }
    if (deferPollWhileHidden(
      syncPollRef,
      () => pollOnlineSyncStatus({ reloadOnFinish }).catch(() => {}),
      1200
    )) return;
    const requestControl = onlinePollRequestControlRef.current;
    const request = requestControl.begin();
    try {
      const payload = await api('/api/sync-status?kind=battlemetrics', { signal: request.signal });
      if (!requestControl.isCurrent(request)) return;
      const status = payload.syncState?.battlemetrics || {};
      const keepPolling = applyOnlineSyncStatus(status);
      if (keepPolling) {
        schedulePollTimeout(syncPollRef, () => pollOnlineSyncStatus({ reloadOnFinish }).catch(() => {}), 1200);
        return;
      }
      if (reloadOnFinish && status.status === 'complete') {
        await refreshMembersAndSelection();
        if (!requestControl.isCurrent(request)) return;
        await loadCurrentWipeInfo().catch(() => {});
        if (!requestControl.isCurrent(request)) return;
        setToast(formatCopy(t('battlemetricsSyncDone'), status));
      } else if (reloadOnFinish && status.status === 'failed') {
        setError(localizeError(status.error || t('battlemetricsSyncFailed'), t));
      }
    } catch (error) {
      if (isAbortError(error)) return;
      // Status polling is best-effort; the main sync request still owns errors.
    } finally {
      requestControl.finish(request);
    }
  }

  function applyProfileSyncStatus(status = {}) {
    const nextState = syncUiStateFromServer(status);
    if ((nextState === 'complete' || nextState === 'error') && !shouldShowFinishedSyncState(status)) {
      setProfileSyncStatus({});
      return false;
    }
    setProfileSyncStatus(status);
    return nextState === 'syncing';
  }

  async function pollProfileSyncStatus({ reloadOnFinish = false } = {}) {
    if (!activeRef.current) return;
    if (profileSyncPollRef.current) {
      clearTimeout(profileSyncPollRef.current);
      profileSyncPollRef.current = null;
    }
    if (deferPollWhileHidden(
      profileSyncPollRef,
      () => pollProfileSyncStatus({ reloadOnFinish }).catch(() => {}),
      1500
    )) return;
    const requestControl = profilePollRequestControlRef.current;
    const request = requestControl.begin();
    try {
      const payload = await api('/api/sync-status?kind=memberProfiles', { signal: request.signal });
      if (!requestControl.isCurrent(request)) return;
      const status = payload.syncState?.memberProfiles || {};
      const keepPolling = applyProfileSyncStatus(status);
      if (keepPolling) {
        schedulePollTimeout(profileSyncPollRef, () => pollProfileSyncStatus({ reloadOnFinish }).catch(() => {}), 1500);
        return;
      }
      if (reloadOnFinish && status.status === 'complete') {
        await refreshMembersAndSelection();
        if (!requestControl.isCurrent(request)) return;
        setToast(formatCopy(t('memberProfileSyncDone'), status));
        scheduleProfileSyncReset(2600);
      } else if (reloadOnFinish && status.status === 'failed') {
        setError(localizeError(status.error || t('memberProfileSyncFailed'), t));
        scheduleProfileSyncReset(3600);
      }
    } catch (error) {
      if (isAbortError(error)) return;
      // Profile sync polling is best-effort.
    } finally {
      requestControl.finish(request);
    }
  }

  async function syncOnlineTime() {
    setError('');
    if (syncState === 'syncing' || syncState === 'rateLimited') return;
    const total = syncTargetMemberCount;
    beginOnlineSyncProgress(total, estimateBattlemetricsSyncSeconds(total));
    updateOnlineSyncState('syncing');
    schedulePollTimeout(syncPollRef, () => pollOnlineSyncStatus({ reloadOnFinish: true }).catch(() => {}), 500);
    try {
      const payload = await api('/api/settings/battlemetrics/sync-playtime', { method: 'POST', body: {} });
      if (!activeRef.current) return;
      const status = payload.syncState || {};
      const queued = Boolean(payload.queued || ['queued', 'running'].includes(payload.job?.status) || syncUiStateFromServer(status) === 'syncing');
      if (queued) {
        applyOnlineSyncStatus(status);
        setToast(t('syncJobActionQueued'));
        if (!syncPollRef.current) {
          schedulePollTimeout(syncPollRef, () => pollOnlineSyncStatus({ reloadOnFinish: true }).catch(() => {}), 1200);
        }
        return;
      }
      setToast(formatCopy(t('battlemetricsSyncDone'), payload));
      await refreshMembersAndSelection();
      if (!activeRef.current) return;
      await loadCurrentWipeInfo().catch(() => {});
      if (!activeRef.current) return;
      const nextSource = onlineSourceFromObject(payload);
      if (nextSource) setOnlineSyncSource(nextSource);
      stopSyncProgressTimer();
      const completed = Math.max(0, Math.floor(Number(payload.completed ?? payload.requested ?? total) || 0));
      beginOnlineRateLimitCountdown(KDA_SYNC_COOLDOWN_SECONDS, {
        total: Math.max(0, Math.floor(Number(payload.requested ?? total) || 0)),
        completed,
        phase: 'recovery'
      });
    } catch (err) {
      if (!activeRef.current) return;
      const message = localizeError(err.message, t);
      setError(message);
      if (err.status === 429 || err.retryAfter) {
        beginOnlineRateLimitCountdown(err.retryAfter);
        return;
      }
      failOnlineSyncProgress();
      updateOnlineSyncState('error');
    }
  }

  async function syncAccountData() {
    setError('');
    if (syncUiStateFromServer(profileSyncStatus) === 'syncing') return;
    setProfileSyncStatus({
      status: 'running',
      requested: syncTargetMemberCount,
      completed: 0,
      updated: 0,
      failed: 0,
      percent: 0,
      etaSeconds: Math.max(3, syncTargetMemberCount * 2)
    });
    try {
      const payload = await api('/api/settings/member-profiles/sync', { method: 'POST', body: {} });
      if (!activeRef.current) return;
      const status = payload.syncState || {};
      setProfileSyncStatus(status);
      setToast(formatCopy(t('memberProfileSyncQueued'), status));
      if (syncUiStateFromServer(status) === 'syncing') {
        schedulePollTimeout(profileSyncPollRef, () => pollProfileSyncStatus({ reloadOnFinish: true }).catch(() => {}), 1200);
      } else {
        await refreshMembersAndSelection();
        if (!activeRef.current) return;
        setToast(formatCopy(t('memberProfileSyncDone'), status));
        scheduleProfileSyncReset(2600);
      }
    } catch (err) {
      if (!activeRef.current) return;
      const message = localizeError(err.message, t);
      setError(message);
      setProfileSyncStatus({ status: 'failed', error: message, percent: 100 });
      scheduleProfileSyncReset(3600);
    }
  }

  async function addMember(event) {
    event.preventDefault();
    if (!canCreateMembers) return;
    setError('');
    const vipError = memberVipPurchaseDateValidationError(form, t);
    if (vipError) {
      setError(vipError);
      return;
    }
    setLoading(true);
    try {
      const payload = await api('/api/members', { method: 'POST', body: form });
      setForm({ ...emptyMemberForm(), squadId: squads.length === 1 ? squads[0].id : '' });
      setToast(t('memberAdded'));
      await refreshMembersFromPayload(payload);
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  const applyOptimisticMemberRemoval = useCallback((memberIds = []) => {
    const deleteIds = new Set(memberIds.filter(Boolean));
    if (!deleteIds.size) return null;
    const snapshot = {
      members,
      meta: memberListMeta,
      filterKey: memberListFilterKeyRef.current
    };
    const nextMembers = members.filter((item) => !deleteIds.has(item.id));
    memberListLoadSeqRef.current += 1;
    memberListLoadMoreSeqRef.current += 1;
    setMemberListLoading(false);
    setMemberListLoadingMore(false);
    applyMembers?.(nextMembers, memberListMetaAfterRemoval(memberListMeta, members.length - nextMembers.length, nextMembers.length));
    setSelectedMemberIds((current) => current.filter((id) => !deleteIds.has(id)));
    return snapshot;
  }, [applyMembers, memberListMeta, members]);

  const restoreOptimisticMemberRemoval = useCallback((snapshot) => {
    if (!snapshot || memberListFilterKeyRef.current !== snapshot.filterKey) return;
    applyMembers?.(snapshot.members, snapshot.meta);
  }, [applyMembers]);

  const remove = useCallback(async (member) => {
    if (deletingMemberId || !member?.id) return;
    if (!window.confirm(formatCopy(t('confirmDeleteMember'), { name: member.displayName }))) return;
    setError('');
    setDeletingMemberId(member.id);
    const snapshot = applyOptimisticMemberRemoval([member.id]);
    try {
      await api(`/api/members/${encodeURIComponent(member.id)}?response=minimal`, { method: 'DELETE' });
      setToast(t('memberDeleted'));
      refreshMembersAndSelection().catch((err) => setError(localizeError(err.message, t)));
    } catch (err) {
      restoreOptimisticMemberRemoval(snapshot);
      setError(localizeError(err.message, t));
    } finally {
      setDeletingMemberId('');
    }
  }, [applyOptimisticMemberRemoval, deletingMemberId, refreshMembersAndSelection, restoreOptimisticMemberRemoval, setToast, t]);

  const toggleMemberSelection = useCallback((memberId) => {
    if (!bulkEditMode) return;
    setSelectedMemberIds((current) => (
      current.includes(memberId)
        ? current.filter((id) => id !== memberId)
        : [...current, memberId]
    ));
  }, [bulkEditMode]);

  function toggleFilteredMemberSelection() {
    if (!bulkEditMode) return;
    if (!manageableFilteredMemberIds.length) return;
    setSelectedMemberIds((current) => {
      const next = new Set(current);
      if (allFilteredMembersSelected) {
        manageableFilteredMemberIds.forEach((id) => next.delete(id));
      } else {
        manageableFilteredMemberIds.forEach((id) => next.add(id));
      }
      return [...next];
    });
  }

  async function removeSelectedMembers() {
    if (!bulkEditMode) return;
    const selectedIds = selectedMemberIds.filter((id) => manageableMemberIdSet.has(id));
    if (!selectedIds.length) return;
    if (!window.confirm(formatCopy(t('confirmDeleteSelectedMembers'), { count: selectedIds.length }))) return;
    setBulkDeleting(true);
    setError('');
    const snapshot = applyOptimisticMemberRemoval(selectedIds);
    try {
      const payload = await api('/api/members?response=minimal', { method: 'DELETE', body: { memberIds: selectedIds } });
      setSelectedMemberIds([]);
      setBulkEditMode(false);
      setToast(formatCopy(t('membersDeleted'), { count: payload.deleted ?? selectedIds.length }));
      refreshMembersAndSelection().catch((err) => setError(localizeError(err.message, t)));
    } catch (err) {
      restoreOptimisticMemberRemoval(snapshot);
      setError(localizeError(err.message, t));
    } finally {
      setBulkDeleting(false);
    }
  }

  function enterBulkEditMode() {
    if (!manageableFilteredMemberIds.length) return;
    setBulkEditMode(true);
  }

  function exitBulkEditMode() {
    if (bulkDeleting) return;
    setBulkEditMode(false);
    setSelectedMemberIds([]);
  }

  const syncProgressPercent = Math.max(0, Math.min(100, Number(syncProgress.percent || 0)));
  const syncProgressValues = {
    total: formatStatNumber(syncProgress.total, lang),
    completed: formatStatNumber(syncProgress.completed, lang),
    seconds: formatStatNumber(syncProgress.etaSeconds, lang),
    message: error || t('requestFailed')
  };
  const isOnlineRecoveryCountdown = syncState === 'rateLimited' && syncProgress.phase === 'recovery';
  const syncProgressMeta = syncState === 'syncing'
    ? formatCopy(t('syncKdaProgressMeta'), syncProgressValues)
    : syncState === 'complete'
      ? formatCopy(t('syncKdaCompleteMeta'), syncProgressValues)
      : syncState === 'rateLimited'
        ? formatCopy(t(isOnlineRecoveryCountdown ? 'syncKdaRecoveryMeta' : 'syncKdaRateLimitedMeta'), syncProgressValues)
        : formatCopy(t('syncKdaFailedMeta'), syncProgressValues);
  const syncFeedbackTitle = syncState === 'syncing'
    ? t('battlemetricsSyncing')
    : syncState === 'complete'
      ? t('battlemetricsSyncComplete')
      : syncState === 'rateLimited'
        ? t(isOnlineRecoveryCountdown ? 'syncKdaRecovery' : 'syncKdaRateLimited')
        : t('battlemetricsSyncFailed');
  const syncFeedbackText = syncState === 'syncing'
    ? t('battlemetricsSyncWaiting')
    : syncState === 'complete'
      ? t('battlemetricsSyncComplete')
      : syncState === 'rateLimited'
        ? t(isOnlineRecoveryCountdown ? 'syncKdaRecoveryCountdown' : 'syncKdaRetryCountdown')
        : error;
  const syncButtonText = syncState === 'syncing'
    ? t('battlemetricsSyncing')
    : syncState === 'complete'
      ? t('battlemetricsSyncComplete')
      : syncState === 'rateLimited'
        ? (isOnlineRecoveryCountdown ? t('syncKdaRecoveringShort') : formatCopy(t('syncKdaCooldownShort'), syncProgressValues))
        : t('battlemetricsSyncShort');
  const profileSyncUiState = syncUiStateFromServer(profileSyncStatus);
  const profileSyncButtonText = profileSyncUiState === 'syncing'
    ? t('memberProfileSyncing')
    : profileSyncUiState === 'complete'
      ? t('memberProfileSyncComplete')
      : profileSyncUiState === 'error'
        ? t('memberProfileSyncFailed')
        : t('memberProfileSyncAccountData');
  const syncVisualPercent = syncVisualProgressPercent(syncState, syncProgressPercent);
  const syncCatPosition = `${syncVisualPercent}%`;

  return (
    <section className="page-stack">
      {canCreateMembers && <div className="tool-panel member-add-panel">
        <div className="section-heading compact-heading">
          <button
            type="button"
            className="ghost-button fit-button member-add-toggle"
            aria-expanded={addOpen}
            onClick={() => setAddOpen((current) => !current)}
          >
            <Plus size={17} />
            <span>{t('addMemberPanel')}</span>
          </button>
        </div>
        {addOpen && (
          <form className="embedded-member-form member-form" id="member-add-form" onSubmit={addMember}>
            <label>
              <span>{t('steamId')}</span>
              <input
                value={form.steamInput}
                onChange={(event) => setForm({ ...form, steamInput: event.target.value })}
                placeholder={t('steamInputPlaceholder')}
                required
              />
            </label>
            <label>
              <span>{t('memberName')}</span>
              <input
                value={form.customName}
                onChange={(event) => setForm({ ...form, customName: event.target.value })}
                placeholder={t('memberNamePlaceholder')}
              />
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
              <span>{t('squad')}</span>
              <select value={form.squadId} onChange={(event) => setForm({ ...form, squadId: event.target.value })}>
                <option value="">{t('unassignedSquad')}</option>
                {squads.map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
              </select>
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
            <div className="member-add-actions">
              <button type="button" className="ghost-button warning-button compact-form-button" onClick={() => setAddOpen(false)}>
                {t('cancel')}
              </button>
              <button type="button" className="ghost-button compact-form-button" title={t('bulkImportMembers')} onClick={() => {
                setAddOpen(false);
                setBulkImportOpen(true);
              }}>
                <FileUp size={18} />
                <span>{t('bulkImportShort')}</span>
              </button>
              <button className="primary-button compact-form-button" title={t('add')} disabled={loading}>
                <Plus size={18} />
                <span>{loading ? t('adding') : t('addShort')}</span>
              </button>
            </div>
          </form>
        )}
      </div>}

      <div className="section-heading compact-heading">
        <div className="heading-stack">
          <MemberOnlineDataSource
            source={memberOnlineSource ? { ...memberOnlineSource, syncedAt: memberOnlineDataTime } : null}
            plannedWipe={plannedWipeInfo}
            showPlannedWipe={showPlannedWipeInfo}
            lang={lang}
            t={t}
          />
        </div>
        {canSyncOnline && (
          <div className="member-sync-actions">
            <button
              type="button"
              className="ghost-button fit-button export-button"
              title={t('memberExportTitle')}
              onClick={() => setMemberExportOpen(true)}
            >
              <Download size={17} />
              <span>{t('downloadCsvShort')}</span>
            </button>
            <button
              type="button"
              className={cx('ghost-button sync-kda-button', syncState === 'syncing' && 'syncing', syncState === 'complete' && 'complete', syncState === 'error' && 'error', syncState === 'rateLimited' && 'rate-limited')}
              title={t('battlemetricsSyncPlaytime')}
              onClick={syncOnlineTime}
              disabled={syncState === 'syncing' || syncState === 'rateLimited'}
            >
              <RefreshCw size={17} />
              <span>{syncButtonText}</span>
            </button>
            <button
              type="button"
              className={cx('ghost-button sync-kda-button profile-sync-button', profileSyncUiState === 'syncing' && 'syncing', profileSyncUiState === 'complete' && 'complete', profileSyncUiState === 'error' && 'error')}
              title={t('memberProfileSyncAccountData')}
              onClick={syncAccountData}
              disabled={profileSyncUiState === 'syncing'}
            >
              <UserCheck size={17} />
              <span>{profileSyncButtonText}</span>
            </button>
          </div>
        )}
      </div>
      {syncState !== 'idle' && (
        <div className={cx('sync-feedback', syncState)} aria-live="polite" style={{ '--sync-progress': `${syncVisualPercent}%`, '--sync-cat-position': syncCatPosition }}>
          <span className="sync-feedback-orbit" />
          <div className="sync-feedback-content">
            <div className="sync-feedback-title-row">
              <strong>{syncFeedbackTitle}</strong>
              <span className="sync-feedback-count">{syncProgressMeta}</span>
            </div>
            <small>{syncFeedbackText}</small>
            <div className="sync-progress-track" aria-hidden="true">
              <span className="sync-progress-fill" />
              <span className="sync-cat-runner">
                <span className="sync-cat-tail" />
                <span className="sync-cat-body" />
                <span className="sync-cat-head" />
              </span>
            </div>
          </div>
        </div>
      )}
      {error && syncState !== 'rateLimited' && <Alert tone="danger">{error}</Alert>}

      <div className="member-toolbar">
        <label className="member-squad-filter">
          <select
            value={memberSquadFilter}
            aria-label={t('selectSquad')}
            onChange={(event) => setMemberSquadFilter(event.target.value)}
          >
            <option value="">{t('allSquads')}</option>
            <option value="__unassigned">{t('unassignedSquad')}</option>
            {squads.map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
          </select>
        </label>
        <label className="member-squad-filter member-specialty-filter">
          <select
            value={memberSpecialtyFilter}
            aria-label={t('memberSpecialtyFilter')}
            onChange={(event) => setMemberSpecialtyFilter(event.target.value)}
          >
            <option value="">{t('allSpecialties')}</option>
            {SPECIALTY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
            ))}
          </select>
        </label>
        <label className="member-squad-filter member-vip-filter">
          <select
            value={memberVipFilter}
            aria-label={t('memberVipFilter')}
            onChange={(event) => setMemberVipFilter(event.target.value)}
          >
            <option value="">{t('allVitalVip')}</option>
            <option value="none">{t('vitalVipNone')}</option>
            <option value="priority">{t('vitalVipPriority')}</option>
            <option value="queue_skip">{t('vitalVipQueueSkip')}</option>
          </select>
        </label>
        <label className="member-search-field">
          <Search size={16} />
          <input
            value={memberSearch}
            onChange={(event) => setMemberSearch(event.target.value)}
            placeholder={t('memberSearchPlaceholder')}
            aria-label={t('memberSearchPlaceholder')}
          />
          {memberSearch && (
            <button type="button" className="icon-button" title={t('clearSearch')} onClick={() => setMemberSearch('')}>
              <X size={15} />
            </button>
          )}
        </label>
        <div className="member-bulk-actions">
          <span className="member-filter-count">{formatCopy(t('memberFilterCount'), {
            shown: formatStatNumber(filteredMembers.length, lang),
            total: formatStatNumber(memberTotalCount, lang)
          })}</span>
          {canDeleteMembers && (bulkEditMode ? (
            <>
              <button
                type="button"
                className="ghost-button fit-button"
                onClick={toggleFilteredMemberSelection}
                disabled={!manageableFilteredMemberIds.length || bulkDeleting}
              >
                {allFilteredMembersSelected ? <CheckSquare size={17} /> : <Square size={17} />}
                <span>{allFilteredMembersSelected ? t('clearVisibleSelection') : t('selectVisibleMembers')}</span>
              </button>
              <span className="selected-count">{formatCopy(t('selectedCount'), { count: formatStatNumber(selectedMemberIds.length, lang) })}</span>
              <button
                type="button"
                className="action-button danger member-bulk-delete"
                onClick={removeSelectedMembers}
                disabled={!selectedMemberIds.length || bulkDeleting}
              >
                <Trash2 size={17} />
                <span>{bulkDeleting ? t('deletingSelectedMembers') : t('deleteSelectedMembers')}</span>
              </button>
              <button type="button" className="action-button" onClick={exitBulkEditMode} disabled={bulkDeleting}>
                <X size={17} />
                <span>{t('cancel')}</span>
              </button>
            </>
          ) : (
            <button type="button" className="ghost-button fit-button" onClick={enterBulkEditMode} disabled={!manageableFilteredMemberIds.length}>
              <Pencil size={17} />
              <span>{t('bulkEditMembers')}</span>
            </button>
          ))}
        </div>
      </div>

      {memberListLoading && !members.length ? (
        <PageLoadingState title={t('navMembers')} t={t} compact />
      ) : (
        <MemberTable
          bulkEditMode={bulkEditMode}
          bulkDeleting={bulkDeleting}
          canDeleteMembers={canDeleteMembers}
          columns={memberTableColumns}
          deletingMemberId={deletingMemberId}
          emptyText={memberTableEmptyText}
          filteredMembers={filteredMembers}
          selectedMemberIdSet={selectedMemberIdSet}
          lang={lang}
          t={t}
          setToast={setToast}
          onToggleMemberSelection={toggleMemberSelection}
          onOpenProfile={setProfileMember}
          onEdit={setEditing}
          onRemove={remove}
        />
      )}
      <div ref={memberListSentinelRef} className="member-list-load-more" aria-live="polite">
        {memberListLoadingMore
          ? t('loadingMoreMembers')
          : memberListMeta?.hasMore
            ? t('scrollLoadMoreMembers')
            : (filteredMembers.length ? t('allMembersLoaded') : '')}
      </div>

      {editing && (
        <MemberEditor
          member={editing}
          squads={squads}
          t={t}
          onClose={() => setEditing(null)}
          onSaved={async (payload) => {
            setEditing(null);
            setToast(t('memberUpdated'));
            await refreshMembersFromPayload(payload);
          }}
        />
      )}
      {profileMember && (
        <MemberProfileModal
          member={profileMember}
          lang={lang}
          t={t}
          setToast={setToast}
          onEdit={(member) => {
            setProfileMember(null);
            setEditing(member);
          }}
          onMemberUpdated={async () => {
            await refreshMembersAndSelection();
          }}
          canSyncOnline={canSyncOnline}
          onOpenRustKdaLookup={onOpenRustKdaLookup}
          onClose={() => setProfileMember(null)}
        />
      )}
      {canSyncOnline && memberExportOpen && (
        <MemberExportModal
          squads={squads}
          t={t}
          setToast={setToast}
          onClose={() => setMemberExportOpen(false)}
        />
      )}
      {canCreateMembers && bulkImportOpen && (
        <BulkMemberImportModal
          squads={squads}
          defaultSquadId={form.squadId}
          defaultSpecialty={form.specialty}
          t={t}
          onClose={() => setBulkImportOpen(false)}
	          onImported={async (payload) => {
	            setToast(formatCopy(t('bulkImportDone'), payload));
	            if (Number(payload.imported || 0) > 0 || payload.members) await refreshMembersAndSelection();
	          }}
        />
      )}
    </section>
  );
}
