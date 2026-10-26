import { need } from './model.js';

const fields = Object.freeze({
  connection: ['enabled', 'applicationId', 'publicKey'],
  identity: ['roleSpecialtyMappings', 'roleSquadMappings', 'roleSystemMappings'],
  features: ['commands'],
  servers: ['targets'],
  automation: ['autoWipeCards']
});

// A section owns only its fields. Arrays remain complete snapshots protected by
// expectedRevision, so a stale tab cannot silently overwrite a newer server edit.
export function scopedConfigInput(platform, input) {
  if (input.configSection === undefined) return input.config;
  need(['discord', 'kook'].includes(platform) && Object.hasOwn(fields, input.configSection), 'PLATFORM_CONFIG_SECTION_INVALID');
  need(input.config && typeof input.config === 'object' && !Array.isArray(input.config), 'PLATFORM_INPUT_INVALID');
  const keys = Object.keys(input.config);
  need(keys.length > 0 && keys.every(key => fields[input.configSection].includes(key)), 'PLATFORM_CONFIG_SECTION_INVALID');
  return input.config;
}

export function pruneRemovedCommands(current, normalized, section) {
  if (section !== 'features' || !Array.isArray(normalized.commands)) return normalized;
  const retained = new Set(normalized.commands.map(command => command.id));
  const removed = new Set((current.commands || []).filter(command => !retained.has(command.id)).map(command => command.id));
  if (!removed.size) return normalized;
  return { ...normalized, targets: (current.targets || []).map(target => ({ ...target,
    enabledCommandIds: (target.enabledCommandIds || []).filter(id => !removed.has(id)) })) };
}
