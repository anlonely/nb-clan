import { requireValue as need } from '../identity/errors.js';
import { can, authorize } from '../identity/permissions.js';
import { specialties, normalizeSpecialties } from '../../../shared/member-preferences.js';
import { membershipStatus, legacyBlocked } from '../identity/migration.js';
import { electricianDetails, ELECTRICIAN_COMMAND_ID } from './electrician-card.js';
import { storedSteamAvatar } from './electrician-avatars.js';

export function electricianProfile(value) {
  if (typeof value !== 'string') return null;
  if (/^\d{17}$/.test(value.trim())) return `https://steamcommunity.com/profiles/${value.trim()}/`;
  try {
    const u = new URL(value.trim());
    if (u.protocol !== 'https:' || u.hostname !== 'steamcommunity.com' || u.username || u.password || u.port || u.hash ||
      [...u.searchParams].some(([k,v]) => k !== 'l' || v !== 'english') ||
      !/^\/(?:profiles\/\d{17}|id\/[A-Za-z0-9_-]{2,64})\/?$/.test(u.pathname)) return null;
    return `https://steamcommunity.com${u.pathname.replace(/\/$/, '')}/`;
  } catch { return null; }
}
const nameOf = m => String(m.customName || m.steamNickname || m.displayName || m.steamId || '').trim().slice(0,80);
const active = m => m && membershipStatus(m)==='active' && !legacyBlocked(m) && !m.archivedAt && /^\d{17}$/.test(m.steamId || '');

// A read-only compatibility projection preserves the user's current KOOK list
// until the shared roster is first saved. Never substitute built-in defaults.
export function readElectricianRoster(repo) {
  const stored = repo.get('electrician-roster','shared');
  if (stored) return stored;
  const legacy = electricianDetails(repo.get('config','kook')?.commands?.find(c => c.id === ELECTRICIAN_COMMAND_ID));
  return {revision:0, updatedAt:'', entries: ['china','foreign'].flatMap(group => (legacy?.[group] || []).map(row =>
    ({kind:'manual', group:group==='china'?'CN':'EU', name:row.name, url:row.url}))) };
}

export function resolveElectricianRoster(repo, identity) {
  return resolveEntries(readElectricianRoster(repo).entries, identity.repo.all('members').filter(active), identity.repo.all('squadMembers').filter(s=>!s.validTo));
}

function resolveEntries(entries, members, memberships) {
  const result={china:[],foreign:[]}, seen=new Set();
  const append=(group,row) => {
    const url=electricianProfile(row.url), name=String(row.name || '').trim();
    if (!url || !name || seen.has(url.toLowerCase())) return;
    seen.add(url.toLowerCase());result[group==='CN'?'china':'foreign'].push({name,url});
  };
  for (const entry of entries) {
    if (entry.kind==='manual') append(entry.group,entry);
    else if (['member','specialty'].includes(entry.kind)) for (const member of members) {
      if (entry.kind==='member' ? member.id!==entry.memberId :
        !normalizeSpecialties(member.specialty || member.specialties || []).includes(entry.specialty) ||
        entry.squadId && !memberships.some(s=>s.memberId===member.id&&s.squadId===entry.squadId)) continue;
      append(entry.group,{name:nameOf(member),url:member.steamId});
    }
  }
  need(result.china.length+result.foreign.length<=500,'ELECTRICIAN_LIST_TOO_LARGE',422);
  return result;
}

export function electricianRosterDetail(service, actor) {
  actor=service.actor(actor,'kook');service.actor(actor,'discord');
  const relations=service.identity.relations(), allMembers=service.identity.repo.all('members').filter(active);
  const visibleMember=id=>can(actor,'members.read',{kind:'member',id},relations);
  const visibleSquad=id=>can(actor,'squads.read',{kind:'squad',id},relations);
  const members=allMembers.filter(m=>visibleMember(m.id)), memberships=service.identity.repo.all('squadMembers').filter(s=>!s.validTo);
  const canSelectSpecialty=can(actor,'members.read',{kind:'member',id:'*'},relations)&&allMembers.every(m=>visibleMember(m.id));
  const roster=readElectricianRoster(service.repo), entries=roster.entries.filter(entry=>entry.kind==='manual'||
    entry.kind==='member'&&visibleMember(entry.memberId)||entry.kind==='specialty'&&canSelectSpecialty&&(!entry.squadId||visibleSquad(entry.squadId)));
  const hasRestrictedSources=entries.length!==roster.entries.length;
  const resolved=resolveEntries(entries,members,memberships);
  return {...roster,entries,resolved:Object.fromEntries(Object.entries(resolved).map(([group,rows])=>[group,rows.map(row=>({...row,avatar:storedSteamAvatar(service.repo.db,/\/profiles\/(\d{17})\/$/.exec(row.url)?.[1]||'')}))])),
    // A filtered snapshot cannot replace the full stored roster: doing so would
    // silently delete sources the actor is not allowed to see.
    canConfigure:!hasRestrictedSources&&['kook','discord'].every(id=>can(actor,'platforms.configure',{kind:'platformTarget',id},relations)),
    canSelectSpecialty,hasRestrictedSources,
    members:members.map(m=>({id:m.id,name:nameOf(m),steamId:m.steamId,avatar:storedSteamAvatar(service.repo.db,m.steamId),specialties:normalizeSpecialties(m.specialty||m.specialties||[]),squadIds:memberships.filter(s=>s.memberId===m.id&&visibleSquad(s.squadId)).map(s=>s.squadId)})),
    specialties, squads:service.identity.repo.all('squads').filter(s=>!s.archivedAt&&visibleSquad(s.id)).map(s=>({id:s.id,name:s.name}))};
}

