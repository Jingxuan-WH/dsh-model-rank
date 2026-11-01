// dsh-model-rank · usage.js
// 本机模型用量聚合管线（纯 Node 内置模块，无第三方运行时依赖）。
// 职责：扫描 <DSH_HOME>/sessions 下的会话日志，抽取计费 usage 事件，按 Asia/Shanghai
// 自然日 / provider / model 聚合，产出 .team/API-CONTRACT.md 约定的 v1 报告。
//
// 对齐 DSH 会话持久化格式的三个关键点：
//   1) session*.jsonl.zstd 是「多帧拼接」容器（每次 append 一批日志就是一个独立 zstd frame），
//      Node 的 zlib.zstdDecompressSync 一次只能解一帧 —— 必须先按帧结构切片、再逐帧解压；
//      运行时缺少 zstd 能力（Node < 22.15 等）时跳过 .zstd 文件并给 warning，不报错。
//   2) 用量事件：request/header、request/context 提供 provider·model 回退归属；
//      assistant/chunk(type=usage) 是流式临时值；assistant/message.usage 是权威值。
//      去重键 = `sid::turn:step`：同键 message 覆盖 chunk，只计一次。
//   3) append-only 文件 + 体积可能到 MB 级：磁盘增量缓存按「文件 size+mtime 指纹」只重解析变化文件，
//      内存结果 TTL 30s；缓存损坏/版本不符直接丢弃重扫，绝不因此报错。
//
// 健壮性约定：目录缺失、文件被占用、坏帧、坏缓存等一律降级成 warnings + 已拿到的数据，
// 调用方（host 的 GET /usage 路由）永远能拿到结构完整的 200 响应。
//
// 本模块不 import 任何 DSH 包；只借 pipeline.js 的 normalizeKey 做快照 join（AA 价格 / OpenRouter 周榜 / Arena 名次）。

'use strict';

import zlib from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { normalizeKey, aliasKeys } from './pipeline.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** RPC 契约版本（响应顶层 version）。 */
export const USAGE_VERSION = 1;
/** 磁盘缓存自建格式版本；改动缓存结构时 +1，旧缓存会被丢弃重扫。 */
export const CACHE_VERSION = 1;
/** 宿主内存缓存 TTL：30s 内的重复调用直接复用上一次报告。 */
export const MEMORY_TTL_MS = 30_000;
/** byDay 最多 180 条（超出截断最早），byModel / byProvider 的条数上限。 */
export const BY_DAY_LIMIT = 180;
export const BY_MODEL_LIMIT = 80;
export const BY_PROVIDER_LIMIT = 40;
/**
 * 单次扫描的时间预算：超过后本次只返回「已解析部分 + 未变化文件缓存」并在 warnings 标注部分结果。
 * 用于极端情况（首次启用 + 大量历史会话 + 慢盘）兜底，避免 RPC / 宿主事件循环被长时间占用。
 */
export const SCAN_BUDGET_MS = 5_000;

const DAY_MS = 86_400_000;
// Asia/Shanghai 无夏令时，固定 UTC+8；用「+8h 后取 UTC 日期」比 Intl.DateTimeFormat 快一个数量级。
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
// zstd frame magic：0xFD2FB528（字节序 28 B5 2F FD）按 UInt32LE 读。
const ZSTD_MAGIC = 4247762216;
const SESSION_FILE_RE = /^session(\.v(\d+))?\.jsonl(\.zstd)?$/;
const MAX_SESSION_DEPTH = 8;
const UNKNOWN_MODEL = '(unknown)';
const UNKNOWN_PROVIDER = '(unknown)';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function numeric(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function tokenNumber(value) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function round(value, digits) {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function shortError(err) {
  const text = String((err && err.message) || err || 'unknown');
  return text.length > 160 ? text.slice(0, 160) + '…' : text;
}

/** 让出事件循环：大文件解析之间穿插，避免长时间独占宿主线程阻塞快照刷新等其它任务。 */
function yieldToHost() {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 毫秒时间戳 → 本机时区（Asia/Shanghai）自然日 'YYYY-MM-DD'；非法值返回 null。 */
export function toDayKey(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  return new Date(n + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' 自然日加减；只做日标签运算（Asia/Shanghai 无 DST，按 UTC 解析安全）。 */
export function addDaysKey(dayKey, delta) {
  const t = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(t)) return dayKey;
  return new Date(t + delta * DAY_MS).toISOString().slice(0, 10);
}

/** 当前运行时是否具备 zstd 解压能力（Node ≥ 22.15 / 24 有 zlib.zstdDecompressSync）。 */
export function canDecodeZstd() {
  return typeof zlib.zstdDecompressSync === 'function';
}

function lastSlugSegment(slug) {
  const s = String(slug || '');
  return s.includes('/') ? s.slice(s.lastIndexOf('/') + 1) : s;
}

/**
 * 一个 provider 侧 model id → 一组归一化匹配键（去 provider 前缀、去 :free 渠道后缀、去日期版本）。
 * 与 pipeline.aliasKeys 完全同一套口径（AA/OpenRouter/Arena/LiveBench/本机清单共用），保留此导出名供测试与复用。
 */
export const modelKeys = aliasKeys;

// ---------------------------------------------------------------------------
// zstd 多帧解码（对齐 DSH 会话持久化：每个 append 批 = 一个独立 frame）
// ---------------------------------------------------------------------------

/**
 * 在不真正解压的前提下，按 zstd 帧结构扫描出每个完整 frame 的 [start, end) 字节区间。
 * 文件末尾未写完的半帧会被自然丢弃（返回已完整的帧），因此解析结果是「某个一致快照」。
 */
export function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) break; // reserved bits 置位 → 非合法帧
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let lastBlockSeen = false;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) break; // reserved block type → 帧损坏
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break; // 数据块还没写全
      offset += payloadBytes;
      if (lastBlock) {
        lastBlockSeen = true;
        break;
      }
    }
    // 没读到 last block = 文件末尾是「正在写入的半帧」：丢弃该帧，保留前面完整的帧（解析结果仍是一致快照）
    if (!lastBlockSeen) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

/**
 * 解压「多帧拼接」的 zstd 会话日志为完整 UTF-8 文本。
 * 任一帧解压失败 / 无 zstd 能力 / 没有完整帧时返回 null（调用方当作该文件无数据）。
 */
export function decodeSessionZstd(buffer) {
  if (!canDecodeZstd()) return null;
  const frames = scanZstdFrames(buffer);
  if (!frames.length) return null;
  const parts = [];
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8'));
    } catch {
      return null;
    }
  }
  return parts.join('');
}

