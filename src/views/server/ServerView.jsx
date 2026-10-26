import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  CalendarClock,
  Clipboard,
  Download,
  ExternalLink,
  FileUp,
  ImagePlus,
  MapPinned,
  Minus,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Trash2,
  UserCheck,
  Users,
  X
} from 'lucide-react';
import { api } from '../../shared/api.js';
import { CUSTOM_SERVER_CHOICE } from '../../shared/app-constants.js';
import { copyText, fileToDataUrl } from '../../shared/browser.js';
import { isAbortError } from '../../shared/request-control.js';
import {
  browserTimeZone,
  datetimeLocalInputValue,
  datetimeLocalToIso,
  formatBrowserDateTimeWithYear,
  formatCopy,
  formatStatNumber,
  formatTime,
  localizeError
} from '../../shared/format.js';
import { ServerVipSummary } from '../../shared/member/profile-form.jsx';
import {
  MemberPicker,
  MemberProfileDialogStack
} from '../../shared/member/dialogs.jsx';
import { SpecialtyBadge } from '../../shared/member/specialty.jsx';
import {
  ParticipantStatusBadge,
  StatusBadge,
  normalizeParticipantStatus,
  participantSourceLabel
} from '../../shared/member/status.jsx';
import { MemberName } from '../../shared/member/MemberName.jsx';
import {
  DiscordPushCardModal,
  discordPushCardLanguage
} from '../../shared/bot/settings.jsx';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { ModalFrame } from '../../shared/ui/ModalFrame.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';
import { managedWipeOptionForForm } from '../../shared/wipes.js';

const MEMBER_LIST_PAGE_SIZE = 5;
const PARTICIPANT_EXPORT_PAGE_SIZE = 100;
const WIPE_ATTENDANCE_REFRESH_INTERVAL_MS = 15_000;

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

function participantSteamId(participant = {}) {
  return String(participant.member?.steamId || participant.steamId || '').trim();
}

function participantNickname(participant = {}) {
  return String(
    participant.member?.displayName ||
    participant.member?.customName ||
    participant.member?.steamNickname ||
    participant.member?.discordName ||
    participant.displayName ||
    participant.steamNickname ||
    participant.nickname ||
    ''
  ).trim();
}

function safeExportFileName(value = '') {
  return String(value || '')
    .trim()
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'wipe';
}

function emptyWipeForm() {
  return {
    name: '',
    serverName: '',
    startedAt: '',
    directConnect: '',
    vipUrl: '',
    mapLink: '',
    rustMapsLink: '',
    serverPresetId: '',
    serverVipProvider: '',
    kdaProvider: 'manual',
    vitalServerId: '',
    battlemetricsId: '',
    vitalWipeId: '',
    wipeMode: 'current',
    wipeLabel: '',
    nextWipeAt: '',
    kdaUrl: '',
    notes: ''
  };
}


function isRustMapsPreviewAsset(item = {}, wipe = {}) {
  const name = String(item.originalName || '').toLowerCase();
  return Boolean(
    item.kind === 'map_image' &&
    (
      (wipe.rustMapsImageUrl && item.url === wipe.rustMapsImageUrl) ||
      name.includes('rustmaps')
    )
  );
}

function MapPreviewModal({ imageUrl, rustMapsUrl = '', t, onClose }) {
  const [zoom, setZoom] = useState(1);
  const zoomPercent = Math.round(zoom * 100);

  function changeZoom(delta) {
    setZoom((current) => Math.min(3, Math.max(0.5, Math.round((current + delta) * 100) / 100)));
  }

  return (
    <ModalFrame className="map-preview-modal" labelledBy="map-preview-title" onClose={onClose}>
      <div className="modal-title map-preview-titlebar">
        <div>
          <h3 id="map-preview-title">{t('mapPreview')}</h3>
          <span className="modal-subtitle">{zoomPercent}%</span>
        </div>
        <div className="map-preview-controls">
          <button type="button" className="action-button" onClick={() => changeZoom(-0.25)} disabled={zoom <= 0.5} title={t('zoomOut')}>
            <Minus size={16} />
            <span>{t('zoomOut')}</span>
          </button>
          <button type="button" className="action-button" onClick={() => changeZoom(0.25)} disabled={zoom >= 3} title={t('zoomIn')}>
            <Plus size={16} />
            <span>{t('zoomIn')}</span>
          </button>
          <button type="button" className="action-button" onClick={() => setZoom(1)} title={t('resetZoom')}>
            <RotateCcw size={16} />
            <span>{t('resetZoom')}</span>
          </button>
          {rustMapsUrl && (
            <a className="action-button" href={rustMapsUrl} target="_blank" rel="noreferrer" title={t('rustMapsLink')}>
              <ExternalLink size={16} />
              <span>{t('rustMapsShort')}</span>
            </a>
          )}
          <button type="button" className="icon-button" onClick={onClose} title={t('close')}>
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="map-preview-viewport">
        <img
          className="map-preview-image"
          src={imageUrl}
          alt={t('mapPreview')}
          style={{ width: `${zoomPercent}%` }}
        />
      </div>
    </ModalFrame>
  );
}

