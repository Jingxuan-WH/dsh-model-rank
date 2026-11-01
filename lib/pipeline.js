// dsh-model-rank · pipeline.js
// 纯数据管线：抓取（免 key 公开页面）→ 解析 → 归一化 → 与本机已接入模型匹配 → 合并快照。
// 不 import 任何 DSH 包；index.js（宿主半侧）与 scripts/build-snapshot.mjs（开发用）共用这里。

'use strict';

import { existsSync as fsExists, readFileSync as fsRead, readdirSync as fsReaddir } from 'node:fs';
import { join as joinPath } from 'node:path';
import { fetchLivebench, LIVEBENCH_HOME } from './livebench.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const PLUGIN_NAME = 'dsh-model-rank';
export const DEFAULT_REFRESH_MS = 24 * 60 * 60 * 1000;      // 成功后 24h 内不重抓
export const DEFAULT_RETRY_MS = 2 * 60 * 60 * 1000;         // 失败后 2h 再试
export const DEFAULT_MIN_GAP_MS = 10 * 60 * 1000;            // 手动"立即刷新"最小间隔
export const FETCH_TIMEOUT_MS = 30_000;
// P1-03：抓取重试策略集中定义，保证「刷新最坏耗时」可计算、可测试：
// 单请求超时 30s × (1+1 次尝试) + 1.5s 退避 ≈ 61.5s < 客户端 120s；Arena 与其他源同样只重试 1 次。
export const SOURCE_RETRY = { timeoutMs: FETCH_TIMEOUT_MS, defaultRetries: 1, arenaRetries: 1, backoffMs: 1_500 };

const OR_RANKINGS_URL = 'https://openrouter.ai/rankings';
const AA_MODELS_URL = 'https://artificialanalysis.ai/models';
// LMArena 官方 HF 数据集（cc-by-4.0，无 key）。
// 页面本体被 Cloudflare 挡（403），走 Hugging Face datasets-server 官方公开端点。
// 注意：datasets-server 的 /filter 端点自 2026-11-01 起对匿名请求恒返回
// 422「Parameter 'where' contains errors or invalid symbols」（连官方文档示例数据集也如此），
// 因此改用 /rows 分页 + 本地筛选：该 split 按分类成块排列，overall 块在最前面、
// 每页 100 行且按 rank 升序，翻到出现非 overall 行即停止。
const ARENA_ROWS_BASE =
  'https://datasets-server.huggingface.co/rows' +
  '?dataset=lmarena-ai%2Fleaderboard-dataset' +
  '&config=text_style_control' +
  '&split=latest';
export const ARENA_PAGE_SIZE = 100;
const ARENA_MAX_PAGES = 8;              // 最多翻 8 页（800 行）以统计 overall 总数，避免失控
export const ARENA_DISPLAY_ROWS = 50;   // 快照里保留的展示行数（Top N）
export const ARENA_BUDGET_MS = 40_000;  // Arena 源总预算，保证刷新最坏耗时仍小于客户端超时

/** LMArena /rows 分页 URL（offset 从 0 开始、每页 100 行；可被测试断言） */
export function arenaRowsUrl(offset = 0) {
  return `${ARENA_ROWS_BASE}&offset=${encodeURIComponent(String(offset))}&length=${ARENA_PAGE_SIZE}`;
}

const BROWSER_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
};

// OpenRouter 页面表格 → 榜单分类（按最近出现的标题文本区分 today/month/trending/weekly；
// marketShare 用表头列识别）。P1-08：weekly 增加 heading 兜底，不再只依赖「tokens processed」表头。
const OR_HEADING_HINTS = [
  [/top models today/i, 'today'],
  [/top models this month/i, 'month'],
  [/new and trending models this week/i, 'trending'],
  [/top models this week/i, 'weekly'],
];

export const AUTHOR_DISPLAY = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  'google-deepmind': 'Google',
  deepseek: 'DeepSeek',
  'z-ai': 'Z.ai',
  zhipu: 'Zhipu AI',
  alibaba: 'Alibaba',
  qwen: 'Alibaba',
  moonshot: 'Moonshot AI',
  moonshotai: 'Moonshot AI',
  minimax: 'MiniMax',
  xiaomi: 'Xiaomi',
  tencent: 'Tencent',
  meituan: 'Meituan',
  'x-ai': 'xAI',
  meta: 'Meta',
  mistral: 'Mistral AI',
  'mistral-ai': 'Mistral AI',
  nvidia: 'NVIDIA',
  stepfun: 'StepFun',
  bytedance: 'ByteDance',
  baidu: 'Baidu',
  microsoft: 'Microsoft',
  ai21: 'AI21',
  reka: 'Reka',
  cohere: 'Cohere',
  'liquid': 'Liquid AI',
  particlearmax: 'Particle',
};

// 模型家族前缀 → 机构键（用于把"本机接入的哪家"与 OpenRouter 份额榜对上）。
const FAMILY_TOKENS = [
  [/^(claude|fable|haiku|opus|sonnet)/, 'anthropic'],
  [/^(gpt|o[1-9]($|-))/, 'openai'],
  [/^(gemini)/, 'google'],
  [/^(deepseek)/, 'deepseek'],
  [/^(glm)/, 'zhipu'],
  [/^(qwen)/, 'alibaba'],
  [/^(kimi)/, 'moonshot'],
  [/^(minimax)/, 'minimax'],
  [/^(mimo)/, 'xiaomi'],
  [/^(hy)\d/, 'tencent'],
  [/^(longcat)/, 'meituan'],
  [/^(grok)/, 'xai'],
  [/^(nemotron)/, 'nvidia'],
  [/^(mistral|magistral)/, 'mistral'],
  [/^(muse|spark)/, 'meta'],
  [/^(step)/, 'stepfun'],
  [/^(doubao)/, 'bytedance'],
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function nowIso() {
  return new Date().toISOString();
}

export function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch { /* 老运行时继续走手动定时器 */ }
  return undefined;
}