// ---------------------------------------------------------------------------
// 事件解析与去重
// ---------------------------------------------------------------------------

function turnStepKey(sid, data, ev) {
  if (data && data.turn !== undefined && data.step !== undefined) {
    return `${sid}::${data.turn}:${data.step}`;
  }
  // 极少数事件没有 turn/step：退化为 seq 级唯一键，避免互相覆盖。
  return `${sid}::msg:${ev && ev.seq !== undefined ? ev.seq : 'na'}`;
}

function makeUsageEvent(ev, sid, time, source) {
  const data = (ev && ev.data) || {};
  const usage = data.usage || (data.chunk && data.chunk.usage) || {};
  return {
    t: time,                                                     // 事件时间（ms）
    sid: sid || '',                                              // 会话 id（目录名去掉 session- 前缀）
    p: source && source.provider ? String(source.provider) : '', // provider
    m: source && source.model ? String(source.model) : '',       // model
    i: tokenNumber(usage.inputTokens),                           // 未缓存输入
    o: tokenNumber(usage.outputTokens),                          // 输出（含推理输出）
    r: tokenNumber(usage.cacheReadTokens),                       // 缓存读
    w: tokenNumber(usage.cacheWriteTokens),                      // 缓存写
    z: tokenNumber(usage.reasoningTokens),                       // 推理输出（单独统计，不计入 total）
  };
}

/**
 * 解析一个会话文件的完整文本 → 去重后的 usage 事件列表（紧凑字段，见 makeUsageEvent）。
 * 规则（与 DSH 会话日志语义一致）：
 *   - request/header.data.header.config.{provider,model}、request/context.data.{provider,model}
 *     更新该会话的归属回退值；
 *   - assistant/chunk.data.chunk.type === 'usage'：临时值，同键已存在时不覆盖；
 *   - assistant/message.data.usage：权威值，同键直接覆盖（临时值不再重复计）。
 * fallbackTime 用于个别缺少 time 的事件（取上一条事件时间，最终回退到文件 mtime）。
 */
export function parseSessionText(text, sid, fallbackTime) {
  const byTurnStep = new Map();
  const source = { provider: '', model: '' };
  let lastTime = Number.isFinite(Number(fallbackTime)) ? Number(fallbackTime) : 0;

  const lines = String(text || '').split('\n');
  for (const line of lines) {
    const raw = line.trim();
    if (!raw) continue;
    let ev;
    try {
      ev = JSON.parse(raw);
    } catch {
      continue; // 坏行（半行 / 非 JSON）跳过，不影响同文件其它事件
    }
    if (!ev || typeof ev !== 'object') continue;

    const evTime = numeric(ev.time);
    if (evTime !== null) lastTime = evTime;

    if (ev.type === 'request/header') {
      const cfg = ev.data && ev.data.header && ev.data.header.config;
      if (cfg) {
        if (cfg.provider) source.provider = String(cfg.provider);
        if (cfg.model) source.model = String(cfg.model);
      }
      continue;
    }

    if (ev.type === 'request/context') {
      const data = ev.data;
      if (data) {
        if (data.provider) source.provider = String(data.provider);
        if (data.model) source.model = String(data.model);
      }
      continue;
    }

    if (ev.type === 'assistant/chunk') {
      const chunk = ev.data && ev.data.chunk;
      if (chunk && chunk.type === 'usage' && chunk.usage) {
        const key = turnStepKey(sid, ev.data, ev);
        if (!byTurnStep.has(key)) byTurnStep.set(key, makeUsageEvent(ev, sid, lastTime, { ...source }));
      }
      continue;
    }

    if (ev.type === 'assistant/message' && ev.data && ev.data.usage) {
      const messageSource = ev.data.message && ev.data.message.source;
      const provider = messageSource && messageSource.provider ? String(messageSource.provider) : source.provider;
      const model = messageSource && messageSource.model ? String(messageSource.model) : source.model;
      // 权威值：同键覆盖（chunk 临时值 → 只算一次）
      byTurnStep.set(turnStepKey(sid, ev.data, ev), makeUsageEvent(ev, sid, lastTime, { provider, model }));
      if (messageSource) {
        if (messageSource.provider) source.provider = String(messageSource.provider);
        if (messageSource.model) source.model = String(messageSource.model);
      }
    }
  }
  return [...byTurnStep.values()];
}

