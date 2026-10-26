import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowUpDown,
  BarChart3,
  Crown,
  Database,
  KeyRound,
  LogOut,
  Monitor,
  ScrollText,
  Search,
  Send,
  Server,
  Settings,
  ShieldCheck,
  UserMinus,
  UserPlus,
  UserRound,
  Users
} from 'lucide-react';
import { api } from '../shared/api.js';
import { useCurrencyContext } from '../shared/currency.js';
import { localizeError } from '../shared/format.js';
import { canEditModule, canViewModule } from '../shared/permissions.js';
import {
  accountRiskRulesOrDefault,
  alertDismissalIdSet,
  buildMemberNotifications,
  defaultAccountRiskRules,
  normalizeAccountRiskRule,
  readMemberNotificationState,
  writeMemberNotificationState
} from '../shared/risk-alerts.js';
import { StatusBadge } from '../shared/member/status.jsx';
import { BrandMark } from '../shared/ui/BrandMark.jsx';
import { PageLoadingState } from '../shared/ui/PageLoadingState.jsx';
import { cx } from '../shared/ui/cx.js';
import {
  ApiSettingsView,
  DataLookupView,
  DepartedMembersView,
  DiscordBotSettingsView,
  DiscordKookBridgeView,
  HistoryView,
  HighRiskAccountAlertsView,
  KdaView,
  LogsView,
  MembersView,
  PermissionsView,
  ProfileView,
  QueryView,
  RustplusClanChatView,
  RustplusClanInfoView,
  ServerView,
  SquadsView,
  SyncCenterPanel,
  SystemSettingsView,
  UsersView,
  WechatMiniProgramView
} from './lazyViews.jsx';
import { LanguageSwitcher, ThemeSwitcher, ToastMessage, useToastMessage } from './shell-ui.jsx';

const EMPTY_ARRAY = Object.freeze([]);
const EMPTY_SET = Object.freeze(new Set());
const MEMBER_LIST_PAGE_SIZE = 5;

function readInitialDashboardNavigation() {
  if (typeof window === 'undefined') return { active: 'query', lookupRequest: null };
  const params = new URLSearchParams(window.location.search);
  const view = String(params.get('view') || '').trim();
  const tab = String(params.get('tab') || '').trim();
  if (view !== 'dataLookup' && tab !== 'vital') {
    return { active: 'query', lookupRequest: null };
  }
  if (tab !== 'vital') return { active: 'dataLookup', lookupRequest: null };
  const vitalServerId = String(params.get('vitalServerId') || '').trim();
  const vitalWipeId = String(params.get('vitalWipeId') || '').trim();
  const steamInput = String(params.get('steamInput') || params.get('vitalUserId') || '').trim();
  return {
    active: 'dataLookup',
    lookupRequest: {
      target: 'vital',
      vitalServerId,
      vitalWipeId,
      steamInput,
      id: `url:vital:${vitalServerId}:${vitalWipeId}:${steamInput}`
    }
  };
}

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

