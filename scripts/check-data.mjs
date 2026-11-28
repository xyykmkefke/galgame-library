// 数据质量校验：重复 ID、非法日期、评分越界、题材越界、平台数组异常、标题缺失、rt/gc/wc 泄漏
// 用法：node scripts/check-data.mjs
// 退出码 0 表示数据干净，1 表示存在问题

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { GENRES, suppressRelationalGenres } from './genres.mjs';

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
const mainVx = new Set();
try {
  const vraw = await readFile(path.join(ROOT, 'data', 'vndb.js'), 'utf8');
  const vm = vraw.match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/);
  if (!vm) throw new Error('未找到 window.GL_VNDB');
  const vndb = JSON.parse(vm[1]);
  const map = vndb.map || {};
  Object.values(map).forEach((v) => { if (v && v.v) mainVx.add(String(v.v)); });
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
// 新作索引需要跨文件查重，这里把扩展库的 id / vx 集合暴露到块外
const extraIdsAll = new Set();
const extraVxAll = new Set();
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
    else if (mainVx.has(String(x.vx))) bad.push(`${at}:与主库映射重复 ${x.vx}`);
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
  // 供新作索引查重：本文件的 id / vx 均已通过上面的格式校验
  list.forEach((x) => {
    extraIdsAll.add(String(x.i));
    if (x.vx) extraVxAll.add(String(x.vx));
  });
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

  // ---- 别名（al）语言白名单 ----
  // 扩展库的 al 有两个产出路径：构建期 fetch-vndb-extra.mjs 直接写、离线 fill-extra-aliases.mjs 补。
  // 两条路都必须只收 ja/zh 的拉丁转写 —— 实测 ru / ko / uk / th 音译混进来过。
  //
  // 判据演进（2026-11-27，两次都错了才落到最终版）：
  //   ① 初版用「西里尔/谚文/泰文正则」。**漏报**——生成端取的是 titles[].latin（罗马字转写），
  //      产物是纯 ASCII（`G-Seonsangui Mawang` 而非 `G선상의 마왕`），正则一个都抓不到。
  //   ② 改成「可追溯」：拿 data/build/vndb-titles.json 反查每个写法的来源语言，
  //      只有 lang ∈ AL_LANGS 或 en 才算合法。这才是真正在检查「白名单是否生效」，
  //      而不是在检查「结果长什么样」——后者换个产出形态就失效。
  // 副作用：索引覆盖不到的新条目会无法追溯，因此只把「能追溯到、且追溯到非白名单语言」
  // 判为越界；追溯不到的单独计数提示，不阻断（否则上游索引滞后会误伤）。
  let alBad = [];
  let alUnverifiable = 0;
  let alWrites = 0;
  let alEntries = 0;
  const AL_LANGS = new Set(['ja', 'zh-Hans', 'zh-Hant', 'zh']);
  const normAl = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');
  // 索引缺失（data/build/ 在 .gitignore 里，CI 与全新克隆都没有这个 16MB 文件）**不是缺陷**，
  // 必须与「索引在、但查出越界」区分开。早期写法是把两者都塞进 alBad → 兜底成一条 FAIL，
  // 结果 CI 上永远红：本地全绿、CI 全红，且报错文案指向「确认 AL_LANGS 是否生效」，
  // 完全误导方向（AL_LANGS 是对的，只是索引不在）。
  // 这不是新问题——同一段代码上方刚写过「追溯不到的单独计数提示、不阻断」，
  // 索引整体缺失是该原则的极端情形，却漏掉了。降级为提示并写明「本轮未校验」。
  let alSkipped = '';
  try {
    const tIdxRaw = await readFile(path.join(ROOT, 'data', 'build', 'vndb-titles.json'), 'utf8');
    const tIdx = new Map((JSON.parse(tIdxRaw).list || []).map((v) => [String(v.i), v]));
    for (const x of list) {
      if (!Array.isArray(x.al) || !x.al.length) continue;
      alEntries += 1;
      const src = tIdx.get(String(x.vx || '').replace(/^v/, ''));
      // 该条目所有「合法来源」写法（en 的 title + 白名单语言的 latin）
      const okSet = new Set();
      if (src) {
        (src.ti || []).forEach((z) => {
          if (z.l === 'en' && z.t) okSet.add(normAl(z.t));
          if (AL_LANGS.has(z.l) && z.la) okSet.add(normAl(z.la));
        });
      }
      for (const a of x.al) {
        alWrites += 1;
        if (!src) { alUnverifiable += 1; continue; }
        const k = normAl(a);
        if (okSet.has(k)) continue;
        // 自身标题 / 中文名 / 官方 aliases 也是合法来源（生成端顺序里包含它们）
        if (k === normAl(x.n) || (x.cn && k === normAl(x.cn))) continue;
        if (String(src.a || '').split(/\n+/).some((v) => normAl(v) === k)) continue;
        alBad.push(`${x.i}:${String(a).slice(0, 24)}`);
      }
    }
  } catch (err) {
    // 只把「文件不存在」降级为跳过；JSON 损坏之类的真问题仍应报出来
    if (err.code === 'ENOENT') alSkipped = '本地索引缺失（data/build/ 未入库，CI 常态）';
    else alBad = [`索引不可用：${err.message}`];
  }
  if (alBad.length) {
    console.log(`FAIL 扩展别名含非白名单语言来源：${alBad.length} 处（${alBad.slice(0, 3).join(', ')}）`);
    console.log('     修复：确认 fetch-vndb-extra.mjs / fill-extra-aliases.mjs 的 AL_LANGS 是否生效');
    total += 1;
  } else if (alSkipped) {
    console.log(`提示 扩展别名语言来源本轮未校验：${alSkipped}。本地有索引时会校验（${alEntries || list.length} 条待查）`);
  } else if (alEntries) {
    console.log(`PASS 扩展别名来源合法：${alEntries} 条 / ${alWrites} 个写法，均可追溯到 en 或 ja/zh` +
      (alUnverifiable ? `（${alUnverifiable} 处索引未覆盖，未校验）` : ''));
  }

  // ---- 兜底：非拉丁字符残留（不依赖索引，CI 上唯一生效的别名检查） ----
  // 上面那条「可追溯」检查需要本地索引，而 data/build/ 未入库 → **CI 上一直跳过、从未执行**。
  // 等于最重要的一道守卫在 CI 里是空转的，本地绿不绿都不代表 CI 在测。
  // 这里补一条纯正则检查：抓 al 里的西里尔 / 谚文 / 泰文 / 阿拉伯文。
  // 它抓不到「纯 ASCII 的俄语罗马化」（`Shkolnye Dni`）——那需要索引才能判，
  // 所以只在本地跑；但非拉丁字符残留是更常见也更严重的形态（详情页直接显示外文），
  // 有这一层至少让 CI 不是完全不查。两条互补，缺一不可。
  const NONLATIN = /[\u0400-\u04ff\uac00-\ud7af\u0e00-\u0e7f\u0600-\u06ff]/;
  const nonLatinBad = [];
  for (const x of list) {
    if (!Array.isArray(x.al)) continue;
    for (const a of x.al) {
      if (NONLATIN.test(String(a || ''))) nonLatinBad.push(`${x.i}:${String(a).slice(0, 20)}`);
    }
  }
  if (nonLatinBad.length) {
    console.log(`FAIL 扩展别名含非拉丁字符：${nonLatinBad.length} 处（${nonLatinBad.slice(0, 3).join(', ')}）`);
    total += 1;
  } else {
    console.log('PASS 扩展别名无非拉丁字符残留（西里尔/谚文/泰文/阿拉伯文）');
  }

  // ---- 制作人员词典化的 id 可解析性（前瞻守卫） ----
  // 计划把 sc/ar/mu 从「顿号分隔字符串」改成「词典 id 数组」（见 docs/staff-dict-plan.md）。
  // 切换后若 id 越界，staffValues() 会静默返回空字符串 —— 表现为「某作品的剧本/原画/music 突然没了」，
  // 且不会抛错、不会进 bad 列表。这条断言就是为那个时刻准备的：
  // 现在 staff 还是字符串，断言自动跳过；改成数组后开始生效。
  const staffBad = [];
  let staffIdItems = 0;
  for (const x of list) {
    for (const f of ['sc', 'ar', 'mu']) {
      const v = x[f];
      if (!Array.isArray(v)) continue;
      staffIdItems += 1;
      const dict = extra.staffDict;
      if (!Array.isArray(dict)) {
        staffBad.push(`${x.i}:${f}:缺少 staffDict`);
        continue;
      }
      v.forEach((id) => {
        if (!Number.isInteger(id) || id < 0 || id >= dict.length) {
          staffBad.push(`${x.i}:${f}:id ${id} 越界（词典 ${dict.length}）`);
        }
      });
    }
  }
  if (staffBad.length) {
    console.log(`FAIL 制作人员 id 无法解析：${staffBad.length} 处（${staffBad.slice(0, 3).join(', ')}）`);
    total += 1;
  } else if (staffIdItems) {
    console.log(`PASS 制作人员词典 id 全部可解析：${staffIdItems} 个字段数组`);
  }

  // ---- 词典完整性与一致性（2026-11-28 补，针对 --popularity-only 重建缺陷） ----
  // 背景：`fetch-vndb-extra.mjs --popularity-only` 会读回现有 vndb-extra.js 再追新条目。
  // 而 v2.40.0 之后读回的 list 已是 id 数组，早期 packStaffDict 只统计「字符串形态」的姓名
  // → 新词典仅由新条目构成，旧条目的 id 全部指向越界或错位的下标。
  // 实测过两种形态：词典从 7867 塌缩到 3，旧条目 [1669] 从「Looseboy」变成 undefined。
  //
  // 「id 越界」那类会被上面的守卫抓到，但更隐蔽的形态是 id 仍在范围内、却指向别人 ——
  // 那种情况 id 合法，只是人名错了，任何「范围校验」都发现不了。
  //
  // 这里用结构性判据（不依赖外部索引、CI 上同样生效）：
  // 词典是「按实际出现的姓名」构建的，所以每个 id 都必然被引用过 → 引用覆盖率必须 100%。
  // 重建缺陷会让词典里出现大量从未被引用的条目（或反向：引用了词典里没有的 id）。
  // 两个方向都查，任一不达标即 FAIL。
  if (Array.isArray(extra.staffDict)) {
    const dict = extra.staffDict;
    const usedIds = new Set();
    let refsTotal = 0;
    for (const x of list) {
      for (const f of ['sc', 'ar', 'mu']) {
        if (!Array.isArray(x[f])) continue;
        for (const id of x[f]) { if (Number.isInteger(id) && id >= 0 && id < dict.length) { usedIds.add(id); refsTotal += 1; } }
      }
    }
    const orphan = dict.length - usedIds.size;
    const dupNames = dict.length - new Set(dict).size;
    const emptyNames = dict.filter((n) => typeof n !== 'string' || !n.trim()).length;
    if (refsTotal === 0) {
      // 词典存在但一条引用都没有：说明数据形态与词典脱节
      console.log(`FAIL 制作人员词典无任何引用（词典 ${dict.length} 个，数据里 0 个 id 数组）`);
      total += 1;
    } else if (orphan > 0 || dupNames > 0 || emptyNames > 0) {
      console.log(`FAIL 制作人员词典不完整：孤儿 ${orphan} 个 / 重名 ${dupNames} 个 / 空名 ${emptyNames} 个` +
        `（词典 ${dict.length}，被引用 ${usedIds.size}）`);
      console.log('     常见原因：--popularity-only 重建时未带上旧 staffDict');
      total += 1;
    } else {
      console.log(`PASS 制作人员词典完整：${dict.length} 个全部被引用（引用 ${refsTotal} 次），无重名空名`);
    }
  }
} catch (err) {
  console.log(`FAIL 扩展库不可用：${err.message}`);
  total += 1;
}

