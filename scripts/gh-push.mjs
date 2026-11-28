// 通过 gh api（可用通道）把本地 HEAD 的改动推送到 GitHub，不依赖 git 的 HTTPS 传输
// 用法：
//   node scripts/gh-push.mjs                                   发布：推送 HEAD~1..HEAD 并创建版本标签
//   node scripts/gh-push.mjs --no-tag                          只同步 HEAD~1..HEAD，不建标签
//   node scripts/gh-push.mjs --from origin/main --no-tag \
//     --message "docs: ..."                                    把一段本地提交一次性同步到 main
//   node scripts/gh-push.mjs ... --dry-run                     只打印计划，不调用写接口
// 约定：先本地 commit，再运行；发布模式要求工作区干净，且同版本标签不存在。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = 'xyykmkefke/galgame-library';
// 相对定位仓库根目录，不再硬编码绝对路径（迁移前后均可运行）
const ROOT = path.resolve(import.meta.dirname, '..');
const TAG = 'v' + JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const tmp = mkdtempSync(path.join(tmpdir(), 'gh-push-'));

function fail(message) {
  console.error('\n[gh-push] ' + message);
  process.exit(2);
}

function argValue(name) {
  const i = process.argv.indexOf(name);
  if (i < 0) return null;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) fail(`${name} 需要一个值`);
  return value;
}

const FROM = argValue('--from') || 'HEAD~1';
const MESSAGE = argValue('--message') || argValue('-m');
const NO_TAG = process.argv.includes('--no-tag');
const DRY = process.argv.includes('--dry-run');

// 工作区必须干净：脚本只读 HEAD，未提交改动不会被推送
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (dirty) fail('工作区有未提交改动，先 commit 再推送：\n' + dirty);

function gh(args, input) {
  const full = ['api', ...args];
  if (input) {
    const file = path.join(tmp, 'body-' + Math.random().toString(36).slice(2) + '.json');
    writeFileSync(file, JSON.stringify(input));
    full.push('--input', file);
  }
  return execFileSync('gh', full, { encoding: 'utf8', timeout: 60000 }).trim();
}

function ghJson(args, input) {
  return JSON.parse(gh(args, input));
}

// 校验同步起点：必须存在，且是 HEAD 的祖先
try {
  execFileSync('git', ['rev-parse', '--verify', `${FROM}^{commit}`], { cwd: ROOT, stdio: 'ignore' });
} catch {
  fail(`--from 引用不存在：${FROM}`);
}
try {
  execFileSync('git', ['merge-base', '--is-ancestor', FROM, 'HEAD'], { cwd: ROOT, stdio: 'ignore' });
} catch {
  // 经 gh API 推送后本地/远端历史会分叉，--from origin/main 通常不是 HEAD 祖先；
  // 这里按 tree 差异同步，最终仍会用远端 tree 与本地 HEAD tree 严格比对。
  console.log(`[gh-push] 提示：--from ${FROM} 不是 HEAD 的祖先，将按 tree 差异同步。`);
}

// 用 name-status 区分新增/修改/删除：删除的文件不能读取内容，
// 在 Git tree API 中以 sha: null 表示从远端移除。
// core.quotepath=false：避免中文文件名被转义成 "\347\225\..." 导致路径匹配失败
const rawFiles = execFileSync('git', ['-c', 'core.quotepath=false', 'diff', '--name-status', FROM, 'HEAD'], {
  cwd: ROOT, encoding: 'utf8',
}).trim().split(/\r?\n/).filter(Boolean);
const files = [];
for (const line of rawFiles) {
  const [status, ...rest] = line.split('\t');
  if (status.startsWith('R') || status.startsWith('C')) {
    // 重命名/复制是两个路径：旧路径要删，新路径要写
    const [from, to] = rest;
    files.push({ status: 'D', path: from });
    files.push({ status: status.startsWith('R') ? 'A' : 'A', path: to });
    continue;
  }
  files.push({ status, path: rest.join('\t') });
}

if (!files.length) {
  fail(`${FROM}..HEAD 没有文件变更，请先 commit。`);
}