/** 超限响应的错误标记：调用方据此不重试、并把「过大」透传成可读原因。 */
function tooLargeError(message) {
  return Object.assign(new Error(message), { code: 'response_too_large' });
}

/**
 * 在 maxBytes 内读取响应体（LB-12：不再「读完再量」，避免恶意/异常大响应撑爆宿主内存）。
 * 1) 有 Content-Length 且超限 → 立即 cancel，不读 body；
 * 2) 否则流式累计，超过上限立刻 cancel 并抛错；
 * 3) 运行时没有流式 body 时退化为「读完再量」（仍有上限校验）。
 * @returns {Promise<string>}
 */
async function readBodyLimited(res, maxBytes) {
  const declared = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch { /* noop */ }
    throw tooLargeError(`响应过大（Content-Length ${declared} > ${maxBytes} 字节），已中止读取`);
  }
  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    if (Buffer.byteLength(String(text || ''), 'utf8') > maxBytes) throw tooLargeError(`响应超过大小上限（> ${maxBytes} 字节），已丢弃`);
    return text;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value && typeof value.byteLength === 'number' ? value.byteLength : 0;
    if (total > maxBytes) {
      try { await reader.cancel('response too large'); } catch { /* noop */ }
      throw tooLargeError(`响应超过大小上限（> ${maxBytes} 字节），已中止读取`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 抓取一个 URL，超时与 403/5xx 各重试一次。返回 { text, finalUrl, status } 或抛错。
 * options.maxBytes：响应体上限（配合 Content-Length 预检 + 流式中止，超限不重试）。
 */
export async function fetchText(url, { headers, timeoutMs = FETCH_TIMEOUT_MS, retries = 1, maxBytes = null } = {}) {
  const merged = { ...BROWSER_HEADERS, ...(headers || {}) };
  const byteLimit = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : null;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: merged, redirect: 'follow', signal: timeoutSignal(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = byteLimit === null ? await res.text() : await readBodyLimited(res, byteLimit);
      return { text, finalUrl: res.url || url, status: res.status };
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'response_too_large') throw err; // 超限不重试（重试只会再下载一次）
      if (attempt < retries) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

// 归一化匹配键：NFKC + 小写 + 去括注 + 只保留 Unicode 字母/数字 + 去尾部 contributor。
// P1-04/P1-18：旧实现只保留 [a-z0-9]，CJK 模型名会退化成空串（漏匹配）或只剩共同后缀（误匹配）；
// \p{L}/\p{N} 用 RegExp 字符串构造，运行时支持属性类即保留中日韩文字，否则回退常见 CJK 区段。
const UNICODE_STRIP_RE = (() => {
  try { return new RegExp('[^\\p{L}\\p{N}]+', 'gu'); } catch { /* older engines */ }
  return /[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g;
})();
export function normalizeKey(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(UNICODE_STRIP_RE, '')
    .replace(/contributor$/, '');
}

/**
 * 去掉公开榜单模型名常见的「版本 / 日期 / 渠道」后缀，便于跨源匹配。
 * 例：claude-sonnet-4-5-20250929 → claude-sonnet-4-5；deepseek-v4.1-flash-1017 → deepseek-v4.1-flash。
 */
function stripModelAliasSuffix(value) {
  return String(value || '')
    .replace(/[-_.]?(?:20\d{6}|\d{8})$/i, '')
    .replace(/[-_.]?\d{4}[-_.]\d{2}[-_.]\d{2}$/, '')
    .replace(/[-_.]?\d{4}$/, '') // 形如 -1017 / -0613 的「月日」式版本尾缀（LiveBench 常见）
    .replace(/[-_.]?(?:latest|preview|beta|free|nitro|exp)$/i, '')
    .replace(/[-_.]v\d+(?:[._]\d+)*$/i, '');
}

/**
 * 模型名 → 一组归一化匹配键：原值 / 去 provider 前缀（`vendor/model`）/ 去渠道后缀（`:free`）/
 * 再去日期版本后缀。AA、OpenRouter、Arena、LiveBench、本机清单统一用这一套口径（usage.js 也复用）。
 * @returns {string[]} 归一化后的匹配键（去重、按优先级排序）
 */
export function aliasKeys(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return [];
  const keys = new Set();
  const add = (value) => {
    const key = normalizeKey(value);
    if (key) keys.add(key);
  };
  const slashTail = text.includes('/') ? text.slice(text.lastIndexOf('/') + 1) : text;
  const colonTail = slashTail.includes(':') ? slashTail.slice(0, slashTail.indexOf(':')) : slashTail;
  for (const variant of [text, slashTail, colonTail]) {
    add(variant);
    add(stripModelAliasSuffix(variant));
  }
  return [...keys];
}

/** 用户模型 id / name → 机构键（用于"份额榜里哪些厂商我接了"）。 */
export function familyOfUserModel(text) {
  const t = String(text || '').toLowerCase();
  for (const [re, org] of FAMILY_TOKENS) if (re.test(t)) return org;
  return null;
}

export function authorOrgKey(author) {
  const raw = String(author || '').toLowerCase().trim();
  return canonicalOrgOfAuthor(raw);
}

// 机构名 → 家族键（与 familyOfUserModel 的输出同域）。同时按「原始」与「紧凑」两种写法注册，
// 因为榜单作者名可能是 Z.ai / Z AI / z-ai / zai，归一化后都落到 zhipu。
const ORG_CANONICAL = {
  anthropic: 'anthropic', openai: 'openai', google: 'google', 'google-deepmind': 'google', googledeepmind: 'google',
  deepseek: 'deepseek', 'z-ai': 'zhipu', zai: 'zhipu', zhipu: 'zhipu', alibaba: 'alibaba', qwen: 'alibaba',
  moonshot: 'moonshot', moonshotai: 'moonshot', minimax: 'minimax', xiaomi: 'xiaomi',
  tencent: 'tencent', meituan: 'meituan', 'x-ai': 'xai', xai: 'xai', meta: 'meta', mistral: 'mistral',
  'mistral-ai': 'mistral', mistralai: 'mistral', nvidia: 'nvidia', stepfun: 'stepfun', bytedance: 'bytedance',
  baidu: 'baidu', microsoft: 'microsoft', ai21: 'ai21', reka: 'reka', cohere: 'cohere', liquid: 'liquid',
  liquidai: 'liquid', kimi: 'moonshot', 'moonshot-ai': 'moonshot', openrouter: 'openrouter',
};

function canonicalOrgOfAuthor(author) {
  const raw = String(author || '').toLowerCase().trim();
  const compact = raw.replace(/[^a-z0-9]/g, '');
  if (ORG_CANONICAL[raw]) return ORG_CANONICAL[raw];
  if (ORG_CANONICAL[compact]) return ORG_CANONICAL[compact];
  return compact;
}

// 作者/机构展示名：先按原始串（小写）查，再按紧凑串查（Google DeepMind → Google），最后回退原值。
const AUTHOR_DISPLAY_COMPACT = Object.fromEntries(
  Object.entries(AUTHOR_DISPLAY).map(([key, value]) => [key.replace(/[^a-z0-9]/g, ''), value]),
);
function authorDisplayOf(author) {
  const raw = String(author || '').trim();
  if (!raw) return '';
  return AUTHOR_DISPLAY[raw.toLowerCase()] || AUTHOR_DISPLAY_COMPACT[normalizeKey(raw)] || raw;
}

/** 任意 provider/model 清单 → 家族键列表（去重） */
export function userOrgs(userModels) {
  const set = new Set();
  for (const um of userModels || []) {
    const org = familyOfUserModel(`${um.id || ''} ${um.name || ''}`);
    if (org) set.add(org);
  }
  return [...set];
}

// ---------------------------------------------------------------------------
// OpenRouter rankings 解析（SSR HTML，2026-11 实测结构）
// ---------------------------------------------------------------------------

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 提取所有 or-table 并返回 { header, rows, index }（thead 一律剔除，避免表头行混进数据行）
 *  P1-08：行 class 放宽为「包含 or-table__row」（站点可能追加 or-table__row--top 等修饰类）；
 *  注意只作为兜底，真正校验交给下方列映射（列错位会被跳过而不是产生垃圾行）。 */
function extractOrTables(html) {
  const tables = [];
  const re = /<table[\s\S]*?<\/table>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const seg = m[0].replace(/<thead[\s\S]*?<\/thead>/g, '');
    const rowHtmls = [...seg.matchAll(/<tr[^>]*\bclass="[^"]*\bor-table__row\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/g)]
      .map((r) => r[1]);
    const rows = rowHtmls.map((row) => {
      const parts = [...row.matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/g)].map((c) => stripTags(c[1]));
      return parts;
    });
    const header = [...m[0].matchAll(/<th[^>]*class="or-table__header-cell[^"]*"[^>]*>([\s\S]*?)<\/th>/g)].map((h) => stripTags(h[1]));
    tables.push({ index: m.index, rows, header });
  }
  return tables;
}

function headerSignature(table) {
  return table.header.map((h) => h.toLowerCase()).join('|');
}

// P1-07/P1-08：OpenRouter 表格一律「按表头列名」定位字段，不再按列位硬编码取值。
const OR_COLUMN_MATCHERS = {
  rank: [/^#\s*$/, /^rank$/i, /^#/],
  model: [/^model/i, /^name$/i],
  author: [/^author/i, /creator/i, /^provider$/i],
  tokens: [/tokens?\s*(processed|used)?/i, /^tokens$/i],
  change: [/^change$/i, /^delta$/i, /^Δ$/i, /trend/i],
  share: [/share\s*of\s*requests/i, /^share$/i],
};
function mapOrColumns(header) {
  const map = {};
  (Array.isArray(header) ? header : []).forEach((raw, index) => {
    const text = String(raw || '').trim();
    if (!text) return;
    for (const [key, patterns] of Object.entries(OR_COLUMN_MATCHERS)) {
      if (map[key] != null) continue;
      if (patterns.some((re) => re.test(text))) { map[key] = index; break; }
    }
  });
  return map;
}
function orCell(row, map, key) {
  const index = map[key];
  if (index == null || !Array.isArray(row) || index >= row.length) return '';
  const value = row[index];
  return value == null ? '' : String(value);
}
/** 是否为市场份额表：有 author + share，且没有 model 列（避免把模型表误判为份额表）。 */
function isMarketShareTable(table) {
  const map = mapOrColumns(table.header);
  return map.author != null && map.share != null && map.model == null;
}
/** 是否为可解析的模型榜表（有 model 列；tokens/change/author 至少其一）。 */
function isModelRankTable(table) {
  const map = mapOrColumns(table.header);
  return map.model != null && (map.tokens != null || map.change != null || map.author != null);
}

/** 从 HTML 里抽出 JSON-LD ItemList（name → permaslug） */
function extractJsonLdSlugs(html) {
  const map = new Map();
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        if (item && item.itemListElement && Array.isArray(item.itemListElement)) {
          for (const el of item.itemListElement) {
            if (el && el.name && el.item && typeof el.item === 'string') {
              const slug = String(el.item).split('/').filter(Boolean).slice(-2).join('/');
              if (slug) map.set(normalizeKey(el.name), slug);
            }
          }
        }
      }
    } catch { /* 忽略解析失败的 JSON-LD */ }
  }
  return map;
}

