// dsh-model-rank · headless client validation
// 目的：证明 lib/client.js 的 factory 能在真实 React 下物化，
//       注册到的 main 面板与侧栏图标组件能用「运行时快照 fixture」渲染出 HTML，并覆盖：
//       - 7 个 tab（含「能力榜」）与「本机接入」= 本机用量仪表盘；
//       - 数据源状态条 / 表头排序（aria-sort）/ CSV 导出按钮 / 明细抽屉入口；
//       - 内置快照净化（aa=null、无 local 标记）下不崩，且带 local 的运行时 fixture 能渲染「已接入」徽标。
// 用法（先临时装 dev 依赖，不进 package.json；跑完可删 node_modules）：
//   npm.cmd install --no-save --no-audit --no-fund react@18.3.1 react-dom@18.3.1
//   node scripts/validate-client.mjs
// 说明：bundled data/snapshot.json 是「净化版」（无 AA / 无本机清单 / 无 local），
//       所以本脚本在内存里注入 demo 假数据 fixture（demo-1/demo-2 + Demo Model A–D），
//       既验证净化版能渲染，也验证有 local 时「已接入」徽标与能力榜 tab 正常。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// P1-15：不写死本机绝对路径（脚本可复制到其它 checkout / CI 运行）
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const dshNodeModules = join(packageRoot, 'node_modules');

const requireFrom = createRequire(join(packageRoot, 'probe.js'));
const React = requireFrom(join(dshNodeModules, 'react'));
const ReactDOMServer = requireFrom(join(dshNodeModules, 'react-dom', 'server.js'));

