// dsh-model-rank · scripts/validate-livebench.mjs
// 离线校验 lib/livebench.js（LiveBench 2.0 能力榜数据源）与快照接入/净化逻辑，默认零联网、可重复运行。
//
// 覆盖：
//   1) 版本发现：discoverBundleUrl（同源 / 相对路径 / 跨域拒绝 / 无脚本）、parseBundleReleases（v2 8 位 + v1 ISO，散落日期不误判）
//   2) CSV/JSON 解析：BOM/CRLF、列数不符行跳过、HTML 嗅探、缺 model 列、_overall_weights 元键、坏 JSON
//   3) 加权总分：按 _overall_weights、缺类不计入分母、0 分保留、'-'/空 视为无分、列缺失/未知类别、行数上限
//   4) notes：≤10 条、每条 ≤300 字、坏数据返回 []
//   5) fetchLivebench（注入 mock fetchText）：成功结构严格符合 .team/research.md §6.3；
//      404 HTML / 响应过大 / 同源拒绝 / 版本发现失败回退上次 releaseId / 新 release 无数据回退上一个 release
//   6) v1 旧代：等权总分 + 缺任一类别不进总榜
//   7) 快照接入与隐私：mergeSnapshots 写入 livebench、失败沿用旧数据 + stale、rows[].local 标记；
//      sanitizeBundledSnapshot 后 livebench=null 且无任何 local/orgMatched/userProviders 残留
//   8) 与 /usage 的匹配口径统一：pipeline.aliasKeys === usage.modelKeys 行为
//
// 运行：
//   node scripts/validate-livebench.mjs          # 默认离线（mock fetchText）
//   node scripts/validate-livebench.mjs --live   # 额外真实抓取一次 livebench.ai（只打印结构摘要，不打印数据集）
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LIVEBENCH_HOME, LIVEBENCH_LIMITS,
  discoverBundleUrl, parseBundleReleases, parseTableCsv, parseCategoriesJson,
  buildLivebenchRows, parseNotesJson, fetchLivebench, getLastLivebenchCache,
} from '../lib/livebench.js';
import { aliasKeys, mergeSnapshots, fetchText as pipelineFetchText } from '../lib/pipeline.js';
import { modelKeys as usageModelKeys } from '../lib/usage.js';
import { sanitizeBundledSnapshot, auditForbiddenKeys } from './build-snapshot.mjs';

const LIVE = process.argv.includes('--live');
const packageRoot = fileURLToPath(new URL('..', import.meta.url));

let failures = 0;
let checks = 0;
function check(ok, message) {
  checks += 1;
  if (ok) console.log(`  √ ${message}`);
  else {
    failures += 1;
    console.error(`  × ${message}`);
  }
}
function expectEqual(actual, expected, message) {
  const ok = Object.is(actual, expected);
  check(ok, ok ? message : `${message}（期望 ${expected}，实际 ${actual}）`);
}
function expectClose(actual, expected, tolerance, message) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tolerance;
  check(ok, ok ? message : `${message}（期望 ≈${expected}，实际 ${actual}）`);
}
function expectThrows(fn, message) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  check(threw, message);
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

const PAGE_HTML = '<!doctype html><html><head><title>LiveBench 2.0</title>'
  + '<script defer="defer" src="./static/js/main.test.js"></script>'
  + '<link href="./static/css/main.test.css" rel="stylesheet"></head><body><div id="root"></div></body></html>';
const BUNDLE_URL = `${LIVEBENCH_HOME}static/js/main.test.js`;
const V2_ID = '20261025';
const V1_ID = '2026-06-25';

const BUNDLE_TEXT = [
  'const Yt=["20261014","20261025"];',
  'const v1Dates=["2024-06-24","2024-07-26","2026-06-25"];',
  'const meta={version:"2025-01-01",released:"2024-11-25"};', // 散落日期：不是纯日期数组，不能误判为 release
].join('\n');

const V2_TABLE = [
  'model,long_agentic,reasoning,coding',
  'demo-model-a,80,60,70',
  'demo-model-b,60,60,60',
  'demo-model-c,90,-,70',
  'demo-model-broken,91,92', // 列数不符 → 跳过
].join('\n');

const V2_CATEGORIES = JSON.stringify({
  'Long Agentic': ['long_agentic'],
  Reasoning: ['reasoning'],
  Coding: ['coding'],
  _overall_weights: { 'Long Agentic': 2, Coding: 1.5 },
});

const V2_NOTES = JSON.stringify([
  'Each cell is the model mean task score for the suite, 0–100.',
  'Overall is the mean of the suites a model has a score for.',
]);

const V1_TABLE = [
  'model,task_a,task_b',
  'demo-model-a,80,60',
  'demo-model-b,90,-', // 类别 B 缺失 → v1 不进总榜
].join('\n');
const V1_CATEGORIES = JSON.stringify({ 'Cat A': ['task_a'], 'Cat B': ['task_b'] });
const V1_TABLE_URL = `${LIVEBENCH_HOME}v1/table_2026_06_25.csv`;
const V1_CATEGORIES_URL = `${LIVEBENCH_HOME}v1/categories_2026_06_25.json`;

