// 抓取月幕全量游戏索引（构建缓存，不写库），供离线匹配使用。
// 月幕 search-game 接口在 keyword 为空时按发布时间倒序返回全部作品，pageSize 上限 20。
//
// 用法：
//   node scripts/fetch-ymgal-index.mjs              增量续抓
//   node scripts/fetch-ymgal-index.mjs --refresh    清空缓存重抓
//   node scripts/fetch-ymgal-index.mjs --limit=50   只抓 50 页（调试）
//
// 输出 data/build/ymgal-index.json：{ meta, list: [{g,n,cn,d,o,i,s,hc}] }

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'build', 'ymgal-index.json');
const API = 'https://www.ymgal.games';
const CLIENT_ID = process.env.YMGAL_CLIENT_ID || 'ymgal';
const CLIENT_SECRET = process.env.YMGAL_CLIENT_SECRET || 'luna0327';
const REFRESH = process.argv.includes('--refresh');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 0;
const PAGE_SIZE = 20;
const DELAY_MS = 800;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function fetchPage(pageNum) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const at = await getToken();
      const url = API + '/open/archive/search-game?mode=list&keyword=&pageNum=' + pageNum + '&pageSize=' + PAGE_SIZE;
      const res = await fetch(url, {
        headers: { Authorization: 'Bearer ' + at, version: '1', Accept: 'application/json;charset=utf-8' },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 401) { token = ''; await sleep(1500); continue; }
      if (res.status === 429) { console.warn('    限流，等待 10s'); await sleep(10000); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      if (!json.success) throw new Error('接口 success=false code=' + json.code + ' ' + (json.msg || ''));
      return json.data || null;
    } catch (err) {
      if (attempt === 4) throw err;
      console.warn(`    重试 ${attempt}/3：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  return null;
}

let data = { meta: { generatedAt: '', total: 0, pages: 0, lastPage: 0 }, list: [] };
if (!REFRESH && existsSync(OUT)) {
  data = JSON.parse(await readFile(OUT, 'utf8'));
  console.log(`续抓：已有 ${data.list.length} 条，lastPage ${data.meta.lastPage || 0} / 共 ${data.meta.pages || '?'} 页`);
} else {
  console.log('全量抓取：清空缓存');
}

function slim(c) {
  return {
    g: Number(c.id) || 0,
    n: String(c.name || ''),
    cn: String(c.chineseName || ''),
    d: String(c.releaseDate || ''),
    o: String(c.orgName || ''),
    i: String(c.mainImg || ''),
    s: c.score == null ? '' : String(c.score),
    hc: c.haveChinese ? 1 : 0,
  };
}

let page = (data.meta.lastPage || 0) + 1;
let fetchedPages = 0;
while (true) {
  if (LIMIT && fetchedPages >= LIMIT) { console.log(`已达 --limit=${LIMIT} 页，停`); break; }
  const d = await fetchPage(page);
  if (!d) throw new Error('页面为空：' + page);
  if (!data.meta.total) data.meta.total = Number(d.total) || 0;
  data.meta.pages = Math.ceil((Number(d.total) || data.meta.total) / PAGE_SIZE);
  const results = Array.isArray(d.result) ? d.result : [];
  results.forEach((c) => data.list.push(slim(c)));
  data.meta.lastPage = page;
  data.meta.generatedAt = new Date().toISOString();
  fetchedPages += 1;
  page += 1;
  if (fetchedPages % 20 === 0 || !results.length || !d.hasNext) {
    await writeFile(OUT, JSON.stringify(data), 'utf8');
    console.log(`  第 ${data.meta.lastPage}/${data.meta.pages} 页，累计 ${data.list.length} 条`);
  }
  if (!d.hasNext || !results.length || page > data.meta.pages) break;
  await sleep(DELAY_MS);
}

await writeFile(OUT, JSON.stringify(data), 'utf8');
console.log(`完成：${data.list.length} 条 / ${data.meta.pages} 页，缓存 ${OUT}`);
