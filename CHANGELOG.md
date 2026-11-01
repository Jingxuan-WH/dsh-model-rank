# Changelog

本项目所有值得注意的变更记录在这里。格式参考
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.1] - 2026-11-01

### Fixed

- **市场份额页行样式塌陷（v0.2.0 回归）**：市场份额每一行同时需要布局类 `.mrr-share` 与可点击类
  `.mrr-row-clickable`，但行属性展开让后者覆盖了前者，导致行退化为块级堆叠、份额条消失。
  已合并类名修复，并在 `validate-client` 增加 SSR 回归断言（行样式类必须并存、份额条/数值存在）。
- 本次为纯客户端修复，数据口径与宿主侧行为不变；已安装用户刷新页面或重启 DSH 后生效。

## [0.2.0] - 2026-11-01

> 功能大版本 + 数据/隐私口径调整；各榜单的**计算方法未变**（新增的能力榜是独立口径）。

### Added

- **能力榜（LiveBench 2.0）——第 7 个标签页**：LiveBench 2.0 长任务 / Agent 能力榜，
  官方**加权综合分**（权重取自官方 `categories.json`，缺失套件不计入分母）+ 7 类分项
  （Long Agentic / Reasoning / Coding / Browser / Data Analysis / Research / Design）。
  面板显示当前 LiveBench release；支持搜索、仅看已接入、排序、CSV 导出与明细抽屉。
  数据**仅在本机运行时抓取，不随仓库 / 安装包分发**，宿主首次联网刷新成功后出现。
- **本机用量仪表盘**（位于「本机接入」标签页内；tab 名保持「本机接入」，页面内区块标题为「本机用量」）：
  - KPI 卡片：今日 / 近 7 天 / 近 30 天 / 累计的 tokens、**估算**花费、调用次数；
  - 范围切换（今日 / 近 7 天 / 近 30 天 / 全部，只切本地数据）；
  - 「我的模型用量排行」：按 tokens 排序，附占比条、AA 智能指数与 OpenRouter 周榜位次（能匹配到时）；
  - 厂商（provider）用量分布、近 14 天 token 趋势、provider 接入卡片；
  - 本机存在 `dsh-usage` 账户快照时，展示渠道余额 / 套餐窗口（只读、可选）；
  - 统计口径：只读本机会话日志，按 **Asia/Shanghai 自然日**分桶；统计覆盖宿主能读到的全部会话日志
    （含插件安装前的历史；旧日志清理后对应数字减少）；费用按 Artificial Analysis 公开价估算并显示
    **定价覆盖度**，无公开价的模型显示「—」（不用 0 冒充）。
- 新增宿主 RPC `GET /_dsh/dsh-model-rank/usage`（本地聚合，带磁盘增量缓存）。
- **模型明细抽屉**：点击 Arena / 综合智能 / 能力榜 的模型行查看分项、价格速度与本机用量。
- **CSV 导出**：每个榜单导出**当前筛选结果**（本地生成、带 UTF-8 BOM，Excel 打开中文不乱码）。
- **数据源状态条**：每个榜单头部显示来源、版本 / 同步时间与 stale 提示。
- 仓库补充 `README.en.md`、`CONTRIBUTING.md`、本 `CHANGELOG.md`、Issue/PR 模板。
- 新增轻量 CI（`.github/workflows/ci.yml`）：语法检查 + manifest/内置快照隐私自检，不联网、不装依赖。

### Changed

- 「本机接入」标签页内新增本机用量仪表盘（tab 名保持「本机接入」），接入清单保留。
- 视觉改版：更克制的排行视觉、粘性表头、窄屏表格转卡片、跟随 DSH 明暗主题 token；
  明细抽屉随视觉重构上线。
- 榜单通用交互：支持表头排序；每个榜单可导出当前筛选结果。
- README 重构为中文主 + 英文（`README.en.md`），补充数据口径、隐私说明、常见问题与路线图。
- 宿主运行时要求 `node:zlib` 的 zstd 解码能力：`engines.node` 提升为 **>= 22.15.0**；
  更低版本会跳过 `.zstd` 压缩会话日志并给出 warning（未压缩日志不受影响）。

### Removed / 数据与隐私

