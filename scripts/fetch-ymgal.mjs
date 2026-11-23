// 用月幕 Galgame 开放 API 为 Bangumi 条目补充第三数据源（构建期抓取，运行时只读静态文件）
// 用法：
//   node scripts/fetch-ymgal.mjs               增量：已匹配的条目直接复用缓存
//   node scripts/fetch-ymgal.mjs --limit=250   只补充热度前 N 条（默认 700）
//   node scripts/fetch-ymgal.mjs --refresh     忽略缓存重新匹配
//
// 月幕官方为学习/实验提供公共凭据，无需申请；如需专属凭据到 https://github.com/ymgal/docs 提 issue。
// 文档要求避免并发与高频调用，这里顺序请求、固定 800ms 间隔，命中 429 时退避重试。
// 匹配策略与 VNDB 一致：标题归一后必须完全相等才采纳，优先发售年更接近、评分更高的候选。
//
// 输出 data/ymgal.js → window.GL_YMGAL = { meta, map }，map 以 Bangumi id 为键，
// 值形如 { g, n, cn, d, o, i, s, hc }，由页面在 adoptData() 中挂到 x.ym。

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, 'data', 'build');
const CACHE_FILE = path.join(BUILD_DIR, 'ymgal-map.json');
const OUT_FILE = path.join(ROOT, 'data', 'ymgal.js');
const API = 'https://www.ymgal.games';
const CLIENT_ID = process.env.YMGAL_CLIENT_ID || 'ymgal';
const CLIENT_SECRET = process.env.YMGAL_CLIENT_SECRET || 'luna0327';
const REFRESH = process.argv.includes('--refresh');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 700;
const DELAY_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 标题归一：全角转半角、去空格与标点、小写；保留中日英文字符与数字
function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～・、。…‥「」『』【】《》（）〈〉〔〕~～〜]/g, '');
}

function titleKeys(item) {
  const keys = new Set();
  [item.cn, item.n].forEach((v) => {
    const k = normalizeTitle(v);
    if (k) keys.add(k);
    const head = normalizeTitle(String(v || '').split(/[~～〜:：\-—–]/)[0]);
    if (head && head.length >= 2) keys.add(head);
  });
  return keys;
}

function candidateKeys(c) {
  const keys = new Set();
  [c.name, c.chineseName].forEach((v) => {
    const k = normalizeTitle(v);
    if (k) keys.add(k);
  });
  return keys;
}

function yearOf(dateStr) {
  const m = String(dateStr || '').match(/^(\d{4})/);
  return m ? Number(m[1]) : 0;
}

// 在候选中挑置信度最高的一个；没有标题完全命中则返回 null
function pickMatch(item, results) {
  const want = titleKeys(item);
  if (!want.size) return null;
  const year = yearOf(item.d);
  const hits = [];
  (results || []).forEach((c) => {
    const keys = candidateKeys(c);
    let overlap = 0;
    want.forEach((k) => { if (keys.has(k)) overlap += 1; });
    if (!overlap) return;
    const cy = yearOf(c.releaseDate);
    const gap = year && cy ? Math.abs(cy - year) : 9;
    hits.push({ c, overlap, gap });
  });
  if (!hits.length) return null;
  hits.sort((a, b) =>
    (b.overlap - a.overlap) ||
    (a.gap - b.gap) ||
    ((Number(b.c.score) || 0) - (Number(a.c.score) || 0)));
  const best = hits[0];
  if (best.gap > 3) return null;
  return best.c;
}

let token = '';
let tokenExpireAt = 0;

async function getToken() {
  if (token && Date.now() < tokenExpireAt - 60000) return token;
  const url = API + '/oauth/token?grant_type=client_credentials&client_id=' +
    encodeURIComponent(CLIENT_ID) + '&client_secret=' + encodeURIComponent(CLIENT_SECRET) + '&scope=public';
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error('取 token 失败 HTTP ' + res.status);
  const json = await res.json();
  if (!json.access_token) throw new Error('token 响应缺少 access_token');
  token = json.access_token;
  const ttl = Number(json.expires_in) || 3600;
  tokenExpireAt = Date.now() + ttl * 1000;
  return token;
}

