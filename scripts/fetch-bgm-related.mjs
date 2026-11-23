// 以主库条目为种子，遍历 Bangumi 关联条目，补同系列 / 前传续作 / 外传等日系 galgame
// 用法：
//   node scripts/fetch-bgm-related.mjs                 默认 500 个种子、最多补 500 条
//   node scripts/fetch-bgm-related.mjs --seeds=800 --limit=800
//
// 只收 type=4（游戏）、且日期 / 评分 / 封面 / 开发商 / 平台 / 题材齐全的条目；
// 已存在于主库的 id 与标题全部跳过。输出 data/bgm-extra.js，页面运行时并入全库。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initials } from './build-pinyin.mjs';
import { genreIdsFromNames, rawTagNames } from './genres.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'bgm-extra.js');
const OTOME_FILE = path.join(ROOT, 'data', 'blocklist-otome.json');
const BASE = 'https://bgmapi.anibt.net';
const UA = 'yuc-galgame-list/1.0';
const SEEDS = Number((process.argv.find((a) => a.startsWith('--seeds=')) || '').slice(8)) || 500;
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 500;
const CONCURRENCY = Number((process.argv.find((a) => a.startsWith('--concurrency=')) || '').slice(14)) || 4;
const DELAY_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 关联条目里混有同系列 RPG / ACT / 手游，必须按类型与恋爱标签双重过滤
const GT_ALLOW = /ADV|AVG|アドベンチャー|ノベル|ビジュアルノベル|Visual Novel|视觉小说/i;
const GT_REJECT = /RPG|ACT|アクション|STG|MUG|FPS|TPS|FTG|SLG|SIM|TCG|RAC|SPG|パズル|PUZ|格闘|シューティング|レース|スポーツ|シミュレーション|育成|塔防|麻将|麻雀|カード|养成|卡牌|竞技|音游|リズム|ボードゲーム|放置|Roguelike|Deckbuilder|サバイバル|ホラー|恐怖|動作|动作|射击|格斗|策略|模拟|体育|竞速|法庭|大法廷|推理|裁判|バトル|対戦|对战|桌面伴侣|换装|開放世界|开放世界|Open World|着せ替え/i;
const GT_ROMANCE = /恋愛|恋爱|ギャル|エロゲ|BL|ボーイズラブ/i;

function isGalLike(item) {
  const gt = item.gt || '';
  const tg = item.tg || [];
  if (tg.includes('oto')) return false;
  if (!GT_ALLOW.test(gt) || GT_REJECT.test(gt)) return false;
  return tg.includes('rom') || tg.includes('bl') || GT_ROMANCE.test(gt);
}

