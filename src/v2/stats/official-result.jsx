import { t, getUiLocale } from '../i18n.js';
import React, { useState } from 'react';
import { Avatar } from '../ui.jsx';

// Steam's statistic names are provider keys. Keep those keys intact in the
// query result and translate only at the presentation boundary.
const categories = [
  { id: 'combat', title: '战斗与伤亡', entries: [
    ['kill_player', '击杀玩家'], ['deaths', '死亡次数'], ['headshot', '爆头次数'],
    ['kill_scientist', '击杀科学家'], ['mlrs_kills', 'MLRS 击杀'],
    ['death_suicide', '自杀死亡'], ['death_fall', '坠落死亡'],
    ['death_selfinflicted', '自伤死亡'], ['death_entity', '实体造成的死亡'],
    ['death_wolf', '被狼击杀'], ['death_bear', '被熊击杀'],
    ['wounded', '倒地次数'], ['wounded_assisted', '协助救助次数'],
    ['wounded_healed', '伤员治疗次数']
  ] },
  { id: 'weapons', title: '武器与命中', entries: [
    ['bullet_fired', '发射子弹'], ['arrow_fired', '发射箭矢'],
    ['arrows_shot', '射箭次数'], ['rocket_fired', '发射火箭弹'],
    ['shotgun_fired', '霰弹枪射击'], ['grenades_thrown', '投掷手雷'],
    ['melee_strikes', '近战攻击'], ['melee_thrown', '投掷近战武器'],
    ['bullet_hit_player', '子弹命中玩家'], ['bullet_hit_entity', '子弹命中实体'],
    ['bullet_hit_building', '子弹命中建筑'], ['bullet_hit_sign', '子弹命中标牌'],
    ['bullet_hit_playercorpse', '子弹命中玩家尸体'], ['bullet_hit_corpse', '子弹命中尸体'],
    ['arrow_hit_player', '箭矢命中玩家'], ['arrow_hit_entity', '箭矢命中实体'],
    ['arrow_hit_building', '箭矢命中建筑'], ['shotgun_hit_player', '霰弹命中玩家'],
    ['shotgun_hit_entity', '霰弹命中实体'], ['shotgun_hit_building', '霰弹命中建筑'],
    ['scope_zoom_changed', '调整瞄准镜倍率']
  ] },
  { id: 'wildlife', title: '野外生物', entries: [
    ['kill_bear', '击杀熊'], ['kill_boar', '击杀野猪'], ['kill_stag', '击杀雄鹿'],
    ['kill_chicken', '击杀鸡'], ['kill_wolf', '击杀狼'],
    ['arrow_hit_boar', '箭矢命中野猪'], ['arrow_hit_bear', '箭矢命中熊'],
    ['arrow_hit_wolf', '箭矢命中狼'], ['arrow_hit_stag', '箭矢命中雄鹿'],
    ['bullet_hit_bear', '子弹命中熊'], ['bullet_hit_stag', '子弹命中雄鹿'],
    ['bullet_hit_wolf', '子弹命中狼'], ['bullet_hit_boar', '子弹命中野猪'],
    ['bee_attacks_count', '被蜜蜂攻击'], ['snake_hazard_failed_count', '蛇类危险事件']
  ] },
  { id: 'resources', title: '采集与资源', entries: [
    ['harvested_wood', '采集木材'], ['harvested_stones', '采集石头'],
    ['harvested_cloth', '采集布料'], ['harvested_leather', '采集皮革'],
    ['acquired_lowgradefuel', '获得低级燃料'], ['acquired_metal.ore', '获得金属矿石'],
    ['acquired_scrap', '获得废料'], ['ORE_HIT', '敲击矿石'],
    ['TREE_HIT', '砍伐树木'], ['destroyed_barrels', '打碎油桶'],
    ['recycled_cans', '回收罐头']
  ] },
  { id: 'building', title: '建造与工程', entries: [
    ['placed_blocks', '放置建筑方块'], ['upgraded_blocks', '升级建筑方块'],
    ['wires_connected', '连接电线'], ['hoses_connected', '连接软管'],
    ['pipes_connected', '连接管道'], ['tincanalarms_wired', '接线罐头警报器'],
    ['spotlight_deployed_count', '部署探照灯'],
    ['boat_steering_wheel_placed_count', '放置船舵'],
    ['boat_steering_wheel_mounted_count', '使用船舵']
  ] },
  { id: 'survival', title: '生存与探索', entries: [
    ['comfort_duration', '舒适状态累计时长'], ['calories_consumed', '消耗热量'],
    ['water_consumed', '消耗水量'], ['pickup_category_food', '拾取食物'],
    ['radiation_exposure_duration', '辐射暴露累计时长'],
    ['cold_exposure_duration', '寒冷暴露累计时长'],
    ['hot_exposure_duration', '高温暴露累计时长'],
    ['topology_road_duration', '道路区域累计时长'],
    ['horse_distance_ridden', '骑马移动距离（原始值）'],
    ['horse_distance_ridden_km', '骑马里程（公里）'],
    ['horse_mounted_count', '骑马次数'], ['helipad_landings', '停机坪降落'],
    ['cargoship_bridge_visits', '到访货船舰桥'],
    ['STAT_LOOT_MAINLAND', '大陆区域搜刮'], ['STAT_EAT_COCONUT', '食用椰子'],
    ['distance_in_water_deepsea', '深海水中移动距离（原始值）'],
    ['distance_in_water_mainland', '陆地水域移动距离（原始值）'],
    ['caught_sardine', '捕获沙丁鱼'], ['missions_completed', '完成任务'],
    ['excavator_activated', '启动挖掘机']
  ] },
  { id: 'activity', title: '操作与互动', entries: [
    ['item_drop', '丢弃物品'], ['blueprint_studied', '研究蓝图'],
    ['INVENTORY_OPENED', '打开背包'], ['CRAFTING_OPENED', '打开制作界面'],
    ['MAP_OPENED', '打开地图'], ['CUPBOARD_OPENED', '打开领地柜'],
    ['ITEM_EXAMINED', '查看物品'], ['seconds_speaking', '语音发言秒数'],
    ['InstrumentNotesPlayed', '演奏音符'],
    ['InstrumentFullKeyboardMode', '使用乐器完整键盘模式'],
    ['gesture_wave_count', '挥手动作'], ['waved_at_players', '向玩家挥手'],
    ['bags_unclaimed', '未领取的袋子']
  ] }
];

