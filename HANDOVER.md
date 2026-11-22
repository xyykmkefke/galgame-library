# Galgame 库 · 落实与交接

- 文档日期：2026-11-23
- 当前状态：v2.1.0（数据 1820 条，`npm run verify` 112/112）
- 模板项目：`../番剧`（Bangumi Anime Library v1.6.8）
- 模板线上：<https://xyykmkefke.github.io/bangumi-anime-library/>
- 目标版本：v1.0.0（已达成，v1.1.0 增补数据源与交互改进）

## 1. 目标与边界

做一个本地优先、无后端的 Galgame 浏览 + 游玩记录 PWA，沿用番剧项目的交互与工程体系。

v1.0.0 必须包含：

- 全库浏览：年份、平台、开发商、题材筛选；评分 / 热度 / 发售日 / 名称排序
- 搜索：多关键词交集、`-词` 排除、拼音首字母、标题高亮、搜索历史
- 我的游玩：想玩 / 在玩 / 已通关 / 弃坑（仅四种状态，不记路线、时长、日期）
- 视图：网格 / 列表 / 看板（按状态四列）；按年份、题材、状态分组
- 详情：平台、开发、发行、剧本、原画、音乐、游戏类型、题材、评分、Bangumi 链接、同题材推荐
- 数据：JSON / CSV / Markdown 导出；JSON 导入合并（无效条目提示）
- 云同步：GitHub Gist 双向合并，删除墓碑，失败退避重试
- PWA：可添加到 iOS 主屏幕，离线可打开
- 设置：字号 / 卡片密度 / 动效 / 明暗主题
- 无障碍：跳过头部、焦点陷阱、Esc 归焦、状态播报、44px 触控目标

v1.0.0 明确不做：

- 通关路线 / 结局、游玩时长、通关日期、个人评分、短评
- 本季日历、最近浏览、摇一部、年度回顾
- 地区筛选（绝大多数为日本作品）
- 账号登录、自建后端

## 2. 数据源（已核实）

Bangumi 镜像接口：

```http
POST https://bgmapi.anibt.net/v0/search/subjects?limit=20&offset=0
Content-Type: application/json
User-Agent: yuc-galgame-list/1.0

{
  "keyword": "",
  "sort": "heat",
  "filter": { "type": [4], "tag": ["galgame"] }
}
```

- `type=4` 为游戏；`tag` 精确匹配「galgame」（大小写不敏感）。
- 单页最多 20 条（`limit` 传 50 也只返回 20），按 `offset += 20` 翻页，直到 `offset >= total`。
- 2026-11-22 实测 `total = 1722`，发售日约 1991–2027（含已公布未来发售）。
- 搜索结果已包含 `infobox`、`tags`、`rating`、`collection`，无需逐条请求详情。
- 建议请求间隔 800ms，失败重试 4 次（2s / 4s / 6s 退避）。

标签范围说明：

- `galgame` 1722 条；`视觉小说` 547 条；`ADV` 1633 条，三者高度重叠。
- v1.0.0 先只用 `galgame`；v1.1.0 已补抓 `视觉小说`，与 `galgame` 按 `id` 去重合并后共 1820 条。
- 仍不并入 `ADV`，避免混入大量非 Galgame 的冒险游戏；需要时用 `--tags=galgame,视觉小说,ADV` 显式指定。

## 3. 抓取与产出

新增 `scripts/fetch-games.mjs`，参考 `../番剧/scripts/fetch-bangumi.mjs`：

- 复用 `requestPage` 的重试、`slim` 的压缩思路、`initials` 拼音
- 去掉季度逻辑，按标签 × 发售年份分桶（`offset >= 1000` 翻页上限），末尾 heat / rank / score 各取前 1000 条兜底
- 每桶缓存到 `data/build/{g|vn}-{year}.json`，中断可续跑；`--refresh` 清空缓存重抓
- 桶缓存额外保留 `rt`（原始标签）与 `plr`（原始平台碎片），可离线重算题材与平台归一
- 输出 `data/galgames.js`：

