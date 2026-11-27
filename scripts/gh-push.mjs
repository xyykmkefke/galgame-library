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
