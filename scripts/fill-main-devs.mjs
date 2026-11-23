// 主库开发商补齐：对 dev 为空、且有 VNDB 映射的条目，用 vndb.dv 回填。
// 默认 dry-run；确认后加 --apply 写回 data/galgames.js。
//
// 用法：
//   node scripts/fill-main-devs.mjs
//   node scripts/fill-main-devs.mjs --apply

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const VNDB = path.join(ROOT, 'data', 'vndb.js');
const APPLY = process.argv.includes('--apply');
const CLEAN = process.argv.includes('--clean');

function cleanDev(raw) {
  return String(raw || '').trim()
    .replace(/\s*(co\.,?\s*ltd\.?|co\.?\s*ltd\.?|inc\.?|llc|ltd\.?|corporation|corp\.?|gmbh|株式会社|有限会社|合同会社)\s*$/i, '')
    .trim()
    .replace(/^[·・,，、.\s]+|[·・,，、.\s]+$/g, '');
}

const raw = await readFile(MAIN, 'utf8');
const meta = JSON.parse(raw.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/)[1]);
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const vmap = JSON.parse((await readFile(VNDB, 'utf8')).match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/)[1]).map || {};

if (CLEAN) {
  let changed = 0;
  all.forEach((x) => {
    if (!Array.isArray(x.dev)) return;
    const out = [];
    const seen = new Set();
    x.dev.forEach((d) => {
      const c = cleanDev(d);
      if (c && !seen.has(c)) { seen.add(c); out.push(c); }
    });
    if (JSON.stringify(out) !== JSON.stringify(x.dev)) { x.dev = out; changed += 1; }
  });
  const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
    `window.GL_META = ${JSON.stringify(meta)};\n` +
    `window.GL_DATA = ${JSON.stringify(all)};\n`;
  await writeFile(MAIN, content, 'utf8');
  console.log(`开发商后缀清理：${changed} 条已更新`);
  process.exit(0);
}

const visible = all.filter((x) => x.k !== 'off');
const missing = visible.filter((x) => !x.dev || !x.dev.length);
const targets = [];
const skipped = [];
for (const item of missing) {
  const v = vmap[String(item.i)];
  const dv = String((v && v.dv) || '').trim();
  if (!dv) continue;
  // 联合署名 / 斜杠值容易把多个实体塞进一个字段，先跳过
  if (!dv || /[\/&]/.test(dv)) { skipped.push([item, dv]); continue; }
  targets.push({ item, dv });
}

const before = visible.filter((x) => x.dev && x.dev.length).length;
console.log(`主库可见 ${visible.length}；缺开发商 ${missing.length}；可补 ${targets.length}；跳过联合署名 ${skipped.length}`);
console.log(`覆盖率 ${(before / visible.length * 100).toFixed(1)}% → ${((before + targets.length) / visible.length * 100).toFixed(1)}%`);
console.log('样本：');
targets.slice(0, 20).forEach((t) => console.log(`  ${t.item.cn || t.item.n} → ${t.dv}`));
if (skipped.length) {
  console.log('跳过样本：');
  skipped.slice(0, 10).forEach(([item, dv]) => console.log(`  ${item.cn || item.n} → ${dv}`));
}

if (!APPLY) {
  console.log('\n当前为预演模式，未写入；确认后加 --apply。');
  process.exit(0);
}

for (const t of targets) t.item.dev = [t.dv];
meta.devFilled = (meta.devFilled || 0) + targets.length;
const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(meta)};\n` +
  `window.GL_DATA = ${JSON.stringify(all)};\n`;
await writeFile(MAIN, content, 'utf8');
console.log(`\n已写入 ${MAIN}：补 ${targets.length} 条开发商`);
