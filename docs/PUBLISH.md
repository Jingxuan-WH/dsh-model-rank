# npm 发布指南（维护者）

> **现状（2026-11-01 核查）**
>
> - `https://registry.npmjs.org/dsh-model-rank` 返回 **404** → 包尚未发布，包名当前可用。
> - 本机 npm 未登录：`npm.cmd whoami` → `ENEEDAUTH`。
> - **发布只能由仓库维护者（Lead）用本人 npm 账号执行**；本文只是步骤清单，不包含任何 token。
> - 不发布也完全不影响插件安装与 awesome 收录；只是市场里不会有「下载量」数字。

## 0. 发布前检查清单（缺一不可）

- [ ] `package.json` 的 `version` 已更新，且 `repository.url` 指回
      `https://github.com/Jingxuan-WH/dsh-model-rank`（awesome 市场靠它关联 npm 包，无需在 yml 里写 npm 字段）。
- [ ] `CHANGELOG.md` 有对应版本条目，日期正确。
- [ ] `README.md` / `README.en.md` 与实际功能一致（不写未实现的能力）。
- [ ] 内置快照 `data/snapshot.json` 已净化：**不含本机 provider/model 清单、`local` 标记、Artificial Analysis 数据**。
- [ ] 仓库里没有 `.team/`、测试日志、本机路径、真实 provider 名等隐私内容（`files` 白名单之外也要看一眼 git 状态）。
- [ ] 当前分支已 commit、与 GitHub 上的发布 commit 一致。

## 1. 版本号与提交

```powershell
cd D:\Tools\DeepSeek-Harness\dsh-model-rank
# 编辑 package.json 的 version -> 0.2.0
# 编辑 CHANGELOG.md：把 [Unreleased] 改成 [0.2.0] - YYYY-MM-DD
git add package.json CHANGELOG.md README.md README.en.md ...
git commit -m "chore(release): v0.2.0"
# 由 Lead push 并打 tag（见 .team 里的 push 清单）
```

## 2. 登录与预检

```powershell
npm.cmd whoami                                   # 必须返回你的 npm 用户名
npm.cmd view dsh-model-rank                      # 首次发布应返回 404
npm.cmd publish --dry-run --access public        # 只看打包内容，不真的发布
npm.cmd pack --dry-run                           # 再核对一次 tarball 文件清单
```

检查 `publish --dry-run` 的清单，预期包含：`package.json`、`README.md`、`LICENSE`、
`lib/**`、`data/snapshot.json`、`cordis.patch.yml`。**不应**包含 `.team/`、`docs/`、
测试数据或本机配置。

> 备注：`files` 白名单目前不含 `README.en.md` 与 `screenshots.json`。是否把它们加进 `files`
> 需要先改 `package.json`（**改前先与 Lead 确认**）：前者不影响 npm 页面展示（npm 只渲染
> `README.md`），后者是给插件市场读的、放仓库即可，所以默认都不加。

## 3. 发布

```powershell
npm.cmd publish --access public
```

- 开了 2FA 的账号会要求 OTP：`npm.cmd publish --access public --otp <6位验证码>`。
- 可选（未来）：在 GitHub Actions 里用 OIDC 做 `--provenance` 发布，需要在 CI 中执行，
  并保证 tag 与 commit 一致；当前无 CI 权限要求，先手动发布即可。

## 4. 发布后验证

```powershell
npm.cmd view dsh-model-rank version dist-tags repository
# 期望：0.2.0 | latest: 0.2.0 | repository 指回 GitHub
```

- 打开 `https://www.npmjs.com/package/dsh-model-rank` 确认版本与 README 渲染。
  **注意**：README 中的图片是仓库相对路径（`docs/preview.png`），npmjs.com 上可能不显示；
  以 GitHub 页面为准，不必为此把 README 改成绝对链接。
- 确认从 npm 安装可用：

```powershell
dsh plugin --profile <临时profile> add dsh-model-rank
```

## 5. 发布后要同步的文档

1. `README.md` / `README.en.md`：
   - 加 npm 版本徽章：`[![npm](https://img.shields.io/npm/v/dsh-model-rank)](https://www.npmjs.com/package/dsh-model-rank)`
   - 安装章节补最短路径：桌面端插件页填 `dsh-model-rank`；Web 端
     `dsh plugin --profile web add dsh-model-rank`（npm 通常比 git 源安装更快）。
2. `CHANGELOG.md` 该版本条目补一句「已在 npm 发布」。
3. awesome-dsh-plugin：**无需改 yml**——市场从 registry 自动采集下载量，前提是
   `package.json.repository` 指回被收录的仓库。
4. GitHub Release body 可选补 npm 安装命令。

## 6. 出问题怎么办

| 现象 | 处理 |
|---|---|
| `ENEEDAUTH` / `EOTP` | 先 `npm.cmd login`；开了 2FA 就加 `--otp` |
| `E403` 包名已存在 | 说明名字被占用（当前 404，可能性低）；改用带 scope 的包名 `@<user>/dsh-model-rank`，并同步改安装文档 |
| 发错内容 | **72 小时内**可 `npm.cmd unpublish dsh-model-rank@0.2.0`；超时后不能删版本，只能 `npm.cmd deprecate "dsh-model-rank@0.2.0" "使用 0.2.1"` 并发补丁版 |
| npm 页面 README 图片不显示 | 预期行为，以 GitHub 为准；或在 README 里改用 `raw.githubusercontent.com` 绝对链接（需权衡仓库内可维护性） |
| 发布后发现隐私内容 | 立即 `npm unpublish`（72h 内）+ 删除 GitHub 上的发布物 + 重新打算发布（评估是否泄露过敏感数据并公告） |

## 7. 不要做的事

- 不要把 npm token 写进仓库、`.npmrc`、脚本或 CI 明文；用 2FA/环境变量/CI secret。
- 不要发布未净化 `data/snapshot.json` 的版本（AA 数据再分发风险 + 本机清单泄露）。
- 不要为了「下载量」缩水 `files` 白名单或塞无关文件。
