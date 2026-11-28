// 自动化验收：启动本地静态服务 + Edge 无头浏览器，通过 CDP 跑核心交互检查
// 用法：node scripts/verify.mjs [--keep]
// 退出码 0 表示全部通过，1 表示存在失败项

import http from 'node:http';
import net from 'node:net';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE_PORT = 8792;
const BASE_CDP_PORT = 9338;
// 端口在运行时才最终确定（见 listenWithFallback / pickFreePort）：
// 上一个进程刚退出时端口常处于 TIME_WAIT，直接 listen 会 EADDRINUSE 整轮失败。
// 端口进不了页面（页面走相对路径），顺延端口不影响任何断言。
let PORT = BASE_PORT;
let CDP_PORT = BASE_CDP_PORT;
const KEEP = process.argv.includes('--keep');

const EDGE_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
].filter(Boolean);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 在页面里求值时复用的「制作人员字段解码」片段。
// sc/ar/mu 有两种存法：主库是「、」分隔字符串，扩展库（v2.40.0 起）是词典 id 数组。
// 断言里若仍写 x[k].split('、')，对数组会直接抛 TypeError；即便不抛也会把 5737 条扩展库
// 全部漏掉，于是「期望值」和「页面真实渲染」用的是两套口径——断言照样全绿，但测的不是同一件事。
// 所以这里统一成与 index.html staffValues() 同规则的实现，供各处断言注入。
const STAFF_JS = `const staffOf = (x, k) => {
  const v = x && x[k];
  if (Array.isArray(v)) {
    const d = (window.GL_VNDB_EXTRA && window.GL_VNDB_EXTRA.staffDict) || [];
    return v.map((i) => d[i]).filter((n) => typeof n === 'string' && n);
  }
  return String(v || '').split('、').map((s) => s.trim()).filter(Boolean);
};`;

// 注入页面的 GitHub API mock：只拦截 api.github.com，其余请求原样放行
const MOCK_GIST_SCRIPT = `(() => {
  var FILE = 'yuc-galgame-list.json';
  var state = { gist: null, mode: '', writes: 0 };
  window.__mockGist = state;
  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.indexOf('https://api.github.com') !== 0) return realFetch(input, init);
    var method = ((init && init.method) || 'GET').toUpperCase();
    var reply = function (obj, status) {
      return Promise.resolve(new Response(JSON.stringify(obj), {
        status: status || 200,
        headers: { 'Content-Type': 'application/json' }
      }));
    };
    if (state.mode === '401') return reply({ message: 'Bad credentials' }, 401);
    if (state.mode === '403') return reply({ message: 'Forbidden' }, 403);
    if (method === 'GET') {
      if (!state.gist) return reply({ message: 'Not Found' }, 404);
      var files = {};
      files[FILE] = { content: JSON.stringify(state.gist) };
      return reply({ id: 'mockgist123', files: files });
    }
    var body = init && init.body ? JSON.parse(init.body) : {};
    var content = body.files && body.files[FILE] ? body.files[FILE].content : '';
    if (content) state.gist = JSON.parse(content);
    state.writes += 1;
    return reply({ id: 'mockgist123' });
  };
})();`;

function findBrowser() {
  const found = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!found) throw new Error('未找到 Edge/Chrome，可执行文件不存在');
  return found;
}

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/') pathname = '/index.html';
      const file = path.join(ROOT, pathname);
      const rel = path.relative(ROOT, file);
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('forbidden');
      const data = await readFile(file);
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    }
  });
  return server;
}

// 找一个能监听的端口：默认用 BASE_PORT，被占用就向后顺延几个。
async function listenWithFallback(server) {
  for (let i = 0; i < 12; i += 1) {
    const port = BASE_PORT + i;
    const ok = await new Promise((resolve) => {
      const onErr = (e) => { server.removeListener('listening', onOk); resolve(e.code !== 'EADDRINUSE'); };
      const onOk = () => { server.removeListener('error', onErr); resolve(true); };
      server.once('error', onErr);
      server.once('listening', onOk);
      server.listen(port, '127.0.0.1');
    });
    if (ok && server.listening) { PORT = port; return port; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`端口 ${BASE_PORT}~${BASE_PORT + 11} 都被占用，无法启动静态服务`);
}

// CDP 端口同理：浏览器绑定失败时只会静默退出，表现为「无法连接到浏览器调试端口」，
// 与真正的浏览器崩溃难以区分。先探一个闲置端口再用。
async function pickFreePort(base) {
  for (let i = 0; i < 12; i += 1) {
    const port = base + i;
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    if (free) return port;
  }
  throw new Error(`CDP 端口 ${base}~${base + 11} 都被占用`);
}

async function getDebugPage() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
      const pages = await res.json();
      const page = pages.find((t) => t.type === 'page' && String(t.url).includes(`:${PORT}`));
      if (page && page.webSocketDebuggerUrl) return page;
    } catch {}
    await sleep(250);
  }
  throw new Error('无法连接到浏览器调试端口');
}

function createCdp(ws) {
  let seq = 0;
  const pending = new Map();
  const events = [];

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method) events.push(msg);
  };

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++seq;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (res.result?.exceptionDetails) {
      throw new Error('页面脚本异常：' + JSON.stringify(
        res.result.exceptionDetails.exception?.description || res.result.exceptionDetails.text));
    }
    return res.result?.result?.value;
  };

  return { send, evaluate, events, clearEvents: () => { events.length = 0; } };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  → ' + detail : ''}`);
}

