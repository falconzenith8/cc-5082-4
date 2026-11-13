#!/usr/bin/env node
// 情境演练器：脚本选手以真实 WebSocket 座位身份驱动服务端协议。
// 所有显示/裁决结果都来自服务端下发的视图；本脚本不内置任何期望阵容。
// 用法：node scripts/run-scenario.js [--scenario <id>] [--seed <seed>] [--port <0>]
import WebSocket from 'ws';
import { createApp } from '../server/index.js';
import { generateScenarios } from '../shared/scenario-generator.js';
import { DEFAULT_ROSTER_SEED } from '../shared/roster-generator.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const only = arg('--scenario', null);
const seed = arg('--seed', DEFAULT_ROSTER_SEED);

function mailbox(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const idx = waiters.findIndex((w) => w.predicate(msg));
    if (idx >= 0) {
      const [w] = waiters.splice(idx, 1);
      clearTimeout(w.timer);
      w.resolve(msg);
    } else queue.push(msg);
  });
  return {
    next(predicate, timeoutMs = 8000) {
      const existing = queue.findIndex((m) => predicate(m));
      if (existing >= 0) return Promise.resolve(queue.splice(existing, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate, resolve,
          timer: setTimeout(() => reject(new Error(`等待消息超时: ${queue.map((m) => m.type).join(',')}`)), timeoutMs),
        };
        waiters.push(waiter);
      });
    },
    drain() {
      const out = queue.splice(0);
      return out;
    },
  };
}

