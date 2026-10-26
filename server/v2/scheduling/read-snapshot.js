// Request-local synchronous reads only. Nothing survives this roster evaluation.
// Authorization still uses the original IdentityService methods and current rows.
export function rosterReadScope(service, wipe) {
  const cacheRepository = repository => {
    const view = Object.create(repository), collections = new Map(), indexes = new Map(), rows = new Map();
    view.all = name => {
      if (!collections.has(name)) { collections.set(name, repository.all(name)); indexes.set(name, new Map(collections.get(name).map(row => [row.id,row]))); }
      return collections.get(name);
    };
    view.get = (name, id) => {
      if (collections.has(name)) return indexes.get(name).get(id) || null;
      const key = JSON.stringify([name, id]);
      if (!rows.has(key)) rows.set(key, repository.get(name, id));
      return rows.get(key);
    };
    view.primeRead = (name, id, value) => rows.set(JSON.stringify([name, id]), value);
    return view;
  };
  const view = Object.create(service), identity = Object.create(service.identity);
  identity.repo = cacheRepository(service.identity.repo);
  const relations = service.identity.relations.bind(identity);
  let currentRelations;
  identity.relations = () => currentRelations ||= relations();
  view.identity = identity;
  view.repo = cacheRepository(service.repo);
  if (wipe) {
    const ids = [...new Set(identity.repo.all('bindings').map(b => b.accountId).filter(Boolean))];
    const accounts = service.identity.repo.db.prepare("SELECT id,payload_json FROM json_records WHERE collection='v2Accounts' AND id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids));
    for (const id of ids) identity.repo.primeRead('accounts',id,null);
    for (const row of accounts) identity.repo.primeRead('accounts',row.id,JSON.parse(row.payload_json));
    const signupRows = service.repo.forWipe('signups',wipe.id);
    const signups = new Map(signupRows.map(row => [row.id,row]));
    view.repo.forWipe = (name,id) => name === 'signups' && id === wipe.id ? signupRows : service.repo.forWipe(name,id);
    view.roster = (actor,current,options) => current.id === wipe.id ? view.evaluateRoster(actor,current,options) : service.roster(actor,current,options);
    const get = view.repo.get;
    view.repo.get = (name,id) => name === 'signups' ? signups.get(id) || null : get(name,id);
  }
  return view;
}
