// 按 data/blocklist.json 过滤扩展库里的非 gal 条目（只改 vndb-extra.js，不动主库与抓取缓存）。
// 默认 dry-run；确认后加 --apply 才写文件。
//
// 用法：
//   node scripts/apply-blocklist.mjs            # 预演：打印将删除的条数与体积
//   node scripts/apply-blocklist.mjs --apply    # 执行过滤
//
// 黑名单按 VNDB id（vx）匹配；抓取脚本 fetch-vndb-extra.mjs 也会读取同一文件，
// 避免下次重抓时把已确认的非 gal 条目带回来。

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'vndb-extra.js');
const BLOCK = path.join(ROOT, 'data', 'blocklist.json');
const APPLY = process.argv.includes('--apply');

const raw = await readFile(FILE, 'utf8');
const m = raw.match(/window\.GL_VNDB_EXTRA\s*=\s*(\{[\s\S]*\});/);
if (!m) throw new Error('未找到 window.GL_VNDB_EXTRA');
const data = JSON.parse(m[1]);
const list = Array.isArray(data.list) ? data.list : [];

const block = JSON.parse(await readFile(BLOCK, 'utf8'));
const blocked = new Set((block.items || []).map((x) => String(x.vx)).filter(Boolean));
if (!blocked.size) {
  console.log('黑名单为空，无需处理');
  process.exit(0);
}

const kept = list.filter((x) => !blocked.has(String(x.vx)));
const removed = list.filter((x) => blocked.has(String(x.vx)));
const beforeBytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
const afterBytes = Buffer.byteLength(JSON.stringify(kept), 'utf8');

console.log(`黑名单 ${blocked.size} 条，命中扩展库 ${removed.length} 条`);
console.log(`条数 ${list.length} → ${kept.length}；体积 ${(beforeBytes / 1024).toFixed(0)}KB → ${(afterBytes / 1024).toFixed(0)}KB（释放 ${((beforeBytes - afterBytes) / 1024).toFixed(0)}KB）`);
if (removed.length) {
  console.log('将删除：' + removed.map((x) => `${x.vx} ${x.n || ''}`).join(' / '));
}

if (!APPLY) {
  console.log('当前为预演模式，未写入文件；确认后加 --apply。');
  process.exit(0);
}

data.list = kept;
data.meta = data.meta || {};
data.meta.count = kept.length;
data.meta.blocklist = {
  at: new Date().toISOString(),
  source: 'data/blocklist.json',
  configured: blocked.size,
  removed: removed.length,
};
const content = '// 由 scripts/fetch-vndb-extra.mjs 生成，请勿手动修改\n' +
  'window.GL_VNDB_EXTRA = ' + JSON.stringify(data) + ';\n';
const tmp = `${FILE}.tmp`;
await writeFile(tmp, content, 'utf8');
await rename(tmp, FILE);
console.log(`已写入 ${FILE}`);
