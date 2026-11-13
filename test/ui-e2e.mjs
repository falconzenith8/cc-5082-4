// 浏览器端到端：两队在真实界面点击操作，验证服务端采用意图、秘密隔离、视图切换、
// 互斥禁用、公开裁决与场景载入。默认自起独立服务器；已有服务器时用 BASE_URL 指向它。
import { chromium } from 'playwright';
import { createApp } from '../server/index.js';
import { CHARACTER_POOL, MUTEXES } from '../shared/characters.js';

async function startOwnServer() {
  const app = createApp({ log: () => {} });
  await new Promise((resolve) => app.server.listen(4321, resolve));
  return { app, base: 'http://localhost:4321' };
}

function nameOf(id) {
  return CHARACTER_POOL.find((c) => c.id === id)?.name || id;
}

// 按定位动态挑选角色，并避开与已选角色互斥的 id（不在界面里写死任何选角结果）。
function pickByRole(role, chosen = [], acceptRoles = null) {
  const blocked = new Set(chosen.flatMap((id) =>
    MUTEXES.filter((p) => p.a === id || p.b === id).map((p) => (p.a === id ? p.b : p.a))));
  const c = CHARACTER_POOL.find((ch) =>
    (acceptRoles ? acceptRoles.includes(ch.role) : ch.role === role)
    && !chosen.includes(ch.id) && !blocked.has(ch.id));
  if (!c) throw new Error(`无可用 ${role} 角色`);
  return c.id;
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
  // 头像由服务端静态资源提供，应成功加载
  const portraitOk = await pageA.locator('.pool-item .portrait').first().evaluate((img) => img.complete && img.naturalWidth > 0);
  if (!portraitOk) throw new Error('角色头像未加载');
  console.log('--- 头像资源加载正常 ---');

  console.log('--- 禁用阶段（界面点击，服务端裁决）---');
  const banA1 = pickByRole('duelist');
  await banViaUi(pageA, nameOf(banA1));
  await waitPhaseTextLeaves(pageA, '苍隼队');
  const banB1 = pickByRole('control', [banA1]);
  await banViaUi(pageB, nameOf(banB1));
  await waitPhaseTextLeaves(pageB, '赤隼队');
  const banA2 = pickByRole('duelist', [banA1, banB1]);
  await banViaUi(pageA, nameOf(banA2));
  await waitPhaseTextLeaves(pageA, '苍隼队');
  const banB2 = pickByRole('control', [banA1, banB1, banA2]);
  await banViaUi(pageB, nameOf(banB2));

  await pageA.waitForFunction(() => (document.querySelector('.phase-callout')?.textContent || '').includes('秘密候选'), { timeout: 20000 });

  console.log('--- 秘密候选阶段 ---');
  const aVg = pickByRole('vanguard');
  const aSp = pickByRole('support', [aVg]);
  await secretViaUi(pageA, 'vanguard', nameOf(aVg), 'A');
  await secretViaUi(pageA, 'support', nameOf(aSp), 'A');

  // 互斥关系：与 aVg 互斥的角色在 A 的角色池中应被禁用
  const mutexPartner = MUTEXES.find((p) => p.a === aVg || p.b === aVg);
  if (mutexPartner) {
    const partnerId = mutexPartner.a === aVg ? mutexPartner.b : mutexPartner.a;
    const disabled = await pageA.locator('.pool-item').filter({ hasText: nameOf(partnerId) }).isDisabled();
    if (!disabled) throw new Error(`互斥角色 ${partnerId} 应在界面禁用`);
    console.log('--- 互斥角色在界面正确禁用 ---');
  }

  // 队内/公共视图切换：切到公共视图后 A 的队伍面板不得出现本队秘密角色名
  await pageA.click('#view-public');
  await pageA.waitForFunction(() => document.getElementById('view-public').classList.contains('active'));
  const publicTeamText = await pageA.locator('.team-columns').innerText();
  if (publicTeamText.includes(nameOf(aVg))) throw new Error('公共视图泄漏了本队秘密候选');
  const previewPublic = await pageA.locator('.preview-panel .public-col').innerText();
  if (previewPublic.includes(nameOf(aVg))) throw new Error('预览区公共列泄漏秘密候选');
  console.log('--- 公共视图隐藏秘密，预览区只显示提交进度 ---');
  await pageA.click('#view-team');
  await pageA.waitForFunction(() => document.getElementById('view-team').classList.contains('active'));
  const teamPreview = await pageA.locator('.preview-panel .team-col').innerText();
  if (!teamPreview.includes(nameOf(aVg))) throw new Error('队内视图预览应显示本队秘密候选');

  // 旁观者队伍面板同样不得泄漏 A 队秘密
  const spectatorTeamText = await pageS.locator('.team-columns').innerText();
  if (spectatorTeamText.includes(nameOf(aVg))) throw new Error('旁观页队伍面板泄漏 A 队秘密候选');
  if (await pageS.locator('#view-switch').isVisible()) throw new Error('旁观者不应出现视图切换器');

  // B 提交三个位置
  const bVg = pickByRole('vanguard', [aVg, aSp]);
  const bSp = pickByRole('support', [aVg, aSp, bVg]);
  const bFx = pickByRole(null, [aVg, aSp, bVg, bSp], ['duelist', 'control']);
  await secretViaUi(pageB, 'vanguard', nameOf(bVg), 'B');
  await secretViaUi(pageB, 'support', nameOf(bSp), 'B');
  await secretViaUi(pageB, 'flex', nameOf(bFx), 'B');

  // A 自由位
  const aFx = pickByRole(null, [aVg, aSp], ['duelist', 'control']);
  await secretViaUi(pageA, 'flex', nameOf(aFx), 'A');

  await pageA.waitForFunction(() => (document.querySelector('.phase-callout')?.textContent || '').includes('裁决完成'), { timeout: 40000 });
  console.log('--- 服务端裁决完成，正式阵容公开 ---');

  // 预览区公开列应在裁决后显示正式阵容
  const revealedPreview = await pageA.locator('.preview-panel .public-col').innerText();
  if (!revealedPreview.includes(nameOf(aVg))) throw new Error('裁决后预览区应公开正式阵容');

  const rosters = await pageA.$$eval('.team-card .slot-row', (rows) => rows.map((r) => r.innerText));
  console.log(rosters.join('\n'));

  if (!(await pageA.isVisible('#scene-area'))) throw new Error('裁决后未出现场景区域');
  await pageA.click('#scene-send');
  await pageA.waitForSelector('#scene-canvas canvas', { timeout: 10000 });
  const sceneLoaded = await pageA.$eval('#scene-canvas canvas', (c) => ({ w: c.width, h: c.height }));
  console.log('scene canvas', sceneLoaded);

  await pageS.goto(`${BASE}/scene/${matchId}`, { waitUntil: 'networkidle' });
  await pageS.waitForSelector('#scene-canvas canvas', { timeout: 10000 });
  console.log('scene route:', (await pageS.$eval('.phase-callout', (el) => el.textContent)).slice(0, 80));

  await pageA.click('#reveal-panel button');
  await pageA.waitForFunction(() => (document.querySelector('.phase-callout')?.textContent || '').includes('禁用'), { timeout: 10000 });

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

async function waitPhaseTextLeaves(page, teamName) {
  await page.waitForFunction((name) => !(document.querySelector('.phase-callout')?.textContent || '').includes(name), teamName, { timeout: 10000 });
}

async function banViaUi(page, characterName) {
  await page.waitForFunction(() => (document.querySelector('.phase-callout')?.textContent || '').includes('轮到'), { timeout: 15000 });
  await page.locator('.pool-item').filter({ hasText: characterName }).first().click();
  await page.waitForFunction(() => !document.getElementById('toast').hidden, { timeout: 5000 });
}

async function secretViaUi(page, slotId, characterName, team) {
  await page.locator('.pool-item').filter({ hasText: characterName }).first().click();
  await page.waitForTimeout(150);
  const scope = page.locator(`.team-card[data-team="${team}"]`);
  const row = scope.locator('.slot-row').filter({ hasText: slotLabel(slotId) }).first();
  await page.waitForFunction(([label, teamId]) => {
    const root = document.querySelector(`.team-card[data-team="${teamId}"]`);
    if (!root) return false;
    const target = [...root.querySelectorAll('.slot-row')].find((r) => r.textContent.includes(label));
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
