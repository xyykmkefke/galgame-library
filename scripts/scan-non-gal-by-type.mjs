// 按「游戏类型含硬核玩法 且 无 galgame 相关标签」筛出主库误收条目，输出候选清单供人工核对。
//
// 背景：文档 47.4 记录的「30 条疑似非 gal」一直未处理。逐条核对后发现判断依据不足，
// 改用可验证的组合条件：Bangumi 游戏类型明确是 RPG / SRPG / ACT / 育成 / 卡牌等可玩性主导的类型，
// **且** Bangumi 用户没有给它打任何 galgame 相关标签 —— 两个条件同时成立才判为非 gal。
//
// 为什么不看「类型不含 ADV 就排除」：实测会命中 637 条（32.9% 全库），其中 354 条带 galgame 标签，
// 大量 AVG+RPG 混合类型的真 galgame 会被误杀。
//
// 为什么必须在构建期做：主库不保留 Bangumi 原始标签（rt 属缓存字段，check-data 会报泄漏），
// 所以判定只能在有 data/build 缓存时完成，结论固化进 data/blocklist-main.json。
//
// 用法：
//   node scripts/scan-non-gal-by-type.mjs              # 输出清单 + 抽样，不写库
//   node scripts/scan-non-gal-by-type.mjs --json       # 只输出 JSON 清单
//   node scripts/scan-non-gal-by-type.mjs --write      # 合并进 data/blocklist-main.json（不标记 k=off）
//
// 标记 k="off" 仍由 mark-non-gal.mjs 负责，两步分开便于回滚。

import { readFile, writeFile } from 'node:fs/promises';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'data', 'galgames.js');
const BUILD = path.join(ROOT, 'data', 'build');
const BLOCK = path.join(ROOT, 'data', 'blocklist-main.json');
const JSON_ONLY = process.argv.includes('--json');
const WRITE = process.argv.includes('--write');

// Bangumi 上被广泛用于标记 galgame 的标签；命中任一即视为「用户认为是 gal」，不排除
const GAL_TAGS = new Set([
  'galgame', 'gal', '视觉小说', '視覚小説', 'vn', 'avg', 'adv',
  '黄油', 'eroge', '美少女游戏', 'ビジュアルノベル',
]);

// 可玩性主导的游戏类型：这些类型说明作品核心不是文字阅读。
//
// 注意：这里**故意不收 SLG / SIM / 模拟**，与 genres.mjs 的 HARD_TYPE 不同口径。
//   - genres.mjs 用 HARD_TYPE 决定「要不要采信百合/耽美标签」，宁可严一点；
//   - 本脚本用 HARD_TYPE 决定「整个条目是不是非 gal、要不要隐藏」，必须保守。
// 恋爱模拟、养成模拟、经营策略类里有大量真 galgame（心跳回忆、美少女梦工厂），
// 把 SLG/SIM 加进来会成批误杀。两处用途不同，不要图省事合并。
const HARD_TYPE = /(?:SRPG|RPG|ACT|FTG|TPS|FPS|育成|パズル|カード|アクション|シューティング|シミュレーション|音ゲー|リズム|ストラテジー|タワーディフェンス)/i;

// 只要类型里出现这些词，说明文字阅读仍是核心玩法之一（如「AVG、RPG」「视觉小说RPG」），
// 即使同时命中 HARD_TYPE 也不能判为非 gal —— 实测这类混合类型绝大多数是真 galgame
const NARRATIVE_TYPE = /(?:AVG|ADV|アドベンチャー|ノベル|ビジュアルノベル|视觉小说|視覚小説)/i;

// 规则兜不住、但人工核对确认应排除的条目（补充名单）。
// 只收「类型词表覆盖不到」或「标签与类型冲突但类型证据更强」的情况，逐条注明依据。
const MANUAL = [
  {
    i: 544941,
    title: '弹丸论破Remembrance：绝望的记忆与希望的纪念',
    reason: '类型「同人游戏、悬疑、推理」不含任何文字冒险指示，属推理同人游戏；系列正传玩法为高速推理动作',
  },
  {
    i: 99290,
    title: '偶像大师： 全力以赴',
    reason: '类型「アイドル育成ゲーム」为偶像养成，核心为养成与音游，非文字阅读；AVG 标签系用户误挂',
  },
];

