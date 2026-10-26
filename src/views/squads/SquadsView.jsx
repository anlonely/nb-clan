import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UserCheck,
  UserRound,
  Users,
  X
} from 'lucide-react';
import { api } from '../../shared/api.js';
import { accountRoleLabel } from '../../shared/permissions.js';
import { displayDataValue, formatCopy, formatTime, localizeError } from '../../shared/format.js';
import {
  MemberEditor,
  MemberPicker,
  MemberProfileModal,
  memberProfileCanSyncOnline
} from '../../shared/member/dialogs.jsx';
import { MemberName } from '../../shared/member/MemberName.jsx';
import { MemberOnlineSummary } from '../../shared/member/status.jsx';
import { SpecialtyBadge } from '../../shared/member/specialty.jsx';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { ModalFrame } from '../../shared/ui/ModalFrame.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';

const SQUAD_MEMBER_PAGE_SIZE = 10;

function mergeMemberPages(currentMembers = [], nextMembers = []) {
  const merged = [...currentMembers];
  const indexById = new Map(merged.map((member, index) => [member.id, index]));
  for (const member of nextMembers) {
    if (!member?.id) continue;
    const existingIndex = indexById.get(member.id);
    if (existingIndex === undefined) {
      indexById.set(member.id, merged.length);
      merged.push(member);
    } else {
      merged[existingIndex] = member;
    }
  }
  return merged;
}

function squadLeaderIds(squad = {}) {
  const ids = Array.isArray(squad.leaderUserIds) ? squad.leaderUserIds : [squad.leaderUserId];
  return [...new Set(ids.map((id) => String(id || '').trim()).filter(Boolean))];
}

function squadLeaderLabel(squad, t) {
  if (Array.isArray(squad?.leaderNames) && squad.leaderNames.length) return squad.leaderNames.join(', ');
  return displayDataValue(squad?.leaderName, t);
}

function selectedLeaderUsers(users, selectedIds) {
  const usersById = new Map(users.map((item) => [item.id, item]));
  return (selectedIds || []).map((id) => usersById.get(id)).filter(Boolean);
}

function LeaderSummaryControl({ users, selectedIds, actionLabel, onEdit, t }) {
  const leaders = selectedLeaderUsers(users, selectedIds);

  return (
    <div className="leader-summary-control">
      <div className="leader-summary-head">
        <span>{t('leader')}</span>
        <button type="button" className="action-button" onClick={onEdit}>
          <Users size={16} />
          <span>{actionLabel}</span>
        </button>
      </div>
      <div className={cx('leader-chip-row', !leaders.length && 'empty')}>
        {leaders.length ? leaders.map((leader) => (
          <span key={leader.id} className="leader-chip">
            <ShieldCheck size={14} />
            {leader.displayName || leader.username}
          </span>
        )) : <span>{t('noLeaderSelected')}</span>}
      </div>
    </div>
  );
}

