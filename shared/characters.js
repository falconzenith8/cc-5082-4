// 兼容门面：角色池不再写死，统一由固定种子的生成器产出。
// 新代码请直接 import { generateRoster } from './roster-generator.js'。
import {
  generateRoster,
  DEFAULT_ROSTER_SEED,
  ROLES,
  FACTIONS,
  TEAM_META,
  characterById,
  getPool,
  roleOf,
  factionOf,
  mutexMap,
  areMutex,
  portraitPath,
} from './roster-generator.js';

const ROSTER = generateRoster(DEFAULT_ROSTER_SEED);

export const ROSTER_SEED = ROSTER.seed;
export const CHARACTER_POOL = ROSTER.characters;
export const MUTEXES = ROSTER.mutexes;
export const ROSTER_MANIFEST = ROSTER;

export {
  ROLES,
  FACTIONS,
  TEAM_META,
  characterById,
  getPool,
  roleOf,
  factionOf,
  mutexMap,
  areMutex,
  portraitPath,
  generateRoster,
  DEFAULT_ROSTER_SEED,
};