function parseChange(text) {
  const t = stripTags(text);
  if (!t) return null;
  if (/^new$/i.test(t)) return { kind: 'new' };
  // P1-11：兼容 ▲/▼/↑/↓/U+2212 等 Unicode 箭头；方向与百分比分开解析，解析不出百分比给 null（不产生 NaN）。
  const isDown = /^[\s\-−▼↓]/.test(t) || /[▼↓]/.test(t);
  const isUp = /^[\s+＋▲↑]/.test(t) || /[▲↑]/.test(t);
  const matched = t.match(/([\d][\d.,]*)/);
  const pct = matched ? parseFloat(matched[1].replace(/,/g, '')) : null;
  const pctOut = Number.isFinite(pct) ? pct : null;
  if (isDown) return { kind: 'down', pct: pctOut };
  if (isUp) return { kind: 'up', pct: pctOut };
  if (pctOut != null) return { kind: 'up', pct: pctOut };
  return null;
}

function parseTokens(text) {
  const t = stripTags(text).replace(/\s*tokens?\s*$/i, '').trim();
  const mult = { B: 1e9, T: 1e12, M: 1e6, K: 1e3 };
  const m = t.match(/^([\d.]+)\s*([BTKM])$/i) || t.match(/^([\d.]+)([btkm])$/i);
  if (m) return { label: `${m[1]}${m[2].toUpperCase()}`, value: parseFloat(m[1]) * mult[m[2].toUpperCase()] };
  return { label: t, value: null };
}

