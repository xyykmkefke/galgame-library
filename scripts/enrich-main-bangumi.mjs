// 主库字段补齐：按 Bangumi 详情 infobox 补 开发 / 剧本 / 原画 / 音乐 / 中文名。
// 只填空字段，不覆盖已有值；默认 dry-run，加 --apply 才写回 data/galgames.js。
//
// 用法：
//   node scripts/enrich-main-bangumi.mjs                    # 预演全部缺项
//   node scripts/enrich-main-bangumi.mjs --limit=50         # 只预演热度前 50 条
//   node scripts/enrich-main-bangumi.mjs --fields=dev,cn    # 只处理指定字段
//   node scripts/enrich-main-bangumi.mjs --apply            # 写回
//   node scripts/enrich-main-bangumi.mjs --refresh          # 忽略详情缓存重抓
//
// 缓存：data/build/bgm-details.json（按 Bangumi id 保存 name_cn 与 infobox 子集）

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const CACHE = path.join(ROOT, 'data', 'build', 'bgm-details.json');
const API = 'https://bgmapi.anibt.net/v0/subjects/';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const DELAY = 800;
const APPLY = process.argv.includes('--apply');
const REFRESH = process.argv.includes('--refresh');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 0;
const CONCURRENCY = Math.max(1, Math.min(4, Number((process.argv.find((a) => a.startsWith('--concurrency=')) || '').slice(14)) || 2));
const FIELD_ARG = (process.argv.find((a) => a.startsWith('--fields=')) || '').slice(9);
const FIELDS = new Set((FIELD_ARG || 'dev,sc,ar,mu,cn').split(',').map((s) => s.trim()).filter(Boolean));
const ALLOWED = new Set(['dev', 'sc', 'ar', 'mu', 'cn']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanDev(raw) {
  return String(raw || '').trim()
    .replace(/\s*(co\.,?\s*ltd\.?|co\.?\s*ltd\.?|inc\.?|llc|ltd\.?|corporation|corp\.?|gmbh|株式会社|有限会社|合同会社)\s*$/i, '')
    .trim()
    .replace(/^[·・,，、.\s]+|[·・,，、.\s]+$/g, '');
}

// infobox 的 value 可能是字符串，也可能是 [{v}] 数组
function textOf(value) {
  if (Array.isArray(value)) {
    return value.map((v) => String((v && v.v) || v || '').trim()).filter(Boolean).join('、');
  }
  return String(value || '').trim();
}

function namesOf(value) {
  const text = textOf(value);
  if (!text) return [];
  return text.split(/[、,，/／]/).map(cleanDev).filter(Boolean);
}

// 别名最多保留 5 个，去掉与中文名 / 原名重复或过长的项
function cleanAliases(list, x) {
  const own = new Set([x.cn, x.n, x.py].map((v) => String(v || '').toLowerCase().replace(/\s+/g, '')).filter(Boolean));
  const out = [];
  (list || []).forEach((raw) => {
    const name = String(raw || '').trim();
    if (!name || name.length > 40) return;
    const key = name.toLowerCase().replace(/\s+/g, '');
    if (!key || own.has(key)) return;
    own.add(key);
    out.push(name);
  });
  return out.slice(0, 5);
}

function boxOf(detail) {
  const out = {};
  (detail.infobox || []).forEach((item) => {
    if (item && item.key) out[item.key] = item.value;
  });
  return out;
}

async function fetchDetail(id) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API + id, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 429) {
        console.warn('    限流，等待 10s');
        await sleep(10000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      const box = boxOf(json);
      return {
        ok: true,
        at: new Date().toISOString(),
        name_cn: String(json.name_cn || '').trim(),
        dev: namesOf(box['开发'] || box['开发商'] || box['ブランド']),
        sc: textOf(box['剧本']),
        ar: textOf(box['原画']),
        mu: textOf(box['音乐']),
        gt: textOf(box['游戏类型']),
        alias: Array.isArray(box['别名'])
          ? box['别名'].map((v) => String((v && v.v) || v || '').trim()).filter(Boolean)
          : String(box['别名'] || '').split(/[、,，/／]/).map((s) => s.trim()).filter(Boolean),
      };
    } catch (err) {
      if (attempt === 3) {
        return { ok: false, error: String(err.message || err), at: new Date().toISOString() };
      }
      console.warn(`    重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 2000);
    }
  }
  return { ok: false, error: 'unknown', at: new Date().toISOString() };
}

const raw = await readFile(MAIN, 'utf8');
const meta = JSON.parse(raw.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/)[1]);
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);

const missing = (x, field) => {
  if (field === 'dev') return !x.dev || !x.dev.length;
  if (field === 'cn') return !x.cn || !String(x.cn).trim();
  return !x[field] || !String(x[field]).trim();
};

const visible = all.filter((x) => x.k !== 'off');
let targets = visible.filter((x) => [...FIELDS].some((f) => missing(x, f)));
targets.sort((a, b) => (b.h || 0) - (a.h || 0));
if (LIMIT > 0) targets = targets.slice(0, LIMIT);

let cache = {};
if (!REFRESH) {
  try { cache = JSON.parse(await readFile(CACHE, 'utf8')); } catch { /* 首次运行 */ }
}

console.log(`字段：${[...FIELDS].join(', ')}`);
console.log(`缺失目标：${targets.length} 条（缓存 ${Object.keys(cache).length} 条）`);

const stats = { dev: 0, sc: 0, ar: 0, mu: 0, cn: 0, alias: 0, aliasApplied: 0 };
const changes = [];
let fetched = 0;
let failed = 0;

const pending = targets.filter((x) => {
  const key = String(x.i);
  return !cache[key] || REFRESH || cache[key].ok === false;
});
console.log(`需抓取：${pending.length} 条（并发 ${CONCURRENCY}，间隔 ${DELAY}ms）`);

let cursor = 0;
async function worker() {
  while (cursor < pending.length) {
    const x = pending[cursor];
    cursor += 1;
    const key = String(x.i);
    const detail = await fetchDetail(key);
    cache[key] = detail;
    fetched += 1;
    if (!detail.ok) failed += 1;
    if (fetched % 25 === 0) {
      await writeFile(CACHE, JSON.stringify(cache), 'utf8');
      console.log(`  抓取 ${fetched}/${pending.length}，失败 ${failed}`);
    }
    await sleep(DELAY);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
await mkdir(path.dirname(CACHE), { recursive: true });
await writeFile(CACHE, JSON.stringify(cache), 'utf8');

for (const x of targets) {
  const d = cache[String(x.i)];
  if (!d || !d.ok) continue;
  const patch = {};
  if (FIELDS.has('dev') && missing(x, 'dev') && d.dev && d.dev.length) {
    patch.dev = d.dev;
  }
  for (const field of ['sc', 'ar', 'mu']) {
    if (FIELDS.has(field) && missing(x, field) && d[field]) patch[field] = d[field];
  }
  if (FIELDS.has('cn') && missing(x, 'cn') && d.name_cn) patch.cn = d.name_cn;
  if (d.alias && d.alias.length) {
    stats.alias += 1;
    if (!x.al || !x.al.length) {
      const aliases = cleanAliases(d.alias, x);
      if (aliases.length) {
        patch.al = aliases;
        stats.aliasApplied += 1;
      }
    }
  }
  if (patch.dev) stats.dev += 1;
  if (patch.sc) stats.sc += 1;
  if (patch.ar) stats.ar += 1;
  if (patch.mu) stats.mu += 1;
  if (patch.cn) stats.cn += 1;
  if (Object.keys(patch).length) {
    changes.push({ id: x.i, name: x.cn || x.n, patch });
    if (APPLY) Object.assign(x, patch);
  }
}

console.log(`\n可补条目：${changes.length} 条（抓取 ${fetched}，失败 ${failed}）`);
console.log(`字段命中：开发 ${stats.dev} · 剧本 ${stats.sc} · 原画 ${stats.ar} · 音乐 ${stats.mu} · 中文名 ${stats.cn} · 有别名 ${stats.alias} / 可写别名 ${stats.aliasApplied}`);
console.log('\n抽样：');
changes.slice(0, 15).forEach((c) => {
  console.log(`  [${c.id}] ${c.name} -> ${JSON.stringify(c.patch).slice(0, 180)}`);
});

if (!APPLY) {
  console.log(`\n预演完成，未写数据。确认后运行：node scripts/enrich-main-bangumi.mjs --apply${LIMIT ? ` --limit=${LIMIT}` : ''}`);
  process.exit(0);
}

// 写回主库，只更新被补的条目与 meta 统计
const counts = changes.reduce((acc, c) => {
  Object.keys(c.patch).forEach((k) => { acc[k] = (acc[k] || 0) + 1; });
  return acc;
}, {});
meta.bgmDetailFilled = {
  at: new Date().toISOString(),
  dev: counts.dev || 0,
  sc: counts.sc || 0,
  ar: counts.ar || 0,
  mu: counts.mu || 0,
  cn: counts.cn || 0,
  al: counts.al || 0,
};

const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(meta)};\n` +
  `window.GL_DATA = ${JSON.stringify(all)};\n`;
await writeFile(MAIN, content, 'utf8');
console.log(`\n已写回 ${MAIN}：${changes.length} 条`);
