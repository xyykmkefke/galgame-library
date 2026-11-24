// 主库开发商补齐（月幕）：对 dev 为空、且月幕已匹配的条目，用 ymgal.o 回填。
// 只填空字段，不覆盖已有开发商；默认 dry-run，加 --apply 写回。
//
// 用法：
//   node scripts/fill-main-devs-ymgal.mjs
//   node scripts/fill-main-devs-ymgal.mjs --apply

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const YMGAL = path.join(ROOT, 'data', 'ymgal.js');
const APPLY = process.argv.includes('--apply');

function cleanDev(raw) {
  const value = String(raw || '').trim()
    .replace(/^(株式会社|有限会社|合同会社)\s*/, '')
    .replace(/\s*(co\.,?\s*ltd\.?|co\.?\s*ltd\.?|inc\.?|llc|ltd\.?|corporation|corp\.?|gmbh|株式会社|有限会社|合同会社)\s*$/i, '')
    .trim()
    .replace(/^[·・,，、.\s]+|[·・,，、.\s]+$/g, '');
  return /^(?:默认机构|未知|不明|-+)$/.test(value) ? '' : value;
}

const raw = await readFile(MAIN, 'utf8');
const meta = JSON.parse(raw.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/)[1]);
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const ymap = JSON.parse((await readFile(YMGAL, 'utf8')).match(/window\.GL_YMGAL\s*=\s*(\{[\s\S]*\});/)[1]).map || {};

const changes = [];
for (const x of all) {
  if (x.k === 'off' || (x.dev && x.dev.length)) continue;
  const y = ymap[String(x.i)];
  const dev = cleanDev(y && y.o);
  if (!dev) continue;
  changes.push({ id: x.i, name: x.cn || x.n, dev });
  if (APPLY) x.dev = [dev];
}

console.log(`可由月幕补开发商：${changes.length} 条`);
changes.slice(0, 20).forEach((c) => console.log(`  [${c.id}] ${c.name} -> ${c.dev}`));

if (!APPLY) {
  console.log('\n预演完成，未写数据。确认后运行：node scripts/fill-main-devs-ymgal.mjs --apply');
  process.exit(0);
}

meta.ymDevFilled = { at: new Date().toISOString(), count: changes.length };
const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(meta)};\n` +
  `window.GL_DATA = ${JSON.stringify(all)};\n`;
await writeFile(MAIN, content, 'utf8');
console.log(`\n已写回：${changes.length} 条`);
