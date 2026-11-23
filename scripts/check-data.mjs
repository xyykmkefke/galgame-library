// 数据质量校验：重复 ID、非法日期、评分越界、题材越界、平台数组异常、标题缺失、rt/gc/wc 泄漏
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

  if (x.rt || x.gc !== undefined || x.wc !== undefined) issues.leak.push(String(x.i));

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
  ['开发商', count((x) => Array.isArray(x.dev) && x.dev.length) / data.length, 0.73],
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
    else if (v.al !== undefined && (!Array.isArray(v.al) || !v.al.length ||
      v.al.length > 5 || v.al.some((a) => !String(a || '').trim()))) bad.push(`${id}:别名 ${JSON.stringify(v.al)}`);
  });
  const matched = Object.keys(map).length;
  const aliased = Object.keys(map).filter((id) => Array.isArray(map[id].al) && map[id].al.length).length;
  console.log(`月幕：匹配 ${matched} 条（尝试 ${ymgal.meta?.tried || 0}），有别名 ${aliased} 条，异常 ${bad.length} 条`);
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

// ---------- 扩展库（Bangumi 关联，独立文件） ----------
let bgmExtraSize = 0;
try {
  const braw = await readFile(path.join(ROOT, 'data', 'bgm-extra.js'), 'utf8');
  bgmExtraSize = Buffer.byteLength(braw, 'utf8');
  const bm = braw.match(/window\.GL_BGM_EXTRA\s*=\s*(\{[\s\S]*\});/);
  if (!bm) throw new Error('未找到 window.GL_BGM_EXTRA');
  const bgmExtra = JSON.parse(bm[1]);
  const list = Array.isArray(bgmExtra.list) ? bgmExtra.list : [];
  const mainIds = new Set(data.map((x) => String(x.i)));
  const ids = new Set();
  const bad = [];
  const cover = { date: 0, score: 0, img: 0, pl: 0, dev: 0, tg: 0 };
  list.forEach((x, idx) => {
    const at = `${idx}:${x.i}`;
    if (!Number.isInteger(Number(x.i)) || Number(x.i) <= 0 || Number(x.i) >= 1000000) bad.push(`${at}:非法 i`);
    else if (mainIds.has(String(x.i))) bad.push(`${at}:与主库冲突`);
    else if (ids.has(String(x.i))) bad.push(`${at}:重复 i`);
    ids.add(String(x.i));
    if (!String(x.n || '').trim() && !String(x.cn || '').trim()) bad.push(`${at}:缺少标题`);
    if (x.d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.d))) bad.push(`${at}:日期 ${x.d}`);
      else cover.date += 1;
    }
    if (Number(x.s) > 0 && Number(x.s) <= 10) cover.score += 1;
    else if (Number(x.s) < 0 || Number(x.s) > 10) bad.push(`${at}:评分 ${x.s}`);
    if (x.img) {
      if (!/^https:\/\//.test(String(x.img))) bad.push(`${at}:封面 ${x.img}`);
      else cover.img += 1;
    }
    if (x.pl != null) {
      if (!Array.isArray(x.pl) || !x.pl.length || x.pl.some((p) => !String(p || '').trim()) ||
        new Set(x.pl).size !== x.pl.length) bad.push(`${at}:平台 ${JSON.stringify(x.pl)}`);
      else cover.pl += 1;
    }
    if (x.dev != null) {
      if (!Array.isArray(x.dev) || !x.dev.length || x.dev.some((d) => !String(d || '').trim()) ||
        new Set(x.dev).size !== x.dev.length) bad.push(`${at}:开发商 ${JSON.stringify(x.dev)}`);
      else cover.dev += 1;
    }
    if (x.tg != null) {
      if (!Array.isArray(x.tg) || !x.tg.length || new Set(x.tg).size !== x.tg.length ||
        x.tg.some((g) => !GENRE_IDS.has(g))) bad.push(`${at}:题材 ${JSON.stringify(x.tg)}`);
      else cover.tg += 1;
    }
    if (x.bg !== 1) bad.push(`${at}:缺少 bg 标记`);
    if (x.rt || x.gc !== undefined || x.wc !== undefined) bad.push(`${at}:缓存字段泄漏`);
  });
  const ratio = (n) => (list.length ? n / list.length : 0);
  console.log(`Bangumi 关联扩展：${list.length} 条（种子 ${bgmExtra.meta?.seeds || 0}，候选 ${bgmExtra.meta?.candidates || 0}），异常 ${bad.length} 条`);
  console.log(`关联覆盖：日期 ${(ratio(cover.date) * 100).toFixed(1)}% · 评分 ${(ratio(cover.score) * 100).toFixed(1)}% · ` +
    `封面 ${(ratio(cover.img) * 100).toFixed(1)}% · 平台 ${(ratio(cover.pl) * 100).toFixed(1)}% · ` +
    `开发商 ${(ratio(cover.dev) * 100).toFixed(1)}% · 题材 ${(ratio(cover.tg) * 100).toFixed(1)}%`);
  if (list.length < 10) {
    console.log(`FAIL Bangumi 关联扩展过少：${list.length} < 10`);
    total += 1;
  }
  if (Number(bgmExtra.meta?.count) !== list.length) {
    console.log(`FAIL 关联元信息数量不一致：${bgmExtra.meta?.count} != ${list.length}`);
    total += 1;
  }
  [['日期', cover.date, 0.95], ['评分', cover.score, 0.5], ['封面', cover.img, 0.95],
    ['平台', cover.pl, 0.95], ['开发商', cover.dev, 0.95], ['题材', cover.tg, 0.2]]
    .forEach(([name, n, min]) => {
      if (ratio(n) < min) {
        console.log(`FAIL 关联覆盖率不足：${name} ${(ratio(n) * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}%`);
        total += 1;
      }
    });
  if (bad.length) {
    console.log(`FAIL 关联条目异常：${bad.slice(0, 5).join(', ')}`);
    total += bad.length;
  }
} catch (err) {
  console.log(`FAIL Bangumi 关联扩展不可用：${err.message}`);
  total += 1;
}

