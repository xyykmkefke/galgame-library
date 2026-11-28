// 为 galgame 数据补充/刷新拼音首字母字段 py，便于按首字母搜索。
// 用法：node scripts/build-pinyin.mjs
//
// 三份数据都要补：
//   data/galgames.js      主库 1968 条（一直有做）
//   data/vndb-extra.js    扩展库 5737 条（此前漏做，955 条中文名搜不到拼音）
//   data/recent-extra.js  新作索引 1329 条（此前漏做，79 条中文名搜不到拼音）
// 漏做的后果不是「少个字段」，而是自相矛盾：同一部作品在主库能搜「gxshdm」，
// 在扩展库搜不到，用户只会以为搜索坏了。
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinyin } from 'pinyin-pro';

const ROOT = path.resolve(import.meta.dirname, '..');
const FULL_FILE = path.join(ROOT, 'data', 'galgames.js');
const EXTRA_FILE = path.join(ROOT, 'data', 'vndb-extra.js');
const RECENT_FILE = path.join(ROOT, 'data', 'recent-extra.js');

// 标题里出现假名时，只把汉字拿去转拼音会得到极短的碎片：
//   「サクラノ刻」→ k、「グリザイアの楽園」→ ly、「オブジェクト・ハッピーエンディング」→ 空
// 这些 1–2 字符的值会被任意短查询命中，等于给搜索加噪音。
// 判据：含假名就返回空串（宁可不生成，也不生成错的）。
//
// 注意别顺手把「纯拉丁也返回空」写进来——试过，会废掉 179 条：
// `Fate/EXTRA Record` 的 py 是 `fateextrarecord`，这里 py 同时兼作
// 「去掉空格与标点的搜索键」，清空后 `fateextrarecord` 就搜不到了。
// 所以拉丁标题原样保留字母数字，只有假名才拦。
const KANA = /[\u3040-\u30ff]/;

export function initials(text) {
  if (!text) return '';
  const s = String(text);
  if (KANA.test(s)) return '';        // 日文标题：假名没有拼音，硬转只会得到碎片
  return pinyin(s, { pattern: 'first', toneType: 'none', type: 'array' })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// 从 `window.XXX = {...};` 里取出 JSON 与那个赋值表达式的前后缀，便于原样写回。
function splitFile(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error(`找不到 ${marker}`);
  const open = src.indexOf('{', start);
  // 从末尾往前找最后一个 `};`，避免标题里含 `}` 时切错
  const end = src.lastIndexOf('}');
  if (open < 0 || end < open) throw new Error(`无法解析 ${marker}`);
  return {
    head: src.slice(0, open),
    data: JSON.parse(src.slice(open, end + 1)),
    tail: src.slice(end + 1),
  };
}

async function writeArrFile(file, marker, head, list, tail, meta) {
  const content = head + JSON.stringify(list) + tail;
  await writeFile(file, content, 'utf8');
  return content.length;
}

// 主库：GL_META + GL_DATA 两个赋值，GL_DATA 是数组
export async function addPinyinMain() {
  const src = await readFile(FULL_FILE, 'utf8');
  const metaMatch = src.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/);
  const open = src.indexOf('[', src.indexOf('window.GL_DATA'));
  const close = src.lastIndexOf(']');
  if (!metaMatch || open < 0 || close < 0) throw new Error('无法解析 data/galgames.js');
  const meta = JSON.parse(metaMatch[1]);
  const all = JSON.parse(src.slice(open, close + 1));
  let changed = 0;
  all.forEach((x) => {
    const py = initials(x.cn || x.n);
    if (x.py !== py) { x.py = py; changed += 1; }
  });
  // 没有实际变化就不写盘：此前每次都会重置 meta.generatedAt，
  // 让「跑一遍拼音」看起来像数据更新，逼着升 SW、污染 diff。
  if (!changed) return { total: all.length, changed };
  meta.generatedAt = new Date().toISOString();
  const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
    `window.GL_META = ${JSON.stringify(meta)};\n` +
    `window.GL_DATA = ${JSON.stringify(all)};\n`;
  await writeFile(FULL_FILE, content, 'utf8');
  return { total: all.length, changed };
}

// 扩展库与新作：结构都是 { meta, list }（新作多一个 v 字段）。就地补 py，不动其它字段。
async function addPinyinListFile(file, marker) {
  const src = await readFile(file, 'utf8');
  const { head, data, tail } = splitFile(src, marker);
  const list = data.list;
  if (!Array.isArray(list)) throw new Error(`${marker} 缺少 list 数组`);
  let changed = 0;
  let withCn = 0;
  list.forEach((x) => {
    const py = initials(x.cn || x.n);
    if (py) withCn += 1;
    if (x.py !== py) { x.py = py; changed += 1; }
  });
  // 只有真的变了才写盘，避免无意义地改动生成物时间戳
  if (changed) await writeFile(file, head + JSON.stringify(data) + tail, 'utf8');
  return { total: list.length, changed, withCn };
}

export async function addPinyin() {
  const main = await addPinyinMain();
  const extra = await addPinyinListFile(EXTRA_FILE, 'window.GL_VNDB_EXTRA');
  const recent = await addPinyinListFile(RECENT_FILE, 'window.GL_RECENT');
  return { main, extra, recent };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const r = await addPinyin();
  console.log(`主库：${r.main.total} 条（更新 ${r.main.changed}）`);
  console.log(`扩展库：${r.extra.total} 条（更新 ${r.extra.changed}，可拼音 ${r.extra.withCn} 条）`);
  console.log(`新作：${r.recent.total} 条（更新 ${r.recent.changed}，可拼音 ${r.recent.withCn} 条）`);
}
