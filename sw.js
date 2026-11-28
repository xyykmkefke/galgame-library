// 应用壳离线缓存：首页网络优先并带超时回退，其余同源资源缓存优先、后台更新
var CACHE = 'yuc-gl-shell-v70';

var CORE = ['./', './index.html', './manifest.webmanifest', './icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];
var DATA = ['./data/galgames.js', './data/vndb.js', './data/ymgal.js', './data/vndb-extra.js', './data/bgm-extra.js', './data/recent-extra.js', './data/series.js', './data/dev-alias.js', './data/alias-groups.js'];
var IMG_LIMIT = 500;

// 封面缓存有上限：超出后按插入顺序清理最旧的，避免长期使用占满配额
//
// ⚠️ 判断「这条是不是封面」不能靠 URL 正则，也不能靠 req.destination：
//
// ① req.destination 在这里恒为空字符串。Cache API 的 cache.keys() 返回的 Request
//    是从缓存条目重建的，只有 url / method / headers / mode，**不保留 destination**。
//    实测（Edge 无头，2026-11-28）：塞入一张 no-cors 图片，读回来 destination === ''。
//    所以原来那个 `req.destination === 'image' || ...` 的前半段永远为假，
//    真正起作用的只有后半段正则 —— 而那半段是错的。
//
// ② 正则 /bgmimg|anibt|vndb|ymgal/ 会命中应用自己的数据文件：
//    data/vndb.js、data/ymgal.js、data/vndb-extra.js（合计约 2.4MB，三个数据源）。
//    而这三个文件是 install 阶段**最先**写进缓存的，裁剪按插入顺序从头删，
//    于是它们是**最先**被删掉的。实测 620 张封面后误删 6 条：三个数据文件 + 三个 PWA 图标。
//
// 后果：断网后 vndb / 月幕 / VNDB 扩展三个数据源全部加载失败，只剩主库；
// 图标被删还会让桌面图标变白块。而用户完全不知道是自己「多翻了几页」导致的。
//
// 正确做法：反过来标记「哪些绝对不能删」。壳与数据文件是已知的、可枚举的，
// 用白名单排除远比用 URL 猜类型可靠；封面判断则退化为「不在白名单里的都算可回收」。
//
// 白名单用 registration.scope 解析成绝对 URL 再比。不能靠「剥掉第一段路径」去猜部署子路径 ——
// 线上是 /galgame-library/index.html，本地是 /index.html，同一段代码在两边会剥出不同结果
// （本地会把 index.html 整个剥掉，白名单直接失效）。
function shellUrls() {
  var base = self.registration.scope;   // 部署根，例如 https://host/galgame-library/
  var set = {};
  CORE.concat(DATA).forEach(function (rel) {
    try {
      var u = new URL(rel, base);
      // 忽略查询串：页面用 loadScriptOnce('data/vndb-extra.js?v=' + Date.now()) 做强制刷新，
      // 带 ?v= 的条目 url 与预缓存的裸 url 不同，只比 href 会漏掉它们 ——
      // 实测这样仍会把带查询串的数据文件当封面删掉。
      set[u.origin + u.pathname] = 1;
    } catch (e) {}
  });
  return set;
}

function trimImageCache(cache) {
  var keep = shellUrls();
  return cache.keys().then(function (keys) {
    // 白名单里的（壳、图标、数据文件）一律不参与回收 —— 与顺序无关，不会被先删
    var imgs = keys.filter(function (req) {
      var u;
      try { u = new URL(req.url); } catch (e) { return true; }
      return !keep[u.origin + u.pathname];
    });
    if (imgs.length <= IMG_LIMIT) return null;
    var drop = imgs.slice(0, imgs.length - IMG_LIMIT);
    return Promise.all(drop.map(function (req) { return cache.delete(req); }));
  }).catch(function () {});
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (cache) {
      // 壳文件强制走网络，确保新版本生效；数据优先复用刚加载的 HTTP 缓存，避免首访重复下载 2.8MB
      return Promise.all([
        cache.addAll(CORE.map(function (url) {
          return new Request(url, { cache: 'reload' });
        })),
        cache.addAll(DATA),
      ]);
    }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      // 同源还部署着番剧、轻小说等项目，只清理本项目前缀的旧缓存
      return Promise.all(keys.map(function (key) {
        if (key === CACHE) return null;
        if (key.indexOf('yuc-gl-') !== 0) return null;
        return caches.delete(key);
      }));
    }).then(function () {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  // 封面等图片：缓存优先，命中直接返回，未命中走网络并写入缓存
  if (req.destination === 'image') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          // 封面多为跨域 opaque 响应（status 0），同样可以缓存供离线使用
          if (res.ok || res.type === 'opaque') {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) {
              return cache.put(req, copy).then(function () { return trimImageCache(cache); });
            });
          }
          return res;
        });
      })
    );
    return;
  }

  var url = new URL(req.url);

  // 全库数据走 jsDelivr：缓存优先，离线时也能打开
  if (url.hostname.indexOf('jsdelivr.net') >= 0) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res.ok || res.type === 'opaque') {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        }).catch(function () {
          return hit;
        });
        return hit || net;
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // 页面本身：网络优先；1.5s 内没回来就先展示缓存，等下次启动再用新版
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match(req).then(function (hit) {
        var net = fetch(req).then(function (res) {
          if (res.ok) {
            var copy = res.clone();
            caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
          }
          return res;
        }).catch(function () {
          return hit || caches.match('./index.html');
        });
        if (!hit) return net;
        var timer = new Promise(function (resolve) {
          setTimeout(function () { resolve(hit); }, 1500);
        });
        return Promise.race([net, timer]);
      })
    );
    return;
  }

  // 数据与静态资源：立即用缓存，后台拉新版本供下次使用
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res.ok) {
          var copy = res.clone();
          caches.open(CACHE).then(function (cache) { cache.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return hit;
      });
      return hit || net;
    })
  );
});