// 杀掉本次验收启动的整个浏览器进程树。
//
// 为什么不能只 taskkill /PID child.pid /T：
//   Edge 首次用新的 --user-data-dir 启动时，spawn 出来的可能只是 launcher，
//   它拉起真正的 browser 进程后自己就退了。child.pid 一旦失效，`/T` 无从展开子树，
//   一个子进程都杀不到 —— 但 taskkill 仍返回 0，从外部看像「已经处理过了」。
//   现象是临时 profile 一直被占、rm 报 EBUSY，容易被误判成「Edge 子进程没杀干净」。
//   实测 2026-11-27：跑完一轮后残留 11 个 msedge.exe 仍引用着临时 profile。
//
// 兜底判据：命令行里含本轮 profile 的**目录名**。不依赖父子关系，也不依赖 pid 存活。
// 注意 PowerShell 的 -like 里 `\` 是字面量、不要转义（曾把路径的反斜杠写成双反斜杠，
// 导致匹配恒假、兜底静默失效，且因为 stdio 是 ignore 连报错都没有）。
// 用 PowerShell 而非 wmic：新版 Windows 已移除 wmic。
function killBrowserTree(child, profileDir) {
  if (process.platform !== 'win32') {
    try { child?.kill('SIGTERM'); } catch {}
    return;
  }
  // 先按 pid 试一次（正常情况够用，也最快）
  if (child && child.pid) {
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
  // 再按 profile 目录名兜底，覆盖 launcher 模式
  const tag = path.basename(profileDir);
  const ps = [
    'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'"',
    `| Where-Object { $_.CommandLine -like '*${tag}*' }`,
    '| ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }',
  ].join(' ');
  try {
    spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore' });
  } catch {}
}

async function main() {
  const browser = findBrowser();
  // profile 每次运行都用独立目录（pid + 时间戳）。
  // 早先写死 'galgame-verify-profile'，连跑第二次会撞上一次还没退干净的浏览器锁，
  // rm 抛 EBUSY（实测 ...\galgame-verify-profile\Functional SAN Data），整轮直接失败。
  // 而且这里原本是 try 之外的裸 await，一旦抛错 finally 根本不执行，
  // 浏览器进程和端口全部泄漏，下一次运行继续撞——三个问题互相放大。
  const profile = path.join(os.tmpdir(), 'galgame-verify-profile-' + process.pid + '-' + Date.now());
  const shots = path.join(ROOT, '.verify');
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });

  const server = await startServer();
  const port = await listenWithFallback(server);
  if (port !== BASE_PORT) console.log(`提示：端口 ${BASE_PORT} 被占用，改用 ${port}`);
  CDP_PORT = await pickFreePort(BASE_CDP_PORT);
  if (CDP_PORT !== BASE_CDP_PORT) console.log(`提示：CDP 端口 ${BASE_CDP_PORT} 被占用，改用 ${CDP_PORT}`);
  let child = null;
  let ws = null;

  try {
    child = spawn(
      browser,
      [
        '--headless=new',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        // 扩展必须禁用：即便用全新 profile，Windows 上的 Edge 仍会加载内置组件扩展，
        // 它们注入的 content script 会抛「listener indicated an asynchronous response …
        // message channel closed」，被「全程无 JS 异常」误判成页面缺陷。
        // 实测 2026-11-27：同一份代码先后两次运行，一次 234/234、一次 233/234 卡在这条，
        // 差别只在有没有撞上组件扩展的注入时机——属环境噪音，不是页面问题。
        // 番剧项目（../番剧/scripts/verify.mjs）踩过同一个坑，这里照搬同一个修法。
        '--disable-extensions',
        '--disable-component-extensions-with-background-pages',
        ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : []),
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${profile}`,
        '--window-size=1440,1100',
        `http://127.0.0.1:${PORT}/`,
      ],
      { stdio: 'ignore' },
    );

    const page = await getDebugPage();
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const cdp = createCdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK_GIST_SCRIPT });

    const waitFor = async (expression, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        try {
          if (await cdp.evaluate(expression)) return true;
        } catch {}
        await sleep(120);
      }
      return false;
    };

    const shot = async (name) => {
      const res = await cdp.send('Page.captureScreenshot', { format: 'png' });
      if (res.result?.data) await writeFile(path.join(shots, name + '.png'), Buffer.from(res.result.data, 'base64'));
    };

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    await waitFor("document.querySelectorAll('.card').length > 0", 15000);
    await waitFor("window.__FULL_DATA_READY === true", 20000);

    // ---------- 数据与首屏 ----------
    const total = await cdp.evaluate('(window.GL_DATA || []).filter((x) => x.k !== "off").length');
    const hiddenNonGal = await cdp.evaluate('(window.GL_DATA || []).filter((x) => x.k === "off").length');
    // 数量不写死：黑名单会随数据核查增删，写死 35 这种字面量每次清理都要改断言。
    // 改为校验「黑名单与主库的交集全部被隐藏」，以及 meta 计数与实际一致，
    // 这样断言跟着数据走，但确实能抓到「标记漏了 / 没同步 meta」的解。
    // 注意黑名单里可能有根本不存在的 id（如「火焰之纹章if 暗夜/白夜王国」被标签门槛先挡掉了），
    // 所以比的是交集，不是黑名单长度。
    const blocklistIds = (() => {
      try {
        const raw = readFileSync(path.join(ROOT, 'data', 'blocklist-main.json'), 'utf8');
        return (JSON.parse(raw).items || []).map((x) => Number(x.i)).filter(Boolean);
      } catch { return null; }
    })();
    const nonGalSynced = await cdp.evaluate(
      '(() => { const d = window.GL_DATA || [];' +
      ' return [[...new Set(d.filter((x) => x.k === "off").map((x) => x.i))],' +
      ' (window.GL_META || {}).nonGalMarked || 0]; })()');
    const offIds = new Set(nonGalSynced[0]);
    let missHide = 0;
    if (blocklistIds) {
      const allIds = new Set(await cdp.evaluate('(window.GL_DATA || []).map((x) => x.i)'));
      missHide = blocklistIds.filter((id) => allIds.has(id) && !offIds.has(id)).length;
    }
    check('默认隐藏非 gal 条目',
      hiddenNonGal > 0 && nonGalSynced[0].length === nonGalSynced[1] && missHide === 0,
      `隐藏 ${hiddenNonGal} 部 / meta 记 ${nonGalSynced[1]}` +
      (blocklistIds ? ` / 黑名单 ${blocklistIds.length} 条，该隐藏未隐藏 ${missHide} 条` : ''));
    const metaCount = await cdp.evaluate('(window.GL_META || {}).count || 0');
    const extraCount = await cdp.evaluate('((window.GL_VNDB_EXTRA || {}).list || []).length');
    const bgmExtraCount = await cdp.evaluate('((window.GL_BGM_EXTRA || {}).list || []).length');
    const recentCount = await cdp.evaluate('((window.GL_RECENT || {}).list || []).length');
    check('全库数据加载', total > 3000 && metaCount + extraCount + bgmExtraCount + recentCount === total + hiddenNonGal,
      (total + hiddenNonGal) + ' 条（主库 ' + metaCount + ' + VNDB ' + extraCount + ' + 关联 ' + bgmExtraCount +
      ' + 新作 ' + recentCount + '，默认可见 ' + total + '）');

    const noCacheFields = await cdp.evaluate(
      "(() => (window.GL_DATA || []).slice(0, 200).every((x) => x.rt === undefined && x.plr === undefined && x.gc === undefined && x.wc === undefined))()");
    check('最终数据无缓存字段泄漏', noCacheFields === true);

    const platsClean = await cdp.evaluate(
      "(() => { const bad=new Set(['windows','win','安卓','8','10','其他','未知']); const all=[]; (window.GL_DATA||[]).forEach((x)=>(x.pl||[]).forEach((p)=>all.push(p))); const junk=all.filter((p)=>bad.has(String(p).toLowerCase())||/^\\d+$/.test(p)); return [new Set(all).size, junk.length]; })()");
    check('平台名已归一且无数字碎片', platsClean[0] > 8 && platsClean[1] === 0, platsClean.join(' / '));

    const plCover = await cdp.evaluate(
      "(() => { const d=window.GL_DATA||[]; return d.length ? d.filter((x)=>x.pl&&x.pl.length).length/d.length : 0; })()");
    check('平台覆盖率 ≥95%', plCover >= 0.95, (plCover * 100).toFixed(1) + '%');

    const devCover = await cdp.evaluate(
      "(() => { const d=window.GL_DATA||[]; return d.length ? d.filter((x)=>x.dev&&x.dev.length).length/d.length : 0; })()");
    check('开发商覆盖率 ≥75%', devCover >= 0.75, (devCover * 100).toFixed(1) + '%');

    const devAlias = await cdp.evaluate(
      "(() => { const d=window.GL_DATA||[]; return [" +
      "d.filter((x)=>(x.dev||[]).includes('AliceSoft')).length," +
      "d.filter((x)=>(x.dev||[]).includes('Alice Soft')).length," +
      "d.filter((x)=>(x.dva||[]).includes('Alice Soft')).length]; })()");
    check('开发商别名已归一', devAlias[0] >= 60 && devAlias[1] === 0 && devAlias[2] >= 50,
      'AliceSoft ' + devAlias[0] + ' / 旧名 ' + devAlias[1] + ' / 原名保留 ' + devAlias[2]);

    // 日期允许两种精度：完整日期 2025-03-14，或只有年份 2025（VNDB 未公布月日，仅新作索引会出现）
    const datesOk = await cdp.evaluate(
      "(() => (window.GL_DATA||[]).every((x)=>!x.d || /^\\d{4}-\\d{2}-\\d{2}$/.test(x.d) || (x.rn === 1 && /^\\d{4}$/.test(x.d))))()");
    check('发售日格式全部合法', datesOk === true);

    // 年份精度只允许出现在新作索引里，且必须有对应的时间标签，避免渲染成「2028-01-01」误导
    const yearOnly = await cdp.evaluate(
      "(() => { const d=(window.GL_DATA||[]).filter((x)=>/^\\d{4}$/.test(String(x.d||''))); " +
      "return [d.length, d.filter((x)=>x.rn===1).length]; })()");
    check('年份精度日期仅来自新作索引', yearOnly[0] === yearOnly[1], yearOnly.join(' / '));


    // 题材覆盖率按主库 + 扩展库统计：新作索引的题材受 VNDB 冷启动限制（无票即无标签），单列门槛
    const genreCover = await cdp.evaluate(
      "(() => { const d=(window.GL_DATA||[]).filter((x)=>x.rn!==1); " +
      "return d.length ? d.filter((x)=>x.tg&&x.tg.length).length/d.length : 0; })()");
    check('题材覆盖率 ≥80%', genreCover >= 0.80, (genreCover * 100).toFixed(1) + '%');
    const recentGenreCover = await cdp.evaluate(
      "(() => { const d=(window.GL_DATA||[]).filter((x)=>x.rn===1); " +
      "return [d.length, d.filter((x)=>x.tg&&x.tg.length).length]; })()");
    // 新作票数少 → VNDB 标签权重不足 0.5 → 无题材可映射。这是数据源冷启动的客观限制，
    // 门槛只用于兜住「映射规则整体失效」这类回归，不追求高覆盖
    check('新作题材有兜底覆盖（≥30%）',
      recentGenreCover[0] === 0 || recentGenreCover[1] / recentGenreCover[0] >= 0.30,
      recentGenreCover[1] + ' / ' + recentGenreCover[0] +
      ' (' + (recentGenreCover[0] ? (recentGenreCover[1] / recentGenreCover[0] * 100).toFixed(1) : 0) + '%)');

    const metaHelp = await cdp.evaluate('JSON.stringify(window.GL_META || {})');
    check('数据元信息含生成时间与日期范围', /generatedAt/.test(metaHelp) && /minDate/.test(metaHelp), metaHelp.slice(0, 80));

    const cards = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('首屏分批渲染 240 张卡片', cards === 240, cards + ' 张');

    const coverFallback = await cdp.evaluate("document.querySelectorAll('.cover img[data-fb]').length");
    check('封面支持月幕主图兜底', coverFallback > 0, coverFallback + ' 张');

    const pyReady = await cdp.evaluate('!!(window.GL_DATA || []).find((x) => x.py)');
    check('数据包含拼音首字母字段', pyReady === true);

    const resultbar = await cdp.evaluate("document.getElementById('resultbar').textContent");
    check('结果栏显示条目统计', resultbar.includes(String(total)), resultbar.trim());

    const dataStamp = await cdp.evaluate("document.getElementById('dataUpdated').textContent");
    check('页脚显示数据更新时间', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dataStamp), dataStamp);

    const noOldKeys = await cdp.evaluate("Object.keys(localStorage).filter((k) => !k.startsWith('yuc_gl_')).length");
    check('本地存储只使用 yuc_gl_ 前缀', noOldKeys === 0, '其他键 ' + noOldKeys + ' 个');

    const yearRange = await cdp.evaluate(
      "(() => { const ys=[...document.querySelectorAll('[data-year]')].map((b)=>b.dataset.year); return [ys.includes('1985'), ys.includes('2027'), ys[0]]; })()");
    check('年份按钮覆盖 1985–2027', yearRange[0] && yearRange[1], yearRange[2]);

    const plats = await cdp.evaluate("JSON.stringify([...document.querySelectorAll('#platform option')].map((o)=>o.value))");
    check('平台下拉已归一', ['PC', 'Switch', 'Android', 'iOS', 'PSP'].every((p) => plats.includes('"' + p + '"')), plats.slice(0, 120));

    const devs = await cdp.evaluate("document.querySelectorAll('#developerList option').length");
    check('开发商候选列表已生成', devs > 100, devs + ' 个');

    const genreCount = await cdp.evaluate("document.querySelectorAll('#genre option').length");
    check('题材下拉可用', genreCount >= 10, genreCount + ' 项');

    const firstImg = await cdp.evaluate(
      "(() => { const imgs=[...document.querySelectorAll('.card img')]; const i=imgs[5] || imgs[0]; return [i.getAttribute('loading'), i.getAttribute('src').startsWith('https://'), imgs.slice(0,5).every((x)=>x.getAttribute('loading')==='eager')]; })()");
    check('封面外链、首屏 5 张优先、其余懒加载', firstImg[0] === 'lazy' && firstImg[1] === true && firstImg[2] === true, String(firstImg));

    await shot('desktop-home');

    // ---------- 搜索 ----------
    const typeSearch = async (text) => {
      await cdp.evaluate(`(() => { const el=document.getElementById('search'); el.value=${JSON.stringify(text)};
        el.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await sleep(320);
    };
    const clearSearch = async () => {
      await cdp.evaluate("(() => { const el=document.getElementById('search'); el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); })()");
      await sleep(300);
    };
    // 搜索并取命中集。首屏只渲染 PAGE_SIZE(240) 张卡，所以：
    // - count 用页面上的 #resultCount（真实命中总数，不受渲染上限影响）；
    // - ids 用已渲染的卡片（最多 240 条），两边做子集比对——
    //   同一套匹配规则下前 240 条必然一致，加上 count 相等就能确认真等价。
    const aliasHits = async (text) => {
      await typeSearch(text);
      const r = await cdp.evaluate(`(() => {
        const cards = [...document.querySelectorAll('.card')].map((c) => String(c.dataset.id));
        const el = document.getElementById('resultCount');
        const total = el ? (Number(String(el.textContent).replace(/\\D/g, '')) || 0) : cards.length;
        return { ids: cards, total: total };
      })()`);
      return { ids: r.ids || [], count: r.total || 0 };
    };

    await typeSearch('时空轮回');
    let firstTitle = await cdp.evaluate("(document.querySelector('.card .title') || {}).textContent || ''");
    let searchCards = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('中文搜索有结果且首位精确', searchCards > 0 && /时空轮回/.test(firstTitle), `${searchCards} 条 / ${firstTitle}`);
    check('搜索关键词标题高亮', await cdp.evaluate("!!document.querySelector('.card .title mark')") === true);

    await typeSearch('CLANNAD');
    searchCards = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('英文原名搜索有结果', searchCards > 0, searchCards + ' 条');

    const pyToken = await cdp.evaluate(
      "(() => { const x=(window.GL_DATA||[]).find((x)=>x.py && x.py.length>=2 && /^[a-z]+$/.test(x.py)); return x ? [x.py.slice(0,2), x.cn||x.n] : []; })()");
    await typeSearch(pyToken[0]);
    const pyCards = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('拼音首字母搜索有结果', pyCards > 0, `${pyToken[0]} → ${pyCards} 条（${pyToken[1]}）`);

    // 开发商 / 平台也参与搜索
    const devToken = await cdp.evaluate(
      "(() => { const c={}; (window.GL_DATA||[]).forEach((x)=>(x.dev||[]).forEach((d)=>{ if (d.length>=3) c[d]=(c[d]||0)+1; })); const top=Object.entries(c).sort((a,b)=>b[1]-a[1]).find((e)=>!/\\s/.test(e[0])); return top ? top[0] : ''; })()");
    await typeSearch(devToken);
    const devSearch = await cdp.evaluate(
      "(() => { const t=" + JSON.stringify(devToken) + "; const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id)); const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; }); return ids.length > 0 && ids.some((id)=>((map[id]&&map[id].dev)||[]).indexOf(t)>=0); })()");
    check('搜索可命中开发商', devSearch === true, devToken);

    await typeSearch('Switch');
    // 判据要容忍「标题/别名本身含该词」：搜 Switch 时出现 Tsuboi-kun no Switch!（PC 游戏）
    // 是正确行为，不是误命中。此前这里只查 cn/n，扩展库补了 al 之后这类条目变多，
    // 断言就开始失败——不是产品退步，是判据漏了一个维度。
    const platSearch = await cdp.evaluate(
      "(() => { const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id)); const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; }); return ids.length > 0 && ids.every((id)=>{ const x=map[id]||{}; return (x.pl||[]).some((p)=>/^Switch/i.test(p)) || (x.dev||[]).some((d)=>/switch/i.test(d)) || /switch/i.test(x.cn||x.n||'') || (x.al||[]).some((a)=>/switch/i.test(a)); }); })()");
    const platTotal = await cdp.evaluate("document.querySelectorAll('.card').length");
    const platPure = await cdp.evaluate(
      "(() => { const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id)); const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; }); return ids.filter((id)=>{ const x=map[id]||{}; return !((x.pl||[]).some((p)=>/^Switch/i.test(p)) || (x.dev||[]).some((d)=>/switch/i.test(d)) || /switch/i.test(x.cn||x.n||'') || (x.al||[]).some((a)=>/switch/i.test(a))); }).length; })()");
    check('搜索可命中平台', platSearch === true, platSearch ? `Switch · ${platTotal} 条·越界 ${platPure}` : '未命中');

    // ---------- 标题里的标点不应把整条查询变成 0 结果（v2.39.0） ----------
    // 用户常把英文别名整条粘进搜索框：`Love, Elections, & Chocolate`、
    // `Do As I Say - Obedience to the Priest`。按空格切词后 `,`/`&`/`-` 会变成
    // 必须命中的关键词，而它们不可能出现在任何标题里 —— 结果必然是 0 条。
    // 这里挑「别名本身带孤立标点」的条目，用别名原样查询，必须能命中它自己。
    const punctAlias = await cdp.evaluate(`(() => {
      const d = window.GL_DATA || [];
      // 均匀取样：先收集全部候选再按步长取，避免只验到前段同质条目
      const pool = [];
      for (const x of d) {
        if (!x.al || !x.al.length) continue;
        const a = x.al.find((v) => {
          const s = String(v);
          if (s.length < 10) return false;
          const toks = s.toLowerCase().split(/\\s+/).filter(Boolean);
          // 带「被空格包围的纯标点」或「逗号/&」才算有区分力的用例
          return toks.some((t) => t.length === 1 && !/[0-9a-z\\u3040-\\u30ff\\u4e00-\\u9fff]/.test(t)) || /[,&]/.test(s);
        });
        if (a) pool.push({ id: String(x.i), alias: a });
      }
      if (!pool.length) return null;
      const step = Math.max(1, Math.floor(pool.length / 12));
      const sample = [];
      for (let i = 0; i < pool.length && sample.length < 12; i += step) sample.push(pool[i]);
      return { poolSize: pool.length, sample };
    })()`);
    if (!punctAlias) {
      check('带标点的别名可用原样查询命中', false, '找不到含孤立标点的别名 —— 用例为 0，断言会空跑');
    } else {
      const missed = [];
      for (const cs of punctAlias.sample) {
        await typeSearch(cs.alias);
        const got = await cdp.evaluate("[...document.querySelectorAll('.card')].map((c)=>String(c.dataset.id))");
        if (!got.includes(cs.id)) missed.push({ id: cs.id, alias: cs.alias.slice(0, 48), got: got.length });
      }
      check('带标点的别名可用原样查询命中', missed.length === 0,
        `${punctAlias.sample.length - missed.length}/${punctAlias.sample.length} 命中（候选池 ${punctAlias.poolSize}）` +
        (missed.length ? ' · 漏 ' + JSON.stringify(missed.slice(0, 3)) : ''));
    }

    // 排除语法不能被上面的兜底改坏：`-词` 仍要真的把含该词的条目排掉。
    //
    // 判据要用「独立的 witch 词」，不能用 /witch/i 子串：
    // `Switch` / `スイッチ` 里也含 witch，而严格匹配要求 `w` 左侧是词边界，
    // 所以它们本来就不该被 `-witch` 排除。用子串判会把这个正确行为当成漏排除。
    await typeSearch('witch');
    const witchWordRe = "(^|[^a-z])witch([^a-z]|$)";
    const witchHit = await cdp.evaluate(
      "(() => { const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id)); const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; }); const re=new RegExp(" + JSON.stringify(witchWordRe) + ",'i'); return ids.filter((id)=>{ const x=map[id]||{}; return re.test(x.n||'') || re.test(x.cn||'') || (x.al||[]).some((a)=>re.test(a)); }).length; })()");
    await typeSearch('-witch');
    const witchNegHit = await cdp.evaluate(
      "(() => { const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id)); const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; }); const re=new RegExp(" + JSON.stringify(witchWordRe) + ",'i'); return ids.filter((id)=>{ const x=map[id]||{}; return re.test(x.n||'') || re.test(x.cn||'') || (x.al||[]).some((a)=>re.test(a)); }).length; })()");
    check('排除语法仍然生效', witchHit > 0 && witchNegHit === 0, `独立 witch 词 ${witchHit} 条 → -witch 后 ${witchNegHit} 条`);

    // 标题本身带「-词」时，原样粘贴必须能搜到它自己（兜底分支）。
    //
    // 这类标题不少：`Lilac -side Witch-`、`ATRI -My Dear Moments-`、
    // `灰色 -CHRONOS REBELLION-`。用户从别处复制标题粘进搜索框时，中间的
    // `-side` / `-My` 会被当成排除词，把它自己排掉 —— 结果是 0 条。
    //
    // 这条断言和上面「排除语法仍然生效」是一对反例：
    // 上面守「-词 必须真的排除」，这条守「整串命中不能因此丢失」。
    // 两条都过，才说明兜底只在「排除后为空」时触发，没有把排除语法废掉。
    //
    // 必须用「整串查询」而不是拆词，且必须挑排除后确实为 0 的样本 ——
    // 否则不会进入兜底分支，断言会空跑（曾经就是因此漏掉整段代码）。
    const dashTitle = await cdp.evaluate(`(() => {
      const d = window.GL_DATA || [];
      const pool = [];
      for (const x of d) {
        if (!x.al || !x.al.length) continue;
        for (const a of x.al) {
          const s = String(a);
          if (s.length < 12 || s.length > 46) continue;
          // 别名里要有「被空格包围的 -词」，这才是会被误当排除词的形态
          if (!/(^|\\s)-[A-Za-z]/.test(s)) continue;
          pool.push({ id: String(x.i), alias: s });
          break;
        }
      }
      if (!pool.length) return null;
      const step = Math.max(1, Math.floor(pool.length / 15));
      const sample = [];
      for (let i = 0; i < pool.length && sample.length < 15; i += step) sample.push(pool[i]);
      return { poolSize: pool.length, sample };
    })()`);
    if (!dashTitle) {
      check('标题自带「-词」时原样查询仍能命中', false, '找不到含「空格-词」的别名 —— 用例为 0，断言会空跑');
    } else {
      const missed = [];
      for (const cs of dashTitle.sample) {
        await typeSearch(cs.alias);
        const got = await cdp.evaluate("[...document.querySelectorAll('.card')].map((c)=>String(c.dataset.id))");
        if (!got.includes(cs.id)) missed.push({ id: cs.id, alias: cs.alias.slice(0, 44), got: got.length });
      }
      check('标题自带「-词」时原样查询仍能命中', missed.length === 0,
        `${dashTitle.sample.length - missed.length}/${dashTitle.sample.length} 命中（候选池 ${dashTitle.poolSize}）` +
        (missed.length ? ' · 漏 ' + JSON.stringify(missed.slice(0, 3)) : ''));
    }

    // 跨源别名：VNDB 英文 / 罗马字标题参与搜索（主库原名不含该标题时才用于验证）
    const vAlias = await cdp.evaluate(`(() => {
      const vm = (window.GL_VNDB || {}).map || {};
      const hit = (window.GL_DATA || []).find((x) => {
        const v = vm[String(x.i)];
        if (!v || !v.t || v.t.length < 8) return false;
        return ((x.cn || '') + ' ' + (x.n || '')).toLowerCase().indexOf(v.t.toLowerCase()) < 0;
      });
      return hit ? [vm[String(hit.i)].t, String(hit.i)] : null;
    })()`);
    await typeSearch(vAlias[0]);
    const vAliasIds = await cdp.evaluate("[...document.querySelectorAll('.card')].map((c) => c.dataset.id)");
    check('搜索可命中 VNDB 英文标题别名', vAliasIds.includes(vAlias[1]), `${vAlias[0]} → ${vAliasIds.length} 条`);

    // 跨源别名：月幕原名参与搜索
    const yAlias = await cdp.evaluate(`(() => {
      const ym = (window.GL_YMGAL || {}).map || {};
      const hit = (window.GL_DATA || []).find((x) => {
        const y = ym[String(x.i)];
        if (!y || !y.n || y.n.length < 6) return false;
        return ((x.cn || '') + ' ' + (x.n || '')).toLowerCase().indexOf(y.n.toLowerCase()) < 0;
      });
      return hit ? [ym[String(hit.i)].n, String(hit.i)] : null;
    })()`);
    await typeSearch(yAlias[0]);
    const yAliasIds = await cdp.evaluate("[...document.querySelectorAll('.card')].map((c) => c.dataset.id)");
    check('搜索可命中月幕原名别名', yAliasIds.includes(yAlias[1]), `${yAlias[0]} → ${yAliasIds.length} 条`);

    // 主库别名：Bangumi infobox 的别名参与搜索（选不含空格/冒号/减号的样例，避免触发限定语法）
    const bAlias = await cdp.evaluate(`(() => {
      const hit = (window.GL_DATA || []).find((x) => {
        if (!x.al || !x.al.length) return false;
        return x.al.some((a) => /^[A-Za-z0-9\\u3040-\\u30ff\\u3400-\\u9fff]{4,}$/.test(a) &&
          ((x.cn || '') + ' ' + (x.n || '')).toLowerCase().indexOf(a.toLowerCase()) < 0);
      });
      if (!hit) return null;
      const alias = hit.al.find((a) => /^[A-Za-z0-9\\u3040-\\u30ff\\u3400-\\u9fff]{4,}$/.test(a) &&
        ((hit.cn || '') + ' ' + (hit.n || '')).toLowerCase().indexOf(a.toLowerCase()) < 0);
      return [alias, String(hit.i)];
    })()`);
    await typeSearch(bAlias[0]);
    const bAliasIds = await cdp.evaluate("[...document.querySelectorAll('.card')].map((c) => c.dataset.id)");
    check('搜索可命中主库 Bangumi 别名', bAliasIds.includes(bAlias[1]), `${bAlias[0]} → ${bAliasIds.length} 条`);

    // ---------- 别名等价：同一实体的不同语言 / 写法必须命中同一条 ----------
    //
    // 判据是「不丢目标」而不是「命中数相等」：标题里本来就可能含别的词的子串
    // （「雨音スイッチ」里有「スイッチ」，「kidnapped」里有「kid」），
    // 那种多命中是词串本身的歧义，不是别名失效。
    // 真正的失效是「用 A 能搜到某条，用同组的 B 搜不到它」。
    const aliasGroupCover = async (field, std) => {
      const r = await cdp.evaluate(`(() => {
        const AG = (window.GL_ALIAS_GROUPS || {})[${JSON.stringify(field)}] || {};
        const g = AG[${JSON.stringify(std)}];
        if (!g) return null;
        const names = [${JSON.stringify(std)}].concat(Object.prototype.toString.call(g) === '[object Array]' ? g : [g.c].concat(g.a || []));
        const D = window.GL_DATA || [];
        const idx = (n) => {
          const k = String(n).toLowerCase();
          const ids = new Set();
          D.forEach((x) => {
            const list = ${field === 'dev' ? '((x.dev||[]).concat(x.dva||[]))' : '((x.pl||[]).concat(x.pla||[]))'};
            if (list.some((v) => String(v).toLowerCase() === k)) ids.add(String(x.i));
          });
          return ids;
        };
        const sets = names.map((n) => ({ n: n, s: idx(n) }));
        const union = new Set();
        sets.forEach((it) => it.s.forEach((id) => union.add(id)));
        let miss = 0;
        const sample = [];
        union.forEach((id) => {
          const lack = sets.filter((it) => !it.s.has(id));
          if (!lack.length) return;
          miss += 1;
          if (sample.length < 3) sample.push(id + ' 漏 ' + lack.map((it) => it.n).join('/'));
        });
        return { names: names, union: union.size, miss: miss, sample: sample };
      })()`);
      return r;
    };

    for (const [field, std, alt] of [
      ['dev', '戯画', 'GIGA'],
      ['dev', 'キッド', 'KID'],
      ['dev', '工画堂スタジオ', 'Kogado Studio'],
      ['dev', 'ニトロプラス', 'Nitroplus'],
      ['plat', 'Arcade', 'アーケード'],
      ['plat', 'PS2', 'PlayStation 2'],
      ['plat', 'PC', 'Windows'],
    ]) {
      const cov = await aliasGroupCover(field, std);
      check(`别名组「${alt}」不丢目标（${std} 组）`,
        !!cov && cov.union > 0 && cov.miss === 0,
        cov ? `${cov.union} 条 / 漏 ${cov.miss}${cov.sample.length ? '：' + cov.sample.join('；') : ''}` : '组不存在');
    }

    // 大小写 / 全角：同一实体换个写法，命中集合必须一致
    const sameHits = async (a, b) => {
      await typeSearch(a);
      const idsA = await cdp.evaluate("[...document.querySelectorAll('.card')].map((c) => c.dataset.id)");
      await typeSearch(b);
      const idsB = await cdp.evaluate("[...document.querySelectorAll('.card')].map((c) => c.dataset.id)");
      const sb = new Set(idsB);
      const missing = idsA.filter((id) => !sb.has(id));
      return { a: idsA.length, b: idsB.length, missing: missing.slice(0, 3) };
    };

    for (const [a, b, label] of [
      ['戯画', 'ＧＩＧＡ', '全角 vs 日文'],
      ['GIGA', '戯画', '英文 vs 日文'],
      ['キッド', 'KID', '日文 vs 英文'],
      ['工画堂スタジオ', 'Kogado Studio', '日文 vs 英文'],
      ['PlayStation 2', 'PS2', '全称 vs 缩写'],
    ]) {
      const r = await sameHits(a, b);
      check(`别名等价：${label}（${a} ⊇ ${b}）`,
        r.a > 0 && r.missing.length === 0,
        `${r.a} vs ${r.b}${r.missing.length ? ' 漏 ' + r.missing.join(',') : ''}`);
    }

    // ---------- 开发商前缀搜索：逐字输入时不能中途空结果 ----------
    // v2.32.0 曾把 ≤4 字符的短 token 限制成整名/后缀，导致 atel/hook/07th 全部搜不到，
    // 用户边打字边看结果时前面几步全是空。这里断言「前缀能命中以它开头的开发商」。
    // 判据不是「有结果」（别的字段可能碰巧命中），而是结果里确实有该前缀开头的开发商。
    for (const pre of ['atel', 'hook', 'dies']) {
      await typeSearch(pre);
      const r = await cdp.evaluate(`(() => {
        const ids=[...document.querySelectorAll('.card')].map((c)=>String(c.dataset.id));
        const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[String(x.i)]=x; });
        const pre=${JSON.stringify(pre)};
        const withDev=ids.filter((id)=>{
          const x=map[id]||{};
          return ((x.dev||[]).concat(x.dva||[])).some((d)=>String(d).toLowerCase().indexOf(pre)===0);
        });
        return { total:ids.length, withDev:withDev.length, sample:withDev.slice(0,3).map((id)=>(map[id]||{}).n||'') };
      })()`);
      check(`开发商前缀可搜：${pre}`, r.withDev > 0,
        `${r.total} 条 / 命中前缀开发商 ${r.withDev} 条${r.sample.length ? '：' + r.sample.join('、') : ''}`);
    }

    // 放开前缀后，标题里的词内子串仍必须挡住：kid 不能命中「kidnapped girl」这类标题
    await typeSearch('kid');
    const kidTitleBad = await cdp.evaluate(`(() => {
      const ids=[...document.querySelectorAll('.card')].map((c)=>String(c.dataset.id));
      const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[String(x.i)]=x; });
      return ids.filter((id)=>{
        const x=map[id]||{};
        const devs=((x.dev||[]).concat(x.dva||[])).map((d)=>String(d).toLowerCase());
        const hitDev=devs.some((d)=>/^kid\\b/.test(d)||/^kid$/.test(d));
        return !hitDev && /kidnapp/i.test(String(x.n||''));
      }).map((id)=>id+':'+(map[id]||{}).n).slice(0,3);
    })()`);
    check('前缀放开不引入标题词内误命中（kidnapped）', kidTitleBad.length === 0,
      kidTitleBad.length ? kidTitleBad.join('；') : '0 条误命中');

    // ---------- 题材同义词：中文标签 / 英文 / 日文写法必须等价 ----------
    // 题材别名表曾经生成了却完全没接入（构建脚本还把 id 当成数组下标 0/1/2），
    // 导致「题材:sf」「题材:yuri」这类输入搜不到。这里守两件事：
    // 1) 同义词与中文标签命中同一批条目（判据不丢目标）；
    // 2) 命中数必须大于 0——否则「两边都是 0」会伪装成通过。
    for (const [a, b, label] of [
      ['题材:科幻', '题材:sf', '科幻 vs sf'],
      ['题材:科幻', '题材:cyberpunk', '科幻 vs cyberpunk'],
      ['题材:恋爱', '题材:romance', '恋爱 vs romance'],
      ['题材:百合', '题材:yuri', '百合 vs yuri'],
    ]) {
      const A = await aliasHits(a);
      const B = await aliasHits(b);
      const sb = new Set(B.ids);
      const missing = A.ids.filter((id) => !sb.has(id));
      const sb2 = new Set(A.ids);
      const missing2 = B.ids.filter((id) => !sb2.has(id));
      // 判据三条：两边都有结果、命中总数相等、渲染出的条目集合一致。
      // 「两边都是 0」会被 A.count > 0 拦住，不会伪装成通过。
      check(`题材同义词等价：${label}`,
        A.count > 0 && A.count === B.count && missing.length === 0 && missing2.length === 0,
        `${A.count} vs ${B.count}${missing.length + missing2.length ? ' 漏 ' + missing.concat(missing2).slice(0, 3).join(',') : ''}`);
    }

    // ---------- 跨语言社名：日文社名与官方英文名必须等价 ----------
    // 这批社在数据里只以日文出现（アトラス / フリュー / ブシロード…），
    // 用户用英文名搜命中 0 条。已用人工核对表补入（scripts/dev-cross-lang.mjs），
    // 只进搜索别名不改显示。这里守「两边命中数相等且非 0」。
    //
    // 选例规则：只用「可见条目 >= 2」的社。浏览器搜索不返回 k="off" 的隐藏条目
    // （205 条非 gal 默认隐藏），所以拿一条只覆盖隐藏条目的映射来测，两边都是 0、
    // 断言必然 FAIL —— 那测的不是功能，是选例失误。曾经踩过：レベルファイブ
    // 全库只有 1 条作品（212078 イナズマイレブン），且是隐藏条目，误报 0 vs 0。
    // 这类映射仍然有价值（用户打开隐藏开关后英文名同样能搜到），只是不适合做用例。
    for (const [jp, lat] of [
      ['アトラス', 'Atlus'],
      ['フリュー', 'Furyu'],
      ['ブシロード', 'Bushiroad'],
      ['アクワイア', 'Acquire'],
      ['ヒューネックス', 'HuneX'],
    ]) {
      const A = await aliasHits(jp);
      const B = await aliasHits(lat);
      check(`跨语言社名等价：${jp} = ${lat}`,
        A.count > 0 && A.count === B.count,
        `${A.count} vs ${B.count}`);
    }
    // 上面这批用例本身要够厚：全是 0 或只有 1 条时，等价判据几乎没区分力。
    // 这里兜一道，防止将来数据变动让测试悄悄退化成「1 vs 1 永远通过」。
    {
      const probe = await aliasHits('アトラス');
      check('跨语言社名用例具备区分力（命中 >= 2 条）', probe.count >= 2,
        `アトラス 命中 ${probe.count} 条`);
    }

    // ---------- 假名社名的罗马字：打不出假名也要能搜到 ----------
    // 库里 83 个纯假名社（けばぶ / うた / みどり / ランカース…）原先搜罗马字命中 0 条。
    // 这批社没有官方英文名，用确定性转写补（scripts/dev-romaji.mjs）。
    //
    // 判据必须只看「开发商字段命中」，不能直接比搜索总命中数：
    //   搜索是全字段的，标题和别名里的词也会命中。实测 ニトロプラス 34 条 vs NITRO PLUS 33 条，
    //   差的 135999「NiTRO+ BLASTERZ」是因为它的月幕别名里有「ニトロプラス ブラスターズ…」
    //   这整段日文标题 —— 属词串重叠导致的正确多命中，不是漏搜。
    //   把这种差异算作失败，等于要求「日文标题里的日文词也要能用英文搜到」，那是错的。
    // 所以这里比对的是：**dev 字段命中该社的条目**，两边必须完全一致。
    const romajiCases = await cdp.evaluate(`(() => {
      const AG = window.GL_ALIAS_GROUPS || {};
      const dev = AG.dev || {};
      const out = [];
      Object.keys(dev).forEach((k) => {
        if (!/^[\\u3040-\\u309f\\u30a0-\\u30ff\\u30fc\\u30fb\\s]+$/.test(k)) return;
        const lats = (dev[k] || []).filter((v) => /^[a-z ]+$/i.test(String(v)));
        if (!lats.length) return;
        out.push([k, lats[0]]);
      });
      return out;
    })()`);
    check('假名社名已生成罗马字别名（覆盖 >= 60 组）', romajiCases.length >= 60,
      `${romajiCases.length} 组假名社名带罗马字写法`);
    let romajiOk = 0;
    const romajiBad = [];
    for (const [kana, lat] of romajiCases.slice(0, 12)) {
      // devHits：搜该词后，dev/dva 里确实含这个词的条目集合
      const devHit = async (q) => cdp.evaluate(`(() => {
        const el = document.getElementById('search');
        el.value = ${JSON.stringify(q)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return null;
      })()`).then(() => sleep(320)).then(() => cdp.evaluate(`(() => {
        const q = ${JSON.stringify(q)}.toLowerCase();
        // 用 dva 判断：运行时别名闭包已注入，能直接看出该条目是否真的挂了这个社名
        const hit = [];
        (window.GL_DATA || []).forEach((x) => {
          const names = (x.dev || []).concat(x.dva || []).map((d) => String(d).toLowerCase());
          if (names.some((d) => d === q || d.indexOf(q) === 0)) hit.push(String(x.i));
        });
        return hit;
      })()`));
      const A = await devHit(kana);
      const B = await devHit(lat);
      // 判据只守「漏」：假名侧能命中的条目，罗马字侧必须也全命中（onlyA 为空）。
      //
      // 反向的 onlyB（罗马字多命中）不算失败 —— 多命中是拆词搜索的固有行为：
      // 「Azarashi Soft」含空格会被拆成 azarashi + soft，soft 单独命中全库
      // 所有「XXX Soft」，实测 38 条里有 36 条不属于这家。这是噪音不是缺陷，
      // 真正要防的是「用户改用罗马字就搜不到原来那批条目」。
      const onlyA = A.filter((id) => !B.includes(id));
      if (A.length > 0 && onlyA.length === 0) romajiOk += 1;
      else romajiBad.push(`${kana}(${A.length}) vs ${lat}(${B.length})${onlyA.length ? ' 漏' + onlyA.slice(0, 2).join(',') : ''}`);
    }
    check('假名社名与其罗马字不丢目标（假名侧命中，罗马字侧必全命中）',
      romajiCases.length >= 60 && romajiOk > 0 && romajiBad.length === 0,
      romajiBad.length ? romajiBad.slice(0, 3).join('；')
        : `${romajiOk}/12 组无漏搜（候选 ${romajiCases.length} 组）`);
    // 不只是抽查：整张表里「有拉丁写法但拉丁写法一条都搜不到」的组必须为 0。
    // 这条守的是「别名表生成了但运行时没接上」这类故障——它不会让某个抽样用例失败，
    // 却会让整批别名静默失效。
    {
      const orphanGroups = await cdp.evaluate(`(() => {
        const AG = window.GL_ALIAS_GROUPS || {};
        const dev = AG.dev || {};
        let total = 0;
        Object.keys(dev).forEach((k) => { if ((dev[k] || []).some((v) => /[A-Za-z]/.test(String(v)))) total += 1; });
        return total;
      })()`);
      check('开发商别名表已加载并可被运行时消费', orphanGroups > 200,
        `${orphanGroups} 个写法含拉丁别名`);
    }

    // ---- 纯中文社名的拼音：白露社 / bailushe / bls 三边等价 ----
    //
    // 上一条只覆盖假名社名。库里 188 个纯中文社名（白露社 / 琉璃花糖制作组 / 零创游戏）
    // 此前搜拼音是 0 条 —— 中文用户打不出中文、或用拼音输入法时完全搜不到。
    // 判据与罗马字那条一致，只守「漏」：中文侧命中的条目，拼音侧必须全命中。
    const cnDevCases = await cdp.evaluate(`(() => {
      const AG = window.GL_ALIAS_GROUPS || {};
      const dev = AG.dev || {};
      const cn = /[\\u3400-\\u9fff]/;
      const kana = /[\\u3040-\\u30ff]/;
      const out = [];
      Object.keys(dev).forEach((k) => {
        if (!cn.test(k) || kana.test(k)) return;                 // 纯中文（不含假名）
        const pys = (dev[k] || []).filter((v) => /^[a-z]+$/i.test(String(v)) && String(v).length >= 3);
        if (!pys.length) return;
        out.push([k, pys[0]]);
      });
      return out;
    })()`);
    // 守卫：候选为 0 时下面的循环会「0 个失败」而假通过，必须显式挡
    check('纯中文社名已生成拼音别名（覆盖 >= 100 组）', cnDevCases.length >= 100,
      `${cnDevCases.length} 个中文社名带拼音写法`);
    let cnDevOk = 0;
    const cnDevBad = [];
    for (const [cnName, py] of cnDevCases.slice(0, 10)) {
      const devHit = async (q) => cdp.evaluate(`(() => {
        const el = document.getElementById('search');
        el.value = ${JSON.stringify(q)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return null;
      })()`).then(() => sleep(320)).then(() => cdp.evaluate(`(() => {
        const q = ${JSON.stringify(q)}.toLowerCase();
        const hit = [];
        (window.GL_DATA || []).forEach((x) => {
          const names = (x.dev || []).concat(x.dva || []).map((d) => String(d).toLowerCase());
          if (names.some((d) => d === q || d.indexOf(q) === 0)) hit.push(String(x.i));
        });
        return hit;
      })()`));
      const A = await devHit(cnName);
      const B = await devHit(py);
      const onlyA = A.filter((id) => !B.includes(id));
      if (A.length > 0 && onlyA.length === 0) cnDevOk += 1;
      else cnDevBad.push(`${cnName}(${A.length}) vs ${py}(${B.length})${onlyA.length ? ' 漏' + onlyA.slice(0, 2).join(',') : ''}`);
    }
    check('中文社名与其拼音不丢目标（中文侧命中，拼音侧必全命中）',
      cnDevCases.length >= 100 && cnDevOk > 0 && cnDevBad.length === 0,
      cnDevBad.length ? cnDevBad.slice(0, 3).join('；')
        : `${cnDevOk}/10 组无漏搜（候选 ${cnDevCases.length} 组）`);
    // 补入英译不能改变列表显示：アトラス 的作品仍应显示日文社名
    const devDisplayClean = await cdp.evaluate(`(() => {
      const map = {};
      (window.GL_DATA || []).forEach((x) => { map[String(x.i)] = x; });
      const bad = [];
      (window.GL_DATA || []).forEach((x) => {
        if (!(x.dev || []).length) return;
        // 显示层用 x.dev；只有带英文名的条目才可能被误改
        if ((x.dev || []).some((d) => d === 'Atlus' || d === 'Furyu')) bad.push(String(x.i));
      });
      return bad.slice(0, 3);
    })()`);
    check('跨语言英译不改变显示（仍显示日文社名）', devDisplayClean.length === 0,
      devDisplayClean.length ? '被改名：' + devDisplayClean.join(',') : '0 条被改名');

    // 含空格的平台全称不能被拆成多词：拆开会让「2」命中「WHITE ALBUM2」这类标题，
    // 再和 playstation 的 PS3/PSV 别名取交集，搜平台全称反而搜出非该平台的条目。
    await typeSearch('PlayStation 2');
    const ps2Strict = await cdp.evaluate(`(() => {
      const map = {};
      (window.GL_DATA || []).forEach((x) => { map[String(x.i)] = x; });
      const ids = [...document.querySelectorAll('.card')].map((c) => String(c.dataset.id));
      const bad = ids.filter((id) => {
        const x = map[id] || {};
        const pls = (x.pl || []).concat(x.pla || []).map((p) => String(p).toLowerCase());
        return pls.indexOf('ps2') < 0 && pls.indexOf('playstation 2') < 0;
      });
      return { total: ids.length, bad: bad.slice(0, 3), badCount: bad.length };
    })()`);
    check('平台全称不拆词（PlayStation 2 只出 PS2 游戏）',
      ps2Strict.total > 0 && ps2Strict.badCount === 0,
      `${ps2Strict.total} 条 / 非 PS2 ${ps2Strict.badCount}${ps2Strict.bad.length ? '：' + ps2Strict.bad.join(',') : ''}`);


    const looseHit = await cdp.evaluate(
      "(() => { const x=(window.GL_DATA||[]).find((x)=>String(x.n||'').toLowerCase().replace(/[^a-z0-9]+/g,'').indexOf('fatestaynight')===0); return x?[String(x.i), x.n]:null; })()");
    await typeSearch('fatestaynight');
    const looseIds = await cdp.evaluate("[...document.querySelectorAll('.card')].map((c) => c.dataset.id)");
    check('忽略标点与空格的英文搜索', !!looseHit && looseIds.includes(looseHit[0]),
      looseHit ? `${looseHit[1]} → ${looseIds.length} 条` : '未找到样例');

    // 全角输入走宽松兜底：严格匹配不会命中，NFKC 归一后可命中
    await typeSearch('ＦＡＴＥ');
    const wideCards = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('全角关键词搜索可命中', wideCards > 0, wideCards + ' 条');

    // 宽松模式下排除词同样生效
    await typeSearch('ＦＡＴＥ -ｈｏｌｌｏｗ');
    const looseExclude = await cdp.evaluate(
      "(() => { const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; }); const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id)); return [ids.length, ids.every((id)=>/hollow/i.test(((map[id]||{}).n||'')+((map[id]||{}).cn||''))===false)]; })()");
    check('宽松搜索下排除词仍生效', looseExclude[0] > 0 && looseExclude[1] === true, looseExclude[0] + ' 条');

    // 详情展示别名，便于核对搜索命中来源
    await clearSearch();
    await cdp.evaluate(`location.hash = '#d=${vAlias[1]}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const aliasMeta = await cdp.evaluate("document.getElementById('detailMeta').textContent");
    check('详情展示 VNDB 别名', aliasMeta.includes('别名') && aliasMeta.includes(vAlias[0]), aliasMeta.slice(0, 80));
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);

    await clearSearch();
    await typeSearch('游戏 -性');
    let exclInfo = await cdp.evaluate(
      "(() => { const n=document.querySelectorAll('.card').length; return [n, [...document.querySelectorAll('.card .title')].some((t)=>/性/.test(t.textContent))]; })()");
    check('「-词」排除生效', exclInfo[0] > 0 && exclInfo[1] === false, String(exclInfo));

    // 搜索限定语法：开发商 / 平台 / 年份可写在搜索框里，-前缀表示排除
    await typeSearch('开发商:' + devToken);
    const qualDev = await cdp.evaluate(`(() => { const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; });
      const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id));
      return [ids.length, ids.every((id)=>((map[id]||{}).dev||[]).join(' ').toLowerCase().indexOf(${JSON.stringify(devToken.toLowerCase())})>=0)]; })()`);
    check('搜索可按开发商限定', qualDev[0] > 0 && qualDev[1] === true, devToken + ' → ' + qualDev[0] + ' 条');

    await typeSearch('平台:Switch');
    const qualPlat = await cdp.evaluate(`(() => { const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; });
      const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id));
      return [ids.length, ids.every((id)=>((map[id]||{}).pl||[]).some((p)=>p.toLowerCase().indexOf('switch')>=0))]; })()`);
    check('搜索可按平台限定', qualPlat[0] > 0 && qualPlat[1] === true, 'Switch → ' + qualPlat[0] + ' 条');

    await typeSearch('年份:2015');
    const qualYear = await cdp.evaluate(`(() => { const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; });
      const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id));
      const all=(window.GL_DATA||[]).filter((x)=>String(x.d||'').slice(0,4)==='2015').length;
      return [ids.length, all, ids.every((id)=>String(((map[id]||{}).d)||'').slice(0,4)==='2015')]; })()`);
    check('搜索可按年份限定', qualYear[0] === Math.min(qualYear[1], 240) && qualYear[2] === true,
      '2015 → ' + qualYear[0] + ' / ' + qualYear[1] + ' 条');

    await typeSearch('-平台:PC');
    const qualNeg = await cdp.evaluate(`(() => { const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; });
      const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id));
      return [ids.length, ids.every((id)=>((map[id]||{}).pl||[]).indexOf('PC')<0)]; })()`);
    check('搜索限定支持 - 排除', qualNeg[0] > 0 && qualNeg[1] === true, qualNeg[0] + ' 条');

    // 题材与评分限定：题材:恋爱（或 tag:rom）、评分:>=8，支持 - 排除
    await typeSearch('题材:恋爱');
    const qualGenre = await cdp.evaluate(`(() => { const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; });
      const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id));
      const all=(window.GL_DATA||[]).filter((x)=>(x.tg||[]).indexOf('rom')>=0).length;
      return [ids.length, all, ids.every((id)=>((map[id]||{}).tg||[]).indexOf('rom')>=0)]; })()`);
    check('搜索可按题材限定', qualGenre[0] === Math.min(qualGenre[1], 240) && qualGenre[2] === true,
      '恋爱 → ' + qualGenre[0] + ' / ' + qualGenre[1] + ' 条');

    await typeSearch('评分:>=8');
    const qualScore = await cdp.evaluate(`(() => { const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; });
      const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id));
      const all=(window.GL_DATA||[]).filter((x)=>(Number(x.s)||0)>=8).length;
      return [ids.length, all, ids.every((id)=>(Number((map[id]||{}).s)||0)>=8)]; })()`);
    check('搜索可按评分下限限定', qualScore[0] === Math.min(qualScore[1], 240) && qualScore[2] === true,
      '≥8 → ' + qualScore[0] + ' / ' + qualScore[1] + ' 条');

    await typeSearch('-评分:>=8');
    const qualScoreNeg = await cdp.evaluate(`(() => { const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; });
      const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id));
      return [ids.length, ids.every((id)=>(Number((map[id]||{}).s)||0)<8)]; })()`);
    check('评分限定支持 - 排除', qualScoreNeg[0] === 240 && qualScoreNeg[1] === true, qualScoreNeg[0] + ' 条');

    await typeSearch('时空 轮回');
    let multi = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('多关键词取交集', multi > 0 && multi <= 5, multi + ' 条');

    await clearSearch();
    await waitFor("document.querySelectorAll('.card').length === 240");

    // ---------- 筛选 ----------
    const pickYear = async (y) => {
      await cdp.evaluate(`document.querySelector('[data-year="${y}"]').click()`);
      await sleep(300);
    };
    await pickYear('2020');
    const y2020 = await cdp.evaluate(
      "(() => { const ds=[...document.querySelectorAll('.card .meta')].map((m)=>m.textContent); return [ds.length, ds.filter((d)=>/^2020/.test(d)).length]; })()");
    check('年份筛选结果均为该年', y2020[0] > 0 && y2020[0] === y2020[1], String(y2020));
    await pickYear('all');

    const setSelect = async (id, value) => {
      await cdp.evaluate(`(() => { const s=document.getElementById('${id}'); s.value=${JSON.stringify(value)};
        s.dispatchEvent(new Event('change',{bubbles:true})); })()`);
      await sleep(300);
    };
    await setSelect('platform', 'Android');
    const androidInfo = await cdp.evaluate(
      "(() => ({ n: document.querySelectorAll('.card').length, text: document.getElementById('resultbar').textContent }))()");
    check('平台筛选生效', androidInfo.n > 0 && androidInfo.n < 800, androidInfo.n + ' 张');
    await setSelect('platform', 'all');

    await cdp.evaluate("(() => { const el=document.getElementById('developer'); el.value='Key'; el.dispatchEvent(new Event('change',{bubbles:true})); })()");
    await sleep(300);
    const devInfo = await cdp.evaluate(
      "(() => [document.querySelectorAll('.card').length, [...document.querySelectorAll('.card .meta')].every((m)=>/Key/.test(m.textContent))])()");
    check('开发商筛选生效', devInfo[0] > 0 && devInfo[0] < 240, devInfo[0] + ' 张');

    await cdp.evaluate("(() => { const el=document.getElementById('developer'); el.value=''; el.dispatchEvent(new Event('change',{bubbles:true})); })()");
    await sleep(300);
    await setSelect('genre', 'yur');
    const genreN = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('题材筛选生效', genreN > 0 && genreN < 400, genreN + ' 张');
    await setSelect('genre', 'all');

    const otoOpt = await cdp.evaluate("!!document.querySelector('#genre option[value=\"oto\"]')");
    check('题材下拉不含乙女', otoOpt === false);

    const lengthOptions = await cdp.evaluate("document.querySelectorAll('#length option').length");
    check('时长下拉三档可用', lengthOptions === 4, lengthOptions + ' 项');

    await setSelect('length', 'short');
    const shortInfo = await cdp.evaluate(`(() => { const map={};
      (window.GL_DATA||[]).forEach((x)=>{ const m=x.vo&&typeof x.vo.l==='number'?x.vo.l:(x.l||0); if(m) map[String(x.i)]=m; });
      const ids=[...document.querySelectorAll('.card')].map((c)=>String(c.dataset.id));
      return [ids.length, ids.every((id)=>{ const m=map[id]; return m>0 && m<=600; }),
        /ln=short/.test(location.hash), document.getElementById('filterChips').textContent]; })()`);
    check('时长筛选只保留短篇', shortInfo[0] > 0 && shortInfo[1] === true, shortInfo[0] + ' 张');
    check('时长筛选写入 hash 与筛选标签', shortInfo[2] === true && String(shortInfo[3]).includes('时长'), String(shortInfo[3]).slice(0, 24));

    await cdp.evaluate("document.querySelector('[data-chip=length]').click()");
    await sleep(300);
    const afterChip = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('移除时长筛选恢复全库', afterChip === 240, afterChip + ' 张');

    await cdp.evaluate("document.getElementById('highScoreBtn').click()");
    await sleep(300);
    const scores = await cdp.evaluate(
      "(() => [...document.querySelectorAll('.card .badge.score')].map((b)=>b.textContent).filter((t)=>t!=='暂无').map(Number))()");
    check('高分筛选只保留 ≥8.0', scores.length > 0 && scores.every((s) => s >= 8), scores.length + ' 张');

    await cdp.evaluate("document.getElementById('highScoreBtn').click()");
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);
    const clearN = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('清除筛选恢复全库', clearN === 240, clearN + ' 张');

    // 制作人员深链冷启动（扩展库未合并时不能把 sv 判成无效）
    //
    // 这条守的是一个真实缺陷（2026-11-28 修掉）：启动顺序是 applyStateMap → render →
    // scheduleExtraData，所以首屏校验 sv 时 DATA 只有主库 1968 条。若姓名只存在于扩展库
    // 5737 条里，`found` 必为 false → state.staff 清空 → render 里的 writeHash 把 sv 写成空串
    // → 深链彻底丢失，刷新后静默回到全库。同一条详情深链（d=）因为有 pendingDetail 机制
    // 等合并后重试，反而不受影响，对比之下更说明问题只在 sv 这一处。
    //
    // 测试必须用「真正重载」而不是「只改 hash」：Page.navigate 到仅 hash 不同的 URL 不会重载
    // 页面，只触发 hashchange，而那时扩展库早已合并，缺陷态也会通过。
    // 这就是我第一版测试写成假阳性的原因 —— 加 ?salts= 时间戳强制走完整冷启动。
    const deepStaff = await cdp.evaluate(`(() => {
      ${STAFF_JS}
      const d = window.GL_DATA || [];
      const mainNames = new Set();
      d.filter((x) => x.ex !== 1).forEach((x) => {
        ['sc','ar','mu'].forEach((f) => staffOf(x, f).forEach((n) => mainNames.add(n)));
      });
      for (const x of d) {
        if (x.ex !== 1) continue;
        for (const f of ['sc','ar','mu']) {
          const hit = staffOf(x, f).find((n) => n && !mainNames.has(n));
          if (hit) return { name: hit, kind: f };
        }
      }
      return null;
    })()`);
    if (deepStaff) {
      const url = `http://127.0.0.1:${PORT}/?stalfix=${Date.now()}#tab=all&y=all&f=all&dv=` +
        `&sk=${deepStaff.kind}&sv=` + encodeURIComponent(deepStaff.name);
      await cdp.send('Page.navigate', { url });
      for (let i = 0; i < 100; i += 1) {
        await sleep(200);
        if (await cdp.evaluate('window.__FULL_DATA_READY === true').catch(() => false)) break;
      }
      await sleep(600);
      const cold = await cdp.evaluate(
        "(() => ({ n: document.querySelectorAll('.card').length," +
        " chips: document.getElementById('filterChips').textContent," +
        " hash: decodeURIComponent(location.hash) }))()");
      check('制作人员深链冷启动不丢失筛选',
        cold.chips.includes(deepStaff.name) && cold.n > 0 && cold.hash.includes('sv=' + deepStaff.name),
        `${deepStaff.kind} · ${deepStaff.name} → ${cold.n} 张`);
      // 恢复干净状态供后续断言使用
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?aftstaff=${Date.now()}` });
      for (let i = 0; i < 100; i += 1) {
        await sleep(200);
        if (await cdp.evaluate('window.__FULL_DATA_READY === true').catch(() => false)) break;
      }
      await sleep(400);
    } else {
      check('制作人员深链冷启动不丢失筛选', false, '未找到仅在扩展库出现的制作人员姓名');
    }

    // 开发商（dv）与系列（se）是同一条根因的另两个受害者：
    // applyStateMap 在首屏跑，此时 DATA 只有主库 1968 条，devs / seriesInfo 都只由主库构建。
    // 只存在于扩展库的开发商（1040 个 / 4642 处引用）和系列（492 个）在首屏都会被判「不存在」→ 清空 → 深链丢失。
    // 测法：从「扩展库独有」里挑样本，用带 salt 的 URL 强制冷启动，再看筛选是否还在。
    const coldDeep = async (hash) => {
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?cold=${Date.now()}#${hash}` });
      for (let i = 0; i < 100; i += 1) {
        await sleep(200);
        if (await cdp.evaluate('window.__FULL_DATA_READY === true').catch(() => false)) break;
      }
      await sleep(600);
      return cdp.evaluate(
        "(() => ({ n: document.querySelectorAll('.card').length," +
        " chips: document.getElementById('filterChips').textContent," +
        " hash: decodeURIComponent(location.hash) }))()");
    };

    const deepDev = await cdp.evaluate(
      "(() => { const mainIds=new Set(((window.GL_META||{}).mainIds||[]));" +
      " const d=window.GL_DATA||[];" +
      // 主库 id 集合取不到时，退化为「前 1968 条」——加载顺序决定主库始终在前
      " const head = mainIds.size ? d.filter((x)=>mainIds.has(x.i)) : d.slice(0, 1968);" +
      " const seen=new Set(); head.forEach((x)=>(x.dev||[]).forEach((v)=>seen.add(v)));" +
      " for (const x of d) { if (mainIds.size ? mainIds.has(x.i) : d.indexOf(x) < 1968) continue;" +
      "   const hit=(x.dev||[]).find((v)=>!seen.has(v)); if (hit) return hit; }" +
      " return ''; })()");
    if (deepDev) {
      const cold = await coldDeep(`tab=all&y=all&f=all&dv=${encodeURIComponent(deepDev)}`);
      check('开发商深链冷启动不丢失筛选',
        cold.chips.includes(deepDev) && cold.n > 0 && cold.hash.includes('dv=' + deepDev),
        `${deepDev} → ${cold.n} 张`);
    } else {
      check('开发商深链冷启动不丢失筛选', false, '未找到仅在扩展库出现的开发商');
    }

    const deepSeries = await cdp.evaluate(
      "(() => { const n=(window.GL_SERIES||{}).n||[]; const m=(window.GL_SERIES||{}).m||{};" +
      " const d=window.GL_DATA||[]; const cut=1968;" +
      " const key=(x)=>x.vx?String(x.vx):(x.vo&&x.vo.v?String(x.vo.v):'b:'+x.i);" +
      " const nameOf=(x)=>{const s=m[key(x)]||0; return s?n[s]||'':'';};" +
      " const cntHead=Object.create(null), cntAll=Object.create(null);" +
      " const bump=(bag,x)=>{const nm=nameOf(x); if(nm) bag[nm]=(bag[nm]||0)+1;};" +
      " d.slice(0,cut).forEach((x)=>bump(cntHead,x)); d.forEach((x)=>bump(cntAll,x));" +
      " for (const nm of Object.keys(cntAll)) { if (!cntHead[nm] && cntAll[nm]>=2) return { name: nm, n: cntAll[nm] }; }" +
      " return null; })()");
    if (deepSeries) {
      const cold = await coldDeep(`tab=all&y=all&f=all&se=${encodeURIComponent(deepSeries.name)}`);
      check('系列深链冷启动不丢失筛选',
        cold.chips.includes(deepSeries.name) && cold.n > 0 && cold.hash.includes('se=' + deepSeries.name),
        `${deepSeries.name} → ${cold.n} 张（全库 ${deepSeries.n} 部）`);
    } else {
      check('系列深链冷启动不丢失筛选', false, '未找到仅在扩展库构成的系列');
    }

    // 反向边界：暂存机制不能变成「无条件接受脏值」。
    // 上面三条只证明「合法的扩展库值能被恢复」，若实现写成「登记了就一律恢复」，
    // 过期/伪造的深链也会被接受，反而从「丢筛选」变成「留下空结果」。
    // 这里用三个绝不存在的值走同一条冷启动路径，要求它们全部被丢弃、且不留下空结果。
    const ghost = {};
    for (const [k, v] of Object.entries({ dv: '__NO_SUCH_DEV__', se: '__NO_SUCH_SERIES__', sv: '__NO_SUCH_STAFF__' })) {
      const q = k === 'sv' ? `sk=sc&sv=${v}` : `${k}=${v}`;
      const r = await coldDeep(`tab=all&y=all&f=all&${q}`);
      ghost[k] = { n: r.n, leaked: r.chips.includes(v) || r.hash.includes(k + '=' + v) };
    }
    const ghostLeak = Object.entries(ghost).filter(([, v]) => v.leaked).map(([k]) => k);
    check('过期深链的脏值被丢弃且不留空结果',
      ghostLeak.length === 0 && Object.values(ghost).every((v) => v.n > 0),
      ghostLeak.length ? `未丢弃: ${ghostLeak.join('/')}` : `dv/se/sv 三键均已丢弃，回落到 ${ghost.dv.n} 张`);

    // 恢复干净状态供后续断言使用
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?aftcold=${Date.now()}` });
    for (let i = 0; i < 100; i += 1) {
      await sleep(200);
      if (await cdp.evaluate('window.__FULL_DATA_READY === true').catch(() => false)) break;
    }
    await sleep(400);

    // ---------- 详情 ----------
    await cdp.evaluate("document.querySelector('.card .card-link').click()");
    await waitFor("document.getElementById('modal').hidden === false");
    const detailMeta = await cdp.evaluate("document.getElementById('detailMeta').textContent");
    check('详情展示平台/开发/发行/剧本', ['平台', '开发', '发行', '剧本'].every((k) => detailMeta.includes(k)), detailMeta.slice(0, 60));
    const simN = await cdp.evaluate("document.querySelectorAll('.sim-card').length");
    check('详情展示相似推荐', simN > 0, simN + ' 条');
    const navInfo = await cdp.evaluate(
      "(() => [document.getElementById('detailNav').hidden, document.getElementById('detailNext').disabled])()");
    check('详情上一部/下一部可用', navInfo[0] === false && navInfo[1] === false, String(navInfo));
    await cdp.evaluate("document.getElementById('detailNext').click()");
    await sleep(300);
    const changed = await cdp.evaluate("location.hash.includes('d=')");
    check('详情内可切到下一部并更新 hash', changed === true);
    await shot('desktop-detail');
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);

    // 多值字段逐项可点：点开发商直接跳到筛选
    const richId = await cdp.evaluate(
      "(() => { const x=(window.GL_DATA||[]).find((x)=>x.dev&&x.dev.length&&x.pl&&x.pl.length); return x ? String(x.i) : ''; })()");
    await cdp.evaluate(`location.hash = '#d=${richId}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const detailLinks = await cdp.evaluate(
      "(() => ({ pl: document.querySelectorAll('#detailMeta [data-jump-type]').length, dev: document.querySelectorAll('#detailMeta [data-jump-dev]').length }))()");
    check('详情平台与开发商逐项可点', detailLinks.pl >= 1, JSON.stringify(detailLinks));
    const jumpedDev = await cdp.evaluate(
      "(() => { const b=document.querySelector('#detailMeta [data-jump-dev]'); if (!b) return ''; const v=b.dataset.jumpDev; b.click(); return v; })()");
    await sleep(450);
    const jumpState = await cdp.evaluate(
      "(() => [document.getElementById('modal').hidden, document.getElementById('developer').value, document.querySelectorAll('.card').length])()");
    check('详情点开发商即按该开发商筛选', !!jumpedDev && jumpState[0] === true && jumpState[1] === jumpedDev && jumpState[2] > 0,
      jumpedDev + ' → ' + jumpState[2] + ' 张');
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    // 制作人员（剧本 / 原画 / 音乐 / 发行）逐项可点，并按该人员筛选全库
    // 样本刻意从「带 staff 的条目」里挑，但不再假设字段一定是字符串（扩展库是 id 数组）
    const staffId = await cdp.evaluate(
      "(() => { " + STAFF_JS + " const x=(window.GL_DATA||[]).find((x)=>staffOf(x,'sc').length); return x ? String(x.i) : ''; })()");
    await cdp.evaluate(`location.hash = '#d=${staffId}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const staffLinks = await cdp.evaluate("document.querySelectorAll('#detailMeta [data-jump-staff]').length");
    check('详情剧本与制作人员可点', staffLinks >= 1, staffLinks + ' 个');
    const staffJump = await cdp.evaluate(
      "(() => { const b=document.querySelector('#detailMeta [data-jump-staff]'); if (!b) return null; const v=b.dataset.jumpStaff; const k=b.dataset.staffKind; b.click(); return { v, k }; })()");
    await sleep(450);
    const staffFiltered = await cdp.evaluate(
      `(() => { ${STAFF_JS} const ids=[...document.querySelectorAll('.card')].map((c)=>c.dataset.id);` +
      ` const ok=ids.every((id)=>{ const x=(window.GL_DATA||[]).find((y)=>String(y.i)===id);` +
      ` return x && staffOf(x, '${staffJump ? staffJump.k : 'sc'}').indexOf(${JSON.stringify(staffJump ? staffJump.v : '')})>=0; });` +
      ` return [ids.length, ok, document.getElementById('modal').hidden, document.getElementById('filterChips').textContent]; })()`);
    check('详情点制作人员即按该人员筛选', !!staffJump && staffFiltered[0] > 0 && staffFiltered[1] === true && staffFiltered[2] === true,
      (staffJump ? staffJump.k + ' · ' + staffJump.v : '无') + ' → ' + staffFiltered[0] + ' 张');
    check('筛选标签显示制作人员筛选', /剧本|原画|音乐|发行/.test(staffFiltered[3]) && staffFiltered[3].includes(staffJump ? staffJump.v : ''), String(staffFiltered[3]).slice(0, 40));
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    // 扩展库制作人员词典可还原（防「词典读错全局名」这类静默失效）
    // 背景：v2.40.0 把扩展库 sc/ar/mu 改成词典 id 数组，前端需读 GL_VNDB_EXTRA.staffDict 还原。
    // 一旦读错来源（例如写了个不存在的全局名），dict 恒为空 → 数组里每个 id 都查不到姓名 →
    // staffValues() 返回空数组 → 5737 条扩展库的剧本/原画/音乐**全部显示「未标注」**，
    // 不抛错、check-data 的 id 越界守卫也照样 PASS（它只校验 id 范围，不校验能否查到人）。
    //
    // 判据必须走页面自己的读取路径，不能自己再算一遍：
    // 第一版这里用断言内自带的解码器去重算，缺陷态下照样 PASS 5558/5558 —— 因为它读的是
    // 正确的数据来源，测的是「数据能否还原」，而缺陷在「页面读错来源」。空转的断言等于没有。
    // 改为挑一个**只出现在扩展库**的剧本姓名，用页面的筛选入口去查：
    // 页面若能还原 → 结果 >0 且每条都含该姓名；页面读不到词典 → 筛选结果 0 条（或全越界），必然 FAIL。
    const dictRender = await cdp.evaluate(`(() => {
      ${STAFF_JS}
      const d = window.GL_DATA || [];
      const ext = d.filter((x) => x.ex === 1);
      const arrItems = ext.filter((x) => ['sc','ar','mu'].some((f) => Array.isArray(x[f]) && x[f].length));
      // 主库出现过的所有姓名（字符串形态），用于排除「主库也有同名」的样本
      const inMain = new Set();
      d.filter((x) => x.ex !== 1).forEach((x) => {
        ['sc','ar','mu'].forEach((f) => staffOf(x, f).forEach((n) => inMain.add(n)));
      });
      // 找一个只在扩展库出现的剧本姓名（页面读不到词典时，这个筛选必然 0 条）
      let pick = '';
      for (const x of ext) {
        if (!Array.isArray(x.sc)) continue;
        for (const n of staffOf(x, 'sc')) {
          if (n && !inMain.has(n)) { pick = n; break; }
        }
        if (pick) break;
      }
      return {
        ext: ext.length, arrItems: arrItems.length,
        okItems: arrItems.filter((x) => ['sc','ar','mu'].some((f) => staffOf(x, f).length)).length,
        pick
      };
    })()`);
    check('扩展库存在可筛选的词典化制作人员',
      dictRender.arrItems > 1000 && dictRender.okItems === dictRender.arrItems && !!dictRender.pick,
      `${dictRender.okItems}/${dictRender.arrItems} 条有姓名（扩展库 ${dictRender.ext} 条）· 样本「${dictRender.pick}」`);

    // 用上面那个「仅扩展库独有」的姓名走页面筛选，验证页面确实还原得出人名
    if (dictRender.pick) {
      await cdp.evaluate(`location.hash = '#sk=sc&sv=' + encodeURIComponent(${JSON.stringify(dictRender.pick)})`);
      await sleep(450);
      const extFilter = await cdp.evaluate(`(() => {
        ${STAFF_JS}
        const ids = [...document.querySelectorAll('.card')].map((c) => c.dataset.id);
        const bad = ids.filter((id) => {
          const x = (window.GL_DATA || []).find((y) => String(y.i) === id);
          return !x || staffOf(x, 'sc').indexOf(${JSON.stringify(dictRender.pick)}) < 0;
        }).length;
        return { n: ids.length, bad, chips: document.getElementById('filterChips').textContent };
      })()`);
      check('扩展库制作人员可被页面筛选命中',
        extFilter.n > 0 && extFilter.bad === 0 && extFilter.chips.includes(dictRender.pick),
        `${dictRender.pick} → ${extFilter.n} 张 · 越界 ${extFilter.bad}`);
      await cdp.evaluate("document.getElementById('clearFiltersBtn').click(); location.hash = ''");
      await sleep(300);

      // 详情页也必须把姓名渲染出来（而不是「未标注」或一串裸露的 id 数字）
      const sampleId = await cdp.evaluate(`(() => {
        ${STAFF_JS}
        const x = (window.GL_DATA || []).find((y) => y.ex === 1 && Array.isArray(y.sc) && staffOf(y, 'sc').indexOf(${JSON.stringify(dictRender.pick)}) >= 0);
        return x ? String(x.i) : '';
      })()`);
      await cdp.evaluate(`location.hash = '#d=${sampleId}'`);
      await waitFor("document.getElementById('modal').hidden === false");
      await sleep(250);
      const extDetail = await cdp.evaluate(
        "(() => { const rows=[...document.querySelectorAll('#detailMeta .chip')];" +
        " const r=rows.find((x)=>(x.querySelector('i')||{}).textContent==='剧本'); return r ? r.textContent : ''; })()");
      check('扩展条目的剧本显示姓名而非未标注',
        extDetail.includes(dictRender.pick) && extDetail !== '' && !extDetail.includes('未标注'),
        extDetail.slice(0, 50));
      await cdp.evaluate("document.getElementById('modal').hidden = true; location.hash = ''");
      await sleep(250);
    } else {
      check('扩展库制作人员可被页面筛选命中', false, '未找到仅在扩展库出现的剧本姓名');
    }

    // 系列聚合：详情展示系列入口，点击后按系列筛选全库，非法系列链接自动忽略
    const seriesData = await cdp.evaluate(
      "(() => window.GL_SERIES ? [window.GL_SERIES.meta.series, window.GL_SERIES.meta.items] : null)()");
    check('系列映射数据已加载', Array.isArray(seriesData) && seriesData[0] === 629 && seriesData[1] === 1797,
      JSON.stringify(seriesData));
    const seriesName = '秋之回忆';
    const seriesIds = await cdp.evaluate(
      `(window.GL_DATA||[]).filter((x)=>String(x.cn||x.n||'').indexOf(${JSON.stringify(seriesName)})===0).map((x)=>String(x.i))`);
    await cdp.evaluate(`location.hash = '#d=${seriesIds[0] || ''}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const seriesChip = await cdp.evaluate(
      "(() => { const b=document.querySelector('#detailMeta [data-jump-series]'); return b ? [b.dataset.jumpSeries, b.textContent] : null; })()");
    const seriesCount = Number((String(seriesChip && seriesChip[1]).match(/(\d+) 部/) || [])[1] || 0);
    check('详情展示系列入口与部数', !!seriesChip && seriesChip[0] === seriesName && seriesCount >= 5, String(seriesChip));
    // 同系列其他作品：详情内直接列出并切换，按发售日升序，最多 12 部
    const seriesSibs = await cdp.evaluate(`(() => {
      const head = document.querySelector('#detailSimilar .series-head');
      const rows = [...document.querySelectorAll('#detailSimilar .series-list [data-sim]')];
      return { head: head ? head.textContent : '', n: rows.length,
        ids: rows.map((b) => String(b.dataset.sim)), cur: String(${JSON.stringify(seriesIds[0] || '')}) };
    })()`);
    const expectSibs = Math.min(seriesCount - 1, 12);
    check('详情列出同系列其他作品', /同系列/.test(seriesSibs.head) && seriesSibs.n === expectSibs &&
      seriesSibs.ids.every((id) => id !== seriesSibs.cur), seriesSibs.n + ' 部 / 应有 ' + expectSibs);
    const sibOpen = await cdp.evaluate(`(() => {
      const b = document.querySelector('#detailSimilar .series-list [data-sim]');
      if (!b) return null;
      const title = b.querySelector('.sim-title').textContent;
      const id = String(b.dataset.sim);
      b.click();
      return { title: title, id: id };
    })()`);
    await sleep(350);
    const sibState = await cdp.evaluate(
      "(() => ({ title: document.getElementById('modalTitle').textContent, hash: location.hash," +
      " hidden: document.getElementById('modal').hidden }))()");
    check('点同系列条目直接切换详情', !!sibOpen && sibState.hidden === false &&
      sibState.title.indexOf(sibOpen.title) >= 0 && sibState.hash.indexOf('d=' + sibOpen.id) >= 0,
      (sibOpen ? sibOpen.title : '无') + ' → ' + sibState.title);
    await cdp.evaluate("document.querySelector('#detailMeta [data-jump-series]').click()");
    await sleep(450);
    const seriesState = await cdp.evaluate(
      "(() => { const ids=[...document.querySelectorAll('.card')].map((c)=>String(c.dataset.id));" +
      " const S=window.GL_SERIES||{n:[],m:{}}; const key=(x)=>x.vx?String(x.vx):(x.vo&&x.vo.v?String(x.vo.v):'b:'+String(x.i));" +
      " const sname=(x)=>S.n[S.m[key(x)]]||'';" +
      " const ok=ids.every((id)=>{ const x=(window.GL_DATA||[]).find((y)=>String(y.i)===id);" +
      ` return x && sname(x)===${JSON.stringify(seriesName)}; });` +
      " return { hidden: document.getElementById('modal').hidden, ids: ids, ok: ok, chips: document.getElementById('filterChips').textContent, hash: location.hash }; })()");
    check('点系列即筛选该系列全部作品',
      seriesState.hidden === true && seriesCount >= 2 && seriesState.ids.length === seriesCount,
      seriesState.ids.length + ' 张（详情标注 ' + seriesCount + ' 部）');
    check('系列筛选写入 hash 与筛选标签',
      /se=/.test(seriesState.hash) && /系列/.test(seriesState.chips) && seriesState.chips.includes(seriesName),
      String(seriesState.chips).slice(0, 40));
    await cdp.evaluate("location.hash = '#se=' + encodeURIComponent('不存在的系列')");
    await sleep(400);
    const badSeries = await cdp.evaluate(
      "(() => [document.querySelectorAll('.card').length, document.getElementById('filterChips').textContent])()");
    check('非法系列链接自动忽略', badSeries[0] === 240 && !/系列/.test(badSeries[1]), String(badSeries));
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    // 系列一览：列出全部系列，点击即筛选，Esc 关闭
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"series\"]').click()");
    await waitFor("document.getElementById('seriesModal') && document.getElementById('seriesModal').hidden === false");
    const seriesPanel = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#seriesBody [data-series-pick]')];
      const first = rows[0];
      const num = first ? first.querySelector('.num') : null;
      return {
        rows: rows.length,
        total: document.getElementById('seriesTotal').textContent,
        first: first ? first.dataset.seriesPick : '',
        firstCount: num ? Number((num.textContent.match(/^(\\d+)/) || [])[1] || 0) : 0
      };
    })()`);
    check('系列一览列出全部系列', seriesPanel.rows >= 40 &&
      /^\d+ 个系列 · \d+ 部$/.test(seriesPanel.total) &&
      Number(seriesPanel.total.match(/^(\d+)/)[1]) === seriesPanel.rows,
      seriesPanel.total + ' / ' + seriesPanel.rows + ' 行');
    // 面板内搜索：只保留名称命中的系列，顶部汇总保持全量
    const seriesSearch = await cdp.evaluate(`(() => {
      const input = document.getElementById('seriesSearch');
      input.value = '秋之';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rows = [...document.querySelectorAll('#seriesBody [data-series-pick]')];
      const heading = (document.querySelector('#seriesBody h3') || {}).textContent || '';
      const total = document.getElementById('seriesTotal').textContent;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return { names: rows.map((r) => r.dataset.seriesPick), heading: heading, total: total,
        restored: document.querySelectorAll('#seriesBody [data-series-pick]').length };
    })()`);
    const searchCount = (seriesSearch.heading.match(/（(\d+) \/ (\d+)）/) || [])[1];
    check('系列一览可按名称搜索',
      seriesSearch.names.length >= 1 && seriesSearch.names.indexOf(seriesName) >= 0 &&
      seriesSearch.names.every(function (n) { return n.indexOf('秋之') >= 0; }) &&
      Number(searchCount) === seriesSearch.names.length && /个系列/.test(seriesSearch.total) &&
      seriesSearch.restored === seriesPanel.rows,
      seriesSearch.names.join(',') + ' / ' + seriesSearch.heading);
    await cdp.evaluate("document.querySelector('#seriesBody [data-series-pick]').click()");
    await sleep(500);
    const seriesPanelJump = await cdp.evaluate(
      "(() => ({ hidden: document.getElementById('seriesModal').hidden," +
      " n: document.querySelectorAll('.card').length," +
      " chips: document.getElementById('filterChips').textContent," +
      " hash: location.hash }))()");
    check('系列一览选择后即筛选该系列',
      seriesPanelJump.hidden === true && seriesPanelJump.n === seriesPanel.firstCount &&
      seriesPanelJump.chips.includes(seriesPanel.first) && /se=/.test(seriesPanelJump.hash),
      seriesPanel.first + ' → ' + seriesPanelJump.n + ' 张');
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"series\"]').click()");
    await waitFor("document.getElementById('seriesModal').hidden === false");
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);
    check('Esc 可关闭系列一览',
      await cdp.evaluate("document.getElementById('seriesModal').hidden") === true);
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    // 开发商一览：默认列出 ≥2 部开发商，面板内可搜索、可切换显示全部，点击即筛选
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"devs\"]').click()");
    await waitFor("document.getElementById('devModal') && document.getElementById('devModal').hidden === false");
    const devPanel = await cdp.evaluate(`(() => {
      const d = window.GL_DATA || [];
      const counts = {};
      d.forEach((x) => (x.dev || []).forEach((n) => { counts[n] = (counts[n] || 0) + 1; }));
      const names = Object.keys(counts);
      return {
        rows: document.querySelectorAll('#devBody [data-dev-pick]').length,
        expected: names.filter((n) => counts[n] >= 2).length,
        names: names.length,
        covered: d.filter((x) => x.dev && x.dev.length).length,
        total: document.getElementById('devTotal').textContent
      };
    })()`);
    check('开发商一览默认列出 ≥2 部开发商', devPanel.rows === devPanel.expected && devPanel.rows > 100 &&
      devPanel.total === devPanel.names + ' 个开发商 · 覆盖 ' + devPanel.covered + ' 部',
      devPanel.rows + ' 行 / 共 ' + devPanel.names + ' 个');

    await cdp.evaluate("(() => { const i=document.getElementById('devSearch'); i.value='key'; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await sleep(200);
    const devSearchRows = await cdp.evaluate(
      "(() => { const rows=[...document.querySelectorAll('#devBody [data-dev-pick]')];" +
      " return { n: rows.length, bad: rows.filter((r)=>r.dataset.devPick.toLowerCase().indexOf('key')<0).length }; })()");
    check('开发商一览支持面板内搜索', devSearchRows.n > 0 && devSearchRows.bad === 0, devSearchRows.n + ' 行含 key');

    await cdp.evaluate("(() => { const i=document.getElementById('devSearch'); i.value='';" +
      " i.dispatchEvent(new Event('input',{bubbles:true})); document.getElementById('devToggleAll').click(); })()");
    await sleep(200);
    const devAll = await cdp.evaluate("document.querySelectorAll('#devBody [data-dev-pick]').length");
    check('可切换显示仅 1 部的开发商', devAll === devPanel.names, devAll + ' 行');

    const firstDev = await cdp.evaluate("(() => { const r=document.querySelector('#devBody [data-dev-pick]');" +
      " return r ? [r.dataset.devPick, Number((r.querySelector('.num').textContent.match(/^(\\d+)/)||[])[1]||0)] : null; })()");
    await cdp.evaluate("document.querySelector('#devBody [data-dev-pick]').click()");
    await sleep(500);
    const devJump = await cdp.evaluate(
      "(() => ({ hidden: document.getElementById('devModal').hidden," +
      " n: document.querySelectorAll('.card').length," +
      " chips: document.getElementById('filterChips').textContent," +
      " hash: location.hash }))()");
    check('开发商一览选择后即筛选该开发商',
      devJump.hidden === true && devJump.n === firstDev[1] &&
      devJump.chips.includes(firstDev[0]) && /dv=/.test(devJump.hash),
      firstDev[0] + ' → ' + devJump.n + ' 张');
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    // 制作人员一览：默认剧本 ≥2 部，可切换类型、搜索、点击筛选与 Esc
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"staffs\"]').click()");
    await waitFor("document.getElementById('staffModal') && document.getElementById('staffModal').hidden === false");
    const staffPanel = await cdp.evaluate(`(() => {
      ${STAFF_JS}
      const d = window.GL_DATA || [];
      const counts = {};
      d.forEach((x) => staffOf(x, 'sc').forEach((n) => { counts[n] = (counts[n] || 0) + 1; }));
      const names = Object.keys(counts);
      return {
        rows: document.querySelectorAll('#staffBody [data-staff-pick]').length,
        expected: names.filter((n) => counts[n] >= 2).length,
        names: names.length,
        covered: d.filter((x) => staffOf(x, 'sc').length).length,
        total: document.getElementById('staffTotal').textContent
      };
    })()`);
    check('制作人员一览默认列出 ≥2 部剧本', staffPanel.rows === staffPanel.expected && staffPanel.rows > 100 &&
      staffPanel.total === '剧本 ' + staffPanel.names + ' 人 · 覆盖 ' + staffPanel.covered + ' 部',
      staffPanel.rows + ' 行 / 共 ' + staffPanel.names + ' 人');

    const staffAr = await cdp.evaluate(`(() => {
      document.getElementById('staffKind').value = 'ar';
      document.getElementById('staffKind').dispatchEvent(new Event('change', { bubbles: true }));
      ${STAFF_JS}
      const d = window.GL_DATA || [];
      const counts = {};
      d.forEach((x) => staffOf(x, 'ar').forEach((n) => { counts[n] = (counts[n] || 0) + 1; }));
      const names = Object.keys(counts);
      return {
        rows: document.querySelectorAll('#staffBody [data-staff-pick]').length,
        expected: names.filter((n) => counts[n] >= 2).length,
        total: document.getElementById('staffTotal').textContent
      };
    })()`);
    check('制作人员一览可切换原画类型', staffAr.rows === staffAr.expected && staffAr.rows > 100 &&
      staffAr.total.indexOf('原画') === 0, staffAr.rows + ' 行 · ' + staffAr.total);

    const staffSearchRows = await cdp.evaluate(`(() => {
      document.getElementById('staffKind').value = 'sc';
      document.getElementById('staffKind').dispatchEvent(new Event('change', { bubbles: true }));
      const rows = [...document.querySelectorAll('#staffBody [data-staff-pick]')];
      const name = rows[0].dataset.staffPick;
      const input = document.getElementById('staffSearch');
      input.value = name.slice(0, 2);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const after = [...document.querySelectorAll('#staffBody [data-staff-pick]')];
      return {
        n: after.length,
        bad: after.filter((r) => r.dataset.staffPick.toLowerCase().indexOf(name.slice(0, 2).toLowerCase()) < 0).length
      };
    })()`);
    check('制作人员一览支持面板内搜索', staffSearchRows.n > 0 && staffSearchRows.bad === 0,
      staffSearchRows.n + ' 行命中');

    await cdp.evaluate("(() => { const i=document.getElementById('staffSearch'); i.value='';" +
      " i.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await sleep(150);
    const firstStaff = await cdp.evaluate("(() => { const r=document.querySelector('#staffBody [data-staff-pick]');" +
      " return r ? [r.dataset.staffPick, Number((r.querySelector('.num').textContent.match(/^(\\d+)/)||[])[1]||0)] : null; })()");
    await cdp.evaluate("document.querySelector('#staffBody [data-staff-pick]').click()");
    await sleep(500);
    const staffPanelJump = await cdp.evaluate(
      "(() => ({ hidden: document.getElementById('staffModal').hidden," +
      " n: document.querySelectorAll('.card').length," +
      " chips: document.getElementById('filterChips').textContent," +
      " hash: location.hash }))()");
    check('制作人员一览选择后即筛选该人员',
      staffPanelJump.hidden === true && staffPanelJump.n === firstStaff[1] &&
      staffPanelJump.chips.includes(firstStaff[0]) && /sk=sc/.test(staffPanelJump.hash) && /sv=/.test(staffPanelJump.hash),
      firstStaff[0] + ' → ' + staffPanelJump.n + ' 张');
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"staffs\"]').click()");
    await waitFor("document.getElementById('staffModal').hidden === false");
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);
    check('Esc 可关闭制作人员一览',
      await cdp.evaluate("document.getElementById('staffModal').hidden") === true);

    // 题材一览：列出全部有作品的题材，显示汇总卡与我的进度，点击即筛选
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"genres\"]').click()");
    await waitFor("document.getElementById('genreModal') && document.getElementById('genreModal').hidden === false");
    const genrePanel = await cdp.evaluate(`(() => {
      const ids = new Set();
      (window.GL_DATA || []).forEach((x) => (x.tg || []).forEach((g) => ids.add(g)));
      const rows = [...document.querySelectorAll('#genreBody [data-genre-pick]')];
      return {
        rows: rows.length,
        expected: ids.size,
        first: rows[0] ? rows[0].dataset.genrePick : '',
        firstLabel: rows[0] ? rows[0].querySelector('.lbl').textContent : '',
        firstCount: rows[0] ? Number((rows[0].querySelector('.num').textContent.match(/^(\\d+)/) || [])[1] || 0) : 0,
        total: document.getElementById('genreTotal').textContent,
        cards: document.querySelectorAll('#genreBody .stat-card').length
      };
    })()`);
    check('题材一览列出全部有作品的题材', genrePanel.rows === genrePanel.expected && genrePanel.rows >= 15 &&
      /^\d+ \/ \d+ 个题材 · 覆盖 \d+ 部$/.test(genrePanel.total) && genrePanel.cards === 3,
      genrePanel.rows + ' 行 / 期望 ' + genrePanel.expected + ' / 卡片 ' + genrePanel.cards + ' / ' + genrePanel.total);

    await cdp.evaluate("document.querySelector('#genreBody [data-genre-pick]').click()");
    await sleep(500);
    const genreJump = await cdp.evaluate(
      "(() => ({ hidden: document.getElementById('genreModal').hidden," +
      " n: document.querySelectorAll('.card').length," +
      " chips: document.getElementById('filterChips').textContent," +
      " hash: location.hash }))()");
    check('题材一览选择后即筛选该题材',
      genreJump.hidden === true && genreJump.n === Math.min(genrePanel.firstCount, 240) &&
      genreJump.chips.includes(genrePanel.firstLabel) && /gr=/.test(genreJump.hash),
      genrePanel.firstLabel + ' → ' + genreJump.n + ' 张');
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"genres\"]').click()");
    await waitFor("document.getElementById('genreModal').hidden === false");
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);
    check('Esc 可关闭题材一览',
      await cdp.evaluate("document.getElementById('genreModal').hidden") === true);

    // 平台一览：列出全部平台，显示汇总卡，点击即筛选，Esc 关闭
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"platforms\"]').click()");
    await waitFor("document.getElementById('platformModal') && document.getElementById('platformModal').hidden === false");
    const platformPanel = await cdp.evaluate(`(() => {
      const names = new Set();
      (window.GL_DATA || []).forEach((x) => (x.pl || []).forEach((p) => names.add(p)));
      const rows = [...document.querySelectorAll('#platformBody [data-platform-pick]')];
      return {
        rows: rows.length,
        expected: names.size,
        first: rows[0] ? rows[0].dataset.platformPick : '',
        firstCount: rows[0] ? Number((rows[0].querySelector('.num').textContent.match(/^(\\d+)/) || [])[1] || 0) : 0,
        total: document.getElementById('platformTotal').textContent,
        cards: document.querySelectorAll('#platformBody .stat-card').length
      };
    })()`);
    check('平台一览列出全部平台', platformPanel.rows === platformPanel.expected && platformPanel.rows >= 20 &&
      /^\d+ 个平台 · 覆盖 \d+ 部 · \d+ 部支持多平台$/.test(platformPanel.total) && platformPanel.cards === 3,
      platformPanel.rows + ' 行 / ' + platformPanel.total);

    await cdp.evaluate("document.querySelector('#platformBody [data-platform-pick]').click()");
    await sleep(500);
    const platformJump = await cdp.evaluate(
      "(() => ({ hidden: document.getElementById('platformModal').hidden," +
      " n: document.querySelectorAll('.card').length," +
      " chips: document.getElementById('filterChips').textContent," +
      " hash: location.hash }))()");
    check('平台一览选择后即筛选该平台',
      platformJump.hidden === true && platformJump.n === Math.min(platformPanel.firstCount, 240) &&
      platformJump.chips.includes('平台') && platformJump.chips.includes(platformPanel.first) &&
      /f=/.test(platformJump.hash),
      platformPanel.first + ' → ' + platformJump.n + ' 张');
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"platforms\"]').click()");
    await waitFor("document.getElementById('platformModal').hidden === false");
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);
    check('Esc 可关闭平台一览',
      await cdp.evaluate("document.getElementById('platformModal').hidden") === true);

    // ---------- 加入 / 状态 / 批量 ----------
    const targetId = await cdp.evaluate("document.querySelector('.card').dataset.id");
    await cdp.evaluate("document.querySelector('.card [data-act=\"toggle\"]').click()");
    await sleep(300);
    const stored = await cdp.evaluate("JSON.stringify(JSON.parse(localStorage.getItem('yuc_gl_mine_v1') || '{}'))");
    check('加入后写入 yuc_gl_mine_v1', stored.includes('"s":"want"') && stored.includes(targetId), stored.slice(0, 80));
    const badge = await cdp.evaluate("document.querySelector('.card .badge.status') ? document.querySelector('.card .badge.status').textContent : ''");
    check('卡片显示「想玩」状态', badge === '想玩', badge);

    await cdp.evaluate("(() => { const t=[...document.querySelectorAll('.tab')].find((b)=>b.dataset.tab==='mine'); t.click(); })()");
    await sleep(300);
    const mineN = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('我的游玩显示已加入条目', mineN === 1, mineN + ' 张');

    await cdp.evaluate("document.querySelector('.card .card-link').click()");
    await waitFor("document.getElementById('modal').hidden === false");
    await cdp.evaluate("(() => { const b=[...document.querySelectorAll('#statusOpts [data-status]')].find((x)=>x.dataset.status==='doing'); b.click(); })()");
    await sleep(300);
    const doing = await cdp.evaluate("JSON.parse(localStorage.getItem('yuc_gl_mine_v1'))['" + targetId + "'].s");
    check('详情内可切换为在玩', doing === 'doing', String(doing));

    await cdp.evaluate("document.getElementById('bulkBtn').click()");
    await sleep(200);
    await cdp.evaluate("document.querySelector('.card [data-act=\"select\"]').click()");
    await sleep(200);
    await cdp.evaluate("document.querySelector('[data-bulk=\"done\"]').click()");
    await sleep(300);
    const bulkDone = await cdp.evaluate("JSON.parse(localStorage.getItem('yuc_gl_mine_v1'))['" + targetId + "'].s");
    check('批量标记为已通关', bulkDone === 'done', String(bulkDone));
    const undoBtn = await cdp.evaluate("!!document.getElementById('toastAct')");
    if (undoBtn) {
      await cdp.evaluate("document.getElementById('toastAct').click()");
      await sleep(300);
    }
    const undone = await cdp.evaluate("JSON.parse(localStorage.getItem('yuc_gl_mine_v1'))['" + targetId + "'].s");
    check('撤销批量操作恢复原状态', undoBtn && undone === 'doing', String(undone));

    // ---------- 存储写入失败时必须如实告知（不能报成功） ----------
    // 缺陷形态（2026-11-28 实测）：7 处调用点写成 `saveMine(); toast('已标记为…')`，
    // 两次 toast 在同一个任务里，浏览器连一帧都来不及绘制 —— 失败提示**一次都没显示过**，
    // 用户只看到「已加入我的游玩」，而 localStorage 里什么都没写进去。
    //
    // 这条断言的要求（两点缺一不可）：
    //   1. 常驻通道（storageWarn 横幅）必须显示 —— toast 一闪而过，不能作为唯一告知手段；
    //   2. 不允许出现任何「已…」成功文案 —— 用 MutationObserver 记录 toast 的**全部历史**，
    //      不能只读最终文本（最终文本可能被后续其他 toast 覆盖，例如 PWA 安装提示）。
    //
    // 测试替身改 Storage.prototype，不能改 localStorage 实例：
    // 给实例加自有属性会让 Object.keys(localStorage) 多出一项，污染其他键名断言。
    await cdp.evaluate(`
      (() => {
        window.__toastSeen = [];
        var el = document.getElementById('toast');
        window.__toastMo && window.__toastMo.disconnect();
        window.__toastMo = new MutationObserver(() => { window.__toastSeen.push(el.textContent); });
        window.__toastMo.observe(el, { childList: true, subtree: true, characterData: true });
        window.__origSetItem = window.__origSetItem || Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (String(k).indexOf('yuc_gl_mine') >= 0) {
            var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
          }
          return window.__origSetItem.call(this, k, v);
        };
        return 'ok';
      })()
    `);
    // 走真实 UI：卡片上的「加入/移出」按钮
    const failClick = await cdp.evaluate(`
      (() => {
        var b = [...document.querySelectorAll('.card [data-act="toggle"]')][0];
        if (!b) return 'no-btn';
        b.click();
        return 'clicked';
      })()
    `);
    await sleep(900);
    const failState = await cdp.evaluate(`
      (() => ({
        warnHidden: document.getElementById('storageWarn').hidden,
        warnText: document.getElementById('storageWarn').textContent,
        seen: window.__toastSeen || [],
        finalToast: document.getElementById('toast').textContent
      }))()
    `);
    await cdp.evaluate("Storage.prototype.setItem = window.__origSetItem; window.__toastMo.disconnect(); 'restored'");
    const sawFailMsg = failState.seen.some((t) => /保存失败|禁止本地存储/.test(t));
    const sawOkMsg = failState.seen.some((t) => /已加入|已移出|已标记|已恢复|已清空/.test(t));
    check('存储写入失败时如实告知且不误报成功',
      failClick === 'clicked' && failState.warnHidden === false && sawFailMsg && !sawOkMsg,
      `${failClick} · 横幅${failState.warnHidden ? '未显示' : '已显示'} · 失败提示${sawFailMsg ? '有' : '无'} · ` +
      `误报成功${sawOkMsg ? '有:' + failState.seen.filter((t) => /已/.test(t)).join('/') : '无'}`);

    // 自动收回：写入恢复正常后，下一次成功保存应把横幅自己收回去。
    //
    // 此刻的处境：上面那次失败点击把「我的游玩」里唯一一条收藏移出了，
    // 当前标签下已经没有可点的卡片（实测 .card [data-act=toggle] 为 0）。
    // 所以先去全库补一张回来，再在新卡片的按钮上观察横幅是否被收回。
    //
    // 守卫：必须确认进入这一步时横幅**是显示着的**（即上一步的失败确实挂上了它）。
    // 否则「点一下之后 hidden===true」在缺陷态也能通过 —— 因为横幅从来没出现过，
    // hidden 天然为真，这条就成了恒真断言。
    await cdp.evaluate(`
      (() => {
        var a = [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'all');
        if (a) a.click();
        return 'ok';
      })()
    `);
    await sleep(350);
    const autoHide = await cdp.evaluate(`
      (() => {
        var el = document.getElementById('storageWarn');
        var shownBefore = el && !el.hidden;      // 守卫前提：横幅此刻确实可见
        var b = [...document.querySelectorAll('.card [data-act="toggle"]')][0];
        if (!b) return 'no-btn(' + document.querySelectorAll('.card').length + ')';
        b.click();
        if (!shownBefore) return 'not-shown-before';   // 前提不成立就明确失败，不要空跑
        return el.hidden ? 'hidden' : 'visible';
      })()
    `);
    check('写入恢复正常后横幅自动收回', autoHide === 'hidden', String(autoHide));

    // 手动关闭：横幅控件本身要能用（用户看过后能自己收起来）。
    // 这条与上面两条是独立性质 —— 它只保证「显示态下点 × 能收起」，
    // 不负责判断横幅是否该被挂起来（那是第一条断言的职责）。
    const closeBtn = await cdp.evaluate(`
      (() => {
        var el = document.getElementById('storageWarn');
        var btn = document.getElementById('storageWarnClose');
        if (!btn) return 'no-btn';
        el.hidden = false;          // 先摆成显示态，才观察得到「被关闭」
        var wasShown = !el.hidden;
        btn.click();
        // 守卫：必须确认它「曾经显示过」，否则 hidden===true 是恒真的。
        return wasShown && el.hidden ? 'closed' : (wasShown ? 'still-visible' : 'never-shown');
      })()
    `);
    check('存储异常横幅的关闭按钮可用', closeBtn === 'closed', String(closeBtn));

    // ---------- 删除标记写失败时也必须告知（否则同步会把已删记录拉回来） ----------
    // 缺陷形态：persistDeleted() 的 catch 是空的，tombstone 没写进去也没人知道。
    // 后果比收藏本体丢失更隐蔽：刷新后 mergeRemote() 里
    //   `remoteDeleted[id] || myDeleted[id]` 取到 0 → 云端那条被判为「本地没删过」→ 拉回来。
    // 用户看到「我明明删了，过一阵它自己回来了」，中间隔了一次刷新和一次同步，极难归因。
    //
    // 这条断言要同时满足：
    //   1. 常驻横幅显示（说明失败被记账）；
    //   2. toast 历史里没有「已移出」这类成功文案（不能误报）；
    //   3. 持久化的 deleted 里确实**没有**这条 —— 证明我们测的确实是失败路径，
    //      而不是碰巧写成功了。没有第 3 点，这条在正常环境下也会 PASS，属于空跑。
    await cdp.evaluate(`
      (() => {
        // 让删除标记这个键写入失败，收藏本体照常
        window.__origSetItem = window.__origSetItem || Storage.prototype.setItem;
        Storage.prototype.setItem = function (k, v) {
          if (String(k).indexOf('yuc_gl_deleted') >= 0) {
            var e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
          }
          return window.__origSetItem.call(this, k, v);
        };
        window.__delSeen = [];
        var el = document.getElementById('toast');
        window.__delMo && window.__delMo.disconnect();
        window.__delMo = new MutationObserver(() => { window.__delSeen.push(el.textContent); });
        window.__delMo.observe(el, { childList: true, subtree: true, characterData: true });
        return 'ok';
      })()
    `);
    // 走真实 UI：先在「我的游玩」里补一条收藏，再点「移出」
    await cdp.evaluate(`
      (() => {
        var t = [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'mine');
        if (t) t.click();
        return 'ok';
      })()
    `);
    await sleep(300);
    // 不依赖前序断言留下收藏：空了就自己补一条，否则这条断言会因「找不到目标」而假失败。
    // （实测出现过一次 249/250，就是前序清理把收藏清空了。）
    const ensured = await cdp.evaluate(`
      (() => {
        var m = JSON.parse(localStorage.getItem('yuc_gl_mine_v1') || '{}');
        if (Object.keys(m).length) return 'have:' + Object.keys(m).length;
        var a = [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'all');
        if (a) a.click();
        return 'empty';
      })()
    `);
    if (ensured === 'empty') {
      await sleep(350);
      await cdp.evaluate("document.querySelector('.card [data-act=\"toggle\"]').click()");
      await sleep(350);
      await cdp.evaluate(`
        (() => {
          var t = [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'mine');
          if (t) t.click();
          return 'ok';
        })()
      `);
      await sleep(350);
    }
    const delTarget = await cdp.evaluate(`
      (() => {
        var m = JSON.parse(localStorage.getItem('yuc_gl_mine_v1') || '{}');
        var id = Object.keys(m)[0];
        if (!id) return '';
        var cards = [...document.querySelectorAll('.card')];
        var card = cards.find((c) => c.dataset.id === id) || cards[0];
        if (!card) return '';
        var b = card.querySelector('[data-act="toggle"]');
        if (!b) return '';
        b.click();
        return card.dataset.id || id;
      })()
    `);
    await sleep(700);
    const delState = await cdp.evaluate(`
      (() => ({
        warnHidden: document.getElementById('storageWarn').hidden,
        seen: window.__delSeen || [],
        persistedTomb: (() => {
          try { return JSON.parse(localStorage.getItem('yuc_gl_deleted_v1') || '{}'); } catch { return {}; }
        })()
      }))()
    `);
    await cdp.evaluate("Storage.prototype.setItem = window.__origSetItem; window.__delMo && window.__delMo.disconnect(); 'ok'");
    const delSawOk = delState.seen.some((t) => /已移出/.test(t));
    const delSawFail = delState.seen.some((t) => /删除记录没能保存|保存失败/.test(t));
    const tombMissing = !delTarget || !delState.persistedTomb[delTarget];
    check('删除标记写失败时如实告知且不误报',
      !!delTarget && delState.warnHidden === false && delSawFail && !delSawOk && tombMissing,
      delTarget
        ? `目标 ${delTarget} · 横幅${delState.warnHidden ? '未显示' : '已显示'} · 失败提示${delSawFail ? '有' : '无'} · ` +
          `误报成功${delSawOk ? '有' : '无'} · tombstone${tombMissing ? '确实没存进去' : '存进去了(测的不是失败路径)'}`
        : '找不到可移出的收藏');

    // 前面的失败点击把那条收藏从「想玩」变走了，后面「按年份分组」「看板四列」
    // 都依赖「我的游玩」里有卡片。这里补一条回去，恢复到本段开始时的状态。
    await cdp.evaluate(`
      (() => {
        var t = [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'mine');
        if (t) t.click();
        return 'ok';
      })()
    `);
    await sleep(300);
    const mineCount = await cdp.evaluate("document.querySelectorAll('.card').length");
    if (mineCount === 0) {
      await cdp.evaluate(`
        (() => {
          var a = [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'all');
          if (a) a.click();
          return 'ok';
        })()
      `);
      await sleep(300);
      await cdp.evaluate("document.querySelector('.card [data-act=\"toggle\"]').click()");
      await sleep(300);
      await cdp.evaluate(`
        (() => {
          var t = [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'mine');
          if (t) t.click();
          return 'ok';
        })()
      `);
      await sleep(300);
    }


    await cdp.evaluate("document.getElementById('groupBtn').click()");
    await sleep(300);
    const tlGroups = await cdp.evaluate("document.querySelectorAll('.tl-group').length");
    check('我的游玩可按年份分组', tlGroups > 0, tlGroups + ' 组');
    await cdp.evaluate("document.getElementById('groupBtn').click()");

    await setSelect('viewSelect', 'board');
    const boardCols = await cdp.evaluate("document.querySelectorAll('.board-col').length");
    check('看板视图四列状态', boardCols === 4, boardCols + ' 列');
    await setSelect('viewSelect', 'list');
    const listClass = await cdp.evaluate("document.getElementById('grid').classList.contains('list')");
    check('列表视图生效', listClass === true);
    await setSelect('viewSelect', 'grid');

    await shot('desktop-mine');

    // 系列进度：详情与系列一览展示我的收藏 / 通关数，只在运行时计算
    const spName = '秋之回忆';
    const spIds = await cdp.evaluate(`(() => {
      const ids = (window.GL_DATA || []).filter((x) => String(x.cn || x.n || '').indexOf(${JSON.stringify(spName)}) === 0)
        .map((x) => String(x.i)).slice(0, 3);
      const mine = {};
      ids.forEach((id, i) => { mine[id] = { s: i < 2 ? 'done' : 'doing', t: 1000, u: 1000 }; });
      localStorage.setItem('yuc_gl_mine_v1', JSON.stringify(mine));
      return ids;
    })()`);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?sp=${Date.now()}#d=${spIds[0]}` });
    await waitFor("document.getElementById('modal').hidden === false", 15000);
    const spChip = await cdp.evaluate(
      "(() => { const b=document.querySelector('#detailMeta [data-jump-series]'); return b ? b.textContent : ''; })()");
    check('详情系列入口显示我的收藏与通关', /收藏 3/.test(spChip) && /通关 2/.test(spChip), spChip);
    const spHead = await cdp.evaluate("(document.querySelector('#detailSimilar .series-head') || {}).textContent || ''");
    check('同系列头部显示系列进度', /收藏 3/.test(spHead) && /通关 2/.test(spHead), spHead);
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(250);
    // 分组方式支持按系列：同系列收藏聚为一组，未归系列单独成组
    await cdp.evaluate("(() => { const t=[...document.querySelectorAll('.tab')].find((b)=>b.dataset.tab==='mine'); t.click(); })()");
    await sleep(250);
    const contSeries = await cdp.evaluate(`(() => {
      const el = document.getElementById('continueSeries');
      return { hidden: el.hidden, cards: el.querySelectorAll('[data-continue-id]').length, text: el.textContent };
    })()`);
    check('我的游玩显示继续系列', contSeries.hidden === false && contSeries.cards >= 1 &&
      contSeries.text.includes(spName), contSeries.cards + ' 张 / ' + contSeries.text.slice(0, 40));
    await cdp.evaluate("document.getElementById('groupBtn').click()");
    await sleep(250);
    const seriesOpt = await cdp.evaluate("!!document.querySelector('#groupBy option[value=\"series\"]')");
    check('分组方式包含按系列', seriesOpt === true);
    await setSelect('groupBy', 'series');
    const seriesGroup = await cdp.evaluate(`(() => {
      const heads = [...document.querySelectorAll('.tl-group .tl-head')].map((h) => h.textContent);
      return { groups: heads.length, heads: heads, hash: location.hash,
        by: document.getElementById('groupBy').value };
    })()`);
    check('我的游玩可按系列分组',
      seriesGroup.by === 'series' && seriesGroup.groups === 1 &&
      seriesGroup.heads.length === 1 && seriesGroup.heads[0].includes(spName) &&
      /3 部/.test(seriesGroup.heads[0]),
      seriesGroup.heads.join(' / '));
    check('系列分组写入 hash', /gb=series/.test(seriesGroup.hash), seriesGroup.hash.slice(0, 90));
    await cdp.evaluate("document.getElementById('groupBtn').click()");
    await sleep(150);
    await cdp.evaluate("(() => { const t=[...document.querySelectorAll('.tab')].find((b)=>b.dataset.tab==='all'); t.click(); })()");
    await sleep(250);
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"series\"]').click()");
    await waitFor("document.getElementById('seriesModal').hidden === false");
    const spPanel = await cdp.evaluate(`(() => {
      const row = [...document.querySelectorAll('#seriesBody [data-series-pick]')]
        .find((r) => r.dataset.seriesPick === ${JSON.stringify(spName)});
      const cards = [...document.querySelectorAll('#seriesBody .stat-card')].map((c) => c.textContent);
      return { note: row ? (row.querySelector('.rownote') || {}).textContent || '' : '', cards: cards };
    })()`);
    check('系列一览显示我的收藏与通关', /我的 3/.test(spPanel.note) && /通关 2/.test(spPanel.note), String(spPanel.note));
    check('系列一览补充我收藏的系列卡',
      spPanel.cards.some((t) => /我收藏的系列/.test(t) && /^1/.test(t)), spPanel.cards.join(' / '));
    // 面板内「只看我收藏的系列」：只留收藏过的系列，再点一次恢复全量
    const spMineOnly = await cdp.evaluate(`(() => {
      const btn = document.getElementById('seriesToggleMine');
      btn.click();
      const rows = [...document.querySelectorAll('#seriesBody [data-series-pick]')];
      const state = {
        pressed: btn.getAttribute('aria-pressed'),
        names: rows.map((r) => r.dataset.seriesPick),
        heading: (document.querySelector('#seriesBody h3') || {}).textContent || ''
      };
      btn.click();
      state.restored = document.querySelectorAll('#seriesBody [data-series-pick]').length;
      state.pressedAfter = btn.getAttribute('aria-pressed');
      return state;
    })()`);
    check('系列一览可只看我收藏的系列',
      spMineOnly.pressed === 'true' && spMineOnly.names.length === 1 &&
      spMineOnly.names[0] === spName && /1 \/ \d+/.test(spMineOnly.heading) &&
      spMineOnly.restored > 40 && spMineOnly.pressedAfter === 'false',
      spMineOnly.names.join(',') + ' / ' + spMineOnly.heading + ' / 恢复 ' + spMineOnly.restored);
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    // 题材一览我的进度：本地收藏与通关数在对应题材行右侧展示
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"genres\"]').click()");
    await waitFor("document.getElementById('genreModal').hidden === false");
    const genreNotes = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#genreBody [data-genre-pick]')];
      const notes = rows.map((r) => { const n = r.querySelector('.rownote'); return n ? n.textContent : ''; });
      const cards = [...document.querySelectorAll('#genreBody .stat-card')].map((c) => c.textContent);
      return { notes: notes, cards: cards };
    })()`);
    const noteList = genreNotes.notes.filter(Boolean);
    check('题材一览显示我的收藏进度',
      noteList.length > 0 && noteList.every((t) => /^我的 \d+ · 通关 \d+$/.test(t)) &&
      genreNotes.cards.some((t) => /我收藏的题材/.test(t)),
      noteList.slice(0, 3).join(' / '));
    await cdp.evaluate("document.getElementById('genreClose').click()");
    await sleep(200);

    // ---------- 导出 ----------
    await cdp.evaluate(`(() => {
      window.__dl = [];
      const orig = URL.createObjectURL;
      URL.createObjectURL = function (b) { b.text().then((t) => window.__dl.push(t)); return orig.call(URL, b); };
      HTMLAnchorElement.prototype.click = function () { window.__dlName = this.download; };
    })()`);
    await cdp.evaluate("document.getElementById('exportBtn').click()");
    await sleep(500);
    const exported = await cdp.evaluate("window.__dl && window.__dl[0] ? window.__dl[0] : ''");
    let payload = null;
    try { payload = JSON.parse(exported); } catch {}
    check('导出 JSON 使用 yuc-galgame-list 标识', payload && payload.app === 'yuc-galgame-list' && payload.items.length > 0, exported.slice(0, 100));
    const dlName = await cdp.evaluate("window.__dlName || ''");
    check('导出文件名带日期', /^我的游玩-\d{8}\.json$/.test(dlName), dlName);

    await cdp.evaluate("document.getElementById('exportCsv').click()");
    await sleep(400);
    const csv = await cdp.evaluate("window.__dl[1] || ''");
    check('导出 CSV 含平台与开发商列', /条目ID,中文名,原名,平台,开发商/.test(csv), csv.slice(0, 60));

    await cdp.evaluate("document.getElementById('exportMd').click()");
    await sleep(400);
    const md = await cdp.evaluate("window.__dl[2] || ''");
    check('导出 Markdown 含状态表', /# 我的游玩/.test(md) && /\| 游戏 \| 状态 \|/.test(md), md.slice(0, 40));

    // 导入：新增一条 + 一条无效
    const importId = await cdp.evaluate(
      "(() => { const used=JSON.parse(localStorage.getItem('yuc_gl_mine_v1')||'{}'); const x=(window.GL_DATA||[]).find((x)=>!used[String(x.i)] && x.d); return String(x.i); })()");
    await cdp.evaluate(`(() => {
      const data = { app: 'yuc-galgame-list', version: 1, items: [
        { id: ${importId}, status: 'done', addedAt: 1, updatedAt: 2 },
        { id: 999999999, status: 'done' }
      ] };
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(data)], 'backup.json', { type: 'application/json' }));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await sleep(700);
    const importToast = await cdp.evaluate("document.getElementById('toast').textContent");
    check('导入新增并跳过无效记录', /新增 1/.test(importToast) && /跳过 1/.test(importToast), importToast);

    // 清空 + 撤销
    await cdp.evaluate("window.confirm = () => true");
    await cdp.evaluate("document.getElementById('clearBtn').click()");
    await sleep(400);
    const cleared = await cdp.evaluate("Object.keys(JSON.parse(localStorage.getItem('yuc_gl_mine_v1') || '{}')).length");
    check('清空我的游玩', cleared === 0, cleared + ' 条');
    await cdp.evaluate("document.getElementById('toastAct').click()");
    await sleep(400);
    const restored = await cdp.evaluate("Object.keys(JSON.parse(localStorage.getItem('yuc_gl_mine_v1') || '{}')).length");
    check('清空后可撤销恢复', restored > 0, restored + ' 条');

    // ---------- 备份要带上删除标记（墓碑） ----------
    // 缺陷形态：导出的 JSON 只有 items、没有 deleted。
    // 墓碑只活在 localStorage 里，是「这条被删过」的唯一凭据；备份里没有它，
    // 「导出 → 清空 / 换设备 → 导入」之后墓碑就空了，mergeRemote() 里
    // `tomb && tomb >= r.u` 判不出删除 → 云端那条被原样拉回来。
    // 测法：走真实入口造一条墓碑 → 导出 → 抹掉本地 deleted（模拟换设备）→ 冷启动
    //       → 导入刚才那份备份 → 校验墓碑回来了、没把本地收藏误删、过期墓碑被丢弃。
    await cdp.evaluate(`(() => {
      const t = [...document.querySelectorAll('.tab')].find((b) => b.dataset.tab === 'mine');
      if (t) t.click();
    })()`);
    await sleep(300);
    const tombId = await cdp.evaluate(`(() => {
      const b = document.querySelector('.card [data-act="toggle"]');
      if (!b) return '';
      const card = b.closest('.card');
      b.click();
      return card.dataset.id || '';
    })()`);
    await sleep(500);
    const tombStored = await cdp.evaluate(
      "(() => { try { return JSON.parse(localStorage.getItem('yuc_gl_deleted_v1') || '{}'); } catch { return {}; } })()");
    // 注意 __dl 里已累积了前面 CSV / Markdown 的内容，必须按点击前的长度取新增那一条
    const dlBefore = await cdp.evaluate("window.__dl ? window.__dl.length : 0");
    await cdp.evaluate("document.getElementById('exportBtn').click()");
    await sleep(600);
    const exportWithTomb = await cdp.evaluate(
      `window.__dl && window.__dl.length > ${dlBefore} ? window.__dl[${dlBefore}] : ''`);
    let tombBackup = null;
    try { tombBackup = JSON.parse(exportWithTomb); } catch {}
    check('备份导出带上删除标记',
      !!tombId && !!tombStored[tombId] && !!tombBackup && !!tombBackup.deleted &&
        String(tombBackup.deleted[tombId] || '') === String(tombStored[tombId]),
      tombId
        ? `墓碑 ${tombId} · 备份里${tombBackup && tombBackup.deleted
          ? (tombBackup.deleted[tombId] ? '有' : '无') : '无 deleted 字段'}`
        : '找不到可移出的收藏');

    // 抹掉存储里的 deleted：模拟「换了设备 / 清了浏览器缓存」，墓碑彻底不存在了
    await cdp.evaluate("localStorage.setItem('yuc_gl_deleted_v1', '{}'); 'ok'");
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?tomb=${Date.now()}` });
    await waitFor("document.querySelectorAll('.card').length > 0", 15000);
    await waitFor("window.__FULL_DATA_READY === true", 20000);
    const tombScenario = await cdp.evaluate(`(() => {
      const mine = JSON.parse(localStorage.getItem('yuc_gl_mine_v1') || '{}');
      const keep = Object.keys(mine)[0] || '';
      // 找一个库里存在、但本地没收藏的 id，用来测「过期墓碑被丢弃」
      const xx = (window.GL_DATA || []).find((x) => !mine[String(x.i)] && x.d);
      const stale = xx ? String(xx.i) : '';
      const staleTs = Date.now() - 181 * 24 * 60 * 60 * 1000;
      // 注意这里必须先 parse：导出的原文是一段 JSON 字符串，直接赋值会得到字符串
      const payload = JSON.parse(${JSON.stringify(exportWithTomb)});
      payload.deleted = payload.deleted || {};
      payload.deleted[keep] = Date.now();          // 本地还留着这条 → 不该被误删
      if (stale) payload.deleted[stale] = staleTs; // 181 天前 → 该被判过期丢弃
      const dt = new DataTransfer();
      dt.items.add(new File([JSON.stringify(payload)], 'backup-tomb.json', { type: 'application/json' }));
      const input = document.getElementById('fileInput');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { keep: keep, stale: stale };
    })()`);
    await sleep(900);
    const tombAfter = await cdp.evaluate(`(() => {
      const m = JSON.parse(localStorage.getItem('yuc_gl_mine_v1') || '{}');
      const d = JSON.parse(localStorage.getItem('yuc_gl_deleted_v1') || '{}');
      return { mine: m, deleted: d, toast: document.getElementById('toast').textContent };
    })()`);
    const tombRestored = !!tombAfter.deleted[tombId];
    const keepAlive = !!tombScenario.keep && !!tombAfter.mine[tombScenario.keep] && !tombAfter.deleted[tombScenario.keep];
    const staleDropped = !tombScenario.stale || !tombAfter.deleted[tombScenario.stale];
    check('导入备份恢复删除标记且不误删本地收藏',
      tombRestored && keepAlive && staleDropped &&
        /恢复 1 条删除记录/.test(tombAfter.toast) && /跳过 1 条过期删除记录/.test(tombAfter.toast),
      `墓碑${tombRestored ? '已恢复' : '丢了'} · 本地收藏 ${tombScenario.keep || '?'}${keepAlive ? '保留' : '被误删'} · ` +
        `过期墓碑${staleDropped ? '已丢弃' : '被写入'} · ${tombAfter.toast}`);


    // ---------- 云同步（mock GitHub API） ----------
    await cdp.evaluate("localStorage.clear()");
    const syncIds = await cdp.evaluate(`(() => {
      const ids = (window.GL_DATA || []).filter((x) => x.d).slice(0, 2).map((x) => String(x.i));
      const mine = {};
      mine[ids[0]] = { s: 'doing', t: 1000, u: 1000 };
      mine[ids[1]] = { s: 'want', t: 1000, u: 1000 };
      localStorage.setItem('yuc_gl_mine_v1', JSON.stringify(mine));
      localStorage.setItem('yuc_gl_gist_v1', JSON.stringify({ token: 'ghp_mocktoken', gistId: '' }));
      return ids;
    })()`);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?sync=${Date.now()}` });
    await waitFor("document.querySelectorAll('.card').length > 0", 15000);
    await waitFor("window.__FULL_DATA_READY === true", 20000);

    const clickSync = async (gistId) => {
      await cdp.evaluate(`(() => {
        document.getElementById('gistToken').value = 'ghp_mocktoken';
        document.getElementById('gistId').value = ${JSON.stringify(gistId || '')};
        document.getElementById('syncNowBtn').click();
      })()`);
      await sleep(600);
    };

    await clickSync('');
    await waitFor("document.getElementById('syncStatus').textContent.indexOf('已同步') >= 0", 8000);
    const firstSync = await cdp.evaluate(
      "(() => ({ cfg: JSON.parse(localStorage.getItem('yuc_gl_gist_v1') || '{}'), gist: window.__mockGist.gist }))()");
    check('云同步创建 Gist 并写入记录', firstSync.cfg.gistId === 'mockgist123' && !!firstSync.gist &&
      firstSync.gist.app === 'yuc-galgame-list' && firstSync.gist.items.length === 2,
      firstSync.gist ? firstSync.gist.items.length + ' 条' : '无');

    const extraId = await cdp.evaluate(`(() => {
      const mine = JSON.parse(localStorage.getItem('yuc_gl_mine_v1') || '{}');
      const x = (window.GL_DATA || []).find((x) => !mine[String(x.i)] && x.d);
      return x ? String(x.i) : '';
    })()`);
    await cdp.evaluate(`(() => {
      const g = window.__mockGist.gist;
      g.items = g.items.map((it) => String(it.id) === ${JSON.stringify(syncIds[0])}
        ? Object.assign({}, it, { status: 'done', updatedAt: 9000 }) : it);
      g.items.push({ id: ${JSON.stringify(extraId)}, status: 'want', addedAt: 500, updatedAt: 500 });
      g.deleted = {};
      window.__mockGist.gist = g;
    })()`);
    await clickSync('mockgist123');
    const mergeOk = await waitFor(
      "(() => { const m=JSON.parse(localStorage.getItem('yuc_gl_mine_v1')||'{}'); return !!(m[" + JSON.stringify(syncIds[0]) + "] && m[" + JSON.stringify(syncIds[0]) + "].s === 'done' && m[" + JSON.stringify(extraId) + "]); })()",
      8000);
    check('双向合并：远端新状态与新增条目落地', mergeOk === true, syncIds[0] + ' → done, +' + extraId);

    await cdp.evaluate(`window.__mockGist.gist.deleted = { ${JSON.stringify(extraId)}: 99999999999 }`);
    await clickSync('mockgist123');
    const tombOk = await waitFor(
      "(() => { const m=JSON.parse(localStorage.getItem('yuc_gl_mine_v1')||'{}'); const d=JSON.parse(localStorage.getItem('yuc_gl_deleted_v1')||'{}'); return !m[" + JSON.stringify(extraId) + "] && !!d[" + JSON.stringify(extraId) + "]; })()",
      8000);
    check('远端墓碑删除后本地不复活', tombOk === true, extraId);

    await cdp.evaluate("window.__mockGist.mode = '401'");
    await clickSync('mockgist123');
    await sleep(800);
    const authText = await cdp.evaluate("document.getElementById('syncStatus').textContent");
    check('Token 无效立即报错且不自动重试', /Token/.test(authText) && !/自动重试/.test(authText), authText);
    await cdp.evaluate("window.__mockGist.mode = ''; localStorage.removeItem('yuc_gl_gist_v1');");

    // ---------- 设置 / 命令面板 / 无障碍 ----------
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await cdp.evaluate("(() => { const b=[...document.querySelectorAll('#moreMenu [data-more]')].find((x)=>x.dataset.more==='settings'); b.click(); })()");
    await sleep(200);
    await cdp.evaluate("document.querySelector('#fontSeg [data-font=\"lg\"]').click()");
    await sleep(200);
    const fontInfo = await cdp.evaluate("(() => [document.documentElement.getAttribute('data-font'), localStorage.getItem('yuc_gl_settings_v1')])()");
    check('字号设置写入本地存储', fontInfo[0] === 'lg' && /"font":"lg"/.test(fontInfo[1]), String(fontInfo));
    await cdp.evaluate("document.getElementById('settingsReset').click()");
    await cdp.evaluate("document.getElementById('settingsClose').click()");

    const themeBefore = await cdp.evaluate("document.documentElement.getAttribute('data-theme')");
    await cdp.evaluate("document.getElementById('themeBtn').click()");
    await sleep(200);
    const themeAfter = await cdp.evaluate("document.documentElement.getAttribute('data-theme')");
    check('明暗主题可切换', themeBefore !== themeAfter, themeBefore + ' → ' + themeAfter);
    await cdp.evaluate("document.getElementById('themeBtn').click()");

    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))");
    await sleep(250);
    const paletteOpen = await cdp.evaluate("document.getElementById('palette').hidden === false");
    check('Ctrl K 打开命令面板', paletteOpen === true);
    if (paletteOpen) {
      await cdp.evaluate("(() => { const i=document.getElementById('paletteInput'); i.value='导出'; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
      await sleep(250);
      const paletteItems = await cdp.evaluate("document.querySelectorAll('.palette-item').length");
      check('命令面板可搜索命令', paletteItems > 0, paletteItems + ' 项');
      await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
      await sleep(200);
    }

    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}))");
    await sleep(200);
    const helpOpen = await cdp.evaluate("document.getElementById('help').hidden === false");
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    check('「?」打开快捷键帮助', helpOpen === true);

    const skipLink = await cdp.evaluate(
      "(() => { const b=document.getElementById('skipLink'); b.click(); return document.activeElement.id; })()");
    check('跳过头部链接把焦点交给列表', skipLink === 'grid', skipLink);

    const aria = await cdp.evaluate(
      "(() => [document.getElementById('search').getAttribute('aria-label'), document.getElementById('grid').getAttribute('tabindex')])()");
    check('搜索与列表有无障碍标注', !!aria[0] && aria[1] === '-1', String(aria));

    // ---------- PWA ----------
    const manifest = await cdp.evaluate("fetch('manifest.webmanifest').then((r)=>r.text())");
    let mf = null;
    try { mf = JSON.parse(manifest); } catch {}
    check('manifest 名称与快捷方式正确', mf && mf.name.includes('Galgame') && mf.short_name === 'Galgame' && mf.display === 'standalone', mf && mf.name);
    const swText = await cdp.evaluate("fetch('sw.js').then((r)=>r.text())");
    const swCache = (swText.match(/var CACHE = '([^']+)'/) || [])[1] || '';
    check('Service Worker 使用独立缓存并预缓存数据', /^yuc-gl-shell-v\d+$/.test(swCache) && /data\/galgames\.js/.test(swText) && /data\/vndb\.js/.test(swText) && /data\/ymgal\.js/.test(swText) && /data\/vndb-extra\.js/.test(swText) && /data\/bgm-extra\.js/.test(swText), swCache);
    const iconsOk = await cdp.evaluate("Promise.all(['icons/icon-180.png','icons/icon-192.png','icons/icon-512.png'].map((u)=>fetch(u).then((r)=>r.ok)))");
    check('PWA 图标可访问', Array.isArray(iconsOk) && iconsOk.every(Boolean), String(iconsOk));

    // 离线：等 Service Worker 接管并缓存数据后断网重开
    await waitFor("!!(navigator.serviceWorker && navigator.serviceWorker.controller)", 15000);
    const cachedData = await cdp.evaluate(
      `caches.open(${JSON.stringify(swCache)}).then((c)=>Promise.all([c.match('./data/galgames.js'), c.match('./data/vndb.js'), c.match('./data/ymgal.js'), c.match('./data/vndb-extra.js'), c.match('./data/bgm-extra.js')])).then((a)=>a.every(Boolean))`);
    check('Service Worker 已缓存全库数据、第二 / 第三数据源与两类扩展', cachedData === true);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?offline=${Date.now()}` });
    const offlineCards = await waitFor("document.querySelectorAll('.card').length > 0", 15000);
    const offlineData = await cdp.evaluate("!!(window.GL_DATA && window.GL_DATA.length)");
    check('断网重开仍可浏览全库', offlineCards && offlineData === true);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?online=${Date.now()}` });
    await waitFor("document.querySelectorAll('.card').length > 0", 15000);
    await waitFor("window.__FULL_DATA_READY === true", 20000);

    await cdp.evaluate("localStorage.clear()");
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?deep=${Date.now()}#d=1126` });
    await waitFor("document.getElementById('modal').hidden === false", 12000);
    const deepTitle = await cdp.evaluate("document.getElementById('modalTitle').textContent");
    check('深链 #d=1126 直接打开详情', /时空轮回/.test(deepTitle), deepTitle);
    await cdp.evaluate("document.getElementById('modalClose').click()");

    // ---------- v1.2 发现 / 统计 / 安装引导 ----------
    const vndbInfo = await cdp.evaluate(
      "(() => { const v=window.GL_VNDB||{}; const m=v.map||{}; let n=0; (window.GL_DATA||[]).forEach((x)=>{ if(x.vo) n++; }); return [Object.keys(m).length, n, (v.meta||{}).matched||0]; })()");
    check('VNDB 第二数据源已加载并关联', vndbInfo[0] > 100 && vndbInfo[1] === vndbInfo[0], vndbInfo.join(' / '));
    check('VNDB 元信息与映射数量一致', vndbInfo[2] === vndbInfo[0], vndbInfo[2] + ' / ' + vndbInfo[0]);
    const rawHasVo = await cdp.evaluate("!!(window.GL_VNDB && (window.GL_VNDB.map || {})['13'])");
    check('VNDB 数据独立于主库文件', rawHasVo === true);

    const vId = await cdp.evaluate("(() => { const x=(window.GL_DATA||[]).find((x)=>x.vo && x.vo.l && x.vo.r); return x ? String(x.i) : ''; })()");
    await cdp.evaluate(`location.hash = '#d=${vId}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const vndbDetail = await cdp.evaluate(
      "(() => { const m=document.getElementById('detailMeta'); return { text: m.textContent, vndb: (m.querySelector('a[href*=\"vndb.org\"]')||{}).getAttribute ? m.querySelector('a[href*=\"vndb.org\"]').getAttribute('href') : '', bgm: m.querySelector('a[href*=\"bgm.tv\"]') ? 1 : 0 }; })()");
    check('详情展示 VNDB 评分与时长', /VNDB/.test(vndbDetail.text) && /时长/.test(vndbDetail.text), vndbDetail.text.slice(0, 80));
    check('详情提供 Bangumi 与 VNDB 外链', vndbDetail.bgm === 1 && /^https:\/\/vndb\.org\/v\d+$/.test(vndbDetail.vndb), vndbDetail.vndb);

    const recentSaved = await cdp.evaluate("JSON.parse(localStorage.getItem('yuc_gl_recent_v1')||'[]')");
    check('最近浏览写入 yuc_gl_recent_v1', Array.isArray(recentSaved) && recentSaved[0] === vId, JSON.stringify(recentSaved.slice(0, 3)));
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);

    // ---------- VNDB 日系扩展库 ----------
    const extraInfo = await cdp.evaluate(
      "(() => { const e=window.GL_VNDB_EXTRA||{}; const l=e.list||[]; const x=l[0]||{}; return [l.length, (e.meta||{}).count||0, x.i||0, x.vx||'', x.n||'']; })()");
    check('VNDB 日系扩展库已加载', extraInfo[0] > 500 && extraInfo[0] === extraInfo[1],
      extraInfo[0] + ' 条 / 元信息 ' + extraInfo[1]);
    check('扩展库使用独立 ID 段并带 VNDB 编号', Number(extraInfo[2]) >= 1000000 && /^v\d+$/.test(extraInfo[3]),
      extraInfo[2] + ' → ' + extraInfo[3]);
    const extraMerged = await cdp.evaluate(
      "(() => { const main=(window.GL_META||{}).count||0; const ex=((window.GL_VNDB_EXTRA||{}).list||[]).length; " +
      "const bg=((window.GL_BGM_EXTRA||{}).list||[]).length; const rn=((window.GL_RECENT||{}).list||[]).length; " +
      "return [(window.GL_DATA||[]).length, main, ex, bg, rn]; })()");
    check('扩展库已并入全库浏览',
      extraMerged[0] === extraMerged[1] + extraMerged[2] + extraMerged[3] + extraMerged[4], extraMerged.join(' / '));

    await cdp.evaluate(`location.hash = '#d=${extraInfo[2]}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const extraDetail = await cdp.evaluate(`(() => {
      const m=document.getElementById('detailMeta'); const a=m.querySelector('a[href*="vndb.org"]');
      const link=document.getElementById('detailLink');
      return { text: m.textContent, bgm: m.querySelector('a[href*="bgm.tv"]') ? 1 : 0,
        vndb: a ? a.getAttribute('href') : '', href: link.getAttribute('href'), label: link.textContent };
    })()`);
    check('扩展条目详情只提供 VNDB 外链',
      extraDetail.bgm === 0 && /^https:\/\/vndb\.org\/v\d+$/.test(extraDetail.vndb) &&
      extraDetail.href === extraDetail.vndb && extraDetail.label === 'VNDB',
      extraDetail.vndb + ' / ' + extraDetail.label);
    check('扩展条目详情标注来源与 VNDB 数据', /来源/.test(extraDetail.text) && /VNDB/.test(extraDetail.text),
      extraDetail.text.slice(0, 60));
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);

    // ---------- 新作索引（2025+ 全部日系，不设票数门槛） ----------
    const recentInfo = await cdp.evaluate(
      "(() => { const e=window.GL_RECENT||{}; const l=e.list||[]; const m=e.meta||{}; " +
      "const x=l.find((y)=>y.tg&&y.tg.length)||l[0]||{}; " +
      "return [l.length, m.count||0, (m.filter||{}).releasedGte||'', (m.filter||{}).voteMin, x.i||0, x.d||'']; })()");
    check('新作索引已加载', recentInfo[0] > 200 && recentInfo[0] === recentInfo[1],
      recentInfo[0] + ' 条 / 元信息 ' + recentInfo[1]);
    check('新作索引不设票数门槛且限定 2025 起',
      recentInfo[3] === 0 && /^\d{4}-\d{2}-\d{2}$/.test(recentInfo[2] || ''),
      'voteMin=' + recentInfo[3] + ' / since=' + recentInfo[2]);
    const recentNoVote = await cdp.evaluate(
      "(() => { const l=((window.GL_RECENT||{}).list||[]); " +
      "return [l.length, l.filter((x)=>!x.h).length, l.every((x)=>x.rn===1)]; })()");
    check('新作索引收录无票数作品并带 rn 标记',
      recentNoVote[1] > 0 && recentNoVote[2] === true,
      '无票 ' + recentNoVote[1] + ' / ' + recentNoVote[0]);

    const recentDup = await cdp.evaluate(
      "(() => { const all=window.GL_DATA||[]; const ids=new Set(); let dup=0; " +
      "all.forEach((x)=>{const k=String(x.i); if(ids.has(k))dup++; ids.add(k);}); return [all.length, ids.size, dup]; })()");
    check('并入新作后全库无重复 ID', recentDup[2] === 0, recentDup[0] + ' 条 / 唯一 ' + recentDup[1]);

    // 新作筛选：点击后结果必须全部 ≥ 2025，且包含无票作品（这正是按热度排序会漏掉的那批）
    await cdp.evaluate("(() => { location.hash='#tab=all&rn=0'; })()");
    await sleep(300);
    await cdp.evaluate("document.getElementById('recentBtn').click()");
    await sleep(500);
    const recentFilter = await cdp.evaluate(
      "(() => { const cards=[...document.querySelectorAll('.card')].map((c)=>c.dataset.id); " +
      "const byId=new Map((window.GL_DATA||[]).map((x)=>[String(x.i),x])); " +
      "const ds=cards.map((id)=>(byId.get(String(id))||{}).d||''); " +
      "return [cards.length, ds.filter((d)=>String(d).slice(0,4)>='2025').length, " +
      "document.getElementById('recentBtn').getAttribute('aria-pressed'), " +
      "location.hash.indexOf('rn=1')>=0]; })()");
    check('新作筛选只保留 2025 起发售',
      recentFilter[0] > 0 && recentFilter[0] === recentFilter[1],
      recentFilter[1] + ' / ' + recentFilter[0]);
    check('新作筛选状态写入按钮与地址栏',
      recentFilter[2] === 'true' && recentFilter[3] === true, 'aria-pressed=' + recentFilter[2]);

    const recentChip = await cdp.evaluate(
      "(() => { const el=document.getElementById('filterChips'); " +
      "return !!el && !el.hidden && /新作/.test(el.textContent); })()");
    check('新作筛选显示可移除的条件标签', recentChip === true);

    // 关键：新作 66.5% 无评分，若仍按评分排序会被压到 580+ 位，等于白点。
    // 打开开关必须自动切到按发售日，且首屏要出现无评分作品
    const recentSort = await cdp.evaluate(
      "(() => { const byId=new Map((window.GL_DATA||[]).map((x)=>[String(x.i),x])); " +
      "const cards=[...document.querySelectorAll('.card')].map((c)=>byId.get(String(c.dataset.id))||{}); " +
      "return { sort: document.getElementById('sort').value, cards: cards.length, " +
      "noScore: cards.filter((x)=>!x.s).length, " +
      "dates: cards.slice(0,12).map((x)=>String(x.d||'')) }; })()");
    check('新作筛选自动切到按发售日排序', recentSort.sort === 'date', 'sort=' + recentSort.sort);
    check('新作首屏含无评分作品（不被评分排序压到末尾）', recentSort.noScore > 0,
      '首屏 ' + recentSort.cards + ' 张中无评分 ' + recentSort.noScore + ' 张');
    check('新作首屏按发售日降序排列',
      recentSort.dates.length > 1 &&
      recentSort.dates.every((d, i) => i === 0 || String(recentSort.dates[i - 1]).localeCompare(d) >= 0),
      recentSort.dates.slice(0, 4).join(' > '));

    // 未发售：占位日期要有明确标识，且可一键隐藏
    // 注意：按发售日降序后未发售作品被排到末尾，首屏看不到徽章，
    // 因此先切到「2027 年」筛出全部未发售作品再验证标识
    await cdp.evaluate("(() => { location.hash='#tab=all&y=2027&rn=0'; })()");
    await sleep(500);
    const upcoming = await cdp.evaluate(
      "(() => { const cards=[...document.querySelectorAll('.card')]; " +
      "const badges=document.querySelectorAll('.card .badge.upcoming').length; " +
      "return { cards: cards.length, badges }; })()");
    check('未发售作品在卡片上有标识', upcoming.cards > 0 && upcoming.badges === upcoming.cards,
      upcoming.badges + ' 个标识 / ' + upcoming.cards + ' 张卡片');

    await cdp.evaluate("(() => { location.hash='#tab=all&rn=0'; })()");
    await sleep(400);
    await cdp.evaluate("document.getElementById('recentBtn').click()");
    await sleep(500);
    const beforeHide = await cdp.evaluate("document.querySelectorAll('.card').length");
    await cdp.evaluate("document.getElementById('hideUpcomingBtn').click()");
    await sleep(500);
    const afterHide = await cdp.evaluate(
      "(() => { const cards=[...document.querySelectorAll('.card')]; " +
      "const byId=new Map((window.GL_DATA||[]).map((x)=>[String(x.i),x])); " +
      "const d=new Date(); const t=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); " +
      "const norm=(v)=>String(v).length===4?v+'-01-01':String(v); " +
      "const up=cards.filter((c)=>{const x=byId.get(String(c.dataset.id))||{};return norm(x.d||'')>t;}).length; " +
      "return { cards: cards.length, up, pressed: document.getElementById('hideUpcomingBtn').getAttribute('aria-pressed') }; })()");
    check('隐藏未发售开启后不再出现未发售作品',
      afterHide.up === 0 && afterHide.pressed === 'true',
      '剩余 ' + afterHide.cards + ' 张 / 未发售 ' + afterHide.up);
    // 注意：默认排序下未发售作品本就在 583 位之后，首屏 240 张不含它们，
    // 所以这里只校验「开关生效 + 徽章存在」，不校验数量减少
    await cdp.evaluate("document.getElementById('hideUpcomingBtn').click()");
    await sleep(300);

    await cdp.evaluate("document.getElementById('recentBtn').click()");
    await sleep(400);
    const sortRestored = await cdp.evaluate("document.getElementById('sort').value");
    check('关闭新作筛选还原自动改过的排序', sortRestored === 'score', 'sort=' + sortRestored);

    // 年份精度日期必须显示为「2028 年」，不能渲染成 2028-01-01 误导
    const yearItem = await cdp.evaluate(
      "(() => { const x=(window.GL_DATA||[]).find((y)=>/^\\d{4}$/.test(String(y.d||''))); return x ? [x.i, x.d] : []; })()");
    if (yearItem.length) {
      await cdp.evaluate(`location.hash = '#d=${yearItem[0]}'`);
      await waitFor("document.getElementById('modal').hidden === false");
      const yearText = await cdp.evaluate("document.getElementById('detailMeta').textContent");
      check('年份精度日期显示为「YYYY 年」', yearText.indexOf(yearItem[1] + ' 年') >= 0 && yearText.indexOf(yearItem[1] + '-01-01') < 0,
        yearItem[1] + ' → ' + yearText.slice(0, 40));
      await cdp.evaluate("document.getElementById('modalClose').click()");
      await sleep(200);
    }

    // ---------- Bangumi 关联扩展库 ----------
    const bgmInfo = await cdp.evaluate(
      "(() => { const e=window.GL_BGM_EXTRA||{}; const l=e.list||[]; const x=l[0]||{}; return [l.length, (e.meta||{}).count||0, x.i||0, x.n||'', x.bg||0]; })()");
    check('Bangumi 关联扩展库已加载', bgmInfo[0] > 10 && bgmInfo[0] === bgmInfo[1],
      bgmInfo[0] + ' 条 / 元信息 ' + bgmInfo[1]);
    check('关联条目使用 Bangumi ID 并带来源标记',
      Number(bgmInfo[2]) > 0 && Number(bgmInfo[2]) < 1000000 && Number(bgmInfo[4]) === 1,
      bgmInfo[2] + ' / bg=' + bgmInfo[4]);

    await cdp.evaluate(`location.hash = '#d=${bgmInfo[2]}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const bgmDetail = await cdp.evaluate(`(() => {
      const m=document.getElementById('detailMeta'); const link=document.getElementById('detailLink');
      return { text: m.textContent, bgm: m.querySelector('a[href*="bgm.tv"]') ? 1 : 0,
        href: link.getAttribute('href'), label: link.textContent };
    })()`);
    check('关联条目详情保留 Bangumi 外链',
      bgmDetail.bgm === 1 && /^https:\/\/bgm\.tv\/subject\/\d+$/.test(bgmDetail.href) && bgmDetail.label === 'Bangumi',
      bgmDetail.href + ' / ' + bgmDetail.label);
    check('关联条目详情标注 Bangumi 关联来源', /Bangumi 关联/.test(bgmDetail.text), bgmDetail.text.slice(0, 60));
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);

    // ---------- v2.1 月幕第三数据源 ----------
    const ymgalInfo = await cdp.evaluate(
      "(() => { const y=window.GL_YMGAL||{}; const m=y.map||{}; let n=0; (window.GL_DATA||[]).forEach((x)=>{ if(x.ym) n++; }); return [Object.keys(m).length, n, (y.meta||{}).matched||0]; })()");
    check('月幕第三数据源已加载并关联', ymgalInfo[0] > 100 && ymgalInfo[1] === ymgalInfo[0], ymgalInfo.join(' / '));
    check('月幕元信息与映射数量一致', ymgalInfo[2] === ymgalInfo[0], ymgalInfo[2] + ' / ' + ymgalInfo[0]);
    const ymgalFile = await cdp.evaluate(
      "fetch('data/ymgal.js').then((r)=>r.text()).then((t)=>[t.indexOf('window.GL_YMGAL')>=0, t.length])");
    check('月幕数据独立成文件', ymgalFile[0] === true, ymgalFile[1] + ' 字节');

    const ymId = await cdp.evaluate(
      "(() => { const x=(window.GL_DATA||[]).find((x)=>x.ym&&x.ym.hc); return x ? String(x.i) : ((window.GL_DATA||[]).find((x)=>x.ym)||{}).i || ''; })()");
    await cdp.evaluate(`location.hash = '#d=${ymId}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const ymDetail = await cdp.evaluate(
      "(() => { const m=document.getElementById('detailMeta'); const a=m.querySelector('a[href*=\"ymgal.games\"]'); return { text: m.textContent, href: a ? a.getAttribute('href') : '' }; })()");
    check('详情提供月幕外链', /^https:\/\/www\.ymgal\.games\/GA\d+$/.test(ymDetail.href), ymDetail.href);
    check('详情展示月幕中文版标记', /中文版/.test(ymDetail.text), ymDetail.text.slice(0, 60));
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);

    const ymFooter = await cdp.evaluate("!!document.querySelector('footer a[href*=\"ymgal.games\"]')");
    check('页脚注明月幕 Galgame 数据来源', ymFooter === true);

    const ymAliasInfo = await cdp.evaluate(
      "(() => { const m=(window.GL_YMGAL||{}).map||{}; const ids=Object.keys(m).filter((id)=>Array.isArray(m[id].al)&&m[id].al.length); const t=ids.find((id)=>m[id].al.some((a)=>String(a).length>=4)); return [ids.length, t||'', t?m[t].al.find((a)=>String(a).length>=4):'']; })()");
    check('月幕别名数据已加载', ymAliasInfo[0] >= 50, ymAliasInfo[0] + ' 条');
    if (ymAliasInfo[1]) {
      await cdp.evaluate(`(() => { const i=document.getElementById('search'); i.value=${JSON.stringify(ymAliasInfo[2])}; i.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      const aliasHit = await waitFor(`!!document.querySelector('.card[data-id="${ymAliasInfo[1]}"]')`, 4000);
      check('可用月幕别名搜索到作品', aliasHit === true, ymAliasInfo[2] + ' → ' + ymAliasInfo[1]);
      await cdp.evaluate("(() => { const i=document.getElementById('search'); i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
      await sleep(250);
      await cdp.evaluate(`location.hash = '#d=${ymAliasInfo[1]}'`);
      await waitFor("document.getElementById('modal').hidden === false");
      const aliasDetail = await cdp.evaluate("document.getElementById('detailMeta').textContent");
      check('详情展示月幕别名', /月幕别名/.test(aliasDetail), aliasDetail.slice(0, 80));
      await cdp.evaluate("document.getElementById('modalClose').click()");
      await sleep(200);
    } else {
      check('可用月幕别名搜索到作品', false, '无可用别名');
      check('详情展示月幕别名', false, '无可用别名');
    }
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}))");
    await sleep(250);
    check('I 键打开数据统计', await cdp.evaluate("document.getElementById('statsModal').hidden === false") === true);
    const statsInfo = await cdp.evaluate(
      "(() => { const b=document.getElementById('statsBody'); return { cards: b.querySelectorAll('.stat-card').length, bars: b.querySelectorAll('.bar-row').length, text: b.textContent }; })()");
    check('统计面板含覆盖率与分布', statsInfo.cards >= 12 && statsInfo.bars >= 20, statsInfo.cards + ' 卡片 / ' + statsInfo.bars + ' 条');
    check('统计面板显示字段覆盖率百分比', /%/.test(statsInfo.text) && /字段覆盖率/.test(statsInfo.text));
    check('统计面板显示月幕匹配', /月幕匹配/.test(statsInfo.text));
    check('统计面板列出最近浏览', (await cdp.evaluate("document.querySelectorAll('#statsBody [data-stat-recent]').length")) > 0);

    const statPlat = await cdp.evaluate(
      "(() => { const b=document.querySelector('#statsBody [data-stat-platform]'); if(!b) return ''; const v=b.dataset.statPlatform; b.click(); return v; })()");
    await sleep(450);
    const statFiltered = await cdp.evaluate(
      "(() => [document.getElementById('statsModal').hidden, document.getElementById('platform').value, document.querySelectorAll('.card').length])()");
    check('统计条点击即按平台筛选', !!statPlat && statFiltered[0] === true && statFiltered[1] === statPlat && statFiltered[2] > 0,
      statPlat + ' → ' + statFiltered[2] + ' 张');
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}))");
    await sleep(250);
    const statDev = await cdp.evaluate(
      "(() => { const b=document.querySelector('#statsBody [data-stat-dev]'); if(!b) return ''; const v=b.dataset.statDev; b.click(); return v; })()");
    await sleep(450);
    const devFiltered = await cdp.evaluate(
      "(() => [document.getElementById('statsModal').hidden, document.getElementById('developer').value, document.querySelectorAll('.card').length])()");
    check('统计条点击即按开发商筛选', !!statDev && devFiltered[0] === true && devFiltered[1] === statDev && devFiltered[2] > 0,
      statDev + ' → ' + devFiltered[2] + ' 张');
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}))");
    await sleep(200);
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);
    check('Esc 关闭统计面板', await cdp.evaluate("document.getElementById('statsModal').hidden === true") === true);

    // 我的时长估算：按 VNDB 时长汇总已收藏作品的预计总时长
    const playIds = await cdp.evaluate(`(() => {
      const picks = (window.GL_DATA || []).filter((x) => x.vo && x.vo.l > 0).slice(0, 3);
      const sts = ['done', 'doing', 'want'];
      const mine = {};
      picks.forEach((x, i) => { mine[String(x.i)] = { s: sts[i], t: 1000, u: 1000 }; });
      localStorage.setItem('yuc_gl_mine_v1', JSON.stringify(mine));
      return {
        n: picks.length,
        totalH: Math.round(picks.reduce((a, x) => a + x.vo.l, 0) / 60),
        doneH: Math.round(picks[0].vo.l / 60)
      };
    })()`);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?play=${Date.now()}` });
    await waitFor("document.querySelectorAll('.card').length > 0", 15000);
    await waitFor("window.__FULL_DATA_READY === true", 20000);
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'i',bubbles:true}))");
    await sleep(250);
    const playSec = await cdp.evaluate(`(() => {
      const h = [...document.querySelectorAll('#statsBody .stats-sec h3')].find((x) => /我的时长/.test(x.textContent));
      return {
        text: h ? h.parentElement.textContent : '',
        cards: h ? [...h.parentElement.querySelectorAll('.stat-card')].map((c) => c.textContent) : []
      };
    })()`);
    check('统计面板显示我的时长估算', /我的时长/.test(playSec.text) && playSec.cards.length === 3, playSec.cards.join(' / '));
    check('收藏总时长与已通关时长按 VNDB 时长汇总',
      playSec.text.includes(playIds.totalH + ' 小时') && playSec.text.includes(playIds.doneH + ' 小时'),
      playIds.totalH + ' 小时 / 通关 ' + playIds.doneH + ' 小时');
    check('时长估算备注仅统计已匹配条目', /未匹配/.test(playSec.text) && playSec.text.includes(playIds.n + ' 部'),
      '覆盖 ' + playIds.n + ' 部');
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);

    // 我的足迹：按加入月份分组列出收藏，点击条目打开详情
    const timelineSeed = await cdp.evaluate(`(() => {
      const picks = (window.GL_DATA || []).slice(0, 3);
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 15).getTime();
      const mine = {};
      mine[String(picks[0].i)] = { s: 'done', t: now.getTime(), u: now.getTime() };
      mine[String(picks[1].i)] = { s: 'want', t: now.getTime() - 3600000, u: now.getTime() - 3600000 };
      mine[String(picks[2].i)] = { s: 'doing', t: lastMonth, u: lastMonth };
      localStorage.setItem('yuc_gl_mine_v1', JSON.stringify(mine));
      return { n: picks.length };
    })()`);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?tl=${Date.now()}` });
    await waitFor("document.querySelectorAll('.card').length > 0", 15000);
    await waitFor("window.__FULL_DATA_READY === true", 20000);
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"timeline\"]').click()");
    await waitFor("document.getElementById('timelineModal').hidden === false");
    const timelinePanel = await cdp.evaluate(`(() => {
      const rows = [...document.querySelectorAll('#timelineBody [data-timeline-pick]')];
      return {
        rows: rows.length,
        groups: document.querySelectorAll('#timelineBody .tl-group').length,
        total: document.getElementById('timelineTotal').textContent,
        cards: document.querySelectorAll('#timelineBody .stat-card').length,
        firstId: rows[0] ? rows[0].dataset.timelinePick : ''
      };
    })()`);
    check('我的足迹按月份分组列出全部收藏', timelinePanel.rows === timelineSeed.n && timelinePanel.groups >= 2 &&
      /^\d+ 部收藏 · \d+ 个月$/.test(timelinePanel.total) && timelinePanel.cards === 3,
      timelinePanel.rows + ' 行 / ' + timelinePanel.groups + ' 组 / ' + timelinePanel.total);

    await cdp.evaluate("document.querySelector('#timelineBody [data-timeline-pick]').click()");
    await waitFor("document.getElementById('modal').hidden === false");
    const timelineOpen = await cdp.evaluate(
      "(() => ({ hidden: document.getElementById('timelineModal').hidden, id: location.hash }))()");
    check('我的足迹点击条目打开详情并关闭面板',
      timelineOpen.hidden === true && timelineOpen.id.includes('d=' + timelinePanel.firstId),
      timelineOpen.id);
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);

    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await sleep(150);
    await cdp.evaluate("document.querySelector('[data-more=\"timeline\"]').click()");
    await waitFor("document.getElementById('timelineModal').hidden === false");
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);
    check('Esc 可关闭我的足迹',
      await cdp.evaluate("document.getElementById('timelineModal').hidden") === true);

    // 最近浏览去重并置顶
    const recentOrder = await cdp.evaluate("(() => { const l=JSON.parse(localStorage.getItem('yuc_gl_recent_v1')||'[]'); return [l.length, new Set(l).size, l[0]]; })()");
    check('最近浏览去重且最新在前', recentOrder[0] === recentOrder[1] && recentOrder[0] > 0, String(recentOrder));
    check('最近浏览上限 20 条', recentOrder[0] <= 20, recentOrder[0] + ' 条');

    // 摇一部：只在当前筛选结果内抽取
    await cdp.evaluate("document.querySelector('[data-year=\"2020\"]').click()");
    await sleep(300);
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'r',bubbles:true}))");
    await waitFor("document.getElementById('modal').hidden === false", 4000);
    const randomDate = await cdp.evaluate("document.getElementById('detailMeta').textContent");
    check('R 键摇一部随机打开详情', await cdp.evaluate("document.getElementById('modal').hidden === false") === true);
    check('摇一部只从当前筛选结果抽取', /2020/.test(randomDate), randomDate.slice(0, 40));
    await cdp.evaluate("document.getElementById('modalClose').click()");
    await sleep(200);
    await cdp.evaluate("document.querySelector('[data-year=\"all\"]').click()");
    await sleep(300);

    // 安装引导
    await cdp.evaluate("document.getElementById('moreBtn').click()");
    await cdp.evaluate("(() => { const b=[...document.querySelectorAll('#moreMenu [data-more]')].find((x)=>x.dataset.more==='install'); b.click(); })()");
    await sleep(300);
    const installVisible = await cdp.evaluate("document.getElementById('installTip').hidden === false");
    check('安装引导可显示', installVisible === true);
    if (installVisible) {
      await cdp.evaluate("document.getElementById('installTipClose').click()");
      await sleep(150);
      const installDismissed = await cdp.evaluate(
        "(() => [document.getElementById('installTip').hidden, localStorage.getItem('yuc_gl_install_v1')])()");
      check('关闭安装引导后不再提示', installDismissed[0] === true && installDismissed[1] === '1', String(installDismissed));
    }

    // 键盘帮助与命令面板
    const helpText = await cdp.evaluate("document.getElementById('help').textContent");
    check('快捷键帮助包含统计与随机', /I/.test(helpText) && /R/.test(helpText) && /数据统计/.test(helpText) && /摇一部/.test(helpText));
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))");
    await sleep(250);
    await cdp.evaluate("(() => { const i=document.getElementById('paletteInput'); i.value='摇'; i.dispatchEvent(new Event('input',{bubbles:true})); })()");
    await sleep(250);
    const paletteRandom = await cdp.evaluate("document.getElementById('paletteList').textContent");
    check('命令面板可搜索新增命令', /摇一部/.test(paletteRandom), paletteRandom.slice(0, 40));
    await cdp.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await sleep(200);

    // SEO 与体积预算
    const seo = await cdp.evaluate(
      "Promise.all(['robots.txt','sitemap.xml'].map((u)=>fetch(u).then((r)=>r.ok?r.text():''))).then(([r,s])=>[r.indexOf('Sitemap')>=0, s.indexOf('galgame-library')>=0])");
    check('robots 与 sitemap 可访问', seo[0] && seo[1], String(seo));
    const seoMeta = await cdp.evaluate(
      "(() => { const q=(s)=>!!document.querySelector(s); return [q('meta[name=\"description\"]'), q('meta[property=\"og:title\"]'), q('meta[property=\"og:image\"]'), q('link[rel=\"canonical\"]')]; })()");
    check('描述、OG 与 canonical 完整', seoMeta.every(Boolean), String(seoMeta));
    const dataSize = await cdp.evaluate(
      "Promise.all(['data/galgames.js','data/vndb.js','data/ymgal.js','data/vndb-extra.js','data/bgm-extra.js','data/recent-extra.js'].map((u)=>fetch(u).then((r)=>r.text()).then((t)=>t.length)))");
    const dataSum = dataSize.reduce((a, b) => a + b, 0);
    check('数据体积在预算内（<4MB）', dataSum < 4000000, dataSum + ' 字节');
    const devJunk = await cdp.evaluate(
      "(() => { const bad=[]; (window.GL_DATA||[]).forEach((x)=>(x.dev||[]).forEach((d)=>{ if (/co\\.,?\\s*ltd|株式会社$|有限会社$/i.test(d)) bad.push(d); })); return bad.slice(0, 5); })()");
    check('开发商名已归一（无公司后缀）', devJunk.length === 0, devJunk.join(' / '));
    const appVer = await cdp.evaluate("(document.querySelector('meta[name=\"version\"]')||{}).content || ''");
    check('页面版本号 ≥ 1.2.0', /^1\.[2-9]\.|^[2-9]\./.test(appVer), appVer);

    // ---------- 移动端 ----------
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 375, height: 812, deviceScaleFactor: 2, mobile: true,
    });
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?mobile=${Date.now()}` });
    await waitFor("document.querySelectorAll('.card').length > 0", 12000);
    const overflow = await cdp.evaluate(
      "(() => [document.documentElement.scrollWidth, window.innerWidth])()");
    check('375×812 无横向滚动', overflow[0] <= overflow[1] + 1, overflow.join(' / '));

    const touch = await cdp.evaluate(`(() => {
      const els = [document.querySelector('.tab'), document.getElementById('filterToggle'), document.querySelector('.card .ctool')].filter(Boolean);
      return els.map((el) => Math.round(el.getBoundingClientRect().height));
    })()`);
    check('主要触控目标高度 ≥44px', touch.length === 3 && touch.every((h) => h >= 44), String(touch));

    const filterSheet = await cdp.evaluate(
      "(() => { document.getElementById('filterToggle').click(); const open=!document.getElementById('filterSheet').hidden; document.getElementById('filterDone').click(); return open; })()");
    check('移动端筛选抽屉可打开', filterSheet === true);

    await shot('mobile-home');

    const jsErrors = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    check('全程无 JS 异常', jsErrors.length === 0,
      jsErrors.length ? (jsErrors[0].params.exceptionDetails.exception?.description || '').split('\n')[0] : '');

    const passed = results.filter((r) => r.ok).length;
    console.log(`\n通过 ${passed}/${results.length}`);
    process.exitCode = passed === results.length ? 0 : 1;
  } finally {
    try { ws && ws.close(); } catch {}
    // 杀整个浏览器进程树（含 launcher 模式兜底），再等句柄释放后清 profile。
    // 只用 pid 版 taskkill 会漏杀，详见 killBrowserTree 的注释。
    killBrowserTree(child, profile);
    server.close();
    if (!KEEP) {
      await rm(shots, { recursive: true, force: true });
      // 进程被杀掉时浏览器可能仍有句柄未释放，立刻 rm 会 EBUSY；等一小会儿再清。
      // 清理失败不能影响验收结论（它只是临时目录），但也不能静默——打印出来便于排查。
      await new Promise((r) => setTimeout(r, 600));
      try {
        await rm(profile, { recursive: true, force: true });
        if (process.env.VERIFY_DIAG) console.log('[diag] profile 已清理: ' + profile);
      } catch (err) {
        console.log(`提示：profile 清理失败（可忽略）: ${err && err.code ? err.code : err}`);
      }
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // 主动退出：WebSocket / 浏览器子进程 / HTTP server 可能残留事件循环引用，
    // 导致验收跑完后 node 进程不退出（CI 上会挂到 workflow 超时；本地表现为
    // 命令行不返回，而已删掉的临时 profile 因为进程还活着又被重建/占用）。
    setImmediate(() => process.exit(process.exitCode || 0));
  });
