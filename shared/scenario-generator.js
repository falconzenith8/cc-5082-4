// 情境生成器：用固定种子确定性地产出角色池与「提交序列」（脚本选手要发送的意图）。
// 关键约束：情境文件只描述操作（做什么）和希望触发的规则关系（验证什么），
// 绝不预填期望选角结果/最终阵容——所有结果只能来自服务端裁决。
import { Rng } from './rng.js';
import { generateRoster, DEFAULT_ROSTER_SEED, areMutex } from './roster-generator.js';

export const SCENARIO_SCHEMA = 'arena-scenario@1';

// 操作类型：ban（带轮次回合）、secret（带窗口与阵容位）、presence（掉线/回归）、
// peek-secret（越权反例：用错误令牌/旁观者身份尝试读取他队秘密，预期被服务端拒绝）。
function step({ at, type, team, seat = 0, slotId = null, role = null, characterId = null, turnId = null, windowId = null, connected = null, useToken = null, note = '' }) {
  return {
    at, type, team, seat, slotId, role, characterId, turnId, windowId, connected, useToken, note,
  };
}

function pickByRole(pool, role, { exclude = new Set(), slotAcceptsList = null } = {}) {
  return pool.find((c) =>
    (slotAcceptsList ? slotAcceptsList.includes(c.role) : c.role === role)
    && !exclude.has(c.id)) || null;
}

// 按种子从池中确定性挑一个角色；意图本身由脚本在真实协议里发送，结果不写死。
function seededChoice(rng, pool, predicate, exclude) {
  const options = pool.filter((c) => predicate(c) && !exclude.has(c.id));
  if (!options.length) return null;
  return options[Math.floor(rng.next() * options.length)];
}

// 情境一：正常轮换。完整禁用轮换 + 两队秘密候选 + 改选，验证轮次身份、幂等、正常到期公开。
function buildRotationScenario(roster, rng) {
  const pool = roster.characters;
  const script = { A: [], B: [] };
  let at = 100;
  const banned = new Set();
  // 4 次禁用（每队 2 次），按 A/B/A/B 轮换；禁用候选由种子挑决斗/控制，避免耗尽必需定位。
  const order = ['A', 'B', 'A', 'B'];
  order.forEach((team, index) => {
    const choice = seededChoice(rng, pool, (c) => c.role === 'duelist' || c.role === 'control', banned);
    banned.add(choice.id);
    script[team].push(step({
      at, type: 'ban', team, seat: 0, turnId: `r1-ban${index}`, characterId: choice.id,
      note: `第 ${index + 1} 次轮换禁用`,
    }));
    at += 250;
  });
  // 秘密候选：两队各填三个阵容位；A 队先提交再改选一次以验证 revision。
  const windowId = 'r1-secret';
  const usedA = new Set();
  const slotRoles = { vanguard: ['vanguard'], support: ['support'], flex: ['duelist', 'control'] };
  for (const [slotId, roles] of Object.entries(slotRoles)) {
    const choice = seededChoice(rng, pool, (c) => roles.includes(c.role) && !banned.has(c.id), usedA);
    usedA.add(choice.id);
    script.A.push(step({ at, type: 'secret', team: 'A', seat: 0, slotId, windowId, characterId: choice.id, note: 'A 队初次提交' }));
    at += 200;
  }
  // A 队改选自由位（revision 规则）
  const reviseTarget = seededChoice(
    rng, pool,
    (c) => (c.role === 'duelist' || c.role === 'control') && !banned.has(c.id) && !usedA.has(c.id),
    new Set(),
  );
  script.A.push(step({ at, type: 'secret', team: 'A', seat: 0, slotId: 'flex', windowId, characterId: reviseTarget.id, note: 'A 队截止前改选自由位' }));
  usedA.add(reviseTarget.id);
  at += 200;
  const usedB = new Set();
  for (const [slotId, roles] of Object.entries(slotRoles)) {
    const choice = seededChoice(rng, pool, (c) => roles.includes(c.role) && !banned.has(c.id) && !usedB.has(c.id), new Set());
    usedB.add(choice.id);
    script.B.push(step({ at, type: 'secret', team: 'B', seat: 0, slotId, windowId, characterId: choice.id, note: 'B 队提交' }));
    at += 200;
  }
  // 一条重复 intentId 的重放（脚本侧重发完全相同的意图），验证幂等拒绝。
  const lastSecret = script.B[script.B.length - 1];
  script.B.push({ ...lastSecret, at: at + 100, note: '相同意图重放，预期 duplicate-intent', replay: true });

  return {
    id: 'rotation',
    title: '正常轮换：完整禁用 → 秘密候选 → 到期公开',
    instructions: [
      '服务端创建对局后，A/B 两队脚本座位按 turnId 顺序完成 4 次轮换禁用。',
      '进入秘密窗口后两队提交三个阵容位，A 队对自由位改选一次，B 队重放一条相同 intentId。',
      '推进到秘密窗口截止，由服务端一次性裁决并公开正式阵容。',
      '旁观页与座位页并排打开，观察秘密候选在裁决前只对本队可见。',
    ],
    expectRules: [
      'ban-turn-rotation',
      'stale-turn-guard',
      'secret-isolation-before-reveal',
      'intent-idempotency',
      'secret-revision',
      'deadline-adjudication',
      'cross-team-unique-lock',
    ],
    rules: {
      banTurnsPerTeam: 2,
      factionCap: 2,
      minFactions: 2,
      slotPlan: ['vanguard', 'support', 'flex'],
      timers: { banMs: 60000, secretMs: 60000, awayGraceMs: 8000 },
    },
    script,
  };
}