/** 解析 openrouter.ai/rankings SSR HTML → 归一化 usage 数据
 *  P1-07/P1-08：按表头列名映射字段（不再按列位硬编码），列数不符的行跳过；
 *  weekly 先按 heading（Top models this week）识别，再回退到「第一个未使用的 token 榜表」。 */
export function parseOpenRouterRankings(html) {
  const out = { asOf: null, weekly: [], today: [], month: [], trending: [], marketShare: [] };
  const asOf = html.match(/Usage data through[\s\S]{0,120}?([A-Z][a-z]+ \d{1,2}, \d{4})/);
  if (asOf) out.asOf = asOf[1];

  const slugMap = extractJsonLdSlugs(html);
  const tables = extractOrTables(html);
  const used = new Set();

  /** 按表头列名解析模型榜行；列数漂移/缺 model 的行直接跳过（宁缺勿错位）。 */
  function parseRankTable(table) {
    const map = mapOrColumns(table.header);
    const list = [];
    for (const row of table.rows) {
      if (!Array.isArray(row) || !table.header.length || row.length !== table.header.length) continue;
      const model = orCell(row, map, 'model').trim();
      if (!model) continue;
      const author = orCell(row, map, 'author').trim();
      list.push({
        rank: parseInt(orCell(row, map, 'rank'), 10) || list.length + 1,
        model,
        slug: slugMap.get(normalizeKey(model)) || null,
        authorKey: canonicalOrgOfAuthor(author),
        authorDisplay: authorDisplayOf(author),
        tokens: parseTokens(orCell(row, map, 'tokens')),
        change: parseChange(orCell(row, map, 'change')),
      });
    }
    return list;
  }

  // 1) 先按 heading 分类 today / month / trending / weekly
  for (let i = 0; i < tables.length; i += 1) {
    if (used.has(i)) continue;
    const before = html.slice(Math.max(0, tables[i].index - 5000), tables[i].index);
    let kind = null;
    for (const [rx, key] of OR_HEADING_HINTS) if (rx.test(before)) kind = key;
    if (!kind || !isModelRankTable(tables[i])) continue;
    const list = parseRankTable(tables[i]);
    if (list.length) {
      out[kind] = list;
      used.add(i);
    }
  }

  // 2) weekly 兜底：没有 heading 时，取第一个未被使用的模型榜表（通常是 tokens processed 表）
  if (!out.weekly.length) {
    for (let i = 0; i < tables.length; i += 1) {
      if (used.has(i) || !isModelRankTable(tables[i])) continue;
      const list = parseRankTable(tables[i]);
      if (list.length) {
        out.weekly = list;
        used.add(i);
        break;
      }
    }
  }

  // 3) 市场份额：author + share 列（无 model 列），同样按列名取值
  for (let i = 0; i < tables.length; i += 1) {
    if (!isMarketShareTable(tables[i])) continue;
    const map = mapOrColumns(tables[i].header);
    for (const row of tables[i].rows) {
      if (!Array.isArray(row) || row.length !== tables[i].header.length) continue;
      const author = orCell(row, map, 'author').trim();
      if (!author) continue;
      out.marketShare.push({
        rank: parseInt(orCell(row, map, 'rank'), 10) || out.marketShare.length + 1,
        author,
        authorKey: canonicalOrgOfAuthor(author),
        share: orCell(row, map, 'share'),
        change: parseChange(orCell(row, map, 'change')),
      });
    }
  }

  if (!out.weekly.length && !out.marketShare.length) {
    throw new Error('openrouter: 未在页面里解析出任何榜单表格（页面结构可能变化）');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Artificial Analysis models 页面解析（flight 数据，免 key，2026-11 实测结构）
// ---------------------------------------------------------------------------

function decodeFlight(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,\s*"((?:[^"\\]|\\.)*)"\]\)/g)];
  let flight = '';
  for (const c of chunks) {
    try {
      flight += JSON.parse(`"${c[1]}"`);
    } catch { /* 单片损坏就跳过该片段 */ }
  }
  return flight;
}

