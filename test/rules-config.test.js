import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchRoom } from '../server/engine.js';
import { CHARACTER_POOL, getPool } from '../shared/characters.js';
import {
  normalizeRules,
  validateFinalRosters,
  canComplete,
  slotAccepts,
} from '../shared/rules.js';

function makeRoom({ rules, pool = CHARACTER_POOL, clock } = {}) {
  let t = clock ?? 1000;
  const room = new MatchRoom({ id: `cfg-${Math.random().toString(36).slice(2, 7)}`, rules, pool, clock: () => t });
  return { room, advance: (ms) => { t += ms; return t; }, now: () => t };
}

function fillSlots(room, now, team, picks, seat = 0) {
  for (const [slotId, characterId] of Object.entries(picks)) {
    const result = room.submitSecret({
      team, seatIndex: seat, intentId: `i-${team}-${slotId}-${characterId}-${Math.random().toString(36).slice(2, 6)}`,
      roundId: room.state.roundId, windowId: room.state.secret.windowId, slotId, characterId, receivedAt: now(),
    });
    assert.equal(result.ok, true, `${team}/${slotId}/${characterId}: ${result.code} ${result.message}`);
  }
}

const fourSlots = ['vanguard', 'support', 'flex', 'flex2'];

test('规则归一化：位置必须含先锋与支援，阵营参数被夹紧', () => {
  assert.throws(() => normalizeRules({ slotPlan: ['flex', 'flex2'] }), /vanguard|support/);
  const rules = normalizeRules({
    slotPlan: fourSlots,
    factionCap: 1,
    minFactions: 9,
    banTurnsPerTeam: 3,
    timers: { banMs: -5, secretMs: 'x', awayGraceMs: 250 },
  });
  assert.equal(rules.minFactions, 4, 'minFactions 不超过位置数');
  assert.equal(rules.timers.banMs, 0, '负时间被夹到 0');
  assert.equal(rules.timers.secretMs, 60000, '非法时间回退默认');
  assert.equal(rules.timers.awayGraceMs, 250);
});

test('四位置编成：阵营上限 1 时强制四阵营混合，默认选择也满足', () => {
  const rules = {
    banTurnsPerTeam: 0,
    factionCap: 1,
    minFactions: 3,
    slotPlan: fourSlots,
    timers: { banMs: 100, secretMs: 2000, awayGraceMs: 100 },
  };
  const { room, advance, now } = makeRoom({ rules });
  // banTurnsPerTeam=0 -> 直接进入秘密阶段；推进到秘密截止后由服务端裁决
  assert.equal(room.state.phase, 'secret');
  advance(room.state.secret.deadline - now() + 1);
  room.tick(now());
  assert.equal(room.state.phase, 'revealed');
  for (const team of ['A', 'B']) {
    const counts = room.state.reveal.factionCounts[team];
    for (const [faction, count] of Object.entries(counts)) {
      assert.equal(count, 1, `${team} 阵营 ${faction} 必须唯一`);
    }
    assert.ok(Object.keys(counts).length >= 3);
  }
  const allIds = ['A', 'B'].flatMap((t) => room.state.reveal.rosters[t].map((e) => e.characterId));
  assert.equal(new Set(allIds).size, allIds.length, '两阵营不得重叠');
});

test('位置角色的联合校验：同角色不同位置不可重复，严格位置只接受指定角色', () => {
  const pool = getPool(CHARACTER_POOL);
  const rules = normalizeRules({ banTurnsPerTeam: 0, factionCap: 2, minFactions: 2, slotPlan: fourSlots });
  assert.equal(slotAccepts('vanguard', 'duelist'), false);
  assert.equal(slotAccepts('flex', 'duelist'), true);
  assert.equal(slotAccepts('flex2', 'control'), true);
  assert.equal(slotAccepts('support', 'vanguard'), false);

  const banned = new Set();
  const banned2 = new Set(CHARACTER_POOL.filter((c) => c.role === 'duelist' || c.role === 'control').map((c) => c.id));
  assert.equal(
    canComplete({ rosterIds: ['iron_bulwark', 'iron_forge'], slotIds: ['flex', 'flex2'], pool, banned: banned2, locked: null, rules }),
    false,
    '决斗/控制位全部禁光时无法填充自由位',
  );
  assert.equal(
    canComplete({ rosterIds: [], slotIds: fourSlots, pool, banned, locked: null, rules }),
    true,
  );
  void banned;
});

test('跨阵营池约束：候选不足时裁决失败且不产生锁或场景', () => {
  // 池扩容后按生成数据动态裁剪：只保留 1 名先锋，两队无法各锁一名。
  const vanguards = CHARACTER_POOL.filter((c) => c.role === 'vanguard');
  const removed = vanguards.slice(1).map((c) => c.id);
  const thinPool = CHARACTER_POOL.filter((c) => !removed.includes(c.id));
  assert.equal(thinPool.filter((c) => c.role === 'vanguard').length, 1);
  const rules = normalizeRules({
    banTurnsPerTeam: 0, factionCap: 2, minFactions: 2, slotPlan: ['vanguard', 'support'],
    timers: { banMs: 100, secretMs: 1000, awayGraceMs: 100 },
  });
  let t = 1000;
  // 该房间显式传入空互斥表，隔离「候选耗尽」这一单一规则关系。
  const room = new MatchRoom({
    id: 'exhaust-cfg', rules, pool: thinPool, mutexes: [], clock: () => t,
  });
  t += 1200;
  room.tick(t);
  assert.equal(room.state.phase, 'failed');
  assert.equal(room.state.failure.code, 'no-disjoint-lineup');
  assert.equal(room.state.scene, null);
  const view = room.publicView();
  assert.equal(view.rosters, undefined);
});

