import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MatchRoom } from '../server/engine.js';
import { CHARACTER_POOL } from '../shared/characters.js';
import { DEFAULT_RULES } from '../shared/rules.js';
import { validateScene } from '../public/js/scene-loader.js';

const baseRules = {
  banTurnsPerTeam: 0,
  factionCap: 2,
  minFactions: 2,
  slotPlan: ['vanguard', 'support', 'flex'],
  timers: { banMs: 1000, secretMs: 1000, awayGraceMs: 500 },
};

function makeRoom(rules = baseRules, clockStart = 1000) {
  const clockRef = { t: clockStart };
  const room = new MatchRoom({ id: `test-${Math.random().toString(36).slice(2, 7)}`, rules, clock: () => clockRef.t });
  room.on('error', () => {});
  return { room, clockRef };
}

function submit(room, clockRef, payload) {
  return room.submitSecret({ ...payload, receivedAt: clockRef.t });
}

function fillTeam(room, clockRef, team, slots, seat = 0) {
  for (const [slotId, characterId] of Object.entries(slots)) {
    const result = submit(room, clockRef, {
      team, seatIndex: seat,
      intentId: `${team}-${slotId}-${characterId}-${Math.random().toString(36).slice(2, 7)}`,
      roundId: room.state.roundId,
      windowId: room.state.secret.windowId,
      slotId,
      characterId,
    });
    assert.equal(result.ok, true, `${team}/${slotId}/${characterId}: ${result.code} ${result.message}`);
  }
}

test('候选耗尽：支援位候选被禁光后裁决失败且不生成锁', () => {
  const { room, clockRef } = makeRoom({ ...baseRules, banTurnsPerTeam: 0 });
  // 直接在秘密阶段前禁掉所有支援角色：通过重开房间时先手动写入 bans 更直观——
  // 这里用 3 队可完成的最小池构造耗尽：把支援位角色从池中移除。
  const slimPool = CHARACTER_POOL.filter((c) => c.role !== 'support');
  const room2 = new MatchRoom({
    id: 'exhaust',
    rules: { ...baseRules, timers: { banMs: 100, secretMs: 100, awayGraceMs: 50 } },
    pool: slimPool,
    clock: () => clockRef.t,
  });
  clockRef.t = room2.state.secret.deadline;
  room2.tick(clockRef.t);
  if (room2.state.phase === 'failed') {
    assert.equal(room2.state.failure.code, 'candidate-exhausted');
    assert.deepEqual(room2.state.failure.diagnostics.lineupOptions, { A: 0, B: 0 });
  } else {
    // 若池仍可完成则不应失败，但这说明测试前提不成立
    assert.fail('support 缺失时不允许完成阵容');
  }
  void room;
});

test('队内冲突：截止前改选由最新意图胜出，且另一座位可覆盖旧意图', () => {
  const { room, clockRef } = makeRoom();
  clockRef.t += 1;
  const first = submit(room, clockRef, {
    team: 'A', seatIndex: 0, intentId: 'i1', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'vanguard', characterId: 'iron_bulwark',
  });
  assert.equal(first.ok, true);

  clockRef.t += 1;
  const conflict = submit(room, clockRef, {
    team: 'A', seatIndex: 1, intentId: 'i2', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'vanguard', characterId: 'tide_bastion',
  });
  assert.equal(conflict.ok, true, '不同座位同位置不同角色应被接受但记录冲突');

  const effectives = room.teamEffectives('A');
  assert.equal(effectives.vanguard.characterId, 'tide_bastion', '较晚提交者胜出');
  assert.equal(room.state.secret.teams.A.conflicts.length, 1);

  clockRef.t += 1;
  const revise = submit(room, clockRef, {
    team: 'A', seatIndex: 0, intentId: 'i3', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'vanguard', characterId: 'ember_ram',
  });
  assert.equal(revise.ok, true, '截止前的改选应被接受');
  assert.equal(room.teamEffectives('A').vanguard.characterId, 'ember_ram');
  assert.equal(revise.revision, true);
});

