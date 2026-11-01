# Pull Request

## 这个 PR 做了什么

<!-- 一句话总结；关联 issue 用 "Closes #123" -->

## 改动类型

- [ ] feat：新功能
- [ ] fix：修复
- [ ] docs：文档
- [ ] perf：性能
- [ ] chore / refactor：杂项 / 重构
- [ ] data：数据抓取、解析或内置快照

## 改动清单

<!-- 主要文件 + 一句话说明；大 diff 请指路 -->

## 验证

<!-- 贴命令与结果；UI / 数据类改动请附截图或返回样例（脱敏） -->

```bash
node --check lib/index.js
node --check lib/pipeline.js
node --check lib/client.js
node scripts/validate-host.mjs
# node scripts/validate-client.mjs   # 需先临时安装 react@18
```

- 验证结果：
- 涉及界面：截图（**必须使用 demo 数据**）
- 涉及数据：口径是否变化 / 是否更新了内置快照

## 检查项

- [ ] 没有新增运行时依赖（宿主只用 `node:*` + `yaml`；客户端只用 React）
- [ ] 未包含真实 provider/渠道名、模型清单、余额、API key、会话内容或本机绝对路径
- [ ] `data/snapshot.json` 不含本机 inventory / `local` 标记 / Artificial Analysis 数据
- [ ] 抓取失败仍保留旧快照（不伪造、不清零）
- [ ] 行为/数据变化已同步更新 README 与 CHANGELOG
- [ ] 保持客户端单文件 bundle 形态，无构建步骤
- [ ] 该 PR 只做一件事，可以独立回滚
