// dsh-model-rank · scripts/validate-parsers.mjs
// 离线校验 lib/pipeline.js 的解析器与匹配器（P1-07/08/09/10/11/18、P2-34）。
// 目的：把 T5 审计时用网络样本发现的健壮性问题固化为可重复 fixture，页面结构变化时能离线报警。
//
// 运行：node scripts/validate-parsers.mjs
// 特性：默认零联网、零真实用户数据、可重复；所有模型/厂商均为 demo 假值。
import {
  parseOpenRouterRankings,
  parseAaModelsHtml,
  parseArenaRows,
  fetchArenaOverall,
  arenaRowsUrl,
  ARENA_PAGE_SIZE,
  ARENA_DISPLAY_ROWS,
  normalizeKey,
  mergeSnapshots,
  userOrgs,
} from '../lib/pipeline.js';

let checks = 0;
let failures = 0;
function check(ok, message) {
  checks += 1;
  if (ok) {
    console.log(`  √ ${message}`);
  } else {
    failures += 1;
    console.error(`  × ${message}`);
  }
}

// ---------------------------------------------------------------------------
// 1) normalizeKey：CJK / NFKC / 括注 / contributor（P1-04/P1-18）
// ---------------------------------------------------------------------------
console.log('\n[1] normalizeKey（CJK / NFKC / 括注 / contributor）');
check(normalizeKey('智谱 GLM-5') === '智谱glm5', 'CJK 前缀保留（不再退化成 glm5）');
check(normalizeKey('纯中文模型名') === '纯中文模型名', '纯 CJK 名不再变空串');
check(normalizeKey('ＧＰＴ－４Ｏ') === 'gpt4o', 'NFKC 全角归一化');
check(normalizeKey('Claude (Opus 4.6)') === 'claude', '去括注');
check(normalizeKey('model-contributor') === 'model', '去尾部 contributor');
check(normalizeKey('') === '', '空值安全');

// ---------------------------------------------------------------------------
// 2) OpenRouter：表头列名映射 / 列漂移 / class 修饰 / Unicode change（P1-07/08/11）
// ---------------------------------------------------------------------------
console.log('\n[2] OpenRouter 解析：列名映射 / 列漂移 / class / change');
const HEAD = (...cells) => cells.map((c) => `<th class="or-table__header-cell">${c}</th>`).join('');
const ROW = (cells, cls = 'or-table__row') => `<tr class="${cls}">${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
const TABLE = (head, rows) => `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
const PAGE = (tables) => `<html><body><p>Usage data through Nov 1, 2026</p>${tables.join('')}</body></html>`;
const WEEKLY_HEAD = HEAD('#', 'Model', 'Author', 'Tokens processed', 'Change');
const SHARE_HEAD = HEAD('#', 'Author', 'Share of requests', 'Change');

try {
  const parsed = parseOpenRouterRankings(PAGE([
    TABLE(WEEKLY_HEAD, [
      ROW(['1', 'Model A', 'OpenAI', '1.2T tokens', '+5%']),
      ROW(['2', 'Model B', 'Z.ai', '900B tokens', '-3%']),
      ROW(['3', 'Model C', 'NewLab', '7.1B tokens', '▲ 4%']),
      ROW(['4', 'Model D', 'OldLab', '1.1B tokens', '▼ 2%']),
    ]),
    TABLE(SHARE_HEAD, [ROW(['1', 'OpenAI', '42.5%', '+1%']), ROW(['2', 'Z.ai', '10.7%', '▼ 6%'])]),
  ]));
  check(parsed.asOf === 'Nov 1, 2026', 'asOf 解析');
  check(parsed.weekly.length === 4, 'weekly 4 行');
  check(parsed.weekly[0].tokens.value === 1.2e12 && parsed.weekly[0].tokens.label === '1.2T', 'tokens 单位解析（1.2T）');
  check(parsed.weekly[0].change.kind === 'up' && parsed.weekly[0].change.pct === 5, 'change +5%');
  check(parsed.weekly[1].change.kind === 'down' && parsed.weekly[1].change.pct === 3, 'change -3%');
  check(parsed.weekly[2].change.kind === 'up' && parsed.weekly[2].change.pct === 4, 'change ▲ 4%（Unicode 箭头）');
  check(parsed.weekly[3].change.kind === 'down' && parsed.weekly[3].change.pct === 2, 'change ▼ 2%（Unicode 箭头）');
  check(parsed.marketShare.length === 2, 'marketShare 2 行');
  check(parsed.marketShare[1].authorKey === 'zhipu', 'marketShare authorKey 规范化 Z.ai→zhipu（P1-09）');
  check(parsed.marketShare[0].author === 'OpenAI' && parsed.marketShare[1].author === 'Z.ai', 'marketShare 保留原始作者展示名');
} catch (err) {
  check(false, `正常页面解析抛错：${err.message}`);
}

