// 为 galgame 数据补充/刷新拼音首字母字段 py，便于按首字母搜索。
// 用法：node scripts/build-pinyin.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinyin } from 'pinyin-pro';

const ROOT = path.resolve(import.meta.dirname, '..');
const FULL_FILE = path.join(ROOT, 'data', 'galgames.js');

export function initials(text) {
  if (!text) return '';
  return pinyin(String(text), { pattern: 'first', toneType: 'none', type: 'array' })
    .join('')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export async function addPinyin() {
  const src = await readFile(FULL_FILE, 'utf8');
  const metaMatch = src.match(/window\.GL_META\s*=\s*(\{[\s\S]*?\});/);
  const open = src.indexOf('[', src.indexOf('window.GL_DATA'));
  const close = src.lastIndexOf(']');
  if (!metaMatch || open < 0 || close < 0) throw new Error('无法解析 data/galgames.js');
  const meta = JSON.parse(metaMatch[1]);
  const all = JSON.parse(src.slice(open, close + 1));
  let changed = 0;
  all.forEach((x) => {
    const py = initials(x.cn || x.n);
    if (x.py !== py) {
      x.py = py;
      changed += 1;
    }
  });
  meta.generatedAt = new Date().toISOString();
  const content = '// 由 scripts/fetch-games.mjs 生成，请勿手动修改\n' +
    `window.GL_META = ${JSON.stringify(meta)};\n` +
    `window.GL_DATA = ${JSON.stringify(all)};\n`;
  await writeFile(FULL_FILE, content, 'utf8');
  return { total: all.length, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await addPinyin();
  console.log(`已补充拼音：${result.total} 条（更新 ${result.changed}）`);
}
