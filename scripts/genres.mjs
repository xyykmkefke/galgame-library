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