function mockFetch(routes) {
  const calls = [];
  const requests = [];
  const fetchText = async (url, options = {}) => {
    calls.push(url);
    requests.push({ url, opts: options });
    if (!(url in routes)) throw new Error(`HTTP 404: ${url}`);
    const entry = routes[url];
    if (typeof entry === 'function') return entry(url);
    if (entry && typeof entry === 'object' && 'throw' in entry) throw new Error(entry.throw);
    return { text: entry, finalUrl: url, status: 200 };
  };
  fetchText.calls = calls;
  fetchText.requests = requests;
  return fetchText;
}

function successRoutes(overrides = {}) {
  return {
    [LIVEBENCH_HOME]: PAGE_HTML,
    [BUNDLE_URL]: BUNDLE_TEXT,
    [`${LIVEBENCH_HOME}data/${V2_ID}/table.csv`]: V2_TABLE,
    [`${LIVEBENCH_HOME}data/${V2_ID}/categories.json`]: V2_CATEGORIES,
    [`${LIVEBENCH_HOME}data/${V2_ID}/notes.json`]: V2_NOTES,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1) 版本发现
// ---------------------------------------------------------------------------
console.log('\n[1] 版本发现：bundle URL / release 数组');

expectEqual(discoverBundleUrl(PAGE_HTML), BUNDLE_URL, '相对 script src → 同源绝对 URL');
expectEqual(
  discoverBundleUrl('<html><script src="https://evil.example.com/x.js"></script></html>'),
  null,
  '跨域脚本被拒绝（同源校验）',
);
expectEqual(discoverBundleUrl('<html><link href="./main.css"></html>'), null, '没有 .js 脚本 → null');
expectEqual(discoverBundleUrl(''), null, '空 HTML → null');

const releases = parseBundleReleases(BUNDLE_TEXT);
check(releases.v2.join(',') === '20261014,20261025', 'v2 release 数组识别正确（升序）');
check(releases.v1.join(',') === '2024-06-24,2024-07-26,2026-06-25', 'v1 release 数组识别正确（散落日期不误判）');
expectEqual(parseBundleReleases('var a=1;').v2.length, 0, '没有日期数组 → v2 为空');
expectEqual(parseBundleReleases('var a=1;').v1.length, 0, '没有日期数组 → v1 为空');

// ---------------------------------------------------------------------------
// 2) CSV / JSON 解析
// ---------------------------------------------------------------------------
console.log('\n[2] table.csv / categories.json / notes.json 解析');

const table = parseTableCsv(V2_TABLE);
expectEqual(table.header.length, 4, 'table.csv 表头 4 列');
expectEqual(table.rows.length, 3, 'table.csv 有效行 = 3（列数不符行被跳过）');
check(table.warnings.some((warning) => warning.includes('列数不符')), 'table.csv 列数不符行有 warning');
expectThrows(() => parseTableCsv('<!doctype html><html></html>'), 'HTML 响应（404 fallback）被嗅探拒绝');
expectThrows(() => parseTableCsv(''), '空 table.csv 抛错');
expectThrows(() => parseTableCsv('foo,bar\n1,2'), '缺少 model 列抛错');

const crlf = parseTableCsv('\uFEFFmodel,a\r\nx,1\r\ny,2\r\n');
expectEqual(crlf.rows.length, 2, 'table.csv 容忍 BOM + CRLF');
const quoted = parseTableCsv('model,a\n"demo-model",1\n');
expectEqual(quoted.rows.length, 1, 'table.csv 容忍整字段引号包裹');
expectEqual(quoted.rows[0][0], 'demo-model', 'table.csv 剥离字段引号');

const categories = parseCategoriesJson(V2_CATEGORIES);
expectEqual(categories.categories.length, 3, 'categories.json 识别 3 个类别（_overall_weights 不计入）');
const categoryWeights = Object.fromEntries(categories.categories.map((category) => [category.name, category.weight]));
expectEqual(categoryWeights['Long Agentic'], 2, '_overall_weights 生效（Long Agentic ×2）');
expectEqual(categoryWeights.Coding, 1.5, '_overall_weights 生效（Coding ×1.5）');
expectEqual(categoryWeights.Reasoning, 1, '未配置权重的类别默认 ×1');
check(categories.categories.every((category) => !('_overall_weights' in category)), '元键 _overall_weights 未被当作类别');
expectThrows(() => parseCategoriesJson('[1,2,3]'), 'categories.json 结构异常抛错');
expectThrows(() => parseCategoriesJson('{oops'), 'categories.json 非法 JSON 抛错');
expectThrows(() => parseCategoriesJson('<!doctype html>'), 'categories.json HTML 响应被嗅探拒绝');
const emptyCategory = parseCategoriesJson(JSON.stringify({ Empty: [], Real: ['a'] }));
expectEqual(emptyCategory.categories.length, 1, '空任务类别被跳过');
check(emptyCategory.warnings.some((warning) => warning.includes('Empty')), '空任务类别有 warning');

const notes = parseNotesJson(V2_NOTES);
expectEqual(notes.length, 2, 'notes.json 解析 2 条');
expectEqual(parseNotesJson('not json').length, 0, '坏 notes 返回 []（可选数据源）');
expectEqual(parseNotesJson(JSON.stringify({ a: 1 })).length, 0, '非数组 notes 返回 []');
const manyNotes = parseNotesJson(JSON.stringify(Array.from({ length: 12 }, (_, i) => `note-${i}`)));
expectEqual(manyNotes.length, LIVEBENCH_LIMITS.notes, `notes 最多 ${LIVEBENCH_LIMITS.notes} 条`);
const longNotes = parseNotesJson(JSON.stringify(['x'.repeat(400)]));
check(longNotes[0].length <= LIVEBENCH_LIMITS.noteChars, `单条 notes ≤ ${LIVEBENCH_LIMITS.noteChars} 字（实际 ${longNotes[0].length}）`);

// ---------------------------------------------------------------------------
// 3) 加权总分
// ---------------------------------------------------------------------------
console.log('\n[3] 加权总分（_overall_weights / 缺类不计入分母 / 0 分保留）');

const builtRows = buildLivebenchRows(table, categories.categories);
expectEqual(builtRows.length, 3, '可用行 = 3（全缺失行会被排除）');
expectEqual(builtRows[0].model, 'demo-model-c', '按总分降序：demo-model-c 第一');
expectClose(builtRows.find((row) => row.model === 'demo-model-c').overall, 81.43, 0.01, 'demo-model-c 缺 reasoning：加权 (90×2+70×1.5)/3.5 = 81.43');
expectClose(builtRows.find((row) => row.model === 'demo-model-a').overall, 72.22, 0.01, 'demo-model-a 加权 (80×2+60×1+70×1.5)/4.5 = 72.22');
expectClose(builtRows.find((row) => row.model === 'demo-model-b').overall, 60, 0.001, 'demo-model-b 等分 = 60');
check(builtRows.every((row, index) => row.rank === index + 1), 'rank 从 1 连续');
expectEqual(builtRows.find((row) => row.model === 'demo-model-c').scores.reasoning, undefined, '缺失类别不写入 scores');
expectEqual(builtRows.find((row) => row.model === 'demo-model-c').display, 'demo-model-c', 'display 缺省 = 原始 model');

const zeroRow = buildLivebenchRows(
  { header: ['model', 'a'], rows: [['demo-zero', '0'], ['demo-missing', '-']] },
  [{ key: 'a', name: 'A', tasks: ['a'], weight: 1 }],
);
expectEqual(zeroRow.length, 1, '0 分是合法分数、"-" 视为缺失');
expectClose(zeroRow[0].overall, 0, 1e-9, '0 分保留为 overall = 0');

const allMissing = buildLivebenchRows(
  { header: ['model', 'a'], rows: [['demo-x', '-']] },
  [{ key: 'a', name: 'A', tasks: ['a'], weight: 1 }],
);
expectEqual(allMissing.length, 0, '所有类别无分的行被排除');

const weightedVsEqual = buildLivebenchRows(
  { header: ['model', 'a', 'b'], rows: [['demo-w', '90', '60']] },
  [{ key: 'a', name: 'A', tasks: ['a'], weight: 2 }, { key: 'b', name: 'B', tasks: ['b'], weight: 1 }],
);
expectClose(weightedVsEqual[0].overall, 80, 0.001, '加权生效：90×2/3 + 60×1/3 = 80（等权会是 75）');

const hugeTable = { header: ['model', 'a'], rows: Array.from({ length: LIVEBENCH_LIMITS.rows + 5 }, (_, i) => [`demo-${i}`, String(100 - i / 100)]) };
const cappedRows = buildLivebenchRows(hugeTable, [{ key: 'a', name: 'A', tasks: ['a'], weight: 1 }]);
expectEqual(cappedRows.length, LIVEBENCH_LIMITS.rows, `行数上限 ${LIVEBENCH_LIMITS.rows}`);

// v1：等权 + 缺任一类别不进总榜
const v1Table = parseTableCsv(V1_TABLE);
const v1Categories = parseCategoriesJson(V1_CATEGORIES).categories;
const v1Rows = buildLivebenchRows(v1Table, v1Categories, { requireAllCategories: true });
expectEqual(v1Rows.length, 1, 'v1：缺任一类别不进总榜');
expectClose(v1Rows[0].overall, 70, 0.001, 'v1：等权总分 = (80+60)/2 = 70');

// 多个同源脚本：第一个没有版本信息时应继续尝试下一个（站点若引入 vendor chunk 仍可工作）
const multiHtml = '<html><head><script src="./static/js/vendor.js"></script><script src="./static/js/main.test.js"></script></head></html>';
expectEqual(discoverBundleUrl(multiHtml), `${LIVEBENCH_HOME}static/js/vendor.js`, 'discoverBundleUrl 返回首个同源 .js');
const multiMock = mockFetch({
  [LIVEBENCH_HOME]: multiHtml,
  [`${LIVEBENCH_HOME}static/js/vendor.js`]: 'var vendorBundle=1;',
  [BUNDLE_URL]: BUNDLE_TEXT,
  [`${LIVEBENCH_HOME}data/${V2_ID}/table.csv`]: V2_TABLE,
  [`${LIVEBENCH_HOME}data/${V2_ID}/categories.json`]: V2_CATEGORIES,
  [`${LIVEBENCH_HOME}data/${V2_ID}/notes.json`]: V2_NOTES,
});
const multiBundle = await fetchLivebench(null, { fetchText: multiMock });
check(multiBundle.ok === true, '多个同源脚本：跳过无版本信息的 vendor 后仍发现 release');

// ---------------------------------------------------------------------------
// 4) fetchLivebench（注入 mock fetchText）
// ---------------------------------------------------------------------------
console.log('\n[4] fetchLivebench：成功结构 / 失败降级');

const mock = mockFetch(successRoutes());
const okResult = await fetchLivebench(null, { fetchText: mock });
check(okResult.ok === true, '抓取成功 ok=true');
const data = okResult.data || {};
expectEqual(data.generation, 'v2', 'generation = v2');
expectEqual(data.releaseId, V2_ID, 'releaseId = 20261025');
expectEqual(data.release, '2026-10-25', 'release 展示名为 ISO 日期');
expectEqual(data.asOf, '2026-10-25', 'asOf = release');
expectEqual(data.overall, 'weighted-mean', 'overall 口径标识 weighted-mean');
expectEqual(data.ranked, 3, 'ranked = 可用行数');
check(Array.isArray(data.rows) && data.rows.length === 3 && data.rows.every((row) => typeof row.overall === 'number'), 'rows 结构合法（overall 为数字）');
check(data.categories.length === 3 && data.categories.every((category) => typeof category.key === 'string' && typeof category.weight === 'number'), 'categories 结构合法（key/name/weight）');
check(Array.isArray(data.notes) && data.notes.length === 2, 'notes 已带上（≤10 条 × 300 字）');
check(data.source.table.endsWith(`/data/${V2_ID}/table.csv`) && data.source.categories.endsWith('/categories.json'), 'source 记录 table/categories URL');
check(typeof data.fetchedAt === 'string' && Number.isFinite(Date.parse(data.fetchedAt)), 'fetchedAt 为合法 ISO 时间');
expectEqual(data.stale, false, '成功后 stale=false');
check(!!getLastLivebenchCache() && getLastLivebenchCache().releaseId === V2_ID, '内部缓存记录最近一次成功结果');
check(mock.calls.every((url) => url.startsWith('https://livebench.ai/')), '所有请求都在 livebench.ai 同源');

const missingNotes = mockFetch(successRoutes({ [`${LIVEBENCH_HOME}data/${V2_ID}/notes.json`]: { throw: 'HTTP 500' } }));
const noNotes = await fetchLivebench(null, { fetchText: missingNotes });
check(noNotes.ok === true && noNotes.data.notes.length === 0, 'notes.json 失败不影响榜单');

const html404 = mockFetch(successRoutes({ [`${LIVEBENCH_HOME}data/${V2_ID}/table.csv`]: '<!doctype html><html><body>Not Found</body></html>' }));
const htmlFail = await fetchLivebench(null, { fetchText: html404 });
check(htmlFail.ok === false && /HTML/.test(htmlFail.error), '404 的 HTML fallback 被拒绝（ok=false + 原因）');

// 新 release 数据未发布 → 回退上一个 release
const fallbackRoutes = successRoutes({
  [`${LIVEBENCH_HOME}data/${V2_ID}/table.csv`]: { throw: 'HTTP 404' },
  [`${LIVEBENCH_HOME}data/20261014/table.csv`]: V2_TABLE,
  [`${LIVEBENCH_HOME}data/20261014/categories.json`]: V2_CATEGORIES,
  [`${LIVEBENCH_HOME}data/20261014/notes.json`]: V2_NOTES,
});
const fallback = await fetchLivebench({ generation: 'v2', releaseId: '20261014' }, { fetchText: mockFetch(fallbackRoutes) });
check(fallback.ok === true && fallback.data.releaseId === '20261014', '新 release 无数据 → 回退上一个 releaseId');

// 版本发现失败 → 用 prev.releaseId 兜底
const discoveryFail = mockFetch({
  [LIVEBENCH_HOME]: '<html><body>maintenance</body></html>',
  [`${LIVEBENCH_HOME}data/20261014/table.csv`]: V2_TABLE,
  [`${LIVEBENCH_HOME}data/20261014/categories.json`]: V2_CATEGORIES,
  [`${LIVEBENCH_HOME}data/20261014/notes.json`]: V2_NOTES,
});
const prevFallback = await fetchLivebench({ generation: 'v2', releaseId: '20261014' }, { fetchText: discoveryFail });
check(prevFallback.ok === true && prevFallback.data.releaseId === '20261014', '版本发现失败 → 回退 prev.releaseId');

// 响应过大
const oversized = mockFetch(successRoutes({ [BUNDLE_URL]: 'x'.repeat(LIVEBENCH_LIMITS.bundle + 10) }));
const sizeFail = await fetchLivebench(null, { fetchText: oversized });
check(sizeFail.ok === false && /响应过大|过大/.test(sizeFail.error), 'bundle 超大小上限 → ok=false');

// 跨域 bundle：首页只给跨域脚本 → 版本发现失败（无 prev）→ ok=false
const crossOrigin = mockFetch({ [LIVEBENCH_HOME]: '<html><script src="https://cdn.example.com/app.js"></script></html>' });
const crossFail = await fetchLivebench(null, { fetchText: crossOrigin });
check(crossFail.ok === false, '跨域 bundle 被拒绝 → ok=false');
check(crossOrigin.calls.length === 1, '跨域脚本不会被下载（只请求首页）');

// 类别任务列缺失 → 本次失败（保留旧数据由 pipeline 负责）
const missingCategoryColumn = mockFetch(successRoutes({
  [`${LIVEBENCH_HOME}data/${V2_ID}/table.csv`]: 'model,long_agentic\n demo-model-a,80\n',
}));
const columnFail = await fetchLivebench(null, { fetchText: missingCategoryColumn });
check(columnFail.ok === false && /任务列缺失|列缺失/.test(columnFail.error), '类别任务列缺失 → ok=false（不半截入库）');

// v1 旧代：等权 + 缺类别排除 + 无 notes 请求
const v1Mock = mockFetch({
  [LIVEBENCH_HOME]: PAGE_HTML,
  [BUNDLE_URL]: 'const v1=["2026-06-25"];',
  [V1_TABLE_URL]: V1_TABLE,
  [V1_CATEGORIES_URL]: V1_CATEGORIES,
});
const v1Result = await fetchLivebench(null, { fetchText: v1Mock });
check(v1Result.ok === true && v1Result.data.generation === 'v1', 'v1 旧代可解析（generation=v1）');
check(v1Result.data.overall === 'equal-mean', 'v1 overall 口径 = equal-mean');
expectEqual(v1Result.data.rows.length, 1, 'v1：缺类别模型不进总榜');
check(!v1Mock.calls.some((url) => url.includes('notes.json')), 'v1 不请求 notes.json');

// ---------------------------------------------------------------------------
// 5) 快照接入 + 本机标记
// ---------------------------------------------------------------------------
console.log('\n[5] pipeline 接入：mergeSnapshots 写入 livebench / 失败 stale / local 标记');

const inventory = {
  models: [{ provider: 'demo-provider', providerDisplay: 'Demo Provider', id: 'demo-model-a', name: 'Demo Model A' }],
  providers: [{ name: 'demo-provider', display: 'Demo Provider', models: [] }],
  default: null,
};
const fetchedOk = { livebench: okResult.data, sources: { 'livebench-data': { url: LIVEBENCH_HOME, ok: true, error: null } } };
const merged = mergeSnapshots(null, fetchedOk, inventory);
check(merged.livebench && merged.livebench.generation === 'v2' && merged.livebench.rows.length === 3, 'mergeSnapshots 写入 livebench 数据');
check(merged.livebench.stale === false, '成功时 stale=false');
const localRow = merged.livebench.rows.find((row) => row.model === 'demo-model-a');
check(localRow && localRow.local && localRow.local.provider === 'demo-provider', 'rows[].local 打上本机 provider（复用 aliasKeys 宽松匹配）');
const noLocalRow = merged.livebench.rows.find((row) => row.model === 'demo-model-b');
check(!!noLocalRow && noLocalRow.local === undefined, '未匹配行不带 local');

const fetchedFail = { livebench: null, sources: { 'livebench-data': { url: LIVEBENCH_HOME, ok: false, error: 'HTTP 500' } } };
const mergedFail = mergeSnapshots(merged, fetchedFail, inventory);
check(mergedFail.livebench && mergedFail.livebench.stale === true, '抓取失败：沿用旧数据并标 stale=true');
expectEqual(mergedFail.livebench.rows.length, 3, '抓取失败：旧行数保留（不清零）');
const mergedFirstFail = mergeSnapshots(null, fetchedFail, inventory);
check(mergedFirstFail.livebench === null, '从未成功过：livebench 保持 null（不伪造数据）');

// 匹配口径统一
check(
  JSON.stringify(aliasKeys('vendor/demo-model-a-1017:free')) === JSON.stringify(usageModelKeys('vendor/demo-model-a-1017:free')),
  'pipeline.aliasKeys 与 usage.modelKeys 口径一致',
);
check(aliasKeys('demo-model-a-1017').includes('demomodela'), '别名规则支持去掉日期/版本尾缀（LiveBench -1017 之类）');

// ---------------------------------------------------------------------------
// 6) 内置快照净化（隐私 strip）
// ---------------------------------------------------------------------------
console.log('\n[6] sanitizeBundledSnapshot：AA/LiveBench 不随包分发、行内标记清空');

const dirty = {
  version: 1,
  fetchedAt: '2026-11-01T10:00:00.000Z',
  sources: {
    'livebench-data': { url: LIVEBENCH_HOME, ok: true, error: null },
    'aa-models': { url: 'https://artificialanalysis.ai/models', ok: true, error: null },
    'openrouter-rankings': { url: 'https://openrouter.ai/rankings', ok: true, error: null },
  },
  userModelsCount: 36,
  userProviders: [{ name: 'demo-provider', display: 'Demo Provider', models: [{ id: 'demo-model-a' }] }],
  usedDefaultModel: { provider: 'demo-provider', model: 'demo-model-a' },
  arena: { rows: [{ rank: 1, model: 'demo-model-a', local: { provider: 'demo-provider' } }] },
  aa: { models: [{ name: 'Demo AA', local: { provider: 'demo-provider' } }] },
  usage: {
    weekly: [{ model: 'Demo Weekly', local: { provider: 'demo-provider' } }],
    today: [], month: [], trending: [],
    marketShare: [{ author: 'Demo', orgMatched: true }],
  },
  livebench: {
    generation: 'v2', release: '2026-10-25', releaseId: V2_ID,
    rows: [{ model: 'demo-model-a', local: { provider: 'demo-provider' } }, { model: 'demo-model-b' }],
    stale: false,
  },
};
const clean = sanitizeBundledSnapshot(dirty);
check(clean.livebench === null, '净化后 livebench = null（不随包分发）');
check(clean.aa === null, '净化后 aa = null（不随包分发）');
check(clean.sources['livebench-data'].ok === false && /runtime fetch only/.test(clean.sources['livebench-data'].error), 'sources["livebench-data"] 标记为仅运行时抓取');
check(clean.sources['aa-models'].ok === false, 'sources["aa-models"] 标记为仅运行时抓取');
check(clean.userProviders === undefined && clean.userModelsCount === undefined && clean.usedDefaultModel === undefined, '本机接入清单字段已删除');
check(clean.arena.rows.length === 1 && clean.arena.rows[0].local === undefined, 'arena 行保留但 local 标记被剥离');
check(clean.usage.weekly[0].local === undefined && clean.usage.marketShare[0].orgMatched === undefined, 'usage 行的 local/orgMatched 被剥离');
expectEqual(auditForbiddenKeys(clean).length, 0, '净化后深度隐私自检 0 残留');
check(dirty.livebench !== null && dirty.arena.rows[0].local !== undefined, '净化不修改输入对象（深拷贝）');

// 已提交的内置快照也必须满足上述约束（若仓库里存在该文件）
const bundledPath = join(packageRoot, 'data', 'snapshot.json');
if (existsSync(bundledPath)) {
  const repoSnapshot = JSON.parse(readFileSync(bundledPath, 'utf8'));
  check(repoSnapshot.livebench === null, '仓库 data/snapshot.json 的 livebench = null');
  expectEqual(auditForbiddenKeys(repoSnapshot).length, 0, '仓库 data/snapshot.json 深度隐私自检 0 残留');
}

// ---------------------------------------------------------------------------
// 7) 传输加固（LB-12）：maxBytes = Content-Length 预检 + 流式超限中止
// ---------------------------------------------------------------------------
console.log('\n[7] 传输加固（LB-12）：Content-Length 预检 + 流式超限中止');

check(LIVEBENCH_LIMITS.budgetMs === 45_000, 'LIVEBENCH_LIMITS.budgetMs = 45s（全局预算，LB-11）');
check(LIVEBENCH_LIMITS.requestTimeoutMs === 8_000, 'LIVEBENCH_LIMITS.requestTimeoutMs = 8s（单请求超时上限）');
check(LIVEBENCH_LIMITS.bundleCandidates === 2, 'LIVEBENCH_LIMITS.bundleCandidates = 2（候选脚本上限）');

const originalFetch = globalThis.fetch;
try {
  // (a) Content-Length 预检：超限时不应读取 body
  let bodyRead = false;
  let bodyCanceled = false;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://livebench.ai/x',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? String(4 * 1024 * 1024) : null) },
    body: {
      cancel: async () => { bodyCanceled = true; },
      getReader() { bodyRead = true; throw new Error('Content-Length 已超限，不应读取 body'); },
    },
    text: async () => { bodyRead = true; return ''; },
  });
  let contentLengthErr = null;
  try {
    await pipelineFetchText('https://livebench.ai/x', { maxBytes: 256 * 1024, retries: 0 });
  } catch (err) {
    contentLengthErr = err;
  }
  check(!!contentLengthErr && /响应过大/.test(contentLengthErr.message), 'Content-Length 超限 → 快速失败（不读 body）');
  check(bodyCanceled === true, 'Content-Length 超限 → 调用 body.cancel() 中止下载');
  check(bodyRead === false, 'Content-Length 超限 → 未读取响应体');

  // (b) 无 Content-Length：流式累计，超限即 cancel（不是读完再量）
  let streamCanceled = false;
  let chunksRead = 0;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://livebench.ai/x',
    headers: { get: () => null },
    body: {
      getReader() {
        let index = 0;
        return {
          read: async () => {
            if (index < 64) {
              index += 1;
              chunksRead += 1;
              return { done: false, value: new Uint8Array(64 * 1024) };
            }
            return { done: true, value: undefined };
          },
          cancel: async () => { streamCanceled = true; },
        };
      },
    },
    text: async () => '',
  });
  let streamErr = null;
  try {
    await pipelineFetchText('https://livebench.ai/x', { maxBytes: 256 * 1024, retries: 0 });
  } catch (err) {
    streamErr = err;
  }
  check(!!streamErr && /大小上限/.test(streamErr.message), '流式累计超限 → 抛「超过大小上限」');
  check(streamCanceled === true, '流式超限 → reader.cancel() 中止下载');
  check(chunksRead <= 5, `流式超限后立即停止读取（仅读 ${chunksRead} 个 chunk，上限 256KB/64KB≈5）`);

  // (c) 正常小响应仍可读
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://livebench.ai/x',
    headers: { get: (name) => (String(name).toLowerCase() === 'content-length' ? '5' : null) },
    body: null,
    text: async () => 'hello',
  });
  const smallRead = await pipelineFetchText('https://livebench.ai/x', { maxBytes: 256 * 1024, retries: 0 });
  expectEqual(smallRead.text, 'hello', '正常小响应可读取（maxBytes 不误伤）');

  // (d) 超限错误不重试：fetch 只调用 1 次
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      url: 'https://livebench.ai/x',
      headers: { get: () => '1048576' },
      body: { cancel: async () => {} },
      text: async () => '',
    };
  };
  try {
    await pipelineFetchText('https://livebench.ai/x', { maxBytes: 1024, retries: 2 });
  } catch { /* 预期超限 */ }
  expectEqual(fetchCalls, 1, '超限错误不重试（避免重复下载大响应）');
} finally {
  globalThis.fetch = originalFetch;
}