// ---------- 新作索引（VNDB 2025 起，不设票数门槛） ----------
// 需要与主库、扩展库做 id / vx 冲突校验，这里取用前面已收集的全局集合
const mainIdsAll = new Set(data.map((x) => String(x.i)));
let recentSize = 0;
try {
  const rraw = await readFile(path.join(ROOT, 'data', 'recent-extra.js'), 'utf8');
  recentSize = Buffer.byteLength(rraw, 'utf8');
  const rm = rraw.match(/window\.GL_RECENT\s*=\s*(\{[\s\S]*\});/);
  if (!rm) throw new Error('未找到 window.GL_RECENT');
  const recent = JSON.parse(rm[1]);
  const list = Array.isArray(recent.list) ? recent.list : [];
  const since = String(recent.meta?.filter?.releasedGte || '').trim();
  if (!since) {
    console.log('FAIL 新作索引 meta.filter.releasedGte 缺失，无法判定范围');
    total += 1;
  }
  const sinceYear = (since || '2025-01-01').slice(0, 4);
  const ids = new Set();
  const vxs = new Set();
  const bad = [];
  const cover = { date: 0, img: 0, pl: 0, dev: 0 };
  list.forEach((x, idx) => {
    const at = `${idx}:${x.i}`;
    const key = String(x.i);
    if (!Number.isInteger(Number(x.i)) || Number(x.i) < 1000000) bad.push(`${at}:非法 i`);
    else if (mainIdsAll.has(key)) bad.push(`${at}:与主库冲突`);
    else if (extraIdsAll.has(key)) bad.push(`${at}:与扩展库冲突`);
    else if (ids.has(key)) bad.push(`${at}:重复 i`);
    ids.add(key);
    if (!/^v\d+$/.test(String(x.vx || ''))) bad.push(`${at}:vx ${x.vx}`);
    else if (mainVx.has(String(x.vx)) || extraVxAll.has(String(x.vx))) bad.push(`${at}:vx 与已有映射重复 ${x.vx}`);
    else if (vxs.has(String(x.vx))) bad.push(`${at}:重复 vx ${x.vx}`);
    vxs.add(String(x.vx));
    if (!String(x.n || '').trim()) bad.push(`${at}:缺少标题`);
    // 日期允许两种精度：完整日期 2025-03-14，或只有年份 2025（VNDB 未公布月日）
    const ds = String(x.d || '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(ds) || /^\d{4}$/.test(ds)) {
      if (ds.slice(0, 4) < sinceYear) bad.push(`${at}:早于 ${since} 的日期 ${ds}`);
      else cover.date += 1;
    } else {
      bad.push(`${at}:日期 ${x.d}`);
    }
    if (x.s != null && !(Number(x.s) > 0 && Number(x.s) <= 10)) bad.push(`${at}:评分 ${x.s}`);
    if (x.h != null && !(Number(x.h) >= 0)) bad.push(`${at}:热度 ${x.h}`);
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
    if (x.cn != null && !String(x.cn).trim()) bad.push(`${at}:cn 为空`);
    if (x.rn !== 1) bad.push(`${at}:缺少 rn 标记`);
    // 乙女向是项目既定排除项（data/blocklist-otome.json），新作索引也必须遵守
    if ((x.tg || []).includes('oto')) bad.push(`${at}:乙女向未排除`);
    if (x.rt || x.gc !== undefined || x.wc !== undefined) bad.push(`${at}:缓存字段泄漏`);
  });
  const ratio = (n) => (list.length ? n / list.length : 0);
  const tgCover = list.filter((x) => x.tg && x.tg.length).length;
  const withAl = list.filter((x) => Array.isArray(x.al) && x.al.length).length;
  console.log(`新作索引：${list.length} 条（抓取 ${recent.meta?.fetched || 0}，跳过已有 ${recent.meta?.skippedExisting || 0}，` +
    `released >= ${since}），异常 ${bad.length} 条`);
  console.log(`新作覆盖：日期 ${(ratio(cover.date) * 100).toFixed(1)}% · 封面 ${(ratio(cover.img) * 100).toFixed(1)}% · ` +
    `平台 ${(ratio(cover.pl) * 100).toFixed(1)}% · 开发商 ${(ratio(cover.dev) * 100).toFixed(1)}% · ` +
    `题材 ${(ratio(tgCover) * 100).toFixed(1)}%（新作票数少，标签权重普遍不足，覆盖率天然偏低）`);
  console.log(`新作别名：${withAl} 条有 al（${(ratio(withAl) * 100).toFixed(1)}%）`);
  if (list.length < 200) {
    console.log(`FAIL 新作索引过少：${list.length} < 200`);
    total += 1;
  }
  if (Number(recent.meta?.count) !== list.length) {
    console.log(`FAIL 新作元信息数量不一致：${recent.meta?.count} != ${list.length}`);
    total += 1;
  }
  // 新作索引刻意收录未积累票数的作品，故只校验「必备字段」，不设评分/票数覆盖率
  [['日期', cover.date, 1], ['封面', cover.img, 0.9]].forEach(([name, n, min]) => {
    if (ratio(n) < min) {
      console.log(`FAIL 新作覆盖率不足：${name} ${(ratio(n) * 100).toFixed(1)}% < ${(min * 100).toFixed(0)}%`);
      total += 1;
    }
  });
  // 重建新作索引会清空 al；补别名是独立步骤，覆盖率跌破 85% 多半是忘了跑 fill-extra-aliases
  if (ratio(withAl) < 0.85) {
    console.log(`FAIL 新作别名覆盖不足：${(ratio(withAl) * 100).toFixed(1)}% < 85%（重建后需运行 node scripts/fill-extra-aliases.mjs --apply）`);
    total += 1;
  }
  if (bad.length) {
    console.log(`FAIL 新作条目异常：${bad.slice(0, 5).join(', ')}`);
    total += bad.length;
  }
} catch (err) {
  console.log(`FAIL 新作索引不可用：${err.message}`);
  total += 1;
}

