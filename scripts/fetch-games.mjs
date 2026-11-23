// 从 Bangumi 镜像 API 抓取 galgame 条目，按年份分桶缓存后合并为 data/galgames.js
// 用法：
//   node scripts/fetch-games.mjs            增量：已有桶缓存直接复用
//   node scripts/fetch-games.mjs --refresh  清空缓存重抓
//   node scripts/fetch-games.mjs --tags=galgame,视觉小说   指定标签（默认见 TAGS）
//
// 镜像单次搜索 offset 上限为 1000（offset >= 1000 返回空数组），所以不能按 total 一路翻页，
// 必须按发售年份分桶，每桶内部翻页；末尾再用 heat / rank / score 三个排序各取前 1000 条兜底，
// 补上少量没有发售日、无法被年份桶命中的条目。
//
// 多个标签按 id 合并去重；桶缓存保留原始平台串（plr），平台归一规则调整后可离线重算。

import { mkdir, writeFile, readFile, access, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { initials } from './build-pinyin.mjs';
import { genreIdsFromNames, rawTagNames, tagVotes } from './genres.mjs';

const BASE = 'https://bgmapi.anibt.net';
const START_YEAR = 1980;
const END_YEAR = 2027;
const PAGE_SIZE = 20;
const OFFSET_LIMIT = 1000;
const DELAY_MS = 800;
const USER_AGENT = 'yuc-galgame-list/1.0';
const REFRESH = process.argv.includes('--refresh');

const tagArg = (process.argv.find((a) => a.startsWith('--tags=')) || '').slice(7);
// 默认只收日系 galgame 相关标签：ADV 覆盖大量非 gal 的冒险 / 解谜游戏，不纳入
const TAGS = tagArg
  ? tagArg.split(',').map((s) => s.trim()).filter(Boolean)
  : ['galgame', '视觉小说', '百合', 'BL', '拔作'];
const TAG_SLUG = new Map([['galgame', 'g'], ['视觉小说', 'vn'], ['ADV', 'adv']]);
const tagSlug = (tag) => TAG_SLUG.get(tag) || `t${Buffer.from(tag).toString('hex').slice(0, 8)}`;

const rootDir = path.resolve(import.meta.dirname, '..');
const buildDir = path.join(rootDir, 'data', 'build');
const outFile = path.join(rootDir, 'data', 'galgames.js');
const OTOME_FILE = path.join(rootDir, 'data', 'blocklist-otome.json');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 乙女向主库黑名单：已确认的 Bangumi id，抓取时直接跳过
async function loadOtomeMainIds() {
  try {
    const data = JSON.parse(await readFile(OTOME_FILE, 'utf8'));
    return new Set((data.main || []).map((x) => String(x.i)).filter(Boolean));
  } catch {
    return new Set();
  }
}

// 原始标签可能是字符串或对象，统一取出名字再判断乙女
const tagName = (t) => (typeof t === 'string' ? t : String((t && (t.name || t.n)) || ''));
const isOtomeRaw = (rt) => Array.isArray(rt) && rt.some((t) => /乙女|otome/i.test(tagName(t)));
const pad = (n) => String(n).padStart(2, '0');

// ---------- 平台归一 ----------

// 先把 Xbox Series X/S 这类含斜杠的复合名替换成占位符，避免被拆分
const PROTECTED = [[/xbox\s*series\s*x\s*[/&＆]\s*s/gi, '\u0000XSX\u0000']];

const PLATFORM_MAP = new Map(Object.entries({
  pc: 'PC', windows: 'PC', win: 'PC', 'microsoft windows': 'PC', 'windows pc': 'PC', 'pc windows': 'PC',
  steam: 'PC', xp: 'PC', vista: 'PC',
  'windows 95': 'PC', 'windows 98': 'PC', 'windows 2000': 'PC', 'windows xp': 'PC',
  'windows vista': 'PC', 'windows 7': 'PC', 'windows 8': 'PC', 'windows 8.1': 'PC', 'windows 10': 'PC', 'windows 11': 'PC',
  playstation: 'PS', ps: 'PS', ps1: 'PS', 'playstation 1': 'PS', 'playstation one': 'PS',
  ps2: 'PS2', 'playstation 2': 'PS2', 'playstation2': 'PS2',
  ps3: 'PS3', 'playstation 3': 'PS3',
  ps4: 'PS4', 'playstation 4': 'PS4',
  ps5: 'PS5', 'playstation 5': 'PS5',
  psp: 'PSP', 'playstation portable': 'PSP',
  psv: 'PSV', 'ps vita': 'PSV', psvita: 'PSV', 'playstation vita': 'PSV',
  switch: 'Switch', swtich: 'Switch', 'nintendo switch': 'Switch', ns: 'Switch',
  'switch 2': 'Switch 2', 'nintendo switch 2': 'Switch 2',
  '3ds': '3DS', '3dsll': '3DS', '3ds ll': '3DS', 'nintendo 3ds': '3DS', 'new 3ds': '3DS',
  nds: 'NDS', ds: 'NDS', ndsi: 'NDS', dsi: 'NDS', 'nds lite': 'NDS', 'nintendo ds': 'NDS',
  wii: 'Wii', 'nintendo wii': 'Wii',
  'wii u': 'WiiU', wiiu: 'WiiU', 'nintendo wii u': 'WiiU',
  gc: 'GC', ngc: 'GC', gamecube: 'GC', 'nintendo gamecube': 'GC',
  xbox: 'Xbox', xbox360: 'Xbox 360', 'xbox 360': 'Xbox 360',
  'xbox one': 'Xbox One', xboxone: 'Xbox One',
  '\u0000xsx\u0000': 'Xbox Series X/S', 'xbox series': 'Xbox Series X/S',
  ios: 'iOS', iphone: 'iOS', ipad: 'iOS', ipados: 'iOS',
  android: 'Android', 安卓: 'Android',
  mac: 'macOS', 'mac os': 'macOS', macos: 'macOS', 'mac os x': 'macOS', 'os x': 'macOS',
  linux: 'Linux',
  dc: 'DC', dreamcast: 'DC', 'sega saturn': 'SS', saturn: 'SS', ss: 'SS',
  pce: 'PCE', 'pc engine': 'PCE',
  'playstation vr': 'PSVR', psvr: 'PSVR', 'steam vr': 'Steam VR',
  'playstationvita': 'PSV', 'psvita': 'PSV',
  me: 'PC', 'windows me': 'PC', 'windows nt': 'PC', nt: 'PC', 'windows phone': 'Windows Phone',
  'win 98': 'PC', 'win98': 'PC',
  'pc98': 'PC-98', 'pc-98': 'PC-98',
  'switch lite': 'Switch', 'nintendo switch lite': 'Switch',
  web: 'Web', browser: 'Web', 网页: 'Web', 浏览器: 'Web', ブラウザ: 'Web', 在線: 'Web', 'online game': 'Web',
}));

const JUNK_PLATFORM = new Set([
  '', 'all', '其他', '未知', '不详', '无', '未定', '待定', '-', '—', 'null', 'n/a', 'tba', '?', '/',
]);

// 去掉 ®™©、全角字母数字转半角、去掉括号内的说明（如「PC (Windows)」）
function cleanToken(raw) {
  let v = String(raw || '');
  v = v.replace(/[Ａ-Ｚａ-ｚ０-９＋]/g, (ch) => {
    if (ch === '＋') return '+';
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  v = v.replace(/[®™©℗]/g, '');
  v = v.replace(/[（(][^）)]*[）)]/g, ' ');
  // 缓存里可能残留被分隔符拆坏的半截括号，直接截断 / 去掉
  v = v.replace(/[（(][^）)]*$/, ' ').replace(/[）)]/g, ' ');
  return v.replace(/\s+/g, ' ').trim();
}

function normalizePlatform(value) {
  let v = cleanToken(value);
  if (!v) return '';
  PROTECTED.forEach(([re, token]) => { v = v.replace(re, token); });
  const key = v.toLowerCase().replace(/\s+/g, ' ').trim();
  if (JUNK_PLATFORM.has(key)) return '';
  if (/^\d+$/.test(key)) return '';                          // 纯数字（由 / 拆分出的版本号碎片）
  if (/^[\d.]+$/.test(key)) return '';                       // 8.1 / 11 这类版本号
  if (/^\d+(\s*日本語版)?$/.test(key)) return '';             // 10 日本語版
  if (/^\d+用$/.test(key)) return '';                        // 98用
  if (PLATFORM_MAP.has(key)) return PLATFORM_MAP.get(key);
  // Windows 7/8/10、WindowsXP、Windows2000以降、Win 98、Window 10以上 等统一归 PC
  if (/^(win|windows|window)\s*\d/.test(key)) return 'PC';
  if (/^(microsoft\s*)?windows/.test(key)) return 'PC';
  // 3DS / 3DSLL / 3DS 3DSLL 等手写合并值
  if (/^3ds/.test(key)) return '3DS';
  if (/^nds/.test(key)) return 'NDS';
  if (/^nintendo\s*sw[ti]*ch$/.test(key)) return 'Switch';
  if (/^playstation\s*\d$/.test(key)) return 'PS' + key.slice(-1);
  if (/^ps\s*\d$/.test(key)) return 'PS' + key.slice(-1);
  return v;
}

// 把「平台」字段拆成原始碎片（写入桶缓存，供离线重算归一）
const PLATFORM_SPLIT = /[|、/／,，&＆+＋]|及|和/;

function platformPieces(infobox) {
  const out = [];
  const seen = new Set();
  infoValues(infobox, '平台').forEach((raw) => {
    // 先整体去括号，避免「PC (Windows 98/XP)」被斜杠拆成两半
    let v = cleanToken(raw);
    PROTECTED.forEach(([re, token]) => { v = v.replace(re, token); });
    v.split(PLATFORM_SPLIT).forEach((piece) => {
      const name = cleanToken(piece).replace(/\u0000XSX\u0000/g, 'Xbox Series X/S');
      if (!name || seen.has(name)) return;
      seen.add(name);
      out.push(name);
    });
  });
  return out;
}

function platformsFromPieces(pieces) {
  const out = [];
  const seen = new Set();
  (pieces || []).forEach((piece) => {
    const name = normalizePlatform(piece);
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  });
  return out;
}

// ---------- infobox 取值 ----------

function infoValues(infobox, key) {
  const item = (infobox || []).find((x) => x && x.key === key);
  if (!item) return [];
  const raw = Array.isArray(item.value) ? item.value : [item.value];
  return raw
    .map((v) => (typeof v === 'string' ? v : (v && v.v) || ''))
    .map((v) => String(v).trim())
    .filter(Boolean);
}

// 按分隔符拆成数组（用于开发这类多值字段）
function splitValues(values, re = /[、，,]/) {
  const out = [];
  const seen = new Set();
  values.forEach((raw) => {
    String(raw).split(re).forEach((piece) => {
      const name = piece.trim();
      if (!name || name === '—' || seen.has(name)) return;
      seen.add(name);
      out.push(name);
    });
  });
  return out;
}

// 开发商名归一：去掉「株式会社」「Co., Ltd.」等公司后缀，便于按厂商聚合
const DEV_NOISE_HEAD = /^(株式会社|有限会社|合同会社|（株）|\(株\)|（有）|\(有\))\s*/;
const DEV_NOISE_TAIL = /\s*(co\.,?\s*ltd\.?|co\.,?\s*ltd|inc\.?|llc|ltd\.?|corporation|corp\.?|gmbh|株式会社|有限会社|合同会社)\s*$/i;

function normalizeDevName(raw) {
  let v = cleanToken(raw);
  v = v.replace(DEV_NOISE_HEAD, '').replace(DEV_NOISE_TAIL, '').trim();
  v = v.replace(/^[·・,，、.\s]+|[·・,，、.\s]+$/g, '');
  // 至少保留一个任意语言的字母或数字；纯符号视为无效
  if (!v || !/[\p{L}\p{N}]/u.test(v)) return '';
  return v;
}

function normalizeDevList(list) {
  const out = [];
  const seen = new Set();
  (list || []).forEach((raw) => {
    const name = normalizeDevName(raw);
    if (!name || seen.has(name)) return;
    seen.add(name);
    out.push(name);
  });
  return out;
}

// 多值字段用「、」连接成一个展示字符串
function joinValues(values) {
  return splitValues(values, /[、，,/／]/).join('、');
}

// ---------- 网络请求 ----------

let requestCount = 0;

async function requestPage(payload, offset) {
  const url = `${BASE}/v0/search/subjects?limit=${PAGE_SIZE}&offset=${offset}`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      requestCount += 1;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw err;
      const wait = attempt * 2000;
      console.warn(`    重试 ${attempt}/3：${err.message}，${wait}ms 后继续`);
      await sleep(wait);
    }
  }
}