```js
// 由 scripts/fetch-games.mjs 生成，请勿手动修改
window.GL_META = { generatedAt: '...', count: 1820, minDate: '...', maxDate: '...' };
window.GL_DATA = [ /* ... */ ];
```

数据字段（缩写用于控制体积）：

| 字段 | 含义 | 来源 |
|---|---|---|
| `i` | Bangumi ID | `id` |
| `n` | 原名 | `name` |
| `cn` | 中文名 | `name_cn` |
| `d` | 发售日 | `date` |
| `s` | 评分 | `rating.score` |
| `rk` | 排名 | `rating.rank` |
| `h` | 收藏数 | `collection.collect` |
| `img` | 封面 | `images.common` |
| `py` | 拼音首字母 | `pinyin-pro` |
| `tg` | 题材 id 数组 | `scripts/genres.mjs` |
| `pl` | 平台数组 | `infobox`「平台」 |
| `dev` | 开发商数组 | `infobox`「开发」 |
| `pub` | 发行 | `infobox`「发行」 |
| `sc` | 剧本 | `infobox`「剧本」 |
| `ar` | 原画 | `infobox`「原画」 |
| `mu` | 音乐 | `infobox`「音乐」 |
| `gt` | 游戏类型 | `infobox`「游戏类型」 |
| `ns` | 是否 R18 | `nsfw` |
| `rt` | 原始标签（仅抓取缓存，不写入最终文件） | `meta_tags` + `tags`（count ≥ 3） |

`infobox` 的值可能是字符串，也可能是 `[{ v }]` 数组，必须写一个兼容取值函数：

```js
function infoValues(infobox, key) {
  const item = (infobox || []).find((x) => x.key === key);
  if (!item) return [];
  const raw = Array.isArray(item.value) ? item.value : [item.value];
  return raw
    .map((v) => (typeof v === 'string' ? v : (v && v.v) || ''))
    .filter(Boolean);
}
```

- 「平台」：把所有值合并后按 `| 、 / ／ , ，` 拆分，去重、去空。
- 「开发」：按 `、 ， ,` 拆分（不要按 `/` 拆，避免拆坏 `Nitro+` 这类名字），去重。
- 「剧本 / 原画 / 音乐 / 发行 / 游戏类型」：用 `、` 连接为一个字符串，直接展示。
- 缺失字段留空，不丢弃条目。

平台归一（UI 与统计前执行）：

- `Windows`、`Win` → `PC`
- `PlayStation`、`プレイステーション` → `PS`
- `3DSLL`、`3DS` → `3DS`
- `NDSi`、`DS` → `NDS`
- 其余保持原样，过滤空值和明显异常值

题材白名单（`scripts/genres.mjs`，18 个）：

科幻、奇幻、恋爱、校园、日常、悬疑、推理、泣系、郁系、恐怖、猎奇、战斗、冒险、百合、耽美、后宫、女装、机战。

参考标签映射：

- 科幻：科幻、SF、科学幻想、赛博朋克
- 奇幻：奇幻、魔法、幻想
- 恋爱：恋爱、爱情、恋爱喜剧、纯爱、ラブコメ
- 校园：校园、学园、学校
- 日常：日常、生活、慢节奏
- 悬疑：悬疑、谜题、犯罪
- 推理：推理、侦探
- 泣系：泣きゲー、泣系、催泪、感动、治愈
- 郁系：郁、郁系、致郁、黑暗、病态
- 恐怖：恐怖、惊悚、灵异
- 猎奇：猎奇、电波、グロ
- 战斗：战斗、动作、热血
- 冒险：冒险、探索、解谜
- 百合：百合、GL、女子恋爱
- 耽美：耽美、BL、蔷薇
- 后宫：后宫、ハーレム
- 女装：女装、伪娘、男の娘
- 机战：机战、机器人、机甲

标签映射沿用番剧策略：只做精确匹配，低于 3 票的用户标签不参与归类；调整映射表后可离线重算，无需重新联网。

## 4. 个人数据与键名（同源冲突警告）

两个项目都会部署在 `xyykmkefke.github.io` 下，localStorage 与 Cache Storage 按 origin 共享，所有键必须带项目前缀，绝不能复用番剧的键。

