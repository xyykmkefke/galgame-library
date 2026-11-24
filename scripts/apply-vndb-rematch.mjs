// 把 A5 探测结果（data/build/vndb-rematch.json）合并回 data/vndb.js。
// 只接受 ok=true 且有 VNDB id 的条目；不动已匹配条目。默认 dry-run，加 --apply 写回。
//
// 用法：
//   node scripts/apply-vndb-rematch.mjs
//   node scripts/apply-vndb-rematch.mjs --apply

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const VNDB = path.join(ROOT, 'data', 'vndb.js');
const REMATCH = path.join(ROOT, 'data', 'build', 'vndb-rematch.json');
const APPLY = process.argv.includes('--apply');

const raw = await readFile(VNDB, 'utf8');
const vndb = JSON.parse(raw.match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/)[1]);
const main = JSON.parse((await readFile(MAIN, 'utf8')).match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const rematch = JSON.parse(await readFile(REMATCH, 'utf8'));

const visibleIds = new Set(main.filter((x) => x.k !== 'off').map((x) => String(x.i)));
const added = [];
for (const [id, hit] of Object.entries(rematch)) {
  if (!hit || !hit.ok || !hit.v) continue;
  if (!visibleIds.has(id)) continue;
  if (vndb.map[id] && vndb.map[id].v) continue;
  added.push({ id, hit, name: (main.find((x) => String(x.i) === id) || {}).cn || '' });
}

console.log(`可新增 VNDB 匹配：${added.length} 条`);
added.slice(0, 20).forEach((a) => console.log(`  [${a.id}] ${a.name} -> ${a.hit.t} (${a.hit.v}, ${a.hit.d || '无日期'})`));

if (!APPLY) {
  console.log('\n预演完成，未写数据。确认后运行：node scripts/apply-vndb-rematch.mjs --apply');
  process.exit(0);
}

added.forEach(({ id, hit }) => {
  vndb.map[id] = {
    v: hit.v,
    r: Number(hit.r) || 0,
    l: 0,
    d: hit.d || '',
    t: hit.t || '',
    dv: hit.dv || '',
    vc: Number(hit.vc) || 0,
  };
});

vndb.meta = Object.assign({}, vndb.meta, {
  matched: Object.keys(vndb.map).length,
  rematchAt: new Date().toISOString(),
  rematchTried: Object.keys(rematch).length,
  rematchAdded: (Number(vndb.meta.rematchAdded) || 0) + added.length,
});
const content = '// 由 scripts/fetch-vndb.mjs 生成，请勿手动修改\n' +
  'window.GL_VNDB = ' + JSON.stringify(vndb) + ';\n';
await writeFile(VNDB, content, 'utf8');
console.log(`\n已写回 ${VNDB}：+${added.length} 条，累计匹配 ${vndb.meta.matched}`);
