import { randomBytes } from 'node:crypto';
import { runStoreWriteTask as defaultWriteTask } from '../../store.js';
import { IdentityError } from '../identity/errors.js';
import { assertSteamLinksProof } from './proof.js';
import { parseSteamIdentifier } from './interaction-input.js';
import { DiscordSteamLinksRepository, SteamLinksWriteError, steamLinkKey, steamLinksDigest } from './repository.js';
import { steamLinksText as text } from './locale.js';
import { privateSteamLinksPayload, steamLinksModal, steamLinkConfirmation, renderSteamLinksList, steamTeamSummary } from './renderer.js';
import { renderSteamProfile } from './profile.js';
import { matchSteamTeam, steamTeamSyncStatuses } from './team-matching.js';

const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const steamId = value => typeof value === 'string' && /^\d{17}$/.test(value);
const need = (ok, code, status = 409) => { if (!ok) throw new IdentityError(code, status); };
const CONTEXT_TTL = 15 * 60_000, RECEIPT_TTL = 24 * 60 * 60_000;
const MUTATIONS = new Set(['submit', 'confirm', 'cancel']);
const reply = (proof, key, values) => privateSteamLinksPayload(text(proof.locale, key, values));

/** A Discord guild's self-declared links. Optional website team updates use a
 * trusted synchronous adapter; a declared Steam ID never authenticates a user. */