| 用途 | 键名 |
|---|---|
| 我的游玩 | `yuc_gl_mine_v1` |
| 筛选偏好 | `yuc_gl_prefs_v1` |
| 搜索历史 | `yuc_gl_hist_v1` |
| 删除墓碑 | `yuc_gl_deleted_v1` |
| 设置 | `yuc_gl_settings_v1` |
| Gist 配置 | `yuc_gl_gist_v1` |
| 备份时间 | `yuc_gl_backup_v1` |
| 待备份改动 | `yuc_gl_dirty_v1` |
| 备份提醒 | `yuc_gl_backup_warn_v1` |
| SW 缓存 | `yuc-gl-shell-v1` |
| Gist 文件名 | `yuc-galgame-list.json` |
| Gist payload app | `yuc-galgame-list` |

单条记录（只有状态，没有进度）：

```js
{
  s: 'want' | 'doing' | 'done' | 'drop',
  t: 0,   // 加入时间戳
  u: 0    // 更新时间戳
}
```

- 状态文案：想玩 / 在玩 / 已通关 / 弃坑
- 合并规则：同一条目按 `u` 取新；删除用墓碑（保留 180 天）
- 导出 JSON：

```json
{
  "app": "yuc-galgame-list",
  "version": 1,
  "exportedAt": "2026-11-22T00:00:00.000Z",
  "items": [
    { "id": 1126, "status": "done", "addedAt": 0, "updatedAt": 0 }
  ]
}
```

## 5. 页面改造映射

以 `../番剧/index.html` v1.6.8 为底稿复制，保留 CSS / 主题 / 工具栏 / 命令面板 / 设置 / 同步 / 导出 / 无障碍，替换下列域相关内容：

| 番剧 | Galgame |
|---|---|
| `ANIME_DATA` / `ANIME_META` | `GL_DATA` / `GL_META` |
| `data/anime-lite.js` 分层加载 | 删除；数据量约 1700 条，直接一次加载 |
| `STATUS` 想看 / 在看 / 看完 / 弃番 | 想玩 / 在玩 / 已通关 / 弃坑 |
| `state.season` + `renderSeasons` | 删除 |
| `state.platform`（动画平台） | 改为游戏平台，取值来自 `pl` |
| `state.region` | 删除 |
| 卡片「集数 / 已看」 | 「平台 / 开发商」 |
| 详情「话数 / 首播」 | 「平台 / 开发 / 发行 / 剧本 / 原画 / 音乐 / 游戏类型 / 发售日」 |
| 日历视图 | 删除 |
| 导出列「已看」 | 删除进度列，只保留状态与加入时间 |
| 播放进度 `ep` | 整段删除（含卡片进度条、批量进度、进度排序） |
| Gist 键与文件名 | 见第 4 节 |
| `PAGE_SIZE` 240 分批 | 保留 |

关键区段（v1.6.8 行号，仅作定位参考）：

- 数据与常量：L2602–2658
- `state`：L2686–2705
- 记录 `normalizeEntry` / `saveMine`：L2737–2820
- `filteredList`：L3439
- 卡片渲染：L3555
- `render`：L3943
- 详情 `renderDetail`：L4107
- 命令面板 `renderPalette`：L4682
- 设置 `syncSettingsUI`：L5290
- 导出：L5572–5639
- 导入：L5641–5686
- Gist 同步：L5715–6100
- 全库加载 `loadFullData`：L6269

搜索、筛选、批量、撤销、看板、分组、分享、备份提醒、重试队列等通用逻辑不要重写，按字段替换即可。

筛选栏要求：

- 年份：默认「全部年份」（数据量小，不做默认本年）
- 平台：`select`，按条目数排序的平台列表
- 开发商：可搜索输入框 + `datalist`，留空表示全部；按 `dev` 数组精确匹配
- 题材、状态、高分 ≥8.0、只看我的、隐藏已收藏：沿用番剧
- 排序：评分 / 热度 / 发售日 / 名称 / 我的更新时间

## 6. 目录结构（完成后）