// 情境二：候选耗尽。规则把池压缩到两队无法各取不重叠阵容，验证 failed 且不生成锁/场景。
function buildExhaustionScenario(roster, rng) {
  const pool = roster.characters;
  // 用 slotPlan 只含先锋+支援，并由脚本禁用到只剩 1 名先锋：两队无法各锁一名先锋。
  const vanguards = pool.filter((c) => c.role === 'vanguard');
  const banned = new Set();
  const script = { A: [], B: [] };
  let at = 100;
  // 需要禁用 (vanguard 数量 - 1) 名先锋；banTurnsPerTeam 设为足够大。
  const toBan = vanguards.slice(0, vanguards.length - 1);
  const turnsNeeded = toBan.length;
  const order = Array.from({ length: turnsNeeded }, (_, i) => (i % 2 === 0 ? 'A' : 'B'));
  toBan.forEach((character, index) => {
    const team = order[index];
    banned.add(character.id);
    script[team].push(step({
      at, type: 'ban', team, seat: 0, turnId: `r1-ban${index}`, characterId: character.id,
      note: '禁掉一名先锋，压缩先锋位候选',
    }));
    at += 200;
  });
  // 秘密阶段两队都申请仅剩的那名先锋，制造无解争抢（不预填结果，只发意图）。
  const lastVanguard = pool.find((c) => c.role === 'vanguard' && !banned.has(c.id));
  const supports = pool.filter((c) => c.role === 'support' && !banned.has(c.id));
  script.A.push(step({ at, type: 'secret', team: 'A', seat: 0, slotId: 'vanguard', windowId: 'r1-secret', characterId: lastVanguard.id, note: 'A 申请唯一先锋' }));
  at += 150;
  script.B.push(step({ at, type: 'secret', team: 'B', seat: 0, slotId: 'vanguard', windowId: 'r1-secret', characterId: lastVanguard.id, note: 'B 申请同一先锋' }));
  at += 150;
  script.A.push(step({ at, type: 'secret', team: 'A', seat: 0, slotId: 'support', windowId: 'r1-secret', characterId: supports[0].id }));
  at += 150;
  script.B.push(step({ at, type: 'secret', team: 'B', seat: 0, slotId: 'support', windowId: 'r1-secret', characterId: supports[1].id }));
  void rng;

  return {
    id: 'exhaustion',
    title: '候选耗尽：先锋位被禁到无法组成两队不重叠阵容',
    instructions: [
      '按脚本顺序禁用先锋，直到全池只剩一名先锋角色。',
      '秘密窗口两队都申请该先锋，并各自提交支援位。',
      '推进截止时间，观察服务端裁决：不得生成任何阵容锁或比赛场景。',
    ],
    expectRules: [
      'no-disjoint-lineup',
      'failed-produces-no-locks',
      'scene-409-before-reveal',
    ],
    rules: {
      banTurnsPerTeam: Math.ceil(turnsNeeded / 2),
      factionCap: 3,
      minFactions: 1,
      slotPlan: ['vanguard', 'support'],
      timers: { banMs: 60000, secretMs: 60000, awayGraceMs: 8000 },
    },
    script,
  };
}

