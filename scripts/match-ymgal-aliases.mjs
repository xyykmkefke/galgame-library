// 月幕反向匹配探针：对尚未匹配月幕的主库可见条目，用 VNDB 日文原名 / Bangumi 别名去月幕搜索，
// 只接受归一标题完全相等（命名或中文名）且年份差 ≤3 的结果。只写构建缓存，不改 data/ymgal.js。
//
// 用法：
//   node scripts/match-ymgal-aliases.mjs                增量（已探测的跳过）
//   node scripts/match-ymgal-aliases.mjs --limit=100    只探测前 100 条
//   node scripts/match-ymgal-aliases.mjs --refresh      忽略缓存重新探测
//
// 输出 data/build/ymgal-alias.json：{ [bangumiId]: { ok, g, n, cn, d, o, i, s, hc, keyword, at } }

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const API = 'https://www.ymgal.games';
const CLIENT_ID = process.env.YMGAL_CLIENT_ID || 'ymgal';
const CLIENT_SECRET = process.env.YMGAL_CLIENT_SECRET || 'luna0327';
const OUT = path.join(ROOT, 'data', 'build', 'ymgal-alias.json');
const INDEX = path.join(ROOT, 'data', 'build', 'vndb-titles.json');
const DELAY_MS = 800;
const REFRESH = process.argv.includes('--refresh');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseWindow(raw, name) {
  const m = raw.match(new RegExp('window\\.' + name + '\\s*=\\s*([\\[{][\\s\\S]*[\\]}]);'));
  if (!m) throw new Error('未找到 ' + name);
  return JSON.parse(m[1]);
}

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
  tokenExpireAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
  return token;
}

async function search(keyword) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const at = await getToken();
      const url = API + '/open/archive/search-game?mode=list&keyword=' +
        encodeURIComponent(keyword) + '&pageNum=1&pageSize=10';
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + at, version: '1', Accept: 'application/json;charset=utf-8' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401) { token = ''; await sleep(1500); continue; }
      if (res.status === 429) { await sleep(10000); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.success) throw new Error('接口 success=false code=' + json.code);
      return (json.data && json.data.result) || [];
    } catch (err) {
      if (attempt === 3) throw err;
      await sleep(attempt * 3000);
    }
  }
  return [];
}

const main = parseWindow(await readFile(path.join(ROOT, 'data', 'galgames.js'), 'utf8'), 'GL_DATA');
const vndb = parseWindow(await readFile(path.join(ROOT, 'data', 'vndb.js'), 'utf8'), 'GL_VNDB');
const ymgal = parseWindow(await readFile(path.join(ROOT, 'data', 'ymgal.js'), 'utf8'), 'GL_YMGAL');
const index = existsSync(INDEX) ? JSON.parse(await readFile(INDEX, 'utf8')) : { list: [] };

const vnById = new Map();
index.list.forEach((vn) => vnById.set(vn.i, vn));

const cache = !REFRESH && existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf8')) : {};
const targets = main.filter((x) => {
  if (x.k === 'off') return false;
  const id = String(x.i);
  if (ymgal.map && ymgal.map[id]) return false;
  if (!REFRESH && cache[id]) return false;
  return true;
});
const queue = LIMIT ? targets.slice(0, LIMIT) : targets;
console.log(`月幕未匹配可见条目 ${targets.length} 条，本轮探测 ${queue.length} 条（已缓存 ${Object.keys(cache).length}）`);

function keywordsFor(item) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v || '').trim();
    if (s.length < 2 || s.length > 60) return;
    const k = normalizeTitle(s);
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  const v = (vndb.map || {})[String(item.i)];
  if (v && v.v) {
    const vn = vnById.get(String(v.v).replace(/^v/, ''));
    if (vn) {
      (vn.ti || []).filter((t) => t.l === 'ja').forEach((t) => push(t.t));
      push(vn.t);
    }
  }
  (item.al || []).forEach(push);
  push(item.n);
  return out.slice(0, 3);
}

let done = 0;
let hits = 0;
for (const item of queue) {
  const id = String(item.i);
  const year = yearOf(item.d);
  const kws = keywordsFor(item);
  let best = null;
  for (const kw of kws) {
    const list = await search(kw);
    const want = new Set(kws.map(normalizeTitle));
    want.add(normalizeTitle(item.n));
    want.add(normalizeTitle(item.cn));
    (list || []).forEach((c) => {
      const keys = [normalizeTitle(c.name), normalizeTitle(c.chineseName)].filter(Boolean);
      if (!keys.some((k) => want.has(k))) return;
      const cy = yearOf(c.releaseDate);
      const gap = year && cy ? Math.abs(cy - year) : 9;
      if (gap > 3) return;
      const score = (Number(c.score) || 0) + (Number(c.haveChinese) ? 0.5 : 0) - gap;
      if (!best || score > best.score) best = { c, gap, score, kw };
    });
    if (best && best.gap === 0) break;
    await sleep(DELAY_MS);
  }
  if (best) {
    hits += 1;
    cache[id] = {
      ok: true,
      g: Number(best.c.id) || 0,
      n: String(best.c.name || ''),
      cn: String(best.c.chineseName || ''),
      d: String(best.c.releaseDate || ''),
      o: String(best.c.orgName || ''),
      i: String(best.c.mainImg || ''),
      s: best.c.score == null ? '' : best.c.score,
      hc: best.c.haveChinese ? 1 : 0,
      keyword: best.kw,
      at: new Date().toISOString(),
    };
  } else {
    cache[id] = { ok: false, at: new Date().toISOString() };
  }
  done += 1;
  if (done % 25 === 0) {
    await writeFile(OUT, JSON.stringify(cache), 'utf8');
    console.log(`  进度 ${done}/${queue.length}，命中 ${hits}`);
  }
  await sleep(DELAY_MS);
}
await writeFile(OUT, JSON.stringify(cache), 'utf8');
console.log(`完成：本轮 ${done} 条，命中 ${hits}；缓存共 ${Object.keys(cache).length} 条，其中命中 ${Object.values(cache).filter((x) => x.ok).length}`);
console.log(`输出：${OUT}`);
