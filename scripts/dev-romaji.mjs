// 假名社名的罗马字别名：让打不出假名的用户也能搜到。
//
// 为什么需要这个：
//   库里还有一百多个只以假名出现的开发商（けばぶ / うた / みどり / ランカース …），
//   都是只有一两部作品的同人社团，没有官方英文名可查。之前只人工补了 57 家
//   有官方英文名的大社（dev-cross-lang.mjs），剩下的搜英文/罗马字命中 0 条。
//
// 为什么用罗马字而不是「猜英文名」：
//   罗马字是**确定性的转写规则**，不是猜测。けばぶ -> kebabu 谁转都一样；
//   而「猜官方英文名」会写出 Sagiyama 这种无法查证的东西，用户会误以为那就是官方名。
//   错误映射比搜不到更糟 —— 所以这个文件只做机械转写，不编造。
//
// 和 dev-cross-lang.mjs 的分工：
//   - dev-cross-lang.mjs：人工核对过的**官方英文名**（Atlas -> Atlus 这类）
//   - dev-romaji.mjs   ：机械转写的**罗马字**（含常见异写，见下）
//   两者的结果都只灌别名闭包、不写 dev-alias 的 map，显示保持日文原名。
//
// 输出多个变体而不是单一写法，因为转写本身有公认的多套写法：
//   し = shi / si，つ = tsu / tu，ふ = fu / hu，じ = ji / zi，
//   長音 ー 可以写成 -、省略或双写元音。
//   多给几个变体不会出错，只是让「用户按自己习惯敲」都能命中。

// 三拍以上的组合音要放在两拍之前匹配（きゃ 优先于 き + ゃ）
const COMBO = [
  ['きゃ', 'kya'], ['きゅ', 'kyu'], ['きょ', 'kyo'],
  ['しゃ', 'sha'], ['しゅ', 'shu'], ['しょ', 'sho'],
  ['ちゃ', 'cha'], ['ちゅ', 'chu'], ['ちょ', 'cho'],
  ['にゃ', 'nya'], ['にゅ', 'nyu'], ['にょ', 'nyo'],
  ['ひゃ', 'hya'], ['ひゅ', 'hyu'], ['ひょ', 'hyo'],
  ['みゃ', 'mya'], ['みゅ', 'myu'], ['みょ', 'myo'],
  ['りゃ', 'rya'], ['りゅ', 'ryu'], ['りょ', 'ryo'],
  ['ぎゃ', 'gya'], ['ぎゅ', 'gyu'], ['ぎょ', 'gyo'],
  ['じゃ', 'ja'], ['じゅ', 'ju'], ['じょ', 'jo'],
  ['ぢゃ', 'ja'], ['ぢゅ', 'ju'], ['ぢょ', 'jo'],
  ['びゃ', 'bya'], ['びゅ', 'byu'], ['びょ', 'byo'],
  ['ぴゃ', 'pya'], ['ぴゅ', 'pyu'], ['ぴょ', 'pyo'],
  ['ふぁ', 'fa'], ['ふぃ', 'fi'], ['ふぇ', 'fe'], ['ふぉ', 'fo'],
  ['てぃ', 'ti'], ['でぃ', 'di'], ['とぅ', 'tu'], ['どぅ', 'du'],
  ['うぃ', 'wi'], ['うぇ', 'we'], ['うぉ', 'wo'],
  ['ゔぁ', 'va'], ['ゔぃ', 'vi'], ['ゔぇ', 've'], ['ゔぉ', 'vo'],
  ['ちぇ', 'che'], ['しぇ', 'she'], ['じぇ', 'je'],
];

const SINGLE = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'o', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'zu', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ゔ: 'vu',
  ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
  ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa',
  // 長音与中点是标点/修饰符，作为对象键必须加引号（不加是语法错误）
  'ー': '-', '・': ' ',
};

// 片假名 -> 平假名（同一个音，只为复用一张表）
const toHira = (s) => String(s).replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

