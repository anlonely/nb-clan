export function emptyChat(scope = '') {
  return {
    scope,
    history: [],
    tail: [],
    before: null,
    after: null,
    loaded: false,
    gap: false,
    source: null,
    overflow: false
  };
}
const unique = items => {
  const seen = new Set();
  return items.filter(m => !seen.has(m.id) && seen.add(m.id));
};
export function reduceChat(state, event) {
  if (event.scope !== state.scope) return state;
  if (event.type === 'reset') return emptyChat(state.scope);
  if (event.type === 'initial') return {
    ...state,
    history: unique(event.page.items),
    tail: [],
    before: event.page.nextCursor,
    after: event.page.tailCursor,
    source: event.page.source,
    loaded: true,
    gap: false,
    source: null,
    overflow: false
  };
  if (event.type === 'source') return {
    ...state,
    source: event.source
  };
  if (event.type === 'history') return {
    ...state,
    history: unique([...state.history, ...event.page.items]).slice(0, 1000),
    before: event.page.nextCursor
  };
  if (event.type === 'event') {
    if (event.data.eventType === 'scope.reset') return {
      ...emptyChat(state.scope),
      gap: true
    };
    const payload = event.data.payload;
    return {
      ...state,
      overflow: state.overflow || event.data.eventType === 'chat.created' && state.tail.length >= 200,
      after: event.data.eventId,
      tail: event.data.eventType === 'chat.created' ? unique([payload, ...state.tail]).slice(0, 200) : state.tail
    };
  }
  return state;
}
export function visibleChat(state) {
  return unique([...state.history, ...state.tail]).sort((a, b) => String(b.sentAt || b.occurredAt || b.receivedAt).localeCompare(String(a.sentAt || a.occurredAt || a.receivedAt)) || b.id.localeCompare(a.id));
}
