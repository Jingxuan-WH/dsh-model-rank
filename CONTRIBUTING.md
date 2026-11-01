# Contributing · 贡献指南

感谢你愿意花时间改进 dsh-model-rank。这是一个**无构建步骤**的 DSH 插件：宿主半侧是纯 Node 模块，
客户端是单文件 React bundle。仓库很小，因此流程也尽量短。

> English speakers: this guide is bilingual. The Chinese section is authoritative for
> behavior/privacy rules; the English summary at the bottom is enough to get started, and
> you are welcome to open issues/PRs in English.

---

## 1. 先提 Issue，再动代码

- **Bug**：请用 [bug_report](.github/ISSUE_TEMPLATE/bug_report.md) 模板，务必写清
  DSH 版本、操作系统 / profile、复现步骤、期望与实际。涉及数据抓取的请附上
  `/_dsh/dsh-model-rank/status` 返回（可脱敏）。
- **功能建议**：用 [feature_request](.github/ISSUE_TEMPLATE/feature_request.md) 模板。
  「这个功能对应什么真实使用场景」比「加个按钮」有用得多。
- **改行为 / 改 RPC 结构**：请先开 issue 讨论，避免大 PR 走错方向。

## 2. 隐私红线（对所有 contribution 生效）

本项目会读取用户本机配置与会话日志。任何提交物（代码、测试输出、日志、截图、issue、PR）
都**不得**包含：

- 真实的 provider / 渠道名与本机模型清单（示例请用 `demo-1`、`demo-model-a` 这类假名）；
- 账户余额、套餐额度、API key、cookie、任何凭据；
- 真实会话内容或完整的 `session/*.jsonl` 原文；
- 用户本机绝对路径（如 `C:\Users\<name>\...`）出现在**提交的文件**里。

> 注意：`data/snapshot.json` 是随包分发的**内置快照**，只能包含公开榜单数据；
> 不得包含本机 inventory、`local` 标记，也不得包含 Artificial Analysis 抓取数据
> （AA 数据仅允许在用户本机运行时抓取，不随仓库/包分发）。改动该文件前先读 README 的
> 「数据口径与来源」「隐私」两节。

## 3. 本地开发

### 3.1 环境

- Node.js **≥ 22.13**（仓库 `engines`；推荐 24，`node:zlib` 的 zstd 解码在旧版本上会缺失并降级）。
- 任意 DSH 0.2.x profile；桌面版与 `dsh web` 均可，推荐一次性的测试 profile。
- 无构建步骤：改完源码直接重新加载插件即可。

```bash
git clone https://github.com/Jingxuan-WH/dsh-model-rank.git
cd dsh-model-rank
npm install          # 只有一个运行时依赖：yaml
```

### 3.2 以 link 方式装进 profile

```bash
# Web profile（profile 名按你的实际环境替换，如 web / desktop / 自建）
dsh plugin --profile web add "link:$(pwd)"

# 桌面版：在 设置 → 插件 → 添加插件 里装，或用应用自带 CLI（Windows 示例）
& "<DeepSeek Harness 安装目录>\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add "link:<仓库绝对路径>"
```

卸载：`dsh plugin --profile <profile> remove dsh-model-rank`。
装完需要让宿主重新加载插件：重启 DSH 最稳；0.2.1 起多数情况刷新页面即可。

### 3.3 验证（提交 PR 前必须跑）

```bash
node --check lib/index.js
node --check lib/pipeline.js
node --check lib/client.js

node scripts/validate-host.mjs     # 宿主：路由注册 / 内置快照兜底 / RPC 形状（不联网）

# 客户端无头渲染回归（临时装 React，不进 package.json）
npm install --no-save --no-audit --no-fund react@18.3.1 react-dom@18.3.1
node scripts/validate-client.mjs
```

> ⚠️ **已知问题**：`scripts/validate-host.mjs` 与 `scripts/validate-client.mjs` 目前把
> `packageRoot` 写死为维护者本机路径。首次运行前请改成你自己的仓库路径（欢迎顺手提 PR
> 改成 `import.meta.url` 相对路径——这正是我们希望修掉的问题）。

