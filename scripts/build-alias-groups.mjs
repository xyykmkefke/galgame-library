// 别名组表：把「同一个实体的多种写法」算成闭包组，让搜索任一写法都命中全集。
//
// 解决什么问题：
//   dev-alias.js 是 原名 -> 标准名 的单向字典。运行时 dva 只备份每条记录自己的原始写法，
//   所以「戯画」和「GIGA」只在各自出现的条目上可搜，搜不到对方的条目。
//   实测 80 对中日->英映射里，35 对搜英文比搜原名多，累计多出 180 条条目搜不到原名；
//   最极端的「キッド」搜到 1 条、「KID」搜到 26 条。
//
// 做法：
//   1. 把 dev-alias.js 的映射、platform-alias.mjs 的平台别名、genres.mjs 的题材标签
//      统一看成无向边，用并查集求出连通分量。
//   2. 每个分量内部的全部写法互为别名，展开成一张「写法 -> 同组全部写法」的查找表。
//   3. 运行时 decorateData 按标准名查表，把同组别名注入 dva / pla，搜索即命中全集。
//
// 为什么用并查集而不是简单反转字典：
//   映射里有 A->B、A->C、D->B 这种链式关系（如 KADOKAWA GAME STUDIO -> Kadokawa Games
//   <- 角川ゲームス），简单反转只会得到多对一，链上的写法仍搜不到彼此。
//   并查集能把整条链并成一个组，组内两两互通。
//
// 用法：
//   node scripts/build-alias-groups.mjs           # 预演，打印分组统计
//   node scripts/build-alias-groups.mjs --apply   # 写入 data/alias-groups.js

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PLATFORM_ALIAS } from './platform-alias.mjs';
import { GENRES } from './genres.mjs';
import { DEV_CROSS_LANG } from './dev-cross-lang.mjs';
import { romajiAliases } from './dev-romaji.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DEV_ALIAS = path.join(ROOT, 'data', 'dev-alias.js');
const OUT = path.join(ROOT, 'data', 'alias-groups.js');
const APPLY = process.argv.includes('--apply');

// ---------- 并查集 ----------
function makeUnionFind() {
  const parent = new Map();
  const find = (x) => {
    if (!parent.has(x)) { parent.set(x, x); return x; }
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    // 路径压缩
    let c = x;
    while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  return { find, union, parent };
}

// 去掉首尾标点与多余空白：别名表里有「Kogado Studio,」这种尾随逗号的脏数据
const clean = (s) => String(s == null ? '' : s).replace(/^[\s,，、;；]+|[\s,，、;；]+$/g, '').replace(/\s+/g, ' ').trim();

// 把「标准名 -> [别名]」的映射灌进并查集，同时记录每个标准名的原始写法集合
function feed(uf, std, aliases, stats) {
  const names = [std, ...aliases].map(clean).filter(Boolean);
  if (!names.length) return;
  const uniq = [...new Set(names)];
  uniq.forEach((n) => uf.find(n));
  for (let i = 1; i < uniq.length; i += 1) {
    uf.union(uniq[0], uniq[i]);
    stats.edges += 1;
  }
}

const uf = makeUnionFind();
const stats = { edges: 0 };

// ---- 1. 开发商：dev-alias.js 的单向字典 ----
const devRaw = await readFile(DEV_ALIAS, 'utf8');
const devData = JSON.parse(devRaw.match(/window\.GL_DEV_ALIAS\s*=\s*(\{[\s\S]*\});/)[1]);
const devMap = devData.map || {};
let devDirty = 0;
Object.entries(devMap).forEach(([from, to]) => {
  const a = clean(from), b = clean(to);
  if (a !== String(from) || b !== String(to)) devDirty += 1;
  if (!a || !b) return;
  uf.union(a, b);
  stats.edges += 1;
});

// ---- 1b. 复合名：主名 + 分隔符 + 团队/子公司 ----
//
// 「工画堂スタジオ しまりすさんちーむ」这类是同一个开发商带团队后缀，指向同一实体，
// 但闭包表里没有，搜「Kogado Studio」就漏掉它（实测少 1 条）。
// 规则：如果某个 dev 名以已知标准名开头，且紧跟空格 / 斜杠 / ×，就并入该标准名的组。
// 用分隔符限定是关键 —— 「KID Fans Club」虽然以 KID 开头，但它是汉化组不是 KID 本社，
// 中间分隔符是空格看似符合……所以额外要求「后缀不含 Fans / Club / Team 这类组织词」。
const ORG_WORD = /\b(fans?\s*club|fan\s*sub|汉化|漢化|字幕|team|project|studio|studios|entertainment|interactive|works)\b/i;
// 前缀匹配的候选要用「键 + 值」两端：工画堂スタジオ 是键、Kogado Studio 是值，
// 复合名的前缀可能落在任意一端（「工画堂スタジオ しまりすさんちーむ」用的是键那一端）。
const canonNames = [...new Set(
  Object.keys(devMap).map(clean).concat(Object.values(devMap).map(clean)).filter(Boolean),
)];

// 复合名必须从主库里扫：这些名字从没进过 dev-alias，不在 uf.parent 里。
// 只扫可见条目即可（k=off 的已被默认隐藏，别名不影响界面）。
const mainRaw = await readFile(path.join(ROOT, 'data', 'galgames.js'), 'utf8');
const mainAll = JSON.parse(mainRaw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/)[1]);
const allDevNames = new Set();
mainAll.forEach((x) => (x.dev || []).forEach((d) => {
  const c = clean(d);
  if (c) allDevNames.add(c);
}));