export function saveElectricianRoster(service, actor, input, operationId) {
  actor=service.actor(actor,'kook',true);service.actor(actor,'discord',true);
  need(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).every(k=>['expectedRevision','entries'].includes(k))&&Number.isSafeInteger(input.expectedRevision)&&input.expectedRevision>=0&&Array.isArray(input.entries)&&input.entries.length<=200,'ELECTRICIAN_INPUT_INVALID',422);
  const relations=service.identity.relations(), seen=new Set(), entries=[];
  for(const raw of input.entries) {
    need(raw&&typeof raw==='object'&&!Array.isArray(raw)&&['CN','EU'].includes(raw.group)&&['manual','member','specialty'].includes(raw.kind),'ELECTRICIAN_INPUT_INVALID',422);
    const keys=raw.kind==='manual'?['kind','group','name','url']:raw.kind==='member'?['kind','group','memberId']:['kind','group','specialty','squadId'];
    need(Object.keys(raw).every(k=>keys.includes(k)),'ELECTRICIAN_INPUT_INVALID',422);
    let entry;
    if(raw.kind==='manual') {
      const url=electricianProfile(raw.url);
      need(url&&typeof raw.name==='string'&&raw.name.trim()&&raw.name.trim().length<=80&&!/[\x00-\x1f\x7f]/.test(raw.name),'ELECTRICIAN_INPUT_INVALID',422);
      entry={kind:raw.kind,group:raw.group,name:raw.name.trim(),url};
    } else if(raw.kind==='member') {
      need(typeof raw.memberId==='string'&&raw.memberId.length>0&&raw.memberId.length<=160,'ELECTRICIAN_INPUT_INVALID',422);
      const member=service.identity.repo.get('members',raw.memberId);need(active(member),'MEMBER_UNAVAILABLE',422);
      authorize(actor,'members.read',{kind:'member',id:member.id},relations);entry={kind:raw.kind,group:raw.group,memberId:member.id};
    } else {
      need(typeof raw.specialty==='string'&&Object.hasOwn(specialties,raw.specialty)&&typeof (raw.squadId??'')==='string'&&(raw.squadId||'').length<=160,'ELECTRICIAN_INPUT_INVALID',422);
      authorize(actor,'members.read',{kind:'member',id:'*'},relations);
      need(service.identity.repo.all('members').filter(active).every(m=>can(actor,'members.read',{kind:'member',id:m.id},relations)),'ACCESS_DENIED',403);
      if(raw.squadId) {const squad=service.identity.repo.get('squads',raw.squadId);need(squad&&!squad.archivedAt,'SQUAD_UNAVAILABLE',422);authorize(actor,'squads.read',{kind:'squad',id:raw.squadId},relations);}
      entry={kind:raw.kind,group:raw.group,specialty:raw.specialty,squadId:raw.squadId||''};
    }
    const key=JSON.stringify(entry.kind==='manual'?['manual',entry.url.toLowerCase()]:entry.kind==='member'?['member',entry.memberId]:['specialty',entry.specialty,entry.squadId]);
    if(!seen.has(key)){seen.add(key);entries.push(entry);}
  }
  need(typeof operationId==='string'&&/^[A-Za-z0-9:_-]{1,160}$/.test(operationId),'IDEMPOTENCY_KEY_REQUIRED',422);
  const digest=JSON.stringify(input), old=service.repo.get('electrician-operation',operationId);
  if(old){need(old.actorId===actor.id&&old.digest===digest,'IDEMPOTENCY_CONFLICT',409);return {...old,current:electricianRosterDetail(service,actor)};}
  return service.repo.transaction(()=>{
    service.actor(actor,'kook',true);service.actor(actor,'discord',true);
    need(!electricianRosterDetail(service,actor).hasRestrictedSources,'ACCESS_DENIED',403);
    const current=readElectricianRoster(service.repo);need(current.revision===input.expectedRevision,'REVISION_CONFLICT',409);
    const next={entries,revision:current.revision+1,updatedAt:new Date(service.now()).toISOString()};
    service.repo.put('electrician-roster','shared','shared',actor.id,service.now(),next);
    resolveElectricianRoster(service.repo,service.identity);
    const receipt={operationId,actorId:actor.id,digest,status:'succeeded',revision:next.revision};
    service.repo.put('electrician-operation',operationId,'shared',actor.id,service.now(),receipt);
    service.identity.audit('electrician_roster_changed',actor.id,{revision:next.revision});
    return {...receipt,current:electricianRosterDetail(service,actor)};
  });
}