// (e) 传输层返回超限文本时，LiveBench 的读后校验双保险仍会拒绝
const hugeCsv = 'model,a\n' + 'x'.repeat(LIVEBENCH_LIMITS.csv + 10);
const oversizedTextResult = await fetchLivebench(null, {
  fetchText: mockFetch(successRoutes({ [`${LIVEBENCH_HOME}data/${V2_ID}/table.csv`]: hugeCsv })),
});
check(oversizedTextResult.ok === false && /过大|大小/.test(oversizedTextResult.error), '传输层返回超限文本 → 读后 assertTextSize 双保险拒绝');

// (f) LiveBench 下发给传输层的参数：retries:0 / 单请求超时 ≤8s / maxBytes 按资源类型
const captureFetch = mockFetch(successRoutes());
const captured = await fetchLivebench(null, { fetchText: captureFetch });
check(captured.ok === true, '参数捕获用例抓取成功');
const captureRequests = captureFetch.requests;
check(captureRequests.length >= 5, `共发起 ${captureRequests.length} 个请求（首页/bundle/table/categories/notes）`);
check(captureRequests.every((request) => request.opts && request.opts.retries === 0), '所有 LiveBench 请求 retries:0（不再 2×30s 重试）');
check(
  captureRequests.every((request) => Number.isFinite(request.opts.timeoutMs) && request.opts.timeoutMs > 0 && request.opts.timeoutMs <= LIVEBENCH_LIMITS.requestTimeoutMs),
  '所有 LiveBench 请求单请求超时 ≤ 8s',
);
check(
  captureRequests.every((request) => Number.isFinite(request.opts.maxBytes) && request.opts.maxBytes > 0),
  '所有 LiveBench 请求都携带 maxBytes（供传输层流式中止）',
);
const bundleRequest = captureRequests.find((request) => request.url.endsWith('.js'));
expectEqual(bundleRequest && bundleRequest.opts.maxBytes, LIVEBENCH_LIMITS.bundle, 'bundle 请求 maxBytes = 2MB');
const tableRequest = captureRequests.find((request) => request.url.endsWith('/table.csv'));
expectEqual(tableRequest && tableRequest.opts.maxBytes, LIVEBENCH_LIMITS.csv, 'table.csv 请求 maxBytes = 256KB');
const categoriesRequest = captureRequests.find((request) => request.url.endsWith('/categories.json'));
expectEqual(categoriesRequest && categoriesRequest.opts.maxBytes, LIVEBENCH_LIMITS.json, 'categories.json 请求 maxBytes = 256KB');
const homeRequest = captureRequests.find((request) => request.url === LIVEBENCH_HOME);
expectEqual(homeRequest && homeRequest.opts.maxBytes, LIVEBENCH_LIMITS.html, '首页请求 maxBytes = 256KB');

