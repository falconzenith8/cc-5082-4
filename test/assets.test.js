import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRoster, DEFAULT_ROSTER_SEED } from '../shared/roster-generator.js';
import { generatePortraits, verifyAssets, renderPortraitSvg } from '../shared/assets.js';

test('SVG 头像确定性：同一角色重复渲染内容一致', () => {
  const roster = generateRoster(DEFAULT_ROSTER_SEED);
  const c = roster.characters[0];
  assert.equal(renderPortraitSvg(c), renderPortraitSvg(c));
  assert.ok(renderPortraitSvg(c).includes('<svg'));
  assert.ok(renderPortraitSvg(c).includes(c.name.replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]))));
});

test('资源生成后校验通过：文件存在且哈希匹配', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assets-ok-'));
  try {
    const roster = generateRoster(DEFAULT_ROSTER_SEED);
    await generatePortraits(roster, { outputRoot: dir });
    const result = await verifyAssets(roster, { outputRoot: dir });
    assert.equal(result.ok, true);
    assert.equal(result.checked, roster.characters.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('缺失素材文件产生带路径的可定位错误', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assets-missing-'));
  try {
    const roster = generateRoster(DEFAULT_ROSTER_SEED);
    const manifest = await generatePortraits(roster, { outputRoot: dir });
    // 删除其中一张头像
    const target = manifest.files[3];
    await rm(join(dir, target.rel), { force: true });
    await assert.rejects(
      () => verifyAssets(roster, { outputRoot: dir }),
      (error) => {
        assert.equal(error.code, 'asset-verify-failed');
        assert.ok(error.locations.some((l) => l.code === 'missing-asset-file' && l.characterId === target.characterId));
        assert.ok(error.message.includes(target.characterId));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('素材被篡改导致哈希不匹配时报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assets-tamper-'));
  try {
    const roster = generateRoster(DEFAULT_ROSTER_SEED);
    const manifest = await generatePortraits(roster, { outputRoot: dir });
    const target = manifest.files[0];
    const file = join(dir, target.rel);
    const original = await readFile(file, 'utf8');
    await writeFile(file, `${original}<!-- tampered -->`, 'utf8');
    await assert.rejects(
      () => verifyAssets(roster, { outputRoot: dir }),
      (error) => {
        assert.equal(error.code, 'asset-verify-failed');
        assert.ok(error.locations.some((l) => l.code === 'asset-hash-mismatch' && l.characterId === target.characterId));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('种子不匹配时报错，避免用错角色池的资源', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'assets-seed-'));
  try {
    const rosterA = generateRoster(DEFAULT_ROSTER_SEED);
    await generatePortraits(rosterA, { outputRoot: dir });
    const rosterB = generateRoster('different-seed');
    await assert.rejects(
      () => verifyAssets(rosterB, { outputRoot: dir }),
      (error) => error.locations.some((l) => l.code === 'seed-mismatch'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
