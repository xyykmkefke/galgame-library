// 用本地 VNDB 全量标题索引（scripts/fetch-vndb-titles.mjs）离线给未匹配主库条目找 VNDB 对应。
// 只读索引与本地数据，不写主库；结果写 data/build/vndb-offline-match.json 供复核。
//
// 用法：
//   node scripts/match-vndb-offline.mjs                预演，打印统计与前 30 条
//   node scripts/match-vndb-offline.mjs --verbose      打印全部命中的多候选 / 歧义明细
//
// 匹配口径（比 A5 在线搜索更严）：
//   - 标题归一后必须完全相等（VNDB 主标题 / 罗马字 / 各语言标题 / 别名 vs 主库原名 / 中文名 / Bangumi 别名 / 月幕名）
//   - 发售年差 ≤ 3 年；同一 VNDB id 不重复分配给多条主库
//   - 多个候选时只接受「命中键数严格更多」的最高分；同分视为歧义，跳过

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const INDEX = path.join(ROOT, 'data', 'build', 'vndb-titles.json');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const VNDB = path.join(ROOT, 'data', 'vndb.js');
const YMGAL = path.join(ROOT, 'data', 'ymgal.js');
const OUT = path.join(ROOT, 'data', 'build', 'vndb-offline-match.json');
const VERBOSE = process.argv.includes('--verbose');

function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～・、。…‥「」『』【】《》（）〈〉〔〕~～〜]/g, '');
}

function yearOf(value) {
  const m = String(value || '').match(/^(\d{4})/);
  return m ? Number(m[1]) : 0;
}

const isCjk = (s) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/.test(s);

// 开发商一致性：两边都是纯拉丁名时要求至少一个词重合，否则视为不同作品；
// 任一侧含日文 / 中文时无法可靠比较，直接放行（交给标题与年份把关）
function devTokens(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((t) => t.length >= 3);
}

function devCompatible(mainDev, vnDev) {
  const devText = Array.isArray(mainDev) ? mainDev.join(' ') : String(mainDev || '');
  if (!devText || !vnDev) return true;
  if (isCjk(devText) || isCjk(vnDev)) return true;
  const a = devTokens(devText);
  const b = devTokens(vnDev);
  if (!a.length || !b.length) return true;
  return a.some((x) => b.some((y) => x === y || x.includes(y) || y.includes(x)));
}

// 归一后的键太短容易误配：中文 2 字起，拉丁 / 假名 3 字起
function usableKey(key) {
  if (!key) return false;
  if (/^\d+$/.test(key)) return false;
  return isCjk(key) ? key.length >= 2 : key.length >= 3;
}

function parseWindow(raw, name) {
  const m = raw.match(new RegExp('window\\.' + name + '\\s*=\\s*([\\[{][\\s\\S]*[\\]}]);'));
  if (!m) throw new Error('未找到 ' + name);
  return JSON.parse(m[1]);
}

const index = JSON.parse(await readFile(INDEX, 'utf8'));
const main = parseWindow(await readFile(MAIN, 'utf8'), 'GL_DATA');
const vndb = parseWindow(await readFile(VNDB, 'utf8'), 'GL_VNDB');
const ymgal = existsSync(YMGAL) ? parseWindow(await readFile(YMGAL, 'utf8'), 'GL_YMGAL') : { map: {} };

// 索引：归一标题 -> [VN 序号]
const byKey = new Map();
function addIndex(key, i) {
  let arr = byKey.get(key);
  if (!arr) { arr = []; byKey.set(key, arr); }
  if (arr[arr.length - 1] !== i) arr.push(i);
}
index.list.forEach((vn, i) => {
  const keys = new Set();
  const push = (v) => { const k = normalizeTitle(v); if (usableKey(k)) keys.add(k); };
  push(vn.t); push(vn.a);
  (vn.ti || []).forEach((x) => { push(x.t); push(x.la); });
  (vn.n || []).forEach(push);
  keys.forEach((k) => addIndex(k, i));
});
console.log(`索引：${index.list.length} 部 VN，${byKey.size} 个标题键`);

const usedVndb = new Set(Object.values(vndb.map || {}).map((x) => String(x.v || '').replace(/^v/, '')).filter(Boolean));
const matchedIds = new Set(Object.keys(vndb.map || {}).filter((id) => vndb.map[id] && vndb.map[id].v));

const proposals = [];
const ambiguous = [];
const rejected = { year: 0, tie: 0, used: 0, dev: 0 };
let unmatched = 0;

