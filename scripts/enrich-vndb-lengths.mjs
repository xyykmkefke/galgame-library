// 给主库 VNDB 映射补游玩时长（vndb.map[id].l，单位分钟），用于时长筛选与「我的时长」统计。
// 只处理已匹配但 l 为空 / 0 的条目；默认 dry-run，加 --apply 写回 data/vndb.js。
//
// 用法：
//   node scripts/enrich-vndb-lengths.mjs
//   node scripts/enrich-vndb-lengths.mjs --apply
//   node scripts/enrich-vndb-lengths.mjs --refresh   # 同时刷新已有 l（VNDB 有修订时）

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VNDB = path.join(ROOT, 'data', 'vndb.js');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const APPLY = process.argv.includes('--apply');
const REFRESH = process.argv.includes('--refresh');
const BATCH = 50;
const DELAY_MS = 1600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const raw = await readFile(VNDB, 'utf8');
const vndb = JSON.parse(raw.match(/window\.GL_VNDB\s*=\s*(\{[\s\S]*\});/)[1]);

const targets = Object.keys(vndb.map).filter((id) => {
  const x = vndb.map[id];
  if (!x || !x.v) return false;
  return REFRESH || !x.l;
});
console.log(`已匹配 ${Object.keys(vndb.map).length} 条，待补时长 ${targets.length} 条`);
if (!targets.length) {
  console.log('没有需要补的条目');
  process.exit(0);
}

const byVn = new Map();
const batches = chunk(targets, BATCH);
for (let i = 0; i < batches.length; i += 1) {
  const ids = batches[i].map((id) => String(vndb.map[id].v));
  const filter = ids.length === 1 ? ['id', '=', ids[0]] : ['or'].concat(ids.map((v) => ['id', '=', v]));
  let json = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({ filters: filter, fields: 'id,length_minutes', results: 100 }),
        signal: AbortSignal.timeout(45000),
      });
      if (res.status === 429) {
        console.warn('    限流，等待 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      json = await res.json();
      break;
    } catch (err) {
      if (attempt === 4) throw err;
      console.warn(`    重试 ${attempt}/3：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  (json.results || []).forEach((c) => byVn.set(String(c.id), Number(c.length_minutes) || 0));
  if ((i + 1) % 5 === 0 || i === batches.length - 1) {
    console.log(`  批次 ${i + 1}/${batches.length}`);
  }
  if (i < batches.length - 1) await sleep(DELAY_MS);
}

let fillable = 0;
const samples = [];
targets.forEach((id) => {
  const vn = String(vndb.map[id].v);
  const len = byVn.get(vn) || 0;
  if (len > 0) {
    fillable += 1;
    if (samples.length < 10) samples.push(`${id}:${vndb.map[id].t || ''} → ${len} 分钟`);
  }
});
console.log(`可补时长 ${fillable} 条（VNDB 未标注 ${targets.length - fillable} 条）`);
samples.forEach((s) => console.log('  ' + s));
if (!APPLY) {
  console.log('\n预演完成，未写数据。确认后运行：node scripts/enrich-vndb-lengths.mjs --apply');
  process.exit(0);
}

let written = 0;
targets.forEach((id) => {
  const vn = String(vndb.map[id].v);
  const len = byVn.get(vn) || 0;
  if (len > 0 && vndb.map[id].l !== len) {
    vndb.map[id].l = len;
    written += 1;
  }
});
vndb.meta = Object.assign({}, vndb.meta, {
  lengthFilledAt: new Date().toISOString(),
  lengthFilled: (Number(vndb.meta.lengthFilled) || 0) + written,
});
await writeFile(VNDB, '// 由 scripts/fetch-vndb.mjs 生成，请勿手动修改\n' +
  'window.GL_VNDB = ' + JSON.stringify(vndb) + ';\n', 'utf8');
console.log(`\n已写回 ${VNDB}：补 ${written} 条时长`);
