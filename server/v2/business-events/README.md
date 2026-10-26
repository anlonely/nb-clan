# G06 business cache events

`createBusinessEventsHub` from `./index.js` owns one shared interval and the
`GET /events` Express router. Mount it at `/api/v2` **after G03 identity**. It uses
`req.v2Identity.authenticate()`; there is no separate session or authentication
scheme. No schema installation, notification send, outbox mutation or scheduled
job runs as a result of a GET.

```js
const events = createBusinessEventsHub({
  // Omit entirely when the explicit isolated notification runtime is absent.
  getNotificationSystem: identity => notificationRuntime.getSystem(identity)
});
router.use('/v2', identityMiddleware);
router.use('/v2', events.router);
// During shutdown, before closing the shared SQLite handle:
await events.stop();
```

The getter must synchronously return the shared B system, or null. It is never
used to install schemas. An unavailable configured system ends the stream so
the browser reconnects and resets; G04 works independently when no getter is
configured. `poll()` is an explicit bounded pump for integration tests;
`diagnostics()` returns counts only, without account IDs or cursor state.

## Wire protocol

All named events use `schemaVersion: 1` and the original authenticated
`scopeVersion`. Event IDs are an opaque connection UUID plus local sequence;
they contain no SQLite positions and cannot resume history. Every connection,
including one with arbitrary `Last-Event-ID`, receives reset and captures current
SQLite watermarks. This is **reset followed by incremental cache invalidation**,
not an exact historical replay protocol.

- `reset`: `{schemaVersion, scopeVersion, reason}` where reason is `initial`,
  `reconnect`, or `scope_changed`.
- `invalidate`: `{schemaVersion, scopeVersion, changes}` containing at most 100
  allowlisted hints. A hint is `{kind:'wipe'|'signup', wipeId}` or
  `{kind:'notification', wipeId, intentId, deliveryId}`.
- `authorization-revoked`: `{schemaVersion, scopeVersion}`; the stream closes.

No member identity, target identity, event rowid, timestamps, operation keys,
before/after payload, platform token, message reference, counts or evidence
appear in hints. G04 immutable event rows are projected with SQLite rowid in
batches of 100; the corresponding outbox is left untouched. B's committed
`service.repo.listChanges` is consumed in batches of 100, and each event is
cross-checked against the current delivery linkage.

Before every pump the original cookie is authenticated again. After asynchronous
eligibility refresh, the current actor, permission version and G03 scope digest
are checked again. There are no awaits between the final check and sending.
Wipes require current `wipes.read`; signup changes additionally require
`signups.read` for the actual subject; notification changes additionally require
a currently enabled catalog target and `notifications.preview`, `send` or
`reconcile` for that target. Delivery/intent/target/wipe linkage must still match.

Wipe audience changes and target configuration changes may alter visible
resources without increasing G03 permissionVersion. The hub fingerprints only
current authorized wipe IDs and safe target configuration revisions. A changed
fingerprint emits generic `scope_changed` and closes, without naming resources
that became inaccessible. Relationships are read using current audience and
membership metadata projections, not historical payloads. Per-pump metadata
cost grows with current wipe/membership/catalog size; G08 performance work
should measure this separately from bounded history batch size.

## Client and lifecycle

`useBusinessEvents({client, session, online, refreshSession})` in
`src/v2/business-events.js` retains the existing `/api/v2/auth/events` flow.
`connectBusinessEvents` is its lifecycle controller, directly tested with an
EventSource substitute. The hook lifecycle depends on query-client generation
as well as account/scope, so restoring the same account and scope after a cache
reset creates a fresh stream even if React batches the state updates. All
messages are fenced by captured query-client generation, account and scope. Malformed, oversized, wrong-scope or extra-field
messages are ignored. Native EventSource owns reconnect backoff; invalidations
are ignored after disconnect until another reset. No cursors or private content
are persisted in browser storage.

Initial/reconnect reset invalidates all queries so active reads refetch.
`scope_changed` synchronously closes the stream and calls `clearIdentity` with
normal notification, clearing cached data and causing App to unmount private
pages before a fenced `refreshSession` bootstrap. Revocation clears identity
without automatic retry. Identity change, offline effect cleanup and unmount
remove listeners and close the old stream. No client interval is created.

Actual member and A admin keys are covered: home, wipes, wipe, signups, history,
admin-wipes, admin-signup, admin-history, admin-archive, notification-options,
notification-intents, notification-intent and notification-delivery.

Defaults: one 2-second interval while connections exist, at most 64 connections
and four per account, 100 rows per source per pump, maximum 32 KiB frames. A
failed `res.write` or excess writable buffer closes immediately without an
application queue. Slow authentication closes on the shared timer after the
15-second budget (plus up to one interval); other clients continue pumping.
Pending authentication slots remain counted after timeout until those calls
settle, so repeated reconnects cannot accumulate unbounded in-flight work.
`stop()` cancels the interval, closes streams and awaits in-flight G03
authentication before DB closure. Existing G03 provider timeouts still govern
completion of any already-started eligibility network request.

## Verification boundary

`node --test test/v2-business-events*.test.js` covers actual in-memory SQLite,
real G03 cookie authentication and loopback HTTP SSE, real G04 mutations and B
persisted delivery transitions, source/scope filtering, revocation races,
reconnect watermarks, read-only mode, no GET migration, shutdown and backpressure.
B tests use its explicitly isolated renderer/transport fixture; these tests
do not claim C-platform or full application browser acceptance. Client tests
exercise lifecycle with the real query client and mock EventSource. Root's
combined runtime/browser checks remain the acceptance surface for full G06.