// 转一次：sokuon(っ) 双写后接辅音，長音 ー 暂时留成 '-' 由调用方处理
function translit(str) {
  const s = toHira(str);
  let out = '';
  let i = 0;
  while (i < s.length) {
    // 促音：把下一个辅音复制一份（もっきゃ -> mokky a）
    if (s[i] === 'っ') {
      const rest = s.slice(i + 1);
      let next = '';
      const c2 = COMBO.find(([k]) => rest.startsWith(k));
      if (c2) next = c2[1];
      else if (SINGLE[rest[0]]) next = SINGLE[rest[0]];
      if (next && /^[a-z]/.test(next)) out += next[0];
      i += 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    const c = COMBO.find(([k]) => k === two);
    if (c) { out += c[1]; i += 2; continue; }
    const one = s[i];
    if (SINGLE[one] !== undefined) { out += SINGLE[one]; i += 1; continue; }
    out += one;   // 汉字/符号原样保留，由调用方判断是否可用
    i += 1;
  }
  return out;
}

// 异写变体：把 shi/si、tsu/tu、fu/hu、ji/zi 这类公认的两套写法都生成出来
function variants(base) {
  const set = new Set([base]);
  const rules = [
    [/shi/g, 'si'], [/sha/g, 'sya'], [/shu/g, 'syu'], [/sho/g, 'syo'],
    [/cha/g, 'tya'], [/chu/g, 'tyu'], [/cho/g, 'tyo'],
    [/tsu/g, 'tu'], [/fu/g, 'hu'], [/ji/g, 'zi'],
    [/ja/g, 'zya'], [/ju/g, 'zyu'], [/jo/g, 'zyo'],
  ];
  // 单轮替换即可：库里的社名都是短名，多轮组合收益极低、变体爆炸反而干扰
  for (const [re, to] of rules) {
    const cur = [...set];
    for (const v of cur) set.add(v.replace(re, to));
  }
  return [...set];
}

/**
 * 生成一个假名社名的罗马字别名列表。
 *
 * 输入容忍的范围（比第一版放宽）：
 *   - 纯假名：けばぶ -> kebabu
 *   - 带标点：あまてる。-> amateru / テクスト。-> tekusuto
 *   - 带波浪线：てぃ～ぐる -> tiiguru（～ 视为长音，直接丢掉）
 *   - 混拉丁字母：KSBゲームス -> ksbgemusu，并额外给出「只转假名段 + 保留原拉丁」的写法
 *   - 复合名（含 / ・ & ；）：拆段后逐段转写，再拼出各段的独立写法
 *     这些是「多家联合开发」被塞进一个字段的脏数据，整串转写没意义，
 *     但拆出的每一段都是有意义的社名（アトラス / スタジオ・ゼロ -> atorasu / sutajio zero）。
 *
 * 仍然不做的事：
 *   - 汉字读音：みつどもえ工房 的 工房 读 koubou 还是 kubou 取决于社名习惯，
 *     机械转写会出错，宁可不给（错误映射比搜不到更糟）。
 */
export function romajiAliases(name) {
  const raw = String(name || '');
  if (!raw) return [];

  const out = new Set();
  const push = (s) => {
    const t = String(s || '').replace(/\s+/g, ' ').trim();
    // 门槛 3 个字符。
    //
    // 定这个数是因为两字母碎片是拆段残留、必须挡住：ge / re / ha / do / io 这类
    // 留在表里会让「搜两个字母」命中一大片无关条目，是纯噪音。
    // 但门槛放到 4 又会误伤真实短名 —— うた(uta) / えぬ(enu) /
    // ディーオー(dio) / ポーン(pon) 都正好 3 个字符，它们是真社名不是碎片。
    //
    // 现在「・」不再当多社分隔符（见下方 segments 的说明），两字母碎片的来源
    // 已经消失，3 这个门槛刚好把「碎片」和「短名」分开。
    if (t.length < 3) return;
    out.add(t);
    out.add(t.replace(/\s+/g, ''));                                   // 连写
    out.add(t.replace(/\b[a-z]/g, (c) => c.toUpperCase()));           // 首字母大写
  };

  // 复合名拆段：只按「明确的多社分隔符」拆 —— / ／ & ； ; 、
  //
  // 中点「・」不拆：它在日文社名里几乎总是词内的装饰符号
  // （ザ・ロータス = The Lotus，ハ・ン・ド = Hand），当成多社分隔会把它切成
  // ザ / ロータス / ハ / ン / ド 这种两字母碎片，变成搜索噪音。
  // 实测这类碎片会把「ge」「re」「ha」「do」灌进别名表，搜两个字母就命中一大片。
  const segments = raw.split(/\s*[\/／&；;、]\s*/).map((s) => s.trim()).filter(Boolean);
  const targets = segments.length > 1 ? segments : [raw];

  for (const seg of targets) {
    // 汉字一律跳过整个分段
    if (/[\u4e00-\u9fff]/.test(seg)) continue;
    // 必须含至少一个假名才转写。
    // 否则纯拉丁名会被逐字母喂进 translit —— 拉丁字母 A 恰好等于假名「あ」的键，
    // 于是 CHARON 变成 tyaron 这种垃圾（C 不在表里被原样留下，A 被当成「あ」）。
    // 这类名字本来就是拉丁形式，不需要也不应该生成罗马字别名。
    if (!/[\u3040-\u309f\u30a0-\u30ff]/.test(seg)) continue;
    // 只保留假名 + 拉丁字母 + 数字；符号（。～〜！等）当分隔/丢弃。
    // 波浪线 ～〜 表示长音，先换成 ー 再交给 translit 处理（否则会被当普通符号删掉）。
    const normalized = seg.replace(/[～〜~]/g, 'ー');
    const kept = normalized.replace(/[^0-9A-Za-z\u3040-\u309f\u30a0-\u30ff\u30fc]/g, '');
    if (!kept) continue;
    // 转写前把拉丁片段「保护」起来：只让假名部分进 translit，
    // 拉丁部分原样保留。KID / CHARON 这类缩写不能变形。
    //
    // 注意必须整段交给 translit，不能逐字符调 —— 组合音（チュ / シャ / キャ）
    // 是两拍，逐字符会把 チュ 拆成 チ(chi) + ュ(yu) 得到 chiyu，
    // 正确的 chuu/chun 反而出不来（实测 チュンソフト -> chiyunsofuto 就是这毛病）。
    // 做法：按「拉丁段 / 假名段」切块，假名块整块 translit，拉丁块原样拼回。
    let base = '';
    let chunk = '';
    let chunkLatin = null;   // null = 未开始；true/false = 当前块类型
    const flush = () => {
      if (!chunk) return;
      base += chunkLatin ? chunk : translit(chunk);
      chunk = '';
    };
    for (const ch of kept) {
      const isLatin = /[A-Za-z0-9]/.test(ch);
      if (chunkLatin === null) { chunkLatin = isLatin; chunk = ch; continue; }
      if (chunkLatin === isLatin) { chunk += ch; continue; }
      flush();
      chunkLatin = isLatin;
      chunk = ch;
    }
    flush();
    base = base.replace(/-/g, '').replace(/\s+/g, ' ').trim();
    if (!base) continue;
    // 混拉丁字母的：假名段已转写，原有拉丁片段原样保留（KID / SDR 这类缩写不能丢）
    const merged = base.toLowerCase();
    if (!/^[a-z0-9 ]+$/.test(merged)) continue;
    variants(merged).forEach(push);
  }

  return [...out];
}
