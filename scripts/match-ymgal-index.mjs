// 用月幕全量索引（fetch-ymgal-index.mjs）离线给未匹配月幕的主库条目找对应。
// 只读索引与本地数据；结果并入 data/build/ymgal-alias.json（与别名反查同格式），
// 之后用 `npm run apply-ymgal-aliases -- --apply` 合并进 data/ymgal.js。
//
// 用法：
//   node scripts/match-ymgal-index.mjs
//   node scripts/match-ymgal-index.mjs --refresh   忽略已有 --index 结果重新匹配
//
// 口径：归一标题完全相等（主库原名/中文名/Bangumi 别名/VNDB 各语言标题 vs 月幕 name/chineseName）；
//       年份差 ≤3；纯拉丁开发商名要求词重合；多个候选同分视为歧义跳过。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = path.join(ROOT, 'data', 'build', 'ymgal-index.json');
const VNDB_INDEX = path.join(ROOT, 'data', 'build', 'vndb-titles.json');
const OUT = path.join(ROOT, 'data', 'build', 'ymgal-alias.json');
const REFRESH = process.argv.includes('--refresh');

const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/g, '')
  .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～・、。…‥「」『』【】《》（）〈〉〔〕~～〜]/g, '');
const year = (s) => (String(s || '').match(/^(\d{4})/) || [])[1] || '';
const cjk = (s) => /[\u3040-\u30ff\u3400-\u9fff]/.test(s);
const toks = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3);
const usable = (k) => k && !/^\d+$/.test(k) && (cjk(k) ? k.length >= 2 : k.length >= 3);

function parseWindow(raw, name) {
  const m = raw.match(new RegExp('window\\.' + name + '\\s*=\\s*([\\[{][\\s\\S]*[\\]}]);'));
  if (!m) throw new Error('未找到 ' + name);
  return JSON.parse(m[1]);
}

const index = JSON.parse(await readFile(INDEX, 'utf8'));
const main = parseWindow(await readFile(path.join(ROOT, 'data', 'galgames.js'), 'utf8'), 'GL_DATA');
const vndb = parseWindow(await readFile(path.join(ROOT, 'data', 'vndb.js'), 'utf8'), 'GL_VNDB');
const ymgal = parseWindow(await readFile(path.join(ROOT, 'data', 'ymgal.js'), 'utf8'), 'GL_YMGAL');
const vndbIndex = existsSync(VNDB_INDEX) ? JSON.parse(await readFile(VNDB_INDEX, 'utf8')) : { list: [] };
const cache = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : {};

const vnById = new Map(vndbIndex.list.map((v) => [String(v.i), v]));

// 月幕索引：归一标题 -> 条目下标
const byKey = new Map();
index.list.forEach((y, i) => {
  [y.n, y.cn].forEach((v) => {
    const k = norm(v);
    if (!usable(k)) return;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  });
});
console.log(`月幕索引：${index.list.length} 部（${index.meta.lastPage || '?'}/${index.meta.pages || '?'} 页），${byKey.size} 个标题键`);

const targets = main.filter((x) => x.k !== 'off' && !(ymgal.map && ymgal.map[String(x.i)]));
console.log(`月幕未匹配可见条目 ${targets.length} 条`);

const proposals = [];
const ambiguous = [];
for (const g of targets) {
  const id = String(g.i);
  if (!REFRESH && cache[id] && cache[id].ok) continue;
  const want = new Set();
  const keys = [g.n, g.cn, ...(g.al || [])];
  const v = (vndb.map || {})[id];
  if (v && v.v) {
    const vn = vnById.get(String(v.v).replace(/^v/, ''));
    if (vn) {
      keys.push(vn.t, vn.a);
      (vn.ti || []).forEach((t) => keys.push(t.t, t.la));
    }
  }
  keys.forEach((k0) => { const k = norm(k0); if (usable(k)) want.add(k); });
  if (!want.size) continue;

  const gy = year(g.d);
  const cand = new Map();
  want.forEach((k) => {
    (byKey.get(k) || []).forEach((i) => {
      const y = index.list[i];
      const yy = year(y.d);
      const gap = gy && yy ? Math.abs(Number(gy) - Number(yy)) : 9;
      if (gap > 3) return;
      const gd = (g.dev || []).join(' ');
      let devOk = true;
      if (gd && y.o && !cjk(gd) && !cjk(y.o)) {
        const a = toks(gd), b = toks(y.o);
        devOk = !a.length || !b.length || a.some((x) => b.some((z) => x === z || x.includes(z) || z.includes(x)));
      }
      if (!devOk) return;
      const cur = cand.get(y.g) || { y, keys: new Set(), gap: 9 };
      cur.keys.add(k);
      if (gap < cur.gap) cur.gap = gap;
      cand.set(y.g, cur);
    });
  });
  if (!cand.size) continue;
  const ranked = [...cand.values()].sort((a, b) =>
    (b.keys.size - a.keys.size) || (a.gap - b.gap) || ((b.y.hc || 0) - (a.y.hc || 0)));
  const top = ranked[0];
  const second = ranked[1];
  const row = {
    id,
    name: g.cn || g.n,
    y: top.y,
    keys: top.keys.size,
    gap: top.gap,
    alt: second ? second.y : null,
  };
  if (second && second.keys.size === top.keys.size && second.gap === top.gap) {
    ambiguous.push(row);
    continue;
  }
  proposals.push(row);
}

const at = new Date().toISOString();
proposals.forEach((p) => {
  cache[String(p.id)] = {
    ok: true,
    g: p.y.g,
    n: p.y.n,
    cn: p.y.cn,
    d: p.y.d,
    o: p.y.o,
    i: p.y.i,
    s: p.y.s,
    hc: p.y.hc,
    src: 'index',
    at,
  };
});
await writeFile(OUT, JSON.stringify(cache), 'utf8');

console.log(`离线命中 ${proposals.length} 条（歧义 ${ambiguous.length} 条未采纳）`);
proposals.slice(0, 30).forEach((p) => console.log(`  [${p.id}] ${p.name} => ${p.y.n}${p.y.cn ? ' / ' + p.y.cn : ''} (${p.y.d || '无日期'})`));
ambiguous.slice(0, 10).forEach((p) => console.log(`  ?[${p.id}] ${p.name} => ${p.y.n} | 备选 ${p.alt.n}`));
console.log(`输出：${OUT}`);
