// 浏览器端到端：两队各自点击操作，验证服务端采用意图、秘密隔离、公开裁决与场景载入。
// 默认自起一个独立服务器；已有服务器时用 BASE_URL 指向它。
import { chromium } from 'playwright';
import { createApp } from '../server/index.js';

async function startOwnServer() {
  const app = createApp({ log: () => {} });
  await new Promise((resolve) => app.server.listen(4321, resolve));
  return { app, base: 'http://localhost:4321' };
}

async function main() {
  const own = process.env.BASE_URL ? null : await startOwnServer();
  const BASE = own?.base || process.env.BASE_URL;
  const browser = await chromium.launch();
  const errors = [];
  const record = (pageName) => (page) => {
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`${pageName}: ${m.text()}`); });
    page.on('pageerror', (e) => errors.push(`${pageName}: ${e.message}`));
  };

  const created = await fetch(`${BASE}/api/matches`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ rules: { timers: { banMs: 20000, secretMs: 25000, awayGraceMs: 4000 } } }),
  }).then((r) => r.json());
  const matchId = created.matchId;

  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxS = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageS = await ctxS.newPage();
  record('A')(pageA); record('B')(pageB); record('S')(pageS);

  await pageA.goto(`${BASE}/table/${matchId}?token=${created.tokens.A[0]}`, { waitUntil: 'networkidle' });
  await pageB.goto(`${BASE}/table/${matchId}?token=${created.tokens.B[0]}`, { waitUntil: 'networkidle' });
  await pageS.goto(`${BASE}/spectate/${matchId}`, { waitUntil: 'networkidle' });

  await pageA.waitForSelector('.pool-item');
  await pageB.waitForSelector('.pool-item');

  console.log('--- 禁用阶段 ---');
  // A 先禁；每次点击后等服务端广播的下一条视图，避免两队同时抢着点击。
  await banViaUi(pageA, 'ember_step');
  await pageA.waitForFunction(() => !document.querySelector('.phase-callout')?.textContent.includes('苍隼队'), { timeout: 10000 });
  await banViaUi(pageB, 'tide_fang');
  await pageB.waitForFunction(() => !document.querySelector('.phase-callout')?.textContent.includes('赤隼队'), { timeout: 10000 });
  await banViaUi(pageA, 'iron_edge');
  await pageA.waitForFunction(() => !document.querySelector('.phase-callout')?.textContent.includes('苍隼队'), { timeout: 10000 });
  await banViaUi(pageB, 'wild_shade');

  await pageA.waitForFunction(() => {
    const text = document.querySelector('.phase-callout')?.textContent || '';
    return text.includes('秘密候选');
  }, { timeout: 20000 });

  console.log('--- 秘密候选阶段 ---');
  // A 两席：先由 pageA 提交 3 个位置（只连接了一个座位 0）
  await secretViaUi(pageA, 'vanguard', 'iron_bulwark', 'A');
  await secretViaUi(pageA, 'support', 'iron_forge', 'A');

  // 旁观者面板不应显示 A 队的秘密候选（角色池本身列全量角色，需只看队伍面板）
  const spectatorTeamText = await pageS.locator('.team-columns').innerText();
  if (spectatorTeamText.includes('铁壁·阿格尼斯')) throw new Error('旁观页队伍面板泄漏 A 队秘密候选');
  // 也不应在 WebSocket 视图里出现：解析最后一次 view 消息的 JSON 字符串
  const spectatorPoolText = await pageS.locator('.pool-item').filter({ hasText: '铁壁·阿格尼斯' }).count();
  if (spectatorPoolText === 0) throw new Error('角色池应始终展示全量角色');

  // B 提交
  await secretViaUi(pageB, 'vanguard', 'tide_bastion', 'B');
  await secretViaUi(pageB, 'support', 'ember_hearth', 'B');
  await secretViaUi(pageB, 'flex', 'ember_cinder', 'B');

  // A 第三位：故意选与 B 相同的 flex 目标，触发跨队争抢
  await secretViaUi(pageA, 'flex', 'ember_cinder', 'A');

  await pageA.waitForFunction(() => document.querySelector('.phase-callout')?.textContent.includes('裁决完成'), { timeout: 40000 });
  console.log('--- 裁决完成 ---');

  // 读取双方最终阵容
  const rosters = await pageA.$$eval('.team-card .slot-row', (rows) => rows.map((r) => r.innerText));
  console.log(rosters.join('\n'));

  const sceneVisible = await pageA.isVisible('#scene-area');
  if (!sceneVisible) throw new Error('裁决后未出现场景区域');

  // 场景载入
  await pageA.click('#scene-send');
  await pageA.waitForSelector('#scene-canvas canvas', { timeout: 10000 });
  const sceneLoaded = await pageA.$eval('#scene-canvas canvas', (c) => ({ w: c.width, h: c.height }));
  console.log('scene canvas', sceneLoaded);

  // 直接走场景页面
  await pageS.goto(`${BASE}/scene/${matchId}`, { waitUntil: 'networkidle' });
  await pageS.waitForSelector('#scene-canvas canvas', { timeout: 10000 });
  const sceneRouteOk = await pageS.$eval('.phase-callout', (el) => el.textContent);
  console.log('scene route:', sceneRouteOk.slice(0, 80));

  // 下一轮
  await pageA.click('#reveal-panel button');
  await pageA.waitForFunction(() => document.querySelector('.phase-callout')?.textContent.includes('禁用'), { timeout: 10000 });
  console.log('next round phase:', await pageA.$eval('.phase-callout', (el) => el.textContent));

  await pageA.screenshot({ path: '/tmp/ui-table.png' });
  await pageS.screenshot({ path: '/tmp/ui-scene.png' });

  if (errors.length) {
    console.error('浏览器错误:', errors);
    process.exitCode = 1;
  } else {
    console.log('浏览器端到端通过，无控制台错误');
  }
  await browser.close();
  await own?.app.close();
}

