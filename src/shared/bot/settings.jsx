import React from 'react';
import { ChevronDown, Send } from 'lucide-react';
import { LANGUAGES, languageOptionLabel, normalizeLanguageId } from '../../i18n/languages.js';
import { Alert } from '../ui/Alert.jsx';
import { ModalFrame } from '../ui/ModalFrame.jsx';

function createDiscordTargetDraft(t, index = 0) {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return {
    id: index === 0 ? 'default' : `target_${suffix}`,
    name: index === 0 ? t('discordDefaultTargetName') : t('discordNewTargetName'),
    enabledCommandIds: [],
    guildId: '',
    channelId: '',
    channelName: '',
    memberRegisterChannelId: '',
    memberReviewChannelId: '',
    mapChannelId: '',
    mapChannelName: '',
    kdaQueryChannelId: '',
    memberRankingChannelId: '',
    memberRankingChannelName: '',
    memberRegisterRoleId: '',
    memberManageRoleId: '',
    memberRegisterSquadName: '57',
    memberRegisterRoleSquadRules: [createDiscordRoleSquadRuleDraft()],
    discordMetadataSyncedAt: '',
    discordMetadataSyncError: '',
    lastPushAt: '',
    lastPushError: '',
    lastMessageId: '',
    lastMemberRegisterPushAt: '',
    lastMemberRegisterMessageId: '',
    lastMemberRankingPushAt: '',
    lastMemberRankingMessageId: '',
    lastMemberRankingRefreshAt: '',
    lastMemberRankingRefreshError: '',
    lastMapPushAt: '',
    lastMapMessageId: '',
    lastMapLanguage: '',
    lastCommandRegisterAt: '',
    lastCommandRegisterError: ''
  };
}

const DISCORD_COMMAND_IDS = ['wipe', 'kda', 'member', 'ranking', 'map'];
const DISCORD_COMMAND_FIELD_MAP = {
  wipe: ['channelId'],
  kda: ['kdaQueryChannelId'],
  member: ['memberRegisterChannelId', 'memberReviewChannelId'],
  ranking: ['memberRankingChannelId'],
  map: ['mapChannelId']
};
const KOOK_COMMAND_IDS = ['kookWipe', 'kookMember', 'kookKda', 'kookRanking'];
const KOOK_COMMAND_FIELD_MAP = {
  kookWipe: ['channelId'],
  kookMember: ['memberRegisterChannelId'],
  kookKda: ['kdaQueryChannelId'],
  kookRanking: ['memberRankingChannelId']
};
const BOT_COMMAND_ID_PATTERN = /^[A-Za-z0-9_:-]{1,80}$/;
const BOT_COMMAND_TYPE_OPTIONS = ['slash_command', 'persistent_card', 'event_card', 'event_command'];
const DISCORD_COMMAND_CHANNEL_FIELD_KEYS = ['channelId', 'memberRegisterChannelId', 'memberReviewChannelId', 'kdaQueryChannelId', 'memberRankingChannelId', 'mapChannelId'];
const KOOK_COMMAND_CHANNEL_FIELD_KEYS = ['channelId', 'memberRegisterChannelId', 'kdaQueryChannelId', 'memberRankingChannelId'];
const DISCORD_LEGACY_DEFAULT_TEMPLATE_VALUES = {
  kda: {
    titleTemplate: ['KDA query · {serverName}'],
    bodyTemplate: [
      [
        'Enter a SteamID, member name, or profile link to query current-server KDA.',
        'Returns kills, deaths, KD/KDA, online time, and current wipe data.',
        'Only responds in the configured KDA query channel; leave the channel blank to allow all channels.'
      ].join('\n')
    ]
  },
  member: {
    titleTemplate: ['NB Clan Registration & VIP'],
    bodyTemplate: [
      '填写成员资料并更新 VIP 信息。',
      'Register member profile and VIP update.',
      'Register member profile and update VIP information.',
      [
        'Click the button below to submit member registration.',
        'Members fill in SteamID, in-game name, specialty, VIP info, and contact details.',
        'Submissions are sent to the member review channel; admin approval writes the member profile and team.',
        'Registered members can use the VIP update entry to keep server VIP types and dates current.'
      ].join('\n'),
      [
        'Members with a configured registration role can register their SteamID and VIP info here.',
        'New members: click Register Member, choose a specialty, then submit SteamID and VIP info in one flow. Your role decides which team you enter.',
        'Already registered: use the VIP update button on the right to keep each server VIP type and dates current.',
        'The system sends a Discord DM reminder 3 days before VIP expiry.'
      ].join('\n')
    ]
  },
  ranking: {
    titleTemplate: ['Current server member ranking', 'Current server member ranking · {metric} Top {limit}'],
    bodyTemplate: [
      'NB Clan · 点击下方按钮切换排行类型',
      'NB Clan · Use the buttons below to switch ranking type',
      'Top 20 current-server member ranking card.',
      [
        'Shows the current-server member ranking Top {limit}.',
        'The ranking card includes team, SteamID, KDA, kills, deaths, online time, resource stats, and combat stats.',
        'Data comes from the current wipe and refreshes on the card after background sync completes.',
        'NB Clan · Use the buttons below to switch ranking type'
      ].join('\n'),
      [
        'Shows the current-server member ranking Top {limit}.',
        'The ranking card includes team, SteamID, KDA, kills, deaths, online time, and other core data.',
        'NB Clan · Use the buttons below to switch ranking type'
      ].join('\n')
    ]
  },
  map: {
    titleTemplate: ['Map {serverName}', '🗺️ Map {serverName}'],
    bodyTemplate: [
      '当前服务器地图链接与预览图。',
      'Map link and preview image.',
      'Map link and preview image for the current server.',
      [
        'Map information for {serverName}.',
        'Includes the map preview, RustMaps link, map download link, and server direct-connect address.',
        'Uses the uploaded map image first; falls back to RustMaps or the map download link when no image is available.',
        'After map or wipe information changes, push the card again to the configured channel.'
      ].join('\n'),
      [
        'Map link and preview image for the current server.',
        'Uses the uploaded map image first; falls back to RustMaps or the map download link when no image is available.',
        'Members can open map resources from the action button.'
      ].join('\n')
    ]
  }
};
const KOOK_LEGACY_DEFAULT_TEMPLATE_VALUES = {
  kookWipe: {
    titleTemplate: ['Wipe registration', 'KOOK wipe registration'],
    bodyTemplate: [
      'KOOK Wipe 登记频道卡片。',
      'KOOK wipe registration channel.',
      'KOOK wipe registration channel card.',
      [
        'KOOK wipe registration channel card.',
        'Members can submit on-time, late, or unsure status in KOOK.',
        'The card summarizes current wipe signups, team counts, and notes for admins before wipe start.'
      ].join('\n'),
      [
        'KOOK wipe registration channel card.',
        'Members can submit on-time, late, or unsure status in KOOK.',
        'Used for current wipe attendance statistics.'
      ].join('\n')
    ]
  },
  kookMember: {
    titleTemplate: ['Member self-registration'],
    bodyTemplate: [
      '成员自助登记',
      'KOOK 成员自助登记频道卡片。',
      'KOOK member self-registration channel.',
      'KOOK member self-registration channel card.',
      [
        'KOOK member self-registration channel card.',
        'Members can submit SteamID, name, and profile details, then wait for admin review.',
        'Approved submissions write the member profile and allow later VIP updates.'
      ].join('\n'),
      [
        'KOOK member self-registration channel card.',
        'Members can submit SteamID and profile details, then wait for admin review.'
      ].join('\n')
    ]
  },
  kookKda: {
    titleTemplate: ['KOOK KDA query · {serverName}'],
    bodyTemplate: [
      [
        'Query current-server KDA inside the configured KOOK channel.',
        'Supports SteamID, member name, or profile link.',
        'Returns kills, deaths, KD/KDA, online time, and current wipe data.'
      ].join('\n')
    ]
  },
  kookRanking: {
    titleTemplate: ['Current server member ranking', 'Current server member ranking · {metric} Top {limit}'],
    bodyTemplate: [
      'NB Clan · 点击下方按钮切换排行类型',
      'NB Clan · Use the buttons below to switch ranking type',
      'Current-server member ranking card.',
      [
        'Shows the current-server member ranking Top {limit}.',
        'The ranking card includes team, SteamID, KDA, kills, deaths, online time, resource stats, and combat stats.',
        'Data comes from the current wipe and refreshes on the card after background sync completes.',
        'NB Clan · Use the buttons below to switch ranking type'
      ].join('\n'),
      [
        'Shows the current-server member ranking Top {limit}.',
        'The ranking card includes team, SteamID, KDA, kills, deaths, online time, and other core data.',
        'NB Clan · Use the buttons below to switch ranking type'
      ].join('\n')
    ]
  }
};

