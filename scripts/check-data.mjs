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
};
const issues = {
  duplicate: [], date: [], score: [], title: [], id: [], genre: [], platform: [], list: [], leak: [],
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
});

const total = Object.values(issues).reduce((n, arr) => n + arr.length, 0);
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
console.log(`问题总数：${total}`);
process.exit(total ? 1 : 0);
