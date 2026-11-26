// 合并「同一开发商的中文名与拉丁名」到 dev-alias 映射表。
//
// 背景：`dev-alias.js` 原本只做「同一语言的写法归一」（Alicesoft → AliceSoft），
// 没处理跨语言。于是 `橘子班`(13 条) 与 `Juzi Ban`(12 条) 并存且交集为 0，
// 搜中文只到 13 条、搜英文只到 12 条，同一家社在搜索里被劈成两家。
//
// 方向：拉丁名 → 中文名。站点是中文界面，归到中文名后列表显示更自然；
// 反向归会把中文社名显示成拼音，对中文用户是倒退。
// 归一后 dva 同时保留两种写法，搜索任一写法都能命中全集。
//
// 收录标准（必须人工确认，不做自动推断）：
//   1. 两边的作品能对应上（互为续作 / 同系列 / 官方译名），
//   2. 排除「名字撞车但实体不同」——如 Delta（日本成人向）vs 腾讯互娱 Delta 工作室。
//   自动拼音匹配只能用来找候选，不能直接采信：くらやみ横丁 会被误配成 Hending。
//
// 用法：node scripts/merge-dev-dups.mjs [--apply]
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');

// 已人工核实的同一实体：拉丁名 -> 中文名
const CONFIRMED = {
  'Juzi Ban': '橘子班',
  'Yanghong Gongfang': '洋红工房',
  'Zhangyu Guantou Zhizuozu': '章鱼罐头制作组',
  'Luoye Dao Xiangmuzu': '落叶岛项目组',
  'Wang Xue She': '忘雪社',
  "Gaokao Lian'ai Weiyuanhui": '高考恋爱委员会',
};

// 明确不合并（名字相似但不是同一实体），写在这里是为了避免以后被反复误判
const REJECTED = {
  '互娱事业群所属合作产品部Delta工作室': 'Delta 是日本成人向厂商，与本条腾讯系工作室无关',
  'くらやみ横丁': '拼音近似实测为误判，与 Hending 作品无关联',
};

const raw = await readFile(path.join(ROOT, 'data', 'dev-alias.js'), 'utf8');
const m = raw.match(/window\.GL_DEV_ALIAS\s*=\s*(\{[\s\S]*\});/);
if (!m) throw new Error('未找到 window.GL_DEV_ALIAS');
const data = JSON.parse(m[1]);
const map = data.map || {};

const applied = [];
const skipped = [];
Object.entries(CONFIRMED).forEach(([lat, cn]) => {
  if (REJECTED[lat] || REJECTED[cn]) { skipped.push(`${lat} 在排除清单`); return; }
  const cur = map[lat];
  if (cur === cn) { skipped.push(`${lat} 已映射到 ${cn}`); return; }
  if (cur) { skipped.push(`${lat} 已映射到 ${cur}，不覆盖`); return; }
  map[lat] = cn;
  applied.push(`${lat} -> ${cn}`);
});

console.log(`待新增映射：${applied.length} 条`);
applied.forEach((s) => console.log('  + ' + s));
if (skipped.length) {
  console.log(`跳过：${skipped.length} 条`);
  skipped.forEach((s) => console.log('  - ' + s));
}

if (!APPLY) {
  console.log('\n预演完成，未写入。确认后运行：node scripts/merge-dev-dups.mjs --apply');
  process.exit(0);
}
if (!applied.length) {
  console.log('\n无变更，未写入。');
  process.exit(0);
}

data.map = map;
data.meta = data.meta || {};
data.meta.aliases = Object.keys(map).length;
data.meta.groups = new Set(Object.values(map)).size;

const before = raw.slice(0, raw.indexOf('window.GL_DEV_ALIAS'));
const after = raw.slice(raw.indexOf('window.GL_DEV_ALIAS'));
const tail = after.slice(after.indexOf('\n'));
const out = before + 'window.GL_DEV_ALIAS = ' + JSON.stringify(data) + ';' + (tail.startsWith('\n') ? tail : '\n');
await writeFile(path.join(ROOT, 'data', 'dev-alias.js'), out);
console.log(`\n已写入 data/dev-alias.js，新增 ${applied.length} 条跨语言映射。`);
