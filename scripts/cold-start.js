#!/usr/bin/env node
// 冷启动演练：在一个全新的、未缓存任何生成资源的临时目录中验证交付工程可独立启动。
// 流程：拷贝仓库源文件（不含 node_modules / public/assets / data 产物）-> 安装依赖 ->
// 固定种子重建资源 -> 校验 -> 启动服务器 -> 真实 WebSocket 脚本选手走完一局 -> 验证正式阵容与场景。
// 用法：node scripts/cold-start.js [--keep]
import { mkdtemp, cp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const keep = process.argv.includes('--keep');
const log = (...args) => console.log('[cold-start]', ...args);

function run(cmd, args, opts = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      if (code === 0) resolveRun({ out, err });
      else rejectRun(new Error(`${cmd} ${args.join(' ')} 退出码 ${code}\n${err}`));
    });
  });
}

const dir = await mkdtemp(join(tmpdir(), 'arena-cold-'));
log(`全新目录：${dir}`);
try {
  // 1. 仅拷贝源文件，显式排除依赖与所有生成物，模拟未缓存环境
  await mkdir(dir, { recursive: true });
  const entries = ['package.json', 'package-lock.json', 'server', 'shared', 'public', 'scripts', 'test'];
  for (const entry of entries) {
    await cp(join(REPO, entry), join(dir, entry), {
      recursive: true,
      filter: (src) => {
        const normalized = src.replaceAll('\\', '/');
        if (normalized.includes('/node_modules/')) return false;
        if (normalized.includes('/public/assets/')) return false; // 生成的头像与清单
        return true;
      },
    });
  }
  // 不拷贝 data/（生成物），确认其缺席时构建能从零创建
  log('已拷贝源文件（排除 node_modules 与生成资源）');

  // 2. 安装依赖
  log('安装依赖（npm ci）…');
  await run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir });

  // 3. 固定种子重建资源
  log('固定种子重建角色池/头像/情境…');
  const build = await run('node', ['scripts/build-resources.js'], { cwd: dir });
  log(build.out.trim().split('\n').map((l) => l.replace('[build] ', '')).join(' | '));

  // 4. 资源校验（缺失素材/失效引用会在此非零退出）
  await run('node', ['scripts/verify-resources.js'], { cwd: dir });
  log('资源校验通过');

  // 5. 启动服务器
  const port = 4477;
  const server = spawn('node', ['server/index.js'], {
    cwd: dir,
    env: { ...process.env, PORT: String(port), BAN_MS: '1500', SECRET_MS: '2500', AWAY_GRACE_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  await new Promise((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error('服务器启动超时')), 15000);
    const probe = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (res.ok) { clearTimeout(timer); resolveWait(); return; }
      } catch { /* 尚未就绪 */ }
      setTimeout(probe, 150);
    };
    probe();
  });
  log(`服务器已在 ${port} 启动`);

  // 6. 真实 WebSocket 脚本选手完成一局，验证正式阵容展示
  const created = await fetch(`http://127.0.0.1:${port}/api/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { timers: { banMs: 1500, secretMs: 2500, awayGraceMs: 1000 } } }),
  }).then((r) => r.json());
  const openSeat = (token) => new Promise((resolveSeat, rejectSeat) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.on('error', rejectSeat);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', matchId: created.matchId, token })));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello.ok') resolveSeat({ ws, role: msg.role });
    });
  });
  const seatA = await openSeat(created.tokens.A[0]);
  const seatB = await openSeat(created.tokens.B[0]);
  const waitView = (ws, pred) => new Promise((resolveView, rejectView) => {
    const timer = setTimeout(() => rejectView(new Error('等待裁决超时')), 20000);
    const handler = (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'view' && pred(msg.view)) { clearTimeout(timer); ws.off('message', handler); resolveView(msg.view); }
    };
    ws.on('message', handler);
  });
  const finalView = await waitView(seatA.ws, (v) => v.phase === 'revealed' || v.phase === 'failed');
  if (finalView.phase !== 'revealed') throw new Error(`冷启动对局未进入正式阵容：${finalView.failure?.code}`);
  const rosterCount = finalView.rosters.A.length + finalView.rosters.B.length;
  log(`正式阵容已展示：${rosterCount} 个单位，scene=${finalView.scene.sceneId}`);
  const sceneRes = await fetch(`http://127.0.0.1:${port}/api/matches/${created.matchId}/scene`);
  if (sceneRes.status !== 200) throw new Error(`场景接口异常 HTTP ${sceneRes.status}`);
  const scene = await sceneRes.json();
  if (scene.schema !== 'arena-match-scene@1') throw new Error('场景 schema 异常');
  // 头像在新目录中确实可访问
  const portrait = await fetch(`http://127.0.0.1:${port}${finalView.rosters.A[0].character.portrait}`);
  if (portrait.status !== 200 || portrait.headers.get('content-type') !== 'image/svg+xml') {
    throw new Error('正式阵容角色头像在新目录不可访问');
  }
  seatA.ws.close();
  seatB.ws.close();
  server.kill();
  log('冷启动演练通过：未缓存资源的新目录可独立启动并进入正式阵容展示');
} catch (error) {
  console.error('[cold-start] 失败：', error.message);
  process.exitCode = 1;
} finally {
  if (keep) log(`保留临时目录：${dir}`);
  else await rm(dir, { recursive: true, force: true });
}
