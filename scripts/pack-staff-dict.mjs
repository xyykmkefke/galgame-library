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
const freq = new Map();
for (const x of list) {
  for (const f of ['sc', 'ar', 'mu']) {
    if (Array.isArray(x[f]) || typeof x[f] !== 'string') continue;
    x[f].split('、').map((s) => s.trim()).filter(Boolean)
      .forEach((n) => freq.set(n, (freq.get(n) || 0) + 1));
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
for (const x of list) {
  for (const f of ['sc', 'ar', 'mu']) {
    if (Array.isArray(x[f]) || typeof x[f] !== 'string') continue;
    const names = x[f].split('、').map((s) => s.trim()).filter(Boolean);
    if (!names.length) continue;
    x[f] = names.map((n) => idOf.get(n));
    refs += names.length;
    converted += 1;
  }
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
