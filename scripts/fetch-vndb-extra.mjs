// 从 VNDB 公共 Kana API 拉取「日系 galgame 扩展库」，独立成文件，不修改主库
// 用法：
//   node scripts/fetch-vndb-extra.mjs                 默认热度 3000 条 + 关系补全
//   node scripts/fetch-vndb-extra.mjs --limit=2000    指定热度条数
//
// 两段式：
//   1) 按热度降序拉取 olang=ja、评分 >= 60、投票 >= 10 的作品，取前 limit 条；
//   2) 以主库 VNDB 映射 + 扩展库为种子，批量读取 relations，补同系列 / 同设定 / 前传续作等
//      相关作品（跳过 char / fan 这类同人衍生关系），再补齐完整元数据。
// 已出现在主库 VNDB 映射里的 id，以及标题与主库 / 月幕别名归一后相同的条目全部跳过，
// 保证扩展库不与主库重复。输出 data/vndb-extra.js，页面按扩展键合并展示。
//
// VNDB 匿名限流约 200 次 / 5 分钟，这里分页间隔 1s、关系查询间隔 1.6s，命中 429 时等待 60s 再重试。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mapVndbGenres } from './vndb-genre-map.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'vndb-extra.js');
const BLOCK_FILE = path.join(ROOT, 'data', 'blocklist.json');
const OTOME_FILE = path.join(ROOT, 'data', 'blocklist-otome.json');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 3000;
const POP_ONLY = process.argv.includes('--popularity-only');
const PAGE_SIZE = 100;
const MAX_PAGE = 120;
const DELAY_MS = 1000;
const BATCH_SIZE = 50;
const REL_DELAY_MS = 1600;
const PROD_BATCH = 20;
const PROD_PAGE_MAX = 3;
const PROD_DELAY_MS = 2200;
const FIELDS = 'id,title,alttitle,titles.title,titles.lang,image.url,released,rating,votecount,length_minutes,developers.name,platforms,staff{id,name,role},tags.name,tags.rating,tags.spoiler';
const FULL_FIELDS = FIELDS + ',olang';
const FILTERS = ['and', ['olang', '=', 'ja'], ['rating', '>=', 60], ['votecount', '>=', 10]];
// 只跟随官方作品关系；char（共用角色）与 fan（同人）会引入大量衍生小游戏
const RELATION_TYPES = new Set(['seq', 'preq', 'set', 'alt', 'side', 'par', 'ser', 'sub', 'orig']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 非 gal 黑名单（按 VNDB id）；缺失时返回空集，不阻塞抓取
async function loadBlockSet() {
  try {
    const data = JSON.parse(await readFile(BLOCK_FILE, 'utf8'));
    return new Set((data.items || []).map((x) => String(x.vx)).filter(Boolean));
  } catch {
    return new Set();
  }
}

// 乙女向黑名单（VNDB id）；同时按 tg=oto 兜底，避免新条目回流
async function loadOtomeSet() {
  try {
    const data = JSON.parse(await readFile(OTOME_FILE, 'utf8'));
    return new Set((data.vndb || []).map((x) => String(x.vx)).filter(Boolean));
  } catch {
    return new Set();
  }
}

// 标题归一：全角转半角、去空格与标点、小写；保留中日英文字符与数字
function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～・、。…‥「」『』【】《》（）〈〉〔〕~～〜]/g, '');
}

// 整名与「分隔符前的头名」都入键集，覆盖副标题差异
function addKeys(set, value) {
  const full = normalizeTitle(value);
  if (full) set.add(full);
  const head = normalizeTitle(String(value || '').split(/[~～〜:：\-—–]/)[0]);
  if (head && head.length >= 2) set.add(head);
}

function candidateKeys(c) {
  const keys = new Set();
  addKeys(keys, c.title);
  addKeys(keys, c.alttitle);
  (c.titles || []).forEach((t) => addKeys(keys, t.title));
  return keys;
}

