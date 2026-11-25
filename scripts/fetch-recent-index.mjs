// 抓取「新作索引」：2025 年起发售的全部日系 VN，不设票数门槛，补扩展库按全局票数排序漏掉的新作。
// 用法：
//   node scripts/fetch-recent-index.mjs            默认 dry-run，只统计不写文件
//   node scripts/fetch-recent-index.mjs --apply    写 data/recent-extra.js
//   node scripts/fetch-recent-index.mjs --from=2025-01-01 --apply
//
// 背景：vndb-extra.js 按全局 votecount 降序取前 3000 条，新作票数天然低会被老作挤出。
// 实测收录率 2015 年 61% → 2026 年 27%，本脚本专门补 2025 年后的缺口。
//
// 字段刻意精简（无 staff / 无标签 / 无时长），控制体积：10547 条约 864KB。
// 复用 fetch-vndb-extra.mjs 的平台映射与开发商清洗口径，保持两库字段一致。
//
// VNDB 匿名限流约 200 次 / 5 分钟；这里分页间隔 1.2s，命中 429 等 60s。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mapVndbGenres, genreFromTitle } from './vndb-genre-map.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'recent-extra.js');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';

const FROM = (process.argv.find((a) => a.startsWith('--from=')) || '').slice(7) || '2025-01-01';
const APPLY = process.argv.includes('--apply');
const PAGE_SIZE = 100;
const MAX_PAGE = 200;
const DELAY_MS = 1200;

// 只取必要字段：精简体积。tags 只用于映射成 tg 数组后丢弃，不落库
const FIELDS = 'id,title,alttitle,titles.title,titles.lang,image.url,released,rating,votecount,developers.name,platforms,tags.name,tags.rating,tags.spoiler';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function fullDate(value) {
  const m = String(value || '').match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/);
  if (!m) return '';
  // 只到年份（如 "2028"）时保留年份精度，不臆造 01-01 —— 否则会被当成已确切的发售日
  if (!m[2]) return m[1];
  return `${m[1]}-${m[2]}-${m[3] || '01'}`;
}

function buildItem(c) {
  const titles = c.titles || [];
  const ja = (titles.find((t) => t.lang === 'ja') || {}).title || '';
  const zhHans = (titles.find((t) => t.lang === 'zh-Hans') || {}).title || '';
  const zhHant = (titles.find((t) => t.lang === 'zh-Hant') || {}).title || '';
  const n = String(ja || c.alttitle || c.title || '').trim();
  if (!n) return null;
  // VNDB 的 TBA 作品会被 release 排序排在最前，fullDate('TBA') 返回空串；
  // 但部分作品被写成了远期占位日期（如 2028-01-01），这类同样不能算「已发售新作」
  const d = fullDate(c.released);
  if (!d) return null;
  const item = {
    i: 1000000 + Number(String(c.id || '').slice(1)),
    n,
    d,
    vx: c.id,
    rn: 1,
  };
  if (c.rating) item.s = Number((Number(c.rating) / 10).toFixed(1));
  if (Number(c.votecount) > 0) item.h = Number(c.votecount);
  const cn = String(zhHans || zhHant || '').trim();
  if (cn) item.cn = cn;
  if (c.image && c.image.url) item.img = c.image.url;
  const dev = cleanDevs(c.developers);
  if (dev.length) item.dev = dev;
  const pl = mapPlatforms(c.platforms);
  if (pl.length) item.pl = pl;
  // 题材：新作大多没有足够票数，标签缺失时用标题关键词兜底，
  // 否则用户一旦按题材筛选，这批新作就永远不出现
  const tg = mapVndbGenres(c.tags);
  const finalTg = tg.length ? tg : genreFromTitle(n);
  // 乙女向是项目既定排除项（见 data/blocklist-otome.json），新作无法靠黑名单覆盖，
  // 这里按题材兜底剔除，否则重抓会把这批作品重新带回来
  if (finalTg.includes('oto')) return null;
  if (finalTg.length) item.tg = finalTg;
  return item;
}

async function queryPage(page) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          filters: ['and', ['olang', '=', 'ja'], ['released', '>=', FROM]],
          sort: 'released',
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
  throw new Error('分页请求失败');
}

