// 构建系列映射：优先用 VNDB 强关系（ser / seq / preq）的连通分量，标题前缀法只做兜底。
// 输出 data/series.js（提交），运行时只查表，不在前端跑图算法。
//
// 用法：
//   node scripts/build-series.mjs            # 读取 data/build/vndb-relations.json，生成 data/series.js
//   node scripts/build-series.mjs --dry       # 只打印统计，不写文件
//
// 设计要点：
//   - 只有多成员强关系组才登记为系列；单例不登记。
//   - 标题组里若已有 >=2 个成员落在同一个关系组，则把该标题组中「没有 VNDB id」的残留成员并入该关系组；
//     有 VNDB id 但属于其他分量的成员不强行拉回，保留关系法的拆分精度。
//   - 完全没有关系覆盖的标题组仍登记为系列，保证主库无 VNDB 映射的条目有归属。
//   - scripts/series-blocklist.json 可选：命中的条目不参与系列（不删数据、不影响搜索筛选）。
//   - 身份用稳定 sid（s1、s2…），展示名单独维护；旧标题名写入 alias，兼容旧 hash / 视图。

import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'data');
const REL_FILE = path.join(DATA, 'build', 'vndb-relations.json');
const OUT_FILE = path.join(DATA, 'series.js');
const BLOCK_FILE = path.join(ROOT, 'scripts', 'series-blocklist.json');
const DRY = process.argv.includes('--dry');
const TYPES = ['preq', 'seq', 'ser'];
const STRONG = new Set(TYPES);

async function readWindow(file, name) {
  const raw = await readFile(file, 'utf8');
  const m = raw.match(new RegExp(`window\\.${name}\\s*=\\s*([\\[{][\\s\\S]*?[\\]}]);`));
  if (!m) throw new Error(`未找到 window.${name}：${file}`);
  return JSON.parse(m[1]);
}

function normalizeTitle(value) {
  return String(value || '').normalize('NFKC').trim();
}

// 与 index.html 的 seriesKey 保持一致，作为标题兜底
function seriesKey(item) {
  const raw = normalizeTitle(item.cn || item.n || '');
  if (!raw) return '';
  let base = raw;
  const parts = raw.split(/[～~：:]/);
  if (parts.length > 1 && parts[0].trim().length >= 2) base = parts[0].trim();
  base = base.replace(
    /\s*(第[0-9０-９一二三四五六七八九十]+[章話话部巻卷]|[0-9０-９]+|Vol\.?|FD|ファンディスク|完全版|通常版|体験版|前編|後編|続編|外伝|资料片|重制版)$/i,
    '',
  ).trim();
  if (base.length < 2) return raw;
  if (/^[\x00-\x7F]+$/.test(base) && base.length < 3) return raw;
  return base;
}

function shortName(value) {
  let s = normalizeTitle(value).split(/[～~：:]/)[0].trim();
  s = s.replace(/\s*(第[0-9０-９一二三四五六七八九十]+[章話话部巻卷]|[0-9０-９]+|Vol\.?|FD|完全版|通常版|体験版|前編|後編|続編|外伝)$/i, '').trim();
  return s.slice(0, 24) || normalizeTitle(value).slice(0, 24);
}

function loadBlocklist(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  return list
    .filter((r) => r && (r.title || r.dev))
    .map((r) => ({
      title: r.title ? new RegExp(r.title, 'i') : null,
      dev: r.dev ? new RegExp(r.dev, 'i') : null,
      reason: r.reason || '',
    }));
}

function blocked(item, rules) {
  const title = String(item.cn || item.n || '');
  const dev = Array.isArray(item.dev) ? item.dev.join(' ') : String(item.dev || '');
  return rules.some((r) => (!r.title || r.title.test(title)) && (!r.dev || r.dev.test(dev)));
}

