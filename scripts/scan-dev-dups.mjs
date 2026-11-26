// 扫描「中英重复开发商」：同一实体的中文名与拉丁名并存，但没有任何映射关系。
//
// 危害：搜「橘子班」得 13 条，搜「Juzi Ban」得 12 条，两边都搜不到对方的条目，
// 相当于同一家开发商在搜索里被劈成两家。这是别名覆盖断言查不出的盲区——
// 断言只查「已有别名组内是否互通」，而这类问题压根没进组。
//
// 用法：node scripts/scan-dev-dups.mjs
// 已人工确认的误判写进 EXCLUDE，不再重复报；新候选需人工核实后才能合并
// （合并走 merge-dev-dups.mjs，拼音只是找候选，不能直接采信）。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pinyin } from 'pinyin-pro';

const ROOT = path.resolve(import.meta.dirname, '..');
const rd = (f) => readFileSync(path.join(ROOT, f), 'utf8');
const grab = (s, re) => JSON.parse(s.match(re)[1]);

// ---- 组库 ----
let all = [];
[['data/galgames.js', /window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/],
 ['data/bgm-extra.js', /window\.GL_BGM_EXTRA\s*=\s*([\s\S]*);/],
 ['data/vndb-extra.js', /window\.GL_VNDB_EXTRA\s*=\s*([\s\S]*);/],
 ['data/recent-extra.js', /window\.GL_RECENT\s*=\s*([\s\S]*);/]].forEach(([f, re]) => {
  try {
    const v = grab(rd(f), re);
    (v.list || v).forEach((x) => all.push(x));
  } catch { /* 缺失跳过 */ }
});

const DAM = grab(rd('data/dev-alias.js'), /window\.GL_DEV_ALIAS\s*=\s*([\s\S]*);/).map || {};
const AG = grab(rd('data/alias-groups.js'), /window\.GL_ALIAS_GROUPS\s*=\s*([\s\S]*);/).dev || {};

// 出现次数 = 该名字直接出现在多少条记录里
const cnt = new Map();
all.forEach((x) => (x.dev || []).forEach((d) => {
  const k = String(d).trim();
  if (k) cnt.set(k, (cnt.get(k) || 0) + 1);
}));

const CJK = /[\u3400-\u9fff]/;
const names = [...cnt.keys()];
const cjkNames = names.filter((n) => CJK.test(n));
const latinNames = names.filter((n) => !CJK.test(n));

// ---- 候选：中文名的拼音/罗马字 与 拉丁名 高度相似 ----
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// 中文名转拼音（不带声调），再去掉空格，得到 juziban 这种形态
const pyOf = (cn) => norm(pinyin(cn, { toneType: 'none', type: 'array' }).join(''));

// 编辑距离，用来判「差一两个字母」的拼写变体
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

// 已知的强关联词表（人工确认过的同一实体），优先级最高。已合并的仍列出，
// 让 sameGroup 过滤掉，作为「这确实修好了」的回归检查。
const KNOWN = [
  ['橘子班', 'Juzi Ban'],
  ['洋红工房', 'Yanghong Gongfang'],
  ['章鱼罐头制作组', 'Zhangyu Guantou Zhizuozu'],
  ['落叶岛项目组', 'Luoye Dao Xiangmuzu'],
  ['忘雪社', 'Wang Xue She'],
  ['高考恋爱委员会', "Gaokao Lian'ai Weiyuanhui"],
];

// 人工确认过的误判：名字相似但不是同一实体
const EXCLUDE = new Set([
  'くらやみ横丁',                          // 与 Hending 的拼音近似是巧合，两家不同会社
  '互娱事业群所属合作产品部Delta工作室',   // Delta 是日本成人向厂商，与腾讯互娱无关
]);

const hits = [];
const seenPair = new Set();
const record = (cn, lat, why) => {
  const key = cn + '\u0001' + lat;
  if (seenPair.has(key)) return;
  seenPair.add(key);
  hits.push({ cn, lat, why, cnCnt: cnt.get(cn), latCnt: cnt.get(lat) });
};

// 1) 人工词表
KNOWN.forEach(([cn, lat]) => {
  if (cnt.has(cn) && cnt.has(lat)) record(cn, lat, '已知词表');
});

// 2) 拼音相等：橘子班 -> juziban，拉丁名归一后为 juziban
const latinByNorm = new Map();
latinNames.forEach((l) => {
  const k = norm(l);
  if (!k) return;
  if (!latinByNorm.has(k)) latinByNorm.set(k, []);
  latinByNorm.get(k).push(l);
});

cjkNames.forEach((cn) => {
  if (cn.length > 8) return;                 // 过长的多半是句子，不是厂名
  const py = pyOf(cn);
  if (py.length < 3) return;
  // 完全相等
  (latinByNorm.get(py) || []).forEach((lat) => record(cn, lat, '拼音完全相等'));
  // 差 1~2 个字母（拼写变体）
  latinNames.forEach((lat) => {
    const k = norm(lat);
    if (!k || Math.abs(k.length - py.length) > 2) return;
    const d = lev(py, k);
    if (d > 0 && d <= 2 && d / Math.max(py.length, k.length) <= 0.25) record(cn, lat, `拼音近似(距离${d})`);
  });
});

// 3) 拉丁名是中文名的「翻译词」：如 猫猫毛工坊 / Nekonoke —— 靠共同子串无法可靠判断，不做自动推断
//    只报告「中文名里含拉丁片段」的情况（猫猫毛工坊Nekonoke 这种本身就是一个名字）
cjkNames.forEach((cn) => {
  const m = cn.match(/[A-Za-z][A-Za-z0-9\s.'-]{2,}/);
  if (!m) return;
  const frag = m[0].trim();
  if (cnt.has(frag)) record(cn, frag, '中文名内含拉丁片段');
  else {
    // 片段不完全等于已有拉丁名时，找最接近的
    latinNames.forEach((lat) => {
      if (norm(lat) === norm(frag) && lat !== frag) record(cn, lat, '中文名内含拉丁片段(近似)');
    });
  }
});

// ---- 过滤：已经在同一别名组里的不算问题 ----
const sameGroup = (a, b) => {
  const ga = AG[a], gb = AG[b];
  if (!ga || !gb) return false;
  const sa = new Set([a].concat(ga).map((s) => String(s).toLowerCase()));
  return sa.has(String(b).toLowerCase());
};
const real = hits.filter((h) => !sameGroup(h.cn, h.lat) && !EXCLUDE.has(h.cn) && !EXCLUDE.has(h.lat));

console.log(`候选 ${hits.length} 对，排除已合并组与已知误判后，待人工核实 ${real.length} 对\n`);
real.sort((a, b) => (b.cnCnt + b.latCnt) - (a.cnCnt + a.latCnt));
real.slice(0, 40).forEach((h) => {
  console.log(`  ${h.why.padEnd(22)} ${h.cn}(${h.cnCnt})  <->  ${h.lat}(${h.latCnt})`);
});

if (real.length) {
  console.log('\n新候选需人工核实作品是否对应，确认后用 merge-dev-dups.mjs 合并。');
  process.exitCode = 1;   // 有未核实候选时返回非零，便于 CI 提醒
} else {
  console.log('无新增待核实候选。');
}
