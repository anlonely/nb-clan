import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BadgeCheck,
  CheckSquare,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Settings,
  Square,
  Trash2,
  UserRound,
  X
} from 'lucide-react';
import { api } from '../../shared/api.js';
import {
  formatCopy,
  formatStatNumber,
  formatTime,
  localizeError
} from '../../shared/format.js';
import { canEditModule } from '../../shared/permissions.js';
import {
  ACCOUNT_RISK_RULE_TYPE_OPTIONS,
  ACCOUNT_RISK_UNASSIGNED_SQUAD_FILTER,
  PRIVATE_ACCOUNT_ALERT_TYPE,
  PRIVATE_INVENTORY_ALERT_TYPE,
  PRIVATE_PLAY_TIME_ALERT_TYPE,
  accountAlertId,
  accountRiskOperatorOptionsForType,
  accountRiskRuleMatches,
  accountRiskRuleNeedsThreshold,
  accountRiskRuleOperatorOption,
  accountRiskRuleTitle,
  accountRiskRuleTypeOption,
  accountRiskRulesOrDefault,
  alertDismissedMemberIdSet,
  defaultAccountRiskOperator,
  highRiskRulesOnly,
  memberMatchesRiskSquadFilter,
  memberNotificationName,
  normalizeAccountRiskRule,
  riskRuleAppliesToMember,
  shouldShowPrivateInventoryAlert,
  shouldShowPrivatePlayTimeAlert
} from '../../shared/risk-alerts.js';
import {
  deferPollWhileHidden,
  schedulePollTimeout,
  syncUiStateFromServer
} from '../../shared/sync-status.js';
import { Avatar } from '../../shared/member/Avatar.jsx';
import {
  MemberEditor,
  MemberProfileModal
} from '../../shared/member/dialogs.jsx';
import { Alert } from '../../shared/ui/Alert.jsx';
import { ModalFrame } from '../../shared/ui/ModalFrame.jsx';
import { cx } from '../../shared/ui/cx.js';

function RiskMemberLink({ member, name, onOpenMember, onConfirm, t, compact = false }) {
  const targetMember = member || {};
  const displayName = name || memberNotificationName(targetMember);
  return (
    <div className={cx('risk-member-link', compact && 'compact')}>
      <button
        type="button"
        className="risk-member-name-button"
        title={t('openMemberProfile')}
        onClick={() => onOpenMember(targetMember)}
      >
        <Avatar member={targetMember} />
        <span>{displayName}</span>
      </button>
      <button
        type="button"
        className="ghost-button mini-button risk-member-view-button"
        title={t('openMemberProfile')}
        onClick={() => onOpenMember(targetMember)}
      >
        <UserRound size={13} />
        <span>{t('viewMemberProfileShort')}</span>
      </button>
      {onConfirm && (
        <button
          type="button"
          className="ghost-button mini-button risk-member-confirm-button"
          title={t('notificationConfirm')}
          onClick={() => onConfirm(targetMember)}
        >
          <CheckSquare size={13} />
          <span>{t('notificationConfirm')}</span>
        </button>
      )}
    </div>
  );
}

function PrivateDataMemberList({ members, emptyText, onOpenMember, onConfirm, t }) {
  return (
    <div className="private-data-account-list">
      {members.length ? members.map((member) => (
        <RiskMemberLink key={member.id} member={member} onOpenMember={onOpenMember} onConfirm={onConfirm} t={t} compact />
      )) : (
        <div className="notification-empty">{emptyText}</div>
      )}
    </div>
  );
}

