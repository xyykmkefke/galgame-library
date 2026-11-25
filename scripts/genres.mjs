// 把 Bangumi 的自由标签归一到固定题材（20 个）。
// 只做精确匹配，避免「非科幻」这类标签被误判；新增同义词直接补在 tags 里。
export const GENRES = [
  { id: 'sci', label: '科幻', tags: ['科幻', 'sf', 'science fiction', '科学幻想', '赛博朋克', 'cyberpunk'] },
  { id: 'fan', label: '奇幻', tags: ['奇幻', '魔法', '幻想', '剑与魔法', '魔幻', 'ファンタジー'] },
  { id: 'rom', label: '恋爱', tags: ['恋爱', '恋愛', '爱情', '愛情', '恋爱喜剧', '纯爱', '純愛', 'ラブコメ', 'romance'] },
  { id: 'sch', label: '校园', tags: ['校园', '学园', '学園', '学校', '学生会'] },
  { id: 'sli', label: '日常', tags: ['日常', '生活', '青春', '慢节奏', '空气系'] },
  { id: 'mys', label: '悬疑', tags: ['悬疑', '懸疑', '神秘', '谜题', '犯罪', 'サスペンス', 'サスペンス・ミステリー'] },
  { id: 'det', label: '推理', tags: ['推理', '侦探', '探偵', '本格', 'ミステリー'] },
  { id: 'nak', label: '泣系', tags: ['泣きゲー', '泣系', '催泪', '感动', '治癒', '治愈', '泣き'] },
  { id: 'dep', label: '郁系', tags: ['郁', '鬱', '郁系', '致郁', '黑暗', '病态', 'ダーク'] },
  { id: 'hor', label: '恐怖', tags: ['恐怖', '惊悚', '灵异', 'ホラー'] },
  { id: 'gru', label: '猎奇', tags: ['猎奇', '电波', 'グロ', 'グロテスク'] },
  { id: 'bat', label: '战斗', tags: ['战斗', '动作', '热血', 'バトル'] },
  { id: 'adv', label: '冒险', tags: ['冒险', '探索', '解谜', 'アドベンチャー'] },
  { id: 'yur', label: '百合', tags: ['百合', 'gl', 'yuri', '女子恋爱', '百合ゲー'] },
  { id: 'bl', label: '耽美', tags: ['耽美', 'bl', 'boys love', 'yaoi', '蔷薇', '蔷薇向'] },
  { id: 'har', label: '后宫', tags: ['后宫', 'ハーレム'] },
  { id: 'jk', label: '女装', tags: ['女装', '伪娘', '男の娘', 'おとこのこ'] },
  { id: 'mec', label: '机战', tags: ['机战', '机器人', '机甲', 'ロボット'] },
  { id: 'oto', label: '乙女', tags: ['乙女向', '乙女', '乙女ゲーム', '乙女游戏', '女性向', 'otome'] },
  { id: 'nukige', label: '拔作', tags: ['拔作', '抜きゲー', 'nukige', 'ヌキゲー'] },
];

const TAG_TO_GENRE = new Map();
GENRES.forEach((g) => {
  g.tags.forEach((t) => TAG_TO_GENRE.set(String(t).trim().toLowerCase(), g.id));
});

// 低于该票数的用户标签噪声较大，不参与归类
export const TAG_MIN_COUNT = 3;

export function rawTagNames(metaTags = [], tags = []) {
  const names = [];
  const seen = new Set();
  const push = (value) => {
    const name = String(value || '').trim();
    if (!name || seen.has(name)) return;
    seen.add(name);
    names.push(name);
  };
  (Array.isArray(metaTags) ? metaTags : []).forEach(push);
  (Array.isArray(tags) ? tags : []).forEach((t) => {
    if (!t || !t.name) return;
    if (Number(t.count) < TAG_MIN_COUNT) return;
    push(t.name);
  });
  return names;
}

export function genreIdsFromNames(names = []) {
  const hit = new Set();
  names.forEach((name) => {
    const id = TAG_TO_GENRE.get(String(name).trim().toLowerCase());
    if (id) hit.add(id);
  });
  return GENRES.filter((g) => hit.has(g.id)).map((g) => g.id);
}

// ---- 泛用标签抑制：题材只在「类型支持」时才采信 ----
//
// 背景：Bangumi 用户标签里「百合」「耽美」是高频泛用标签 —— 角色关系、画风、甚至作者偏好
// 都会被标上，与作品玩法无关。实测全库 283 条游戏类型明显是 RPG/SRPG/ACT/TPS 的作品
// 被标了 yur（如「火焰之纹章if」(SRPG)、「蓝色星原：旅谣」(ARPG)）。
//
// 规则：当游戏类型明确是可玩性主导（RPG/ACT/育成等）**且**不含任何文字冒险指示时，
// 不采信这两个「关系类」标签；其余题材（科幻/悬疑/恐怖等属内容描述）不受影响。
// SLG / SIM（模拟经营、策略、养成）也是可玩性主导，与 RPG/ACT 同类。
// v2.31.0 排查发现原规则缺这两个词，导致「发明工坊2」(SLG)、「火山的女儿」(SIM 美少女模拟养成)
// 等 11 条策略 / 模拟类仍被标成百合。含 AVG/ADV 的混合类型由 NARRATIVE_TYPE 自动放行。
const HARD_TYPE = /(?:SRPG|RPG|SLG|SIM|FTG|TPS|FPS|ACT|育成|パズル|カード|アクション|シューティング|シミュレーション|音ゲー|リズム|ストラテジー|タワーディフェンス|模拟|模擬)/i;
const NARRATIVE_TYPE = /(?:AVG|ADV|アドベンチャー|ノベル|ビジュアルノベル|视觉小说|視覚小説)/i;
const RELATIONAL_GENRES = new Set(['yur', 'bl']);
// 类型或标题本身就写明百合 / 耽美时，标注是正确的，必须保留
const YURI_SIGNAL = /百合|yuri|ガールズラブ|女子(?:恋爱|愛)/i;
const BL_SIGNAL = /耽美|boys\s*love|yaoi|ボーイズラブ/i;

export function suppressRelationalGenres(ids = [], gameType = '', title = '') {
  const g = String(gameType || '');
  if (!g || !HARD_TYPE.test(g) || NARRATIVE_TYPE.test(g)) return ids;
  const t = String(title || '');
  return ids.filter((id) => {
    if (!RELATIONAL_GENRES.has(id)) return true;
    if (id === 'yur') return YURI_SIGNAL.test(g) || YURI_SIGNAL.test(t);
    return BL_SIGNAL.test(g) || BL_SIGNAL.test(t);
  });
}

export function genreIdsOf(metaTags, tags) {
  return genreIdsFromNames(rawTagNames(metaTags, tags));
}

// 入选白名单：即使 galgame 票数低，只要命中这些标签就保留（视觉小说/百合/BL/拔作）
export const GAL_WHITELIST = /^(视觉小说|百合|BL|拔作|ビジュアルノベル|yuri|ボーイズラブ)$/i;

// 从 Bangumi 搜索结果的 tags（含 count）里取最高票数，供抓取时做门槛判断
export function tagVotes(tags = []) {
  let galgame = 0;
  let whitelist = 0;
  (Array.isArray(tags) ? tags : []).forEach((t) => {
    if (!t || !t.name) return;
    const name = String(t.name).trim();
    const count = Number(t.count) || 0;
    if (/^galgame$/i.test(name)) galgame = Math.max(galgame, count);
    else if (GAL_WHITELIST.test(name)) whitelist = Math.max(whitelist, count);
  });
  return { galgame, whitelist };
}