export default function ServerView({ user, setToast, lang, t, onOpenRustKdaLookup = null }) {
  const [wipe, setWipe] = useState(null);
  const [participants, setParticipants] = useState([]);
  const [participantMeta, setParticipantMeta] = useState({ total: 0, offset: 0, limit: MEMBER_LIST_PAGE_SIZE, hasMore: false });
  const [participantSummary, setParticipantSummary] = useState(null);
  const [myParticipant, setMyParticipant] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [serverOptions, setServerOptions] = useState([]);
  const [showPicker, setShowPicker] = useState(false);
  const [participantPickerLoading, setParticipantPickerLoading] = useState(false);
  const [participantPickerError, setParticipantPickerError] = useState('');
  const [participantMutationLoading, setParticipantMutationLoading] = useState(false);
  const [profileMember, setProfileMember] = useState(null);
  const [form, setForm] = useState(emptyWipeForm());
  const [serverChoice, setServerChoice] = useState('');
  const [error, setError] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);
  const [participantListLoading, setParticipantListLoading] = useState(false);
  const [participantListLoadingMore, setParticipantListLoadingMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pushingDiscord, setPushingDiscord] = useState(false);
  const [discordPushModal, setDiscordPushModal] = useState(null);
  const [mapPreviewOpen, setMapPreviewOpen] = useState(false);
  const [signupLoading, setSignupLoading] = useState('');
  const [exportingParticipants, setExportingParticipants] = useState(false);
  const [participantExportIncludeNickname, setParticipantExportIncludeNickname] = useState(false);
  const isAdmin = user.role === 'admin';
  const isMemberRole = user.role === 'member';
  const canManageParticipants = user.role === 'admin' || user.role === 'leader';
  const canUseSelfSignup = Boolean(isMemberRole && user.boundSteamId && wipe?.status !== 'closed');
  const wipeFormDisabled = !isAdmin || saving || wipe?.status === 'closed';
  const clientTimeZone = browserTimeZone();
  const participantListSentinelRef = useRef(null);
  const participantRefreshInFlightRef = useRef(false);
  const participantLoadMoreInFlightRef = useRef(false);
  const signupActiveRef = useRef(true);
  const signupRequestAbortRef = useRef(null);
  const signupQueueRef = useRef({ running: false, pending: null, sequence: 0 });
  const wipeServerHydrationRef = useRef('');
  const selectedServer = serverOptions.find((server) => server.serverPresetId === serverChoice) ||
    serverOptions.find((server) => server.vitalServerId && server.vitalServerId === form.vitalServerId) ||
    null;
  const usingCustomServerName = serverChoice === CUSTOM_SERVER_CHOICE || (!selectedServer && Boolean(form.serverName));
  const wipeOptions = selectedServer?.wipeOptions || [];
  const directConnectText = form.directConnect || wipe?.directConnect || '';
  const mapDownloadUrl = wipe?.mapLink || form.mapLink || '';
  const rustMapsUrl = wipe?.rustMapsLink || form.rustMapsLink || '';
  const mapFiles = wipe?.mapFiles || [];
  const rustMapsPreviewAsset = mapFiles.find((item) => isRustMapsPreviewAsset(item, wipe)) || null;
  const rustMapsPreviewImageUrl = wipe?.rustMapsImageUrl || rustMapsPreviewAsset?.url || '';
  const visibleMapFiles = mapFiles.filter((item) => !isRustMapsPreviewAsset(item, wipe));
  const participantStatusCounts = useMemo(() => (
    participantSummary ? {
      total: Math.max(0, Number(participantSummary.total || 0) || 0),
      onTime: Math.max(0, Number(participantSummary.onTime || 0) || 0),
      join8h: Math.max(0, Number(participantSummary.join8h || participantSummary.join_8h || 0) || 0),
      join16h: Math.max(0, Number(participantSummary.join16h || participantSummary.join_16h || 0) || 0),
      notAttending: Math.max(0, Number(participantSummary.notAttending || participantSummary.not_attending || 0) || 0),
      vip: Math.max(0, Number(participantSummary.vip || 0) || 0),
      priority: Math.max(0, Number(participantSummary.priority || 0) || 0),
      queueSkip: Math.max(0, Number(participantSummary.queueSkip || 0) || 0)
    } : participants.reduce((counts, participant) => {
      const status = normalizeParticipantStatus(participant.status);
      counts.total += 1;
      if (status === 'join_8h') {
        counts.join8h += 1;
      } else if (status === 'join_16h') {
        counts.join16h += 1;
      } else if (status === 'not_attending') {
        counts.notAttending += 1;
      } else {
        counts.onTime += 1;
      }
      if (status !== 'not_attending') {
        const vip = participant.currentServerVip ||
          participant.serverVip ||
          participant.member?.currentServerVip ||
          participant.member?.serverVip ||
          participant.vitalVip ||
          participant.member?.vitalVip ||
          {};
        const vipType = vip.active === false ? 'none' : (participant.currentServerVipType || vip.type || participant.vitalVipType || participant.member?.vitalVipType || 'none');
        if (vipType === 'priority') {
          counts.vip += 1;
          counts.priority += 1;
        } else if (vipType === 'queue_skip') {
          counts.vip += 1;
          counts.queueSkip += 1;
        }
      }
      return counts;
    }, { total: 0, onTime: 0, join8h: 0, join16h: 0, notAttending: 0, vip: 0, priority: 0, queueSkip: 0 })
  ), [participantSummary, participants]);
  const participantTotalCount = Math.max(
    Number(participantStatusCounts.total || 0),
    Number(participantMeta.total || 0),
    participants.length
  );
  const participantPrioritySupported = participantSummary?.prioritySupported ?? wipe?.serverVip?.supportsPriority ?? true;
  const canLoadMoreParticipants = Boolean(participantMeta?.hasMore) && !participantListLoading && !participantListLoadingMore;
  const canExportParticipants = Boolean(wipe) && !exportingParticipants && !participantListLoading && participantTotalCount > 0;
  const participantSquadSummary = useMemo(() => {
    if (Array.isArray(participantSummary?.squads)) {
      const rows = participantSummary.squads.map((item) => ({
        id: item.id || item.name || '',
        name: item.name || t('unassignedSquad'),
        count: Math.max(0, Number(item.count || 0) || 0)
      }));
      const visible = rows.slice(0, 4);
      const hidden = rows.slice(4);
      return {
        rows,
        visible,
        hiddenSquads: hidden.length,
        hiddenCount: hidden.reduce((sum, item) => sum + item.count, 0),
        title: rows.map((item) => `${item.name}: ${formatStatNumber(item.count, lang)}`).join(' · ')
      };
    }
    const rowsBySquad = new Map();
    for (const participant of participants) {
      if (normalizeParticipantStatus(participant.status) !== 'on_time') continue;
      const name = participant.squadName || t('unassignedSquad');
      const key = participant.squadId || `unassigned:${name}`;
      const row = rowsBySquad.get(key) || { id: key, name, count: 0 };
      row.count += 1;
      rowsBySquad.set(key, row);
    }
    const rows = [...rowsBySquad.values()]
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
    const visible = rows.slice(0, 4);
    const hidden = rows.slice(4);
    return {
      rows,
      visible,
      hiddenSquads: hidden.length,
      hiddenCount: hidden.reduce((sum, item) => sum + item.count, 0),
      title: rows.map((item) => `${item.name}: ${formatStatNumber(item.count, lang)}`).join(' · ')
    };
  }, [participantSummary, participants, lang, t]);

  function applyParticipantPayload(payload = {}, { append = false } = {}) {
    const pageParticipants = payload.participants || [];
    let nextParticipants = pageParticipants;
    setParticipants((current) => {
      nextParticipants = append ? mergeMemberPages(current, pageParticipants) : pageParticipants;
      return nextParticipants;
    });
    setParticipantMeta({
      total: Math.max(0, Number(payload.total ?? nextParticipants.length) || 0),
      offset: Math.max(0, Number(payload.offset || 0) || 0),
      limit: Math.max(0, Number(payload.limit || MEMBER_LIST_PAGE_SIZE) || 0),
      hasMore: Boolean(payload.hasMore)
    });
    setParticipantSummary(payload.summary || null);
    setMyParticipant(payload.myParticipant || null);
    return nextParticipants;
  }

  const loadParticipantsPage = useCallback(async (targetWipeId, { append = false, offset = 0, loadingMore = false, silent = false, limit = MEMBER_LIST_PAGE_SIZE, signal } = {}) => {
    if (!targetWipeId) {
      setParticipants([]);
      setParticipantMeta({ total: 0, offset: 0, limit: MEMBER_LIST_PAGE_SIZE, hasMore: false });
      setParticipantSummary(null);
      setMyParticipant(null);
      return [];
    }
    if (!silent) {
      if (loadingMore) setParticipantListLoadingMore(true);
      else setParticipantListLoading(true);
    }
    try {
      const params = new URLSearchParams({
        limit: String(Math.max(1, Number(limit) || MEMBER_LIST_PAGE_SIZE)),
        offset: String(Math.max(0, Number(offset) || 0))
      });
      const payload = await api(`/api/wipes/${targetWipeId}/participants?${params}`, { signal });
      return applyParticipantPayload(payload, { append });
    } finally {
      if (!silent) {
        if (loadingMore) setParticipantListLoadingMore(false);
        else setParticipantListLoading(false);
      }
    }
  }, []);

  function buildKdaUrl(vitalServerId, vitalWipeId) {
    if (!vitalServerId || !vitalWipeId) return '';
    const params = new URLSearchParams({
      view: 'dataLookup',
      tab: 'vital',
      vitalServerId: String(vitalServerId),
      vitalWipeId: String(vitalWipeId)
    });
    return `/?${params}`;
  }

  function applyServerSelection(server, option, baseForm = form) {
    if (!server) return baseForm;
    const selectedOption = option || managedWipeOptionForForm(server.wipeOptions, baseForm) || server.wipeOptions?.[0] || {};
    const nextWipeAt = datetimeLocalInputValue(server.nextWipeAt || baseForm.nextWipeAt || '');
    return {
      ...baseForm,
      serverName: server.name,
      serverPresetId: server.serverPresetId || server.id || '',
      serverVipProvider: server.serverVipProvider || server.provider || '',
      kdaProvider: server.kdaProvider || (server.vitalServerId ? 'vital' : 'manual'),
      vitalServerId: server.vitalServerId || '',
      battlemetricsId: server.battlemetricsId || '',
      vitalWipeId: selectedOption.vitalWipeId || '',
      wipeMode: selectedOption.type || 'current',
      wipeLabel: selectedOption.label || '',
      startedAt: datetimeLocalInputValue(selectedOption.startedAt || baseForm.startedAt || ''),
      nextWipeAt,
      directConnect: server.directConnect || baseForm.directConnect || '',
      vipUrl: server.vipUrl || baseForm.vipUrl || '',
      kdaUrl: selectedOption.kdaUrl || buildKdaUrl(server.vitalServerId, selectedOption.vitalWipeId || ''),
      mapLink: Object.hasOwn(selectedOption, 'mapLink') ? selectedOption.mapLink : (baseForm.mapLink || ''),
      rustMapsLink: Object.hasOwn(selectedOption, 'rustMapsLink') ? selectedOption.rustMapsLink : (server.rustMapsLink || baseForm.rustMapsLink || '')
    };
  }

  function repairManagedWipeSelection(server, option, baseForm = form) {
    if (!server || !option) return baseForm;
    const vitalWipeId = option.vitalWipeId || '';
    return {
      ...baseForm,
      vitalWipeId,
      wipeMode: option.type || 'current',
      wipeLabel: option.label || '',
      startedAt: baseForm.startedAt || datetimeLocalInputValue(option.startedAt || ''),
      nextWipeAt: datetimeLocalInputValue(server.nextWipeAt || baseForm.nextWipeAt || ''),
      kdaUrl: option.kdaUrl || buildKdaUrl(server.vitalServerId, vitalWipeId)
    };
  }

  function applyCustomServerSelection(baseForm = form, previousServer = selectedServer) {
    const next = {
      ...baseForm,
      serverPresetId: '',
      serverVipProvider: '',
      kdaProvider: 'manual',
      vitalServerId: '',
      battlemetricsId: '',
      vitalWipeId: '',
      wipeMode: 'current',
      wipeLabel: '',
      kdaUrl: ''
    };
    if (previousServer) {
      if (next.serverName === previousServer.name) next.serverName = '';
      if (next.directConnect === previousServer.directConnect) next.directConnect = '';
      if (next.vipUrl === previousServer.vipUrl) next.vipUrl = '';
      if (next.mapLink === previousServer.mapLink) next.mapLink = '';
      if (next.rustMapsLink === previousServer.rustMapsLink) next.rustMapsLink = '';
    }
    return next;
  }

  function wipeOptionLabel(option) {
    const label = option.type === 'next' ? t('nextWipeChoice') : t('currentWipeChoice');
    const time = option.startedAt ? formatBrowserDateTimeWithYear(option.startedAt, lang) : '';
    return [label, time].filter(Boolean).join(' · ');
  }

  async function load() {
    const payload = await api('/api/wipes/current');
    setWipe(payload.wipe);
    if (payload.wipe) {
      setServerChoice(payload.wipe.serverPresetId || payload.wipe.vitalServerId || CUSTOM_SERVER_CHOICE);
      setForm({
        name: payload.wipe.name || '',
        serverName: payload.wipe.serverName || '',
        startedAt: datetimeLocalInputValue(payload.wipe.startedAt || ''),
        directConnect: payload.wipe.directConnect || '',
        vipUrl: payload.wipe.vipUrl || '',
        serverPresetId: payload.wipe.serverPresetId || '',
        serverVipProvider: payload.wipe.serverVipProvider || payload.wipe.vipProvider || '',
        kdaProvider: payload.wipe.kdaProvider || (payload.wipe.vitalServerId ? 'vital' : 'manual'),
        vitalServerId: payload.wipe.vitalServerId || '',
        battlemetricsId: payload.wipe.battlemetricsId || '',
        vitalWipeId: payload.wipe.vitalWipeId || '',
        wipeMode: payload.wipe.wipeMode || 'current',
        wipeLabel: payload.wipe.wipeLabel || '',
        nextWipeAt: datetimeLocalInputValue(payload.wipe.nextWipeAt || ''),
        kdaUrl: payload.wipe.kdaUrl || '',
        mapLink: payload.wipe.mapLink || '',
        rustMapsLink: payload.wipe.rustMapsLink || '',
        notes: payload.wipe.notes || ''
      });
      await loadParticipantsPage(payload.wipe.id, { append: false, offset: 0 });
    } else {
      setServerChoice('');
      setParticipants([]);
      setParticipantMeta({ total: 0, offset: 0, limit: MEMBER_LIST_PAGE_SIZE, hasMore: false });
      setParticipantSummary(null);
      setMyParticipant(null);
    }
  }

  async function loadServerOptions() {
    const payload = await api('/api/wipe-server-options');
    setServerOptions(payload.servers || []);
  }

  useEffect(() => {
    signupActiveRef.current = true;
    return () => {
      signupActiveRef.current = false;
      signupQueueRef.current.pending = null;
      signupRequestAbortRef.current?.abort();
      signupRequestAbortRef.current = null;
    };
  }, []);

  useEffect(() => {
    setInitialLoading(true);
    setError('');
    Promise.all([
      load(),
      loadServerOptions().catch(() => {})
    ])
      .catch((err) => setError(localizeError(err.message, t)))
      .finally(() => setInitialLoading(false));
  }, []);

  useEffect(() => {
    if (wipe || serverChoice || !serverOptions.length) return;
    const firstServer = serverOptions[0];
    setServerChoice(firstServer.serverPresetId || firstServer.id);
    setForm((current) => applyServerSelection(
      firstServer,
      managedWipeOptionForForm(firstServer.wipeOptions, { ...current, wipeMode: 'next' }),
      current
    ));
  }, [serverOptions.length, wipe, serverChoice]);

  useEffect(() => {
    if (!wipe?.id || !serverOptions.length || !serverChoice || serverChoice === CUSTOM_SERVER_CHOICE) return;
    const server = serverOptions.find((item) => item.serverPresetId === serverChoice) ||
      serverOptions.find((item) => item.vitalServerId && item.vitalServerId === form.vitalServerId);
    if (!server) return;
    const hydrationKey = `${wipe.id}:${server.serverPresetId || server.id || server.vitalServerId || ''}`;
    if (wipeServerHydrationRef.current === hydrationKey) return;
    wipeServerHydrationRef.current = hydrationKey;
    const option = managedWipeOptionForForm(server.wipeOptions, {
      wipeMode: wipe.wipeMode,
      startedAt: wipe.startedAt
    });
    const shouldRepairWipeMode = Boolean(option?.type && option.type !== wipe.wipeMode);
    setForm((current) => {
      const repaired = shouldRepairWipeMode
        ? repairManagedWipeSelection(server, option, current)
        : current;
      return {
        ...repaired,
        directConnect: repaired.directConnect || server.directConnect || '',
        vipUrl: repaired.vipUrl || server.vipUrl || ''
      };
    });
  }, [serverOptions.length, serverChoice, form.vitalServerId, wipe?.id, wipe?.wipeMode, wipe?.startedAt]);

  useEffect(() => {
    if (!rustMapsPreviewImageUrl) setMapPreviewOpen(false);
  }, [rustMapsPreviewImageUrl]);

  const refreshParticipantsSilently = useCallback(async () => {
    if (!wipe?.id || wipe.status === 'closed') return;
    if (
      participantRefreshInFlightRef.current ||
      participantListLoading ||
      participantListLoadingMore ||
      participantPickerLoading ||
      participantMutationLoading ||
      showPicker
    ) return;
    participantRefreshInFlightRef.current = true;
    try {
      await loadParticipantsPage(wipe.id, {
        append: false,
        offset: 0,
        silent: true,
        limit: Math.max(MEMBER_LIST_PAGE_SIZE, participants.length, participantMeta.limit || 0)
      });
    } finally {
      participantRefreshInFlightRef.current = false;
    }
  }, [loadParticipantsPage, participantListLoading, participantListLoadingMore, participantMeta.limit, participantMutationLoading, participantPickerLoading, participants.length, showPicker, wipe?.id, wipe?.status]);

  useEffect(() => {
    if (!wipe?.id || wipe.status === 'closed') return undefined;
    const timer = window.setInterval(() => {
      refreshParticipantsSilently().catch(() => {});
    }, WIPE_ATTENDANCE_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshParticipantsSilently, wipe?.id, wipe?.status]);

  const loadMoreParticipants = useCallback(async () => {
    if (!wipe?.id || !canLoadMoreParticipants || participantLoadMoreInFlightRef.current) return;
    participantLoadMoreInFlightRef.current = true;
    try {
      await loadParticipantsPage(wipe.id, {
        append: true,
        offset: participants.length,
        loadingMore: true
      });
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      participantLoadMoreInFlightRef.current = false;
    }
  }, [canLoadMoreParticipants, loadParticipantsPage, participants.length, t, wipe?.id]);

  useEffect(() => {
    const node = participantListSentinelRef.current;
    if (!node || !canLoadMoreParticipants) return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        loadMoreParticipants().catch(() => {});
      }
    }, { rootMargin: '240px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [canLoadMoreParticipants, loadMoreParticipants]);

  useEffect(() => {
    if (!canLoadMoreParticipants) return undefined;
    let frame = 0;
    const checkNearBottom = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const node = participantListSentinelRef.current;
        if (!node) return;
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const rect = node.getBoundingClientRect();
        if (rect.top <= viewportHeight + 260) {
          loadMoreParticipants().catch(() => {});
        }
      });
    };
    const listenerOptions = { passive: true, capture: true };
    window.addEventListener('scroll', checkNearBottom, listenerOptions);
    document.addEventListener('scroll', checkNearBottom, listenerOptions);
    window.addEventListener('resize', checkNearBottom);
    checkNearBottom();
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', checkNearBottom, listenerOptions);
      document.removeEventListener('scroll', checkNearBottom, listenerOptions);
      window.removeEventListener('resize', checkNearBottom);
    };
  }, [canLoadMoreParticipants, loadMoreParticipants]);

  async function loadParticipantsForExport() {
    if (!wipe?.id) return [];
    if (!participantMeta?.hasMore && participants.length >= participantTotalCount) {
      return participants;
    }

    let allParticipants = [];
    let nextOffset = 0;
    let total = Math.max(participantTotalCount, participants.length);
    let hasMore = true;
    let lastPayload = null;

    while (hasMore) {
      const params = new URLSearchParams({
        limit: String(PARTICIPANT_EXPORT_PAGE_SIZE),
        offset: String(nextOffset)
      });
      const payload = await api(`/api/wipes/${wipe.id}/participants?${params}`);
      const pageParticipants = payload.participants || [];
      allParticipants = mergeMemberPages(allParticipants, pageParticipants);
      total = Math.max(total, Number(payload.total || 0) || 0, allParticipants.length);
      nextOffset += pageParticipants.length;
      lastPayload = payload;
      hasMore = Boolean(payload.hasMore) && pageParticipants.length > 0 && nextOffset < total;
    }

    if (lastPayload) {
      applyParticipantPayload({
        ...lastPayload,
        participants: allParticipants,
        total,
        offset: 0,
        limit: Math.max(PARTICIPANT_EXPORT_PAGE_SIZE, allParticipants.length),
        hasMore: false
      }, { append: false });
    }
    return allParticipants;
  }

  async function exportParticipants() {
    if (!wipe || exportingParticipants) return;
    setError('');
    setExportingParticipants(true);
    try {
      const exportRows = (await loadParticipantsForExport())
        .map((participant) => ({
          steamId: participantSteamId(participant),
          nickname: participantNickname(participant)
        }))
        .filter((row) => row.steamId);
      if (!exportRows.length) {
        setToast(t('participantExportNoParticipants'));
        return;
      }
      const serverName = safeExportFileName(wipe.serverName || form.serverName || wipe.name || 'current-server');
      const datePart = safeExportFileName((wipe.startedAt || new Date().toISOString()).slice(0, 10));
      if (participantExportIncludeNickname) {
        const lines = exportRows.map((row) => [row.steamId, row.nickname].map(csvCell).join(',')).join('\r\n');
        downloadTextFile(`${serverName}-participants-${datePart}.csv`, `${lines}\r\n`, 'text/csv;charset=utf-8');
      } else {
        const lines = exportRows.map((row) => row.steamId).join('\r\n');
        downloadTextFile(`${serverName}-participants-${datePart}.txt`, `${lines}\r\n`);
      }
      setToast(formatCopy(t('participantExportDone'), { count: exportRows.length }));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setExportingParticipants(false);
    }
  }

  async function save(event) {
    event.preventDefault();
    if (saving) return;
    setError('');
    setSaving(true);
    setToast(t('saving'));
    try {
      const body = {
        ...form,
        name: '',
        startedAt: datetimeLocalToIso(form.startedAt),
        nextWipeAt: datetimeLocalToIso(form.nextWipeAt),
        timeZone: clientTimeZone
      };
      const payload = wipe
        ? await api(`/api/wipes/${wipe.id}`, { method: 'PUT', body })
        : await api('/api/wipes', { method: 'POST', body });
      setWipe(payload.wipe);
      setToast(wipe ? t('wipeSaved') : t('wipeCreated'));
      await load();
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  async function openParticipantPicker() {
    if (!wipe || !canManageParticipants || participantPickerLoading) return;
    setParticipantPickerError('');
    setShowPicker(true);
    setParticipantPickerLoading(true);
    try {
      const payload = await api(`/api/wipes/${wipe.id}/participant-candidates`);
      setCandidates(payload.members || []);
    } catch (err) {
      setParticipantPickerError(localizeError(err.message, t));
    } finally {
      setParticipantPickerLoading(false);
    }
  }

  async function addParticipants(memberIds) {
    if (!canManageParticipants) return;
    setParticipantMutationLoading(true);
    try {
      const responseLimit = Math.max(MEMBER_LIST_PAGE_SIZE, participants.length + memberIds.length, participantMeta.limit || 0);
      const payload = await api(`/api/wipes/${wipe.id}/participants`, {
        method: 'POST',
        body: { memberIds, responseLimit, responseOffset: 0 }
      });
      applyParticipantPayload(payload, { append: false });
      setCandidates((current) => current.filter((member) => !memberIds.includes(member.id)));
      setShowPicker(false);
      setToast(t('participantAdded'));
    } finally {
      setParticipantMutationLoading(false);
    }
  }

  async function removeParticipant(participant) {
    if (!canManageParticipants) return;
    await api(`/api/wipes/${wipe.id}/participants/${participant.memberId}`, { method: 'DELETE' });
    setToast(t('participantRemoved'));
    await load();
  }

  async function updateParticipantStatus(participant, status) {
    if (!canManageParticipants) return;
    try {
      await api(`/api/wipes/${wipe.id}/participants/${participant.memberId}`, { method: 'PUT', body: { status } });
      setToast(t('participantUpdated'));
      await load();
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function drainSignupQueue() {
    const queue = signupQueueRef.current;
    if (queue.running) return;
    queue.running = true;
    let finalOutcome = null;

    try {
      while (signupActiveRef.current) {
        while (queue.pending && signupActiveRef.current) {
          const task = queue.pending;
          queue.pending = null;
          const controller = new AbortController();
          signupRequestAbortRef.current = controller;
          try {
            await api(`/api/wipes/${task.wipeId}/my-signup`, {
              method: 'POST',
              body: { status: task.status },
              signal: controller.signal
            });
            finalOutcome = { task, error: null };
          } catch (error) {
            if (!isAbortError(error)) finalOutcome = { task, error };
          } finally {
            if (signupRequestAbortRef.current === controller) signupRequestAbortRef.current = null;
          }
        }

        if (!signupActiveRef.current || !finalOutcome) break;
        if (queue.pending) continue;
        if (!finalOutcome.error) {
          const controller = new AbortController();
          signupRequestAbortRef.current = controller;
          try {
            await loadParticipantsPage(finalOutcome.task.wipeId, {
              append: false,
              offset: 0,
              signal: controller.signal
            });
          } catch (error) {
            if (!isAbortError(error)) finalOutcome = { ...finalOutcome, error };
          } finally {
            if (signupRequestAbortRef.current === controller) signupRequestAbortRef.current = null;
          }
        }
        if (queue.pending) continue;
        if (!signupActiveRef.current) break;
        if (finalOutcome.error) setError(localizeError(finalOutcome.error.message, t));
        else setToast(t('signupSaved'));
        break;
      }
    } finally {
      queue.running = false;
      if (signupActiveRef.current) {
        if (queue.pending) drainSignupQueue().catch(() => {});
        else setSignupLoading('');
      }
    }
  }

  function updateMySignup(status) {
    if (!wipe || !canUseSelfSignup) return;
    const queue = signupQueueRef.current;
    queue.pending = {
      sequence: ++queue.sequence,
      status,
      wipeId: wipe.id
    };
    setError('');
    setSignupLoading(status);
    drainSignupQueue().catch(() => {});
  }

  async function closeWipe() {
    if (!wipe || !window.confirm(t('closeWipe'))) return;
    const payload = await api(`/api/wipes/${wipe.id}/close`, { method: 'POST' });
    setWipe(payload.wipe);
    setToast(t('wipeClosed'));
    await load();
  }

  function discordAttendancePushBody(language = '', mentionEveryone = true) {
    return {
      ...form,
      name: '',
      startedAt: datetimeLocalToIso(form.startedAt),
      nextWipeAt: datetimeLocalToIso(form.nextWipeAt),
      timeZone: clientTimeZone,
      language: discordPushCardLanguage(language),
      mentionEveryone
    };
  }

  async function loadDiscordAttendancePreview(language, mentionEveryone = true) {
    const nextLanguage = discordPushCardLanguage(language);
    setDiscordPushModal((current) => current ? { ...current, language: nextLanguage, mentionEveryone, loading: true, error: '' } : current);
    try {
      const payload = await api('/api/wipes/current/discord-attendance/preview', {
        method: 'POST',
        body: discordAttendancePushBody(nextLanguage, mentionEveryone)
      });
      setDiscordPushModal((current) => current ? {
        ...current,
        language: discordPushCardLanguage(payload.language || nextLanguage),
        mentionEveryone,
        preview: payload.preview || null,
        loading: false,
        error: ''
      } : current);
    } catch (err) {
      setDiscordPushModal((current) => current ? { ...current, loading: false, error: localizeError(err.message, t) } : current);
    }
  }

  function openDiscordAttendancePreview() {
    if (pushingDiscord) return;
    const language = discordPushCardLanguage(lang);
    setError('');
    setDiscordPushModal({
      type: 'wipe',
      language,
      mentionEveryone: true,
      preview: null,
      loading: true,
      pushing: false,
      error: ''
    });
    loadDiscordAttendancePreview(language, true).catch(() => {});
  }

  async function pushDiscordAttendance(language = 'en', mentionEveryone = true) {
    if (pushingDiscord) return;
    setError('');
    setPushingDiscord(true);
    setDiscordPushModal((current) => current ? { ...current, pushing: true, error: '' } : current);
    try {
      const payload = await api('/api/wipes/current/discord-attendance', {
        method: 'POST',
        body: discordAttendancePushBody(language, mentionEveryone)
      });
      if (payload.wipe) setWipe(payload.wipe);
      const url = payload.message?.url || '';
      setDiscordPushModal(null);
      setToast(url ? t('discordAttendancePushedWithLink') : t('discordAttendancePushed'));
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
      await load();
    } catch (err) {
      const message = localizeError(err.message, t);
      setError(message);
      setDiscordPushModal((current) => current ? { ...current, error: message } : current);
    } finally {
      setPushingDiscord(false);
      setDiscordPushModal((current) => current ? { ...current, pushing: false } : current);
    }
  }

  async function uploadScreenshot(event) {
    const file = event.target.files?.[0];
    if (!file || !wipe) return;
    const dataUrl = await fileToDataUrl(file);
    await api(`/api/wipes/${wipe.id}/screenshots`, {
      method: 'POST',
      body: { originalName: file.name, mimeType: file.type, dataUrl }
    });
    setToast(t('uploadScreenshot'));
    await load();
  }

  async function uploadMapAsset(event, kind) {
    const file = event.target.files?.[0];
    if (!file || !wipe) return;
    const dataUrl = await fileToDataUrl(file);
    await api(`/api/wipes/${wipe.id}/map-files`, {
      method: 'POST',
      body: { originalName: file.name, mimeType: file.type || 'application/octet-stream', kind, dataUrl }
    });
    setToast(kind === 'map_image' ? t('uploadMapImage') : t('uploadMapFile'));
    event.target.value = '';
    await load();
  }

  async function deleteScreenshot(item) {
    if (!wipe || !window.confirm(t('deleteScreenshot'))) return;
    try {
      const payload = await api(`/api/wipes/${wipe.id}/screenshots/${item.id}`, { method: 'DELETE' });
      setWipe(payload.wipe);
      setToast(t('screenshotDeleted'));
      await load();
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  async function deleteMapAsset(item) {
    if (!wipe || !window.confirm(t('deleteMapAsset'))) return;
    try {
      const payload = await api(`/api/wipes/${wipe.id}/map-files/${item.id}`, { method: 'DELETE' });
      setWipe(payload.wipe);
      setToast(t('deleteMapAsset'));
      await load();
    } catch (err) {
      setError(localizeError(err.message, t));
    }
  }

  if (initialLoading) {
    return (
      <section className="page-stack">
        <PageLoadingState title={t('serverWipeInfo')} t={t} />
      </section>
    );
  }

  return (
    <section className="page-stack">
      {error && <Alert tone="danger">{error}</Alert>}
      {!wipe && !isAdmin ? <div className="empty-state">{t('noCurrentWipe')}</div> : null}
      {(wipe || isAdmin) && (
        <form className="tool-panel member-form server-form" onSubmit={save}>
          <div className="section-heading span-2">
            <div className="heading-with-summary">
              <h3>{t('serverWipeInfo')}</h3>
              {wipe && <StatusBadge status={wipe.status} t={t} />}
            </div>
            {isAdmin && (
              <button type="button" className="primary-button discord-push-button wipe-card" onClick={openDiscordAttendancePreview} disabled={wipe?.status === 'closed' || saving || pushingDiscord} title={t('pushDiscord')}>
                <Send size={17} />
                <span>{pushingDiscord ? t('pushingDiscord') : t('pushDiscord')}</span>
              </button>
            )}
          </div>
          {serverOptions.length ? (
            <>
              <label>
                <span>{t('serverChoice')}</span>
                <select
                  value={selectedServer ? serverChoice : (serverChoice || CUSTOM_SERVER_CHOICE)}
                  onChange={(event) => {
                    const nextChoice = event.target.value;
                    if (nextChoice === CUSTOM_SERVER_CHOICE) {
                      setServerChoice(CUSTOM_SERVER_CHOICE);
                      setForm((current) => applyCustomServerSelection(current, selectedServer));
                      return;
                    }
                    const server = serverOptions.find((item) => item.serverPresetId === nextChoice);
                    setServerChoice(server?.serverPresetId || '');
                    setForm((current) => applyServerSelection(
                      server,
                      managedWipeOptionForForm(
                        server?.wipeOptions,
                        wipe
                          ? { wipeMode: wipe.wipeMode, startedAt: wipe.startedAt }
                          : { ...current, wipeMode: 'next' }
                      ),
                      current
                    ));
                  }}
                  disabled={wipeFormDisabled}
                  required
                >
                  {serverOptions.map((server) => <option key={server.serverPresetId || server.id} value={server.serverPresetId || server.id}>{server.name}</option>)}
                  <option value={CUSTOM_SERVER_CHOICE}>{t('customServerName')}</option>
                </select>
              </label>
              {usingCustomServerName && (
                <>
                  <label>
                    <span>{t('customServerName')}</span>
                    <input value={form.serverName} onChange={(event) => setForm({ ...form, serverName: event.target.value })} disabled={wipeFormDisabled} required />
                  </label>
                  <label>
                    <span>{t('battlemetricsServerId')}</span>
                    <input value={form.battlemetricsId} onChange={(event) => setForm({ ...form, battlemetricsId: event.target.value })} disabled={wipeFormDisabled} inputMode="numeric" />
                  </label>
                </>
              )}
            </>
          ) : (
            <label>
              <span>{t('serverName')}</span>
              <input value={form.serverName} onChange={(event) => setForm({ ...form, serverName: event.target.value })} disabled={wipeFormDisabled} required />
            </label>
          )}
          <label>
            <span>{t('wipe')}</span>
            <select
              value={form.wipeMode || 'current'}
              onChange={(event) => {
                const option = wipeOptions.find((item) => item.type === event.target.value);
                setForm((current) => applyServerSelection(selectedServer, option, current));
              }}
              disabled={wipeFormDisabled || !wipeOptions.length}
            >
              {wipeOptions.length ? wipeOptions.map((option) => (
                <option key={option.type} value={option.type}>{wipeOptionLabel(option)}</option>
              )) : <option value="current">{t('currentWipeChoice')}</option>}
            </select>
          </label>
          <label>
            <span>{t('wipeStartTime')}</span>
            <input
              type="datetime-local"
              value={form.startedAt}
              onChange={(event) => setForm({ ...form, startedAt: event.target.value })}
              disabled={wipeFormDisabled}
              required
            />
          </label>
          <label>
            <span>{t('nextWipeAt')}</span>
            <input
              type="datetime-local"
              value={form.nextWipeAt}
              onChange={(event) => setForm({ ...form, nextWipeAt: event.target.value })}
              disabled={wipeFormDisabled}
            />
          </label>
          <p className="form-hint span-2">{t('wipeTimeZoneHint')}</p>
          <label>
            <span>{t('directConnect')}</span>
            <input value={form.directConnect} onChange={(event) => setForm({ ...form, directConnect: event.target.value })} disabled={wipeFormDisabled} />
          </label>
          <label>
            <span>{t('vipUrl')}</span>
            <input value={form.vipUrl} onChange={(event) => setForm({ ...form, vipUrl: event.target.value })} disabled={wipeFormDisabled} />
          </label>
          <label>
            <span>{t('kdaUrl')}</span>
            <input value={form.kdaUrl} placeholder={t('noKdaLink')} readOnly disabled={wipeFormDisabled} />
          </label>
          <label>
            <span>{t('mapLink')}</span>
            <input value={form.mapLink} onChange={(event) => setForm({ ...form, mapLink: event.target.value })} disabled={wipeFormDisabled} />
          </label>
          <label>
            <span>{t('rustMapsLink')}</span>
            <input value={form.rustMapsLink} onChange={(event) => setForm({ ...form, rustMapsLink: event.target.value })} disabled={wipeFormDisabled} />
          </label>
          <label className="span-2">
            <span>{t('notes')}</span>
            <input value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} disabled={wipeFormDisabled} />
          </label>
          <div className="server-form-actions span-2">
            <div className="server-form-link-actions">
              {directConnectText && (
                <button type="button" className="ghost-button" title={t('copyDirectConnect')} onClick={() => copyText(directConnectText, setToast, t)}>
                  <Clipboard size={17} />
                  <span>{t('copyDirectConnectShort')}</span>
                </button>
              )}
              {mapDownloadUrl && (
                <a className="ghost-button" title={t('mapLink')} href={mapDownloadUrl} target="_blank" rel="noreferrer">
                  <Download size={17} />
                  <span>{t('mapLinkShort')}</span>
                </a>
              )}
              {rustMapsPreviewImageUrl && (
                <button type="button" className="ghost-button" title={t('mapPreview')} onClick={() => setMapPreviewOpen(true)}>
                  <MapPinned size={17} />
                  <span>{t('mapPreviewShort')}</span>
                </button>
              )}
              {rustMapsUrl && (
                <a className="ghost-button" title={t('rustMapsLink')} href={rustMapsUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={17} />
                  <span>{t('rustMapsShort')}</span>
                </a>
              )}
            </div>
            {isAdmin && (!wipe || wipe.status !== 'closed') && (
              <button className="primary-button align-end" title={wipe ? t('saveServer') : t('createWipe')} disabled={saving}>
                <Save size={18} />
                <span>{saving ? t('saving') : (wipe ? t('saveShort') : t('createShort'))}</span>
              </button>
            )}
          </div>
        </form>
      )}
      {visibleMapFiles.length ? (
        <div className="screenshot-grid asset-grid">
          {visibleMapFiles.map((item) => (
            <figure key={item.id} className="screenshot-card file-asset-card">
              {item.mimeType?.startsWith('image/') ? (
                <img src={item.url} alt="" />
              ) : (
                <a className="file-card" href={item.url} target="_blank" rel="noreferrer">
                  <FileUp size={26} />
                  <span>{item.originalName || t('mapFile')}</span>
                </a>
              )}
              <figcaption>
                <span>{item.originalName || t('mapAssets')}</span>
                {isAdmin && wipe.status !== 'closed' && (
                  <button className="action-button danger" title={t('deleteMapAsset')} onClick={() => deleteMapAsset(item)}>
                    <Trash2 size={16} />
                    <span>{t('delete')}</span>
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {wipe?.screenshots?.length ? (
        <div className="screenshot-grid">
          {wipe.screenshots.map((item) => (
            <figure key={item.id} className="screenshot-card">
              <img src={item.url} alt="" />
              <figcaption>
                <span>{item.originalName || t('screenshot')}</span>
                {isAdmin && wipe.status !== 'closed' && (
                  <button className="action-button danger" title={t('deleteScreenshot')} onClick={() => deleteScreenshot(item)}>
                    <Trash2 size={16} />
                    <span>{t('delete')}</span>
                  </button>
                )}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}

      {wipe && (
        <div className="section-heading participants-section-heading">
          <div className="heading-with-summary">
            <h3>{t('participants')}</h3>
            <div className="participant-overview">
              <div className="participant-status-summary">
                <span className="summary-chip-total">
                  <Users size={14} />
                  {formatCopy(t('participantTotalCount'), { count: formatStatNumber(participantTotalCount, lang) })}
                </span>
                <span>{formatCopy(t('participantOnTimeCount'), { count: formatStatNumber(participantStatusCounts.onTime, lang) })}</span>
                <span>{formatCopy(t('participantJoin8hCount'), { count: formatStatNumber(participantStatusCounts.join8h, lang) })}</span>
                <span>{formatCopy(t('participantJoin16hCount'), { count: formatStatNumber(participantStatusCounts.join16h, lang) })}</span>
                <span>{formatCopy(t('participantNotAttendingCount'), { count: formatStatNumber(participantStatusCounts.notAttending, lang) })}</span>
                <span className="vip-summary-chip queue-skip">{formatCopy(t('participantQueueSkipCount'), { count: formatStatNumber(participantStatusCounts.queueSkip, lang) })}</span>
                {participantPrioritySupported && <span className="vip-summary-chip priority">{formatCopy(t('participantPriorityCount'), { count: formatStatNumber(participantStatusCounts.priority, lang) })}</span>}
              </div>
              {participantSquadSummary.rows.length > 0 && (
                <div className="participant-squad-summary" title={participantSquadSummary.title}>
                  <span className="summary-label">{t('participantSquadBreakdown')}</span>
                  {participantSquadSummary.visible.map((item) => (
                    <span key={item.id} className="squad-count-chip">
                      <strong>{item.name}</strong>
                      <b>{formatStatNumber(item.count, lang)}</b>
                    </span>
                  ))}
                  {participantSquadSummary.hiddenCount > 0 && (
                    <span className="squad-count-chip muted">
                      {formatCopy(t('participantOtherSquadsCount'), {
                        squads: formatStatNumber(participantSquadSummary.hiddenSquads, lang),
                        count: formatStatNumber(participantSquadSummary.hiddenCount, lang)
                      })}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          <div className="row-actions toolbar-compact">
            <label className="ghost-button participant-export-option" title={t('participantExportIncludeNickname')}>
              <input
                type="checkbox"
                checked={participantExportIncludeNickname}
                onChange={(event) => setParticipantExportIncludeNickname(event.target.checked)}
              />
              <span>{t('participantExportIncludeNickname')}</span>
            </label>
            <button
              type="button"
              className={cx('ghost-button fit-button', exportingParticipants && 'loading-button')}
              title={t('participantExportPlayerList')}
              onClick={exportParticipants}
              disabled={!canExportParticipants}
            >
              {exportingParticipants ? <RefreshCw size={17} /> : <Download size={17} />}
              <span>{exportingParticipants ? t('loading') : t('participantExportPlayerList')}</span>
            </button>
            {form.vipUrl && <a className="ghost-button" title={t('vipUrl')} href={form.vipUrl} target="_blank" rel="noreferrer"><ExternalLink size={17} /><span>{t('vipShort')}</span></a>}
            {(wipe.mapLink || form.mapLink) && (
              <a className="ghost-button" title={t('mapLink')} href={wipe.mapLink || form.mapLink} target="_blank" rel="noreferrer">
                <Download size={17} />
                <span>{t('mapLinkShort')}</span>
              </a>
            )}
            {isAdmin && wipe.status !== 'closed' && (
              <label className="file-button ghost-button" title={t('uploadScreenshot')}>
                <ImagePlus size={17} />
                <span>{t('uploadScreenshotShort')}</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={uploadScreenshot} />
              </label>
            )}
            {isAdmin && wipe.status !== 'closed' && (
              <label className="file-button ghost-button" title={t('uploadMapImage')}>
                <MapPinned size={17} />
                <span>{t('uploadMapImageShort')}</span>
                <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => uploadMapAsset(event, 'map_image')} />
              </label>
            )}
            {isAdmin && wipe.status !== 'closed' && (
              <label className="file-button ghost-button" title={t('uploadMapFile')}>
                <FileUp size={17} />
                <span>{t('uploadMapFileShort')}</span>
                <input type="file" accept=".map,application/octet-stream" onChange={(event) => uploadMapAsset(event, 'map_file')} />
              </label>
            )}
            {canManageParticipants && wipe.status !== 'closed' && (
              <button className={cx('primary-button', participantPickerLoading && !showPicker && 'loading-button')} title={t('addParticipants')} onClick={openParticipantPicker} disabled={participantPickerLoading}>
                {participantPickerLoading && !showPicker ? <RefreshCw size={18} /> : <UserCheck size={18} />}
                <span>{participantPickerLoading && !showPicker ? t('loading') : t('addParticipantsShort')}</span>
              </button>
            )}
            {isAdmin && wipe.status === 'active' && (
              <button className="action-button danger" title={t('closeWipe')} onClick={closeWipe}>
                <Archive size={17} />
                <span>{t('closeWipe')}</span>
              </button>
            )}
          </div>
        </div>
      )}

      {wipe?.status === 'closed' && <Alert>{t('closedReadonly')}</Alert>}
      {wipe && isMemberRole && (
        <section className="tool-panel self-signup-panel">
          <div className="self-signup-copy">
            <span className="eyebrow">{t('mySignup')}</span>
            <strong>{myParticipant ? <ParticipantStatusBadge status={myParticipant.status} t={t} /> : t('signupNotSubmitted')}</strong>
          </div>
          <div className="self-signup-actions">
            <button
              type="button"
              className={cx('action-button', normalizeParticipantStatus(myParticipant?.status) === 'on_time' && 'active-choice')}
              disabled={!canUseSelfSignup || Boolean(signupLoading)}
              onClick={() => updateMySignup('on_time')}
            >
              <UserCheck size={17} />
              <span>{t('signupOnTime')}</span>
            </button>
            <button
              type="button"
              className={cx('action-button', normalizeParticipantStatus(myParticipant?.status) === 'join_8h' && 'active-choice')}
              disabled={!canUseSelfSignup || Boolean(signupLoading)}
              onClick={() => updateMySignup('join_8h')}
            >
              <CalendarClock size={17} />
              <span>{t('signupJoin8h')}</span>
            </button>
            <button
              type="button"
              className={cx('action-button', normalizeParticipantStatus(myParticipant?.status) === 'join_16h' && 'active-choice')}
              disabled={!canUseSelfSignup || Boolean(signupLoading)}
              onClick={() => updateMySignup('join_16h')}
            >
              <CalendarClock size={17} />
              <span>{t('signupJoin16h')}</span>
            </button>
            <button
              type="button"
              className={cx('action-button', normalizeParticipantStatus(myParticipant?.status) === 'not_attending' && 'active-choice')}
              disabled={!canUseSelfSignup || Boolean(signupLoading)}
              onClick={() => updateMySignup('not_attending')}
            >
              <Minus size={17} />
              <span>{t('signupNotAttending')}</span>
            </button>
          </div>
        </section>
      )}
      {wipe && (
        <>
          {participantListLoading && !participants.length ? (
            <PageLoadingState title={t('participants')} t={t} compact />
          ) : (
            <DataTable columns={[t('nickname'), t('specialty'), t('currentServerVip'), t('squadName'), t('participantStatus'), t('source'), t('updatedAt'), t('manage')]} emptyText={t('noParticipants')}>
              {participants.map((participant) => (
                <tr key={participant.id}>
                  <td><MemberName member={participant.member} t={t} setToast={setToast} showSteamId onProfileClick={setProfileMember} /></td>
                  <td><SpecialtyBadge value={participant.member?.specialty} t={t} /></td>
                  <td><ServerVipSummary participant={participant} t={t} /></td>
                  <td>{participant.squadName || t('unassignedSquad')}</td>
                  <td>
                    {wipe.status === 'closed' || !canManageParticipants ? (
                      <ParticipantStatusBadge status={participant.status} t={t} />
                    ) : (
                      <select className="compact-select" value={normalizeParticipantStatus(participant.status)} onChange={(event) => updateParticipantStatus(participant, event.target.value)}>
                        <option value="on_time">{t('statusParticipantActive')}</option>
                        <option value="join_8h">{t('statusParticipantJoin8h')}</option>
                        <option value="join_16h">{t('statusParticipantJoin16h')}</option>
                        <option value="not_attending">{t('statusParticipantNotAttending')}</option>
                      </select>
                    )}
                  </td>
                  <td>{participantSourceLabel(participant.source, t)}</td>
                  <td>{formatTime(participant.updatedAt, lang) || '-'}</td>
                  <td>
                    {canManageParticipants && wipe.status !== 'closed' && (
                      <button className="action-button danger" onClick={() => removeParticipant(participant)}>
                        <Trash2 size={17} />
                        <span>{t('remove')}</span>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </DataTable>
          )}
          <div ref={participantListSentinelRef} className="member-list-load-more" aria-live="polite">
            {participantListLoadingMore ? (
              t('loadingMoreMembers')
            ) : canLoadMoreParticipants ? (
              <button type="button" className="ghost-button fit-button" onClick={loadMoreParticipants}>
                <RefreshCw size={16} />
                <span>{t('loadMoreMembers')}</span>
              </button>
            ) : (
              participants.length ? t('allMembersLoaded') : ''
            )}
          </div>
        </>
      )}

      {showPicker && (
        <MemberPicker
          title={t('addParticipants')}
          members={candidates}
          loading={participantPickerLoading}
          loadError={participantPickerError}
          t={t}
          setToast={setToast}
          onConfirm={addParticipants}
          onClose={() => setShowPicker(false)}
        />
      )}
      <MemberProfileDialogStack
        member={profileMember}
        user={user}
        lang={lang}
        t={t}
        setToast={setToast}
        onMemberUpdated={async () => {
          await load();
        }}
        onOpenRustKdaLookup={onOpenRustKdaLookup}
        onClose={() => setProfileMember(null)}
      />
      {mapPreviewOpen && rustMapsPreviewImageUrl && (
        <MapPreviewModal
          imageUrl={rustMapsPreviewImageUrl}
          rustMapsUrl={rustMapsUrl}
          t={t}
          onClose={() => setMapPreviewOpen(false)}
        />
      )}
      {discordPushModal && (
        <DiscordPushCardModal
          cardType="wipe"
          language={discordPushModal.language}
          preview={discordPushModal.preview}
          loading={discordPushModal.loading}
          pushing={discordPushModal.pushing}
          error={discordPushModal.error}
          mentionEveryone={discordPushModal.mentionEveryone !== false}
          t={t}
          lang={lang}
          onCancel={() => setDiscordPushModal(null)}
          onLanguageChange={(nextLanguage) => loadDiscordAttendancePreview(nextLanguage, discordPushModal.mentionEveryone !== false)}
          onMentionEveryoneChange={(nextValue) => loadDiscordAttendancePreview(discordPushModal.language, nextValue)}
          onPush={() => pushDiscordAttendance(discordPushModal.language, discordPushModal.mentionEveryone !== false)}
        />
      )}
    </section>
  );
}
