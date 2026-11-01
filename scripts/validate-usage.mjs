// dsh-model-rank · scripts/validate-usage.mjs
// 用 TEMP 下的假 DSH_HOME 验证 lib/usage.js 的完整行为（可重复运行、默认完全不碰真实用户数据）：
//   - 聚合正确：今日 / 近 7 天 / 近 30 天 / 全部 的 token、调用数、会话数、按日分桶；
//   - 去重正确：同一 sid::turn:step 的 chunk(临时) + message(权威) 只算一次且取 message 值；
//   - provider/model 归属：message.source 优先，缺失时回退 request/header、request/context；
//   - 多帧 zstd：一个会话日志由 3 个独立 frame 拼接（含末尾未写完的半帧）仍能完整解析；
//   - 增量缓存：第二次 warm 不重解析；追加写入后只重解析变化的文件、不重复计费；
//   - 容错：坏 zstd 文件只计入 failed 不影响其它、坏 JSON 行跳过、缓存损坏自动重建、目录缺失返回空态；
//   - 契约字段齐全（v1 + 增补 costCoverage）：Metrics / ModelBucket / ProviderBucket / byDay / accounts / inventory；
//   - 快照 join：AA 价格 → 估算费用与 aa 字段、OpenRouter 周榜、Arena 名次、本机清单展示名；
//   - 账户文件：只读 <DSH_HOME>/dsh-usage/provider-snapshots.json。
//
// 运行：
//   node scripts/validate-usage.mjs            # 默认：TEMP 假数据
//   node scripts/validate-usage.mjs --live     # 额外对真实 DSH_HOME 做只读冒烟（只打印聚合数字，不打印模型/provider 明细）
//
// 退出码：0 = 全部断言通过；1 = 有断言失败。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import zlib from 'node:zlib'

import {
  CACHE_VERSION, SCAN_BUDGET_MS, USAGE_VERSION,
  createUsageReporter, decodeSessionZstd, parseSessionText, scanZstdFrames,
} from '../lib/usage.js'

const LIVE = process.argv.includes('--live');
const realDshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh');

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-11-01T10:00:00.000Z'); // Asia/Shanghai 2026-11-01 18:00
const METRIC_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'calls', 'sessions', 'estimatedCostUsd'];
const MODEL_KEYS = ['model', 'display', 'provider', 'providers', 'share', 'localRank', 'aa', 'globalWeekly', 'arenaRank', ...METRIC_KEYS];
const PROVIDER_KEYS = ['provider', 'display', 'share', 'models', ...METRIC_KEYS];

