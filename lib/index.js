// dsh-model-rank · host half（cordis 插件，静态 bundle 形态）
// 职责：
//   1) 每日抓取一次公开榜单（OpenRouter rankings + Artificial Analysis models，均免 key），
//      汇成本机快照落盘 DSH_HOME/dsh-model-rank/snapshot.json；
//   2) 暴露 HTTP RPC（GET /_dsh/dsh-model-rank/<method>，宿主认证边界内），客户端只读快照，
//      打开面板零外部网络请求，秒开；
//   3) 提供手动"立即刷新"（带最小间隔节流，避免狂点打爆上游）。
// 依赖：inject ['timer']（ctx.interval）；嵌套注入 connection + webServer。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PLUGIN_NAME, DEFAULT_REFRESH_MS, DEFAULT_RETRY_MS, DEFAULT_MIN_GAP_MS,
  fetchSources, mergeSnapshots, readUserModelInventory, nowIso,
} from './pipeline.js'
import { createUsageReporter } from './usage.js'

// ---------- 路径与配置 ----------

function dshHomeDir() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : join(homedir(), '.dsh')
}

const BUNDLED_SNAPSHOT = () => fileURLToPath(new URL('../data/snapshot.json', import.meta.url))

function envNumber(name, fallback) {
  const raw = typeof process.env[name] === 'string' ? process.env[name].trim() : ''
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// ---------- 工具 ----------

function respond(res, status, body, extraHeaders) {
  const text = JSON.stringify(body)
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(extraHeaders || {}),
    });
  } catch {
    // headers 已发出 / 连接已断开：不再二次写响应
    try { res.destroy(); } catch { /* noop */ }
    return;
  }
  try { res.end(text); } catch { try { res.destroy(); } catch { /* noop */ } }
}

function readBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        // P2-04：先 pause 再走 413 响应，避免 destroy 导致客户端只看到连接重置
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        try { req.pause(); } catch { /* noop */ }
        return;
      }
      chunks.push(chunk);
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    })
    req.on('error', reject);
  })
}

function log(ctx, message) {
  try {
    if (ctx && ctx.logger && typeof ctx.logger.info === 'function') ctx.logger.info(`[${PLUGIN_NAME}] ${message}`);
    else console.info(`[${PLUGIN_NAME}] ${message}`);
  } catch { /* 日志失败无害 */ }
}

/**
 * 刷新调度纯函数（导出以便离线回归测试注入假时钟）。
 * 规则与 README 一致：
 *   - 失败后：严格等 RETRY_MS（默认 2h）再重试 —— 先于 24h 冷却判断，避免失败后每 30min 反复抓；
 *   - 有成功记录：距上次成功 ≥ REFRESH_MS（默认 24h）才到期 —— 重启后 lastAttemptMs 归零不会绕过冷却；
 *   - 从没成功过（含首次安装只有内置快照）：没有尝试记录 → 立即到期（启动检查时抓一次）；
 *     有过失败尝试则等 RETRY_MS。
 * @param {{lastSuccessMs?:number,lastAttemptMs?:number,lastError?:object|null}} state
 * @param {number} now 当前毫秒时间戳
 * @param {{refreshMs?:number,retryMs?:number}} limits
 * @returns {boolean}
 */
export function computeIsDue(state = {}, now = Date.now(), limits = {}) {
  const refreshMs = Number.isFinite(limits.refreshMs) ? limits.refreshMs : DEFAULT_REFRESH_MS;
  const retryMs = Number.isFinite(limits.retryMs) ? limits.retryMs : DEFAULT_RETRY_MS;
  const lastSuccessMs = Number.isFinite(state.lastSuccessMs) ? state.lastSuccessMs : 0;
  const lastAttemptMs = Number.isFinite(state.lastAttemptMs) ? state.lastAttemptMs : 0;
  const sinceSuccess = lastSuccessMs > 0 ? now - lastSuccessMs : Infinity;
  const sinceAttempt = lastAttemptMs > 0 ? now - lastAttemptMs : Infinity;
  if (state.lastError) return sinceAttempt >= retryMs;   // 失败退避优先（README：失败 2h 后重试）
  if (lastSuccessMs > 0) return sinceSuccess >= refreshMs; // 有成功：只看 24h 冷却（重启不清零）
  if (lastAttemptMs === 0) return true;                   // 从未抓过（含只有内置快照的首次启动）
  return sinceAttempt >= retryMs;
}

