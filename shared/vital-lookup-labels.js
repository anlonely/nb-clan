// Pure Vital lookup definitions shared by the bundled client and server exports.
export const VITAL_LOOKUP_GROUPS = [
  {
    id: 'player',
    label: { zh: '玩家', en: 'Player' },
    metrics: [
      { label: { zh: 'K/D', en: 'K/D' }, formula: '@combat|kills / @combat|deaths', decimals: 2 },
      { label: { zh: '击杀', en: 'Kills' }, path: 'combat.kills' },
      { label: { zh: 'T3 击杀', en: 'T3 kills' }, path: 'combat.killsT3' },
      { label: { zh: '死亡', en: 'Deaths' }, path: 'combat.deaths' },
      { label: { zh: '爆头', en: 'Headshots' }, path: 'combat.headshots' },
      { label: { zh: '命中', en: 'Hits' }, path: 'combat.hits' },
      { label: { zh: '开枪', en: 'Shots' }, path: 'combat.shots' },
      { label: { zh: '倒地', en: 'Wounds' }, path: 'combat.wounds' },
      { label: { zh: '自杀', en: 'Suicides' }, path: 'combat.suicides' }
    ]
  },
  {
    id: 'raiding',
    label: { zh: '抄家', en: 'Raiding' },
    metrics: [
      { label: { zh: '火箭', en: 'Rockets' }, path: 'raiding.rockets' },
      { label: { zh: '高速火箭', en: 'HV rockets' }, path: 'raiding.rocketsHighVelocity' },
      { label: { zh: '燃烧火箭', en: 'Incendiary rockets' }, path: 'raiding.rocketsIncendiary' },
      { label: { zh: 'C4', en: 'C4' }, path: 'raiding.explosivesTimed' },
      { label: { zh: '炸药包', en: 'Satchels' }, path: 'raiding.explosivesSatchel' },
      { label: { zh: '豆罐', en: 'Beancans' }, path: 'raiding.grenadesBeancan' },
      { label: { zh: '手雷', en: 'F1 grenades' }, path: 'raiding.grenadesF1' },
      { label: { zh: '燃烧瓶', en: 'Molotovs' }, path: 'raiding.grenadesMolotov' },
      { label: { zh: '爆炸子弹', en: 'Explosive ammo' }, path: 'raiding.ammoExplosive' },
      { label: { zh: '40mm HE', en: '40mm HE' }, path: 'raiding.ammoGrenadesHE' },
      { label: { zh: '烟雾榴弹', en: 'Smoke grenades' }, path: 'raiding.ammoGrenadesSmoke' },
      { label: { zh: '闪光弹', en: 'Flashbangs' }, path: 'raiding.grenadesFlashbang' }
    ]
  },
  {
    id: 'pve',
    label: { zh: 'PVE', en: 'PVE' },
    metrics: [
      { label: { zh: '科学家', en: 'Scientists' }, formula: '@pve.killsNPC|scientistnpc_roam_nvg_variant + @pve.killsNPC|scientistnpc_oilrig + @pve.killsNPC|scientistnpc_full_shotgun + @pve.killsNPC|scientistnpc_patrol + @pve.killsNPC|scientistnpc_excavator + @pve.killsNPC|scientistnpc_roam + @pve.killsNPC|scientistnpc_junkpile_pistol + @pve.killsNPC|scientistnpc_roamtethered + @pve.killsNPC|scientistnpc_heavy + @pve.killsNPC|scientistnpc_full_lr300' },
      { label: { zh: '地道科学家', en: 'Tunnel dwellers' }, path: 'pve.killsNPC.npc_tunneldweller' },
      { label: { zh: '水下科学家', en: 'Underwater dwellers' }, path: 'pve.killsNPC.npc_underwaterdweller' },
      { label: { zh: '武直', en: 'Patrol helicopter' }, path: 'pve.killsNPC.patrolhelicopter' },
      { label: { zh: '坦克', en: 'Bradley APC' }, path: 'pve.killsNPC.bradleyapc' },
      { label: { zh: '油井箱', en: 'Rig crates hacked' }, path: 'pve.cratesHackedRig' },
      { label: { zh: '回收废料', en: 'Scrap recycled' }, path: 'pve.scrapRecycled' }
    ]
  },
  {
    id: 'animals',
    label: { zh: '动物', en: 'Animals' },
    metrics: [
      { label: { zh: '狼', en: 'Wolf' }, path: 'pve.killsNPC.wolf' },
      { label: { zh: '熊', en: 'Bear' }, path: 'pve.killsNPC.bear' },
      { label: { zh: '北极熊', en: 'Polar bear' }, path: 'pve.killsNPC.polarbear' },
      { label: { zh: '鹿', en: 'Stag' }, path: 'pve.killsNPC.stag' },
      { label: { zh: '鸡', en: 'Chicken' }, path: 'pve.killsNPC.chicken' },
      { label: { zh: '鳄鱼', en: 'Crocodile' }, path: 'pve.killsNPC.crocodile' }
    ]
  },
  {
    id: 'farming',
    label: { zh: '采集', en: 'Farming' },
    metrics: [
      { label: { zh: '硫磺矿', en: 'Sulfur ore' }, path: 'farming.gathered.sulfur.ore', compact: true },
      { label: { zh: '金属矿', en: 'Metal ore' }, path: 'farming.gathered.metal.ore', compact: true },
      { label: { zh: '高金矿', en: 'HQM ore' }, path: 'farming.gathered.hq.metal.ore', compact: true },
      { label: { zh: '木头', en: 'Wood' }, path: 'farming.gathered.wood', compact: true },
      { label: { zh: '布', en: 'Cloth' }, path: 'farming.gathered.cloth', compact: true },
      { label: { zh: '废料', en: 'Scrap' }, path: 'farming.looted.scrap', compact: true },
      { label: { zh: '蘑菇', en: 'Mushrooms' }, path: 'farming.gathered.mushroom' },
      { label: { zh: '南瓜', en: 'Pumpkins' }, path: 'farming.gathered.pumpkin' },
      { label: { zh: '玉米', en: 'Corn' }, path: 'farming.gathered.corn' },
      { label: { zh: '柴油', en: 'Diesel' }, path: 'farming.gathered.diesel_barrel' },
      { label: { zh: '红莓', en: 'Red berries' }, path: 'farming.gathered.red.berry' },
      { label: { zh: '蓝莓', en: 'Blue berries' }, path: 'farming.gathered.blue.berry' }
    ]
  },
  {
    id: 'gambling',
    label: { zh: '赌博', en: 'Gambling' },
    metrics: [
      { label: { zh: '投注废料', en: 'Scrap wagered' }, formula: '@pve|scrapWheelWagered + @pve|scrapSlotsWagered', compact: true },
      { label: { zh: '赢得废料', en: 'Scrap won' }, formula: '@pve|scrapWheelWon + @pve|scrapSlotsWon', compact: true },
      { label: { zh: '轮盘投注', en: 'Wheel wagered' }, path: 'pve.scrapWheelWagered', compact: true },
      { label: { zh: '老虎机投注', en: 'Slots wagered' }, path: 'pve.scrapSlotsWagered', compact: true },
      { label: { zh: '轮盘赢得', en: 'Wheel won' }, path: 'pve.scrapWheelWon', compact: true },
      { label: { zh: '老虎机赢得', en: 'Slots won' }, path: 'pve.scrapSlotsWon', compact: true }
    ]
  },
  {
    id: 'building',
    label: { zh: '建筑', en: 'Building' },
    metrics: [
      { label: { zh: '墙', en: 'Walls' }, path: 'building.buildings.wall' },
      { label: { zh: '地基', en: 'Foundations' }, path: 'building.buildings.foundation' },
      { label: { zh: '地板', en: 'Floors' }, path: 'building.buildings.floor' },
      { label: { zh: '三角地基', en: 'Triangle foundations' }, path: 'building.buildings.foundation.triangle' },
      { label: { zh: '三角地板', en: 'Triangle floors' }, path: 'building.buildings.floor.triangle' },
      { label: { zh: '门框', en: 'Doorways' }, path: 'building.buildings.wall.doorway' },
      { label: { zh: '窗户', en: 'Windows' }, path: 'building.buildings.wall.window' },
      { label: { zh: '半墙', en: 'Half walls' }, path: 'building.buildings.wall.half' },
      { label: { zh: '矮墙', en: 'Low walls' }, path: 'building.buildings.wall.low' },
      { label: { zh: '屋顶', en: 'Roofs' }, path: 'building.buildings.roof' },
      { label: { zh: '斜坡', en: 'Ramps' }, path: 'building.buildings.ramp' },
      { label: { zh: 'U 型楼梯', en: 'U-shape stairs' }, path: 'building.buildings.block.stair.ushape' }
    ]
  }
];
