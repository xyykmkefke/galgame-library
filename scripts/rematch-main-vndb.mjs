// A5 dry-run：对未匹配 VNDB 的主库条目，用中文名 / Bangumi 别名 / 月幕别名重试匹配。
// 只读网络与本地数据，不写主库；结果写入 data/build/vndb-rematch.json 供复核。
//
// 用法：
//   node scripts/rematch-main-vndb.mjs --limit=200
//   node scripts/rematch-main-vndb.mjs --limit=200 --refresh --verbose
//
// 匹配仍保持保守：标题归一后必须完全命中，发售年差 ≤ 3 年；不做模糊接受。
// 一次请求用 OR 组合多个关键词，降低 VNDB 请求数与限流风险。

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const VNDB = path.join(ROOT, 'data', 'vndb.js');
const YMGAL = path.join(ROOT, 'data', 'ymgal.js');
const OUT = path.join(ROOT, 'data', 'build', 'vndb-rematch.json');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 200;
const CONCURRENCY = Math.max(1, Math.min(2, Number((process.argv.find((a) => a.startsWith('--concurrency=')) || '').slice(14)) || 1));
const REFRESH = process.argv.includes('--refresh');
const VERBOSE = process.argv.includes('--verbose');
const DELAY = Number((process.argv.find((a) => a.startsWith('--delay=')) || '').slice(8)) || 3000;
const MAX_KEYS = 5;
const FIELDS = 'id,title,alttitle,titles.title,titles.latin,titles.lang,aliases,rating,votecount,released,developers.name';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function candidateKeys(c) {
  const keys = new Set();
  const push = (v) => {
    const k = normalizeTitle(v);
    if (k) keys.add(k);
  };
  push(c.title);
  push(c.alttitle);
  (c.titles || []).forEach((t) => { push(t.title); push(t.latin); });
  (c.aliases || []).forEach(push);
  return keys;
}

function pickMatch(item, results, probeKeys) {
  const want = new Set();
  const push = (v) => {
    const k = normalizeTitle(v);
    if (k) want.add(k);
  };
  push(item.cn);
  push(item.n);
  (item.al || []).forEach(push);
  (probeKeys || []).forEach(push);
  if (!want.size) return null;
  const year = yearOf(item.d);
  const hits = [];
  (results || []).forEach((c) => {
    const keys = candidateKeys(c);
    let overlap = 0;
    want.forEach((k) => { if (keys.has(k)) overlap += 1; });
    if (!overlap) return;
    const cy = yearOf(c.released);
    const gap = year && cy ? Math.abs(cy - year) : 9;
    if (gap > 3) return;
    hits.push({ c, overlap, gap });
  });
  hits.sort((a, b) =>
    (b.overlap - a.overlap) ||
    (a.gap - b.gap) ||
    ((b.c.votecount || 0) - (a.c.votecount || 0)));
  return hits[0] ? hits[0].c : null;
}

let cooldownUntil = 0;