function isBotCommandId(value) {
  return BOT_COMMAND_ID_PATTERN.test(String(value || '').trim());
}

function botCommandTypeLabel(type, t) {
  if (type === 'slash_command') return t('botCommandTypeSlash');
  if (type === 'event_card' || type === 'event_command') return t('botCommandTypeEvent');
  return t('botCommandTypeCard');
}

function botCommandTypeOptionLabel(type, t) {
  if (type === 'slash_command') return t('botCommandTypeSlash');
  if (type === 'event_card') return t('botCommandTypeEventCard');
  if (type === 'event_command') return t('botCommandTypeEventCommand');
  return t('botCommandTypeCard');
}

function discordCommandFieldOptions(t) {
  return [
    { key: 'channelId', nameKey: 'channelName', label: t('discordChannelId'), placeholder: t('discordChannelIdPlaceholder') },
    { key: 'memberRegisterChannelId', label: t('discordMemberRegisterChannelId'), placeholder: t('discordMemberRegisterChannelIdPlaceholder') },
    { key: 'memberReviewChannelId', label: t('discordMemberReviewChannelId'), placeholder: t('discordMemberReviewChannelIdPlaceholder') },
    { key: 'kdaQueryChannelId', label: t('discordKdaQueryChannelId'), placeholder: t('discordKdaQueryChannelIdPlaceholder') },
    { key: 'memberRankingChannelId', nameKey: 'memberRankingChannelName', label: t('discordMemberRankingChannelId'), placeholder: t('discordMemberRankingChannelIdPlaceholder') },
    { key: 'mapChannelId', nameKey: 'mapChannelName', label: t('discordMapChannelId'), placeholder: t('discordMapChannelIdPlaceholder') }
  ];
}

function kookCommandFieldOptions(t) {
  return [
    { key: 'channelId', label: t('kookChannelId'), placeholder: t('kookChannelIdPlaceholder') },
    { key: 'memberRegisterChannelId', label: t('kookMemberRegisterChannelId'), placeholder: t('kookMemberRegisterChannelIdPlaceholder') },
    { key: 'kdaQueryChannelId', label: t('kookKdaQueryChannelId'), placeholder: t('kookKdaQueryChannelIdPlaceholder') },
    { key: 'memberRankingChannelId', label: t('kookMemberRankingChannelId'), placeholder: t('kookMemberRankingChannelIdPlaceholder') }
  ];
}

