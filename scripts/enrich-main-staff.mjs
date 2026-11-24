// 主库制作人员补齐：对「有 VNDB 映射且 sc/ar/mu 缺失」的条目，按 VNDB staff 角色回填。
// 只填空字段，不覆盖 Bangumi 已有值；默认 dry-run，加 --apply 写回。
//
// 用法：
//   node scripts/enrich-main-staff.mjs
//   node scripts/enrich-main-staff.mjs --apply
//
// 缓存：data/build/main-vndb-staff.json（按 Bangumi id 保存 VNDB staff 原始数组）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const VNDB = path.join(ROOT, 'data', 'vndb.js');
const CACHE = path.join(ROOT, 'data', 'build', 'main-vndb-staff.json');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const APPLY = process.argv.includes('--apply');
const REFRESH = process.argv.includes('--refresh');
const BATCH = 10;
const DELAY = 1600;
const ROLE_FIELD = { scenario: 'sc', art: 'ar', music: 'mu' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function queryStaff(ids) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          filters: ['or'].concat(ids.map((id) => ['id', '=', id])),
          fields: 'id,staff{id,name,original,role,note}',
          results: ids.length,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        console.warn('  限流，等待 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return Array.isArray(json.results) ? json.results : [];
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  return [];
}

function staffText(list, field) {
  const out = [];
  const seen = new Set();
  (list || []).forEach((s) => {
    if (!s || ROLE_FIELD[s.role] !== field) return;
    const name = String(s.original || s.name || '').trim()
      // VNDB 日文原名常带空格（川村 敏江），与 Bangumi 的无空格写法对齐；西文名保留空格
      .replace(/(?<=[\u3400-\u9fff\u3040-\u30ff])\s+(?=[\u3400-\u9fff\u3040-\u30ff])/g, '');
    const key = name.toLowerCase();
    if (!name || name.length > 60 || seen.has(key)) return;
    seen.add(key);
    out.push(name);
  });
  return out.join('、').slice(0, 400);
}

const raw = await readFile(MAIN, 'utf8');
const meta = JSON.parse(raw.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/)[1]);
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const vmap = JSON.parse((await readFile(VNDB, 'utf8')).match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/)[1]).map || {};

const missing = (x, field) => !x[field] || !String(x[field]).trim();
const targets = all
  .filter((x) => x.k !== 'off' && vmap[String(x.i)] && vmap[String(x.i)].v)
  .filter((x) => ['sc', 'ar', 'mu'].some((f) => missing(x, f)));
targets.sort((a, b) => (b.h || 0) - (a.h || 0));

let cache = {};
if (!REFRESH) {
  try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch { /* 首次运行 */ }
}

console.log(`待补制作人员（有 VNDB 映射）：${targets.length} 条`);

const pending = targets.filter((x) => !cache[String(x.i)] || REFRESH);
const ids = pending.map((x) => vmap[String(x.i)].v);
let fetched = 0;
for (let i = 0; i < ids.length; i += BATCH) {
  const chunk = ids.slice(i, i + BATCH);
  const results = await queryStaff(chunk);
  const byId = new Map(results.map((r) => [String(r.id), Array.isArray(r.staff) ? r.staff : []]));
  chunk.forEach((vid, j) => {
    const owner = pending[i + j];
    cache[String(owner.i)] = { v: vid, staff: byId.get(vid) || [] };
  });
  fetched += chunk.length;
  await writeFile(CACHE, JSON.stringify(cache), 'utf8');
  console.log(`  已抓取 ${fetched}/${ids.length}`);
  if (i + BATCH < ids.length) await sleep(DELAY);
}

const stats = { sc: 0, ar: 0, mu: 0 };
const changes = [];
for (const x of targets) {
  const entry = cache[String(x.i)];
  if (!entry || !entry.staff || !entry.staff.length) continue;
  const patch = {};
  for (const field of ['sc', 'ar', 'mu']) {
    if (!missing(x, field)) continue;
    const text = staffText(entry.staff, field);
    if (text) patch[field] = text;
  }
  if (!Object.keys(patch).length) continue;
  Object.keys(patch).forEach((k) => { stats[k] += 1; });
  changes.push({ id: x.i, name: x.cn || x.n, patch });
  if (APPLY) Object.assign(x, patch);
}

console.log(`\n可补条目：${changes.length} 条`);
console.log(`字段命中：剧本 ${stats.sc} · 原画 ${stats.ar} · 音乐 ${stats.mu}`);
changes.slice(0, 15).forEach((c) => {
  console.log(`  [${c.id}] ${c.name} -> ${JSON.stringify(c.patch).slice(0, 160)}`);
});

if (!APPLY) {
  console.log('\n预演完成，未写数据。确认后运行：node scripts/enrich-main-staff.mjs --apply');
  process.exit(0);
}

const counts = changes.reduce((acc, c) => {
  Object.keys(c.patch).forEach((k) => { acc[k] = (acc[k] || 0) + 1; });
  return acc;
}, {});
meta.vndbStaffFilled = { at: new Date().toISOString(), ...counts };
const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(meta)};\n` +
  `window.GL_DATA = ${JSON.stringify(all)};\n`;
await mkdir(path.dirname(CACHE), { recursive: true });
await writeFile(MAIN, content, 'utf8');
console.log(`\n已写回：${changes.length} 条`);