/** 从会话目录名提取稳定的 sid：去掉 DSH 的 `session-` 前缀。 */
function sessionIdOfDir(dir) {
  const name = basename(dir);
  return name.startsWith('session-') ? name.slice('session-'.length) : name;
}

// ---------------------------------------------------------------------------
// 会话文件发现（每个会话目录只取「代数最高」的那一份日志）
// ---------------------------------------------------------------------------

function walkSessionTree(root, visit) {
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > MAX_SESSION_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 目录被占用 / 无权限：跳过子树
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push({ dir: path, depth: depth + 1 });
      else if (entry.isFile() && SESSION_FILE_RE.test(entry.name)) visit(path, entry.name);
    }
  }
}

/**
 * 发现会话日志文件。同一会话目录可能存在多代日志（session.v3 / session.v4 …）：
 * 只保留代数最高的一份，避免重复计费；同代优先未压缩 .jsonl。
 * 返回 [{ path, sid, zstd, size, mtimeMs }]，按路径排序（结果稳定、增量缓存友好）。
 */
export function discoverSessionFiles(sessionsDir, warnings = []) {
  const files = [];
  if (!sessionsDir) {
    warnings.push('未配置 DSH_HOME，无法定位会话日志，用量从 0 开始');
    return files;
  }
  if (!existsSync(sessionsDir)) {
    warnings.push(`未找到会话日志目录（${sessionsDir}），用量从 0 开始`);
    return files;
  }
  const bestByDir = new Map();
  try {
    walkSessionTree(sessionsDir, (path, name) => {
      const match = SESSION_FILE_RE.exec(name);
      if (!match) return;
      const gen = match[2] ? Number(match[2]) : 0;
      const zstd = name.endsWith('.zstd');
      const dir = dirname(path);
      const prev = bestByDir.get(dir);
      if (!prev || gen > prev.gen || (gen === prev.gen && prev.zstd && !zstd)) {
        bestByDir.set(dir, { gen, path, zstd, sid: sessionIdOfDir(dir) });
      }
    });
  } catch (err) {
    warnings.push(`会话目录遍历失败（${shortError(err)}），用量可能不完整`);
  }

  let statFailures = 0;
  for (const item of bestByDir.values()) {
    try {
      const st = statSync(item.path);
      if (!st.isFile()) continue;
      files.push({ path: item.path, sid: item.sid, zstd: item.zstd, size: st.size, mtimeMs: Math.floor(st.mtimeMs) });
    } catch {
      statFailures += 1;
    }
  }
  if (statFailures > 0) warnings.push(`${statFailures} 个会话文件无法读取元信息，已跳过`);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

function parseSessionFile(file) {
  const buffer = readFileSync(file.path);
  let text;
  if (file.zstd) {
    const decoded = decodeSessionZstd(buffer);
    if (decoded === null) throw new Error('zstd 解码失败或文件里没有完整帧');
    text = decoded;
  } else {
    text = buffer.toString('utf8');
  }
  return parseSessionText(text, file.sid, file.mtimeMs);
}

// ---------------------------------------------------------------------------
// 磁盘增量缓存：DSH_HOME/dsh-model-rank/usage-cache.json（自建格式，含 version）
// ---------------------------------------------------------------------------

function loadDiskCache(cacheFile, sessionsDir) {
  try {
    if (!cacheFile || !existsSync(cacheFile)) return { cache: null, warning: null };
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8'));
    if (!parsed || parsed.version !== CACHE_VERSION) {
      return { cache: null, warning: '用量磁盘缓存版本不符，已丢弃重建' };
    }
    if (parsed.sessionsDir !== sessionsDir) {
      // DSH_HOME 变了（切换安装目录）：旧缓存路径无意义，重扫
      return { cache: null, warning: '用量磁盘缓存路径与当前 DSH_HOME 不符，已丢弃重建' };
    }
    if (!parsed.files || typeof parsed.files !== 'object') {
      return { cache: null, warning: '用量磁盘缓存结构异常，已丢弃重建' };
    }
    return { cache: parsed, warning: null };
  } catch {
    return { cache: null, warning: '用量磁盘缓存损坏，已丢弃重建' };
  }
}

function saveDiskCache(cacheFile, sessionsDir, files, warnings) {
  if (!cacheFile) return;
  try {
    mkdirSync(dirname(cacheFile), { recursive: true });
    const payload = { version: CACHE_VERSION, updatedAt: Date.now(), sessionsDir, files };
    const tmp = `${cacheFile}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    renameSync(tmp, cacheFile);
  } catch (err) {
    warnings.push(`用量磁盘缓存写入失败（${shortError(err)}），下次将重新扫描`);
  }
}

// ---------------------------------------------------------------------------
// 快照 join：AA 价格 / OpenRouter 周榜 / Arena 名次 + 本机接入清单的展示名
// ---------------------------------------------------------------------------

function firstAliasHit(index, keys) {
  for (const key of keys) {
    const hit = index.get(key);
    if (hit !== undefined) return hit;
  }
  return null;
}

function addAlias(index, alias, value) {
  for (const key of modelKeys(alias)) {
    if (!index.has(key)) index.set(key, value);
  }
}

/**
 * 用当前快照与本机接入清单建 join 索引：
 *   - aa.models → 模型价格（估算费用）与智能指数等展示字段；
 *   - usage.weekly → OpenRouter 周榜名次；
 *   - arena.rows → LMArena 对战榜名次；
 *   - inventory → 可读 model / provider 展示名。
 * resolve(model) 结果按 model 原值缓存，重复事件只算一次。
 */
function createJoiner(snapshot, inventory) {
  const aaIndex = new Map();
  const weeklyIndex = new Map();
  const arenaIndex = new Map();
  const modelNameIndex = new Map();
  const providerNameIndex = new Map();

  for (const model of (inventory && Array.isArray(inventory.models) ? inventory.models : [])) {
    if (!model || typeof model !== 'object') continue;
    if (model.provider && model.providerDisplay) providerNameIndex.set(String(model.provider), String(model.providerDisplay));
    const name = typeof model.name === 'string' && model.name ? model.name : (typeof model.id === 'string' ? model.id : '');
    if (name) {
      addAlias(modelNameIndex, model.id, name);
      addAlias(modelNameIndex, model.name, name);
    }
  }
  for (const provider of (inventory && Array.isArray(inventory.providers) ? inventory.providers : [])) {
    if (!provider || typeof provider !== 'object') continue;
    if (provider.name && provider.display) providerNameIndex.set(String(provider.name), String(provider.display));
  }

  const aaRows = snapshot && snapshot.aa && Array.isArray(snapshot.aa.models) ? snapshot.aa.models : [];
  for (const row of aaRows) {
    if (!row || typeof row !== 'object') continue;
    addAlias(aaIndex, row.name, row);
    addAlias(aaIndex, row.slug, row);
    addAlias(aaIndex, lastSlugSegment(row.slug), row);
    if (row.provider) {
      addAlias(aaIndex, `${row.provider} ${row.name || ''}`, row);
      addAlias(aaIndex, `${row.provider} ${lastSlugSegment(row.slug)}`, row);
    }
  }

  const weeklyRows = snapshot && snapshot.usage && Array.isArray(snapshot.usage.weekly) ? snapshot.usage.weekly : [];
  for (const row of weeklyRows) {
    if (!row || typeof row !== 'object') continue;
    addAlias(weeklyIndex, row.model, row);
    addAlias(weeklyIndex, row.slug, row);
    addAlias(weeklyIndex, lastSlugSegment(row.slug), row);
  }

  const arenaRows = snapshot && snapshot.arena && Array.isArray(snapshot.arena.rows) ? snapshot.arena.rows : [];
  for (const row of arenaRows) {
    if (!row || typeof row !== 'object') continue;
    addAlias(arenaIndex, row.model, row);
    addAlias(arenaIndex, lastSlugSegment(row.model), row);
  }

  const cache = new Map();
  return {
    resolve(model) {
      const raw = model || '';
      if (cache.has(raw)) return cache.get(raw);
      const keys = modelKeys(raw);
      const aaRow = firstAliasHit(aaIndex, keys);
      const result = {
        display: firstAliasHit(modelNameIndex, keys) || raw,
        aa: aaRow || null,
        price: aaRow && aaRow.price && typeof aaRow.price === 'object' ? aaRow.price : null,
        weekly: firstAliasHit(weeklyIndex, keys) || null,
        arena: firstAliasHit(arenaIndex, keys) || null,
      };
      cache.set(raw, result);
      return result;
    },
    providerDisplay(provider) {
      return providerNameIndex.get(provider) || provider;
    },
  };
}

/** AA 行 → 契约里的 ModelBucket.aa 子结构（字段可能缺失；完全无价格时 price=null）。 */
function aaFacade(row) {
  if (!row) return null;
  const rawPrice = row.price && typeof row.price === 'object' ? row.price : {};
  const price = {};
  const input = numeric(rawPrice.input);
  const output = numeric(rawPrice.output);
  const cacheHit = numeric(rawPrice.cacheHit);
  if (input !== null) price.input = input;
  if (output !== null) price.output = output;
  if (cacheHit !== null) price.cacheHit = cacheHit;
  return {
    slug: typeof row.slug === 'string' ? row.slug : null,
    name: typeof row.name === 'string' ? row.name : null,
    intelligence: numeric(row.intelligence),
    price: Object.keys(price).length ? price : null,
    blended31: numeric(rawPrice.blended31),
  };
}

/** OpenRouter 周榜行 → 契约里的 ModelBucket.globalWeekly 子结构。 */
function weeklyFacade(row) {
  if (!row) return null;
  return {
    rank: numeric(row.rank),
    tokensLabel: row.tokens && typeof row.tokens.label === 'string' ? row.tokens.label : null,
    authorDisplay: typeof row.authorDisplay === 'string' ? row.authorDisplay : null,
  };
}

// ---------------------------------------------------------------------------
// 账户余额 / 套餐窗口（可选数据源，只读；文件缺失不影响功能）
// ---------------------------------------------------------------------------

function normalizeBalance(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = numeric(Number(raw.totalBalance));
  if (total === null) return null;
  return {
    currency: typeof raw.currency === 'string' ? raw.currency : '',
    total,
    updatedAt: numeric(raw.updatedAt),
  };
}

function normalizePlan(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const windows = Array.isArray(raw.windows) ? raw.windows : [];
  const plan = [];
  for (const item of windows) {
    if (!item || typeof item !== 'object') continue;
    plan.push({
      key: typeof item.key === 'string' ? item.key : '',
      percent: numeric(item.percent),
      resetsAt: typeof item.resetsAt === 'string' ? item.resetsAt : null,
    });
  }
  return plan;
}

/** 读 <DSH_HOME>/dsh-usage/provider-snapshots.json（dsh-usage 插件的只读快照）。 */
function readAccounts(home, warnings) {
  const source = { available: false, path: null };
  if (!home) return { source, accounts: [] };
  const file = join(home, 'dsh-usage', 'provider-snapshots.json');
  if (!existsSync(file)) return { source, accounts: [] };
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const providers = doc && doc.providers && typeof doc.providers === 'object' ? Object.values(doc.providers) : [];
    const accounts = [];
    for (const provider of providers) {
      if (!provider || typeof provider !== 'object') continue;
      const balance = normalizeBalance(provider.balance);
      const plan = normalizePlan(provider.plan);
      // 只暴露有余额或套餐窗口的账户：空账户不占 UI 空间
      if (!balance && plan.length === 0) continue;
      accounts.push({
        provider: typeof provider.provider === 'string' ? provider.provider : '',
        displayName: typeof provider.displayName === 'string' ? provider.displayName : String(provider.provider || ''),
        credential: typeof provider.credential === 'string' ? provider.credential : 'none',
        balance,
        plan,
      });
    }
    source.available = true;
    source.path = file;
    return { source, accounts };
  } catch (err) {
    warnings.push(`账户余额文件读取失败（${shortError(err)}），已跳过`);
    return { source, accounts: [] };
  }
}

// ---------------------------------------------------------------------------
// 聚合
// ---------------------------------------------------------------------------

function newMetricsAcc() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    calls: 0,
    cost: 0,
    pricedTokens: 0,
    sids: new Set(),
  };
}

function newAgg() {
  return { total: newMetricsAcc(), models: new Map(), providers: new Map() };
}

function newRangeAggs(todayKey) {
  return {
    todayKey,
    d7Start: addDaysKey(todayKey, -6),
    d30Start: addDaysKey(todayKey, -29),
    today: newAgg(),
    d7: newAgg(),
    d30: newAgg(),
    all: newAgg(),
  };
}

/** 费用估算（USD）：AA 价格为 USD / 1M tokens；cacheWrite 无独立价时按 input 价。 */
function estimateCost(event, price) {
  if (!price || typeof price !== 'object') return null;
  const pIn = numeric(price.input);
  const pOut = numeric(price.output);
  const pHit = numeric(price.cacheHit);
  if (pIn === null && pOut === null) return null;
  const inRate = pIn === null ? 0 : pIn;
  const outRate = pOut === null ? 0 : pOut;
  const hitRate = pHit === null ? inRate : pHit;
  const cost = (event.i * inRate + event.r * hitRate + event.w * inRate + event.o * outRate) / 1e6;
  return Number.isFinite(cost) ? cost : null;
}

function addEventTo(agg, event, resolved) {
  const total = event.i + event.r + event.w + event.o;
  const price = resolved.price;
  const apply = (acc) => {
    acc.inputTokens += event.i;
    acc.outputTokens += event.o;
    acc.cacheReadTokens += event.r;
    acc.cacheWriteTokens += event.w;
    acc.reasoningTokens += event.z;
    acc.totalTokens += total;
    acc.calls += 1;
    if (event.sid) acc.sids.add(event.sid);
    if (price) {
      const cost = estimateCost(event, price);
      if (cost !== null) {
        acc.cost += cost;
        acc.pricedTokens += total;
      }
    }
  };
  apply(agg.total);

  const model = event.m || UNKNOWN_MODEL;
  const provider = event.p || UNKNOWN_PROVIDER;
  let modelAcc = agg.models.get(model);
  if (!modelAcc) {
    modelAcc = newMetricsAcc();
    modelAcc.providers = new Map();
    agg.models.set(model, modelAcc);
  }
  apply(modelAcc);
  modelAcc.providers.set(provider, (modelAcc.providers.get(provider) || 0) + total);

  let providerAcc = agg.providers.get(provider);
  if (!providerAcc) {
    providerAcc = newMetricsAcc();
    providerAcc.models = new Set();
    agg.providers.set(provider, providerAcc);
  }
  apply(providerAcc);
  providerAcc.models.add(model);
}

function zeroMetrics() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    calls: 0,
    sessions: 0,
    estimatedCostUsd: null,
  };
}

function metricsOut(acc) {
  return {
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cacheReadTokens: acc.cacheReadTokens,
    cacheWriteTokens: acc.cacheWriteTokens,
    reasoningTokens: acc.reasoningTokens,
    totalTokens: acc.totalTokens,
    calls: acc.calls,
    sessions: acc.sids.size,
    estimatedCostUsd: acc.pricedTokens > 0 ? round(acc.cost, 4) : null,
  };
}

function costCoverageOf(acc) {
  if (!acc.totalTokens) return null;
  return round(acc.pricedTokens / acc.totalTokens, 4);
}

/**
 * 一个 range 的 RangePayload：metrics + byModel + byProvider + costCoverage（可选增补字段）。
 */
function buildRangePayload(agg, joiner) {
  const grandTokens = agg.total.totalTokens;
  const metrics = metricsOut(agg.total);

  const byModel = [];
  for (const [model, acc] of agg.models) {
    const resolved = joiner.resolve(model);
    const providerEntries = [...(acc.providers || new Map()).entries()].sort((a, b) => b[1] - a[1]);
    byModel.push({
      model,
      display: resolved.display || model,
      provider: providerEntries.length ? providerEntries[0][0] : '',
      providers: providerEntries.map(([provider]) => provider).filter(Boolean),
      ...metricsOut(acc),
      share: grandTokens > 0 ? round(acc.totalTokens / grandTokens, 4) : 0,
      localRank: 0, // 排序后回填
      aa: aaFacade(resolved.aa),
      globalWeekly: weeklyFacade(resolved.weekly),
      arenaRank: resolved.arena && numeric(resolved.arena.rank) !== null ? resolved.arena.rank : null,
    });
  }
  byModel.sort((a, b) => b.totalTokens - a.totalTokens || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  byModel.forEach((bucket, index) => { bucket.localRank = index + 1; });

  const byProvider = [];
  for (const [provider, acc] of agg.providers) {
    byProvider.push({
      provider,
      display: joiner.providerDisplay(provider),
      ...metricsOut(acc),
      share: grandTokens > 0 ? round(acc.totalTokens / grandTokens, 4) : 0,
      models: acc.models ? acc.models.size : 0,
    });
  }
  byProvider.sort((a, b) => b.totalTokens - a.totalTokens || (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0));

  return {
    metrics,
    byModel: byModel.slice(0, BY_MODEL_LIMIT),
    byProvider: byProvider.slice(0, BY_PROVIDER_LIMIT),
    costCoverage: costCoverageOf(agg.total),
  };
}

/** byDay：升序、连续自然日（补零）、以今天结尾、最多 180 条（超出截断最早）。 */
function buildByDay(dayMap, todayKey) {
  if (!dayMap.size) return [];
  let minDay = null;
  let maxDay = null;
  for (const day of dayMap.keys()) {
    if (minDay === null || day < minDay) minDay = day;
    if (maxDay === null || day > maxDay) maxDay = day;
  }
  let start = addDaysKey(todayKey, -(BY_DAY_LIMIT - 1));
  if (minDay > start) start = minDay;
  const end = maxDay > todayKey ? maxDay : todayKey;
  const out = [];
  for (let day = start, guard = 0; day <= end && guard < 800; guard += 1, day = addDaysKey(day, 1)) {
    const agg = dayMap.get(day);
    out.push({ day, ...(agg ? metricsOut(agg.total) : zeroMetrics()) });
  }
  while (out.length > BY_DAY_LIMIT) out.shift();
  return out;
}

function summarizeInventory(inventory) {
  const models = inventory && Array.isArray(inventory.models) ? inventory.models.length : 0;
  const providers = [];
  for (const provider of inventory && Array.isArray(inventory.providers) ? inventory.providers : []) {
    const name = provider && (provider.name || provider.display);
    if (name && !providers.includes(name)) providers.push(String(name));
  }
  return { models, providers };
}

function emptySessionsSource() {
  return { dir: '', files: 0, parsed: 0, reparsed: 0, failed: 0, skipped: 0, events: 0, cache: 'none' };
}

function emptyRangePayload() {
  return { metrics: zeroMetrics(), byModel: [], byProvider: [], costCoverage: null };
}

/** 结构完整、全零的降级报告：任何内部异常都不能让 RPC 返回 500 / 残结构。 */
export function emptyReport(warning) {
  return {
    version: USAGE_VERSION,
    ok: true,
    generatedAt: Date.now(),
    durationMs: 0,
    sources: { sessions: emptySessionsSource(), accounts: { available: false, path: null } },
    totals: zeroMetrics(),
    ranges: {
      today: emptyRangePayload(),
      d7: emptyRangePayload(),
      d30: emptyRangePayload(),
      all: emptyRangePayload(),
    },
    byDay: [],
    accounts: [],
    inventory: { models: 0, providers: [] },
    costCoverage: null,
    warnings: warning ? [String(warning)] : [],
  };
}

// ---------------------------------------------------------------------------
// 报告构建
// ---------------------------------------------------------------------------

async function buildReport(params) {
  const clock = typeof params.clock === 'function' ? params.clock : () => Date.now();
  const startedAt = params.startedAt;
  const nowMs = params.nowMs;
  const home = params.home || '';
  const sessionsDir = params.sessionsDir || '';
  const cacheFile = params.cacheFile || '';
  const warnings = [];

  const files = discoverSessionFiles(sessionsDir, warnings);
  const zstdAvailable = canDecodeZstd();
  const { cache, warning: cacheWarning } = loadDiskCache(cacheFile, sessionsDir);
  if (cacheWarning) warnings.push(cacheWarning);

  const cachedFiles = (cache && cache.files) || {};
  const nextFiles = {};
  let reparsed = 0;
  let parsed = 0;
  let failed = 0;
  let skipped = 0;
  let budgetSkipped = 0;
  let cacheChanged = !cache;
  const scanBudgetMs = numeric(params.scanBudgetMs) === null ? SCAN_BUDGET_MS : params.scanBudgetMs;
  const scanDeadline = startedAt + scanBudgetMs;

  for (const file of files) {
    if (file.zstd && !zstdAvailable) {
      skipped += 1;
      continue; // 本运行时不支持 zstd：不写缓存，下次运行时若升级会自动重试
    }
    const cached = cachedFiles[file.path];
    if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
      nextFiles[file.path] = cached;
      if (cached.ok === true) {
        parsed += 1;
      } else {
        failed += 1;
      }
      continue;
    }
    // 只有「需要真正重新解析」的文件才会消耗预算；解析之间让出事件循环，避免阻塞宿主其它任务
    await yieldToHost();
    if (clock() > scanDeadline) {
      budgetSkipped += 1;
      cacheChanged = true;
      continue;
    }
    reparsed += 1;
    cacheChanged = true;
    try {
      const events = await parseSessionFile(file);
      nextFiles[file.path] = { size: file.size, mtimeMs: file.mtimeMs, ok: true, events };
      parsed += 1;
    } catch (err) {
      nextFiles[file.path] = { size: file.size, mtimeMs: file.mtimeMs, ok: false, err: shortError(err) };
      failed += 1;
    }
  }

  // 缓存里已被删除的会话路径：清理（changed 用于决定是否回写）
  if (cache && Object.keys(cachedFiles).length !== Object.keys(nextFiles).length) cacheChanged = true;
  if (cacheChanged) saveDiskCache(cacheFile, sessionsDir, nextFiles, warnings);

  const joiner = createJoiner(params.snapshot, params.inventory);
  const todayKey = toDayKey(nowMs) || '1970-01-01';
  const ranges = newRangeAggs(todayKey);
  const allAgg = ranges.all;
  const dayMap = new Map();
  let eventsTotal = 0;

  for (const filePath of Object.keys(nextFiles)) {
    const entry = nextFiles[filePath];
    if (!entry || entry.ok !== true || !Array.isArray(entry.events)) continue;
    eventsTotal += entry.events.length;
    for (const event of entry.events) {
      const day = toDayKey(event.t) || todayKey;
      const resolved = joiner.resolve(event.m || UNKNOWN_MODEL);
      addEventTo(allAgg, event, resolved);
      let dayAgg = dayMap.get(day);
      if (!dayAgg) {
        dayAgg = newAgg();
        dayMap.set(day, dayAgg);
      }
      addEventTo(dayAgg, event, resolved);
      if (day === ranges.todayKey) addEventTo(ranges.today, event, resolved);
      if (day >= ranges.d7Start && day <= ranges.todayKey) addEventTo(ranges.d7, event, resolved);
      if (day >= ranges.d30Start && day <= ranges.todayKey) addEventTo(ranges.d30, event, resolved);
    }
  }

  if (skipped > 0) warnings.push(`当前 Node 运行时缺少 zstd 解压能力，已跳过 ${skipped} 个 .zstd 会话文件（升级到 Node ≥ 22.15 可恢复）`);
  if (failed > 0) warnings.push(`${failed} 个会话文件解析失败（坏帧 / 被占用），已跳过且不影响其它文件`);
  if (budgetSkipped > 0) {
    warnings.push(`本次扫描超过 ${Math.max(0, Math.round(scanBudgetMs))}ms 时间预算，${budgetSkipped} 个已变化文件未纳入统计（本次为部分结果），下次调用会继续增量补全`);
  }

  const accountsInfo = readAccounts(home, warnings);
  const totals = metricsOut(allAgg.total);
  const rangePayloads = {
    today: buildRangePayload(ranges.today, joiner),
    d7: buildRangePayload(ranges.d7, joiner),
    d30: buildRangePayload(ranges.d30, joiner),
    all: buildRangePayload(allAgg, joiner),
  };

  if (totals.calls > 0 && totals.estimatedCostUsd === null) {
    warnings.push('快照里没有可匹配的 Artificial Analysis 价格数据，费用无法估算（联网刷新后自动恢复）');
  }

  return {
    version: USAGE_VERSION,
    ok: true,
    generatedAt: nowMs,
    durationMs: clock() - startedAt,
    sources: {
      sessions: {
        dir: sessionsDir,
        files: files.length,
        parsed,
        reparsed,
        failed,
        skipped,
        events: eventsTotal,
        cache: cache ? 'warm' : (files.length ? 'cold' : 'none'),
      },
      accounts: accountsInfo.source,
    },
    totals,
    ranges: rangePayloads,
    byDay: buildByDay(dayMap, todayKey),
    accounts: accountsInfo.accounts,
    inventory: summarizeInventory(params.inventory),
    costCoverage: costCoverageOf(allAgg.total),
    warnings,
  };
}

function stampOf(snapshot, inventory) {
  const fetchedAt = snapshot && typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : '';
  const aaCount = snapshot && snapshot.aa && Array.isArray(snapshot.aa.models) ? snapshot.aa.models.length : 0;
  const weeklyCount = snapshot && snapshot.usage && Array.isArray(snapshot.usage.weekly) ? snapshot.usage.weekly.length : 0;
  const modelCount = inventory && Array.isArray(inventory.models) ? inventory.models.length : 0;
  const providerCount = inventory && Array.isArray(inventory.providers) ? inventory.providers.length : 0;
  return `${fetchedAt}|${aaCount}|${weeklyCount}|${modelCount}|${providerCount}`;
}

// ---------------------------------------------------------------------------
// 对外入口：createUsageReporter
// ---------------------------------------------------------------------------

/**
 * 创建用量报告器（每个 host 插件实例一个）。
 *
 * @param {object} options
 *   - home          DSH_HOME（账户文件从 <home>/dsh-usage/ 读）
 *   - sessionsDir   会话日志根目录（默认 <home>/sessions）
 *   - cacheFile     磁盘增量缓存文件（默认 <home>/dsh-model-rank/usage-cache.json）
 *   - memoryTtlMs   内存缓存 TTL（默认 30s；测试可传 0 强制重建）
 *   - scanBudgetMs  单次扫描时间预算（默认 5s；超预算返回部分结果 + warnings，测试可传 -1 强制降级）
 *   - now           时钟注入（测试用）
 *   - log           降级日志回调（默认静默；不打印 token 明细）
 * @returns {{ report:Function, summary:Function, invalidate:Function }}
 */
export function createUsageReporter(options = {}) {
  const home = typeof options.home === 'string' ? options.home.trim() : '';
  const sessionsDir = typeof options.sessionsDir === 'string' && options.sessionsDir
    ? options.sessionsDir
    : (home ? join(home, 'sessions') : '');
  const cacheFile = typeof options.cacheFile === 'string' && options.cacheFile
    ? options.cacheFile
    : (home ? join(home, 'dsh-model-rank', 'usage-cache.json') : '');
  const memoryTtlMs = numeric(options.memoryTtlMs) === null ? MEMORY_TTL_MS : options.memoryTtlMs;
  const scanBudgetMs = numeric(options.scanBudgetMs) === null ? SCAN_BUDGET_MS : options.scanBudgetMs;
  const clock = typeof options.now === 'function' ? options.now : () => Date.now();
  const log = typeof options.log === 'function' ? options.log : () => {};

  let memory = { at: 0, stamp: '', report: null };
  let pending = null;
  let pendingStamp = '';

  function memoryHit(reportValue, started) {
    // 内存命中：数据沿用上次聚合结果，只更新本次调用耗时
    const copy = { ...reportValue, durationMs: clock() - started };
    copy.sources = { ...copy.sources, sessions: { ...copy.sources.sessions } };
    copy.sources.sessions.reparsed = 0;
    copy.sources.sessions.cache = 'warm';
    return copy;
  }

  /**
   * 构建（或复用）用量报告。异常一律降级为空报告 + warning，永不 reject。
   * 解析大文件之间会 await 让出事件循环；并发调用复用同一个 in-flight 构建。
   * @param {{ snapshot?:object|null, inventory?:object|null, force?:boolean }} input
   * @returns {Promise<object>}
   */
  async function report(input = {}) {
    const started = clock();
    const snapshot = input.snapshot || null;
    const inventory = input.inventory || null;
    const stamp = stampOf(snapshot, inventory);

    if (!input.force && memory.report && memory.stamp === stamp && started - memory.at < memoryTtlMs) {
      return memoryHit(memory.report, started);
    }
    if (!input.force && pending && pendingStamp === stamp) return pending;

    const run = (async () => {
      try {
        return await buildReport({
          home,
          sessionsDir,
          cacheFile,
          snapshot,
          inventory,
          nowMs: started,
          startedAt: started,
          clock,
          scanBudgetMs,
        });
      } catch (err) {
        try { log(`[usage] 报告构建降级：${(err && err.stack) || shortError(err)}`) } catch { /* 日志失败无害 */ }
        const fallback = emptyReport(`用量统计内部异常（已降级为空数据）：${shortError(err)}`);
        fallback.durationMs = clock() - started;
        return fallback;
      }
    })();
    pending = run;
    pendingStamp = stamp;
    run.then((result) => {
      memory = { at: clock(), stamp, report: result };
    }, () => { /* 内部已降级，不会走到这里 */ }).finally(() => {
      if (pending === run) {
        pending = null;
        pendingStamp = '';
      }
    });
    return run;
  }

  /** 轻量摘要（给 status payload 用）：未构建过报告时返回 null，绝不触发扫描。 */
  function summary() {
    const last = memory.report;
    if (!last) return null;
    return {
      generatedAt: last.generatedAt,
      totalTokens: last.totals.totalTokens,
      estimatedCostUsd: last.totals.estimatedCostUsd,
      calls: last.totals.calls,
    };
  }

  /** 丢弃内存缓存（快照刷新成功后调用，让新价格/榜单立即生效）。 */
  function invalidate() {
    memory = { at: 0, stamp: '', report: null };
  }

  return { report, summary, invalidate, sessionsDir, cacheFile };
}
