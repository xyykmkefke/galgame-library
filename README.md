# Galgame 库 · 游玩记录

本地优先的 Galgame 浏览与游玩记录 PWA。内置 Bangumi「galgame」「视觉小说」「百合」「BL」「拔作」等日系 galgame 标签条目，并用 VNDB 补充评分、时长、制作人员与 5742 部日系扩展作品（含关系与开发商补全），用 Bangumi 关联条目补同系列 galgame，用月幕 Galgame 补充中文标题与外链，无账号、无后端。**已移除全部乙女向作品。**

状态：**v2.27.1**

## 功能

- **全库浏览**：7732 部日系作品（1972 部 Bangumi 主库 + 18 部 Bangumi 关联 + 5742 部 VNDB 日系扩展；不含乙女向），按年份、平台、开发商、题材、游玩时长筛选，评分 / 热度 / 发售日 / 名称排序
- **搜索**：多关键词交集、`-词` 排除、拼音首字母、跨源别名（VNDB 英文 / 罗马字标题、月幕原名 / 中文名 / 详情别名）、开发商 / 平台命中、标题高亮、搜索历史；严格无结果时自动忽略空格、标点与全半角差异再搜一次；支持 `开发商:Key`、`平台:Switch`、`年份:2015`、`题材:恋爱`、`评分:>=8` 限定（评分支持 `>=` / `<=` / `>` / `<`，省略运算符按 `>=`），前缀 `-` 表示排除
- **我的游玩**：想玩 / 在玩 / 已通关 / 弃坑（仅四种状态）
- **题材补齐**：主库题材 1234 → 1349（68.4%），VNDB 标签 + Bangumi 原始标签离线映射；扩展题材 93.2%
- **主库字段补齐**：从 Bangumi 详情补别名/中文名，从 VNDB staff 补剧本/原画/音乐，从月幕补开发商；主库开发商 81.6% → 84.5%，剧本 55.4% → 61.2%，原画 44.3% → 51.9%，音乐 38.1% → 47.8%
- **主库别名**：877 条作品带 Bangumi 别名（共 1490 条），参与搜索与详情展示
- **非 gal 标记**：35 条主库误收（逆转裁判、FF、GTA 等）加 `k="off"`，默认隐藏；设置里可切换显示，收藏、详情与旧链接保留
- **视图**：网格 / 列表 / 看板；按发售年份、加入年份、状态、系列分组
- **详情**：平台、开发、发行、剧本、原画、音乐、游戏类型、题材、相似推荐；平台、开发商、剧本 / 原画 / 音乐 / 发行逐项可点，点制作人员即筛出该人员参与的全部作品；同系列作品优先按 VNDB 官方关系（ser / seq / preq）聚合，标题前缀兜底；详情显示「系列 · N 部」并一键筛选整个系列；Bangumi / VNDB / 月幕三外链
- **系列一览**：更多菜单汇总 601 个系列 / 1704 部作品，支持按名称搜索与「只看我收藏的系列」，点击任一即筛选该系列；已收藏的系列会显示「我的 N · 通关 M」，并额外给出「我收藏的系列」卡；Esc 关闭
- **开发商一览**：汇总 2087 个开发商与覆盖作品数，默认列出 2 部及以上（898 个）；117 组日文/英文/大小写别名已归一（原名保留供搜索），面板内可按名称搜索、可切换显示仅 1 部的开发商，点击任一即筛选该开发商全部作品
- **制作人员一览**：按剧本 / 原画 / 音乐 / 发行四个维度汇总人员与作品数，默认列出 2 部及以上，面板内可按名称搜索与切换维度，点击任一即筛选该人员参与的全部作品
- **题材一览**：汇总全部 18 个题材的作品数与覆盖作品，按作品数排序，行内显示「我的 N · 通关 M」，点击任一题材即筛选其全部作品
- **平台一览**：汇总 94 个平台（覆盖 7634 部、2636 部多平台），按作品数排序并显示「我的 N · 通关 M」，点击任一平台即筛选该平台作品
- **我的足迹**：按加入月份分组列出全部收藏，显示状态与日期，顶部汇总收藏总数 / 已通关 / 本月新增，点击任意条目直接打开详情
- **同系列切换**：详情页列出同系列其他作品（按发售日升序，最多 12 部，含日期 / 评分 / 我的状态），点击即切换详情，无需返回列表；自动标记「下一部」
- **渐进加载**：首屏先渲染 1972 条主库，1.8MB VNDB 扩展库在首屏后空闲加载并合并；大脚本预加载，SW 安装复用 HTTP 缓存，避免首访重复下载
- **继续系列**：我的游玩顶部按「在玩 > 想玩 > 未收藏」给出最多 3 个继续系列与下一部，点击直接打开详情
- **系列进度**：系列一览显示「我的 N · 通关 M · 未玩 K」，支持「只看有未玩的」筛选
- **数据统计**：字段覆盖率、年份按十年分布、平台 / 开发商 / 题材 Top，分布条可点击直接跳筛选；最近浏览；一键复制摘要；新增「我的时长（估算）」按 VNDB 时长汇总收藏总时长、已通关与想玩 + 在玩时长，仅统计已匹配条目
- **时长筛选**：按 VNDB 时长分短篇 ≤10h / 中篇 10–30h / 长篇 >30h 三档，可与题材、平台等条件叠加；未匹配 VNDB 的条目不落入任何档位
- **发现**：摇一部（`R`，只在当前筛选结果内抽取）
- **数据**：JSON / CSV / Markdown 导出，JSON 导入合并
- **云同步**：GitHub Gist 双向合并（可选，Token 仅存本机），删除墓碑、失败退避
- **PWA**：安装引导（Chrome / Edge 原生提示，iOS 给出添加到主屏幕步骤）、离线缓存、新版本刷新提示
- **无障碍**：键盘导航、焦点陷阱、状态播报、44px 触控目标

