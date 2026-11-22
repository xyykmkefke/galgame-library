// 数据质量校验：重复 ID、非法日期、评分越界、题材越界、平台数组异常、标题缺失、rt 泄漏
// 用法：node scripts/check-data.mjs
// 退出码 0 表示数据干净，1 表示存在问题

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GENRES } from './genres.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const raw = await readFile(path.join(ROOT, 'data', 'galgames.js'), 'utf8');
const match = raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);?/);
if (!match) {
  console.error('未找到 window.GL_DATA');
  process.exit(1);
}
const data = JSON.parse(match[1]);

const GENRE_IDS = new Set(GENRES.map((g) => g.id));
const label = {
  duplicate: '重复 ID',
  date: '非法日期',
  score: '评分越界',
  title: '缺少标题',
  id: '非法 ID',
  genre: '题材字段异常',
  platform: '平台字段异常',
  list: '数组字段异常',
  leak: '缓存字段泄漏',
  dev: '开发商字段异常',
  flag: '布尔字段异常',
};
const issues = {
  duplicate: [], date: [], score: [], title: [], id: [], genre: [], platform: [], list: [], leak: [],
  dev: [], flag: [],
};
const seen = new Map();

data.forEach((x, idx) => {
  const id = Number(x.i);
  if (!Number.isInteger(id) || id <= 0) issues.id.push(`${idx}:${x.i}`);
  if (seen.has(String(x.i))) issues.duplicate.push(`${x.i}（#${seen.get(String(x.i))} 与 #${idx}）`);
  else seen.set(String(x.i), idx);

  const d = String(x.d || '');
  if (d && !/^\d{4}-\d{2}-\d{2}$/.test(d)) issues.date.push(`${x.i}:${d}`);

  if (x.s != null && (Number(x.s) < 0 || Number(x.s) > 10)) issues.score.push(`${x.i}:${x.s}`);

  if (!String(x.cn || '').trim() && !String(x.n || '').trim()) issues.title.push(String(x.i));

  if (x.rt) issues.leak.push(String(x.i));

  if (x.tg != null) {
    if (!Array.isArray(x.tg) || !x.tg.length) {
      issues.genre.push(`${x.i}:${JSON.stringify(x.tg)}`);
    } else {
      const bad = x.tg.filter((g) => !GENRE_IDS.has(g));
      if (bad.length) issues.genre.push(`${x.i}:${bad.join('/')}`);
      if (new Set(x.tg).size !== x.tg.length) issues.genre.push(`${x.i}:重复`);
    }
  }

  if (x.pl != null) {
    if (!Array.isArray(x.pl) || !x.pl.length) issues.platform.push(`${x.i}:${JSON.stringify(x.pl)}`);
    else if (x.pl.some((p) => !String(p || '').trim())) issues.platform.push(`${x.i}:含空值`);
    else if (new Set(x.pl).size !== x.pl.length) issues.platform.push(`${x.i}:重复`);
  }

  ['dev'].forEach((key) => {
    if (x[key] != null && (!Array.isArray(x[key]) || x[key].some((v) => !String(v || '').trim()))) {
      issues.list.push(`${x.i}.${key}`);
    }
  });

  // 开发商：去重、无公司后缀残留
  if (Array.isArray(x.dev)) {
    if (new Set(x.dev).size !== x.dev.length) issues.dev.push(`${x.i}:重复`);
    if (x.dev.some((d) => /co\.,?\s*ltd|株式会社$|有限会社$/i.test(String(d)))) {
      issues.dev.push(`${x.i}:未归一`);
    }
  }

  if (x.ns != null && typeof x.ns !== 'boolean') issues.flag.push(`${x.i}.ns`);

  // 运行期才注入的字段不能写进数据文件
  if (x.vo !== undefined) issues.leak.push(`${x.i}.vo`);
});

let total = Object.values(issues).reduce((n, arr) => n + arr.length, 0);
Object.keys(issues).forEach((key) => {
  const arr = issues[key];
  if (arr.length) console.log(`FAIL ${label[key]}：${arr.length} 条，示例 ${arr.slice(0, 5).join(', ')}`);
});