// ---------------------------------------------------------------------------
// 8) 全局时间预算（LB-11）
// ---------------------------------------------------------------------------
console.log('\n[8] 全局时间预算（LB-11）：整轮抓取 ≤45s，超预算返回 ok:false/error="budget"');

// (a) 慢传输 + 小预算：预算耗尽后立即返回，不继续后续请求
const slowTransport = async (url) => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  return { text: url === LIVEBENCH_HOME ? PAGE_HTML : BUNDLE_TEXT, finalUrl: url, status: 200 };
};
const budgetStart = Date.now();
const budgetHit = await fetchLivebench(null, { fetchText: slowTransport, budgetMs: 100 });
const budgetElapsed = Date.now() - budgetStart;
check(budgetHit.ok === false && budgetHit.error === 'budget', '预算耗尽 → ok=false, error="budget"');
check(budgetElapsed < 2_000, `超预算快速返回（${budgetElapsed}ms，暂停后续请求）`);

// (b) 已过期预算（budgetMs=0）→ 立即 budget，且不发起任何请求
const zeroBudgetFetch = mockFetch(successRoutes());
const zeroBudget = await fetchLivebench(null, { fetchText: zeroBudgetFetch, budgetMs: 0 });
check(zeroBudget.ok === false && zeroBudget.error === 'budget', 'budgetMs=0 → 立即返回 budget');
expectEqual(zeroBudgetFetch.requests.length, 0, 'budgetMs=0 → 不发起任何请求');

