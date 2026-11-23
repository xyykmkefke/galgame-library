// 裁剪 VNDB 扩展库中的低热度老作，为未来更新留出体积空间
// 默认只预演，不写文件；确认后加 --apply 才真正裁剪
// 用法：
//   node scripts/prune-vndb-extra.mjs --policy=conservative        # 预演：h<10 且 2015 年前，约 -857 条 / -222KB
//   node scripts/prune-vndb-extra.mjs --policy=balanced --apply    # 执行：h<20 且 2015 年前，约 -1850 条 / -497KB
//
// 两条策略都保留全部 2015 年及以后作品、h>=20 的作品（balanced 保留 h>=20）。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'vndb-extra.js');
const POLICY = {
  conservative: { maxHeat: 10, before: '2015-01-01' },
  balanced: { maxHeat: 20, before: '2015-01-01' },
};

const arg = (name, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const policyName = arg('policy', 'conservative');
const policy = POLICY[policyName];
const apply = process.argv.includes('--apply');

if (!policy) {
  console.error(`未知策略：${policyName}，可选 ${Object.keys(POLICY).join(' / ')}`);
  process.exit(1);
}

const raw = await readFile(FILE, 'utf8');
const m = raw.match(/window\.GL_VNDB_EXTRA\s*=\s*(\{[\s\S]*\});/);
if (!m) throw new Error('未找到 window.GL_VNDB_EXTRA');
const data = JSON.parse(m[1]);
const list = Array.isArray(data.list) ? data.list : [];

const keep = [];
const drop = [];
list.forEach((x) => {
  const lowHeat = Number(x.h) < policy.maxHeat;
  const old = x.d && String(x.d) < policy.before;
  if (lowHeat && old) drop.push(x);
  else keep.push(x);
});

const beforeBytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
const afterBytes = Buffer.byteLength(JSON.stringify(keep), 'utf8');
console.log(`策略 ${policyName}：h < ${policy.maxHeat} 且发售日 < ${policy.before}`);
console.log(`条数 ${list.length} → ${keep.length}（删除 ${drop.length}，保留 ${keep.length}）`);
console.log(`体积约 ${(beforeBytes / 1024).toFixed(0)}KB → ${(afterBytes / 1024).toFixed(0)}KB（释放 ${((beforeBytes - afterBytes) / 1024).toFixed(0)}KB）`);

if (!apply) {
  console.log('当前为预演模式，未写入文件；确认后加 --apply。');
  process.exit(0);
}

data.list = keep;
data.meta.count = keep.length;
data.meta.prune = {
  at: new Date().toISOString(),
  policy: policyName,
  maxHeat: policy.maxHeat,
  before: policy.before,
  removed: drop.length,
  freedKB: Number(((beforeBytes - afterBytes) / 1024).toFixed(1)),
};
const content = '// 由 scripts/fetch-vndb-extra.mjs 生成，请勿手动修改\n' +
  'window.GL_VNDB_EXTRA = ' + JSON.stringify(data) + ';\n';
await writeFile(FILE, content, 'utf8');
console.log(`已写入 ${FILE}`);
