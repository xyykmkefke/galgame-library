// 用 VNDB 公共 Kana API 为 Bangumi 条目补充第二数据源（无需凭据）
// 用法：
//   node scripts/fetch-vndb.mjs               增量：已匹配的条目直接复用缓存
//   node scripts/fetch-vndb.mjs --limit=350   只补充热度前 N 条（默认 350）
//   node scripts/fetch-vndb.mjs --refresh     忽略缓存重新匹配
//
// 匹配策略偏保守：只接受「标题归一后完全相等」的候选，优先发售年相差最小、投票数最高的结果，
// 避免把《CLANNAD》错配到同社的《Kanon》。匹配结果写入 data/vndb.js，运行时不改主数据结构，
// 由页面按 Bangumi id 关联展示。
//
// VNDB 匿名限流约 200 次 / 5 分钟，这里固定 1.6s 间隔，命中 429 时等待 60s 再重试。

import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BUILD_DIR = path.join(ROOT, 'data', 'build');
const CACHE_FILE = path.join(BUILD_DIR, 'vndb-map.json');
const OUT_FILE = path.join(ROOT, 'data', 'vndb.js');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const REFRESH = process.argv.includes('--refresh');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 350;
const DELAY_MS = 1600;
const FIELDS = 'id,title,alttitle,titles.title,titles.latin,titles.lang,aliases,rating,votecount,length_minutes,released,developers.name';

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
    // 去掉常见副标题分隔符后再取一段，覆盖「作品名 ～副标题～」这类差异
    const head = normalizeTitle(String(v || '').split(/[~～〜:：\-—–]/)[0]);
    if (head && head.length >= 2) keys.add(head);
  });
  return keys;
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
    const cy = yearOf(c.released);
    const gap = year && cy ? Math.abs(cy - year) : 9;
    hits.push({ c, overlap, gap });
  });
  if (!hits.length) return null;
  hits.sort((a, b) =>
    (b.overlap - a.overlap) ||
    (a.gap - b.gap) ||
    ((b.c.votecount || 0) - (a.c.votecount || 0)));
  const best = hits[0];
  // 年份差超过 3 年视为低置信，宁缺毋滥
  if (best.gap > 3) return null;
  return best.c;
}

async function query(title) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ filters: ['search', '=', title], fields: FIELDS, results: 6 }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        console.warn('    限流，等待 60s');
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

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
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
  const unmatched = data.filter((x) => (x.cn || x.n) && !(cache[String(x.i)] && cache[String(x.i)].v));
  const byHeat = (a, b) => (b.h || 0) - (a.h || 0);
  const freshPool = unmatched.filter((x) => !cache[String(x.i)]).sort(byHeat);
  const retryPool = unmatched.filter((x) => cache[String(x.i)]).sort(byHeat);
  const pool = freshPool.concat(retryPool).slice(0, LIMIT);

  console.log(`待匹配 ${pool.length} 条（新 ${freshPool.length} / 重试 ${retryPool.length}，上限 ${LIMIT}）`);
  let done = 0;
  let matched = 0;
  let failed = 0;

  for (const item of pool) {
    const title = item.n || item.cn;
    try {
      const results = await query(title);
      const hit = pickMatch(item, results);
      if (hit) {
        cache[String(item.i)] = {
          v: hit.id,
          r: Number(hit.rating) || 0,
          l: Number(hit.length_minutes) || 0,
          d: hit.released || '',
          t: hit.title || '',
          dv: ((hit.developers || [])[0] || {}).name || '',
          vc: Number(hit.votecount) || 0,
        };
        matched += 1;
      } else {
        cache[String(item.i)] = { v: '', r: 0, l: 0, d: '', t: '', dv: '', vc: 0 };
      }
    } catch (err) {
      failed += 1;
      console.warn(`  [${item.i}] ${title} 失败：${err.message}`);
    }
    done += 1;
    if (done % 25 === 0) {
      await writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');
      console.log(`  进度 ${done}/${pool.length}，已匹配 ${matched}，失败 ${failed}`);
    }
    await sleep(DELAY_MS);
  }

  await writeFile(CACHE_FILE, JSON.stringify(cache), 'utf8');

  const map = {};
  Object.keys(cache).forEach((id) => {
    const v = cache[id];
    if (v && v.v) map[id] = v;
  });

  const meta = {
    generatedAt: new Date().toISOString(),
    source: 'vndb',
    total: data.length,
    tried: Object.keys(cache).length,
    matched: Object.keys(map).length,
  };
  const content = '// 由 scripts/fetch-vndb.mjs 生成，请勿手动修改\n' +
    'window.GL_VNDB = ' + JSON.stringify({ meta, map }) + ';\n';
  await writeFile(OUT_FILE, content, 'utf8');

  console.log(`完成：新增匹配 ${matched}，失败 ${failed}，累计匹配 ${meta.matched}/${data.length}（尝试 ${meta.tried}）`);
  console.log(`输出：${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