const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const rangeCount = Number(execFileSync('git', ['rev-list', '--count', `${FROM}..HEAD`], {
  cwd: ROOT, encoding: 'utf8',
}).trim());

let subject;
let body;
if (MESSAGE) {
  subject = MESSAGE;
  body = '';
} else if (FROM === 'HEAD~1' && rangeCount === 1) {
  subject = execFileSync('git', ['log', '-1', '--pretty=%s'], { cwd: ROOT, encoding: 'utf8' }).trim();
  body = execFileSync('git', ['log', '-1', '--pretty=%b'], { cwd: ROOT, encoding: 'utf8' }).trim();
} else {
  subject = `sync: ${FROM}..HEAD（${rangeCount} 个提交）`;
  body = execFileSync('git', ['log', '--reverse', '--pretty=- %h %s', `${FROM}..HEAD`], {
    cwd: ROOT, encoding: 'utf8',
  }).trim();
}
const authorName = execFileSync('git', ['config', 'user.name'], { cwd: ROOT, encoding: 'utf8' }).trim();
const authorEmail = execFileSync('git', ['config', 'user.email'], { cwd: ROOT, encoding: 'utf8' }).trim();

console.log('仓库根目录:', ROOT);
console.log('同步范围:', `${FROM}..HEAD（${rangeCount} 个提交）`);
console.log('提交信息:', subject);
if (body) console.log('提交正文:\n' + body);
console.log('待同步文件:', files.map((f) => `${f.status} ${f.path}`).join(', '));
console.log('版本标签:', NO_TAG ? '跳过（--no-tag）' : TAG);

if (DRY) {
  console.log('\n[dry-run] 未调用任何写接口。');
  process.exit(0);
}

// 标签已存在说明该版本已发布过：拒绝重跑，避免把 main 再推一遍或把 tag 指错提交
if (!NO_TAG) {
  const localTag = execFileSync('git', ['tag', '--list', TAG], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (localTag) fail(`本地已存在标签 ${TAG}，拒绝重复发布；如需修复请升版本后重试。`);

  try {
    ghJson([`repos/${REPO}/git/ref/tags/${TAG}`]);
    fail(`远端已存在标签 ${TAG}，拒绝重复发布；如需修复请升版本后重试。`);
  } catch (e) {
    const msg = String(e.stderr || e.message || '');
    if (!/404|Not Found/i.test(msg)) fail('无法确认远端标签是否存在：' + msg.trim());
  }
}

const ref = ghJson([`repos/${REPO}/git/ref/heads/main`]);
const baseCommit = ref.object.sha;
const base = ghJson([`repos/${REPO}/git/commits/${baseCommit}`]);
console.log('远端基线:', baseCommit.slice(0, 7), '本地提交:', headSha.slice(0, 7));

const tree = [];
for (const { status, path: rel } of files) {
  if (status === 'D') {
    // Git tree API：sha=null 表示删除该路径
    tree.push({ path: rel, mode: '100644', type: 'blob', sha: null });
    console.log('delete', rel);
    continue;
  }
  // 必须读「入库形态」而不是工作区原始字节：
  // core.autocrlf=true 时工作区是 CRLF、仓库里是 LF，用 readFileSync 上传会让远端 blob
  // 与本地 HEAD 的 blob 哈希不同，tree 校验必然失败（表现为「构造的 remote tree 与本地 HEAD 不一致」）。
  // git cat-file blob 直接取索引/对象里已做过换行归一的那份，字节与 HEAD 完全一致。
  const content = execFileSync('git', ['cat-file', 'blob', `HEAD:${rel}`], {
    cwd: ROOT, maxBuffer: 256 * 1024 * 1024,
  });
  // mode 取 HEAD 里的真实值，别硬编码 100644：可执行位不同同样会让 tree 校验失败
  const mode = execFileSync('git', ['ls-tree', 'HEAD', '--', rel], { cwd: ROOT, encoding: 'utf8' })
    .trim().split(/\s+/)[0] || '100644';
  const blob = ghJson([`--method`, 'POST', `repos/${REPO}/git/blobs`], {
    content: content.toString('base64'),
    encoding: 'base64',
  });
  tree.push({ path: rel, mode, type: 'blob', sha: blob.sha });
  console.log('blob', rel, blob.sha.slice(0, 7));
}

const newTree = ghJson([`--method`, 'POST', `repos/${REPO}/git/trees`], {
  base_tree: base.tree.sha,
  tree,
});

// 先比对新 tree 与本地 HEAD tree，不一致说明远端基线已分叉，直接中止且不移动 main
const localTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: ROOT, encoding: 'utf8' }).trim();
if (newTree.sha !== localTree) {
  fail(`构造的 remote tree 与本地 HEAD 不一致，已中止：${newTree.sha} != ${localTree}`);
}

