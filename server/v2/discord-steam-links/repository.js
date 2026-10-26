import { createHash } from 'node:crypto';
import { PlatformAdminRepository } from '../platform-admin/repository.js';

export const steamLinkKinds = Object.freeze({ link: 'discord-steam-link', context: 'discord-steam-context', receipt: 'discord-steam-receipt' });
export const steamLinksDigest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const steamLinkKey = (guildId, discordId) => `${guildId}:${discordId}`;

export class SteamLinksWriteError extends Error {
  constructor(outcome, cause) { super('STEAM_LINK_SAVE_FAILED', { cause }); this.outcome = outcome; }
}

export class DiscordSteamLinksRepository extends PlatformAdminRepository {
  getLink(guildId, discordId) { return this.get(steamLinkKinds.link, steamLinkKey(guildId, discordId)); }
  links(guildId) {
    return this.db.prepare("SELECT payload FROM platform_admin_records WHERE kind=? AND json_extract(payload,'$.guildId')=? ORDER BY id")
      .all(steamLinkKinds.link, guildId).map(row => JSON.parse(row.payload));
  }
  putRecord(kind, id, payload, actor, at) { return this.put(steamLinkKinds[kind], id, 'discord', actor, at, payload); }
  getRecord(kind, id) { return this.get(steamLinkKinds[kind], id); }
  prune(now) {
    this.db.prepare("DELETE FROM platform_admin_records WHERE kind IN (?,?) AND json_extract(payload,'$.expiresAt')<=?")
      .run(steamLinkKinds.context, steamLinkKinds.receipt, now);
  }
  count(kind) { return this.db.prepare('SELECT count(*) n FROM platform_admin_records WHERE kind=?').get(steamLinkKinds[kind]).n; }
  transaction(work) {
    let started = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); started = true;
      const value = work();
      if (value?.then) throw new Error('Async transaction forbidden');
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      let rolledBack = !started;
      if (started) try { this.db.exec('ROLLBACK'); rolledBack = true; } catch {}
      // Domain denials are never relabelled as uncertain persistence.
      if (error?.errorCode) throw error;
      throw new SteamLinksWriteError(rolledBack ? 'failed' : 'unknown', error);
    }
  }
}
