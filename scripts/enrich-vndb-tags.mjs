// 为现有 VNDB 扩展补充题材：只重抓没有 tg 的条目标签，不重新跑整条抓取链
// 用法：node scripts/enrich-vndb-tags.mjs

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { mapVndbGenres, genreFromTitle } from './vndb-genre-map.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'vndb-extra.js');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const BATCH = 50;
const DELAY_MS = 1600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function queryTags(ids) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          filters: ['or'].concat(ids.map((id) => ['id', '=', id])),
          fields: 'id,tags{name,rating,spoiler}',
          results: ids.length,
        }),
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429) {
        console.warn('  限流，等待 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`  重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  return { results: [] };
}

async function main() {
  const raw = await readFile(FILE, 'utf8');
  const m = raw.match(/window\.GL_VNDB_EXTRA\s*=\s*(\{[\s\S]*\});/);
  if (!m) throw new Error('未找到 window.GL_VNDB_EXTRA');
  const data = JSON.parse(m[1]);
  const list = Array.isArray(data.list) ? data.list : [];
  const byVx = new Map(list.map((x) => [String(x.vx), x]));
  const missing = list.filter((x) => !Array.isArray(x.tg) || !x.tg.length);
  console.log(`无题材条目 ${missing.length} / ${list.length}，开始补标签`);

  let tagAdded = 0;
  let titleAdded = 0;
  let still = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    const json = await queryTags(batch.map((x) => x.vx));
    (json.results || []).forEach((c) => {
      const item = byVx.get(String(c.id));
      if (!item) return;
      let tg = mapVndbGenres(c.tags);
      let viaTitle = false;
      if (!tg.length) {
        tg = genreFromTitle(item.n);
        viaTitle = tg.length > 0;
      }
      if (!tg.length) return;
      item.tg = tg;
      if (viaTitle) titleAdded += 1;
      else tagAdded += 1;
    });
    if ((i + BATCH) % 500 === 0 || i + BATCH >= missing.length) {
      console.log(`  进度 ${Math.min(i + BATCH, missing.length)}/${missing.length}，标签补 ${tagAdded}，标题补 ${titleAdded}`);
    }
    await sleep(DELAY_MS);
  }

  still = list.filter((x) => !Array.isArray(x.tg) || !x.tg.length).length;
  data.meta.genreEnrich = {
    at: new Date().toISOString(),
    checked: missing.length,
    tagAdded,
    titleAdded,
    remaining: still,
  };
  const content = '// 由 scripts/fetch-vndb-extra.mjs 生成，请勿手动修改\n' +
    'window.GL_VNDB_EXTRA = ' + JSON.stringify(data) + ';\n';
  await writeFile(FILE, content, 'utf8');
  console.log(`完成：标签补 ${tagAdded}，标题补 ${titleAdded}，仍无题材 ${still} / ${list.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
