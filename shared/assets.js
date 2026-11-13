// 可视化资源生成与校验：每名角色一张确定性 SVG 头像（同种子重建像素级一致），
// 并产出带内容哈希的资源清单。缺失素材或失效引用在这里产生带文件路径的可定位错误。
import { createHash } from 'node:crypto';
import { writeFile, mkdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rng } from './rng.js';
import { FACTIONS, ROLES, portraitPath } from './roster-generator.js';

export const ASSETS_SCHEMA = 'arena-assets@1';
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const PUBLIC_DIR = join(ROOT, 'public');
export const PORTRAIT_DIR = join(PUBLIC_DIR, 'assets', 'portraits');
export const ASSET_MANIFEST_PATH = join(PUBLIC_DIR, 'assets', 'manifest.json');

function esc(value) {
  return String(value).replace(/[<>&"]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
}

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const clamp = (v) => Math.max(0, Math.min(255, v));
  const r = clamp(Math.round(((n >> 16) & 255) * factor));
  const g = clamp(Math.round(((n >> 8) & 255) * factor));
  const b = clamp(Math.round((n & 255) * factor));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// 头像的几何布局由角色 id 派生出的 Rng 决定，同种子/同 id 永远生成相同 SVG。
export function renderPortraitSvg(character) {
  const faction = FACTIONS[character.faction];
  const role = ROLES[character.role];
  const rng = new Rng(`portrait:${character.id}`);
  const accents = Array.from({ length: 5 }, () => ({
    cx: rng.int(16, 184),
    cy: rng.int(16, 224),
    r: rng.int(8, 34),
    o: 0.08 + rng.next() * 0.18,
  }));
  const facets = Array.from({ length: 3 }, () => ({
    x: rng.int(-20, 140),
    y: rng.int(-10, 200),
    size: rng.int(28, 64),
    rotate: rng.int(0, 60),
  }));
  const accent = faction.color;
  const dark = shade(accent, 0.45);
  const light = shade(accent, 1.25);
  const glyph = esc(role.short);
  const initials = esc(character.name.split('·').pop().slice(0, 2));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240" viewBox="0 0 200 240" role="img" aria-label="${esc(character.name)}">
  <defs>
    <linearGradient id="bg-${esc(character.id)}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${dark}"/>
      <stop offset="1" stop-color="#0b1220"/>
    </linearGradient>
  </defs>
  <rect width="200" height="240" fill="url(#bg-${esc(character.id)})"/>
  ${accents.map((a) => `<circle cx="${a.cx}" cy="${a.cy}" r="${a.r}" fill="${accent}" opacity="${a.o.toFixed(3)}"/>`).join('\n  ')}
  ${facets.map((f) => `<rect x="${f.x}" y="${f.y}" width="${f.size}" height="${f.size}" rx="8" transform="rotate(${f.rotate} ${f.x} ${f.y})" fill="${light}" opacity="0.10"/>`).join('\n  ')}
  <circle cx="100" cy="92" r="46" fill="#0a101c" stroke="${accent}" stroke-width="4"/>
  <text x="100" y="110" text-anchor="middle" font-size="44" font-weight="700" fill="${accent}" font-family="sans-serif">${glyph}</text>
  <text x="100" y="182" text-anchor="middle" font-size="26" font-weight="700" fill="#e8eef8" font-family="sans-serif">${initials}</text>
  <text x="100" y="212" text-anchor="middle" font-size="14" fill="${light}" font-family="sans-serif">${esc(role.name)} · ${esc(faction.name)}</text>
</svg>
`;
}

function hashContent(content) {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// 生成全部头像并写清单；返回清单对象（不落盘时可用于内存校验）。
export async function generatePortraits(roster, { outputRoot = PUBLIC_DIR, write = true } = {}) {
  const dir = join(outputRoot, 'assets', 'portraits');
  if (write) await mkdir(dir, { recursive: true });
  const files = [];
  for (const character of roster.characters) {
    const svg = renderPortraitSvg(character);
    const rel = `assets/portraits/${character.id}.svg`;
    const absolute = join(outputRoot, rel.split('/').join(sep));
    if (write) await writeFile(absolute, svg, 'utf8');
    files.push({
      characterId: character.id,
      path: portraitPath(character.id),
      rel,
      bytes: Buffer.byteLength(svg, 'utf8'),
      sha256: hashContent(svg),
    });
  }
  const manifest = {
    schema: ASSETS_SCHEMA,
    rosterSeed: roster.seed,
    generatedAt: 'deterministic',
    count: files.length,
    files,
  };
  if (write) {
    await mkdir(dirname(join(outputRoot, 'assets', 'manifest.json')), { recursive: true });
    await writeFile(join(outputRoot, 'assets', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  return manifest;
}

export async function loadManifest(manifestPath = ASSET_MANIFEST_PATH) {
  const raw = await readFile(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);
  if (manifest.schema !== ASSETS_SCHEMA) {
    const error = new Error(`${manifestPath}: 资源清单 schema 为 ${manifest.schema}，期望 ${ASSETS_SCHEMA}`);
    error.code = 'asset-manifest-schema';
    throw error;
  }
  return manifest;
}

// 校验清单：角色引用的每个素材都存在、可读、哈希一致；失效引用直接报出具体路径与角色。
export async function verifyAssets(roster, { outputRoot = PUBLIC_DIR, manifestPath } = {}) {
  const errors = [];
  let manifest = null;
  const resolvedManifest = manifestPath || join(outputRoot, 'assets', 'manifest.json');
  try {
    manifest = await loadManifest(resolvedManifest);
  } catch (error) {
    errors.push({ code: 'manifest-unreadable', path: resolvedManifest, message: error.message });
  }
  if (manifest) {
    if (manifest.rosterSeed !== roster.seed) {
      errors.push({
        code: 'seed-mismatch',
        path: resolvedManifest,
        message: `清单种子 ${manifest.rosterSeed} 与角色池种子 ${roster.seed} 不一致，请重新生成资源`,
      });
    }
    const byId = new Map(manifest.files.map((f) => [f.characterId, f]));
    for (const character of roster.characters) {
      const entry = byId.get(character.id);
      if (!entry) {
        errors.push({ code: 'missing-manifest-entry', characterId: character.id, path: character.portrait, message: '资源清单缺少该角色的素材记录' });
        continue;
      }
      const absolute = join(outputRoot, entry.rel.split('/').join(sep));
      if (!existsSync(absolute)) {
        errors.push({ code: 'missing-asset-file', characterId: character.id, path: absolute, message: '清单声明的素材文件不存在' });
        continue;
      }
      let fileStat;
      try {
        fileStat = await stat(absolute);
      } catch (error) {
        errors.push({ code: 'asset-unreadable', characterId: character.id, path: absolute, message: error.message });
        continue;
      }
      if (!fileStat.isFile()) {
        errors.push({ code: 'asset-not-file', characterId: character.id, path: absolute });
        continue;
      }
      const content = await readFile(absolute, 'utf8');
      const actualHash = hashContent(content);
      if (actualHash !== entry.sha256) {
        errors.push({
          code: 'asset-hash-mismatch',
          characterId: character.id,
          path: absolute,
          message: `期望 sha256:${entry.sha256}，实际 sha256:${actualHash}`,
        });
      }
      if (character.portrait !== entry.path) {
        errors.push({
          code: 'portrait-path-mismatch',
          characterId: character.id,
          message: `角色声明 ${character.portrait}，清单记录 ${entry.path}`,
        });
      }
    }
    const rosterIds = new Set(roster.characters.map((c) => c.id));
    for (const entry of manifest.files) {
      if (!rosterIds.has(entry.characterId)) {
        errors.push({ code: 'orphan-asset', characterId: entry.characterId, path: entry.rel, message: '素材在清单中但角色池已无此角色' });
      }
    }
  }
  if (errors.length) {
    const error = new Error(`可视化资源校验失败：\n - ${errors.map((e) => `${e.code} @ ${e.path || e.characterId}: ${e.message || ''}`).join('\n - ')}`);
    error.code = 'asset-verify-failed';
    error.locations = errors;
    throw error;
  }
  return { ok: true, checked: roster.characters.length, manifest };
}