const pct = (n) => `${(n / data.length * 100).toFixed(1)}%`;
const count = (fn) => data.filter(fn).length;

const withGenre = count((x) => Array.isArray(x.tg) && x.tg.length);
const genreCounts = {};
data.forEach((x) => (x.tg || []).forEach((g) => { genreCounts[g] = (genreCounts[g] || 0) + 1; }));
const dist = GENRES.filter((g) => genreCounts[g.id])
  .map((g) => `${g.label} ${genreCounts[g.id]}`).join(' · ');

const platformCounts = {};
data.forEach((x) => (x.pl || []).forEach((p) => { platformCounts[p] = (platformCounts[p] || 0) + 1; }));
const topPlatforms = Object.entries(platformCounts)
  .sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([p, n]) => `${p} ${n}`).join(' · ');

const devCounts = {};
data.forEach((x) => (x.dev || []).forEach((d) => { devCounts[d] = (devCounts[d] || 0) + 1; }));
const topDevs = Object.entries(devCounts)
  .sort((a, b) => b[1] - a[1]).slice(0, 10)
  .map(([d, n]) => `${d} ${n}`).join(' · ');

console.log(`条目总数：${data.length}`);
console.log(`日期：${count((x) => x.d)}（${pct(count((x) => x.d))}）`);
console.log(`评分：${count((x) => Number(x.s) > 0)}（${pct(count((x) => Number(x.s) > 0))}）`);
console.log(`封面：${count((x) => x.img)}（${pct(count((x) => x.img))}）`);
console.log(`平台：${count((x) => Array.isArray(x.pl) && x.pl.length)}（${pct(count((x) => Array.isArray(x.pl) && x.pl.length))}）`);
console.log(`开发商：${count((x) => Array.isArray(x.dev) && x.dev.length)}（${pct(count((x) => Array.isArray(x.dev) && x.dev.length))}）`);
console.log(`剧本：${count((x) => x.sc)}（${pct(count((x) => x.sc))}） · 原画：${count((x) => x.ar)}（${pct(count((x) => x.ar))}） · 音乐：${count((x) => x.mu)}（${pct(count((x) => x.mu))}）`);
console.log(`题材覆盖：${withGenre}/${data.length}（${pct(withGenre)}）`);
console.log(`题材分布：${dist || '无'}`);
console.log(`平台分布：${topPlatforms || '无'}`);
console.log(`开发商 Top：${topDevs || '无'}`);

// ---------- 覆盖率底线 ----------
const floors = [
  ['发售日', count((x) => x.d) / data.length, 0.95],
  ['评分', count((x) => Number(x.s) > 0) / data.length, 0.95],
  ['封面', count((x) => x.img) / data.length, 0.99],
  ['平台', count((x) => Array.isArray(x.pl) && x.pl.length) / data.length, 0.94],
  ['开发商', count((x) => Array.isArray(x.dev) && x.dev.length) / data.length, 0.74],
  ['题材', withGenre / data.length, 0.50],
];
floors.forEach(([name, ratio, min]) => {
  if (ratio < min) {
    console.log(`FAIL 覆盖率不足：${name} ${(ratio * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}%`);
    total += 1;
  }
});

// ---------- 第二数据源（VNDB） ----------
try {
  const vraw = await readFile(path.join(ROOT, 'data', 'vndb.js'), 'utf8');
  const vm = vraw.match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/);
  if (!vm) throw new Error('未找到 window.GL_VNDB');
  const vndb = JSON.parse(vm[1]);
  const map = vndb.map || {};
  const ids = new Set(data.map((x) => String(x.i)));
  const bad = [];
  Object.keys(map).forEach((id) => {
    const v = map[id];
    if (!ids.has(id)) bad.push(`${id}:主库不存在`);
    else if (!/^v\d+$/.test(String(v.v))) bad.push(`${id}:${v.v}`);
    else if (!(Number(v.r) >= 0 && Number(v.r) <= 100)) bad.push(`${id}:评分 ${v.r}`);
    else if (!(Number(v.l) >= 0)) bad.push(`${id}:时长 ${v.l}`);
  });
  const matched = Object.keys(map).length;
  console.log(`VNDB：匹配 ${matched} 条（尝试 ${vndb.meta?.tried || 0}），异常 ${bad.length} 条`);
  if (matched < 100) {
    console.log(`FAIL VNDB 匹配过少：${matched} < 100`);
    total += 1;
  }
  if (bad.length) {
    console.log(`FAIL VNDB 映射异常：${bad.slice(0, 5).join(', ')}`);
    total += bad.length;
  }
  if (Number(vndb.meta?.matched) !== matched) {
    console.log(`FAIL VNDB 元信息数量不一致：${vndb.meta?.matched} != ${matched}`);
    total += 1;
  }
} catch (err) {
  console.log(`FAIL 第二数据源不可用：${err.message}`);
  total += 1;
}

