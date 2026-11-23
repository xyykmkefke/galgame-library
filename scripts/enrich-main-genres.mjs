// 主库题材补齐：对「无 tg 且有 VNDB 映射」的条目批量抓 VNDB 标签，映射成本地题材。
// 默认 dry-run；确认后加 --apply 写回 data/galgames.js。
//
// 用法：
//   node scripts/enrich-main-genres.mjs            # 预演：只报告可补条目与题材分布
//   node scripts/enrich-main-genres.mjs --apply    # 写回 tg，更新 meta.genreFilled
//
// 缓存：data/build/main-vndb-tags.json（按 VNDB id 保存原始 tags，重复运行不重复请求）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { mapVndbGenres } from './vndb-genre-map.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const VNDB = path.join(ROOT, 'data', 'vndb.js');
const CACHE = path.join(ROOT, 'data', 'build', 'main-vndb-tags.json');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const APPLY = process.argv.includes('--apply');
const BATCH = 10;
const DELAY = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const raw = await readFile(MAIN, 'utf8');
const meta = JSON.parse(raw.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/)[1]);
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const vmap = JSON.parse((await readFile(VNDB, 'utf8')).match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/)[1]).map || {};

const targets = all
  .filter((x) => x.k !== 'off' && (!x.tg || !x.tg.length) && vmap[String(x.i)] && vmap[String(x.i)].v)
  .map((x) => ({ item: x, vx: String(vmap[String(x.i)].v) }));
console.log(`无题材且可查 VNDB 的主库条目：${targets.length} 条`);

let cache = {};
try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch { /* 首次运行 */ }
const need = [...new Set(targets.map((t) => t.vx))].filter((vx) => !cache[vx]);
console.log(`缓存命中 ${targets.length - targets.filter((t) => !cache[t.vx]).length} 条，需要请求 ${need.length} 个 id`);

async function fetchBatch(ids) {
  const filters = ['or', ...ids.map((id) => ['id', '=', id])];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ filters, fields: 'id,title,tags.name,tags.rating,tags.spoiler' }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
      const json = await res.json();
      return json.results || [];
    } catch (err) {
      console.warn(`  批次失败（${attempt}/3）：${err.message}`);
      if (attempt === 3) return [];
      await sleep(5000 * attempt);
    }
  }
  return [];
}

for (let i = 0; i < need.length; i += BATCH) {
  const ids = need.slice(i, i + BATCH);
  console.log(`  拉取 ${i + 1}-${Math.min(i + BATCH, need.length)} / ${need.length}`);
  const results = await fetchBatch(ids);
  if (results.length < ids.length) console.log(`    返回 ${results.length}/${ids.length}（可能含无效 id）`);
  for (const r of results) cache[String(r.id)] = r.tags || [];
  await sleep(DELAY);
}

await mkdir(path.dirname(CACHE), { recursive: true });
await writeFile(CACHE, JSON.stringify(cache), 'utf8');

const filled = [];
const empty = [];
const genreCount = {};
for (const t of targets) {
  const tags = cache[t.vx] || [];
  const tg = mapVndbGenres(tags).filter((g) => g !== 'oto');
  if (tg.length) {
    filled.push({ item: t.item, vx: t.vx, tg });
    tg.forEach((g) => { genreCount[g] = (genreCount[g] || 0) + 1; });
  } else {
    empty.push({ item: t.item, vx: t.vx });
  }
}

filled.sort((a, b) => (b.item.h || 0) - (a.item.h || 0));
console.log(`\n可补题材 ${filled.length} 条；仍补不出 ${empty.length} 条`);
console.log('题材分布：' + Object.entries(genreCount).sort((a, b) => b[1] - a[1]).map(([g, n]) => `${g}:${n}`).join(' / '));
console.log('\n样本（按热度）：');
filled.slice(0, 20).forEach((f) => console.log(`  ${f.item.cn || f.item.n} → ${f.tg.join(',')}`));

if (!APPLY) {
  console.log('\n当前为预演模式，未写入 galgames.js；确认后加 --apply。');
  process.exit(0);
}

for (const f of filled) f.item.tg = f.tg;
meta.genreFilled = (meta.genreFilled || 0) + filled.length;
const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(meta)};\n` +
  `window.GL_DATA = ${JSON.stringify(all)};\n`;
await writeFile(MAIN, content, 'utf8');
console.log(`\n已写入 ${MAIN}：补 ${filled.length} 条题材`);
