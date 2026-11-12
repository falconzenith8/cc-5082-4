import { FACTIONS, ROLES, TEAM_META } from './characters.js';
import { SLOT_DEFINITIONS } from './rules.js';

export const SCENE_SCHEMA = 'arena-match-scene@1';

const ARENA = {
  width: 1200,
  height: 720,
  spawns: {
    A: [{ x: 190, y: 220 }, { x: 190, y: 360 }, { x: 190, y: 500 }],
    B: [{ x: 1010, y: 220 }, { x: 1010, y: 360 }, { x: 1010, y: 500 }],
  },
  objectives: [
    { id: 'relay', name: '中继核心', x: 600, y: 360, radius: 90 },
  ],
};

function stableNumber(seed, salt = '') {
  let hash = 2166136261;
  const input = `${seed}:${salt}`;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

function seatLayout(team, roster) {
  return roster.map((entry, index) => ({
    slotId: entry.slotId,
    index,
    spawn: ARENA.spawns[team][index] || { x: team === 'A' ? 160 : 1040, y: 300 + index * 120 },
  }));
}

export function createMatchScene({
  matchId,
  roundId,
  rules,
  bans,
  rosters,
  factionCounts,
  initiative,
  pool,
  meta = {},
  createdAt = Date.now(),
  revealReason = 'deadline',
  overrides = [],
  contested = [],
}) {
  const seed = `${matchId}:r${roundId}`;
  const teams = {};
  for (const team of ['A', 'B']) {
    const units = rosters[team].map((entry, index) => {
      const character = pool.get(entry.characterId);
      if (!character) throw new Error(`scene build failed: missing character ${entry.characterId}`);
      return {
        unitId: `${team}-${index + 1}`,
        slotId: entry.slotId,
        slotLabel: SLOT_DEFINITIONS[entry.slotId].label,
        seat: seatLayout(team, rosters[team])[index],
        character: {
          id: character.id,
          name: character.name,
          role: character.role,
          roleName: ROLES[character.role].name,
          faction: character.faction,
          factionName: FACTIONS[character.faction].name,
          power: character.power,
          guard: character.guard,
          speed: character.speed,
          utility: character.utility,
        },
      };
    });
    teams[team] = {
      id: team,
      name: TEAM_META[team].name,
      color: TEAM_META[team].color,
      accent: TEAM_META[team].accent,
      hasInitiative: initiative === team,
      factionCounts: factionCounts[team],
      units,
    };
  }

  return {
    schema: SCENE_SCHEMA,
    sceneId: `${matchId}-r${roundId}-${revealReason}`,
    matchId,
    roundId,
    seed,
    createdAt,
    revealReason,
    rules: {
      factionCap: rules.factionCap,
      minFactions: rules.minFactions,
      slotPlan: rules.slotPlan.slice(),
    },
    meta,
    arena: {
      id: 'relay-arena',
      width: ARENA.width,
      height: ARENA.height,
      objectives: ARENA.objectives.map((objective, index) => ({
        ...objective,
        activationAt: 0.35 + stableNumber(seed, `objective-${index}`) * 0.2,
      })),
      hazards: [
        { id: 'vent-a', x: 380, y: 150, intervalMs: 9000 + Math.round(stableNumber(seed, 'vent-a') * 3000) },
        { id: 'vent-b', x: 820, y: 570, intervalMs: 9000 + Math.round(stableNumber(seed, 'vent-b') * 3000) },
      ],
    },
    teams,
    bans: bans.map((entry) => ({ team: entry.team, characterId: entry.characterId, auto: Boolean(entry.auto) })),
    contested,
    overrides,
  };
}
