// 给主库 galgames.js 的非 gal 条目加 k="off"（默认隐藏，保留收藏、详情与旧链接）。
// 不删除条目、不改 vndb.js；黑名单来自 data/blocklist-main.json。
// 默认 dry-run；确认后加 --apply 才写文件；--unmark 用于撤销标记。
//
// 用法：
//   node scripts/mark-non-gal.mjs             # 预演
//   node scripts/mark-non-gal.mjs --apply     # 写入 k="off"
//   node scripts/mark-non-gal.mjs --apply --unmark  # 撤销标记

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'galgames.js');
const BLOCK = path.join(ROOT, 'data', 'blocklist-main.json');
const APPLY = process.argv.includes('--apply');
const UNMARK = process.argv.includes('--unmark');

const block = JSON.parse(await readFile(BLOCK, 'utf8'));
const ids = new Set((block.items || []).map((x) => Number(x.i)).filter(Boolean));
if (!ids.size) {
  console.log('主库黑名单为空，无需处理');
  process.exit(0);
}

const raw = await readFile(FILE, 'utf8');
const metaMatch = raw.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/);
const dataMatch = raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/);
if (!metaMatch || !dataMatch) throw new Error('未找到 window.GL_META / window.GL_DATA');
const meta = JSON.parse(metaMatch[1]);
const all = JSON.parse(dataMatch[1]);

let changed = 0;
let missing = 0;
let already = 0;
for (const id of ids) {
  const item = all.find((x) => Number(x.i) === id);
  if (!item) { missing += 1; continue; }
  if (UNMARK) {
    if (item.k === 'off') { delete item.k; changed += 1; }
  } else if (item.k !== 'off') {
    item.k = 'off';
    changed += 1;
  } else {
    already += 1;
  }
}

console.log(`主库黑名单 ${ids.size} 条；将${UNMARK ? '撤销' : '标记'} ${changed} 条，已是目标状态 ${already} 条，主库缺失 ${missing} 条`);

// meta.nonGalMarked 供统计面板展示，必须与实际 k="off" 数量一致，否则面板与列表自相矛盾
const offCount = all.filter((x) => x.k === 'off').length;
if (meta.nonGalMarked !== offCount) {
  console.log(`meta.nonGalMarked ${meta.nonGalMarked} → ${offCount}`);
  meta.nonGalMarked = offCount;
}

if (!APPLY) {
  console.log('当前为预演模式，未写入文件；确认后加 --apply。');
  process.exit(0);
}

const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(meta)};\n` +
  `window.GL_DATA = ${JSON.stringify(all)};\n`;
const tmp = `${FILE}.tmp`;
await writeFile(tmp, content, 'utf8');
await rename(tmp, FILE);
console.log(`已写入 ${FILE}`);