// (c) 单请求超时被夹在剩余预算内
const clampedFetch = mockFetch(successRoutes());
await fetchLivebench(null, { fetchText: clampedFetch, budgetMs: 2_000 });
const clampedTimeout = clampedFetch.requests[0] && clampedFetch.requests[0].opts.timeoutMs;
check(Number.isFinite(clampedTimeout) && clampedTimeout <= 2_000, `单请求超时被夹在剩余预算内（实际 ${clampedTimeout}ms）`);

// (d) 预算充足时不误伤正常抓取（慢但远小于预算）
const mildSlow = async (url) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const routes = successRoutes();
  if (!(url in routes)) throw new Error(`HTTP 404: ${url}`);
  return { text: routes[url], finalUrl: url, status: 200 };
};
const withinBudget = await fetchLivebench(null, { fetchText: mildSlow, budgetMs: 5_000 });
check(withinBudget.ok === true && withinBudget.data.rows.length === 3, '预算内正常成功（预算不误伤）');

// (e) bundle 候选脚本数上限 2：第 3 个脚本不再尝试（失败降级，不会无限抓）
const capHtml = '<html><head>'
  + '<script src="./static/js/a.js"></script>'
  + '<script src="./static/js/b.js"></script>'
  + '<script src="./static/js/main.test.js"></script>'
  + '</head></html>';