const commit = ghJson([`--method`, 'POST', `repos/${REPO}/git/commits`], {
  message: subject + (body ? '\n\n' + body : ''),
  tree: newTree.sha,
  parents: [baseCommit],
  author: { name: authorName, email: authorEmail, date: new Date().toISOString() },
  committer: { name: authorName, email: authorEmail, date: new Date().toISOString() },
});
gh([`--method`, 'PATCH', `repos/${REPO}/git/refs/heads/main`], {
  sha: commit.sha,
  force: false,
});
console.log('已更新 main →', commit.sha);

const after = ghJson([`repos/${REPO}/git/ref/heads/main`]);
if (after.object.sha !== commit.sha) fail(`远端 main 更新后校验失败：${after.object.sha} != ${commit.sha}`);
console.log('tree 校验一致:', localTree);

// 记录本次实际推送的远端状态：origin/main 跟踪引用可能因网络滞后，doctor 以此为准
try {
  writeFileSync(path.join(ROOT, '.git', 'yuc-remote-state.json'), JSON.stringify({
    repo: REPO,
    main: commit.sha,
    tree: localTree,
    updatedAt: new Date().toISOString(),
  }, null, 2));
  console.log('已记录远端状态 → .git/yuc-remote-state.json');
} catch (e) {
  console.log('远端状态记录失败（不影响发布）：' + String(e.message).slice(0, 80));
}

// 同步本地跟踪引用：先尝试 fetch 取得 API 创建的提交对象；失败则只提示，不影响已完成的推送
let fetched = false;
try {
  execFileSync('git', ['fetch', 'origin', 'main'], { cwd: ROOT, stdio: 'ignore', timeout: 15000 });
  fetched = true;
} catch {}
try {
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', commit.sha], { cwd: ROOT, stdio: 'ignore' });
  console.log('已更新本地 origin/main →', commit.sha.slice(0, 7));
} catch {
  console.log(`远端 main 已更新；本地 origin/main 未同步（对象尚未取回${fetched ? '' : '，git fetch 失败'}）。`);
}

if (NO_TAG) {
  console.log('已跳过标签创建（--no-tag）');
} else {
  const tag = ghJson([`--method`, 'POST', `repos/${REPO}/git/tags`], {
    tag: TAG,
    message: TAG,
    object: commit.sha,
    type: 'commit',
    tagger: { name: authorName, email: authorEmail, date: new Date().toISOString() },
  });
  try {
    gh([`--method`, 'POST', `repos/${REPO}/git/refs`], {
      ref: `refs/tags/${TAG}`,
      sha: tag.sha,
    });
    console.log('已创建标签', TAG);
  } catch (e) {
    // 重跑或并发时 ref 可能已存在：只有确认它指向本次提交才算成功，否则必须非零退出
    let existing = null;
    try {
      const ref = ghJson([`repos/${REPO}/git/ref/tags/${TAG}`]);
      existing = ref.object.type === 'tag'
        ? ghJson([`repos/${REPO}/git/tags/${ref.object.sha}`]).object.sha
        : ref.object.sha;
    } catch {}
    if (existing !== commit.sha) {
      fail(
        `标签 ${TAG} 创建失败：${String(e.message).split('\n')[0]}\n` +
        `main 已推进到 ${commit.sha.slice(0, 7)}，但标签缺失或指向其他提交。\n` +
        `请单独补建该标签（gh api repos/${REPO}/git/refs），不要重跑本脚本。`,
      );
    }
    console.log(`标签 ${TAG} 已存在且指向 ${commit.sha.slice(0, 7)}，视为成功`);
  }
}

