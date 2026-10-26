import React, { useEffect, useMemo, useState } from 'react';
import { Clipboard, MapPinned, Plus, RefreshCw, Save, Send, Settings, Trash2 } from 'lucide-react';
import { api } from '../../shared/api.js';
import { copyText } from '../../shared/browser.js';
import { formatTime, localizeError } from '../../shared/format.js';
import { Alert } from '../../shared/ui/Alert.jsx';
import { InfoGrid } from '../../shared/ui/InfoGrid.jsx';
import { ModalFrame } from '../../shared/ui/ModalFrame.jsx';
import { cx } from '../../shared/ui/cx.js';
import {
  DISCORD_COMMAND_FIELD_MAP,
  DISCORD_PUSH_CARD_CONFIG,
  DiscordPushCardModal,
  KOOK_COMMAND_FIELD_MAP,
  BotCollapsibleHeader,
  botCommandTypeLabel,
  botTemplateBodyRows,
  createDiscordRoleSquadRuleDraft,
  createDiscordTargetDraft,
  discordFormFromPayload,
  discordPushCardLanguage,
  discordSettingsSavePayload,
  kookFormFromPayload,
  kookSettingsSavePayload,
  normalizeDiscordCommandDefinitions,
  normalizeDiscordTargetCommandIds,
  normalizeKookCommandIds,
  normalizeKookEventDefinitions
} from '../../shared/bot/settings.jsx';

