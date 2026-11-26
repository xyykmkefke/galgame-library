// 用月幕的中文名补主库缺失的标题别名。
//
// 背景：主库有 550 条没有中文名（x.cn 为空），其中 47 条月幕（GL_YMGAL）已给出
// 真正的中文译名 —— Fate/stay night → 命运之夜、Kanon → 雪之少女。
// 这类条目的中文用户完全搜不到，是最典型的「换个语言就搜不到」。
//
// 为什么写进 al 而不是 cn：
//   cn 是列表主标题（渲染处是 `x.cn || x.n`），补进去会直接改变列表显示文字，
//   还会影响按标题排序的结果。写进 al 只作用于搜索，展示完全不变。
//
// 为什么不用自动翻译：
//   标题是专有名词，机翻会造出「命运之夜停留」这种错名，反而污染数据。
//   只采信月幕已有的译名，宁缺毋滥。
//
// 用法：node scripts/fill-title-alias.mjs [--apply]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');

const read = async (f) => readFile(path.join(ROOT, 'data', f), 'utf8');
const grab = (f, re) => JSON.parse(read(f).then ? '' : '');
const grabSync = (s, re) => {
  const m = s.match(re);
  if (!m) throw new Error('解析失败');
  return JSON.parse(m[1]);
};

const mainRaw = await read('galgames.js');
const main = grabSync(mainRaw, /window\.GL_DATA\s*=\s*(\[[\s\S]*\]);/);
const ymRaw = await read('ymgal.js');
const YM = grabSync(ymRaw, /window\.GL_YMGAL\s*=\s*([\s\S]*);/).map || {};

const CJK = /[\u3400-\u9fff]/;

// 限定语法用 : 和空格切词、用 - 表示排除，别名里出现这些字符会被误当成语法。
// 处理顺序是先「规范化」再「判安全」：
//   - 全角冒号 ： 换成普通的，避免被当成限定符（Rewrite：收获祭！→ Rewrite:收获祭！）
//   - 中文之间的空格直接去掉（葬花 · 暗黑桃花源 → 葬花·暗黑桃花源），中文排版本就不需要空格
//   - 处理完仍含 ASCII 空格或冒号的（多是中日混排的「A - B」形式）才跳过
const normalizeCn = (s) => String(s)
  .replace(/\uFF1A/g, ':')
  .replace(/([\u3400-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u3400-\u9fff\u3000-\u303f\uff00-\uffef])/g, '$1')
  .trim();
const SAFE = /^[^:：\s]+$/;

const planned = [];
let skippedUnsafe = 0;
let skippedDup = 0;

main.forEach((x) => {
  if (String(x.cn || '').trim()) return;          // 已有中文名，不用补
  const y = YM[String(x.i)];
  if (!y || !y.cn) return;
  const raw = String(y.cn).trim();
  if (!raw || !CJK.test(raw)) return;             // 只要真正的中文
  const cn = normalizeCn(raw);
  if (!cn || cn === String(x.n || '').trim()) return;
  if (!SAFE.test(cn)) {
    // 含空格或冒号的先跳过，避免被当成限定语法；这类留给人工
    skippedUnsafe += 1; return;
  }
  const al = x.al || (x.al = []);
  const lower = al.map((a) => String(a).toLowerCase());
  if (lower.indexOf(cn.toLowerCase()) >= 0 || String(x.n || '').toLowerCase() === cn.toLowerCase()) {
    skippedDup += 1; return;
  }
  al.push(cn);
  planned.push({ i: x.i, n: x.n, cn });
});

console.log(`可补中文别名：${planned.length} 条`);
console.log(`  跳过（含空格/冒号，会触发限定语法）：${skippedUnsafe} 条`);
console.log(`  跳过（重复）：${skippedDup} 条`);
planned.slice(0, 15).forEach((p) => console.log(`  ${p.i}  ${p.n}  =>  ${p.cn}`));

if (!APPLY) {
  console.log('\n预演完成，未写入。确认后运行：node scripts/fill-title-alias.mjs --apply');
  process.exit(0);
}

if (!planned.length) {
  console.log('无变更，未写入。');
  process.exit(0);
}

// 保留原文件前缀注释与 GL_META 行，只替换 GL_DATA 行
const before = mainRaw.slice(0, mainRaw.indexOf('window.GL_DATA'));
const dataEnd = mainRaw.indexOf('\n', mainRaw.indexOf('window.GL_DATA'));
const after = dataEnd >= 0 ? mainRaw.slice(dataEnd) : '\n';
const out = before + 'window.GL_DATA = ' + JSON.stringify(main) + ';' + after;
await writeFile(path.join(ROOT, 'data', 'galgames.js'), out);
console.log(`\n已写入 data/galgames.js，补入 ${planned.length} 条中文别名。`);