// ---------- 别名覆盖：同组内任一写法都要能搜到同一条 ----------
//
// 这是「中英日任一写法搜索都命中同一条」的守护断言。
// 判据不看命中数是否相等（标题里本来就可能有别的词的子串，如「雨音スイッチ」含「スイッチ」），
// 只看「不丢目标」：某条目只要组内有一个写法能搜到，同组其他写法也必须能搜到。
try {
  const agRaw = await readFile(path.join(ROOT, 'data', 'alias-groups.js'), 'utf8');
  const agm = agRaw.match(/window\.GL_ALIAS_GROUPS\s*=\s*([\s\S]*);/);
  if (!agm) throw new Error('未找到 window.GL_ALIAS_GROUPS');
  const AG = JSON.parse(agm[1]);

  // 组库 = 主库 + 三个扩展库，与前端 adoptData / mergeExtraData 保持一致
  let pool = data.slice();
  const addExtra = async (file, re, flag) => {
    try {
      const s = await readFile(path.join(ROOT, 'data', file), 'utf8');
      const m = s.match(re);
      if (!m) return;
      const v = JSON.parse(m[1]);
      (v.list || []).forEach((x) => { x[flag] = 1; pool.push(x); });
    } catch { /* 缺失已在其他检查里报错 */ }
  };
  await addExtra('bgm-extra.js', /window\.GL_BGM_EXTRA\s*=\s*([\s\S]*);/, 'bg');
  await addExtra('vndb-extra.js', /window\.GL_VNDB_EXTRA\s*=\s*([\s\S]*);/, 'ex');
  await addExtra('recent-extra.js', /window\.GL_RECENT\s*=\s*([\s\S]*);/, 'rn');

  // 按连通分量去重：dev 表每个写法都是 key，同一组会重复出现多次
  const dedupe = (table) => {
    const seen = new Set();
    const out = {};
    Object.entries(table).forEach(([k, v]) => {
      const names = Array.isArray(v) ? [k].concat(v) : [v.c].concat(v.a || []);
      const sig = names.slice().sort().join('\u0001');
      if (seen.has(sig)) return;
      seen.add(sig);
      out[k] = Array.isArray(v) ? v : (v.a || []);
    });
    return out;
  };

  // 数据文件里的 dev / pl 是「归一后」的写法，dva / pla 是运行时才注入的。
  // 校验脚本不跑前端，所以要在这里复现同一套装饰：原始写法 + 复合名拆段 + 同组别名闭包。
  const DEV_MAP = await (async () => {
    try {
      const s = await readFile(path.join(ROOT, 'data', 'dev-alias.js'), 'utf8');
      const m = s.match(/window\.GL_DEV_ALIAS\s*=\s*([\s\S]*);/);
      return m ? JSON.parse(m[1]).map || {} : {};
    } catch { return {}; }
  })();

  const lowerIdx = (t) => {
    const m = Object.create(null);
    Object.keys(t).forEach((k) => { m[k.toLowerCase()] = t[k]; });
    return m;
  };
  const DEV_L = lowerIdx(AG.dev || {});
  const PLAT_L = lowerIdx(AG.plat || {});
  const variants = (name, table, lower) => {
    if (!name) return [];
    const hit = table[name] || lower[String(name).toLowerCase()];
    if (!hit) return [];
    return Array.isArray(hit) ? hit : [hit.c].concat(hit.a || []);
  };

  // 单条记录的「可搜开发商名集合」
  const devNamesOf = (x) => {
    const raw = x.dev || [];
    const out = new Set();
    raw.forEach((d) => out.add(String(d)));
    // 归一后的标准名（数据里已是标准名，但 dev-alias 仍可能再映射一层）
    const canon = [];
    raw.forEach((d) => {
      const c = DEV_MAP[d] || d;
      if (canon.indexOf(c) < 0) canon.push(c);
    });
    canon.forEach((c) => {
      String(c).split(/[\/／]/).forEach((p) => {
        const t = p.trim();
        if (!t) return;
        out.add(t);
        variants(t, AG.dev || {}, DEV_L).forEach((v) => out.add(String(v)));
      });
    });
    return [...out];
  };

  // 单条记录的「可搜平台名集合」
  const platNamesOf = (x) => {
    const out = new Set();
    (x.pl || []).forEach((p) => {
      out.add(String(p));
      const v = variants(p, AG.plat || {}, PLAT_L);
      (v.length ? v : [p]).forEach((n) => out.add(String(n)));
    });
    return [...out];
  };

  // 倒排索引：写法（小写）-> 条目 id 集合
  const buildIndex = (field) => {
    const idx = new Map();
    pool.forEach((x) => {
      const names = field === 'dev' ? devNamesOf(x) : platNamesOf(x);
      const seen = new Set();
      names.forEach((n) => {
        const key = String(n || '').trim().toLowerCase();
        if (!key || seen.has(key)) return;
        seen.add(key);
        if (!idx.has(key)) idx.set(key, new Set());
        idx.get(key).add(String(x.i));
      });
    });
    return idx;
  };

  const checkGroups = (label2, groups, field) => {
    const idx = buildIndex(field);
    const bad = [];
    Object.entries(groups).forEach(([std, aliases]) => {
      const names = [std].concat(aliases || []);
      if (names.length < 2) return;
      const sets = names.map((n) => ({ n, s: idx.get(String(n).toLowerCase()) || new Set() }));
      const union = new Set();
      sets.forEach(({ s }) => s.forEach((id) => union.add(id)));
      union.forEach((id) => {
        const missing = sets.filter(({ s }) => !s.has(id));
        if (missing.length) bad.push(`${id}「${std}」漏 ${missing.map((m) => m.n).join('/')}`);
      });
    });
    if (bad.length) {
      console.log(`FAIL ${label2}别名覆盖：${bad.length} 条同组写法不能互相命中`);
      bad.slice(0, 8).forEach((b) => console.log(`     ${b}`));
      total += 1;
    } else {
      const groupCount = Object.keys(groups).length;
      console.log(`PASS ${label2}别名覆盖：${groupCount} 组内任一写法均能命中同一条`);
    }
  };

  checkGroups('开发商', dedupe(AG.dev || {}), 'dev');
  checkGroups('平台', dedupe(AG.plat || {}), 'pl');

  // 题材别名：写法 -> 题材 id，必须是运行时 tg 字段真实存在的 id。
  //
  // 曾经的真实缺陷：build-alias-groups.mjs 用 Object.entries(GENRES) 取 id，
  // GENRES 是数组，于是 id 变成数组下标 "0"/"1"/"2"，与 tg 的 sci/fan/rom 完全对不上，
  // 104 个题材写法全部失效。这条断言就是防它复发——id 必须能在数据里找到。
  {
    const genreMap = AG.genre || {};
    const keys = Object.keys(genreMap);
    const realIds = new Set();
    pool.forEach((x) => (x.tg || []).forEach((t) => realIds.add(String(t))));
    const badIds = [...new Set(Object.values(genreMap))].filter((id) => !realIds.has(String(id)) && !/^$/.test(id));
    // 允许「有同义词但库里没条目」的题材（如 oto 乙女，本库定位排除乙女向），
    // 但 id 必须是 GENRES 里定义过的合法 id——不能是数组下标这种错位产物。
    const validIds = new Set(['sci', 'fan', 'rom', 'sch', 'sli', 'mys', 'det', 'nak', 'dep',
      'hor', 'gru', 'bat', 'adv', 'yur', 'bl', 'har', 'jk', 'mec', 'oto', 'nukige']);
    const invalidIds = [...new Set(Object.values(genreMap))].filter((id) => !validIds.has(String(id)));
    if (invalidIds.length) {
      console.log(`FAIL 题材别名指向非法 id：${invalidIds.slice(0, 5).join('/')}（应为 sci/fan/rom 等，不是数组下标）`);
      total += 1;
    } else if (badIds.length) {
      // 合法 id 但库里没条目：不报错，只提示（乙女向不在本库范围内属正常）
      console.log(`提示 题材别名中 ${badIds.length} 个 id 暂无对应条目（${badIds.join('/')}），不影响搜索`);
    }
    if (keys.length === 0) {
      console.log('FAIL 题材别名为空：题材同义词搜索会全部失效');
      total += 1;
    } else if (!invalidIds.length) {
      console.log(`PASS 题材别名：${keys.length} 个写法覆盖 ${new Set(Object.values(genreMap)).size} 个题材，id 合法`);
    }
    // 中文标签必须能在别名表里查到，否则「题材:恋爱」这种最自然的输入会失效
    const missingLabels = ['恋爱', '科幻', '奇幻', '校园', '百合', '拔作'].filter((lb) => !genreMap[lb]);
    if (missingLabels.length) {
      console.log(`FAIL 正名标签不在题材别名表：${missingLabels.join('/')}`);
      total += 1;
    }
  }
} catch (err) {
  console.log(`FAIL 别名组不可用：${err.message}`);
  total += 1;
}

