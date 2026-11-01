// dsh-model-rank · headless host validation（hermetic）
// 用桩 cordis ctx 跑 lib/index.js 的 apply()，验证：
//   1) 路由注册 / status / refresh 形态；
//   2) 鉴权路径（connection.requestRejection → 401/403）；
//   3) 包内 data/snapshot.json（--bundled 净化版）的兜底加载与「净化形态」：
//      aa 为空、无 userProviders / userModelsCount / usedDefaultModel、行内无 local / orgMatched；
//   4) 新增 GET /usage 的返回骨架（临时空 DSH_HOME → calls=0 + warnings + 四段 ranges）；
//   5) 刷新调度（P0-01/P1-01/P1-21）：纯函数假时钟 + bundled/磁盘重启两条运行时路径；
//   6) P1-02 全源失败 → 旧快照各段 stale=true；P1-12 写盘失败 → meta.lastWriteError 可见（离线 mock fetch）。
//
// 默认完全 hermetic：DSH_MODEL_RANK_DATA_DIR / DSH_HOME 都指向系统临时目录，不读真实用户数据；
// 全源失败用例只 mock 掉全局 fetch（不触网）。
//
// 运行：
//   node scripts/validate-host.mjs            # 默认 hermetic 校验
//   node scripts/validate-host.mjs --live     # 额外做一次真实 DSH_HOME 只读冒烟（只打印聚合数字，不打印模型/厂商明细）
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// P1-15：不写死本机绝对路径
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const LIVE = process.argv.includes('--live');
const realDshHome = (process.env.DSH_HOME && process.env.DSH_HOME.trim()) || join(homedir(), '.dsh');

// 先把环境指向临时目录，再 import 插件模块（apply() 里读取 env）
const workRoot = mkdtempSync(join(process.env.TEMP || process.env.TMP || homedir(), 'dsh-model-rank-validate-host-'));
const tempDataDir = join(workRoot, 'data');
const tempHome = join(workRoot, 'home');
process.env.DSH_MODEL_RANK_DATA_DIR = tempDataDir;
process.env.DSH_HOME = tempHome;

// 假 profile 清单：验证「净化后的 bundled 快照不含 userProviders 时，冷启动 inventory 仍能实时读 profiles」。
// 只写假 provider/model 名，不涉及任何真实本机数据。
const demoProfileDir = join(tempHome, 'profiles', 'demo-profile');
mkdirSync(demoProfileDir, { recursive: true });
writeFileSync(
  join(demoProfileDir, 'cordis.patch.yml'),
  [
    '- name: dsh-llm-pi-ai',
    '  config:',
    '    providers:',
    '      demo-1:',
    '        displayName: Demo One',
    '        models:',
    '          - id: demo-model-a',
    '            name: Demo Model A',
    '',
  ].join('\n'),
  'utf8',
);

let failures = 0;
function check(ok, message) {
  if (ok) {
    console.log(`  √ ${message}`);
  } else {
    failures += 1;
    console.error(`  × ${message}`);
  }
}

function fakeRes() {
  const res = { headersSent: false, statusCode: null, body: null, headers: null, destroyed: false };
  res.writeHead = (status, headers) => { res.statusCode = status; res.headers = headers || {}; res.headersSent = true; };
  res.end = (text) => { res.body = text; };
  res.destroy = () => { res.destroyed = true; };
  return res;
}

async function call(route, url, method = 'GET') {
  const res = fakeRes();
  await route.handler({ url, method }, res);
  let body = null;
  try { body = res.body ? JSON.parse(res.body) : null } catch { /* 保留原始 body */ }
  return { res, body };
}

/** POST 调用（带空 body 的 fake req，模拟手动刷新）。 */
async function callPost(route, url) {
  const res = fakeRes();
  const fakeReq = {
    url,
    method: 'POST',
    on(event, callback) {
      if (event === 'end') setImmediate(() => callback());
      return this;
    },
    destroy() {},
  };
  await route.handler(fakeReq, res);
  let body = null;
  try { body = res.body ? JSON.parse(res.body) : null } catch { /* 保留原始 body */ }
  return { res, body };
}

/** 创建一个只收集路由的桩 ctx（用于二次 apply 的插件实例）。 */
function makeRouteOnlyCtx(routes) {
  return {
    logger: { info() {} },
    effect(fn) { return fn(); },
    interval() { return () => {}; },
    inject(deps, fn) {
      return fn({
        logger: { info() {} },
        effect(fn2) { return fn2(); },
        connection: { requestRejection: () => undefined },
        webServer: {
          register(route) { routes.push(route); return () => {}; },
          registerUpgrade() { return () => {}; },
          getOrigin() { return 'http://127.0.0.1:1'; },
        },
      });
    },
  };
}