/** 用括号配对把 "initialModels":[...] 的对象逐个取出并 JSON.parse
 *  P1-10：兼容 `"initialModels": [`（冒号后带空白）；单个对象解析失败不拖累其它对象；
 *  上限放宽到 5000（AA 模型数增长时不静默截断）。 */
function extractModelsArray(flight) {
  const match = flight.match(/"initialModels"\s*:\s*\[/);
  if (!match || match.index == null) return null;
  let cursor = flight.indexOf('[', match.index) + 1;
  const models = [];
  for (let guard = 0; guard < 5000; guard++) {
    const objStart = flight.indexOf('{', cursor);
    const arrEnd = flight.indexOf(']', cursor);
    if (objStart < 0 || (arrEnd >= 0 && objStart > arrEnd)) break;
    let depth = 0, pos = objStart, inStr = false, esc = false;
    for (; pos < flight.length; pos++) {
      const ch = flight[pos];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) break; }
    }
    const objStr = flight.slice(objStart, pos + 1);
    try {
      models.push(JSON.parse(objStr));
    } catch {
      // 单对象解析失败：跳过这一个继续
    }
    cursor = pos + 1;
  }
  return models.length ? models : null;
}

/** AA 模型对象 → 插件行 */
function projectAaModel(m) {
  const ts = m.timescaleData || {};
  const speed = { tokensPerSec: null, ttftMs: null };
  if (typeof ts.medianOutputSpeed === 'number') speed.tokensPerSec = Math.round(ts.medianOutputSpeed * 10) / 10;
  const medium = (m.performanceByPromptType || {}).medium || {};
  if (typeof medium.medianTimeToFirstAnswerToken === 'number') speed.ttftMs = Math.round(medium.medianTimeToFirstAnswerToken);
  else if (typeof ts.medianTimeToFirstChunk === 'number') speed.ttftMs = Math.round(ts.medianTimeToFirstChunk);

  const price = {
    input: m.price1mInputTokens ?? null,
    output: m.price1mOutputTokens ?? null,
    cacheHit: m.cacheHitPrice ?? null,
    blended31: m.price1mBlended0To3To1 ?? null,
    blended21: m.price1mBlended7To2To1 ?? null,
    blended11: m.price1mBlended0To1To1 ?? null,
  };

  const caps = m.capabilities || {};
  const mods = {
    text: m.outputModalityText !== false,
    image: m.outputModalityImage === true,
    speech: m.outputModalitySpeech === true,
    video: m.outputModalityVideo === true,
  };

  return {
    slug: m.slug || null,
    name: m.name || m.shortName || null,
    suffix: m.suffix || null,
    provider: (m.creator && (m.creator.name || m.creator.slug)) || null,
    providerKey: normalizeKey((m.creator && (m.creator.slug || m.creator.name)) || ''),
    effort: (m.effort && (m.effort.label || null)) || null,
    intelligence: typeof m.intelligenceIndex === 'number'
      ? Math.round(m.intelligenceIndex * 10) / 10
      : null,
    intelligenceEstimated: m.intelligenceIndexIsEstimated === true,
    releasedOn: m.releaseDate || null,
    isReasoning: m.isReasoning === true,
    openWeights: m.isOpenWeights === true,
    parametersB: typeof m.parameters === 'number' ? m.parameters : null,
    activeParamsB: typeof m.inferenceParametersActiveBillions === 'number' ? m.inferenceParametersActiveBillions : null,
    contextTokens: typeof m.contextWindowTokens === 'number' ? m.contextWindowTokens : null,
    licenseName: m.licenseName || null,
    price,
    speed,
    costPerTask: (() => {
      const c = m.intelligenceIndexCostPerTask && m.intelligenceIndexCostPerTask.cost;
      return typeof (c && c.total) === 'number' ? Math.round(c.total * 100) / 100 : null;
    })(),
    benchmarks: {
      gdpval: typeof m.gdpval === 'number' ? Math.round(m.gdpval) : null,
      terminalBench: m.terminalBench40 != null ? Math.round(m.terminalBench40 * 100) / 100 : null,
      frontierCode: m.frontierCode != null ? Math.round(m.frontierCode * 100) / 100 : null,
      hle: m.hle != null ? Math.round(m.hle * 100) / 100 : null,
      livecodebench: m.livecodebench != null ? Math.round(m.livecodebench * 100) / 100 : null,
      aime25: m.aime25 != null ? Math.round(m.aime25 * 100) / 100 : null,
      gpqa: m.gpqa != null ? Math.round(m.gpqa * 100) / 100 : null,
    },
    modalities: mods,
  };
}

export function parseAaModelsHtml(html) {
  const flight = decodeFlight(html);
  if (!flight) throw new Error('aa: 页面里没有 Next flight 数据');
  const raw = extractModelsArray(flight);
  if (!raw) throw new Error('aa: 没找到 initialModels 数据');
  const rows = raw.filter((m) => m && m.slug && typeof m.intelligenceIndex === 'number').map(projectAaModel);
  rows.sort((a, b) => (b.intelligence ?? -1) - (a.intelligence ?? -1));
  rows.forEach((row, i) => { row.rank = i + 1; });
  if (!rows.length) throw new Error('aa: initialModels 里没有可用模型');
  // P1-10：尽量从页面里读数据更新时间（字段名随 AA 部署可能变化，读不到就 null，不抛错）
  const asOfMatch = html.match(/"(?:updatedAt|lastUpdatedAt|lastUpdated|updated_at)"\s*:\s*"(\d{4}-\d{2}-\d{2}[^"]*)"/);
  return { asOf: asOfMatch ? asOfMatch[1] : null, models: rows };
}

