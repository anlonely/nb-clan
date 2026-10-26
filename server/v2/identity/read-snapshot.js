// Only the synchronous actor/digest calculation uses this view. It is discarded
// before an eligibility await; session validation still runs on both sides.
export function accountReadScope(service, account, { actor = false } = {}) {
  if (!service.repo.db) return service;
  const view = Object.create(service), repository = service.repo;
  const prepare = sql => repository.readStatement ? repository.readStatement(sql) : repository.db.prepare(sql);
  const rows = new Map(), collections = new Map();
  view.repo = Object.create(repository);
  view.repo.get = (name, id) => {
    const key = JSON.stringify([name, id]);
    if (!rows.has(key)) rows.set(key, repository.get(name, id));
    return rows.get(key);
  };
  if (typeof account === 'string') account = view.repo.get('accounts', account);
  view.repo.all = name => {
    if (!collections.has(name)) {
      let result;
      if (name === 'bindings' && typeof account?.id === 'string') {
        result = prepare(`SELECT payload_json FROM json_records
          WHERE collection='v2SteamBindings' AND json_extract(payload_json,'$.accountId')=? ORDER BY id`)
          .all(account.id).map(row => JSON.parse(row.payload_json));
      } else if (name === 'squadMembers') {
        const memberId = actor && !view.repo.all('bindings').some(binding => binding.accountId === account?.id && binding.status === 'verified')
          ? null : account?.memberId;
        if (memberId == null || typeof memberId === 'string') {
          // SQL NULL is a superset of missing/null; the original strict JS
          // equality below this view still selects the exact original rows.
          result = prepare(`SELECT payload_json FROM json_records
            WHERE collection='squadMembers' AND json_extract(payload_json,'$.memberId') IS ? ORDER BY id`)
            .all(memberId ?? null).map(row => JSON.parse(row.payload_json));
        } else result = repository.all(name);
      } else result = repository.all(name);
      collections.set(name, result);
    }
    return collections.get(name);
  };
  return view;
}