// 情境三：队员掉线。座位断开触发暂离，全队离线超宽限提前裁决；回归后意图恢复。
function buildDisconnectScenario(roster, rng) {
  const pool = roster.characters;
  const script = { A: [], B: [] };
  let at = 100;
  const banned = new Set();
  // A 队完成第一次禁用后，A 队两席掉线；B 队继续。
  const firstBan = seededChoice(rng, pool, (c) => c.role === 'duelist', banned);
  banned.add(firstBan.id);
  script.A.push(step({ at, type: 'ban', team: 'A', seat: 0, turnId: 'r1-ban0', characterId: firstBan.id, note: 'A 第一次禁用' }));
  at += 200;
  script.A.push(step({ at, type: 'presence', team: 'A', seat: 0, connected: false, note: 'A 指挥席掉线' }));
  script.A.push(step({ at: at + 50, type: 'presence', team: 'A', seat: 1, connected: false, note: 'A 副手席掉线（全队暂离）' }));
  at += 300;
  const secondBan = seededChoice(rng, pool, (c) => c.role === 'control' && !banned.has(c.id), new Set());
  banned.add(secondBan.id);
  script.B.push(step({ at, type: 'ban', team: 'B', seat: 0, turnId: 'r1-ban1', characterId: secondBan.id, note: 'B 在 A 暂离期间禁用' }));
  at += 200;
  // A 队回归
  script.A.push(step({ at, type: 'presence', team: 'A', seat: 0, connected: true, note: 'A 指挥席回归' }));
  at += 200;
  // 秘密阶段：B 队两席提交后整体掉线，触发 both-teams-away 提前裁决路径需要两队都离；
  // 这里让 B 提交完再掉线，A 只交部分，验证暂离座位意图被拒与默认补位。
  const windowId = 'r1-secret';
  const support = pool.find((c) => c.role === 'support' && !banned.has(c.id));
  script.B.push(step({ at, type: 'secret', team: 'B', seat: 0, slotId: 'support', windowId, characterId: support.id, note: 'B 提交支援' }));
  at += 150;
  // A 指挥席在掉线状态尝试提交（脚本先标记离线再发意图），预期 seat-away。
  script.A.push(step({ at, type: 'presence', team: 'A', seat: 0, connected: false, note: 'A 再次掉线' }));
  at += 100;
  const vanguard = pool.find((c) => c.role === 'vanguard' && !banned.has(c.id));
  script.A.push(step({ at, type: 'secret', team: 'A', seat: 0, slotId: 'vanguard', windowId, characterId: vanguard.id, note: '离线座位提交，预期 seat-away 拒绝' }));
  at += 100;
  script.A.push(step({ at, type: 'presence', team: 'A', seat: 0, connected: true, note: 'A 回归，剩余位置由默认策略补位' }));

  return {
    id: 'disconnect',
    title: '队员掉线：暂离拒绝意图、宽限计时与回归恢复',
    instructions: [
      'A 队完成首次禁用后两席先后掉线，观察 presence 与全队暂离时间。',
      'B 队在对方暂离期间继续操作；A 队回归后再次掉线并尝试提交秘密候选。',
      '离线座位的意图必须被服务端拒绝（seat-away）；回归后未提交位置在截止时默认补位。',
      '可手动断开全部四个座位，验证双方离线超过宽限会提前触发默认裁决。',
    ],
    expectRules: [
      'presence-away-tracking',
      'seat-away-reject',
      'away-grace-deadline',
      'both-teams-away-adjudication',
      'default-fill-on-missing',
    ],
    rules: {
      banTurnsPerTeam: 1,
      factionCap: 2,
      minFactions: 2,
      slotPlan: ['vanguard', 'support', 'flex'],
      timers: { banMs: 60000, secretMs: 60000, awayGraceMs: 8000 },
    },
    script,
  };
}

