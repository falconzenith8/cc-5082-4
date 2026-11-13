import { mutexMap } from './characters.js';

export const SLOT_DEFINITIONS = {
  vanguard: { id: 'vanguard', label: '先锋位', accepts: ['vanguard'] },
  support: { id: 'support', label: '支援位', accepts: ['support'] },
  flex: { id: 'flex', label: '自由位', accepts: ['duelist', 'control'] },
  flex2: { id: 'flex2', label: '自由位 II', accepts: ['duelist', 'control'] },
};

export const DEFAULT_SLOT_PLAN = ['vanguard', 'support', 'flex'];

export const DEFAULT_RULES = {
  banTurnsPerTeam: 2,
  factionCap: 2,
  minFactions: 2,
  slotPlan: DEFAULT_SLOT_PLAN,
  timers: {
    banMs: 45000,
    secretMs: 60000,
    awayGraceMs: 8000,
  },
};

const FIT_WEIGHTS = {
  vanguard: { guard: 0.55, utility: 0.25, power: 0.12, speed: 0.08 },
  support: { utility: 0.58, guard: 0.18, speed: 0.14, power: 0.10 },
  flex: { power: 0.50, utility: 0.20, speed: 0.18, guard: 0.12 },
};

export function normalizeRules(input = {}) {
  const merged = {
    ...DEFAULT_RULES,
    ...input,
    slotPlan: input.slotPlan || DEFAULT_RULES.slotPlan,
    timers: { ...DEFAULT_RULES.timers, ...(input.timers || {}) },
  };
  const banTurnsPerTeam = Math.max(0, Math.floor(Number(merged.banTurnsPerTeam)));
  const slotPlan = merged.slotPlan.map((slotId) => {
    if (!SLOT_DEFINITIONS[slotId]) throw new Error(`unknown slot: ${slotId}`);
    return slotId;
  });
  const factionCap = Math.max(1, Number(merged.factionCap));
  const minFactions = Math.min(slotPlan.length, Math.max(1, Number(merged.minFactions)));
  for (const slotId of ['vanguard', 'support']) {
    if (!slotPlan.includes(slotId)) throw new Error(`slot plan must include ${slotId}`);
  }
  const asMs = (value, fallback) => (Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : fallback);
  return {
    banTurnsPerTeam,
    factionCap,
    minFactions,
    slotPlan,
    timers: {
      banMs: asMs(merged.timers.banMs, DEFAULT_RULES.timers.banMs),
      secretMs: asMs(merged.timers.secretMs, DEFAULT_RULES.timers.secretMs),
      awayGraceMs: asMs(merged.timers.awayGraceMs, DEFAULT_RULES.timers.awayGraceMs),
    },
  };
}

export function banTurns(rules) {
  const turns = [];
  for (let i = 0; i < rules.banTurnsPerTeam * 2; i += 1) {
    turns.push(i % 2 === 0 ? 'A' : 'B');
  }
  return turns;
}

export function slotAccepts(slotId, role) {
  const slot = SLOT_DEFINITIONS[slotId];
  return Boolean(slot && slot.accepts.includes(role));
}

export function fitScore(character, slotId) {
  const weights = FIT_WEIGHTS[slotId] || FIT_WEIGHTS.flex;
  let score = 0;
  for (const [stat, weight] of Object.entries(weights)) score += (character[stat] || 0) * weight;
  return Math.round(score * 10) / 10;
}

export function threatScore(character) {
  return Math.round((Math.max(character.power, character.utility) * 2 + (character.power + character.utility)) * 0.5);
}

export function countFactions(roster, pool) {
  const counts = {};
  for (const entry of roster) {
    if (!entry.characterId) continue;
    const character = pool.get(entry.characterId);
    if (!character) continue;
    counts[character.faction] = (counts[character.faction] || 0) + 1;
  }
  return counts;
}

export function countFactionsFromIds(characterIds, pool) {
  const counts = {};
  for (const id of characterIds) {
    const character = pool.get(id);
    if (!character) continue;
    counts[character.faction] = (counts[character.faction] || 0) + 1;
  }
  return counts;
}

function isFeasibleRoster({ rosterIds, slotIds, pool, banned, locked, rules, mutexes }) {
  const used = new Set(rosterIds.filter(Boolean));
  const counts = countFactionsFromIds(rosterIds.filter(Boolean), pool);
  const forbidden = mutexes ? mutexMap(mutexes) : null;
  const violatesMutex = (characterId, usedIds) => {
    if (!forbidden || !forbidden.has(characterId)) return false;
    const blocked = forbidden.get(characterId);
    for (const id of usedIds) if (blocked.has(id)) return true;
    return false;
  };
  const candidates = [...pool.values()].filter(
    (c) => !banned.has(c.id) && !(locked && locked.has(c.id)) && !used.has(c.id),
  );
  const dfs = (slots, usedIds, factionCounts) => {
    if (!slots.length) return Object.keys(factionCounts).length >= rules.minFactions;
    const [slotId, ...rest] = slots;
    const sorted = candidates.slice().sort((a, b) => fitScore(b, slotId) - fitScore(a, slotId));
    for (const character of sorted) {
      if (usedIds.has(character.id)) continue;
      if (!slotAccepts(slotId, character.role)) continue;
      if (violatesMutex(character.id, usedIds)) continue;
      const nextCount = (factionCounts[character.faction] || 0) + 1;
      if (nextCount > rules.factionCap) continue;
      if (dfs(rest, new Set(usedIds).add(character.id), { ...factionCounts, [character.faction]: nextCount })) {
        return true;
      }
    }
    return false;
  };
  return dfs(slotIds, used, counts);
}

