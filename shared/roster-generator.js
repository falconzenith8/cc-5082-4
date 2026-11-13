// 种子化角色池生成器：同一种子重建完全相同的 24 人角色池、互斥关系与可视化资源声明。
// 前 16 名是人工策划的基线角色（ID/数值固定，保证历史对局可复现）；
// 后 8 名的数值与全部互斥关系由 Rng 从种子确定性派生。
import { Rng } from './rng.js';

export const ROSTER_SCHEMA = 'arena-roster@2';
export const DEFAULT_ROSTER_SEED = 'arena-draft-2026';

// 角色定位与阵营（引擎/UI 均从这里读取，避免多处写死）
export const ROLES = {
  vanguard: { id: 'vanguard', name: '先锋', short: '锋', color: '#f3a712', required: true },
  support: { id: 'support', name: '支援', short: '援', color: '#3ddc97', required: true },
  duelist: { id: 'duelist', name: '决斗', short: '斗', color: '#ff6b8a', required: false },
  control: { id: 'control', name: '控制', short: '控', color: '#a78bfa', required: false },
};

export const FACTIONS = {
  iron: { id: 'iron', name: '铁盟', color: '#9aa8bf' },
  tide: { id: 'tide', name: '潮汐', color: '#38bdf8' },
  ember: { id: 'ember', name: '焰庭', color: '#fb923c' },
  wild: { id: 'wild', name: '荒野', color: '#a3e635' },
};

export const TEAM_META = {
  A: { id: 'A', name: '苍隼队', color: '#5eb1ff', accent: '#1b4f86' },
  B: { id: 'B', name: '赤隼队', color: '#ff7b72', accent: '#7a2b2b' },
};

// 人工策划的 16 名基线角色：id / 称号 / 定位 / 阵营 / 四维均为源文件数据。
const BASELINE_CHARACTERS = [
  { id: 'iron_bulwark', name: '铁壁·阿格尼斯', role: 'vanguard', faction: 'iron', power: 74, guard: 92, speed: 46, utility: 58 },
  { id: 'iron_edge', name: '锋刃·艾吉', role: 'duelist', faction: 'iron', power: 86, guard: 58, speed: 76, utility: 44 },
  { id: 'iron_forge', name: '锻炉·瓦特', role: 'support', faction: 'iron', power: 58, guard: 64, speed: 52, utility: 88 },
  { id: 'iron_warden', name: '戒律·沃登', role: 'control', faction: 'iron', power: 66, guard: 70, speed: 58, utility: 84 },
  { id: 'tide_bastion', name: '潮障·娜瑞尔', role: 'vanguard', faction: 'tide', power: 70, guard: 86, speed: 54, utility: 66 },
  { id: 'tide_fang', name: '浪牙·赛壬', role: 'duelist', faction: 'tide', power: 82, guard: 54, speed: 88, utility: 50 },
  { id: 'tide_choir', name: '潮歌·露米', role: 'support', faction: 'tide', power: 54, guard: 60, speed: 68, utility: 90 },
  { id: 'tide_mist', name: '雾潮·维恩', role: 'control', faction: 'tide', power: 64, guard: 62, speed: 72, utility: 86 },
  { id: 'ember_ram', name: '熔角·卡恩', role: 'vanguard', faction: 'ember', power: 78, guard: 88, speed: 50, utility: 55 },
  { id: 'ember_step', name: '焰足·希拉', role: 'duelist', faction: 'ember', power: 88, guard: 52, speed: 84, utility: 40 },
  { id: 'ember_hearth', name: '炉心·奥菲', role: 'support', faction: 'ember', power: 60, guard: 58, speed: 56, utility: 92 },
  { id: 'ember_cinder', name: '烬涡·格雷', role: 'control', faction: 'ember', power: 68, guard: 64, speed: 60, utility: 82 },
  { id: 'wild_root', name: '根守·布鲁', role: 'vanguard', faction: 'wild', power: 72, guard: 90, speed: 58, utility: 62 },
  { id: 'wild_shade', name: '藤影·希芙', role: 'duelist', faction: 'wild', power: 84, guard: 56, speed: 82, utility: 48 },
  { id: 'wild_bloom', name: '花语·梅芙', role: 'support', faction: 'wild', power: 56, guard: 62, speed: 64, utility: 94 },
  { id: 'wild_gale', name: '风笞·索恩', role: 'control', faction: 'wild', power: 62, guard: 60, speed: 78, utility: 88 },
];

// 追加 8 人的骨架：阵营与定位人工设计，保证全局每种定位 6 人、每阵营 6 人；
// 称号同样人工策划，数值由种子派生。
const EXTRA_SKELETONS = [
  { id: 'iron_aegis', name: '盾誓·伊欧娜', role: 'vanguard', faction: 'iron' },
  { id: 'iron_quill', name: '墨律·奎尔', role: 'control', faction: 'iron' },
  { id: 'tide_kelp', name: '藻铠·凯尔', role: 'duelist', faction: 'tide' },
  { id: 'tide_anchor', name: '锚心·安珂', role: 'vanguard', faction: 'tide' },
  { id: 'ember_flare', name: '灼言·芙蕾', role: 'support', faction: 'ember' },
  { id: 'ember_coil', name: '焰环·科尔', role: 'duelist', faction: 'ember' },
  { id: 'wild_moss', name: '苔盾·摩斯', role: 'control', faction: 'wild' },
  { id: 'wild_petal', name: '瓣刃·佩塔', role: 'support', faction: 'wild' },
];

const MUTEX_PAIR_COUNT = 8;
const MAX_EDGES_PER_CHARACTER = 2;

