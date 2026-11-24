// 主库题材离线补齐：用 data/build 里保留的 Bangumi 原始标签（rt）与游戏类型（gt），
// 只给「完全没有题材」的条目补高置信题材。默认 dry-run，加 --apply 写回。
//
// 规则：
//   - 只处理 galgame 类条目（rt 含 galgame/视觉小说/黄油/gal，或 gt 含 AVG/ADV/VN 且不含 RPG/SLG/ACT 等）
//   - 标签必须精确命中题材词，不做子串匹配（避免 blazblue 命中 bl）
//   - gt 只认强题材词（恋爱/校园/悬疑/恐怖/拔作等），不把 ADV/AVG/视觉小说当题材
//
// 用法：
//   node scripts/enrich-main-genres-keywords.mjs
//   node scripts/enrich-main-genres-keywords.mjs --apply

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { GENRES } from './genres.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const BUILD = path.join(ROOT, 'data', 'build');
const APPLY = process.argv.includes('--apply');

const TAG_RULES = {
  rom: ['恋爱', '恋愛', '纯爱', '純愛', '爱情', '愛情'],
  sch: ['校园', '学園', '学园'],
  sli: ['日常', '青春'],
  mys: ['悬疑', '懸疑', '神秘'],
  det: ['推理', '侦探', '探偵'],
  nak: ['泣系', '泣きゲー', '催泪', '感動', '感动', '治愈', '治癒'],
  dep: ['郁系', '致郁', '鬱'],
  hor: ['恐怖', '惊悚', 'ホラー'],
  gru: ['猎奇', 'グロ'],
  bat: ['战斗', 'バトル'],
  adv: ['冒险', '探索', '解谜', 'アドベンチャー'],
  yur: ['百合', 'gl', 'yuri'],
  bl: ['耽美', 'bl', 'boys love', 'yaoi'],
  har: ['后宫', 'ハーレム'],
  jk: ['女装', '伪娘', '男の娘'],
  mec: ['机战', '机器人', 'ロボット'],
  sci: ['科幻', 'sf', 'science fiction'],
  fan: ['奇幻', '魔法', '幻想', 'ファンタジー'],
  nukige: ['拔作', '抜きゲー', 'nukige'],
};
const GT_RULES = {
  rom: ['恋爱', '恋愛', '纯爱', '純愛', '爱情', '愛情'],
  sch: ['校园', '学園', '学园'],
  sli: ['日常', '青春'],
  mys: ['悬疑', '懸疑'],
  det: ['推理', '侦探', '探偵'],
  nak: ['泣', '催泪', '感動', '治愈'],
  dep: ['致郁', '鬱'],
  hor: ['恐怖', 'ホラー'],
  gru: ['猎奇', 'グロ'],
  bat: ['战斗', 'バトル'],
  adv: ['冒险', '探索', '解谜'],
  yur: ['百合'],
  bl: ['耽美', 'boys love'],
  har: ['后宫', 'ハーレム'],
  jk: ['女装', '伪娘'],
  mec: ['机战', '机器人'],
  sci: ['科幻'],
  fan: ['奇幻', '魔法', '幻想'],
  nukige: ['拔作', '抜きゲー'],
};

const GALISH_TAGS = new Set(['galgame', 'gal', '视觉小说', '視覚小説', 'vn', 'avg', 'adv', '黄油', 'eroge', '美少女游戏']);
const NONGAL_TAGS = new Set(['rpg', 'jrpg', 'slg', 'act', 'ftg', 'tps', 'fps', '音游', '音乐游戏', '手游']);
const NONGAL_GT = /(?:rpg|slg|ftg|音ゲー|リズム|アクション|シューティング)/;

function loadBuckets() {
  const rt = new Map();
  const gt = new Map();
  for (const file of readdirSync(BUILD)) {
    if (!file.endsWith('.json')) continue;
    let arr;
    try { arr = JSON.parse(readFileSync(path.join(BUILD, file), 'utf8')); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || x.i == null) continue;
      if (Array.isArray(x.rt)) rt.set(x.i, x.rt);
      if (x.gt) gt.set(x.i, x.gt);
    }
  }
  return { rt, gt };
}

const { rt, gt } = loadBuckets();
const raw = await readFile(MAIN, 'utf8');
const meta = JSON.parse(raw.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/)[1]);
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const order = GENRES.map((g) => g.id);

const visible = all.filter((x) => x.k !== 'off');
const missing = visible.filter((x) => !x.tg || !x.tg.length);
const hits = {};
const changes = [];

for (const x of missing) {
  const names = (rt.get(x.i) || []).map((s) => String(s).trim().toLowerCase());
  const g = String(gt.get(x.i) || '').toLowerCase();
  const isGal = names.some((n) => GALISH_TAGS.has(n));
  const nonGal = names.some((n) => NONGAL_TAGS.has(n)) || NONGAL_GT.test(g);
  const galish = isGal || (!nonGal && /(?:avg|adv|vn|ノベル|视觉小说)/.test(g));
  if (!galish) continue;
  const ids = new Set();
  for (const [id, tags] of Object.entries(TAG_RULES)) {
    if (!order.includes(id)) continue;
    if (names.some((n) => tags.includes(n))) ids.add(id);
  }
  for (const [id, words] of Object.entries(GT_RULES)) {
    if (!order.includes(id)) continue;
    if (words.some((w) => g.includes(w))) ids.add(id);
  }
  if (!ids.size) continue;
  const tg = order.filter((id) => ids.has(id));
  changes.push({ id: x.i, name: x.cn || x.n, tg });
  tg.forEach((id) => { hits[id] = (hits[id] || 0) + 1; });
}

console.log(`无题材条目：${missing.length} 条`);
console.log(`可补：${changes.length} 条（${(changes.length / missing.length * 100).toFixed(1)}%）`);
console.log('题材分布：' + Object.entries(hits).sort((a, b) => b[1] - a[1])
  .map(([id, n]) => {
    const g = GENRES.find((x) => x.id === id);
    return `${g ? g.label : id} ${n}`;
  }).join(' · '));
console.log('\n抽样：');
changes.slice(0, 15).forEach((c) => console.log(`  [${c.id}] ${c.name} -> ${c.tg.join(',')}`));

if (!APPLY) {
  console.log('\n预演完成，未写数据。确认后运行：node scripts/enrich-main-genres-keywords.mjs --apply');
  process.exit(0);
}

changes.forEach((c) => {
  const x = all.find((y) => y.i === c.id);
  if (x && (!x.tg || !x.tg.length)) x.tg = c.tg;
});
meta.keywordGenreFilled = { at: new Date().toISOString(), count: changes.length };
const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(meta)};\n` +
  `window.GL_DATA = ${JSON.stringify(all)};\n`;
await writeFile(MAIN, content, 'utf8');
console.log(`\n已写回：${changes.length} 条`);
