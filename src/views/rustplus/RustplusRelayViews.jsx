import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronDown, Monitor, Plus, RefreshCw, RotateCcw, Save, ScrollText, Search, Send, ShieldCheck, Square, Trash2, TriangleAlert, UserPlus, X } from 'lucide-react';
import { api } from '../../shared/api.js';
import { formatCopy, formatPlayTimeMinutes, formatStatNumber, formatTime, localizeError } from '../../shared/format.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { DataTable } from '../../shared/ui/DataTable.jsx';
import { InfoGrid } from '../../shared/ui/InfoGrid.jsx';
import { ModalFrame } from '../../shared/ui/ModalFrame.jsx';
import { PageLoadingState } from '../../shared/ui/PageLoadingState.jsx';
import { cx } from '../../shared/ui/cx.js';
import { Avatar } from '../../shared/member/Avatar.jsx';
import { MemberProfileModal } from '../../shared/member/dialogs.jsx';
import { MemberProfileHero } from '../../shared/member/MemberProfileHero.jsx';

const RUSTPLUS_RELAY_CHAT_LOAD_MORE = 100;
const RUSTPLUS_RELAY_CHAT_INITIAL_LIMIT = 50;
const RUSTPLUS_RELAY_CLIENT_ACTIVE_MS = 2 * 60 * 1000;

function useRustplusRelayPageState(t, scope = 'all', options = {}) {
  const autoLoadChat = options.autoLoadChat !== false;
  const live = options.live !== false;
  const [relay, setRelay] = useState(null);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedServerKey, setSelectedServerKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const selectedRef = useRef({ clientId: '', serverKey: '' });

  const applyRelayPayload = useCallback((nextRelay) => {
    const next = nextRelay || null;
    setRelay((current) => next ? {
      ...(current || {}),
      ...next,
      settings: Object.hasOwn(next, 'settings') ? next.settings : (current?.settings || null),
      clients: Array.isArray(next.clients) ? next.clients : (current?.clients || []),
      servers: Array.isArray(next.servers) ? next.servers : (current?.servers || []),
      selected: Object.hasOwn(next, 'selected') ? (next.selected || {}) : (current?.selected || {}),
      server: Object.hasOwn(next, 'server') ? next.server : (current?.server || null),
      clan: Object.hasOwn(next, 'clan') ? next.clan : (current?.clan || null),
      members: Array.isArray(next.members) ? next.members : (current?.members || []),
      invites: Array.isArray(next.invites) ? next.invites : (current?.invites || []),
      chatMessages: Array.isArray(next.chatMessages) ? next.chatMessages : (current?.chatMessages || []),
      chatPage: Object.hasOwn(next, 'chatPage') ? (next.chatPage || {}) : (current?.chatPage || {}),
      summary: {
        ...(current?.summary || {}),
        ...(next.summary || {})
      },
      discordTargets: Object.hasOwn(next, 'discordTargets') ? (next.discordTargets || []) : (current?.discordTargets || []),
      inviteRecords: Object.hasOwn(next, 'inviteRecords') ? (next.inviteRecords || []) : (current?.inviteRecords || [])
    } : null);
    const nextClientId = next?.selected?.clientId || '';
    const nextServerKey = next?.selected?.serverKey || '';
    setSelectedClientId(nextClientId);
    setSelectedServerKey(nextServerKey);
    selectedRef.current = { clientId: nextClientId, serverKey: nextServerKey };
  }, []);

  const load = useCallback(async (filters = selectedRef.current, loadOptions = {}) => {
    const includeChat = scope === 'chat' ? (loadOptions.includeChat ?? autoLoadChat) : false;
    if (!loadOptions.silent) setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (filters?.clientId) params.set('clientId', filters.clientId);
      if (filters?.serverKey) params.set('serverKey', filters.serverKey);
      if (filters?.chatOffset) params.set('chatOffset', String(filters.chatOffset));
      if (filters?.chatLimit) params.set('chatLimit', String(filters.chatLimit));
      else if (scope === 'chat' && includeChat) params.set('chatLimit', String(RUSTPLUS_RELAY_CHAT_INITIAL_LIMIT));
      else if (scope === 'chat') params.set('chatLimit', '0');
      else if (scope !== 'chat') params.set('chatLimit', '0');
      if (filters?.includeInviteRecords) params.set('includeInviteRecords', '1');
      else if (scope !== 'chat') params.set('includeInviteRecords', '0');
      if (scope) params.set('scope', scope);
      const query = params.toString() ? `?${params}` : '';
      const endpoints = scope === 'chat'
        ? [
            `/api/rustplus-relay/summary${query}`,
            ...(includeChat ? [`/api/rustplus-relay/chats${query}`] : [])
          ]
        : [`/api/rustplus-relay/summary${query}`, `/api/rustplus-relay/members${query}`];
      const payloads = await Promise.all(endpoints.map((endpoint) => api(endpoint)));
      payloads.forEach((payload) => applyRelayPayload(payload.relay || null));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      if (!loadOptions.silent) setLoading(false);
    }
  }, [applyRelayPayload, autoLoadChat, scope, t]);

  useEffect(() => {
    load({}, { silent: false, includeChat: autoLoadChat }).catch((err) => setError(localizeError(err.message, t)));
  }, [load, t]);

  useEffect(() => {
    if (!live) return undefined;
    if (typeof EventSource === 'undefined') return undefined;
    const params = new URLSearchParams();
    if (scope) params.set('scope', scope);
    if (scope === 'chat') {
      if (!autoLoadChat) return undefined;
      params.set('chatLimit', String(RUSTPLUS_RELAY_CHAT_INITIAL_LIMIT));
    }
    if (scope !== 'chat') params.set('chatLimit', '0');
    if (scope !== 'chat') params.set('includeInviteRecords', '0');
    const source = new EventSource(`/api/rustplus-relay/events${params.toString() ? `?${params}` : ''}`, { withCredentials: true });
    source.addEventListener('relay_state', (event) => {
      try {
        applyRelayPayload(JSON.parse(event.data));
      } catch {
        // Keep the last valid relay state.
      }
    });
    source.addEventListener('relay_update', (event) => {
      try {
        const payload = JSON.parse(event.data);
        const nextRelay = payload.relay || null;
        const current = selectedRef.current;
        const matchesClient = !current.clientId || nextRelay?.selected?.clientId === current.clientId;
        const matchesServer = !current.serverKey || nextRelay?.selected?.serverKey === current.serverKey;
        if (matchesClient && matchesServer) {
          applyRelayPayload(nextRelay);
          return;
        }
        load(current, { silent: true }).catch(() => {});
      } catch {
        // Keep the last valid relay state.
      }
    });
    source.onerror = () => {};
    return () => source.close();
  }, [applyRelayPayload, autoLoadChat, live, load, scope]);

  function selectClient(clientId) {
    const next = { clientId, serverKey: '' };
    selectedRef.current = next;
    setSelectedClientId(clientId);
    setSelectedServerKey('');
    load(next).catch((err) => setError(localizeError(err.message, t)));
  }

  function selectServer(serverKey) {
    const next = { clientId: selectedClientId, serverKey };
    selectedRef.current = next;
    setSelectedServerKey(serverKey);
    load(next).catch((err) => setError(localizeError(err.message, t)));
  }

  const loadMoreChat = useCallback(async (limit = RUSTPLUS_RELAY_CHAT_LOAD_MORE) => {
    const currentRelay = relay || {};
    const chatPage = currentRelay.chatPage || {};
    if (!chatPage.hasMore) return currentRelay;
    setError('');
    const params = new URLSearchParams();
    if (selectedRef.current.clientId) params.set('clientId', selectedRef.current.clientId);
    if (selectedRef.current.serverKey) params.set('serverKey', selectedRef.current.serverKey);
    if (scope) params.set('scope', scope);
    params.set('chatOffset', String(chatPage.nextOffset ?? (currentRelay.chatMessages || []).length));
    params.set('chatLimit', String(limit));
    const payload = await api(`/api/rustplus-relay/chats?${params}`);
    const nextRelay = payload.relay || null;
    setRelay((previous) => {
      if (!previous || !nextRelay) return nextRelay;
      return {
        ...nextRelay,
        discordTargets: nextRelay.discordTargets || previous.discordTargets || [],
        inviteRecords: nextRelay.inviteRecordsIncluded ? (nextRelay.inviteRecords || []) : (previous.inviteRecords || nextRelay.inviteRecords || []),
        chatMessages: [
          ...(previous.chatMessages || []),
          ...(nextRelay.chatMessages || [])
        ]
      };
    });
    return nextRelay;
  }, [relay, scope]);

  const loadInviteRecords = useCallback(async () => {
    const params = new URLSearchParams();
    if (selectedRef.current.clientId) params.set('clientId', selectedRef.current.clientId);
    if (selectedRef.current.serverKey) params.set('serverKey', selectedRef.current.serverKey);
    params.set('includeInviteRecords', '1');
    const payload = await api(`/api/rustplus-relay/invites?${params}`);
    applyRelayPayload(payload.relay || null);
    return payload.relay || null;
  }, [applyRelayPayload]);

  const members = relay?.members || [];
  const invites = relay?.invites || [];
  const inviteRecords = relay?.inviteRecords || [];
  const chatMessages = relay?.chatMessages || [];

  return {
    relay,
    selectedClientId,
    selectedServerKey,
    loading,
    error,
    setError,
    load,
    loadMoreChat,
    loadInviteRecords,
    applyRelayPayload,
    selectClient,
    selectServer,
    clients: relay?.clients || [],
    servers: relay?.servers || [],
    members,
    invites,
    inviteRecords,
    chatMessages,
    onlineMembers: members.filter((member) => member.online),
    offlineMembers: members.filter((member) => !member.online)
  };
}

