// 抓取 VNDB 全量 VN 标题索引，供离线匹配使用（构建缓存，不写库）。
// 用法：
//   node scripts/fetch-vndb-titles.mjs              增量续抓（默认 1.6s/页，100 条/页）
//   node scripts/fetch-vndb-titles.mjs --refresh    清空缓存重新抓
//   node scripts/fetch-vndb-titles.mjs --limit=20   只抓 20 页（调试）
//
// 输出 data/build/vndb-titles.json：{ meta, list: [{i,t,a,ti,n,d,r,vc,dv}] }

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'data', 'build', 'vndb-titles.json');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const REFRESH = process.argv.includes('--refresh');
const LIMIT_PAGES = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 0;
const DELAY_MS = 1600;
const PAGE = 100;
const FIELDS = 'id,title,alttitle,titles.title,titles.latin,titles.lang,aliases,released,rating,votecount,developers.name';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let data = { meta: { generatedAt: '', lastId: 0, count: 0 }, list: [] };
if (!REFRESH && existsSync(OUT)) {
  data = JSON.parse(await readFile(OUT, 'utf8'));
  console.log(`续抓：已有 ${data.list.length} 条，最后 id v${data.meta.lastId || 0}`);
} else {
  console.log('全量抓取：清空缓存');
}

function slim(c) {
  return {
    i: String(c.id || '').replace(/^v/, ''),
    t: String(c.title || ''),
    a: String(c.alttitle || ''),
    ti: (c.titles || []).map((x) => ({ l: x.lang, t: x.title, la: x.latin || '' })),
    n: (c.aliases || []).slice(0, 12),
    d: String(c.released || ''),
    r: Number(c.rating) || 0,
    vc: Number(c.votecount) || 0,
    dv: (c.developers || []).map((x) => x.name).join(', '),
  };
}

let pages = 0;
while (true) {
  if (LIMIT_PAGES && pages >= LIMIT_PAGES) { console.log(`已达 --limit=${LIMIT_PAGES} 页，停`); break; }
  let json = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          filters: data.meta.lastId ? ['id', '>', Number(data.meta.lastId)] : ['id', '>=', 1],
          fields: FIELDS,
          sort: 'id',
          reverse: false,
          results: PAGE,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 429) {
        console.warn('    限流，冷却 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 120));
      json = await res.json();
      break;
    } catch (err) {
      if (attempt === 5) throw err;
      console.warn(`    重试 ${attempt}/4：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  const results = (json && json.results) || [];
  for (const c of results) data.list.push(slim(c));
  if (results.length) data.meta.lastId = Number(String(results[results.length - 1].id).replace(/^v/, ''));
  data.meta.count = data.list.length;
  data.meta.generatedAt = new Date().toISOString();
  pages += 1;
  await writeFile(OUT, JSON.stringify(data), 'utf8');
  if (pages % 10 === 0 || !json.more) console.log(`  第 ${pages} 页，累计 ${data.list.length} 条，lastId v${data.meta.lastId}`);
  if (!json.more || !results.length) break;
  await sleep(DELAY_MS);
}

console.log(`完成：${data.list.length} 条，缓存 ${OUT}`);