function normalizeCommandChannelFields(fields, options) {
  const optionMap = new Map(options.map((field) => [field.key, field]));
  const used = new Set();
  return (Array.isArray(fields) ? fields : [])
    .map((field) => {
      const key = typeof field === 'string' ? field : field?.key;
      if (!key || !optionMap.has(key) || used.has(key)) return null;
      used.add(key);
      return {
        ...optionMap.get(key),
        ...(typeof field === 'object' && field ? {
          label: field.label || optionMap.get(key).label,
          placeholder: field.placeholder || optionMap.get(key).placeholder
        } : {})
      };
    })
    .filter(Boolean);
}

function isLegacyDefaultTemplateValue(value, legacyValues = []) {
  const normalized = String(value ?? '').trim();
  return legacyValues.some((legacy) => normalized === String(legacy ?? '').trim());
}

function botCommandTemplateValue(item, fallback, id, field, legacyDefaultTemplates, custom) {
  const hasValue = Object.hasOwn(item || {}, field);
  const fallbackValue = fallback?.[field] ?? '';
  if (!hasValue) return fallbackValue;
  const value = String(item?.[field] ?? '');
  if (custom) return value;
  if (!value.trim() && fallbackValue) return fallbackValue;
  const legacyValues = legacyDefaultTemplates?.[id]?.[field] || [];
  if (isLegacyDefaultTemplateValue(value, legacyValues)) return fallbackValue;
  return value;
}

function serializeCommandDefinitions(definitions = []) {
  return (definitions || [])
    .filter((command) => isBotCommandId(command.id))
    .map((command) => ({
      id: String(command.id || '').trim(),
      name: String(command.name || '').trim(),
      type: String(command.type || 'persistent_card').trim(),
      slashCommand: String(command.slashCommand || '').trim(),
      titleTemplate: String(command.titleTemplate || '').trim(),
      bodyTemplate: String(command.bodyTemplate || '').trim(),
      requiresChannelId: Boolean(command.requiresChannelId),
      channelFields: (command.channelFields || []).map((field) => field.key || field).filter(Boolean),
      requiresRoleRules: Boolean(command.requiresRoleRules),
      supportsPush: Boolean(command.supportsPush),
      pushType: String(command.pushType || '').trim(),
      editableTemplate: Boolean(command.editableTemplate),
      custom: Boolean(command.custom)
    }));
}

function botTemplateBodyRows(value = '') {
  const lines = String(value || '').split(/\r\n|\r|\n/);
  const estimatedRows = lines.reduce((total, line) => total + Math.max(1, Math.ceil(String(line).length / 64)), 0);
  return Math.min(18, Math.max(5, estimatedRows));
}

function defaultDiscordCommandDefinitions(t, form = {}) {
  return [
    {
      id: 'wipe',
      name: t('botCommandWipe'),
      type: 'slash_command',
      typeLabel: t('botCommandTypeSlash'),
      slashCommand: form.commandHint || '/wipe',
      titleTemplate: form.templateTitle || '🚨 {serverName} WIPE 🚨',
      bodyTemplate: form.templateBody || t('discordTemplateBodyPlaceholder'),
      channelFields: normalizeCommandChannelFields(['channelId'], discordCommandFieldOptions(t)),
      requiresChannelId: true,
      requiresRoleRules: false,
      supportsPush: true,
      pushType: 'wipe',
      editableTemplate: true
    },
    {
      id: 'kda',
      name: t('botCommandKda'),
      type: 'slash_command',
      typeLabel: t('botCommandTypeSlash'),
      slashCommand: '/kda',
      titleTemplate: t('botKdaTemplateTitle'),
      bodyTemplate: t('botKdaTemplateBody'),
      channelFields: normalizeCommandChannelFields(['kdaQueryChannelId'], discordCommandFieldOptions(t)),
      requiresChannelId: false,
      requiresRoleRules: false,
      supportsPush: false
    },
    {
      id: 'member',
      name: t('botCommandMember'),
      type: 'persistent_card',
      typeLabel: t('botCommandTypeCard'),
      slashCommand: 'member-registration-card',
      titleTemplate: t('botMemberRegistrationTemplateTitle'),
      bodyTemplate: t('botMemberRegistrationTemplateBody'),
      channelFields: normalizeCommandChannelFields(['memberRegisterChannelId', 'memberReviewChannelId'], discordCommandFieldOptions(t)),
      requiresChannelId: true,
      requiresRoleRules: true,
      supportsPush: true,
      pushType: 'member'
    },
    {
      id: 'ranking',
      name: t('botCommandRanking'),
      type: 'persistent_card',
      typeLabel: t('botCommandTypeCard'),
      slashCommand: 'member-ranking-card',
      titleTemplate: t('botRankingTemplateTitle'),
      bodyTemplate: t('botRankingTemplateBody'),
      channelFields: normalizeCommandChannelFields(['memberRankingChannelId'], discordCommandFieldOptions(t)),
      requiresChannelId: true,
      requiresRoleRules: false,
      supportsPush: true,
      pushType: 'ranking'
    },
    {
      id: 'map',
      name: t('botCommandMap'),
      type: 'persistent_card',
      typeLabel: t('botCommandTypeCard'),
      slashCommand: 'map-card',
      titleTemplate: t('botMapTemplateTitle'),
      bodyTemplate: t('botMapTemplateBody'),
      channelFields: normalizeCommandChannelFields(['mapChannelId'], discordCommandFieldOptions(t)),
      requiresChannelId: true,
      requiresRoleRules: false,
      supportsPush: true,
      pushType: 'map'
    }
  ];
}

