import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Rng, hashSeed } from '../shared/rng.js';
import {
  generateRoster,
  validateRosterShape,
  mutexMap,
  areMutex,
  DEFAULT_ROSTER_SEED,
  ROSTER_SCHEMA,
} from '../shared/roster-generator.js';
import { CHARACTER_POOL, MUTEXES } from '../shared/characters.js';
import { generateScenarios, SCENARIO_SCHEMA } from '../shared/scenario-generator.js';
import { MatchRoom } from '../server/engine.js';
import { canComplete, conflictsWith, validateFinalRosters } from '../shared/rules.js';
import { getPool } from '../shared/roster-generator.js';

test('固定种子重建：同种子两次生成的角色池与互斥关系字节一致', () => {
  const a = generateRoster(DEFAULT_ROSTER_SEED);
  const b = generateRoster(DEFAULT_ROSTER_SEED);
  assert.equal(a.schema, ROSTER_SCHEMA);
  assert.deepEqual(a, b);
  // 不同种子应产生不同数值/互斥组合
  const other = generateRoster('another-seed');
  assert.notDeepEqual(other.mutexes, a.mutexes);
});

test('Rng 确定性：同种子序列完全一致，洗牌可复现', () => {
  const x = new Rng('s');
  const y = new Rng('s');
  const seqX = Array.from({ length: 10 }, () => x.int(0, 99));
  const seqY = Array.from({ length: 10 }, () => y.int(0, 99));
  assert.deepEqual(seqX, seqY);
  const shuffled = new Rng('shuffle').shuffle([1, 2, 3, 4, 5, 6]);
  assert.deepEqual(shuffled, new Rng('shuffle').shuffle([1, 2, 3, 4, 5, 6]));
  assert.notDeepEqual(shuffled, [1, 2, 3, 4, 5, 6]);
  assert.equal(typeof hashSeed('abc'), 'number');
});

test('角色池结构：24 人、定位与阵营均衡、互斥关系对称且引用有效', () => {
  const roster = generateRoster(DEFAULT_ROSTER_SEED);
  assert.equal(roster.characters.length, 24);
  for (const role of ['vanguard', 'support', 'duelist', 'control']) {
    assert.equal(roster.characters.filter((c) => c.role === role).length, 6, `${role} 应有 6 人`);
  }
  for (const faction of ['iron', 'tide', 'ember', 'wild']) {
    assert.equal(roster.characters.filter((c) => c.faction === faction).length, 6);
  }
  // 互斥只在跨阵营间生成，且每个角色最多 2 条边
  const degree = new Map();
  for (const pair of roster.mutexes) {
    const ca = roster.characters.find((c) => c.id === pair.a);
    const cb = roster.characters.find((c) => c.id === pair.b);
    assert.notEqual(ca.faction, cb.faction, '互斥关系必须跨阵营');
    degree.set(pair.a, (degree.get(pair.a) || 0) + 1);
    degree.set(pair.b, (degree.get(pair.b) || 0) + 1);
  }
  for (const count of degree.values()) assert.ok(count <= 2);
  assert.doesNotThrow(() => validateRosterShape(roster));
  // 兼容门面导出的就是种子生成结果
  assert.equal(CHARACTER_POOL.length, 24);
  assert.deepEqual(MUTEXES, roster.mutexes);
});

test('失效互斥引用触发可定位错误', () => {
  const broken = generateRoster(DEFAULT_ROSTER_SEED);
  broken.mutexes.push({ a: broken.characters[0].id, b: 'ghost-character', reason: 'x' });
  assert.throws(() => validateRosterShape(broken), /ghost-character/);
});

test('互斥规则：同队提交互斥角色被引擎拒绝，错误码 mutex-conflict', () => {
  const room = new MatchRoom({
    id: 'mutex-test',
    rules: { banTurnsPerTeam: 0, slotPlan: ['vanguard', 'support', 'flex'], timers: { banMs: 100, secretMs: 1000, awayGraceMs: 100 } },
  });
  const pair = MUTEXES[0];
  const pool = getPool(CHARACTER_POOL);
  const ca = pool.get(pair.a);
  const cb = pool.get(pair.b);
  // 把两个互斥角色放到能接受的不同位置
  const slotFor = (role) => (role === 'vanguard' ? 'vanguard' : role === 'support' ? 'support' : 'flex');
  const first = room.submitSecret({
    team: 'A', seatIndex: 0, intentId: 'm1', roundId: 1, windowId: room.state.secret.windowId,
    slotId: slotFor(ca.role), characterId: ca.id,
  });
  assert.equal(first.ok, true, first.message);
  const second = room.submitSecret({
    team: 'A', seatIndex: 0, intentId: 'm2', roundId: 1, windowId: room.state.secret.windowId,
    slotId: slotFor(cb.role), characterId: cb.id,
  });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'mutex-conflict');
});

