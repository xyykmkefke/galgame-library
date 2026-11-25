// 补全成果快照：把 enrich 类脚本补出来的字段从主库抽出来，凹成独立文件。
//
// 为什么需要这个文件：
//   galgames.js 既是 fetch-games.mjs 的抓取产物，又是各种 enrich 脚本的补全载体。
//   而 fetch-games.mjs 每次都整份重写 galgames.js —— 补全成果必然被覆盖。
//   实测 v2.31.0 一次重建丢了：别名 877 条（全没）、音乐 305 条、原画 224 条、
//   剧本 187 条、开发商 247 条、题材 355 条。
//
// 解法：补全成果落盘到 data/enrich-main.json（按 id 索引），
//   fetch-games.mjs 重建时先读回来叠加，补全成果就不会随重建蒸发。
//
// 用法：
//   node scripts/snapshot-enrich.mjs          # 预演，报告将快照多少条
//   node scripts/snapshot-enrich.mjs --apply  # 写入 data/enrich-main.json
//
// 注意：快照只存「能从外部数据源补出来」的字段，不存抓取本身就有的字段
//   （评分、封面、热度等），避免把旧值钉死、让上游更新失效。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { suppressRelationalGenres } from './genres.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const OUT = path.join(ROOT, 'data', 'enrich-main.json');
const APPLY = process.argv.includes('--apply');

// 这四类字段由 enrich 脚本补充，且无法从 bangumi 抓取桶里重新得到：
//   al  别名        ← enrich-main-bangumi / fetch-ymgal（extensionName）
//   dev 开发商      ← enrich-main-bangumi / fill-main-devs
//   sc/ar/mu 制作人员 ← enrich-main-bangumi / enrich-main-staff
//
// tg 题材也在快照里，但要区别对待：fetch-games.mjs 已经内置三级回退，
// 大部分题材能自己算出来。只有少数条目（早期标签被上游改掉、旧版映射残留）
// 算不出来，快照只在这些条目的 tg 为空时兜底，有值的以本次计算结果为准。
const ENRICHED = ['al', 'dev', 'sc', 'ar', 'mu', 'tg'];

const raw = await readFile(MAIN, 'utf8');
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);

const out = {};
let filled = 0;
let tgFixed = 0;
for (const x of all) {
  // 隐藏条目也快照：k="off" 只是默认不显示，条目本身还在，字段丢了会让详情页变空
  const rec = {};
  for (const f of ENRICHED) {
    let v = x[f];
    if (!v) continue;
    if (Array.isArray(v) && !v.length) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    // 快照会长期存活，落盘前先过一遍关系标签抑制：
    // 否则旧数据里「RPG 被标成百合」这类误标会被快照永久固化，每次重建又搬回来。
    if (f === 'tg' && Array.isArray(v)) {
      const before = v.length;
      v = suppressRelationalGenres(v, x.gt || '', x.cn || x.n || '');
      if (v.length !== before) tgFixed += 1;
      if (!v.length) continue;
    }
    rec[f] = v;
  }
  if (!Object.keys(rec).length) continue;
  out[String(x.i)] = rec;
  filled += 1;
}

const stat = {};
for (const f of ENRICHED) {
  stat[f] = Object.values(out).filter((r) => r[f] !== undefined).length;
}

console.log(`主库 ${all.length} 条，其中 ${filled} 条有可快照的补全字段`);
console.log('字段覆盖：' + ENRICHED.map((f) => `${f} ${stat[f]}`).join(' · '));

if (!APPLY) {
  console.log('\n预演完成，未写入。确认后运行：node scripts/snapshot-enrich.mjs --apply');
  process.exit(0);
}

const payload = {
  updatedAt: new Date().toISOString().slice(0, 10),
  note: '主库补全成果快照。由 snapshot-enrich.mjs 生成，fetch-games.mjs 重建时按 id 叠加，防止 enrich 成果被覆盖。',
  fields: ENRICHED,
  items: out,
};
await writeFile(OUT, JSON.stringify(payload), 'utf8');
console.log(`\n已写入 ${OUT}（${Object.keys(out).length} 条）`);