/**
 * 原子写快照文件（同目录 tmp + rename）。导出以便离线测试「写盘失败」路径。
 * @returns {{ ok:boolean, error:string|null, code?:string|null }}
 */
export function persistSnapshotFile(filePath, snapshot) {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(snapshot), 'utf8');
    renameSync(tmp, filePath);
    return { ok: true, error: null };
  } catch (err) {
    return {
      ok: false,
      error: String((err && err.message) || err),
      code: (err && err.code) || null,
    };
  }
}

// ---------- 插件 ----------

export default {
  inject: ['timer'],
  apply(ctx) {
    const dataDir = process.env.DSH_MODEL_RANK_DATA_DIR || join(dshHomeDir(), PLUGIN_NAME);
    const snapshotFile = join(dataDir, 'snapshot.json');

    const REFRESH_MS = envNumber('DSH_MODEL_RANK_REFRESH_MS', DEFAULT_REFRESH_MS);
    const RETRY_MS = envNumber('DSH_MODEL_RANK_RETRY_MS', DEFAULT_RETRY_MS);
    const MIN_GAP_MS = envNumber('DSH_MODEL_RANK_MIN_GAP_MS', DEFAULT_MIN_GAP_MS);
    const GUARD_INTERVAL_MS = Math.min(30 * 60 * 1000, RETRY_MS);

    const state = {
      snapshot: null,
      refreshing: false,
      lastAttemptMs: 0,
      lastSuccessMs: 0,
      lastError: null,
      lastWriteError: null,
      lastTrigger: null,
      // P2-33：force 刷新的绝对频率上限（防本机页面/扩展狂点绕过 MIN_GAP）
      forceAttempts: [],
    };
    const FORCE_LIMIT_PER_HOUR = 3;

    // ---------- 本机用量（lib/usage.js）：扫描 <DSH_HOME>/sessions 会话日志 ----------
    // 报告自带磁盘增量缓存（DSH_HOME/dsh-model-rank/usage-cache.json）+ 30s 内存 TTL；
    // 解析过程会分片让出事件循环，不阻塞快照刷新等宿主任务。
    const usageReporter = createUsageReporter({
      home: dshHomeDir(),
      cacheFile: join(dataDir, 'usage-cache.json'),
      log: (msg) => log(ctx, msg),
    });

    // 本机接入清单（用于用量表的模型/厂商展示名）：读 profiles/*/cordis.patch.yml，
    // 5 分钟 TTL + in-flight 复用；刷新成功时用新清单直接覆盖。读失败降级为空清单。
    const inventoryState = { at: 0, value: null, pending: null };
    const EMPTY_INVENTORY = { models: [], providers: [], default: null };
    async function resolveInventory() {
      const now = Date.now();
      if (inventoryState.value && now - inventoryState.at < 5 * 60_000) return inventoryState.value;
      if (inventoryState.pending) return inventoryState.pending;
      const pending = readUserModelInventory(dshHomeDir())
        .then((inv) => {
          const normalized = inv && typeof inv === 'object' ? inv : EMPTY_INVENTORY;
          inventoryState.value = normalized;
          inventoryState.at = Date.now();
          return normalized;
        })
        .catch(() => inventoryState.value || EMPTY_INVENTORY)
        .finally(() => {
          if (inventoryState.pending === pending) inventoryState.pending = null;
        });
      inventoryState.pending = pending;
      return pending;
    }

    // 启动即异步读取一次本机清单：净化后的 bundled 快照不含 userProviders，
    // 若只依赖快照，冷启动未联网时「本机接入清单」会显示为空（ui-usage 反馈）。
    resolveInventory().catch(() => { /* 读失败降级为空清单，不影响其它功能 */ });

    /**
     * RPC payload 里的本机接入清单：优先用实时读到的 profiles 清单（本地回环数据，不写回 bundled 文件），
     * 读不到时回退快照里的字段（磁盘快照 / 旧版本），再退化为空占位。
     */
    function inventoryPayload() {
      const live = inventoryState.value;
      if (live && Array.isArray(live.models) && live.models.length > 0) {
        return {
          userModelsCount: live.models.length,
          userProviders: Array.isArray(live.providers) ? live.providers : [],
          defaultModel: live.default || null,
        };
      }
      return {
        userModelsCount: state.snapshot?.userModelsCount ?? null,
        userProviders: state.snapshot?.userProviders ?? [],
        defaultModel: state.snapshot?.usedDefaultModel ?? null,
      };
    }

    // 快照读取：优先磁盘缓存，其次包内内置快照（保证首次启用就有数据可看）
    function loadSnapshotFromDisk() {
      try {
        if (existsSync(snapshotFile)) {
          const raw = readFileSync(snapshotFile, 'utf8');
          const parsed = JSON.parse(raw);
          if (parsed && parsed.version === 1) {
            // 由内置快照派生、又被「全源失败」写回磁盘的快照（fromBundled=true）仍然不算抓取成功，
            // 否则重启后会把包内快照时间当成 lastSuccess，首次联网可能被 24h 冷却拖住（与 P1-21 同源）。
            const fromBundled = parsed.fromBundled === true;
            state.snapshot = parsed;
            state.snapshot.fromBundled = fromBundled;
            if (!fromBundled) {
              const t = Date.parse(parsed.fetchedAt || '');
              if (Number.isFinite(t)) state.lastSuccessMs = t;
            }
            return;
          }
        }
      } catch (err) {
        try { console.warn(`[${PLUGIN_NAME}] 磁盘快照读取失败：${err.message}`) } catch { /* noop */ }
      }
      try {
        const bundledPath = BUNDLED_SNAPSHOT();
        if (existsSync(bundledPath)) {
          const parsed = JSON.parse(readFileSync(bundledPath, 'utf8'));
          if (parsed && parsed.version === 1) {
            state.snapshot = parsed;
            // P1-21：内置快照只用于「先有数据可看」，不算一次成功抓取 ——
            // 否则新装用户会因包内快照较新而 24h 不联网，AA/LiveBench 空态持续一天。
            // lastSuccessMs 保持 0（磁盘快照仍按其 fetchedAt 计冷却，重启不会绕过 24h）。
            state.lastSuccessMs = 0;
            state.snapshot.fromBundled = true;
          }
        }
      } catch (err) {
        try { console.warn(`[${PLUGIN_NAME}] 包内快照读取失败：${err.message}`) } catch { /* noop */ }
      }
    }

    /** 写盘并记录可见错误（P1-12：写盘失败不再静默，payload.meta.lastWriteError 可见）。 */
    function writeSnapshotToDisk(snapshot) {
      const result = persistSnapshotFile(snapshotFile, snapshot);
      if (result.ok) {
        state.lastWriteError = null;
        return true;
      }
      state.lastWriteError = { message: `快照写盘失败：${result.error}`, at: nowIso(), code: result.code };
      log(ctx, `${state.lastWriteError.message}（仅内存生效，重启后会回到旧快照）`);
      return false;
    }

    loadSnapshotFromDisk();

    // ---------- 刷新 ----------
    async function runRefresh({ force = false, trigger = 'schedule' } = {}) {
      if (state.refreshing) return { started: false, reason: 'busy' };
      const now = Date.now();
      if (!force && state.lastAttemptMs && now - state.lastAttemptMs < MIN_GAP_MS) {
        return { started: false, reason: 'throttled', retryAfterMs: MIN_GAP_MS - (now - state.lastAttemptMs) };
      }
      state.refreshing = true;
      state.lastAttemptMs = now;
      state.lastTrigger = trigger;

      try {
        const userInv = await readUserModelInventory(dshHomeDir());
        const fetched = await fetchSources({
          log: (msg) => log(ctx, msg),
          prev: state.snapshot, // LiveBench 版本发现失败时可用上次 releaseId 兜底
        });
        const merged = mergeSnapshots(state.snapshot, fetched, userInv);
        if (!fetched.aa && !fetched.openrouter) {
          // P1-02：全部数据源失败也合并一次 —— 各段 stale=true（客户端显示「数据源待更新」），
          // 旧数据与上次成功时间保留，不把旧快照当成新数据。
          if (state.snapshot && state.snapshot.fetchedAt) merged.fetchedAt = state.snapshot.fetchedAt;
          merged.fromBundled = state.snapshot ? state.snapshot.fromBundled === true : false;
          state.snapshot = merged;
          state.lastError = { message: '全部数据源抓取失败，已保留旧快照并标记「数据源待更新」', at: nowIso() };
          const persisted = writeSnapshotToDisk(merged);
          log(ctx, `刷新失败（${trigger}）：全部数据源不可用，已保留旧快照并标记 stale${persisted ? '' : '；写盘失败，仅内存生效'}`);
          return { started: true, ok: false, error: state.lastError.message, staleAll: true };
        }
        state.snapshot = merged;
        state.snapshot.fromBundled = false;
        state.lastSuccessMs = now;
        state.lastError = null;
        writeSnapshotToDisk(merged);
        // 价格/榜单/接入清单都变了：用量报告的内存缓存立即失效，并在下次调用时用新清单展示
        usageReporter.invalidate();
        inventoryState.value = userInv && typeof userInv === 'object' ? userInv : EMPTY_INVENTORY;
        inventoryState.at = Date.now();
        log(ctx, `快照刷新成功（${trigger}），AA ${merged.aa?.models?.length ?? 0} 个模型 · OpenRouter 周/月/份额 ${merged.usage?.weekly?.length ?? 0}/${merged.usage?.month?.length ?? 0}/${merged.usage?.marketShare?.length ?? 0} 行 · LiveBench ${merged.livebench ? `${merged.livebench.release} ${merged.livebench.rows?.length ?? 0} 行` : '无数据'}`);
        return { started: true, ok: true };
      } catch (err) {
        state.lastError = { message: String((err && err.message) || err), at: nowIso() };
        log(ctx, `刷新失败：${state.lastError.message}`);
        return { started: true, ok: false, error: state.lastError.message };
      } finally {
        state.refreshing = false;
      }
    }

    function isDue() {
      if (state.refreshing) return false;
      return computeIsDue(state, Date.now(), { refreshMs: REFRESH_MS, retryMs: RETRY_MS });
    }

    // 启动后延迟一会儿「检查是否到期」再抓（避开宿主启动高峰）：
    // 磁盘快照 24h 内不重复抓；只有内置快照（从未成功抓取）时这里会触发首次联网。
    const initialTimer = setTimeout(() => {
      if (!isDue()) return;
      runRefresh({ force: false, trigger: '启动检查' }).catch(() => { /* 状态已记录 */ });
    }, 15_000);
    if (initialTimer && typeof initialTimer.unref === 'function') initialTimer.unref();

    ctx.interval(() => {
      if (state.refreshing) return;
      if (!isDue()) return;
      runRefresh({ force: false, trigger: '定时' }).catch(() => { /* 状态已记录 */ });
    }, GUARD_INTERVAL_MS);

    // ---------- HTTP RPC ----------
    const ROUTE_PREFIX = `/_dsh/${PLUGIN_NAME}`;

    ctx.inject(['connection', 'webServer'], function (webCtx) {
      webCtx.effect(function () {
        const dispose = webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: async function (req, res) {
            let method = '';
            try {
              const rejection = webCtx.connection.requestRejection(req);
              if (rejection !== undefined) {
                // P2-03：保留宿主 rejection 码语义（401=未认证，403=Host/Origin 不可信）
                respond(res, rejection === 401 ? 401 : 403, { error: rejection === 401 ? 'authentication required' : 'forbidden' });
                return;
              }
              const url = new URL(req.url || '/', 'http://localhost');
              const path = url.pathname;
              if (path === ROUTE_PREFIX || path === ROUTE_PREFIX + '/') {
                // P2-01：根路径返回方法清单（此前 404，/snapshot/ 之类尾斜杠也不友好）
                respond(res, 200, { plugin: PLUGIN_NAME, methods: { snapshot: 'GET', status: 'GET', usage: 'GET', refresh: 'POST' } });
                return;
              }
              if (!path.startsWith(ROUTE_PREFIX + '/')) {
                respond(res, 404, { error: 'not found' });
                return;
              }
              try {
                method = decodeURIComponent(path.slice(ROUTE_PREFIX.length + 1)).replace(/\/+$/, '');
              } catch {
                // P2-02：畸形百分号编码是 400，不是 500
                respond(res, 400, { error: 'bad request path' });
                return;
              }
              const allowedMethod = { snapshot: 'GET', status: 'GET', usage: 'GET', refresh: 'POST' }[method];
              if (allowedMethod && req.method !== allowedMethod) {
                // P2-01：方法不匹配返回 405 + Allow，而不是 "404 unknown method"
                respond(res, 405, { error: `method not allowed: ${method} requires ${allowedMethod}` }, { Allow: allowedMethod });
                return;
              }

              if (method === 'snapshot') {
                respond(res, 200, payload('snapshot'));
                return;
              }
              if (method === 'usage') {
                // 本机用量：会话日志扫描（带磁盘增量缓存 + 内存 TTL），内部异常一律降级为空报告，恒 200
                const inventory = await resolveInventory();
                const force = url.searchParams.get('force') === '1';
                const report = await usageReporter.report({ snapshot: state.snapshot, inventory, force });
                respond(res, 200, report);
                return;
              }
              if (method === 'status') {
                respond(res, 200, payload('status'));
                return;
              }
              if (method === 'refresh') {
                let args = {};
                try { args = await readBody(req); } catch (err) {
                  respond(res, err.status || 400, { error: err.message });
                  return;
                }
                const force = args.force === true || url.searchParams.get('force') === '1';
                // 普通手动点击 force=false：仍受 10 分钟最小间距约束；
                // P2-33：force=true 可越过节流，但每小时最多 3 次，防本机页面/扩展狂点打上游。
                if (force) {
                  const now = Date.now();
                  state.forceAttempts = state.forceAttempts.filter((at) => now - at < 3_600_000);
                  if (state.forceAttempts.length >= FORCE_LIMIT_PER_HOUR) {
                    respond(res, 200, {
                      started: false,
                      ok: false,
                      reason: 'force-limited',
                      retryAfterMs: Math.max(1000, 3_600_000 - (now - state.forceAttempts[0])),
                      snapshot: payload('snapshot'),
                    });
                    return;
                  }
                  state.forceAttempts.push(now);
                }
                const result = await runRefresh({ force, trigger: '手动' });
                respond(res, 200, { ...result, snapshot: payload('snapshot') });
                return;
              }
              respond(res, 404, { error: 'unknown method: ' + method });
            } catch (err) {
              if (res.headersSent) {
                res.destroy(err);
                return;
              }
              const status = (err && err.status) || 500;
              if (status === 500) {
                try {
                  console.warn(`[${PLUGIN_NAME}] RPC ${method || 'unknown'} failed: ${(err && err.stack) || err}`);
                } catch { /* noop */ }
              }
              respond(res, status, { error: status === 500 ? 'internal error' : String((err && err.message) || err) });
            }
          },
        });
        return function () {
          try { dispose(); } catch { /* noop */ }
        };
      }, 'dsh-model-rank: web routes');
    });

    function payload(kind) {
      const now = Date.now();
      return {
        kind,
        nowMs: now,
        config: { refreshIntervalMs: REFRESH_MS, retryMs: RETRY_MS, minGapMs: MIN_GAP_MS },
        meta: {
          refreshing: state.refreshing,
          lastAttemptMs: state.lastAttemptMs || null,
          lastSuccessMs: state.lastSuccessMs || null,
          lastError: state.lastError,
          // P1-12：快照写盘失败可见（成功路径不设置；成功写盘后自动清空）
          lastWriteError: state.lastWriteError,
          lastTrigger: state.lastTrigger,
          sourceInfo: state.snapshot ? state.snapshot.sources : null,
          usageAsOf: state.snapshot?.usage?.asOf || null,
          bundled: state.snapshot?.fromBundled === true,
        },
        // 用量摘要（契约增补 v1.1）：只读已构建过的内存结果，不会触发会话扫描；未请求过 /usage 时为 null
        usageSummary: usageReporter.summary(),
        inventory: inventoryPayload(),
        snapshot: state.snapshot,
      };
    }

    // ---------- 生命周期 ----------
    return function () {
      try { clearTimeout(initialTimer); } catch { /* noop */ }
      // ctx.interval / ctx.effect 注册的句柄随插件 fiber 自动清理
    };
  },
};
