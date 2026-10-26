import { normalizeSpecialties } from '../../../shared/member-preferences.js';

// Member role IDs come from the verified guild membership response. Names are
// usable only when guild metadata was also fetched successfully.
export function platformRoleContext(db, evidence) {
  if (!['discord', 'kook'].includes(evidence?.provider) || !evidence.guildId) return null;
  const namesAvailable = evidence.community?.available === true && evidence.community.displayOnly !== true && Array.isArray(evidence.community.roles);
  if (!namesAvailable && !Array.isArray(evidence.roleIds)) return null;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='platform_admin_records'").get()) return null;
  const row = db.prepare("SELECT payload FROM platform_admin_records WHERE kind='config' AND id=?").get(evidence.provider);
  const config = row ? JSON.parse(row.payload) : null;
  const roleIds = new Set(evidence.roleIds || []);
  const roleNames = new Set(namesAvailable ? evidence.community.roles.map(role => role.name).filter(Boolean) : []);
  const matches = rule => rule.roleId ? rule.guildId === evidence.guildId && roleIds.has(rule.roleId) : namesAvailable && roleNames.has(rule.roleName);
  return { config, matches, namesAvailable };
}

export function mappedRoleSpecialties(db, evidence) {
  const context = platformRoleContext(db, evidence);
  if (!context || !context.namesAvailable && (context.config?.roleSpecialtyMappings || []).some(rule => !rule.roleId)) return null;
  return normalizeSpecialties((context.config?.roleSpecialtyMappings || [])
    .filter(context.matches).map(rule => rule.specialty));
}

export function applyRoleSpecialties(repo, member, evidence, now) {
  if (!member) return member;
  const mapped = mappedRoleSpecialties(repo.db, evidence);
  if (mapped === null) return member;
  const previous = member.roleDerivedSpecialties || {};
  if (!mapped.length && !(previous[evidence.provider] || []).length) return member;
  const priorValues = new Set(normalizeSpecialties(Object.values(previous).flat()));
  const manual = normalizeSpecialties(member.specialty || member.specialties || []).filter(value => !priorValues.has(value));
  const derived = { ...previous, [evidence.provider]: mapped };
  const specialty = normalizeSpecialties([...manual, ...Object.values(derived).flat()]);
  if (JSON.stringify(specialty) === JSON.stringify(normalizeSpecialties(member.specialty || member.specialties || [])) &&
      JSON.stringify(derived) === JSON.stringify(previous)) return member;
  const next = { ...member, specialty, specialties: specialty, roleDerivedSpecialties: derived,
    revision: (member.revision || 1) + 1, updatedAt: new Date(now()).toISOString() };
  repo.put('members', next);
  return next;
}
