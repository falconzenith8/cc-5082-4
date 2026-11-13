#!/usr/bin/env node
// 资源构建：用固定种子重建角色池 -> 生成全部 SVG 头像与清单 -> 生成情境文件。
// 同种子重复运行产物字节一致；用法：node scripts/build-resources.js [--seed <seed>] [--out <dir>]
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRoster, DEFAULT_ROSTER_SEED } from '../shared/roster-generator.js';
import { generatePortraits, verifyAssets, PUBLIC_DIR } from '../shared/assets.js';
import { generateScenarios } from '../shared/scenario-generator.js';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const seed = arg('--seed', DEFAULT_ROSTER_SEED);
const outDir = resolve(arg('--out', PUBLIC_DIR));
const dataDir = resolve(fileURLToPath(new URL('../data', import.meta.url)));

const roster = generateRoster(seed);
console.log(`[build] 角色池 seed=${seed} 角色=${roster.characters.length} 互斥关系=${roster.mutexes.length}`);

const manifest = await generatePortraits(roster, { outputRoot: outDir, write: true });
console.log(`[build] 已写入 ${manifest.count} 张头像与资源清单 -> ${join(outDir, 'assets')}`);

await verifyAssets(roster, { outputRoot: outDir });
console.log('[build] 资源校验通过：所有素材存在且哈希一致');

await mkdir(dataDir, { recursive: true });
const rosterFile = join(dataDir, 'roster.json');
await writeFile(rosterFile, `${JSON.stringify(roster, null, 2)}\n`, 'utf8');
console.log(`[build] 角色池清单 -> ${rosterFile}`);

const scenarioBundle = generateScenarios(seed);
const scenarioFile = join(dataDir, 'scenarios.json');
await writeFile(scenarioFile, `${JSON.stringify(scenarioBundle, null, 2)}\n`, 'utf8');
console.log(`[build] 情境 ${scenarioBundle.scenarios.length} 个 -> ${scenarioFile}`);
console.log('[build] 完成');