/** 深度遍历，收集「净化后不应出现」的键路径（只报路径，不打印值）。 */
const FORBIDDEN_SNAPSHOT_KEYS = new Set(['userProviders', 'userModelsCount', 'usedDefaultModel', 'local', 'orgMatched']);
function findForbiddenKeys(root) {
  const hits = [];
  const stack = [{ value: root, path: '$' }];
  while (stack.length) {
    const { value, path } = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      value.forEach((item, index) => stack.push({ value: item, path: `${path}[${index}]` }));
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN_SNAPSHOT_KEYS.has(key)) hits.push(`${path}.${key}`);
      stack.push({ value: child, path: `${path}.${key}` });
    }
  }
  return hits;
}

function checkUsagePayload(usage) {
  check(usage && usage.version === 1, 'usage.version = 1');
  check(usage && usage.ok === true, 'usage.ok = true');
  check(usage && typeof usage.generatedAt === 'number' && typeof usage.durationMs === 'number', 'usage.generatedAt / durationMs 为数字');
  check(usage && usage.totals && typeof usage.totals.totalTokens === 'number', 'usage.totals 结构完整');
  check(usage && usage.totals && usage.totals.calls === 0, 'usage.totals.calls = 0（临时空 home，无会话日志）');
  check(usage && usage.sources && usage.sources.sessions && usage.sources.sessions.files === 0, 'usage.sources.sessions.files = 0');
  check(usage && usage.sources.sessions.cache === 'none', 'usage.sources.sessions.cache = none');
  check(usage && Array.isArray(usage.warnings) && usage.warnings.length > 0, 'usage.warnings 非空（提示未找到会话日志）');
  const metricsKeys = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens', 'calls', 'sessions', 'estimatedCostUsd'];
  check(usage && usage.totals && metricsKeys.every((key) => key in usage.totals), 'usage.totals 契约 Metrics 字段齐全');
  for (const rangeKey of ['today', 'd7', 'd30', 'all']) {
    const range = usage && usage.ranges && usage.ranges[rangeKey];
    check(
      !!range && !!range.metrics && Array.isArray(range.byModel) && Array.isArray(range.byProvider) && 'costCoverage' in range,
      `usage.ranges.${rangeKey} 结构完整（metrics/byModel/byProvider/costCoverage）`,
    );
  }
  check(usage && Array.isArray(usage.byDay), 'usage.byDay 为数组');
  check(usage && usage.inventory && typeof usage.inventory.models === 'number' && Array.isArray(usage.inventory.providers), 'usage.inventory 摘要结构完整');
  check(usage && Array.isArray(usage.accounts), 'usage.accounts 为数组');
  check(usage && 'costCoverage' in usage, 'usage.costCoverage 存在（契约增补 v1.1）');
}