// ── 收尾自检：CI 到底有没有跑起来，Pages 有没有重新构建 ────────────────────────
//
// 为什么必须写在脚本里、而不是写在交接文档里让人记住：
// 用 Git Data API PATCH refs/heads/main 时，GitHub **有时**生成 push 事件、有时不生成。
// 2026-11-28 同一天三次推送实测：
//   4de0c49 (06:01) → 没有 push 事件，CI 没跑，只能手动 dispatch 补
//   03e8e1a (06:08) → 有 push 事件，CI 自动跑
//   0b4f32d (08:08) → 有 push 事件，CI 自动跑
// 所以「一定不触发」（旧版 43.2.1 的结论）和「push 会自动跑」都是错的：
// 它是**不可依赖**的。凡是不可依赖的环节，就不能交给人的记忆去兜底 ——
// 忘了的后果是线上静默停在旧版本，而脚本、远端 SHA、tree 校验全部显示成功。
//
// 因此这里主动查一次：有该 SHA 的 run 就报「已自动触发」；没有就补 dispatch。
// 查不到但也没补成功，属于必须让人知道的失败，用非零退出。
function listRunsFor(lookback) {
  const raw = execFileSync('gh', [
    'run', 'list', '--workflow=ci.yml', '--limit', String(lookback),
    '--json', 'databaseId,headSha,status,conclusion,event',
  ], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return JSON.parse(raw || '[]');
}

if (DRY) {
  console.log('（--dry-run：跳过 CI/Pages 自检）');
} else {
  try {
    // 等一小会儿再查：push 事件触发的 run 不是瞬时可见的，偶尔要十几秒才出现在列表里。
    // 不用 execFileSync('sleep')：Windows 上不保证有 sleep.exe，跨平台会直接抛错。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
    const runs = listRunsFor(12);
    const mine = runs.filter((r) => r.headSha === commit.sha);
    if (mine.length) {
      console.log(`CI 已自动触发：${mine.map((r) => `${r.event}#${r.databaseId}`).join(', ')}`);
    } else {
      console.log('CI 未自动触发（本次 ref 更新没有产生 push 事件），手动补触发…');
      gh(['workflow', 'run', 'ci.yml', '--ref', 'main']);
      const retry = listRunsFor(12).filter((r) => r.headSha === commit.sha);
      if (retry.length) {
        console.log(`已补触发 CI：${retry.map((r) => `${r.event}#${r.databaseId}`).join(', ')}`);
      } else {
        fail(
          '补触发 CI 后仍查不到该 commit 的 run。\n' +
          `commit ${commit.sha.slice(0, 7)} 已在远端，请手动确认：\n` +
          '  gh run list --workflow=ci.yml --limit 5\n' +
          '  gh workflow run ci.yml --ref main',
        );
      }
    }

    // Pages 是 legacy 构建，没有 workflow_dispatch 可调，只能 POST 一次构建请求。
    // 重复请求无害（同一 commit 的构建会被合并），所以不用先判断有没有跑。
    const before = (() => {
      try { return ghJson([`repos/${REPO}/pages/builds/latest`]); } catch { return null; }
    })();
    if (before && before.commit === commit.sha && before.status === 'built') {
      console.log('Pages 已为本次 commit 构建完成');
    } else {
      try {
        gh(['-X', 'POST', `repos/${REPO}/pages/builds`]);
        console.log('已请求 Pages 重新构建（legacy 构建无法用 workflow_dispatch）');
      } catch (e) {
        // Pages 请求失败不该让「代码已推上去」这件事变成失败：明确告知即可
        console.log('Pages 构建请求失败，请手动补：' + String(e.message).split('\n')[0]);
      }
    }
    console.log('\n线上核验（Pages 构建需 1–3 分钟）：');
    console.log('  curl -s https://xyykmkefke.github.io/galgame-library/ | grep \'name="version"\'');
  } catch (e) {
    console.log('CI/Pages 自检出错（代码已推送成功，请手动核对）：' + String(e.message).split('\n')[0]);
  }
}
