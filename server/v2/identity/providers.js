import nodeFetch from 'node-fetch';
import { assertLocalMode } from '../../local-mode.js';
import { kookSteamAuthorizationUrl, verifyKookSteamIdentity } from '../../kook-steam-openid.js';
import { IdentityError, requireValue } from './errors.js';
import { createKookRequestGate } from './kook-request-gate.js';

export function publicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new IdentityError('LOGIN_NOT_CONFIGURED', 503); }
  requireValue(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/' &&
    (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)), 'LOGIN_NOT_CONFIGURED', 503);
  return url.origin;
}
export function providerConfiguration(env = process.env) {
  const origin = publicOrigin(env.NB_V2_PUBLIC_ORIGIN || env.NB_PUBLIC_BASE_URL);
  const localMode = assertLocalMode(env);
  const config = { origin };
  if (localMode) return { origin, discord: { clientId: '', clientSecret: '', redirectUri: `${origin}/api/v2/auth/discord/callback` },
    kook: { clientId: '', clientSecret: '', redirectUri: `${origin}/api/v2/auth/kook/callback` } };
  for (const provider of ['discord', 'kook']) {
    const key = provider.toUpperCase();
    const parseCallback = value => {
      let url; try { url = new URL(value); } catch { throw new IdentityError('LOGIN_NOT_CONFIGURED', 503); }
      publicOrigin(url.origin);
      requireValue(!url.search && !url.hash && !url.username && !url.password &&
        [`/api/auth/${provider}/callback`, `/api/v2/auth/${provider}/callback`].includes(url.pathname) &&
        (env.NB_V2_PRODUCTION_ENABLED !== '1' || url.protocol === 'https:'), 'LOGIN_NOT_CONFIGURED', 503);
      return url;
    };
    const legacy = env[`NB_${key}_OAUTH_REDIRECT_URI`] ? parseCallback(env[`NB_${key}_OAUTH_REDIRECT_URI`]) : null;
    const callback = env[`NB_V2_${key}_OAUTH_REDIRECT_URI`] || legacy?.href || `${origin}/api/v2/auth/${provider}/callback`;
    const url = parseCallback(callback);
    // Only the configured application and this provider's existing callback host
    // are allowed. Request headers and returnTo can never add another host.
    requireValue(new Set([origin, legacy?.origin].filter(Boolean)).has(url.origin), 'LOGIN_NOT_CONFIGURED', 503);
    config[provider] = { clientId: env[`NB_${key}_OAUTH_CLIENT_ID`] || '',
      clientSecret: env[`NB_${key}_OAUTH_CLIENT_SECRET`] || '', redirectUri: url.href };
  }
  return config;
}