export function createDiscordSteamLinksService({ db, readConfig, provider, now = Date.now,
  runStoreWriteTask = defaultWriteTask, providerTimeoutMs = 12_000, syncMemberTeam } = {}) {
  need(db && typeof readConfig === 'function' && provider, 'STEAM_LINK_SERVICE_UNAVAILABLE', 503);
  const repo = new DiscordSteamLinksRepository(db), inFlight = new Map();
  const configured = (proof, command, list = false) => {
    need(proof.provider === 'discord' && [proof.guildId, proof.channelId, proof.externalId].every(snowflake), 'PLATFORM_AUTH_INVALID', 401);
    const config = readConfig();
    need(config?.enabled === true, 'PLATFORM_DISABLED', 403);
    const commands = (config.commands || []).filter(row => row.id === command);
    need(commands.length === 1 && commands[0].enabled === true && commands[0].type === 'slash_command' &&
      commands[0].slashCommand === command, 'COMMAND_DISABLED', 403);
    const targets = (config.targets || []).filter(row => row.enabled === true && row.guildId === proof.guildId &&
      row.channelId === proof.channelId && row.enabledCommandIds?.includes(command));
    need(targets.length === 1, 'PLATFORM_CHANNEL_DENIED', 403);
    const target = targets[0];
    if (list) {
      const permissions = typeof proof.discordPermissions === 'string' && /^\d{1,20}$/.test(proof.discordPermissions)
        ? BigInt(proof.discordPermissions) : 0n;
      need((permissions & (8n | 32n)) !== 0n || target.steamListAllowedUserIds?.includes(proof.externalId) ||
        proof.discordRoleIds?.some(role => target.steamListAllowedRoleIds?.includes(role)), 'STEAM_LINK_LIST_DENIED', 403);
    }
    return target;
  };
  const receiptId = proof => steamLinksDigest(`${proof.guildId}\0${proof.externalId}\0${proof.channelId}\0${proof.interactionId}`);
  const requestDigest = proof => steamLinksDigest(proof.payload);
  function receipt(proof) {
    const row = repo.getRecord('receipt', receiptId(proof));
    if (!row) return null;
    need(row.requestDigest === requestDigest(proof), 'PLATFORM_REPLAY_CONFLICT');
    return row;
  }
  function saveReceipt(proof, result) {
    need(repo.count('receipt') < 50000 || repo.getRecord('receipt', receiptId(proof)), 'STEAM_LINK_CAPACITY', 503);
    const row = { requestDigest: requestDigest(proof), guildId: proof.guildId, discordId: proof.externalId,
      createdAt: now(), expiresAt: now() + RECEIPT_TTL, result };
    repo.putRecord('receipt', receiptId(proof), row, proof.externalId, now());
    return result;
  }
  function contextFor(proof, type, properties = {}) {
    repo.prune(now());
    need(repo.count('context') < 5000 && repo.count('receipt') < 50000, 'STEAM_LINK_CAPACITY', 503);
    const token = randomBytes(32).toString('base64url');
    const context = { id: steamLinksDigest(token), type, guildId: proof.guildId, discordId: proof.externalId,
      channelId: proof.channelId, targetId: configured(proof, type === 'list' ? 'view' : 'setsteam', type === 'list').id,
      originMessageId: null, createdAt: now(), expiresAt: now() + CONTEXT_TTL, state: 'open', ...properties };
    repo.putRecord('context', context.id, context, proof.externalId, now());
    return { token, context };
  }
  function context(proof, type, { bindMessage = false } = {}) {
    need(typeof proof.payload.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(proof.payload.token), 'STEAM_LINK_CONTEXT_INVALID', 404);
    const row = repo.getRecord('context', steamLinksDigest(proof.payload.token));
    need(row && row.type === type && row.guildId === proof.guildId && row.discordId === proof.externalId && row.channelId === proof.channelId,
      'STEAM_LINK_CONTEXT_INVALID', 404);
    need(row.expiresAt > now(), 'STEAM_LINK_CONTEXT_EXPIRED', 410);
    need(configured(proof, type === 'list' ? 'view' : 'setsteam', type === 'list').id === row.targetId, 'PLATFORM_CHANNEL_DENIED', 403);
    if (bindMessage) {
      need(proof.originEphemeral === true && snowflake(proof.originMessageId) &&
        row.originMessageId === proof.originMessageId, 'MESSAGE_REFERENCE_REQUIRED');
    }
    return row;
  }
  function consume(proof, row, result) {
    repo.putRecord('context', row.id, { ...row, state: 'complete', completedAt: now(), result }, proof.externalId, now());
    return saveReceipt(proof, result);
  }
  function updateTeam(proof, link) {
    const target = configured(proof, 'setsteam');
    const enabled = readConfig().commands.find(command => command.id === 'setsteam')?.autoMatchTeamByRole;
    const match = matchSteamTeam({ enabled, target, discordRoleIds: proof.discordRoleIds });
    // Existing installations keep their original records until the feature is
    // used. Turning it off preserves every recorded assignment and member ID.
    if (match.status === 'disabled' && !link.teamSync && !link.teamAssignment) return link;
    let result = { status: match.status };
    if (match.team) {
      result = { status: 'failed' };
      if (typeof syncMemberTeam === 'function' && syncMemberTeam.constructor?.name !== 'AsyncFunction') {
        db.exec('SAVEPOINT discord_steam_member_team');
        try {
          const synced = syncMemberTeam({ proof, link, team: match.team });
          if (!synced || synced.then || !steamTeamSyncStatuses.includes(synced.status)) throw new Error('Invalid team sync result');
          if (['synced', 'unchanged', 'manual_preserved'].includes(synced.status)) db.exec('RELEASE discord_steam_member_team');
          else { db.exec('ROLLBACK TO discord_steam_member_team'); db.exec('RELEASE discord_steam_member_team'); }
          result = synced;
        } catch {
          // A rollback failure must reach the outer transaction; continuing
          // could otherwise acknowledge partial website writes as a failure.
          db.exec('ROLLBACK TO discord_steam_member_team');
          db.exec('RELEASE discord_steam_member_team');
        }
      }
    }
    const teamSync = { ...link.teamSync, status: result.status === 'unchanged' ? 'synced' : result.status };
    for (const key of ['memberId', 'squadId']) if (typeof result[key] === 'string' && result[key].length <= 128 && result[key]) teamSync[key] = result[key];
    return { ...link, ...(match.team ? { teamAssignment: match.team } : {}), teamSync };
  }
  function persistLink(proof, id, previous) {
    const candidate = { ...previous, guildId: proof.guildId, discordId: proof.externalId, steamId: id, revision: (previous?.revision || 0) + 1,
      declaredBy: proof.externalId, ownershipVerified: false, createdAt: previous?.createdAt || new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString() };
    const row = updateTeam(proof, candidate);
    if (previous?.steamId === id && JSON.stringify(previous.teamAssignment) === JSON.stringify(row.teamAssignment) &&
      JSON.stringify(previous.teamSync) === JSON.stringify(row.teamSync)) return previous;
    repo.putRecord('link', steamLinkKey(proof.guildId, proof.externalId), row, proof.externalId, now());
    return row;
  }
  function savedProfile(proof, id, profile, same = false, link) {
    let payload;
    try { payload = renderSteamProfile(profile || { status: 'unavailable' }, { locale: proof.locale,
      discordUserId: proof.externalId, linked: true, steamId: id, link }); }
    catch { payload = privateSteamLinksPayload(); }
    const team = !payload.embeds?.length ? steamTeamSummary(link, proof.locale) : '';
    return { ...payload, content: [text(proof.locale, same ? 'same' : 'saved', { steamId: id }), text(proof.locale, 'declaration'), team].filter(Boolean).join('\n') };
  }
  async function write(proof, work, afterCommit) {
    let result;
    try { result = await runStoreWriteTask(() => repo.transaction(work)); }
    catch (error) {
      if (!(error instanceof SteamLinksWriteError)) throw error;
      // A successful receipt read resolves a COMMIT whose acknowledgement was
      // lost. An unavailable DB remains unknown; never claim success from RAM.
      try { result = receipt(proof)?.result; }
      catch { return reply(proof, 'saveUnknown'); }
      if (!result) return reply(proof, error.outcome === 'failed' ? 'saveFailed' : 'saveUnknown');
    }
    // Optional presentation reads happen after COMMIT and cannot change the
    // durable receipt or turn an acknowledged save into a failed operation.
    if (afterCommit) try { return await afterCommit(result); } catch {}
    return result;
  }
  async function callProvider(method, argument, timeoutMs = providerTimeoutMs) {
    if (typeof provider[method] !== 'function') return { status: 'unavailable' };
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => provider[method](argument, { signal: controller.signal })),
        new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve({ status: 'error' }); }, timeoutMs); }),
      ]);
    } catch { return { status: 'error' }; }
    finally { clearTimeout(timer); }
  }
  async function enrichSavedProfile(proof, result, completion) {
    if (!completion) return result;
    const profile = await callProvider('readProfile', completion.steamId, Math.min(providerTimeoutMs, 4000));
    try {
      configured(proof, 'setsteam');
      const current = repo.getLink(proof.guildId, proof.externalId);
      need(current?.steamId === completion.steamId && current.revision === completion.revision, 'STEAM_LINK_REVISION_CONFLICT');
    } catch {
      // A later revocation or replacement cannot undo this completed operation.
      // Keep its acknowledgement while withholding newly fetched account data.
      return privateSteamLinksPayload(result.content);
    }
    if (!profile || !['ok', 'private'].includes(profile.status) || profile.steamId !== completion.steamId) return result;
    return savedProfile(proof, completion.steamId, profile, completion.same, completion.link);
  }
  async function resolve(proof, value) {
    const parsed = parseSteamIdentifier(value);
    if (!parsed) return { response: reply(proof, 'invalid') };
    const result = await callProvider('resolveIdentifier', parsed.value);
    if (result?.status !== 'ok' || !steamId(result.steamId) || parsed.steamId && parsed.steamId !== result.steamId) {
      return { response: reply(proof, result?.status === 'invalid' ? 'invalid' : result?.status === 'not_found' ? 'notFound' : 'providerFailed') };
    }
    return result;
  }
  function open(proof) {
    return repo.transaction(() => {
      const saved = receipt(proof); if (saved) return saved.result;
      const previous = repo.getLink(proof.guildId, proof.externalId);
      const { token } = contextFor(proof, 'modal', { baseRevision: previous?.revision || 0 });
      return saveReceipt(proof, steamLinksModal(token, proof.locale));
    });
  }
  async function submit(proof) {
    const initial = context(proof, 'modal');
    if (initial.state !== 'open') return initial.result || reply(proof, 'contextUsed');
    const resolved = await resolve(proof, proof.payload.values?.identifier);
    configured(proof, 'setsteam');
    if (resolved.response) return resolved.response;
    let completion;
    return write(proof, () => {
      const saved = receipt(proof); if (saved) return saved.result;
      const current = context(proof, 'modal');
      if (current.state !== 'open') return saveReceipt(proof, current.result || reply(proof, 'contextUsed'));
      const previous = repo.getLink(proof.guildId, proof.externalId);
      if (previous?.steamId === resolved.steamId) {
        const linked = persistLink(proof, resolved.steamId, previous);
        completion = { steamId: resolved.steamId, revision: linked.revision, same: true, link: linked };
        return consume(proof, current, savedProfile(proof, resolved.steamId, resolved.profile, true, linked));
      }
      need(current.baseRevision === (previous?.revision || 0), 'STEAM_LINK_REVISION_CONFLICT');
      if (previous) {
        const candidateProfile = resolved.profile && JSON.stringify(resolved.profile).length <= 16000 ? resolved.profile : { status: 'unavailable' };
        const { token } = contextFor(proof, 'confirm', { baseRevision: previous.revision, oldSteamId: previous.steamId, steamId: resolved.steamId, candidateProfile });
        return consume(proof, current, steamLinkConfirmation({ token, locale: proof.locale, oldSteamId: previous.steamId, steamId: resolved.steamId }));
      }
      const linked = persistLink(proof, resolved.steamId, previous);
      completion = { steamId: linked.steamId, revision: linked.revision, same: false, link: linked };
      return consume(proof, current, savedProfile(proof, resolved.steamId, resolved.profile, false, linked));
    }, result => enrichSavedProfile(proof, result, completion));
  }
  function confirm(proof, cancel) {
    let completion;
    return write(proof, () => {
      const saved = receipt(proof); if (saved) return saved.result;
      const current = context(proof, 'confirm', { bindMessage: true });
      if (current.state !== 'open') return saveReceipt(proof, current.result || reply(proof, 'contextUsed'));
      if (cancel) return consume(proof, current, reply(proof, 'cancelled'));
      const previous = repo.getLink(proof.guildId, proof.externalId);
      need(previous?.revision === current.baseRevision && previous?.steamId === current.oldSteamId, 'STEAM_LINK_REVISION_CONFLICT');
      const linked = persistLink(proof, current.steamId, previous);
      completion = { steamId: linked.steamId, revision: linked.revision, same: false, link: linked };
      return consume(proof, current, savedProfile(proof, current.steamId, current.candidateProfile, false, linked));
    }, result => enrichSavedProfile(proof, result, completion));
  }
  async function viewUser(proof) {
    const values = proof.payload.values || {};
    const hasUser = typeof values.user === 'string' && values.user.length > 0;
    const hasInput = typeof values.identifier === 'string' && values.identifier.trim().length > 0;
    if (hasUser === hasInput) return reply(proof, hasUser ? 'conflictingInput' : 'oneInput');
    let id, linked = false, link;
    if (hasUser) {
      need(snowflake(values.user), 'STEAM_LINK_INPUT_INVALID', 422);
      link = repo.getLink(proof.guildId, values.user);
      if (!link) return reply(proof, 'notLinked');
      id = link.steamId; linked = true;
    } else {
      const resolved = await resolve(proof, values.identifier);
      configured(proof, 'view');
      if (resolved.response) return resolved.response;
      id = resolved.steamId;
    }
    const profile = await callProvider('readProfile', id);
    configured(proof, 'view');
    if (hasUser) need(repo.getLink(proof.guildId, values.user)?.revision === link.revision, 'STEAM_LINK_REVISION_CONFLICT');
    return renderSteamProfile(profile, { locale: proof.locale, discordUserId: hasUser ? values.user : undefined, linked, steamId: id, link });
  }
  async function memberRows(proof, mode) {
    const result = await callProvider('listGuildMembers', proof.guildId);
    configured(proof, 'view', true);
    if (result?.status !== 'ok' || result.complete !== true || !Array.isArray(result.members) || result.members.length > 100000)
      return { response: reply(proof, 'memberFetchFailed') };
    const seen = new Set();
    for (const member of result.members) {
      if (!snowflake(member?.discordId) || typeof member.bot !== 'boolean' || seen.has(member.discordId)) return { response: reply(proof, 'memberFetchFailed') };
      seen.add(member.discordId);
    }
    const links = new Map(repo.links(proof.guildId).map(row => [row.discordId, row]));
    const rows = result.members.filter(row => !row.bot && (mode === 'all' ? links.has(row.discordId) : !links.has(row.discordId)))
      .map(row => ({ discordId: row.discordId, displayName: row.displayName || row.discordId, ...(mode === 'all' ? {
        steamId: links.get(row.discordId).steamId, teamAssignment: links.get(row.discordId).teamAssignment,
        teamSync: links.get(row.discordId).teamSync ? { status: links.get(row.discordId).teamSync.status } : undefined,
      } : {}) }))
      .sort((a, b) => a.discordId.length - b.discordId.length || a.discordId.localeCompare(b.discordId));
    return { rows, fetchedAt: result.fetchedAt || new Date(now()).toISOString() };
  }
  async function list(proof, mode) {
    const result = await memberRows(proof, mode);
    if (result.response) return result.response;
    return write(proof, () => {
      configured(proof, 'view', true);
      const { token } = contextFor(proof, 'list', { mode });
      return renderSteamLinksList({ ...result, mode, page: 0, token, locale: proof.locale });
    });
  }
  async function page(proof) {
    const current = context(proof, 'list', { bindMessage: true });
    const result = await memberRows(proof, current.mode);
    context(proof, 'list', { bindMessage: true });
    if (result.response) return result.response;
    need(Number.isSafeInteger(proof.payload.page) && proof.payload.page >= 0 && proof.payload.page <= 5000, 'STEAM_LINK_INPUT_INVALID', 422);
    return renderSteamLinksList({ ...result, mode: current.mode, page: proof.payload.page, token: proof.payload.token, locale: proof.locale });
  }
  function handleVerified(proof) {
    assertSteamLinksProof(proof);
    const action = proof.payload.action;
    need(['open', 'submit', 'confirm', 'cancel', 'view_user', 'view_all', 'view_nosteam', 'page'].includes(action), 'PLATFORM_PAYLOAD_INVALID', 422);
    need(snowflake(proof.interactionId), 'PLATFORM_AUTH_INVALID', 401);
    configured(proof, ['open', 'submit', 'confirm', 'cancel'].includes(action) ? 'setsteam' : 'view', ['view_all', 'view_nosteam', 'page'].includes(action));
    if (action === 'open') return open(proof);
    if (MUTATIONS.has(action)) {
      const saved = receipt(proof); if (saved) return Promise.resolve(saved.result);
      const key = receiptId(proof), running = inFlight.get(key), digest = requestDigest(proof);
      if (running) { need(running.digest === digest, 'PLATFORM_REPLAY_CONFLICT'); return running.promise; }
      need(inFlight.size < 1000, 'STEAM_LINK_CAPACITY', 503);
      const promise = Promise.resolve().then(() => action === 'submit' ? submit(proof) : confirm(proof, action === 'cancel'))
        .finally(() => inFlight.delete(key));
      inFlight.set(key, { digest, promise });
      return promise;
    }
    return action === 'view_user' ? viewUser(proof) : action === 'page' ? page(proof) : list(proof, action === 'view_all' ? 'all' : 'nosteam');
  }
  function bindPrivateMessage(proof, payload, messageId) {
    assertSteamLinksProof(proof);
    need(snowflake(messageId) && payload?.flags === 64, 'MESSAGE_REFERENCE_REQUIRED');
    const tokens = [...new Set((payload.components || []).flatMap(row => row.components || [])
      .map(row => /^nbsteam:(?:confirm|cancel|page):([A-Za-z0-9_-]{43})(?::\d+)?$/.exec(row.custom_id || '')?.[1]).filter(Boolean))];
    if (!tokens.length) return;
    return repo.transaction(() => {
      for (const token of tokens) {
        const row = repo.getRecord('context', steamLinksDigest(token));
        need(row && ['confirm', 'list'].includes(row.type) && row.guildId === proof.guildId && row.discordId === proof.externalId &&
          row.channelId === proof.channelId && row.expiresAt > now() && (!row.originMessageId || row.originMessageId === messageId), 'STEAM_LINK_CONTEXT_INVALID');
        need(configured(proof, row.type === 'list' ? 'view' : 'setsteam', row.type === 'list').id === row.targetId, 'PLATFORM_CHANNEL_DENIED', 403);
        repo.putRecord('context', row.id, { ...row, originMessageId: messageId }, proof.externalId, now());
      }
    });
  }
  return { handleVerified, bindPrivateMessage };
}