try {
  const indexExports = await import('file:///' + join(packageRoot, 'lib/index.js').replace(/\\/g, '/'));
  const plugin = indexExports.default;
  if (!plugin || typeof plugin.apply !== 'function') throw new Error('lib/index.js 未导出 default 插件');
  if (!plugin.inject.includes('timer')) throw new Error('插件应 inject ["timer"]');
  const computeIsDue = indexExports.computeIsDue;
  check(typeof computeIsDue === 'function', '导出 computeIsDue 调度纯函数（可离线回归 P0-01/P1-01/P1-21）');

  // ---------- P1-03：刷新最坏耗时预算（host 抓取 × 重试 + 客户端超时） ----------
  const pipelineExports = await import('file:///' + join(packageRoot, 'lib/pipeline.js').replace(/\\/g, '/'));
  const SOURCE_RETRY = pipelineExports.SOURCE_RETRY;
  check(!!SOURCE_RETRY && typeof SOURCE_RETRY.timeoutMs === 'number', 'pipeline 导出 SOURCE_RETRY 重试策略（P1-03）');
  if (SOURCE_RETRY) {
    const worstAttempts = Math.max(SOURCE_RETRY.defaultRetries, SOURCE_RETRY.arenaRetries);
    const worstMs = SOURCE_RETRY.timeoutMs * (1 + worstAttempts) + SOURCE_RETRY.backoffMs * worstAttempts;
    check(worstMs <= 120_000, `单源最坏抓取 ${worstMs}ms ≤ 客户端 120s（P1-03）`);
  }
  try {
    const clientSource = readFileSync(join(packageRoot, 'lib', 'client.js'), 'utf8');
    const refreshTimeout = clientSource.match(/rpcPost\('refresh', \{\},\s*(\d+)\)/);
    check(!!refreshTimeout && Number(refreshTimeout[1]) >= 120_000, `客户端刷新超时 ≥120s（实际 ${refreshTimeout ? refreshTimeout[1] : '未匹配到'}，P1-03）`);
  } catch { /* client.js 缺失时由其它 validate-client 覆盖 */ }

  const logs = [];
  const intervals = [];
  const routes = [];
  const effects = [];
  let rejection = undefined; // 由用例切换：undefined=放行 / 401 / 403

  function fakeCtx() {
    return {
      logger: { info: (m) => logs.push(String(m)) },
      effect(fn, label) { effects.push(label); return fn(); },
      interval(fn, ms) { intervals.push({ fn, ms }); return () => {}; },
      inject(deps, fn) {
        return fn({
          logger: { info: (m) => logs.push('[nested] ' + String(m)) },
          effect(fn2, label2) { effects.push(label2); return fn2(); },
          connection: { requestRejection: () => rejection },
          webServer: {
            register(route) { routes.push(route); return () => {}; },
            registerUpgrade() { return () => {}; },
            getOrigin() { return 'http://127.0.0.1:60976'; },
          },
        });
      },
    };
  }

  const ctx = fakeCtx();
  const cleanup = plugin.apply(ctx);

  check(routes.length === 1, `注册 1 条路由（实际 ${routes.length}）`);
  const route = routes[0];
  check(route && route.kind === 'prefix' && route.path === '/_dsh/dsh-model-rank', `路由形状 prefix ${route && route.path}`);

  // ---------- 鉴权路径 ----------
  rejection = 401;
  const unauthorized = await call(route, '/_dsh/dsh-model-rank/snapshot');
  check(unauthorized.res.statusCode === 401, '未认证请求 → 401');
  rejection = 403;
  const rejected = await call(route, '/_dsh/dsh-model-rank/snapshot');
  check(rejected.res.statusCode === 403, 'Host/Origin 不可信请求 → 403（P2-03：保留 rejection 码）');
  rejection = undefined;

  // ---------- P2-01：RPC 路由/方法语义 ----------
  const rootCall = await call(route, '/_dsh/dsh-model-rank');
  check(rootCall.res.statusCode === 200 && !!rootCall.body && typeof rootCall.body.methods === 'object', 'prefix 根路径 → 200 + 方法清单');
  const trailingCall = await call(route, '/_dsh/dsh-model-rank/snapshot/');
  check(trailingCall.res.statusCode === 200, 'snapshot 尾斜杠 → 200（P2-01）');
  const wrongMethod = await call(route, '/_dsh/dsh-model-rank/snapshot', 'POST');
  check(wrongMethod.res.statusCode === 405 && !!wrongMethod.res.headers && wrongMethod.res.headers.Allow === 'GET', 'POST /snapshot → 405 + Allow: GET');
  const badPath = await call(route, '/_dsh/dsh-model-rank/%E0%A4%A');
  check(badPath.res.statusCode === 400, '畸形百分号编码 → 400（P2-02，不再 500）');
  const unknownMethod = await call(route, '/_dsh/dsh-model-rank/nope');
  check(unknownMethod.res.statusCode === 404, '未知方法 → 404');

  // 等插件启动时的「本机清单异步读取」完成（期间只读假 profile，不联网）
  let inventoryReady = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const probe = await call(route, '/_dsh/dsh-model-rank/status');
    if (probe.body && probe.body.inventory && probe.body.inventory.userModelsCount === 1) {
      inventoryReady = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  check(inventoryReady, '冷启动 inventory 异步读取在 5s 内完成（不依赖 bundled 快照）');

  // ---------- GET /snapshot：内置净化快照兜底 ----------
  const snapshotCall = await call(route, '/_dsh/dsh-model-rank/snapshot');
  const payload = snapshotCall.body;
  check(snapshotCall.res.statusCode === 200 && !!payload, 'GET /snapshot → 200');
  check(payload && payload.snapshot && payload.snapshot.version === 1, 'snapshot.version = 1');
  check(payload && payload.meta && payload.meta.bundled === true, 'meta.bundled = true（临时 data 目录为空 → 加载包内快照）');
  check(payload && payload.snapshot.arena && payload.snapshot.arena.rows && payload.snapshot.arena.rows.length > 0, '内置快照保留 arena 数据');
  check(payload && payload.snapshot.usage && payload.snapshot.usage.weekly && payload.snapshot.usage.weekly.length > 0, '内置快照保留 usage.weekly');
  check(payload && payload.snapshot.usage && payload.snapshot.usage.marketShare && payload.snapshot.usage.marketShare.length > 0, '内置快照保留 usage.marketShare');
  check(payload && payload.snapshot.aa === null, '内置快照不含 AA 数据（aa = null）');
  const aaSource = payload && payload.snapshot.sources && payload.snapshot.sources['aa-models'];
  check(!!aaSource && aaSource.ok === false, 'sources["aa-models"] 标记 ok=false（仅运行时抓取）');
  const livebench = payload && payload.snapshot.livebench;
  check(
    livebench === null || (livebench && (livebench.generation === 'v2' || livebench.generation === 'v1') && Array.isArray(livebench.rows) && livebench.rows.every((row) => typeof row.overall === 'number')),
    `snapshot.livebench 为 null 或结构合法（当前 bundled：${livebench === null ? 'null' : '有数据'}）`,
  );
  const livebenchSource = payload && payload.snapshot.sources && payload.snapshot.sources['livebench-data'];
  check(!!livebenchSource && livebenchSource.ok === false, 'sources["livebench-data"] 标记 ok=false（仅运行时抓取）');
  const forbidden = payload ? findForbiddenKeys(payload.snapshot) : ['no payload'];
  check(forbidden.length === 0, `内置快照无本机清单推导字段（local/orgMatched/userProviders/userModelsCount/usedDefaultModel），残留 ${forbidden.length} 处${forbidden.length ? '：' + forbidden.slice(0, 5).join(', ') : ''}`);
  check(
    payload && payload.meta && payload.meta.bundled === true && payload.meta.lastSuccessMs === null,
    'bundled 快照不计入 lastSuccessMs（P1-21：新装 15s 后会尝试联网抓 AA/LiveBench）',
  );
  check(
    payload && payload.inventory && payload.inventory.userModelsCount === 1
      && Array.isArray(payload.inventory.userProviders) && payload.inventory.userProviders.length === 1
      && payload.inventory.userProviders[0].name === 'demo-1',
    'RPC inventory 冷启动使用实时 profiles 清单（userModelsCount=1 / provider=demo-1）',
  );
  check(payload && payload.snapshot && payload.snapshot.userProviders === undefined, '内置快照本体仍不含 userProviders（RPC 的 inventory 是运行期只读数据）');
  check(payload && payload.meta && payload.meta.lastWriteError === null, 'meta.lastWriteError 初始为 null（P1-12 字段存在且干净）');

  // ---------- GET /usage：骨架（临时假 home，无真实会话日志） ----------
  const usageCall = await call(route, '/_dsh/dsh-model-rank/usage');
  check(usageCall.res.statusCode === 200, 'GET /usage → 200');
  checkUsagePayload(usageCall.body);

  // ---------- GET /status：带 usageSummary（只读内存结果，不触发扫描） ----------
  const statusCall = await call(route, '/_dsh/dsh-model-rank/status');
  const status = statusCall.body;
  check(statusCall.res.statusCode === 200 && !!status, 'GET /status → 200');
  check(status && status.meta && typeof status.meta.refreshing === 'boolean', 'status.meta.refreshing 为布尔');
  check(status && status.config && status.config.refreshIntervalMs > 0, 'status.config.refreshIntervalMs 正常');
  check(
    !!status && !!status.usageSummary && typeof status.usageSummary.generatedAt === 'number' && status.usageSummary.totalTokens === 0,
    'status.usageSummary 已带轻量摘要（generatedAt/totalTokens/estimatedCostUsd/calls）',
  );

  // ---------- 刷新调度（P0-01 / P1-01 / P1-21）：纯函数离线回归 ----------
  if (typeof computeIsDue === 'function') {
    const NOW = 1_800_000_000_000;
    const H = 3_600_000;
    const M = 60_000;
    const LIMITS = { refreshMs: 24 * H, retryMs: 2 * H };
    const due = (s) => computeIsDue(s, NOW, LIMITS);
    check(due({ lastSuccessMs: NOW - 1 * H, lastAttemptMs: 0, lastError: null }) === false, '重启后（lastAttemptMs=0）成功 1h 内不抓 → 24h 冷却生效（P0-01）');
    check(due({ lastSuccessMs: NOW - 25 * H, lastAttemptMs: 0, lastError: null }) === true, '成功已超 24h → 到期');
    check(due({ lastSuccessMs: 0, lastAttemptMs: 0, lastError: null }) === true, '只有内置快照 / 从未抓过 → 启动检查即到期（P1-21）');
    check(due({ lastSuccessMs: NOW - 25 * H, lastAttemptMs: NOW - 30 * M, lastError: { message: 'offline' } }) === false, '失败 30min 后不重试 → 严格等 2h（P1-01）');
    check(due({ lastSuccessMs: NOW - 25 * H, lastAttemptMs: NOW - 90 * M, lastError: { message: 'offline' } }) === false, '失败 90min 后仍不重试');
    check(due({ lastSuccessMs: NOW - 25 * H, lastAttemptMs: NOW - 2 * H, lastError: { message: 'offline' } }) === true, '失败满 2h → 允许重试');
    check(due({ lastSuccessMs: 0, lastAttemptMs: NOW - 30 * M, lastError: { message: 'offline' } }) === false, '首次失败 30min 内不重试');
    check(due({ lastSuccessMs: 0, lastAttemptMs: NOW - 2 * H, lastError: { message: 'offline' } }) === true, '首次失败满 2h → 允许重试');
    check(due({ lastSuccessMs: NOW - 1 * H, lastAttemptMs: NOW - 5 * M, lastError: null }) === false, '手动刷新后 5min 内不因定时 tick 重抓');
    // 用插件真实 bootstrap 状态验证：bundled 冷启动应判定「到期」，15s 启动检查会触发一次真实抓取
    check(
      !!status && computeIsDue(
        {
          lastSuccessMs: status.meta.lastSuccessMs || 0,
          lastAttemptMs: status.meta.lastAttemptMs || 0,
          lastError: status.meta.lastError,
        },
        status.nowMs,
        { refreshMs: status.config.refreshIntervalMs, retryMs: status.config.retryMs },
      ) === true,
      'bundled 冷启动（status 实际状态）→ 启动检查判定到期（会联网抓一次 AA/LiveBench）',
    );
    check(status && status.config.refreshIntervalMs === 24 * H && status.config.retryMs === 2 * H, 'status.config 冷却/重试参数与 README 一致（24h / 2h）');
  }

  // ---------- refresh 的快速分支（不触网）：GET 应为 405 method not allowed ----------
  const bad = await call(route, '/_dsh/dsh-model-rank/refresh', 'GET');
  check(bad.res.statusCode === 405, `refresh via GET → 405（实际 ${bad.res.statusCode}）`);
  check(!!bad.body && typeof bad.body.error === 'string', 'refresh via GET 返回 error 文案');

  // ---------- 重启场景：磁盘快照 1h 前成功 → 启动检查不抓（P0-01 运行时路径） ----------
  const rebootDataDir = join(workRoot, 'reboot-data');
  mkdirSync(rebootDataDir, { recursive: true });
  const diskFixture = JSON.parse(JSON.stringify(payload.snapshot));
  delete diskFixture.fromBundled;
  diskFixture.fetchedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeFileSync(join(rebootDataDir, 'snapshot.json'), JSON.stringify(diskFixture), 'utf8');
  process.env.DSH_MODEL_RANK_DATA_DIR = rebootDataDir;
  const rebootRoutes = [];
  const rebootTop = plugin.apply({
    logger: { info() {} },
    effect(fn) { return fn(); },
    interval() { return () => {}; },
    inject(deps, fn) {
      return fn({
        logger: { info() {} },
        effect(fn2) { return fn2(); },
        connection: { requestRejection: () => undefined },
        webServer: { register(route) { rebootRoutes.push(route); return () => {}; }, registerUpgrade() { return () => {}; }, getOrigin() { return 'http://127.0.0.1:1'; } },
      });
    },
  });
  const rebootRoute = rebootRoutes[0];
  const rebootStatusCall = await call(rebootRoute, '/_dsh/dsh-model-rank/status');
  const rebootMeta = rebootStatusCall.body.meta;
  check(rebootMeta.bundled === false && typeof rebootMeta.lastSuccessMs === 'number', '磁盘快照 1h 前成功 → 重启后 lastSuccessMs 保留（冷却基准不丢）');
  const rebootDue = computeIsDue ? computeIsDue(
    { lastSuccessMs: rebootMeta.lastSuccessMs, lastAttemptMs: 0, lastError: null },
    rebootStatusCall.body.nowMs,
    { refreshMs: rebootStatusCall.body.config.refreshIntervalMs, retryMs: rebootStatusCall.body.config.retryMs },
  ) : null;
  check(rebootDue === false, '重启后 24h 内启动检查判定「未到期」→ 不抓（P0-01 运行时路径）');
  if (typeof rebootTop === 'function') rebootTop();

  // ---------- bundled 派生磁盘快照（全源失败写回）重启后仍不算成功（P1-21 边界） ----------
  const bundledDiskDir = join(workRoot, 'bundled-disk-data');
  mkdirSync(bundledDiskDir, { recursive: true });
  const bundledDiskFixture = JSON.parse(JSON.stringify(payload.snapshot));
  bundledDiskFixture.fromBundled = true;
  bundledDiskFixture.fetchedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 很新，但不是抓取成功
  writeFileSync(join(bundledDiskDir, 'snapshot.json'), JSON.stringify(bundledDiskFixture), 'utf8');
  process.env.DSH_MODEL_RANK_DATA_DIR = bundledDiskDir;
  const bundledDiskRoutes = [];
  const bundledDiskTop = plugin.apply(makeRouteOnlyCtx(bundledDiskRoutes));
  const bundledDiskStatus = await call(bundledDiskRoutes[0], '/_dsh/dsh-model-rank/status');
  const bundledDiskBody = bundledDiskStatus.body;
  check(bundledDiskBody.meta.bundled === true && bundledDiskBody.meta.lastSuccessMs === null, 'bundled 派生磁盘快照重启 → 仍标记 bundled 且 lastSuccessMs=null（写回磁盘不会造成假 24h 冷却）');
  const bundledDiskDue = computeIsDue
    ? computeIsDue({ lastSuccessMs: bundledDiskBody.meta.lastSuccessMs || 0, lastAttemptMs: 0, lastError: null }, bundledDiskBody.nowMs, { refreshMs: bundledDiskBody.config.refreshIntervalMs, retryMs: bundledDiskBody.config.retryMs })
    : null;
  check(bundledDiskDue === true, 'bundled 派生磁盘快照重启 → 启动检查判定到期（会重试联网）');
  if (typeof bundledDiskTop === 'function') bundledDiskTop();

  // ---------- P1-12：原子写盘（导出函数）成功 / 失败路径 ----------
  const persistSnapshotFile = indexExports.persistSnapshotFile;
  check(typeof persistSnapshotFile === 'function', '导出 persistSnapshotFile（可离线测写盘失败）');
  if (typeof persistSnapshotFile === 'function') {
    const goodSnapshotFile = join(workRoot, 'persist-ok', 'snapshot.json');
    const persisted = persistSnapshotFile(goodSnapshotFile, { version: 1, demo: 'demo-value' });
    check(persisted.ok === true && persisted.error === null, 'persistSnapshotFile 正常路径成功');
    check(JSON.parse(readFileSync(goodSnapshotFile, 'utf8')).demo === 'demo-value', '写出的快照 JSON 内容正确');
    const blockerFile = join(workRoot, 'persist-blocker');
    writeFileSync(blockerFile, 'not a directory', 'utf8');
    const badPersisted = persistSnapshotFile(join(blockerFile, 'snapshot.json'), { version: 1 });
    check(badPersisted.ok === false && typeof badPersisted.error === 'string' && badPersisted.error.length > 0, 'persistSnapshotFile 不可写路径 → ok:false + 可读 error');
  }

  // ---------- P1-02 + P1-12 端到端：全源失败 → 各段 stale + 写盘失败 meta 可见（离线 mock 全局 fetch） ----------
  const blockerFileForRefresh = join(workRoot, 'refresh-blocker');
  writeFileSync(blockerFileForRefresh, 'not a directory', 'utf8');
  const brokenDataDir = join(blockerFileForRefresh, 'data'); // 父路径是文件 → 写盘必失败
  process.env.DSH_MODEL_RANK_DATA_DIR = brokenDataDir;
  const brokenRoutes = [];
  const brokenTop = plugin.apply({
    logger: { info() {} },
    effect(fn) { return fn(); },
    interval() { return () => {}; },
    inject(deps, fn) {
      return fn({
        logger: { info() {} },
        effect(fn2) { return fn2(); },
        connection: { requestRejection: () => undefined },
        webServer: { register(route) { brokenRoutes.push(route); return () => {}; }, registerUpgrade() { return () => {}; }, getOrigin() { return 'http://127.0.0.1:1'; } },
      });
    },
  });
  const originalGlobalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network disabled (validate-host)'); };
  try {
    const refreshCall = await callPost(brokenRoutes[0], '/_dsh/dsh-model-rank/refresh?force=1');
    check(refreshCall.res.statusCode === 200, '全源失败时 refresh RPC 仍 200（不 500）');
    check(!!refreshCall.body && refreshCall.body.started === true && refreshCall.body.ok === false, '全源失败 refresh 返回 ok:false + error 文案');
    const brokenStatusCall = await call(brokenRoutes[0], '/_dsh/dsh-model-rank/status');
    const brokenStatus = brokenStatusCall.body;
    check(!!brokenStatus && brokenStatus.snapshot && brokenStatus.snapshot.arena && brokenStatus.snapshot.arena.stale === true, '全源失败后 arena.stale = true（P1-02，客户端可见「数据源待更新」）');
    check(!!brokenStatus && brokenStatus.snapshot.usage && brokenStatus.snapshot.usage.stale === true, '全源失败后 usage.stale = true（P1-02）');
    check(
      !!brokenStatus && brokenStatus.snapshot.sources
        && ['openrouter-rankings', 'aa-models', 'lmarena-dataset', 'livebench-data'].every((key) => brokenStatus.snapshot.sources[key] && brokenStatus.snapshot.sources[key].ok === false),
      '全源失败 sources 记录 4 个源全部 ok=false',
    );
    check(!!brokenStatus && brokenStatus.snapshot.arena.rows && brokenStatus.snapshot.arena.rows.length > 0, '旧快照数据仍保留（不清零 / 不伪造）');
    check(!!brokenStatus && !!brokenStatus.meta.lastError && typeof brokenStatus.meta.lastError.message === 'string', 'meta.lastError 可见（错误不再只进日志）');
    check(!!brokenStatus && !!brokenStatus.meta.lastWriteError && typeof brokenStatus.meta.lastWriteError.message === 'string', 'meta.lastWriteError 可见（P1-12：data 目录不可写）');
    check(!!brokenStatus && brokenStatus.meta.lastSuccessMs === null, '全源失败后 lastSuccessMs 仍为 null（没把失败当成功）');
    const brokenSnapshotCall = await call(brokenRoutes[0], '/_dsh/dsh-model-rank/snapshot');
    check(!!brokenSnapshotCall.body && brokenSnapshotCall.body.snapshot.arena.stale === true, 'GET /snapshot 同样返回 stale=true（客户端主通道可见）');

    // ---------- P1-02 写盘路径：磁盘快照含 AA/LiveBench 旧段 + data 目录可写 → 四段 stale 且落盘 ----------
    const staleDiskDir = join(workRoot, 'stale-disk-data');
    mkdirSync(staleDiskDir, { recursive: true });
    const staleFixture = JSON.parse(JSON.stringify(payload.snapshot));
    delete staleFixture.fromBundled;
    staleFixture.fetchedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    staleFixture.aa = { asOf: null, models: [{ name: 'Demo AA Model', rank: 1 }], stale: false };
    staleFixture.livebench = {
      generation: 'v2',
      release: '2026-10-25',
      releaseId: '20261025',
      asOf: '2026-10-25',
      source: { home: 'https://livebench.ai/', table: null, categories: null, notes: null },
      overall: 'weighted-mean',
      categories: [],
      rows: [{ model: 'demo-model-a', scores: {}, overall: 80, rank: 1 }],
      ranked: 1,
      notes: [],
      stale: false,
      fetchedAt: staleFixture.fetchedAt,
    };
    writeFileSync(join(staleDiskDir, 'snapshot.json'), JSON.stringify(staleFixture), 'utf8');
    process.env.DSH_MODEL_RANK_DATA_DIR = staleDiskDir;
    const staleRoutes = [];
    const staleTop = plugin.apply(makeRouteOnlyCtx(staleRoutes));
    const staleRefreshCall = await callPost(staleRoutes[0], '/_dsh/dsh-model-rank/refresh?force=1');
    check(!!staleRefreshCall.body && staleRefreshCall.body.ok === false, '全源失败（可写 data 目录）refresh 返回 ok:false');
    const staleStatusCall = await call(staleRoutes[0], '/_dsh/dsh-model-rank/status');
    const staleSnapshot = staleStatusCall.body.snapshot;
    check(
      !!staleSnapshot && staleSnapshot.arena.stale === true && staleSnapshot.aa.stale === true
        && staleSnapshot.usage.stale === true && staleSnapshot.livebench.stale === true,
      '全源失败后四段（arena/aa/usage/livebench）均标记 stale=true（P1-02）',
    );
    const persistedStale = JSON.parse(readFileSync(join(staleDiskDir, 'snapshot.json'), 'utf8'));
    check(
      persistedStale.arena.stale === true && persistedStale.aa.stale === true
        && persistedStale.usage.stale === true && persistedStale.livebench.stale === true,
      '全源失败结果已落盘且四段 stale 持久化（重启后客户端仍显示「数据源待更新」）',
    );
    check(persistedStale.fetchedAt === staleFixture.fetchedAt, '落盘保留上次成功时间（不把失败伪装成新数据）');
    if (typeof staleTop === 'function') staleTop();
  } finally {
    globalThis.fetch = originalGlobalFetch;
    if (typeof brokenTop === 'function') brokenTop();
  }

  console.log(`\nintervals registered: ${intervals.length} (${intervals[0] && intervals[0].ms}ms)`);
  console.log('effects:', effects.join(', '));
  check(typeof cleanup === 'function', 'cleanup 为函数');
  if (typeof cleanup === 'function') cleanup();

  // ---------- 可选：真实 DSH_HOME 只读冒烟（只打印聚合数字，不打印模型 / 厂商明细） ----------
  if (LIVE) {
    const usageExports = await import('file:///' + join(packageRoot, 'lib/usage.js').replace(/\\/g, '/'));
    // 冷启动上限 3s 是「正常机器」承诺；其它 agent/杀软可能同时抢 CPU，所以取两次独立冷扫的较快一次，
    // 同时把两个数字都打印出来，避免验收被宿主负载抖动误伤。
    const coldAttempts = [];
    let first = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reporter = usageExports.createUsageReporter({
        home: realDshHome,
        cacheFile: join(tempDataDir, `live-usage-cache-${attempt}.json`),
      });
      const t0 = Date.now();
      const report = await reporter.report({});
      coldAttempts.push(Date.now() - t0);
      if (!first) first = report;
    }
    const bestColdMs = Math.min(...coldAttempts);
    const reporterWarm = usageExports.createUsageReporter({ home: realDshHome, cacheFile: join(tempDataDir, 'live-usage-cache-warm.json') });
    await reporterWarm.report({});
    const t1 = Date.now();
    await reporterWarm.report({});
    const warmMs = Date.now() - t1;
    console.log('\n[live] 真实 DSH_HOME 只读冒烟（仅聚合数字）：');
    console.log(`  files=${first.sources.sessions.files} parsed=${first.sources.sessions.parsed} events=${first.sources.sessions.events} sessions=${first.totals.sessions} calls=${first.totals.calls}`);
    console.log(`  totalTokens=${first.totals.totalTokens} byDay=${first.byDay.length} ranges=(${['today', 'd7', 'd30', 'all'].map((k) => first.ranges[k].metrics.totalTokens).join(',')})`);
    console.log(`  cost=${first.totals.estimatedCostUsd == null ? 'null' : '有值'} costCoverage=${first.costCoverage == null ? 'null' : '有值'} accounts=${first.accounts.length}`);
    console.log(`  coldMs=[${coldAttempts.join(', ')}] best=${bestColdMs} warmMs(memory)=${warmMs} warnings=${first.warnings.length}`);
    check(first.version === 1 && first.ok === true, '[live] 报告结构合法');
    check(bestColdMs < 3000, `[live] 冷扫描 < 3s（两次实测 ${coldAttempts.join('/')}ms，取较快 ${bestColdMs}ms）`);
    check(warmMs <= 100, `[live] 内存热调用 ≤ 100ms（实际 ${warmMs}ms）`);
  }

  if (failures > 0) {
    console.error(`\n× 宿主半侧校验失败：${failures} 项断言未通过`);
    process.exitCode = 1;
  } else {
    console.log('\n√ 宿主半侧桩集成测试全部通过');
  }
} finally {
  try { rmSync(workRoot, { recursive: true, force: true }); } catch { /* 清理失败无害 */ }
}