export function createProviders(config, { settings, fetch = nodeFetch, kookGate = createKookRequestGate(), kookGuildCacheMs = 60_000 } = {}) {
  const guildCache = new Map();
  async function json(url, options = {}, timeoutMs = 15_000) {
    try {
      const request = () => {
        const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
        return fetch(url, { ...options, redirect: 'error', signal });
      };
      const botRequest = url.startsWith('https://www.kookapp.cn/api/v3/') && options.headers?.authorization?.startsWith('Bot ');
      const response = botRequest ? await kookGate.run(request) : await request();
      if (response.status === 429 && url.includes('kookapp.cn')) {
        const after = Number(response.headers?.get?.('retry-after'));
        const reset = Number(response.headers?.get?.('x-rate-limit-reset'));
        const retryAfterSeconds = Number.isFinite(after) && after > 0 ? Math.ceil(after)
          : Number.isFinite(reset) && reset > 0 ? Math.ceil(reset) : 5;
        const wait = Math.min(600, Math.max(1, retryAfterSeconds));
        if (botRequest) kookGate.cooldown(wait);
        throw new IdentityError('KOOK_RATE_LIMITED', 503, { retryAfterSeconds: wait });
      }
      if (botRequest && response.headers?.get?.('x-rate-limit-remaining') === '0') {
        const reset = Number(response.headers.get('x-rate-limit-reset'));
        if (Number.isFinite(reset) && reset > 0) kookGate.cooldown(Math.min(600, Math.ceil(reset)));
      }
      if (!response.ok) throw new IdentityError(response.status === 404 ? 'ELIGIBILITY_DENIED' : 'ELIGIBILITY_UNAVAILABLE', response.status === 404 ? 403 : 503);
      return await response.json();
    } catch (error) {
      if (error instanceof IdentityError) throw error;
      throw new IdentityError('ELIGIBILITY_UNAVAILABLE', 503);
    }
  }
  function guildMetadata(guildId, botToken) {
    const key = `${guildId}:${botToken}`;
    const previous = guildCache.get(key);
    if (previous && previous.expiresAt > Date.now()) return previous.promise;
    const promise = json(`https://www.kookapp.cn/api/v3/guild/view?${new URLSearchParams({ guild_id: guildId })}`,
      { headers: { authorization: `Bot ${botToken}` } }, 5_000);
    if (kookGuildCacheMs > 0) {
      guildCache.set(key, { promise, expiresAt: Date.now() + kookGuildCacheMs });
      promise.catch(() => { if (guildCache.get(key)?.promise === promise) guildCache.delete(key); });
      if (guildCache.size > 100) guildCache.delete(guildCache.keys().next().value);
    }
    return promise;
  }
  return Object.fromEntries(['discord', 'kook'].map(provider => {
    const c = config[provider], discord = provider === 'discord';
    return [provider, {
      redirectUri: c.redirectUri,
      configured: () => Boolean(c.clientId && c.clientSecret),
      authorizationUrl(state) {
        requireValue(this.configured(), 'LOGIN_NOT_CONFIGURED', 503);
        return `${discord ? 'https://discord.com/oauth2/authorize' : 'https://www.kookapp.cn/app/oauth2/authorize'}?${new URLSearchParams({
          client_id: c.clientId, redirect_uri: c.redirectUri, response_type: 'code', scope: discord ? 'identify' : 'get_user_info', state })}`;
      },
      async exchange(code) {
        requireValue(this.configured(), 'LOGIN_NOT_CONFIGURED', 503);
        try {
          const token = await json(discord ? 'https://discord.com/api/oauth2/token' : 'https://www.kookapp.cn/api/oauth2/token', {
            method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', client_id: c.clientId, client_secret: c.clientSecret,
              code, redirect_uri: c.redirectUri }).toString()
          });
          requireValue(typeof token.access_token === 'string' && token.access_token && token.token_type?.toLowerCase() === 'bearer', 'AUTH_INVALID_CALLBACK', 401);
          const payload = await json(discord ? 'https://discord.com/api/v10/users/@me' : 'https://www.kookapp.cn/api/v3/user/me', {
            headers: { authorization: `Bearer ${token.access_token}` }
          });
          const profile = discord ? payload : payload.code === 0 && payload.data;
          requireValue(typeof profile?.id === 'string' && profile.id.length > 0 && profile.id.length <= 80 && !profile.bot, 'AUTH_INVALID_CALLBACK', 401);
          let avatarUrl = '';
          if (discord && /^\d{15,22}$/.test(profile.id) && /^(?:a_)?[a-f0-9]{32}$/.test(profile.avatar || ''))
            avatarUrl = `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128`;
          else if (!discord) {
            try {
              const url = new URL(profile.avatar || '');
              if (url.protocol === 'https:' && ['img.kookapp.cn', 'img.kaiheila.cn'].includes(url.hostname) &&
                !url.username && !url.password && !url.port && !url.hash) avatarUrl = url.href;
            } catch { /* Avatar is optional profile metadata. */ }
          }
          return { provider, id: profile.id, displayName: String(profile.global_name || profile.nickname || profile.username || '').trim().slice(0, 120), avatarUrl };
        } catch (error) {
          if (['LOGIN_NOT_CONFIGURED', 'KOOK_RATE_LIMITED', 'KOOK_BUSY'].includes(error.errorCode)) throw error;
          if (!discord && error.errorCode === 'ELIGIBILITY_UNAVAILABLE') throw new IdentityError('KOOK_UNAVAILABLE', 503);
          throw new IdentityError('AUTH_INVALID_CALLBACK', 401);
        }
      },
      async admissionRoles(guildId) {
        const runtime = await settings();
        const botToken = runtime.settings?.[provider]?.botToken;
        requireValue(botToken, 'ELIGIBILITY_UNAVAILABLE', 503);
        const payload = await json(discord ? `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/roles`
          : `https://www.kookapp.cn/api/v3/guild/view?${new URLSearchParams({ guild_id: guildId })}`, {
          headers: { authorization: `Bot ${botToken}` }
        });
        const roles = discord ? payload : payload.code === 0 && String(payload.data?.id) === guildId && payload.data.roles;
        requireValue(Array.isArray(roles) && roles.length > 0 && roles.length <= 500 &&
          roles.every(role => typeof (discord ? role.id : role.role_id) === 'string' ||
            Number.isSafeInteger(discord ? role.id : role.role_id)) &&
          (!discord || roles.some(role => role.id === guildId)), 'ELIGIBILITY_UNAVAILABLE', 503);
        return [...new Set(roles.map(role => String(discord ? role.id : role.role_id)))];
      },
      async roles(externalId, guildId, { includeCommunity = false, admissionRoleIds = [], signal } = {}) {
        const runtime = await settings();
        const botToken = runtime.settings?.[provider]?.botToken;
        requireValue(botToken, 'ELIGIBILITY_UNAVAILABLE', 503);
        let verifiedGuild = null;
        if (admissionRoleIds.length) {
          requireValue(Array.isArray(admissionRoleIds) && admissionRoleIds.length <= 500 &&
            admissionRoleIds.every(id => typeof id === 'string' && id.length <= 80), 'ELIGIBILITY_UNAVAILABLE', 503);
          let response;
          try {
            response = await json(discord ? `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`
              : `https://www.kookapp.cn/api/v3/guild/view?${new URLSearchParams({ guild_id: guildId })}`,
            { headers: { authorization: `Bot ${botToken}` }, signal }, 5_000);
          } catch (error) {
            if (error?.errorCode === 'ELIGIBILITY_DENIED') throw new IdentityError('ADMISSION_ROLE_CONFIG_INVALID', 503);
            throw error;
          }
          verifiedGuild = discord ? response : response.code === 0 && response.data;
          requireValue(String(verifiedGuild?.id) === guildId && Array.isArray(verifiedGuild.roles) &&
            verifiedGuild.roles.length <= 500, 'ELIGIBILITY_UNAVAILABLE', 503);
          const available = new Set(verifiedGuild.roles.map(role => String(discord ? role.id : role.role_id)));
          requireValue(admissionRoleIds.every(id => available.has(id)), 'ADMISSION_ROLE_CONFIG_INVALID', 503);
        }
        const payload = await json(discord ? `https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(externalId)}`
          : `https://www.kookapp.cn/api/v3/user/view?${new URLSearchParams({ user_id: externalId, guild_id: guildId })}`, {
          headers: { authorization: `Bot ${botToken}` }, signal
        });
        const user = discord ? payload.user : payload.data;
        requireValue(discord || payload.code === 0, 'ELIGIBILITY_UNAVAILABLE', 503);
        requireValue(user?.id === externalId && !user.bot && (discord || Number(user.status) !== 10), 'ELIGIBILITY_DENIED');
        const roles = discord ? payload.roles : user.roles;
        requireValue(Array.isArray(roles) && roles.every(r => typeof r === 'string' || Number.isSafeInteger(r)), 'ELIGIBILITY_UNAVAILABLE', 503);
        const roleIds = roles.map(String);
        let community;
        if (includeCommunity) {
          community = { name: '', iconUrl: null, roles: [], available: false };
          try {
            const payload = verifiedGuild ? null : discord
              ? await json(`https://discord.com/api/v10/guilds/${encodeURIComponent(guildId)}`,
                { headers: { authorization: `Bot ${botToken}` }, signal }, 5_000)
              : await guildMetadata(guildId, botToken);
            const guild = verifiedGuild || (discord ? payload : payload.code === 0 && payload.data);
            requireValue(String(guild?.id) === guildId && typeof guild.name === 'string' && Array.isArray(guild.roles), 'ELIGIBILITY_UNAVAILABLE', 503);
            const ownRoles = new Set(roleIds);
            let iconUrl = null;
            const icon = discord && /^(?:a_)?[a-f0-9]{32}$/.test(guild.icon || '')
              ? `https://cdn.discordapp.com/icons/${encodeURIComponent(guildId)}/${guild.icon}.png?size=128` : !discord ? guild.icon : null;
            try {
              const url = new URL(icon);
              if (url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
                ['cdn.discordapp.com', 'img.kookapp.cn', 'img.kaiheila.cn'].includes(url.hostname)) iconUrl = url.href;
            } catch {}
            community = { name: guild.name.slice(0, 120), iconUrl, available: true,
              roles: guild.roles.filter(r => ownRoles.has(String(discord ? r.id : r.role_id)))
                .map(r => ({ id: String(discord ? r.id : r.role_id), name: String(r.name || '').slice(0, 100) })).filter(r => r.name) };
          } catch { /* Optional display metadata never grants or denies membership. */ }
        }
        return { externalId, guildId, roleIds, ...(includeCommunity ? { community } : {}) };
      }
    }];
  }));
}

// Both community providers use exactly the same Steam assertion verifier.
export const steamProvider = {
  authorizationUrl: kookSteamAuthorizationUrl,
  async verify(query, returnTo) {
    if (query['openid.mode'] === 'cancel') throw new IdentityError('AUTH_CANCELLED', 400);
    try { return await verifyKookSteamIdentity(query, returnTo); }
    catch (error) {
      if (error.errorKey === 'steamRateLimited') throw new IdentityError('STEAM_RATE_LIMITED', 503,
        { retryAfterSeconds: error.retryAfterSeconds });
      if (error.errorKey === 'steamUnavailable') throw new IdentityError('STEAM_UNAVAILABLE', 503);
      throw new IdentityError('AUTH_INVALID_CALLBACK', 401);
    }
  }
};
