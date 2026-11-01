// dsh-model-rank · scripts/build-snapshot.mjs
// 用途：
//   node scripts/build-snapshot.mjs                     # 开发自测：抓三源 + 本机接入清单 → 全量快照（含本机标记与 AA），
//                                                       # 默认写到系统临时目录，绝不覆盖提交物（可用 --out <path> 指定）
//   node scripts/build-snapshot.mjs --bundled           # 生成「随包 / 随仓库分发」的内置快照 → data/snapshot.json
//   node scripts/build-snapshot.mjs --bundled --offline # 不联网：把现有 data/snapshot.json 重新净化成内置快照
//
// --bundled 模式的净化规则（隐私与第三方数据再分发要求，见 .team/BRIEF.md 第 3 节）：
//   1) 删除 userProviders / userModelsCount / usedDefaultModel —— 本机接入清单会泄露用户的私有 provider 与模型列表；
//   2) 删除所有行内本机标记：arena.rows / aa.models / usage.{weekly,today,month,trending} 的 `local`，
//      以及 usage.marketShare 的 `orgMatched`（都由本机清单推导，间接泄露「我接了哪些厂商」）；
//   3) 不含 Artificial Analysis 数据（AA 是第三方站点抓取数据，随包分发有再分发风险）：
//      aa 段置 null、sources['aa-models'] 标记 ok=false 说明原因；运行时抓取不受影响（宿主仍会每日抓取）；
//   4) 保留 LMArena 对战榜（CC BY 4.0）与 OpenRouter 榜单 / 份额（CC BY 4.0）。
//
// 写盘前会做一次深度隐私自检：任何残留的上述键名都会让脚本以非零退出，避免把本机清单带进提交物。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchSources, mergeSnapshots, readUserModelInventory, normalizeKey } from '../lib/pipeline.js'

const here = fileURLToPath(new URL('.', import.meta.url));
const pkgRoot = join(here, '..');
// 提交物路径（仅 --bundled 模式写入；也是 --offline 的基底来源）
const bundledPath = join(pkgRoot, 'data', 'snapshot.json');

const argv = process.argv.slice(2);
const bundled = argv.includes('--bundled');
const offline = argv.includes('--offline');
const outIndex = argv.indexOf('--out');
const explicitOut = outIndex >= 0 ? argv[outIndex + 1] : null;
// 非内置模式默认写临时目录：全量快照含本机 provider/模型清单与 AA 数据，绝不能误覆盖提交物
const outPath = explicitOut
  ? (isAbsolute(explicitOut) ? explicitOut : resolve(pkgRoot, explicitOut))
  : (bundled ? bundledPath : join(tmpdir(), 'dsh-model-rank-snapshot.local.json'));
const EMPTY_INVENTORY = { models: [], providers: [], default: null };

// 内置快照里绝对不允许出现的键（全部由本机接入清单推导，或属于不分发的第三方数据）。
export const FORBIDDEN_KEYS = new Set(['userProviders', 'userModelsCount', 'usedDefaultModel', 'local', 'orgMatched']);

function readExistingSnapshot() {
  try {
    if (!existsSync(bundledPath)) return null;
    const parsed = JSON.parse(readFileSync(bundledPath, 'utf8'));
    return parsed && parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** 深度遍历，返回所有禁用键的出现位置（只报路径，不报值）。 */
export function auditForbiddenKeys(root) {
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
      if (FORBIDDEN_KEYS.has(key)) hits.push(`${path}.${key}`);
      stack.push({ value: child, path: `${path}.${key}` });
    }
  }
  return hits;
}

/** 记录净化前的隐私面统计（只统计数量，不打印任何本机名称）。 */
function privacyStats(snapshot) {
  const countLocal = (rows) => (Array.isArray(rows) ? rows.filter((row) => row && typeof row === 'object' && 'local' in row).length : 0);
  const usage = snapshot.usage || {};
  return {
    userProviders: Array.isArray(snapshot.userProviders) ? snapshot.userProviders.length : 0,
    userModelsCount: snapshot.userModelsCount ?? null,
    usedDefaultModel: snapshot.usedDefaultModel ? 1 : 0,
    localMarks:
      countLocal(snapshot.arena?.rows) +
      countLocal(snapshot.aa?.models) +
      countLocal(snapshot.livebench?.rows) +
      ['weekly', 'today', 'month', 'trending'].reduce((sum, kind) => sum + countLocal(usage[kind]), 0),
    orgMatched: Array.isArray(usage.marketShare) ? usage.marketShare.filter((row) => row && 'orgMatched' in row).length : 0,
    aaModels: Array.isArray(snapshot.aa?.models) ? snapshot.aa.models.length : 0,
    livebenchRows: Array.isArray(snapshot.livebench?.rows) ? snapshot.livebench.rows.length : 0,
  };
}