function defaultKookEventDefinitions(t) {
  return [
    {
      id: 'kookWipe',
      name: t('botCommandKookWipe'),
      type: 'event_card',
      typeLabel: t('botCommandTypeEvent'),
      slashCommand: 'wipe-registration-card',
      titleTemplate: t('botKookWipeTemplateTitle'),
      bodyTemplate: t('botKookWipeTemplateBody'),
      channelFields: normalizeCommandChannelFields(['channelId'], kookCommandFieldOptions(t)),
      requiresChannelId: true,
      requiresRoleRules: false
    },
    {
      id: 'kookMember',
      name: t('botCommandKookMember'),
      type: 'event_card',
      typeLabel: t('botCommandTypeEvent'),
      slashCommand: 'member-registration-card',
      titleTemplate: t('botKookMemberTemplateTitle'),
      bodyTemplate: t('botKookMemberTemplateBody'),
      channelFields: normalizeCommandChannelFields(['memberRegisterChannelId'], kookCommandFieldOptions(t)),
      requiresChannelId: true,
      requiresRoleRules: false
    },
    {
      id: 'kookKda',
      name: t('botCommandKookKda'),
      type: 'event_command',
      typeLabel: t('botCommandTypeEvent'),
      slashCommand: 'kda-query',
      titleTemplate: t('botKookKdaTemplateTitle'),
      bodyTemplate: t('botKookKdaTemplateBody'),
      channelFields: normalizeCommandChannelFields(['kdaQueryChannelId'], kookCommandFieldOptions(t)),
      requiresChannelId: true,
      requiresRoleRules: false
    },
    {
      id: 'kookRanking',
      name: t('botCommandKookRanking'),
      type: 'persistent_card',
      typeLabel: t('botCommandTypeCard'),
      slashCommand: 'member-ranking-card',
      titleTemplate: t('botRankingTemplateTitle'),
      bodyTemplate: t('botRankingTemplateBody'),
      channelFields: normalizeCommandChannelFields(['memberRankingChannelId'], kookCommandFieldOptions(t)),
      requiresChannelId: true,
      requiresRoleRules: false,
      supportsPush: true,
      pushType: 'kookRanking'
    }
  ];
}

function normalizeBotCommandDefinitions(values, t, defaults, fieldOptions, legacyDefaultTemplates = {}) {
  const fallbackById = new Map(defaults.map((command) => [command.id, command]));
  const raw = Array.isArray(values) ? values : defaults;
  const used = new Set();
  return raw
    .map((item) => {
      const id = String(item?.id || '').trim();
      if (!isBotCommandId(id) || used.has(id)) return null;
      used.add(id);
      const fallback = fallbackById.get(id) || {};
      const type = item.type || fallback.type || 'persistent_card';
      const normalizedChannelFields = normalizeCommandChannelFields(
        Object.hasOwn(item || {}, 'channelFields') ? item.channelFields : fallback.channelFields,
        fieldOptions
      );
      const fallbackChannelFields = normalizeCommandChannelFields(fallback.channelFields, fieldOptions);
      const channelFields = normalizedChannelFields.length || !fallbackChannelFields.length || item.custom
        ? normalizedChannelFields
        : fallbackChannelFields;
      const custom = Object.hasOwn(item || {}, 'custom') ? Boolean(item.custom) : !fallbackById.has(id);
      return {
        id,
        name: item.name || fallback.name || id,
        type,
        typeLabel: item.typeLabel || fallback.typeLabel || botCommandTypeLabel(type, t),
        slashCommand: item.slashCommand ?? fallback.slashCommand ?? '',
        titleTemplate: botCommandTemplateValue(item, fallback, id, 'titleTemplate', legacyDefaultTemplates, custom),
        bodyTemplate: botCommandTemplateValue(item, fallback, id, 'bodyTemplate', legacyDefaultTemplates, custom),
        channelFields,
        requiresChannelId: Object.hasOwn(item || {}, 'requiresChannelId') ? Boolean(item.requiresChannelId) : Boolean(fallback.requiresChannelId),
        requiresRoleRules: Object.hasOwn(item || {}, 'requiresRoleRules') ? Boolean(item.requiresRoleRules) : Boolean(fallback.requiresRoleRules),
        supportsPush: Object.hasOwn(item || {}, 'supportsPush') ? Boolean(item.supportsPush) : Boolean(fallback.supportsPush),
        pushType: item.pushType || fallback.pushType || '',
        editableTemplate: Object.hasOwn(item || {}, 'editableTemplate') ? Boolean(item.editableTemplate) : Boolean(fallback.editableTemplate),
        custom
      };
    })
    .filter(Boolean);
}

function normalizeDiscordCommandDefinitions(values, t, form = {}) {
  return normalizeBotCommandDefinitions(values, t, defaultDiscordCommandDefinitions(t, form), discordCommandFieldOptions(t), DISCORD_LEGACY_DEFAULT_TEMPLATE_VALUES);
}

function normalizeKookEventDefinitions(values, t) {
  return normalizeBotCommandDefinitions(values, t, defaultKookEventDefinitions(t), kookCommandFieldOptions(t), KOOK_LEGACY_DEFAULT_TEMPLATE_VALUES);
}

