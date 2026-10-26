import assert from 'node:assert/strict';
import test from 'node:test';

test('discord-kook translation treats deep as team size only in Rust roster context', async () => {
  const previousEnv = {
    NB_DISABLE_BACKGROUND_JOBS: process.env.NB_DISABLE_BACKGROUND_JOBS,
    NODE_ENV: process.env.NODE_ENV
  };
  try {
    process.env.NODE_ENV = 'test';
    process.env.NB_DISABLE_BACKGROUND_JOBS = '1';
    const apiModule = await import(`../server/api.js?translation-intent=${Date.now()}`);
    const helpers = apiModule.__discordKookBridgeTranslationForTests;
    const rosterMessage = '@everyone all who will play medium wipe with us in MCV do wipe react pls, we need understand how deep we are';

    assert.match(helpers.systemPrompt, /deep in roster\/headcount phrases/i);
    assert.match(helpers.systemPrompt, /how deep we are -> 我们得看看这次有多少人\/阵容多大/);
    assert.match(helpers.bridgeTranslationIntentHints(rosterMessage), /player headcount or team size/i);
    assert.match(helpers.bridgeTranslationUserPrompt('Simplified Chinese', rosterMessage), /有多少人\/阵容多大\/几人队/);

    assert.equal(helpers.bridgeTranslationIntentHints('the water near cargo is deep'), '');
    assert.equal(helpers.bridgeTranslationIntentHints('we need to understand how deep we are underwater'), '');
  } finally {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
