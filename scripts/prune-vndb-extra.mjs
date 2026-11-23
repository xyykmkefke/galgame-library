// 裁剪 VNDB 扩展库中的低热度老作，为未来更新留出体积空间
// 默认只预演，不写文件；确认后加 --apply 才真正裁剪
// 用法：
//   node scripts/prune-vndb-extra.mjs --policy=conservative        # 预演：h<10 且 2015 年前，约 -857 条 / -222KB
//   node scripts/prune-vndb-extra.mjs --policy=balanced --apply    # 执行：h<20 且 2015 年前，约 -1850 条 / -497KB
//   node scripts/prune-vndb-extra.mjs --policy=graph               # 预演：balanced + 关系图保护（推荐先跑这个）
//   node scripts/prune-vndb-extra.mjs --policy=graph --apply       # 执行 graph 策略
//
// conservative / balanced 保留全部 2015 年及以后作品（balanced 另保留 h>=20）。
// graph 在 balanced 基础上按 VNDB relations 构建连通分量：
//   - 分量内有 h>=20 / 2015 年后作品，或通过边连到主库锚点 → 整组保留；
//   - 整组都是 h<20 且 2015 年前的冷门老作 → 多部作品的组保留 h 最高的一部（并列取 d 最新），其余删除；
//     孤立单点没有系列可保，按 balanced 直接删除。
// graph 依赖 data/build/vndb-relations.json（构建缓存，不提交）；缺失或损坏会直接退出。

import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'vndb-extra.js');
const MAIN_FILE = path.join(ROOT, 'data', 'vndb.js');
const REL_FILE = path.join(ROOT, 'data', 'build', 'vndb-relations.json');
const POLICY = {
  conservative: { maxHeat: 10, before: '2015-01-01' },
  balanced: { maxHeat: 20, before: '2015-01-01' },
  graph: { maxHeat: 20, before: '2015-01-01' },
};

const arg = (name, fallback = '') => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const policyName = arg('policy', 'conservative');
const policy = POLICY[policyName];
const apply = process.argv.includes('--apply');

if (!policy) {
  console.error(`未知策略：${policyName}，可选 ${Object.keys(POLICY).join(' / ')}`);
  process.exit(1);
}

const parseWindowData = (text, key) => {
  const hit = text.match(new RegExp(`window\\.${key}\\s*=\\s*(\\{[\\s\\S]*\\});`));
  if (!hit) throw new Error(`未找到 window.${key}`);
  return JSON.parse(hit[1]);
};

const raw = await readFile(FILE, 'utf8');
const data = parseWindowData(raw, 'GL_VNDB_EXTRA');
const list = Array.isArray(data.list) ? data.list : [];
const isLowOld = (x) => Number(x.h) < policy.maxHeat && Boolean(x.d) && String(x.d) < policy.before;

const beforeBytes = Buffer.byteLength(JSON.stringify(list), 'utf8');
const plan = { keep: [], drop: [], stats: null };

