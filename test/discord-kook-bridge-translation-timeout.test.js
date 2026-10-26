import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import express from 'express';

test('discord-kook translation aborts a stalled provider request', async () => {
  const previousEnv = {
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NB_DISCORD_KOOK_BRIDGE_TRANSLATION_TIMEOUT_MS: process.env.NB_DISCORD_KOOK_BRIDGE_TRANSLATION_TIMEOUT_MS,
    NB_TRANSLATION_API_BASE_URL: process.env.NB_TRANSLATION_API_BASE_URL,
    NODE_ENV: process.env.NODE_ENV
  };
  const app = express();
  app.use(express.json());
  app.post('/v1/chat/completions', (_req, res) => {
    setTimeout(() => res.json({ choices: [{ message: { content: 'late' } }] }), 1000);
  });
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.NODE_ENV = 'test';
    process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    process.env.NB_DISCORD_KOOK_BRIDGE_TRANSLATION_TIMEOUT_MS = '250';
    process.env.NB_TRANSLATION_API_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
    const apiModule = await import(`../server/api.js?translation-timeout=${Date.now()}`);
    const startedAt = Date.now();
    await assert.rejects(
      () => apiModule.__discordKookBridgeTranslationForTests.translateBridgeMessage('hello', {
        settings: {
          discordKookBridge: {
            translationApiKey: 'translation_timeout_test_key',
            translationBaseUrl: process.env.NB_TRANSLATION_API_BASE_URL,
            translationModel: 'timeout-test-model'
          }
        }
      }, 'English'),
      (error) => error?.status === 504 && /translation timeout/i.test(error.message)
    );
    assert.equal(Date.now() - startedAt < 900, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    Object.assign(process.env, previousEnv);
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
    }
  }
});
