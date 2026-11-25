// 主库题材补全：三级回退，专治「重建后题材覆盖暴跌」。
//
// 背景：题材有三个来源，历史上分散在三个独立脚本里 ——
//   1. fetch-games.mjs 自己的 genreIdsFromNames（Bangumi 标签精确映射）
//   2. enrich-main-genres-keywords.mjs（从「游戏类型」自由文本里抽题材）
//   3. enrich-main-genres.mjs（VNDB 标签映射）
// 而 fetch-games.mjs 会整份重写 galgames.js，第 2、3 步的成果必然被覆盖。
// 实测 v2.31.0 重抓后题材覆盖从 75.0% 掉到 57.2%，355 条真 galgame 丢了题材。
//
// 修法：把三级回退收进本模块，由 fetch-games.mjs 在写库前统一执行，
// 重建一次就得到完整结果，不再依赖「记得手动跑 enrich 脚本」。
//
// 优先级（先准后糙，命中即停）：
//   L1  Bangumi 标签精确命中题材词          —— 最可信，用户亲自打的题材标签
//   L2  游戏类型 / 标签关键词                —— 次可信，「恋愛アドベンチャー」这类日文类型名
//   L3  VNDB 标签（含票数 / 剧透过滤）       —— 兜底，官方结构化标签
// 只有 tg 为空的条目才会补；已有题材一律不动，避免覆盖上游更准的结果。

import { GENRES, suppressRelationalGenres } from './genres.mjs';
import { mapVndbGenres } from './vndb-genre-map.mjs';

const ORDER = GENRES.map((g) => g.id);

// 标签精确匹配（不做子串，避免 blazblue 命中 bl）
const TAG_RULES = {
  rom: ['恋爱', '恋愛', '纯爱', '純愛', '爱情', '愛情', '恋爱喜剧', 'ラブコメ'],
  sch: ['校园', '学園', '学园', '学校', '学生会'],
  sli: ['日常', '青春', '生活', '空气系'],
  mys: ['悬疑', '懸疑', '神秘', '犯罪', 'サスペンス'],
  det: ['推理', '侦探', '探偵', '本格', 'ミステリー'],
  nak: ['泣系', '泣きゲー', '催泪', '感動', '感动', '治愈', '治癒', '泣き'],
  dep: ['郁系', '致郁', '鬱', '黑暗', '病态', 'ダーク'],
  hor: ['恐怖', '惊悚', '灵异', 'ホラー'],
  gru: ['猎奇', '电波', 'グロ', 'グロテスク'],
  bat: ['战斗', '热血', 'バトル'],
  adv: ['冒险', '探索', '解谜', 'アドベンチャー'],
  yur: ['百合', 'gl', 'yuri', '女子恋爱', '百合ゲー'],
  bl: ['耽美', 'bl', 'boys love', 'yaoi', '蔷薇', 'ボーイズラブ'],
  har: ['后宫', 'ハーレム'],
  jk: ['女装', '伪娘', '男の娘', 'おとこのこ'],
  mec: ['机战', '机器人', '机甲', 'ロボット'],
  sci: ['科幻', 'sf', 'science fiction', '科学幻想', '赛博朋克', 'サイエンス'],
  fan: ['奇幻', '魔法', '幻想', '剑与魔法', 'ファンタジー'],
  nukige: ['拔作', '抜きゲー', 'nukige', 'ヌキゲー'],
};

// 游戏类型（gt）是自由文本，只能子串匹配。
// 刻意不收 'ADV' / 'AVG' / 'VN' / '视觉小说' —— 这些说明的是载体形式，不是题材，
// 把它们当题材会让「日常」「恋爱」这类真实内容信息被形式标签淹没。
const GT_RULES = {
  rom: ['恋爱', '恋愛', '纯爱', '純愛', '爱情', '愛情', 'ラブコメ', 'らぶこめ'],
  sch: ['校园', '学園', '学园'],
  sli: ['日常', '青春'],
  mys: ['悬疑', '懸疑', 'サスペンス'],
  det: ['推理', '侦探', '探偵', 'ミステリー', 'ミステリ'],
  nak: ['泣', '催泪', '感動', '治愈', '治癒'],
  dep: ['致郁', '鬱', 'ダーク', '病态'],
  hor: ['恐怖', 'ホラー', '惊悚'],
  gru: ['猎奇', 'グロ'],
  bat: ['战斗', 'バトル', '热血'],
  adv: ['冒险', '探索', '解谜', 'アドベンチャー'],
  yur: ['百合', 'yuri', 'ガールズラブ'],
  bl: ['耽美', 'boys love', 'ボーイズラブ', 'yaoi'],
  har: ['后宫', 'ハーレム'],
  jk: ['女装', '伪娘', '男の娘'],
  mec: ['机战', '机器人', 'ロボット'],
  sci: ['科幻', 'サイエンス'],
  fan: ['奇幻', '魔法', '幻想', 'ファンタジー'],
  nukige: ['拔作', '抜きゲー', 'nukige'],
};