## 数据

- 主源：Bangumi（bgm.tv），`type=4` 游戏，`tag=galgame` / `视觉小说` / `百合` / `BL` / `拔作` 按 ID 合并去重；不收 ADV（混入大量非 gal 的冒险 / 解谜游戏），不收乙女向，也不收标为欧美的作品
- 扩展源：VNDB 公共 Kana API，只收原始语言为日文（`olang=ja`）、评分 ≥ 60 的作品：热度前 6000 条 + 关系补全 452 条 + 1325 个 producer 的开发商补全 3626 条，合计 7879 条；再按 `h<20 且 2015 年前` 裁剪 1850 条低热度老作，保留 **6029 条**；再按 `data/blocklist.json` 过滤 57 条确认的非 gal 条目（逆转裁判、雷顿教授、格斗 / 音游、逃脱解谜等）得到 5972 条，最后移除 230 条乙女向，最终 **5742 条**。扩展条目额外补 `length_minutes`、`staff`（剧本 / 原画 / 音乐）与题材；题材先用 VNDB 标签（新增「拔作 / Nukige」分类），标签缺失时用标题关键词兜底，覆盖率 93.2%
- 关联源：Bangumi 关联条目（`/v0/subjects/{id}/subjects`），遍历全部 1972 个主库种子；按游戏类型与恋爱 / BL 标签严格过滤掉 RPG / ACT / 手游 / 开放世界换装与乙女向，最终保留 18 部真正日系 galgame
- 补充源：VNDB 公共 Kana API，按标题归一 + 年份容差保守匹配，只保留高置信结果；当前匹配 803 条（已尝试 1840 条；A5 用别名重试新增 17 条）
- 补充源：月幕 Galgame 开放 API，同样按标题归一 + 年份容差严格匹配；当前匹配 916 条，其中 577 条有详情别名
- 规模：7732 条（主库 1972 含 35 条非 gal 标记 + Bangumi 关联 18 + VNDB 扩展 5742；默认可见 7697 条；1985-05-31 ~ 2027-03-25）
- 覆盖：日期 99.3%、评分 99.2%、封面 100%、平台 98.7%、开发商 95.3%、题材 85.3%
- 文件：`data/galgames.js`（主库）、`data/vndb.js`（第二数据源）、`data/ymgal.js`（第三数据源）、`data/vndb-extra.js`（VNDB 扩展）、`data/bgm-extra.js`（Bangumi 关联）、`data/series.js`（系列映射，构建物）、`data/dev-alias.js`（开发商别名）

抓取按发售年份分桶（镜像 offset 上限 1000），再用 heat / rank / score 三个排序各取前 1000 条兜底：

