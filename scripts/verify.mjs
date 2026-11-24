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
    check('默认隐藏非 gal 条目', hiddenNonGal === 35, '隐藏 ' + hiddenNonGal + ' 部');
    const metaCount = await cdp.evaluate('(window.GL_META || {}).count || 0');
    const extraCount = await cdp.evaluate('((window.GL_VNDB_EXTRA || {}).list || []).length');
    const bgmExtraCount = await cdp.evaluate('((window.GL_BGM_EXTRA || {}).list || []).length');
    check('全库数据加载', total > 3000 && metaCount + extraCount + bgmExtraCount === total + hiddenNonGal,
      (total + hiddenNonGal) + ' 条（主库 ' + metaCount + ' + VNDB ' + extraCount + ' + 关联 ' + bgmExtraCount + '，默认可见 ' + total + '）');

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

    const datesOk = await cdp.evaluate(
      "(() => (window.GL_DATA||[]).every((x)=>!x.d || /^\\d{4}-\\d{2}-\\d{2}$/.test(x.d)))()");
    check('发售日格式全部合法', datesOk === true);

    const genreCover = await cdp.evaluate(
      "(() => { const d=window.GL_DATA||[]; return d.length ? d.filter((x)=>x.tg&&x.tg.length).length/d.length : 0; })()");
    check('题材覆盖率 ≥80%', genreCover >= 0.80, (genreCover * 100).toFixed(1) + '%');

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

    // 宽松搜索：严格匹配无结果时忽略空格与标点再试一次（如 Fate/stay night → fatestaynight）
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
    const staffId = await cdp.evaluate(
      "(() => { const x=(window.GL_DATA||[]).find((x)=>x.sc&&x.sc.split('、').map((s)=>s.trim()).filter(Boolean).length); return x ? String(x.i) : ''; })()");
    await cdp.evaluate(`location.hash = '#d=${staffId}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const staffLinks = await cdp.evaluate("document.querySelectorAll('#detailMeta [data-jump-staff]').length");
    check('详情剧本与制作人员可点', staffLinks >= 1, staffLinks + ' 个');
    const staffJump = await cdp.evaluate(
      "(() => { const b=document.querySelector('#detailMeta [data-jump-staff]'); if (!b) return null; const v=b.dataset.jumpStaff; const k=b.dataset.staffKind; b.click(); return { v, k }; })()");
    await sleep(450);
    const staffFiltered = await cdp.evaluate(
      `(() => { const ids=[...document.querySelectorAll('.card')].map((c)=>c.dataset.id);` +
      ` const ok=ids.every((id)=>{ const x=(window.GL_DATA||[]).find((y)=>String(y.i)===id);` +
      ` return x && String(x['${staffJump ? staffJump.k : 'sc'}']||'').split('、').map((s)=>s.trim()).indexOf(${JSON.stringify(staffJump ? staffJump.v : '')})>=0; });` +
      ` return [ids.length, ok, document.getElementById('modal').hidden, document.getElementById('filterChips').textContent]; })()`);
    check('详情点制作人员即按该人员筛选', !!staffJump && staffFiltered[0] > 0 && staffFiltered[1] === true && staffFiltered[2] === true,
      (staffJump ? staffJump.k + ' · ' + staffJump.v : '无') + ' → ' + staffFiltered[0] + ' 张');
    check('筛选标签显示制作人员筛选', /剧本|原画|音乐|发行/.test(staffFiltered[3]) && staffFiltered[3].includes(staffJump ? staffJump.v : ''), String(staffFiltered[3]).slice(0, 40));
    await cdp.evaluate("document.getElementById('clearFiltersBtn').click()");
    await sleep(300);

    // 系列聚合：详情展示系列入口，点击后按系列筛选全库，非法系列链接自动忽略
    const seriesData = await cdp.evaluate(
      "(() => window.GL_SERIES ? [window.GL_SERIES.meta.series, window.GL_SERIES.meta.items] : null)()");
    check('系列映射数据已加载', Array.isArray(seriesData) && seriesData[0] === 601 && seriesData[1] === 1704,
      JSON.stringify(seriesData));
    const seriesName = '秋之回忆';
    const seriesIds = await cdp.evaluate(
      `(window.GL_DATA||[]).filter((x)=>String(x.cn||x.n||'').indexOf(${JSON.stringify(seriesName)})===0).map((x)=>String(x.i))`);
    await cdp.evaluate(`location.hash = '#d=${seriesIds[0] || ''}'`);
    await waitFor("document.getElementById('modal').hidden === false");
    const seriesChip = await cdp.evaluate(
      "(() => { const b=document.querySelector('#detailMeta [data-jump-series]'); return b ? [b.dataset.jumpSeries, b.textContent] : null; })()");
    check('详情展示系列入口与部数', !!seriesChip && seriesChip[0] === seriesName && /10 部/.test(seriesChip[1]), String(seriesChip));
    const seriesCount = Number((String(seriesChip && seriesChip[1]).match(/(\d+) 部/) || [])[1] || 0);
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
      const staffValues = (x, k) => String(x[k] || '').split('、').map((v) => v.trim()).filter(Boolean);
      const d = window.GL_DATA || [];
      const counts = {};
      d.forEach((x) => staffValues(x, 'sc').forEach((n) => { counts[n] = (counts[n] || 0) + 1; }));
      const names = Object.keys(counts);
      return {
        rows: document.querySelectorAll('#staffBody [data-staff-pick]').length,
        expected: names.filter((n) => counts[n] >= 2).length,
        names: names.length,
        covered: d.filter((x) => staffValues(x, 'sc').length).length,
        total: document.getElementById('staffTotal').textContent
      };
    })()`);
    check('制作人员一览默认列出 ≥2 部剧本', staffPanel.rows === staffPanel.expected && staffPanel.rows > 100 &&
      staffPanel.total === '剧本 ' + staffPanel.names + ' 人 · 覆盖 ' + staffPanel.covered + ' 部',
      staffPanel.rows + ' 行 / 共 ' + staffPanel.names + ' 人');

    const staffAr = await cdp.evaluate(`(() => {
      document.getElementById('staffKind').value = 'ar';
      document.getElementById('staffKind').dispatchEvent(new Event('change', { bubbles: true }));
      const staffValues = (x, k) => String(x[k] || '').split('、').map((v) => v.trim()).filter(Boolean);
      const d = window.GL_DATA || [];
      const counts = {};
      d.forEach((x) => staffValues(x, 'ar').forEach((n) => { counts[n] = (counts[n] || 0) + 1; }));
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
      genrePanel.rows + ' 行 / ' + genrePanel.total);

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
      "(() => { const main=(window.GL_META||{}).count||0; const ex=((window.GL_VNDB_EXTRA||{}).list||[]).length; const bg=((window.GL_BGM_EXTRA||{}).list||[]).length; return [(window.GL_DATA||[]).length, main, ex, bg]; })()");
    check('扩展库已并入全库浏览',
      extraMerged[0] === extraMerged[1] + extraMerged[2] + extraMerged[3], extraMerged.join(' / '));

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
      "Promise.all(['data/galgames.js','data/vndb.js','data/ymgal.js','data/vndb-extra.js','data/bgm-extra.js'].map((u)=>fetch(u).then((r)=>r.text()).then((t)=>t.length)))");
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
    if (child) child.kill();
    server.close();
    if (!KEEP) await rm(shots, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
