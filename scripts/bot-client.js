#!/usr/bin/env node
// 脚本选手：以真实 WebSocket 座位身份完成整局禁选，并打印最终阵容。
// 用法：
//   node scripts/bot-client.js                      # 自建一局，两队各派一名脚本选手
//   node scripts/bot-client.js <matchId> <tokenA0> <tokenB0>   # 加入已有对局
import WebSocket from 'ws';

const args = process.argv.slice(2);
const base = process.env.BASE_URL || 'http://localhost:4317';
const wsBase = base.replace(/^http/, 'ws');
let [matchId, tokenA, tokenB] = args;

function openSeat(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws`);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', matchId, token }));
    });
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'hello.ok') resolve({ ws, role: message.role });
    });
    ws.on('error', reject);
  });
}

function intentId(kind) {
  return `bot-${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function sendIntent(ws, payload) {
  return new Promise((resolve, reject) => {
    const id = intentId(payload.type);
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'intent.result' && message.intentId === id) {
        ws.off('message', handler);
        resolve(message);
      }
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ ...payload, intentId: id }));
    setTimeout(() => { ws.off('message', handler); reject(new Error('intent timeout')); }, 20000);
  });
}

function waitForView(ws, predicate, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const handler = (raw) => {
      const message = JSON.parse(raw.toString());
      const view = message.type === 'view' ? message.view : message.type === 'match.ended' ? message : null;
      if (view && predicate(view)) {
        ws.off('message', handler);
        clearTimeout(timer);
        resolve(view);
      }
    };
    const timer = setTimeout(() => {
      ws.off('message', handler);
      reject(new Error('view timeout'));
    }, timeoutMs);
    ws.on('message', handler);
  });
}

function bestCharacter(view, slotId, seat, team) {
  const banned = new Set(view.ban.bans.map((b) => b.characterId));
  const used = new Set(Object.values(view.secret.own.picks).filter(Boolean).map((p) => p.characterId));
  const accept = { vanguard: ['vanguard'], support: ['support'], flex: ['duelist', 'control'] }[slotId];
  const weights = {
    vanguard: (c) => c.guard * 0.55 + c.utility * 0.25 + c.power * 0.12 + c.speed * 0.08,
    support: (c) => c.utility * 0.58 + c.guard * 0.18 + c.speed * 0.14 + c.power * 0.1,
    flex: (c) => c.power * 0.5 + c.utility * 0.2 + c.speed * 0.18 + c.guard * 0.12,
  };
  const list = view.pool
    .filter((c) => !banned.has(c.id) && accept.includes(c.role) && !used.has(c.id))
    .sort((a, b) => weights[slotId](b) - weights[slotId](a));
  // 两个座位与两队的偏好略作差异化，便于观察到队内冲突与跨队争抢的裁决
  const teamOffset = team === 'B' ? 1 : 0;
  const pick = list[Math.min(seat + teamOffset, list.length - 1)];
  return pick;
}

function roleKey(role) {
  return role === 'duelist' || role === 'control' ? 'flex' : role;
}

function chooseBan(view, team) {
  const banned = new Set(view.ban.bans.map((b) => b.characterId));
  const scarcity = { vanguard: 0, support: 0, flex: 0 };
  for (const c of view.pool) {
    if (banned.has(c.id)) continue;
    scarcity[roleKey(c.role)] += 1;
  }
  // 保护每个位置至少保留 2 个候选，避免把某个位置禁到无法满足选角约束。
  const safe = (c) => scarcity[roleKey(c.role)] > 2;
  const threat = (pool) => pool.sort((a, b) => (Math.max(b.power, b.utility) + (b.power + b.utility) * 0.4) - (Math.max(a.power, a.utility) + (a.power + a.utility) * 0.4));
  const all = threat(view.pool.filter((c) => !banned.has(c.id)));
  const guard = all.filter(safe);
  const priorityOrder = guard.length ? guard : all;
  const offset = team === 'B' ? 1 : 0;
  return (priorityOrder[offset] || priorityOrder[0]).id;
}