function DiscordBotSettingsView({
  lang,
  setToast,
  t,
  canViewDiscord = false,
  canEditDiscord = false,
  canViewKook = false,
  canEditKook = false
}) {
  const [settings, setSettings] = useState({ discord: null, kook: null });
  const [form, setForm] = useState(() => discordFormFromPayload(null, t));
  const [kookForm, setKookForm] = useState(() => kookFormFromPayload(null, t));
  const [squads, setSquads] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [kookSaving, setKookSaving] = useState(false);
  const [busyAction, setBusyAction] = useState('');
  const [pushCardModal, setPushCardModal] = useState(null);
  const [configModal, setConfigModal] = useState(null);
  const [openBotSections, setOpenBotSections] = useState({ commands: false, channels: true, kookChannels: false });
  const [editingCommandId, setEditingCommandId] = useState('');
  const [editingKookEventId, setEditingKookEventId] = useState('');
  const [error, setError] = useState('');
  const discordInteractionsEndpoint = useMemo(() => {
    const endpointPath = settings.discord?.interactionsEndpoint || '/api/integrations/discord/interactions';
    if (typeof window === 'undefined') return endpointPath;
    return `${window.location.origin}${endpointPath}`;
  }, [settings.discord?.interactionsEndpoint]);
  const kookEventsEndpoint = useMemo(() => {
    const endpointPath = settings.kook?.eventEndpoint || '/api/integrations/kook/events';
    if (/^https?:\/\//i.test(endpointPath)) return endpointPath;
    if (typeof window === 'undefined') return endpointPath;
    return `${window.location.origin}${endpointPath}`;
  }, [settings.kook?.eventEndpoint]);
  const savedTargetIds = useMemo(
    () => new Set((settings.discord?.targets || []).map((target) => target.id).filter(Boolean)),
    [settings.discord?.targets]
  );

  async function load() {
    setLoading(true);
    setError('');
    try {
      const [payload, squadsPayload] = await Promise.all([
        api('/api/settings/api'),
        canViewDiscord ? api('/api/squads').catch(() => ({ squads: [] })) : Promise.resolve({ squads: [] })
      ]);
      const nextSquads = squadsPayload.squads || [];
      setSquads(nextSquads);
      setSettings({
        discord: canViewDiscord ? payload.discord : null,
        kook: canViewKook ? payload.kook : null
      });
      if (canViewDiscord) setForm(discordFormFromPayload(payload.discord, t, nextSquads));
      if (canViewKook) setKookForm(kookFormFromPayload(payload.kook, t));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load().catch(() => {});
  }, []);

  function updateTarget(index, patch) {
    setForm((current) => ({
      ...current,
      targets: current.targets.map((target, targetIndex) => (targetIndex === index ? { ...target, ...patch } : target))
    }));
  }

  function toggleBotSection(section) {
    setOpenBotSections((current) => ({ ...current, [section]: !current[section] }));
  }

  function addDiscordCommandDefinition() {
    const id = `custom_${Date.now().toString(36)}`;
    const command = {
      id,
      name: t('botNewCommandName'),
      type: 'persistent_card',
      typeLabel: t('botCommandTypeCard'),
      slashCommand: '',
      titleTemplate: '',
      bodyTemplate: '',
      channelFields: [],
      requiresChannelId: false,
      requiresRoleRules: false,
      supportsPush: false,
      pushType: '',
      editableTemplate: true,
      custom: true
    };
    setForm((current) => ({
      ...current,
      commandDefinitions: [...normalizeDiscordCommandDefinitions(current.commandDefinitions, t, current), command]
    }));
    setEditingCommandId(id);
  }

  function updateDiscordCommandDefinition(commandId, patch) {
    setForm((current) => {
      const definitions = normalizeDiscordCommandDefinitions(current.commandDefinitions, t, current);
      const next = {
        ...current,
        ...(commandId === 'wipe' && Object.hasOwn(patch, 'slashCommand') ? { commandHint: patch.slashCommand } : {}),
        ...(commandId === 'wipe' && Object.hasOwn(patch, 'titleTemplate') ? { templateTitle: patch.titleTemplate } : {}),
        ...(commandId === 'wipe' && Object.hasOwn(patch, 'bodyTemplate') ? { templateBody: patch.bodyTemplate } : {})
      };
      return {
        ...next,
        commandDefinitions: definitions.map((command) => {
          if (command.id !== commandId) return command;
          const type = patch.type || command.type;
          return { ...command, ...patch, type, typeLabel: botCommandTypeLabel(type, t) };
        })
      };
    });
  }

  function removeDiscordCommandDefinition(commandId) {
    setForm((current) => ({
      ...current,
      commandDefinitions: normalizeDiscordCommandDefinitions(current.commandDefinitions, t, current).filter((command) => command.id !== commandId),
      targets: current.targets.map((target) => ({
        ...target,
        enabledCommandIds: normalizeDiscordTargetCommandIds(target.enabledCommandIds, target).filter((id) => id !== commandId)
      }))
    }));
    if (editingCommandId === commandId) setEditingCommandId('');
  }

  async function deleteDiscordCommandDefinition(commandId) {
    if (!canEditDiscord || saving) return;
    const nextForm = {
      ...form,
      commandDefinitions: normalizeDiscordCommandDefinitions(form.commandDefinitions, t, form).filter((command) => command.id !== commandId),
      targets: form.targets.map((target) => ({
        ...target,
        enabledCommandIds: normalizeDiscordTargetCommandIds(target.enabledCommandIds, target).filter((id) => id !== commandId)
      }))
    };
    setForm(nextForm);
    if (editingCommandId === commandId) setEditingCommandId('');
    await saveDiscordSettingsDraft(nextForm);
  }

  function addKookEventDefinition() {
    const id = `kook_custom_${Date.now().toString(36)}`;
    const event = {
      id,
      name: t('botNewKookEventName'),
      type: 'event_card',
      typeLabel: t('botCommandTypeEvent'),
      slashCommand: '',
      titleTemplate: '',
      bodyTemplate: '',
      channelFields: [],
      requiresChannelId: false,
      requiresRoleRules: false,
      supportsPush: false,
      pushType: '',
      editableTemplate: true,
      custom: true
    };
    setKookForm((current) => ({
      ...current,
      eventDefinitions: [...normalizeKookEventDefinitions(current.eventDefinitions, t), event]
    }));
    setEditingKookEventId(id);
  }

  function updateKookEventDefinition(eventId, patch) {
    setKookForm((current) => ({
      ...current,
      eventDefinitions: normalizeKookEventDefinitions(current.eventDefinitions, t).map((event) => {
        if (event.id !== eventId) return event;
        const type = patch.type || event.type;
        return { ...event, ...patch, type, typeLabel: botCommandTypeLabel(type, t) };
      })
    }));
  }

  function removeKookEventDefinition(eventId) {
    setKookForm((current) => ({
      ...current,
      eventDefinitions: normalizeKookEventDefinitions(current.eventDefinitions, t).filter((event) => event.id !== eventId),
      enabledCommandIds: normalizeKookCommandIds(current.enabledCommandIds, current).filter((id) => id !== eventId)
    }));
    if (editingKookEventId === eventId) setEditingKookEventId('');
  }

  async function deleteKookEventDefinition(eventId) {
    if (!canEditKook || kookSaving) return;
    const nextForm = {
      ...kookForm,
      eventDefinitions: normalizeKookEventDefinitions(kookForm.eventDefinitions, t).filter((event) => event.id !== eventId),
      enabledCommandIds: normalizeKookCommandIds(kookForm.enabledCommandIds, kookForm).filter((id) => id !== eventId)
    };
    setKookForm(nextForm);
    if (editingKookEventId === eventId) setEditingKookEventId('');
    await saveKookSettingsDraft(nextForm);
  }

  function updateTargetRegisterRule(targetIndex, ruleIndex, patch) {
    setForm((current) => ({
      ...current,
      targets: current.targets.map((target, index) => {
        if (index !== targetIndex) return target;
        const rules = target.memberRegisterRoleSquadRules?.length ? target.memberRegisterRoleSquadRules : [createDiscordRoleSquadRuleDraft()];
        return {
          ...target,
          memberRegisterRoleSquadRules: rules.map((rule, currentRuleIndex) => (
            currentRuleIndex === ruleIndex ? { ...rule, ...patch } : rule
          ))
        };
      })
    }));
  }

  function addTargetRegisterRule(targetIndex) {
    setForm((current) => ({
      ...current,
      targets: current.targets.map((target, index) => (index === targetIndex
        ? { ...target, memberRegisterRoleSquadRules: [...(target.memberRegisterRoleSquadRules || []), createDiscordRoleSquadRuleDraft()] }
        : target))
    }));
  }

  function removeTargetRegisterRule(targetIndex, ruleIndex) {
    setForm((current) => ({
      ...current,
      targets: current.targets.map((target, index) => {
        if (index !== targetIndex) return target;
        const nextRules = (target.memberRegisterRoleSquadRules || []).filter((_, currentRuleIndex) => currentRuleIndex !== ruleIndex);
        return { ...target, memberRegisterRoleSquadRules: nextRules.length ? nextRules : [createDiscordRoleSquadRuleDraft()] };
      })
    }));
  }

  function addTarget() {
    setForm((current) => ({
      ...current,
      targets: [...current.targets, createDiscordTargetDraft(t, current.targets.length)]
    }));
  }

  function removeTarget(index) {
    setForm((current) => {
      if (current.targets.length <= 1) return current;
      return {
        ...current,
        targets: current.targets.filter((_, targetIndex) => targetIndex !== index)
      };
    });
  }

  function toggleTargetCommand(index, commandId, enabled) {
    setForm((current) => ({
      ...current,
      targets: current.targets.map((target, targetIndex) => {
        if (targetIndex !== index) return target;
        const commandDefinition = normalizeDiscordCommandDefinitions(current.commandDefinitions, t, current).find((command) => command.id === commandId);
        const currentIds = normalizeDiscordTargetCommandIds(target.enabledCommandIds, target);
        const nextIds = enabled
          ? normalizeDiscordTargetCommandIds([...currentIds, commandId], target)
          : currentIds.filter((id) => id !== commandId);
        const clearedFields = enabled
          ? {}
          : Object.fromEntries(((commandDefinition?.channelFields || []).map((field) => field.key).length
            ? commandDefinition.channelFields.map((field) => field.key)
            : (DISCORD_COMMAND_FIELD_MAP[commandId] || [])).map((field) => [field, '']));
        return {
          ...target,
          ...clearedFields,
          enabledCommandIds: nextIds
        };
      })
    }));
  }

  function toggleKookCommand(commandId, enabled) {
    setKookForm((current) => {
      const commandDefinition = normalizeKookEventDefinitions(current.eventDefinitions, t).find((command) => command.id === commandId);
      const currentIds = normalizeKookCommandIds(current.enabledCommandIds, current);
      const nextIds = enabled
        ? normalizeKookCommandIds([...currentIds, commandId], current)
        : currentIds.filter((id) => id !== commandId);
      const clearedFields = enabled
        ? {}
        : Object.fromEntries(((commandDefinition?.channelFields || []).map((field) => field.key).length
          ? commandDefinition.channelFields.map((field) => field.key)
          : (KOOK_COMMAND_FIELD_MAP[commandId] || [])).map((field) => [field, '']));
      return {
        ...current,
        ...clearedFields,
        enabledCommandIds: nextIds
      };
    });
  }

  async function saveDiscordSettings() {
    return saveDiscordSettingsDraft(form);
  }

  async function saveDiscordSettingsDraft(nextForm = form) {
    if (!canEditDiscord || saving) return false;
    setSaving(true);
    setError('');
    try {
      const payload = await api('/api/settings/discord', { method: 'PUT', body: discordSettingsSavePayload(nextForm, squads) });
      setSettings((current) => ({ ...current, discord: payload.discord }));
      setForm(discordFormFromPayload(payload.discord, t, squads));
      setToast(t('discordSettingsSaved'));
      return true;
    } catch (err) {
      setError(localizeError(err.message, t));
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function saveKookSettings() {
    return saveKookSettingsDraft(kookForm);
  }

  async function saveKookSettingsDraft(nextForm = kookForm) {
    if (!canEditKook || kookSaving) return false;
    setKookSaving(true);
    setError('');
    try {
      const payload = await api('/api/settings/kook', { method: 'PUT', body: kookSettingsSavePayload(nextForm) });
      setSettings((current) => ({ ...current, kook: payload.kook }));
      setKookForm(kookFormFromPayload(payload.kook, t));
      setToast(t('kookSettingsSaved'));
      return true;
    } catch (err) {
      setError(localizeError(err.message, t));
      return false;
    } finally {
      setKookSaving(false);
    }
  }

  async function registerDiscordCommands(target) {
    const key = `${target.id}:commands`;
    if (!canEditDiscord || busyAction) return;
    setBusyAction(key);
    setError('');
    try {
      const payload = await api('/api/settings/discord/commands', { method: 'POST', body: { targetId: target.id } });
      setSettings((current) => ({ ...current, discord: payload.discord }));
      setForm(discordFormFromPayload(payload.discord, t, squads));
      setToast(t('discordCommandsRegistered'));
    } catch (err) {
      setError(localizeError(err.message, t));
    } finally {
      setBusyAction('');
    }
  }

  async function loadDiscordTargetCardPreview(target, type, language, mentionEveryone = true) {
    const config = DISCORD_PUSH_CARD_CONFIG[type];
    if (!config) return;
    const nextLanguage = discordPushCardLanguage(language);
    const targetId = target?.id || config.platform || 'default';
    setPushCardModal((current) => current ? { ...current, language: nextLanguage, mentionEveryone, loading: true, error: '' } : current);
    try {
      const payload = await api(config.previewEndpoint, {
        method: 'POST',
        body: {
          ...(config.platform === 'kook' ? {} : { targetId }),
          language: nextLanguage,
          ...(type === 'wipe' ? { mentionEveryone } : {})
        }
      });
      setPushCardModal((current) => (
        current && current.type === type && (current.target?.id || config.platform || 'default') === targetId
          ? { ...current, language: discordPushCardLanguage(payload.language || nextLanguage), mentionEveryone, preview: payload.preview || null, loading: false, error: '' }
          : current
      ));
    } catch (err) {
      setPushCardModal((current) => (
        current && current.type === type && (current.target?.id || config.platform || 'default') === targetId
          ? { ...current, loading: false, error: localizeError(err.message, t) }
          : current
      ));
    }
  }

  function openDiscordTargetCardPreview(target, type) {
    const config = DISCORD_PUSH_CARD_CONFIG[type];
    const canEditTarget = config?.platform === 'kook' ? canEditKook : canEditDiscord;
    if (!config || !canEditTarget || busyAction) return;
    const language = discordPushCardLanguage(lang);
    setError('');
    setPushCardModal({
      type,
      target,
      language,
      mentionEveryone: true,
      preview: null,
      loading: true,
      pushing: false,
      error: ''
    });
    loadDiscordTargetCardPreview(target, type, language, true).catch(() => {});
  }

  async function pushDiscordTargetCard(target, type, language, mentionEveryone = true) {
    const config = DISCORD_PUSH_CARD_CONFIG[type];
    const canEditTarget = config?.platform === 'kook' ? canEditKook : canEditDiscord;
    const targetId = target?.id || config?.platform || 'default';
    const key = `${targetId}:${type}`;
    if (!config || !canEditTarget || busyAction) return;
    setBusyAction(key);
    setError('');
    setPushCardModal((current) => current ? { ...current, pushing: true, error: '' } : current);
    try {
      const payload = await api(config.pushEndpoint, {
        method: 'POST',
        body: {
          ...(config.platform === 'kook' ? {} : { targetId }),
          language: discordPushCardLanguage(language),
          ...(type === 'wipe' ? { mentionEveryone } : {})
        }
      });
      const url = payload.message?.url || '';
      if (payload.discord) {
        setSettings((current) => ({ ...current, discord: payload.discord }));
        setForm(discordFormFromPayload(payload.discord, t, squads));
      }
      if (payload.kook) {
        setSettings((current) => ({ ...current, kook: payload.kook }));
        setKookForm(kookFormFromPayload(payload.kook, t));
      }
      setPushCardModal(null);
      setToast(url ? t(config.toastKeys[1]) : t(config.toastKeys[0]));
      if (url) window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setPushCardModal((current) => current ? { ...current, error: localizeError(err.message, t) } : current);
    } finally {
      setBusyAction('');
      setPushCardModal((current) => current ? { ...current, pushing: false } : current);
    }
  }

  async function saveBotSettings() {
    return Promise.all([
      canViewDiscord && canEditDiscord ? saveDiscordSettings() : Promise.resolve(),
      canViewKook && canEditKook ? saveKookSettings() : Promise.resolve()
    ]);
  }

  const targets = form.targets.length ? form.targets : [createDiscordTargetDraft(t, 0)];
  const discordCommandDefinitions = useMemo(
    () => normalizeDiscordCommandDefinitions(form.commandDefinitions, t, form),
    [form.commandDefinitions, form.commandHint, form.templateBody, form.templateTitle, t]
  );
  const kookCommandDefinitions = useMemo(
    () => normalizeKookEventDefinitions(kookForm.eventDefinitions, t),
    [kookForm.eventDefinitions, t]
  );
  const discordConfiguredChannelCount = targets.reduce((count, target) => {
    const values = ['channelId', 'memberRegisterChannelId', 'memberReviewChannelId', 'mapChannelId', 'kdaQueryChannelId', 'memberRankingChannelId']
      .map((field) => target[field])
      .filter(Boolean);
    return count + values.length;
  }, 0);
  const latestDiscordCommandSync = targets
    .map((target) => target.lastCommandRegisterAt)
    .filter(Boolean)
    .sort()
    .at(-1);
  const latestDiscordPush = targets
    .flatMap((target) => [target.lastPushAt, target.lastMemberRegisterPushAt, target.lastMemberRankingPushAt, target.lastMapPushAt])
    .filter(Boolean)
    .sort()
    .at(-1);
  const discordStatusItems = [
    [t('botTokenStatus'), settings.discord?.tokenMasked ? t('discordConfigured') : t('discordNotConfigured')],
    [t('botEndpointStatus'), discordInteractionsEndpoint],
    [t('botTargetCount'), String(targets.length)],
    [t('botConfiguredChannelCount'), String(discordConfiguredChannelCount)],
    [t('botCommandSyncStatus'), formatTime(latestDiscordCommandSync, lang) || t('notSyncedYet')],
    [t('botPushSyncStatus'), formatTime(latestDiscordPush, lang) || t('notSyncedYet')],
    [t('botLastUpdatedAt'), formatTime(settings.discord?.updatedAt, lang) || '-']
  ];
  const kookConfiguredChannelCount = ['channelId', 'memberRegisterChannelId', 'kdaQueryChannelId', 'memberRankingChannelId']
    .map((field) => kookForm[field])
    .filter(Boolean)
    .length;
  const kookStatusItems = [
    [t('botTokenStatus'), settings.kook?.tokenMasked ? t('kookConfigured') : t('kookNotConfigured')],
    [t('botEndpointStatus'), kookEventsEndpoint],
    [t('botConfiguredChannelCount'), String(kookConfiguredChannelCount)],
    [t('botPushSyncStatus'), formatTime(settings.kook?.lastPushAt, lang) || t('notSyncedYet')],
    [t('kookMemberRankingLastRefreshAt'), formatTime(settings.kook?.lastMemberRankingRefreshAt, lang) || t('notSyncedYet')],
    [t('discordLastPushError'), settings.kook?.lastPushError || '-'],
    [t('botLastUpdatedAt'), formatTime(settings.kook?.updatedAt, lang) || '-']
  ];

  return (
    <section className="page-stack discord-bot-page bot-management-page">
      <div className="section-heading compact-heading bot-page-heading">
        <div className="heading-stack">
          <h3>{t('discordBotManagement')}</h3>
          <p>{t('discordBotManagementHint')}</p>
        </div>
        <div className="heading-actions">
          <button type="button" className="ghost-button fit-button" disabled={loading} onClick={load}>
            <RefreshCw size={17} />
            <span>{t('refresh')}</span>
          </button>
          {canViewDiscord && (
            <button type="button" className="ghost-button fit-button" onClick={() => setConfigModal('discord')}>
              <Settings size={17} />
              <span>{t('botDiscordConfig')}</span>
            </button>
          )}
          {canViewKook && (
            <button type="button" className="ghost-button fit-button" onClick={() => setConfigModal('kook')}>
              <Settings size={17} />
              <span>{t('botKookConfig')}</span>
            </button>
          )}
          <button type="button" className="primary-button fit-button" disabled={saving || kookSaving || (!canEditDiscord && !canEditKook)} onClick={saveBotSettings}>
            <Save size={17} />
            <span>{saving || kookSaving ? t('saving') : t('botSaveAllSettings')}</span>
          </button>
        </div>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="bot-status-grid">
        {canViewDiscord && (
          <section className="tool-panel bot-status-panel">
            <div className="bot-platform-title">
              <div>
                <span className={cx('status-badge', settings.discord?.enabled ? 'complete' : 'pending')}>{settings.discord?.enabled ? t('discordConfigured') : t('discordNotConfigured')}</span>
                <h3>Discord</h3>
              </div>
              <button type="button" className="action-button" onClick={() => copyText(discordInteractionsEndpoint, setToast, t)} title={t('copyEndpoint')}>
                <Clipboard size={16} />
                <span>{t('copyEndpoint')}</span>
              </button>
            </div>
            <InfoGrid items={discordStatusItems} />
          </section>
        )}
        {canViewKook && (
          <section className="tool-panel bot-status-panel">
            <div className="bot-platform-title">
              <div>
                <span className={cx('status-badge', settings.kook?.enabled ? 'complete' : 'pending')}>{settings.kook?.enabled ? t('kookConfigured') : t('kookNotConfigured')}</span>
                <h3>KOOK</h3>
              </div>
              <button type="button" className="action-button" onClick={() => copyText(kookEventsEndpoint, setToast, t)} title={t('copyEndpoint')}>
                <Clipboard size={16} />
                <span>{t('copyEndpoint')}</span>
              </button>
            </div>
            <InfoGrid items={kookStatusItems} />
          </section>
        )}
      </div>

      {canViewDiscord && (
        <section className="tool-panel bot-command-panel">
          <BotCollapsibleHeader
            title={t('botCommandSettings')}
            description={t('discordGlobalSettingsHint')}
            open={openBotSections.commands}
            onToggle={() => toggleBotSection('commands')}
          />
          {openBotSections.commands && (
            <>
              <div className="bot-command-grid">
                {discordCommandDefinitions.map((command) => (
                    <article key={command.id} className="bot-command-card">
                      <div className="bot-command-head">
                        <div>
                          <h4>{command.name}</h4>
                        </div>
                        <div className="bot-command-card-actions">
                          <button type="button" className="action-button" disabled={!canEditDiscord || saving} onClick={() => saveDiscordSettingsDraft(form)}>
                            <Save size={16} />
                            <span>{saving ? t('saving') : t('save')}</span>
                          </button>
                          <button type="button" className="action-button danger" disabled={!canEditDiscord || saving} onClick={() => deleteDiscordCommandDefinition(command.id)}>
                            <Trash2 size={16} />
                            <span>{t('delete')}</span>
                          </button>
                        </div>
                      </div>
                      <div className="bot-command-template-grid">
                        <label>
                          <span>{t('botCommandName')}</span>
                          <input value={command.name} onChange={(event) => updateDiscordCommandDefinition(command.id, { name: event.target.value })} maxLength={120} disabled={!canEditDiscord} />
                        </label>
                        <label>
                          <span>{t('discordCommandHint')}</span>
                          <input value={command.slashCommand} onChange={(event) => updateDiscordCommandDefinition(command.id, { slashCommand: event.target.value })} maxLength={120} disabled={!canEditDiscord} />
                        </label>
                        <label>
                          <span>{t('discordTemplateTitle')}</span>
                          <input value={command.titleTemplate} onChange={(event) => updateDiscordCommandDefinition(command.id, { titleTemplate: event.target.value })} maxLength={220} disabled={!canEditDiscord} />
                        </label>
                        <label className="span-2 discord-template-body">
                          <span>{t('discordTemplateBody')}</span>
                          <textarea value={command.bodyTemplate} rows={botTemplateBodyRows(command.bodyTemplate)} onChange={(event) => updateDiscordCommandDefinition(command.id, { bodyTemplate: event.target.value })} maxLength={3000} disabled={!canEditDiscord} />
                        </label>
                      </div>
                    </article>
                ))}
              </div>
              <p className="form-hint">{t('discordTemplateVarsHint')}</p>
            </>
          )}
        </section>
      )}

      {canViewDiscord && (
        <section className="bot-channel-section">
          <BotCollapsibleHeader
            title={t('botChannelSettings')}
            description={t('botChannelSettingsHint')}
            open={openBotSections.channels}
            onToggle={() => toggleBotSection('channels')}
            actions={(
              <button type="button" className="ghost-button fit-button" disabled={!canEditDiscord} onClick={addTarget}>
                <Plus size={17} />
                <span>{t('discordAddTarget')}</span>
              </button>
            )}
          />
          {openBotSections.channels && (
          <div className="discord-target-grid">
            {targets.map((target, index) => {
              const key = target.id || `target-${index}`;
              const targetCommandIds = normalizeDiscordTargetCommandIds(target.enabledCommandIds, target);
              const targetCommands = discordCommandDefinitions.filter((command) => targetCommandIds.includes(command.id));
              const configured = Boolean(target.guildId && targetCommands.some((command) => command.channelFields?.some((field) => target[field.key])));
              const targetSaved = savedTargetIds.has(target.id);
              return (
                <div key={key} className="tool-panel discord-target-card bot-channel-card">
                  <div className="discord-target-card-head">
                    <div>
                      <span className={cx('status-badge', configured ? 'complete' : 'pending')}>{configured ? t('discordConfigured') : t('discordNotConfigured')}</span>
                      <h3>{target.name || t('discordNewTargetName')}</h3>
                    </div>
                    <div className="row-actions">
                      <button type="button" className="action-button" disabled={!canEditDiscord || Boolean(busyAction) || !targetSaved || !form.applicationId || !target.guildId} onClick={() => registerDiscordCommands(target)}>
                        <RefreshCw size={16} />
                        <span>{busyAction === `${target.id}:commands` ? t('discordRegisteringCommands') : t('discordRegisterCommands')}</span>
                      </button>
                      <button type="button" className="action-button danger" disabled={!canEditDiscord || targets.length <= 1} onClick={() => removeTarget(index)} title={t('remove')}>
                        <Trash2 size={16} />
                        <span>{t('remove')}</span>
                      </button>
                    </div>
                  </div>

                  <div className="discord-target-form bot-channel-base-form">
                    <label>
                      <span>{t('discordTargetName')}</span>
                      <input value={target.name || ''} onChange={(event) => updateTarget(index, { name: event.target.value })} maxLength={80} disabled={!canEditDiscord} />
                    </label>
                    <label>
                      <span>{t('discordGuildId')}</span>
                      <input value={target.guildId || ''} onChange={(event) => updateTarget(index, { guildId: event.target.value })} maxLength={32} placeholder={t('discordGuildIdPlaceholder')} autoComplete="off" disabled={!canEditDiscord} />
                    </label>
                  </div>

                  <div className="bot-command-picker">
                    <strong>{t('botAddedCommands')}</strong>
                    <div className="bot-command-choice-grid">
                      {discordCommandDefinitions.map((command) => (
                        <label key={command.id} className="bot-command-choice">
                          <input type="checkbox" checked={targetCommandIds.includes(command.id)} onChange={(event) => toggleTargetCommand(index, command.id, event.target.checked)} disabled={!canEditDiscord} />
                          <span>{command.name}</span>
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="bot-target-command-list">
                    {targetCommands.map((command) => {
                      const pushKey = command.pushType ? `${target.id}:${command.pushType}` : '';
                      const pushDisabled = !command.pushType || !canEditDiscord || Boolean(busyAction) || !targetSaved || !command.channelFields?.some((field) => target[field.key]);
                      const pushLabel = command.pushType === 'wipe'
                        ? (busyAction === pushKey ? t('pushingDiscord') : t('pushDiscord'))
                        : command.pushType === 'member'
                          ? (busyAction === pushKey ? t('pushingDiscordMemberRegistrationCard') : t('pushDiscordMemberRegistrationCard'))
                          : command.pushType === 'ranking'
                            ? (busyAction === pushKey ? t('pushingDiscordMemberRankingCard') : t('pushDiscordMemberRankingCard'))
                            : command.pushType === 'map'
                              ? (busyAction === pushKey ? t('pushingDiscordMapCard') : t('pushDiscordMapCard'))
                              : t('botNoPushAction');
                      return (
                        <section key={command.id} className="bot-target-command-block">
                          <div className="bot-target-command-head">
                            <div>
                              <span className="status-badge neutral">{command.typeLabel}</span>
                              <h4>{command.name}</h4>
                            </div>
                            {command.pushType ? (
                              <button type="button" className={cx('primary-button fit-button discord-push-button', command.pushType === 'wipe' && 'wipe-card', command.pushType === 'map' && 'map-card')} disabled={pushDisabled} onClick={() => openDiscordTargetCardPreview(target, command.pushType)}>
                                {command.pushType === 'map' ? <MapPinned size={17} /> : <Send size={17} />}
                                <span>{pushLabel}</span>
                              </button>
                            ) : (
                              <span className="status-badge neutral">{t('botNoPushAction')}</span>
                            )}
                          </div>
                          <div className="bot-command-channel-grid">
                            {(command.channelFields || []).map((field) => (
                              <React.Fragment key={field.key}>
                                <label>
                                  <span>{field.label}</span>
                                  <input value={target[field.key] || ''} onChange={(event) => updateTarget(index, { [field.key]: event.target.value })} maxLength={32} placeholder={field.placeholder} autoComplete="off" disabled={!canEditDiscord} />
                                </label>
                                {field.nameKey && (
                                  <label>
                                    <span>{t('discordChannelName')}</span>
                                    <input className="discord-resolved-name" value={target[field.nameKey] || ''} placeholder={t('discordMetadataNotResolved')} readOnly aria-readonly="true" />
                                  </label>
                                )}
                              </React.Fragment>
                            ))}
                            {command.requiresRoleRules && (
                              <label>
                                <span>{t('discordMemberManageRoleId')}</span>
                                <input value={target.memberManageRoleId || ''} onChange={(event) => updateTarget(index, { memberManageRoleId: event.target.value })} maxLength={512} placeholder={t('discordMemberManageRoleIdPlaceholder')} autoComplete="off" disabled={!canEditDiscord} />
                              </label>
                            )}
                          </div>
                          {command.requiresRoleRules && (
                            <div className="discord-register-rule-editor">
                              <div className="discord-register-rule-head">
                                <div>
                                  <strong>{t('discordRegisterSquadRules')}</strong>
                                  <small>{t('discordRegisterSquadRulesHint')}</small>
                                </div>
                                <button type="button" className="ghost-button fit-button" disabled={!canEditDiscord} onClick={() => addTargetRegisterRule(index)}>
                                  <Plus size={16} />
                                  <span>{t('discordAddRegisterSquadRule')}</span>
                                </button>
                              </div>
                              {(target.memberRegisterRoleSquadRules?.length ? target.memberRegisterRoleSquadRules : [createDiscordRoleSquadRuleDraft()]).map((rule, ruleIndex) => (
                                <div className="discord-register-rule-row" key={rule.id || ruleIndex}>
                                  <label>
                                    <span>{t('discordRegisterRuleRoleId')}</span>
                                    <input value={rule.roleId || ''} onChange={(event) => updateTargetRegisterRule(index, ruleIndex, { roleId: event.target.value })} maxLength={32} placeholder={t('discordMemberRegisterRoleIdPlaceholder')} autoComplete="off" disabled={!canEditDiscord} />
                                  </label>
                                  <label>
                                    <span>{t('discordRoleName')}</span>
                                    <input className="discord-resolved-name" value={rule.roleName || ''} placeholder={t('discordMetadataNotResolved')} readOnly aria-readonly="true" />
                                  </label>
                                  <label>
                                    <span>{t('discordRegisterRuleSquad')}</span>
                                    <select value={rule.squadId || ''} onChange={(event) => updateTargetRegisterRule(index, ruleIndex, { squadId: event.target.value })} disabled={!canEditDiscord}>
                                      <option value="">{t('selectSquad')}</option>
                                      {squads.map((squad) => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
                                    </select>
                                  </label>
                                  <button type="button" className="action-button danger" disabled={!canEditDiscord} onClick={() => removeTargetRegisterRule(index, ruleIndex)} title={t('remove')}>
                                    <Trash2 size={16} />
                                    <span>{t('remove')}</span>
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </section>
                      );
                    })}
                  </div>

                  <InfoGrid className="bot-channel-status-grid" items={[
                    [t('discordCommandLastRegisteredAt'), formatTime(target.lastCommandRegisterAt, lang) || t('notSyncedYet')],
                    [t('discordCommandLastError'), target.lastCommandRegisterError || '-'],
                    [t('discordLastPushAt'), formatTime(target.lastPushAt, lang) || t('notSyncedYet')],
                    [t('discordMemberRegisterLastPushAt'), formatTime(target.lastMemberRegisterPushAt, lang) || t('notSyncedYet')],
                    [t('discordMemberRankingLastPushAt'), formatTime(target.lastMemberRankingPushAt, lang) || t('notSyncedYet')],
                    [t('discordMapLastPushAt'), formatTime(target.lastMapPushAt, lang) || t('notSyncedYet')],
                    [t('discordMetadataSyncedAt'), formatTime(target.discordMetadataSyncedAt, lang) || t('notSyncedYet')],
                    [t('discordMetadataSyncError'), target.discordMetadataSyncError || '-'],
                    [t('discordMemberRankingLastRefreshAt'), formatTime(target.lastMemberRankingRefreshAt, lang) || t('notSyncedYet')],
                    [t('discordMemberRankingLastRefreshError'), target.lastMemberRankingRefreshError || '-'],
                    [t('discordLastPushError'), target.lastPushError || '-']
                  ]} />
                </div>
              );
            })}
          </div>
          )}
        </section>
      )}

      {canViewKook && (
        <section className="tool-panel bot-command-panel kook-bot-panel">
          <BotCollapsibleHeader
            title={t('botKookChannelConfig')}
            description={t('kookGlobalSettingsHint')}
            open={openBotSections.kookChannels}
            onToggle={() => toggleBotSection('kookChannels')}
            actions={(
              <button type="button" className="primary-button fit-button discord-push-button" disabled={!canEditKook || Boolean(busyAction) || !settings.kook?.enabled || !kookForm.memberRankingChannelId} onClick={() => openDiscordTargetCardPreview({ id: 'kook', name: 'KOOK' }, 'kookRanking')}>
                <Send size={17} />
                <span>{busyAction === 'kook:kookRanking' ? t('pushingKookMemberRankingCard') : t('pushKookMemberRankingCard')}</span>
              </button>
            )}
          />
          {openBotSections.kookChannels && (
            <>
              <div className="bot-command-grid">
                {kookCommandDefinitions.map((command) => (
                    <article key={command.id} className="bot-command-card">
                      <div className="bot-command-head">
                        <div>
                          <h4>{command.name}</h4>
                        </div>
                        <div className="bot-command-card-actions">
                          <button type="button" className="action-button" disabled={!canEditKook || kookSaving} onClick={() => saveKookSettingsDraft(kookForm)}>
                            <Save size={16} />
                            <span>{kookSaving ? t('saving') : t('save')}</span>
                          </button>
                          <button type="button" className="action-button danger" disabled={!canEditKook || kookSaving} onClick={() => deleteKookEventDefinition(command.id)}>
                            <Trash2 size={16} />
                            <span>{t('delete')}</span>
                          </button>
                        </div>
                      </div>
                      <div className="bot-command-template-grid">
                        <label>
                          <span>{t('botCommandName')}</span>
                          <input value={command.name} onChange={(event) => updateKookEventDefinition(command.id, { name: event.target.value })} maxLength={120} disabled={!canEditKook} />
                        </label>
                        <label>
                          <span>{t('discordCommandHint')}</span>
                          <input value={command.slashCommand} onChange={(event) => updateKookEventDefinition(command.id, { slashCommand: event.target.value })} maxLength={120} disabled={!canEditKook} />
                        </label>
                        <label>
                          <span>{t('discordTemplateTitle')}</span>
                          <input value={command.titleTemplate} onChange={(event) => updateKookEventDefinition(command.id, { titleTemplate: event.target.value })} maxLength={220} disabled={!canEditKook} />
                        </label>
                        <label className="span-2 discord-template-body">
                          <span>{t('discordTemplateBody')}</span>
                          <textarea value={command.bodyTemplate} rows={botTemplateBodyRows(command.bodyTemplate)} onChange={(event) => updateKookEventDefinition(command.id, { bodyTemplate: event.target.value })} maxLength={1500} disabled={!canEditKook} />
                        </label>
                      </div>
                    </article>
                ))}
              </div>

              <div className="bot-kook-channel-card">
                <div className="bot-command-picker">
                  <strong>{t('botAddedEvents')}</strong>
                  <div className="bot-command-choice-grid">
                    {kookCommandDefinitions.map((command) => (
                      <label key={command.id} className="bot-command-choice">
                        <input type="checkbox" checked={normalizeKookCommandIds(kookForm.enabledCommandIds, kookForm).includes(command.id)} onChange={(event) => toggleKookCommand(command.id, event.target.checked)} disabled={!canEditKook} />
                        <span>{command.name}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="bot-channel-base-form">
                  <label>
                    <span>{t('kookGuildId')}</span>
                    <input value={kookForm.guildId} onChange={(event) => setKookForm({ ...kookForm, guildId: event.target.value })} maxLength={80} placeholder={t('kookGuildIdPlaceholder')} autoComplete="off" disabled={!canEditKook} />
                  </label>
                </div>
                <div className="bot-target-command-list">
                  {kookCommandDefinitions.filter((command) => normalizeKookCommandIds(kookForm.enabledCommandIds, kookForm).includes(command.id)).map((command) => (
                    <section key={command.id} className="bot-target-command-block">
                      <div className="bot-target-command-head">
                        <div>
                          <span className="status-badge neutral">{command.typeLabel}</span>
                          <h4>{command.name}</h4>
                        </div>
                        {command.pushType ? <span className="status-badge complete">{t('botActivePush')}</span> : <span className="status-badge neutral">{t('botNoPushAction')}</span>}
                      </div>
                      <div className="bot-command-channel-grid">
                        {(command.channelFields || []).map((field) => (
                          <label key={field.key}>
                            <span>{field.label}</span>
                            <input value={kookForm[field.key] || ''} onChange={(event) => setKookForm({ ...kookForm, [field.key]: event.target.value })} maxLength={80} placeholder={field.placeholder} autoComplete="off" disabled={!canEditKook} />
                          </label>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
                <InfoGrid className="bot-channel-status-grid" items={kookStatusItems} />
              </div>
            </>
          )}
        </section>
      )}
      {configModal === 'discord' && (
        <ModalFrame className="discord-settings-modal bot-config-modal" labelledBy="bot-discord-config-title" onClose={() => setConfigModal(null)}>
          <div className="modal-title">
            <div>
              <h3 id="bot-discord-config-title">{t('botDiscordConfigTitle')}</h3>
              <span className="modal-subtitle">{t('discordGlobalSettingsHint')}</span>
            </div>
          </div>
          <div className="bot-config-form">
            <label className="api-endpoint-field span-2">
              <span>{t('discordInteractionsEndpoint')}</span>
              <div className="endpoint-copy-row">
                <input value={discordInteractionsEndpoint} readOnly />
                <button type="button" className="action-button" onClick={() => copyText(discordInteractionsEndpoint, setToast, t)} title={t('copyEndpoint')}>
                  <Clipboard size={16} />
                  <span>{t('copyEndpoint')}</span>
                </button>
              </div>
            </label>
            <label>
              <span>{t('discordBotToken')}</span>
              <input type="password" value={form.botToken} onChange={(event) => setForm({ ...form, botToken: event.target.value })} minLength={24} maxLength={4096} placeholder={settings.discord?.tokenMasked || t('discordBotTokenPlaceholder')} autoComplete="new-password" disabled={!canEditDiscord || form.clearToken} />
            </label>
            <label>
              <span>{t('discordPublicKey')}</span>
              <input value={form.publicKey} onChange={(event) => setForm({ ...form, publicKey: event.target.value })} maxLength={128} placeholder={t('discordPublicKeyPlaceholder')} autoComplete="off" disabled={!canEditDiscord} />
            </label>
            <label>
              <span>{t('discordApplicationId')}</span>
              <input value={form.applicationId} onChange={(event) => setForm({ ...form, applicationId: event.target.value })} maxLength={32} placeholder={t('discordApplicationIdPlaceholder')} autoComplete="off" disabled={!canEditDiscord} />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={form.clearToken} onChange={(event) => setForm({ ...form, clearToken: event.target.checked, botToken: event.target.checked ? '' : form.botToken })} disabled={!canEditDiscord || !settings.discord?.tokenMasked} />
              <span>{t('discordClearToken')}</span>
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost-button warning-button" onClick={() => setConfigModal(null)}>{t('cancel')}</button>
            <button type="button" className="primary-button" disabled={!canEditDiscord || saving} onClick={async () => { if (await saveDiscordSettings()) setConfigModal(null); }}>
              <Save size={17} />
              <span>{saving ? t('saving') : t('saveDiscordSettings')}</span>
            </button>
          </div>
        </ModalFrame>
      )}
      {configModal === 'kook' && (
        <ModalFrame className="discord-settings-modal bot-config-modal" labelledBy="bot-kook-config-title" onClose={() => setConfigModal(null)}>
          <div className="modal-title">
            <div>
              <h3 id="bot-kook-config-title">{t('botKookConfigTitle')}</h3>
              <span className="modal-subtitle">{t('kookGlobalSettingsHint')}</span>
            </div>
          </div>
          <div className="bot-config-form">
            <label className="api-endpoint-field span-2">
              <span>{t('kookEventsEndpoint')}</span>
              <div className="endpoint-copy-row">
                <input value={kookEventsEndpoint} readOnly />
                <button type="button" className="action-button" onClick={() => copyText(kookEventsEndpoint, setToast, t)} title={t('copyEndpoint')}>
                  <Clipboard size={16} />
                  <span>{t('copyEndpoint')}</span>
                </button>
              </div>
            </label>
            <label className="api-endpoint-field span-2">
              <span>{t('kookCallbackUrl')}</span>
              <div className="endpoint-copy-row">
                <input value={kookEventsEndpoint} readOnly />
                <button type="button" className="action-button" onClick={() => copyText(kookEventsEndpoint, setToast, t)} title={t('copyEndpoint')}>
                  <Clipboard size={16} />
                  <span>{t('copyEndpoint')}</span>
                </button>
              </div>
            </label>
            <label>
              <span>{t('kookBotToken')}</span>
              <input type="password" value={kookForm.botToken} onChange={(event) => setKookForm({ ...kookForm, botToken: event.target.value })} minLength={8} maxLength={4096} placeholder={settings.kook?.tokenMasked || t('kookBotTokenPlaceholder')} autoComplete="new-password" disabled={!canEditKook || kookForm.clearToken} />
            </label>
            <label>
              <span>{t('kookVerifyToken')}</span>
              <input type="password" value={kookForm.verifyToken} onChange={(event) => setKookForm({ ...kookForm, verifyToken: event.target.value })} maxLength={256} placeholder={settings.kook?.verifyTokenMasked || t('kookVerifyTokenPlaceholder')} autoComplete="new-password" disabled={!canEditKook || kookForm.clearVerifyToken} />
            </label>
            <label>
              <span>{t('kookEncryptKey')}</span>
              <input type="password" value={kookForm.encryptKey} onChange={(event) => setKookForm({ ...kookForm, encryptKey: event.target.value })} maxLength={256} placeholder={settings.kook?.encryptKeyMasked || t('kookEncryptKeyPlaceholder')} autoComplete="new-password" disabled={!canEditKook || kookForm.clearEncryptKey} />
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={kookForm.clearToken} onChange={(event) => setKookForm({ ...kookForm, clearToken: event.target.checked, botToken: event.target.checked ? '' : kookForm.botToken })} disabled={!canEditKook || !settings.kook?.tokenMasked} />
              <span>{t('kookClearToken')}</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={kookForm.clearVerifyToken} onChange={(event) => setKookForm({ ...kookForm, clearVerifyToken: event.target.checked, verifyToken: event.target.checked ? '' : kookForm.verifyToken })} disabled={!canEditKook || !settings.kook?.verifyTokenConfigured} />
              <span>{t('kookClearVerifyToken')}</span>
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={kookForm.clearEncryptKey} onChange={(event) => setKookForm({ ...kookForm, clearEncryptKey: event.target.checked, encryptKey: event.target.checked ? '' : kookForm.encryptKey })} disabled={!canEditKook || !settings.kook?.encryptKeyMasked} />
              <span>{t('kookClearEncryptKey')}</span>
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="ghost-button warning-button" onClick={() => setConfigModal(null)}>{t('cancel')}</button>
            <button type="button" className="primary-button" disabled={!canEditKook || kookSaving} onClick={async () => { if (await saveKookSettings()) setConfigModal(null); }}>
              <Save size={17} />
              <span>{kookSaving ? t('saving') : t('saveKookSettings')}</span>
            </button>
          </div>
        </ModalFrame>
      )}
      {pushCardModal && (
        <DiscordPushCardModal
          cardType={pushCardModal.type}
          language={pushCardModal.language}
          preview={pushCardModal.preview}
          loading={pushCardModal.loading}
          pushing={pushCardModal.pushing}
          error={pushCardModal.error}
          mentionEveryone={pushCardModal.mentionEveryone !== false}
          t={t}
          lang={lang}
          onCancel={() => setPushCardModal(null)}
          onLanguageChange={(nextLanguage) => loadDiscordTargetCardPreview(pushCardModal.target, pushCardModal.type, nextLanguage, pushCardModal.mentionEveryone !== false)}
          onMentionEveryoneChange={(nextValue) => loadDiscordTargetCardPreview(pushCardModal.target, pushCardModal.type, pushCardModal.language, nextValue)}
          onPush={() => pushDiscordTargetCard(pushCardModal.target, pushCardModal.type, pushCardModal.language, pushCardModal.mentionEveryone !== false)}
        />
      )}
    </section>
  );
}

export default DiscordBotSettingsView;