export function canComplete({ rosterIds, slotIds, pool, banned, locked, rules, mutexes = [] }) {
  if (!slotIds.length) {
    return Object.keys(countFactionsFromIds(rosterIds.filter(Boolean), pool)).length >= rules.minFactions;
  }
  return isFeasibleRoster({ rosterIds, slotIds, pool, banned, locked, rules, mutexes });
}

// 返回与已选角色互斥的角色 id 集合，供引擎/界面禁用候选项。
export function conflictsWith(rosterIds, mutexes) {
  const forbidden = mutexMap(mutexes);
  const out = new Set();
  for (const id of rosterIds) {
    const blocked = forbidden.get(id);
    if (blocked) for (const other of blocked) out.add(other);
  }
  return out;
}

export function defaultBanOrder({ pool, banned, locked }) {
  return [...pool.values()]
    .filter((character) => !banned.has(character.id) && !(locked && locked.has(character.id)))
    .sort((a, b) => {
      const diff = threatScore(b) - threatScore(a);
      return diff !== 0 ? diff : a.id.localeCompare(b.id);
    })
    .map((character) => character.id);
}

export function defaultCandidateOrder({ pool, banned, locked, usedIds, slotId, rules }) {
  const eligible = [...pool.values()]
    .filter((character) => {
      if (banned.has(character.id)) return false;
      if (locked && locked.has(character.id)) return false;
      if (usedIds && usedIds.has(character.id)) return false;
      if (!slotAccepts(slotId, character.role)) return false;
      return true;
    })
    .map((character) => ({ character, score: fitScore(character, slotId) }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.character.power !== a.character.power) return b.character.power - a.character.power;
      return a.character.id.localeCompare(b.character.id);
    });
  void rules;
  return eligible.map((entry) => entry.character.id);
}

export function validateFinalRosters({ pool, banned, locked, rules, mutexes = [] }) {
  const errors = [];
  const rosters = { A: [], B: [] };
  const factions = { A: {}, B: {} };

  for (const team of ['A', 'B']) {
    const roster = rules.slotPlan.map((slotId) => {
      const found = [...locked.entries()].find(([, lock]) => lock.team === team && lock.slotId === slotId);
      return { slotId, characterId: found ? found[0] : null };
    });
    rosters[team] = roster;
    const seenSlots = new Set();
    for (const entry of roster) {
      if (seenSlots.has(entry.slotId)) errors.push({ team, code: 'duplicate-slot', slotId: entry.slotId });
      seenSlots.add(entry.slotId);
      if (!entry.characterId) {
        errors.push({ team, slotId: entry.slotId, code: 'slot-empty', message: `${SLOT_DEFINITIONS[entry.slotId].label}缺少角色` });
        continue;
      }
      const character = pool.get(entry.characterId);
      if (!character) {
        errors.push({ team, slotId: entry.slotId, code: 'unknown-character', characterId: entry.characterId });
        continue;
      }
      if (banned.has(entry.characterId)) {
        errors.push({ team, slotId: entry.slotId, code: 'character-banned', characterId: entry.characterId });
      }
      if (!slotAccepts(entry.slotId, character.role)) {
        errors.push({
          team, slotId: entry.slotId, characterId: entry.characterId, code: 'role-mismatch',
          message: `${character.name} 是 ${character.role}，不符合 ${SLOT_DEFINITIONS[entry.slotId].label}`,
        });
      }
      const lock = locked.get(entry.characterId);
      if (!lock || lock.team !== team) {
        errors.push({ team, slotId: entry.slotId, characterId: entry.characterId, code: 'lock-owner-mismatch' });
      }
      factions[team][character.faction] = (factions[team][character.faction] || 0) + 1;
    }
    for (const slotId of rules.slotPlan) {
      if (!roster.some((entry) => entry.slotId === slotId)) errors.push({ team, code: 'missing-slot', slotId });
    }
    // 同队互斥复核：互斥角色不得同时进入一支队伍的阵容。
    const teamIds = roster.map((entry) => entry.characterId).filter(Boolean);
    for (const pair of mutexes) {
      if (teamIds.includes(pair.a) && teamIds.includes(pair.b)) {
        errors.push({ team, code: 'mutex-conflict', characterId: pair.a, conflictsWith: pair.b, message: `互斥角色 ${pair.a} 与 ${pair.b} 不能同队` });
      }
    }
    for (const [faction, count] of Object.entries(factions[team])) {
      if (count > rules.factionCap) {
        errors.push({ team, code: 'faction-cap-exceeded', faction, count, message: `同阵营 ${count} 名，上限 ${rules.factionCap}` });
      }
    }
    if (Object.keys(factions[team]).length < rules.minFactions) {
      errors.push({
        team, code: 'faction-diversity',
        message: `阵营数量 ${Object.keys(factions[team]).length}，要求至少 ${rules.minFactions}`,
      });
    }
  }

  const allIds = [...rosters.A, ...rosters.B].filter((entry) => entry.characterId).map((entry) => entry.characterId);
  const duplicates = allIds.filter((id, index) => allIds.indexOf(id) !== index);
  for (const characterId of new Set(duplicates)) {
    errors.push({ code: 'cross-team-duplicate', characterId, message: '同一角色被多个阵营锁定' });
  }

  return { ok: errors.length === 0, errors, rosters, factionCounts: factions };
}
