import { need, hash, stamp } from './shared.js';
import { platformAliases, legacyBlocked, membershipStatus } from '../identity/migration.js';

const actions = new Set(['attending_on_time', 'join_8h', 'join_16h', 'not_attending']);
const discordId = value => typeof value === 'string' && /^\d{15,22}$/.test(value);

// V2 OAuth links do not always duplicate the Discord ID onto the member row.
// Check both current identity links and migrated aliases for known restrictions.
function memberLinks(identity) {
  const members = identity.repo.all('members'), accounts = identity.repo.all('accounts');
  const users = identity.repo.all('users'), links = new Map();
  const add = (externalId, memberId) => {
    if (!discordId(externalId) || !memberId) return;
    const ids = links.get(externalId) || new Set(); ids.add(memberId); links.set(externalId, ids);
  };
  for (const member of members) for (const externalId of platformAliases(member, 'discord')) add(externalId, member.id);
  for (const item of identity.repo.all('identities')) if (item.provider === 'discord')
    add(item.externalId, accounts.find(account => account.id === item.accountId)?.memberId);
  for (const user of users) {
    const account = accounts.find(account => account.legacyUserId === user.id || account.id === user.id);
    const memberId = account?.memberId || members.find(member => member.steamId && member.steamId === user.boundSteamId)?.id;
    for (const externalId of platformAliases(user, 'discord')) add(externalId, memberId);
  }
  return { members, accounts, users, links };
}

function assertKnownAccess(identity, discordId, context = memberLinks(identity)) {
  const mapping = identity.identity('discord', discordId);
  if (mapping?.accountId) {
    const actor = identity.actorForAccount(mapping.accountId);
    if (actor.memberId) identity.assertMemberParticipation(actor);
  }
  const { members, accounts, users, links } = context;
  need((links.get(discordId)?.size || 0) <= 1, 'IDENTITY_CONFLICT');
  const linkedUsers = users.filter(user => platformAliases(user, 'discord').includes(discordId));
  for (const user of linkedUsers) {
    need(!user.disabled && user.status !== 'disabled', 'ACCOUNT_DISABLED', 403);
    const account = accounts.find(account => account.legacyUserId === user.id || account.id === user.id);
    if (account) identity.actorForAccount(account.id);
  }
  for (const memberId of links.get(discordId) || []) {
    const member = members.find(member => member.id === memberId);
    need(!legacyBlocked(member), 'ACCESS_RESTRICTED', 403);
    need(member && membershipStatus(member) === 'active', 'MEMBERSHIP_INACTIVE', 403);
    for (const account of accounts.filter(account => account.memberId === memberId)) identity.assertMemberParticipation(identity.actorForAccount(account.id));
    const restricted = identity.repo.all('restrictions').some(row => row.memberId === memberId && row.kind === 'deny_access' &&
      (!row.startsAt || Date.parse(row.startsAt) <= identity.now()) && (!row.endsAt || Date.parse(row.endsAt) > identity.now()));
    need(!restricted, 'ACCESS_RESTRICTED', 403);
  }
}

/** Discord attendance is a separate roster; it never creates a Steam binding or member. */
export function discordSignupRows(service, wipeId, guildId) {
  const context = memberLinks(service.identity);
  return service.repo.forWipe('discordSignups', wipeId).filter(row => {
    if (row.guildId !== guildId) return false;
    try { assertKnownAccess(service.identity, row.discordId, context); return true; }
    catch (error) { if (error.errorCode) return false; throw error; }
  });
}

