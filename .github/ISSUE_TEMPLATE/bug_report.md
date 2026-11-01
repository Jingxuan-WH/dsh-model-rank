---
name: Bug report
about: 报告一个可复现的问题（面板显示 / 数据抓取 / 安装 / 性能）
title: "[Bug] "
labels: bug
assignees: ""
---

## 环境

- DSH 版本（设置 → 关于，或 `dsh --version`）：
- 操作系统 / 架构：
- Profile 名称（`desktop` / `web` / 自建）：
- Node.js 版本（`node --version`；宿主运行时即可）：
- 插件版本（`package.json` 的 version 或插件页显示）：

## 复现步骤

1.
2.
3.

## 期望行为

## 实际行为

## 截图 / 日志

<!--
注意：截图与日志必须脱敏——不要贴真实 provider/渠道名、模型清单、余额、API key 或会话内容。
可用 demo 名称代替。
-->

## 数据相关（可选，凡是「数据不对/抓不到/刷新无变化」必填）

- 面板右上角「数据更新于」显示的时间：
- `GET /_dsh/dsh-model-rank/status` 返回（可删掉本机路径与模型清单）：
- 是否手动点过「刷新数据」：

## 已尝试

- [ ] 重启 DSH / 刷新页面
- [ ] 删除 `localStorage['dsh-model-rank:snapshot']` 后重试
- [ ] 触发一次手动刷新并等待完成

## 其它

- [ ] 我确认已搜索过现有 issues，没有重复
