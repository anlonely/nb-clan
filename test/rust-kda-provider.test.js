import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchInternalRustKdaJson } from '../server/rust-kda-provider.js';

test('internal Steam KDA provider exposes RustStats-style fields and full raw stats', async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith('https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v0002/')) {
      return new Response(JSON.stringify({
        playerstats: {
          stats: [
            { name: 'kill_player', value: 24 },
            { name: 'deaths', value: 8 },
            { name: 'headshot', value: 12 },
            { name: 'bullet_fired', value: 300 },
            { name: 'bullet_hit_player', value: 120 },
            { name: 'bullet_hit_building', value: 30 },
            { name: 'bullet_hit_sign', value: 5 },
            { name: 'bullet_hit_wolf', value: 2 },
            { name: 'bullet_hit_bear', value: 3 },
            { name: 'bullet_hit_boar', value: 4 },
            { name: 'bullet_hit_stag', value: 5 },
            { name: 'bullet_hit_horse', value: 6 },
            { name: 'bullet_hit_playercorpse', value: 7 },
            { name: 'bullet_hit_entity', value: 200 },
            { name: 'rocket_fired', value: 7 },
            { name: 'harvest.sulfur_ore', value: 2400 },
            { name: 'harvest.metal_ore', value: 1200 },
            { name: 'harvest.wood', value: 600 },
            { name: 'harvest.stones', value: 300 },
            { name: 'placed_blocks', value: 66 }
          ]
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href.startsWith('https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/')) {
      return new Response(JSON.stringify({
        response: {
          games: [{ appid: 252490, playtime_forever: 750, playtime_2weeks: 60 }]
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (href.startsWith('https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/')) {
      return new Response(JSON.stringify({
        playerstats: {
          achievements: [
            { apiname: 'a', achieved: 1 },
            { apiname: 'b', achieved: 0 },
            { apiname: 'c', achieved: 1 }
          ]
        }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ error: 'unexpected steam url' }), { status: 404, headers: { 'content-type': 'application/json' } });
  };

  try {
    const payload = await fetchInternalRustKdaJson('/api/kda/76561198000000001', { steamWebApiKey: 'steam_test_key' });
    assert.equal(payload.rustStats.minutes_played, 750);
    assert.equal(payload.rustStats.achievement_count, 2);
    assert.equal(payload.rustStats.kdr, 3);
    assert.equal(payload.rustStats.bullets.fired, 300);
    assert.equal(payload.rustStats.bullets.hits.players, 120);
    assert.equal(payload.rustStats.bullets.hits.buildings, 30);
    assert.equal(payload.rustStats.bullets.hits.dead_players, 7);
    assert.equal(payload.rustStats.bullets.hits.other, 18);
    assert.equal(payload.rustStats.bullets.total_hits, 200);
    assert.equal(payload.raw_stats.kill_player, 24);
    assert.equal(payload.raw_stats['harvest.sulfur_ore'], 2400);
    assert.equal(payload.sections.some((section) => section.id === 'bullets'), true);
  } finally {
    global.fetch = previousFetch;
  }
});

test('internal Steam KDA provider treats Steam 400 stats response as no public Rust stats', async () => {
  const previousFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.startsWith('https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v0002/')) {
      return new Response(JSON.stringify({ response: { error: 'Bad Request' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response(JSON.stringify({ error: 'unexpected steam url' }), {
      status: 404,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const payload = await fetchInternalRustKdaJson('/api/kda/76561198000000002', { steamWebApiKey: 'steam_test_key' });
    assert.equal(payload.error, '玩家资料未公开或无 Rust 游戏数据');
  } finally {
    global.fetch = previousFetch;
  }
});
