// dsh-model-rank · livebench.js
// LiveBench 2.0「能力榜」数据源（纯 Node、零依赖、运行时抓取、随包不分发）。
//
// 数据流（研究实测，见 .team/research.md §5）：
//   1) GET https://livebench.ai/            → 从 SPA 外壳里发现同源 bundle 脚本（hash 每次部署都会变）
//   2) GET <bundle>.js                      → 正则发现 release：v2 是 8 位日期数组，v1 是 ISO 日期数组
//   3) GET data/<v2id>/table.csv            → 模型 × 类别分数
//      GET data/<v2id>/categories.json      → 类别 → 任务列 + `_overall_weights`（总分权重）
//      GET data/<v2id>/notes.json           → 官方口径说明（可选，失败不影响）
//   4) 解析后按官方权重算总分：Σ(score×weight)/Σ(weight)，缺类不计入分母；0 分保留。
//
// 安全与健壮性（研究 §5.7 / §9.3，硬性）：
//   - 只访问 livebench.ai 同源；不执行远程 JS；
//   - 响应大小上限（html 256KB / bundle 2MB / csv·json 256KB），超限视为失败；
//   - 404 会返回 SPA 的 HTML（9KB）→ 所有非 HTML 响应都做 HTML 嗅探，绝不把 HTML 当 CSV/JSON；
//   - 版本发现失败 → 回退上次 releaseId；release 数据 404 → 回退上一个 releaseId；
//   - 任何失败都返回 { ok:false, error }，由 pipeline 降级为「沿用旧快照 + stale」，绝不抛给宿主。
//
// 授权：LiveBench 项目代码 Apache-2.0；站点分数数据未标注独立许可 → 与 AA 同一策略，
//       只运行时抓取、不写进随包分发的 data/snapshot.json。

export const LIVEBENCH_HOME = 'https://livebench.ai/';
export const LIVEBENCH_ORIGIN = 'https://livebench.ai';
export const LIVEBENCH_LIMITS = {
  html: 256 * 1024,
  bundle: 2 * 1024 * 1024,
  csv: 256 * 1024,
  json: 256 * 1024,
  rows: 200,          // 单次最多保留的模型行（当前 32/55/71，防上游异常暴涨）
  notes: 10,          // notes.json 最多保留条数
  noteChars: 300,     // 单条 notes 最大字符数
  // LB-11：整轮 LiveBench 抓取的全局时间预算；超时立即返回 ok:false/error='budget'，
  // 保证刷新 RPC 最坏 < 60s（远早于客户端 90s 超时），不会把宿主拖死。
  budgetMs: 45_000,
  // 单个请求超时上限（候选 URL 一律 retries:0，失败等下次刷新，不在这里反复重试）。
  requestTimeoutMs: 8_000,
  // bundle 候选脚本最多尝试数（首页出现 vendor chunk 时仍能发现版本信息，但不会无限循环）。
  bundleCandidates: 2,
};

const FETCH_TIMEOUT_MS = 30_000;
const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// 最近一次成功结果（内部缓存，供诊断 / 失败回退参考；不含本机清单）
let lastSuccess = null;

/** 最近一次成功的 LiveBench 结果（深拷贝，避免调用方误改内部缓存）。 */
export function getLastLivebenchCache() {
  return lastSuccess ? JSON.parse(JSON.stringify(lastSuccess)) : null;
}

function nowIso() {
  return new Date().toISOString();
}

function shortError(err) {
  const text = String((err && err.message) || err || 'unknown');
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/** 多任务类别（v1）没有单一任务列时用的稳定 key；v2 单任务类别直接用任务列名。 */
function slugCategoryKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '') || 'category';
}

// ---------------------------------------------------------------------------
// 纯解析函数（离线 fixture 可测）
// ---------------------------------------------------------------------------

/**
 * 从首页 HTML 里发现所有同源 bundle 脚本 URL（最多 8 个；只接受 livebench.ai 同源、pathname 以 .js 结尾）。
 * @returns {string[]}
 */