// ---------- 数据压缩 ----------

function slim(item) {
  // rt / plr 只写入桶缓存，便于以后离线重算题材与平台归一；不会进入 galgames.js
  const tagNames = rawTagNames(item.meta_tags, item.tags);
  const votes = tagVotes(item.tags);
  const infobox = item.infobox || [];
  const pieces = platformPieces(infobox);
  const out = {
    i: item.id,
    n: item.name || '',
    cn: item.name_cn || infoValues(infobox, '中文名')[0] || '',
    d: item.date || '',
    s: item.rating?.score || 0,
    rk: item.rating?.rank || 0,
    h: item.collection?.collect || 0,
    img: item.images?.common || item.images?.large || '',
    py: initials(item.name_cn || infoValues(infobox, '中文名')[0] || item.name || ''),
    tg: genreIdsFromNames(tagNames),
    pl: platformsFromPieces(pieces),
    plr: pieces,
    dev: splitValues(infoValues(infobox, '开发')),
    pub: joinValues(infoValues(infobox, '发行')),
    sc: joinValues(infoValues(infobox, '剧本')),
    ar: joinValues(infoValues(infobox, '原画')),
    mu: joinValues(infoValues(infobox, '音乐')),
    gt: joinValues(infoValues(infobox, '游戏类型')),
    ns: Boolean(item.nsfw),
    rt: tagNames,
    gc: votes.galgame,
    wc: votes.whitelist,
  };
  if (!out.pl.length) delete out.pl;
  if (!out.dev.length) delete out.dev;
  return out;
}

