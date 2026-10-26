// A synchronous event-batch view. Session authentication and the original
// current-actor check still run for every subscriber and every batch.
export function realtimeReadScope(service, id) {
  if (!service.repo) return service;
  const view=Object.create(service),identity=Object.create(service.identity),repository=service.identity.repo;
  const rows=new Map(),collections=new Map(),digests=new WeakMap();
  identity.repo=Object.create(repository);
  identity.repo.all=name=>{
    if(!collections.has(name))collections.set(name,repository.all(name));
    return collections.get(name);
  };
  identity.repo.get=(name,key)=>{
    const cacheKey=JSON.stringify([name,key]);
    if(!rows.has(cacheKey))rows.set(cacheKey,repository.get(name,key));
    return rows.get(cacheKey);
  };
  identity.scopeDigest=account=>{
    if(!digests.has(account))digests.set(account,service.identity.scopeDigest.call(identity,account));
    return digests.get(account);
  };
  const scope=service.repo.scope(id);view.repo=Object.create(service.repo);
  view.repo.scope=key=>key===id?scope:service.repo.scope(key);
  let relations;
  identity.relations=()=>relations||=service.identity.relations.call(identity);
  const squadRelations=new Map();
  view.authorizationRelations=(actor,resource)=>{
    // System relay scopes still pass the fresh account/root guard in access().
    // Membership relationships cannot authorize them, even for all-scope users.
    if(resource.kind==='system')return {squadMembers:[],wipes:[]};
    // Only self scope uses memberships for a squad resource; explicit squad
    // grants compare resource.id directly. Other resource kinds keep all rows.
    if(resource.kind!=='squad'||actor.memberId!=null&&typeof actor.memberId!=='string')return identity.relations();
    if(!squadRelations.has(actor.memberId)){
      const sql="SELECT payload_json FROM json_records WHERE collection='squadMembers' AND json_extract(payload_json,'$.memberId') IS ? ORDER BY id";
      const statement=repository.readStatement?repository.readStatement(sql):repository.db.prepare(sql);
      squadRelations.set(actor.memberId,{squadMembers:statement.all(actor.memberId??null).map(row=>JSON.parse(row.payload_json)),wipes:[]});
    }
    return squadRelations.get(actor.memberId);
  };
  view.identity=identity;
  return view;
}