```bash
npm run fetch-data          # 增量，已有分桶缓存直接复用
node scripts/fetch-games.mjs --refresh   # 清空缓存重抓
node scripts/fetch-games.mjs --tags=galgame,视觉小说,百合   # 指定标签（乙女向会被过滤）
npm run fetch-vndb          # 补充 VNDB（默认热度前 350 条，增量）
npm run fetch-vndb-extra    # 抓取 VNDB 日系扩展（默认 3000 条 + 关系 + 开发商，整包重抓）
node scripts/fetch-vndb-extra.mjs --limit=6000 --popularity-only   # 只补热度页，保留现有关系 / 开发商条目
npm run fetch-vndb-relations # 保存库内 VNDB 官方关系边表（构建缓存，供裁剪与系列聚合复用）
npm run build-series        # 用强关系生成 data/series.js（标题前缀兜底）
npm run fetch-bgm-related   # 从主库关联条目补同系列 galgame（排除乙女向，默认 500 种子）
npm run enrich-vndb-tags    # 只重抓缺失题材的扩展条目标签，补 tg
npm run enrich-main-bangumi # 用 Bangumi 详情补主库 开发/剧本/原画/音乐/中文名/别名（dry-run）
npm run enrich-main-staff   # 用 VNDB staff 补主库缺失制作人员（dry-run）
npm run enrich-main-genres-keywords # 用 Bangumi 原始标签离线补主库题材（dry-run）
npm run rematch-main-vndb -- --limit=100 # A5：用别名重试未匹配 VNDB（dry-run，写探测缓存）
npm run apply-vndb-rematch # 预演把 A5 命中合并回 vndb.js
npm run prune-vndb-extra -- --policy=conservative          # 预演裁剪低热度老作（不写文件）
npm run prune-vndb-extra -- --policy=balanced --apply      # 执行裁剪，为后续更新释放约 497KB
npm run apply-blocklist                                    # 预演按 data/blocklist.json 过滤非 gal 扩展条目
npm run apply-blocklist -- --apply                         # 执行过滤（抓取脚本也会读取同一黑名单）
npm run mark-non-gal                                       # 预演给主库 36 条非 gal 加 k="off"
npm run mark-non-gal -- --apply                            # 执行标记；--unmark 撤销
npm run remove-otome                                       # 预演删除全部乙女向
npm run remove-otome -- --apply                            # 执行删除（全来源）
npm run fetch-ymgal         # 补充月幕（默认热度前 700 条，增量）
npm run check-data
```

平台在构建期归一：Windows 各版本 / Win 98 → `PC`，PlayStation 各代 → `PS` 系，安卓 → `Android`，浏览器 / 在线网页 → `Web`，并过滤版本号等碎片。开发商名去掉「株式会社」「Co., Ltd.」等后缀。桶缓存保留原始平台串与标签，调整映射后可离线重算。

VNDB 匿名限流约 200 次 / 5 分钟，脚本固定 1.6s 间隔并对 429 退避；匹配结果落 `data/build/vndb-map.json`，重复运行只补未匹配条目。

扩展库脚本按热度降序分页拉取（每页 100 条、间隔 1s），60 页取到前 6000 条候选；再按 50 个 id 一批遍历 4033 个种子的 `relations`（只跟随 seq / preq / set / alt / side 等官方关系，跳过 char / fan），补字段完整的相关作品 452 条；最后从现有作品反查 1325 个 producer，按 20 个一批拉其全部 VN（每批最多 3 页），补 3626 条。题材映射集中到 `scripts/vndb-genre-map.mjs`，标签阈值降到 0.5 并新增「拔作」；对缺失题材的条目用 `enrich-vndb-tags.mjs` 分批重抓标签，仍无标签时用标题关键词兜底，把扩展题材覆盖从 43.7% 提升到 90.1%。标题 / 别名归一后与主库和月幕去重，输出独立文件，不写主库。Bangumi 关联脚本遍历 2485 个主库种子，过滤非 gal 类型后保留 110 条，写入 `data/bgm-extra.js`。

月幕使用官方公开的公共凭据（`client_id=ymgal`，供学习 / 实验），构建期顺序请求、800ms 间隔并对 429 退避，匹配结果落 `data/build/ymgal-map.json`；有匹配的条目再逐条取详情补 `extensionName` 别名（同样 800ms 限速）。也可用环境变量 `YMGAL_CLIENT_ID` / `YMGAL_CLIENT_SECRET` 覆盖。数据非商业用途，本站已在页脚与文档标注月幕 Galgame 来源。

## 开发

```bash
npm start        # 本地静态服务
npm run verify   # Edge/Chrome + CDP 自动验收（187 项，含 Gist mock、离线重开、统计与五份数据文件）
```

CI：`.github/workflows/ci.yml` 在 push / PR 时运行 `check-data` 与 `verify`（Linux 下自动使用系统 Chrome）。

交接与会话记录：[HANDOVER.md](./HANDOVER.md)（字段、数据源、风险与后续建议）、[SESSION-LOG.md](./SESSION-LOG.md)（v2.19.0 → v2.27.1 会话过程与提交）。

## 部署

GitHub Pages：<https://xyykmkefke.github.io/galgame-library/>

详细实现说明见 [HANDOVER.md](./HANDOVER.md)。