```
galgame/
├── index.html                 # 单文件应用
├── data/galgames.js           # 生成的全库数据（提交）
├── data/build/                # 抓取分页缓存（不提交）
├── scripts/
│   ├── fetch-games.mjs
│   ├── genres.mjs
│   ├── build-pinyin.mjs
│   ├── check-data.mjs
│   └── verify.mjs
├── sw.js
├── manifest.webmanifest
├── icon.svg
├── icons/                     # 180 / 192 / 512 PNG
├── package.json
└── README.md
```

## 7. 实施步骤

### Step 1 数据（完成标志：`npm run check-data` 通过）

1. 复制 `../番剧/scripts/` 的 fetch / pinyin / check 框架，改成本项目命名。
2. 写 `fetch-games.mjs`，全量抓约 1722 条，解析 `infobox` 的平台、开发、发行、剧本、原画、音乐、游戏类型。
3. 写 `genres.mjs`（18 个题材），构建期写入 `tg`。
4. `npm run check-data`：重复 ID、日期、评分、题材、平台数组、标题、`rt` 泄漏全部为 0；输出平台 / 开发商覆盖率。

### Step 2 页面（完成标志：本地打开可浏览、可加入）

1. 复制 `../番剧/index.html`，按第 5 节替换数据、状态、题材、字段。
2. 删除季度 / 日历 / 地区 / 集数 / 进度相关代码与 DOM。
3. 卡片、详情改为平台 / 开发 / 剧本 / 原画；我的只保留四状态。
4. 保留搜索、筛选、排序、视图、批量、撤销、命令面板、设置、无障碍。
5. `npx serve .` 打开检查桌面与 375×812 移动端。

### Step 3 云同步与数据（完成标志：双浏览器双向合并通过）

1. 按第 4 节改 localStorage 键、Gist 文件名、payload `app`。
2. 合并逻辑：`u` 新者胜，墓碑防复活。
3. 导出 JSON / CSV / MD，导入合并，备份提醒。

### Step 4 PWA（完成标志：断网重开可用）

1. `sw.js` 改缓存名 `yuc-gl-shell-v1`，SHELL 改为 `./data/galgames.js`。
2. manifest 改名「Galgame 库」、短名「Galgame」，主题色沿用石墨黑 + 靛蓝。
3. 生成 180 / 192 / 512 PNG 图标，补 iOS meta。
4. 断网重开验证。

### Step 5 验收（完成标志：`npm run verify` 全绿）

1. 从 `../番剧/scripts/verify.mjs` 复制 CDP 验收骨架（静态服务器、Edge/Chrome、CDP 部分）。
2. 端口改为本项目专用：HTTP `8792`，CDP `9338`，避免与番剧 / 轻小说冲突。
3. 写本项目用例，目标 ≥ 40 项，覆盖第 8 节。
4. 保留失败截图 / 日志。

### Step 6 部署（完成标志：线上可打开）

1. 提交后执行：

```bash
gh repo create xyykmkefke/galgame-library --public --source . --remote origin --push
```

2. 开启 Pages：`main` 分支根目录。
3. 线上复跑验收，记录 URL 与版本。

## 8. 验收清单

> 本节是设计期清单；当前自动化验收为 75 项（见第 11 节），其中同步为 mock 覆盖，真实 Gist / 真机 iOS 待线上验证。

数据：

- [ ] 条目数 ≥ 1500，ID 无重复
- [ ] 日期为空或 `YYYY-MM-DD`
- [ ] 评分 0–10
- [ ] 题材 id 全部在白名单内，无重复
- [ ] `pl` 为数组且无空值；主流平台已归一（PC / PS / PSP / Switch / Android / iOS）
- [ ] 最终文件无 `rt` 字段
- [ ] 抽查「时空轮回」「Fate/stay night」「CLANNAD」的平台、开发、剧本字段

功能：