function discoverBundleUrls(html) {
  const text = String(html || '');
  const urls = [];
  if (!text) return urls;
  const re = /<script[^>]*\ssrc=["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(text)) !== null && urls.length < 8) {
    const src = match[1].trim();
    if (!src) continue;
    let url;
    try {
      url = new URL(src, LIVEBENCH_HOME);
    } catch {
      continue;
    }
    if (url.origin !== LIVEBENCH_ORIGIN) continue; // 同源校验：绝不加载第三方脚本
    if (!/\.js$/i.test(url.pathname)) continue;
    if (!urls.includes(url.href)) urls.push(url.href);
  }
  return urls;
}

/**
 * 从首页 HTML 里发现主 bundle 脚本 URL（当前站点只有 1 个 main bundle）。
 * 只接受：同源（livebench.ai）、pathname 以 .js 结尾；忽略跨域脚本与静态资源。
 * @returns {string|null} 绝对 URL 或 null
 */
export function discoverBundleUrl(html) {
  return discoverBundleUrls(html)[0] || null;
}

/**
 * 从 bundle 文本里发现 release 列表（只匹配「元素全为日期字符串」的数组，避免误把散落的日期当 release）。
 * @returns {{ v2: string[], v1: string[] }} 升序去重后的 release id 列表
 */
export function parseBundleReleases(bundleText) {
  const text = String(bundleText || '');
  const collect = (arrayRe, idRe) => {
    const ids = new Set();
    let match;
    while ((match = arrayRe.exec(text)) !== null) {
      const found = match[1].match(idRe) || [];
      for (const id of found) ids.add(id);
    }
    return [...ids].sort();
  };
  return {
    v2: collect(/\[((?:"20\d{6}"\s*,?\s*)+)\]/g, /20\d{6}/g),
    v1: collect(/\[((?:"20\d{2}-\d{2}-\d{2}"\s*,?\s*)+)\]/g, /20\d{2}-\d{2}-\d{2}/g),
  };
}

function stripQuotes(value) {
  const s = String(value == null ? '' : value).trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/""/g, '"');
  }
  return s;
}

/**
 * 解析 table.csv（无引号、LF、UTF-8；容忍 BOM/CRLF）。
 * 校验每行列数 = 表头列数，不一致的行跳过并累计 warning。
 * @returns {{ header: string[], rows: string[][], warnings: string[] }}
 */
export function parseTableCsv(text) {
  const warnings = [];
  const raw = String(text || '');
  if (/^\s*<!doctype/i.test(raw) || /<html[\s>]/i.test(raw)) {
    throw new Error('table.csv 返回了 HTML（可能 404 或站点布局变化）');
  }
  const lines = raw.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (!lines.length) throw new Error('table.csv 为空');
  const header = lines[0].split(',').map(stripQuotes);
  if (header[0] !== 'model') throw new Error('table.csv 缺少 model 列（站点布局可能变化）');
  if (header.length < 2) throw new Error('table.csv 没有类别列');
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    const parts = lines[i].split(',').map(stripQuotes);
    if (parts.length !== header.length) {
      warnings.push(`table.csv 第 ${i + 1} 行列数不符（${parts.length}/${header.length}），已跳过`);
      continue;
    }
    rows.push(parts);
  }
  if (!rows.length) throw new Error('table.csv 没有有效数据行');
  return { header, rows, warnings };
}

/**
 * 解析 categories.json：`{"<展示名>": ["<任务列>", ...], ..., "_overall_weights": {...}}`。
 * `_overall_weights` 是元数据，不是类别；未配置的类别权重按 1。
 * @returns {{ categories: Array<{key:string,name:string,tasks:string[],weight:number}>, warnings: string[] }}
 */