test('队内重复：同队两个阵容位不能选同一角色', () => {
  const { room, clockRef } = makeRoom({ ...baseRules, slotPlan: ['vanguard', 'support', 'flex', 'flex2'] });
  clockRef.t += 1;
  const one = submit(room, clockRef, {
    team: 'A', seatIndex: 0, intentId: 'd1', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'flex', characterId: 'iron_edge',
  });
  assert.equal(one.ok, true, `${one.code} ${one.message}`);
  clockRef.t += 1;
  const sameSeat = submit(room, clockRef, {
    team: 'A', seatIndex: 0, intentId: 'd2', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'flex2', characterId: 'iron_edge',
  });
  assert.equal(sameSeat.ok, false);
  assert.equal(sameSeat.code, 'team-internal-conflict');
  const otherSeat = submit(room, clockRef, {
    team: 'A', seatIndex: 1, intentId: 'd3', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'flex2', characterId: 'iron_edge',
  });
  assert.equal(otherSeat.ok, false);
  assert.equal(otherSeat.code, 'team-internal-conflict');
});

test('超时默认选择：两队在期限后由默认策略补足且通过全部约束', () => {
  const { room, clockRef } = makeRoom({ ...baseRules, timers: { banMs: 100, secretMs: 2000, awayGraceMs: 100 } });
  clockRef.t += 1;
  fillTeam(room, clockRef, 'A', { support: 'iron_forge' });
  // B 完全不提交，全部走默认
  clockRef.t = room.state.secret.deadline;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'revealed');
  const reveal = room.state.reveal;
  assert.deepEqual(reveal.defaultsUsed.A.concat(reveal.defaultsUsed.B).length, 5);
  assert.equal(reveal.defaultsUsed.A.length, 2);
  assert.equal(reveal.defaultsUsed.B.length, 3);
  const view = room.publicView();
  for (const team of ['A', 'B']) {
    const counts = view.factionCounts[team];
    assert.ok(Object.keys(counts).length >= 2, `${team} 阵营多样性`);
    for (const [faction, count] of Object.entries(counts)) {
      assert.ok(count <= 2, `${team}/${faction} 阵营上限`);
    }
  }
  assert.ok(validateScene(room.state.scene).ok);
});

test('默认禁用不破坏池可行性：四次默认禁用后两队仍能各取支援并生成场景', () => {
  const { room, clockRef } = makeRoom({
    ...baseRules,
    banTurnsPerTeam: 2,
    timers: { banMs: 100, secretMs: 1000, awayGraceMs: 100 },
  });
  // 不提交任何禁用，逐个推进到每个禁用回合的截止，全部由默认策略处理。
  for (let i = 0; i < 4; i += 1) {
    assert.equal(room.state.phase, 'ban');
    clockRef.t = room.effectiveBanDeadline();
    room.tick(clockRef.t);
  }
  assert.equal(room.state.phase, 'secret');
  assert.equal(room.state.bans.length, 4);
  assert.ok(room.state.bans.every((b) => b.auto), '四次禁用都应为默认策略');
  // 默认禁用必须给两队各自留下可用的支援/先锋，而不是把某个必需位置禁到只剩一人。
  clockRef.t = room.state.secret.deadline;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'revealed', JSON.stringify(room.state.failure));
  const allIds = ['A', 'B'].flatMap((team) => room.state.reveal.rosters[team].map((e) => e.characterId));
  for (const team of ['A', 'B']) {
    assert.ok(room.state.reveal.rosters[team].find((e) => e.slotId === 'support'), `${team} 必须有支援位`);
  }
  assert.equal(new Set(allIds).size, 6, '六名角色互不重复');
  assert.ok(validateScene(room.state.scene).ok);
});