const labels = new Map(categories.flatMap(category => category.entries.map(([key, label]) =>
  [`rawStats.${key}`, { category: category.id, label }])));
const number = value => new Intl.NumberFormat(getUiLocale().startsWith('en') ? 'en-US' : 'zh-CN', { maximumFractionDigits: 2 }).format(value);
const displayValue = value => value == null ? '—' : typeof value === 'number' ? number(value) : String(value);

export function SteamProfileCard({ result, time, playtimeSeconds }) {
  const minutes = result.steamProfile?.playtimeMinutes;
  const seconds = Number.isFinite(playtimeSeconds) && playtimeSeconds >= 0 ? playtimeSeconds
    : Number.isFinite(minutes) && minutes >= 0 ? minutes * 60 : null;
  const playtime = seconds === null ? t('未提供') : t('{hours} 小时', { hours: number(seconds / 3600) });
  return <section className="stats-steam-card" aria-label={t("Steam 基础信息")}>
    <div className="stats-steam-identity">
      <Avatar name={result.displayName || 'Steam'} src={result.steamProfile?.avatar} size={72}/>
      <div><span>{t("STEAM 账号")}</span><strong>{result.displayName || t('昵称未提供')}</strong><small>SteamID {result.steamId || t('未提供')}</small></div>
    </div>
    <div className="stats-steam-detail"><span>{t("注册时间")}</span><strong>{result.steamProfile?.createdAt ? time(result.steamProfile.createdAt) : t('未提供')}</strong></div>
    <div className="stats-steam-detail"><span>{t("Rust 游戏时长")}</span><strong>{playtime}</strong></div>
  </section>;
}

