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

export const CHARACTER_POOL = [
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

export function characterById(id, pool = CHARACTER_POOL) {
  return (pool instanceof Map ? [...pool.values()] : pool).find((c) => c.id === id) || null;
}

export function getPool(pool) {
  const source = pool || CHARACTER_POOL;
  return source instanceof Map ? source : new Map(source.map((c) => [c.id, c]));
}

export function roleOf(c) {
  return ROLES[c.role] || ROLES.control;
}

export function factionOf(c) {
  return FACTIONS[c.faction] || FACTIONS.iron;
}