export default function Dashboard({ user, onUserChange, lang, setLang, themeMode, setThemeMode, t }) {
  const [initialNavigation] = useState(readInitialDashboardNavigation);
  const [active, setActive] = useState(initialNavigation.active);
  const [members, setMembers] = useState([]);
  const [memberListMeta, setMemberListMeta] = useState({ total: 0, offset: 0, limit: MEMBER_LIST_PAGE_SIZE, hasMore: false, paged: false });
  const [systemSettings, setSystemSettings] = useState({ teamLogoUrl: '', proxy: { scope: 'global', url: '' } });
  const [accountRiskSettings, setAccountRiskSettings] = useState({ squadFilter: '', rules: defaultAccountRiskRules(), configured: false });
  const [toast, setToast] = useToastMessage();
  const [notificationState, setNotificationState] = useState(() => readMemberNotificationState(user));
  const notificationStateRef = useRef(notificationState);
  const [alertDismissals, setAlertDismissals] = useState([]);
  const [rustKdaLookupRequest, setRustKdaLookupRequest] = useState(initialNavigation.lookupRequest);
  const membersLoadedAtRef = useRef(0);
  const membersRef = useRef([]);
  const membersLoadedAllRef = useRef(false);
  const isViewer = user.role === 'viewer';
  const isRootAccount = user?.id === 'user_root' || user?.username === 'root';
  const canViewRiskAlerts = canViewModule(user, 'riskAlerts');
  const canConfirmRiskAlerts = canEditModule(user, 'riskAlerts') && !isViewer;
  const canViewDiscordBot = canViewModule(user, 'discordBot');
  const canEditDiscordBot = canEditModule(user, 'discordBot');
  const canViewKookBot = canViewModule(user, 'kookBot');
  const canEditKookBot = canEditModule(user, 'kookBot');
  const canViewDiscordKookSync = canViewModule(user, 'discordKookSync');
  const canEditDiscordKookSync = canEditModule(user, 'discordKookSync');
  const canViewWechatMiniProgram = canViewModule(user, 'wechatMini');
  const canManageWechatMiniProgram = canEditModule(user, 'wechatMini');
  const canViewPermissions = isRootAccount;
  const canEditPermissions = isRootAccount;
  const canViewUsers = canViewModule(user, 'users');
  const canEditUsers = canEditModule(user, 'users');
  const canViewSystem = canViewModule(user, 'system');
  const canEditSystem = canEditModule(user, 'system');
  const canViewRustTools = canViewModule(user, 'rustTools');
  const canEditRustTools = canEditModule(user, 'rustTools');
  const canViewRustClanInfo = canViewModule(user, 'rustClanInfo') || canViewRustTools;
  const canEditRustClanInfo = canEditModule(user, 'rustClanInfo') || canEditRustTools;
  const canViewRustClanChat = canViewModule(user, 'rustClanChat') || canViewRustTools;
  const canEditRustClanChat = canEditModule(user, 'rustClanChat') || canEditRustTools;
  const canViewOfficialKda = canViewModule(user, 'officialKda');
  const canViewInventoryDetails = canViewModule(user, 'inventoryDetails');
  const canViewDataLookup = canViewOfficialKda || canViewInventoryDetails;
  const canImportRustClanMember = canEditModule(user, 'members') && user.role !== 'viewer' && user.role !== 'member';
  const canViewApi = canViewModule(user, 'api');
  const canEditApi = canEditModule(user, 'api');
  const canViewSync = canViewModule(user, 'sync');
  const canEditSync = canEditModule(user, 'sync');
  const canViewDepartedMembers = canViewModule(user, 'departedMembers');
  const canEditDepartedMembers = canEditModule(user, 'departedMembers');
  const teamLogoUrl = systemSettings?.teamLogoUrl || '';
  const currencyContext = useCurrencyContext(lang);

  const primaryNavItems = useMemo(() => [
    ...(canViewModule(user, 'query') ? [{ id: 'query', label: t('navQuery'), icon: Search }] : []),
    ...(canViewModule(user, 'members') ? [{ id: 'members', label: t('navMembers'), icon: Users }] : []),
    ...(canViewDepartedMembers ? [{ id: 'departedMembers', label: t('navDepartedMembers'), icon: UserMinus }] : []),
    ...(canViewRiskAlerts ? [{ id: 'riskAlerts', label: t('highRiskAccountAlerts'), icon: ShieldCheck }] : []),
    ...(canViewModule(user, 'squads') ? [{ id: 'squads', label: t('navSquads'), icon: Crown }] : []),
	    ...(canViewModule(user, 'server') ? [{ id: 'server', label: t('navServer'), icon: Server }] : []),
	    ...(canViewRustClanInfo ? [{ id: 'rustClanInfo', label: t('navRustClanInfo'), icon: Users }] : []),
	    ...(canViewRustClanChat ? [{ id: 'rustClanChat', label: t('navRustClanChat'), icon: ScrollText }] : []),
    ...(canViewModule(user, 'kda') ? [{ id: 'kda', label: t('navKda'), icon: BarChart3 }] : []),
    ...(canViewModule(user, 'history') ? [{ id: 'history', label: t('navHistory'), icon: Archive }] : []),
    ...(canViewDiscordBot || canViewKookBot ? [{ id: 'discordBot', label: t('navBot'), icon: Send }] : []),
    ...(canViewDiscordKookSync ? [{ id: 'discordKookSync', label: t('navDiscordKookSync'), icon: ArrowUpDown }] : []),
    ...(canViewWechatMiniProgram ? [{ id: 'wechatMini', label: t('navWechatMiniProgram'), icon: Monitor }] : []),
    ...(canViewModule(user, 'logs') ? [{ id: 'logs', label: t('navLogs'), icon: ScrollText }] : []),
    ...(canViewSync ? [{ id: 'sync', label: t('syncCenter'), icon: Activity }] : []),
    ...(canViewSystem ? [{ id: 'system', label: t('navSystem'), icon: Settings }] : []),
    ...(canViewApi ? [{ id: 'api', label: t('navApi'), icon: KeyRound }] : []),
    ...(canViewUsers ? [{ id: 'users', label: t('navUsers'), icon: UserPlus }] : []),
    ...(canViewPermissions ? [{ id: 'permissions', label: t('navPermissions'), icon: ShieldCheck }] : []),
    { id: 'profile', label: t('navProfile'), icon: UserRound }
  ], [canViewApi, canViewDepartedMembers, canViewDiscordBot, canViewDiscordKookSync, canViewKookBot, canViewPermissions, canViewRiskAlerts, canViewRustClanChat, canViewRustClanInfo, canViewSync, canViewSystem, canViewUsers, canViewWechatMiniProgram, t, user]);
  const bottomNavItems = useMemo(() => (
    canViewDataLookup ? [{ id: 'dataLookup', label: t('navDataLookup'), icon: Database }] : []
  ), [canViewDataLookup, t]);
  const navItems = useMemo(() => [...primaryNavItems, ...bottomNavItems], [bottomNavItems, primaryNavItems]);

  useEffect(() => {
    if (navItems.some((item) => item.id === active)) return;
    setActive(navItems[0]?.id || 'profile');
  }, [active, navItems]);

  useEffect(() => {
    membersRef.current = members;
  }, [members]);

  const applyMembers = useCallback((nextMembers = [], meta = {}) => {
    const normalizedMembers = Array.isArray(nextMembers) ? nextMembers : [];
    const total = Math.max(0, Number(meta.total ?? normalizedMembers.length) || 0);
    const limit = Math.max(0, Number(meta.limit ?? normalizedMembers.length) || 0);
    membersLoadedAtRef.current = Date.now();
    membersLoadedAllRef.current = !meta.paged;
    membersRef.current = normalizedMembers;
    setMemberListMeta({
      total,
      offset: Math.max(0, Number(meta.offset || 0) || 0),
      limit,
      hasMore: Boolean(meta.hasMore),
      paged: Boolean(meta.paged)
    });
    setMembers(normalizedMembers);
    return normalizedMembers;
  }, []);

  const loadMembers = useCallback(async ({ force = false, maxAgeMs = 0, limit = 0, offset = 0, append = false, q = '', squadId = '', specialty = '', vitalVipType = '', apply = true, returnPayload = false } = {}) => {
    const cachedMembers = membersRef.current;
    const pageLimit = Math.max(0, Number(limit) || 0);
    const isPagedRequest = pageLimit > 0;
    if (!isPagedRequest && !force && maxAgeMs > 0 && membersLoadedAllRef.current && cachedMembers.length && Date.now() - membersLoadedAtRef.current < maxAgeMs) {
      return cachedMembers;
    }
    const params = new URLSearchParams();
    if (isPagedRequest) {
      params.set('limit', String(pageLimit));
      params.set('offset', String(Math.max(0, Number(offset) || 0)));
    }
    if (q) params.set('q', q);
    if (squadId) params.set('squadId', squadId);
    if (specialty) params.set('specialty', specialty);
    if (vitalVipType) params.set('vitalVipType', vitalVipType);
    const payload = await api(`/api/members${params.toString() ? `?${params}` : ''}`);
    const payloadMembers = payload.members || [];
    const nextMembers = append ? mergeMemberPages(cachedMembers, payloadMembers) : payloadMembers;
    const meta = {
      total: payload.total ?? nextMembers.length,
      offset: payload.offset ?? offset,
      limit: payload.limit ?? (isPagedRequest ? pageLimit : nextMembers.length),
      hasMore: payload.hasMore,
      paged: isPagedRequest
    };
    if (!apply) return returnPayload ? { members: nextMembers, meta, payload } : nextMembers;
    const appliedMembers = applyMembers(nextMembers, meta);
    return returnPayload ? { members: appliedMembers, meta, payload } : appliedMembers;
  }, [applyMembers]);

  const replaceLoadedMember = useCallback((member) => {
    if (!member?.id) return membersRef.current;
    const currentMembers = membersRef.current;
    const nextMembers = currentMembers.some((item) => item.id === member.id)
      ? currentMembers.map((item) => (item.id === member.id ? member : item))
      : [member, ...currentMembers];
    membersLoadedAtRef.current = Date.now();
    membersRef.current = nextMembers;
    setMembers(nextMembers);
    return nextMembers;
  }, []);

  const loadSystemSettings = useCallback(async () => {
    const payload = await api('/api/settings/system');
    setSystemSettings(payload.system || { teamLogoUrl: '', proxy: { scope: 'global', url: '' } });
  }, []);

  const loadSystemBranding = useCallback(async () => {
    const payload = await api('/api/settings/branding');
    const branding = payload.system || {};
    setSystemSettings((current) => ({
      ...current,
      teamLogoUrl: branding.teamLogoUrl || '',
      teamLogoUpdatedAt: branding.teamLogoUpdatedAt || ''
    }));
  }, []);

  const loadAlertDismissals = useCallback(async () => {
    const payload = await api('/api/account-alert-dismissals');
    const nextDismissals = payload.dismissals || [];
    setAlertDismissals(nextDismissals);
    return nextDismissals;
  }, []);

  const loadAccountRiskSettings = useCallback(async () => {
    const payload = await api('/api/settings/account-risk');
    const nextSettings = payload.accountRisk || { squadFilter: '', rules: defaultAccountRiskRules(), configured: false };
    setAccountRiskSettings(nextSettings);
    return nextSettings;
  }, []);

  const reloadMembersForce = useCallback(() => loadMembers({ force: true }), [loadMembers]);
  const refreshMembersAfterRustClanImport = useCallback(() => (
    loadMembers({ force: true, limit: MEMBER_LIST_PAGE_SIZE, offset: 0 })
  ), [loadMembers]);

  const saveAccountRiskSettings = useCallback(async (nextSettings) => {
    const payload = await api('/api/settings/account-risk', {
      method: 'PUT',
      body: {
        squadFilter: nextSettings?.squadFilter || '',
        rules: accountRiskRulesOrDefault(nextSettings?.rules).map(normalizeAccountRiskRule)
      }
    });
    const savedSettings = payload.accountRisk || nextSettings;
    setAccountRiskSettings(savedSettings);
    setToast(t('riskRuleSaved'));
    return savedSettings;
  }, [t]);

  useEffect(() => {
    if (canViewSystem) loadSystemSettings().catch(() => {});
    else loadSystemBranding().catch(() => {});
    if (canViewRiskAlerts) {
      loadAlertDismissals().catch(() => {});
      loadAccountRiskSettings().catch(() => {});
    }
  }, [canViewRiskAlerts, canViewSystem, loadAccountRiskSettings, loadAlertDismissals, loadSystemBranding, loadSystemSettings]);

  useEffect(() => {
    if ((active === 'riskAlerts' && !canViewRiskAlerts) || (active !== 'riskAlerts' && active !== 'wechatMini')) return;
    loadMembers({ maxAgeMs: 15_000 }).catch(() => {});
  }, [active, canViewRiskAlerts, loadMembers]);

  useEffect(() => {
    const nextNotificationState = readMemberNotificationState(user);
    notificationStateRef.current = nextNotificationState;
    setNotificationState(nextNotificationState);
    if (canViewRiskAlerts) loadAlertDismissals().catch(() => {});
    else setAlertDismissals([]);
  }, [canViewRiskAlerts, loadAlertDismissals, user?.id, user?.username]);

  const logout = useCallback(async () => {
    await api('/api/auth/logout', { method: 'POST' });
    onUserChange(null);
  }, [onUserChange]);

  const openRustKdaLookup = useCallback((target, source) => {
    const steamInput = String(source?.steamId || source?.profileStats?.steamId || '').trim();
    if (!steamInput) {
      setToast(t('errorSteamUnrecognized'));
      return;
    }
    setRustKdaLookupRequest({ target, steamInput, id: `${target}:${steamInput}:${Date.now()}` });
    setActive('dataLookup');
  }, [t]);

  const selectNavItem = useCallback((id) => {
    setRustKdaLookupRequest(null);
    setActive(id);
  }, []);

  const shouldBuildRiskAlerts = active === 'riskAlerts' && canViewRiskAlerts;
  const dismissedAlertIds = useMemo(
    () => (shouldBuildRiskAlerts ? alertDismissalIdSet(alertDismissals) : EMPTY_SET),
    [alertDismissals, shouldBuildRiskAlerts]
  );
  const notifications = useMemo(
    () => (shouldBuildRiskAlerts
      ? buildMemberNotifications(
          members,
          t,
          lang,
          notificationState,
          dismissedAlertIds,
          currencyContext,
          accountRiskSettings?.rules || [],
          accountRiskSettings?.squadFilter || ''
        )
      : EMPTY_ARRAY),
    [accountRiskSettings?.rules, accountRiskSettings?.squadFilter, currencyContext, dismissedAlertIds, lang, members, notificationState, shouldBuildRiskAlerts, t]
  );
  const unreadNotificationCount = useMemo(
    () => notifications.reduce((count, item) => count + (item.status === 'unread' ? 1 : 0), 0),
    [notifications]
  );

  const setNotificationItemStatus = useCallback((id, status) => {
    const next = {
      ...notificationStateRef.current,
      [id]: { status, updatedAt: new Date().toISOString() }
    };
    notificationStateRef.current = next;
    setNotificationState(next);
    writeMemberNotificationState(user, next);
  }, [user]);

  const confirmAccountAlert = useCallback(async (id) => {
    const payload = await api('/api/account-alert-dismissals', { method: 'POST', body: { id } });
    setAlertDismissals(payload.dismissals || []);
    setNotificationItemStatus(id, 'done');
  }, [setNotificationItemStatus]);

  const clearAccountAlertConfirmations = useCallback(async () => {
    const payload = await api('/api/account-alert-dismissals', { method: 'DELETE' });
    setAlertDismissals(payload.dismissals || []);
    const next = Object.fromEntries(
      Object.entries(notificationStateRef.current || {}).filter(([, item]) => item?.status !== 'done')
    );
    notificationStateRef.current = next;
    setNotificationState(next);
    writeMemberNotificationState(user, next);
    return payload;
  }, [user]);

  const markNotificationRead = useCallback((id) => setNotificationItemStatus(id, 'read'), [setNotificationItemStatus]);
  const markNotificationUnread = useCallback((id) => setNotificationItemStatus(id, 'unread'), [setNotificationItemStatus]);
  const completeNotification = useCallback(
    (id) => confirmAccountAlert(id).catch((err) => setToast(localizeError(err.message, t))),
    [confirmAccountAlert, t]
  );

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <BrandMark logoUrl={teamLogoUrl} />
          <div>
            <strong>NB Clan</strong>
            <span>{user.username}</span>
          </div>
        </div>
        <nav className="nav-list" aria-label={t('navLabel')}>
          {primaryNavItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                className={cx('nav-item', active === item.id && 'active')}
                onClick={() => selectNavItem(item.id)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <nav className="nav-list sidebar-secondary-nav" aria-label={t('rustKdaInventoryLink')}>
            {bottomNavItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={cx('nav-item', active === item.id && 'active')}
                  onClick={() => selectNavItem(item.id)}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </nav>
          <button className="ghost-button sidebar-logout" onClick={logout}>
            <LogOut size={18} />
            {t('logout')}
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <span className="eyebrow">NB Clan</span>
          </div>
          <div className="topbar-actions">
            <LanguageSwitcher lang={lang} setLang={setLang} t={t} />
            <ThemeSwitcher themeMode={themeMode} setThemeMode={setThemeMode} t={t} />
            <button type="button" className="user-chip user-chip-button" title={t('logout')} onClick={logout}>
              <UserRound size={16} />
              <span>{user.steamNickname || user.username}</span>
              <LogOut size={14} />
            </button>
          </div>
        </header>

        {active === 'query' && canViewModule(user, 'query') && (
          <React.Suspense fallback={<PageLoadingState title={t('navQuery')} t={t} compact />}>
            <QueryView setToast={setToast} lang={lang} t={t} />
          </React.Suspense>
        )}
        {active === 'dataLookup' && canViewDataLookup && (
          <React.Suspense fallback={<PageLoadingState title={t('navDataLookup')} t={t} compact />}>
            <DataLookupView user={user} lang={lang} t={t} setToast={setToast} lookupRequest={rustKdaLookupRequest} />
          </React.Suspense>
        )}
        {active === 'members' && canViewModule(user, 'members') && (
          <React.Suspense fallback={<PageLoadingState title={t('navMembers')} t={t} compact />}>
            <MembersView
              user={user}
              members={members}
              memberListMeta={memberListMeta}
              loadMembers={loadMembers}
              reload={reloadMembersForce}
              applyMembers={applyMembers}
              replaceMember={replaceLoadedMember}
              setToast={setToast}
              lang={lang}
              t={t}
              onOpenRustKdaLookup={openRustKdaLookup}
              pageSize={MEMBER_LIST_PAGE_SIZE}
            />
          </React.Suspense>
        )}
        {active === 'departedMembers' && canViewDepartedMembers && (
          <React.Suspense fallback={<PageLoadingState title={t('navDepartedMembers')} t={t} compact />}>
            <DepartedMembersView
              lang={lang}
              t={t}
              setToast={setToast}
              canEdit={canEditDepartedMembers && user.role !== 'viewer'}
              canDelete={canEditModule(user, 'members') && user.role !== 'viewer'}
              onMembersUpdated={reloadMembersForce}
            />
          </React.Suspense>
        )}
        {active === 'riskAlerts' && canViewRiskAlerts && (
          <React.Suspense fallback={<PageLoadingState title={t('notificationPanelTitle')} t={t} compact />}>
            <HighRiskAccountAlertsView
              user={user}
              members={members}
              notifications={notifications}
              unreadCount={unreadNotificationCount}
              dismissedAlertIds={dismissedAlertIds}
              accountRiskSettings={accountRiskSettings}
              lang={lang}
              t={t}
              setToast={setToast}
              reload={reloadMembersForce}
              applyMembers={applyMembers}
              onMarkRead={markNotificationRead}
              onMarkUnread={markNotificationUnread}
              onComplete={canConfirmRiskAlerts ? completeNotification : null}
              onConfirmAlert={canConfirmRiskAlerts ? (id) => confirmAccountAlert(id) : null}
              onClearConfirmations={canConfirmRiskAlerts ? clearAccountAlertConfirmations : null}
              onSaveAccountRiskSettings={saveAccountRiskSettings}
              onOpenRustKdaLookup={openRustKdaLookup}
            />
          </React.Suspense>
        )}
        {active === 'squads' && canViewModule(user, 'squads') && (
          <React.Suspense fallback={<PageLoadingState title={t('navSquads')} t={t} compact />}>
            <SquadsView
              user={user}
              setToast={setToast}
              lang={lang}
              t={t}
              onOpenRustKdaLookup={openRustKdaLookup}
            />
          </React.Suspense>
        )}
        {active === 'server' && canViewModule(user, 'server') && (
          <React.Suspense fallback={<PageLoadingState title={t('navServer')} t={t} compact />}>
            <ServerView
              user={user}
              setToast={setToast}
              lang={lang}
              t={t}
              onOpenRustKdaLookup={openRustKdaLookup}
            />
          </React.Suspense>
        )}
        {active === 'rustClanInfo' && canViewRustClanInfo && (
          <React.Suspense fallback={<PageLoadingState title={t('navRustClanInfo')} t={t} compact />}>
            <RustplusClanInfoView
              lang={lang}
              setToast={setToast}
              t={t}
              canEdit={canEditRustClanInfo}
              canImportMember={canImportRustClanMember}
              onMembersUpdated={refreshMembersAfterRustClanImport}
            />
          </React.Suspense>
        )}
        {active === 'rustClanChat' && canViewRustClanChat && (
          <React.Suspense fallback={<PageLoadingState title={t('navRustClanChat')} t={t} compact />}>
            <RustplusClanChatView lang={lang} setToast={setToast} t={t} canEdit={canEditRustClanChat} />
          </React.Suspense>
        )}
        {active === 'kda' && canViewModule(user, 'kda') && (
          <React.Suspense fallback={<PageLoadingState title={t('kdaData')} t={t} compact />}>
            <KdaView
              user={user}
              lang={lang}
              t={t}
              setToast={setToast}
              onOpenRustKdaLookup={openRustKdaLookup}
            />
          </React.Suspense>
        )}
        {active === 'history' && canViewModule(user, 'history') && (
          <React.Suspense fallback={<PageLoadingState title={t('history')} t={t} compact />}>
            <HistoryView
              user={user}
              lang={lang}
              t={t}
              setToast={setToast}
              onOpenRustKdaLookup={openRustKdaLookup}
              StatusBadge={StatusBadge}
            />
          </React.Suspense>
        )}
        {active === 'wechatMini' && canViewWechatMiniProgram && (
          <React.Suspense fallback={<PageLoadingState title={t('wechatMiniProgram')} t={t} compact />}>
            <WechatMiniProgramView
              lang={lang}
              t={t}
              setToast={setToast}
              user={user}
              members={members}
              onMembersUpdated={reloadMembersForce}
              onOpenRustKdaLookup={openRustKdaLookup}
              canManageReviews={canManageWechatMiniProgram}
            />
          </React.Suspense>
        )}
        {active === 'discordBot' && (canViewDiscordBot || canViewKookBot) && (
          <React.Suspense fallback={<PageLoadingState title={t('discordBotManagement')} t={t} compact />}>
            <DiscordBotSettingsView
              lang={lang}
              setToast={setToast}
              t={t}
              canViewDiscord={canViewDiscordBot}
              canEditDiscord={canEditDiscordBot}
              canViewKook={canViewKookBot}
              canEditKook={canEditKookBot}
            />
          </React.Suspense>
        )}
        {active === 'discordKookSync' && canViewDiscordKookSync && (
          <React.Suspense fallback={<PageLoadingState title={t('discordKookSyncTitle')} t={t} compact />}>
            <DiscordKookBridgeView
              lang={lang}
              setToast={setToast}
              t={t}
              canEdit={canEditDiscordKookSync}
              isRoot={isRootAccount}
            />
          </React.Suspense>
        )}
        {active === 'logs' && canViewModule(user, 'logs') && (
          <React.Suspense fallback={<PageLoadingState title={t('logsTitle')} t={t} compact />}>
            <LogsView lang={lang} t={t} />
          </React.Suspense>
        )}
        {active === 'sync' && canViewSync && (
          <React.Suspense fallback={<PageLoadingState title={t('navSyncCenter')} t={t} compact />}>
            <SyncCenterPanel lang={lang} setToast={setToast} t={t} canEdit={canEditSync} />
          </React.Suspense>
        )}
        {active === 'system' && canViewSystem && (
          <React.Suspense fallback={<PageLoadingState title={t('systemSettings')} t={t} compact />}>
            <SystemSettingsView
              lang={lang}
              setToast={setToast}
              systemSettings={systemSettings}
              onSystemUpdated={setSystemSettings}
              t={t}
              canEditProxy={isRootAccount && canEditSystem}
              canEditBranding={canEditSystem}
            />
          </React.Suspense>
        )}
        {active === 'api' && canViewApi && (
          <React.Suspense fallback={<PageLoadingState title={t('apiSettings')} t={t} compact />}>
            <ApiSettingsView lang={lang} setToast={setToast} t={t} canEdit={isRootAccount && canEditApi} />
          </React.Suspense>
        )}
        {active === 'users' && canViewUsers && (
          <React.Suspense fallback={<PageLoadingState title={t('navUsers')} t={t} compact />}>
            <UsersView user={user} setToast={setToast} t={t} canEdit={canEditUsers} />
          </React.Suspense>
        )}
        {active === 'permissions' && canViewPermissions && (
          <React.Suspense fallback={<PageLoadingState title={t('navPermissions')} t={t} compact />}>
            <PermissionsView user={user} setToast={setToast} t={t} canEdit={canEditPermissions} />
          </React.Suspense>
        )}
        {active === 'profile' && (
          <React.Suspense fallback={<PageLoadingState title={t('navProfile')} t={t} compact />}>
            <ProfileView user={user} onUserChange={onUserChange} setToast={setToast} t={t} />
          </React.Suspense>
        )}
      </main>
      <ToastMessage toast={toast} />
    </div>
  );
}