### 3.4 抓取 / 快照脚本（会联网）

```bash
node scripts/build-snapshot.mjs    # 现场抓取数据并重新生成 data/snapshot.json（内置兜底快照）
```

改动内置快照后必须人工检查它不含 §2 列出的隐私内容。

## 4. 代码约定

- 2 空格缩进；保持 `lib/index.js`、`lib/pipeline.js`、`lib/client.js` 现有风格与标题注释。
- **宿主半侧**（`lib/**`）只用 `node:*` 内置模块 + 现有 `yaml` 依赖；**不要新增运行时依赖**。
- **客户端**（`lib/client.js`）保持单文件 bundle：
  `window.__ModuleLoader__.load({ id, factory })` 形态、`module.exports = { inject: ['slots'], apply }`、
  只 `require('react')`、无构建步骤、无第三方 UI 库。
- 样式使用 CSS 字符串注入；颜色一律用 DSH 主题 token（`--dsw-alias-*`）并带 fallback，保证明暗主题可用。
- 数据抓取失败时**保留旧快照并标记 stale**，不要清零、不要伪造数据。
- 面向用户的新文案中文优先，必要时中英都给；不要写未实现的承诺。
- 提交信息建议 Conventional Commits：`feat: …` / `fix: …` / `docs: …` / `perf: …` / `chore: …`。

## 5. PR 流程

1. 从 `main` 拉分支（如 `feat/usage-dashboard`）。
2. 按 [PR 模板](.github/pull_request_template.md) 填完；贴出验证命令与结果。
3. 涉及 UI 的请附截图（**必须用 demo 数据**）；涉及数据的请说明口径变化。
4. 行为/数据/隐私变化必须同步更新 `README.md` 相关章节和 `CHANGELOG.md`。
5. 一个 PR 只做一件事；大改动先拆小。
6. CI 会自动跑「语法 + manifest/快照隐私」自检（不装依赖、不联网），本地等价检查即上文 §3.3。

## 6. 发布（维护者）

版本号遵循 SemVer；发布步骤见 [docs/PUBLISH.md](docs/PUBLISH.md)。
Release 前必须核对：README 与实现一致、内置快照已净化、`CHANGELOG.md` 已更新、
awesome-dsh-plugin 条目描述与实际功能一致。

## 7. License

本项目为 [MIT](LICENSE)。提交 PR 即表示你同意以 MIT 许可贡献你的改动，
且确认贡献内容不包含他人版权/许可受限的素材。

---

## English quick start

`dsh-model-rank` is a build-step-free DSH plugin: a pure-Node host module plus a single-file
React client bundle (`lib/client.js`).

- **Before coding**: open an issue. For RPC/snapshot shape changes, discuss first.
- **Privacy is a hard rule**: never commit real provider/model names, balances, API keys, session
  content, or local absolute paths. Screenshots must use demo data. `data/snapshot.json` must stay
  free of local inventory and Artificial Analysis data (AA is fetched at runtime only).
- **Setup**: `git clone`, `npm install`, then `dsh plugin --profile <profile> add "link:<repo path>"`.
  Node ≥ 22.13; no build step.
- **Validate before a PR**: `node --check lib/{index,pipeline,client}.js`,
  `node scripts/validate-host.mjs`, and (after installing React 18 temporarily)
  `node scripts/validate-client.mjs`.
  Known issue: both validation scripts currently hard-code the maintainer's `packageRoot`;
  point them at your checkout first (a fix PR is welcome).
- **Code rules**: no new runtime dependencies; host uses `node:*` + `yaml` only; client stays a
  single bundle (`window.__ModuleLoader__.load(...)`, React only) with DSH theme tokens
  (`--dsw-alias-*`) and graceful fallbacks. Keep fetch failures non-destructive (stale snapshot,
  never fake data).
- **PRs**: one concern per PR, fill the template, paste validation output, screenshots with demo
  data only, update `README.md` + `CHANGELOG.md` when behavior/data changes.
- MIT license, inbound = outbound.