const capFetch = mockFetch({
  [LIVEBENCH_HOME]: capHtml,
  [`${LIVEBENCH_HOME}static/js/a.js`]: 'var a=1;',
  [`${LIVEBENCH_HOME}static/js/b.js`]: 'var b=1;',
  [BUNDLE_URL]: BUNDLE_TEXT,
});
const capResult = await fetchLivebench(null, { fetchText: capFetch });
check(capResult.ok === false, 'bundle 候选数上限 2：第 3 个脚本不再尝试（本次降级）');
expectEqual(capFetch.requests.filter((request) => request.url.endsWith('.js')).length, 2, 'bundle 最多尝试 2 个候选脚本');

// ---------------------------------------------------------------------------
// 9) 可选：真实端点冒烟（只打印结构摘要，不打印数据集）
// ---------------------------------------------------------------------------
if (LIVE) {
  console.log('\n[9] 真实端点冒烟（只打印结构摘要 + 耗时）');
  const t0 = Date.now();
  const liveResult = await fetchLivebench(null, { fetchText: pipelineFetchText, log: () => {} });
  const liveMs = Date.now() - t0;
  if (!liveResult.ok) {
    check(false, `真实抓取失败：${liveResult.error}`);
  } else {
    const liveData = liveResult.data;
    console.log(`  · generation=${liveData.generation} release=${liveData.release} rows=${liveData.rows.length} ranked=${liveData.ranked} categories=${liveData.categories.length} notes=${liveData.notes.length} ms=${liveMs}`);
    console.log(`  · source=${liveData.source.table}`);
    check(liveData.generation === 'v2' || liveData.generation === 'v1', 'live：generation 合法');
    check(liveData.rows.length > 0 && liveData.rows.every((row) => typeof row.overall === 'number' && row.rank >= 1), 'live：rows 结构与分数合法');
    check(liveData.categories.length >= 1 && liveData.categories.every((category) => typeof category.key === 'string' && category.weight > 0), 'live：categories 带 key/weight');
    check(/^\d{4}-\d{2}-\d{2}$/.test(liveData.release), 'live：release 为 ISO 日期');
    check(liveMs < 60_000, `live：耗时 < 60s（预算 45s，实际 ${liveMs}ms）`);
    check(liveResult.error !== 'budget', 'live：本次未触发时间预算降级');
  }
}

console.log(`\n断言 ${checks} 项，失败 ${failures} 项`);
if (failures > 0) {
  console.error('× validate-livebench 未通过');
  process.exitCode = 1;
} else {
  console.log('√ validate-livebench 全部通过');
}