async function searchMany(keywords) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const wait = cooldownUntil - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          filters: ['or'].concat(keywords.map((k) => ['search', '=', k])),
          fields: FIELDS,
          results: Math.max(6, keywords.length * 3),
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        cooldownUntil = Date.now() + 60000;
        console.warn('    限流，全局冷却 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return Array.isArray(json.results) ? json.results : [];
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`    重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  return [];
}

function whichKeyword(hit, keywords) {
  const keys = candidateKeys(hit);
  return keywords.find((kw) => keys.has(normalizeTitle(kw))) || keywords[0] || '';
}

const main = JSON.parse((await readFile(MAIN, 'utf8')).match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const vmap = JSON.parse((await readFile(VNDB, 'utf8')).match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/)[1]).map || {};
const ymap = JSON.parse((await readFile(YMGAL, 'utf8')).match(/window\.GL_YMGAL\s*=\s*(\{[\s\S]*\});/)[1]).map || {};

const visible = main.filter((x) => x.k !== 'off');
const unmatched = visible.filter((x) => !(vmap[String(x.i)] && vmap[String(x.i)].v));
unmatched.sort((a, b) => (b.h || 0) - (a.h || 0));

let cache = {};
if (!REFRESH && existsSync(OUT)) {
  try { cache = JSON.parse(await readFile(OUT, 'utf8')); } catch { /* ignore */ }
}

const targets = unmatched.filter((x) => !cache[String(x.i)]).slice(0, LIMIT);
console.log(`未匹配可见条目：${unmatched.length} 条；本轮探测：${targets.length} 条（上限 ${LIMIT}，并发 ${CONCURRENCY}）`);

function keywordsOf(x) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    const s = String(v || '').trim();
    const k = normalizeTitle(s);
    if (!s || !k || seen.has(k)) return;
    seen.add(k);
    out.push(s);
  };
  // 原始 n 已在 fetch-vndb 中试过；这里优先中文名与别名
  push(x.cn);
  (x.al || []).forEach(push);
  const y = ymap[String(x.i)];
  if (y) {
    push(y.n);
    push(y.cn);
    (y.al || []).forEach(push);
  }
  return out.slice(0, MAX_KEYS);
}

let tested = 0;
let matched = 0;
let failed = 0;
const matchedRows = [];
const bySource = {};
let cursor = 0;

async function worker() {
  while (cursor < targets.length) {
    const x = targets[cursor];
    cursor += 1;
    const keywords = keywordsOf(x);
    let hit = null;
    let used = '';
    if (keywords.length) {
      try {
        const results = await searchMany(keywords);
        hit = pickMatch(x, results, keywords);
        if (hit) used = whichKeyword(hit, keywords);
        if (VERBOSE) console.log(`    [${x.i}] ${keywords.join(' | ')} -> ${results.length} 结果${hit ? '，命中 ' + hit.title : ''}`);
      } catch (err) {
        failed += 1;
        console.warn(`  [${x.i}] ${x.cn || x.n} 搜索失败：${err.message}`);
      }
      await sleep(DELAY);
    }
    tested += 1;
    cache[String(x.i)] = hit
      ? {
        ok: true,
        keyword: used,
        v: hit.id,
        t: hit.title || '',
        d: hit.released || '',
        r: Number(hit.rating) || 0,
        vc: Number(hit.votecount) || 0,
        dv: ((hit.developers || [])[0] || {}).name || '',
      }
      : { ok: false, keyword: '', at: new Date().toISOString() };
    if (hit) {
      matched += 1;
      const source = used === x.cn || used === x.n
        ? 'cn'
        : ((x.al || []).includes(used) ? 'bangumi-alias' : 'ymgal');
      bySource[source] = (bySource[source] || 0) + 1;
      matchedRows.push({ id: x.i, name: x.cn || x.n, keyword: used, v: hit.id, title: hit.title, date: hit.released || '' });
      console.log(`  [${x.i}] ${x.cn || x.n} -> ${hit.title} (${hit.id}, ${hit.released || '无日期'}) via ${used}`);
    }
    if (tested % 20 === 0) {
      await writeFile(OUT, JSON.stringify(cache), 'utf8');
      console.log(`  进度 ${tested}/${targets.length}，命中 ${matched}，失败 ${failed}`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
await writeFile(OUT, JSON.stringify(cache), 'utf8');

console.log(`\n本轮：${tested} 条，命中 ${matched}（${(matched / Math.max(1, tested) * 100).toFixed(1)}%），失败 ${failed}`);
console.log('命中来源：', bySource);
if (matched) {
  console.log('样例：');
  matchedRows.slice(0, 20).forEach((r) => console.log(`  [${r.id}] ${r.name} -> ${r.title} ${r.date ? r.date.slice(0, 4) : ''} via ${r.keyword}`));
  const projected = Math.round(matched / Math.max(1, tested) * unmatched.length);
  console.log(`按当前命中率估算全部 ${unmatched.length} 条可新增约 ${projected} 条匹配。`);
}
console.log(`探测缓存：${OUT}`);