try {
  // 列漂移：多一列徽标 → 该行应被跳过（不产生 model="NEW" 的垃圾行）
  const parsed = parseOpenRouterRankings(PAGE([
    TABLE(WEEKLY_HEAD, [
      ROW(['1', '<span>NEW</span>', 'Model A', 'OpenAI', '1.2T tokens', '+5%']),
      ROW(['2', 'Model B', 'OpenAI', '900B tokens', '-3%']),
    ]),
    TABLE(SHARE_HEAD, [ROW(['1', 'OpenAI', '42%', '+1%'])]),
  ]));
  check(parsed.weekly.length === 1 && parsed.weekly[0].model === 'Model B', '列数漂移行被跳过，不产生错位垃圾行（P1-07）');
} catch (err) {
  check(false, `列漂移页面抛错（应降级而非抛错）：${err.message}`);
}

try {
  // class 追加修饰类 → 仍应解析；列顺序打乱 → 按表头列名映射仍正确
  const reorderedHead = HEAD('Rank', 'Author', 'Model', 'Change', 'Tokens processed');
  const parsed = parseOpenRouterRankings(PAGE([
    TABLE(reorderedHead, [ROW(['1', 'OpenAI', 'Model A', '+8%', '2.5T tokens'], 'or-table__row or-table__row--top')]),
    TABLE(SHARE_HEAD, [ROW(['1', 'OpenAI', '42%', '+1%'])]),
  ]));
  check(parsed.weekly.length === 1, 'class 修饰类放宽后仍能解析（P1-08）');
  check(parsed.weekly[0].model === 'Model A' && parsed.weekly[0].tokens.value === 2.5e12 && parsed.weekly[0].change.pct === 8, '列顺序打乱后按表头映射正确（P1-07）');
} catch (err) {
  check(false, `打乱列/修饰 class 页面抛错：${err.message}`);
}

// ---------------------------------------------------------------------------
// 3) 本机匹配 / orgMatched（P1-09/P1-18）
// ---------------------------------------------------------------------------
console.log('\n[3] 本机匹配与 orgMatched（P1-09/P1-18）');
const userInv = {
  models: [
    { provider: 'demo-1', providerDisplay: 'Demo One', id: 'glm-5.3-flash', name: 'GLM-5.3-Flash' },
    { provider: 'demo-2', providerDisplay: 'Demo Two', id: 'demo/gpt-4o', name: 'demo/gpt-4o' },
    { provider: 'demo-3', providerDisplay: 'Demo Three', id: '豆包-Pro', name: '豆包 Pro' },
  ],
  providers: [], default: null,
};
try {
  const parsed = parseOpenRouterRankings(PAGE([
    TABLE(WEEKLY_HEAD, [ROW(['1', 'GLM-5.3-Flash', 'Z.ai', '1.2T tokens', '+5%'])]),
    TABLE(SHARE_HEAD, [ROW(['1', 'Z.ai', '10.7%', '+1%']), ROW(['2', 'Mistral AI', '2.0%', '-1%'])]),
  ]));
  const snap = mergeSnapshots(null, { openrouter: parsed, aa: null, arena: null, sources: {} }, userInv);
  const zhipu = snap.usage.marketShare.find((row) => row.author === 'Z.ai');
  check(!!zhipu && zhipu.orgMatched === true && zhipu.orgKey === 'zhipu', 'Z.ai 份额行 orgMatched=true（本机有 GLM 模型）');
  check(snap.usage.weekly[0].local && snap.usage.weekly[0].local.provider === 'demo-1', 'weekly 行打上本机 local');
} catch (err) {
  check(false, `匹配用例抛错：${err.message}`);
}

