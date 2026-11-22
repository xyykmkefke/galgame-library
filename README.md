# Galgame 库 · 游玩记录

本地优先的 Galgame 浏览与游玩记录 PWA。内置 Bangumi「galgame」+「视觉小说」标签条目，无账号、无后端。

状态：**v1.1.0**

## 功能

- **全库浏览**：1820 部作品，按年份、平台、开发商、题材筛选，评分 / 热度 / 发售日 / 名称排序
- **搜索**：多关键词交集、`-词` 排除、拼音首字母、开发商 / 平台命中、标题高亮、搜索历史
- **我的游玩**：想玩 / 在玩 / 已通关 / 弃坑（仅四种状态）
- **视图**：网格 / 列表 / 看板；按发售年份、加入年份、状态分组
- **详情**：平台、开发、发行、剧本、原画、音乐、游戏类型、题材、相似推荐；平台与开发商逐项可点
- **数据**：JSON / CSV / Markdown 导出，JSON 导入合并
- **云同步**：GitHub Gist 双向合并（可选，Token 仅存本机），删除墓碑、失败退避
- **PWA**：iOS 添加到主屏幕、离线缓存、新版本刷新提示
- **无障碍**：键盘导航、焦点陷阱、状态播报、44px 触控目标

## 数据

- 来源：Bangumi（bgm.tv），`type=4` 游戏，`tag=galgame` 与 `tag=视觉小说` 按 ID 合并去重
- 规模：1820 条（1985-05-31 ~ 2027-02-18）
- 覆盖：日期 97.6%、评分 97.7%、封面 99.9%、平台 95.6%、开发商 76.0%
- 文件：`data/galgames.js`

抓取按发售年份分桶（镜像 offset 上限 1000），再用 heat / rank / score 三个排序各取前 1000 条兜底：

```bash
npm run fetch-data          # 增量，已有分桶缓存直接复用
node scripts/fetch-games.mjs --refresh   # 清空缓存重抓
node scripts/fetch-games.mjs --tags=galgame,视觉小说   # 指定标签
npm run check-data
```

平台在构建期归一：Windows 各版本 / Win 98 → `PC`，PlayStation 各代 → `PS` 系，安卓 → `Android`，浏览器 / 在线网页 → `Web`，并过滤版本号等碎片。桶缓存保留原始平台串，调整映射后可离线重算。

## 开发

```bash
npm start        # 本地静态服务
npm run verify   # Edge/Chrome + CDP 自动验收（75 项，含 Gist mock 与离线重开）
```

## 部署

GitHub Pages：<https://xyykmkefke.github.io/galgame-library/>

详细实现说明见 [HANDOVER.md](./HANDOVER.md)。