let compoundLinked = 0;
for (const name of allDevNames) {
  if (canonNames.includes(name)) continue;
  for (const canon of canonNames) {
    if (canon.length < 3 || name === canon) continue;
    if (!name.toLowerCase().startsWith(canon.toLowerCase())) continue;
    const rest = name.slice(canon.length);
    // 必须是分隔符开头，不能是字母直接拼（如 KID 后面直接跟 nap → Kidnap）
    if (!/^[\s/／×・,，]/.test(rest)) continue;
    if (ORG_WORD.test(rest)) continue;   // 汉化组 / 字幕组 / 独立团队不并入
    uf.union(canon, name);
    compoundLinked += 1;
    stats.edges += 1;
    break;
  }
}
if (compoundLinked) console.log(`复合名并入主名：${compoundLinked} 条`);

// ---- 1c. 跨语言社名：日文名 -> 官方英文名（人工核对表）----
//
// 只灌并查集，不写进 dev-alias.js 的 map —— map 会改写 x.dev 从而改变列表显示，
// 而这里只想让英文名能搜到（进 dva），显示保持日文原名。
const crossLang = Object.entries(DEV_CROSS_LANG).reduce((n, [jp, lats]) => {
  const a = clean(jp);
  const list = (Array.isArray(lats) ? lats : [lats]).map(clean).filter(Boolean);
  if (!a || !list.length) return n;
  uf.find(a);
  list.forEach((lat) => { uf.union(a, lat); stats.edges += 1; });
  return n + 1;
}, 0);
if (crossLang) console.log(`跨语言社名并入：${crossLang} 条`);