// 发售日补齐到 YYYY-MM-DD；无法识别时留空
function fullDate(value) {
  const m = String(value || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!m) return '';
  return `${m[1]}-${m[2] || '01'}-${m[3] || '01'}`;
}

const PLATFORM = {
  win: 'PC', lin: 'Linux', mac: 'macOS', ios: 'iOS', and: 'Android', web: 'Web', dos: 'DOS',
  ps1: 'PS', ps2: 'PS2', ps3: 'PS3', ps4: 'PS4', ps5: 'PS5', psp: 'PSP', psv: 'PSV',
  swi: 'Switch', wii: 'Wii', wiiu: 'WiiU', gc: 'GC', n64: 'N64', sfc: 'SFC', nes: 'FC', fc: 'FC',
  gb: 'GB', gbc: 'GBC', gba: 'GBA', nds: 'NDS', '3ds': '3DS', n3d: '3DS',
  xbo: 'Xbox', x360: 'Xbox 360', xb1: 'Xbox One', xsx: 'Xbox Series X/S',
  sat: 'SS', dc: 'DC', pce: 'PCE', pcfx: 'PC-FX', pc88: 'PC-88', pc98: 'PC-98',
  x68: 'X68000', fm7: 'FM-7', fm8: 'FM-8', msx: 'MSX', fmt: 'FM Towns',
};

function mapPlatforms(codes) {
  const out = [];
  (codes || []).forEach((code) => {
    const name = PLATFORM[String(code).toLowerCase()];
    if (name && out.indexOf(name) < 0) out.push(name);
  });
  return out;
}

function cleanDevs(list) {
  const out = [];
  (list || []).forEach((d) => {
    const name = String((d && d.name) || '')
      .replace(/\s*(?:co\.,?\s*ltd\.?|inc\.?|llc|ltd\.?|株式会社|有限会社)\s*$/i, '')
      .trim();
    if (name && out.indexOf(name) < 0) out.push(name);
  });
  return out;
}

// VNDB staff 角色 -> 主库展示字段；场景 / 原画 / 音乐各保留前 8 位
const STAFF_ROLE = { scenario: 'sc', art: 'ar', chardesign: 'ar', music: 'mu', songs: 'mu' };

function mapStaff(staff) {
  const out = { sc: [], ar: [], mu: [] };
  (staff || []).forEach((s) => {
    const key = STAFF_ROLE[s && s.role];
    const name = String((s && s.name) || '').trim();
    if (!key || !name || out[key].indexOf(name) >= 0) return;
    out[key].push(name);
  });
  const result = {};
  ['sc', 'ar', 'mu'].forEach((k) => {
    if (out[k].length) result[k] = out[k].slice(0, 8).join('、');
  });
  return result;
}

function buildItem(c) {
  const titles = c.titles || [];
  const ja = (titles.find((t) => t.lang === 'ja') || {}).title || '';
  const zhHans = (titles.find((t) => t.lang === 'zh-Hans') || {}).title || '';
  const zhHant = (titles.find((t) => t.lang === 'zh-Hant') || {}).title || '';
  const n = String(ja || c.alttitle || c.title || '').trim();
  if (!n) return null;
  const item = {
    i: 1000000 + Number(String(c.id || '').slice(1)),
    n,
    d: fullDate(c.released),
    s: c.rating ? Number((Number(c.rating) / 10).toFixed(1)) : 0,
    h: Number(c.votecount) || 0,
    vx: c.id,
  };
  if (Number(c.length_minutes) > 0) item.l = Number(c.length_minutes);
  const cn = String(zhHans || zhHant || '').trim();
  if (cn) item.cn = cn;
  if (c.image && c.image.url) item.img = c.image.url;
  const dev = cleanDevs(c.developers);
  if (dev.length) item.dev = dev;
  const pl = mapPlatforms(c.platforms);
  if (pl.length) item.pl = pl;
  const tg = mapVndbGenres(c.tags);
  if (tg.length) item.tg = tg;
  Object.assign(item, mapStaff(c.staff));
  return item;
}