function deriveDiscordTargetCommandIds(target = {}) {
  const ids = [];
  if (target.channelId) ids.push('wipe');
  if (target.kdaQueryChannelId) ids.push('kda');
  if (
    target.memberRegisterChannelId ||
    target.memberReviewChannelId ||
    target.memberManageRoleId ||
    (target.memberRegisterRoleSquadRules || []).some((rule) => rule.roleId || rule.squadId)
  ) {
    ids.push('member');
  }
  if (target.memberRankingChannelId) ids.push('ranking');
  if (target.mapChannelId) ids.push('map');
  return ids;
}

function normalizeDiscordTargetCommandIds(values, target = {}) {
  const raw = Array.isArray(values) ? values : deriveDiscordTargetCommandIds(target);
  const used = new Set();
  return raw
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if ((!DISCORD_COMMAND_IDS.includes(value) && !isBotCommandId(value)) || used.has(value)) return false;
      used.add(value);
      return true;
    });
}

function deriveKookCommandIds(kook = {}) {
  const ids = [];
  if (kook.channelId) ids.push('kookWipe');
  if (kook.memberRegisterChannelId) ids.push('kookMember');
  if (kook.kdaQueryChannelId) ids.push('kookKda');
  if (kook.memberRankingChannelId) ids.push('kookRanking');
  return ids;
}

function normalizeKookCommandIds(values, kook = {}) {
  const raw = Array.isArray(values) ? values : deriveKookCommandIds(kook);
  const used = new Set();
  return raw
    .map((value) => String(value || '').trim())
    .filter((value) => {
      if ((!KOOK_COMMAND_IDS.includes(value) && !isBotCommandId(value)) || used.has(value)) return false;
      used.add(value);
      return true;
    });
}