// ---- 1d. 假名社名的罗马字：打不出假名时用罗马字也能搜到 ----
//
// 上一段只补了 57 家有官方英文名的大社，库里还有 82 个纯假名社名
// （けばぶ / うた / みどり / ランカース …）搜罗马字命中 0 条。
// 这些多是只有一两部作品的同人社团，没有官方英文名可查，
// 但罗马字是**确定性转写**（けばぶ 恒等于 kebabu），不是猜测，可以全量生成。
//
// 同样只灌并查集、不写 dev-alias 的 map —— 显示保持日文原名。
//
// 跳过的情况（romajiAliases 内部已经返回空）：
//   - 含汉字：读音不唯一，机械转写会出错（みつどもえ工房 的 工房 读 koubou / kubou 看社名习惯）
//   - 含拉丁字母或全角符号：本身就是复合名或脏数据（"アトラス / スタジオ・ゼロ"）
let romajiCount = 0;
let romajiSkipped = 0;
// 只看「还没有任何拉丁写法」的社名：已经有了就不需要罗马字近似
const devWithLatin = new Set();
Object.keys(devMap).forEach((k) => {
  if (/[A-Za-z]/.test(k)) devWithLatin.add(k);
  if (/[A-Za-z]/.test(String(devMap[k] || ''))) devWithLatin.add(k);
});
// 复合名（A/B/C）不能只看整串：整串里只要有一段的拉丁名没进 devWithLatin，
// 就会把「サイバーフロント/KID/SDR project」整串并到罗马字组，
// 而它的子段 サイバーフロント 早就有官方英文名 CyberFront —— 结果整串名
// 搜 CyberFront 搜不到，check-data 会报「漏 saibafuronto」。
// 所以拆段后逐段判断：**所有**子段都已有拉丁写法时，整串才跳过。
for (const name of allDevNames) {
  if (devWithLatin.has(name)) continue;
  // 已有跨语言官方英文名的也不重复生成
  if (DEV_CROSS_LANG[name]) continue;

  // 复合名（A/B/C）走另一条路：逐段处理，再把整串与已转写好的各段并起来。
  //
  // 为什么不能直接对整串生成罗马字：
  //   「サイバーフロント/KID/SDR project」整串转写会得到 saibafuronto，
  //   而 サイバーフロント 早就有官方英文名 CyberFront。于是整串被并进罗马字组、
  //   和 CyberFront 脱钩 —— 搜 CyberFront 搜不到这条，check-data 报「漏 saibafuronto」。
  //   正确做法是让整串跟着各段已有的名字走，只给「确实没有拉丁名」的段补罗马字。
  const segs = String(name).split(/\s*[\/／&；;、]\s*/).map((s) => s.trim()).filter(Boolean);
  if (segs.length > 1) {
    let touched = false;
    segs.forEach((seg) => {
      uf.find(seg);
      uf.union(name, seg);          // 整串 ≈ 每个子段
      stats.edges += 1;
      touched = true;
      // 该子段没有拉丁名时，补它的罗马字（并连到该子段，不直连整串）
      if (!devWithLatin.has(seg) && !DEV_CROSS_LANG[seg]) {
        const segList = romajiAliases(seg);
        segList.forEach((r) => { uf.union(seg, r); stats.edges += 1; });
      }
    });
    if (touched) romajiCount += 1;
    continue;
  }

  const list = romajiAliases(name);
  if (!list.length) { romajiSkipped += 1; continue; }
  uf.find(name);
  list.forEach((r) => { uf.union(name, r); stats.edges += 1; });
  romajiCount += 1;
}
if (romajiCount) console.log(`假名社名罗马字并入：${romajiCount} 社（另有 ${romajiSkipped} 个非纯假名社名，不需要/无法转写）`);

// ---- 2. 平台：platform-alias.mjs ----
Object.entries(PLATFORM_ALIAS).forEach(([std, list]) => feed(uf, std, list, stats));

// ---- 3. 题材：genres.mjs 的标签 ----
// 题材在运行时是按 id 走的（tg），这里只为「题材名搜索」提供同义词，
// 让「搜 百合 / yuri / GL 都落到 yur」这种能力有数据基础。
// 注意：GENRES 是数组，必须取 g.id（sci/fan/rom…），不能用 Object.entries 的数组下标——
// 那样会得到 "0"/"1"/"2"，与运行时 tg 字段的 id 体系对不上，题材搜索会全部落空。
for (const g of GENRES) {
  const id = g.id;
  const names = [g.label, ...(g.tags || [])].map(clean).filter(Boolean);
  const uniq = [...new Set(names)];
  uniq.forEach((n) => uf.find(`g:${id}:${n}`));
  for (let i = 1; i < uniq.length; i += 1) uf.union(`g:${id}:${uniq[0]}`, `g:${id}:${uniq[i]}`);
}

// ---- 汇总连通分量 ----
const groups = new Map();
for (const key of uf.parent.keys()) {
  const root = uf.find(key);
  if (!groups.has(root)) groups.set(root, []);
  groups.get(root).push(key);
}

// 每个组选一个「标准名」。
// 关键约束：标准名必须是数据里真实存在的写法，否则运行时按它查表会全部落空。
// 所以优先用 PLATFORM_ALIAS 的 key（那是我人工核对过的标准名），
// 而不是靠自己拼一个「看起来最像英文」的名字出来。
function pickCanonical(members, prefer) {
  if (prefer) {
    const hit = members.find((m) => m.toLowerCase() === prefer.toLowerCase());
    if (hit) return hit;
  }
  const score = (s) => {
    let v = 0;
    if (/^[\x20-\x7e]+$/.test(s)) v += 2;          // ASCII 优先
    if (!/^[A-Z0-9\s]+$/.test(s)) v += 1;          // 不全大写
    if (s.length <= 3) v -= 1;                      // 过短的缩写信息量低
    v += Math.min(s.length, 20) / 100;
    return v;
  };
  return members.slice().sort((a, b) => score(b) - score(a))[0];
}

