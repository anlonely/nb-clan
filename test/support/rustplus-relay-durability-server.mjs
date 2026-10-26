import { createServer } from 'node:http';
import express from 'express';

const relayToken = process.env.NB_TEST_RUSTPLUS_RELAY_TOKEN || 'rustplus_durability_token_1234567890';

const { createApiRouter } = await import('../../server/api.js');
const { installRustplusRelayWebSocket } = await import('../../server/rustplus-relay-stream.js');
const { saveRustplusRelayToken } = await import('../../server/rustplus-relay.js');
const { ensureStore } = await import('../../server/store.js');
const { injectSqliteStorePatchFailureForTests } = await import('../../server/storage/repository.js');
const { closeSqliteDatabasesForTests } = await import('../../server/storage/sqlite.js');

await ensureStore();
await saveRustplusRelayToken(relayToken);

const flushFailures = Math.max(0, Number(process.env.NB_TEST_RUSTPLUS_CHAT_FLUSH_FAILURES) || 0);
if (flushFailures) {
  injectSqliteStorePatchFailureForTests('rustplus_relay_chat_flush', flushFailures);
}
const inviteFailures = Math.max(0, Number(process.env.NB_TEST_RUSTPLUS_INVITE_WRITE_FAILURES) || 0);
if (inviteFailures) {
  injectSqliteStorePatchFailureForTests('rustplus_relay_clan_invite_record', inviteFailures);
}

const app = express();
app.use('/api', createApiRouter());
const server = createServer(app);
const relayWebSocketServer = installRustplusRelayWebSocket(server);

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.stdout.write(`${JSON.stringify({ type: 'ready', port: server.address().port })}\n`);

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const client of relayWebSocketServer.clients) client.terminate();
  await new Promise((resolve) => relayWebSocketServer.close(() => resolve()));
  await new Promise((resolve) => server.close(() => resolve()));
  await closeSqliteDatabasesForTests();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    close().then(() => process.exit(0), (error) => {
      console.error(error);
      process.exit(1);
    });
  });
}