/**
 * 内置快照净化：删除本机清单与行内标记，并剥离 AA / LiveBench 第三方数据。
 * 输入不会被修改（深拷贝后处理），返回新对象。导出给 validate-livebench 做单元测试。
 */
export function sanitizeBundledSnapshot(snapshot) {
  const out = JSON.parse(JSON.stringify(snapshot));

  // 1) 本机接入清单（私有 provider / 模型列表 / 默认模型）
  delete out.userModelsCount;
  delete out.userProviders;
  delete out.usedDefaultModel;

  // 2) 行内本机标记（local / orgMatched 都由本机清单推导）
  const stripRow = (row) => {
    if (!row || typeof row !== 'object') return;
    delete row.local;
    delete row.orgMatched;
  };
  for (const row of out.arena?.rows || []) stripRow(row);
  for (const row of out.aa?.models || []) stripRow(row);
  for (const row of out.livebench?.rows || []) stripRow(row);
  for (const kind of ['weekly', 'today', 'month', 'trending']) {
    for (const row of out.usage?.[kind] || []) stripRow(row);
  }
  for (const row of out.usage?.marketShare || []) stripRow(row);

  // 3) 第三方站点数据不随包分发，只运行时抓取：
  //    - Artificial Analysis（价格 / 智能指数）
  //    - LiveBench（能力榜分数；代码 Apache-2.0，但分数数据未标独立许可）
  out.aa = null;
  out.livebench = null;
  if (out.sources && typeof out.sources === 'object') {
    const prevAa = out.sources['aa-models'];
    out.sources['aa-models'] = {
      url: prevAa && prevAa.url ? prevAa.url : 'https://artificialanalysis.ai/models',
      ok: false,
      error: 'bundled snapshot excludes Artificial Analysis data (runtime fetch only)',
    };
    const prevLb = out.sources['livebench-data'];
    out.sources['livebench-data'] = {
      url: prevLb && prevLb.url ? prevLb.url : 'https://livebench.ai/',
      ok: false,
      error: 'bundled snapshot excludes LiveBench data (runtime fetch only)',
    };
  }

  return out;
}

// ---------------------------------------------------------------------------
// 构建主流程（仅作为 CLI 直接运行时执行；被 validate-livebench import 时不执行，只导出纯函数）
// ---------------------------------------------------------------------------