function LeaderSelectionModal({ title, users, selectedIds, t, onConfirm, onClose }) {
  const [selected, setSelected] = useState(() => [...new Set(selectedIds || [])]);
  const [query, setQuery] = useState('');
  const selectedSet = new Set(selected);
  const orderedLeaders = selectedLeaderUsers(users, selected);
  const deferredQuery = useDeferredValue(query);
  const normalizedQuery = deferredQuery.trim().toLowerCase();
  const filteredUsers = useMemo(() => users.filter((item) => {
    if (!normalizedQuery) return true;
    return [item.username, item.displayName, item.boundSteamId, accountRoleLabel(item, t)]
      .some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
  }), [normalizedQuery, t, users]);

  function toggle(userId) {
    setSelected((current) => {
      if (current.includes(userId)) return current.filter((id) => id !== userId);
      return [...current, userId];
    });
  }

  function moveLeader(userId, offset) {
    setSelected((current) => {
      const index = current.indexOf(userId);
      const nextIndex = index + offset;
      if (index < 0 || nextIndex < 0 || nextIndex >= current.length) return current;
      const next = [...current];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function removeLeader(userId) {
    setSelected((current) => current.filter((id) => id !== userId));
  }

  function submit(event) {
    event.preventDefault();
    if (!selected.length) return;
    onConfirm(selected);
  }

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="modal leader-selection-modal" role="dialog" aria-modal="true" aria-labelledby="leader-selection-title" onSubmit={submit}>
        <div className="modal-title">
          <div>
            <h3 id="leader-selection-title">{title}</h3>
            <span className="modal-subtitle">{formatCopy(t('selectedCount'), { count: selected.length })}</span>
          </div>
          <button type="button" className="icon-button" onClick={onClose} title={t('close')}>
            <X size={18} />
          </button>
        </div>
        <p className="modal-hint">{t('leaderSelectionHint')}</p>
        <div className="leader-order-panel">
          <div className="leader-order-head">
            <span>{t('leaderOrderHint')}</span>
          </div>
          {orderedLeaders.length ? (
            <div className="leader-order-list">
              {orderedLeaders.map((leader, index) => (
                <div key={leader.id} className="leader-order-row">
                  <span className="leader-order-index">#{index + 1}</span>
                  <span className="leader-selection-avatar">{String(leader.displayName || leader.username || '?').slice(0, 1).toUpperCase()}</span>
                  <span className="leader-selection-main">
                    <strong>{leader.displayName || leader.username}</strong>
                    <small>{leader.username} · {accountRoleLabel(leader, t)}</small>
                  </span>
                  {index === 0 && <b className="primary-leader-badge">{t('primaryLeader')}</b>}
                  <span className="leader-order-actions">
                    <button type="button" className="icon-button mini" onClick={() => moveLeader(leader.id, -1)} disabled={index === 0} title={t('moveLeaderUp')}>
                      <ArrowUp size={15} />
                    </button>
                    <button type="button" className="icon-button mini" onClick={() => moveLeader(leader.id, 1)} disabled={index === orderedLeaders.length - 1} title={t('moveLeaderDown')}>
                      <ArrowDown size={15} />
                    </button>
                    <button type="button" className="icon-button mini danger" onClick={() => removeLeader(leader.id)} title={t('remove')}>
                      <Trash2 size={15} />
                    </button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="leader-order-empty">{t('noLeaderSelected')}</div>
          )}
        </div>
        <label className="leader-search-field">
          <span>{t('search')}</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('leaderSearchPlaceholder')} autoFocus />
        </label>
        <div className="leader-selection-list">
          {filteredUsers.map((item) => {
            const checked = selectedSet.has(item.id);
            return (
              <label key={item.id} className={cx('leader-selection-row', checked && 'selected')}>
                <input type="checkbox" checked={checked} onChange={() => toggle(item.id)} />
                <span className="leader-selection-avatar">{String(item.displayName || item.username || '?').slice(0, 1).toUpperCase()}</span>
                <span className="leader-selection-main">
                  <strong>{item.displayName || item.username}</strong>
                  <small>{item.username} · {accountRoleLabel(item, t)}</small>
                </span>
                <span className="leader-selection-steam mono">{item.boundSteamId || t('unbound')}</span>
              </label>
            );
          })}
          {!filteredUsers.length && <div className="empty-state">{t('noAccounts')}</div>}
        </div>
        <div className="modal-actions">
          <span>{formatCopy(t('selectedCount'), { count: selected.length })}</span>
          <button type="button" className="ghost-button" onClick={onClose}>{t('cancel')}</button>
          <button className="primary-button" disabled={!selected.length}>
            <UserCheck size={18} />
            {t('confirm')}
          </button>
        </div>
      </form>
    </div>
  );
}

export default function SquadsView({ user, setToast, lang, t, onOpenRustKdaLookup = null }) {
  const [squads, setSquads] = useState([]);
  const [users, setUsers] = useState([]);
  const [selectedId, setSelectedId] = useState('');
  const [members, setMembers] = useState([]);
  const [memberPageMeta, setMemberPageMeta] = useState({ total: 0, offset: 0, limit: SQUAD_MEMBER_PAGE_SIZE, hasMore: false, loaded: false });
  const [candidates, setCandidates] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [leaderModal, setLeaderModal] = useState(null);
  const [profileMember, setProfileMember] = useState(null);
  const [editingMember, setEditingMember] = useState(null);
  const [deleteConfirmMember, setDeleteConfirmMember] = useState(null);
  const [form, setForm] = useState({ name: '', leaderUserIds: [], notes: '' });
  const [detailForm, setDetailForm] = useState({ name: '', leaderUserIds: [], notes: '' });
  const [error, setError] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersLoadingMore, setMembersLoadingMore] = useState(false);
  const [squadAction, setSquadAction] = useState('');
  const selectedIdRef = useRef('');
  const memberPagesBySquadIdRef = useRef({});
  const squadMemberListSentinelRef = useRef(null);
  const isAdmin = user.role === 'admin';

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  function emptySquadMemberPage() {
    return { members: [], total: 0, offset: 0, limit: SQUAD_MEMBER_PAGE_SIZE, hasMore: false, loaded: true };
  }

  function pruneSquadMemberCache(nextSquads = []) {
    const validIds = new Set((nextSquads || []).map((squad) => squad.id).filter(Boolean));
    memberPagesBySquadIdRef.current = Object.fromEntries(
      Object.entries(memberPagesBySquadIdRef.current || {}).filter(([squadId]) => validIds.has(squadId))
    );
  }

  function cacheSquadMembers(squadId, nextMembers, meta = {}, options = {}) {
    if (!squadId) return;
    const previous = memberPagesBySquadIdRef.current[squadId] || emptySquadMemberPage();
    const normalizedMembers = Array.isArray(nextMembers) ? nextMembers : [];
    const mergedMembers = options.append ? mergeMemberPages(previous.members, normalizedMembers) : normalizedMembers;
    const nextEntry = {
      members: mergedMembers,
      total: Math.max(0, Number(meta.total ?? mergedMembers.length) || 0),
      offset: Math.max(0, Number(meta.offset || 0) || 0),
      limit: Math.max(1, Number(meta.limit || SQUAD_MEMBER_PAGE_SIZE) || SQUAD_MEMBER_PAGE_SIZE),
      hasMore: Boolean(meta.hasMore),
      loaded: true
    };
    memberPagesBySquadIdRef.current = {
      ...memberPagesBySquadIdRef.current,
      [squadId]: nextEntry
    };
    if (selectedIdRef.current === squadId) {
      setMembers(nextEntry.members);
      setMemberPageMeta(nextEntry);
    }
    return nextEntry;
  }

  function openLeaderModal(mode) {
    setLeaderModal({
      mode,
      selectedIds: mode === 'create' ? form.leaderUserIds : detailForm.leaderUserIds
    });
  }

  function confirmLeaders(leaderUserIds) {
    if (leaderModal?.mode === 'create') {
      setForm((current) => ({ ...current, leaderUserIds }));
    } else {
      setDetailForm((current) => ({ ...current, leaderUserIds }));
    }
    setLeaderModal(null);
  }

  async function loadSquads(options = {}) {
    const { updateSelected = true } = options;
    const payload = await api('/api/squads');
    const nextSquads = payload.squads || [];
    const fallbackSelectedId = nextSquads[0]?.id || '';
    setSquads(nextSquads);
    pruneSquadMemberCache(nextSquads);
    if (updateSelected) {
      setSelectedId((current) => current || fallbackSelectedId);
    }
    return { squads: nextSquads, fallbackSelectedId };
  }

  async function loadUsers() {
    if (!isAdmin) return;
    const payload = await api('/api/users');
    setUsers(payload.users || []);
  }

  async function fetchSquadMemberPage(squadId, options = {}) {
    const pageLimit = Math.max(1, Number(options.limit || SQUAD_MEMBER_PAGE_SIZE) || SQUAD_MEMBER_PAGE_SIZE);
    const pageOffset = Math.max(0, Number(options.offset || 0) || 0);
    const payload = await api(`/api/squads/${squadId}/members?limit=${pageLimit}&offset=${pageOffset}`);
    const nextMembers = payload.members || [];
    return {
      members: nextMembers,
      total: payload.total ?? nextMembers.length,
      offset: payload.offset ?? pageOffset,
      limit: payload.limit ?? pageLimit,
      hasMore: Boolean(payload.hasMore)
    };
  }

  async function preloadSquadMembers(nextSquads = []) {
    const squadIds = [...new Set((nextSquads || []).map((squad) => squad.id).filter(Boolean))];
    if (!squadIds.length) {
      return memberPagesBySquadIdRef.current;
    }
    const entries = await Promise.all(squadIds.map(async (squadId) => {
      const entry = await fetchSquadMemberPage(squadId, { limit: SQUAD_MEMBER_PAGE_SIZE, offset: 0 });
      return [squadId, entry];
    }));
    const nextCache = entries.reduce((cache, [squadId, entry]) => {
      cache[squadId] = {
        ...entry,
        loaded: true
      };
      return cache;
    }, { ...memberPagesBySquadIdRef.current });
    memberPagesBySquadIdRef.current = nextCache;
    return nextCache;
  }

  async function refreshSquadsAndMemberPages() {
    const payload = await loadSquads({ updateSelected: false });
    const nextSquads = payload?.squads || [];
    const currentSelectedId = selectedIdRef.current;
    const nextSelectedId = nextSquads.some((squad) => squad.id === currentSelectedId)
      ? currentSelectedId
      : (payload?.fallbackSelectedId || '');
    selectedIdRef.current = nextSelectedId;
    setSelectedId(nextSelectedId);
    if (nextSelectedId) {
      await loadMembers(nextSelectedId, { force: true });
      const backgroundSquads = nextSquads.filter((squad) => squad.id !== nextSelectedId);
      preloadSquadMembers(backgroundSquads).catch(() => {});
    } else {
      setMembers([]);
      setMemberPageMeta({ total: 0, offset: 0, limit: SQUAD_MEMBER_PAGE_SIZE, hasMore: false, loaded: true });
    }
    return { squads: nextSquads, selectedId: nextSelectedId, cache: memberPagesBySquadIdRef.current };
  }

  async function loadMembers(squadId = selectedId, options = {}) {
    const { force = false, append = false, offset = 0, limit = SQUAD_MEMBER_PAGE_SIZE } = options;
    if (!squadId) {
      setMembers([]);
      setMembersLoading(false);
      setMembersLoadingMore(false);
      setMemberPageMeta({ total: 0, offset: 0, limit: SQUAD_MEMBER_PAGE_SIZE, hasMore: false, loaded: true });
      return;
    }
    const cachedEntry = memberPagesBySquadIdRef.current[squadId];
    if (!force && !append && cachedEntry?.loaded) {
      setMembers(cachedEntry.members || []);
      setMemberPageMeta(cachedEntry);
      setMembersLoading(false);
      setMembersLoadingMore(false);
      return;
    }
    if (append) {
      setMembersLoadingMore(true);
    } else {
      setMembersLoading(true);
      setMembersLoadingMore(false);
    }
    try {
      const entry = await fetchSquadMemberPage(squadId, { limit, offset });
      cacheSquadMembers(squadId, entry.members, {
        total: entry.total,
        offset: entry.offset,
        limit: entry.limit,
        hasMore: entry.hasMore
      }, { append });
    } finally {
      if (selectedIdRef.current === squadId) {
        if (append) {
          setMembersLoadingMore(false);
        } else {
          setMembersLoading(false);
        }
      }
    }
  }

  async function loadCandidates() {
    if (!selectedSquad?.canManage || squadAction) return;
    setError('');
    setSquadAction('load-candidates');
    try {
      const payload = await api(`/api/squads/${selectedId}/candidates`);
      setCandidates(payload.members || []);
      setShowPicker(true);
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSquadAction('');
    }
  }

  useEffect(() => {
    setInitialLoading(true);
    setError('');
    Promise.all([
      refreshSquadsAndMemberPages(),
      loadUsers().catch(() => {})
    ])
      .catch((err) => setError(localizeError(err.message, t)))
      .finally(() => setInitialLoading(false));
  }, []);

  useEffect(() => {
    const squad = squads.find((item) => item.id === selectedId);
    if (squad) {
      setDetailForm({ name: squad.name || '', leaderUserIds: squadLeaderIds(squad), notes: squad.notes || '' });
    }
    loadMembers(selectedId).catch((err) => setError(localizeError(err.message, t)));
  }, [selectedId, squads]);

  async function handleRefreshSquads() {
    if (squadAction) return;
    setSquadAction('refresh');
    setError('');
    try {
      await refreshSquadsAndMemberPages();
      setToast(t('squadDataRefreshed'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSquadAction('');
    }
  }

  async function createSquad(event) {
    event.preventDefault();
    if (squadAction) return;
    setError('');
    setSquadAction('create');
    try {
      const payload = await api('/api/squads', { method: 'POST', body: form });
      setSquads(payload.squads || []);
      setForm({ name: '', leaderUserIds: [], notes: '' });
      setToast(t('squadCreated'));
      await refreshSquadsAndMemberPages();
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSquadAction('');
    }
  }

  async function saveSquad(event) {
    event.preventDefault();
    if (!selectedId || !selectedSquad?.canManage || squadAction) return;
    setError('');
    setSquadAction(`save:${selectedId}`);
    try {
      const payload = await api(`/api/squads/${selectedId}`, { method: 'PUT', body: detailForm });
      setSquads(payload.squads || []);
      setToast(t('squadUpdated'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSquadAction('');
    }
  }

  async function addMembers(memberIds) {
    if (!selectedSquad?.canManage || squadAction) return;
    setError('');
    setSquadAction('add-members');
    try {
      await api(`/api/squads/${selectedId}/members`, { method: 'POST', body: { memberIds } });
      setShowPicker(false);
      setToast(t('squadMemberAdded'));
      await loadSquads();
      await loadMembers(selectedId, { force: true });
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSquadAction('');
    }
  }

  async function removeMember(member) {
    if (!selectedSquad?.canManage || !member?.id || squadAction) return;
    setError('');
    setSquadAction(`remove:${member.id}`);
    try {
      await api(`/api/squads/${selectedId}/members/${member.id}`, { method: 'DELETE' });
      setToast(t('squadMemberRemoved'));
      await loadSquads();
      await loadMembers(selectedId, { force: true });
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSquadAction('');
    }
  }

  async function deleteMember(member) {
    if (!member?.canManage || squadAction) return;
    setError('');
    setSquadAction(`delete-member:${member.id}`);
    try {
      await api(`/api/members/${member.id}`, { method: 'DELETE' });
      setDeleteConfirmMember(null);
      setProfileMember((current) => (current?.id === member.id ? null : current));
      setEditingMember((current) => (current?.id === member.id ? null : current));
      setToast(t('memberDeleted'));
      await loadSquads();
      await loadMembers(selectedId, { force: true });
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSquadAction('');
    }
  }

  const selectedSquad = squads.find((item) => item.id === selectedId);
  const manageableSquads = squads.filter((squad) => squad.canManage);
  const isSquadActionBusy = Boolean(squadAction);
  const isCreatingSquad = squadAction === 'create';
  const isRefreshingSquads = squadAction === 'refresh';
  const isSavingSelectedSquad = squadAction === `save:${selectedId}`;
  const isAddingMembers = squadAction === 'add-members';
  const isLoadingCandidates = squadAction === 'load-candidates';
  const canLoadMoreSquadMembers = Boolean(selectedSquad && memberPageMeta.hasMore && !membersLoading && !membersLoadingMore);

  const loadMoreSquadMembers = useCallback(async () => {
    const squadId = selectedIdRef.current;
    if (!squadId || !canLoadMoreSquadMembers) return;
    try {
      await loadMembers(squadId, {
        append: true,
        limit: SQUAD_MEMBER_PAGE_SIZE,
        offset: members.length
      });
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }, [canLoadMoreSquadMembers, members.length, t]);

  useEffect(() => {
    const node = squadMemberListSentinelRef.current;
    if (!node || !canLoadMoreSquadMembers) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreSquadMembers().catch(() => {});
      }
    }, { rootMargin: '240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [canLoadMoreSquadMembers, loadMoreSquadMembers]);

  async function deleteSquad(squad) {
    if (!squad || squadAction || !window.confirm(formatCopy(t('confirmDeleteSquad'), { name: squad.name }))) return;
    setError('');
    setSquadAction(`delete:${squad.id}`);
    try {
      const payload = await api(`/api/squads/${squad.id}`, { method: 'DELETE' });
      const nextSquads = payload.squads || [];
      const nextSquad = nextSquads[0] || null;
      setSquads(nextSquads);
      pruneSquadMemberCache(nextSquads);
      selectedIdRef.current = nextSquad?.id || '';
      setSelectedId(nextSquad?.id || '');
      if (nextSquad) {
        setDetailForm({ name: nextSquad.name || '', leaderUserIds: squadLeaderIds(nextSquad), notes: nextSquad.notes || '' });
        await loadMembers(nextSquad.id, { force: true });
      } else {
        setMembers([]);
        setDetailForm({ name: '', leaderUserIds: [], notes: '' });
      }
      setToast(t('squadDeleted'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSquadAction('');
    }
  }

  if (initialLoading) {
    return (
      <section className="page-stack">
        <PageLoadingState title={t('squadManagement')} t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="split-grid squad-layout">
        <div className="tool-panel">
          <div className="section-heading compact-heading">
            <h3>{t('squadManagement')}</h3>
            <button type="button" className="ghost-button" onClick={handleRefreshSquads} disabled={isSquadActionBusy}>
              <RefreshCw size={17} />
              {isRefreshingSquads ? t('loading') : t('refresh')}
            </button>
          </div>
          <div className="list-stack">
            {squads.map((squad) => (
              <button key={squad.id} className={cx('list-row-button', selectedId === squad.id && 'active')} onClick={() => setSelectedId(squad.id)}>
                <strong>{squad.name}</strong>
                <span>{t('leader')}: {squadLeaderLabel(squad, t)}</span>
                <small>{t('memberCount')}: {squad.memberCount} · {t('participantCount')}: {squad.participantCount}</small>
              </button>
            ))}
            {!squads.length && <div className="empty-state">{t('noSquads')}</div>}
          </div>
        </div>

        <div className="page-stack">
          {isAdmin && (
            <form className="tool-panel inline-form" onSubmit={createSquad}>
              <label>
                <span>{t('squadName')}</span>
                <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
              </label>
              <LeaderSummaryControl
                users={users}
                selectedIds={form.leaderUserIds}
                actionLabel={t('chooseLeaders')}
                onEdit={() => openLeaderModal('create')}
                t={t}
              />
              <button className="primary-button align-end" title={t('newSquad')} disabled={isSquadActionBusy || !form.name.trim() || !form.leaderUserIds.length}>
                <Plus size={18} />
                <span>{isCreatingSquad ? t('saving') : t('newSquadShort')}</span>
              </button>
            </form>
          )}

          {selectedSquad ? (
            <form className="tool-panel member-form" onSubmit={saveSquad}>
              <label>
                <span>{t('squadName')}</span>
                <input value={detailForm.name} onChange={(event) => setDetailForm({ ...detailForm, name: event.target.value })} disabled={!selectedSquad.canManage} />
              </label>
              {isAdmin && (
                <LeaderSummaryControl
                  users={users}
                  selectedIds={detailForm.leaderUserIds}
                  actionLabel={t('editLeaders')}
                  onEdit={() => openLeaderModal('edit')}
                  t={t}
                />
              )}
              <label className="span-2">
                <span>{t('notes')}</span>
                <input value={detailForm.notes} onChange={(event) => setDetailForm({ ...detailForm, notes: event.target.value })} disabled={!selectedSquad.canManage} />
              </label>
              {selectedSquad.canManage && (
                <button className="primary-button align-end" title={t('save')} disabled={isSquadActionBusy || (isAdmin && !detailForm.leaderUserIds.length)}>
                  <Save size={18} />
                  <span>{isSavingSelectedSquad ? t('saving') : t('saveShort')}</span>
                </button>
              )}
            </form>
          ) : null}
        </div>
      </div>

      <div className="section-heading">
        <h3>{selectedSquad?.name || t('squadManagement')}</h3>
        {selectedSquad && (
          <div className="row-actions toolbar-compact">
            {isAdmin && (
              <button type="button" className="action-button danger" onClick={() => deleteSquad(selectedSquad)} title={t('deleteSquad')} disabled={isSquadActionBusy}>
                <Trash2 size={16} />
                <span>{squadAction === `delete:${selectedSquad.id}` ? t('saving') : t('deleteSquad')}</span>
              </button>
            )}
            {selectedSquad.canManage && (
              <button type="button" className="primary-button" onClick={loadCandidates} title={t('addMembers')} disabled={isSquadActionBusy}>
                <UserCheck size={18} />
                <span>{isLoadingCandidates ? t('loading') : t('addMembersShort')}</span>
              </button>
            )}
          </div>
        )}
      </div>
      <DataTable
        className="squad-member-table"
        columns={[t('nickname'), t('specialty'), t('createdAt'), t('onlineTime'), t('manage')]}
        emptyText={membersLoading ? t('loading') : t('noSquadMembers')}
      >
        {members.map((member) => (
          <tr key={member.id}>
            <td><MemberName member={member} t={t} setToast={setToast} showSteamId onProfileClick={setProfileMember} /></td>
            <td><SpecialtyBadge value={member.specialty} t={t} /></td>
            <td>{formatTime(member.createdAt, lang)}</td>
            <td><MemberOnlineSummary summary={member.onlineSummary} lang={lang} t={t} /></td>
            <td>
              <div className="row-actions">
                <button type="button" className="action-button" title={t('viewProfile')} onClick={() => setProfileMember(member)}>
                  <UserRound size={17} />
                  <span>{t('viewProfile')}</span>
                </button>
                {member.canManage && (
                  <button type="button" className="action-button" title={t('edit')} onClick={() => setEditingMember(member)}>
                    <Pencil size={17} />
                    <span>{t('edit')}</span>
                  </button>
                )}
                {selectedSquad?.canManage && (
                  <button type="button" className="action-button" title={t('removeFromSquad')} onClick={() => removeMember(member)} disabled={isSquadActionBusy}>
                    <LogOut size={17} />
                    <span>{squadAction === `remove:${member.id}` ? t('saving') : t('removeFromSquad')}</span>
                  </button>
                )}
                {member.canManage && (
                  <button type="button" className="action-button danger" title={t('deleteMember')} onClick={() => setDeleteConfirmMember(member)} disabled={isSquadActionBusy}>
                    <Trash2 size={17} />
                    <span>{t('deleteMember')}</span>
                  </button>
                )}
              </div>
            </td>
          </tr>
        ))}
      </DataTable>
      <div ref={squadMemberListSentinelRef} className="member-list-load-more squad-member-load-more" aria-live="polite">
        {membersLoadingMore
          ? t('loadingMoreMembers')
          : memberPageMeta.hasMore
            ? t('scrollLoadMoreMembers')
            : (members.length ? t('allMembersLoaded') : '')}
      </div>

      {showPicker && (
        <MemberPicker
          title={t('availableMembers')}
          members={candidates}
          loading={isAddingMembers}
          t={t}
          setToast={setToast}
          onConfirm={addMembers}
          onClose={() => setShowPicker(false)}
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
            setEditingMember(member);
          }}
          onMemberUpdated={async () => {
            await loadSquads();
            await loadMembers(selectedId, { force: true });
          }}
          canSyncOnline={memberProfileCanSyncOnline(user)}
          onOpenRustKdaLookup={onOpenRustKdaLookup}
          onClose={() => setProfileMember(null)}
        />
      )}
      {editingMember && (
        <MemberEditor
          member={editingMember}
          squads={manageableSquads}
          t={t}
          onClose={() => setEditingMember(null)}
          onSaved={async () => {
            setEditingMember(null);
            setToast(t('memberUpdated'));
            await loadSquads();
            await loadMembers();
          }}
        />
      )}
      {leaderModal && (
        <LeaderSelectionModal
          title={leaderModal.mode === 'create' ? t('chooseLeaders') : t('leaderSelectionTitle')}
          users={users}
          selectedIds={leaderModal.selectedIds}
          t={t}
          onConfirm={confirmLeaders}
          onClose={() => setLeaderModal(null)}
        />
      )}
      {deleteConfirmMember && (
        <ModalFrame onClose={() => setDeleteConfirmMember(null)} labelledBy="squad-member-delete-title">
          <div className="modal-title">
            <div>
              <h3 id="squad-member-delete-title">{t('confirmDeleteMemberTitle')}</h3>
              <span className="modal-subtitle">{deleteConfirmMember.displayName || deleteConfirmMember.steamId || '-'}</span>
            </div>
            <button type="button" className="icon-button" onClick={() => setDeleteConfirmMember(null)} title={t('close')}>
              <X size={18} />
            </button>
          </div>
          <p className="modal-hint">
            {formatCopy(t('confirmDeleteMemberBody'), { name: deleteConfirmMember.displayName || deleteConfirmMember.steamId || '-' })}
          </p>
          <div className="modal-actions">
            <span />
            <button type="button" className="ghost-button" onClick={() => setDeleteConfirmMember(null)} disabled={isSquadActionBusy}>{t('cancel')}</button>
            <button type="button" className="action-button danger" onClick={() => deleteMember(deleteConfirmMember)} disabled={isSquadActionBusy}>
              <Trash2 size={18} />
              <span>{squadAction === `delete-member:${deleteConfirmMember.id}` ? t('saving') : t('confirm')}</span>
            </button>
          </div>
        </ModalFrame>
      )}
    </section>
  );
}