// ---------- 桶与抓取 ----------

function buildBuckets(tag) {
  const list = [];
  // 1980 年之前的老作品单独一桶
  list.push({ key: 'pre1980', label: '1980 前', filter: { type: [4], tag: [tag], air_date: ['<1980-01-01'] } });
  for (let year = START_YEAR; year <= END_YEAR; year += 1) {
    list.push({
      key: String(year),
      label: `${year}`,
      filter: { type: [4], tag: [tag], air_date: [`>=${year}-01-01`, `<${year + 1}-01-01`] },
    });
  }
  return list;
}

// 兜底桶：不带日期过滤，按不同排序各取前 1000 条，补上没有发售日的条目
function buildFillBuckets(tag) {
  return ['heat', 'rank', 'score'].map((sort) => ({
    key: `fill-${sort}`,
    label: `兜底 ${sort}`,
    sort,
    filter: { type: [4], tag: [tag] },
  }));
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function crawlBucket(bucket, cacheKey) {
  const items = [];
  let offset = 0;

  while (offset < OFFSET_LIMIT) {
    const payload = { keyword: '', sort: bucket.sort || 'heat', filter: bucket.filter };
    const data = await requestPage(payload, offset);
    const page = data?.data || [];
    page.forEach((raw) => items.push(slim(raw)));
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
    await sleep(DELAY_MS);
  }

  await writeFile(path.join(buildDir, `${cacheKey}.json`), JSON.stringify(items), 'utf8');
  return items.length;
}

// 跨标签同 id 合并：保留先到的条目，补齐缺失字段
function mergeEntry(prev, next) {
  const out = { ...prev };
  ['pl', 'dev', 'pub', 'sc', 'ar', 'mu', 'gt'].forEach((k) => {
    const missing = out[k] == null || (Array.isArray(out[k]) && !out[k].length) || out[k] === '';
    if (missing && next[k] != null) out[k] = next[k];
  });
  ['d', 'img', 's', 'cn', 'n'].forEach((k) => {
    if (!out[k] && next[k]) out[k] = next[k];
  });
  return out;
}

async function main() {
  await mkdir(buildDir, { recursive: true });

  if (REFRESH && await exists(buildDir)) {
    const files = await readdir(buildDir);
    for (const f of files) {
      if (f.endsWith('.json')) await unlink(path.join(buildDir, f));
    }
    console.log('已清空 data/build 缓存');
  }

  const byId = new Map();
  const otomeMain = await loadOtomeMainIds();
  let fetched = 0;
  let thresholdSkipped = 0;

  for (const tag of TAGS) {
    const slug = tagSlug(tag);
    const buckets = buildBuckets(tag);
    const fills = buildFillBuckets(tag);

    console.log(`[${tag}] 计划抓取 ${buckets.length} 个年份桶 + ${fills.length} 个兜底桶`);

    const run = async (list) => {
      for (const bucket of list) {
        const cacheKey = `${slug}-${bucket.key}`;
        const cacheFile = path.join(buildDir, `${cacheKey}.json`);
        let items;

        if (!REFRESH && await exists(cacheFile)) {
          items = JSON.parse(await readFile(cacheFile, 'utf8'));
        } else {
          try {
            const count = await crawlBucket(bucket, cacheKey);
            items = JSON.parse(await readFile(cacheFile, 'utf8'));
            fetched += 1;
            console.log(`[${cacheKey}] 抓取 ${count} 条`);
          } catch (err) {
            console.error(`[${cacheKey}] 失败：${err.message}`);
            if (await exists(cacheFile)) {
              items = JSON.parse(await readFile(cacheFile, 'utf8'));
              console.warn(`    ${cacheKey} 使用旧缓存`);
            } else {
              continue;
            }
          }
          await sleep(DELAY_MS);
        }

        for (const item of items) {
          if (!item || !Number.isInteger(item.i)) continue;
          // 乙女向是明确排除项：黑名单 id 与原始标签双重拦截
          if (otomeMain.has(String(item.i)) || isOtomeRaw(item.rt)) continue;
          // 标签票数门槛：仅对新缓存（含 gc/wc）生效，老缓存不追溯过滤
          const hasVotes = Number.isFinite(item.gc) || Number.isFinite(item.wc);
          if (hasVotes && Number(item.gc || 0) < 3 && Number(item.wc || 0) < 1) {
            thresholdSkipped += 1;
            continue;
          }
          // 方向是日系 galgame：明确标为欧美作品的条目不收
          if (Array.isArray(item.rt) && item.rt.some((t) => /^(欧美|欧美系)$/.test(String(t)))) continue;

          // 有原始平台碎片时按最新归一遍，调整映射后无需重新联网
          const { rt, plr, gc, wc, ...rest } = item;
          if (Array.isArray(plr) && plr.length) rest.pl = platformsFromPieces(plr);
          if (Array.isArray(rest.pl) && !rest.pl.length) delete rest.pl;

          // 有原始标签时按最新映射重算题材；映射出乙女也跳过
          const tg = rt ? genreIdsFromNames(rt) : (rest.tg || []);
          if (tg.includes('oto')) continue;
          if (tg.length) rest.tg = tg;
          else delete rest.tg;

          // 开发商名归一，改规则后可直接离线重算
          if (Array.isArray(rest.dev)) rest.dev = normalizeDevList(rest.dev);
          if (Array.isArray(rest.dev) && !rest.dev.length) delete rest.dev;

          const prev = byId.get(rest.i);
          byId.set(rest.i, prev ? mergeEntry(prev, rest) : rest);
        }
      }
    };

    await run(buckets);
    await run(fills);
  }

  const all = [...byId.values()].filter((x) => !otomeMain.has(String(x.i)) && !(x.tg || []).includes('oto'));
  all.sort((a, b) => (a.d < b.d ? 1 : a.d > b.d ? -1 : 0));

  // 主库非 gal 标记：只加 k="off"，不删条目，保证重抓后仍默认隐藏
  let nonGal = new Set();
  try {
    const blockRaw = await readFile(path.join(rootDir, 'data', 'blocklist-main.json'), 'utf8');
    nonGal = new Set((JSON.parse(blockRaw).items || []).map((x) => Number(x.i)).filter(Boolean));
  } catch { /* 黑名单可选 */ }
  let nonGalMarked = 0;
  if (nonGal.size) {
    all.forEach((x) => {
      if (nonGal.has(Number(x.i))) {
        x.k = 'off';
        nonGalMarked += 1;
      }
    });
  }

  const dates = all.map((x) => x.d).filter(Boolean).sort();
  const meta = {
    generatedAt: new Date().toISOString(),
    count: all.length,
    minDate: dates[0] || '',
    maxDate: dates[dates.length - 1] || '',
    nonGalMarked,
    thresholdSkipped,
  };

  const content = `// 由 scripts/fetch-games.mjs 生成，请勿手动修改\nwindow.GL_META = ${JSON.stringify(meta)};\nwindow.GL_DATA = ${JSON.stringify(all)};\n`;
  await writeFile(outFile, content, 'utf8');

  console.log(`完成：网络请求 ${requestCount} 次，本次新抓 ${fetched} 个桶，共 ${all.length} 条（非 gal 标记 ${nonGalMarked} 条，票数门槛跳过 ${thresholdSkipped} 条）`);
  console.log(`日期范围：${meta.minDate} ~ ${meta.maxDate}`);
  console.log(`输出：${outFile}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