- [ ] 搜索中文、原名、拼音首字母、`-排除`
- [ ] 年份 / 平台 / 开发商 / 题材 / 状态 / 高分 / 只看我的 / 隐藏已收藏筛选
- [ ] 网格 / 列表 / 看板切换，分组，分页
- [ ] 加入 / 移出、四状态、批量标记、撤销
- [ ] 详情、相似推荐、上下一条、分享链接
- [ ] JSON / CSV / MD 导出；JSON 导入合并与无效提示
- [ ] 设置字号 / 密度 / 动效 / 主题
- [ ] 命令面板、键盘导航、焦点陷阱

同步：

- [ ] 两个浏览器配置同 Gist，A 加 B 见
- [ ] A 改状态、B 改另一条，合并后都保留
- [ ] 同一条两端都改，按 `updatedAt` 取新
- [ ] 删除后另一设备不复活
- [ ] 断网改数据，恢复后自动补同步
- [ ] Token 错误不重试并提示

PWA / 移动端：

- [ ] 离线重开可用
- [ ] iOS 添加到主屏幕全屏启动
- [ ] 375×812 筛选抽屉、44px 触控、无横向滚动

## 9. 已知风险与决策

1. `galgame` 标签只有 1722 条，可能漏掉部分作品：v1.0.0 先接受；后续可补抓 `视觉小说` 并按 `id` 去重，不要直接并入 `ADV`。
2. 部分条目缺平台 / 开发 / 剧本：留空，UI 显示「—」，不丢弃条目。
3. 平台名称存在变体（Windows / PC、3DSLL / 3DS）：构建期归一，UI 只展示归一后的值。
4. 开发商存在改名 / 合并（如 Key / VISUAL ARTS）：v1.0.0 用原始字符串，不建别名表；后续可加映射。
5. R18 条目：默认全部收录，存 `ns` 标记，详情页显示一个「R18」小标签；v1.0.0 不做过滤开关。
6. 两个 Pages 站点同源：键名、缓存名、Gist 文件名必须唯一。
7. 封面为外链，首次需联网；离线显示首字占位（沿用番剧）。
8. 抓取是公开接口，务必限速 800ms、带 UA、失败退避，避免被风控。
9. 版本策略：补丁位修 bug / 样式，次版本加功能块，主版本才大改。

## 10. 交接提示词

> 接手 `c:\Users\ASUS\Desktop\音乐\galgame`。先读 `README.md`、`HANDOVER.md`，再读 `../番剧/README.md` 和 `../番剧/index.html` 的对应区段。按第 7 节顺序实现 v1.0.0，每步运行 `check-data` / `verify`，不要修改 `../番剧`。完成后汇报：数据统计、平台与开发商覆盖率、verify 通过数、桌面与移动端截图、线上 URL。若数据字段与本文不符，先停下来说明差异再改。

## 11. 实际落实与计划差异（v1.1.0）

- 数据：已实现 `galgame` + `视觉小说` 双标签抓取与按 ID 合并，共 1820 条（1985-05-31 ~ 2027-02-18）；未并入 `ADV`。
- 平台归一：在原有映射上补充 Windows 各版本 / `Win 98` / `Window 10以上` → `PC`、`PlayStationVita` → `PSV`、`Nintendo Swtich` → `Switch`、`PC98` → `PC-98`、`ブラウザ` → `Web`，并过滤 `8` / `10 日本語版` / `98用` 等由斜杠拆出的碎片；桶缓存保留 `plr`，改映射后可离线重算。
- 页面：卡片标题两行截断（列表视图一行）沿用番剧方案，卡片 meta 增加单行省略防溢出；搜索扩展到开发商与平台；详情页平台、开发商改为逐项可点。
- 云同步：`verify` 通过注入 `Page.addScriptToEvaluateOnNewDocument` mock `api.github.com`，覆盖创建 Gist、双向合并、远端墓碑、401 不重试四类场景；真实 Gist 与真机 iOS 仍未在线验证。
- PWA：`verify` 增加 Service Worker 缓存检查与 CDP 断网重开验证；`index.html` 内注册 SW，并在 `updatefound` 后提示「新版本已就绪 / 刷新」。
- 验收：`npm run verify` 由 59 项扩到 75 项，当前 75/75；`npm run check-data` 问题总数 0。
- 版本：`package.json` 升至 1.1.0（相对 v1.0.0 增加数据源与交互改进）。
- 部署：受本次任务约束，未执行 commit / push / Pages 开启；部署命令见第 7 节 Step 6。

