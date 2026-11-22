# Galgame 库 · 游玩记录

本地优先的 Galgame 浏览与游玩记录 PWA。内置 Bangumi「galgame」+「视觉小说」标签条目，并用 VNDB 补充评分、时长，用月幕 Galgame 补充中文标题与外链，无账号、无后端。

状态：**v2.4.0**

## 功能

- **全库浏览**：1820 部作品，按年份、平台、开发商、题材筛选，评分 / 热度 / 发售日 / 名称排序
- **搜索**：多关键词交集、`-词` 排除、拼音首字母、跨源别名（VNDB 英文 / 罗马字标题、月幕原名）、开发商 / 平台命中、标题高亮、搜索历史；严格无结果时自动忽略空格、标点与全半角差异再搜一次；支持 `开发商:Key`、`平台:Switch`、`年份:2015` 限定，前缀 `-` 表示排除
- **我的游玩**：想玩 / 在玩 / 已通关 / 弃坑（仅四种状态）
- **视图**：网格 / 列表 / 看板；按发售年份、加入年份、状态分组
- **详情**：平台、开发、发行、剧本、原画、音乐、游戏类型、题材、相似推荐；平台、开发商、剧本 / 原画 / 音乐 / 发行逐项可点，点制作人员即筛出该人员参与的全部作品；同前缀作品自动归为系列，详情显示「系列 · N 部」并一键筛选整个系列；Bangumi / VNDB / 月幕三外链
- **系列一览**：更多菜单汇总全部 54 个系列与覆盖作品数，点击任一即筛选该系列；Esc 关闭
- **同系列切换**：详情页列出同系列其他作品（按发售日升序，最多 12 部，含日期 / 评分 / 我的状态），点击即切换详情，无需返回列表
- **数据统计**：字段覆盖率、年份按十年分布、平台 / 开发商 / 题材 Top，分布条可点击直接跳筛选；最近浏览；一键复制摘要
- **发现**：摇一部（`R`，只在当前筛选结果内抽取）
- **数据**：JSON / CSV / Markdown 导出，JSON 导入合并
- **云同步**：GitHub Gist 双向合并（可选，Token 仅存本机），删除墓碑、失败退避
- **PWA**：安装引导（Chrome / Edge 原生提示，iOS 给出添加到主屏幕步骤）、离线缓存、新版本刷新提示
- **无障碍**：键盘导航、焦点陷阱、状态播报、44px 触控目标

## 数据

- 主源：Bangumi（bgm.tv），`type=4` 游戏，`tag=galgame` 与 `tag=视觉小说` 按 ID 合并去重
- 补充源：VNDB 公共 Kana API，按标题归一 + 年份容差保守匹配，只保留高置信结果；当前匹配 627 条（热度前 700 条中 387 条新增）
- 补充源：月幕 Galgame 开放 API，同样按标题归一 + 年份容差严格匹配；匹配数与中文版标记见统计面板
- 规模：1820 条（1985-05-31 ~ 2027-02-18）
- 覆盖：日期 97.6%、评分 97.7%、封面 99.9%、平台 95.6%、开发商 76.0%
- 文件：`data/galgames.js`（主库）、`data/vndb.js`（第二数据源）、`data/ymgal.js`（第三数据源），后两者按 Bangumi ID 关联

抓取按发售年份分桶（镜像 offset 上限 1000），再用 heat / rank / score 三个排序各取前 1000 条兜底：

```bash
npm run fetch-data          # 增量，已有分桶缓存直接复用
node scripts/fetch-games.mjs --refresh   # 清空缓存重抓
node scripts/fetch-games.mjs --tags=galgame,视觉小说   # 指定标签
npm run fetch-vndb          # 补充 VNDB（默认热度前 350 条，增量）
npm run fetch-ymgal         # 补充月幕（默认热度前 700 条，增量）
npm run check-data
```

平台在构建期归一：Windows 各版本 / Win 98 → `PC`，PlayStation 各代 → `PS` 系，安卓 → `Android`，浏览器 / 在线网页 → `Web`，并过滤版本号等碎片。开发商名去掉「株式会社」「Co., Ltd.」等后缀。桶缓存保留原始平台串与标签，调整映射后可离线重算。

VNDB 匿名限流约 200 次 / 5 分钟，脚本固定 1.6s 间隔并对 429 退避；匹配结果落 `data/build/vndb-map.json`，重复运行只补未匹配条目。

月幕使用官方公开的公共凭据（`client_id=ymgal`，供学习 / 实验），构建期顺序请求、800ms 间隔并对 429 退避，匹配结果落 `data/build/ymgal-map.json`；也可用环境变量 `YMGAL_CLIENT_ID` / `YMGAL_CLIENT_SECRET` 覆盖。数据非商业用途，本站已在页脚与文档标注月幕 Galgame 来源。

## 开发

```bash
npm start        # 本地静态服务
npm run verify   # Edge/Chrome + CDP 自动验收（131 项，含 Gist mock、离线重开、统计与三数据源）
```

CI：`.github/workflows/ci.yml` 在 push / PR 时运行 `check-data` 与 `verify`（Linux 下自动使用系统 Chrome）。

## 部署

GitHub Pages：<https://xyykmkefke.github.io/galgame-library/>

详细实现说明见 [HANDOVER.md](./HANDOVER.md)。
