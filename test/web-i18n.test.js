import assert from 'node:assert/strict';
import test from 'node:test';
import { COPY } from '../src/i18n/copy.js';
import { OFFICIAL_KDA_ITEM_LABELS, officialKdaExtraGroupIdForKey } from '../src/shared/data-lookup/labels.js';

const TARGET_LANGS = ['ru', 'tr', 'th', 'ko'];
const FOCUS_PREFIXES = /^(discordKook|discord|kook|bot|wechat|permission|role|sync|rustplusRelay|member|public|account|wipe|nav)/;
const TECHNICAL_LEADING_TEXT = /^(?:Discord|KOOK|WeChat|Steam|Rust\+?|KDA|BMID|VIP|API|URL|ID|Key|Token|BM|KD|Wipe|root|Web|Vital|Atlas|Rustinity|OpenAI)(?:[\s/:+\-↔]|$)/;
const TEMPORARY_TRANSLATION_TOKEN = /NBPH|NBSEP|\{\{\d+\}\}|НБПХ|เอ็นบี|엔비/i;

function loadWebCopy() {
  return COPY;
}

function loadWebI18nState() {
  return {
    copy: COPY,
    officialKdaItemLabels: OFFICIAL_KDA_ITEM_LABELS
  };
}

function placeholders(value) {
  return [...String(value || '').matchAll(/\{[^}]+\}/g)].map((match) => match[0]).sort();
}

test('web i18n translations preserve placeholders and generated token cleanup', () => {
  const copy = loadWebCopy();
  for (const lang of TARGET_LANGS) {
    for (const key of Object.keys(copy.zh)) {
      assert.deepEqual(
        placeholders(copy[lang][key]),
        placeholders(copy.en[key]),
        `${lang}.${key} should preserve copy placeholders`
      );
      assert.equal(
        TEMPORARY_TRANSLATION_TOKEN.test(String(copy[lang][key])),
        false,
        `${lang}.${key} should not contain temporary translation tokens`
      );
    }
  }
});

test('high-visibility web sections do not fall back to English copy', () => {
  const copy = loadWebCopy();
  for (const lang of TARGET_LANGS) {
    const actionableFallbackKeys = Object.keys(copy.zh).filter((key) => {
      if (!FOCUS_PREFIXES.test(key)) return false;
      const english = String(copy.en[key] || '');
      if (english.length <= 12 || TECHNICAL_LEADING_TEXT.test(english)) return false;
      return copy[lang]?.[key] === copy.en?.[key] && copy.en?.[key] !== copy.zh?.[key];
    });
    assert.deepEqual(actionableFallbackKeys, [], `${lang} should not fall back to English for major Web pages`);
  }
});

test('official KDA extra metric labels cover known raw Steam stat keys', () => {
  const { officialKdaItemLabels } = loadWebI18nState();
  const zhLabels = officialKdaItemLabels.zh;
  const rawKeys = [
    'death_suicide',
    'death_fall',
    'death_selfinflicted',
    'arrow_hit_entity',
    'arrow_hit_building',
    'kill_bear',
    'kill_boar',
    'kill_stag',
    'kill_chicken',
    'kill_wolf',
    'arrow_hit_boar',
    'arrow_hit_bear',
    'arrow_hit_wolf',
    'arrow_hit_chicken',
    'arrow_hit_player',
    'death_entity',
    'death_wolf',
    'death_bear',
    'shotgun_hit_building',
    'shotgun_hit_player',
    'shotgun_hit_entity',
    'wounded',
    'wounded_assisted',
    'wounded_healed',
    'ITEM_EXAMINED',
    'ORE_HIT',
    'TREE_HIT',
    'comfort_duration',
    'calories_consumed',
    'water_consumed',
    'pickup_category_food',
    'radiation_exposure_duration',
    'cold_exposure_duration',
    'hot_exposure_duration',
    'melee_strikes',
    'melee_thrown',
    'seconds_speaking',
    'topology_road_duration',
    'horse_distance_ridden',
    'helipad_landings',
    'recycled_cans',
    'kill_scientist',
    'horse_distance_ridden_km',
    'InstrumentNotesPlayed',
    'grenades_thrown',
    'gesture_wave_count',
    'waved_at_players',
    'missions_completed',
    'bags_unclaimed',
    'wires_connected',
    'hoses_connected',
    'pipes_connected',
    'tincanalarms_wired',
    'scope_zoom_changed',
    'horse_mounted_count',
    'bee_attacks_count',
    'snake_hazard_failed_count',
    'spotlight_deployed_count',
    'boat_steering_wheel_placed_count',
    'boat_steering_wheel_mounted_count',
    'STAT_LOOT_MAINLAND',
    'distance_in_water_mainland',
    'distance_in_water_deepsea',
    'cargoship_bridge_visits',
    'InstrumentFullKeyboardMode',
    'caught_anchovy',
    'caught_herring',
    'caught_sardine',
    'caught_small_trout',
    'dweller_kills_while_moving',
    'excavator_activated'
  ];

  for (const key of rawKeys) {
    assert.equal(typeof zhLabels[key], 'string', `${key} should have a Chinese label`);
    assert.notEqual(zhLabels[key], key, `${key} should not display the raw key`);
    assert.equal(/[_A-Z]{2,}/.test(zhLabels[key]), false, `${key} label should not look like a raw stat key`);
  }
});

test('official KDA raw metrics are grouped by semantic categories', () => {
  const cases = [
    ['bullet_fired', 'weapons'],
    ['arrow_hit_player', 'hits'],
    ['kill_scientist', 'combat'],
    ['acquired_metal.ore', 'resources'],
    ['destroyed_barrels', 'resources'],
    ['placed_blocks', 'building'],
    ['INVENTORY_OPENED', 'interaction'],
    ['InstrumentFullKeyboardMode', 'interaction'],
    ['ORE_HIT', 'resources'],
    ['distance_in_water_deepsea', 'travel'],
    ['horse_distance_ridden', 'vehicles'],
    ['cold_exposure_duration', 'environment'],
    ['excavator_activated', 'activities'],
    ['wires_connected', 'utilities'],
    ['pickup_category_food', 'fishing'],
    ['caught_sardine', 'fishing']
  ];

  for (const [key, group] of cases) {
    assert.equal(officialKdaExtraGroupIdForKey(key), group, `${key} should be grouped as ${group}`);
  }
});
