import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createApp } from '../server/index.js';

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function createMailbox(ws) {
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const index = waiters.findIndex((w) => w.predicate(msg));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  return {
    next(predicate, timeoutMs = 6000) {
      const existing = queue.findIndex((m) => predicate(m));
      if (existing >= 0) {
        const [msg] = queue.splice(existing, 1);
        return Promise.resolve(msg);
      }
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate, resolve,
          timer: setTimeout(() => {
            const idx = waiters.indexOf(waiter);
            if (idx >= 0) waiters.splice(idx, 1);
            reject(new Error(`message timeout; queue=${queue.map((m) => m.type).join(',')}`));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function startServer() {
  const app = createApp({ log: () => {} });
  await new Promise((resolve) => app.server.listen(0, resolve));
  const port = app.server.address().port;
  return { app, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

async function seatSocket(wsBase, matchId, token) {
  const ws = new WebSocket(`${wsBase}/ws`);
  await waitOpen(ws);
  const mailbox = createMailbox(ws);
  ws.send(JSON.stringify({ type: 'hello', matchId, token }));
  const ok = await mailbox.next((m) => m.type === 'hello.ok');
  assert.equal(ok.role.kind, 'seat');
  const first = await mailbox.next((m) => m.type === 'view');
  return { ws, mailbox, view: first.view };
}

test('HTTP 创建对局、未裁决时场景 409、裁决后场景 200', async () => {
  const { app, base } = await startServer();
  try {
    const created = await fetch(`${base}/api/matches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { banTurnsPerTeam: 0, timers: { banMs: 2000, secretMs: 2500, awayGraceMs: 1000 } } }),
    }).then((r) => r.json());
    assert.ok(created.matchId);
    assert.equal(created.tokens.A.length, 2);

    const early = await fetch(`${base}/api/matches/${created.matchId}/scene`);
    assert.equal(early.status, 409);
    const body = await early.json();
    assert.equal(body.error, 'match-not-revealed');

    const state = await fetch(`${base}/api/matches/${created.matchId}`).then((r) => r.json());
    assert.equal(state.seatRole, 'spectator');
    assert.equal(state.secret.own, undefined);
  } finally {
    await app.close();
  }
});

test('WebSocket：座位视图含自己的秘密候选，旁观与敌方连接不含', async () => {
  const { app, base, wsBase } = await startServer();
  const sockets = [];
  try {
    const created = await fetch(`${base}/api/matches`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { banTurnsPerTeam: 0, timers: { banMs: 2000, secretMs: 4000, awayGraceMs: 1000 } } }),
    }).then((r) => r.json());
    const matchId = created.matchId;

    const seatA = await seatSocket(wsBase, matchId, created.tokens.A[0]);
    const seatB = await seatSocket(wsBase, matchId, created.tokens.B[0]);
    const specWs = new WebSocket(`${wsBase}/ws`);
    await waitOpen(specWs);
    const specBox = createMailbox(specWs);
    specWs.send(JSON.stringify({ type: 'hello', matchId }));
    const specHello = await specBox.next((m) => m.type === 'hello.ok');
    assert.equal(specHello.role.kind, 'spectator');
    await specBox.next((m) => m.type === 'view');
    sockets.push(seatA.ws, seatB.ws, specWs);

    const view = await seatA.mailbox.next((m) => m.type === 'view' && m.view.phase === 'secret');
    seatA.ws.send(JSON.stringify({
      type: 'intent.secret', intentId: 'secret-1', roundId: view.view.roundId,
      windowId: view.view.secret.windowId, slotId: 'vanguard', characterId: 'iron_bulwark',
    }));
    const result = await seatA.mailbox.next((m) => m.type === 'intent.result' && m.intentId === 'secret-1');
    assert.equal(result.ok, true);

    const aView = await seatA.mailbox.next((m) => m.type === 'view' && m.view.secret?.own?.picks?.vanguard);
    assert.equal(aView.view.secret.own.picks.vanguard.characterId, 'iron_bulwark');

    const specView = await specBox.next((m) => m.type === 'view' && m.view.phase === 'secret');
    assert.equal(specView.view.secret.own, undefined);
    assert.equal(specView.view.secret.opponent, undefined);

    const bView = await seatB.mailbox.next((m) => m.type === 'view' && m.view.secret?.status);
    const ownA = bView.view.secret.own;
    const opponentA = bView.view.secret.opponent;
    assert.equal(opponentA.slotsSubmitted, 1, 'B 只能看到 A 已提交的位置数');
    assert.ok(!JSON.stringify(opponentA).includes('iron_bulwark'), 'B 队视图的对手摘要不得包含角色 ID');
    assert.equal(ownA.picks.vanguard, null, 'B 队自己的候选仍为空');
    assert.equal(bView.view.secret.status.A.slotsSubmitted, 1);
  } finally {
    sockets.forEach((ws) => ws.close());
    await app.close();
  }
});

test('WebSocket：无座位令牌不能提交意图；重复 intentId 被拒', async () => {
  const { app, base, wsBase } = await startServer();
  let specWs;
  let seatA;
  try {
    const created = await fetch(`${base}/api/matches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { banTurnsPerTeam: 2, timers: { banMs: 5000, secretMs: 5000, awayGraceMs: 1000 } } }),
    }).then((r) => r.json());
    seatA = await seatSocket(wsBase, created.matchId, created.tokens.A[0]);
    specWs = new WebSocket(`${wsBase}/ws`);
    await waitOpen(specWs);
    const specBox = createMailbox(specWs);
    specWs.send(JSON.stringify({ type: 'hello', matchId: created.matchId }));
    await specBox.next((m) => m.type === 'hello.ok');
    await specBox.next((m) => m.type === 'view');

    specWs.send(JSON.stringify({ type: 'intent.ban', intentId: 'x', roundId: 1, turnId: 'r1-ban0', characterId: 'iron_bulwark' }));
    const rejected = await specBox.next((m) => m.type === 'rejected');
    assert.equal(rejected.code, 'not-a-seat');

    const view = seatA.view;
    const payload = {
      type: 'intent.ban', intentId: 'same', roundId: view.roundId,
      turnId: view.ban.activeTurnId, characterId: 'ember_step',
    };
    seatA.ws.send(JSON.stringify(payload));
    const first = await seatA.mailbox.next((m) => m.type === 'intent.result' && m.intentId === 'same');
    assert.equal(first.ok, true, `first=${first.code} ${first.message}`);
    // 同一 intentId 的重复投递：幂等拒绝，即使携带不同角色也不会重复生效。
    seatA.ws.send(JSON.stringify({ ...payload, characterId: 'iron_bulwark' }));
    const second = await seatA.mailbox.next((m) => m.type === 'intent.result' && m.intentId === 'same');
    assert.equal(second.ok, false);
    // 该回合已推进，因此可能是 duplicate-intent 或 stale-turn；两者都证明意图未被重复采用。
    assert.ok(['duplicate-intent', 'stale-turn'].includes(second.code), `unexpected ${second.code}`);
  } finally {
    specWs?.close();
    seatA?.ws?.close();
    await app.close();
  }
});

test('WebSocket：座位断开触发暂离；双方断开后服务端按时裁决', async () => {
  const { app, base, wsBase } = await startServer();
  try {
    const created = await fetch(`${base}/api/matches`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rules: { banTurnsPerTeam: 0, timers: { banMs: 3000, secretMs: 5000, awayGraceMs: 1200 } } }),
    }).then((r) => r.json());
    const matchId = created.matchId;
    const a0 = await seatSocket(wsBase, matchId, created.tokens.A[0]);
    const a1 = await seatSocket(wsBase, matchId, created.tokens.A[1]);
    const b0 = await seatSocket(wsBase, matchId, created.tokens.B[0]);
    const b1 = await seatSocket(wsBase, matchId, created.tokens.B[1]);
    a0.ws.close(); a1.ws.close(); b0.ws.close(); b1.ws.close();
    await new Promise((r) => setTimeout(r, 400));

    const state = await fetch(`${base}/api/matches/${matchId}`).then((r) => r.json());
    assert.equal(state.presence.A[0].connected, false);
    assert.equal(state.presence.B[0].connected, false);

    const room = app.matches.get(matchId);
    assert.ok(room.state.allAwaySince != null, '全部断开后应记录全体暂离时间');
    room.tick(room.state.allAwaySince + 1200 + 10);
    assert.equal(room.state.phase, 'revealed');
    assert.equal(room.state.reveal.reason, 'both-teams-away');
  } finally {
    await app.close();
  }
});