function createDiscordRoleSquadRuleDraft() {
  return {
    id: `rule_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    roleId: '',
    roleName: '',
    squadId: ''
  };
}

function squadIdByName(squads = [], name = '') {
  const normalizedName = String(name || '').trim().toLowerCase();
  if (!normalizedName) return '';
  return (squads || []).find((squad) => String(squad.name || '').trim().toLowerCase() === normalizedName)?.id || '';
}

function squadNameById(squads = [], squadId = '') {
  return (squads || []).find((squad) => squad.id === squadId)?.name || '';
}

function discordRoleSquadRulesFromPayload(target = {}, squads = []) {
  const rawRules = Array.isArray(target.memberRegisterRoleSquadRules) ? target.memberRegisterRoleSquadRules : [];
  const rules = rawRules
    .map((rule) => ({
      id: rule.id || createDiscordRoleSquadRuleDraft().id,
      roleId: rule.roleId || '',
      roleName: rule.roleName || '',
      squadId: rule.squadId || ''
    }))
    .filter((rule) => rule.roleId || rule.squadId);
  if (rules.length) return rules;
  if (target.memberRegisterRoleId) {
    return [{
      id: 'legacy',
      roleId: target.memberRegisterRoleId,
      roleName: '',
      squadId: target.memberRegisterSquadId || squadIdByName(squads, target.memberRegisterSquadName || '57')
    }];
  }
  return [createDiscordRoleSquadRuleDraft()];
}

function discordTargetDraftFromPayload(target = {}, index = 0, t, squads = []) {
  const base = createDiscordTargetDraft(t, index);
  const draft = {
    ...base,
    ...target,
    id: target.id || base.id,
    name: target.name || base.name,
    memberRegisterSquadName: target.memberRegisterSquadName || '57',
    memberRegisterRoleSquadRules: discordRoleSquadRulesFromPayload(target, squads)
  };
  return {
    ...draft,
    enabledCommandIds: normalizeDiscordTargetCommandIds(target.enabledCommandIds, draft)
  };
}

function discordFormFromPayload(discord = null, t, squads = []) {
  const fallbackTarget = {
    id: 'default',
    name: t('discordDefaultTargetName'),
    guildId: discord?.guildId || '',
    channelId: discord?.channelId || '',
    channelName: discord?.channelName || '',
    memberRegisterChannelId: discord?.memberRegisterChannelId || '',
    memberReviewChannelId: discord?.memberReviewChannelId || '',
    mapChannelId: discord?.mapChannelId || '',
    mapChannelName: discord?.mapChannelName || '',
    kdaQueryChannelId: discord?.kdaQueryChannelId || '',
    memberRankingChannelId: discord?.memberRankingChannelId || '',
    memberRankingChannelName: discord?.memberRankingChannelName || '',
    memberRegisterRoleId: discord?.memberRegisterRoleId || '',
    memberManageRoleId: discord?.memberManageRoleId || '',
    memberRegisterSquadName: discord?.memberRegisterSquadName || '57',
    discordMetadataSyncedAt: discord?.discordMetadataSyncedAt || '',
    discordMetadataSyncError: discord?.discordMetadataSyncError || '',
    lastPushAt: discord?.lastPushAt || '',
    lastPushError: discord?.lastPushError || '',
    lastMessageId: discord?.lastMessageId || '',
    lastMemberRegisterPushAt: discord?.lastMemberRegisterPushAt || '',
    lastMemberRegisterMessageId: discord?.lastMemberRegisterMessageId || '',
    lastMemberRankingPushAt: discord?.lastMemberRankingPushAt || '',
    lastMemberRankingMessageId: discord?.lastMemberRankingMessageId || '',
    lastMemberRankingRefreshAt: discord?.lastMemberRankingRefreshAt || '',
    lastMemberRankingRefreshError: discord?.lastMemberRankingRefreshError || '',
    lastMapPushAt: discord?.lastMapPushAt || '',
    lastMapMessageId: discord?.lastMapMessageId || '',
    lastMapLanguage: discord?.lastMapLanguage || '',
    lastCommandRegisterAt: discord?.lastCommandRegisterAt || '',
    lastCommandRegisterError: discord?.lastCommandRegisterError || ''
  };
  const rawTargets = Array.isArray(discord?.targets) && discord.targets.length ? discord.targets : [fallbackTarget];
  const form = {
    botToken: '',
    publicKey: discord?.publicKey || '',
    applicationId: discord?.applicationId || '',
    commandHint: discord?.commandHint || '/wipe',
    templateTitle: discord?.templateTitle || '',
    templateBody: discord?.templateBody || '',
    clearToken: false,
    targets: rawTargets.map((target, index) => discordTargetDraftFromPayload(target, index, t, squads))
  };
  return {
    ...form,
    commandDefinitions: normalizeDiscordCommandDefinitions(discord?.commandDefinitions, t, form)
  };
}

function discordSettingsSavePayload(form = {}, squads = []) {
  return {
    ...form,
    commandDefinitions: serializeCommandDefinitions(form.commandDefinitions || []),
    targets: (form.targets || []).map((target) => {
      const {
        channelName: _channelName,
        memberRankingChannelName: _memberRankingChannelName,
        mapChannelName: _mapChannelName,
        discordMetadataSyncedAt: _discordMetadataSyncedAt,
        discordMetadataSyncError: _discordMetadataSyncError,
        ...configTarget
      } = target;
      const rules = (target.memberRegisterRoleSquadRules || [])
        .map((rule) => ({
          id: rule.id,
          roleId: String(rule.roleId || '').trim(),
          squadId: String(rule.squadId || '').trim()
        }))
        .filter((rule) => rule.roleId && rule.squadId);
      const firstRule = rules[0] || null;
      return {
        ...configTarget,
        enabledCommandIds: normalizeDiscordTargetCommandIds(target.enabledCommandIds, target),
        memberManageRoleId: String(target.memberManageRoleId || '').trim(),
        memberRegisterRoleSquadRules: rules,
        memberRegisterRoleId: firstRule?.roleId || '',
        memberRegisterSquadName: firstRule ? (squadNameById(squads, firstRule.squadId) || target.memberRegisterSquadName || '57') : ''
      };
    })
  };
}

function kookFormFromPayload(kook = null, t) {
  const translate = typeof t === 'function' ? t : (key) => key;
  const form = {
    botToken: '',
    verifyToken: '',
    encryptKey: '',
    guildId: kook?.guildId || '',
    channelId: kook?.channelId || '',
    memberRegisterChannelId: kook?.memberRegisterChannelId || '',
    kdaQueryChannelId: kook?.kdaQueryChannelId || '',
    memberRankingChannelId: kook?.memberRankingChannelId || '',
    enabledCommandIds: [],
    clearToken: false,
    clearVerifyToken: false,
    clearEncryptKey: false
  };
  return {
    ...form,
    enabledCommandIds: normalizeKookCommandIds(kook?.enabledCommandIds, form),
    eventDefinitions: normalizeKookEventDefinitions(kook?.eventDefinitions || kook?.commandDefinitions, translate)
  };
}

function kookSettingsSavePayload(form = {}) {
  const eventDefinitions = serializeCommandDefinitions(form.eventDefinitions || []);
  return {
    botToken: form.botToken || '',
    verifyToken: form.verifyToken || '',
    encryptKey: form.encryptKey || '',
    guildId: form.guildId || '',
    channelId: form.channelId || '',
    memberRegisterChannelId: form.memberRegisterChannelId || '',
    kdaQueryChannelId: form.kdaQueryChannelId || '',
    memberRankingChannelId: form.memberRankingChannelId || '',
    enabledCommandIds: normalizeKookCommandIds(form.enabledCommandIds, form),
    commandDefinitions: eventDefinitions,
    eventDefinitions,
    clearToken: Boolean(form.clearToken),
    clearVerifyToken: Boolean(form.clearVerifyToken),
    clearEncryptKey: Boolean(form.clearEncryptKey)
  };
}

function createDiscordKookBridgeRouteForm(route = {}) {
  return {
    id: route?.id || `new_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    name: route?.name || '',
    enabled: Object.hasOwn(route || {}, 'enabled') ? Boolean(route.enabled) : true,
    discordGuildId: route?.discordGuildId || '',
    discordChannelId: route?.discordChannelId || '',
    kookGuildId: route?.kookGuildId || '',
    kookChannelId: route?.kookChannelId || '',
    kookAccessToken: '',
    kookAccessTokenConfigured: Boolean(route?.kookAccessTokenConfigured),
    clearKookAccessToken: false
  };
}

function discordKookBridgeFormFromPayload(bridge = null) {
  return {
    enabled: Boolean(bridge?.enabled),
    translationApiKey: '',
    clearTranslationApiKey: false,
    translationBaseUrl: bridge?.translationBaseUrl || '',
    translationModel: bridge?.translationModel || '',
    pollIntervalSeconds: bridge?.pollIntervalMs ? Math.round(Number(bridge.pollIntervalMs) / 1000) : 15,
    routes: Array.isArray(bridge?.routes)
      ? bridge.routes.map(createDiscordKookBridgeRouteForm)
      : [],
    resetCursors: false
  };
}