function statProfile(role, rng) {
  // 不同定位有不同的数值倾向，rng 只决定小幅波动，保证定位特征不被随机抹平。
  const bias = {
    vanguard: { power: [66, 80], guard: [82, 94], speed: [44, 62], utility: [50, 68] },
    support: { power: [50, 64], guard: [54, 68], speed: [50, 68], utility: [84, 96] },
    duelist: { power: [80, 92], guard: [48, 62], speed: [74, 90], utility: [38, 54] },
    control: { power: [60, 72], guard: [58, 72], speed: [56, 74], utility: [80, 90] },
  }[role];
  const roll = (range) => range[0] + rng.int(0, range[1] - range[0]);
  return {
    power: roll(bias.power),
    guard: roll(bias.guard),
    speed: roll(bias.speed),
    utility: roll(bias.utility),
  };
}

// 互斥关系：两名角色因剧情/机制冲突不能进入同一支队伍的阵容。
// 仅在跨阵营角色间生成，确定性、对称、无重复，每个角色最多 2 条边。
export function generateMutexes(characters, rng) {
  const edges = new Map(characters.map((c) => [c.id, new Set()]));
  const pairKey = (a, b) => [a, b].sort().join('~');
  const used = new Set();
  const pairs = [];
  let attempts = 0;
  while (pairs.length < MUTEX_PAIR_COUNT && attempts < 400) {
    attempts += 1;
    const a = rng.pick(characters);
    const candidates = characters.filter((c) =>
      c.id !== a.id
      && c.faction !== a.faction
      && edges.get(c.id).size < MAX_EDGES_PER_CHARACTER
      && edges.get(a.id).size < MAX_EDGES_PER_CHARACTER
      && !used.has(pairKey(a.id, c.id)));
    if (!candidates.length) continue;
    const b = rng.pick(candidates);
    used.add(pairKey(a.id, b.id));
    edges.get(a.id).add(b.id);
    edges.get(b.id).add(a.id);
    pairs.push({ a: a.id, b: b.id, reason: '剧情对立：同队登场将触发机制冲突' });
  }
  return pairs;
}

export function portraitPath(characterId) {
  return `/assets/portraits/${characterId}.svg`;
}

export function generateRoster(seed = DEFAULT_ROSTER_SEED) {
  const rng = new Rng(seed);
  const characters = BASELINE_CHARACTERS.map((c) => ({ ...c }));
  for (const skeleton of EXTRA_SKELETONS) {
    characters.push({ id: skeleton.id, name: skeleton.name, role: skeleton.role, faction: skeleton.faction, ...statProfile(skeleton.role, rng) });
  }
  for (const character of characters) {
    character.portrait = portraitPath(character.id);
  }
  const mutexes = generateMutexes(characters, rng.fork('mutex'));
  const roster = {
    schema: ROSTER_SCHEMA,
    seed,
    generatedAt: 'deterministic',
    roles: ROLES,
    factions: FACTIONS,
    characters,
    mutexes,
  };
  validateRosterShape(roster);
  return roster;
}

export function mutexMap(mutexes) {
  const map = new Map();
  const add = (a, b) => {
    if (!map.has(a)) map.set(a, new Set());
    map.get(a).add(b);
  };
  for (const pair of mutexes) {
    add(pair.a, pair.b);
    add(pair.b, pair.a);
  }
  return map;
}

export function areMutex(aId, bId, mutexes) {
  return mutexes.some((p) => (p.a === aId && p.b === bId) || (p.a === bId && p.b === aId));
}

// 结构性自检：重复 ID、未知定位/阵营、互斥引用失效都会在这里抛出可定位错误。
export function validateRosterShape(roster) {
  const errors = [];
  const ids = new Set();
  for (const [index, c] of roster.characters.entries()) {
    const where = `characters[${index}](${c.id || 'no-id'})`;
    if (!c.id) errors.push(`${where}: 缺少 id`);
    if (ids.has(c.id)) errors.push(`${where}: 角色 id 重复`);
    ids.add(c.id);
    if (!ROLES[c.role]) errors.push(`${where}: 未知定位 ${c.role}`);
    if (!FACTIONS[c.faction]) errors.push(`${where}: 未知阵营 ${c.faction}`);
    for (const stat of ['power', 'guard', 'speed', 'utility']) {
      if (!Number.isFinite(c[stat])) errors.push(`${where}: 数值 ${stat} 非法`);
    }
    if (!c.portrait) errors.push(`${where}: 缺少可视化资源 portrait`);
  }
  for (const [index, pair] of (roster.mutexes || []).entries()) {
    const where = `mutexes[${index}]`;
    if (!ids.has(pair.a)) errors.push(`${where}: 引用了不存在的角色 ${pair.a}`);
    if (!ids.has(pair.b)) errors.push(`${where}: 引用了不存在的角色 ${pair.b}`);
    if (pair.a === pair.b) errors.push(`${where}: 互斥关系不能指向自身`);
  }
  if (errors.length) {
    const error = new Error(`角色池结构校验失败：\n - ${errors.join('\n - ')}`);
    error.code = 'roster-shape-invalid';
    error.locations = errors;
    throw error;
  }
  return true;
}

export function characterById(id, pool) {
  const list = pool instanceof Map ? [...pool.values()] : pool;
  return list.find((c) => c.id === id) || null;
}

export function getPool(pool) {
  const source = pool || generateRoster().characters;
  return source instanceof Map ? source : new Map(source.map((c) => [c.id, c]));
}

export function roleOf(c) {
  return ROLES[c.role] || ROLES.control;
}

export function factionOf(c) {
  return FACTIONS[c.faction] || FACTIONS.iron;
}
