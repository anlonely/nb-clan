import { requireValue } from '../identity/errors.js';

export const NEW_WIPE_COMMAND_ID = 'newwipe';
const snowflake = value => typeof value === 'string' && /^\d{17,20}$/.test(value);
const deny = (condition, code) => requireValue(condition, code, 403);

/** Resolve only the current configured guild/channel. The caller must supply a
 * verifier-issued proof; this helper never turns browser identity into Discord
 * publishing authority. Joining a published card does not require that authority.
 */
export function resolveNewwipeTarget(config, proof, { requirePublisher = true } = {}) {
  deny(config?.enabled === true, 'PLATFORM_DISABLED');
  deny(proof?.provider === 'discord' && snowflake(proof.guildId) && snowflake(proof.channelId)
    && snowflake(proof.externalId), 'PLATFORM_AUTH_INVALID');
  const commands = (config.commands || []).filter(command => command.id === NEW_WIPE_COMMAND_ID);
  deny(commands.length === 1 && commands[0].enabled === true
    && commands[0].type === 'event_command' && commands[0].slashCommand === NEW_WIPE_COMMAND_ID, 'COMMAND_DISABLED');
  const targets = (config.targets || []).filter(target => {
    const channels = target.newwipeChannelIds?.length ? target.newwipeChannelIds : [target.channelId];
    return target.enabled === true && target.guildId === proof.guildId
      && target.enabledCommandIds?.includes(NEW_WIPE_COMMAND_ID) && channels.includes(proof.channelId);
  });
  deny(targets.length === 1, 'PLATFORM_CHANNEL_DENIED');
  const target = targets[0];
  if (!requirePublisher) return target;

  const allowedUsers = target.newwipeAllowedUserIds || [];
  const allowedRoles = target.newwipeAllowedRoleIds || [];
  const roles = Array.isArray(proof.discordRoleIds) ? proof.discordRoleIds.filter(snowflake) : [];
  let permissions = 0n;
  if (typeof proof.discordPermissions === 'string' && /^\d{1,30}$/.test(proof.discordPermissions)) {
    permissions = BigInt(proof.discordPermissions);
  }
  const administrator = target.newwipeAllowAdministrators !== false && (permissions & (8n | 32n)) !== 0n;
  deny(administrator || allowedUsers.includes(proof.externalId) || roles.some(role => allowedRoles.includes(role)),
    'NEWWIPE_PUBLISHER_DENIED');
  return target;
}
