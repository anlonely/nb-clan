import { need, text, stamp, hash } from '../../stats/model.js';
import { riskConfiguration } from './risk-model.js';
import { discordAuditConfiguration } from './discord-membership.js';
const sync = value => { need(!value?.then, 'SOURCE_CONFIG_SYNC_REQUIRED', 503); return value; };
export function createSourceConfiguration({ readSettings, readWipe, readServerProfile, readLegacyWipe, readCredentials, readProxyUrl, readWindow, readDiscordSettings, readDiscordContext, readKookContext, readProviderBindings, capabilities = {} }) {
  need(typeof readSettings === 'function' && typeof readWipe === 'function', 'SOURCE_NOT_CONFIGURED', 503);
  const settings = () => sync(readSettings()) || {};
  const enabled = name => capabilities[name] === true;
  function credentials(source) {
    const s = settings(), injected = sync(readCredentials?.()) || {};
    // Preserve audited precedence without consulting process.env or mutating settings.
    const steamKey = s.steamWebApi?.apiKey || injected.steamApiKey || '';
    const bmKeys = [...new Set((s.battlemetrics?.apiKeys || []).map(k => typeof k?.apiKey === 'string' ? k.apiKey.trim() : '').filter(Boolean))];
    const legacyBmKey = String(s.battlemetrics?.apiKey || '').trim();
    const battlemetricsKey = injected.battlemetricsApiKey || (legacyBmKey && !bmKeys.includes(legacyBmKey) ? legacyBmKey : bmKeys[0] || legacyBmKey);
    const service = source === 'battlemetrics' ? 'battlemetrics' : source === 'discord' ? 'discord' : 'kda';
    const p = s.system?.proxy || {}, scope = ['global', 'battlemetrics', 'kda'].includes(p.scope) ? p.scope : 'global';
    const proxyEnabled = p.enabled !== false;
    const selected = proxyEnabled && (p.nodeId || p.url) && (scope === 'global' || scope === service);
    // The production network owns node resolution. Never silently bypass a selected node.
    need(source === 'kook' || !selected || !p.nodeId || typeof readProxyUrl === 'function', 'PROXY_UNAVAILABLE', 503);
    const proxyUrl = !proxyEnabled || source === 'kook' ? '' : readProxyUrl ? sync(readProxyUrl(service)) : (selected ? p.url : injected[`${service}ProxyUrl`] || injected.proxyUrl || '');
    need(typeof proxyUrl === 'string', 'PROXY_UNAVAILABLE', 503);
    need(source === 'kook' || !selected || Boolean(proxyUrl), 'PROXY_UNAVAILABLE', 503);
    if (proxyUrl) {
      let url; try { url = new URL(proxyUrl); } catch { need(false, 'PROXY_UNAVAILABLE', 503); }
      need(['http:', 'https:', 'socks:', 'socks4:', 'socks4a:', 'socks5:', 'socks5h:'].includes(url.protocol), 'PROXY_UNAVAILABLE', 503);
    }
    return { key: String(source === 'battlemetrics' ? battlemetricsKey : source === 'steam' ? steamKey : source === 'discord' ? injected.discordBotToken || (sync(readDiscordSettings?.()) || s.discord || {}).botToken || '' : source === 'kook' ? injected.kookBotToken || s.kook?.botToken || '' : '').trim(), proxyUrl: String(proxyUrl) };
  }
  function readSourceConfig({ type, scope = {}, member, memberships = [], riskWipes = [], profile: memberProfile } = {}) {
    if (type === 'member_profile' && enabled('memberRisk')) {
      const config = riskConfiguration({ settings: settings(), member, profile: memberProfile, memberships, riskWipes, credentials, capabilities });
      if (readProviderBindings) {
        const bindings = sync(readProviderBindings());
        need(bindings && typeof bindings === 'object' && !Array.isArray(bindings), 'SOURCE_CONFIG_SYNC_REQUIRED', 503);
        const encoded = JSON.stringify(bindings);
        need(encoded && encoded.length <= 8192, 'SOURCE_CONFIG_SYNC_REQUIRED', 503);
        config.riskBinding = hash([config.riskBinding, bindings]);
      }
      return config;
    }
    if (type === 'discord_membership_audit') {
      const linked = member?.id && readDiscordContext ? sync(readDiscordContext(member.id)) || {} : {};
      return discordAuditConfiguration({ settings: readDiscordContext ? {} : sync(readDiscordSettings?.()) || settings().discord || {},
        policy: readDiscordContext ? linked.policy : undefined, externalId: linked.externalId,
        member, memberships, credentials: credentials('discord'), enabled: enabled('discordMembershipAudit') });
    }
    if (type === 'kook_member_sync') {
      const linked = member?.id ? sync(readKookContext?.(member.id)) || {} : {};
      const policy = linked.policy || {}, guildId = text(policy.guildId, 80), externalId = text(linked.externalId, 80);
      const expectedRoleIds = Array.isArray(policy.allowedRoleIds) ? [...new Set(policy.allowedRoleIds.map(String))] : [];
      const syncBinding = hash({ externalId, guildId, expectedRoleIds, matchMode: policy.matchMode,
        policyRevision: policy.policyRevision || 0, mappingRevision: linked.mappingRevision || 0, credentials: credentials('kook') });
      return { enabled: Boolean(enabled('kookMemberSync') && credentials('kook').key && policy.enabled && guildId && expectedRoleIds.length && externalId),
        sourceId: 'kook', guildId, externalId, expectedRoleIds, matchMode: policy.matchMode === 'all' ? 'all' : 'any',
        policyRevision: policy.policyRevision || 0, syncBinding };
    }
    need(['battlemetrics_identity','battlemetrics_playtime','kda','hexaytron_profile','member_profile','steam_profile_backfill','local_consistency'].includes(type), 'INVALID_DATA');
    const wipeId = scope.wipeId || (scope.kind === 'current_wipe' ? scope.id : null);
    const wipe = wipeId ? sync(readWipe(wipeId)) : null;
    const profile = wipe?.serverProfileId ? sync(readServerProfile?.(wipe.serverProfileId)) || {} : {};
    const legacy = wipe?.legacyRaw || (wipeId ? sync(readLegacyWipe?.(wipeId)) : null) || {};
    // Frozen V2 server snapshot is authoritative. Legacy fields only fill absent keys.
    const source = { ...legacy, ...profile, ...wipe?.serverSnapshot };
    const explicitProvider = String(source.kdaProvider || '').trim().toLowerCase();
    const provider = ['vital','manual','none'].includes(explicitProvider) ? explicitProvider : source.vitalServerId ? 'vital' : 'manual';
    const prior = member && scope.sourceContexts?.[member.id];
    const windowBinding = type === 'battlemetrics_playtime' ? hash({ wipeId: wipe?.id || '', revision: wipe?.revision || 0,
      contentRevision: wipe?.contentRevision || 0, lifecycle: wipe?.lifecycle || '', serverId: wipe?.serverProfileId || '',
      provider, vitalServerId: source.vitalServerId || '', vitalWipeId: source.vitalWipeId || '',
      battlemetricsServerId: String(source.battlemetricsId || source.battlemetricsServerId || ''),
      from: stamp(wipe?.serverActualWipeAt || wipe?.actualStartedAt || wipe?.serverScheduledWipeAt || legacy.startedAt) || '',
      to: stamp(wipe?.endedAt || legacy.closedAt) || '', enabled: enabled('battlemetrics'), credentials: credentials('battlemetrics') }) : '';
    const explicit = type === 'battlemetrics_playtime' ? sync(readWindow?.({ type, wipe, scope, member, binding: windowBinding })) || {} : {};
    const from = stamp(explicit.from || wipe?.serverActualWipeAt || wipe?.actualStartedAt || wipe?.serverScheduledWipeAt || legacy.startedAt) || '';
    const to = stamp(explicit.to || wipe?.endedAt || legacy.closedAt) || '';
    const common = {
      sourceId: type === 'kda' ? provider : type.startsWith('battlemetrics_') ? 'battlemetrics' : type === 'hexaytron_profile' ? 'hexaytron' : type === 'local_consistency' ? 'local' : 'steam',
      serverId: text(wipe?.serverProfileId), providerServerId: text(String(source.vitalServerId || '')),
      providerWipeId: text(String(source.vitalWipeId || '')),
      battlemetricsServerId: /^\d{1,30}$/.test(String(source.battlemetricsId || source.battlemetricsServerId || '')) ? String(source.battlemetricsId || source.battlemetricsServerId) : '',
      from: type === 'battlemetrics_playtime' ? from : '', to: type === 'battlemetrics_playtime' ? to : ''
    };
    // sourceContexts is never a source of window values here. The host readWindow
    // must resolve a saved intent/job independently; supplied context is only a consistency check.
    if (type === 'battlemetrics_playtime' && prior) need(stamp(prior.from) === (from || null) && stamp(prior.to) === (to || null), 'SOURCE_WINDOW_INVALID', 503);
    let allowed = false;
    if (type === 'local_consistency') allowed = true;
    else if (type === 'member_profile' || type === 'steam_profile_backfill') allowed = enabled('steam') && Boolean(credentials('steam').key);
    else if (type === 'battlemetrics_identity') allowed = enabled('battlemetrics') && Boolean(credentials('battlemetrics').key);
    else if (type === 'battlemetrics_playtime') allowed = enabled('battlemetrics') && Boolean(credentials('battlemetrics').key && common.serverId && common.battlemetricsServerId && from && to && Date.parse(to) >= Date.parse(from));
    else if (type === 'kda') allowed = enabled('vital') && provider === 'vital' && Boolean(common.serverId && /^\d{1,8}$/.test(common.providerServerId) && common.providerWipeId);
    else if (type === 'hexaytron_profile') allowed = false;
    return { enabled: Boolean(allowed), ...common, ...(windowBinding ? { windowBinding } : {}), ...(!allowed ? { unavailableReason: type === 'battlemetrics_playtime' && (!from || !to) ? 'SOURCE_WINDOW_REQUIRED' : 'SOURCE_NOT_CONFIGURED' } : {}) };
  }
  return { readSourceConfig, credentials, enabled };
}