- **内置兜底快照（随仓库 / 安装包分发）不再包含 Artificial Analysis（AA）数据、本机 provider/model
  清单与 `local` 标记。** 内置快照只保留 LMArena 与 OpenRouter 数据；**0.1.0 的内置快照曾包含 AA
  数据，0.2.0 起移除**。
- Artificial Analysis 数据仅在本机插件运行时抓取并缓存于本机，不再随仓库 / 安装包分发；
  「综合智能」页在首次运行时抓取成功前可能为空，属预期。
- LiveBench 能力榜数据同样仅在本机运行时抓取，**从不随包分发**。
- 仓库内测试数据、截图一律使用示例数据（`demo-*`），不含真实 provider/模型/会话信息。
- 代码许可（MIT）与数据许可相互独立；四类公开数据（LMArena / AA / LiveBench / OpenRouter）
  口径互不可比，插件不做跨榜合并或总分。

### Fixed

- 宿主调度：启动/重启后的首个检查不再绕过 24h 冷却；抓取失败按 2h 退避重试；内置快照首次安装仍允许立即刷新一次。
- 空数据/异常数据不再白屏：面板增加错误边界与逐 tab 降级，`aa=null`、`models=[]`、行数据非数组等场景都有明确空态与重试入口。
- RPC 语义：未知方法 404、方法不符 405（带 `Allow`）、畸形 URL 400、保留 401/403、响应防二次写、body 超限先 pause 再 413、尾斜杠归一。
- 刷新保护：`POST /refresh` 的 `force` 刷新增加绝对频率上限（每小时最多 3 次），超出返回 `force-limited` 与重试时间；客户端有对应提示。
- 解析器健壮性：OpenRouter 改按表头列名映射（列漂移/乱序不再产生错位行）、表格识别放宽；AA `initialModels` 空格变体可解析；Arena rank 统一数字、asOf 取最新发布日期；涨跌箭头全变体兼容；作者名规范化（如 Z.ai→zhipu）。
- 数据源适配：Arena 改用 Hugging Face datasets-server `/rows` 分页 + 本地分类筛选（原 `/filter` 端点自 2026-11 起对匿名请求返回 422），增加单源 40s 预算与逐页降级，避免上游端点变更导致整源失效。
- 中文与 Unicode 搜索/匹配：名称归一化改为 NFKC + Unicode 字母数字（CJK 关键词可命中）。
- 体验与无障碍：刷新结果提示明确（节流/忙/force 上限/失败）、数据源状态条 `role=status`、错误横幅 `aria-live`、标签页 `←→`/`Home`/`End` 键盘导航。
- 验证脚本：`validate-host` / `validate-client` 去掉硬编码本机路径（可在任意目录运行）；新增离线 `validate-parsers.mjs`，`validate-usage` / `validate-livebench` 断言扩充。

## [0.1.0] - 2026-11-01

首个公开版本。

### Added

- DSH 侧栏「模型排行」面板（`main` slot）与侧栏入口（`sidebar.panellist`）。
- 六个标签页：Arena 对战（LMArena 盲测 Bradley-Terry 评分）、综合智能（Artificial Analysis
  智能指数）、OpenRouter 周榜、OpenRouter 月榜、市场份额、本机接入。
- 宿主侧每日快照管线：抓取 LMArena 官方 HF 数据集、Artificial Analysis 页面数据、
  OpenRouter rankings 页面表格；成功冷却 24h、失败 2h 重试、手动刷新 10 分钟节流。
- 内置兜底快照 `data/snapshot.json`；面板先读浏览器缓存立即渲染，再与 RPC 快照对齐。
  注意：该版本的**内置快照曾包含 Artificial Analysis 数据**，0.2.0 起移除。
- 本机模型高亮：读取 `DSH_HOME/profiles/*/cordis.patch.yml` 的 `llm-pi-ai` 清单并做名称归一化匹配。
- RPC：`GET /_dsh/dsh-model-rank/snapshot`、`GET /_dsh/dsh-model-rank/status`、
  `POST /_dsh/dsh-model-rank/refresh`。
- 环境变量：`DSH_MODEL_RANK_DATA_DIR`、`DSH_MODEL_RANK_REFRESH_MS`、
  `DSH_MODEL_RANK_RETRY_MS`、`DSH_MODEL_RANK_MIN_GAP_MS`。
