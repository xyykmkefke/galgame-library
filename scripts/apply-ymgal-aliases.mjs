// 把月幕别名反向匹配结果（data/build/ymgal-alias.json）合并进 data/ymgal.js。
// 只接受 ok=true 且 gid>0 的条目，不动已有映射。默认 dry-run，加 --apply 写回。
// 合并后如需详情别名，再跑一次 `npm run fetch-ymgal` 即可（它会给新匹配补齐 extensionName）。
//
// 用法：
//   node scripts/apply-ymgal-aliases.mjs
//   node scripts/apply-ymgal-aliases.mjs --apply

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const YMGAL = path.join(ROOT, 'data', 'ymgal.js');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const CACHE = path.join(ROOT, 'data', 'build', 'ymgal-alias.json');
const MAP_CACHE = path.join(ROOT, 'data', 'build', 'ymgal-map.json');
const APPLY = process.argv.includes('--apply');

function parseWindow(raw, name) {
  const m = raw.match(new RegExp('window\\.' + name + '\\s*=\\s*([\\[{][\\s\\S]*[\\]}]);'));
  if (!m) throw new Error('未找到 ' + name);
  return JSON.parse(m[1]);
}

const raw = await readFile(YMGAL, 'utf8');
const ymgal = JSON.parse(raw.match(/window\.GL_YMGAL\s*=\s*(\{[\s\S]*\});/)[1]);
const main = parseWindow(await readFile(MAIN, 'utf8'), 'GL_DATA');
const cache = existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf8')) : {};

const visible = new Map(main.filter((x) => x.k !== 'off').map((x) => [String(x.i), x]));
const added = [];
for (const [id, hit] of Object.entries(cache)) {
  if (!hit || !hit.ok || !hit.g) continue;
  if (!visible.has(id)) continue;
  if (ymgal.map[id] && ymgal.map[id].g) continue;
  added.push({ id, hit, name: visible.get(id).cn || visible.get(id).n || '' });
}

console.log(`可新增月幕匹配：${added.length} 条`);
added.slice(0, 20).forEach((a) => console.log(`  [${a.id}] ${a.name} -> ${a.hit.n}${a.hit.cn ? ' / ' + a.hit.cn : ''} (${a.hit.d || '无日期'})`));

if (!APPLY) {
  console.log('\n预演完成，未写数据。确认后运行：node scripts/apply-ymgal-aliases.mjs --apply');
  process.exit(0);
}
if (!added.length) {
  console.log('无需写回');
  process.exit(0);
}

added.forEach(({ id, hit }) => {
  ymgal.map[id] = {
    g: hit.g,
    n: hit.n || '',
    cn: hit.cn || '',
    d: hit.d || '',
    o: hit.o || '',
    i: hit.i || '',
    s: hit.s == null ? '' : String(hit.s),
    hc: hit.hc ? 1 : 0,
  };
});
ymgal.meta = Object.assign({}, ymgal.meta, {
  matched: Object.keys(ymgal.map).length,
  aliased: Object.keys(ymgal.map).filter((id) => Array.isArray(ymgal.map[id].al) && ymgal.map[id].al.length).length,
  aliasMatchedAt: new Date().toISOString(),
  aliasAdded: (Number(ymgal.meta.aliasAdded) || 0) + added.length,
});
await writeFile(YMGAL, '// 由 scripts/fetch-ymgal.mjs 生成，请勿手动修改\n' +
  'window.GL_YMGAL = ' + JSON.stringify(ymgal) + ';\n', 'utf8');
console.log(`\n已写回 ${YMGAL}：+${added.length} 条，累计匹配 ${ymgal.meta.matched}`);

// 同步抓取缓存，避免下次 fetch-ymgal 把新命中当未匹配重新搜一遍
if (existsSync(MAP_CACHE)) {
  const mapCache = JSON.parse(await readFile(MAP_CACHE, 'utf8'));
  added.forEach(({ id, hit }) => {
    mapCache[id] = {
      g: hit.g,
      n: hit.n || '',
      cn: hit.cn || '',
      d: hit.d || '',
      o: hit.o || '',
      i: hit.i || '',
      s: hit.s == null ? '' : String(hit.s),
      hc: hit.hc ? 1 : 0,
    };
  });
  await writeFile(MAP_CACHE, JSON.stringify(mapCache), 'utf8');
  console.log(`已同步 ${MAP_CACHE}：${Object.keys(mapCache).length} 条`);
}