## 12. v1.x 收尾与 v2.0 多源（2.0.0）

### 12.1 版本拆分

本轮把第一阶段称为「1 大版本收尾」，内容落在 v1.2 / v1.3 / v1.4，随后进入 v2.0，对外统一发布 **2.0.0**：

- v1.2 洞察：数据统计面板、摇一部、最近浏览、PWA 安装引导、SEO。
- v1.3 元数据：开发商名归一、详情 Bangumi / VNDB 双外链、VNDB 评分与时长。
- v1.4 自动化：verify 扩到 100 项、GitHub Actions、check-data 覆盖率底线与体积预算。
- v2.0 多源：VNDB 补充数据独立成 `data/vndb.js`，运行时按 Bangumi ID 关联。

### 12.2 新增文件与数据

| 文件 | 作用 |
|---|---|
| `scripts/fetch-vndb.mjs` | VNDB Kana API 补充脚本，标题归一 + 年份容差保守匹配 |
| `data/vndb.js` | 生成物，`window.GL_VNDB = { meta, map }`，map 键为 Bangumi ID |
| `data/build/vndb-map.json` | 匹配缓存（不提交），增量续跑 |
| `.github/workflows/ci.yml` | push / PR 跑 check-data + verify |
| `robots.txt` / `sitemap.xml` | 站点索引 |

VNDB 匹配规则：把中文名、原名及其副标题前段做归一（NFKC、去空格标点、小写），与候选的 `title / alttitle / titles / aliases` 比对，要求至少一个完全相等；候选按标题重合度、发售年差（≤3 年）、投票数排序取第一。宁缺毋滥，未命中不写入。

### 12.3 页面变化

- 头部「更多」新增：数据统计（`I`）、摇一部（`R`）、最近浏览、安装到桌面。
- 统计面板：6 张总量卡 + 6 张覆盖率卡 + 年份按十年分布 + 平台 / 开发商 Top10 + 题材分布 + 我的状态 + 最近浏览 + 数据来源；平台 / 开发商 / 题材分布条点击即跳筛选。
- 最近浏览：`yuc_gl_recent_v1`，最多 20 条，去重置顶。
- 详情：有 VNDB 匹配时显示 VNDB 评分（0-100 折算 10 分制）与时长；「链接」chip 提供 Bangumi 与 VNDB（未匹配时给 VNDB 搜索）。
- 安装引导：`beforeinstallprompt` 捕获后原生提示；iOS 首次访问 2.5s 后提示添加到主屏幕；关闭记 `yuc_gl_install_v1`。
- SW 缓存升级 `yuc-gl-shell-v2`，预缓存 `data/vndb.js`。

### 12.4 数据变化

- `scripts/fetch-games.mjs` 增加 `normalizeDevName` / `normalizeDevList`：去掉「株式会社」「有限会社」「Co., Ltd.」「Inc.」等前后缀，纯符号丢弃。开发商覆盖率保持 76.0%。
- 规则改动可完全离线重算：`node scripts/fetch-games.mjs`（缓存齐全时网络请求 0 次）。
- `check-data` 新增：开发商重复 / 后缀残留、`ns` 类型、`vo` 泄漏、6 项覆盖率底线、VNDB 映射合法性、数据体积预算（<1300KB）。

### 12.5 验收

- `npm run check-data`：问题总数 0，VNDB 匹配与体积见输出。
- `npm run verify`：100 项全绿（新增 VNDB 关联、详情双外链、统计面板与跳筛选、最近浏览、摇一部、安装引导、SEO、体积预算、开发商归一、版本号等）。
- 已知未验证：真实 GitHub Gist（仍为 mock）、真机 iOS 添加到主屏幕。
- 月幕数据源已在 v2.1 接入，见下一节。

### 12.6 后续可选