function RiskAlertDetectionPanel({
  status,
  uiState,
  lastDetectionAt,
  canDetect,
  squads,
  accountRiskSettings,
  onSaveAccountRiskSettings,
  onOpenRuleSettings,
  onDetect,
  onStopDetect,
  t,
  lang,
  error
}) {
  const isDetecting = uiState === 'syncing';
  const [savingFilter, setSavingFilter] = useState(false);
  const squadOptions = useMemo(
    () => [
      { id: '', name: t('riskRuleAllSquads') },
      { id: ACCOUNT_RISK_UNASSIGNED_SQUAD_FILTER, name: t('unassignedSquad') },
      ...(squads || []).map((squad) => ({ id: squad.id, name: squad.name || squad.id }))
    ],
    [squads, t]
  );

  async function changeSquadFilter(event) {
    const squadFilter = event.target.value;
    setSavingFilter(true);
    try {
      await onSaveAccountRiskSettings({
        squadFilter,
        rules: accountRiskRulesOrDefault(accountRiskSettings?.rules)
      });
    } finally {
      setSavingFilter(false);
    }
  }

  return (
    <section className="tool-panel risk-detection-panel">
      <div className="risk-detection-controls">
        <label className="risk-squad-filter-control">
          <span>{t('riskRuleSquadFilter')}</span>
          <select
            value={accountRiskSettings?.squadFilter || ''}
            onChange={changeSquadFilter}
            disabled={!canDetect || savingFilter || isDetecting}
          >
            {squadOptions.map((option) => (
              <option key={option.id || 'all'} value={option.id}>{option.name}</option>
            ))}
          </select>
        </label>
        <div className="risk-detection-meta">
          <span>{t('riskAlertLastDetection')}</span>
          <strong>{formatTime(lastDetectionAt, lang) || t('notSyncedYet')}</strong>
          {isDetecting && (
            <small>{formatStatNumber(status.completed || 0, lang)} / {formatStatNumber(status.requested || 0, lang)}</small>
          )}
          {error && <small className="danger-text">{error}</small>}
        </div>
      </div>
      {canDetect && (
        <div className="risk-detection-actions">
          <button type="button" className="ghost-button risk-rule-open-button" onClick={onOpenRuleSettings}>
            <Settings size={16} />
            <span>{t('riskRuleSettingsTitle')}</span>
          </button>
          <button
            type="button"
            className={cx('primary-button sync-kda-button profile-sync-button', isDetecting && 'syncing', uiState === 'complete' && 'complete', uiState === 'error' && 'error')}
            onClick={onDetect}
            disabled={isDetecting}
          >
            <RefreshCw size={17} />
            <span>{isDetecting ? t('riskAlertDetecting') : t('riskAlertDetect')}</span>
          </button>
          {isDetecting && (
            <button type="button" className="ghost-button danger" onClick={onStopDetect}>
              <Square size={16} />
              <span>{t('riskAlertStopDetect')}</span>
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function emptyAccountRiskRuleDraft(t) {
  const type = 'playtime_hours';
  return {
    id: '',
    name: t('riskRuleNewName'),
    type,
    operator: defaultAccountRiskOperator(type),
    threshold: 500,
    squadFilter: '',
    enabled: true
  };
}

function RiskRuleSettingsPanel({ accountRiskSettings, squads, members, canManage, onSave, t, lang }) {
  const currentRules = useMemo(
    () => highRiskRulesOnly(accountRiskSettings?.rules),
    [accountRiskSettings?.rules]
  );
  const [editingRule, setEditingRule] = useState(null);
  const [saving, setSaving] = useState(false);
  const globalSquadFilter = accountRiskSettings?.squadFilter || '';

  const squadOptions = useMemo(
    () => [
      { id: '', name: t('riskRuleAllSquads') },
      { id: ACCOUNT_RISK_UNASSIGNED_SQUAD_FILTER, name: t('unassignedSquad') },
      ...(squads || []).map((squad) => ({ id: squad.id, name: squad.name || squad.id }))
    ],
    [squads, t]
  );
  const squadNameById = useMemo(
    () => new Map(squadOptions.map((option) => [option.id, option.name])),
    [squadOptions]
  );

  const hitCountByRuleId = useMemo(() => {
    const counts = new Map();
    currentRules.forEach((rule) => {
      const count = (members || []).filter((member) => riskRuleAppliesToMember(rule, member, globalSquadFilter) && accountRiskRuleMatches(rule, member)).length;
      counts.set(rule.id, count);
    });
    return counts;
  }, [currentRules, globalSquadFilter, members]);

  async function saveRiskSettings(nextRules = currentRules, nextSquadFilter = globalSquadFilter) {
    if (!canManage) return;
    setSaving(true);
    try {
      await onSave({
        squadFilter: nextSquadFilter,
        rules: nextRules.map(normalizeAccountRiskRule)
      });
      setEditingRule(null);
    } finally {
      setSaving(false);
    }
  }

  function startAddRule() {
    setEditingRule(emptyAccountRiskRuleDraft(t));
  }

  function startEditRule(rule) {
    setEditingRule({ ...normalizeAccountRiskRule(rule) });
  }

  function updateEditingRule(patch) {
    setEditingRule((current) => {
      const base = current || emptyAccountRiskRuleDraft(t);
      const next = { ...base, ...patch };
      if (patch.type) {
        next.operator = defaultAccountRiskOperator(patch.type);
        if (!accountRiskRuleNeedsThreshold(patch.type)) next.threshold = 0;
      }
      return next;
    });
  }

  async function submitRule(event) {
    event.preventDefault();
    if (!editingRule) return;
    const ruleId = editingRule.id || `risk_rule_${Date.now()}`;
    const nextRule = normalizeAccountRiskRule({ ...editingRule, id: ruleId });
    const exists = currentRules.some((rule) => rule.id === nextRule.id);
    const nextRules = exists
      ? currentRules.map((rule) => (rule.id === nextRule.id ? nextRule : rule))
      : [nextRule, ...currentRules];
    await saveRiskSettings(nextRules);
  }

  async function toggleRule(rule) {
    const nextRules = currentRules.map((item) => (item.id === rule.id ? { ...item, enabled: !item.enabled } : item));
    await saveRiskSettings(nextRules);
  }

  async function deleteRule(rule) {
    if (!window.confirm(t('riskRuleDeleteConfirm').replace('{name}', accountRiskRuleTitle(rule, t)))) return;
    const nextRules = currentRules.filter((item) => item.id !== rule.id);
    await saveRiskSettings(nextRules);
  }

  function formatRuleCondition(rule) {
    if (rule.type === 'account_restricted') return t('riskRuleAccountRestrictedConditionSummary');
    if (rule.type === 'steam_ban_or_restriction') return t('riskRuleSteamBanOrRestrictionConditionSummary');
    if (rule.type === 'unassigned_squad') return t('riskRuleUnassignedConditionSummary');
    return [
      t(accountRiskRuleTypeOption(rule.type).labelKey),
      t(accountRiskRuleOperatorOption(rule.operator).labelKey),
      accountRiskRuleNeedsThreshold(rule.type) ? formatStatNumber(rule.threshold, lang, { maximumFractionDigits: 2 }) : ''
    ].filter(Boolean).join(' · ');
  }

  function formatRuleScope(rule) {
    return squadNameById.get(rule.squadFilter || '') || rule.squadFilter || t('riskRuleAllSquads');
  }

  function renderRuleForm() {
    if (!editingRule) return null;
    const thresholdVisible = accountRiskRuleNeedsThreshold(editingRule.type);
    const operatorOptions = accountRiskOperatorOptionsForType(editingRule.type);
    const selectedOperator = operatorOptions.some((option) => option.value === editingRule.operator)
      ? editingRule.operator
      : defaultAccountRiskOperator(editingRule.type);

    return (
      <form className="risk-rule-form risk-rule-inline-form" onSubmit={submitRule}>
        <div className="risk-rule-form-grid">
          <label>
            <span>{t('riskRuleName')}</span>
            <input value={editingRule.name} onChange={(event) => updateEditingRule({ name: event.target.value })} disabled={!canManage || saving} />
          </label>
          <label>
            <span>{t('riskRuleType')}</span>
            <select value={editingRule.type} onChange={(event) => updateEditingRule({ type: event.target.value })} disabled={!canManage || saving}>
              {ACCOUNT_RISK_RULE_TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('riskRuleOperator')}</span>
            <select value={selectedOperator} onChange={(event) => updateEditingRule({ operator: event.target.value })} disabled={!canManage || saving || !thresholdVisible}>
              {operatorOptions.map((option) => (
                <option key={option.value} value={option.value}>{t(option.labelKey)}</option>
              ))}
            </select>
          </label>
          <label>
            <span>{t('riskRuleThreshold')}</span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={editingRule.threshold}
              onChange={(event) => updateEditingRule({ threshold: event.target.value })}
              disabled={!canManage || saving || !thresholdVisible}
            />
          </label>
          <label>
            <span>{t('riskRuleApplySquad')}</span>
            <select value={editingRule.squadFilter || ''} onChange={(event) => updateEditingRule({ squadFilter: event.target.value })} disabled={!canManage || saving}>
              {squadOptions.map((option) => (
                <option key={option.id || 'all'} value={option.id}>{option.name}</option>
              ))}
            </select>
          </label>
          <label className="risk-rule-enabled-control">
            <input
              type="checkbox"
              checked={editingRule.enabled !== false}
              onChange={(event) => updateEditingRule({ enabled: event.target.checked })}
              disabled={!canManage || saving}
            />
            <span>{t('riskRuleEnabled')}</span>
          </label>
        </div>
        <div className="risk-rule-form-actions">
          <button type="submit" className="primary-button" disabled={!canManage || saving}>
            <Save size={15} />
            <span>{t('riskRuleSave')}</span>
          </button>
          <button type="button" className="ghost-button" onClick={() => setEditingRule(null)} disabled={saving}>
            <X size={15} />
            <span>{t('riskRuleCancel')}</span>
          </button>
        </div>
      </form>
    );
  }

  const isCreatingRule = Boolean(editingRule && !editingRule.id);

  return (
    <div className="risk-rule-settings-panel">
      <div className="risk-rule-modal-summary">
        {canManage && (
          <button type="button" className="primary-button" onClick={startAddRule} disabled={saving}>
            <Plus size={15} />
            <span>{t('riskRuleAdd')}</span>
          </button>
        )}
      </div>

      <div className="risk-rule-list">
        {isCreatingRule && (
          <article className="risk-rule-row editing new">
            <div className="risk-rule-row-head">
              <div className="risk-rule-main">
                <strong>{t('riskRuleFormTitleAdd')}</strong>
                <span>{formatRuleCondition(editingRule)}</span>
                <small>
                  <span>{formatRuleScope(editingRule)}</span>
                  <span className="risk-rule-status-pill enabled">{t('riskRuleEnabled')}</span>
                </small>
              </div>
            </div>
            {renderRuleForm()}
          </article>
        )}
        {currentRules.length ? currentRules.map((rule) => {
            const isEditing = editingRule?.id === rule.id;
            return (
              <article key={rule.id} className={cx('risk-rule-row', isEditing && 'editing', !rule.enabled && 'disabled')}>
                <div className="risk-rule-row-head">
                  <div className="risk-rule-main">
                    <strong>{accountRiskRuleTitle(rule, t)}</strong>
                    <span>{formatRuleCondition(rule)}</span>
                    <small>
                      <span>{formatCopy(t('riskRuleHits'), { count: formatStatNumber(hitCountByRuleId.get(rule.id) || 0, lang) })}</span>
                      <span>{formatRuleScope(rule)}</span>
                      <span className={cx('risk-rule-status-pill', rule.enabled ? 'enabled' : 'disabled')}>
                        {rule.enabled ? t('riskRuleEnabled') : t('riskRuleDisabled')}
                      </span>
                    </small>
                  </div>
                  {canManage && (
                    <div className="risk-rule-actions">
                      <button
                        type="button"
                        className={cx('ghost-button mini-button risk-rule-toggle-button', rule.enabled ? 'enabled' : 'disabled')}
                        onClick={() => toggleRule(rule)}
                        disabled={saving}
                      >
                        {rule.enabled ? <CheckSquare size={13} /> : <Square size={13} />}
                        <span>{rule.enabled ? t('riskRuleDisable') : t('riskRuleEnable')}</span>
                      </button>
                      {!isEditing && (
                        <button type="button" className="ghost-button mini-button" onClick={() => startEditRule(rule)} disabled={saving}>
                          <Pencil size={13} />
                          <span>{t('riskRuleEdit')}</span>
                        </button>
                      )}
                      <button type="button" className="ghost-button mini-button danger" onClick={() => deleteRule(rule)} disabled={saving}>
                        <Trash2 size={13} />
                        <span>{t('riskRuleDelete')}</span>
                      </button>
                    </div>
                  )}
                </div>
                {isEditing && renderRuleForm()}
              </article>
            );
          }) : !isCreatingRule ? (
          <div className="notification-empty">{t('riskRuleNoRules')}</div>
        ) : null}
      </div>
    </div>
  );
}

function HighRiskAccountAlertsView({
  user,
  members,
  notifications,
  unreadCount,
  dismissedAlertIds,
  accountRiskSettings,
  lang,
  t,
  setToast,
  reload,
  applyMembers,
  onMarkRead,
  onMarkUnread,
  onComplete,
  onConfirmAlert,
  onClearConfirmations,
  onSaveAccountRiskSettings,
  onOpenRustKdaLookup = null
}) {
  const [profileMember, setProfileMember] = useState(null);
  const [editing, setEditing] = useState(null);
  const [squads, setSquads] = useState([]);
  const [profileSyncStatus, setProfileSyncStatus] = useState({});
  const [detectionError, setDetectionError] = useState('');
  const [ruleSettingsOpen, setRuleSettingsOpen] = useState(false);
  const [clearingConfirmations, setClearingConfirmations] = useState(false);
  const detectionPollRef = useRef(null);
  const detectionReloadKeyRef = useRef('');
  const accountRiskSquadFilter = accountRiskSettings?.squadFilter || '';
  const dismissedMemberIds = useMemo(
    () => alertDismissedMemberIdSet(Array.from(dismissedAlertIds, (id) => {
      const [memberId, ...rest] = String(id || '').split(':');
      return { id, memberId, type: rest.join(':') };
    })),
    [dismissedAlertIds]
  );
  const privateInventoryMembers = useMemo(
    () => (members || []).filter((member) => (
      memberMatchesRiskSquadFilter(member, accountRiskSquadFilter)
      && shouldShowPrivateInventoryAlert(member)
      && !dismissedMemberIds.has(member.id)
      && !dismissedAlertIds.has(accountAlertId(member.id, PRIVATE_ACCOUNT_ALERT_TYPE))
      && !dismissedAlertIds.has(accountAlertId(member.id, PRIVATE_INVENTORY_ALERT_TYPE))
    )),
    [accountRiskSquadFilter, dismissedAlertIds, dismissedMemberIds, members]
  );
  const privatePlayTimeMembers = useMemo(
    () => (members || []).filter((member) => (
      memberMatchesRiskSquadFilter(member, accountRiskSquadFilter)
      && shouldShowPrivatePlayTimeAlert(member)
      && !dismissedMemberIds.has(member.id)
      && !dismissedAlertIds.has(accountAlertId(member.id, PRIVATE_ACCOUNT_ALERT_TYPE))
      && !dismissedAlertIds.has(accountAlertId(member.id, PRIVATE_PLAY_TIME_ALERT_TYPE))
    )),
    [accountRiskSquadFilter, dismissedAlertIds, dismissedMemberIds, members]
  );
  const canManageAccountRisk = canEditModule(user, 'riskAlerts');
  const profileSyncUiState = syncUiStateFromServer(profileSyncStatus);
  const lastDetectionAt = profileSyncStatus.syncedAt || profileSyncStatus.updatedAt || profileSyncStatus.startedAt || '';

  useEffect(() => {
    api('/api/member-options')
      .then((payload) => setSquads(payload.squads || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadDetectionStatus().catch(() => {});
    return () => {
      if (detectionPollRef.current) clearTimeout(detectionPollRef.current);
    };
  }, []);

  async function loadDetectionStatus() {
    const payload = await api('/api/sync-status?kind=memberProfiles');
    setProfileSyncStatus(payload.syncState?.memberProfiles || {});
  }

  async function pollDetectionStatus({ reloadOnFinish = false } = {}) {
    if (detectionPollRef.current) {
      clearTimeout(detectionPollRef.current);
      detectionPollRef.current = null;
    }
    if (deferPollWhileHidden(
      detectionPollRef,
      () => pollDetectionStatus({ reloadOnFinish }).catch(() => {}),
      1500
    )) return;
    try {
      const payload = await api('/api/sync-status?kind=memberProfiles');
      const status = payload.syncState?.memberProfiles || {};
      setProfileSyncStatus(status);
      if (syncUiStateFromServer(status) === 'syncing') {
        const reloadKey = [
          status.updatedAt || '',
          status.completed || 0,
          status.updated || 0,
          status.failed || 0,
          status.profileCompleted || 0,
          status.accountRestrictionCompleted || 0
        ].join(':');
        if (reloadOnFinish && reloadKey !== detectionReloadKeyRef.current) {
          detectionReloadKeyRef.current = reloadKey;
          await reload();
        }
        schedulePollTimeout(detectionPollRef, () => pollDetectionStatus({ reloadOnFinish }).catch(() => {}), 1500);
        return;
      }
      if (reloadOnFinish) {
        detectionReloadKeyRef.current = '';
        await reload();
        setToast(t(status.status === 'failed' ? 'memberProfileSyncFailed' : 'riskAlertDetectDone'));
      }
    } catch {
      // Detection status polling is best-effort.
    }
  }

  async function detectAccountRisk() {
    if (!canManageAccountRisk || profileSyncUiState === 'syncing') return;
    setDetectionError('');
    detectionReloadKeyRef.current = '';
    setProfileSyncStatus({
      status: 'running',
      requested: members.length,
      completed: 0,
      updated: 0,
      failed: 0,
      percent: 0,
      etaSeconds: Math.max(3, members.length * 2),
      startedAt: new Date().toISOString()
    });
    try {
      const payload = await api('/api/settings/member-profiles/sync', { method: 'POST', body: {} });
      const status = payload.syncState || {};
      setProfileSyncStatus(status);
      setToast(t('riskAlertDetectQueued'));
      if (syncUiStateFromServer(status) === 'syncing') {
        schedulePollTimeout(detectionPollRef, () => pollDetectionStatus({ reloadOnFinish: true }).catch(() => {}), 1200);
      } else {
        await reload();
        setToast(t('riskAlertDetectDone'));
      }
    } catch (err) {
      const message = localizeError(err.message, t);
      setDetectionError(message);
      setProfileSyncStatus((current) => ({ ...current, status: 'failed', error: message, updatedAt: new Date().toISOString() }));
    }
  }

  async function stopAccountRiskDetection() {
    if (!canManageAccountRisk || profileSyncUiState !== 'syncing') return;
    try {
      const payload = await api('/api/settings/member-profiles/sync/cancel', { method: 'POST', body: {} });
      const status = payload.syncState?.memberProfiles || payload.syncState || {};
      setProfileSyncStatus(status);
      setToast(t('riskAlertDetectStopped'));
      await reload();
    } catch (err) {
      setDetectionError(localizeError(err.message, t));
    }
  }

  async function confirmPrivateAlert(member, type = PRIVATE_ACCOUNT_ALERT_TYPE) {
    try {
      await onConfirmAlert(accountAlertId(member.id, type));
      setToast(t('notificationConfirmed'));
    } catch (err) {
      setToast(localizeError(err.message, t));
    }
  }

  async function clearAllConfirmations() {
    if (!onClearConfirmations || clearingConfirmations) return;
    if (typeof window !== 'undefined' && !window.confirm(t('riskAlertClearConfirmationsConfirm'))) return;
    setClearingConfirmations(true);
    try {
      await onClearConfirmations();
      setToast(t('riskAlertConfirmationsCleared'));
      await reload();
    } catch (err) {
      setToast(localizeError(err.message, t));
    } finally {
      setClearingConfirmations(false);
    }
  }

  async function refreshSelectedMember() {
    const nextMembers = await reload();
    if (profileMember?.id && Array.isArray(nextMembers)) {
      const nextProfileMember = nextMembers.find((member) => member.id === profileMember.id);
      if (nextProfileMember) setProfileMember(nextProfileMember);
    }
  }

  return (
    <section className="page-stack risk-alerts-page">
      <RiskAlertDetectionPanel
        status={profileSyncStatus}
        uiState={profileSyncUiState}
        lastDetectionAt={lastDetectionAt}
        canDetect={canManageAccountRisk}
        squads={squads}
        accountRiskSettings={accountRiskSettings}
        onSaveAccountRiskSettings={onSaveAccountRiskSettings}
        onOpenRuleSettings={() => setRuleSettingsOpen(true)}
        onDetect={detectAccountRisk}
        onStopDetect={stopAccountRiskDetection}
        t={t}
        lang={lang}
        error={detectionError}
      />

      <div className="risk-alerts-layout">
        <section className="tool-panel risk-alert-panel">
          <div className="section-heading compact-heading">
            <div className="heading-stack">
              <h3>{t('notificationPanelTitle')}</h3>
              <small>{t('notificationCount').replace('{count}', unreadCount)}</small>
            </div>
            {onClearConfirmations && (
              <div className="risk-alert-heading-actions">
                <button
                  type="button"
                  className="ghost-button mini-button danger risk-alert-clear-button"
                  onClick={clearAllConfirmations}
                  disabled={clearingConfirmations}
                >
                  <Trash2 size={14} />
                  <span>{t('riskAlertClearConfirmations')}</span>
                </button>
              </div>
            )}
          </div>
          {notifications.length ? (
            <div className="notification-list inline-list">
              {notifications.map((item) => (
                <article key={item.id} className={cx('notification-item', item.status === 'unread' && 'unread')}>
                  <div className="notification-item-main">
                    <div className="notification-item-title">
                      <RiskMemberLink
                        member={item.member}
                        name={item.memberName}
                        onOpenMember={setProfileMember}
                        onConfirm={onComplete ? () => onComplete(item.id) : null}
                        t={t}
                      />
                      <span className={cx('notification-status', item.status)}>
                        {item.status === 'unread' ? t('notificationUnread') : t('notificationRead')}
                      </span>
                    </div>
                    <strong className="notification-risk-title">{item.title}</strong>
                    <p>{item.detail}</p>
                  </div>
                  <div className="notification-actions">
                    {item.status === 'unread' ? (
                      <button type="button" className="ghost-button mini-button" onClick={() => onMarkRead(item.id)}>
                        <BadgeCheck size={14} />
                        <span>{t('notificationMarkRead')}</span>
                      </button>
                    ) : (
                      <button type="button" className="ghost-button mini-button" onClick={() => onMarkUnread(item.id)}>
                        <Square size={14} />
                        <span>{t('notificationMarkUnread')}</span>
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="notification-empty">{t('noHighRiskAccounts')}</div>
          )}
        </section>

        <section className="tool-panel private-data-panel">
          <div className="section-heading compact-heading">
            <div className="heading-stack">
              <h3>{t('privateDataAccounts')}</h3>
              <small>{t('privateData')}</small>
            </div>
          </div>
          <div className="private-data-grid">
            <div className="private-data-column">
              <div className="private-data-column-head">
                <strong>{t('privateInventoryAccounts')}</strong>
                <span>{formatStatNumber(privateInventoryMembers.length, lang)}</span>
              </div>
              <PrivateDataMemberList
                members={privateInventoryMembers}
                emptyText={t('noPrivateDataAccounts')}
                onOpenMember={setProfileMember}
                onConfirm={onConfirmAlert ? (member) => confirmPrivateAlert(member, PRIVATE_INVENTORY_ALERT_TYPE) : null}
                t={t}
              />
            </div>
            <div className="private-data-column">
              <div className="private-data-column-head">
                <strong>{t('privatePlayTimeAccounts')}</strong>
                <span>{formatStatNumber(privatePlayTimeMembers.length, lang)}</span>
              </div>
              <PrivateDataMemberList
                members={privatePlayTimeMembers}
                emptyText={t('noPrivateDataAccounts')}
                onOpenMember={setProfileMember}
                onConfirm={onConfirmAlert ? (member) => confirmPrivateAlert(member, PRIVATE_PLAY_TIME_ALERT_TYPE) : null}
                t={t}
              />
            </div>
          </div>
        </section>
      </div>

      {editing && (
        <MemberEditor
          member={editing}
          squads={squads}
          t={t}
          onClose={() => setEditing(null)}
          onSaved={async (payload) => {
            setEditing(null);
            setProfileMember(null);
            setToast(t('memberUpdated'));
            if (payload?.members && applyMembers) {
              applyMembers(payload.members);
            } else {
              await reload();
            }
          }}
        />
      )}

      {ruleSettingsOpen && (
        <ModalFrame className="wide-modal risk-rule-settings-modal" labelledBy="risk-rule-settings-title" onClose={() => setRuleSettingsOpen(false)}>
          <div className="modal-title">
            <div>
              <h3 id="risk-rule-settings-title">{t('riskRuleSettingsTitle')}</h3>
              <span className="modal-subtitle">{t('riskRuleSettingsHint')}</span>
            </div>
            <button type="button" className="icon-button" onClick={() => setRuleSettingsOpen(false)} title={t('close')}>
              <X size={18} />
            </button>
          </div>
          <RiskRuleSettingsPanel
            accountRiskSettings={accountRiskSettings}
            squads={squads}
            members={members}
            canManage={canManageAccountRisk}
            onSave={onSaveAccountRiskSettings}
            t={t}
            lang={lang}
          />
        </ModalFrame>
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
          onMemberUpdated={refreshSelectedMember}
          canSyncOnline={canManageAccountRisk}
          onOpenRustKdaLookup={onOpenRustKdaLookup}
          onClose={() => setProfileMember(null)}
        />
      )}
    </section>
  );
}

export default HighRiskAccountAlertsView;