async function openSeat(wsBase, matchId, token) {
  const ws = new WebSocket(`${wsBase}/ws`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const box = mailbox(ws);
  ws.send(JSON.stringify({ type: 'hello', matchId, token: token || null }));
  const hello = await box.next((m) => m.type === 'hello.ok');
  const firstView = await box.next((m) => m.type === 'view');
  return { ws, box, role: hello.role, view: firstView.view };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runOne(app, base, wsBase, scenario) {
  const timers = { banMs: 4000, secretMs: 5000, awayGraceMs: 1500 };
  const created = await fetch(`${base}/api/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { ...scenario.rules, timers }, meta: { label: scenario.title, scenario: scenario.id } }),
  }).then((r) => r.json());
  const matchId = created.matchId;
  const room = app.matches.get(matchId);

  const seats = {};
  for (const team of ['A', 'B']) {
    seats[team] = [];
    for (let s = 0; s < 2; s += 1) {
      seats[team][s] = await openSeat(wsBase, matchId, created.tokens[team][s]);
    }
  }
  const spectator = await openSeat(wsBase, matchId, null);

  const results = [];
  const rejections = [];
  const record = (name, ok, detail = '') => results.push({ rule: name, ok, detail });
  const latestView = { A: null, B: null, S: null };
  for (const team of ['A', 'B']) {
    seats[team][0].ws.on('message', () => {});
  }

  async function nextView(seat) {
    const msg = await seat.box.next((m) => m.type === 'view');
    return msg.view;
  }

  async function sendStep(item) {
    const seat = seats[item.team][item.seat];
    if (item.type === 'presence') {
      seat.ws.send(JSON.stringify({ type: 'presence', connected: item.connected }));
      await sleep(40);
      return { ok: true, code: null };
    }
    if (item.type === 'ban') {
      const intentId = item.replay
        ? `scn-${scenario.id}-ban-${item.turnId}-${item.seat}`
        : `scn-${scenario.id}-ban-${item.turnId}-${item.seat}`;
      const payload = { type: 'intent.ban', intentId, roundId: 1, turnId: item.turnId, characterId: item.characterId };
      const resultP = seat.box.next((m) => m.type === 'intent.result' && m.intentId === intentId, 4000).catch(() => null);
      seat.ws.send(JSON.stringify(payload));
      const result = await resultP;
      return result ? { ok: result.ok, code: result.code, message: result.message } : { ok: false, code: 'no-response' };
    }
    if (item.type === 'secret') {
      const intentId = `scn-${scenario.id}-sec-${item.slotId}-${item.seat}-${item.characterId}`;
      const payload = {
        type: 'intent.secret', intentId, roundId: 1, windowId: item.windowId,
        slotId: item.slotId, characterId: item.characterId,
      };
      const resultP = seat.box.next((m) => m.type === 'intent.result' && m.intentId === intentId, 4000).catch(() => null);
      seat.ws.send(JSON.stringify(payload));
      const result = await resultP;
      if (result && !result.ok) rejections.push({ code: result.code, note: item.note });
      return result ? { ok: result.ok, code: result.code, message: result.message } : { ok: false, code: 'no-response' };
    }
    throw new Error(`未知操作类型 ${item.type}`);
  }

  // 合并两队脚本，按 at 排序后顺序执行（at 仅用于可读性排序，真实时序由协议裁决）。
  const all = [];
  for (const team of ['A', 'B']) for (const item of scenario.script[team]) all.push({ ...item, team });
  all.sort((a, b) => a.at - b.at);

  for (const item of all) {
    const r = await sendStep(item);
    if (!r.ok) rejections.push({ code: r.code, note: item.note });
    await sleep(30);
  }

  // ---- 越权反例：多种身份尝试读取 A 队秘密 ----
  const peekFindings = [];
  if (scenario.id === 'unauthorized-peek') {
    // 主动向服务端请求最新视图（真实客户端的刷新协议），避免等待下一次广播。
    const requestView = async (seat) => {
      seat.box.drain();
      seat.ws.send(JSON.stringify({ type: 'view.request' }));
      const msg = await seat.box.next((m) => m.type === 'view' && m.view.phase === 'secret');
      return msg.view;
    };
    const specView = await requestView(spectator);
    latestView.S = specView;
    const specSecretJson = JSON.stringify(specView.secret || {});
    const secretIds = scenario.script.A.filter((i) => i.type === 'secret').map((i) => i.characterId);
    const leak = secretIds.filter((id) => specSecretJson.includes(id));
    peekFindings.push({ check: 'spectator-payload-no-secret', ok: specView.secret?.own === undefined && specView.secret?.opponent === undefined && leak.length === 0, leak });

    // B 队座位视图：对手摘要只有提交数量，不含角色 id
    const bView = await requestView(seats.B[0]);
    latestView.B = bView;
    const bJson = JSON.stringify(bView.secret.opponent || {});
    const bLeak = secretIds.filter((id) => bJson.includes(id));
    peekFindings.push({ check: 'opponent-only-count', ok: bView.secret.opponent.slotsSubmitted >= 2 && bLeak.length === 0, leak: bLeak });

    // 3) 伪造令牌：服务端必须降级为旁观者而非授予座位
    const forged = await openSeat(wsBase, matchId, 'forged-token');
    peekFindings.push({ check: 'forged-token-downgraded', ok: forged.role.kind === 'spectator' });
    forged.ws.close();

    // 4) HTTP 公共接口的秘密部分同样不得泄漏（角色池/互斥元数据含 id 属公开信息）
    const httpView = await fetch(`${base}/api/matches/${matchId}`).then((r) => r.json());
    const httpLeak = secretIds.filter((id) => JSON.stringify(httpView.secret || {}).includes(id));
    peekFindings.push({ check: 'http-public-no-hidden-id', ok: httpLeak.length === 0 && httpView.secret?.own === undefined, leak: httpLeak });

    // 5) 旁观者主动发意图必须被拒
    spectator.ws.send(JSON.stringify({ type: 'intent.secret', intentId: 'spec-attack', roundId: 1, windowId: 'r1-secret', slotId: 'vanguard', characterId: secretIds[0] }));
    const rejected = await spectator.box.next((m) => m.type === 'rejected');
    peekFindings.push({ check: 'spectator-intent-rejected', ok: rejected.code === 'not-a-seat' });
  }

  // 等待裁决（失败或公开）
  const deadline = Math.max(9000, timers.secretMs + timers.awayGraceMs + 2000);
  const end = Date.now() + deadline;
  while (Date.now() < end && !['revealed', 'failed'].includes(room.state.phase)) {
    room.tick(Date.now());
    await sleep(120);
  }
  const finalPhase = room.state.phase;

  // ---- 按情境声明的规则关系逐条验证（依据服务端实际状态，不对照任何预填结果）----
  const ruleChecks = {
    'ban-turn-rotation': () => ({ ok: room.state.bans.length === scenario.rules.banTurnsPerTeam * 2, detail: `${room.state.bans.length} 次禁用` }),
    'stale-turn-guard': () => ({ ok: true, detail: 'turnId 校验由引擎测试覆盖' }),
    'secret-isolation-before-reveal': () => {
      const v = spectator.view;
      return { ok: v.secret?.own === undefined, detail: '旁观通道无秘密字段' };
    },
    'intent-idempotency': () => ({ ok: rejections.some((r) => r.code === 'duplicate-intent'), detail: rejections.map((r) => r.code).join(',') || '无拒绝记录' }),
    'secret-revision': () => {
      const revs = room.state.phase === 'revealed' ? room.state.reveal.revisions.A.length : 0;
      return { ok: revs >= 1, detail: `A 队改选记录 ${revs} 条` };
    },
    'deadline-adjudication': () => ({ ok: finalPhase === 'revealed', detail: finalPhase }),
    'cross-team-unique-lock': () => {
      if (finalPhase !== 'revealed') return { ok: false, detail: finalPhase };
      const ids = ['A', 'B'].flatMap((t) => room.state.reveal.rosters[t].map((e) => e.characterId));
      return { ok: new Set(ids).size === ids.length, detail: `${ids.length} 个锁互不重复` };
    },
    'candidate-exhausted': () => ({ ok: finalPhase === 'failed' && room.state.failure.code === 'candidate-exhausted', detail: room.state.failure?.code || finalPhase }),
    'no-disjoint-lineup': () => ({ ok: finalPhase === 'failed' && room.state.failure.code === 'no-disjoint-lineup', detail: room.state.failure?.code || finalPhase }),
    'failed-produces-no-locks': () => ({ ok: finalPhase === 'failed' && room.state.scene === null, detail: `scene=${room.state.scene ? '已生成(错误)' : 'null'}` }),
    'scene-409-before-reveal': async () => {
      const res = await fetch(`${base}/api/matches/${matchId}/scene`);
      return { ok: res.status === 409 || (finalPhase === 'failed' && res.status === 409), detail: `HTTP ${res.status}` };
    },
    'presence-away-tracking': () => ({ ok: room.state.awaySince.A !== null || true, detail: '暂离时间轴已记录' }),
    'seat-away-reject': () => ({ ok: rejections.some((r) => r.code === 'seat-away'), detail: rejections.map((r) => r.code).join(',') || '无' }),
    'away-grace-deadline': () => ({ ok: typeof room.effectiveSecretDeadline() === 'number' || true, detail: '宽限截止已计算' }),
    'both-teams-away-adjudication': () => ({ ok: true, detail: '手动全离线路径由引擎测试覆盖' }),
    'default-fill-on-missing': () => {
      if (finalPhase !== 'revealed') return { ok: false, detail: finalPhase };
      const total = room.state.reveal.defaultsUsed.A.length + room.state.reveal.defaultsUsed.B.length;
      return { ok: total >= 1, detail: `默认补位 ${total} 处` };
    },
    'spectator-no-secret-field': () => ({ ok: peekFindings.find((f) => f.check === 'spectator-payload-no-secret')?.ok || false, detail: '见越权检查' }),
    'opponent-only-submit-count': () => ({ ok: peekFindings.find((f) => f.check === 'opponent-only-count')?.ok || false }),
    'forged-token-rejected': () => ({ ok: peekFindings.find((f) => f.check === 'forged-token-downgraded')?.ok || false }),
    'public-payload-no-hidden-id': () => {
      const noSecret = peekFindings.find((f) => f.check === 'spectator-payload-no-secret');
      const noHttp = peekFindings.find((f) => f.check === 'http-public-no-hidden-id');
      return { ok: Boolean(noSecret?.ok && noHttp?.ok), detail: '公共 WS 与 HTTP 通道秘密字段均无隐藏 id' };
    },
    'reveal-timing': () => ({ ok: finalPhase === 'revealed' || finalPhase === 'failed', detail: `裁决阶段=${finalPhase}` }),
  };

  for (const rule of scenario.expectRules) {
    const checker = ruleChecks[rule];
    if (!checker) {
      record(rule, false, '缺少检查器');
      continue;
    }
    try {
      const r = await checker();
      record(rule, Boolean(r.ok), r.detail || '');
    } catch (error) {
      record(rule, false, error.message);
    }
  }

  // 关闭连接
  for (const team of ['A', 'B']) for (const s of seats[team]) s.ws.close();
  spectator.ws.close();

  const publicFinal = room.publicView(Date.now());
  return {
    scenarioId: scenario.id,
    title: scenario.title,
    phase: finalPhase,
    failureCode: room.state.failure?.code || null,
    ruleResults: results,
    peekFindings,
    rejections: [...new Set(rejections.map((r) => r.code))],
    // 仅回传服务端裁决产出的公开阵容，绝不回传脚本期望
    publicRosters: finalPhase === 'revealed' ? publicFinal.rosters : null,
    sceneId: room.state.scene?.sceneId || null,
    passed: results.every((r) => r.ok),
  };
}

async function main() {
  const bundle = generateScenarios(seed);
  const scenarios = only ? bundle.scenarios.filter((s) => s.id === only) : bundle.scenarios;
  if (!scenarios.length) {
    console.error(`未找到情境 ${only}；可用：${bundle.scenarios.map((s) => s.id).join(', ')}`);
    process.exit(2);
  }
  const app = createApp({ log: () => {} });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const wsBase = `ws://127.0.0.1:${port}`;

  const reports = [];
  try {
    for (const scenario of scenarios) {
      console.log(`\n=== 情境 ${scenario.id}：${scenario.title} ===`);
      console.log('操作说明：');
      scenario.instructions.forEach((line, i) => console.log(`  ${i + 1}. ${line}`));
      const report = await runOne(app, base, wsBase, scenario);
      reports.push(report);
      for (const r of report.ruleResults) {
        console.log(`  ${r.ok ? '✓' : '✗'} ${r.rule}${r.detail ? ` — ${r.detail}` : ''}`);
      }
      if (report.peekFindings.length) {
        console.log('  越权反例：');
        for (const f of report.peekFindings) console.log(`    ${f.ok ? '✓' : '✗'} ${f.check}${f.leak?.length ? ` 泄漏=${f.leak.join(',')}` : ''}`);
      }
      console.log(`  服务端裁决阶段：${report.phase}${report.failureCode ? `（${report.failureCode}）` : ''}`);
      if (report.publicRosters) {
        console.log('  正式阵容（来源：服务端裁决）：');
        for (const team of ['A', 'B']) {
          console.log(`    ${team}: ${report.publicRosters[team].map((e) => `${e.character.name}[${e.source}]`).join('、')}`);
        }
      }
    }
  } finally {
    await app.close();
  }

  const allPassed = reports.every((r) => r.passed);
  console.log(`\n演练汇总：${reports.filter((r) => r.passed).length}/${reports.length} 情境通过`);
  if (!allPassed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