async function main() {
  const mainData = await readWindow(path.join(DATA, 'galgames.js'), 'GL_DATA');
  const vndb = await readWindow(path.join(DATA, 'vndb.js'), 'GL_VNDB');
  const extra = await readWindow(path.join(DATA, 'vndb-extra.js'), 'GL_VNDB_EXTRA');
  const bgm = await readWindow(path.join(DATA, 'bgm-extra.js'), 'GL_BGM_EXTRA');
  const rel = JSON.parse(await readFile(REL_FILE, 'utf8'));
  let blockRaw = null;
  try { blockRaw = JSON.parse(await readFile(BLOCK_FILE, 'utf8')); } catch { /* 可选文件 */ }
  const rules = loadBlocklist(blockRaw);

  const vmap = (vndb && vndb.map) || {};
  const items = [];
  let blockedCount = 0;
  const push = (item) => {
    if (!item.n && !item.cn) return;
    if (item.k === 'off') { blockedCount += 1; return; }
    if (blocked(item, rules)) { blockedCount += 1; return; }
    items.push(item);
  };

  mainData.forEach((x) => {
    const v = vmap[String(x.i)] && vmap[String(x.i)].v;
    push({
      key: v ? String(v) : `b:${x.i}`,
      vid: v ? String(v) : '',
      id: `b:${x.i}`,
      n: x.n || '',
      cn: x.cn || '',
      d: x.d || '',
      h: Number(x.h) || 0,
      s: Number(x.s) || 0,
      dev: x.dev || [],
      k: x.k || '',
    });
  });
  (extra.list || []).forEach((x) => {
    push({
      key: String(x.vx),
      vid: String(x.vx),
      id: `v:${x.vx}`,
      n: x.n || '',
      cn: x.cn || '',
      d: x.d || '',
      h: Number(x.h) || 0,
      s: Number(x.s) || 0,
      dev: x.dev || [],
      k: x.k || '',
    });
  });
  (bgm.list || []).forEach((x) => {
    push({
      key: `b:${x.i}`,
      vid: '',
      id: `b:${x.i}`,
      n: x.n || '',
      cn: x.cn || '',
      d: x.d || '',
      h: Number(x.h) || 0,
      s: Number(x.s) || 0,
      dev: x.dev || [],
      k: x.k || '',
    });
  });

  const vids = new Set(items.filter((x) => x.vid).map((x) => x.vid));
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  vids.forEach((v) => parent.set(v, v));
  let edgeCount = 0;
  Object.entries((rel && rel.edges) || {}).forEach(([from, arr]) => {
    if (!Array.isArray(arr) || !vids.has(from)) return;
    arr.forEach(([to, type]) => {
      if (!STRONG.has(type) || !vids.has(String(to))) return;
      union(from, String(to));
      edgeCount += 1;
    });
  });

  const comps = new Map();
  vids.forEach((v) => {
    const r = find(v);
    if (!comps.has(r)) comps.set(r, []);
    comps.get(r).push(v);
  });
  const compList = [...comps.values()].filter((c) => c.length >= 2);

  // vid -> 关系组编号（仅多成员组）
  const relSid = new Map();
  compList.forEach((c, i) => c.forEach((v) => relSid.set(v, i)));

  // 标题组
  const titleGroups = new Map();
  items.forEach((x) => {
    const k = seriesKey(x);
    if (!k) return;
    if (!titleGroups.has(k)) titleGroups.set(k, []);
    titleGroups.get(k).push(x);
  });
  const validTitleGroups = [...titleGroups.entries()].filter(([, arr]) => {
    const titles = new Set(arr.map((x) => normalizeTitle(x.cn || x.n)));
    return arr.length >= 2 && titles.size >= 2;
  });

  // 标题组 -> 关系组：若 >=2 个成员已在同一关系组，把该标题组的无 VNDB id 成员并进去
  const titleToRel = new Map();
  validTitleGroups.forEach(([key, arr]) => {
    const counts = new Map();
    arr.forEach((x) => {
      if (x.vid && relSid.has(x.vid)) {
        const sid = relSid.get(x.vid);
        counts.set(sid, (counts.get(sid) || 0) + 1);
      }
    });
    let best = -1;
    let bestN = 0;
    counts.forEach((n, sid) => { if (n > bestN) { best = sid; bestN = n; } });
    if (best >= 0 && bestN >= 2) titleToRel.set(key, best);
  });

  // 关系组 -> 条目（含并入的无 VNDB id 残留成员）
  const compItems = new Map();
  items.forEach((x) => {
    if (x.vid && relSid.has(x.vid)) {
      const sid = relSid.get(x.vid);
      if (!compItems.has(sid)) compItems.set(sid, []);
      compItems.get(sid).push(x);
      return;
    }
    const key = seriesKey(x);
    if (!x.vid && key && titleToRel.has(key)) {
      x.titleFallback = key;
      const sid = titleToRel.get(key);
      if (!compItems.has(sid)) compItems.set(sid, []);
      compItems.get(sid).push(x);
    }
  });

  // 系列集合：关系组 + 未被并入的标题组
  const series = [];
  compList.forEach((c, i) => {
    const arr = compItems.get(i) || [];
    if (arr.length >= 2) series.push({ items: arr, source: 'relations', key: `r${i}` });
  });
  validTitleGroups.forEach(([key, arr]) => {
    const rest = arr.filter((x) => !x.titleFallback);
    const noRel = rest.filter((x) => !x.vid || !relSid.has(x.vid));
    if (noRel.length >= 2 && noRel.length === rest.length) {
      series.push({ items: rest, source: 'title', key });
    }
  });

  // 命名
  const nameCount = new Map();
  function pickName(s) {
    const arr = s.items;
    const freq = new Map();
    arr.forEach((x) => { const k = seriesKey(x); if (k) freq.set(k, (freq.get(k) || 0) + 1); });
    let bestKey = '';
    let bestN = 0;
    freq.forEach((n, k) => { if (n > bestN) { bestKey = k; bestN = n; } });
    let name;
    if (bestKey && bestN / arr.length >= 0.8) name = bestKey;
    else {
      const top = [...arr].sort((a, b) => (b.h - a.h) || (b.s - a.s) || String(a.d).localeCompare(String(b.d)))[0];
      name = shortName(top.cn || top.n);
    }
    if (!name) name = '未命名系列';
    const seen = nameCount.get(name) || 0;
    nameCount.set(name, seen + 1);
    return seen ? `${name} ${seen + 1}` : name;
  }

  series.forEach((s) => { s.name = pickName(s); });

  // 稳定排序：成员数降序、最早发售日升序、名称
  series.sort((a, b) => {
    if (b.items.length !== a.items.length) return b.items.length - a.items.length;
    const da = a.items.map((x) => x.d).filter(Boolean).sort()[0] || '9999';
    const db = b.items.map((x) => x.d).filter(Boolean).sort()[0] || '9999';
    if (da !== db) return da.localeCompare(db);
    return a.name.localeCompare(b.name);
  });

  const n = [''];
  const m = {};
  const alias = {};
  let assigned = 0;
  series.forEach((s, idx) => {
    const sid = idx + 1;
    n.push(s.name);
    s.items.forEach((x) => { if (!(x.key in m)) { m[x.key] = sid; assigned += 1; } });
  });

  validTitleGroups.forEach(([key, arr]) => {
    const counts = new Map();
    arr.forEach((x) => {
      const sid = m[x.key];
      if (sid) counts.set(sid, (counts.get(sid) || 0) + 1);
    });
    let best = 0;
    let bestN = 0;
    counts.forEach((c, sid) => { if (c > bestN) { best = sid; bestN = c; } });
    if (best) alias[key] = best;
  });

  const inputHash = createHash('sha1');
  for (const f of ['galgames.js', 'vndb.js', 'vndb-extra.js', 'bgm-extra.js']) {
    inputHash.update(await readFile(path.join(DATA, f)));
  }
  inputHash.update(TYPES.join(','));
  inputHash.update(JSON.stringify(blockRaw || {}));

  let aliasSplit = 0;
  validTitleGroups.forEach(([, arr]) => {
    const sids = new Set(arr.map((x) => m[x.key]).filter(Boolean));
    if (sids.size > 1) aliasSplit += 1;
  });

  const meta = {
    generatedAt: new Date().toISOString(),
    source: 'vndb-relations',
    types: TYPES,
    series: series.length,
    items: assigned,
    alias: Object.keys(alias).length,
    aliasSplit,
    blocked: blockedCount,
    strongEdges: edgeCount,
    fingerprint: 'sha1:' + inputHash.digest('hex'),
  };

  const payload = { v: 1, meta, n, m, a: alias };
  const content = '// 由 scripts/build-series.mjs 生成，请勿手动修改\n' +
    'window.GL_SERIES = ' + JSON.stringify(payload) + ';\n';

  console.log(`系列 ${meta.series} 个，覆盖 ${meta.items} 条；别名 ${meta.alias}；强关系边 ${edgeCount}`);
  console.log(`最大系列：${series.slice(0, 20).map((s) => s.name + '(' + s.items.length + ')').join(' / ')}`);
  console.log(`体积约 ${(Buffer.byteLength(content) / 1024).toFixed(1)}KB`);

  if (!DRY) {
    await writeFile(OUT_FILE, content, 'utf8');
    console.log(`输出：${OUT_FILE}`);
  } else {
    console.log('dry-run，未写文件');
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