test('迟到旧轮次：上一轮的意图在下一轮开始后被拒绝', () => {
  const { room, clockRef } = makeRoom();
  clockRef.t = room.state.secret.deadline;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'revealed');
  const oldRoundId = room.state.roundId;
  const oldWindow = room.state.secret.windowId;
  const next = room.nextRound(clockRef.t + 10);
  assert.equal(next.ok, true);
  const stale = room.submitSecret({
    team: 'A', seatIndex: 0, intentId: 'late-1', roundId: oldRoundId, windowId: oldWindow,
    slotId: 'vanguard', characterId: 'iron_bulwark', receivedAt: clockRef.t + 20,
  });
  assert.equal(stale.ok, false);
  assert.match(stale.code, /phase-closed|stale-round/);
});

test('迟到旧禁用回合：同一截止瞬间后的旧 turnId 被拒绝', () => {
  const rules = { ...baseRules, banTurnsPerTeam: 1, timers: { banMs: 1000, secretMs: 1000, awayGraceMs: 500 } };
  const { room, clockRef } = makeRoom(rules);
  clockRef.t += 1;
  const ok = room.submitBan({
    team: 'A', seatIndex: 0, intentId: 'b1', roundId: 1, turnId: 'r1-ban0',
    characterId: 'ember_step', receivedAt: clockRef.t,
  });
  assert.equal(ok.ok, true);
  clockRef.t += 1;
  const stale = room.submitBan({
    team: 'B', seatIndex: 0, intentId: 'b2', roundId: 1, turnId: 'r1-ban0',
    characterId: 'tide_fang', receivedAt: clockRef.t,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'stale-turn');
});

test('重复提交：同一 intentId 第二次被忽略', () => {
  const { room, clockRef } = makeRoom();
  clockRef.t += 1;
  const payload = {
    team: 'A', seatIndex: 0, intentId: 'dup-1', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'support', characterId: 'iron_forge',
  };
  const first = submit(room, clockRef, payload);
  assert.equal(first.ok, true);
  const second = submit(room, clockRef, payload);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'duplicate-intent');
});

test('玩家暂离：暂离座位提交被拒，双方全离线超过宽限后触发默认裁决', () => {
  const { room, clockRef } = makeRoom({ ...baseRules, timers: { banMs: 4000, secretMs: 4000, awayGraceMs: 800 } });
  room.setPresence('A', 0, false, clockRef.t);
  room.setPresence('A', 1, false, clockRef.t);
  room.setPresence('B', 0, false, clockRef.t);
  room.setPresence('B', 1, false, clockRef.t);
  const rejected = submit(room, clockRef, {
    team: 'A', seatIndex: 0, intentId: 'away-1', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'vanguard', characterId: 'iron_bulwark',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.code, 'seat-away');
  clockRef.t += 900;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'revealed', '双方全离线超过宽限后应由服务端裁决');
  assert.equal(room.state.reveal.reason, 'both-teams-away');
});

test('秘密视图隔离：旁观者与敌方视图都不包含对方候选', () => {
  const { room, clockRef } = makeRoom();
  clockRef.t += 1;
  submit(room, clockRef, {
    team: 'A', seatIndex: 0, intentId: 'p1', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'vanguard', characterId: 'iron_bulwark',
  });
  const publicView = room.publicView(clockRef.t);
  assert.equal(publicView.secret.own, undefined);
  assert.equal(publicView.secret.opponent, undefined);
  const serialized = JSON.stringify(publicView);
  assert.ok(!serialized.includes('iron_bulwark'), '旁观视图不得包含已提交候选角色');

  const bView = room.teamView('B', 0, clockRef.t);
  const bSerialized = JSON.stringify(bView);
  assert.ok(!bSerialized.includes('iron_bulwark'), 'B 队视图不得包含 A 队的秘密候选');
  assert.equal(bView.secret.opponent.slotsSubmitted, 1);

  const aView = room.teamView('A', 0, clockRef.t);
  assert.equal(aView.secret.own.picks.vanguard.characterId, 'iron_bulwark');
});

