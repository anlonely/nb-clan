import express from 'express';
import { ELECTRICIAN_COMMAND_ID } from './electrician-card.js';

function publicTarget(query) {
  if (Object.keys(query).some(key => !['platform', 'guildId', 'channelId', 'target'].includes(key))) return null;
  if (Object.hasOwn(query, 'target')) {
    if (Object.keys(query).length !== 1 || typeof query.target !== 'string') return null;
    const match = /^(\d{10,20})-(\d{10,20})$/.exec(query.target);
    return match ? { platform: 'discord', guildId: match[1], channelId: match[2] } : null;
  }
  const platform = Object.hasOwn(query, 'platform') ? query.platform : 'kook';
  const validId = value => typeof value === 'string' && /^\d{10,20}$/.test(value);
  if (!['kook', 'discord'].includes(platform) || !validId(query.guildId) ||
      (Object.hasOwn(query, 'channelId') ? !validId(query.channelId) : platform !== 'kook')) return null;
  return { platform, guildId: query.guildId, channelId: query.channelId || null };
}

/** The selected platform configuration authorizes this exact public link;
 * only the shared roster supplies its public rows. */
export function createPublicElectriciansRouter({ readConfig, avatars }) {
  const configuredRoster = (view, guildId, channelId) => {
    const config = view?.config;
    const matches = config?.enabled === true && Array.isArray(config.targets) ? config.targets.filter(row =>
      row?.enabled === true && row.guildId === guildId && /^\d{10,20}$/.test(row.electricianChannelId || '') && (!channelId || row.electricianChannelId === channelId) &&
      Array.isArray(row.enabledCommandIds) && row.enabledCommandIds.includes(ELECTRICIAN_COMMAND_ID))
      : [];
    // KOOK mobile clients may omit the trailing channel query parameter. Only
    // one current enabled destination may authorize that compatibility link.
    const target = channelId ? matches[0] : matches.length === 1 ? matches[0] : null;
    const command = target && Array.isArray(config.commands) && config.commands.find(row =>
      row?.id === ELECTRICIAN_COMMAND_ID && row.enabled === true && row.type === 'persistent_card');
    if (!command || !view.roster) return null;
    return { details: view.roster, destination: {guildId:target.guildId,channelId:target.electricianChannelId}, configurationRevision: config.revision,
      rosterRevision: view.rosterRevision, rosterSource: view.rosterSource };
  };
  const router = express.Router();
  router.get('/public/electricians', async (req, res) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const target = publicTarget(req.query);
    if (!target) {
      return res.status(422).json({ error: { errorCode: 'ELECTRICIAN_INPUT_INVALID' } });
    }
    const { platform, guildId, channelId } = target;
    try {
      const snapshot = configuredRoster(await readConfig(platform), guildId, channelId);
      if (!snapshot) return res.status(404).json({ error: { errorCode: 'ELECTRICIANS_NOT_FOUND' } });
      const { details } = snapshot;
      const data = avatars ? await avatars.read(details) : Object.fromEntries(Object.entries(details)
        .map(([key, rows]) => [key, rows.map(row => ({ ...row, avatar: '' }))]));
      // Recheck the exact platform, shared revision/source and dynamic resolved
      // rows after avatars: config or member changes must not leak a stale list.
      if (JSON.stringify(configuredRoster(await readConfig(platform), guildId, channelId)) !== JSON.stringify(snapshot)) {
        return res.status(404).json({ error: { errorCode: 'ELECTRICIANS_NOT_FOUND' } });
      }
      return res.json(data);
    } catch {
      return res.status(503).json({ error: { errorCode: 'ELECTRICIANS_UNAVAILABLE' } });
    }
  });
  return router;
}
