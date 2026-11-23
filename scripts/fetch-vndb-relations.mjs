// 保存 VNDB 官方作品关系边表，供系列聚合、连通分量裁剪与关系校验复用。
// 只抓库内已有 VNDB id（主库映射 + 日系扩展），不新增作品、不改任何数据文件。
// 输出 data/build/vndb-relations.json（构建缓存，已在 .gitignore 中，不提交）。
//
// 用法：
//   node scripts/fetch-vndb-relations.mjs                 增量补齐全部未处理种子
//   node scripts/fetch-vndb-relations.mjs --limit=100     只处理前 100 个未处理种子（试跑）
//   node scripts/fetch-vndb-relations.mjs --refresh       清空缓存后全量重抓
//   node scripts/fetch-vndb-relations.mjs --delay=2000    调整批次间隔（默认 1600ms）
//
// VNDB 匿名限流约 200 次 / 5 分钟；每批 50 个 id，命中 429 时等待 60s 后重试。

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_FILE = path.join(ROOT, 'data', 'build', 'vndb-relations.json');
const API = 'https://api.vndb.org/kana/vn';
const UA = 'galgame-library/2.0 (https://github.com/xyykmkefke/galgame-library)';
const BATCH_SIZE = 50;
const REQUEST_TIMEOUT_MS = 60000;

const args = process.argv.slice(2);
const REFRESH = args.includes('--refresh');
const LIMIT = Number((args.find((a) => a.startsWith('--limit=')) || '').slice(8)) || 0;
const DELAY_MS = Number((args.find((a) => a.startsWith('--delay=')) || '').slice(8)) || 1600;

// 与 fetch-vndb-extra.mjs 保持一致：只保留官方作品关系，跳过 char（共用角色）与 fan（同人）
const RELATION_TYPES = new Set(['seq', 'preq', 'set', 'alt', 'side', 'par', 'ser', 'sub', 'orig']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function readWindowVar(file, name) {
  try {
    const raw = await readFile(file, 'utf8');
    const m = raw.match(new RegExp(`window\\.${name}\\s*=\\s*(\\{[\\s\\S]*\\});`));
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

// 收集库内全部 VNDB id：主库匹配映射 + 日系扩展
async function collectIds() {
  const ids = new Set();
  const vndb = await readWindowVar(path.join(ROOT, 'data', 'vndb.js'), 'GL_VNDB');
  Object.values((vndb && vndb.map) || {}).forEach((x) => {
    if (x && x.v) ids.add(String(x.v));
  });
  const extra = await readWindowVar(path.join(ROOT, 'data', 'vndb-extra.js'), 'GL_VNDB_EXTRA');
  ((extra && extra.list) || []).forEach((x) => {
    if (x && x.vx) ids.add(String(x.vx));
  });
  return ids;
}

async function loadCache() {
  if (REFRESH) return { edges: {}, processed: [] };
  try {
    const raw = await readFile(OUT_FILE, 'utf8');
    const data = JSON.parse(raw);
    return {
      edges: data && typeof data.edges === 'object' && data.edges ? data.edges : {},
      processed: Array.isArray(data && data.processed) ? data.processed : [],
    };
  } catch {
    return { edges: {}, processed: [] };
  }
}

// 一批 id 查 relations；返回 id -> [[目标 id, 关系类型], ...]
async function queryRelations(ids) {
  const filter = ids.length === 1 ? ['id', '=', ids[0]] : ['or'].concat(ids.map((id) => ['id', '=', id]));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
        body: JSON.stringify({
          filters: filter,
          fields: 'id,relations{id,relation}',
          results: 100,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429) {
        console.warn('    限流，等待 60s');
        await sleep(60000);
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (err) {
      if (attempt === 3) throw err;
      console.warn(`    重试 ${attempt}/2：${err.message}`);
      await sleep(attempt * 3000);
    }
  }
  throw new Error('请求失败');
}

async function save(ids, edges, processed) {
  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'vndb',
    relationTypes: [...RELATION_TYPES].sort(),
    seeds: ids.size,
    processed: [...processed].sort(),
    edgeSeeds: Object.keys(edges).length,
    edgeCount: Object.values(edges).reduce((n, list) => n + list.length, 0),
    edges,
  };
  const tmp = OUT_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(payload), 'utf8');
  await rename(tmp, OUT_FILE);
}

// 只统计库内 id 的连通分量：边两端都在库内才计入
function analyzeComponents(ids, edges) {
  const parent = new Map();
  const find = (x) => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(x) !== root) {
      const next = parent.get(x);
      parent.set(x, root);
      x = next;
    }
    return root;
  };
  const add = (x) => {
    if (!parent.has(x)) parent.set(x, x);
  };
  ids.forEach(add);
  Object.entries(edges).forEach(([from, list]) => {
    if (!ids.has(from)) return;
    (list || []).forEach(([to]) => {
      if (!ids.has(to)) return;
      add(to);
      const ra = find(from);
      const rb = find(to);
      if (ra !== rb) parent.set(ra, rb);
    });
  });
  const sizes = new Map();
  ids.forEach((id) => {
    const root = find(id);
    sizes.set(root, (sizes.get(root) || 0) + 1);
  });
  const groups = [...sizes.values()].sort((a, b) => b - a);
  const linked = groups.filter((n) => n > 1);
  return {
    libraryIds: ids.size,
    touchedIds: [...parent.keys()].filter((id) => ids.has(id) && sizes.get(find(id)) > 1).length,
    groups: groups.length,
    groupsWithMultiple: linked.length,
    largest: groups[0] || 0,
    top: linked.slice(0, 10),
  };
}

