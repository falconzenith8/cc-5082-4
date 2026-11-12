#!/usr/bin/env node
// 离线端到端模拟：在进程内创建对局，由两套脚本策略完成禁选，输出裁决与场景。
// 用法：node scripts/simulate.js [--rules <json>] [--json]
import { MatchRoom } from '../server/engine.js';
import { CHARACTER_POOL } from '../shared/characters.js';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const rulesArg = argv[argv.indexOf('--rules') + 1];
const rules = rulesArg && argv.includes('--rules') ? JSON.parse(rulesArg) : {};

function threatOrder(pool, banned) {
  return pool
    .filter((c) => !banned.has(c.id))
    .sort((a, b) => (Math.max(b.power, b.utility) * 2 + b.power + b.utility) - (Math.max(a.power, a.utility) * 2 + a.power + a.utility));
}

function roleScarcity(pool, banned) {
  const counts = { vanguard: 0, support: 0, flex: 0 };
  for (const c of pool) {
    if (banned.has(c.id)) continue;
    if (c.role === 'vanguard') counts.vanguard += 1;
    else if (c.role === 'support') counts.support += 1;
    else counts.flex += 1;
  }
  return counts;
}

function botBan(room, team) {
  const banned = new Set(room.state.bans.map((b) => b.characterId));
  const scarcity = roleScarcity(CHARACTER_POOL, banned);
  // 保护每个位置至少有 2 个可用候选；否则该位置可能在裁决时耗尽。
  const safe = (c) => {
    const key = c.role === 'duelist' || c.role === 'control' ? 'flex' : c.role;
    return scarcity[key] > 2;
  };
  const order = threatOrder(CHARACTER_POOL, banned).filter(safe);
  const fallback = threatOrder(CHARACTER_POOL, banned);
  const poolToUse = order.length ? order : fallback;
  const offset = team === 'B' ? 1 : 0;
  return (poolToUse[offset] || poolToUse[0]).id;
}

function botSecret(room, team, seat) {
  const effectives = room.teamEffectives(team);
  const banned = new Set(room.state.bans.map((b) => b.characterId));
  const picks = {};
  let t = room.clock();
  const used = new Set(Object.values(effectives).map((p) => p.characterId));
  const usedIds = new Set(used);
  for (const slotId of room.rules.slotPlan) {
    if (effectives[slotId]) {
      picks[slotId] = effectives[slotId];
      continue;
    }
    const accept = { vanguard: ['vanguard'], support: ['support'], flex: ['duelist', 'control'] }[slotId];
    const weights = {
      vanguard: (c) => c.guard * 0.55 + c.utility * 0.25 + c.power * 0.12 + c.speed * 0.08,
      support: (c) => c.utility * 0.58 + c.guard * 0.18 + c.speed * 0.14 + c.power * 0.1,
      flex: (c) => c.power * 0.5 + c.utility * 0.2 + c.speed * 0.18 + c.guard * 0.12,
    };
    const candidates = CHARACTER_POOL
      .filter((c) => !banned.has(c.id) && accept.includes(c.role) && !usedIds.has(c.id))
      .sort((a, b) => weights[slotId](b) - weights[slotId](a));
    const teamOffset = team === 'B' ? 1 : 0;
    const chosen = candidates[Math.min(seat + teamOffset, candidates.length - 1)];
    if (!chosen) continue;
    const result = room.submitSecret({
      team, seatIndex: seat,
      intentId: `sim-${team}-${seat}-${slotId}-${Math.random().toString(36).slice(2, 6)}`,
      roundId: room.state.roundId,
      windowId: room.state.secret.windowId,
      slotId,
      characterId: chosen.id,
      receivedAt: t,
    });
    if (result.ok) {
      usedIds.add(chosen.id);
      picks[slotId] = { characterId: chosen.id };
    }
  }
  return picks;
}

function runTournament(room) {
  const log = [];
  room.on('update', (payload) => log.push(payload.reason));
  let now = room.clock();
  const bannedTurns = room.state.banSequence.length;
  for (let i = 0; i < bannedTurns; i += 1) {
    const team = room.state.banSequence[room.state.banTurnIndex];
    const result = room.submitBan({
      team,
      seatIndex: 0,
      intentId: `sim-ban-${i}-${Math.random().toString(36).slice(2, 5)}`,
      roundId: room.state.roundId,
      turnId: `r${room.state.roundId}-ban${room.state.banTurnIndex}`,
      characterId: botBan(room, team),
      receivedAt: now,
    });
    now += 300;
    if (!result.ok) log.push(`ban-rejected:${result.code}`);
  }
  for (const team of ['A', 'B']) {
    botSecret(room, team, 0);
    botSecret(room, team, 1);
  }
  // 让时间走到秘密窗口后的一个位置，然后由服务端裁决（模拟正常到期）
  now = room.state.secret.deadline;
  room.tick(now);
  return log;
}

const room = new MatchRoom({
  id: `sim-${Date.now()}`,
  rules,
  clock: (() => {
    let t = 1_000_000;
    return () => t;
  })(),
});
runTournament(room);
const view = room.publicView();
if (room.state.phase === 'failed') {
  console.error('FAILED', room.state.failure.code, room.state.failure.diagnostics);
  process.exit(2);
}
if (asJson) {
  console.log(JSON.stringify({ view, scene: room.state.scene }, null, 2));
} else {
  console.log(`对局 ${room.id} 裁决完成（${room.state.reveal.reason}）`);
  for (const team of ['A', 'B']) {
    console.log(`${view.teams[team].name}`);
    for (const entry of view.rosters[team]) {
      console.log(`  ${entry.slotLabel} ${entry.character.name} [${entry.character.roleName}/${entry.character.factionName}] ${entry.source}`);
    }
    console.log(`  阵营: ${Object.entries(view.factionCounts[team]).map(([f, n]) => `${f}:${n}`).join(' ')}`);
  }
  console.log(`scene: ${room.state.scene.sceneId} / schema ${room.state.scene.schema}`);
}