const norm = (v) => String(v || '').trim().toLowerCase();

function fromTagNames(names = []) {
  const lower = names.map(norm);
  const hit = new Set();
  for (const [id, words] of Object.entries(TAG_RULES)) {
    // 精确匹配：标签就是题材词本身，或题材词作为独立片段出现
    if (lower.some((n) => words.includes(n))) hit.add(id);
  }
  return [...hit];
}

function fromGameType(gt = '', names = []) {
  const g = norm(gt);
  const lower = names.map(norm);
  const hit = new Set();
  if (g) {
    for (const [id, words] of Object.entries(GT_RULES)) {
      if (words.some((w) => g.includes(norm(w)))) hit.add(id);
    }
  }
  // gt 没写清楚时，退一步看标签里有没有题材词的宽松形态
  for (const [id, words] of Object.entries(TAG_RULES)) {
    if (words.some((w) => lower.includes(norm(w)))) hit.add(id);
  }
  return [...hit];
}

/**
 * 给「完全没有题材」的条目补题材，返回按 GENRES 声明顺序排好的 id 数组。
 * 非 galgame 条目（RPG / ACT 等可玩性主导且无文字冒险指示）不补，避免误标。
 *
 * @param {object} p
 * @param {string[]} p.tagNames  Bangumi 原始标签
 * @param {string}   p.gameType  游戏类型（infobox「游戏类型」）
 * @param {Array}    [p.vndbTags] VNDB 标签（{name, rating, spoiler}）
 * @returns {string[]}
 */
export function fillGenres({ tagNames = [], gameType = '', vndbTags = [], title = '' } = {}) {
  const names = (Array.isArray(tagNames) ? tagNames : []).map((t) => (
    typeof t === 'string' ? t : String((t && (t.name || t.n)) || '')
  )).filter(Boolean);

  const gt = String(gameType || '');
  // 非 gal 门槛：与 blocklist 的「规则 2」同口径 —— 必须**同时**满足
  // 「类型是可玩性主导」且「标签里没有任何 gal 指示」才拦。
  // 只看类型会误伤带 galgame 标签的 SLG/RPG（如「温泉ホラーSLG」确实收了，题材是恐怖）。
  // 与 genres.mjs 的 HARD_TYPE 保持同一份词表，别让三处规则漂移
  const HARD = /(?:SRPG|RPG|SLG|SIM|FTG|TPS|FPS|ACT|育成|パズル|カード|アクション|シューティング|シミュレーション|音ゲー|リズム|ストラテジー|タワーディフェンス|模拟|模擬)/i;
  const NARRATIVE = /(?:AVG|ADV|アドベンチャー|ノベル|ビジュアルノベル|视觉小说|視覚小説|VN)/i;
  const GAL_TAG = /^(?:galgame|gal|视觉小说|視覚小説|vn|avg|adv|黄油|eroge|美少女游戏)$/i;
  const hasGalTag = names.some((n) => GAL_TAG.test(norm(n)));
  if (gt && HARD.test(gt) && !NARRATIVE.test(gt) && !hasGalTag) return [];

  let ids = fromTagNames(names);
  if (!ids.length) ids = fromGameType(gt, names);
  if (!ids.length && vndbTags && vndbTags.length) {
    ids = mapVndbGenres(vndbTags).filter((id) => id !== 'oto'); // 乙女向不在主库收录范围
  }
  if (!ids.length) return [];
  const set = new Set(ids);
  const ordered = ORDER.filter((id) => set.has(id));
  // 最后统一过一遍关系标签抑制：L2 / L3 是从自由文本和 VNDB 标签来的，
  // 同样会带出「百合 / 耽美」这类泛用关系标签，必须与主流程同口径过滤，
  // 否则重建后误标会回流（实测 Fate/EXTRA CCC、天使之羽 等 10 条）。
  return suppressRelationalGenres(ordered, gt, String(title || ''));
}

/**
 * 从桶缓存的 rt 字段还原成标签名数组，供 fillGenres 使用。
 */
export function tagNamesOf(rawTags = []) {
  return (Array.isArray(rawTags) ? rawTags : [])
    .map((t) => (typeof t === 'string' ? t : String((t && (t.name || t.n)) || '')))
    .filter(Boolean);
}