// ---------- 第三数据源（月幕） ----------
try {
  const yraw = await readFile(path.join(ROOT, 'data', 'ymgal.js'), 'utf8');
  const ymMatch = yraw.match(/window\.GL_YMGAL\s*=\s*(\{[\s\S]*\});/);
  if (!ymMatch) throw new Error('未找到 window.GL_YMGAL');
  const ymgal = JSON.parse(ymMatch[1]);
  const map = ymgal.map || {};
  const ids = new Set(data.map((x) => String(x.i)));
  const bad = [];
  Object.keys(map).forEach((id) => {
    const v = map[id];
    if (!ids.has(id)) bad.push(`${id}:主库不存在`);
    else if (!(Number.isInteger(Number(v.g)) && Number(v.g) > 0)) bad.push(`${id}:gid ${v.g}`);
    else if (!String(v.n || '').trim()) bad.push(`${id}:缺少标题`);
    else if (v.d && !/^\d{4}-\d{2}-\d{2}$/.test(String(v.d))) bad.push(`${id}:日期 ${v.d}`);
    else if (v.s !== '' && !(Number(v.s) >= 0 && Number(v.s) <= 10)) bad.push(`${id}:评分 ${v.s}`);
    else if (v.hc !== 0 && v.hc !== 1) bad.push(`${id}:hc ${v.hc}`);
  });
  const matched = Object.keys(map).length;
  console.log(`月幕：匹配 ${matched} 条（尝试 ${ymgal.meta?.tried || 0}），异常 ${bad.length} 条`);
  if (matched < 100) {
    console.log(`FAIL 月幕匹配过少：${matched} < 100`);
    total += 1;
  }
  if (bad.length) {
    console.log(`FAIL 月幕映射异常：${bad.slice(0, 5).join(', ')}`);
    total += bad.length;
  }
  if (Number(ymgal.meta?.matched) !== matched) {
    console.log(`FAIL 月幕元信息数量不一致：${ymgal.meta?.matched} != ${matched}`);
    total += 1;
  }
} catch (err) {
  console.log(`FAIL 第三数据源不可用：${err.message}`);
  total += 1;
}

// ---------- 体积预算 ----------
const mainSize = Buffer.byteLength(raw, 'utf8');
let vndbSize = 0;
let ymgalSize = 0;
try {
  vndbSize = Buffer.byteLength(await readFile(path.join(ROOT, 'data', 'vndb.js'), 'utf8'), 'utf8');
} catch { /* 缺失已在上面报错 */ }
try {
  ymgalSize = Buffer.byteLength(await readFile(path.join(ROOT, 'data', 'ymgal.js'), 'utf8'), 'utf8');
} catch { /* 缺失已在上面报错 */ }
const totalSize = mainSize + vndbSize + ymgalSize;
console.log(`体积：主库 ${(mainSize / 1024).toFixed(0)}KB + VNDB ${(vndbSize / 1024).toFixed(0)}KB + 月幕 ${(ymgalSize / 1024).toFixed(0)}KB = ${(totalSize / 1024).toFixed(0)}KB`);
if (totalSize > 1300 * 1024) {
  console.log(`FAIL 数据体积超预算：${(totalSize / 1024).toFixed(0)}KB > 1300KB`);
  total += 1;
}

console.log(`问题总数：${total}`);
process.exit(total ? 1 : 0);