export function OfficialQueryResult({ result, time }) {
  const [selected, setSelected] = useState('combat');
  const row = result.rows?.[0];
  const playtimeSeconds = row?.values?.steamTotalSeconds;
  const summary = [
    [t('击杀玩家'), row?.values?.kills], [t('死亡次数'), row?.values?.deaths],
    ['KD', row?.values?.kd], [t('发射火箭弹'), row?.values?.rockets],
    [t('放置建筑方块'), row?.values?.building]
  ];
  const grouped = new Map(categories.map(category => [category.id, []]));
  grouped.set('other', []);
  for (const field of result.fields || []) {
    const translated = labels.get(field.name);
    grouped.get(translated?.category || 'other').push({ ...field,
      label: translated?.label ? t(translated.label) : t('未收录指标：{name}', { name: field.name.replace(/^rawStats\./, '') }) });
  }
  const available = categories.filter(category => grouped.get(category.id).length);
  if (grouped.get('other').length) available.push({ id: 'other', title: '其他原始指标' });
  const current = available.find(category => category.id === selected) || available[0];

  return <>
    <SteamProfileCard result={result} time={time} playtimeSeconds={playtimeSeconds}/>
    <section className="stats-official" aria-label={t("官服累计数据")}>
    <header className="stats-official-head">
      <div><span className="stats-official-eyebrow">STEAM · RUST</span><h2>{t("官服累计数据")}</h2>
        <p>SteamID {result.steamId || t('未提供')} <span aria-hidden="true">·</span> {t("查询于")} {time(result.fetchedAt)}</p></div>
      <span className="stats-official-status">{result.status === 'unavailable' ? t('尚无数据') : t('已取得数据')}</span>
    </header>
    {result.status === 'unavailable' ? <div className="stats-official-empty"><strong>{t("未查到 Rust 官方累计战绩")}</strong><p>{t("Steam 官方接口未返回该账号的可读取战绩。请核对 SteamID；如账号确有战绩，可检查游戏数据是否允许公开读取后重新查询。")}</p></div> : <>
      <div className="stats-official-summary" aria-label={t("关键战绩")}>
        {summary.map(([label, value]) => <div className="stats-official-metric" key={label}><span>{label}</span><strong>{displayValue(value)}</strong></div>)}
      </div>
      <p className="stats-official-note">{t("这是账号的官服累计记录，不代表当前档期。Steam 未提供助攻数据，因此不显示 KDA；“—”表示来源未提供，不等于 0。")}</p>
      {!!available.length && <><div className="stats-official-section-heading"><div><h3>{t("详细指标")}</h3><p>{t("按类别查看 Steam 返回的原始统计，已翻译字段名称。")}</p></div><span>{t("{count} 项", {count:(result.fields || []).length})}</span></div>
        <div className="stats-official-tabs" role="tablist" aria-label={t("官服指标分类")}>
          {available.map(category => <button type="button" role="tab" aria-selected={current?.id === category.id} key={category.id} onClick={() => setSelected(category.id)}>{t(category.title)}<small>{grouped.get(category.id).length}</small></button>)}
        </div>
        {current && <section className="stats-official-category" role="tabpanel" aria-label={t(current.title)}>
          <div className="stats-official-category-heading"><h4>{t(current.title)}</h4><span>{t("{count} 项指标", {count:grouped.get(current.id).length})}</span></div>
          <dl className="stats-official-grid">{grouped.get(current.id).map(field => <div className="stats-official-field" key={field.name}><dt>{field.label}</dt><dd>{displayValue(field.value)}</dd></div>)}</dl>
        </section>}
      </>}
    </>}
    </section>
  </>;
}