// ---------------------------------------------------------------------------
// LMArena（官方 HF 数据集）解析
// ---------------------------------------------------------------------------

/** datasets-server /filter 返回 {num_rows_total, num_rows, features, rows:[{row:{...}}]} */
export function parseArenaRows(payload) {
  const dataRows = Array.isArray(payload && payload.rows) ? payload.rows : null;
  if (!dataRows || !dataRows.length) throw new Error('arena: datasets-server 返回里没有 rows');
  const rows = [];
  for (const item of dataRows) {
    const r = item && item.row;
    if (!r || typeof r !== 'object') continue;
    const rating = typeof r.rating === 'number' ? r.rating : null;
    if (rating == null) continue;
    rows.push({
      rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : null,
      model: String(r.model_name || ''),
      orgKey: canonicalOrgOfAuthor(r.organization || ''),
      orgDisplay: authorDisplayOf(r.organization || ''),
      rating: Math.round(rating * 10) / 10,
      ratingLower: typeof r.rating_lower === 'number' ? Math.round(r.rating_lower * 10) / 10 : null,
      ratingUpper: typeof r.rating_upper === 'number' ? Math.round(r.rating_upper * 10) / 10 : null,
      votes: typeof r.vote_count === 'number' ? r.vote_count : null,
      publishedOn: typeof r.leaderboard_publish_date === 'string' ? r.leaderboard_publish_date : null,
    });
  }
  if (!rows.length) throw new Error('arena: rows 里没有可用模型行');
  rows.sort((a, b) => (b.rating ?? -1) - (a.rating ?? -1));
  rows.forEach((row, i) => { if (row.rank == null) row.rank = i + 1; });
  // P2-34：asOf 取最新发布日期（不是排序后第一行的日期）
  const publishDates = rows.map((r) => r.publishedOn).filter(Boolean).sort();
  const asOf = publishDates.length ? publishDates[publishDates.length - 1] : null;
  const totalModels = typeof payload.num_rows_total === 'number' ? payload.num_rows_total : rows.length;
  return { asOf, totalModels, rows };
}

/**
 * 抓取 LMArena overall 分类行（datasets-server /rows 分页，替代失效的 /filter）。
 * 语义：
 *   - 该 split 按分类成块排列、overall 块在最前、每页按 rank 升序，所以从 offset=0 开始翻页，
 *     一旦某页出现非 overall 行即停止（分类块结束）；
 *   - totalModels = 累计统计到的 overall 行数（而不是整份 split 的行数）；
 *   - 快照只保留前 ARENA_DISPLAY_ROWS 行，控制体积；
 *   - 首屏失败直接抛错（由 fetchSources 标记该源失败、保留旧数据）；
 *     后续页失败/超预算则用已收集到的行降级（不把已成功的首屏丢掉）。
 * @param {(url:string, opts?:object)=>Promise<{text:string}>} fetchTextImpl 可注入的 fetchText，便于离线测试
 */
export async function fetchArenaOverall(fetchTextImpl, { log = () => {} } = {}) {
  const deadline = Date.now() + ARENA_BUDGET_MS;
  const collected = [];
  let totalOverall = 0;
  let sawNonOverall = false;
  for (let page = 0; page < ARENA_MAX_PAGES; page++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      log('arena: 分页统计超出时间预算，使用已收集行');
      break;
    }
    const offset = page * ARENA_PAGE_SIZE;
    const reqTimeout = Math.max(2_000, Math.min(page === 0 ? SOURCE_RETRY.timeoutMs : 10_000, remaining));
    const retries = page === 0 ? SOURCE_RETRY.arenaRetries : 1; // 后续页也重试一次，但超时更短（预算内）
    let payload;
    try {
      const { text } = await fetchTextImpl(arenaRowsUrl(offset), {
        headers: { accept: 'application/json' },
        retries,
        timeoutMs: reqTimeout,
      });
      payload = JSON.parse(text);
    } catch (err) {
      if (page === 0) throw err; // 首屏失败：整源失败，交给上层保留旧快照
      log(`arena: 第 ${page + 1} 页失败（${err && err.message}），使用已收集行`);
      break;
    }
    const pageRows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    if (!pageRows.length) break;
    let pageOverall = 0;
    for (const item of pageRows) {
      const r = item && item.row;
      if (!r || typeof r !== 'object') continue;
      if (r.category !== 'overall') continue;
      pageOverall += 1;
      totalOverall += 1;
      if (collected.length < ARENA_DISPLAY_ROWS) collected.push(item);
    }
    if (pageOverall < pageRows.length) {
      sawNonOverall = true;
      break;
    }
  }
  if (!collected.length) throw new Error('arena: /rows 分页里没有 overall 行');
  const data = parseArenaRows({ rows: collected, num_rows_total: totalOverall });
  if (!sawNonOverall) data.totalModelsIsLowerBound = true; // 翻满页仍未见分类块结束：总数是下界
  return data;
}


// ---------------------------------------------------------------------------
// 本机已接入模型（读 profiles/*/cordis.patch.yml）
// ---------------------------------------------------------------------------

async function loadYamlParse() {
  for (const name of ['yaml', 'js-yaml']) {
    try {
      const mod = await import(name);
      if (name === 'yaml' && typeof mod.parse === 'function') return mod.parse;
      if (name === 'js-yaml' && typeof (mod.default && mod.default.load) === 'function') return mod.default.load;
    } catch { /* 尝试下一个 */ }
  }
  return null;
}

/**
 * 读取 DSH home 下所有 profile 的 cordis.patch.yml，收集 llm-pi-ai providers 里的模型，
 * 以及 agent-default-model 的默认配置。
 * 返回 { models: [{provider, providerDisplay, id, name}], providers: [{name, display, models:[{id,name}]}], default }
 */