// ---- 运行时快照 fixture：在净化版 bundled 快照上注入 demo 数据（不写回文件）----
const bundled = JSON.parse(readFileSync(join(packageRoot, 'data', 'snapshot.json'), 'utf8'));
const snapshot = JSON.parse(JSON.stringify(bundled));
const nowMs = Date.now();
const dayKey = (offset) => {
  const d = new Date(nowMs);
  d.setDate(d.getDate() - offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 1) AA fixture（bundled 净化后 aa === null，这里补 demo 行验证榜单渲染）
snapshot.aa = {
  asOf: dayKey(0),
  stale: false,
  models: [
    { rank: 1, name: 'Demo Model A', provider: 'Demo Labs', slug: 'demo-a', intelligence: 53.2, price: { input: 0.55, output: 2.2, cacheHit: 0.12, blended31: 1 }, speed: { tokensPerSec: 96, ttftMs: 410 }, contextTokens: 262000, local: { provider: 'demo-1', providerDisplay: 'Demo Gateway A', id: 'demo-model-a' } },
    { rank: 2, name: 'Demo Model B', provider: 'Demo Inc', slug: 'demo-b', intelligence: 44.8, price: { input: 0.3, output: 1.2, cacheHit: 0.06, blended31: 0.55 }, speed: { tokensPerSec: 120, ttftMs: 360 }, contextTokens: 131000 },
  ],
};

// 2) LiveBench fixture（结构严格按 .team/research.md §6.3；rows 的 local 也为 demo 值）
const lbCategories = [
  { key: 'long_agentic', name: 'Long Agentic', weight: 2 },
  { key: 'reasoning', name: 'Reasoning', weight: 1 },
  { key: 'coding', name: 'Coding', weight: 1.5 },
  { key: 'browser', name: 'Browser', weight: 1 },
  { key: 'data_analysis', name: 'Data Analysis', weight: 1 },
  { key: 'research', name: 'Research', weight: 1 },
  { key: 'design', name: 'Design', weight: 1.5 },
];
const lbScores = (base) => {
  const out = {};
  lbCategories.forEach((cat, i) => { out[cat.key] = Math.round((base - i * 3.1) * 10) / 10; });
  return out;
};
const lbRows = [
  { model: 'demo-model-a', display: 'Demo Model A', scores: lbScores(88), overall: 86.42, rank: 1, local: { provider: 'demo-1', providerDisplay: 'Demo Gateway A', id: 'demo-model-a' } },
  { model: 'demo-model-b', display: 'Demo Model B', scores: lbScores(79), overall: 77.13, rank: 2 },
  { model: 'demo-model-c', display: 'Demo Model C', scores: lbScores(71), overall: 69.87, rank: 3, local: { provider: 'demo-2', providerDisplay: 'Demo Gateway B', id: 'demo-model-c' } },
];
snapshot.livebench = {
  generation: 'v2',
  release: '2026-10-25',
  releaseId: '20261025',
  asOf: '2026-10-25',
  source: {
    home: 'https://livebench.ai/',
    table: 'https://livebench.ai/data/20261025/table.csv',
    categories: 'https://livebench.ai/data/20261025/categories.json',
    notes: 'https://livebench.ai/data/20261025/notes.json',
  },
  overall: 'weighted-mean',
  categories: lbCategories,
  rows: lbRows,
  ranked: lbRows.length,
  notes: ['Demo 口径说明 1（fixture）。', 'Demo 口径说明 2（fixture）。'],
  stale: false,
  fetchedAt: new Date(nowMs).toISOString(),
};

// 3) bundled 快照里 arena 行没有 local：运行时 fixture 给第一行补 demo local，验证徽标
if (snapshot.arena && Array.isArray(snapshot.arena.rows) && snapshot.arena.rows.length) {
  snapshot.arena.rows[0].local = { provider: 'demo-1', providerDisplay: 'Demo Gateway A', id: 'demo-model-a' };
}
if (snapshot.usage && Array.isArray(snapshot.usage.weekly) && snapshot.usage.weekly.length) {
  snapshot.usage.weekly[0].local = { provider: 'demo-1', providerDisplay: 'Demo Gateway A', id: 'demo-model-a' };
}
snapshot.sources = {
  ...(snapshot.sources || {}),
  'livebench-data': { url: 'https://livebench.ai/data/20261025/table.csv', ok: true, error: null },
};

const inventoryFixture = {
  userModelsCount: 3,
  userProviders: [
    { name: 'demo-1', display: 'Demo Gateway A', models: [{ id: 'demo-model-a', name: 'Demo Model A' }, { id: 'demo-model-b', name: 'Demo Model B' }] },
    { name: 'demo-2', display: 'Demo Gateway B', models: [{ id: 'demo-model-c', name: 'Demo Model C' }] },
  ],
  defaultModel: 'demo-model-a',
};
const metaFixture = {
  refreshing: false,
  lastSuccessMs: nowMs - 3 * 3600 * 1000,
  usageAsOf: (snapshot.usage && snapshot.usage.asOf) || null,
  bundled: false,
  sourceInfo: snapshot.sources,
};
const snapshotCachePayload = { snapshot, meta: metaFixture, inventory: inventoryFixture, at: nowMs };

// ---- 本机用量 fixture（契约 v1.1：顶层 + 每个 range 都有 costCoverage）----
const mkMetrics = (total, calls, cost, sessions) => ({
  inputTokens: Math.round(total * 0.5), outputTokens: Math.round(total * 0.14),
  cacheReadTokens: Math.round(total * 0.32), cacheWriteTokens: Math.round(total * 0.04),
  reasoningTokens: 0, totalTokens: total, calls, sessions, estimatedCostUsd: cost,
});
const byDayFixture = [];
for (let i = 13; i >= 0; i--) byDayFixture.push({ day: dayKey(i), ...mkMetrics(1_000_000 + i * 80_000, 8 + i, 0.4, 2) });
const usageModelA = {
  model: 'demo-model-a', display: 'Demo Model A', provider: 'demo-1', providers: ['demo-1'],
  ...mkMetrics(12_000_000, 40, 4.2, 5), share: 0.75, localRank: 1,
  aa: { slug: 'demo-a', name: 'Demo Model A', intelligence: 53.2, price: { input: 0.55, output: 2.2, cacheHit: 0.12 }, blended31: 1 },
  globalWeekly: { rank: 9, tokensLabel: '742B', authorDisplay: 'Demo Labs' }, arenaRank: 1,
};
const usageModelB = {
  model: 'demo-model-c', display: 'Demo Model C', provider: 'demo-2', providers: ['demo-2'],
  ...mkMetrics(4_000_000, 15, null, 3), share: 0.25, localRank: 2,
  aa: null, globalWeekly: null, arenaRank: null,
};
const usageRangeFixture = (total, calls, cost) => ({
  metrics: mkMetrics(total, calls, cost, 4),
  byModel: [usageModelA, usageModelB],
  byProvider: [
    { provider: 'demo-1', display: 'Demo Gateway A', ...mkMetrics(Math.round(total * 0.75), 30, cost, 3), share: 0.75, models: 1 },
    { provider: 'demo-2', display: 'Demo Gateway B', ...mkMetrics(Math.round(total * 0.25), 10, null, 1), share: 0.25, models: 1 },
  ],
  costCoverage: 0.75,
});
const usageFixture = {
  version: 1, ok: true, generatedAt: nowMs - 20_000, durationMs: 11,
  sources: {
    sessions: { dir: '/demo/.dsh/sessions', files: 6, parsed: 6, reparsed: 0, failed: 0, skipped: 0, events: 55, cache: 'warm' },
    accounts: { available: true, path: '/demo/.dsh/dsh-usage/provider-snapshots.json' },
  },
  totals: mkMetrics(16_000_000, 55, 4.2, 5),
  ranges: {
    today: usageRangeFixture(2_000_000, 6, 0.7),
    d7: usageRangeFixture(9_000_000, 30, 2.4),
    d30: usageRangeFixture(15_000_000, 52, 4.0),
    all: usageRangeFixture(16_000_000, 55, 4.2),
  },
  byDay: byDayFixture,
  accounts: [
    { provider: 'demo-1', displayName: 'Demo Gateway A', credential: 'env', balance: { currency: 'CNY', total: 128.5, updatedAt: nowMs - 7200e3 }, plan: [{ key: '5h', percent: 62, resetsAt: new Date(nowMs + 7200e3).toISOString() }] },
    { provider: 'demo-2', displayName: 'Demo Gateway B', credential: 'none', balance: null, plan: [] },
  ],
  inventory: { models: 3, providers: ['demo-1', 'demo-2'] },
  costCoverage: 0.75,
  warnings: ['demo：1 个会话文件解析失败，已跳过（不影响其余统计）。'],
};

// ---- window.__ModuleLoader__ 队列壳 + localStorage/document 桩 ----
const registrations = [];
globalThis.window = {
  __ModuleLoader__: {
    load(registration) { registrations.push(registration); },
  },
};
const store = new Map([['dsh-model-rank:snapshot', JSON.stringify(snapshotCachePayload)]]);
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = {
  head: { appendChild() {} },
  getElementById() { return null; },
  createElement: () => ({}),
  documentElement: {},
};

// ---- 加载 client bundle（模拟 loader 语义）----
const code = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
new Function('window', code)(globalThis.window);
if (registrations.length !== 1) throw new Error(`期望注册 1 个 bundle，实际 ${registrations.length}`);
const reg = registrations[0];
if (reg.id !== 'dsh-model-rank') throw new Error(`注册 id 不对：${reg.id}`);

// require 语义：本 bundle 只用 seed 模块 react
const factoryRequire = (spec) => {
  if (spec === 'react') return React;
  throw new Error(`client bundle 请求了未预期的模块: ${spec}`);
};
const clientExports = reg.factory(factoryRequire);
console.log('materialized ok; exports keys:', Object.keys(clientExports));
if (clientExports.inject?.[0] !== 'slots') throw new Error('exports.inject 应为 ["slots"]');

// ---- slots stub ----
const registered = [];
const injected = [];
const effects = [];
const slots = {
  inject(name, fn) { injected.push(name); fn(); return () => {}; },
  register(options, Component) { registered.push({ options, Component }); return () => {}; },
};
const ctx = {
  slots,
  get() { return undefined; },
  effect(fn, label) { effects.push(label); try { const d = fn(); return d; } catch (e) { throw e; } },
  reflect: { provide() {} },
};
await clientExports.apply(ctx);
console.log('injected slots:', injected.join(', '));
console.log('effects:', effects.join(', '));
console.log('registered:', registered.map((r) => `${r.options.name}(${r.options.key || r.options.id})`).join(', '));

// ---- 渲染组件为静态 HTML ----
const main = registered.find((r) => r.options.name === 'main');
const icon = registered.find((r) => r.options.name === 'sidebar.panellist');
if (!main || !icon) throw new Error('main 或 sidebar.panellist 未注册');

const iconHtml = ReactDOMServer.renderToStaticMarkup(React.createElement(icon.Component, { size: 16, active: false }));

// 每个 tab 单独渲染一次（localStorage 里先放 tab key + 用量缓存）
function renderPanelCustom(tab, snapshotObj, usageObj, metaObj) {
  store.set('dsh-model-rank:snapshot', JSON.stringify({ snapshot: snapshotObj, meta: metaObj || metaFixture, inventory: inventoryFixture, at: nowMs }));
  store.set('dsh-model-rank:tab', tab);
  store.set('dsh-model-rank:usage', JSON.stringify({ usage: usageObj || usageFixture, at: nowMs - 40_000 }));
  return ReactDOMServer.renderToStaticMarkup(React.createElement(main.Component, {}));
}
function renderPanel(tab) {
  // 每次都用原始 fixture，避免前一个用例污染
  return renderPanelCustom(tab, snapshot, usageFixture, metaFixture);
}
const panelHtml = renderPanel('arena');
const panelLocal = renderPanel('local');
const panelLivebench = renderPanel('livebench');
const panelShare = renderPanel('share');

// 空态：bundled 快照（livebench=null + livebench-data 标记 runtime-fetch-only + lastSuccessMs=null）
// 验证：能力榜空态文案 / 状态条「待联网更新」措辞 / 页头「内置快照 · 等待联网更新」
const savedLivebench = snapshot.livebench;
const savedSources = snapshot.sources;
snapshot.livebench = null;
snapshot.sources = {
  ...snapshot.sources,
  'livebench-data': { url: 'https://livebench.ai/', ok: false, error: 'bundled snapshot excludes LiveBench data (runtime fetch only)' },
};
const bundledMeta = { ...metaFixture, bundled: true, lastSuccessMs: null };
store.set('dsh-model-rank:snapshot', JSON.stringify({ snapshot, meta: bundledMeta, inventory: inventoryFixture, at: nowMs }));
store.set('dsh-model-rank:tab', 'livebench');
const panelLivebenchEmpty = ReactDOMServer.renderToStaticMarkup(React.createElement(main.Component, {}));
snapshot.livebench = savedLivebench;
snapshot.sources = savedSources;

// ---- P0-02 回归：真正渲染 aa tab（bundled 净化后 aa=null；以及空数组/异常类型），确保不崩 ----
const aaNullSnapshot = JSON.parse(JSON.stringify(snapshot));
aaNullSnapshot.aa = null;
const aaEmptySnapshot = JSON.parse(JSON.stringify(snapshot));
aaEmptySnapshot.aa = { asOf: null, models: [], stale: false };
const aaStringSnapshot = JSON.parse(JSON.stringify(snapshot));
aaStringSnapshot.aa = 'oops';
const arenaBadSnapshot = JSON.parse(JSON.stringify(snapshot));
arenaBadSnapshot.arena = { asOf: null, totalModels: 0, rows: 'oops', stale: false };
const panelAaNull = renderPanelCustom('aa', aaNullSnapshot);
const panelAaEmpty = renderPanelCustom('aa', aaEmptySnapshot);
const panelAaString = renderPanelCustom('aa', aaStringSnapshot);
const panelArenaBad = renderPanelCustom('arena', arenaBadSnapshot);

// ---- O1：costCoverage=0 且无已定价模型时，不得显示「定价覆盖 0%」----
const zeroCoverageUsage = JSON.parse(JSON.stringify(usageFixture));
for (const key of Object.keys(zeroCoverageUsage.ranges)) {
  zeroCoverageUsage.ranges[key].costCoverage = 0;
  zeroCoverageUsage.ranges[key].metrics.estimatedCostUsd = null;
}
zeroCoverageUsage.costCoverage = 0;
zeroCoverageUsage.totals.estimatedCostUsd = null;
const panelZeroCoverage = renderPanelCustom('local', snapshot, zeroCoverageUsage);

// ---- P1-13：host 最近一次失败要可见（meta.lastError / meta.lastWriteError 横幅）----
const errorMeta = { ...metaFixture, lastError: { message: 'demo offline', at: '2026-11-01T00:00:00.000Z' }, lastWriteError: null };
const writeErrorMeta = { ...metaFixture, lastError: null, lastWriteError: { message: 'demo write fail', at: '2026-11-01T00:00:00.000Z' } };
const panelMetaError = renderPanelCustom('arena', snapshot, usageFixture, errorMeta);
const panelWriteError = renderPanelCustom('arena', snapshot, usageFixture, writeErrorMeta);

console.log('\nicon html:', iconHtml.slice(0, 220), '...');
console.log('panel bytes:', { arena: panelHtml.length, local: panelLocal.length, livebench: panelLivebench.length, livebenchEmpty: panelLivebenchEmpty.length });
// 输出物写到临时目录，避免污染工作区与仓库
const outDir = process.env.TEMP || packageRoot;
writeFileSync(join(outDir, 'dsh-model-rank-panel.html'), panelHtml, 'utf8');
writeFileSync(join(outDir, 'dsh-model-rank-panel-local.html'), panelLocal, 'utf8');
writeFileSync(join(outDir, 'dsh-model-rank-panel-livebench.html'), panelLivebench, 'utf8');

// ---- 关键断言（原有断言全部保留）----
const checks = [
  ['根容器', panelHtml.includes('mrr-root')],
  ['Arena 对战 tab', panelHtml.includes('Arena 对战')],
  ['Arena Score 列', panelHtml.includes('Arena Score')],
  ['已接入徽标（运行时 fixture 带 local）', panelHtml.includes('已接入')],
  ['刷新数据按钮', panelHtml.includes('刷新数据')],
  ['榜单截点（snapshot.usage.asOf）', panelHtml.includes(snapshot.usage?.asOf || '用量截点')],
  ['综合智能 tab', panelHtml.includes('综合智能')],
  ['能力榜 tab', panelHtml.includes('能力榜')],
  ['OpenRouter 周 tab', panelHtml.includes('OpenRouter 周')],
  ['市场份额 tab', panelHtml.includes('市场份额')],
  // v0.2.0 回归：市场份额行必须同时保留布局类 .mrr-share 与可点击类 .mrr-row-clickable
  // （rowOpenProps 的 className 曾覆盖基础类，导致行退化为块级堆叠、份额条消失）
  ['市场份额行保留布局类（mrr-share + mrr-row-clickable 并存）', panelShare.includes('mrr-share mrr-row-clickable')],
  ['市场份额行含份额条与数值', panelShare.includes('mrr-sharebar') && panelShare.includes('mrr-shareval')],
  ['市场份额行不再退化为纯块级（无裸 mrr-share 行）', !panelShare.includes('class="mrr-share"')],
  ['本机接入 tab', panelHtml.includes('本机接入')],
  ['仅看已接入 chip', panelHtml.includes('仅看已接入')],
  ['数据源状态条', panelHtml.includes('mrr-srcbar') && panelHtml.includes('LMArena')],
  ['表头排序 aria-sort', panelHtml.includes('aria-sort=')],
  ['排序箭头占位可点击表头', panelHtml.includes('mrr-th-sort')],
  ['CSV 导出按钮（榜单）', panelHtml.includes('导出 CSV')],
  ['明细抽屉入口可点击行', panelHtml.includes('mrr-row-clickable')],
  ['能力榜 release 徽标', panelLivebench.includes('LiveBench 2.0') && panelLivebench.includes('2026-10-25')],
  ['能力榜类别 chips', panelLivebench.includes('Long Agentic') && panelLivebench.includes('Coding') && panelLivebench.includes('综合')],
  ['能力榜热格（7 类）', (panelLivebench.match(/mrr-lb-heat/g) || []).length >= lbCategories.length],
  ['能力榜权重 tooltip', panelLivebench.includes('权重')],
  ['能力榜来源署名', panelLivebench.includes('livebench.ai')],
  ['能力榜空态（livebench=null）', panelLivebenchEmpty.includes('暂无能力榜数据') && panelLivebenchEmpty.includes('内置快照不含第三方数据')],
  ['能力榜内置快照状态条措辞（待联网更新）', panelLivebenchEmpty.includes('待联网更新')],
  ['bundled 页头文案（内置快照 · 等待联网更新）', panelLivebenchEmpty.includes('等待联网更新')],
  ['本机用量标题', panelLocal.includes('本机用量')],
  ['用量 KPI 四口径', panelLocal.includes('今日') && panelLocal.includes('近 7 天') && panelLocal.includes('近 30 天') && panelLocal.includes('累计')],
  ['用量 KPI sparkline', panelLocal.includes('mrr-usage-spark') && panelLocal.includes('<polyline')],
  ['用量费用估算 + 覆盖度文案', panelLocal.includes('估算') && panelLocal.includes('覆盖')],
  ['我的模型用量排行', panelLocal.includes('我的模型用量排行')],
  ['provider 分布', panelLocal.includes('provider 用量分布')],
  ['近 14 天趋势 SVG', panelLocal.includes('近 14 天趋势') && panelLocal.includes('<svg')],
  ['账户余额 / 套餐窗口', panelLocal.includes('账户余额 / 套餐窗口')],
  ['账户凭据三态文案', panelLocal.includes('无凭据')],
  ['接入清单', panelLocal.includes('接入清单')],
  ['用量页不伪造缺失（—）', panelLocal.includes('>—<') || panelLocal.includes('>—')],
  // ---- 结构与 a11y（设计稿阶段 B 的稳定契约）----
  ['tablist role', panelHtml.includes('role="tablist"') && panelHtml.includes('aria-label="榜单切换"')],
  ['tab aria-selected', panelHtml.includes('role="tab"') && panelHtml.includes('aria-selected="true"')],
  ['tabpanel role/labelledby', panelHtml.includes('role="tabpanel"') && panelHtml.includes('aria-labelledby=')],
  ['数据源状态条 role=status', panelHtml.includes('role="status"') && panelHtml.includes('aria-live="polite"')],
  ['已接入徽标结构化断言', panelHtml.includes('data-kind="local"')],
  // ---- P0-02：aa tab 三态不得崩溃且有明确空态 ----
  ['aa=null 点综合智能不崩', panelAaNull.includes('mrr-root') && panelAaNull.includes('暂无综合智能数据')],
  ['aa=models[] 空态', panelAaEmpty.includes('暂无综合智能数据')],
  ['aa 类型异常不崩（降级空态）', panelAaString.includes('暂无综合智能数据')],
  ['arena.rows 非数组降级不崩', panelArenaBad.includes('mrr-root') && panelArenaBad.includes('Arena 对战')],
  // ---- O1：0 覆盖语义不得误导 ----
  ['O1 无定价不显示“定价覆盖 0%”', panelZeroCoverage.includes('需联网刷新后估算') && !panelZeroCoverage.includes('定价覆盖 0%')],
  // ---- P1-13：错误可见性 ----
  ['P1-13 数据源刷新失败可见', panelMetaError.includes('数据源刷新失败：demo offline') && panelMetaError.includes('role="status"')],
  ['P1-13 快照写入失败可见', panelWriteError.includes('快照写入失败：demo write fail')],
  // ---- LB-19：LiveBench 官方口径矛盾说明 ----
  ['LiveBench 官方口径矛盾说明', panelLivebench.includes('等权') && panelLivebench.includes('加权') && panelLivebench.includes('官方 notes')],
];
const failed = [];
for (const [name, ok] of checks) {
  if (!ok) failed.push(name);
  console.log(`${ok ? '√' : '×'} ${name}`);
}

// ---- 纯函数单元断言（通过 client bundle 的 __test 出口；P1-04/LB-05/排序稳定性）----
const T = clientExports.__test || {};
const unitFailures = [];
let unitTotal = 0;
function unit(name, fn) {
  unitTotal += 1;
  let ok = false;
  let detail = '';
  try {
    ok = fn() === true;
  } catch (err) {
    detail = String((err && err.message) || err);
  }
  if (!ok) unitFailures.push(name);
  console.log(`${ok ? '√' : '×'} [unit] ${name}${detail ? ' — ' + detail : ''}`);
}
unit('__test 出口存在', () => !!T && typeof T.normKey === 'function' && typeof T.csvCell === 'function');
unit('P1-04 normKey 保留中文：智能', () => T.normKey('智能') === '智能');
unit('P1-04 normKey 中英混合：GLM 智能', () => T.normKey('GLM 智能') === 'glm智能');
unit('P1-04 normKey NFKC 全角：ＧＰＴ－４Ｏ', () => T.normKey('ＧＰＴ－４Ｏ') === 'gpt4o');
unit('P1-04 normKey 去括注/contributor', () => T.normKey('Claude (Opus 4.6)') === 'claude' && T.normKey('model-contributor') === 'model');
unit('LB-05 csvCell = 注入防护', () => T.csvCell('=1+1') === "'=1+1");
unit('LB-05 csvCell + 注入防护', () => T.csvCell('+SUM(A1)') === "'+SUM(A1)");
unit('LB-05 csvCell - 注入防护', () => T.csvCell('-2+3') === "'-2+3");
unit('LB-05 csvCell @ 注入防护', () => T.csvCell('@cmd') === "'@cmd");
unit('LB-05 csvCell Tab/CR 注入防护', () => {
  const tab = T.csvCell('\tx');
  const cr = T.csvCell('\rx');
  return tab === "'\tx" && /^"'\r/.test(cr);
});
unit('LB-05 csvCell 正常值/引号转义', () => T.csvCell('normal') === 'normal' && T.csvCell('a,b') === '"a,b"' && T.csvCell('a"b') === '"a""b"');
unit('LB-05 buildCsv BOM+CRLF', () => T.buildCsv(['a'], [['x']]) === '\uFEFFa\r\nx\r\n');
unit('排序：数值升序且缺失值最后', () => {
  const rows = [{ v: 2 }, { v: null }, { v: 1 }, { v: 1 }];
  const out = T.applyTableSort(rows, { key: 'v', dir: 1 }, (r) => r.v);
  return JSON.stringify(out.map((r) => r.v)) === '[1,1,2,null]';
});
unit('排序：降序且缺失值仍最后', () => {
  const rows = [{ v: 2 }, { v: null }, { v: 1 }];
  const out = T.applyTableSort(rows, { key: 'v', dir: -1 }, (r) => r.v);
  return JSON.stringify(out.map((r) => r.v)) === '[2,1,null]';
});
unit('排序：相等值稳定（保持原序）', () => {
  const rows = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }, { id: 'c', v: 1 }];
  const out = T.applyTableSort(rows, { key: 'v', dir: 1 }, (r) => r.v);
  return out.map((r) => r.id).join('') === 'abc';
});
unit('O1 costCoverage=0 无价格→提示文案', () => {
  const info = T.costCoverageInfo({ estimatedCostUsd: null }, 0);
  return !!info && info.kind === 'none' && /需联网刷新后估算|暂无可定价模型/.test(info.text);
});
unit('P1-05 刷新四态映射', () => {
  return T.refreshFeedback({ reason: 'throttled' }).type === 'throttled'
    && T.refreshFeedback({ reason: 'busy' }).type === 'busy'
    && T.refreshFeedback({ reason: 'force-limited' }).type === 'force-limited'
    && T.refreshFeedback({ ok: false, error: 'boom' }).type === 'error'
    && /boom/.test(T.refreshFeedback({ ok: false, error: 'boom' }).message)
    && T.refreshFeedback({ ok: true }).type === 'ok'
    && T.refreshFeedback({ ok: true }).message === null;
});
unit('P1-14 marketShare 仅看已接入过滤', () => {
  const rows = [
    { author: 'Demo A', authorKey: 'demoa', orgMatched: true },
    { author: 'Demo B', authorKey: 'demob', orgMatched: false },
  ];
  return T.filterShareRows(rows, '', true).length === 1
    && T.filterShareRows(rows, '', true)[0].author === 'Demo A'
    && T.filterShareRows(rows, '', false).length === 2
    && T.filterShareRows(rows, 'demo b', false).length === 1;
});

const allFailed = failed.concat(unitFailures);
if (allFailed.length) throw new Error(`渲染/单元断言失败：${allFailed.join('、')}`);
console.log(`\n√ 全部断言通过（结构 ${checks.length} 项 + 纯函数 ${unitTotal} 项）：7 tab / 能力榜 / 本机用量 / 排序·CSV·状态条 / 空态 / aa 回归 / O1 / LB-19`);