let failures = 0;
let checks = 0;
function check(ok, message) {
  checks += 1;
  if (ok) {
    console.log(`  √ ${message}`);
  } else {
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

// ---------------------------------------------------------------------------
// 假会话日志构造
// ---------------------------------------------------------------------------

const line = (obj) => JSON.stringify(obj);
const evHeader = (provider, model, time) => line({ type: 'request/header', seq: 1, time, data: { header: { config: { provider, model } }, reason: 'request' } });
const evContext = (provider, model, time) => line({ type: 'request/context', seq: 2, time, data: { provider, model, contextWindow: 128000 } });
const evMessage = ({ seq = 10, time, turn, step, provider, model, usage }) => line({
  type: 'assistant/message',
  seq,
  time,
  data: {
    turn,
    step,
    usage,
    message: provider || model ? { source: { kind: 'model', provider: provider || undefined, model: model || undefined } } : {},
  },
});
const evChunk = ({ seq = 11, time, turn, step, usage }) => line({
  type: 'assistant/chunk',
  seq,
  time,
  data: { turn, step, chunk: { type: 'usage', usage } },
});

/** 多帧 zstd 容器：每个字符串压缩成独立 frame 再拼接（模拟 DSH append-only 日志）。 */
function zstdContainer(texts) {
  const frames = texts.map((text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8')));
  return Buffer.concat(frames);
}

function writeFile(filePath, content) {
  mkdirSync(join(filePath, '..'), { recursive: true });
  writeFileSync(filePath, content);
}

// 会话 A（未压缩 jsonl，sid=aaaa）：验证去重、回退归属、坏行跳过、多代日志取最高代
const A_TODAY = NOW - 3 * 3_600_000;
const sessionAText = [
  evHeader('demo-1', 'demo-model-a', A_TODAY),
  evChunk({ time: A_TODAY, turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 5 } }),
  evMessage({ time: A_TODAY, turn: 1, step: 1, provider: 'demo-1', model: 'demo-model-a', usage: { inputTokens: 120, outputTokens: 12, cacheReadTokens: 1100, cacheWriteTokens: 6 } }),
  'this line is intentionally not JSON',
  evHeader('demo-2', 'demo-model-b', A_TODAY + 1_000),
  evMessage({ time: A_TODAY + 1_000, turn: 2, step: 1, usage: { inputTokens: 200, outputTokens: 20 } }),
  evMessage({ time: A_TODAY + 2_000, turn: 2, step: 2, provider: 'demo-1', model: 'demo-model-a', usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 10 } }),
  evChunk({ time: A_TODAY + 3_000, turn: 9, step: 1, usage: { inputTokens: 7, outputTokens: 3 } }),
  '',
].join('\n');

// 更早的一代日志（session.v3.jsonl）：必须被 session.v4 取代，绝不能重复计费
const sessionAStaleText = [
  evHeader('demo-1', 'demo-model-a', A_TODAY),
  evMessage({ time: A_TODAY, turn: 1, step: 1, provider: 'demo-1', model: 'demo-model-a', usage: { inputTokens: 999_999, outputTokens: 999_999 } }),
].join('\n');

// 会话 B（多帧 zstd，sid=bbbb）：三个独立 frame 分别落在 1 / 3 / 8 天前
const D1 = NOW - DAY_MS;
const D3 = NOW - 3 * DAY_MS;
const D8 = NOW - 8 * DAY_MS;
const sessionBFrames = [
  [evHeader('demo-3', 'demo-model-c', D1), evMessage({ time: D1, turn: 1, step: 1, usage: { inputTokens: 300, outputTokens: 30 } })].join('\n') + '\n',
  [evContext('demo-4', 'demo-model-d', D3), evMessage({ time: D3, turn: 2, step: 1, usage: { inputTokens: 400, outputTokens: 40, cacheReadTokens: 5 } })].join('\n') + '\n',
  [
    evChunk({ time: D8, turn: 3, step: 1, usage: { inputTokens: 777, outputTokens: 77 } }),
    evMessage({ time: D8, turn: 3, step: 1, provider: 'demo-2', model: 'demo-model-b', usage: { inputTokens: 500, outputTokens: 50 } }),
  ].join('\n') + '\n',
];
const completeZstd = zstdContainer(sessionBFrames);
// 再拼一个「写到一半」的 frame 尾巴：解析器应自然忽略半帧、仍解出前 3 帧
const truncatedFrame = zlib.zstdCompressSync(Buffer.from('tail-frame-not-finished\n')).subarray(0, 12);
const sessionBBuffer = Buffer.concat([completeZstd, truncatedFrame]);

// 假快照 / 假清单 / 假账户文件
function fakeSnapshot() {
  return {
    version: 1,
    fetchedAt: '2026-11-01T00:00:00.000Z',
    sources: {},
    arena: { asOf: '2026-10-28', totalModels: 30, stale: false, rows: [{ rank: 3, model: 'demo-model-c', orgKey: 'demo', rating: 1200 }] },
    aa: {
      asOf: null,
      stale: false,
      models: [{
        rank: 1,
        slug: 'demo/model-a',
        name: 'Demo Model A',
        provider: 'Demo',
        intelligence: 42.1,
        price: { input: 1, output: 2, cacheHit: 0.5, blended31: 1.1, blended21: 1.6, blended11: 2.1 },
        speed: { tokensPerSec: 100, ttftMs: 300 },
        benchmarks: {},
      }],
    },
    usage: {
      asOf: 'Oct 31, 2026',
      stale: false,
      weekly: [{ rank: 5, model: 'Demo Model B', slug: 'demo/model-b', tokens: { label: '1.2T', value: 1.2e12 }, authorDisplay: 'Demo Inc' }],
      today: [], month: [], trending: [], marketShare: [],
    },
  };
}
function fakeInventory() {
  return {
    models: [{ provider: 'demo-1', providerDisplay: 'Demo One', id: 'demo-model-a', name: 'Demo A Local' }],
    providers: [
      { name: 'demo-1', display: 'Demo One', models: [{ id: 'demo-model-a', name: 'Demo A Local' }] },
      { name: 'demo-2', display: 'Demo Two', models: [{ id: 'demo-model-b', name: 'Demo B Local' }] },
    ],
    default: { provider: 'demo-1', model: 'demo-model-a' },
  };
}
function fakeProviderSnapshots() {
  return {
    version: 1,
    providers: {
      'demo-1': {
        provider: 'demo-1',
        displayName: 'Demo One',
        credential: 'env',
        balance: { currency: 'CNY', totalBalance: '96.20', updatedAt: NOW },
      },
      'demo-2': {
        provider: 'demo-2',
        displayName: 'Demo Two',
        credential: 'none',
        plan: { windows: [{ key: '5h', percent: 61, resetsAt: '2026-11-01T10:12:30.000Z' }, { key: 'week', percent: 24, resetsAt: '2026-11-02T00:00:00.000Z' }], updatedAt: NOW },
      },
      'empty-provider': { provider: 'empty-provider', displayName: 'Empty', credential: 'none' },
    },
  };
}

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

function assertMetricsShape(metrics, label, { allowNullCost = true } = {}) {
  check(!!metrics && typeof metrics === 'object', `${label} 存在`);
  const missing = METRIC_KEYS.filter((key) => !(key in (metrics || {})));
  check(missing.length === 0, `${label} Metrics 字段齐全${missing.length ? '（缺 ' + missing.join(',') + '）' : ''}`);
  const numericKeys = METRIC_KEYS.filter((key) => key !== 'estimatedCostUsd');
  const badNumeric = numericKeys.filter((key) => typeof metrics[key] !== 'number' || metrics[key] < 0);
  check(badNumeric.length === 0, `${label} token/calls/sessions 均为非负数字${badNumeric.length ? '（异常 ' + badNumeric.join(',') + '）' : ''}`);
  check(
    metrics.totalTokens === metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens + metrics.outputTokens,
    `${label} totalTokens = input + cacheRead + cacheWrite + output`,
  );
  check(allowNullCost ? (metrics.estimatedCostUsd === null || typeof metrics.estimatedCostUsd === 'number') : typeof metrics.estimatedCostUsd === 'number', `${label} estimatedCostUsd 类型合法`);
}

function assertModelBucket(bucket, label) {
  const missing = MODEL_KEYS.filter((key) => !(key in (bucket || {})));
  check(missing.length === 0, `${label} ModelBucket 字段齐全${missing.length ? '（缺 ' + missing.join(',') + '）' : ''}`);
  check(Array.isArray(bucket.providers), `${label} providers 为数组`);
  check(bucket.share >= 0 && bucket.share <= 1, `${label} share ∈ [0,1]`);
  check(Number.isInteger(bucket.localRank) && bucket.localRank >= 1, `${label} localRank 为 ≥1 整数`);
  check(bucket.aa === null || (bucket.aa && typeof bucket.aa.name === 'string' && 'intelligence' in bucket.aa), `${label} aa 为 null 或合法子结构`);
  check(bucket.globalWeekly === null || (bucket.globalWeekly && 'rank' in bucket.globalWeekly), `${label} globalWeekly 为 null 或合法子结构`);
  check(bucket.arenaRank === null || Number.isInteger(bucket.arenaRank), `${label} arenaRank 为 null 或整数`);
}

function assertProviderBucket(bucket, label) {
  const missing = PROVIDER_KEYS.filter((key) => !(key in (bucket || {})));
  check(missing.length === 0, `${label} ProviderBucket 字段齐全${missing.length ? '（缺 ' + missing.join(',') + '）' : ''}`);
  check(Number.isInteger(bucket.models) && bucket.models >= 0, `${label} models 为非负整数`);
}

function assertRangePayload(range, label) {
  check(!!range && !!range.metrics && Array.isArray(range.byModel) && Array.isArray(range.byProvider), `${label} 三段结构存在`);
  assertMetricsShape(range.metrics, `${label}.metrics`);
  check(range.byModel.every((bucket, index) => bucket.localRank === index + 1), `${label} byModel 按量降序且 localRank 连续`);
  check(range.byModel.every((bucket, index) => index === 0 || bucket.totalTokens <= range.byModel[index - 1].totalTokens), `${label} byModel 按 totalTokens 降序`);
  check(range.costCoverage === null || (range.costCoverage >= 0 && range.costCoverage <= 1), `${label} costCoverage ∈ [0,1] 或 null`);
  if (range.byModel.length) assertModelBucket(range.byModel[0], `${label}.byModel[0]`);
  if (range.byProvider.length) assertProviderBucket(range.byProvider[0], `${label}.byProvider[0]`);
}

function assertUsageReport(report) {
  check(!!report && report.version === USAGE_VERSION, `报告 version = ${USAGE_VERSION}`);
  check(report && report.ok === true, '报告 ok = true');
  check(report && typeof report.generatedAt === 'number' && typeof report.durationMs === 'number', 'generatedAt / durationMs 为数字');
  check(report && report.sources && report.sources.sessions && typeof report.sources.sessions.dir === 'string', 'sources.sessions.dir 存在');
  check(report && report.sources && report.sources.accounts && typeof report.sources.accounts.available === 'boolean', 'sources.accounts.available 存在');
  assertMetricsShape(report.totals, 'totals');
  for (const rangeKey of ['today', 'd7', 'd30', 'all']) assertRangePayload(report.ranges[rangeKey], `ranges.${rangeKey}`);
  check(Array.isArray(report.byDay) && report.byDay.length <= 180, 'byDay 为 ≤180 条数组');
  check(report.byDay.every((day, index) => index === 0 || day.day > report.byDay[index - 1].day), 'byDay 日期严格升序');
  for (const day of report.byDay) assertMetricsShape(day, `byDay[${day.day}]`);
  check(Array.isArray(report.accounts), 'accounts 为数组');
  check(!!report.inventory && typeof report.inventory.models === 'number' && Array.isArray(report.inventory.providers), 'inventory 摘要结构完整');
  check(Array.isArray(report.warnings), 'warnings 为数组');
  check('costCoverage' in report && (report.costCoverage === null || (report.costCoverage >= 0 && report.costCoverage <= 1)), 'costCoverage ∈ [0,1] 或 null（契约增补 v1.1）');
  check(JSON.stringify(report.totals) === JSON.stringify(report.ranges.all.metrics), 'totals 与 ranges.all.metrics 一致');
  const sharedSum = report.ranges.all.byModel.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
  check(sharedSum === report.totals.totalTokens, 'byModel token 合计 = totals.totalTokens');
  check(report.ranges.all.byModel.reduce((sum, bucket) => sum + bucket.calls, 0) === report.totals.calls, 'byModel 调用数合计 = totals.calls');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

const workRoot = mkdtempSync(join(tmpdir(), 'dsh-model-rank-validate-usage-'));
const hostRoot = join(workRoot, 'home');
const sessionsDir = join(hostRoot, 'sessions');
const cacheFile = join(hostRoot, 'dsh-model-rank', 'usage-cache.json');
const snapshotsFile = join(hostRoot, 'dsh-usage', 'provider-snapshots.json');
const workspaceDir = join(sessionsDir, '--demo-workspace--');
const sessionADir = join(workspaceDir, 'session-aaaa');
const sessionBDir = join(workspaceDir, 'session-bbbb');
const sessionBadDir = join(workspaceDir, 'session-cccc-bad');

function createFakeHome() {
  writeFile(join(sessionADir, 'session.v4.jsonl'), sessionAText);
  writeFile(join(sessionADir, 'session.v3.jsonl'), sessionAStaleText); // 旧代日志：必须被忽略
  writeFile(join(sessionBDir, 'session.v1.jsonl.zstd'), sessionBBuffer);
  writeFile(join(sessionBadDir, 'session.v9.jsonl.zstd'), Buffer.from('this is definitely not a zstd container'));
  mkdirSync(join(hostRoot, 'dsh-usage'), { recursive: true });
  writeFileSync(snapshotsFile, JSON.stringify(fakeProviderSnapshots()), 'utf8');
  return createUsageReporter({ home: hostRoot, cacheFile, now: () => NOW });
}

let reporter = null;
try {
  // ---------- 单元级：zstd 多帧解码 / 事件去重 ----------
  console.log('\n[1] zstd 多帧解码与事件去重（单元级）');
  const decoded = decodeSessionZstd(sessionBBuffer);
  check(typeof decoded === 'string' && decoded.includes('demo-model-c') && decoded.includes('demo-model-b'), '多帧 zstd 容器解出全部 3 帧文本（忽略末尾半帧）');
  const frames = scanZstdFrames(sessionBBuffer);
  expectEqual(frames.length, 3, 'scanZstdFrames 识别出 3 个完整 frame');
  const dedupeEvents = parseSessionText([
    evChunk({ time: NOW, turn: 4, step: 2, usage: { inputTokens: 1, outputTokens: 1 } }),
    evMessage({ time: NOW, turn: 4, step: 2, provider: 'demo-1', model: 'demo-model-a', usage: { inputTokens: 50, outputTokens: 5 } }),
  ].join('\n'), 'sid-dedupe', NOW);
  expectEqual(dedupeEvents.length, 1, 'chunk + message 同 sid::turn:step 只保留 1 条');
  expectEqual(dedupeEvents[0] && dedupeEvents[0].i, 50, '去重后取 message 权威 inputTokens');
  expectEqual(dedupeEvents[0] && dedupeEvents[0].sid, 'sid-dedupe', '事件带 sid');
  check(typeof SCAN_BUDGET_MS === 'number' && SCAN_BUDGET_MS > 0, 'SCAN_BUDGET_MS 已导出（扫描时间预算）');

  // ---------- 冷启动全量聚合 ----------
  console.log('\n[2] 冷启动聚合（假 DSH_HOME：1 个 jsonl + 1 个多帧 zstd + 1 个坏文件）');
  reporter = createFakeHome();
  const snapshot = fakeSnapshot();
  const inventory = fakeInventory();
  const tCold = Date.now();
  const cold = await reporter.report({ snapshot, inventory });
  const coldWallMs = Date.now() - tCold;
  assertUsageReport(cold);
  console.log(`  · 冷启动耗时 ${coldWallMs}ms（durationMs=${cold.durationMs}）`);

  expectEqual(cold.sources.sessions.files, 3, 'sources.sessions.files = 3（3 个会话目录）');
  expectEqual(cold.sources.sessions.parsed, 2, 'sources.sessions.parsed = 2（2 个可用文件）');
  expectEqual(cold.sources.sessions.reparsed, 3, 'sources.sessions.reparsed = 3（首次全部解析，含坏文件）');
  expectEqual(cold.sources.sessions.failed, 1, 'sources.sessions.failed = 1（坏 zstd 文件）');
  expectEqual(cold.sources.sessions.skipped, 0, 'sources.sessions.skipped = 0（当前运行时支持 zstd）');
  expectEqual(cold.sources.sessions.events, 7, 'sources.sessions.events = 7（去重后事件数）');
  expectEqual(cold.sources.sessions.cache, 'cold', '首次 cache = cold');
  check(cold.warnings.some((warning) => warning.includes('解析失败')), 'warnings 提示坏文件已跳过');
  check(coldWallMs < 3000, `冷启动 < 3s（实际 ${coldWallMs}ms）`);

  expectEqual(cold.totals.calls, 7, 'totals.calls = 7');
  expectEqual(cold.totals.sessions, 2, 'totals.sessions = 2');
  expectEqual(cold.totals.inputTokens, 1577, 'totals.inputTokens = 1577');
  expectEqual(cold.totals.outputTokens, 160, 'totals.outputTokens = 160');
  expectEqual(cold.totals.cacheReadTokens, 1115, 'totals.cacheReadTokens = 1115');
  expectEqual(cold.totals.cacheWriteTokens, 6, 'totals.cacheWriteTokens = 6');
  expectEqual(cold.totals.totalTokens, 2858, 'totals.totalTokens = 2858（旧代日志未重复计费）');
  expectEqual(cold.totals.reasoningTokens, 0, 'totals.reasoningTokens = 0（缺省 0）');

  expectEqual(cold.ranges.today.metrics.totalTokens, 1533, 'today.totalTokens = 1533');
  expectEqual(cold.ranges.today.metrics.calls, 4, 'today.calls = 4');
  expectEqual(cold.ranges.today.metrics.sessions, 1, 'today.sessions = 1');
  expectEqual(cold.ranges.d7.metrics.totalTokens, 2308, 'd7.totalTokens = 1533 + 330 + 445 = 2308');
  expectEqual(cold.ranges.d7.metrics.calls, 6, 'd7.calls = 6');
  expectEqual(cold.ranges.d7.metrics.sessions, 2, 'd7.sessions = 2');
  expectEqual(cold.ranges.d30.metrics.totalTokens, 2858, 'd30.totalTokens = 2858');
  expectEqual(cold.ranges.d30.metrics.sessions, 2, 'd30.sessions = 2');
  expectEqual(cold.ranges.all.metrics.totalTokens, 2858, 'all.totalTokens = 2858');

  // byDay：含今天、连续 9 天（-8…0）、零填充
  expectEqual(cold.byDay.length, 9, 'byDay 连续 9 天（-8…今天，补零）');
  const dayTotals = new Map(cold.byDay.map((day) => [day.day, day.totalTokens]));
  expectEqual(dayTotals.get('2026-11-01'), 1533, 'byDay[今天] totalTokens = 1533');
  expectEqual(dayTotals.get('2026-10-31'), 330, 'byDay[昨天] totalTokens = 330');
  expectEqual(dayTotals.get('2026-10-29'), 445, 'byDay[-3d] totalTokens = 445');
  expectEqual(dayTotals.get('2026-10-24'), 550, 'byDay[-8d] totalTokens = 550');
  expectEqual(dayTotals.get('2026-10-30'), 0, 'byDay 无事件的自然日补 0');
  expectEqual(cold.byDay.reduce((sum, day) => sum + day.totalTokens, 0), 2858, 'byDay token 合计 = totals.totalTokens');
  expectEqual(cold.byDay.reduce((sum, day) => sum + day.calls, 0), 7, 'byDay 调用数合计 = totals.calls');

  // ---------- 快照 join：AA 价格 / 周榜 / Arena / 展示名 / 估算费用 ----------
  console.log('\n[3] 快照 join 与费用估算');
  const byModel = cold.ranges.all.byModel;
  expectEqual(byModel.length, 4, 'all.byModel 共 4 个模型');
  const modelA = byModel.find((bucket) => bucket.model === 'demo-model-a');
  const modelB = byModel.find((bucket) => bucket.model === 'demo-model-b');
  const modelC = byModel.find((bucket) => bucket.model === 'demo-model-c');
  const modelD = byModel.find((bucket) => bucket.model === 'demo-model-d');
  check(!!modelA && !!modelB && !!modelC && !!modelD, '四个假模型都出现在 byModel');
  expectEqual(modelA && modelA.totalTokens, 1313, 'model-a totalTokens = 1313（chunk 临时值未重复计）');
  expectEqual(modelA && modelA.calls, 3, 'model-a calls = 3');
  expectEqual(modelA && modelA.sessions, 1, 'model-a sessions = 1');
  expectEqual(modelA && modelA.localRank, 1, 'model-a localRank = 1');
  expectEqual(modelA && modelA.display, 'Demo A Local', 'display 优先用本机清单 name');
  expectEqual(modelA && modelA.provider, 'demo-1', 'model-a 主 provider = demo-1');
  expectEqual(modelB && modelB.totalTokens, 770, 'model-b totalTokens = 220 + 550 = 770');
  expectEqual(modelB && modelB.sessions, 2, 'model-b 跨 2 个会话');
  expectEqual(modelD && modelD.totalTokens, 445, 'model-d totalTokens = 445（context 回退归属）');
  expectEqual(modelC && modelC.arenaRank, 3, 'model-c 匹配 Arena 名次 = 3');
  check(!!modelB && !!modelB.globalWeekly && modelB.globalWeekly.rank === 5 && modelB.globalWeekly.tokensLabel === '1.2T' && modelB.globalWeekly.authorDisplay === 'Demo Inc', 'model-b 匹配 OpenRouter 周榜行（rank/tokensLabel/authorDisplay）');
  check(!!modelA && !!modelA.aa && modelA.aa.slug === 'demo/model-a' && modelA.aa.intelligence === 42.1, 'model-a 匹配 AA 行（slug/intelligence）');
  check(!!modelA && !!modelA.aa && !!modelA.aa.price && modelA.aa.price.input === 1 && modelA.aa.price.output === 2 && modelA.aa.price.cacheHit === 0.5, 'model-a aa.price = {input:1,output:2,cacheHit:0.5}');
  expectEqual(modelA && modelA.aa && modelA.aa.blended31, 1.1, 'model-a aa.blended31 = 1.1');
  check(!!modelD && modelD.aa === null && modelD.globalWeekly === null && modelD.arenaRank === null, '未匹配模型 aa/globalWeekly/arenaRank 均为 null');
  expectEqual(modelD && modelD.estimatedCostUsd, null, '不可定价模型 estimatedCostUsd = null（不伪造 0）');
  // 费用：(177*1 + 1110*0.5 + 6*1 + 20*2)/1e6 = 0.000778 → 保留 4 位 = 0.0008
  expectClose(modelA && modelA.estimatedCostUsd, 0.0008, 1e-9, 'model-a 估算费用 = 0.0008 USD（按 AA 价格公式）');
  expectClose(cold.totals.estimatedCostUsd, 0.0008, 1e-9, 'totals.estimatedCostUsd 只累计已定价模型');
  expectClose(cold.costCoverage, 0.4594, 0.0002, 'costCoverage = 已定价 token 占比 0.4594');
  expectClose(cold.ranges.today.costCoverage, 0.8565, 0.0002, 'today.costCoverage = 1313/1533 = 0.8565');

  // byProvider
  const byProvider = cold.ranges.all.byProvider;
  check(byProvider.map((bucket) => bucket.provider).join(',') === 'demo-1,demo-2,demo-4,demo-3', 'byProvider 按 token 降序');
  const providerOne = byProvider.find((bucket) => bucket.provider === 'demo-1');
  expectEqual(providerOne && providerOne.totalTokens, 1313, 'provider demo-1 totalTokens = 1313');
  expectEqual(providerOne && providerOne.display, 'Demo One', 'provider display 优先用清单 display');
  expectEqual(providerOne && providerOne.models, 1, 'provider demo-1 覆盖 1 个模型');
  expectClose(cold.ranges.all.byModel.reduce((sum, bucket) => sum + bucket.share, 0), 1, 0.01, 'byModel share 合计 ≈ 1');

  // inventory 摘要 / accounts
  expectEqual(cold.inventory.models, 1, 'inventory.models = 1');
  check(cold.inventory.providers.join(',') === 'demo-1,demo-2', 'inventory.providers = [demo-1, demo-2]');
  expectEqual(cold.sources.accounts.available, true, 'sources.accounts.available = true');
  expectEqual(cold.accounts.length, 2, 'accounts 只保留有余额或套餐的账户（空账户被过滤）');
  const accountOne = cold.accounts.find((account) => account.provider === 'demo-1');
  const accountTwo = cold.accounts.find((account) => account.provider === 'demo-2');
  check(!!accountOne && accountOne.balance && accountOne.balance.currency === 'CNY' && accountOne.balance.total === 96.2, '账户余额映射正确（CNY 96.20）');
  check(!!accountTwo && Array.isArray(accountTwo.plan) && accountTwo.plan.length === 2 && accountTwo.plan[0].key === '5h' && accountTwo.plan[0].percent === 61, '套餐窗口映射正确（key/percent/resetsAt）');

  // 缓存文件结构
  const diskCache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  expectEqual(diskCache.version, CACHE_VERSION, '磁盘缓存 version = CACHE_VERSION');
  expectEqual(diskCache.sessionsDir, sessionsDir, '磁盘缓存记录 sessionsDir');
  expectEqual(Object.keys(diskCache.files).length, 3, '磁盘缓存包含 3 个文件条目（含失败条目）');
  const failedEntry = Object.entries(diskCache.files).find(([filePath]) => filePath.includes('session-cccc-bad'));
  check(!!failedEntry && failedEntry[1].ok === false, '失败文件在缓存里标记 ok=false（不重复解析）');

  // ---------- 内存命中 ----------
  console.log('\n[4] 内存缓存 TTL 命中');
  const tWarm = Date.now();
  const memoryHit = await reporter.report({ snapshot, inventory });
  const memoryHitMs = Date.now() - tWarm;
  expectEqual(memoryHit.sources.sessions.reparsed, 0, '内存命中 reparsed = 0（未重新解析）');
  expectEqual(memoryHit.sources.sessions.events, 7, '内存命中的数据与冷启动一致');
  expectEqual(memoryHit.totals.totalTokens, 2858, '内存命中 totals 一致');
  expectEqual(memoryHit.sources.sessions.cache, 'warm', '内存命中 cache = warm');
  check(memoryHitMs <= 100, `内存命中 ≤ 100ms（实际 ${memoryHitMs}ms）`);

  // ---------- 磁盘增量缓存 warm ----------
  console.log('\n[5] 磁盘增量缓存 warm（绕过内存，模拟隔 30s 后的新调用）');
  const tDiskWarm = Date.now();
  const diskWarm = await reporter.report({ snapshot, inventory, force: true });
  const diskWarmMs = Date.now() - tDiskWarm;
  expectEqual(diskWarm.sources.sessions.cache, 'warm', '磁盘缓存命中 cache = warm');
  expectEqual(diskWarm.sources.sessions.reparsed, 0, '磁盘缓存命中 reparsed = 0');
  expectEqual(diskWarm.sources.sessions.parsed, 2, '磁盘缓存命中 parsed = 2');
  expectEqual(diskWarm.totals.totalTokens, 2858, '磁盘缓存命中 totals 一致');
  check(diskWarmMs <= 100, `磁盘缓存 warm 调用 ≤ 100ms（实际 ${diskWarmMs}ms）`);

  // ---------- 增量：追加写入只重解析变化的文件 ----------
  console.log('\n[6] 增量缓存：追加事件后只重解析变化文件、不重复计费');
  const appendedEvent = evMessage({ time: NOW - 1_800_000, turn: 20, step: 1, provider: 'demo-2', model: 'demo-model-b', usage: { inputTokens: 1000, outputTokens: 100 } });
  writeFileSync(join(sessionADir, 'session.v4.jsonl'), sessionAText + '\n' + appendedEvent + '\n');
  const afterAppend = await reporter.report({ snapshot, inventory, force: true });
  expectEqual(afterAppend.sources.sessions.reparsed, 1, '追加后只重解析 1 个变化文件');
  expectEqual(afterAppend.sources.sessions.events, 8, '追加后事件数 = 8');
  expectEqual(afterAppend.totals.totalTokens, 3958, '追加后 totals.totalTokens = 2858 + 1100');
  expectEqual(afterAppend.totals.calls, 8, '追加后 calls = 8');
  expectEqual(afterAppend.ranges.today.metrics.totalTokens, 2633, '追加后 today.totalTokens = 1533 + 1100');
  expectEqual(afterAppend.ranges.all.byModel.find((bucket) => bucket.model === 'demo-model-b').totalTokens, 1870, '追加后 model-b totalTokens = 770 + 1100');
  // 旧缓存里 7 条事件被完整替换为 8 条（不是 15 条）：不重复计费的关键断言
  expectEqual(afterAppend.sources.sessions.events - 7, 1, '事件数只增加新增的 1 条（无重复计费）');

  // ---------- 删除会话文件后缓存裁剪 ----------
  console.log('\n[7] 删除会话文件：缓存裁剪且不再计入');
  rmSync(sessionBDir, { recursive: true, force: true });
  const afterDelete = await reporter.report({ snapshot, inventory, force: true });
  expectEqual(afterDelete.sources.sessions.files, 2, '删除后 files = 2');
  expectEqual(afterDelete.totals.totalTokens, 2633, '删除后 totals.totalTokens = 3958 - 1325');
  expectEqual(afterDelete.totals.calls, 5, '删除后 calls = 5');
  expectEqual(afterDelete.totals.sessions, 1, '删除后 sessions = 1');
  const prunedCache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  expectEqual(Object.keys(prunedCache.files).length, 2, '缓存已裁剪为 2 个文件条目');

  // ---------- 坏缓存自动重建 ----------
  console.log('\n[8] 坏缓存容错：自动丢弃重扫');
  writeFileSync(cacheFile, '{ this is not a valid cache json', 'utf8');
  const afterBadCache = await reporter.report({ snapshot, inventory, force: true });
  check(afterBadCache.warnings.some((warning) => warning.includes('缓存损坏')), 'warnings 提示磁盘缓存损坏已重建');
  expectEqual(afterBadCache.totals.totalTokens, 2633, '坏缓存重建后数据仍正确');
  expectEqual(afterBadCache.sources.sessions.cache, 'cold', '坏缓存重建时 cache = cold');
  const rebuiltCache = JSON.parse(readFileSync(cacheFile, 'utf8'));
  expectEqual(rebuiltCache.version, CACHE_VERSION, '坏缓存已被合法缓存替换');

  // ---------- 缺目录 / 空状态 ----------
  console.log('\n[9] 目录缺失容错：空状态且结构完整');
  const emptyHome = join(workRoot, 'empty-home');
  mkdirSync(emptyHome, { recursive: true });
  const emptyReporter = createUsageReporter({ home: emptyHome, cacheFile: join(emptyHome, 'usage-cache.json'), now: () => NOW });
  const empty = await emptyReporter.report({ snapshot, inventory });
  assertUsageReport(empty);
  expectEqual(empty.totals.calls, 0, '空 home：calls = 0');
  expectEqual(empty.sources.sessions.files, 0, '空 home：files = 0');
  expectEqual(empty.sources.sessions.cache, 'none', '空 home：cache = none');
  expectEqual(empty.byDay.length, 0, '空 home：byDay = []');
  expectEqual(empty.accounts.length, 0, '空 home：accounts = []');
  expectEqual(empty.sources.accounts.available, false, '空 home：accounts.available = false');
  check(empty.warnings.length > 0, '空 home：warnings 提示未找到会话日志');
  expectEqual(empty.totals.estimatedCostUsd, null, '空 home：estimatedCostUsd = null');
  expectEqual(empty.costCoverage, null, '空 home：costCoverage = null');

  // ---------- 扫描超预算：部分结果 + degraded warning ----------
  console.log('\n[10] 扫描时间预算：超预算时返回部分结果并给出 degraded 提示');
  const degradedReporter = createUsageReporter({
    home: hostRoot,
    cacheFile: join(workRoot, 'degraded', 'usage-cache.json'),
    now: () => NOW,
    scanBudgetMs: -1, // 强制每次「需要重解析」都判定超预算
  });
  const degraded = await degradedReporter.report({ snapshot, inventory });
  assertUsageReport(degraded);
  expectEqual(degraded.sources.sessions.events, 0, '超预算：本次不纳入任何重解析文件的事件');
  check(degraded.warnings.some((warning) => warning.includes('部分结果')), '超预算：warnings 标明「本次为部分结果」');
  expectEqual(degraded.totals.calls, 0, '超预算：降级后结构完整、数值为 0');

  // ---------- 不可读内部异常不抛出 ----------
  console.log('\n[11] 非法 DSH_HOME：报告器不抛出、返回合法空报告');
  const brokenReporter = createUsageReporter({ home: '\u0000invalid-path', cacheFile: join(workRoot, 'broken', 'cache.json'), now: () => NOW });
  const broken = await brokenReporter.report({});
  assertUsageReport(broken);
  expectEqual(broken.totals.calls, 0, '非法 home：calls = 0');

  // ---------- 可选：真实 DSH_HOME 只读冒烟 ----------
  if (LIVE) {
    console.log('\n[12] 真实 DSH_HOME 只读冒烟（仅聚合数字，不打印模型/provider 明细）');
    // 冷启动 3s 是「正常机器」承诺；宿主/其它进程抢 CPU 时取两次独立冷扫的较快一次（两个数字都打印）。
    const liveColdAttempts = [];
    let liveCold = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reporter = createUsageReporter({ home: realDshHome, cacheFile: join(workRoot, 'live', `usage-cache-${attempt}.json`) });
      const started = Date.now();
      const report = await reporter.report({});
      liveColdAttempts.push(Date.now() - started);
      if (!liveCold) liveCold = report;
    }
    const bestLiveColdMs = Math.min(...liveColdAttempts);
    const liveWarmReporter = createUsageReporter({ home: realDshHome, cacheFile: join(workRoot, 'live', 'usage-cache-warm.json') });
    await liveWarmReporter.report({});
    const t1 = Date.now();
    await liveWarmReporter.report({});
    const liveWarmMs = Date.now() - t1;
    assertUsageReport(liveCold);
    console.log(`  · files=${liveCold.sources.sessions.files} parsed=${liveCold.sources.sessions.parsed} events=${liveCold.sources.sessions.events} sessions=${liveCold.totals.sessions} calls=${liveCold.totals.calls}`);
    console.log(`  · totalTokens=${liveCold.totals.totalTokens} byDay=${liveCold.byDay.length} ranges=(${['today', 'd7', 'd30', 'all'].map((key) => liveCold.ranges[key].metrics.totalTokens).join(',')})`);
    console.log(`  · cost=${liveCold.totals.estimatedCostUsd == null ? 'null' : '有值'} coverage=${liveCold.costCoverage == null ? 'null' : '有值'} accounts=${liveCold.accounts.length} warnings=${liveCold.warnings.length}`);
    console.log(`  · coldMs=[${liveColdAttempts.join(', ')}] best=${bestLiveColdMs} warmMs=${liveWarmMs}`);
    check(bestLiveColdMs < 3000, `[live] 冷启动 < 3s（两次实测 ${liveColdAttempts.join('/')}ms，取较快 ${bestLiveColdMs}ms）`);
    check(liveWarmMs <= 100, `[live] 热调用 ≤ 100ms（实际 ${liveWarmMs}ms）`);
  }

  console.log(`\n断言 ${checks} 项，失败 ${failures} 项`);
  if (failures > 0) {
    console.error('× validate-usage 未通过');
    process.exitCode = 1;
  } else {
    console.log('√ validate-usage 全部通过');
  }
} catch (err) {
  failures += 1;
  console.error('× validate-usage 执行异常：', (err && err.stack) || err);
  process.exitCode = 1;
} finally {
  try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* 清理失败无害 */ }
}