function discordKookBridgeSavePayload(form = {}, options = {}) {
  const includeCredentials = options.includeCredentials !== false;
  return {
    enabled: Boolean(form.enabled),
    ...(includeCredentials ? {
      translationApiKey: String(form.translationApiKey || '').trim(),
      clearTranslationApiKey: Boolean(form.clearTranslationApiKey),
      translationBaseUrl: String(form.translationBaseUrl || '').trim()
    } : {}),
    translationModel: String(form.translationModel || '').trim(),
    pollIntervalSeconds: Number(form.pollIntervalSeconds || 15),
    routes: Array.isArray(form.routes)
      ? form.routes.map((route) => ({
        id: String(route.id || '').trim(),
        name: String(route.name || '').trim(),
        enabled: Boolean(route.enabled),
        discordGuildId: String(route.discordGuildId || '').trim(),
        discordChannelId: String(route.discordChannelId || '').trim(),
        kookGuildId: '',
        kookChannelId: String(route.kookChannelId || '').trim(),
        kookAccessToken: String(route.kookAccessToken || '').trim(),
        kookAccessTokenConfigured: Boolean(route.kookAccessTokenConfigured),
        clearKookAccessToken: Boolean(route.clearKookAccessToken)
      }))
      : [],
    resetCursors: Boolean(form.resetCursors),
    resetRouteIds: Array.isArray(form.resetRouteIds) ? form.resetRouteIds : []
  };
}

const DISCORD_PUSH_CARD_CONFIG = {
  wipe: {
    previewEndpoint: '/api/wipes/current/discord-attendance/preview',
    pushEndpoint: '/api/wipes/current/discord-attendance',
    pushLabelKey: 'pushDiscord',
    pushingLabelKey: 'pushingDiscord',
    toastKeys: ['discordAttendancePushed', 'discordAttendancePushedWithLink']
  },
  member: {
    previewEndpoint: '/api/settings/discord/member-registration-card/preview',
    pushEndpoint: '/api/settings/discord/member-registration-card',
    pushLabelKey: 'pushDiscordMemberRegistrationCard',
    pushingLabelKey: 'pushingDiscordMemberRegistrationCard',
    toastKeys: ['discordMemberRegistrationCardPushed', 'discordMemberRegistrationCardPushedWithLink']
  },
  ranking: {
    previewEndpoint: '/api/settings/discord/member-ranking-card/preview',
    pushEndpoint: '/api/settings/discord/member-ranking-card',
    pushLabelKey: 'pushDiscordMemberRankingCard',
    pushingLabelKey: 'pushingDiscordMemberRankingCard',
    toastKeys: ['discordMemberRankingCardPushed', 'discordMemberRankingCardPushedWithLink']
  },
  kookRanking: {
    platform: 'kook',
    previewEndpoint: '/api/settings/kook/member-ranking-card/preview',
    pushEndpoint: '/api/settings/kook/member-ranking-card',
    pushLabelKey: 'pushKookMemberRankingCard',
    pushingLabelKey: 'pushingKookMemberRankingCard',
    toastKeys: ['kookMemberRankingCardPushed', 'kookMemberRankingCardPushed']
  },
  map: {
    previewEndpoint: '/api/settings/discord/map-card/preview',
    pushEndpoint: '/api/settings/discord/map-card',
    pushLabelKey: 'pushDiscordMapCard',
    pushingLabelKey: 'pushingDiscordMapCard',
    toastKeys: ['discordMapCardPushed', 'discordMapCardPushedWithLink']
  }
};

function discordPushCardLanguage(value) {
  return normalizeLanguageId(value) || 'en';
}

function discordPreviewButtonLabel(component = {}) {
  return [component.emoji?.name, component.label].filter(Boolean).join(' ') || component.url || component.custom_id || '-';
}

function kookPreviewElementText(element = {}) {
  if (typeof element === 'string') return element;
  if (!element || typeof element !== 'object') return '';
  if (Array.isArray(element.fields)) return element.fields.map(kookPreviewElementText).filter(Boolean).join('\n');
  if (element.text) return kookPreviewElementText(element.text);
  return element.content || element.value || '';
}

function kookPreviewButtonLabel(button = {}) {
  return kookPreviewElementText(button.text) || button.value || '-';
}

function KookCardPreview({ cards = [], t }) {
  return (
    <>
      {cards.map((card, cardIndex) => (
        <div key={`kook-card-${cardIndex}`} className="discord-card-preview-embed kook-card-preview">
          {(Array.isArray(card.modules) ? card.modules : []).map((module, moduleIndex) => {
            const key = `${module.type || 'module'}-${moduleIndex}`;
            if (module.type === 'header') return <h4 key={key}>{kookPreviewElementText(module.text)}</h4>;
            if (module.type === 'divider') return <hr key={key} />;
            if (module.type === 'action-group') {
              const buttons = Array.isArray(module.elements) ? module.elements : [];
              return buttons.length ? (
                <div key={key} className="discord-card-preview-buttons" aria-label={t('discordPreviewButtons')}>
                  {buttons.map((button, buttonIndex) => (
                    <span key={`${button.value || 'button'}-${buttonIndex}`}>{kookPreviewButtonLabel(button)}</span>
                  ))}
                </div>
              ) : null;
            }
            if (module.type === 'context') {
              const contextText = (Array.isArray(module.elements) ? module.elements : []).map(kookPreviewElementText).filter(Boolean).join(' · ');
              return contextText ? <small key={key}>{contextText}</small> : null;
            }
            const text = kookPreviewElementText(module.text || module);
            return text ? <pre key={key}>{text}</pre> : null;
          })}
        </div>
      ))}
    </>
  );
}

