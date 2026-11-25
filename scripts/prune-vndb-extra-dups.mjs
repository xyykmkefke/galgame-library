// 删除 VNDB 扩展库中已被主库映射覆盖的条目（同一 VNDB id 会显示两张卡）。
// 主库映射变化后（apply-vndb-rematch）运行。默认 dry-run，加 --apply 写回。
//
// 用法：
//   node scripts/prune-vndb-extra-dups.mjs
//   node scripts/prune-vndb-extra-dups.mjs --apply

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VNDB = path.join(ROOT, 'data', 'vndb.js');
const EXTRA = path.join(ROOT, 'data', 'vndb-extra.js');
const APPLY = process.argv.includes('--apply');

function parseWindow(raw, name) {
  const m = raw.match(new RegExp('window\\.' + name + '\\s*=\\s*([\\[{][\\s\\S]*[\\]}]);'));
  if (!m) throw new Error('未找到 ' + name);
  return JSON.parse(m[1]);
}

const vndb = parseWindow(await readFile(VNDB, 'utf8'), 'GL_VNDB');
const extra = parseWindow(await readFile(EXTRA, 'utf8'), 'GL_VNDB_EXTRA');

const mapped = new Set(Object.values(vndb.map || {}).map((x) => String(x.v || '')).filter(Boolean));
const dups = extra.list.filter((x) => x.vx && mapped.has(String(x.vx)));
console.log(`扩展 ${extra.list.length} 条，与主库映射重复 ${dups.length} 条`);
dups.slice(0, 20).forEach((x) => console.log(`  [${x.vx}] ${x.n}`));

if (!APPLY) {
  console.log('\n预演完成，未写数据。确认后运行：node scripts/prune-vndb-extra-dups.mjs --apply');
  process.exit(0);
}
if (!dups.length) {
  console.log('无需写回');
  process.exit(0);
}

const drop = new Set(dups.map((x) => String(x.vx)));
extra.list = extra.list.filter((x) => !drop.has(String(x.vx)));
extra.meta = Object.assign({}, extra.meta, {
  count: extra.list.length,
  dupPrunedAt: new Date().toISOString(),
  dupPruned: (Number(extra.meta.dupPruned) || 0) + dups.length,
});
await writeFile(EXTRA, '// 由 scripts/fetch-vndb-extra.mjs 生成，请勿手动修改\n' +
  'window.GL_VNDB_EXTRA = ' + JSON.stringify(extra) + ';\n', 'utf8');
console.log(`已写回：扩展 ${extra.list.length} 条（-${dups.length}）`);