export async function readUserModelInventory(dshHome) {
  const result = { models: [], providers: [], default: null };
  const providerMap = new Map(); // name → {name, display, models: Map(id → {id,name})}
  let yamlParse = await loadYamlParse();
  if (!yamlParse) return result;

  let profilesDir = dshHome ? joinPath(dshHome, 'profiles') : null;
  if (!profilesDir || !fsExists(profilesDir)) return result;

  let entries;
  try {
    entries = fsReaddir(profilesDir);
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    const file = joinPath(profilesDir, entry, 'cordis.patch.yml');
    let text;
    try {
      text = fsRead(file, 'utf8');
    } catch {
      continue;
    }
    let doc;
    try {
      doc = yamlParse(text);
    } catch {
      continue;
    }
    if (!Array.isArray(doc)) continue;
    for (const row of doc) {
      if (!row || typeof row !== 'object') continue;
      const name = typeof row.name === 'string' ? row.name : '';
      if (/(^|\/*)dsh-llm-pi-ai$/.test(name) || name.endsWith('dsh-llm-pi-ai')) {
        const providers = row.config && row.config.providers;
        if (providers && typeof providers === 'object') {
          for (const [provKey, prov] of Object.entries(providers)) {
            if (!prov || typeof prov !== 'object') continue;
            const display = typeof prov.displayName === 'string' ? prov.displayName : provKey;
            if (!providerMap.has(provKey)) providerMap.set(provKey, { name: provKey, display, models: new Map() });
            const models = Array.isArray(prov.models) ? prov.models : [];
            for (const model of models) {
              if (!model || typeof model !== 'object' || typeof model.id !== 'string') continue;
              result.models.push({
                provider: provKey,
                providerDisplay: display,
                id: model.id,
                name: typeof model.name === 'string' ? model.name : model.id,
              });
              providerMap.get(provKey).models.set(model.id, {
                id: model.id,
                name: typeof model.name === 'string' ? model.name : model.id,
              });
            }
          }
        }
      }
      if (name.endsWith('dsh-agent-default-model')) {
        const cfg = row.config;
        if (cfg && typeof cfg.provider === 'string' && typeof cfg.model === 'string') {
          result.default = { provider: cfg.provider, model: cfg.model };
        }
      }
    }
  }
  // 去重（同一 provider+id 可能因多个 profile 重复）
  const seen = new Set();
  result.models = result.models.filter((m) => {
    const key = `${m.provider}::${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  // providers 汇总：把 providerMap 转成数组（models Map → 数组）
  result.providers = [...providerMap.values()].map((p) => ({
    name: p.name,
    display: p.display,
    models: [...p.models.values()],
  }));
  return result;
}

// fs helpers（文件顶部统一 import；此处仅注释）

// ---------------------------------------------------------------------------
// 匹配：给榜单行打上"本机已接入"标记
// ---------------------------------------------------------------------------

// P1-18：本机清单与各榜单统一用 aliasKeys 建立/查询匹配索引（去 provider 前缀/渠道后缀/日期版本后缀）。
function buildLocalIndex(userInv) {
  const keys = new Map(); // normalizeKey → {provider, providerDisplay, id}
  const add = (key, value) => { if (key && !keys.has(key)) keys.set(key, value); };
  for (const m of userInv.models || []) {
    const value = { provider: m.provider, providerDisplay: m.providerDisplay, id: m.id };
    for (const raw of [m.id, m.name]) {
      for (const key of aliasKeys(raw)) add(key, value);
    }
  }
  return keys;
}

/** 在 localIndex 中查找一个模型别名（自动展开 aliasKeys），返回 {provider, providerDisplay, id} 或 null */
function findLocal(localIndex, ...aliases) {
  for (const alias of aliases) {
    if (!alias) continue;
    for (const key of aliasKeys(alias)) {
      const hit = localIndex.get(key);
      if (hit) return hit;
    }
  }
  return null;
}

function findDefaultLocal(userInv, localIndex, ...aliases) {
  if (!userInv.default) return false;
  const { provider, model } = userInv.default;
  for (const a of aliases) {
    const k = normalizeKey(a);
    if (normalizeKey(model) === k) {
      // provider 也对上才高亮"默认"；名称相同 provider 不同只标记已接入
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// 快照构建
// ---------------------------------------------------------------------------

/**
 * 抓取四类源并归一化；一个失败不影响其他。
 * 传入 options.prev（上一次快照）时，LiveBench 可用上一次的 releaseId 做版本发现失败的兜底。
 * @returns { snapshotParts, sources }
 */
export async function fetchSources(options = {}) {
  const log = typeof options.log === 'function' ? options.log : () => {};
  const prevLivebench = options.prev && typeof options.prev === 'object' && options.prev.livebench
    ? options.prev.livebench
    : null;

  const orTask = fetchText(OR_RANKINGS_URL)
    .then(({ text }) => ({ ok: true, data: parseOpenRouterRankings(text) }))
    .catch((err) => {
      log(`openrouter 抓取失败: ${err && err.message}`);
      return { ok: false, error: String((err && err.message) || err) };
    });

  const aaTask = fetchText(AA_MODELS_URL)
    .then(({ text }) => ({ ok: true, data: parseAaModelsHtml(text) }))
    .catch((err) => {
      log(`artificialanalysis 抓取失败: ${err && err.message}`);
      return { ok: false, error: String((err && err.message) || err) };
    });

  // LMArena：/rows 分页（/filter 自 2026-11-01 起匿名恒 422）；独立 catch，失败保留旧快照
  const arenaTask = fetchArenaOverall(fetchText, { log })
    .then((data) => ({ ok: true, data }))
    .catch((err) => {
      log(`lmarena 抓取失败: ${err && err.message}`);
      return { ok: false, error: String((err && err.message) || err) };
    });

  // LiveBench 2.0：首页 → bundle 版本发现 → 官方 CSV；独立 catch，失败不影响其它三源
  const livebenchTask = fetchLivebench(prevLivebench, { fetchText, log })
    .then((result) => {
      if (!result.ok) {
        log(`livebench 抓取失败: ${result.error}`);
        return { ok: false, error: String(result.error || 'unknown error') };
      }
      return { ok: true, data: result.data };
    })
    .catch((err) => {
      log(`livebench 抓取失败: ${err && err.message}`);
      return { ok: false, error: String((err && err.message) || err) };
    });

  const [or, aa, arena, livebench] = await Promise.all([orTask, aaTask, arenaTask, livebenchTask]);
  const results = {
    openrouter: or.ok ? or.data : null,
    aa: aa.ok ? aa.data : null,
    arena: arena.ok ? arena.data : null,
    livebench: livebench.ok ? livebench.data : null,
    sources: {
      'openrouter-rankings': { url: OR_RANKINGS_URL, ok: or.ok, error: or.ok ? null : or.error },
      'aa-models': { url: AA_MODELS_URL, ok: aa.ok, error: aa.ok ? null : aa.error },
      'lmarena-dataset': { url: arenaRowsUrl(0), ok: arena.ok, error: arena.ok ? null : arena.error },
      'livebench-data': { url: LIVEBENCH_HOME, ok: livebench.ok, error: livebench.ok ? null : livebench.error },
    },
  };
  return results;
}

/** 给 LiveBench 行打「本机已接入」标记：统一走 findLocal（aliasKeys 宽松匹配）。 */
function matchLivebenchRows(rows, localIndex) {
  for (const row of rows || []) {
    const hit = findLocal(localIndex, row.model, row.display);
    if (hit) row.local = { provider: hit.provider, providerDisplay: hit.providerDisplay, id: hit.id };
  }
}

function matchAaRows(models, localIndex) {
  for (const row of models) {
    const hit = findLocal(localIndex, row.name, row.slug, row.provider && `${row.provider} ${row.name || ''}`);
    if (hit) {
      row.local = { provider: hit.provider, providerDisplay: hit.providerDisplay, id: hit.id };
    }
  }
}

function matchOrRows(usage, localIndex) {
  for (const kind of ['weekly', 'today', 'month', 'trending']) {
    for (const row of usage[kind] || []) {
      const slugLast = row.slug ? String(row.slug).split('/')[1] : null;
      const hit = findLocal(localIndex, row.model, row.slug || undefined, slugLast);
      if (hit) row.local = { provider: hit.provider, providerDisplay: hit.providerDisplay, id: hit.id };
    }
  }
  for (const row of usage.marketShare || []) {
    // P1-09：份额行 orgMatched 映射统一到家族键（Z.ai→zhipu、Mistral AI→mistral、xAI→xai…）
    const org = canonicalOrgOfAuthor(row.author || row.authorKey);
    if (org) row.orgKey = org;
  }
}

function matchArenaRows(rows, localIndex) {
  for (const row of rows || []) {
    const hit = findLocal(localIndex, row.model);
    if (hit) row.local = { provider: hit.provider, providerDisplay: hit.providerDisplay, id: hit.id };
  }
}

/**
 * 合并旧快照与新一轮抓取结果；单一源失败时沿用旧数据并标注 stale。
 */
export function mergeSnapshots(prev, fetched, userInv) {
  const localIndex = buildLocalIndex(userInv);
  const base = prev && typeof prev === 'object' ? JSON.parse(JSON.stringify(prev)) : {};
  const snapshot = {
    version: 1,
    fetchedAt: nowIso(),
    sources: fetched.sources,
    userModelsCount: (userInv.models || []).length,
    userProviders: userInv.providers || [],
    usedDefaultModel: userInv.default || null,
    arena: base.arena || null,
    aa: base.aa || null,
    usage: base.usage || null,
    livebench: base.livebench || null,
  };

  if (fetched.arena) {
    matchArenaRows(fetched.arena.rows, localIndex);
    snapshot.arena = {
      asOf: fetched.arena.asOf,
      totalModels: fetched.arena.totalModels,
      rows: fetched.arena.rows,
      stale: false,
    };
  } else if (snapshot.arena) {
    snapshot.arena.stale = true;
  }

  if (fetched.aa) {
    matchAaRows(fetched.aa.models, localIndex);
    snapshot.aa = {
      asOf: fetched.aa.asOf,
      models: fetched.aa.models,
      stale: false,
    };
  } else if (snapshot.aa) {
    snapshot.aa.stale = true;
  }

  if (fetched.openrouter) {
    matchOrRows(fetched.openrouter, localIndex);
    // 份额榜按用户家族标记
    const orgs = new Set(userOrgs(userInv.models || []));
    snapshot.usage = {
      asOf: fetched.openrouter.asOf,
      weekly: fetched.openrouter.weekly,
      today: fetched.openrouter.today,
      month: fetched.openrouter.month,
      trending: fetched.openrouter.trending,
      marketShare: fetched.openrouter.marketShare.map((row) => ({ ...row, orgMatched: orgs.has(row.orgKey) })),
      stale: false,
    };
  } else if (snapshot.usage) {
    snapshot.usage.stale = true;
  }

  if (fetched.livebench) {
    matchLivebenchRows(fetched.livebench.rows, localIndex);
    snapshot.livebench = { ...fetched.livebench, stale: false };
  } else if (snapshot.livebench) {
    // 抓取失败：沿用上次能力榜数据并标 stale（旧数据仍可展示，客户端会提示「数据源待更新」）
    snapshot.livebench.stale = true;
  }

  return snapshot;
}