function BotCollapsibleHeader({ title, description = '', open = true, onToggle, actions = null }) {
  return (
    <div className="bot-collapsible-head">
      <button
        type="button"
        className="bot-collapsible-toggle"
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronDown size={17} />
        <span>{title}</span>
      </button>
      {description && <p>{description}</p>}
      {actions && <div className="heading-actions">{actions}</div>}
    </div>
  );
}

function DiscordPushPreview({ preview = null, t }) {
  const embeds = Array.isArray(preview?.embeds) ? preview.embeds : [];
  const componentRows = Array.isArray(preview?.components) ? preview.components : [];
  const buttons = componentRows.flatMap((row) => Array.isArray(row.components) ? row.components : []);
  const kookCards = Array.isArray(preview?.cards) ? preview.cards : [];
  if (!preview || (!preview.content && !embeds.length && !buttons.length && !kookCards.length)) {
    return <div className="empty-state compact-empty">{t('discordPushCardPreviewEmpty')}</div>;
  }
  return (
    <div className="discord-card-preview">
      {preview.content && (
        <div className="discord-card-preview-content">
          <span>{t('discordPreviewContent')}</span>
          <strong>{preview.content}</strong>
        </div>
      )}
      {embeds.map((embed, index) => (
        <div key={`embed-${index}`} className="discord-card-preview-embed">
          {embed.title && <h4>{embed.title}</h4>}
          {embed.description && <pre>{embed.description}</pre>}
          {Array.isArray(embed.fields) && embed.fields.length ? (
            <div className="discord-card-preview-fields">
              {embed.fields.map((field, fieldIndex) => (
                <div key={`${field.name || 'field'}-${fieldIndex}`}>
                  <span>{field.name || '-'}</span>
                  <p>{field.value || '-'}</p>
                </div>
              ))}
            </div>
          ) : null}
          {embed.image?.url && (
            <img className="discord-card-preview-image" src={embed.image.url} alt={embed.title || t('mapPreview')} loading="lazy" />
          )}
          {embed.footer?.text && <small>{embed.footer.text}</small>}
        </div>
      ))}
      {kookCards.length ? <KookCardPreview cards={kookCards} t={t} /> : null}
      {buttons.length ? (
        <div className="discord-card-preview-buttons" aria-label={t('discordPreviewButtons')}>
          {buttons.map((button, index) => (
            <span key={`${button.custom_id || button.url || button.label || 'button'}-${index}`}>{discordPreviewButtonLabel(button)}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DiscordPushCardModal({
  cardType = 'wipe',
  language = 'en',
  preview = null,
  loading = false,
  pushing = false,
  error = '',
  mentionEveryone = true,
  t,
  lang,
  onLanguageChange,
  onMentionEveryoneChange,
  onPush,
  onCancel
}) {
  const config = DISCORD_PUSH_CARD_CONFIG[cardType] || DISCORD_PUSH_CARD_CONFIG.wipe;
  return (
    <ModalFrame className="wide-modal discord-push-card-modal" labelledBy="discord-push-card-title" onClose={pushing ? undefined : onCancel}>
      <div className="modal-title">
        <div>
          <h3 id="discord-push-card-title">{t('discordPushCardPreviewTitle')}</h3>
          <span className="modal-subtitle">{t(config.pushLabelKey)}</span>
        </div>
      </div>
      <label className="discord-push-language-field">
        <span>{t('discordPushCardDisplayLanguage')}</span>
        <select value={language} onChange={(event) => onLanguageChange?.(event.target.value)} disabled={loading || pushing}>
          {LANGUAGES.map((item) => (
            <option key={item.id} value={item.id}>{languageOptionLabel(item, lang)}</option>
          ))}
        </select>
      </label>
      {cardType === 'wipe' && (
        <label className="checkbox-row discord-push-mention-row">
          <input
            type="checkbox"
            checked={mentionEveryone}
            onChange={(event) => onMentionEveryoneChange?.(event.target.checked)}
            disabled={loading || pushing}
          />
          <span>
            {t('discordPushMentionEveryone')}
            <small>{t('discordPushMentionEveryoneHint')}</small>
          </span>
        </label>
      )}
      <div className="discord-push-preview-section">
        <div className="discord-push-preview-head">
          <strong>{t('discordPushCardTemplatePreview')}</strong>
          {loading && <span>{t('discordPushCardPreviewLoading')}</span>}
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <DiscordPushPreview preview={preview} t={t} />
      </div>
      <div className="modal-actions">
        <button type="button" className="ghost-button" onClick={onCancel} disabled={pushing}>{t('cancel')}</button>
        <button type="button" className="primary-button" onClick={onPush} disabled={loading || pushing || !preview}>
          <Send size={17} />
          <span>{pushing ? t(config.pushingLabelKey) : t('discordPushCardPush')}</span>
        </button>
      </div>
    </ModalFrame>
  );
}

export {
  BotCollapsibleHeader,
  DISCORD_COMMAND_FIELD_MAP,
  DISCORD_PUSH_CARD_CONFIG,
  DiscordPushCardModal,
  KOOK_COMMAND_FIELD_MAP,
  botCommandTypeLabel,
  botTemplateBodyRows,
  createDiscordKookBridgeRouteForm,
  createDiscordRoleSquadRuleDraft,
  createDiscordTargetDraft,
  discordFormFromPayload,
  discordKookBridgeFormFromPayload,
  discordKookBridgeSavePayload,
  discordPushCardLanguage,
  discordSettingsSavePayload,
  kookFormFromPayload,
  kookSettingsSavePayload,
  normalizeDiscordCommandDefinitions,
  normalizeDiscordTargetCommandIds,
  normalizeKookCommandIds,
  normalizeKookEventDefinitions
};