try {
  const aa = parseAaModelsHtml(`<script>self.__next_f.push([1,${JSON.stringify(
    'x"initialModels":[{"slug":"gpt-4o","name":"GPT-4o","intelligenceIndex":50,"creator":{"name":"Demo"}},{"slug":"doubao-pro","name":"豆包 Pro","intelligenceIndex":40,"creator":{"name":"Demo"}},{"slug":"tongyi-pro","name":"通义 Pro","intelligenceIndex":30,"creator":{"name":"Demo"}}]y')}])</script>`);
  const arena = parseArenaRows({ rows: [{ row: { rank: 1, model_name: '通义 Pro', organization: 'Alibaba', rating: 1400 } }] });
  const merged = mergeSnapshots(null, { aa, openrouter: null, arena, sources: {} }, userInv);
  const aaGpt = merged.aa.models.find((m) => m.slug === 'gpt-4o');
  check(!!aaGpt && !!aaGpt.local, 'provider 前缀 id（demo/gpt-4o）能匹配 GPT-4o（P1-18）');
  const aaDoubao = merged.aa.models.find((m) => m.slug === 'doubao-pro');
  const aaTongyi = merged.aa.models.find((m) => m.slug === 'tongyi-pro');
  check(!!aaDoubao && !!aaDoubao.local, '纯 CJK 名「豆包 Pro」可匹配（P1-18）');
  check(!!aaTongyi && !aaTongyi.local, '「通义 Pro」不被「豆包 Pro」误匹配（CJK 误报修复）');
  check(!!merged.arena.rows[0] && !merged.arena.rows[0].local, 'Arena「通义 Pro」不被误标已接入');
} catch (err) {
  check(false, `匹配/CJK 用例抛错：${err.message}`);
}

// ---------------------------------------------------------------------------
// 4) AA flight 解析（P1-10）
// ---------------------------------------------------------------------------
console.log('\n[4] AA flight 解析（空格变体 / 大列表 / 截断）');
const flightHtml = (flight) => `<html><body><script>self.__next_f.push([1,${JSON.stringify(flight)}])</script></body></html>`;
const M = (i) => `{"slug":"m${i}","name":"Model ${i}","intelligenceIndex":${100 - i},"creator":{"name":"Demo"}}`;
try {
  const ok = parseAaModelsHtml(flightHtml(`prefix"initialModels":[${M(1)},${M(2)}]suffix`));
  check(ok.models.length === 2, '正常 flight 解析 2 个模型');
  check(ok.asOf === null || typeof ok.asOf === 'string', 'asOf 为 string 或 null');
} catch (err) {
  check(false, `正常 AA 解析抛错：${err.message}`);
}
try {
  const spaced = parseAaModelsHtml(flightHtml(`prefix"initialModels": [${M(1)}]suffix`));
  check(spaced.models.length === 1, '"initialModels": [ 冒号后空格可解析（P1-10）');
} catch (err) {
  check(false, `"initialModels": [ 空格变体抛错：${err.message}`);
}
try {
  const many = Array.from({ length: 405 }, (_, i) => M(i + 1)).join(',');
  const parsed = parseAaModelsHtml(flightHtml(`x"initialModels":[${many}]y`));
  check(parsed.models.length === 405, '405 个模型不再被 400 上限静默截断');
} catch (err) {
  check(false, `大列表解析抛错：${err.message}`);
}
try {
  // 截断 flight：允许返回「已完整解析的对象」（部分结果优于全丢），但绝不能崩或返回伪数据
  const partial = parseAaModelsHtml(flightHtml(`x"initialModels":[${M(1)},${M(2)}`));
  check(partial.models.length >= 1 && partial.models.length <= 2, '截断 flight 返回已完整解析的对象（不崩、不伪造）');
} catch (err) {
  check(/initialModels|可用模型/.test(err.message), '截断 flight 明确抛错（解析失败可见）');
}

// ---------------------------------------------------------------------------
// 5) Arena 解析（P2-34）
// ---------------------------------------------------------------------------
console.log('\n[5] Arena 解析（rank 字符串 / 机构展示名 / asOf 取最新）');
try {
  const arena = parseArenaRows({
    num_rows_total: 419,
    rows: [
      { row: { rank: '2', model_name: 'Model B', organization: 'Google DeepMind', rating: 1490, leaderboard_publish_date: '2026-10-01' } },
      { row: { rank: 1, model_name: 'Model A', organization: 'OpenAI', rating: 1500, leaderboard_publish_date: '2026-10-28' } },
    ],
  });
  check(arena.totalModels === 419, 'totalModels 透传');
  check(arena.rows[0].rank === 1 && arena.rows[1].rank === 2, 'rank 字符串/数字统一为数字');
  check(arena.rows[1].orgDisplay === 'Google', '带空格机构名映射为 Google（P2-16）');
  check(arena.asOf === '2026-10-28', 'asOf 取最新发布日期（P2-34）');
} catch (err) {
  check(false, `Arena 解析抛错：${err.message}`);
}

