import {assertCommunityProof} from './community-proof.js';
import { assertOpenWipeProof } from '../discord-open-wipe/proof.js';
import { localizeError as openWipeError } from '../discord-open-wipe/interaction-ui.js';
import { assertSteamLinksProof } from '../discord-steam-links/proof.js';
import { localizeSteamLinksError } from '../discord-steam-links/locale.js';
import { assertCardViewProof } from './card-language-view.js';
import { assertNotificationTransport } from './runtime-mode.js';
import { createPlatformAdapter } from '../scheduling/adapters.js';
import { IdentityError, requireValue } from '../identity/errors.js';
import { discordTimestamp } from './discord-time.js';
import { interactionText } from './interaction-language.js';
import { isIP } from 'node:net';

const actions = new Set(['attending_on_time', 'attending_later', 'join_8h', 'join_16h', 'not_attending', 'copy_connect', 'register_member', 'withdraw']);
const id = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(value);
const text = value => String(value ?? '').replace(/@/g, '@\u200b').replace(/\((met|rol)\)/gi, '(\u200b$1)').slice(0,500);
const connectCommand = value => {
  if (typeof value !== 'string' || value.length > 240) return '';
  const command = value.trim();
  const target = command.replace(/^(?:client\.connect|connect)\s+/iu, '').replace(/^steam:\/\/connect\//iu, '').replace(/\/$/u, '');
  const match = /^(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]):(\d{1,5})$/u.exec(target);
  return match && Number(match[1]) >= 1 && Number(match[1]) <= 65535 ? command : '';
};
const ipConnectCommand = (command, ip) => {
  if (!command || typeof ip !== 'string' || isIP(ip) !== 4) return '';
  const target = command.replace(/^(?:client\.connect|connect)\s+/iu, '').replace(/^steam:\/\/connect\//iu, '').replace(/\/$/u, '');
  const match = /^([a-zA-Z0-9.-]+):(\d{1,5})$/u.exec(target);
  return match && isIP(match[1]) === 0 ? `client.connect ${ip}:${match[2]}` : '';
};
const safeCodes = new Set(['IDENTITY_BINDING_REQUIRED','ACCOUNT_DISABLED','ACCESS_RESTRICTED','ELIGIBILITY_DENIED',
  'ELIGIBILITY_UNAVAILABLE','IDENTITY_CONFLICT','MEMBERSHIP_INACTIVE','MEMBER_VERIFICATION_REQUIRED','MEMBER_OUTSIDE_AUDIENCE',
  'RESOURCE_NOT_FOUND','ACCESS_DENIED','CAPABILITY_DENIED','PERMISSIONS_CHANGED','SIGNUP_NOT_OPEN','SIGNUP_CLOSED','WIPE_IMMUTABLE',
  'REVISION_CONFLICT','CONTENT_RECONFIRM_REQUIRED','IDEMPOTENCY_CONFLICT','SIGNUP_CONFIRMATION_EXPIRED','SIGNUP_CONFIRMATION_INVALID',
  'ARRIVAL_TIME_INVALID','INVALID_TIME','TIME_ZONE_INVALID','PLATFORM_ACTION_REFERENCE_INVALID','PLATFORM_PREFLIGHT_TIMEOUT']);
const safeCode = error => safeCodes.has(error?.errorCode) ? error.errorCode : 'PLATFORM_CALLBACK_FAILED';
const shanghaiTime = value => {
  if (!value) return '待确定';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '待确定';
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const part = type => parts.find(item => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')} (UTC+8)`;
};
const bindingUrl = publicOrigin => `${publicOrigin}/api/auth/kook/start?lang=zh-CN`;

export function notificationMemberUrl(publicOrigin, wipeId) {
  const origin = new URL(publicOrigin);
  requireValue(['http:', 'https:'].includes(origin.protocol) && origin.origin === publicOrigin &&
    !origin.username && !origin.password, 'NOTIFICATION_INPUT_INVALID', 422);
  requireValue(typeof wipeId === 'string' && wipeId.length > 0 && wipeId.length <= 160 && !/[\x00-\x1f\x7f]/.test(wipeId), 'WIPE_REQUIRED', 422);
  return `${origin.origin}/app/wipes/${encodeURIComponent(wipeId)}?tab=plan#signup`;
}

// The HTTP ACK is a protocol receipt only. These bodies are sent exclusively by
// respondPrivate: Discord edits its ephemeral original response; KOOK creates a
// temp_target_id message in the signed source channel. No public send is used.
function privatePayload(platform, verified, body, buttons = []) {
  if (platform === 'discord') return {
    content: body, allowed_mentions: { parse: [], roles: [], users: [], replied_user: false },
    components: buttons.length ? [{ type: 1, components: buttons.map(b => b.url
      ? { type: 2, style: 5, label: b.label, url: b.url }
      : { type: 2, style: 1, label: b.label, custom_id: b.value }) }] : []
  };
  return { type: 10, target_id: verified.channelId, temp_target_id: verified.externalId,
    content: JSON.stringify([{ type: 'card', theme: 'secondary', size: 'lg', modules: [
      { type: 'section', text: { type: 'plain-text', content: body } },
      ...Array.from({ length: Math.ceil(buttons.length / 4) }, (_, index) => ({ type: 'action-group',
        elements: buttons.slice(index * 4, index * 4 + 4).map(b => ({ type: 'button', theme: 'primary',
          value: b.url || b.value, click: b.url ? 'link' : 'return-val', text: { type: 'plain-text', content: b.label } })) }))
    ] }]) };
}

function resultPayload(platform, verified, result, publicOrigin, now) {
  const t = (key, values) => interactionText(platform, verified, key, values);
  const responseLabel = value => t(({ attending_on_time:'onTime', attending_later:'later', not_attending:'absent' })[value] || 'unanswered');
  const displayTime = value => platform === 'discord' ? discordTimestamp(value) || t('unknown') : shanghaiTime(value);
  if (result?.status === 'confirmation_required') {
    const c = result.confirmation;
    requireValue(c && /^[A-Za-z0-9_-]{43}$/.test(c.contextToken), 'SIGNUP_CONFIRMATION_INVALID', 422);
    const url = notificationMemberUrl(publicOrigin, c.wipe.id);
    const lines = [t(c.needsArrivalInput ? 'chooseArrival' : 'confirmPrompt'),
      text(c.wipe.title).slice(0,128),
      `${t('server')}${t('separator')}${text(c.wipe.serverSnapshot?.name || c.wipe.serverProfileId).slice(0,128)}`,
      `${t('wipe')}${t('separator')}${displayTime(c.wipe.serverScheduledWipeAt)}`,
      `${t('current')}${t('separator')}${responseLabel(c.current.response)}`,
      `${t('choice')}${t('separator')}${responseLabel(c.proposedInput.response)}`];
    const buttons = [];
    const open = ['scheduled', 'active'].includes(c.wipe.lifecycle) && c.wipe.effectiveSignupWindow === 'open';
    if (!open) return privatePayload(platform, verified, t('closed'), [{ label: t('view'), url }]);
    if (c.needsArrivalInput) {
      const start = Date.parse(c.wipe.actualStartedAt || c.wipe.serverScheduledWipeAt || c.wipe.musterAt);
      requireValue(Number.isFinite(start), 'ARRIVAL_TIME_INVALID', 422);
      for (const hours of [8,16]) {
        const epoch = start + hours * 3_600_000;
        if (epoch > now()) {
          // Discord button labels do not render timestamp markup. Put the exact
          // localizable choice in the body and keep the button label concise.
          if (platform === 'discord') lines.push(`${t('after', {hours})}${t('separator')}${displayTime(epoch)}`);
          buttons.push({ label: platform === 'discord' ? t('after', {hours}) : `开荒 +${hours} 小时 · ${shanghaiTime(epoch)}`, value: `nblate:${c.contextToken}:${epoch}` });
        }
      }
    } else buttons.push({ label: t('confirm'), value: `nbconfirm:${c.contextToken}` });
    buttons.push({ label: t('edit'), url });
    return privatePayload(platform, verified, lines.join('\n'), buttons);
  }
  if (result?.status === 'already_current') return privatePayload(platform, verified,
    t('already', {status: responseLabel(result.current.response)}),
    [{ label: t('viewSignup'), url: notificationMemberUrl(publicOrigin, result.current.wipeId) }]);
  requireValue(result?.operationReceipt && result.current, 'PLATFORM_CALLBACK_FAILED', 503);
  const { current, replayed } = result;
  const body = [t(replayed ? 'replayed' : 'saved'),
    `${t('current')}${t('separator')}${responseLabel(current.response)}`,
    ...(current.expectedArrivalAt ? [`${t('arrival')}${t('separator')}${displayTime(current.expectedArrivalAt)}`] : [])].join('\n');
  return privatePayload(platform, verified, body, current.discordId ? [] : [{ label: t('view'), url: notificationMemberUrl(publicOrigin, current.wipeId) }]);
}

async function preflight(work, milliseconds) {
  let timer;
  try {
    return await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new IdentityError('PLATFORM_PREFLIGHT_TIMEOUT', 503)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

export function createNotificationCallbackHandler({ platform, identity, scheduling, verify, resolveActionReference,
  publicOrigin, transport, handleCommunity, handleOpenWipe, handleSteamLinks, bindSteamLinksMessage, viewDiscordCard, submitDiscordSignup, now = Date.now, runtimeMode = 'isolated' }) {
  requireValue(['discord','kook'].includes(platform), 'PLATFORM_PROVIDER_INVALID', 422);
  assertNotificationTransport(transport, runtimeMode);
  requireValue(typeof verify === 'function' && typeof resolveActionReference === 'function', 'PLATFORM_VERIFIER_REQUIRED', 503);
  requireValue(identity && scheduling, 'NOTIFICATION_SETUP_REQUIRED', 503);
  notificationMemberUrl(publicOrigin, 'origin-check');

  return async function handle(envelope, io) {
    requireValue(envelope?.rawBody instanceof Uint8Array && typeof io?.ack === 'function', 'PLATFORM_PAYLOAD_INVALID', 422);
    // Reserve ample time for HTTP serialization within KOOK's 1s / Discord's 3s.
    const verified = await preflight(() => verify(envelope), platform === 'kook' ? 650 : 1800);
    requireValue(verified?.provider === platform, 'PLATFORM_AUTH_INVALID', 401);
    if (verified.payload?.kind === 'ping' && platform === 'discord') { await io.ack({ type: 1 }); return; }
    if (verified.payload?.kind === 'challenge' && platform === 'kook') {
      requireValue(typeof verified.payload.challenge === 'string', 'PLATFORM_PAYLOAD_INVALID', 422);
      await io.ack({ challenge: verified.payload.challenge }); return;
    }
    requireValue(id(verified.externalId) && id(verified.interactionId) && id(verified.channelId) &&
      (id(verified.guildId) || platform === 'kook' && verified.guildId === null), 'PLATFORM_AUTH_INVALID', 401);
    const t = (key, values) => interactionText(platform, verified, key, values);
    if (verified.payload?.kind === 'steam_links') {
      assertSteamLinksProof(verified);
      const failure = error => ({ content: localizeSteamLinksError(verified.locale, error?.errorCode),
        allowed_mentions: { parse: [], roles: [], users: [], replied_user: false }, flags: 64 });
      if (verified.payload.action === 'open') {
        let response;
        try {
          requireValue(typeof handleSteamLinks === 'function', 'STEAM_LINKS_UNAVAILABLE', 503);
          response = await preflight(() => handleSteamLinks(verified), 1800);
          requireValue(response?.type === 9, 'PLATFORM_CALLBACK_FAILED', 503);
        } catch (error) { response = { type: 4, data: failure(error) }; }
        await io.ack(response);
        return;
      }
      // Only a verified private component can edit its source panel. A public
      // message can never become a destination for account links or member lists.
      const updatePanel = ['confirm', 'cancel', 'page', 'raw'].includes(verified.payload.action) && verified.originEphemeral === true;
      await io.ack(updatePanel ? { type: 6 } : { type: 5, data: { flags: 64 } });
      let payload;
      try {
        requireValue(typeof handleSteamLinks === 'function', 'STEAM_LINKS_UNAVAILABLE', 503);
        payload = await handleSteamLinks(verified);
        requireValue(payload && (typeof payload.content === 'string' || Array.isArray(payload.embeds)), 'PLATFORM_CALLBACK_FAILED', 503);
      } catch (error) { payload = failure(error); }
      try {
        const body = { ...payload, content: payload.content || '', embeds: payload.embeds || [], components: payload.components || [],
          allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } };
        // Visibility was fixed by the initial ACK; a webhook PATCH retains it.
        delete body.flags;
        const delivered = await transport.respondPrivate({ platform, verifiedInteraction: verified, payload: body,
          signal: new AbortController().signal });
        if (delivered?.messageId && bindSteamLinksMessage) await bindSteamLinksMessage(verified, payload, delivered.messageId);
      }
      catch { throw new IdentityError('PRIVATE_RESPONSE_UNKNOWN', 503); }
      return;
    }
    if (verified.payload?.kind === 'open_wipe') {
      assertOpenWipeProof(verified);
      const failure = error => ({ content: openWipeError(verified.locale, error?.errorCode), allowed_mentions: { parse: [] } });
      if (['open', 'settings', 'server', 'edit_details'].includes(verified.payload.action)) {
        let response;
        try {
          requireValue(typeof handleOpenWipe === 'function', 'OPEN_WIPE_UNAVAILABLE', 503);
          response = await preflight(() => handleOpenWipe(verified), 1800);
          requireValue([4, 9].includes(response?.type), 'PLATFORM_CALLBACK_FAILED', 503);
          if (response.type === 4) {
            const data = { ...response.data, flags: 64 | (response.data?.flags === (32768 | 64) || response.data?.flags === 32768 ? 32768 : 0) };
            if (data.flags & 32768) { delete data.content; delete data.embeds; }
            response = { type: 4, data };
          }
        } catch (error) { response = { type: 4, data: { ...failure(error), flags: 64 } }; }
        await io.ack(response);
        return;
      }
      // A select changes its actor-only setup panel in place. Never use an
      // update ACK for a public origin, even if a forged select reuses a token.
      const updatePanel = verified.payload.action === 'select_server' && verified.originEphemeral === true;
      await io.ack(updatePanel ? { type: 6 } : { type: 5, data: { flags: 64 } });
      let payload;
      try {
        requireValue(typeof handleOpenWipe === 'function', 'OPEN_WIPE_UNAVAILABLE', 503);
        payload = await handleOpenWipe(verified);
        requireValue(payload && (typeof payload.content === 'string' || Array.isArray(payload.embeds)), 'PLATFORM_CALLBACK_FAILED', 503);
      } catch (error) { payload = updatePanel ? { flags: 32768, content: '', embeds: [],
        components: [{ type: 10, content: failure(error).content }] } : failure(error); }
      try { await transport.respondPrivate({ platform, verifiedInteraction: verified,
        payload: { ...payload, content: payload.content || '', embeds: payload.embeds || [], components: payload.components || [],
          allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } }, signal: new AbortController().signal }); }
      catch { throw new IdentityError('PRIVATE_RESPONSE_UNKNOWN', 503); }
      return;
    }
    if (verified.payload?.kind === 'card_view') {
      assertCardViewProof(verified);
      await io.ack({ type: 5, data: { flags: 64 } });
      let payload;
      try {
        requireValue(typeof viewDiscordCard === 'function', 'PLATFORM_CALLBACK_FAILED', 503);
        payload = await viewDiscordCard(verified);
        requireValue(payload && (typeof payload.content === 'string' || Array.isArray(payload.embeds)), 'PLATFORM_CALLBACK_FAILED', 503);
        payload = { ...payload, content: payload.content || '', allowed_mentions: { parse: [], roles: [], users: [], replied_user: false } };
      } catch (error) { payload = privatePayload(platform, verified, t('cardUnavailable', { code: safeCode(error) })); }
      try { await transport.respondPrivate({ platform, verifiedInteraction: verified, payload, signal: new AbortController().signal }); }
      catch { throw new IdentityError('PRIVATE_RESPONSE_UNKNOWN', 503); }
      return;
    }
    if (verified.payload?.kind === 'community') {
      assertCommunityProof(verified,platform);
      const input=verified.payload;
      // A Discord modal must be the initial HTTP response, never a deferred reply.
      if(platform==='discord'&&input.command==='vip'&&(['open','provider'].includes(input.nativeAction)||input.nativeAction==='type'&&input.type!=='none')){
        try{requireValue(typeof handleCommunity==='function','COMMUNITY_HANDLER_UNAVAILABLE',503);const r=await preflight(()=>handleCommunity(verified),1800);requireValue(r?.privacy==='actor_only'&&[4,9].includes(r.data?.interaction?.type),'PLATFORM_CALLBACK_FAILED',503);await io.ack(r.data.interaction);}
        catch(error){await io.ack({type:4,data:{flags:64,content:t('vipOpenFailed', {code:safeCode(error)}),allowed_mentions:{parse:[]}}});}
        return;
      }
      await io.ack(platform === 'discord' ? {type:5,data:{flags:64}} : {});
      let message;
      try {
        requireValue(typeof handleCommunity === 'function','COMMUNITY_HANDLER_UNAVAILABLE',503);
        const result=await handleCommunity(verified);
        requireValue(result?.privacy==='actor_only','PLATFORM_CALLBACK_FAILED',503);
        const data=result.data, success=result.status==='succeeded' && data?.state==='succeeded';
        const label=['vip','wipe_card','ranking_switch'].includes(input.command)?'operation':'query';
        message=[t(label+(success?'Done':data?.state==='failed'?'Failed':'Pending')),
          ...(data?.items||[]).slice(0,8).map(item=>text(item.label)),
          ...(!success?[text(data?.errorCode||t('resultPending'))]:[])].join('\n').slice(0,1900);
      } catch (error) { message=t('communityFailed', {code:error?.errorCode==='COMMUNITY_HANDLER_UNAVAILABLE'?'COMMUNITY_HANDLER_UNAVAILABLE':safeCode(error)}); }
      try { await transport.respondPrivate({platform,verifiedInteraction:verified,payload:privatePayload(platform,verified,message),signal:new AbortController().signal}); }
      catch { throw new IdentityError('PRIVATE_RESPONSE_UNKNOWN',503); }
      return;
    }
    const trusted = structuredClone(verified);
    let submitted, referenceError;
    try {
      if (trusted.payload?.kind === 'confirm') {
        // Preserve G04's private displayed versions. Never read a latest signup
        // or content revision here to "help" the member confirm a newer state.
        submitted = { kind: 'confirm', contextToken: trusted.payload.contextToken,
          ...(trusted.payload.input === undefined ? {} : { input: trusted.payload.input }) };
      } else {
        requireValue(typeof trusted.actionReference === 'string' && trusted.actionReference.length > 0,
          'PLATFORM_ACTION_REFERENCE_INVALID', 401);
        const reference = await preflight(() => resolveActionReference(trusted.actionReference,
          { platform, guildId: trusted.guildId, channelId: trusted.channelId }), platform === 'kook' ? 100 : 200);
        requireValue(reference && typeof reference.wipeId === 'string' && Number.isSafeInteger(reference.contentRevision) &&
          reference.contentRevision > 0 && actions.has(reference.action) && typeof reference.timeZone === 'string' &&
          (reference.expiresAt === null || Number.isFinite(Date.parse(reference.expiresAt)) && Date.parse(reference.expiresAt) > now()),
        'PLATFORM_ACTION_REFERENCE_INVALID', 401);
        requireValue(reference.action !== 'withdraw' || platform === 'kook', 'PLATFORM_ACTION_REFERENCE_INVALID', 401);
        submitted = { kind: 'public', adapterVersion: 2, wipeId: reference.wipeId,
          contentRevision: reference.contentRevision, action: reference.action, timeZone: reference.timeZone,
          signupMode: reference.signupMode || 'member_required',
          ...(reference.action === 'copy_connect' ? { directConnect: connectCommand(reference.directConnect), directConnectIp: reference.directConnectIp } : {}) };
      }
    } catch (error) { referenceError = error; }
    await io.ack(platform === 'discord' ? { type: 5, data: { flags: 64 } } : {});
    const controller = new AbortController();
    const reply = async payload => {
      try { await transport.respondPrivate({ platform, verifiedInteraction: trusted, payload, signal: controller.signal }); }
      catch { throw new IdentityError('PRIVATE_RESPONSE_UNKNOWN', 503); }
    };
    if (referenceError) {
      await reply(privatePayload(platform, trusted, t('referenceError', {code: safeCode(referenceError)})));
      return;
    }
    if (submitted.action === 'copy_connect') {
      const ipCommand = ipConnectCommand(submitted.directConnect, submitted.directConnectIp);
      await reply(privatePayload(platform, trusted, submitted.directConnect
        ? t(ipCommand ? 'connectWithIp' : 'connect', {command: submitted.directConnect, ipCommand})
        : t('noConnect')));
      return;
    }
    if (submitted.action === 'register_member') {
      await reply(privatePayload(platform, trusted, t('registerPrompt'),
        [{ label: t('register'), url: `${publicOrigin}/api/v2/auth/discord/start?returnTo=%2Fapp%2Fme` }]));
      return;
    }
    if (platform === 'kook') await reply(privatePayload(platform, trusted, '正在处理报名…'));
    let payload;
    try {
      if (platform === 'discord' && submitted.signupMode === 'discord_only') {
        requireValue(typeof submitDiscordSignup === 'function', 'PLATFORM_CALLBACK_FAILED', 503);
        const result = await submitDiscordSignup(trusted);
        payload = resultPayload(platform, trusted, result, publicOrigin, now);
      } else {
        const {signupMode,...adapterPayload}=submitted;
        const adapter = createPlatformAdapter({ provider: platform, identity, service: scheduling, now,
          verify: async () => ({ provider: platform, externalId: trusted.externalId,
            interactionId: trusted.interactionId, payload: adapterPayload }) });
        const result = await adapter.submit(null);
        payload = resultPayload(platform, trusted, result, publicOrigin, now);
      }
    } catch (error) {
      payload = platform === 'discord' && error?.errorCode === 'IDENTITY_BINDING_REQUIRED'
        ? privatePayload(platform, trusted, t('registerPrompt'),
          [{ label: t('register'), url: `${publicOrigin}/api/v2/auth/discord/start?returnTo=%2Fapp%2Fme` }])
        : platform === 'kook' && error?.errorCode === 'IDENTITY_BINDING_REQUIRED'
        ? privatePayload(platform, trusted, '请先在网站绑定 Steam 账号，再返回这里报名。',
          [{ label: '前往网站绑定 Steam', url: bindingUrl(publicOrigin) }])
        : privatePayload(platform, trusted, t('notSaved', {code: safeCode(error)}));
    }
    // Returned Promise covers eligibility, G04 transaction and this final private
    // result. The HTTP runtime must retain it after ACK and observe rejection.
    await reply(payload);
  };
}