// ---------- 补全快照新鲜度 ----------
// 为什么必须有这道检查：
//   fetch-games.mjs 重建时会整份重写 galgames.js，补全字段（别名/开发商/制作人员/题材）
//   只能靠 data/enrich-main.json 快照叠回来。快照一旦落后于主库，重建就会静默丢掉
//   比快照新的那些字段 —— 而「静默」正是最贵的：v2.31.0 就是这么丢了 877 条别名，
//   直到有人去看详情页才发现。HANDOVER 68.8 把「自动比对快照新鲜度并告警」列为未做，
//   这里补上。判据必须与 fetch-games.mjs 的合并逻辑完全一致，否则会误报。
//
// 语义对齐要点：重建时是「抓取侧没值才用快照兜底」（hasCur 为真就跳过快照）。
//   所以「主库有值、快照没值」本身不构成丢失；只有当该字段在快照里「一条都没有」
//   时，重建后才会整段消失。据此把风险分两级：缺整字段=FAIL，缺单条=仅提示。
try {
  const snapRaw = await readFile(path.join(ROOT, 'data', 'enrich-main.json'), 'utf8');
  const snap = JSON.parse(snapRaw);
  const snapItems = snap.items || {};
  const snapFields = Array.isArray(snap.fields) && snap.fields.length
    ? snap.fields
    : ['al', 'dev', 'sc', 'ar', 'mu', 'tg'];
  const hasVal = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && String(v).trim() !== '');
  // 与 fetch-games.mjs 同款：快照里存的是「过完抑制」的题材，比对前主库侧也要过一遍
  const curVal = (x, f) => (f === 'tg' && Array.isArray(x[f]) ? suppressRelationalGenres(x[f], x.gt || '', x.cn || x.n || '') : x[f]);

  let snapAbsentEnt = 0;   // 主库有补全字段、但整条不在快照里
  let snapAbsentFld = 0;   // 同上，按字段计
  let snapGapFld = 0;      // 条目在快照里，但该字段快照没存
  const snapGapSample = [];
  for (const x of data) {
    const rec = snapItems[String(x.i)];
    const filledFields = snapFields.filter((f) => hasVal(curVal(x, f)));
    if (!filledFields.length) continue;
    if (!rec) {
      snapAbsentEnt += 1;
      snapAbsentFld += filledFields.length;
      if (snapGapSample.length < 3) snapGapSample.push(`${x.i}:${filledFields.join('/')}`);
      continue;
    }
    for (const f of filledFields) {
      if (hasVal(rec[f])) continue;
      snapGapFld += 1;
      if (snapGapSample.length < 3) snapGapSample.push(`${x.i}:${f}`);
    }
  }

  const snapDate = String(snap.updatedAt || '');
  const snapAge = snapDate ? Math.round((Date.now() - new Date(snapDate + 'T00:00:00Z').getTime()) / 86400000) : -1;
  const snapTotal = snapAbsentFld + snapGapFld;

  if (snapTotal === 0) {
    console.log(`PASS 补全快照新鲜：无重建丢失风险（快照 ${Object.keys(snapItems).length} 条，${snapDate || '日期未知'}）`);
  } else if (snapAbsentFld > 0) {
    // 整条缺失是硬伤：重建后这些条目的补全字段会全部蒸发
    console.log(`FAIL 补全快照落后主库：${snapAbsentEnt} 条主库条目不快照里，重建将丢失 ${snapAbsentFld} 处字段（示例 ${snapGapSample.join(' ')}）`);
    console.log('     修复：node scripts/snapshot-enrich.mjs --apply');
    total += 1;
  } else {
    // 仅个别字段缺失：重建会丢，但不至于整条清空，提示即可，避免阻断正常流程
    console.log(`提示 补全快照有 ${snapGapFld} 处字段缺口（不影响整条，重建时会丢这些值）：node scripts/snapshot-enrich.mjs --apply 可补齐`);
  }
  if (snapAge > 30) {
    console.log(`提示 补全快照已 ${snapAge} 天未更新（${snapDate}），主库新增条目不会自动进快照`);
  }
} catch (err) {
  console.log(`FAIL 补全快照不可用：${err.message}`);
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
const totalSize = mainSize + vndbSize + ymgalSize + extraSize + bgmExtraSize + recentSize;
console.log(`体积：主库 ${(mainSize / 1024).toFixed(0)}KB + VNDB ${(vndbSize / 1024).toFixed(0)}KB + 月幕 ${(ymgalSize / 1024).toFixed(0)}KB + 扩展 ${(extraSize / 1024).toFixed(0)}KB + 关联 ${(bgmExtraSize / 1024).toFixed(0)}KB + 新作 ${(recentSize / 1024).toFixed(0)}KB = ${(totalSize / 1024).toFixed(0)}KB`);
if (totalSize > 4000 * 1024) {
  console.log(`FAIL 数据体积超预算：${(totalSize / 1024).toFixed(0)}KB > 4000KB`);
  total += 1;
}

console.log(`问题总数：${total}`);
process.exit(total ? 1 : 0);