// 固定并发池：Bangumi 镜像单请求约 2s，串行 500 条太慢
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next;
      next += 1;
      out[i] = await fn(items[i], i);
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------- 标题归一 ----------
function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[!-/:-@[-`{-~！-／：-＠［-｀｛-～・、。…‥「」『』【】《》（）〈〉〔〕~～〜]/g, '');
}
function addKeys(set, value) {
  const full = normalizeTitle(value);
  if (full) set.add(full);
  const head = normalizeTitle(String(value || '').split(/[~～〜:：\-—–]/)[0]);
  if (head && head.length >= 2) set.add(head);
}

// ---------- infobox 与平台 ----------
function infoValues(infobox, key) {
  const item = (infobox || []).find((x) => x && x.key === key);
  if (!item) return [];
  const raw = Array.isArray(item.value) ? item.value : [item.value];
  return raw
    .map((v) => (typeof v === 'string' ? v : (v && v.v) || ''))
    .map((v) => String(v).trim())
    .filter(Boolean);
}

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

const DEV_NOISE_HEAD = /^(株式会社|有限会社|合同会社|（株）|\(株\)|（有）|\(有\))\s*/;
const DEV_NOISE_TAIL = /\s*(co\.,?\s*ltd\.?|inc\.?|llc|ltd\.?|corporation|corp\.?|gmbh|株式会社|有限会社|合同会社)\s*$/i;

function normalizeDevName(raw) {
  let v = String(raw || '').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
  v = v.replace(DEV_NOISE_HEAD, '').replace(DEV_NOISE_TAIL, '').trim();
  v = v.replace(/^[·・,，、.\s]+|[·・,，、.\s]+$/g, '');
  return v && /[\p{L}\p{N}]/u.test(v) ? v : '';
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

const PLATFORM_MAP = new Map(Object.entries({
  pc: 'PC', windows: 'PC', win: 'PC', steam: 'PC', 'microsoft windows': 'PC',
  ps: 'PS', ps1: 'PS', playstation: 'PS', ps2: 'PS2', ps3: 'PS3', ps4: 'PS4', ps5: 'PS5',
  psp: 'PSP', psv: 'PSV', psvita: 'PSV', 'ps vita': 'PSV',
  switch: 'Switch', ns: 'Switch', 'nintendo switch': 'Switch',
  'switch 2': 'Switch 2', 'nintendo switch 2': 'Switch 2',
  nds: 'NDS', ds: 'NDS', 'nintendo ds': 'NDS',
  '3ds': '3DS', 'nintendo 3ds': '3DS', wii: 'Wii', wiiu: 'WiiU', 'wii u': 'WiiU',
  gc: 'GC', gamecube: 'GC', xbox: 'Xbox', xbox360: 'Xbox 360', 'xbox 360': 'Xbox 360',
  'xbox one': 'Xbox One', 'xbox series x/s': 'Xbox Series X/S', xsx: 'Xbox Series X/S',
  ios: 'iOS', iphone: 'iOS', ipad: 'iOS', android: 'Android', 安卓: 'Android',
  mac: 'macOS', macos: 'macOS', linux: 'Linux', web: 'Web', 浏览器: 'Web',
  dc: 'DC', ss: 'SS', 'sega saturn': 'SS', pce: 'PCE', 'pc engine': 'PCE',
  'pc-98': 'PC-98', pc98: 'PC-98',
}));
const JUNK_PLATFORM = new Set(['', 'all', '其他', '未知', '不详', '无', '未定', '待定', '-', '—', 'n/a', 'tba', '?']);

function normalizePlatform(raw) {
  let v = String(raw || '').replace(/[®™©]/g, '').replace(/[（(][^）)]*[）)]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!v) return '';
  const key = v.toLowerCase().trim();
  if (JUNK_PLATFORM.has(key) || /^\d+$/.test(key)) return '';
  if (PLATFORM_MAP.has(key)) return PLATFORM_MAP.get(key);
  if (/^(win|windows|window)\s*\d/.test(key)) return 'PC';
  if (/^ps\s*\d$/.test(key)) return 'PS' + key.slice(-1);
  return v;
}

function platformsFromPieces(pieces) {
  const out = [];
  (pieces || []).forEach((piece) => {
    const name = normalizePlatform(piece);
    if (name && out.indexOf(name) < 0) out.push(name);
  });
  return out;
}

function platformPieces(infobox) {
  const out = [];
  infoValues(infobox, '平台').forEach((raw) => {
    String(raw).split(/[|、/／,，&＆+＋]|及|和/).forEach((piece) => {
      const v = piece.trim();
      if (v && out.indexOf(v) < 0) out.push(v);
    });
  });
  return out;
}

function joinValues(values) {
  return splitValues(values, /[、，,/／]/).join('、');
}

// ---------- 网络 ----------
async function getJson(pathname) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(BASE + pathname, {
        headers: { Accept: 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(30000),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 4) throw err;
      const wait = attempt * 2000;
      console.warn(`    重试 ${attempt}/3：${err.message}，${wait}ms 后继续`);
      await sleep(wait);
    }
  }
  return null;
}

function slim(item) {
  const infobox = item.infobox || [];
  const pieces = platformPieces(infobox);
  const tagNames = rawTagNames(item.meta_tags, item.tags);
  const cn = item.name_cn || infoValues(infobox, '中文名')[0] || '';
  const out = {
    i: item.id,
    n: item.name || '',
    cn,
    d: item.date || '',
    s: item.rating?.score || 0,
    rk: item.rating?.rank || 0,
    h: item.collection?.collect || 0,
    img: item.images?.common || item.images?.large || '',
    py: initials(cn || item.name || ''),
    tg: genreIdsFromNames(tagNames),
    pl: platformsFromPieces(pieces),
    dev: normalizeDevList(splitValues(infoValues(infobox, '开发'))),
    pub: joinValues(infoValues(infobox, '发行')),
    sc: joinValues(infoValues(infobox, '剧本')),
    ar: joinValues(infoValues(infobox, '原画')),
    mu: joinValues(infoValues(infobox, '音乐')),
    gt: joinValues(infoValues(infobox, '游戏类型')),
    ns: Boolean(item.nsfw),
    bg: 1,
  };
  if (!out.tg.length) delete out.tg;
  if (!out.pl.length) delete out.pl;
  if (!out.dev.length) delete out.dev;
  return out;
}

async function main() {
  let otomeBgm = new Set();
  try {
    const block = JSON.parse(await readFile(OTOME_FILE, 'utf8'));
    otomeBgm = new Set((block.bgm || []).map((x) => String(x.i)));
  } catch { /* 黑名单可选 */ }
  const raw = await readFile(path.join(ROOT, 'data', 'galgames.js'), 'utf8');
  const m = raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*?\]);/);
  if (!m) throw new Error('未找到 window.GL_DATA');
  const main = JSON.parse(m[1]);

  const mainIds = new Set(main.map((x) => String(x.i)));
  const titleKeys = new Set();
  main.forEach((x) => { addKeys(titleKeys, x.cn); addKeys(titleKeys, x.n); });

  const seeds = main
    .filter((x) => x.cn || x.n)
    .sort((a, b) => (b.h || 0) - (a.h || 0))
    .slice(0, SEEDS);
  console.log(`种子 ${seeds.length} 条，开始读取关联条目`);

  const candidates = new Map();
  let seedDone = 0;
  await mapLimit(seeds, CONCURRENCY, async (seed) => {
    const list = await getJson(`/v0/subjects/${seed.i}/subjects`);
    if (Array.isArray(list)) {
      list.forEach((r) => {
        if (!r || Number(r.type) !== 4) return;
        const id = String(r.id);
        if (mainIds.has(id)) return;
        const cur = candidates.get(id) || { id: Number(r.id), count: 0, name: r.name || '' };
        cur.count += 1;
        candidates.set(id, cur);
      });
    }
    seedDone += 1;
    if (seedDone % 50 === 0 || seedDone === seeds.length) {
      console.log(`  关联种子 ${seedDone}/${seeds.length}，候选 ${candidates.size}`);
    }
  });

  const ordered = [...candidates.values()].sort((a, b) => b.count - a.count).slice(0, LIMIT);
  console.log(`关联候选 ${candidates.size} 个，取前 ${ordered.length} 个补齐详情`);

  const list = [];
  let skippedDup = 0;
  let skippedInvalid = 0;
  let failed = 0;
  let done = 0;
  await mapLimit(ordered, CONCURRENCY, async (c) => {
    done += 1;
    try {
      const full = await getJson(`/v0/subjects/${c.id}`);
      if (!full || Number(full.type) !== 4) {
        skippedInvalid += 1;
      } else {
        const item = slim(full);
        // 评分可以缺失（显示「暂无」）；日期 / 封面 / 平台 / 开发商齐全，且必须像 galgame
        if (!item.d || !item.img || !item.dev || !item.pl ||
            otomeBgm.has(String(item.i)) || (item.tg || []).includes('oto') || !isGalLike(item)) {
          skippedInvalid += 1;
        } else {
          const keys = new Set();
          addKeys(keys, item.n);
          addKeys(keys, item.cn);
          let dup = false;
          keys.forEach((k) => { if (titleKeys.has(k)) dup = true; });
          if (dup) {
            skippedDup += 1;
          } else {
            list.push(item);
            keys.forEach((k) => titleKeys.add(k));
          }
        }
      }
    } catch (err) {
      failed += 1;
      console.warn(`  [${c.id}] ${c.name} 失败：${err.message}`);
    }
    if (done % 50 === 0) {
      console.log(`  详情 ${done}/${ordered.length}，已收 ${list.length}，重名 ${skippedDup}，无效 ${skippedInvalid}，失败 ${failed}`);
    }
  });

  list.sort((a, b) => (b.h || 0) - (a.h || 0));
  const meta = {
    generatedAt: new Date().toISOString(),
    source: 'bangumi-related',
    seeds: seeds.length,
    candidates: candidates.size,
    count: list.length,
    skippedDup,
    skippedInvalid,
    failed,
  };
  const content = '// 由 scripts/fetch-bgm-related.mjs 生成，请勿手动修改\n' +
    'window.GL_BGM_EXTRA = ' + JSON.stringify({ meta, list }) + ';\n';
  await writeFile(OUT_FILE, content, 'utf8');
  console.log(`完成：关联扩展 ${list.length} 条（候选 ${candidates.size}，重名 ${skippedDup}，无效 ${skippedInvalid}，失败 ${failed}）`);
  console.log(`输出：${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