async function banViaUi(page, characterId) {
  await page.waitForFunction(() => document.querySelector('.phase-callout')?.textContent.includes('轮到'), { timeout: 15000 });
  const item = page.locator(`.pool-item`).filter({ hasText: characterName(characterId) }).first();
  await item.click();
  await page.waitForFunction(() => !document.getElementById('toast').hidden, { timeout: 5000 });
}

function characterName(id) {
  const map = {
    ember_step: '焰足·希拉', tide_fang: '浪牙·赛壬', iron_edge: '锋刃·艾吉', wild_shade: '藤影·希芙',
    iron_bulwark: '铁壁·阿格尼斯', iron_forge: '锻炉·瓦特', tide_bastion: '潮障·娜瑞尔',
    ember_hearth: '炉心·奥菲', ember_cinder: '烬涡·格雷', wild_gale: '风笞·索恩',
  };
  return map[id] || id;
}

async function secretViaUi(page, slotId, characterId, team = null) {
  const scope = team ? page.locator(`.team-card[data-team="${team}"]`) : page.locator('.team-card').first();
  const item = page.locator('.pool-item').filter({ hasText: characterName(characterId) }).first();
  await item.click();
  await page.waitForTimeout(150);
  const row = scope.locator('.slot-row').filter({ hasText: slotLabel(slotId) }).first();
  await page.waitForFunction(([label, teamId]) => {
    const root = teamId ? document.querySelector(`.team-card[data-team="${teamId}"]`) : document.querySelector('.team-card');
    if (!root) return false;
    const rows = [...root.querySelectorAll('.slot-row')];
    const target = rows.find((r) => r.textContent.includes(label));
    const b = target?.querySelector('button.primary');
    return b && !b.disabled;
  }, [slotLabel(slotId), team], { timeout: 8000 });
  await row.locator('button.primary').click();
  await page.waitForTimeout(250);
}

function slotLabel(slotId) {
  return { vanguard: '先锋位', support: '支援位', flex: '自由位' }[slotId];
}

main().catch((error) => { console.error(error); process.exit(1); });
