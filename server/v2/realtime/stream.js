/** Lifecycle belongs to the root owner. No listeners/timers exist until open() is called. */
export function createRealtimeStreamOwner({
  heartbeatMs = 25000,
  maxBytes = 1024 * 1024,
  drainTimeoutMs = 1000
} = {}) {
  const clients = new Set();
  const authorizations = new Set();
  let stopped = false;
  const authenticateTracked = async authenticate => {
    const work = Promise.resolve().then(authenticate);
    authorizations.add(work);
    try { return await work; }
    finally { authorizations.delete(work); }
  };
  return {
    get size() {
      return clients.size;
    },
    async stop() {
      stopped = true;
      for (const close of [...clients]) close();
      await Promise.allSettled([...authorizations]);
    },
    async open({
      req,
      res,
      service,
      authenticate,
      scopeId,
      cursor
    }) {
      if (stopped) throw Object.assign(new Error('STREAM_STOPPED'), {
        status: 503
      });
      const initial = await authenticateTracked(authenticate),
        actor = initial.actor;
      if (stopped || req.destroyed || res.destroyed) {
        res.end();
        return;
      }
      service.access(actor, scopeId, 'relay.chat_read');
      let closed = false,
        busy = false,
        pending = false,
        backpressured = false,
        finishDrain,
        unsub = () => {},
        unsubIdentity = () => {},
        timer;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        finishDrain?.();
        unsub();
        unsubIdentity();
        clients.delete(close);
        res.end();
      };
      const write = (type, data, id) => {
        if (closed) return false;
        const frame = `${id ? `id: ${id}\n` : ''}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
        if (Buffer.byteLength(frame) > maxBytes || res.writableLength + Buffer.byteLength(frame) > maxBytes) {
          res.destroy();
          close();
          return false;
        }
        if (!res.write(frame)) backpressured = true;
        return true;
      };
      const drain = () => new Promise(resolve => {
        if (closed) { resolve(); return; }
        if (typeof res.once !== 'function') { res.destroy(); close(); resolve(); return; }
        const timeout = setTimeout(() => { res.destroy(); close(); }, drainTimeoutMs);
        const onClose = () => close();
        finishDrain = () => {
          clearTimeout(timeout); res.off('drain', finishDrain); res.off('close', onClose);
          finishDrain = null; backpressured = false; resolve();
        };
        res.once('drain', finishDrain); res.once('close', onClose);
      });
      res.status(200).set({
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-store',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
      });
      res.flushHeaders();
      clients.add(close);
      req.once('close', close);
      const pump = async () => {
        if (closed) return;
        if (busy) {
          pending = true;
          return;
        }
        busy = true;
        try {
          do {
            pending = false;
            const {
              actor: current
            } = await authenticateTracked(authenticate);
            if (closed) return;
            if (current.id !== actor.id || current.permissionVersion !== actor.permissionVersion) throw new Error('AUTHORIZATION_REVOKED');
            const batch = service.events(current, scopeId, cursor);
            if (batch.resetRequired) {
              write('reset_required', {
                cursor: batch.cursor
              });
              close();
              return;
            }
            for (const event of batch.events) {
              if (!write('realtime', event, event.eventId)) return;
              cursor = event.eventId;
              if (backpressured) break;
            }
            if (backpressured) {
              await drain();
              if (closed) return;
              // Discard the unsent batch. Resume from the last queued cursor
              // only after the original authentication and scope checks rerun.
              pending = true;
              continue;
            }
            if (!write('heartbeat', {
              cursor: batch.cursor,
              source: batch.source
            })) return;
            cursor = batch.cursor;
            if (backpressured) { await drain(); if (closed) return; }
            if (pending) await new Promise(resolve => setImmediate(resolve));
          } while (pending && !closed);
        } catch (e) {
          write(e.status === 401 || e.status === 403 || e.message === 'AUTHORIZATION_REVOKED' ? 'authorization-revoked' : 'unavailable', {
            reason: 'revalidate'
          });
          close();
        } finally {
          busy = false;
        }
      };
      unsub = service.repo.subscribe(id => {
        if (id === scopeId) void pump();
      });
      unsubIdentity = service.identity.subscribe(event => {
        if (event.accountId === actor.id) {
          write('authorization-revoked', {
            reason: 'identity_changed'
          });
          close();
        }
      });
      timer = setInterval(pump, heartbeatMs);
      timer.unref?.();
      await pump();
      return close;
    }
  };
}