function loadBuildTags() {
  const map = new Map();
  for (const file of readdirSync(BUILD)) {
    if (!file.endsWith('.json')) continue;
    let arr;
    try {
      arr = JSON.parse(readFileSync(path.join(BUILD, file), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(arr)) continue;
    for (const x of arr) {
      if (!x || x.i == null) continue;
      const prev = map.get(String(x.i)) || {};
      map.set(String(x.i), {
        rt: Array.isArray(x.rt) ? x.rt.map((t) => String(t).trim().toLowerCase()) : prev.rt || [],
        gt: x.gt || prev.gt || '',
      });
    }
  }
  return map;
}

const raw = await readFile(MAIN, 'utf8');
const all = JSON.parse(raw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const visible = all.filter((x) => x.k !== 'off');

const tags = loadBuildTags();
const candidates = [];
const noBuild = [];

for (const x of visible) {
  const info = tags.get(String(x.i));
  const gt = String((info && info.gt) || x.gt || '');
  const manual = MANUAL.find((m) => Number(m.i) === Number(x.i));
  if (manual) {
    candidates.push({
      i: x.i,
      title: x.cn || x.n || '',
      gt,
      tags: (info && info.rt ? info.rt : []).slice(0, 8),
      group: 'manual',
      reason: manual.reason,
    });
    continue;
  }
  if (!HARD_TYPE.test(gt)) continue;
  // 混合类型（同时含 AVG/ADV/视觉小说）保留：文字阅读仍是核心，不判非 gal
  if (NARRATIVE_TYPE.test(gt)) continue;
  if (!info) { noBuild.push(x); continue; }
  const hasGal = (info.rt || []).some((t) => GAL_TAGS.has(t));
  if (hasGal) continue;
  candidates.push({
    i: x.i,
    title: x.cn || x.n || '',
    gt,
    tags: (info.rt || []).slice(0, 8),
    group: '',
    reason: `类型「${gt}」且无 galgame 标签`,
  });
}

candidates.sort((a, b) => String(a.gt).localeCompare(String(b.gt)) || a.i - b.i);

if (JSON_ONLY) {
  console.log(JSON.stringify({ count: candidates.length, noBuildCount: noBuild.length, items: candidates }, null, 2));
  process.exit(0);
}

console.log(`可见条目 ${visible.length} 条`);
console.log(`按类型初筛命中且无 galgame 标签：${candidates.length} 条`);
if (noBuild.length) console.log(`缺少 build 缓存无法判定：${noBuild.length} 条（未纳入）`);

const byGt = {};
candidates.forEach((c) => { byGt[c.gt] = (byGt[c.gt] || 0) + 1; });
console.log('\n按游戏类型分布：');
Object.entries(byGt).sort((a, b) => b[1] - a[1])
  .forEach(([g, n]) => console.log(`  ${n.toString().padStart(3)} × ${g}`));

console.log('\n抽样 30 条：');
candidates.slice(0, 30).forEach((c) => {
  console.log(`  [${c.i}] ${c.title.slice(0, 30).padEnd(32)} | ${c.gt}`);
});

if (WRITE) {
  const block = JSON.parse(await readFile(BLOCK, 'utf8'));
  const exist = new Set((block.items || []).map((x) => Number(x.i)));
  let added = 0;
  for (const c of candidates) {
    if (exist.has(Number(c.i))) continue;
    block.items.push({
      i: c.i,
      title: c.title,
      group: c.group,
      reason: c.reason,
    });
    added += 1;
  }
  block.updatedAt = new Date().toISOString().slice(0, 10);
  block.note = '非 gal 主库黑名单：手工核对（逆转裁判 / FF / GTA 等）+ 按类型规则筛出（无 galgame 标签的可玩性主导作品）。';
  await writeFile(BLOCK, JSON.stringify(block, null, 2) + '\n', 'utf8');
  console.log(`\n已写入黑名单：新增 ${added} 条，现有 ${block.items.length} 条`);
  console.log('下一步：node scripts/mark-non-gal.mjs --apply 才会真正标记 k="off"');
} else {
  console.log('\n当前为预演模式，未写文件。确认清单无误后加 --write 合并进黑名单。');
}