async function search(keyword) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const at = await getToken();
      const url = API + '/open/archive/search-game?mode=list&keyword=' +
        encodeURIComponent(keyword) + '&pageNum=1&pageSize=10';
      const res = await fetch(url, {
        headers: {
          Authorization: 'Bearer ' + at,
          version: '1',
          Accept: 'application/json;charset=utf-8',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401) { token = ''; await sleep(1500); continue; }
      if (res.status === 429) {
        console.warn('    限流，等待 10s');
        await sleep(10000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.success) throw new Error('接口返回 success=false code=' + json.code);
      return (json.data && json.data.result) || [];
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`    重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  return [];
}

// 详情接口用于补别名（extensionName）；列表接口不返回这些字段
async function fetchDetail(gid) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const at = await getToken();
      const res = await fetch(API + '/open/archive?gid=' + gid, {
        headers: {
          Authorization: 'Bearer ' + at,
          version: '1',
          Accept: 'application/json;charset=utf-8',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401) { token = ''; await sleep(1500); continue; }
      if (res.status === 429) {
        console.warn('    限流，等待 10s');
        await sleep(10000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.success) throw new Error('接口返回 success=false code=' + json.code);
      return (json.data && json.data.game) || null;
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`    重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  return null;
}

// 取详情里的别名，去掉与原名 / 中文名重复的项，最多保留 5 个
function aliasNames(game, baseNames) {
  const seen = new Set((baseNames || []).map(normalizeTitle).filter(Boolean));
  const out = [];
  ((game && game.extensionName) || []).forEach((e) => {
    const name = String((e && e.name) || '').trim();
    if (!name || name.length > 40) return;
    const k = normalizeTitle(name);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(name);
  });
  return out.slice(0, 5);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function compact(c) {
  return {
    g: Number(c.id) || 0,
    n: String(c.name || ''),
    cn: String(c.chineseName || ''),
    d: String(c.releaseDate || ''),
    o: String(c.orgName || ''),
    i: String(c.mainImg || ''),
    s: String(c.score == null ? '' : c.score),
    hc: c.haveChinese ? 1 : 0,
  };
}

async function main() {
  await mkdir(BUILD_DIR, { recursive: true });
  const raw = await readFile(path.join(ROOT, 'data', 'galgames.js'), 'utf8');
  const m = raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/);
  if (!m) throw new Error('未找到 window.GL_DATA');
  const data = JSON.parse(m[1]);

  let cache = {};
  if (!REFRESH && await exists(CACHE_FILE)) {
    cache = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    console.log(`复用缓存：已记录 ${Object.keys(cache).length} 条`);
  }

  // 新条目优先：从未尝试过的先补，已知不匹配的排到后面，避免重复消耗限流额度
  const unmatched = data.filter((x) => (x.cn || x.n) && !(cache[String(x.i)] && cache[String(x.i)].g));
  const byHeat = (a, b) => (b.h || 0) - (a.h || 0);
  const freshPool = unmatched.filter((x) => !cache[String(x.i)]).sort(byHeat);
  const retryPool = unmatched.filter((x) => cache[String(x.i)]).sort(byHeat);
  const pool = freshPool.concat(retryPool).slice(0, LIMIT);

  console.log(`待匹配 ${pool.length} 条（新 ${freshPool.length} / 重试 ${retryPool.length}，上限 ${LIMIT}）`);
  let done = 0;
  let matched = 0;
  let failed = 0;

  for (const item of pool) {
    const keywords = [];
    if (item.cn) keywords.push(item.cn);
    if (item.n && item.n !== item.cn) keywords.push(item.n);
    try {
      let hit = null;
      for (let k = 0; k < keywords.length && !hit; k += 1) {
        const results = await search(keywords[k]);
        hit = pickMatch(item, results);
        // 首个关键词有结果但没有精确命中时不再换词，避免误配；零结果才尝试另一个标题
        if (!hit && results.length) break;
        if (!hit && k < keywords.length - 1) await sleep(DELAY_MS);
      }
      cache[String(item.i)] = hit ? compact(hit) : { g: 0 };
      if (hit) matched += 1;
    } catch (err) {
      failed += 1;
      console.warn(`  [${item.i}] ${item.cn || item.n} 失败：${err.message}`);
    }
    done += 1;
    if (done % 25 === 0) {
      await writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');
      console.log(`  进度 ${done}/${pool.length}，已匹配 ${matched}，失败 ${failed}`);
    }
    await sleep(DELAY_MS);
  }

  await writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');

  // 为已匹配条目补别名：详情接口的 extensionName 参与搜索，列表接口拿不到
  const aliasTodo = Object.keys(cache)
    .filter((id) => cache[id] && cache[id].g && !Array.isArray(cache[id].al));
  console.log(`别名待补 ${aliasTodo.length} 条`);
  let aliased = 0;
  let detailFailed = 0;
  let detailDone = 0;
  for (const id of aliasTodo) {
    const v = cache[id];
    try {
      const game = await fetchDetail(v.g);
      const names = aliasNames(game, [v.n, v.cn]);
      v.al = names;
      if (names.length) aliased += 1;
    } catch (err) {
      detailFailed += 1;
      console.warn(`  [${id}] 月幕 gid ${v.g} 详情失败：${err.message}`);
    }
    detailDone += 1;
    if (detailDone % 25 === 0) {
      await writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');
      console.log(`  别名进度 ${detailDone}/${aliasTodo.length}，有别名 ${aliased}，失败 ${detailFailed}`);
    }
    await sleep(DELAY_MS);
  }
  await writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');

  const map = {};
  Object.keys(cache).forEach((id) => {
    const v = cache[id];
    if (!v || !v.g) return;
    const item = Object.assign({}, v);
    if (!Array.isArray(item.al) || !item.al.length) delete item.al;
    map[id] = item;
  });

  const meta = {
    generatedAt: new Date().toISOString(),
    source: 'ymgal',
    total: data.length,
    tried: Object.keys(cache).length,
    matched: Object.keys(map).length,
    aliased: Object.keys(map).filter((id) => map[id].al).length,
    detailFailed,
  };
  const content = '// 由 scripts/fetch-ymgal.mjs 生成，请勿手动修改\n' +
    'window.GL_YMGAL = ' + JSON.stringify({ meta, map }) + ';\n';
  await writeFile(OUT_FILE, content, 'utf8');

  console.log(`完成：新增匹配 ${matched}，失败 ${failed}，累计匹配 ${meta.matched}/${data.length}（尝试 ${meta.tried}）`);
  console.log(`输出：${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
