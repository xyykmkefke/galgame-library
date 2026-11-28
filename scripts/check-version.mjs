// 版本一致性门禁：发布前比对所有版本号与文档里的关键数字，不一致就以非 0 退出。
// 用法：node scripts/check-version.mjs
//
// 覆盖：package / package-lock（两处）/ index.html（meta + 页脚）/ manifest / sw 缓存名 /
//       README 状态行 / HANDOVER 文档头与 43.1 版本表 / 描述里的作品数与系列数。

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const fails = [];
const warns = [];
const pass = [];

function check(name, ok, detail) {
  if (ok) pass.push(name + (detail ? '（' + detail + '）' : ''));
  else fails.push(name + (detail ? '：' + detail : ''));
}

const read = (p) => readFile(path.join(ROOT, p), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const V = String(pkg.version);

function windowVar(raw, name) {
  const m = raw.match(new RegExp('window\\.' + name + '\\s*=\\s*([\\[{][\\s\\S]*[\\]}]);'));
  if (!m) throw new Error('未找到 ' + name);
  return JSON.parse(m[1]);
}

// ---------- 数据规模 ----------
const main = windowVar(await read('data/galgames.js'), 'GL_DATA');
const extra = windowVar(await read('data/vndb-extra.js'), 'GL_VNDB_EXTRA').list;
const bgm = windowVar(await read('data/bgm-extra.js'), 'GL_BGM_EXTRA').list;
const recent = windowVar(await read('data/recent-extra.js'), 'GL_RECENT').list;
const series = windowVar(await read('data/series.js'), 'GL_SERIES').meta;
const hidden = main.filter((x) => x.k === 'off').length;
const total = main.length + bgm.length + extra.length + recent.length;
const visible = total - hidden;

// ---------- 版本号 ----------
const lock = JSON.parse(await read('package-lock.json'));
check('package-lock 顶层版本', String(lock.version) === V, `${lock.version} != ${V}`);
check('package-lock packages[""] 版本', String(lock.packages?.['']?.version) === V,
  `${lock.packages?.['']?.version} != ${V}`);

const html = await read('index.html');
const metaV = (html.match(/<meta\s+name="version"\s+content="([^"]+)"/) || [])[1];
check('index.html <meta name="version">', metaV === V, `${metaV} != ${V}`);
const footV = (html.match(/id="appVersion"[^>]*>v([\d.]+)</) || [])[1];
check('index.html 页脚版本', footV === V, `${footV} != ${V}`);

const manifest = JSON.parse(await read('manifest.webmanifest'));
check('manifest 版本', String(manifest.version) === V, `${manifest.version} != ${V}`);

const sw = await read('sw.js');
const cache = (sw.match(/CACHE\s*=\s*'([^']+)'/) || [])[1] || '';
check('sw 缓存名格式', /^yuc-gl-shell-v\d+$/.test(cache), cache || '缺失');

// ---------- README / HANDOVER 状态行 ----------
const readme = await read('README.md');
check('README 状态行', new RegExp('状态：\\*\\*v' + V.replace(/\./g, '\\.') + '\\*\\*').test(readme),
  (readme.match(/状态：\*\*v[\d.]+/i) || ['未找到'])[0]);

const handover = await read('HANDOVER.md');
check('HANDOVER 文档头当前状态', new RegExp('当前状态：\\*\\*v' + V.replace(/\./g, '\\.') + '\\*\\*').test(handover),
  (handover.match(/当前状态：\*\*v[\d.]+/i) || ['未找到'])[0]);

// 43.1 版本表
const tableRows = {
  'package.json': V,
  'package-lock.json': V,
  'index.html': V,
  'README.md': 'v' + V,
  'manifest.webmanifest': V,
  'sw.js': 'v' + ((cache.match(/v(\d+)$/) || [])[1] || ''),
  'HANDOVER.md': 'v' + V,
};
Object.entries(tableRows).forEach(([file, want]) => {
  const line = handover.split('\n').find((l) => l.startsWith('| `' + file + '`'));
  if (!line) { fails.push('43.1 版本表缺少 ' + file); return; }
  const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
  const value = cells[cells.length - 1];
  check('43.1 版本表 ' + file, value === want, `${value} != ${want}`);
});

// ---------- 描述里的作品数 ----------
check('manifest description 作品数', manifest.description.includes(`${total} 部作品（${hidden} 部非 gal 默认隐藏）`),
  manifest.description.slice(0, 40));

const indexDesc = (html.match(/<meta\s+name="description"\s+content="([^"]*)"/) || [])[1] || '';
check('index description 作品数',
  indexDesc.includes(`${total} 部日系作品（${main.length} 部 Bangumi 主库 + ${bgm.length} 部 Bangumi 关联 + ${extra.length} 部 VNDB 扩展 + ${recent.length} 部 2025 年起新作，其中 ${hidden} 部非 gal 默认隐藏`),
  indexDesc.slice(0, 60));

const scaleLine = readme.split('\n').find((l) => l.startsWith('- 规模：')) || '';
check('README 规模行',
  scaleLine.includes(`${total} 条（主库 ${main.length} 含 ${hidden} 条非 gal 标记 + Bangumi 关联 ${bgm.length} + VNDB 扩展 ${extra.length} + 新作索引 ${recent.length}；默认可见 ${visible} 条`),
  scaleLine.slice(0, 70) || '未找到');

const seriesLine = readme.split('\n').find((l) => l.includes('个系列 /')) || '';
check('README 系列数',
  seriesLine.includes(`${series.series} 个系列 / ${series.items} 部作品`),
  seriesLine.slice(0, 60) || '未找到');

// ---------- 输出 ----------
console.log(`版本 ${V} · 作品 ${total}（主库 ${main.length} + 关联 ${bgm.length} + 扩展 ${extra.length} + 新作 ${recent.length}，隐藏 ${hidden}）· 系列 ${series.series}/${series.items}`);
pass.forEach((p) => console.log('PASS  ' + p));
warns.forEach((w) => console.log('WARN  ' + w));
fails.forEach((f) => console.log('FAIL  ' + f));
console.log(`\n通过 ${pass.length}/${pass.length + fails.length}`);
if (fails.length) process.exit(1);