export function parseCategoriesJson(text) {
  const warnings = [];
  const raw = String(text || '');
  if (/^\s*<!doctype/i.test(raw) || /<html[\s>]/i.test(raw)) {
    throw new Error('categories.json 返回了 HTML（可能 404 或站点布局变化）');
  }
  let doc;
  try {
    doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('categories.json 不是合法 JSON');
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('categories.json 结构异常');
  const weightsRaw = doc._overall_weights && typeof doc._overall_weights === 'object' && !Array.isArray(doc._overall_weights)
    ? doc._overall_weights
    : {};
  const categories = [];
  for (const [name, tasksRaw] of Object.entries(doc)) {
    if (name === '_overall_weights') continue;
    const tasks = Array.isArray(tasksRaw)
      ? tasksRaw.filter((task) => typeof task === 'string' && task.trim()).map((task) => task.trim())
      : [];
    if (!tasks.length) {
      warnings.push(`categories.json 里类别「${name}」没有任务列，已跳过`);
      continue;
    }
    const weightRaw = Number(weightsRaw[name]);
    const weight = Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 1;
    categories.push({
      key: tasks.length === 1 ? tasks[0] : slugCategoryKey(name),
      name,
      tasks,
      weight,
    });
  }
  if (!categories.length) throw new Error('categories.json 没有可用类别');
  return { categories, warnings };
}

/** 单个分数单元格：'-' / 空 / n/a / NaN → 无分（null）；0 是合法分数。 */
function parseScoreCell(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  if (!s || s === '-' || s === 'n/a' || s === 'na' || s === 'null' || s === 'nan') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

/**
 * 由 table + categories 生成能力榜行：类别分 = 该类任务均值（缺任务忽略），
 * 总分 = Σ(类别分×权重)/Σ(权重)，缺类不计入分母（v2 官方口径）。
 * options.requireAllCategories=true 时（v1 旧代）任一类别缺失的模型不进总榜（v1 官方口径）。
 * @returns {Array<{model:string,display:string,scores:Object,overall:number,rank:number}>}
 */
export function buildLivebenchRows(table, categories, options = {}) {
  const requireAllCategories = options.requireAllCategories === true;
  const header = table && Array.isArray(table.header) ? table.header : [];
  const rowsIn = table && Array.isArray(table.rows) ? table.rows : [];
  const categoryList = Array.isArray(categories) ? categories : [];
  const colIndex = new Map(header.map((name, index) => [name, index]));
  const out = [];

  for (const parts of rowsIn) {
    const model = stripQuotes(parts[0]);
    if (!model) continue;
    const scores = {};
    let weightedSum = 0;
    let weightSum = 0;
    let missingCategory = false;
    for (const category of categoryList) {
      const values = [];
      for (const task of category.tasks || []) {
        const index = colIndex.get(task);
        if (index === undefined) continue;
        const score = parseScoreCell(parts[index]);
        if (score !== null) values.push(score);
      }
      if (!values.length) {
        missingCategory = true;
        continue;
      }
      const score = Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 1000) / 1000;
      scores[category.key] = score;
      weightedSum += score * category.weight;
      weightSum += category.weight;
    }
    if (requireAllCategories && missingCategory) continue; // v1：缺任一类别不进总榜
    if (weightSum <= 0) continue;
    out.push({ model, display: model, scores, overall: round2(weightedSum / weightSum) });
  }

  out.sort((a, b) => b.overall - a.overall || (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  const ranked = out.slice(0, LIVEBENCH_LIMITS.rows);
  ranked.forEach((row, index) => { row.rank = index + 1; });
  return ranked;
}

/** notes.json → 口径说明字符串数组（可选数据源：解析失败返回 []，最多 10 条 × 300 字）。 */
export function parseNotesJson(text) {
  const raw = String(text || '');
  if (!raw.trim()) return [];
  let doc;
  try {
    doc = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return [];
  }
  if (!Array.isArray(doc)) return [];
  return doc
    .filter((item) => typeof item === 'string' && item.trim())
    .slice(0, LIVEBENCH_LIMITS.notes)
    .map((item) => {
      const text = item.trim();
      return text.length > LIVEBENCH_LIMITS.noteChars
        ? text.slice(0, LIVEBENCH_LIMITS.noteChars - 1) + '…'
        : text;
    });
}

// ---------------------------------------------------------------------------
// 抓取
// ---------------------------------------------------------------------------

async function defaultFetchText(url, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : FETCH_TIMEOUT_MS;
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : null;
  const response = await fetch(url, {
    headers: { ...BROWSER_HEADERS, ...(options.headers || {}) },
    redirect: 'follow',
    signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers && typeof response.headers.get === 'function' ? response.headers.get('content-length') : NaN);
  if (maxBytes && Number.isFinite(declared) && declared > maxBytes) {
    try { if (response.body && typeof response.body.cancel === 'function') await response.body.cancel(); } catch { /* noop */ }
    throw new Error(`响应过大（Content-Length ${declared} > ${maxBytes} 字节）`);
  }
  const text = await response.text();
  if (maxBytes && Buffer.byteLength(String(text || ''), 'utf8') > maxBytes) {
    throw new Error(`响应过大（> ${maxBytes} 字节），已丢弃`);
  }
  return { text, finalUrl: response.url || url, status: response.status };
}

function assertTextSize(text, limitBytes, label) {
  const bytes = Buffer.byteLength(String(text || ''), 'utf8');
  if (bytes > limitBytes) throw new Error(`${label} 响应过大（${bytes} > ${limitBytes} 字节），已丢弃`);
}

function assertSameOrigin(result, requestedUrl) {
  const finalUrl = result && result.finalUrl ? result.finalUrl : requestedUrl;
  try {
    if (new URL(finalUrl, LIVEBENCH_HOME).origin !== LIVEBENCH_ORIGIN) {
      throw new Error(`响应跳到非同源地址（${finalUrl}）`);
    }
  } catch (err) {
    if (err && /非同源/.test(err.message)) throw err;
    throw new Error(`无法校验响应来源（${finalUrl}）`);
  }
}

// LB-11：全局时间预算。deadline 由 fetchLivebench 注入，所有 fetch 前先检查；
// 单请求超时被夹在「剩余预算」内，且一律 retries:0 —— 保证整轮抓取最坏 ~45s（< 客户端 90s 超时）。
function budgetError() {
  return Object.assign(new Error('超出 LiveBench 时间预算'), { code: 'budget' });
}

function ensureBudget(deadline) {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw budgetError();
}

function budgetRemainingMs(deadline) {
  return Math.max(1, deadline - Date.now());
}

/**
 * 拉取一个 URL 文本：全局预算 + 单请求超时上限 + retries:0 + 流式大小上限（maxBytes）
 * + 同源校验 + HTML 嗅探；读后 assertTextSize 双保险。
 */
async function fetchChecked(fetchText, url, { limit, label, headers, expectMarkup = false, deadline }) {
  ensureBudget(deadline);
  const timeoutMs = Math.min(LIVEBENCH_LIMITS.requestTimeoutMs, budgetRemainingMs(deadline));
  const result = await fetchText(url, { headers: headers || {}, timeoutMs, retries: 0, maxBytes: limit });
  const text = typeof result === 'string' ? result : (result && result.text);
  if (typeof text !== 'string') throw new Error(`${label} 没有返回文本内容`);
  if (typeof result === 'object' && result) assertSameOrigin(result, url);
  assertTextSize(text, limit, label); // 双保险：传输层已按 maxBytes 中止，这里再校验一次
  if (!expectMarkup && (/^\s*<!doctype/i.test(text) || /<html[\s>]/i.test(text))) {
    throw new Error(`${label} 返回了 HTML（可能 404 或站点布局变化）`);
  }
  return text;
}

function releaseUrls(generation, releaseId) {
  if (generation === 'v1') {
    const suffix = String(releaseId || '').replace(/-/g, '_');
    return {
      table: `${LIVEBENCH_HOME}v1/table_${suffix}.csv`,
      categories: `${LIVEBENCH_HOME}v1/categories_${suffix}.json`,
      notes: null,
    };
  }
  return {
    table: `${LIVEBENCH_HOME}data/${releaseId}/table.csv`,
    categories: `${LIVEBENCH_HOME}data/${releaseId}/categories.json`,
    notes: `${LIVEBENCH_HOME}data/${releaseId}/notes.json`,
  };
}

function displayRelease(generation, releaseId) {
  if (generation === 'v1') return String(releaseId || '');
  const id = String(releaseId || '');
  return /^\d{8}$/.test(id) ? `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}` : id;
}

function pickRelease(releases) {
  if (releases && Array.isArray(releases.v2) && releases.v2.length) {
    return { generation: 'v2', id: releases.v2[releases.v2.length - 1] };
  }
  if (releases && Array.isArray(releases.v1) && releases.v1.length) {
    return { generation: 'v1', id: releases.v1[releases.v1.length - 1] };
  }
  return null;
}

/** 首页 → bundle → release 列表。任何一步失败抛错；多个同源脚本时依次尝试直到发现 release 数组。 */
async function discoverReleases(fetchText, deadline) {
  const html = await fetchChecked(fetchText, LIVEBENCH_HOME, { limit: LIVEBENCH_LIMITS.html, label: 'LiveBench 首页', expectMarkup: true, deadline });
  const bundleUrls = discoverBundleUrls(html).slice(0, LIVEBENCH_LIMITS.bundleCandidates);
  if (!bundleUrls.length) throw new Error('首页没找到同源 bundle 脚本（站点布局可能变化）');
  let lastError = null;
  for (const bundleUrl of bundleUrls) {
    ensureBudget(deadline);
    try {
      const bundle = await fetchChecked(fetchText, bundleUrl, { limit: LIVEBENCH_LIMITS.bundle, label: 'LiveBench bundle', deadline });
      const releases = parseBundleReleases(bundle);
      if (releases.v2.length || releases.v1.length) return releases;
      lastError = new Error('bundle 里没发现 release 数组（站点布局可能变化）');
    } catch (err) {
      if (err && err.code === 'budget') throw err; // 预算耗尽直接中止，不再试下一个脚本
      lastError = err; // 单个脚本失败/无版本信息：试下一个同源脚本
    }
  }
  throw lastError || new Error('bundle 里没发现 release 数组（站点布局可能变化）');
}

/** 抓取并解析一个 release 的 table + categories (+notes)。任何结构问题抛错（由上层回退/降级）。 */
async function fetchReleaseData(candidate, fetchText, log, deadline) {
  const urls = releaseUrls(candidate.generation, candidate.id);
  const tableText = await fetchChecked(fetchText, urls.table, { limit: LIVEBENCH_LIMITS.csv, label: 'table.csv', headers: { accept: 'text/csv,*/*' }, deadline });
  const categoriesText = await fetchChecked(fetchText, urls.categories, { limit: LIVEBENCH_LIMITS.json, label: 'categories.json', headers: { accept: 'application/json,*/*' }, deadline });
  const table = parseTableCsv(tableText);
  const parsedCategories = parseCategoriesJson(categoriesText);
  for (const warning of parsedCategories.warnings) log(`livebench: ${warning}`);

  // 类别声明的任务列必须都存在于 table 表头（v2 单列即类别列）；缺列 = 站点布局变化 → 本次失败保留旧数据
  const headerSet = new Set(table.header);
  for (const category of parsedCategories.categories) {
    const missing = category.tasks.filter((task) => !headerSet.has(task));
    if (missing.length) throw new Error(`类别「${category.name}」的任务列缺失（${missing.slice(0, 3).join(', ')}），站点布局可能变化`);
  }

  const rows = buildLivebenchRows(table, parsedCategories.categories, {
    requireAllCategories: candidate.generation === 'v1',
  });
  if (!rows.length) throw new Error('table.csv 里没有可用分数行');

  let notes = [];
  if (urls.notes) {
    try {
      const notesText = await fetchChecked(fetchText, urls.notes, { limit: LIVEBENCH_LIMITS.json, label: 'notes.json', headers: { accept: 'application/json,*/*' }, deadline });
      notes = parseNotesJson(notesText);
    } catch (err) {
      // 预算耗尽时也不为可选的 notes 拖垮已拿到的榜单数据
      log(`livebench: notes.json 读取失败（不影响榜单）：${shortError(err)}`);
    }
  }

  return {
    urls,
    rows,
    notes,
    categories: parsedCategories.categories.map((category) => ({
      key: category.key,
      name: category.name,
      weight: category.weight,
    })),
  };
}

/**
 * 抓取 LiveBench 能力榜。永不抛出：成功返回 { ok:true, data }，失败返回 { ok:false, error }。
 * 整轮抓取受全局时间预算（默认 45s）约束：超预算立即返回 { ok:false, error:'budget' }，
 * 保证刷新 RPC 最坏 < 60s，不会被 LiveBench 拖到分钟级。
 *
 * @param {object|null} prev 上一次成功的 snapshot.livebench（用于 releaseId 回退）；可为 null
 * @param {{ fetchText?: Function, log?: Function, budgetMs?: number }} options
 *   fetchText 与 pipeline.fetchText 同签名：(url, {headers,timeoutMs,retries,maxBytes}) => {text,finalUrl,status}（失败抛错）
 *   budgetMs 仅供测试注入（默认 LIVEBENCH_LIMITS.budgetMs）
 * @returns {Promise<{ok:true,data:object}|{ok:false,error:string}>}
 */
export async function fetchLivebench(prev, options = {}) {
  const fetchText = typeof options.fetchText === 'function' ? options.fetchText : defaultFetchText;
  const log = typeof options.log === 'function' ? options.log : () => {};
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs >= 0 ? options.budgetMs : LIVEBENCH_LIMITS.budgetMs;
  const deadline = Date.now() + budgetMs;
  const budgetFailure = () => ({ ok: false, error: 'budget' });
  try {
    ensureBudget(deadline);
    let release = null;
    let discoveryError = null;
    try {
      release = pickRelease(await discoverReleases(fetchText, deadline));
    } catch (err) {
      if (err && err.code === 'budget') return budgetFailure();
      discoveryError = err;
    }
    if (!release && prev && typeof prev.releaseId === 'string' && prev.releaseId) {
      release = { generation: prev.generation === 'v1' ? 'v1' : 'v2', id: prev.releaseId };
      log(`livebench: 版本发现失败，回退到上次 release ${release.id}`);
    }
    if (!release) {
      throw new Error(`版本发现失败（${discoveryError ? shortError(discoveryError) : '没有可用 release'}）`);
    }

    // release 已公布但数据未发布时，回退到上一个 releaseId（研究 §5.7）
    const candidates = [release];
    if (prev && typeof prev.releaseId === 'string' && prev.releaseId && prev.releaseId !== release.id) {
      candidates.push({ generation: prev.generation === 'v1' ? 'v1' : 'v2', id: prev.releaseId });
    }

    let used = null;
    let data = null;
    let lastError = null;
    for (const candidate of candidates) {
      try {
        data = await fetchReleaseData(candidate, fetchText, log, deadline);
        used = candidate;
        break;
      } catch (err) {
        if (err && err.code === 'budget') return budgetFailure();
        lastError = err;
        log(`livebench: release ${candidate.id} 数据不可用：${shortError(err)}`);
      }
    }
    if (!data || !used) throw lastError || new Error('拉取 LiveBench release 数据失败');

    const releaseLabel = displayRelease(used.generation, used.id);
    const result = {
      generation: used.generation,
      release: releaseLabel,
      releaseId: used.id,
      asOf: releaseLabel,
      source: {
        home: LIVEBENCH_HOME,
        table: data.urls.table,
        categories: data.urls.categories,
        notes: data.urls.notes,
      },
      overall: used.generation === 'v2' ? 'weighted-mean' : 'equal-mean',
      categories: data.categories,
      rows: data.rows,
      ranked: data.rows.length,
      notes: data.notes,
      stale: false,
      fetchedAt: nowIso(),
    };
    lastSuccess = result;
    return { ok: true, data: result };
  } catch (err) {
    // 超预算（含被夹在剩余预算内的请求超时）统一返回 error='budget'，调用方据此降级
    const budgetHit = (err && err.code === 'budget') || Date.now() >= deadline;
    return { ok: false, error: budgetHit ? 'budget' : shortError(err) };
  }
}