// ---- 输出三张表 ----
// dev: 写法 -> 同组全部写法（开发商）
// plat: 写法 -> 标准名 + 同组全部写法（平台）
// genre: 写法 -> 题材 id（题材是按 id 走的，不需要组内展开）
const devOut = {};
const platOut = {};
const genreOut = {};
const devGroupSet = new Set(Object.keys(PLATFORM_ALIAS).map((s) => clean(s)));
const genrePrefixes = new Set(GENRES.map((g) => `g:${g.id}:`));

const platKeys = new Set();
Object.values(PLATFORM_ALIAS).forEach((list) => list.forEach((a) => platKeys.add(clean(a).toLowerCase())));

let devGroups = 0, platGroups = 0, genreGroups = 0;
for (const [, members] of groups) {
  if (members.length < 2) continue;
  const plain = members.filter((m) => !m.startsWith('g:'));
  const genreMembers = members.filter((m) => m.startsWith('g:'));
  if (genreMembers.length) {
    // 题材组：写法 -> id
    const id = genreMembers[0].split(':')[1];
    genreMembers.forEach((m) => {
      const name = m.split(':').slice(2).join(':');
      if (name) genreOut[name.toLowerCase()] = id;
    });
    genreGroups += 1;
  }
  if (!plain.length) continue;
  // 判断这组属于平台还是开发商：任一词是平台别名就是平台组
  const isPlat = plain.some((m) => platKeys.has(m.toLowerCase()));
  const out = isPlat ? platOut : devOut;
  if (isPlat) platGroups += 1; else devGroups += 1;
  // 平台组优先用人工核对过的标准名（PLATFORM_ALIAS 的 key），开发商组靠启发式挑选
  let prefer = null;
  if (isPlat) {
    for (const [std, list] of Object.entries(PLATFORM_ALIAS)) {
      if (list.some((a) => plain.some((m) => m.toLowerCase() === clean(a).toLowerCase()))) {
        prefer = clean(std);
        break;
      }
    }
  }
  const canonical = pickCanonical(plain, prefer);
  plain.forEach((m) => {
    out[m] = isPlat
      ? { c: canonical, a: plain.filter((x) => x !== m) }
      : plain.filter((x) => x !== m);
  });
}

console.log(`并查集：${uf.parent.size} 个写法，${groups.size} 个连通分量，${stats.edges} 条边`);
console.log(`开发商组：${devGroups} 组，覆盖 ${Object.keys(devOut).length} 个写法`);
console.log(`平台组：${platGroups} 组，覆盖 ${Object.keys(platOut).length} 个写法`);
console.log(`题材组：${genreGroups} 组，覆盖 ${Object.keys(genreOut).length} 个写法`);
if (devDirty) console.log(`修正尾随标点等脏数据：${devDirty} 条`);

console.log('\n抽样（开发商）：');
['戯画', 'KID', 'キッド'].forEach((k) => {
  if (devOut[k]) console.log(`  ${k} -> ${devOut[k].join(' | ')}`);
});
console.log('\n抽样（平台）：');
['アーケード', 'Nitendo Switch', 'Play Station 2', 'PC'].forEach((k) => {
  if (platOut[k]) console.log(`  ${k} -> [${platOut[k].c}] ${platOut[k].a.join(' | ')}`);
});

if (!APPLY) {
  console.log('\n预演完成，未写入。确认后运行：node scripts/build-alias-groups.mjs --apply');
  process.exit(0);
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    devGroups,
    platGroups,
    genreGroups,
    note: '别名闭包组。由 build-alias-groups.mjs 用并查集生成，运行时注入 dva / pla 参与搜索。',
  },
  dev: devOut,
  plat: platOut,
  genre: genreOut,
};
const content = '// 由 scripts/build-alias-groups.mjs 生成，请勿手动修改\n' +
  `window.GL_ALIAS_GROUPS = ${JSON.stringify(payload)};\n`;
await writeFile(OUT, content, 'utf8');
console.log(`\n已写入 ${OUT}`);
