// 修正主库题材误标：游戏类型为可玩性主导（RPG/SRPG/ACT/育成等）且不含文字冒险指示时，
// 不采信 Bangumi 用户标签里的「百合 / 耽美」—— 这两个是泛用关系标签，与玩法无关。
//
// 只改题材数组，不动收录、不动其他题材（科幻 / 悬疑 / 恐怖等属内容描述，保留）。
// 默认 dry-run；确认后加 --apply。
//
// 用法：
//   node scripts/fix-main-genre-tags.mjs            # 预演，列出将修正的条目
//   node scripts/fix-main-genre-tags.mjs --apply    # 写入

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { suppressRelationalGenres } from './genres.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'galgames.js');
const APPLY = process.argv.includes('--apply');

const raw = await readFile(FILE, 'utf8');
const meta = JSON.parse(raw.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/)[1]);
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);

const changes = [];
// 只看可见条目：k="off" 已被默认隐藏，其题材不再影响界面
for (const x of all) {
  if (x.k === 'off') continue;
  const tg = x.tg || [];
  if (!tg.length) continue;
  const next = suppressRelationalGenres(tg, x.gt || '', x.cn || x.n || '');
  if (next.length === tg.length) continue;
  changes.push({ i: x.i, name: x.cn || x.n || '', gt: x.gt || '', from: tg.slice(), to: next, item: x });
}

console.log(`扫描可见条目 ${all.filter((x) => x.k !== 'off').length} 条，需修正题材 ${changes.length} 条\n`);
changes.forEach((c) => {
  const removed = c.from.filter((t) => !c.to.includes(t));
  console.log(`  [${c.i}] ${c.name.slice(0, 26).padEnd(28)} | ${c.gt.slice(0, 24).padEnd(26)} | 移除 ${removed.join(',')}`);
});

if (!changes.length) {
  console.log('\n无需修正。');
  process.exit(0);
}

if (!APPLY) {
  console.log('\n当前为预演模式，未写入；确认后加 --apply。');
  process.exit(0);
}

for (const c of changes) c.item.tg = c.to;
meta.genreFixedRelational = { at: new Date().toISOString(), count: changes.length };

const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(meta)};\n` +
  `window.GL_DATA = ${JSON.stringify(all)};\n`;
const tmp = `${FILE}.tmp`;
await writeFile(tmp, content, 'utf8');
await rename(tmp, FILE);
console.log(`\n已写入 ${FILE}：修正 ${changes.length} 条`);
