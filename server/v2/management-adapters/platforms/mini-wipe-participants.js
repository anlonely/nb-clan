import { authorize, can, memberDTO, scopeMatches, validGrant } from '../../identity/permissions.js';
import { membershipStatus } from '../../identity/migration.js';
import { IdentityError } from '../../identity/errors.js';
import { normalizeSpecialties } from '../../../../shared/member-preferences.js';

const responses = new Set(['attending_on_time', 'attending_later', 'not_attending']);
const need = (value, code, status = 422) => { if (!value) throw new IdentityError(code, status); };
const text = (value, max = 120) => typeof value === 'string' ? value.slice(0, max) : '';
const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
const avatar = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};

/** A closed, read-only roster projection. The separate roster capability does
 * not grant access to full signup records or another member's private profile. */
export function createMiniWipeParticipants({ identity, scheduling, memberSpace }) {
  return ({ actor: inputActor, input = {} }) => {
    need(input && typeof input === 'object' && !Array.isArray(input) &&
      Object.keys(input).every(key => ['wipeId', 'limit', 'cursor'].includes(key)), 'MINI_PARTICIPANTS_INPUT_INVALID');
    const { wipeId, cursor = '', limit = 30 } = input;
    need(typeof wipeId === 'string' && wipeId.length > 0 && wipeId.length <= 160 &&
      typeof cursor === 'string' && cursor.length <= 160 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
    'MINI_PARTICIPANTS_INPUT_INVALID');
    const actor = memberSpace.actor(inputActor), member = memberSpace.requireMember(actor);
    need(!member.deletedAt && membershipStatus(member) === 'active', 'MEMBERSHIP_INACTIVE', 403);
    const binding = identity.repo.all('bindings').find(row => row.accountId === actor.id && row.memberId === member.id && row.status === 'verified');
    need(binding && binding.steamId === member.steamId, 'MEMBER_VERIFICATION_REQUIRED', 403);
    const relations = identity.relations(), wipe = scheduling.wipe(wipeId);
    authorize(actor, 'wipes.read', { kind: 'wipe', id: wipeId }, relations, true);
    authorize(actor, 'signups.roster', { kind: 'signup', wipeId, memberId: member.id }, relations, true);
    // Historical counts must come from immutable archive snapshots, not today's
    // audience. The member signup screen only offers these current lifecycles.
    need(['scheduled', 'active'].includes(wipe.lifecycle), 'RESOURCE_NOT_FOUND', 404);
    const snapshot = scheduling.roster(actor, wipe, { full: true });
    const denied = (capability, resource) => (actor.grants || []).some(grant => grant.effect === 'deny' &&
      grant.capability === capability && validGrant(grant) && scopeMatches(grant.scope, actor, resource, relations, 'deny', capability));
    const members = new Map(identity.repo.all('members').map(row => [row.id, row]));
    const visible = row => {
      const signup = { kind: 'signup', wipeId, memberId: row.memberId }, resource = { kind: 'member', id: row.memberId, wipeId };
      const target = members.get(row.memberId);
      return target && !target.deletedAt && can(actor, 'signups.roster', signup, relations) &&
        !denied('signups.read', signup) && can(actor, 'members.directory', resource, relations) && !denied('members.read', resource);
    };
    const rows = snapshot.rows.filter(visible), counts = scheduling.counts(rows);
    const answered = rows.filter(row => responses.has(row.response)).sort((a, b) => a.memberId.localeCompare(b.memberId));
    const remaining = answered.filter(row => !cursor || row.memberId.localeCompare(cursor) > 0), selected = remaining.slice(0, limit);
    const activeSquads = identity.repo.all('squads').filter(row => !row.deletedAt && !row.archivedAt);
    const squads = new Map(activeSquads.map(row => [row.id, text(row.name)]));
    const normalizedSquadNames = new Map(activeSquads.map(row => [row.id, typeof row.name === 'string' ? row.name.trim().toUpperCase() : '']));
    const squadNames = new Map(), squadRegions = new Map();
    for (const row of relations.squadMembers) if (!row.validTo && squads.has(row.squadId)) {
      const names = squadNames.get(row.memberId) || [];
      if (!names.includes(squads.get(row.squadId))) names.push(squads.get(row.squadId));
      squadNames.set(row.memberId, names);
      const name = normalizedSquadNames.get(row.squadId), regions = squadRegions.get(row.memberId) || new Set();
      regions.add(name === 'CN' || name === 'EU' ? name.toLowerCase() : 'unknown');
      squadRegions.set(row.memberId, regions);
    }
    // CN/EU are canonical squad names, not inferred geography or server region.
    // Reconfirming responses remain planned attendance; non-attending and
    // withdrawn responses never enter these totals. Conflicting teams count once.
    const regionCounts = { cn: 0, eu: 0, unknown: 0 };
    for (const row of rows) if (['attending_on_time', 'attending_later'].includes(row.response)) {
      const regions = squadRegions.get(row.memberId), key = regions?.size === 1 ? [...regions][0] : 'unknown';
      regionCounts[key || 'unknown']++;
    }
    return {
      wipeId, counts, regionCounts, total: answered.length, countScope: rows.length === snapshot.rows.length ? 'audience' : 'authorized_members',
      rosterRevision: snapshot.rosterRevision, contentRevision: snapshot.contentRevision, evaluatedAt: snapshot.evaluatedAt,
      items: selected.map(row => {
        const target = members.get(row.memberId);
        return { memberId: row.memberId, name: text(memberDTO(target).displayName) || '成员',
          avatar: avatar(target.steamAvatar || target.avatar || target.avatarUrl), squadName: (squadNames.get(row.memberId) || []).join(' · ') || '未分队',
          steamId: text(target.steamId, 32), specialties: normalizeSpecialties(target.specialty || target.specialties || []),
          response: row.response, needsReconfirmation: Boolean(row.needsReconfirmation),
          expectedArrivalAt: row.response === 'attending_later' ? time(row.expectedArrivalAt) : null, isSelf: row.memberId === actor.memberId };
      }),
      nextCursor: remaining.length > limit ? selected.at(-1).memberId : null
    };
  };
}