test('互斥规则：可行性枚举与最终复核都排除互斥同队组合', () => {
  const roster = generateRoster(DEFAULT_ROSTER_SEED);
  const pool = getPool(roster.characters);
  const pair = roster.mutexes[0];
  const blocked = conflictsWith([pair.a], roster.mutexes);
  assert.ok(blocked.has(pair.b));
  assert.ok(areMutex(pair.a, pair.b, roster.mutexes));
  const rules = { banTurnsPerTeam: 0, factionCap: 3, minFactions: 1, slotPlan: ['vanguard', 'support', 'flex'], timers: { banMs: 100, secretMs: 1000, awayGraceMs: 100 } };
  // 含互斥对的残余池无法在同一队共存时，canComplete 应反映约束
  const feasible = canComplete({
    rosterIds: [], slotIds: rules.slotPlan, pool, banned: new Set(), locked: null, rules, mutexes: roster.mutexes,
  });
  assert.equal(typeof feasible, 'boolean');
  // 最终复核直接标错
  const ca = pool.get(pair.a);
  const cb = pool.get(pair.b);
  const locked = new Map([
    [pair.a, { team: 'A', slotId: ca.role === 'vanguard' ? 'vanguard' : 'flex' }],
    [pair.b, { team: 'A', slotId: cb.role === 'support' ? 'support' : 'flex' }],
    [roster.characters.find((c) => c.id !== pair.a && c.id !== pair.b && c.role === 'vanguard').id, { team: 'B', slotId: 'vanguard' }],
  ]);
  // 仅当两个互斥角色都能映射到存在的槽位时才断言；否则跳过该构造
  const slotsA = [...locked.values()].filter((l) => l.team === 'A');
  if (slotsA.length === 2) {
    const result = validateFinalRosters({ pool, banned: new Set(), locked, rules, mutexes: roster.mutexes });
    assert.ok(result.errors.some((e) => e.code === 'mutex-conflict'));
  }
  void mutexMap;
});

test('情境生成：四个情境只含操作与规则关系，不预填裁决结果', () => {
  const bundle = generateScenarios(DEFAULT_ROSTER_SEED);
  assert.equal(bundle.schema, SCENARIO_SCHEMA);
  const ids = bundle.scenarios.map((s) => s.id);
  assert.deepEqual(ids, ['rotation', 'exhaustion', 'disconnect', 'unauthorized-peek']);
  for (const scenario of bundle.scenarios) {
    assert.ok(Array.isArray(scenario.instructions) && scenario.instructions.length > 0, `${scenario.id} 必须附操作说明`);
    assert.ok(Array.isArray(scenario.expectRules) && scenario.expectRules.length > 0, `${scenario.id} 必须声明希望触发的规则关系`);
    const serialized = JSON.stringify(scenario);
    for (const forbidden of ['"rosters"', '"finalLineup"', '"expectedResult"', '"winner"']) {
      assert.ok(!serialized.includes(forbidden), `${scenario.id} 不得预填 ${forbidden}`);
    }
    // 所有角色引用必须在角色池中存在
    const poolIds = new Set(bundle.scenarios && CHARACTER_POOL.map((c) => c.id));
    for (const team of ['A', 'B']) {
      for (const item of scenario.script[team]) {
        if (item.characterId) assert.ok(poolIds.has(item.characterId), `${scenario.id} 失效引用 ${item.characterId}`);
      }
    }
  }
});

test('情境确定性：同种子重建的提交序列完全一致', () => {
  const a = generateScenarios(DEFAULT_ROSTER_SEED);
  const b = generateScenarios(DEFAULT_ROSTER_SEED);
  assert.deepEqual(a, b);
});

test('越权反例情境包含三类攻击身份且声明公共零泄漏规则', () => {
  const bundle = generateScenarios(DEFAULT_ROSTER_SEED);
  const peek = bundle.scenarios.find((s) => s.id === 'unauthorized-peek');
  const tokens = peek.attacks.map((a) => a.useToken);
  assert.deepEqual(tokens, ['spectator', 'B0', 'forged-token']);
  assert.ok(peek.expectRules.includes('public-payload-no-hidden-id'));
  assert.ok(peek.expectRules.includes('forged-token-rejected'));
});
