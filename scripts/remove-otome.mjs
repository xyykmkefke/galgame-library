// 从主库 / VNDB 扩展 / Bangumi 关联中彻底移除乙女向作品（tg 含 oto）。
// 黑名单来自 data/blocklist-otome.json；默认 dry-run，确认后加 --apply。
//
// 用法：
//   node scripts/remove-otome.mjs            # 预演
//   node scripts/remove-otome.mjs --apply    # 删除并更新 meta.count
//
// 说明：只删数据条目，不改抓取缓存；fetch-games / fetch-vndb-extra /
// fetch-bgm-related 会读取同一黑名单与 oto 规则，避免下次重抓回流。

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BLOCK = path.join(ROOT, 'data', 'blocklist-otome.json');
const APPLY = process.argv.includes('--apply');

const block = JSON.parse(await readFile(BLOCK, 'utf8'));
const mainIds = new Set((block.main || []).map((x) => String(x.i)));
const vndbIds = new Set((block.vndb || []).map((x) => String(x.vx)));
const bgmIds = new Set((block.bgm || []).map((x) => String(x.i)));

async function load(file, name) {
  const raw = await readFile(path.join(ROOT, 'data', file), 'utf8');
  const m = raw.match(new RegExp(`window\\.${name}\\s*=\\s*(\\{[\\s\\S]*\\});`));
  if (!m) throw new Error(`未找到 window.${name}：${file}`);
  return { raw, data: JSON.parse(m[1]) };
}

async function save(file, name, data, header) {
  const content = `// ${header}\nwindow.${name} = ${JSON.stringify(data)};\n`;
  const full = path.join(ROOT, 'data', file);
  const tmp = `${full}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, full);
}

const main = await load('galgames.js', 'GL_META');
const mainRaw = await readFile(path.join(ROOT, 'data', 'galgames.js'), 'utf8');
const mainDataMatch = mainRaw.match(/window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/);
if (!mainDataMatch) throw new Error('未找到 window.GL_DATA');
const mainData = JSON.parse(mainDataMatch[1]);
const ext = await load('vndb-extra.js', 'GL_VNDB_EXTRA');
const bgm = await load('bgm-extra.js', 'GL_BGM_EXTRA');

const mainBefore = mainData.length;
const extBefore = (ext.data.list || []).length;
const bgmBefore = (bgm.data.list || []).length;

const mainKept = mainData.filter((x) => !mainIds.has(String(x.i)));
const extKept = (ext.data.list || []).filter((x) => !vndbIds.has(String(x.vx)));
const bgmKept = (bgm.data.list || []).filter((x) => !bgmIds.has(String(x.i)));

const bytes = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8');
const freed = (arrBefore, arrAfter) => {
  const before = arrBefore.reduce((s, x) => s + bytes(x), 0);
  const after = arrAfter.reduce((s, x) => s + bytes(x), 0);
  return before - after;
};
const freedMain = freed(mainData, mainKept);
const freedExt = freed(ext.data.list || [], extKept);
const freedBgm = freed(bgm.data.list || [], bgmKept);

console.log(`主库 ${mainBefore} → ${mainKept.length}（删除 ${mainBefore - mainKept.length}，释放 ${(freedMain / 1024).toFixed(0)}KB）`);
console.log(`扩展 ${extBefore} → ${extKept.length}（删除 ${extBefore - extKept.length}，释放 ${(freedExt / 1024).toFixed(0)}KB）`);
console.log(`BGM 关联 ${bgmBefore} → ${bgmKept.length}（删除 ${bgmBefore - bgmKept.length}，释放 ${(freedBgm / 1024).toFixed(0)}KB）`);
console.log(`合计删除 ${mainBefore - mainKept.length + extBefore - extKept.length + bgmBefore - bgmKept.length} 条，释放 ${((freedMain + freedExt + freedBgm) / 1024).toFixed(0)}KB`);

if (!APPLY) {
  console.log('当前为预演模式，未写入文件；确认后加 --apply。');
  process.exit(0);
}

main.data = main.data || {};
main.data.count = mainKept.length;
main.data.nonGalMarked = mainKept.filter((x) => x.k === 'off').length;
ext.data.meta = ext.data.meta || {};
ext.data.meta.count = extKept.length;
ext.data.meta.otomeRemoved = (ext.data.meta.otomeRemoved || 0) + (extBefore - extKept.length);
bgm.data.meta = bgm.data.meta || {};
bgm.data.meta.count = bgmKept.length;
bgm.data.meta.seeds = mainKept.length;
bgm.data.meta.otomeRemoved = (bgm.data.meta.otomeRemoved || 0) + (bgmBefore - bgmKept.length);

// galgames.js 是双变量文件，单独重写
const mainContent = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
  `window.GL_META = ${JSON.stringify(main.data)};\n` +
  `window.GL_DATA = ${JSON.stringify(mainKept)};\n`;
const mainFile = path.join(ROOT, 'data', 'galgames.js');
const mainTmp = `${mainFile}.tmp`;
await writeFile(mainTmp, mainContent, 'utf8');
await rename(mainTmp, mainFile);

ext.data.list = extKept;
await save('vndb-extra.js', 'GL_VNDB_EXTRA', ext.data, '由 scripts/fetch-vndb-extra.mjs 生成，请勿手动修改');

bgm.data.list = bgmKept;
await save('bgm-extra.js', 'GL_BGM_EXTRA', bgm.data, '由 scripts/fetch-bgm-related.mjs 生成，请勿手动修改');

// 清理 blocklist-main 中已不存在的主库 id（例如被乙女规则删掉的 1 条）
try {
  const mbPath = path.join(ROOT, 'data', 'blocklist-main.json');
  const mb = JSON.parse(await readFile(mbPath, 'utf8'));
  const kept = (mb.items || []).filter((x) => mainKept.some((y) => String(y.i) === String(x.i)));
  const removed = (mb.items || []).length - kept.length;
  if (removed) {
    mb.items = kept;
    mb.updatedAt = new Date().toISOString().slice(0, 10);
    await writeFile(mbPath, JSON.stringify(mb, null, 2), 'utf8');
    console.log(`blocklist-main 清理 ${removed} 条已不存在的 id`);
  }
} catch { /* 可选文件 */ }

// 清理 vndb.js / ymgal.js 中已不存在的主库映射，避免孤儿键
const mainIdSet = new Set(mainKept.map((x) => String(x.i)));
async function cleanMap(file, name, header) {
  const { data } = await load(file, name);
  const map = data.map || {};
  const keptMap = {};
  let removed = 0;
  for (const [k, v] of Object.entries(map)) {
    if (mainIdSet.has(String(k))) keptMap[k] = v;
    else removed += 1;
  }
  if (!removed) return;
  data.map = keptMap;
  data.meta = data.meta || {};
  data.meta.total = mainKept.length;
  data.meta.matched = Object.keys(keptMap).length;
  await save(file, name, data, header);
  console.log(`${file} 清理孤儿映射 ${removed} 条（剩余 ${Object.keys(keptMap).length}）`);
}
await cleanMap('vndb.js', 'GL_VNDB', '由 scripts/fetch-vndb.mjs 生成，请勿手动修改');
await cleanMap('ymgal.js', 'GL_YMGAL', '由 scripts/fetch-ymgal.mjs 生成，请勿手动修改');

console.log('已写入 galgames.js / vndb-extra.js / bgm-extra.js，并清理映射');