// 读现有库里的 VNDB id，用于去重（已有的不再抓进新作索引）
async function loadExistingIds() {
  const ids = new Set();
  try {
    const src = await readFile(path.join(ROOT, 'data', 'vndb.js'), 'utf8');
    const json = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
    Object.values(json.map || {}).forEach((o) => { if (o && o.v) ids.add(String(o.v)); });
  } catch { /* 缺失则视为空 */ }
  try {
    const src = await readFile(path.join(ROOT, 'data', 'vndb-extra.js'), 'utf8');
    const json = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
    (json.list || []).forEach((x) => { if (x.vx) ids.add(String(x.vx)); });
  } catch { /* 缺失则视为空 */ }
  return ids;
}

async function loadBlocklist() {
  const set = new Set();
  for (const file of ['blocklist.json', 'blocklist-otome.json']) {
    try {
      const data = JSON.parse(await readFile(path.join(ROOT, 'data', file), 'utf8'));
      (data.items || data.vndb || []).forEach((x) => { if (x.vx) set.add(String(x.vx)); });
    } catch { /* 缺失跳过 */ }
  }
  return set;
}

async function main() {
  console.log(`新作索引：released >= ${FROM}，olang=ja，不设票数门槛`);
  const existing = await loadExistingIds();
  const blocked = await loadBlocklist();
  console.log(`已有 VNDB id ${existing.size} 个，黑名单 ${blocked.size} 个`);

  const list = [];
  const seen = new Set();
  let total = 0;
  for (let page = 1; page <= MAX_PAGE; page += 1) {
    const data = await queryPage(page);
    const results = data.results || [];
    if (!results.length) break;
    total += results.length;
    for (const c of results) {
      const id = String(c.id || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (existing.has(id) || blocked.has(id)) continue;
      const item = buildItem(c);
      if (item) list.push(item);
    }
    if (!data.more) break;
    if (page % 10 === 0) console.log(`  第 ${page} 页，累计原始 ${total} 条，保留 ${list.length} 条`);
    await sleep(DELAY_MS);
  }

  // 按发售日降序，便于页面「新作」维度默认排序
  list.sort((a, b) => String(b.d || '').localeCompare(String(a.d || '')));

  const payload = {
    v: 1,
    meta: {
      generatedAt: new Date().toISOString(),
      source: 'vndb',
      filter: { olang: 'ja', releasedGte: FROM, voteMin: 0 },
      fetched: total,
      count: list.length,
      skippedExisting: total - list.length,
    },
    list,
  };
  const body = `// 由 scripts/fetch-recent-index.mjs 生成，请勿手动修改\nwindow.GL_RECENT = ${JSON.stringify(payload)};\n`;
  const kb = (Buffer.byteLength(body, 'utf8') / 1024).toFixed(0);

  const withVote = list.filter((x) => (x.h || 0) > 0).length;
  const withDev = list.filter((x) => x.dev && x.dev.length).length;
  const withPl = list.filter((x) => x.pl && x.pl.length).length;
  const withImg = list.filter((x) => x.img).length;
  const withCn = list.filter((x) => x.cn).length;
  const withTg = list.filter((x) => x.tg && x.tg.length).length;
  const byYear = {};
  list.forEach((x) => { const y = String(x.d || '').slice(0, 4); if (y) byYear[y] = (byYear[y] || 0) + 1; });

  console.log('');
  console.log(`抓取原始 ${total} 条，去重后保留 ${list.length} 条`);
  console.log(`字段覆盖：有票 ${withVote} · 开发商 ${withDev} · 平台 ${withPl} · 封面 ${withImg} · 中文名 ${withCn} · 题材 ${withTg}`);
  console.log('按年：' + Object.keys(byYear).sort().map((y) => `${y} ${byYear[y]}`).join(' · '));
  console.log(`体积：${kb}KB（原始字节，未压缩）`);

  if (!APPLY) {
    console.log('');
    console.log('dry-run 结束，未写文件。加 --apply 写入 data/recent-extra.js');
    return;
  }
  await writeFile(OUT_FILE, body, 'utf8');
  console.log(`已写入 ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('失败：' + err.message);
  process.exit(1);
});
