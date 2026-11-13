#!/usr/bin/env node
// 资源校验 CLI：检查角色池结构、素材文件存在性与哈希、情境引用完整性。
// 缺失素材或失效角色引用会以非零退出码和带路径的错误信息失败。
// 用法：node scripts/verify-resources.js [--seed <seed>] [--public <dir>] [--data <dir>]
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRoster, validateRosterShape, DEFAULT_ROSTER_SEED } from '../shared/roster-generator.js';
import { verifyAssets, PUBLIC_DIR } from '../shared/assets.js';
import { SCENARIO_SCHEMA } from '../shared/scenario-generator.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const seed = arg('--seed', DEFAULT_ROSTER_SEED);
const publicDir = resolve(arg('--public', PUBLIC_DIR));
const dataDir = resolve(arg('--data', fileURLToPath(new URL('../data', import.meta.url))));

const failures = [];
const fail = (error) => {
  failures.push(error);
  console.error(`[verify] ✗ ${error.code || 'error'}: ${error.message}`);
  if (error.locations) for (const loc of error.locations) console.error(`         - ${loc}`);
};

// 1. 角色池结构（含互斥引用有效性）
let roster;
try {
  roster = generateRoster(seed);
  validateRosterShape(roster);
  console.log(`[verify] ✓ 角色池结构：${roster.characters.length} 角色 / ${roster.mutexes.length} 互斥关系`);
} catch (error) {
  fail(error);
  process.exit(1);
}

// 2. 与落盘的 roster.json 一致性（若存在）
try {
  const saved = JSON.parse(await readFile(join(dataDir, 'roster.json'), 'utf8'));
  if (JSON.stringify(saved) !== JSON.stringify(roster)) {
    fail({ code: 'roster-rebuild-mismatch', message: 'data/roster.json 与固定种子重建结果不一致，请重新运行 build-resources' });
  } else {
    console.log('[verify] ✓ data/roster.json 可由固定种子字节级重建');
  }
} catch (error) {
  if (error.code !== 'ENOENT') fail(error);
  else console.log('[verify] · data/roster.json 不存在，跳过重建比对（先运行 build-resources 生成）');
}

// 3. 可视化资源
try {
  const result = await verifyAssets(roster, { outputRoot: publicDir });
  console.log(`[verify] ✓ 可视化资源：${result.checked} 个素材全部存在且哈希匹配`);
} catch (error) {
  fail(error);
}

// 4. 情境引用与 schema
try {
  const bundle = JSON.parse(await readFile(join(dataDir, 'scenarios.json'), 'utf8'));
  if (bundle.schema !== SCENARIO_SCHEMA) throw new Error(`情境 schema ${bundle.schema} 不匹配`);
  const ids = new Set(roster.characters.map((c) => c.id));
  for (const scenario of bundle.scenarios) {
    for (const team of ['A', 'B']) {
      for (const item of scenario.script[team]) {
        if (item.characterId && !ids.has(item.characterId)) {
          fail({
            code: 'scenario-bad-character-ref',
            message: `情境 ${scenario.id} / ${team} 引用失效角色 ${item.characterId}（操作：${item.note || item.type}）`,
          });
        }
      }
    }
    if (!Array.isArray(scenario.expectRules) || !scenario.expectRules.length) {
      fail({ code: 'scenario-missing-rules', message: `情境 ${scenario.id} 缺少 expectRules` });
    }
  }
  console.log(`[verify] ✓ 情境包：${bundle.scenarios.length} 个情境，角色引用全部有效`);
} catch (error) {
  if (error.code === 'ENOENT') console.log('[verify] · data/scenarios.json 不存在，跳过情境校验');
  else fail(error);
}

if (failures.length) {
  console.error(`[verify] 失败 ${failures.length} 项`);
  process.exit(1);
}
console.log('[verify] 全部通过');