function RustplusRelayPageToolbar({ relayState, t, children = null }) {
  return (
    <div className="section-heading rustplus-page-toolbar">
      <span />
      <div className="rustplus-page-toolbar-actions">
        {children}
        <button type="button" className="ghost-button" onClick={() => relayState.load()} disabled={relayState.loading}>
          <RefreshCw size={17} />
          <span>{t('refresh')}</span>
        </button>
      </div>
    </div>
  );
}

function rustplusRelayClientRecentlyOnline(client = {}) {
  const lastSeenMs = Date.parse(client.lastSeenAt || '');
  return Number.isFinite(lastSeenMs) && Date.now() - lastSeenMs <= RUSTPLUS_RELAY_CLIENT_ACTIVE_MS;
}

function RustplusRelayDataStatus({ relayState, lang, t }) {
  const [expanded, setExpanded] = useState(false);
  const hasClientReports = relayState.clients.length > 0;
  const dataTime = formatTime(relayState.relay?.settings?.lastReceivedAt, lang) || '-';
  return (
    <div className={cx('rustplus-relay-data-status', !hasClientReports && 'empty', expanded && 'expanded')}>
      <div className="rustplus-relay-data-status-main">
        <span>{hasClientReports
          ? `${t('rustplusRelayReportedClients')} ${formatStatNumber(relayState.clients.length, lang)}`
          : t('rustplusRelayNoClients')}</span>
        <div className="rustplus-relay-data-status-actions">
          <small>{t('kdaDataTime')}: {dataTime}</small>
          {hasClientReports && (
            <button
              type="button"
              className="ghost-button mini-button rustplus-client-detail-toggle"
              onClick={() => setExpanded((current) => !current)}
              aria-expanded={expanded}
            >
              <ChevronDown size={15} />
              <span>{t('rustplusRelayClientDetails')}</span>
            </button>
          )}
        </div>
      </div>
      {hasClientReports && expanded && (
        <div className="rustplus-client-detail-list">
          {relayState.clients.map((client) => {
            const online = rustplusRelayClientRecentlyOnline(client);
            return (
              <div className="rustplus-client-detail-row" key={client.id || client.name}>
                <div className="rustplus-client-detail-name">
                  <Monitor size={16} />
                  <strong>{client.name || client.id || '-'}</strong>
                  {client.id && <small className="mono">{client.id}</small>}
                </div>
                <span className={cx('status-badge', online ? 'active' : 'neutral')}>
                  {online ? t('rustplusRelayClientStatusOnline') : t('rustplusRelayClientStatusOffline')}
                </span>
                <small>{t('rustplusRelayClientConnectedAt')}: {formatTime(client.createdAt, lang) || '-'}</small>
                <small>{t('rustplusRelayClientSyncedAt')}: {formatTime(client.lastSeenAt, lang) || '-'}</small>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RustplusRelayChatTable({ relayState, lang, t, canEdit = false, onClearChat = null }) {
  const [loadingMore, setLoadingMore] = useState(false);
  const chatPage = relayState.relay?.chatPage || {};
  const loadedCount = relayState.chatMessages.length;
  const totalCount = Number(chatPage.total || relayState.relay?.summary?.chatCount || loadedCount) || loadedCount;
  const hasMore = Boolean(chatPage.hasMore || loadedCount < totalCount);
  const noClientReports = relayState.clients.length === 0;
  const chatItems = relayState.chatMessages.map((message, index) => {
    const displayName = message.displayName || message.name || message.steamId || '-';
    const messageText = message.translatedMessage || message.message || '-';
    const originalText = message.translatedMessage && message.message && message.translatedMessage !== message.message
      ? message.message
      : '';
    const avatarMember = {
      avatar: message.avatar || message.steamAvatar || '',
      displayName,
      customName: message.customName || '',
      steamNickname: message.steamNickname || '',
      steamId: message.steamId || ''
    };
    return (
      <article className="rustplus-chat-log-entry" key={message.id || `${message.sentAt || message.receivedAt || index}:${message.steamId || displayName}`}>
        <div className="rustplus-chat-log-time">
          <span>{formatTime(message.sentAt || message.receivedAt, lang) || '-'}</span>
          <small>{[message.serverName, message.channel || 'clan'].filter(Boolean).join(' · ')}</small>
        </div>
        <div className="rustplus-chat-log-avatar">
          <Avatar member={avatarMember} />
        </div>
        <div className="rustplus-chat-log-body">
          <div className="rustplus-chat-log-head">
            <strong>{displayName}</strong>
            {message.steamId && <span className="mono">{message.steamId}</span>}
          </div>
          <p>{messageText}</p>
          {originalText && (
            <div className="rustplus-chat-log-original">
              <span>{t('rustplusRelayChatOriginal')}</span>
              <p>{originalText}</p>
            </div>
          )}
        </div>
      </article>
    );
  });

  async function loadMoreChat() {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      await relayState.loadMoreChat(RUSTPLUS_RELAY_CHAT_LOAD_MORE);
    } catch (err) {
      relayState.setError(localizeError(err.message, t));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <section className="tool-panel rustplus-chat-log-panel">
      <div className="section-heading rustplus-chat-log-heading">
        <div>
          <h3>{t('rustplusRelayChatLog')}</h3>
          <div className="rustplus-chat-log-heading-meta">
            <small>{formatCopy(t('rustplusRelayChatLoadedMeta'), {
              shown: formatStatNumber(loadedCount, lang),
              total: formatStatNumber(totalCount, lang)
            })}</small>
            <small>{formatCopy(t('rustplusRelayChatTotalMeta'), {
              total: formatStatNumber(totalCount, lang)
            })}</small>
          </div>
        </div>
        {canEdit && onClearChat && (
          <button type="button" className="ghost-button danger" onClick={onClearChat} disabled={!totalCount}>
            <Trash2 size={16} />
            <span>{t('rustplusRelayClearChat')}</span>
          </button>
        )}
        </div>
      <div className="rustplus-chat-log-list">
        {chatItems.length ? chatItems : <div className="empty-state">{noClientReports ? t('rustplusRelayNoClients') : t('rustplusRelayChatEmpty')}</div>}
      </div>
      {hasMore && (
        <div className="rustplus-relay-load-more">
          <button type="button" className="ghost-button fit-button" onClick={loadMoreChat} disabled={loadingMore}>
            <RefreshCw size={17} />
            <span>{loadingMore ? t('rustplusRelayLoadingMoreChat') : t('rustplusRelayLoadMoreChat')}</span>
          </button>
        </div>
      )}
    </section>
  );
}

function rustplusDiscordForwardRouteDraft(route = {}, index = 0) {
  const platform = route.platform === 'kook' ? 'kook' : 'discord';
  const hasDestination = platform === 'kook'
    ? Boolean(route.kookChannelId || route.kookTemplateId || route.kookAccessTokenConfigured)
    : Boolean(route.guildId || route.channelId || route.targetId);
  return {
    id: route.id || `discord_forward_${index + 1}`,
    labelIndex: index + 1,
    enabled: route.enabled !== false && hasDestination,
    platform,
    guildId: route.guildId || '',
    channelId: route.channelId || '',
    kookAccessToken: '',
    kookAccessTokenConfigured: Boolean(route.kookAccessTokenConfigured),
    kookChannelId: route.kookChannelId || '',
    kookTemplateId: route.kookTemplateId || '',
    targetId: route.targetId || '',
    targetName: route.targetName || ''
  };
}

function rustplusDiscordForwardRows(routes = []) {
  const rows = routes.length
    ? routes.map((route, index) => rustplusDiscordForwardRouteDraft(route, index))
    : [rustplusDiscordForwardRouteDraft({}, 0)];
  return rows.map((route, index) => ({
    ...route,
    id: route.id || `discord_forward_${index + 1}`,
    labelIndex: index + 1
  }));
}

function createRustplusForwardBlankRoute(index = 0) {
  return rustplusDiscordForwardRouteDraft({
    id: `third_party_forward_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  }, index);
}

function rustplusForwardRouteConfigured(route = {}) {
  if (route.platform === 'kook') {
    return Boolean((route.kookAccessToken || route.kookAccessTokenConfigured) && route.kookChannelId);
  }
  return Boolean(route.guildId && route.channelId);
}

function rustplusForwardRoutePartial(route = {}) {
  if (route.platform === 'kook') {
    const hasAny = Boolean(route.kookAccessToken || route.kookAccessTokenConfigured || route.kookChannelId || route.kookTemplateId);
    return hasAny && !rustplusForwardRouteConfigured(route);
  }
  const hasAny = Boolean(route.guildId || route.channelId);
  return hasAny && !rustplusForwardRouteConfigured(route);
}

function rustplusForwardRouteTargetLabel(route = {}) {
  if (route.platform === 'kook') {
    return `KOOK / ${route.kookChannelId || '-'}${route.kookTemplateId ? ` / ${route.kookTemplateId}` : ''}`;
  }
  return `Discord / ${route.guildId || '-'} / ${route.channelId || '-'}`;
}

function RustplusDiscordForwardingPanel({ relayState, lang, t, setToast, canEdit = false }) {
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const forwarding = relayState.relay?.settings?.discordForwarding || {};
  const forwardingRoutes = useMemo(() => {
    if (Array.isArray(forwarding.routes) && forwarding.routes.length) return forwarding.routes;
    return forwarding.serverKey || forwarding.channelId ? [forwarding] : [];
  }, [
    forwarding.channelId,
    forwarding.clientId,
    forwarding.enabled,
    forwarding.guildId,
    forwarding.routes,
    forwarding.serverId,
    forwarding.serverKey,
    forwarding.serverName,
    forwarding.targetId,
    forwarding.targetName
  ]);
  const [form, setForm] = useState({
    enabled: false,
    routes: []
  });

  useEffect(() => {
    setForm({
      enabled: Boolean(forwarding.enabled),
      routes: rustplusDiscordForwardRows(forwardingRoutes)
    });
  }, [
    forwarding.enabled,
    forwarding.updatedAt,
    forwardingRoutes
  ]);

  const configuredRoutes = form.routes.filter(rustplusForwardRouteConfigured);
  const partialRoutes = form.routes.filter(rustplusForwardRoutePartial);
  const canSave = canEdit && !saving && (!form.enabled || (configuredRoutes.length > 0 && partialRoutes.length === 0));
  const panelBodyId = 'rustplus-discord-forward-body';

  function updateRoute(routeId, patch) {
    setForm((current) => ({
      ...current,
      routes: current.routes.map((route) => route.id === routeId ? { ...route, ...patch } : route)
    }));
  }

  function addRoute() {
    setForm((current) => ({
      ...current,
      routes: [
        ...current.routes,
        createRustplusForwardBlankRoute(current.routes.length)
      ]
    }));
  }

  function removeRoute(routeId) {
    setForm((current) => {
      const routes = current.routes.filter((route) => route.id !== routeId);
      return {
        ...current,
        routes: routes.length ? routes : [createRustplusForwardBlankRoute(0)]
      };
    });
  }

  async function saveForwarding(event) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    relayState.setError('');
    try {
      const payload = await api('/api/settings/rustplus-relay/discord-forwarding', {
        method: 'PUT',
        body: {
          enabled: form.enabled,
          routes: form.routes.filter(rustplusForwardRouteConfigured).map((route, index) => ({
            id: route.id || `discord_forward_${index + 1}`,
            enabled: rustplusForwardRouteConfigured(route),
            platform: route.platform === 'kook' ? 'kook' : 'discord',
            targetName: formatCopy(t('rustplusRelayForwardTargetLabel'), { index: index + 1 }),
            guildId: route.guildId,
            channelId: route.channelId,
            kookAccessToken: route.kookAccessToken,
            kookAccessTokenConfigured: Boolean(route.kookAccessTokenConfigured),
            kookChannelId: route.kookChannelId,
            kookTemplateId: route.kookTemplateId
          }))
        }
      });
      relayState.applyRelayPayload(payload.relay || {
        ...relayState.relay,
        settings: payload.rustplusRelay || relayState.relay?.settings
      });
      setToast(t('rustplusRelayForwardingSaved'));
    } catch (err) {
      relayState.setError(localizeError(err.message, t));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={cx('tool-panel rustplus-discord-forward-panel', !expanded && 'collapsed')} onSubmit={saveForwarding}>
      <div className="rustplus-forward-head">
        <div className="rustplus-forward-title">
          <Send size={18} />
          <div>
            <h3>{t('rustplusRelayForwardDiscord')}</h3>
            <small>{formatCopy(t('rustplusRelayForwardRouteCount'), { count: formatStatNumber(configuredRoutes.length, lang) })}</small>
          </div>
        </div>
        <div className="rustplus-forward-head-actions">
          <span className={cx('status-badge rustplus-forward-status', form.enabled ? 'complete' : 'neutral')}>
            {form.enabled ? t('rustplusRelayForwardingEnabled') : t('rustplusRelayForwardingDisabled')}
          </span>
          <button
            type="button"
            className="ghost-button fit-button rustplus-forward-collapse-toggle"
            aria-expanded={expanded}
            aria-controls={panelBodyId}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronDown size={16} />
            <span>{expanded ? t('collapsePanel') : t('expandPanel')}</span>
          </button>
        </div>
      </div>
      {expanded && (
        <div className="rustplus-forward-body" id={panelBodyId}>
          <label className="switch-row rustplus-forward-toggle">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm((current) => ({ ...current, enabled: event.target.checked }))}
              disabled={!canEdit || saving}
            />
            <span>{form.enabled ? t('rustplusRelayForwardingEnabled') : t('rustplusRelayForwardingDisabled')}</span>
          </label>
          <div className="rustplus-forward-route-list">
            {form.routes.map((route, index) => (
              <div className="rustplus-forward-route-row" key={route.id}>
                <div className="rustplus-forward-server-cell">
                  <div className="rustplus-forward-route-title">
                    <strong>{formatCopy(t('rustplusRelayForwardTargetLabel'), { index: index + 1 })}</strong>
                    <button
                      type="button"
                      className="icon-button danger rustplus-forward-route-remove"
                      title={t('rustplusRelayRemoveForwardTarget')}
                      onClick={() => removeRoute(route.id)}
                      disabled={!canEdit || saving}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  <span>{t('rustplusRelayForwardAllChat')}</span>
                </div>
                <label>
                  <span>{t('rustplusRelayForwardPlatform')}</span>
                  <select
                    value={route.platform || 'discord'}
                    onChange={(event) => updateRoute(route.id, {
                      platform: event.target.value,
                      guildId: event.target.value === 'discord' ? route.guildId : '',
                      channelId: event.target.value === 'discord' ? route.channelId : '',
                      kookChannelId: event.target.value === 'kook' ? route.kookChannelId : '',
                      kookTemplateId: event.target.value === 'kook' ? route.kookTemplateId : ''
                    })}
                    disabled={!canEdit || saving}
                  >
                    <option value="discord">{t('rustplusRelayForwardPlatformDiscord')}</option>
                    <option value="kook">{t('rustplusRelayForwardPlatformKook')}</option>
                  </select>
                </label>
                {route.platform === 'kook' ? (
                  <>
                    <label>
                      <span>{t('rustplusRelayKookAccessToken')}</span>
                      <input
                        type="password"
                        value={route.kookAccessToken || ''}
                        onChange={(event) => updateRoute(route.id, { kookAccessToken: event.target.value })}
                        maxLength={4096}
                        placeholder={route.kookAccessTokenConfigured ? t('rustplusRelayKookAccessTokenConfiguredPlaceholder') : t('rustplusRelayKookAccessTokenPlaceholder')}
                        autoComplete="new-password"
                        disabled={!canEdit || saving}
                      />
                    </label>
                    <label>
                      <span>{t('rustplusRelayKookChannelId')}</span>
                      <input value={route.kookChannelId || ''} onChange={(event) => updateRoute(route.id, { kookChannelId: event.target.value })} maxLength={80} placeholder={t('rustplusRelayKookChannelIdPlaceholder')} disabled={!canEdit || saving} />
                    </label>
                    <label>
                      <span>{t('rustplusRelayKookTemplateId')}</span>
                      <input value={route.kookTemplateId || ''} onChange={(event) => updateRoute(route.id, { kookTemplateId: event.target.value })} maxLength={80} placeholder={t('rustplusRelayKookTemplateIdPlaceholder')} disabled={!canEdit || saving} />
                    </label>
                  </>
                ) : (
                  <>
                <label>
                  <span>{t('rustplusRelayDiscordGuildId')}</span>
                  <input value={route.guildId || ''} onChange={(event) => updateRoute(route.id, { guildId: event.target.value })} maxLength={32} placeholder={t('rustplusRelayDiscordGuildIdPlaceholder')} disabled={!canEdit || saving} />
                </label>
                <label>
                  <span>{t('rustplusRelayDiscordChannelId')}</span>
                  <input value={route.channelId || ''} onChange={(event) => updateRoute(route.id, { channelId: event.target.value })} maxLength={32} placeholder={t('rustplusRelayDiscordChannelIdPlaceholder')} disabled={!canEdit || saving} />
                </label>
                  </>
                )}
              </div>
            ))}
            <div className="rustplus-forward-actions">
              <button type="button" className="ghost-button fit-button" onClick={addRoute} disabled={!canEdit || saving}>
                <Plus size={17} />
                <span>{t('rustplusRelayAddForwardTarget')}</span>
              </button>
              <button type="submit" className="primary-button fit-button" disabled={!canSave}>
                <Save size={17} />
                <span>{saving ? t('saving') : t('save')}</span>
              </button>
            </div>
          </div>
          <InfoGrid className="rustplus-forward-meta system-settings-info" items={[
            [t('rustplusRelayForwardingLast'), formatTime(forwarding.lastForwardedAt, lang) || t('notSyncedYet')],
            [t('rustplusRelayForwardingError'), forwarding.lastForwardError || '-'],
            [t('rustplusRelayForwardRoutes'), formatStatNumber(configuredRoutes.length, lang)],
            [t('rustplusRelayThirdPartyTarget'), configuredRoutes.map(rustplusForwardRouteTargetLabel).join(', ') || '-']
          ]} />
        </div>
      )}
    </form>
  );
}

function RustplusRelayMemberProfileModal({ member, lang, t, setToast, onClose }) {
  const lastOfflineAt = member.lastOfflineAt || '';
  const profile = {
    ...member,
    steamNickname: member.displayName || member.steamNickname || '',
    customName: member.role || ''
  };
  const profileUrl = member.profileUrl || (member.steamId ? `https://steamcommunity.com/profiles/${member.steamId}` : '');
  return (
    <ModalFrame className="wide-modal member-profile-modal" labelledBy="rustplus-member-profile-title" onClose={onClose}>
      <div className="modal-title">
        <div>
          <h3 id="rustplus-member-profile-title">{t('rustplusRelayMemberProfile')}</h3>
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
        canSyncOnline={false}
        canManageProfile={false}
        canEditProfile={false}
        loading={false}
        onlineLoading={false}
        steamLoading={false}
      />
      <div className="member-profile-content">
        <section className="member-profile-section">
          <InfoGrid items={[
            [t('status'), member.online ? t('gameOnline') : t('gameOffline')],
            [t('lastOnlineAt'), formatTime(member.lastOnlineAt, lang) || '-'],
            [t('lastOfflineAt'), lastOfflineAt ? formatTime(lastOfflineAt, lang) : (member.online ? t('notOfflineYet') : '-')],
            [t('onlineTime'), formatPlayTimeMinutes(member.onlineTimeMinutes, lang)]
          ]} />
        </section>
      </div>
    </ModalFrame>
  );
}

function isSteamId64Text(value) {
  return /^\d{17}$/.test(String(value || '').trim());
}

function rustplusIdentityDisplayName(identity = {}) {
  const steamId = identity.steamId || '';
  return [
    identity.customName,
    identity.steamNickname,
    identity.displayName,
    identity.name
  ].map((value) => String(value || '').trim())
    .find((value) => value && value !== '[object Object]' && value !== steamId && !isSteamId64Text(value)) || steamId || '-';
}

function RustplusInviteRecordPerson({ record, type, t, onOpenProfile }) {
  const isInviter = type === 'inviter';
  const steamId = isInviter ? record.inviterSteamId : (record.inviteeSteamId || record.steamId);
  const identity = {
    id: isInviter ? record.inviterMemberId : record.inviteeMemberId || record.memberId,
    steamId,
    customName: isInviter ? record.inviterCustomName : record.inviteeCustomName || record.customName,
    steamNickname: isInviter ? record.inviterSteamNickname : record.inviteeSteamNickname || record.steamNickname,
    displayName: isInviter
      ? record.inviterDisplayName || record.inviterName || record.invitedBy
      : record.inviteeDisplayName || record.inviteeName || record.displayName,
    avatar: isInviter ? record.inviterAvatar : record.inviteeAvatar || record.avatar
  };
  const displayName = rustplusIdentityDisplayName(identity);
  const avatar = <Avatar member={identity} />;
  const content = (
    <>
      {avatar}
      <div className="rustplus-invite-record-person-text">
        <strong>{displayName}</strong>
        {steamId && <small className="mono">{steamId}</small>}
      </div>
    </>
  );
  return onOpenProfile && steamId ? (
    <button type="button" className="rustplus-invite-record-person" title={t('viewProfile')} onClick={() => onOpenProfile(identity)}>
      {content}
    </button>
  ) : (
    <div className="rustplus-invite-record-person">
      {content}
    </div>
  );
}

function RustplusInviteRecordsModal({ relayState, lang, t, onClose, onOpenProfile }) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const records = relayState.inviteRecords || [];
  const filteredRecords = records.filter((record) => {
    if (!normalizedQuery) return true;
    return [
      record.inviterDisplayName,
      record.inviterName,
      record.inviterCustomName,
      record.inviterSteamNickname,
      record.inviterSteamId,
      record.invitedBy,
      record.inviteeDisplayName,
      record.inviteeName,
      record.inviteeCustomName,
      record.inviteeSteamNickname,
      record.displayName,
      record.steamId,
      record.inviteeSteamId,
      record.status,
      record.statusLabel,
      record.serverName
    ].some((value) => String(value || '').toLowerCase().includes(normalizedQuery));
  });
  const acceptedCount = records.filter((record) => String(record.status || '').toLowerCase() === 'accepted').length;
  const pendingCount = Math.max(0, records.length - acceptedCount);
  const meta = formatCopy(t('rustplusRelayInviteRecordMeta'), {
    count: formatStatNumber(records.length, lang),
    pending: formatStatNumber(pendingCount, lang),
    accepted: formatStatNumber(acceptedCount, lang)
  });
  function refreshInviteRecords() {
    relayState.loadInviteRecords?.().catch((err) => relayState.setError(localizeError(err.message, t)));
  }
  const rows = filteredRecords.map((record) => {
    const status = String(record.status || '').toLowerCase();
    const accepted = status === 'accepted';
    return (
      <tr key={record.id || `${record.serverKey}:${record.steamId}:${record.inviterSteamId}:${record.sentAt}`}>
        <td>
          <RustplusInviteRecordPerson record={record} type="inviter" t={t} onOpenProfile={onOpenProfile} />
        </td>
        <td>
          <RustplusInviteRecordPerson record={record} type="invitee" t={t} onOpenProfile={onOpenProfile} />
        </td>
        <td>{formatTime(record.sentAt || record.receivedAt, lang) || '-'}</td>
        <td>
          <span className={cx('status-badge', accepted ? 'complete' : 'pending')}>
            {record.statusLabel || (accepted ? t('rustplusRelayInviteStatusAccepted') : t('rustplusRelayInviteStatusPending'))}
          </span>
        </td>
      </tr>
    );
  });
  return (
    <ModalFrame className="wide-modal rustplus-invite-record-modal" labelledBy="rustplus-invite-record-title" onClose={onClose}>
      <div className="modal-title">
        <div>
          <h3 id="rustplus-invite-record-title">{t('rustplusRelayInviteRecordsTitle')}</h3>
          <p>{t('rustplusRelayInviteRecordsHint')}</p>
        </div>
        <div className="modal-title-actions">
          <button type="button" className="ghost-button fit-button" onClick={refreshInviteRecords} disabled={relayState.loading}>
            <RefreshCw size={16} />
            <span>{t('refresh')}</span>
          </button>
          <button type="button" className="icon-button" title={t('close')} onClick={onClose}>
            <X size={18} />
          </button>
        </div>
      </div>
      <div className="rustplus-invite-record-toolbar">
        <div className="search-control">
          <Search size={16} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('memberSearchPlaceholder')}
            aria-label={t('memberSearchPlaceholder')}
          />
        </div>
        <small>{meta}</small>
      </div>
      <DataTable
        className="rustplus-invite-record-table"
        columns={[t('rustplusRelayInviter'), t('rustplusRelayInvitee'), t('rustplusRelayInviteTime'), t('rustplusRelayInviteStatus')]}
        emptyText={t('rustplusRelayInviteRecordsEmpty')}
      >
        {rows}
      </DataTable>
    </ModalFrame>
  );
}

function rustplusSquadOnlineBreakdown(members = [], t) {
  const rowsBySquad = new Map();
  members.forEach((member) => {
    const squadName = String(member.squadName || '').trim() || t('unassignedSquad');
    if (!rowsBySquad.has(squadName)) {
      rowsBySquad.set(squadName, { name: squadName, online: 0, total: 0 });
    }
    const row = rowsBySquad.get(squadName);
    row.total += 1;
    if (member.online) row.online += 1;
  });
  return [...rowsBySquad.values()].sort((left, right) => (
    right.online - left.online
    || right.total - left.total
    || left.name.localeCompare(right.name)
  ));
}

function RustplusClanOverview({ relayState, lang, t }) {
  const clan = relayState.relay?.clan || relayState.relay?.server?.clan || {};
  const summary = relayState.relay?.summary || {};
  const clanName = import.meta.env?.VITE_BRAND_NAME || 'Clan Portal';
  const clanId = clan.id || relayState.relay?.selected?.clientId || '-';
  const summaryMemberCount = Number(summary.memberCount);
  const summaryOnlineCount = Number(summary.onlineCount);
  const summaryOfflineCount = Number(summary.offlineCount);
  const memberCount = Number.isFinite(summaryMemberCount) ? summaryMemberCount : relayState.members.length;
  const onlineCount = Number.isFinite(summaryOnlineCount) ? summaryOnlineCount : relayState.onlineMembers.length;
  const offlineCount = Number.isFinite(summaryOfflineCount) ? summaryOfflineCount : relayState.offlineMembers.length;
  return (
    <div className="rustplus-clan-overview-grid">
      <div className="rustplus-clan-info-card primary">
        <div className="rustplus-clan-card-label">
          <ShieldCheck size={18} />
          <span>{t('rustplusRelayClanName')}</span>
        </div>
        <strong>{clanName}</strong>
        <small>{t('rustplusRelayClanId')}: {clanId}</small>
      </div>
      <div className="rustplus-clan-info-card">
        <span>{t('memberCount')}</span>
        <strong>{formatStatNumber(memberCount, lang)}</strong>
      </div>
      <div className="rustplus-clan-info-card">
        <span>{t('rustplusRelayOnlineMembers')}</span>
        <strong>{formatStatNumber(onlineCount, lang)}</strong>
      </div>
      <div className="rustplus-clan-info-card">
        <span>{t('rustplusRelayOfflineMembers')}</span>
        <strong>{formatStatNumber(offlineCount, lang)}</strong>
      </div>
    </div>
  );
}

function RustplusUnauthorizedMemberImportModal({
  member,
  squads = [],
  squadId,
  loading,
  saving,
  error,
  lang,
  t,
  onSquadChange,
  onSubmit,
  onClose
}) {
  const displayName = rustplusIdentityDisplayName(member);
  return (
    <ModalFrame className="rustplus-import-member-modal" onClose={onClose}>
      <div className="section-heading compact-heading">
        <div>
          <h3>{t('rustplusRelayImportMemberTitle')}</h3>
          <p>{t('rustplusRelayImportMemberHint')}</p>
        </div>
      </div>
      <div className="rustplus-import-member-profile">
        <Avatar member={member} />
        <div>
          <strong>{displayName || member?.steamId || '-'}</strong>
          <small className="mono">{member?.steamId || '-'}</small>
        </div>
      </div>
      <form className="member-form rustplus-import-member-form" onSubmit={onSubmit}>
        <label>
          <span>{t('squad')}</span>
          <select value={squadId} onChange={(event) => onSquadChange(event.target.value)} disabled={loading || saving || !squads.length} required>
            <option value="">{loading ? t('loading') : t('chooseSquad')}</option>
            {squads.map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
          </select>
        </label>
        {!loading && !squads.length && <Alert tone="warning">{t('rustplusRelayImportMemberEmptySquad')}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="modal-actions rustplus-import-member-actions">
          <span>{formatTime(member?.relaySnapshotAt || member?.lastSeenAt, lang) || ''}</span>
          <button type="button" className="ghost-button warning-button compact-form-button" onClick={onClose} disabled={saving}>{t('cancel')}</button>
          <button type="submit" className="primary-button compact-form-button" title={t('rustplusRelayImportMember')} disabled={loading || saving || !squadId || !member?.steamId}>
            <UserPlus size={17} />
            <span>{saving ? t('adding') : t('rustplusRelayImportMember')}</span>
          </button>
        </div>
      </form>
    </ModalFrame>
  );
}

function RustplusClanMemberTable({ relayState, lang, t, onOpenProfile, onOpenInvites, canImportMember = false, onImportMember = null }) {
  const squadOnlineBreakdown = rustplusSquadOnlineBreakdown(relayState.members, t);
  const memberRows = relayState.members.map((member) => {
    const gameClanName = member.gameClanName || (Array.isArray(member.gameClanNames) ? member.gameClanNames.join(', ') : '');
    const displayName = rustplusIdentityDisplayName(member);
    const steamLine = member.steamId || '-';
    const lastOfflineAt = member.lastOfflineAt || '';
    const unauthorizedMember = Boolean(member.unauthorizedMember || (!member.memberId && member.steamId));
    return (
      <tr key={member.steamId || member.displayName}>
        <td>
          <div className="rustplus-clan-member-cell">
            <button type="button" className="avatar-profile-button" title={t('openMemberProfile')} onClick={() => onOpenProfile(member)}>
              <Avatar member={member} />
            </button>
            <div className="member-name-text">
              <div className="strong-cell rustplus-member-display-name">
                <span className="rustplus-member-display-name-text">{displayName}</span>
                {member.online && <span className="rustplus-online-dot" title={t('gameOnline')} aria-label={t('gameOnline')} />}
              </div>
              <small className="member-name-steam mono">{steamLine}</small>
            </div>
          </div>
        </td>
        <td>
          {unauthorizedMember ? (
            <div className="rustplus-unauthorized-member-actions">
              <span className="rustplus-unauthorized-member-badge" title={t('rustplusRelayUnauthorizedMember')}>
                <TriangleAlert size={14} />
                <span>{t('rustplusRelayUnauthorizedMember')}</span>
              </span>
              {canImportMember && onImportMember && (
                <button type="button" className="action-button rustplus-import-member-button" title={t('rustplusRelayImportMember')} onClick={() => onImportMember(member)}>
                  <UserPlus size={15} />
                  <span>{t('rustplusRelayImportMember')}</span>
                </button>
              )}
            </div>
          ) : (member.squadName || t('unassignedSquad'))}
        </td>
        <td>{gameClanName || '-'}</td>
        <td>{formatTime(member.lastOnlineAt, lang) || '-'}</td>
        <td>{lastOfflineAt ? formatTime(lastOfflineAt, lang) : (member.online ? t('notOfflineYet') : '-')}</td>
        <td>{formatPlayTimeMinutes(member.onlineTimeMinutes, lang)}</td>
      </tr>
    );
  });
  return (
    <section className="tool-panel rustplus-relay-data-panel">
      <div className="section-heading rustplus-clan-member-heading">
        <div>
          <h3>{t('rustplusRelayPeople')}</h3>
          <div className="rustplus-clan-member-subtitle">
            <small>{relayState.relay?.clan?.count > 1 ? t('rustplusRelayMergedClan') : (relayState.relay?.server?.name || relayState.relay?.selected?.serverName || '-')}</small>
            {squadOnlineBreakdown.length > 0 && (
              <div className="rustplus-squad-online-capsules" aria-label={t('rustplusRelayOnlineMembers')}>
                {squadOnlineBreakdown.map((item) => (
                  <span className="rustplus-squad-pill-pair" key={item.name}>
                    <span className="rustplus-squad-online-pill">
                      {formatCopy(t('rustplusRelaySquadOnlineCapsule'), {
                        squad: item.name,
                        count: formatStatNumber(item.online, lang)
                      })}
                    </span>
                    <span className="rustplus-squad-online-pill joined">
                      {formatCopy(t('rustplusRelaySquadJoinedCapsule'), {
                        squad: item.name,
                        count: formatStatNumber(item.total, lang)
                      })}
                    </span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <button type="button" className="ghost-button fit-button" onClick={onOpenInvites}>
          <ScrollText size={16} />
          <span>{t('rustplusRelayInviteRecords')}</span>
        </button>
      </div>
      <DataTable columns={[t('memberName'), t('squad'), t('rustplusRelayGameClan'), t('rustplusRelayLastOnlineTime'), t('rustplusRelayLastOfflineTime'), t('rustplusRelayTotalOnlineTime')]} emptyText={t('rustplusRelayNoServerData')}>
        {memberRows}
      </DataTable>
    </section>
  );
}

function RustplusClanInfoView({ lang, setToast, t, canEdit = false, canImportMember = false, onMembersUpdated = null }) {
  const relayState = useRustplusRelayPageState(t, 'info');
  const [profileMember, setProfileMember] = useState(null);
  const [relayProfileMember, setRelayProfileMember] = useState(null);
  const [inviteRecordsOpen, setInviteRecordsOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [importMember, setImportMember] = useState(null);
  const [importSquads, setImportSquads] = useState([]);
  const [importSquadId, setImportSquadId] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [importSaving, setImportSaving] = useState(false);
  const [importError, setImportError] = useState('');

  async function openRelayMemberProfile(member) {
    setRelayProfileMember(null);
    if (member?.steamId) {
      try {
        const payload = await api(`/api/members?limit=10&q=${encodeURIComponent(member.steamId)}`);
        const matched = (payload.members || []).find((item) => item.steamId === member.steamId);
        if (matched?.id) {
          setProfileMember(matched);
          return;
        }
      } catch {
        // Fall back to the Rust+ relay record below.
      }
    }
    setRelayProfileMember(member);
  }

  async function openImportMember(member) {
    if (!canImportMember || !member?.steamId) return;
    setImportMember(member);
    setImportSquads([]);
    setImportSquadId('');
    setImportError('');
    setImportLoading(true);
    try {
      const payload = await api('/api/member-options');
      const squads = payload.squads || [];
      setImportSquads(squads);
      setImportSquadId(squads[0]?.id || '');
    } catch (err) {
      setImportError(localizeError(err.message, t));
    } finally {
      setImportLoading(false);
    }
  }

  async function submitImportMember(event) {
    event.preventDefault();
    if (!canImportMember || !importMember?.steamId || !importSquadId || importSaving) return;
    setImportSaving(true);
    setImportError('');
    try {
      const displayName = rustplusIdentityDisplayName(importMember);
      const customName = displayName && displayName !== importMember.steamId && displayName !== importMember.steamNickname
        ? displayName
        : '';
      await api('/api/members?response=minimal', {
        method: 'POST',
        body: {
          steamInput: importMember.steamId,
          customName,
          squadId: importSquadId
        }
      });
      setToast(t('rustplusRelayImportMemberSaved'));
      setImportMember(null);
      setImportSquads([]);
      setImportSquadId('');
      const refreshTasks = [
        ...(onMembersUpdated ? [Promise.resolve().then(() => onMembersUpdated())] : []),
        relayState.load(undefined, { silent: true })
      ];
      void Promise.allSettled(refreshTasks);
    } catch (err) {
      setImportError(localizeError(err.message, t));
    } finally {
      setImportSaving(false);
    }
  }

  async function resetRelayData() {
    if (!canEdit || resetting) return;
    setResetting(true);
    relayState.setError('');
    try {
      const payload = await api('/api/rustplus-relay', { method: 'DELETE' });
      relayState.applyRelayPayload(payload.relay ? {
        ...payload.relay,
        inviteRecords: []
      } : {
        clients: [],
        servers: [],
        members: [],
        invites: [],
        inviteRecords: [],
        summary: { memberCount: 0, onlineCount: 0, offlineCount: 0, inviteCount: 0, inviteRecordCount: 0, chatCount: 0 }
      });
      setInviteRecordsOpen(false);
      setResetOpen(false);
      setToast(t('rustplusRelayDataReset'));
    } catch (err) {
      relayState.setError(localizeError(err.message, t));
    } finally {
      setResetting(false);
    }
  }

  if (relayState.loading && !relayState.relay) {
    return <PageLoadingState title={t('navRustClanInfo')} t={t} />;
  }

  return (
    <section className="page-stack rustplus-relay-page">
      <RustplusRelayPageToolbar relayState={relayState} t={t}>
        {canEdit && (
          <button type="button" className="ghost-button danger" onClick={() => setResetOpen(true)} disabled={resetting}>
            <RotateCcw size={17} />
            <span>{resetting ? t('loading') : t('rustplusRelayResetData')}</span>
          </button>
        )}
      </RustplusRelayPageToolbar>
      {relayState.error && <Alert tone="danger">{relayState.error}</Alert>}
      <RustplusRelayDataStatus relayState={relayState} lang={lang} t={t} />
      <RustplusClanOverview relayState={relayState} lang={lang} t={t} />
      <RustplusClanMemberTable
        relayState={relayState}
        lang={lang}
        t={t}
        onOpenProfile={openRelayMemberProfile}
        onOpenInvites={() => {
          setInviteRecordsOpen(true);
          relayState.loadInviteRecords?.().catch((err) => relayState.setError(localizeError(err.message, t)));
        }}
        canImportMember={canImportMember}
        onImportMember={openImportMember}
      />
      {inviteRecordsOpen && (
        <RustplusInviteRecordsModal
          relayState={relayState}
          lang={lang}
          t={t}
          onClose={() => setInviteRecordsOpen(false)}
          onOpenProfile={openRelayMemberProfile}
        />
      )}
      {profileMember && (
        <MemberProfileModal
          member={profileMember}
          lang={lang}
          t={t}
          setToast={setToast}
          onClose={() => setProfileMember(null)}
        />
      )}
      {relayProfileMember && (
        <RustplusRelayMemberProfileModal
          member={relayProfileMember}
          lang={lang}
          t={t}
          setToast={setToast}
          onClose={() => setRelayProfileMember(null)}
        />
      )}
      {importMember && (
        <RustplusUnauthorizedMemberImportModal
          member={importMember}
          squads={importSquads}
          squadId={importSquadId}
          loading={importLoading}
          saving={importSaving}
          error={importError}
          lang={lang}
          t={t}
          onSquadChange={setImportSquadId}
          onSubmit={submitImportMember}
          onClose={() => {
            if (importSaving) return;
            setImportMember(null);
            setImportError('');
          }}
        />
      )}
      {resetOpen && (
        <ModalFrame className="confirm-modal" onClose={() => {
          if (!resetting) setResetOpen(false);
        }}>
          <div className="modal-title">
            <div>
              <h3>{t('rustplusRelayResetConfirmTitle')}</h3>
              <p>{t('rustplusRelayResetConfirmText')}</p>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost-button compact-form-button" onClick={() => setResetOpen(false)} disabled={resetting}>{t('cancel')}</button>
            <button type="button" className="action-button danger compact-form-button" onClick={resetRelayData} disabled={resetting}>
              <Trash2 size={17} />
              <span>{resetting ? t('loading') : t('confirm')}</span>
            </button>
          </div>
        </ModalFrame>
      )}
    </section>
  );
}

function RustplusClanChatView({ lang, setToast, t, canEdit = false }) {
  const [chatEnabled, setChatEnabled] = useState(false);
  const [clearChatOpen, setClearChatOpen] = useState(false);
  const [clearingChat, setClearingChat] = useState(false);
  const relayState = useRustplusRelayPageState(t, 'chat', {
    autoLoadChat: chatEnabled,
    live: chatEnabled
  });

  async function clearChatRecords() {
    if (!canEdit || clearingChat) return;
    setClearingChat(true);
    relayState.setError('');
    try {
      const payload = await api('/api/rustplus-relay/chats', { method: 'DELETE' });
      relayState.applyRelayPayload(payload.relay || {
        chatMessages: [],
        chatPage: { offset: 0, limit: 0, count: 0, total: 0, hasMore: false, nextOffset: 0 },
        summary: { ...(relayState.relay?.summary || {}), chatCount: 0 }
      });
      setClearChatOpen(false);
      setToast(t('rustplusRelayChatCleared'));
    } catch (err) {
      relayState.setError(localizeError(err.message, t));
    } finally {
      setClearingChat(false);
    }
  }

  if (relayState.loading && !relayState.relay) {
    return <PageLoadingState title={t('navRustClanChat')} t={t} />;
  }

  return (
    <section className="page-stack rustplus-relay-page">
      <RustplusRelayPageToolbar relayState={relayState} t={t}>
        {chatEnabled && (
          <button type="button" className="ghost-button" onClick={() => setChatEnabled(false)}>
            <Square size={15} />
            <span>{t('rustplusRelayDisableChat')}</span>
          </button>
        )}
      </RustplusRelayPageToolbar>
      {relayState.error && <Alert tone="danger">{relayState.error}</Alert>}
      <RustplusRelayDataStatus relayState={relayState} lang={lang} t={t} />
      <RustplusDiscordForwardingPanel relayState={relayState} lang={lang} t={t} setToast={setToast} canEdit={canEdit} />
      {chatEnabled ? (
        <RustplusRelayChatTable
          relayState={relayState}
          lang={lang}
          t={t}
          canEdit={canEdit}
          onClearChat={() => setClearChatOpen(true)}
        />
      ) : (
        <section className="tool-panel rustplus-chat-dormant-panel">
          <div className="section-heading">
            <div>
              <h3>{t('rustplusRelayChatLog')}</h3>
              <p>{t('rustplusRelayChatDormant')}</p>
            </div>
            <button type="button" className="primary-button" onClick={() => setChatEnabled(true)}>
              <Activity size={17} />
              <span>{t('rustplusRelayEnableChat')}</span>
            </button>
          </div>
        </section>
      )}
      {clearChatOpen && (
        <ModalFrame className="confirm-modal" onClose={() => {
          if (!clearingChat) setClearChatOpen(false);
        }}>
          <div className="modal-title">
            <div>
              <h3>{t('rustplusRelayClearChatConfirmTitle')}</h3>
              <p>{t('rustplusRelayClearChatConfirmText')}</p>
            </div>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost-button compact-form-button" onClick={() => setClearChatOpen(false)} disabled={clearingChat}>{t('cancel')}</button>
            <button type="button" className="action-button danger compact-form-button" onClick={clearChatRecords} disabled={clearingChat}>
              <Trash2 size={17} />
              <span>{clearingChat ? t('loading') : t('confirm')}</span>
            </button>
          </div>
        </ModalFrame>
      )}
    </section>
  );
}

export { RustplusClanChatView, RustplusClanInfoView };
