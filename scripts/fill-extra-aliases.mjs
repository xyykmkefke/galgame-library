// 给扩展库 / 新作索引补别名（al），数据来自本地的 VNDB 标题索引缓存。
//
// 为什么需要这个脚本：
//   主库有 al（Bangumi 别名 + VNDB 英文标题），扩展库与_new作索引此前**一条都没有**。
//   后果是同一部作品在两个库里行为不一致：主库能搜的英文名，扩展库搜不到。
//   实测扩展库 5737 条中 5405 条可补（94%）、共 7175 个写法，al 覆盖率原本是 0%。
//
// 为什么不在 fetch-vndb-extra.mjs 里一并做：
//   那条路要对 VNDB 重抓 40 页 + 几千次关系查询（1.6s/次），几小时起步。
//   而 data/build/vndb-titles.json 已经缓存了 68371 条标题（含各语言 latin 与英文标题），
//   离线就能补齐，且能重复运行。生成端也同步加了 al（从 API 直接取 aliases），
//   两条路互不依赖：重建后由生成端产出，未重建时用本脚本补齐。
//
// 用法：
//   node scripts/fill-extra-aliases.mjs           # 预演，只报告
//   node scripts/fill-extra-aliases.mjs --apply   # 写回 data/vndb-extra.js 与 recent-extra.js
//
// 收录顺序即详情页展示顺序：官方 aliases → 英文标题 → 罗马字 → 中文标题。
// 只收「与自身显示名不同」的写法，避免详情页把标题重复列一遍。
//
// 语言白名单：只取 ja / zh 的 latin 转写。
// VNDB 的 titles[].latin 是各语言标题的拉丁化转写，含 ko / ru / th 等：
// 实测 ja 5372、zh-Hans 900、zh-Hant 321，而 ko 54 + ru 35 + th 7 合计仅 96 条。
// 那些是韩语/俄语音译（如「Strana Koljos, Devochka-Podsolnuh」），
// 对中文用户是纯噪声——既不是用户会打的写法，又会把详情页别名列表挤满。
const AL_LANGS = new Set(['ja', 'zh-Hans', 'zh-Hant', 'zh']);

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '');

// 索引：VNDB id -> { a: alttitle, ti: [{ l, t, la }] }
const rawIdx = JSON.parse(await readFile(path.join(ROOT, 'data', 'build', 'vndb-titles.json'), 'utf8'));
const idx = new Map();
for (const x of rawIdx.list || []) idx.set(String(x.i), x);
console.log(`VNDB 标题索引：${idx.size} 条`);

// 目标文件：两份结构不同，统一用「整份重写 GL_* 赋值语句」的方式处理
const TARGETS = [
  {
    file: 'data/vndb-extra.js',
    re: /window\.GL_VNDB_EXTRA\s*=\s*([\s\S]*);/,
    write: (obj) => `window.GL_VNDB_EXTRA = ${JSON.stringify(obj)};`,
    // 扩展库 id 在 vx 字段（形如 v211）
    vndbId: (x) => String(x.vx || '').replace(/^v/, ''),
    name: (x) => x.n,
  },
  {
    file: 'data/recent-extra.js',
    re: /window\.GL_RECENT\s*=\s*([\s\S]*);/,
    write: (obj) => `window.GL_RECENT = ${JSON.stringify(obj)};`,
    vndbId: (x) => String(x.vx || '').replace(/^v/, ''),
    name: (x) => x.n,
  },
];

for (const t of TARGETS) {
  const p = path.join(ROOT, t.file);
  const raw = await readFile(p, 'utf8');
  const m = raw.match(t.re);
  if (!m) throw new Error(`未找到赋值语句：${t.file}`);
  const obj = JSON.parse(m[1]);
  const list = obj.list || obj;
  // 保留文件首部的生成说明注释（「由 … 生成，请勿手动修改」）。
  // 整份重写只输出赋值语句，会把注释一并抹掉——那句提示是防止后人直接改数据文件的唯一警示。
  const headComment = (raw.slice(0, m.index).match(/^\s*\/\/[^\n]*/gm) || []).join('\n');

  let changed = 0;
  let added = 0;
  let already = 0;
  for (const x of list) {
    const src = idx.get(t.vndbId(x));
    if (!src) continue;

    const seen = new Set([norm(t.name(x))]);
    const cand = [];
    const push = (v) => {
      const s = String(v || '').trim();
      if (!s) return;
      const k = norm(s);
      if (!k || seen.has(k)) return;
      seen.add(k);
      cand.push(s);
    };
    // 已存在的 al 先占位，避免重复写入
    (x.al || []).forEach(push);
    const before = cand.length;
    // 英文标题：只取 en 的 t（官方英文名，非转写）
    (src.ti || []).filter((z) => z.l === 'en').forEach((z) => push(z.t));
    // 拉丁转写：必须过语言白名单。此前这里写的是 `l !== 'en'`，把 ru / ko / uk / th 等
    // 也一并收了（实测 3092 条 / 7.1%），与上方 AL_LANGS 的声明矛盾——常量定义了却没用上。
    // 这些是俄/韩/乌克兰语音译（如 G선상의 마왕 → G-Seonsangui Mawang），
    // 对中文用户既不是会打的写法，又会把详情页别名列表挤满。
    (src.ti || [])
      .filter((z) => z.l !== 'en' && AL_LANGS.has(z.l))
      .forEach((z) => push(z.la));
    if (x.cn) push(x.cn);

    if (cand.length === before) {
      if (x.al && x.al.length) already += 1;
      continue;
    }
    x.al = cand;
    changed += 1;
    added += cand.length - before;
  }

  console.log(`${t.file}：${list.length} 条，本次补 ${changed} 条 / 新增 ${added} 个写法（已有 al ${already} 条）`);
  if (changed && APPLY) {
    await writeFile(p, (headComment ? headComment + '\n' : '') + t.write(obj), 'utf8');
    console.log(`  已写入 ${t.file}`);
  }
}

if (!APPLY) {
  console.log('\n预演完成，未写入。确认后运行：node scripts/fill-extra-aliases.mjs --apply');
} else {
  console.log('\n记得同步：node scripts/build-pinyin.mjs（若 titles 有变动）');
}