test('全局唯一锁：两队都想争抢同一角色时，只有一队得到，另一队回退且约束仍成立', () => {
  const { room, clockRef } = makeRoom();
  clockRef.t += 1;
  // 双方都想要 vanguard 同一角色
  const a = submit(room, clockRef, {
    team: 'A', seatIndex: 0, intentId: 'x1', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'vanguard', characterId: 'iron_bulwark',
  });
  assert.equal(a.ok, true);
  const b = submit(room, clockRef, {
    team: 'B', seatIndex: 0, intentId: 'x2', roundId: 1, windowId: room.state.secret.windowId,
    slotId: 'vanguard', characterId: 'iron_bulwark',
  });
  assert.equal(b.ok, true, '跨队秘密不互斥，裁决时再解冲突');
  clockRef.t = room.state.secret.deadline;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'revealed');
  const view = room.publicView();
  const ids = [...view.rosters.A, ...view.rosters.B].map((e) => e.characterId);
  assert.equal(ids.filter((id) => id === 'iron_bulwark').length, 1, '同一角色只能被一队锁定');
  const reveal = room.state.reveal;
  assert.equal(reveal.contested.length, 1);
  assert.equal(reveal.overridden.length, 1);
  assert.equal(reveal.overridden[0].reason, 'contested');
  for (const team of ['A', 'B']) {
    const counts = view.factionCounts[team];
    for (const count of Object.values(counts)) assert.ok(count <= 2);
    assert.ok(Object.keys(counts).length >= 2);
  }
});

test('默认策略也必须通过正常约束（含被禁角色排除）', () => {
  const rules = { ...baseRules, banTurnsPerTeam: 2 };
  const { room, clockRef } = makeRoom(rules);
  // 两队禁用按顺序，只禁非先锋角色以避免先锋位候选被全部耗尽（耗尽场景另有专项测试）。
  for (let i = 0; i < 4; i += 1) {
    const team = room.state.banSequence[room.state.banTurnIndex];
    const banned = new Set(room.state.bans.map((b) => b.characterId));
    const pick = CHARACTER_POOL.find(
      (c) => !banned.has(c.id) && c.role === 'duelist',
    ).id;
    const result = room.submitBan({
      team, seatIndex: 0, intentId: `ban-${i}`, roundId: 1,
      turnId: `r1-ban${room.state.banTurnIndex}`, characterId: pick, receivedAt: clockRef.t,
    });
    assert.equal(result.ok, true);
    clockRef.t += 10;
  }
  assert.equal(room.state.phase, 'secret');
  clockRef.t = room.state.secret.deadline;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'revealed');
  const bannedIds = new Set(room.state.bans.map((b) => b.characterId));
  for (const team of ['A', 'B']) {
    for (const entry of room.state.reveal.rosters[team]) {
      assert.ok(!bannedIds.has(entry.characterId), `${team} 阵容不得包含被禁角色`);
    }
  }
});

test('裁决幂等：到达截止后重复 tick 不会二次裁决或改变结果', () => {
  const { room, clockRef } = makeRoom();
  clockRef.t = room.state.secret.deadline;
  room.tick(clockRef.t);
  const firstScene = room.state.scene.sceneId;
  room.tick(clockRef.t + 5000);
  assert.equal(room.state.phase, 'revealed');
  assert.equal(room.state.scene.sceneId, firstScene);
});

test('上一轮已裁决后禁止晚到旧轮禁用', () => {
  const rules = { ...baseRules, banTurnsPerTeam: 1, timers: { banMs: 100, secretMs: 100, awayGraceMs: 50 } };
  const { room, clockRef } = makeRoom(rules);
  // 两次自动禁用，各自在到期后推进
  clockRef.t = room.state.banDeadline + 1;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'ban');
  clockRef.t = room.state.banDeadline + 1;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'secret');
  clockRef.t = room.state.secret.deadline;
  room.tick(clockRef.t);
  assert.equal(room.state.phase, 'revealed');
  const stale = room.submitBan({
    team: 'A', seatIndex: 0, intentId: 'old-ban', roundId: 1, turnId: 'r1-ban0',
    characterId: 'iron_bulwark', receivedAt: clockRef.t + 1,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.code, 'phase-closed');
});