async function runSeat({ token, team, seat, onView }) {
  const { ws, role } = await openSeat(token);
  if (role.kind !== 'seat') throw new Error(`token ${token} 未获得座位`);
  const seen = { bans: new Set(), secret: new Set() };
  ws.on('message', async (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type !== 'view') return;
    const view = message.view;
    onView(view);
    if (view.phase === 'ban' && view.ban.activeTeam === team && seat === 0) {
      const turnId = view.ban.activeTurnId;
      if (seen.bans.has(turnId)) return;
      seen.bans.add(turnId);
      try {
        const result = await sendIntent(ws, {
          type: 'intent.ban', roundId: view.roundId, turnId, characterId: chooseBan(view, team),
        });
        if (!result.ok) console.warn(`[${team}] 禁用被拒: ${result.code} ${result.message}`);
      } catch (error) {
        console.warn(`[${team}] 禁用异常: ${error.message}`);
      }
    }
    if (view.phase === 'secret' && view.secret.own) {
      for (const slotId of view.rules.slotPlan) {
        const key = `${view.secret.windowId}:${slotId}`;
        if (seen.secret.has(key)) continue;
        if (view.secret.own.picks[slotId]) continue;
        // 两个座位都提交，展示队内冲突裁定
        const character = bestCharacter(view, slotId, seat, team);
        if (!character) continue;
        seen.secret.add(key);
        try {
          await sendIntent(ws, {
            type: 'intent.secret',
            roundId: view.roundId,
            windowId: view.secret.windowId,
            slotId,
            characterId: character.id,
          });
        } catch (error) {
          console.warn(`[${team}] 秘密候选异常: ${error.message}`);
        }
      }
    }
  });
  return ws;
}

async function main() {
  if (!matchId || !tokenA || !tokenB) {
    const created = await fetch(`${base}/api/matches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { timers: { banMs: 12000, secretMs: 20000, awayGraceMs: 8000 } } }),
    }).then((response) => response.json());
    matchId = created.matchId;
    tokenA = created.tokens.A[0];
    tokenB = created.tokens.B[0];
    console.log(`已创建对局 ${matchId}，两队脚本选手入场`);
  }

  const seats = [
    { token: tokenA, team: 'A', seat: 0 },
    { token: tokenB, team: 'B', seat: 0 },
  ];
  const progress = { A: null, B: null };
  const sockets = [];
  for (const seatInfo of seats) {
    const ws = await runSeat({ ...seatInfo, onView: (view) => { progress[seatInfo.team] = view; } });
    sockets.push(ws);
  }
  console.log(`脚本选手已就位：match=${matchId} A=${tokenA.slice(0, 6)} B=${tokenB.slice(0, 6)}`);

  const finalView = await waitForView(
    sockets[0],
    (view) => view.phase === 'revealed' || view.phase === 'failed',
    180000,
  );
  if (finalView.phase === 'failed') {
    console.error('裁决失败:', finalView.failure.code, JSON.stringify(finalView.failure.diagnostics));
    sockets.forEach((ws) => ws.close());
    process.exit(2);
  }
  console.log('\n最终阵容（服务端裁决）:');
  for (const team of ['A', 'B']) {
    console.log(`  ${finalView.teams[team].name}:`);
    for (const entry of finalView.rosters[team]) {
      const c = entry.character;
      console.log(`    ${entry.slotLabel.padEnd(4)} ${c.name}  [${c.roleName}/${c.factionName}] 来源=${entry.source}`);
    }
    const counts = finalView.factionCounts[team];
    console.log(`    阵营分布: ${Object.entries(counts).map(([f, n]) => `${f}:${n}`).join(' ')}`);
  }
  const contested = finalView.secret.revealed.contested;
  if (contested.length) console.log(`  跨队争抢: ${contested.length} 次`);
  console.log(`\nscene: ${base}/scene/${matchId}`);
  sockets.forEach((ws) => ws.close());
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
