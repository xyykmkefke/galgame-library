// 把 Bangumi 的自由标签归一到固定题材（18 个）。
// 只做精确匹配，避免「非科幻」这类标签被误判；新增同义词直接补在 tags 里。
export const GENRES = [
  { id: 'sci', label: '科幻', tags: ['科幻', 'sf', 'science fiction', '科学幻想', '赛博朋克', 'cyberpunk'] },
  { id: 'fan', label: '奇幻', tags: ['奇幻', '魔法', '幻想', '剑与魔法', '魔幻'] },
  { id: 'rom', label: '恋爱', tags: ['恋爱', '爱情', '恋爱喜剧', '纯爱', 'ラブコメ', 'romance'] },
  { id: 'sch', label: '校园', tags: ['校园', '学园', '学校', '学生会'] },
  { id: 'sli', label: '日常', tags: ['日常', '生活', '慢节奏', '空气系'] },
  { id: 'mys', label: '悬疑', tags: ['悬疑', '谜题', '犯罪', 'サスペンス', 'サスペンス・ミステリー'] },
  { id: 'det', label: '推理', tags: ['推理', '侦探', '本格', 'ミステリー'] },
  { id: 'nak', label: '泣系', tags: ['泣きゲー', '泣系', '催泪', '感动', '治愈', '泣き'] },
  { id: 'dep', label: '郁系', tags: ['郁', '郁系', '致郁', '黑暗', '病态', 'ダーク'] },
  { id: 'hor', label: '恐怖', tags: ['恐怖', '惊悚', '灵异', 'ホラー'] },
  { id: 'gru', label: '猎奇', tags: ['猎奇', '电波', 'グロ', 'グロテスク'] },
  { id: 'bat', label: '战斗', tags: ['战斗', '动作', '热血', 'バトル'] },
  { id: 'adv', label: '冒险', tags: ['冒险', '探索', '解谜', 'アドベンチャー'] },
  { id: 'yur', label: '百合', tags: ['百合', 'gl', '女子恋爱', '百合ゲー'] },
  { id: 'bl', label: '耽美', tags: ['耽美', 'bl', 'boys love', '蔷薇', '蔷薇向'] },
  { id: 'har', label: '后宫', tags: ['后宫', 'ハーレム'] },
  { id: 'jk', label: '女装', tags: ['女装', '伪娘', '男の娘', 'おとこのこ'] },
  { id: 'mec', label: '机战', tags: ['机战', '机器人', '机甲', 'ロボット'] },
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