// ---------- 扩展库（VNDB 日系，独立文件） ----------
let extraSize = 0;
try {
  const eraw = await readFile(path.join(ROOT, 'data', 'vndb-extra.js'), 'utf8');
  extraSize = Buffer.byteLength(eraw, 'utf8');
  const em = eraw.match(/window\.GL_VNDB_EXTRA\s*=\s*(\{[\s\S]*\});/);
  if (!em) throw new Error('未找到 window.GL_VNDB_EXTRA');
  const extra = JSON.parse(em[1]);
  const list = Array.isArray(extra.list) ? extra.list : [];
  const mainIds = new Set(data.map((x) => String(x.i)));
  const ids = new Set();
  const vxs = new Set();
  const bad = [];
  const cover = { date: 0, score: 0, img: 0, pl: 0, dev: 0, tg: 0 };
  list.forEach((x, idx) => {
    const at = `${idx}:${x.i}`;
    if (!Number.isInteger(Number(x.i)) || Number(x.i) < 1000000) bad.push(`${at}:非法 i`);
    else if (mainIds.has(String(x.i))) bad.push(`${at}:与主库冲突`);
    else if (ids.has(String(x.i))) bad.push(`${at}:重复 i`);
    ids.add(String(x.i));
    if (!/^v\d+$/.test(String(x.vx || ''))) bad.push(`${at}:vx ${x.vx}`);
    else if (vxs.has(String(x.vx))) bad.push(`${at}:重复 vx ${x.vx}`);
    vxs.add(String(x.vx));
    if (!String(x.n || '').trim()) bad.push(`${at}:缺少标题`);
    if (x.d) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(x.d))) bad.push(`${at}:日期 ${x.d}`);
      else cover.date += 1;
    }
    if (!(Number(x.s) > 0 && Number(x.s) <= 10)) bad.push(`${at}:评分 ${x.s}`);
    else cover.score += 1;
    if (!(Number(x.h) >= 0)) bad.push(`${at}:热度 ${x.h}`);
    if (x.img) {
      if (!/^https:\/\//.test(String(x.img))) bad.push(`${at}:封面 ${x.img}`);
      else cover.img += 1;
    }
    if (x.pl != null) {
      if (!Array.isArray(x.pl) || !x.pl.length || x.pl.some((p) => !String(p || '').trim()) ||
        new Set(x.pl).size !== x.pl.length) bad.push(`${at}:平台 ${JSON.stringify(x.pl)}`);
      else cover.pl += 1;
    }
    if (x.dev != null) {
      if (!Array.isArray(x.dev) || !x.dev.length || x.dev.some((d) => !String(d || '').trim()) ||
        new Set(x.dev).size !== x.dev.length) bad.push(`${at}:开发商 ${JSON.stringify(x.dev)}`);
      else cover.dev += 1;
    }
    if (x.tg != null) {
      if (!Array.isArray(x.tg) || !x.tg.length || new Set(x.tg).size !== x.tg.length ||
        x.tg.some((g) => !GENRE_IDS.has(g))) bad.push(`${at}:题材 ${JSON.stringify(x.tg)}`);
      else cover.tg += 1;
    }
    if (x.l != null && !(Number(x.l) > 0)) bad.push(`${at}:时长 ${x.l}`);
    ['sc', 'ar', 'mu'].forEach((k) => {
      if (x[k] != null && !String(x[k]).trim()) bad.push(`${at}:${k} 为空`);
    });
    if (x.rt || x.gc !== undefined || x.wc !== undefined) bad.push(`${at}:缓存字段泄漏`);
  });
  const ratio = (n) => (list.length ? n / list.length : 0);
  console.log(`VNDB 日系扩展：${list.length} 条（请求 ${extra.meta?.pages || 0} 页），异常 ${bad.length} 条`);
  console.log(`扩展覆盖：日期 ${(ratio(cover.date) * 100).toFixed(1)}% · 评分 ${(ratio(cover.score) * 100).toFixed(1)}% · ` +
    `封面 ${(ratio(cover.img) * 100).toFixed(1)}% · 平台 ${(ratio(cover.pl) * 100).toFixed(1)}% · ` +
    `开发商 ${(ratio(cover.dev) * 100).toFixed(1)}% · 题材 ${(ratio(cover.tg) * 100).toFixed(1)}%`);
  if (list.length < 500) {
    console.log(`FAIL VNDB 日系扩展过少：${list.length} < 500`);
    total += 1;
  }
  if (Number(extra.meta?.count) !== list.length) {
    console.log(`FAIL 扩展元信息数量不一致：${extra.meta?.count} != ${list.length}`);
    total += 1;
  }
  [
    ['日期', cover.date, 0.95], ['评分', cover.score, 0.95], ['封面', cover.img, 0.95],
    ['平台', cover.pl, 0.95], ['开发商', cover.dev, 0.95], ['题材', cover.tg, 0.85],
  ].forEach(([name, n, min]) => {
    if (ratio(n) < min) {
      console.log(`FAIL 扩展覆盖率不足：${name} ${(ratio(n) * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}%`);
      total += 1;
    }
  });
  if (bad.length) {
    console.log(`FAIL 扩展条目异常：${bad.slice(0, 5).join(', ')}`);
    total += bad.length;
  }
} catch (err) {
  console.log(`FAIL 扩展库不可用：${err.message}`);
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
const totalSize = mainSize + vndbSize + ymgalSize + extraSize + bgmExtraSize;
console.log(`体积：主库 ${(mainSize / 1024).toFixed(0)}KB + VNDB ${(vndbSize / 1024).toFixed(0)}KB + 月幕 ${(ymgalSize / 1024).toFixed(0)}KB + 扩展 ${(extraSize / 1024).toFixed(0)}KB + 关联 ${(bgmExtraSize / 1024).toFixed(0)}KB = ${(totalSize / 1024).toFixed(0)}KB`);
if (totalSize > 4000 * 1024) {
  console.log(`FAIL 数据体积超预算：${(totalSize / 1024).toFixed(0)}KB > 4000KB`);
  total += 1;
}

console.log(`问题总数：${total}`);
process.exit(total ? 1 : 0);