if (policyName !== 'graph') {
  list.forEach((x) => (isLowOld(x) ? plan.drop : plan.keep).push(x));
} else {
  // --- 读取主库锚点与关系图，缺一不可 ---
  let mainData;
  try {
    mainData = parseWindowData(await readFile(MAIN_FILE, 'utf8'), 'GL_VNDB');
  } catch (err) {
    console.error(`无法读取主库锚点 ${MAIN_FILE}：${err.message}`);
    process.exit(1);
  }
  let rel;
  try {
    rel = JSON.parse(await readFile(REL_FILE, 'utf8'));
  } catch (err) {
    console.error(`无法读取 VNDB 关系图 ${REL_FILE}：${err.message}`);
    console.error('请先运行 node scripts/fetch-vndb-relations.mjs 生成关系缓存，再重试。');
    process.exit(1);
  }
  if (!rel || typeof rel !== 'object' || !rel.edges || typeof rel.edges !== 'object') {
    console.error(`VNDB 关系图格式不正确（缺少 edges 对象）：${REL_FILE}`);
    process.exit(1);
  }
  const anchors = new Set(
    Object.values(mainData && mainData.map ? mainData.map : {})
      .map((o) => o && o.v)
      .filter(Boolean),
  );
  const byId = new Map(list.map((x) => [x.vx, x]));
  const ids = new Set(byId.keys());

  // 只保留两端都在扩展库内的边，视为无向图；同时记录与主库锚点相邻的扩展条目。
  // 注意关系可能只记录在主库一侧（实测 303 条锚点边中有 141 条如此），必须双向判断。
  const adj = new Map();
  ids.forEach((id) => adj.set(id, new Set()));
  const anchorLinked = new Set();
  const badEdges = [];
  Object.entries(rel.edges).forEach(([from, arr]) => {
    if (!Array.isArray(arr)) {
      badEdges.push(from);
      return;
    }
    arr.forEach((pair) => {
      const to = Array.isArray(pair) ? pair[0] : pair;
      if (typeof to !== 'string') return;
      if (ids.has(from) && anchors.has(to)) anchorLinked.add(from);
      if (anchors.has(from) && ids.has(to)) anchorLinked.add(to);
      if (!ids.has(from) || !ids.has(to)) return;
      adj.get(from).add(to);
      adj.get(to).add(from);
    });
  });
  if (badEdges.length) {
    console.warn(`警告：${badEdges.length} 个节点的关系值不是数组，已忽略。`);
  }

  // 连通分量（迭代 DFS，避免深链递归爆栈）
  const seen = new Set();
  const components = [];
  ids.forEach((start) => {
    if (seen.has(start)) return;
    seen.add(start);
    const stack = [start];
    const comp = [];
    while (stack.length) {
      const cur = stack.pop();
      comp.push(cur);
      adj.get(cur).forEach((nb) => {
        if (!seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      });
    }
    components.push(comp);
  });

  const stats = {
    components: components.length,
    multiComponents: 0,
    protectedComponents: 0,
    affectedComponents: 0,
    keptByGroup: 0,
    keptByRepresentative: 0,
    droppedSingletons: 0,
  };
  const dropIds = new Set();

  components.forEach((comp) => {
    if (comp.length > 1) stats.multiComponents += 1;
    const items = comp.map((v) => byId.get(v));
    const linkedToMain = comp.some((v) => anchorLinked.has(v));
    const hasFreshOrHot = items.some((x) => !isLowOld(x));

    if (linkedToMain || hasFreshOrHot) {
      // 系列完整性优先：整组保留
      if (linkedToMain) stats.protectedComponents += 1;
      stats.keptByGroup += items.filter(isLowOld).length;
      items.forEach((x) => plan.keep.push(x));
      return;
    }

    // 孤立单点没有系列可保：按 balanced 直接删除，避免「自己代表自己」导致永远不裁剪
    if (comp.length === 1) {
      stats.droppedSingletons += 1;
      dropIds.add(items[0].vx);
      plan.drop.push(items[0]);
      return;
    }

    // 整组都是冷门老作：留一部代表（h 最高，并列取 d 最新）
    const sorted = [...items].sort((a, b) => {
      const dh = Number(b.h) - Number(a.h);
      if (dh) return dh;
      return String(b.d || '').localeCompare(String(a.d || ''));
    });
    const [rep, ...rest] = sorted;
    stats.keptByRepresentative += 1;
    stats.affectedComponents += 1;
    plan.keep.push(rep);
    rest.forEach((x) => {
      dropIds.add(x.vx);
      plan.drop.push(x);
    });
  });

  // 恢复原库顺序，避免写回时条目乱序
  plan.keep = list.filter((x) => !dropIds.has(x.vx));
  plan.stats = stats;
}

const afterBytes = Buffer.byteLength(JSON.stringify(plan.keep), 'utf8');
const avgBytes = list.length ? beforeBytes / list.length : 0;
const freedKB = (beforeBytes - afterBytes) / 1024;
const coverage = (arr) => {
  const tags = new Set();
  arr.forEach((x) => {
    if (Array.isArray(x.tg)) x.tg.forEach((t) => tags.add(t));
  });
  return tags.size;
};

if (policyName === 'graph') {
  const s = plan.stats;
  console.log(`策略 graph：balanced（h < ${policy.maxHeat} 且发售日 < ${policy.before}）+ 关系图保护`);
  console.log(`连通分量 ${s.components} 个（多节点 ${s.multiComponents} 个），其中 ${s.protectedComponents} 个连接主库锚点受保护`);
  console.log(`条数 ${list.length} → ${plan.keep.length}（删除 ${plan.drop.length}，保留 ${plan.keep.length}）`);
  console.log(`  · 因分量受保护而保留：${s.keptByGroup} 条`);
  console.log(`  · 因代表条目而保留：${s.keptByRepresentative} 条（来自 ${s.affectedComponents} 个全冷门多部件分量）`);
  console.log(`  · 孤立单点删除：${s.droppedSingletons} 条`);
  console.log(`  · 对比纯 balanced：${plan.drop.length} 条被删（原应删 ${list.filter(isLowOld).length} 条）`);
} else {
  console.log(`策略 ${policyName}：h < ${policy.maxHeat} 且发售日 < ${policy.before}`);
  console.log(`条数 ${list.length} → ${plan.keep.length}（删除 ${plan.drop.length}，保留 ${plan.keep.length}）`);
}
console.log(`体积约 ${(beforeBytes / 1024).toFixed(0)}KB → ${(afterBytes / 1024).toFixed(0)}KB（释放 ${freedKB.toFixed(0)}KB，均价 ${avgBytes.toFixed(0)}B/条）`);
if (policyName === 'graph') {
  console.log(`题材标签覆盖 ${coverage(list)} → ${coverage(plan.keep)}`);
}

if (!apply) {
  console.log('当前为预演模式，未写入文件；确认后加 --apply。');
  process.exit(0);
}

data.list = plan.keep;
data.meta.count = plan.keep.length;
data.meta.prune = {
  at: new Date().toISOString(),
  policy: policyName,
  maxHeat: policy.maxHeat,
  before: policy.before,
  removed: plan.drop.length,
  freedKB: Number(freedKB.toFixed(1)),
};
if (policyName === 'graph') {
  data.meta.prune.graph = {
    components: plan.stats.components,
    protectedComponents: plan.stats.protectedComponents,
    affectedComponents: plan.stats.affectedComponents,
    keptByGroup: plan.stats.keptByGroup,
    keptByRepresentative: plan.stats.keptByRepresentative,
    droppedSingletons: plan.stats.droppedSingletons,
  };
}
const content = '// 由 scripts/fetch-vndb-extra.mjs 生成，请勿手动修改\n' +
  'window.GL_VNDB_EXTRA = ' + JSON.stringify(data) + ';\n';
// 先写临时文件再原子替换，避免写入中断留下半截文件
const tmpFile = `${FILE}.tmp`;
await writeFile(tmpFile, content, 'utf8');
await rename(tmpFile, FILE);
console.log(`已写入 ${FILE}`);
