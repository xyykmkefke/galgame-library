// 把 data/vndb-extra.js 的制作人员字段（sc/ar/mu）从「、分隔字符串」转为「词典 id 数组」。
//
// 为什么需要单独一个脚本：
//   重新跑 fetch-vndb-extra.mjs 要对 VNDB 重抓 40 页 + 几千次关系查询（1.6s/次），几小时起步。
//   而这份转换是纯本地重排，无需联网、可重复运行。
//   生成端（fetch-vndb-extra.mjs 的 packStaffDict）与离线脚本必须产出**完全一致**的结构，
//   否则「重建一次就变样」——所以两边的词典排序规则（频率降序 + 名字升序打破并列）必须相同。
//
// 结构变化：
//   之前 { meta, list: [{ sc: "丸戸史明、企画屋", ... }] }
//   之后 { meta, staffDict: ["丸戸史明", ...], list: [{ sc: [1024, 88], ... }] }
//
// 用法：
//   node scripts/pack-staff-dict.mjs           # 预演，只报告
//   node scripts/pack-staff-dict.mjs --apply   # 写回
//
// 幂等：已是数组形态时直接跳过（不重复打包）。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'vndb-extra.js');
const APPLY = process.argv.includes('--apply');

const raw = await readFile(FILE, 'utf8');
const m = raw.match(/window\.GL_VNDB_EXTRA\s*=\s*(\{[\s\S]*\});/);
if (!m) throw new Error('未找到 window.GL_VNDB_EXTRA');
const obj = JSON.parse(m[1]);
const list = obj.list || [];
const headComment = (raw.slice(0, m.index).match(/^\s*\/\/[^\n]*/gm) || []).join('\n');

const already = list.filter((x) => ['sc', 'ar', 'mu'].some((f) => Array.isArray(x[f]))).length;
if (already === list.length && Array.isArray(obj.staffDict)) {
  console.log(`已是词典化形态（staffDict ${obj.staffDict.length} 个），无需转换。`);
  process.exit(0);
}

// ---- 与 fetch-vndb-extra.mjs 的 packStaffDict 保持同一份规则 ----
// 对齐要点（2026-11-28）：两边都必须先「把 id 数组用旧词典还原成姓名」再统一重打包。
// 早期这里只统计字符串形态，混合形态（部分数组 + 部分字符串）会把数组条目漏掉，
// 重建出的词典不完整 → 那部分 id 指向错的姓名。与生成端同一个坑，必须同一套算法。
const prevDict = Array.isArray(obj.staffDict) ? obj.staffDict : null;
const unresolved = [];
const nameArrays = new Map();
for (const x of list) {
  const rec = {};
  for (const f of ['sc', 'ar', 'mu']) {
    const v = x[f];
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (!prevDict) { unresolved.push(`${x.i}:${f}:缺旧词典`); rec[f] = v; continue; }
      const names = v.map((i) => prevDict[i]);
      const badIdx = names.findIndex((n) => typeof n !== 'string' || !n);
      if (badIdx >= 0) { unresolved.push(`${x.i}:${f}:id ${v[badIdx]} 越界（旧词典 ${prevDict.length}）`); rec[f] = v; continue; }
      rec[f] = names;
    } else if (typeof v === 'string') {
      const names = v.split('、').map((s) => s.trim()).filter(Boolean);
      if (names.length) rec[f] = names;
    }
  }
  if (Object.keys(rec).length) nameArrays.set(x, rec);
}

const freq = new Map();
for (const rec of nameArrays.values()) {
  for (const f of ['sc', 'ar', 'mu']) {
    (rec[f] || []).forEach((n) => freq.set(n, (freq.get(n) || 0) + 1));
  }
}
if (!freq.size) {
  console.log('没有可转换的制作人员字段，退出。');
  process.exit(0);
}
const dict = [...freq.entries()]
  .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  .map(([n]) => n);
const idOf = new Map(dict.map((n, i) => [n, i]));

let converted = 0;
let refs = 0;
const badSet = new Set(unresolved.map((s) => s.split(':').slice(0, 2).join(':')));
for (const [x, rec] of nameArrays) {
  for (const f of ['sc', 'ar', 'mu']) {
    if (!rec[f]) continue;
    if (badSet.has(`${x.i}:${f}`)) continue;
    x[f] = rec[f].map((n) => idOf.get(n));
    refs += rec[f].length;
    converted += 1;
  }
}
if (unresolved.length) {
  console.log(`⚠ ${unresolved.length} 处无法还原（示例 ${unresolved.slice(0, 3).join(', ')}），已保留原值`);
}

const byFreq = [...freq.entries()].sort((a, b) => b[1] - a[1]);
console.log(`唯一姓名 ${dict.length} 个，转换字段 ${converted} 个 / 引用 ${refs} 次`);
console.log('高频前 5：' + byFreq.slice(0, 5).map(([n, c]) => `${n}(${c})`).join(' · '));
console.log('低频前 3：' + byFreq.slice(-3).map(([n, c]) => `${n}(${c})`).join(' · '));

const beforeSize = Buffer.byteLength(raw, 'utf8');
const payload = { meta: obj.meta, staffDict: dict, list };
const out = (headComment ? headComment + '\n' : '') +
  'window.GL_VNDB_EXTRA = ' + JSON.stringify(payload) + ';\n';
const afterSize = Buffer.byteLength(out, 'utf8');
console.log(`\nraw：${beforeSize} → ${afterSize}（${afterSize < beforeSize ? '省' : '增'} ${Math.abs(afterSize - beforeSize)} 字节）`);

if (!APPLY) {
  console.log('\n预演完成，未写入。确认后运行：node scripts/pack-staff-dict.mjs --apply');
} else {
  await writeFile(FILE, out, 'utf8');
  console.log(`\n已写入 ${FILE}`);
}