async function main() {
  const ids = await collectIds();
  if (!ids.size) throw new Error('未从 data/vndb.js 或 data/vndb-extra.js 读到 VNDB id');

  const cache = await loadCache();
  const edges = cache.edges;
  const processed = new Set(cache.processed);
  let pending = [...ids].filter((id) => !processed.has(id)).sort();
  if (LIMIT > 0) pending = pending.slice(0, LIMIT);

  console.log(`库内 VNDB id：${ids.size}；已处理：${processed.size}；本轮待抓：${pending.length}`);
  if (!pending.length) {
    console.log('没有待处理种子，直接复用现有缓存');
  }

  const batches = chunk(pending, BATCH_SIZE);
  for (let i = 0; i < batches.length; i += 1) {
    const batch = batches[i];
    const json = await queryRelations(batch);
    const returned = new Set();
    (json.results || []).forEach((c) => {
      const from = String(c.id || '');
      if (!from) return;
      returned.add(from);
      const seen = new Set();
      const list = [];
      (c.relations || []).forEach((r) => {
        const rel = String((r && r.relation) || '');
        const to = String((r && r.id) || '');
        if (!RELATION_TYPES.has(rel) || !to || to === from) return;
        const key = to + '|' + rel;
        if (seen.has(key)) return;
        seen.add(key);
        list.push([to, rel]);
      });
      if (list.length) edges[from] = list;
      else delete edges[from];
    });
    // 请求成功但未返回的 id 也标记已处理，避免反复重试已下架条目
    batch.forEach((id) => processed.add(id));
    if (returned.size !== batch.length) {
      console.log(`    本批 ${batch.length} 个 id，VNDB 返回 ${returned.size} 个`);
    }

    if ((i + 1) % 10 === 0 || i === batches.length - 1) {
      await save(ids, edges, processed);
      console.log(`  批次 ${i + 1}/${batches.length}，已处理 ${processed.size}，边种子 ${Object.keys(edges).length}`);
    }
    if (i < batches.length - 1) await sleep(DELAY_MS);
  }

  await save(ids, edges, processed);
  const stats = analyzeComponents(ids, edges);
  const edgeCount = Object.values(edges).reduce((n, list) => n + list.length, 0);
  console.log(`完成：${processed.size}/${ids.size} 个种子，${Object.keys(edges).length} 个有边，共 ${edgeCount} 条边`);
  console.log(`库内连通分量：${stats.groups} 组，其中多部作品 ${stats.groupsWithMultiple} 组，最大 ${stats.largest} 部`);
  console.log(`最大几组：${stats.top.join(' / ')}`);
  console.log(`输出：${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