export function submitDiscordSignup(service, verified) {
  return service.repo.transaction(() => {
    const { externalId, interactionId, guildId, channelId, actionReference } = verified;
    need(discordId(externalId) && typeof interactionId === 'string' && /^[A-Za-z0-9:_-]{1,160}$/.test(interactionId), 'PLATFORM_AUTH_INVALID', 401);
    const reference = service.resolveReference(actionReference, { platform: 'discord', guildId, channelId });
    need(reference.signupMode === 'discord_only' && actions.has(reference.action), 'PLATFORM_ACTION_REFERENCE_INVALID', 401);
    // Existing restrictions still apply to a linked account. Unregistered guild
    // users need only the authenticated Discord interaction and the published card.
    assertKnownAccess(service.identity, externalId);
    const wipe = service.scheduling.wipe(reference.wipeId);
    need(reference.contentRevision === wipe.contentRevision, 'CONTENT_RECONFIRM_REQUIRED', 409);
    need(['scheduled', 'active'].includes(wipe.lifecycle), 'WIPE_IMMUTABLE', 409);
    const window = service.scheduling.window(wipe);
    need(window === 'open', window === 'closed' ? 'SIGNUP_CLOSED' : 'SIGNUP_NOT_OPEN', 409);
    const id = `discord_signup_${hash([wipe.id, guildId, externalId])}`;
    const operationId = `discord:${interactionId}`, receiptId = hash(operationId);
    const digest = hash({ externalId, guildId, channelId, actionReference });
    const previousReceipt = service.repo.get('discordSignupReceipts', receiptId);
    const current = service.repo.get('discordSignups', id);
    if (previousReceipt) {
      need(previousReceipt.digest === digest, 'IDEMPOTENCY_CONFLICT', 409);
      return { operationReceipt: previousReceipt.operationReceipt, current, replayed: true };
    }
    const response = ['join_8h', 'join_16h'].includes(reference.action) ? 'attending_later' : reference.action;
    let expectedArrivalAt = null;
    if (response === 'attending_later') {
      const start = Date.parse(wipe.actualStartedAt || wipe.serverScheduledWipeAt || wipe.musterAt || '');
      const arrival = start + (reference.action === 'join_8h' ? 8 : 16) * 3_600_000;
      need(Number.isFinite(start) && arrival > service.now(), 'ARRIVAL_TIME_INVALID', 422);
      expectedArrivalAt = new Date(arrival).toISOString();
    }
    const name = String(verified.externalDisplayName || current?.name || `Discord ${externalId}`).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
    const unchanged = current?.response === response && current.expectedArrivalAt === expectedArrivalAt && current.name === name;
    const now = stamp(service.now);
    const next = unchanged ? current : { id, wipeId: wipe.id, guildId, discordId: externalId,
      name,
      response, expectedArrivalAt, timeZone: wipe.timeZone, signupRevision: (current?.signupRevision || 0) + 1,
      confirmedContentRevision: wipe.contentRevision, createdAt: current?.createdAt || now, updatedAt: now };
    const operationReceipt = { operationId, committedAt: now, result: 'committed', action: 'discord.signup',
      wipeId: wipe.id, signupRevision: next.signupRevision, confirmedContentRevision: wipe.contentRevision };
    if (!unchanged) {
      need(current || discordSignupRows(service, wipe.id, guildId).length < 10000, 'PLATFORM_CALLBACK_FAILED', 503);
      service.repo.put('discordSignups', next);
      // The same durable edit worker refreshes the exact original message.
      for (const delivery of service.repo.forWipe('deliveries', wipe.id).filter(row => row.platform === 'discord' && row.target.guildId === guildId && service.repo.get('intents', row.intentId)?.purpose === 'signup_open')) {
        for (const message of service.repo.forWipe('messageRefs', wipe.id).filter(row => row.deliveryId === delivery.id && row.state === 'active'))
          service.queueMessageOperation(delivery, 'edit', { reasonCode: 'DISCORD_SIGNUP_CHANGED', messageRefId: message.id });
      }
      service.repo.appendChange({ wipeId: wipe.id, type: 'discord.signup.changed', createdAt: now });
    }
    service.repo.put('discordSignupReceipts', { id: receiptId, digest, operationReceipt });
    return { operationReceipt, current: next, replayed: false };
  });
}