async function main() {
  const prevSnapshot = readExistingSnapshot();
  let snapshot = null;
  let fetchedOk = 0;

  if (offline) {
    if (!prevSnapshot) {
      console.error('[build-snapshot] --offline 需要现有 data/snapshot.json 作为基底，但文件不存在或不是 version 1');
      process.exit(1);
    }
    console.log('[build-snapshot] --offline：跳过网络抓取，直接净化现有 data/snapshot.json');
    snapshot = prevSnapshot;
  } else {
    console.log('[build-snapshot] 开始抓取四个源…');
    const t0 = Date.now();
    const fetched = await fetchSources({
      log: (m) => console.log('  ·', m),
      prev: prevSnapshot, // LiveBench 版本发现失败时用上次 releaseId 兜底
    });
    fetchedOk = Object.values(fetched.sources).filter((info) => info.ok).length;
    console.log(`[build-snapshot] 抓取完成（${Date.now() - t0}ms，成功 ${fetchedOk}/${Object.keys(fetched.sources).length} 源）`);
    for (const [name, info] of Object.entries(fetched.sources)) {
      console.log(`  ${info.ok ? '√' : '×'} ${name} ${info.error ? '→ ' + info.error : ''}`);
    }

    const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '', '.dsh');
    if (bundled) {
      // 内置快照只保留公开数据：不读本机清单，避免任何私有信息进入提交物
      console.log('[build-snapshot] 内置模式：不读取本机接入清单（仅保留公开榜单数据）');
      snapshot = mergeSnapshots(prevSnapshot, fetched, EMPTY_INVENTORY);
    } else {
      console.log('[build-snapshot] 读取本机接入清单（DSH_HOME =', dshHome, '）…');
      const userInv = await readUserModelInventory(dshHome);
      console.log(`  providers=${userInv.providers.length} models=${userInv.models.length} default=${userInv.default ? userInv.default.provider + '/' + userInv.default.model : '(无)'}`);
      snapshot = mergeSnapshots(null, fetched, userInv);
    }

    if (fetchedOk === 0) {
      if (!prevSnapshot && !bundled) {
        console.error('[build-snapshot] 四个数据源全部抓取失败，且没有可沿用的旧快照，放弃写入（避免用空数据覆盖提交物）');
        process.exit(1);
      }
      // 全部失败：沿用旧数据并保留旧的 fetchedAt（各段 stale 标记已在 mergeSnapshots 里写好）
      if (prevSnapshot && prevSnapshot.fetchedAt) snapshot.fetchedAt = prevSnapshot.fetchedAt;
      console.log('[build-snapshot] ! 四个数据源全部失败：沿用现有 data/snapshot.json 的旧数据（保留旧 fetchedAt，各段标记 stale）');
    }
  }

  const before = bundled ? privacyStats(snapshot) : null;
  if (bundled) {
    snapshot = sanitizeBundledSnapshot(snapshot);
    const hits = auditForbiddenKeys(snapshot);
    if (hits.length) {
      console.error('[build-snapshot] × 隐私自检失败：内置快照里仍残留本机清单推导字段：');
      for (const hit of hits.slice(0, 10)) console.error('   ', hit);
      process.exit(1);
    }
    console.log('[build-snapshot] √ 隐私自检通过：无 userProviders / userModelsCount / usedDefaultModel / local / orgMatched');
  }

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot), 'utf8');

  const kb = (Buffer.byteLength(JSON.stringify(snapshot)) / 1024).toFixed(1);
  console.log(`[build-snapshot] 已写入 ${outPath}（${kb} KB）`);
  if (!bundled) {
    console.log('  ! 这是「全量本地快照」：含本机接入清单 / AA / LiveBench 数据，只用于本机自测 / 客户端渲染，切勿提交；');
    console.log('    提交物请用：node scripts/build-snapshot.mjs --bundled（只含公开榜单数据，AA/LiveBench 运行时抓取）');
  }
  console.log(`  arena rows=${snapshot.arena?.rows?.length ?? 0}（asOf ${snapshot.arena?.asOf ?? '—'}，stale=${snapshot.arena?.stale === true}）`);
  console.log(`  aa rows=${snapshot.aa?.models?.length ?? 0}${snapshot.aa ? '' : '（AA 数据不随包分发）'}`);
  console.log(`  usage weekly=${snapshot.usage?.weekly?.length ?? 0} month=${snapshot.usage?.month?.length ?? 0} share=${snapshot.usage?.marketShare?.length ?? 0}（asOf ${snapshot.usage?.asOf ?? '—'}，stale=${snapshot.usage?.stale === true}）`);
  console.log(`  livebench ${snapshot.livebench ? `${snapshot.livebench.generation} ${snapshot.livebench.release} rows=${snapshot.livebench.rows?.length ?? 0}（stale=${snapshot.livebench.stale === true}）` : '（不随包分发 / 无数据）'}`);
  if (before) {
    console.log(`  净化前：userProviders=${before.userProviders} userModelsCount=${before.userModelsCount ?? 'null'} usedDefaultModel=${before.usedDefaultModel ? '有' : '无'} local 标记=${before.localMarks} orgMatched=${before.orgMatched} AA 行=${before.aaModels} LiveBench 行=${before.livebenchRows}`);
    console.log('  净化后：本机清单字段=0 行内 local/orgMatched=0 AA 行=0 LiveBench 行=0');
  }
  if (!bundled) {
    const localHits = {
      arena: (snapshot.arena?.rows || []).filter((r) => r.local).length,
      aa: (snapshot.aa?.models || []).filter((r) => r.local).length,
      livebench: (snapshot.livebench?.rows || []).filter((r) => r.local).length,
      weekly: (snapshot.usage?.weekly || []).filter((r) => r.local).length,
    };
    console.log(`  本机命中的行数（仅本地自测，勿提交）：arena=${localHits.arena} aa=${localHits.aa} livebench=${localHits.livebench} weekly=${localHits.weekly}`);
    // 归一化键抽查：确认公开模型名可被 usage 报告的 join 逻辑匹配（不打印本机模型名）
    const sample = (snapshot.usage?.weekly || []).find((row) => row && row.model);
    if (sample) console.log(`  归一化键示例：${normalizeKey(sample.model)}`);
  }
}

// 只有「node scripts/build-snapshot.mjs」直接运行时才执行构建；被测试脚本 import 时仅暴露纯函数。
const invokedDirectly = (() => {
  try {
    return !!process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  await main();
}
