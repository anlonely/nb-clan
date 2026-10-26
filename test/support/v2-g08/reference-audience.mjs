// Frozen recovery delta source; comparison only, never used by the runtime.
import {can} from '../../../server/v2/identity/permissions.js';
import {need,hash,stamp} from '../../../server/v2/notifications/shared.js';
export const sourceHash='15c146defd5c6bfdd4f2bc277ecff957bc21fcd851c2d903dd77422954f7306d';
export function audienceSnapshot(actor,w,audience) {
    const prospective={...w,audience};
    need(audience.squadIds.every(id=>w.audience.squadIds.includes(id)) && (!audience.includeUnassigned || w.audience.includeUnassigned) &&
      audience.memberIds.every(id=>this.identity.repo.get('members',id) && this.scheduling.inAudience(w,id)), 'NOTIFICATION_AUDIENCE_DENIED',403);
    const members=this.identity.repo.all('members').filter(m=>this.scheduling.inAudience(prospective,m.id));
    for (const member of members) need(can(actor,'signups.read',{kind:'signup',wipeId:w.id,memberId:member.id},this.identity.relations()),'NOTIFICATION_AUDIENCE_DENIED',403);
    // Scope checks include frozen archive members; current membership must not reveal an unreadable historical roster.
    const roster=this.scheduling.rosterForRead(actor,w);
    const full=hash(audience)===hash(w.audience);
    const rows=full?roster.rows:roster.rows.filter(row=>this.scheduling.inAudience(prospective,row.memberId));
    need(!full || !['authorized_members','authorized_archived_members'].includes(roster.countScope),'NOTIFICATION_AUDIENCE_DENIED',403);
    return {rows,counts:this.scheduling.counts(rows),rosterRevision:roster.rosterRevision,countScope:full?roster.countScope:'notification_audience',evaluatedAt:stamp(this.now)};
  }