// ---------------------------------------------------------------------------
// 6) Arena /rows 分页抓取（/filter 自 2026-11-01 起匿名恒 422 后的替代路径）
// ---------------------------------------------------------------------------
console.log('\n[6] Arena /rows 分页（分类块早停 / 后续页降级 / 首屏失败 / 展示行上限）');
const ROW_OF = (i, category = 'overall') => ({ row: { rank: i, model_name: `Demo Model ${i}`, organization: 'demo-org', rating: 1500 - i, category, leaderboard_publish_date: '2026-10-28' } });
const rowsPage = (arr) => ({ rows: arr });
try {
  const url0 = arenaRowsUrl(0);
  check(url0.includes('offset=0') && url0.includes('length=' + ARENA_PAGE_SIZE), 'arenaRowsUrl 带 offset/length');
  check(url0.includes('/rows') && !url0.includes('/filter'), 'Arena 走 /rows 而非已失效的 /filter');
} catch (err) {
  check(false, `arenaRowsUrl 抛错：${err.message}`);
}
try {
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(url);
    if (url.includes('offset=0')) return { text: JSON.stringify(rowsPage([ROW_OF(1), ROW_OF(2), ROW_OF(3)])) };
    return { text: JSON.stringify(rowsPage([ROW_OF(4), ROW_OF(5), ROW_OF(6, 'chinese')])) };
  };
  const data = await fetchArenaOverall(fakeFetch, {});
  check(data.rows.length === 5 && data.totalModels === 5, 'overall 分类行收集 + 总数统计正确');
  check(calls.length === 2, '出现非 overall 行即停止翻页（早停）');
  check(data.rows[0].rank === 1 && data.rows[0].model === 'Demo Model 1', '排序与字段映射正确');
} catch (err) {
  check(false, `Arena 分页正常路径抛错：${err.message}`);
}
try {
  const fakeFetch = async (url) => {
    if (url.includes('offset=0')) return { text: JSON.stringify(rowsPage([ROW_OF(1), ROW_OF(2)])) };
    throw new Error('HTTP 502');
  };
  const data = await fetchArenaOverall(fakeFetch, {});
  check(data.rows.length === 2 && data.totalModels === 2, '后续页失败时用已收集行降级（不丢首屏）');
  check(data.totalModelsIsLowerBound === true, '未翻到分类块结束时标记总数为下界');
} catch (err) {
  check(false, `Arena 后续页降级抛错：${err.message}`);
}
try {
  const fakeFetch = async () => { throw new Error('HTTP 500'); };
  let threw = false;
  try { await fetchArenaOverall(fakeFetch, {}); } catch { threw = true; }
  check(threw, '首屏失败时抛错（由上层标记源失败、保留旧快照）');
} catch (err) {
  check(false, `Arena 首屏失败断言抛错：${err.message}`);
}
try {
  const many = Array.from({ length: 60 }, (_, i) => ROW_OF(i + 1));
  const fakeFetch = async (url) => (url.includes('offset=0')
    ? { text: JSON.stringify(rowsPage(many)) }
    : { text: JSON.stringify(rowsPage([ROW_OF(999, 'chinese')])) });
  const data = await fetchArenaOverall(fakeFetch, {});
  check(data.rows.length === ARENA_DISPLAY_ROWS, '快照展示行数上限生效');
  check(data.totalModels === 60, '展示行截断不影响 overall 总数统计');
} catch (err) {
  check(false, `Arena 展示行上限抛错：${err.message}`);
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n断言 ${checks} 项，失败 ${failures} 项`);
if (failures > 0) {
  console.error('× validate-parsers 存在失败');
  process.exitCode = 1;
} else {
  console.log('√ validate-parsers 全部通过（离线 fixture：OR/AA/Arena/匹配/CJK/列漂移）');
}