for (const item of main) {
  if (item.k === 'off') continue;
  const id = String(item.i);
  if (matchedIds.has(id)) continue;
  unmatched += 1;

  const want = new Set();
  const sources = [];
  const push = (v, src) => {
    const k = normalizeTitle(v);
    if (!usableKey(k)) return;
    if (want.has(k)) return;
    want.add(k);
    sources.push({ k, src });
  };
  push(item.n, 'name');
  push(item.cn, 'cn');
  (item.al || []).forEach((a) => push(a, 'bgm-alias'));
  const ym = ymgal.map && ymgal.map[id];
  if (ym) {
    push(ym.n, 'ymgal');
    push(ym.cn, 'ymgal-cn');
    (ym.al || []).forEach((a) => push(a, 'ymgal-alias'));
  }
  if (!want.size) continue;

  const year = yearOf(item.d);
  const seen = new Map(); // vn index -> { keys:[], gap }
  for (const { k, src } of sources) {
    const arr = byKey.get(k);
    if (!arr) continue;
    for (const vi of arr) {
      const vn = index.list[vi];
      const vy = yearOf(vn.d);
      const gap = year && vy ? Math.abs(vy - year) : 9;
      if (gap > 3) { rejected.year += 1; continue; }
      if (!devCompatible(item.dev, vn.dv)) { rejected.dev += 1; continue; }
      const cur = seen.get(vi) || { vi, keys: [], gap, srcs: [] };
      cur.keys.push(k);
      cur.srcs.push(src);
      if (gap < cur.gap) cur.gap = gap;
      seen.set(vi, cur);
    }
  }
  if (!seen.size) continue;

  const ranked = [...seen.values()].map((x) => {
    const vn = index.list[x.vi];
    return { ...x, vn, count: x.keys.length, vc: vn.vc || 0 };
  }).sort((a, b) =>
    (b.count - a.count) ||
    (a.gap - b.gap) ||
    (b.vc - a.vc) ||
    (Number(a.vn.i) - Number(b.vn.i)));

  const top = ranked[0];
  const second = ranked[1];
  const vnId = String(top.vn.i);
  const base = {
    id: item.i,
    name: item.cn || item.n,
    key: top.keys[0],
    keys: top.keys,
    srcs: top.srcs,
    v: 'v' + vnId,
    t: top.vn.t,
    d: top.vn.d,
    r: top.vn.r,
    vc: top.vn.vc,
    dv: top.vn.dv,
    gap: top.gap,
  };
  if (usedVndb.has(vnId)) { rejected.used += 1; continue; }
  if (second && second.count === top.count) {
    ambiguous.push({ ...base, alt: { v: 'v' + second.vn.i, t: second.vn.t, d: second.vn.d } });
    rejected.tie += 1;
    continue;
  }
  usedVndb.add(vnId);
  proposals.push(base);
}

const at = new Date().toISOString();
const out = {};
proposals.forEach((p) => {
  out[String(p.id)] = {
    ok: true,
    keyword: p.key,
    v: p.v,
    t: p.t,
    d: p.d,
    r: p.r,
    vc: p.vc,
    dv: p.dv,
    src: 'offline',
    at,
  };
});
await writeFile(OUT, JSON.stringify(out), 'utf8');

console.log(`未匹配可见条目 ${unmatched} 条`);
console.log(`离线命中 ${proposals.length} 条（年份不符 ${rejected.year}、开发商不符 ${rejected.dev}、同分歧义 ${rejected.tie}、VN 已占用 ${rejected.used}）`);
const byGap = {};
proposals.forEach((p) => { byGap[p.gap] = (byGap[p.gap] || 0) + 1; });
console.log('年份差分布：' + Object.keys(byGap).sort().map((k) => `${k}年 ${byGap[k]}`).join(' · '));
proposals.slice(0, 30).forEach((p) => console.log(`  [${p.id}] ${p.name} -> ${p.t} (${p.v}, ${p.d || '无日期'}, gap ${p.gap}, 键 ${p.keys.length})`));
if (ambiguous.length) {
  console.log(`歧义 ${ambiguous.length} 条（未采纳，可人工复核）`);
  (VERBOSE ? ambiguous : ambiguous.slice(0, 10)).forEach((p) => console.log(`  ?[${p.id}] ${p.name} -> ${p.t} (${p.v}) | 备选 ${p.alt.v} ${p.alt.t}`));
}
console.log(`\n输出：${OUT}`);