// 情境四：越权反例。故意用旁观者/错误队令牌偷看秘密候选，验证公共输出不含隐藏字段。
function buildUnauthorizedScenario(roster, rng) {
  const pool = roster.characters;
  const script = { A: [], B: [] };
  let at = 100;
  const vanguard = pickByRole(pool, 'vanguard');
  const support = pickByRole(pool, 'support');
  script.A.push(step({ at, type: 'secret', team: 'A', seat: 0, slotId: 'vanguard', windowId: 'r1-secret', characterId: vanguard.id, note: 'A 提交秘密先锋' }));
  at += 150;
  script.A.push(step({ at, type: 'secret', team: 'A', seat: 0, slotId: 'support', windowId: 'r1-secret', characterId: support.id, note: 'A 提交秘密支援' }));
  at += 150;
  // 反例操作：旁观者尝试拉取 A 队座位视图、B 队尝试读取 A 的候选字段。
  const attacks = [
    step({ at, type: 'peek-secret', team: 'A', seat: 0, useToken: 'spectator', note: '旁观者无令牌请求座位视图' }),
    step({ at: at + 100, type: 'peek-secret', team: 'A', seat: 0, useToken: 'B0', note: 'B 队令牌尝试读取 A 队秘密' }),
    step({ at: at + 200, type: 'peek-secret', team: 'A', seat: 0, useToken: 'forged-token', note: '伪造令牌尝试越权' }),
  ];
  void rng;
  return {
    id: 'unauthorized-peek',
    title: '越权反例：偷看他队秘密候选必须失败，公共输出无隐藏字段',
    instructions: [
      'A 队先提交两个秘密候选，确保存在「隐藏信息」可供反例尝试窃取。',
      '依次以旁观者身份、B 队座位令牌、伪造令牌请求 A 队的座位视图/秘密字段。',
      '所有越权请求必须被服务端拒绝或降级为公共视图；断言任何返回体都不含 A 队候选角色 id。',
      '裁决后再检查：秘密只在 reveal 之后随正式阵容公开，公开时间点之前公开通道零泄漏。',
    ],
    expectRules: [
      'spectator-no-secret-field',
      'opponent-only-submit-count',
      'forged-token-rejected',
      'public-payload-no-hidden-id',
      'reveal-timing',
    ],
    rules: {
      banTurnsPerTeam: 0,
      factionCap: 2,
      minFactions: 2,
      slotPlan: ['vanguard', 'support', 'flex'],
      timers: { banMs: 60000, secretMs: 60000, awayGraceMs: 8000 },
    },
    script,
    attacks,
  };
}

export function generateScenarios(seed = DEFAULT_ROSTER_SEED) {
  const roster = generateRoster(seed);
  const rng = new Rng(`${seed}:scenarios`);
  const scenarios = [
    buildRotationScenario(roster, rng.fork('rotation')),
    buildExhaustionScenario(roster, rng.fork('exhaustion')),
    buildDisconnectScenario(roster, rng.fork('disconnect')),
    buildUnauthorizedScenario(roster, rng.fork('peek')),
  ];
  // 自检：情境不得预填裁决结果，只能包含操作与规则关系。
  for (const scenario of scenarios) {
    const serialized = JSON.stringify(scenario);
    if (/"rosters"|"finalLineup"|"expectedResult"|"winner"/.test(serialized)) {
      const error = new Error(`情境 ${scenario.id} 预填了选角结果，违反「结果只能来自服务端裁决」约束`);
      error.code = 'scenario-prebaked-result';
      throw error;
    }
    for (const team of ['A', 'B']) {
      for (const item of scenario.script[team]) {
        if (item.characterId && !roster.characters.some((c) => c.id === item.characterId)) {
          const error = new Error(`情境 ${scenario.id} 引用了角色池中不存在的角色 ${item.characterId}`);
          error.code = 'scenario-bad-character-ref';
          throw error;
        }
      }
    }
  }
  return {
    schema: SCENARIO_SCHEMA,
    seed,
    rosterSeed: roster.seed,
    scenarios,
  };
}

export { areMutex };