async function queryPage(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          filters: FILTERS,
          sort: 'votecount',
          reverse: true,
          fields: FIELDS,
          results: PAGE_SIZE,
          page,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        console.warn('    限流，等待 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`    重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  throw new Error('请求失败');
}

// 一批 producer id 查其全部 VN；release 子过滤器支持 producer OR
async function queryByProducers(ids, page) {
  const preds = ids.map((id) => ['producer', '=', ['id', '=', id]]);
  const filter = ['release', '=', preds.length === 1 ? preds[0] : ['or'].concat(preds)];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ filters: filter, fields: FULL_FIELDS, results: PAGE_SIZE, page }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        console.warn('    限流，等待 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`    重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  throw new Error('请求失败');
}


function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// 用 OR 组合批量查 id，避免逐条请求消耗限流额度
async function queryIds(ids, fields) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          filters: ['or'].concat(ids.map((id) => ['id', '=', id])),
          fields,
          results: Math.min(100, ids.length),
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        console.warn('    限流，等待 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`    重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  throw new Error('请求失败');
}

async function main() {
  const raw = await readFile(path.join(ROOT, 'data', 'galgames.js'), 'utf8');
  const m = raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error('未找到 window.GL_DATA');
  const main = JSON.parse(m[1]);

  // 主库已用 VNDB id
  const usedVndb = new Set();
  try {
    const vraw = await readFile(path.join(ROOT, 'data', 'vndb.js'), 'utf8');
    const vm = vraw.match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/);
    if (vm) {
      const map = (JSON.parse(vm[1]).map) || {};
      Object.keys(map).forEach((id) => {
        if (map[id] && map[id].v) usedVndb.add(String(map[id].v));
      });
    }
  } catch { /* 没有第二数据源时仍可生成扩展库 */ }

  // 主库标题键：中文名、原名、VNDB 英文标题、月幕原名 / 中文名 / 别名
  const mainKeys = new Set();
  main.forEach((x) => { addKeys(mainKeys, x.cn); addKeys(mainKeys, x.n); });
  try {
    const vraw = await readFile(path.join(ROOT, 'data', 'vndb.js'), 'utf8');
    const vm = vraw.match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/);
    if (vm) {
      const map = (JSON.parse(vm[1]).map) || {};
      Object.keys(map).forEach((id) => { if (map[id] && map[id].t) addKeys(mainKeys, map[id].t); });
    }
  } catch { /* 同上 */ }
  try {
    const yraw = await readFile(path.join(ROOT, 'data', 'ymgal.js'), 'utf8');
    const ym = yraw.match(/window\.GL_YMGAL\s*=\s*(\{[\s\S]*\});/);
    if (ym) {
      const map = (JSON.parse(ym[1]).map) || {};
      Object.keys(map).forEach((id) => {
        const y = map[id] || {};
        addKeys(mainKeys, y.n);
        addKeys(mainKeys, y.cn);
        (y.al || []).forEach((a) => addKeys(mainKeys, a));
      });
    }
  } catch { /* 同上 */ }

  const blockSet = await loadBlockSet();
  const otomeSet = await loadOtomeSet();
  let blockRemoved = 0;
  let otomeRemoved = 0;
  let list = [];
  const extraKeys = new Set();
  let baseMeta = null;
  let baseCount = 0;
  if (POP_ONLY) {
    try {
      const eraw = await readFile(OUT_FILE, 'utf8');
      const em = eraw.match(/window\.GL_VNDB_EXTRA\s*=\s*(\{[\s\S]*\});/);
      if (!em) throw new Error('未找到 window.GL_VNDB_EXTRA');
      const existing = JSON.parse(em[1]);
      list = Array.isArray(existing.list) ? existing.list : [];
      baseMeta = existing.meta || null;
      baseCount = list.length;
      list.forEach((x) => {
        if (x.vx) usedVndb.add(String(x.vx));
        addKeys(extraKeys, x.n);
        addKeys(extraKeys, x.cn);
      });
      console.log(`热度补全模式：复用现有 ${list.length} 条扩展，目标抓取前 ${LIMIT} 条候选`);
    } catch (err) {
      throw new Error('--popularity-only 需要可读取的 data/vndb-extra.js：' + err.message);
    }
  }
  let page = 0;
  let fetched = 0;
  let skippedUsed = 0;
  let skippedDup = 0;
  let skippedInvalid = 0;

  const targetPages = Math.ceil(LIMIT / PAGE_SIZE);
  while ((POP_ONLY ? page < targetPages : list.length < LIMIT) && page < MAX_PAGE) {
    page += 1;
    const json = await queryPage(page);
    const results = Array.isArray(json.results) ? json.results : [];
    if (!results.length) break;
    fetched += results.length;

    results.forEach((c) => {
      if (!POP_ONLY && list.length >= LIMIT) return;
      if (usedVndb.has(String(c.id))) { skippedUsed += 1; return; }
      const keys = candidateKeys(c);
      let dup = false;
      keys.forEach((k) => { if (mainKeys.has(k) || extraKeys.has(k)) dup = true; });
      if (dup) { skippedDup += 1; return; }
      const item = buildItem(c);
      if (!item || !item.d || !item.s || !item.img || !item.dev || !item.pl) {
        skippedInvalid += 1;
        return;
      }
      list.push(item);
      keys.forEach((k) => extraKeys.add(k));
    });

    console.log(`  第 ${page}/${targetPages} 页：累计 ${list.length} 条（本页候选 ${results.length}，已跳过 主库 ${skippedUsed} / 重名 ${skippedDup} / 无效 ${skippedInvalid}）`);
    if (!json.more) break;
    await sleep(DELAY_MS);
  }

  // 热度补全模式：只追加候选页，保留现有关系 / 开发商条目，直接落盘
  if (POP_ONLY) {
    if (blockSet.size) {
      const before = list.length;
      list = list.filter((x) => !blockSet.has(String(x.vx)));
      blockRemoved = before - list.length;
      console.log(`黑名单过滤：${before} → ${list.length}（配置 ${blockSet.size} 条）`);
    }
    if (otomeSet.size) {
      const before = list.length;
      list = list.filter((x) => !otomeSet.has(String(x.vx)) && !(x.tg || []).includes('oto'));
      otomeRemoved = before - list.length;
      console.log(`乙女向过滤：${before} → ${list.length}（配置 ${otomeSet.size} 条）`);
    }
    list.sort((a, b) => (b.h || 0) - (a.h || 0));
    const meta = Object.assign({}, baseMeta || {}, {
      generatedAt: new Date().toISOString(),
      count: list.length,
      popularity: {
        target: LIMIT,
        pages: page,
        fetched,
        added: list.length - baseCount,
        skippedUsed,
        skippedDup,
        skippedInvalid,
      },
      blocklist: { configured: blockSet.size, removed: blockRemoved, source: 'data/blocklist.json' },
      otome: { configured: otomeSet.size, removed: otomeRemoved, source: 'data/blocklist-otome.json' },
    });
    const content = '// 由 scripts/fetch-vndb-extra.mjs 生成，请勿手动修改\n' +
      'window.GL_VNDB_EXTRA = ' + JSON.stringify({ meta, list }) + ';\n';
    await writeFile(OUT_FILE, content, 'utf8');
    console.log(`完成（热度补全）：新增 ${list.length - baseCount} 条，扩展共 ${list.length} 条，请求 ${page} 页 / ${fetched} 条候选`);
    console.log(`输出：${OUT_FILE}`);
    return;
  }

  // ---------- 关系补全：以主库映射 + 热度扩展为种子 ----------
  const seedIds = new Set(usedVndb);
  list.forEach((x) => seedIds.add(String(x.vx)));
  const related = new Map();
  const seedBatches = chunk([...seedIds], BATCH_SIZE);
  console.log(`关系遍历：${seedIds.size} 个种子 / ${seedBatches.length} 批`);
  for (let i = 0; i < seedBatches.length; i += 1) {
    const json = await queryIds(seedBatches[i], 'id,relations{id,relation}');
    (json.results || []).forEach((c) => {
      (c.relations || []).forEach((r) => {
        const id = String(r.id || '');
        if (!RELATION_TYPES.has(String(r.relation))) return;
        if (seedIds.has(id) || usedVndb.has(id) || related.has(id)) return;
        related.set(id, r.relation);
      });
    });
    if ((i + 1) % 10 === 0 || i === seedBatches.length - 1) {
      console.log(`  种子 ${i + 1}/${seedBatches.length}，候选 ${related.size}`);
    }
    await sleep(REL_DELAY_MS);
  }

  let relAdded = 0;
  let relSkippedDup = 0;
  let relSkippedInvalid = 0;
  console.log(`关系候选 ${related.size} 个，开始补齐元数据`);
  for (const batch of chunk([...related.keys()], BATCH_SIZE)) {
    const json = await queryIds(batch, FULL_FIELDS);
    (json.results || []).forEach((c) => {
      if (c.olang !== 'ja') { relSkippedInvalid += 1; return; }
      if (usedVndb.has(String(c.id))) { relSkippedDup += 1; return; }
      const item = buildItem(c);
      // 关系条目也要求关键字段完整，避免把长尾空壳带进页面
      if (!item || !item.d || !item.s || !item.img || !item.dev || !item.pl) {
        relSkippedInvalid += 1;
        return;
      }
      const keys = candidateKeys(c);
      let dup = false;
      keys.forEach((k) => { if (mainKeys.has(k) || extraKeys.has(k)) dup = true; });
      if (dup) { relSkippedDup += 1; return; }
      list.push(item);
      relAdded += 1;
      keys.forEach((k) => extraKeys.add(k));
    });
    await sleep(REL_DELAY_MS);
  }
  console.log(`关系补全：新增 ${relAdded} 条（候选 ${related.size}，字段不全 ${relSkippedInvalid}，重名 ${relSkippedDup}）`);

  // ---------- 开发商覆盖：按现有作品反查 producer，再拉每个 producer 的全部 VN ----------
  const currentVx = new Set(list.map((x) => String(x.vx)));
  const devSeeds = new Set(seedIds);
  list.forEach((x) => devSeeds.add(String(x.vx)));
  const producers = new Map();
  const producerCounts = new Map();
  const devSeedBatches = chunk([...devSeeds], BATCH_SIZE);
  console.log(`开发商遍历：${devSeeds.size} 部作品 / ${devSeedBatches.length} 批读取 producer`);
  for (let i = 0; i < devSeedBatches.length; i += 1) {
    const json = await queryIds(devSeedBatches[i], 'id,developers{id,name}');
    (json.results || []).forEach((c) => {
      (c.developers || []).forEach((d) => {
        if (!d || !d.id || !d.name) return;
        const id = String(d.id);
        producers.set(id, String(d.name));
        producerCounts.set(id, (producerCounts.get(id) || 0) + 1);
      });
    });
    if ((i + 1) % 20 === 0 || i === devSeedBatches.length - 1) {
      console.log(`  producer 种子 ${i + 1}/${devSeedBatches.length}，已收集 ${producers.size}`);
    }
    await sleep(REL_DELAY_MS);
  }

  let devAdded = 0;
  let devSkippedDup = 0;
  let devSkippedInvalid = 0;
  let devPages = 0;
  const prodList = [...producers.keys()]
    .sort((a, b) => (producerCounts.get(b) || 0) - (producerCounts.get(a) || 0));
  const prodBatches = chunk(prodList, PROD_BATCH);
  console.log(`producer ${producers.size} 个 / ${prodBatches.length} 批（每批最多 ${PROD_PAGE_MAX} 页），开始反查作品`);
  for (let i = 0; i < prodBatches.length; i += 1) {
    let pageNo = 1;
    while (pageNo <= PROD_PAGE_MAX) {
      const json = await queryByProducers(prodBatches[i], pageNo);
      const results = Array.isArray(json.results) ? json.results : [];
      if (!results.length) break;
      devPages += 1;
      results.forEach((c) => {
        if (c.olang !== 'ja') { devSkippedInvalid += 1; return; }
        if (usedVndb.has(String(c.id)) || currentVx.has(String(c.id))) { devSkippedDup += 1; return; }
        const item = buildItem(c);
        if (!item || !item.d || !item.s || !item.img || !item.dev || !item.pl) {
          devSkippedInvalid += 1;
          return;
        }
        const keys = candidateKeys(c);
        let dup = false;
        keys.forEach((k) => { if (mainKeys.has(k) || extraKeys.has(k)) dup = true; });
        if (dup) { devSkippedDup += 1; return; }
        list.push(item);
        currentVx.add(String(item.vx));
        devAdded += 1;
        keys.forEach((k) => extraKeys.add(k));
      });
      if (!json.more) break;
      pageNo += 1;
      await sleep(PROD_DELAY_MS);
    }
    if ((i + 1) % 10 === 0 || i === prodBatches.length - 1) {
      console.log(`  开发商批次 ${i + 1}/${prodBatches.length}，累计新增 ${devAdded}`);
    }
    await sleep(PROD_DELAY_MS);
  }
  console.log(`开发商补全：新增 ${devAdded} 条（producer ${producers.size}，请求 ${devPages} 页，重名 ${devSkippedDup}，无效 ${devSkippedInvalid}）`);

  if (blockSet.size) {
    const before = list.length;
    list = list.filter((x) => !blockSet.has(String(x.vx)));
    blockRemoved = before - list.length;
    console.log(`黑名单过滤：${before} → ${list.length}（配置 ${blockSet.size} 条）`);
  }
  if (otomeSet.size) {
    const before = list.length;
    list = list.filter((x) => !otomeSet.has(String(x.vx)) && !(x.tg || []).includes('oto'));
    otomeRemoved = before - list.length;
    console.log(`乙女向过滤：${before} → ${list.length}（配置 ${otomeSet.size} 条）`);
  }
  list.sort((a, b) => (b.h || 0) - (a.h || 0));

  const meta = {
    generatedAt: new Date().toISOString(),
    source: 'vndb',
    filter: { olang: 'ja', ratingMin: 60, voteMin: 10 },
    limit: LIMIT,
    count: list.length,
    pages: page,
    fetched,
    skippedUsed,
    skippedDup,
    skippedInvalid,
    related: {
      seeds: seedIds.size,
      candidates: related.size,
      added: relAdded,
      skippedDup: relSkippedDup,
      skippedInvalid: relSkippedInvalid,
    },
    developer: {
      producers: producers.size,
      added: devAdded,
      pages: devPages,
      skippedDup: devSkippedDup,
      skippedInvalid: devSkippedInvalid,
    },
    blocklist: { configured: blockSet.size, removed: blockRemoved, source: 'data/blocklist.json' },
    otome: { configured: otomeSet.size, removed: otomeRemoved, source: 'data/blocklist-otome.json' },
  };
  const content = '// 由 scripts/fetch-vndb-extra.mjs 生成，请勿手动修改\n' +
    'window.GL_VNDB_EXTRA = ' + JSON.stringify({ meta, list }) + ';\n';
  await writeFile(OUT_FILE, content, 'utf8');

  console.log(`完成：扩展 ${list.length} 条（关系补全 ${relAdded}，开发商补全 ${devAdded}），请求 ${page} 页 / ${fetched} 条候选，跳过 主库 ${skippedUsed}、重名 ${skippedDup}、无效 ${skippedInvalid}`);
  console.log(`输出：${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