1. 月幕接入：需要服务端代理保存凭据，或改为构建期离线抓取后随仓库发布。（v2.1 已按构建期抓取落地）
2. VNDB 覆盖面：当前按热度补到 700 条，成功匹配 627 条（约全库 34%）；继续用 `node scripts/fetch-vndb.mjs --limit=1200` 增量推进，注意 200 次 / 5 分钟限流（脚本已固定 1.6s 间隔）。
3. 系列聚合：可基于标题前缀或 VNDB 系列关系生成 `series` 字段。

## 13. v2.1 月幕第三数据源（2.1.0）

### 13.1 凭据与接口

- 月幕为学习 / 实验提供公共凭据，无需申请：`client_id=ymgal`，`client_secret=luna0327`；专属凭据在 <https://github.com/ymgal/docs> 提 issue。
- Token：`GET https://www.ymgal.games/oauth/token?grant_type=client_credentials&client_id=ymgal&client_secret=luna0327&scope=public`，有效期约 1 小时，脚本内复用并在 401 时刷新。
- 请求头必须带 `Authorization: Bearer <token>`、`version: 1`、`Accept: application/json;charset=utf-8`（漏 Bearer 会 401）。
- 搜索：`GET /open/archive/search-game?mode=list&keyword=<urlencode>&pageNum=1&pageSize=10`。
- 站点链接：`https://www.ymgal.games/GA<gid>`。

### 13.2 构建与页面

| 文件 | 作用 |
|---|---|
| `scripts/fetch-ymgal.mjs` | 月幕补充脚本，标题归一严格匹配、顺序 800ms 限速、429 退避 |
| `data/ymgal.js` | 生成物，`window.GL_YMGAL = { meta, map }`，map 键为 Bangumi ID |
| `data/build/ymgal-map.json` | 匹配缓存（不提交），增量续跑 |

- 匹配值：`{ g, n, cn, d, o, i, s, hc }`（gid、原名、中文名、发售日、开发商、封面、评分、中文版）。
- 页面 `adoptData()` 注入 `x.ym`，主库结构不变；详情展示月幕评分（有值时）、中文版标记与月幕外链；统计面板新增「月幕匹配」卡与数据来源链接；页脚标注月幕 Galgame 来源。
- 封面兜底：Bangumi 主图失效或缺失时，自动改用月幕 `mainImg`，避免破图。
- SW 缓存升级 `yuc-gl-shell-v3`，SHELL 预缓存 `data/ymgal.js`。
- R18 保持不隐藏：仍全量收录并以详情「分级 R18」标记，不加默认隐藏。

### 13.3 验收

- `npm run check-data`：问题总数 0；月幕匹配 441 条（尝试 758），映射异常 0；体积 675KB + 71KB + 92KB = 838KB。
- `npm run verify`：109/109 通过（新增月幕关联、独立文件、详情外链与中文版标记、封面兜底、统计卡、页脚署名、SW v3 预缓存）。
- GitHub Actions CI 保持开启，push 后自动跑 check-data + verify。

## 14. 制作人员维度筛选（2.1.x 迭代）

### 14.1 交互

- 详情页「剧本 / 原画 / 音乐 / 发行」由纯文本改为逐项可点，点击后回到全库并按该人员筛选。
- 筛选状态写入 URL hash（`sk` 维度、`sv` 名字）与浏览偏好，复制视图链接、保存筛选视图、刷新还原均可保留。
- 顶部筛选标签显示「剧本 · 某人」并可单独移除；「清除筛选」与零结果恢复也会一并去掉该条件。
- 维度校验：只接受 `sc / ar / mu / pub` 且名字必须真实存在于数据中，损坏或过期链接不会留下空结果。

### 14.2 实现要点

- 数据字段为「、」连接的单串，前端用 `staffValues()` 拆分后做精确匹配，不引入新数据字段、不增加体积。
- 覆盖基线：剧本 60.1%、原画 49.4%、音乐 41.2%、发行 63.9%；无值条目仍显示「未标注」且不可点。
- 回归：`npm run verify` 由 109 项扩到 112 项（制作人员可点、按人员筛选、筛选标签），当前 112/112；`npm run check-data` 问题总数 0，体积 838KB。


