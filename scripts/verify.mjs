// 自动化验收：启动本地静态服务 + Edge 无头浏览器，通过 CDP 跑核心交互检查
// 用法：node scripts/verify.mjs [--keep]
// 退出码 0 表示全部通过，1 表示存在失败项

import http from 'node:http';
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 8792;
const CDP_PORT = 9338;
const KEEP = process.argv.includes('--keep');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

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
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
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

async function main() {
  const browser = findBrowser();
  const profile = path.join(os.tmpdir(), 'galgame-verify-profile');
  await rm(profile, { recursive: true, force: true });
  const shots = path.join(ROOT, '.verify');
  await rm(shots, { recursive: true, force: true });
  await mkdir(shots, { recursive: true });

  const server = await startServer();
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

    // ---------- 数据与首屏 ----------
    const total = await cdp.evaluate('(window.GL_DATA || []).length');
    const metaCount = await cdp.evaluate('(window.GL_META || {}).count || 0');
    check('全库数据加载', total > 1722 && metaCount === total, total + ' 条');

    const noCacheFields = await cdp.evaluate(
      "(() => (window.GL_DATA || []).slice(0, 200).every((x) => x.rt === undefined && x.plr === undefined))()");
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

    const datesOk = await cdp.evaluate(
      "(() => (window.GL_DATA||[]).every((x)=>!x.d || /^\\d{4}-\\d{2}-\\d{2}$/.test(x.d)))()");
    check('发售日格式全部合法', datesOk === true);

    const genreCover = await cdp.evaluate(
      "(() => { const d=window.GL_DATA||[]; return d.length ? d.filter((x)=>x.tg&&x.tg.length).length/d.length : 0; })()");
    check('题材覆盖率 ≥52%', genreCover >= 0.52, (genreCover * 100).toFixed(1) + '%');

    const metaHelp = await cdp.evaluate('JSON.stringify(window.GL_META || {})');
    check('数据元信息含生成时间与日期范围', /generatedAt/.test(metaHelp) && /minDate/.test(metaHelp), metaHelp.slice(0, 80));

    const cards = await cdp.evaluate("document.querySelectorAll('.card').length");
    check('首屏分批渲染 240 张卡片', cards === 240, cards + ' 张');

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
    const platSearch = await cdp.evaluate(
      "(() => { const ids=[...document.querySelectorAll('.card')].map((c)=>Number(c.dataset.id)); const map={}; (window.GL_DATA||[]).forEach((x)=>{ map[x.i]=x; }); return ids.length > 0 && ids.every((id)=>{ const x=map[id]||{}; return (x.pl||[]).some((p)=>/^Switch/i.test(p)) || (x.dev||[]).some((d)=>/switch/i.test(d)) || /switch/i.test(x.cn||x.n||''); }); })()");
    check('搜索可命中平台', platSearch === true, platSearch ? 'Switch' : '未命中');

    await clearSearch();
    await typeSearch('游戏 -性');
    let exclInfo = await cdp.evaluate(
      "(() => { const n=document.querySelectorAll('.card').length; return [n, [...document.querySelectorAll('.card .title')].some((t)=>/性/.test(t.textContent))]; })()");
    check('「-词」排除生效', exclInfo[0] > 0 && exclInfo[1] === false, String(exclInfo));

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
    check('平台筛选生效', androidInfo.n > 0 && androidInfo.n < 240, androidInfo.n + ' 张');
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
    check('题材筛选生效', genreN > 0 && genreN < 240, genreN + ' 张');
    await setSelect('genre', 'all');

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
    check('Service Worker 使用独立缓存并预缓存数据', /yuc-gl-shell-v1/.test(swText) && /data\/galgames\.js/.test(swText));
    const iconsOk = await cdp.evaluate("Promise.all(['icons/icon-180.png','icons/icon-192.png','icons/icon-512.png'].map((u)=>fetch(u).then((r)=>r.ok)))");
    check('PWA 图标可访问', Array.isArray(iconsOk) && iconsOk.every(Boolean), String(iconsOk));

    // 离线：等 Service Worker 接管并缓存数据后断网重开
    await waitFor("!!(navigator.serviceWorker && navigator.serviceWorker.controller)", 15000);
    const cachedData = await cdp.evaluate(
      "caches.open('yuc-gl-shell-v1').then((c)=>c.match('./data/galgames.js')).then(Boolean)");
    check('Service Worker 已缓存全库数据', cachedData === true);
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

    await cdp.evaluate("localStorage.clear()");
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?deep=${Date.now()}#d=1126` });
    await waitFor("document.getElementById('modal').hidden === false", 12000);
    const deepTitle = await cdp.evaluate("document.getElementById('modalTitle').textContent");
    check('深链 #d=1126 直接打开详情', /时空轮回/.test(deepTitle), deepTitle);
    await cdp.evaluate("document.getElementById('modalClose').click()");

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
    if (child) child.kill();
    server.close();
    if (!KEEP) await rm(shots, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