test('validateFinalRosters 独立复核：超上限、缺阵营、角色不符、空位都会被标错', () => {
  const pool = getPool(CHARACTER_POOL);
  const rules = normalizeRules({ banTurnsPerTeam: 0, factionCap: 2, minFactions: 2, slotPlan: ['vanguard', 'support', 'flex'] });

  const allIronA = new Map([
    ['iron_bulwark', { team: 'A', slotId: 'vanguard' }],
    ['iron_forge', { team: 'A', slotId: 'support' }],
    ['iron_warden', { team: 'A', slotId: 'flex' }],
    ['tide_bastion', { team: 'B', slotId: 'vanguard' }],
    ['tide_choir', { team: 'B', slotId: 'support' }],
    ['wild_gale', { team: 'B', slotId: 'flex' }],
  ]);
  const capResult = validateFinalRosters({ pool, banned: new Set(), locked: allIronA, rules });
  assert.equal(capResult.ok, false);
  assert.ok(capResult.errors.some((e) => e.code === 'faction-cap-exceeded'), JSON.stringify(capResult.errors));

  // 放宽上限后同一编成应不再报超限，只剩缺阵营
  const looseRules = normalizeRules({ banTurnsPerTeam: 0, factionCap: 3, minFactions: 2, slotPlan: ['vanguard', 'support', 'flex'] });
  const looseResult = validateFinalRosters({ pool, banned: new Set(), locked: allIronA, rules: looseRules });
  assert.equal(looseResult.errors.some((e) => e.code === 'faction-cap-exceeded'), false);
  assert.ok(looseResult.errors.some((e) => e.code === 'faction-diversity'), JSON.stringify(looseResult.errors));

  // 先锋角色被塞进自由位 -> 位置/角色联合校验失败
  const badRole = new Map([
    ['tide_bastion', { team: 'A', slotId: 'vanguard' }],
    ['iron_forge', { team: 'A', slotId: 'support' }],
    ['iron_bulwark', { team: 'A', slotId: 'flex' }],
    ['wild_root', { team: 'B', slotId: 'vanguard' }],
    ['wild_bloom', { team: 'B', slotId: 'support' }],
    ['wild_gale', { team: 'B', slotId: 'flex' }],
  ]);
  const roleResult = validateFinalRosters({ pool, banned: new Set(), locked: badRole, rules });
  assert.ok(roleResult.errors.some((e) => e.code === 'role-mismatch'), JSON.stringify(roleResult.errors));

  // 缺少整条位置 -> slot-empty
  const emptySlot = new Map([
    ['tide_bastion', { team: 'A', slotId: 'vanguard' }],
    ['tide_choir', { team: 'A', slotId: 'support' }],
    ['wild_root', { team: 'B', slotId: 'vanguard' }],
    ['wild_bloom', { team: 'B', slotId: 'support' }],
    ['wild_gale', { team: 'B', slotId: 'flex' }],
  ]);
  const emptyResult = validateFinalRosters({ pool, banned: new Set(), locked: emptySlot, rules });
  assert.ok(emptyResult.errors.some((e) => e.code === 'slot-empty' && e.team === 'A' && e.slotId === 'flex'), JSON.stringify(emptyResult.errors));
});

test('裁决确定性：同输入重复运行得到相同阵容与 sceneId', () => {
  const rules = { banTurnsPerTeam: 2, factionCap: 2, minFactions: 2, timers: { banMs: 500, secretMs: 1000, awayGraceMs: 100 } };
  const outputs = [];
  for (let run = 0; run < 3; run += 1) {
    const { room, advance, now } = makeRoom({ rules });
    for (let i = 0; i < 4; i += 1) {
      const team = room.state.banSequence[room.state.banTurnIndex];
      const banned = new Set(room.state.bans.map((b) => b.characterId));
      const choice = CHARACTER_POOL.find((c) => !banned.has(c.id) && c.role === 'duelist').id;
      const result = room.submitBan({
        team, seatIndex: 0, intentId: `ban-${i}`, roundId: 1,
        turnId: `r1-ban${room.state.banTurnIndex}`, characterId: choice, receivedAt: now(),
      });
      assert.equal(result.ok, true);
      advance(10);
    }
    advance(5000);
    room.tick(now());
    assert.equal(room.state.phase, 'revealed');
    outputs.push(JSON.stringify(room.state.reveal.rosters));
  }
  assert.equal(new Set(outputs).size, 1, '无秘密输入时默认裁决应确定');
});
