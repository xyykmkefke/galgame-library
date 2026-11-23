// VNDB 英文标签 / 标题 -> 本地题材 id 的统一映射
// 由 fetch-vndb-extra.mjs 与 enrich-vndb-tags.mjs 共用，避免两处规则漂移
import { GENRES } from './genres.mjs';

export const TAG_GENRE = {
  'science fiction': 'sci', 'sci-fi': 'sci', cyberpunk: 'sci', space: 'sci',
  'time travel': 'sci', 'virtual reality': 'sci', 'post-apocalyptic': 'sci', dystopia: 'sci',
  fantasy: 'fan', magic: 'fan', 'sword and sorcery': 'fan', mythology: 'fan',
  supernatural: 'fan', youkai: 'fan', isekai: 'fan',
  romance: 'rom', 'pure love story': 'rom', 'love story': 'rom', 'dating sim': 'rom',
  'romantic comedy': 'rom', 'love triangle': 'rom',
  school: 'sch', 'high school': 'sch', 'school life': 'sch', 'high school student heroine': 'sch',
  academy: 'sch', 'student council': 'sch',
  'slice of life': 'sli', 'daily life': 'sli',
  mystery: 'mys', crime: 'mys', suspense: 'mys', thriller: 'mys', 'murder mystery': 'mys',
  detective: 'det', investigation: 'det', police: 'det',
  nakige: 'nak', tearjerker: 'nak', emotional: 'nak',
  utsuge: 'dep', tragedy: 'dep', dark: 'dep', despair: 'dep', depression: 'dep', 'bad ending(s)': 'dep',
  horror: 'hor', ghost: 'hor', zombie: 'hor', occult: 'hor', curse: 'hor',
  gore: 'gru', guro: 'gru', denpa: 'gru', grotesque: 'gru',
  battle: 'bat', action: 'bat', war: 'bat', combat: 'bat', 'martial arts': 'bat',
  adventure: 'adv', exploration: 'adv', journey: 'adv',
  yuri: 'yur', 'girls love': 'yur', lesbian: 'yur',
  'boys love': 'bl', yaoi: 'bl', bara: 'bl', 'shounen ai': 'bl',
  harem: 'har', 'reverse harem': 'har',
  'cross-dressing': 'jk', trap: 'jk', otokonoko: 'jk', 'gender bender': 'jk',
  mecha: 'mec', robot: 'mec', 'mecha combat': 'mec',
  otome: 'oto', 'otome game': 'oto',
  nukige: 'nukige',
};

const TITLE_RULES = [
  [/百合|yuri|girls['’]?\s*love/i, 'yur'],
  [/ボーイズラブ|boys['’]?\s*love|yaoi|耽美/i, 'bl'],
  [/乙女|otome/i, 'oto'],
  [/学園|学校|school|academy/i, 'sch'],
  [/恋|love|romance/i, 'rom'],
  [/魔法|魔術|fantasy|ファンタジー/i, 'fan'],
  [/ミステリ|推理|探偵|mystery|detective/i, 'det'],
  [/ホラー|恐怖|horror/i, 'hor'],
  [/ロボ|メカ|mecha|robot/i, 'mec'],
  [/サイエンス|science\s*fiction|sci-?fi|\bsf\b/i, 'sci'],
  [/冒険|adventure/i, 'adv'],
  [/バトル|battle|戦闘/i, 'bat'],
  [/日常|slice\s*of\s*life/i, 'sli'],
  [/泣|nakige/i, 'nak'],
  [/グロ|guro|grotesque/i, 'gru'],
  [/ハーレム|harem/i, 'har'],
  [/女装|cross-?dress|otokonoko/i, 'jk'],
];

export function mapVndbGenres(tags) {
  const hit = new Set();
  (tags || []).forEach((t) => {
    if (!t || t.spoiler) return;
    if (Number(t.rating) < 0.5) return;
    const id = TAG_GENRE[String(t.name || '').trim().toLowerCase()];
    if (id) hit.add(id);
  });
  return GENRES.filter((g) => hit.has(g.id)).map((g) => g.id);
}

// 标签完全缺失时，用标题关键词兜底；只返回一个最可能的题材
export function genreFromTitle(title) {
  const value = String(title || '');
  for (const [re, id] of TITLE_RULES) {
    if (re.test(value)) return [id];
  }
  return [];
}
