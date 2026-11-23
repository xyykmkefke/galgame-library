# 会话日志 · 2026-11-23

本日志记录 Galgame 库从 v2.19.0 到 v2.23.1 的完整会话过程。详细字段、风险与后续建议见 [HANDOVER.md](./HANDOVER.md) 第 36–42 节。

## 起点

- 版本 v2.19.0，HEAD `a5a100a`，主库 2485 条（Bangumi 日系 galgame 标签），VNDB 匹配 1042，月幕匹配 909。
- 验收 174/174，数据体积约 1274KB。
- 方向约束：只收日系 galgame，不收 ADV / 欧美；不使用需要日本出口或代理的受限网络方案。

## 1. VNDB 日系扩展库（v2.20.0，`0554e08`）

- 新建 `scripts/fetch-vndb-extra.mjs`，走 VNDB Kana API：`olang=ja`、`rating>=60`、`votecount>=30`，热度降序取 1500 条。
- 与主库 VNDB 映射、主库标题、VNDB 英文标题、月幕别名归一后去重；输出 `data/vndb-extra.js`，运行时并入全库（`ex=1`）。
- 全库 2485 → 3985；扩展日期 / 评分 / 封面 / 平台 / 开发商 100%，题材 63.1%。
- 页面：扩展详情只提供 VNDB 外链；SW 缓存 v22；版本 2.20.0。
- 验收：`check-data` 0 问题，`verify` 179/179。

## 2. VNDB 关系补全（v2.20.1，`9e94c89`）

- 以主库 + 扩展 2533 个 VNDB id 为种子，批量读 `relations`，只跟随 seq / preq / set / alt / side 等官方关系，跳过 char / fan。
- 候选 1304，新增 439；扩展 1500 → 1939，全库 4424。
- 关系条目要求日期 / 评分 / 封面 / 平台 / 开发商齐全；SW v23；版本 2.20.1。
- 同时尝试 ErogameScape：DNS 可解析但 80/443 超时，公共代理 522，Wayback 不可达，最终未接入。

## 3. ABCD 四项扩展（v2.21.0，`fa18c94`）

- A：VNDB 补 `length_minutes` 与 `staff`（剧本 / 原画 / 音乐），页面时长筛选与详情接入。
- B：新增 `fetch-bgm-related.mjs`，从 500 个主库种子遍历 Bangumi 关联；剔除 RPG / ACT / 手游后保留 18 条真正 gal / 乙女向，输出 `data/bgm-extra.js`。
- C：月幕 `--limit=1200` 扩到 800 条后停止，用 `--prune` 落盘；匹配 909 → 1144（+235），别名 577。
- D：VNDB 热度阈值 30 → 10，热度取满 3000；扩展 3452，全库 5955。
- 新增 `data/bgm-extra.js`、页面来源统计、Bangumi 关联详情外链；SW v24；版本 2.21.0。
- 验收 183/183（新增关联库与双扩展缓存断言）。

## 4. A → C → B 全量扩展（v2.22.0，`c5b7dfe`）

- A：从 4485 部现有作品反查 1325 个 VNDB producer，20 个一批拉其全部 VN，新增 3626 条；扩展 7078。
- C：Bangumi 关联遍历全部 2485 个主库种子，候选 1501，严格过滤后保留 110 条。
- B：新增 `--popularity-only`，复用现有扩展只补热度页；`--limit=6000` 新增 801 条，扩展最终 7879。
- 全库 10474；体积 3674KB；合并覆盖率日期 99.4% / 评分 99.2% / 封面 100% / 平台 99.0% / 开发商 94.6% / 题材 49.1%。
- 题材覆盖不足，`check-data` 扩展底线暂降到 40%，`verify` 合并底线降到 48%。

## 5. 题材覆盖率优化（v2.23.0，`f6b7260`）

- 新增 `scripts/vndb-genre-map.mjs`，集中 VNDB 标签映射；标签评分阈值 1.5 → 0.5，扩充 romance / school / mystery / sci-fi 等同义词。
- `genres.mjs` 新增第 20 个题材「拔作」（`nukige`），页面 GENRES 同步，题材下拉 21 项。
- 新增 `scripts/enrich-vndb-tags.mjs`：只对 4438 条无题材扩展重抓标签，标签补 3543 条、标题兜底 115 条，剩 780 条。
- 扩展题材 43.7% → 90.1%；合并题材 49.1% → 84.0%。
- 质量底线提高：扩展题材 ≥85%、合并题材 ≥80%；`check-data` 0 问题，`verify` 183/183。
- 同时完成低热度老作裁剪分析（子代理统计）：conservative / balanced 两档，详见 HANDOVER 40.2。

## 6. balanced 裁剪（v2.23.1，`d23493b`）

- 新增 `scripts/prune-vndb-extra.mjs`，默认预演，`--apply` 才写文件。
- 执行 `--policy=balanced`：`h<20` 且 `d<2015-01-01`，删除 1850 条，释放 497KB。
- 扩展 7879 → 6029；全库 10474 → 8624；体积 3239KB，4MB 余量约 0.78MB。
- 裁剪后扩展题材 93.4%，合并题材 85.0%；日期 99.4% / 评分 99.1% / 封面 100% / 平台 98.8% / 开发商 93.4%。
- SW v27；版本 2.23.1；CI 成功、Pages 已部署，线上复核 6029 条。

## 最终状态

- 线上：<https://xyykmkefke.github.io/galgame-library/>
- 全库 8624：主库 2485 + Bangumi 关联 110 + VNDB 扩展 6029。
- 第二 / 第三数据源：VNDB 匹配 1042，月幕匹配 1144（577 别名）。
- 验收：`check-data` 0 问题，`verify` 183/183；CI 通过，Pages 已部署。
- 风险与后续：见 HANDOVER 42.4 / 42.5；老系列整组裁剪风险已记录，后续可保存 relations 再做图连通裁剪。

## 7. 非 gal 黑名单（v2.23.2）

- 审计：高置信非 gal 57 条（0.95%）、中置信 43 条（0.71%）；污染是条目级，不是关系分量级。
- 新增 `data/blocklist.json`（57 条 VNDB id）与 `scripts/apply-blocklist.mjs`；`fetch-vndb-extra.mjs` 读取同一文件，避免重抓回填。
- 扩展 6029 → 5972，全库 8624 → 8567，体积 3239KB → 3221KB；题材覆盖 93.5%。
- `check-data` 0 问题；`verify` 183/183；SW 缓存 `yuc-gl-shell-v28`。
