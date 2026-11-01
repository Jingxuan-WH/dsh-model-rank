window.__ModuleLoader__.load({ id: "dsh-model-rank", factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  'use strict';

  // dsh-model-rank · client half
  // - 左侧栏入口（sidebar.panellist 图标行）+ 主面板（main keyed slot）
  // - 数据来自宿主 RPC GET /_dsh/dsh-model-rank/snapshot（宿主每日抓取的本地快照），
  //   先读 localStorage 缓存立即渲染，再后台对齐最新快照 —— 打开即是显示，不等网络。
  // - React 由 bundle 的 require('react') 提供（seed 模块）。

  const React = require('react');
  const h = React.createElement;
  const { useState, useEffect, useMemo, useRef, useCallback } = React;

  const PLUGIN_ID = 'dsh-model-rank';
  const PANEL_KEY = 'model-rank';
  const SLOT_ORDER = 60;
  const RPC_BASE = '/_dsh/dsh-model-rank';
  const CACHE_KEY = 'dsh-model-rank:snapshot';
  const TAB_KEY = 'dsh-model-rank:tab';
  const RPC_TIMEOUT_MS = 20000;
  // 本机用量（GET /usage，见 .team/API-CONTRACT.md）：缓存 key 与轮询节奏
  const USAGE_CACHE_KEY = 'dsh-model-rank:usage';
  const USAGE_RANGE_KEY = 'dsh-model-rank:usage-range';
  const USAGE_TIMEOUT_MS = 15000;
  const USAGE_POLL_MS = 60000;
  const USAGE_DEFAULT_RANGE = 'd7';
  const USAGE_RANGES = [
    { id: 'today', label: '今日', hint: '本机时区自然日' },
    { id: 'd7', label: '近 7 天', hint: '含今天的最近 7 个自然日' },
    { id: 'd30', label: '近 30 天', hint: '含今天的最近 30 个自然日' },
    { id: 'all', label: '全部', hint: '全部可读取的会话日志' },
  ];

  // ---------------------------------------------------------------------------
  // 样式（scoped，全部取 DSW alias 主题 token，dark 模式自动跟随）
  // ---------------------------------------------------------------------------
  const STYLE_ID = 'dsh-model-rank-styles';
  const CSS = `/* ==========================================================================
   dsh-model-rank · 视觉系统 v2（designer 阶段 B）
   规范：.team/design/design-spec.md
   - 颜色只走 --mrr-* 语义变量，--mrr-* 只映射 DSH token（--dsw-alias-*），暗色自动适配
   - 粘性 tab 栏 + 粘性表头；卡片 overflow:clip（不能 hidden，否则表头吸附错位）
   - <900px 表格转卡片（依赖 td[data-label]）
   ========================================================================== */
.mrr-root{
  --mrr-fg:var(--dsw-alias-label-primary,#181c23);
  --mrr-fg2:var(--dsw-alias-label-secondary,#4b5563);
  --mrr-fg3:var(--dsw-alias-label-tertiary,#7b8494);
  --mrr-fg-dim:var(--dsw-alias-label-dimmed,#a8afba);
  --mrr-bg:var(--dsw-alias-bg-layer-1,#fff);
  --mrr-bg-soft:var(--dsw-alias-bg-module-platform,rgba(16,24,40,.035));
  --mrr-bg-raised:var(--dsw-alias-bg-layer-3,#fff);
  --mrr-line:var(--dsw-alias-border-l2,rgba(0,0,0,.10));
  --mrr-line-soft:var(--dsw-alias-border-l1,rgba(0,0,0,.06));
  --mrr-accent:var(--dsw-alias-state-business-primary,var(--dsw-static-deepseek-500,#4176e6));
  --mrr-accent-soft:color-mix(in srgb,var(--mrr-accent) 12%,transparent);
  --mrr-hover:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  --mrr-active:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.10));
  --mrr-link:var(--dsw-alias-link,#4176e6);
  --mrr-good:var(--dsw-alias-state-success-primary,#12b76a);
  --mrr-warn:var(--dsw-alias-state-warning-primary,#f59e0b);
  --mrr-bad:var(--dsw-alias-state-danger-primary,#e5484d);
  --mrr-mask:var(--dsw-alias-bg-mask-1,rgba(16,24,40,.32));
  --mrr-mono:var(--dsw-alias-mono-font-family,ui-monospace,"Cascadia Mono",Consolas,monospace);
  color:var(--mrr-fg); background:var(--mrr-bg);
  box-sizing:border-box; height:100%; width:100%; overflow-y:auto; overflow-x:hidden;
  padding:0 26px 32px; font-variant-numeric:tabular-nums;
  font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.mrr-root *{ box-sizing:border-box; }
.mrr-inner{ max-width:1152px; margin:0 auto; width:100%; }

/* ---------- 顶栏 ---------- */
.mrr-head{ display:flex; align-items:flex-end; justify-content:space-between; gap:16px; padding:22px 0 0; }
.mrr-headtitle{ min-width:0; }
.mrr-headtitle h1{ margin:0; font-size:18px; line-height:26px; font-weight:600; letter-spacing:.2px; display:flex; align-items:baseline; gap:8px; }
.mrr-headtitle h1 .mrr-title-sub{ font-size:13px; font-weight:400; color:var(--mrr-fg3); letter-spacing:0; }
.mrr-sub{ margin-top:3px; display:flex; align-items:center; gap:4px 8px; flex-wrap:wrap; font-size:12px; line-height:18px; color:var(--mrr-fg3); }
.mrr-sub b{ color:var(--mrr-fg2); font-weight:500; }
.mrr-sub a{ color:var(--mrr-fg3); text-decoration:none; border-bottom:1px dotted var(--mrr-line); }
.mrr-sub a:hover{ color:var(--mrr-accent); }
.mrr-headactions{ display:flex; align-items:center; gap:12px; flex-shrink:0; }
.mrr-uptodate{ font-size:11.5px; color:var(--mrr-fg3); text-decoration:none; border-bottom:1px dotted var(--mrr-line); white-space:nowrap; }
.mrr-uptodate:hover{ color:var(--mrr-accent); }
.mrr-refreshbtn{ appearance:none; height:30px; padding:0 12px; border-radius:8px; cursor:pointer;
  border:1px solid var(--mrr-line); background:var(--mrr-bg); color:var(--mrr-fg2);
  font:500 12.5px/1 -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif;
  display:inline-flex; align-items:center; gap:6px; white-space:nowrap;
  transition:background-color .12s ease-out,border-color .12s ease-out,color .12s ease-out; }
.mrr-refreshbtn:hover{ background:var(--mrr-hover); color:var(--mrr-fg); }
.mrr-refreshbtn:active{ background:var(--mrr-active); }
.mrr-refreshbtn:disabled{ opacity:.6; cursor:default; }
.mrr-refreshbtn[data-busy="1"]{ color:var(--mrr-accent); border-color:color-mix(in srgb,var(--mrr-accent) 36%,transparent); }
.mrr-spin{ display:inline-block; width:12px; height:12px; border:1.6px solid currentColor; border-top-color:transparent; border-radius:50%; animation:mrr-spin .8s linear infinite; }
@keyframes mrr-spin{ to{ transform:rotate(360deg); } }
.mrr-title-sub{ font-size:13px; font-weight:400; color:var(--mrr-fg3); }

/* ---------- tab 栏（下划线式 + 粘性） ---------- */
.mrr-tabs{ position:sticky; top:0; z-index:2; display:flex; gap:2px; align-items:flex-end;
  margin-top:8px; border-bottom:1px solid var(--mrr-line-soft);
  background:var(--mrr-bg); }
.mrr-tab{ appearance:none; border:0; background:transparent; cursor:pointer; position:relative;
  display:inline-flex; align-items:baseline; gap:6px; padding:8px 12px 10px; border-radius:8px 8px 0 0;
  font:500 13px/18px -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif;
  color:var(--mrr-fg2); white-space:nowrap; transition:background-color .12s,color .12s; }
.mrr-tab:hover{ background:var(--mrr-hover); color:var(--mrr-fg); }
.mrr-tab:focus-visible{ outline:2px solid var(--mrr-accent); outline-offset:-2px; }
.mrr-tab[data-active="1"]{ color:var(--mrr-accent); font-weight:600; }
.mrr-tab[data-active="1"]::after{ content:""; position:absolute; left:10px; right:10px; bottom:-1px; height:2px; border-radius:2px; background:var(--mrr-accent); }
.mrr-tab .mrr-tabcount{ font-size:11px; font-weight:500; color:var(--mrr-fg3); margin-left:0; letter-spacing:0; }
.mrr-tab[data-active="1"] .mrr-tabcount{ color:var(--mrr-accent); opacity:.82; }

/* ---------- 工具栏 / 搜索 / chip ---------- */
.mrr-filters{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:12px 0; }
.mrr-search{ position:relative; flex:1 1 260px; max-width:360px; min-width:180px; }
.mrr-search input{ width:100%; height:32px; appearance:none; border:1px solid var(--mrr-line); border-radius:8px;
  background:var(--mrr-bg); color:var(--mrr-fg); font-size:12.5px; padding:0 12px 0 30px; outline:none;
  transition:border-color .12s,box-shadow .12s; }
.mrr-search input::placeholder{ color:var(--mrr-fg-dim); }
.mrr-search input:focus{ border-color:var(--mrr-accent); box-shadow:0 0 0 3px var(--mrr-accent-soft); }
.mrr-search input::-webkit-search-cancel-button{ display:none; }
.mrr-search svg{ position:absolute; left:10px; top:50%; transform:translateY(-50%); opacity:.5; pointer-events:none; }
.mrr-chip{ appearance:none; display:inline-flex; align-items:center; gap:6px; height:27px; padding:0 10px; border-radius:999px; cursor:pointer;
  border:1px solid var(--mrr-line); background:transparent; color:var(--mrr-fg2);
  font:600 11.5px/1 -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif; white-space:nowrap;
  transition:background-color .12s,color .12s,border-color .12s; }
.mrr-chip:hover{ background:var(--mrr-hover); color:var(--mrr-fg); }
.mrr-chip:focus-visible{ outline:2px solid var(--mrr-accent); outline-offset:2px; }
.mrr-chip[data-active="1"]{ background:var(--mrr-accent-soft); color:var(--mrr-accent); border-color:transparent; }
.mrr-chip[data-active="1"]::before{ content:""; width:5px; height:5px; border-radius:50%; background:currentColor; }

/* ---------- 卡片 ---------- */
.mrr-card{ border:1px solid var(--mrr-line-soft); border-radius:10px; background:var(--mrr-bg);
  overflow:hidden; overflow:clip; display:flex; flex-direction:column; min-width:0; }
.mrr-tablebar{ display:flex; align-items:center; gap:10px; padding:9px 16px; min-height:40px;
  border-bottom:1px solid var(--mrr-line-soft); }
.mrr-tablebar-title{ font-size:14px; line-height:20px; font-weight:600; color:var(--mrr-fg); }
.mrr-tablebar-sub{ font-size:11px; color:var(--mrr-fg3); margin-right:auto; }
.mrr-exportbtn{ appearance:none; height:26px; padding:0 10px; border-radius:7px; cursor:pointer; white-space:nowrap;
  border:1px solid var(--mrr-line); background:var(--mrr-bg); color:var(--mrr-fg2); font-size:11.5px; font-weight:500; }
.mrr-exportbtn:hover{ background:var(--mrr-hover); color:var(--mrr-fg); }
.mrr-exportbtn:focus-visible{ outline:2px solid var(--mrr-accent); outline-offset:2px; }
.mrr-exportnote{ font-size:11px; color:var(--mrr-bad); }

/* ---------- 表格 ---------- */
.mrr-table{ width:100%; border-collapse:separate; border-spacing:0; font-size:12.5px; }
.mrr-table thead{ position:sticky; top:38px; z-index:1; }
.mrr-table thead th{ text-align:left; font:500 11px/14px -apple-system,"Segoe UI","PingFang SC",system-ui,sans-serif;
  letter-spacing:.04em; color:var(--mrr-fg3); padding:8px 12px; white-space:nowrap;
  background:var(--mrr-bg);
  border-bottom:1px solid var(--mrr-line); }
.mrr-table thead th:first-child{ padding-left:14px; }
.mrr-table thead th:last-child{ padding-right:16px; }
.mrr-table tbody td{ padding:6px 12px; border-bottom:1px solid var(--mrr-line-soft); vertical-align:middle; }
.mrr-table tbody td:first-child{ padding-left:14px; }
.mrr-table tbody td:last-child{ padding-right:16px; }
.mrr-table tbody tr{ transition:background-color .12s ease-out,box-shadow .12s ease-out; }
.mrr-table tbody tr:last-child td{ border-bottom:0; }
.mrr-table tbody tr:hover{ background:var(--mrr-hover); box-shadow:inset 2px 0 0 var(--mrr-accent); }
.mrr-row-clickable{ cursor:pointer; }
.mrr-row-clickable:focus-visible{ outline:2px solid var(--mrr-accent); outline-offset:-2px; }
.mrr-td-rank{ width:46px; text-align:center; white-space:nowrap; }
.mrr-td-rank .mrr-num{ font-size:12.5px; font-weight:500; color:var(--mrr-fg3); }
.mrr-table tbody tr:hover .mrr-td-rank .mrr-num{ color:var(--mrr-fg2); }

/* 名次 chip（取代金/银/铜圆章） */
.mrr-medal{ display:inline-flex; width:20px; height:20px; align-items:center; justify-content:center;
  border-radius:6px; font-size:11.5px; font-weight:700; font-variant-numeric:tabular-nums; }
.mrr-medal[data-medal="1"]{ background:var(--mrr-accent); color:#fff; }
.mrr-medal[data-medal="2"],.mrr-medal[data-medal="3"]{ background:var(--mrr-accent-soft); color:var(--mrr-accent); }

/* 模型单元格 */
.mrr-modelname{ display:flex; flex-direction:column; gap:1px; min-width:0; }
.mrr-modelname b{ display:block; font-weight:600; font-size:13px; line-height:18px; color:var(--mrr-fg);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:330px; }
.mrr-modelname span{ display:block; font-size:11px; line-height:15px; color:var(--mrr-fg3);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:330px; }
.mrr-badges{ display:inline-flex; gap:5px; flex-wrap:wrap; }
.mrr-badge{ display:inline-flex; align-items:center; gap:5px; height:19px; padding:0 7px; border-radius:999px;
  font-size:10.5px; line-height:1; font-weight:600; white-space:nowrap; }
.mrr-badge[data-kind="local"]{ background:var(--mrr-accent-soft); color:var(--mrr-accent); }
.mrr-badge[data-kind="default"]{ background:color-mix(in srgb,var(--mrr-good) 14%,transparent); color:var(--mrr-good); }
.mrr-badge[data-kind="open"]{ border:1px solid var(--mrr-line); color:var(--mrr-fg3); background:transparent; }
.mrr-badge[data-kind="stale"]{ background:color-mix(in srgb,var(--mrr-warn) 15%,transparent); color:color-mix(in srgb,var(--mrr-warn) 78%,var(--mrr-fg)); }
.mrr-muted{ color:var(--mrr-fg3); }

/* 数值 / 条形 */
.mrr-barwrap{ display:flex; align-items:center; justify-content:flex-end; gap:10px; min-width:0; }
.mrr-bar{ flex:0 0 88px; height:5px; border-radius:3px; background:var(--mrr-bg-soft); position:relative; overflow:hidden; }
.mrr-bar i{ display:block; position:absolute; inset:0; border-radius:3px; background:var(--mrr-accent); }
.mrr-barval{ font-size:12.5px; font-weight:600; color:var(--mrr-fg); font-variant-numeric:tabular-nums; }
.mrr-num{ font-size:12.5px; font-weight:600; color:var(--mrr-fg); font-variant-numeric:tabular-nums; }
.mrr-cell2{ display:flex; flex-direction:column; gap:1px; line-height:1.35; }
.mrr-cell2 small{ font-size:10.5px; color:var(--mrr-fg3); font-weight:400; }
.mrr-change{ font-size:11px; font-weight:600; display:inline-flex; align-items:center; gap:2px; font-variant-numeric:tabular-nums; }
.mrr-change[data-kind="up"]{ color:var(--mrr-good); }
.mrr-change[data-kind="down"]{ color:var(--mrr-bad); }
.mrr-change[data-kind="new"]{ color:var(--mrr-accent); }

/* 表头排序 */
.mrr-th-sort{ cursor:pointer; user-select:none; }
.mrr-th-sort:hover{ color:var(--mrr-fg2); }
.mrr-th-sort:focus-visible{ outline:2px solid var(--mrr-accent); outline-offset:-2px; }
.mrr-th-sort[data-active="1"]{ color:var(--mrr-accent); }
.mrr-th-sort .mrr-sortarrow{ font-size:9px; margin-left:3px; opacity:.8; }

/* 数据源状态条 */
.mrr-srcbar{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin:0 0 10px; padding:7px 12px;
  border:1px solid var(--mrr-line-soft); border-radius:8px; background:var(--mrr-bg-soft);
  font-size:11px; line-height:16px; color:var(--mrr-fg3); }
.mrr-srcbar-dot{ width:6px; height:6px; border-radius:50%; background:var(--mrr-good); flex:0 0 auto;
  box-shadow:0 0 0 3px color-mix(in srgb,var(--mrr-good) 16%,transparent); }
.mrr-srcbar[data-kind="warn"] .mrr-srcbar-dot{ background:var(--mrr-warn); box-shadow:0 0 0 3px color-mix(in srgb,var(--mrr-warn) 18%,transparent); }
.mrr-srcbar-name{ font-weight:600; color:var(--mrr-fg2); }
.mrr-srcbar-msg{ color:var(--mrr-fg2); }
.mrr-srcbar[data-kind="warn"] .mrr-srcbar-msg{ color:color-mix(in srgb,var(--mrr-warn) 74%,var(--mrr-fg)); }
.mrr-srcbar-link{ color:var(--mrr-fg3); text-decoration:none; border-bottom:1px dotted var(--mrr-line); }
.mrr-srcbar-link:hover{ color:var(--mrr-accent); }
.mrr-srcbar-asof{ margin-left:auto; font-variant-numeric:tabular-nums; }
.mrr-srcbar-asof + .mrr-srcbar-asof{ margin-left:0; }

/* 分享榜列表 */
.mrr-share{ display:flex; align-items:center; gap:14px; padding:0 16px; height:52px; border-bottom:1px solid var(--mrr-line-soft); }
.mrr-share:last-child{ border-bottom:0; }
.mrr-share:hover{ background:var(--mrr-hover); }
.mrr-share .mrr-sharerank{ width:22px; text-align:center; font-size:12px; font-weight:600; color:var(--mrr-fg3); }
.mrr-share .mrr-shareauthor{ flex:0 0 130px; display:flex; align-items:center; gap:7px; font-weight:600; font-size:12.8px; }
.mrr-share .mrr-sharebar{ flex:1; height:6px; border-radius:3px; background:var(--mrr-bg-soft); position:relative; overflow:hidden; }
.mrr-share .mrr-sharebar i{ display:block; position:absolute; inset:0; border-radius:3px; background:var(--mrr-accent); transition:width .3s; }
.mrr-shareval{ flex:0 0 56px; text-align:right; font-weight:600; }

/* 接入清单 */
.mrr-localgrid{ display:grid; grid-template-columns:repeat(auto-fill,minmax(232px,1fr)); gap:10px; padding:12px 14px 14px; }
.mrr-localcard{ border:1px solid var(--mrr-line-soft); border-radius:8px; padding:10px 12px 11px; background:var(--mrr-bg); }
.mrr-localcard h3{ margin:0 0 7px; font-size:12.5px; line-height:18px; font-weight:600; display:flex; align-items:baseline; gap:7px; }
.mrr-localmodels{ display:flex; flex-wrap:wrap; gap:4px; }
.mrr-modelchip{ font-size:11px; line-height:1; background:var(--mrr-bg-soft); border:1px solid transparent;
  color:var(--mrr-fg2); padding:4px 7px; border-radius:999px; white-space:nowrap; }
.mrr-modelchip[data-hit="1"]{ background:var(--mrr-accent-soft); color:var(--mrr-accent); }

/* 说明 / 空态 / footer */
.mrr-note{ margin-top:auto; padding:7px 16px; border-top:1px solid var(--mrr-line-soft);
  font-size:11px; line-height:17px; color:var(--mrr-fg3); display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.mrr-empty{ padding:46px 20px 50px; text-align:center; color:var(--mrr-fg3); }
.mrr-empty h2{ color:var(--mrr-fg); font-size:15px; line-height:22px; font-weight:600; margin:0 0 6px; }
.mrr-empty p{ margin:0 auto 16px; max-width:360px; font-size:12.5px; line-height:20px; }
.mrr-ranklist{ display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:8px; padding:6px 18px 16px; }
.mrr-rankrow{ display:flex; align-items:center; gap:10px; border:1px solid var(--mrr-line-soft); border-radius:8px; padding:8px 12px; }
.mrr-rankrow .mrr-myrank{ width:28px; text-align:center; font-weight:700; color:var(--mrr-accent); }
.mrr-rankrow b{ font-size:12.5px; }
.mrr-rankrow small{ margin-left:auto; color:var(--mrr-fg3); font-size:11px; }
.mrr-footer{ margin-top:12px; padding-top:8px; border-top:1px solid var(--mrr-line-soft);
  display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap;
  font-size:11px; line-height:17px; color:var(--mrr-fg3); }
.mrr-footer a{ color:inherit; text-decoration:none; border-bottom:1px dotted var(--mrr-line); }
.mrr-footer a:hover{ color:var(--mrr-accent); }
.mrr-err{ margin:0 0 10px; padding:9px 12px; border-radius:8px; font-size:12px; line-height:18px; color:var(--mrr-fg2);
  border:1px solid color-mix(in srgb,var(--mrr-bad) 26%,transparent);
  background:color-mix(in srgb,var(--mrr-bad) 7%,transparent); }
.mrr-loading{ padding:48px 0; text-align:center; color:var(--mrr-fg3); font-size:13px; }

/* ==========================================================================
   本机用量仪表盘（mrr-usage-*）
   ========================================================================== */
.mrr-usage{ display:flex; flex-direction:column; gap:10px; }
.mrr-usage-head{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; padding:2px 2px 0; }
.mrr-usage-title{ margin:0; font-size:15px; line-height:22px; font-weight:600; letter-spacing:.2px; display:flex; align-items:center; gap:8px; }
.mrr-usage-title .mrr-usage-titlebadge{ font-size:10px; font-weight:600; letter-spacing:.02em; padding:2px 7px; border-radius:6px;
  background:var(--mrr-accent-soft); color:var(--mrr-accent); }
.mrr-usage-sub{ margin-top:2px; font-size:11.5px; line-height:17px; color:var(--mrr-fg3); display:flex; align-items:center; gap:4px 12px; flex-wrap:wrap; }
.mrr-usage-actions{ display:flex; align-items:center; gap:8px; flex-shrink:0; }
.mrr-usage-ghostbtn{ appearance:none; height:28px; padding:0 11px; border:1px solid var(--mrr-line); border-radius:8px;
  background:var(--mrr-bg); color:var(--mrr-fg2); font-size:11.5px; font-weight:500; cursor:pointer;
  transition:background-color .12s,color .12s; }
.mrr-usage-ghostbtn:hover{ background:var(--mrr-hover); color:var(--mrr-fg); }
.mrr-usage-ghostbtn:disabled{ opacity:.6; cursor:default; }
.mrr-usage-meta{ display:flex; flex-wrap:wrap; gap:3px 16px; padding:0 2px; font-size:10.5px; line-height:16px; color:var(--mrr-fg3); }
.mrr-usage-warns{ display:flex; flex-direction:column; gap:5px; }
.mrr-usage-warn{ font-size:11.5px; line-height:17px; color:var(--mrr-fg2);
  background:color-mix(in srgb,var(--mrr-warn) 9%,transparent); border-radius:8px; padding:6px 10px; }

/* 概览：标题 + 范围切换 + KPI */
.mrr-usage-overview{ display:flex; flex-direction:column; gap:8px; margin-top:2px; }
.mrr-usage-overview-head{ display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.mrr-usage-overview-head h3{ margin:0; font-size:14px; line-height:20px; font-weight:600; }
.mrr-usage-overview-actions{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.mrr-usage-toolbar{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
.mrr-usage-seg{ display:inline-flex; align-items:center; gap:2px; padding:2px; border:1px solid var(--mrr-line-soft); border-radius:8px; background:var(--mrr-bg-soft); }
.mrr-usage-seg button{ appearance:none; border:0; background:transparent; color:var(--mrr-fg3); cursor:pointer;
  height:24px; padding:0 10px; border-radius:6px; font-size:11.5px; font-weight:500; white-space:nowrap; transition:background-color .12s,color .12s; }
.mrr-usage-seg button:hover{ color:var(--mrr-fg2); }
.mrr-usage-seg button:focus-visible{ outline:2px solid var(--mrr-accent); outline-offset:1px; }
.mrr-usage-seg button[data-active="1"]{ background:var(--mrr-bg); color:var(--mrr-fg); font-weight:600; box-shadow:0 1px 2px rgba(15,23,42,.07); }
.mrr-usage-rangesum{ font-size:11.5px; color:var(--mrr-fg3); display:flex; gap:4px 12px; flex-wrap:wrap; }
.mrr-usage-rangesum b{ color:var(--mrr-fg2); font-weight:600; }

.mrr-usage-kpis{ display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:10px; }
.mrr-usage-kpi{ border:1px solid var(--mrr-line-soft); border-radius:10px; background:var(--mrr-bg);
  padding:9px 13px 10px; display:flex; flex-direction:column; gap:3px; min-width:0; transition:border-color .12s; }
.mrr-usage-kpi:hover{ border-color:var(--mrr-line); }
.mrr-usage-kpi-label{ font-size:11.5px; line-height:16px; color:var(--mrr-fg3); font-weight:500; }
.mrr-usage-kpi-tag{ font-size:9.5px; letter-spacing:.02em; padding:1px 6px; border-radius:5px; background:var(--mrr-bg-soft); color:var(--mrr-fg3); margin-left:6px; }
.mrr-usage-kpi-main{ display:flex; align-items:flex-end; justify-content:space-between; gap:8px; }
.mrr-usage-kpi-value{ font-size:22px; line-height:26px; font-weight:600; letter-spacing:-.3px; color:var(--mrr-fg); white-space:nowrap; font-variant-numeric:tabular-nums; }
.mrr-usage-kpi-value small{ font-size:11px; font-weight:500; letter-spacing:0; color:var(--mrr-fg3); margin-left:3px; }
.mrr-usage-kpi-meta{ display:flex; align-items:baseline; gap:3px 10px; flex-wrap:wrap; font-size:11px; line-height:16px; color:var(--mrr-fg3); }
.mrr-usage-kpi-meta b{ color:var(--mrr-fg2); font-weight:600; font-variant-numeric:tabular-nums; }
.mrr-usage-kpi-share{ margin-top:auto; height:3px; border-radius:3px; background:var(--mrr-bg-soft); overflow:hidden; }
.mrr-usage-kpi-share i{ display:block; height:100%; border-radius:3px; background:color-mix(in srgb,var(--mrr-accent) 45%,transparent); }
.mrr-usage-spark{ flex:0 0 auto; color:var(--mrr-accent); opacity:.85; }
.mrr-usage-spark svg{ display:block; width:64px; height:18px; }
.mrr-usage-spark polyline{ fill:none; stroke:currentColor; stroke-width:1.4; stroke-linecap:round; stroke-linejoin:round; }
.mrr-usage-cred{ font-size:9.5px; padding:1px 6px; border-radius:5px; background:var(--mrr-bg-soft); color:var(--mrr-fg3); }

/* 区块（用量页卡片） */
.mrr-usage-section{ border:1px solid var(--mrr-line-soft); border-radius:10px; background:var(--mrr-bg); overflow:hidden; display:flex; flex-direction:column; }
.mrr-usage-sectionhead{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; flex-wrap:wrap;
  padding:9px 16px; min-height:40px; border-bottom:1px solid var(--mrr-line-soft); }
.mrr-usage-sectionhead h3{ margin:0; font-size:14px; line-height:20px; font-weight:600; display:flex; align-items:center; gap:8px; }
.mrr-usage-sectionhead .mrr-usage-sechead-sub{ font-size:11px; color:var(--mrr-fg3); }
.mrr-usage-grid2{ display:grid; grid-template-columns:1.62fr 1fr; gap:12px; align-items:stretch; }
.mrr-usage-grid-rail{ display:grid; grid-template-columns:1.72fr 1fr; gap:12px; align-items:stretch; }
.mrr-usage-rail{ display:flex; flex-direction:column; gap:12px; min-width:0; }

/* 模型用量表 */
.mrr-usage-modeltable td{ padding:6px 12px; }
.mrr-usage-modeltable tbody tr{ height:40px; }
.mrr-usage-tokencell{ display:flex; flex-direction:column; gap:3px; min-width:120px; }
.mrr-usage-tokenline{ display:flex; align-items:baseline; gap:6px; }
.mrr-usage-tokenline b{ font-weight:600; font-size:12.5px; color:var(--mrr-fg); font-variant-numeric:tabular-nums; }
.mrr-usage-tokenline small{ color:var(--mrr-fg3); font-size:10.5px; }
.mrr-usage-sharebar{ height:4px; border-radius:3px; background:var(--mrr-bg-soft); overflow:hidden; }
.mrr-usage-sharebar i{ display:block; height:100%; border-radius:3px; background:var(--mrr-accent); opacity:.62; }
.mrr-usage-modelname{ display:flex; flex-direction:column; gap:1px; min-width:0; }
.mrr-usage-modelname b{ font-weight:600; font-size:13px; line-height:18px; color:var(--mrr-fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:260px; }
.mrr-usage-modelname span{ font-size:11px; line-height:15px; color:var(--mrr-fg3); }
.mrr-usage-cell2{ display:flex; flex-direction:column; gap:1px; line-height:1.35; }
.mrr-usage-cell2 small{ color:var(--mrr-fg3); font-size:10.5px; }
.mrr-usage-dim{ color:var(--mrr-fg3); }
.mrr-usage-num{ font-variant-numeric:tabular-nums; font-weight:600; color:var(--mrr-fg2); }

/* 厂商分布 */
.mrr-usage-providers{ display:flex; flex-direction:column; gap:1px; padding:4px 16px 8px; }
.mrr-usage-prow{ display:flex; align-items:center; gap:10px; min-width:0; height:28px; }
.mrr-usage-pname{ flex:0 0 92px; font-size:12px; font-weight:500; color:var(--mrr-fg2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mrr-usage-pbar{ flex:1 1 auto; height:6px; border-radius:3px; background:var(--mrr-bg-soft); overflow:hidden; }
.mrr-usage-pbar i{ display:block; height:100%; border-radius:3px; background:var(--mrr-accent); }
.mrr-usage-prow:nth-child(n+2) .mrr-usage-pbar i{ opacity:.62; }
.mrr-usage-pval{ flex:0 0 44px; text-align:right; font-size:11.5px; font-weight:600; font-variant-numeric:tabular-nums; }
.mrr-usage-pmeta{ flex:0 0 104px; text-align:right; font-size:10.5px; color:var(--mrr-fg3); white-space:nowrap; }

/* 趋势图 */
.mrr-usage-chart{ padding:8px 12px 4px; }
.mrr-usage-chart svg{ display:block; width:100%; height:auto; overflow:visible; }
.mrr-usage-chart rect{ fill:color-mix(in srgb,var(--mrr-accent) 42%,transparent); transition:fill .12s; }
.mrr-usage-chart rect[data-today="1"]{ fill:var(--mrr-accent); }
.mrr-usage-chart rect:hover{ fill:var(--mrr-accent); }
.mrr-usage-chart .mrr-usage-axis{ fill:var(--mrr-fg3); font-size:10px; }
.mrr-usage-chart .mrr-usage-gridline{ stroke:var(--mrr-line-soft); stroke-width:1; }
.mrr-usage-chartfoot{ display:flex; align-items:center; justify-content:space-between; gap:10px; padding:0 16px 8px; font-size:10.5px; color:var(--mrr-fg3); }

/* 账户 */
.mrr-usage-accounts{ display:flex; flex-direction:column; gap:0; padding:2px 14px 8px; }
.mrr-usage-account{ padding:6px 0 7px; border-bottom:1px solid var(--mrr-line-soft); display:flex; flex-direction:column; gap:4px; }
.mrr-usage-account:last-child{ border-bottom:0; padding-bottom:4px; }
.mrr-usage-accounthead{ display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.mrr-usage-accounthead b{ font-size:12.5px; color:var(--mrr-fg); font-weight:600; }
.mrr-usage-accounthead .mrr-usage-dim{ margin-left:auto; font-size:10.5px; }
.mrr-usage-balance{ font-size:16px; line-height:20px; font-weight:600; color:var(--mrr-fg); display:flex; align-items:baseline; gap:5px; font-variant-numeric:tabular-nums; }
.mrr-usage-balance small{ font-size:10.5px; font-weight:500; color:var(--mrr-fg3); }
.mrr-usage-plan{ display:grid; grid-template-columns:34px 1fr auto; align-items:center; gap:8px; font-size:10.5px; color:var(--mrr-fg3); height:18px; }
.mrr-usage-planbar{ height:4px; border-radius:3px; background:var(--mrr-bg-soft); overflow:hidden; }
.mrr-usage-planbar i{ display:block; height:100%; border-radius:3px; background:var(--mrr-accent); }
.mrr-usage-acct-state{ font-size:11px; line-height:17px; color:var(--mrr-fg3); }

/* 接入清单（用量页内） */
.mrr-usage-connusage{ margin-top:7px; padding-top:6px; border-top:1px solid var(--mrr-line-soft);
  display:flex; align-items:center; gap:4px 10px; flex-wrap:wrap; font-size:10.5px; color:var(--mrr-fg3); }
.mrr-usage-connusage b{ color:var(--mrr-fg2); font-weight:600; font-variant-numeric:tabular-nums; }

/* 空态 / 骨架 */
.mrr-usage-empty{ border:1px solid var(--mrr-line-soft); border-radius:10px; padding:40px 20px; text-align:center; color:var(--mrr-fg3); }
.mrr-usage-empty b{ display:block; color:var(--mrr-fg); font-size:15px; font-weight:600; margin-bottom:6px; }
.mrr-usage-empty p{ margin:0 auto 14px; max-width:420px; font-size:12.5px; line-height:20px; }
.mrr-usage-skeleton{ padding:14px 16px; display:flex; flex-direction:column; gap:9px; }
.mrr-usage-skbar{ height:12px; border-radius:6px; background:var(--mrr-bg-soft); position:relative; overflow:hidden; }
.mrr-usage-skbar::after{ content:""; position:absolute; inset:0; transform:translateX(-100%);
  background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--mrr-bg) 65%,transparent),transparent); animation:mrr-shimmer 1.4s linear infinite; }
.mrr-usage-skbar[data-w="1"]{ width:100%; } .mrr-usage-skbar[data-w="2"]{ width:72%; } .mrr-usage-skbar[data-w="3"]{ width:46%; }
@keyframes mrr-shimmer{ to{ transform:translateX(100%); } }

/* ==========================================================================
   能力榜（mrr-lb-*）
   ========================================================================== */
.mrr-lb{ display:flex; flex-direction:column; gap:10px; }
.mrr-lb-head{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:0 2px 2px; font-size:11.5px; line-height:18px; color:var(--mrr-fg3); }
.mrr-lb-titleline{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.mrr-lb-titleline h2{ margin:0; font-size:14px; line-height:20px; font-weight:600; color:var(--mrr-fg); }
.mrr-lb-badge{ display:inline-flex; align-items:center; height:21px; padding:0 8px; border-radius:6px;
  background:var(--mrr-accent-soft); color:var(--mrr-accent); font-size:11px; font-weight:600; letter-spacing:.01em; }
.mrr-lb-sub{ font-size:11.5px; color:var(--mrr-fg3); display:flex; align-items:center; gap:4px 10px; flex-wrap:wrap; }
.mrr-lb-sub a{ color:var(--mrr-fg3); text-decoration:none; border-bottom:1px dotted var(--mrr-line); }
.mrr-lb-sub a:hover{ color:var(--mrr-accent); }
.mrr-lb-notes{ font-size:11.5px; line-height:17px; color:var(--mrr-fg3); }
.mrr-lb-notes summary{ cursor:pointer; color:var(--mrr-fg2); }
.mrr-lb-notes ul{ margin:6px 0 0; padding-left:18px; display:flex; flex-direction:column; gap:3px; }
.mrr-lb-chips{ display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:0 0 2px; }
.mrr-lb-chiplabel{ font-size:10.5px; letter-spacing:.04em; color:var(--mrr-fg3); margin-right:2px; }
.mrr-lb-table td{ padding:6px 12px; }
.mrr-lb-heats{ display:inline-flex; gap:3px; justify-content:flex-end; }
.mrr-lb-heat{ display:inline-flex; width:22px; height:22px; border-radius:4px; align-items:center; justify-content:center;
  background:var(--mrr-bg-soft); color:var(--mrr-fg3); font-size:9.5px; font-weight:600; font-variant-numeric:tabular-nums; }
.mrr-lb-heat[data-tier="0"]{ background:color-mix(in srgb,var(--mrr-accent) 12%,transparent); color:var(--mrr-fg2); }
.mrr-lb-heat[data-tier="1"]{ background:color-mix(in srgb,var(--mrr-accent) 30%,transparent); color:var(--mrr-fg); }
.mrr-lb-heat[data-tier="2"]{ background:color-mix(in srgb,var(--mrr-accent) 55%,transparent); color:#fff; }
.mrr-lb-heat[data-tier="3"]{ background:color-mix(in srgb,var(--mrr-accent) 85%,transparent); color:#fff; }
.mrr-lb-heat[data-missing="1"]{ background:transparent; border:1px dashed var(--mrr-line); color:var(--mrr-fg-dim); }
.mrr-lb-heat[data-sel="1"]{ box-shadow:0 0 0 1.5px var(--mrr-accent); }
/* 注意：th 不能改成 flex（会脱离 table-cell 导致列错位），用块级内容 + 右对齐代替 */
.mrr-table thead th.mrr-lb-cell-head{ text-align:right; padding-top:6px; padding-bottom:6px; }
.mrr-lb-cell-head > span:first-child{ display:block; }
.mrr-lb-cell-head .mrr-lb-codes{ display:flex; justify-content:flex-end; gap:3px; margin-top:3px; }
.mrr-lb-codes span{ width:22px; text-align:center; font-size:8.5px; line-height:11px; letter-spacing:.05em; color:var(--mrr-fg-dim); font-weight:600; }
.mrr-lb-legend{ display:inline-flex; align-items:center; gap:3px; margin-left:6px; }
.mrr-lb-legend i{ width:9px; height:9px; border-radius:2px; display:inline-block; }
.mrr-lb-legend i[data-tier="0"]{ background:color-mix(in srgb,var(--mrr-accent) 12%,transparent); }
.mrr-lb-legend i[data-tier="1"]{ background:color-mix(in srgb,var(--mrr-accent) 30%,transparent); }
.mrr-lb-legend i[data-tier="2"]{ background:color-mix(in srgb,var(--mrr-accent) 55%,transparent); }
.mrr-lb-legend i[data-tier="3"]{ background:color-mix(in srgb,var(--mrr-accent) 85%,transparent); }
.mrr-lb-catname{ color:var(--mrr-fg2); }
.mrr-lb-foot{ font-size:11px; line-height:17px; color:var(--mrr-fg3); padding:0 2px; display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; }

/* ==========================================================================
   明细抽屉
   ========================================================================== */
.mrr-drawer-mask{ position:fixed; inset:0; z-index:40; background:var(--mrr-mask); display:flex; justify-content:flex-end;
  animation:mrr-fade .16s ease-out; }
@keyframes mrr-fade{ from{ opacity:0; } to{ opacity:1; } }
.mrr-drawer{ width:min(420px,92vw); height:100%; background:var(--mrr-bg-raised); border-left:1px solid var(--mrr-line);
  box-shadow:-8px 0 32px rgba(15,23,42,.16); display:flex; flex-direction:column; overflow:hidden;
  animation:mrr-slide .16s cubic-bezier(.32,.72,0,1); }
@keyframes mrr-slide{ from{ transform:translateX(24px); opacity:.6; } to{ transform:translateX(0); opacity:1; } }
.mrr-drawer-head{ flex:0 0 auto; display:flex; align-items:flex-start; gap:10px; padding:15px 14px 12px 16px; border-bottom:1px solid var(--mrr-line-soft); }
.mrr-drawer-head-main{ min-width:0; flex:1; }
.mrr-drawer-head h2{ margin:0 0 3px; font-size:15px; line-height:22px; font-weight:600; color:var(--mrr-fg); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mrr-drawer-sub{ display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11.5px; line-height:16px; color:var(--mrr-fg3); }
.mrr-drawer-close{ appearance:none; flex:0 0 auto; width:28px; height:28px; border:0; border-radius:7px;
  background:transparent; color:var(--mrr-fg3); font-size:17px; line-height:1; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; }
.mrr-drawer-close:hover{ background:var(--mrr-hover); color:var(--mrr-fg); }
.mrr-drawer-close:focus-visible{ outline:2px solid var(--mrr-accent); outline-offset:2px; }
.mrr-drawer-body{ flex:1; overflow-y:auto; padding:2px 16px 22px; }
.mrr-drawer-sec{ padding:12px 0 3px; border-top:1px solid var(--mrr-line-soft); }
.mrr-drawer-sec:first-child{ border-top:0; }
.mrr-drawer-label{ margin:0 0 8px; font-size:10.5px; line-height:14px; font-weight:500; letter-spacing:.06em; color:var(--mrr-fg3); }
.mrr-kvgrid{ display:grid; grid-template-columns:1fr 1fr; gap:9px 12px; }
.mrr-kv{ display:flex; flex-direction:column; gap:2px; min-width:0; }
.mrr-kv-label{ font-size:10.5px; line-height:14px; color:var(--mrr-fg3); }
.mrr-kv-value{ font-size:14px; line-height:19px; font-weight:600; color:var(--mrr-fg); display:flex; align-items:baseline; gap:5px; font-variant-numeric:tabular-nums; }
.mrr-kv-value small{ font-size:10.5px; font-weight:500; color:var(--mrr-fg3); }
.mrr-kvrow{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:4px 0; font-size:12px; line-height:18px; }
.mrr-kvrow span:first-child{ color:var(--mrr-fg3); }
.mrr-kvrow b{ font-weight:600; color:var(--mrr-fg); font-variant-numeric:tabular-nums; text-align:right; }
.mrr-bench{ display:flex; align-items:center; gap:9px; height:25px; }
.mrr-bench-name{ flex:0 0 138px; font-size:11.5px; color:var(--mrr-fg2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.mrr-bench-w{ font-size:9.5px; color:var(--mrr-fg-dim); margin-left:3px; }
.mrr-bench-track{ flex:1; height:4px; border-radius:3px; background:var(--mrr-bg-soft); overflow:hidden; }
.mrr-bench-track i{ display:block; height:100%; border-radius:3px; background:var(--mrr-accent); }
.mrr-bench-track[data-quiet="1"] i{ opacity:.55; }
.mrr-bench-val{ flex:0 0 48px; text-align:right; font-size:11.5px; font-weight:600; font-variant-numeric:tabular-nums; }
.mrr-usagebox{ border:1px solid var(--mrr-line-soft); border-radius:8px; padding:9px 12px; background:var(--mrr-bg-soft); }
.mrr-usagebox-top{ display:flex; align-items:baseline; gap:8px; flex-wrap:wrap; }
.mrr-usagebox-top b{ font-size:17px; line-height:22px; font-weight:600; color:var(--mrr-fg); font-variant-numeric:tabular-nums; }
.mrr-usagebox-top b small{ font-size:11px; font-weight:500; color:var(--mrr-fg3); margin-left:2px; }
.mrr-usagebox-sub{ margin-top:3px; font-size:11px; line-height:17px; color:var(--mrr-fg3); display:flex; gap:3px 8px; flex-wrap:wrap; }
.mrr-drawer-foot{ font-size:10.5px; line-height:17px; color:var(--mrr-fg3); padding:0; }

/* ---------- 窄屏：表格转卡片 ---------- */
@media (max-width:900px){
  .mrr-root{ padding:0 14px 24px; }
  .mrr-head{ padding-top:16px; flex-wrap:wrap; align-items:flex-start; }
  .mrr-headtitle h1{ font-size:17px; line-height:24px; }
  .mrr-headactions{ margin-left:0; }
  .mrr-tabs{ overflow-x:auto; scrollbar-width:none; -ms-overflow-style:none;
    -webkit-mask-image:linear-gradient(to right,#000 calc(100% - 22px),transparent);
    mask-image:linear-gradient(to right,#000 calc(100% - 22px),transparent); }
  .mrr-tabs::-webkit-scrollbar{ display:none; }
  .mrr-filters{ padding:10px 0; }
  .mrr-search{ max-width:none; flex-basis:100%; }
  .mrr-usage-grid2,.mrr-usage-grid-rail{ grid-template-columns:1fr; }
  .mrr-usage-kpis{ grid-template-columns:repeat(2,minmax(0,1fr)); }
  .mrr-usage-kpi-value{ font-size:20px; }
  .mrr-usage-overview-head{ align-items:flex-start; }
  .mrr-drawer{ width:min(420px,92vw); }
  .mrr-footer{ flex-direction:column; }
  .mrr-srcbar-asof{ margin-left:0; }
  .mrr-table colgroup, .mrr-table thead{ display:none; }
  .mrr-table, .mrr-table tbody{ display:block; }
  .mrr-table tbody tr{ display:flex; flex-wrap:wrap; align-items:center; gap:3px 8px;
    height:auto; margin:0 0 8px; padding:10px 12px; border:1px solid var(--mrr-line-soft); border-radius:9px; }
  .mrr-table tbody tr:last-child{ margin-bottom:0; }
  .mrr-table tbody td{ display:block; padding:0; border:0; }
  .mrr-table tbody tr:hover{ box-shadow:none; }
  .mrr-table tbody td[data-label]{ order:6; flex:0 0 auto; display:inline-flex; align-items:baseline; gap:5px; }
  .mrr-table tbody td[data-label]:not(.mrr-td-status)::before{ content:attr(data-label); font-size:10.5px; color:var(--mrr-fg-dim); white-space:nowrap; }
  .mrr-table tbody td.mrr-td-rank{ order:1; width:auto; min-width:22px; }
  .mrr-table tbody td.mrr-td-model{ order:2; flex:1 1 45%; min-width:0; }
  .mrr-table tbody td.mrr-td-status{ order:3; margin-left:auto; text-align:right; }
  .mrr-table tbody td.mrr-td-metric{ order:4; flex:0 0 100%; display:flex; align-items:center; gap:8px; margin-top:3px; }
  .mrr-table tbody td.mrr-td-metric::before{ content:attr(data-label); font-size:10.5px; color:var(--mrr-fg-dim); min-width:64px; }
  .mrr-table tbody td.mrr-td-heat{ order:5; flex:0 0 100%; margin-top:3px; }
  .mrr-table tbody td .mrr-bar{ flex:0 0 64px; }
  .mrr-modelname b,.mrr-modelname span{ max-width:100%; }
  .mrr-lb-heats{ justify-content:flex-start; }
  .mrr-lb-head{ align-items:flex-start; }
  .mrr-usage-pmeta{ flex-basis:84px; }
  .mrr-usage-pname{ flex-basis:76px; }
}
@media (max-width:620px){
  .mrr-usage-kpis{ grid-template-columns:1fr; }
  .mrr-usage-seg{ overflow-x:auto; }
  .mrr-usage-accounthead .mrr-usage-dim{ display:none; }
  .mrr-drawer{ width:100%; }
  .mrr-kvgrid{ grid-template-columns:1fr; }
}
@media (prefers-reduced-motion: reduce){
  .mrr-root *{ animation-duration:.01ms !important; animation-iteration-count:1 !important; transition-duration:.01ms !important; }
}
[data-ds-dark-theme] .mrr-root{ --mrr-good:#3dd68c; --mrr-bad:#ff6369; }

/* 状态点 / 状态条分隔符（designer 阶段 B 新增结构） */
.mrr-livedot{ width:6px; height:6px; border-radius:50%; background:var(--mrr-good); flex:0 0 auto;
  box-shadow:0 0 0 3px color-mix(in srgb,var(--mrr-good) 16%,transparent); }
.mrr-livedot[data-kind="stale"]{ background:var(--mrr-warn); box-shadow:0 0 0 3px color-mix(in srgb,var(--mrr-warn) 18%,transparent); }
.mrr-livedot[data-kind="off"]{ background:var(--mrr-fg-dim); box-shadow:none; }
.mrr-srcbar-sep{ color:var(--mrr-fg-dim); }

.mrr-drawer-org{ display:inline-flex; align-items:center; gap:5px; }
.mrr-drawer-title{ font-size:15px; }
.mrr-drawer-link{ font-size:12px; color:var(--mrr-link); text-decoration:none; border-bottom:1px dotted color-mix(in srgb,var(--mrr-link) 40%,transparent); }
.mrr-drawer-link:hover{ border-bottom-style:solid; }
.mrr-usagebox-unit{ font-size:11px; font-weight:500; color:var(--mrr-fg3); margin-left:2px; }
.mrr-drawer-foot{ padding-top:10px; border-top:1px solid var(--mrr-line-soft); }

/* 数字列对齐（designer 阶段 B 补丁 2） */
.mrr-table thead th.mrr-th-num{ text-align:right; }
.mrr-table tbody td.mrr-td-num{ text-align:right; white-space:nowrap; }
.mrr-table thead th.mrr-th-num .mrr-sortarrow{ margin-left:2px; }

/* 用量模型表：右栏窄容器下的列宽收紧（保证 7 列在 1180 不溢出） */
.mrr-usage-modeltable td, .mrr-usage-modeltable th{ padding-left:8px; padding-right:8px; }
.mrr-usage-modeltable td:first-child, .mrr-usage-modeltable th:first-child{ padding-left:12px; width:38px; }
.mrr-usage-modeltable td:last-child, .mrr-usage-modeltable th:last-child{ padding-right:12px; }
.mrr-usage-modeltable .mrr-usage-modelname b{ max-width:248px; }
.mrr-usage-modeltable .mrr-usage-tokencell{ min-width:104px; }
.mrr-usage-grid-rail{ grid-template-columns:1.72fr 1fr; }

/* Lead 复核意见补丁（designer 阶段 B 补丁 3） */
.mrr-usage-linkbtn{ appearance:none; border:0; background:transparent; color:var(--mrr-fg3); cursor:pointer;
  font-size:11.5px; line-height:18px; padding:2px 4px; border-radius:5px;
  text-decoration:underline; text-decoration-style:dotted; text-underline-offset:3px; }
.mrr-usage-linkbtn:hover{ color:var(--mrr-accent); }
.mrr-usage-linkbtn:disabled{ opacity:.6; cursor:default; text-decoration:none; }
.mrr-usage-linkbtn:focus-visible{ outline:2px solid var(--mrr-accent); outline-offset:2px; }
.mrr-usage-sechead-right{ display:flex; align-items:center; gap:12px; margin-left:auto; min-width:0; }
.mrr-usage-sechead-right .mrr-usage-sechead-sub{ white-space:nowrap; }
.mrr-usage-sechead-right .mrr-search{ flex:0 1 220px; min-width:150px; max-width:240px; }
.mrr-lb-codes span{ font-size:9.5px; }
.mrr-lb-legend{ cursor:help; }
.mrr-lb-legend .mrr-lb-chiplabel{ letter-spacing:.04em; color:var(--mrr-fg3); }
`;

function installStyles() {
    let el = document.getElementById(STYLE_ID);
    if (el) return () => {};
    el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = CSS;
    (document.head || document.documentElement).appendChild(el);
    return () => { try { el && el.remove(); } catch { /* noop */ } };
  }

  // ---------------------------------------------------------------------------
  // 工具
  // ---------------------------------------------------------------------------

  function rpcGet(method) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    return fetch(`${RPC_BASE}/${method}`, { method: 'GET', signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then((raw) => { clearTimeout(timer); try { return JSON.parse(raw); } catch { throw new Error('响应不是 JSON'); } })
      .catch((err) => { clearTimeout(timer); throw err; });
  }

  function rpcPost(method, body, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(`${RPC_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then((raw) => { clearTimeout(timer); try { return JSON.parse(raw); } catch { throw new Error('响应不是 JSON'); } })
      .catch((err) => { clearTimeout(timer); throw err; });
  }

  function fmtCtx(tokens) {
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) return '—';
    if (tokens >= 1_000_000) {
      const m = tokens / 1_000_000;
      return `${Number.isInteger(m) ? m : m.toFixed(m < 10 ? 1 : 0)}M`;
    }
    if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
    return String(tokens);
  }

  function fmtPrice(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (v === 0) return '免费';
    if (v < 1) return '$' + v.toFixed(2).replace(/0$/, '');
    return '$' + (v < 10 ? v.toFixed(v % 1 === 0 ? 0 : 1) : Math.round(v));
  }

  function fmtSpeed(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    return `${Math.round(v)} t/s`;
  }

  function fmtTtft(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
    return `${(ms / 1000).toFixed(2)}s 首字`;
  }

  function relTime(isoLike) {
    const t = Date.parse(isoLike);
    if (!Number.isFinite(t)) return '';
    const diff = Date.now() - t;
    if (diff < 60_000) return '刚刚';
    const min = Math.floor(diff / 60_000);
    if (min < 60) return `${min} 分钟前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时前`;
    const d = new Date(t);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }

  // 搜索/匹配归一化：NFKC + 小写 + 去括注 + 只保留 Unicode 字母/数字 + 去尾部 contributor。
  // - 保留中文/日文/西里尔等（P1-04：旧实现只留 [a-z0-9]，中文搜索会退化成空查询=全放行）；
  // - \p{L}/\p{N} 用 RegExp 字符串构造，旧引擎不支持 u 属性类时回退到 CJK 等常见区段。
  const SEARCH_STRIP_RE = (() => {
    try { return new RegExp('[^\\p{L}\\p{N}]+', 'gu'); } catch { /* older engines */ }
    return /[^a-z0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]+/g;
  })();
  function normKey(str) {
    return String(str || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(SEARCH_STRIP_RE, '')
      .replace(/contributor$/, '');
  }

  // ---------------------------------------------------------------------------
  // 用量口径：格式化 / 日期（所有数字来自宿主 /usage，本层只做展示，不推算业务数字）
  // ---------------------------------------------------------------------------

  function fmtTokens(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    if (n >= 1e9) { const v = n / 1e9; return `${v >= 10 ? Math.round(v) : v.toFixed(1)}B`; }
    if (n >= 1e6) { const v = n / 1e6; return `${v >= 100 ? Math.round(v) : v.toFixed(1)}M`; }
    if (n >= 1e3) { const v = n / 1e3; return `${v >= 100 ? Math.round(v) : v.toFixed(1)}K`; }
    return String(Math.round(n));
  }

  function fmtInt(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  // 费用是估算值：null 表示「一个模型都无法定价」，必须显示 — 而不是 0
  function fmtCost(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (v === 0) return '$0.00';
    if (v < 0.01) return '<$0.01';
    if (v < 1) return '$' + v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (v >= 1000) return '$' + fmtInt(v);
    return '$' + v.toFixed(2);
  }

  function fmtPct(ratio) {
    if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—';
    const p = ratio * 100;
    if (p < 0.1) return '<0.1%';
    return `${p >= 10 ? Math.round(p) : p.toFixed(1)}%`;
  }

  // O1：costCoverage=0 有两种语义——「没有任何可定价模型」≠「0% 覆盖」，
  // 不能显示「定价覆盖 0%」（内置快照/首次联网前 AA 价格为空时会出现）。
  function costCoverageInfo(metrics, coverage) {
    if (typeof coverage !== 'number' || !Number.isFinite(coverage) || coverage < 0) return null;
    if (coverage === 0) {
      const noPriced = !metrics || metrics.estimatedCostUsd == null;
      return {
        kind: 'none',
        text: noPriced ? '需联网刷新后估算' : '暂无可定价模型',
        title: noPriced ? '当前范围还没有可匹配公开价格的模型；联网刷新后显示估算' : '当前范围的模型都没有公开价格，无法估算费用',
      };
    }
    return { kind: 'partial', text: `覆盖 ${fmtPct(coverage)}`, title: '该范围已匹配到公开价格的 token 占比' };
  }

  function pad2(n) { return String(n).padStart(2, '0'); }

  // 本机时区自然日（与宿主 Asia/Shanghai 的自然日分桶保持一致；同一台机器时区一致）
  function localDayKey(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    if (!Number.isFinite(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function fmtSessionCount(n) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
    return fmtInt(n);
  }

  // 未来时间（套餐窗口重置）：与 relTime 互补
  function fmtEta(isoLike) {
    const t = Date.parse(isoLike);
    if (!Number.isFinite(t)) return '';
    const diff = t - Date.now();
    if (diff <= 0) return '即将重置';
    const min = Math.floor(diff / 60_000);
    if (min < 60) return `${Math.max(1, min)} 分钟后重置`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr} 小时后重置`;
    return `${Math.floor(hr / 24)} 天后重置`;
  }

  // 把契约里的 ranges 收敛成一个「永远有结构」的视图，字段缺失时全部降级为 — / 空
  function usageRangeView(usage, range) {
    const ranges = (usage && usage.ranges) || {};
    const fallback = (usage && usage.totals) || {};
    const bucket = ranges[range] || {};
    return {
      metrics: bucket.metrics || (range === 'all' ? fallback : {}),
      byModel: Array.isArray(bucket.byModel) ? bucket.byModel : [],
      byProvider: Array.isArray(bucket.byProvider) ? bucket.byProvider : [],
      costCoverage: typeof bucket.costCoverage === 'number' ? bucket.costCoverage : null,
    };
  }

  function usageDaySeries(byDay, days) {
    const list = Array.isArray(byDay) ? byDay : [];
    const tail = days > 0 ? list.slice(-days) : list;
    return tail.map((d) => ({
      day: d && typeof d.day === 'string' ? d.day : '',
      tokens: d && typeof d.totalTokens === 'number' && Number.isFinite(d.totalTokens) ? d.totalTokens : 0,
      calls: d && typeof d.calls === 'number' && Number.isFinite(d.calls) ? d.calls : 0,
    }));
  }

  function usageHasData(usage) {
    if (!usage || typeof usage !== 'object') return false;
    const totals = usage.totals || {};
    if ((typeof totals.calls === 'number' && totals.calls > 0)
      || (typeof totals.totalTokens === 'number' && totals.totalTokens > 0)) return true;
    // totals 缺失时以 ranges 兜底判断
    const ranges = usage.ranges || {};
    for (const key of ['today', 'd7', 'd30', 'all']) {
      const m = (ranges[key] && ranges[key].metrics) || {};
      if ((typeof m.calls === 'number' && m.calls > 0)
        || (typeof m.totalTokens === 'number' && m.totalTokens > 0)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 榜单通用：排序 / CSV 导出 / 数据源状态条
  // ---------------------------------------------------------------------------

  // 表格排序：局部 state，不请求宿主；缺失值永远排最后
  function useTableSort(defaultKey, defaultDir) {
    const [sort, setSort] = useState({ key: defaultKey, dir: typeof defaultDir === 'number' ? defaultDir : 1 });
    const onSort = useCallback((key, dir) => {
      setSort((prev) => (prev.key === key
        ? { key, dir: -prev.dir }
        : { key, dir: typeof dir === 'number' ? dir : 1 }));
    }, []);
    return [sort, onSort];
  }

  function compareSortValues(a, b, dir) {
    const aMissing = a === null || a === undefined || (typeof a === 'number' && !Number.isFinite(a)) || a === '';
    const bMissing = b === null || b === undefined || (typeof b === 'number' && !Number.isFinite(b)) || b === '';
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof a === 'number' && typeof b === 'number') return dir === 1 ? a - b : b - a;
    const as = String(a).toLowerCase();
    const bs = String(b).toLowerCase();
    if (as === bs) return 0;
    const base = as < bs ? -1 : 1;
    return dir === 1 ? base : -base;
  }

  function applyTableSort(rows, sort, getter) {
    if (!Array.isArray(rows) || !sort || typeof getter !== 'function') return rows;
    return rows.slice().sort((a, b) => compareSortValues(getter(a), getter(b), sort.dir));
  }

  // 表头单元格：可点击排序 + 键盘可达 + aria-sort
  function SortableTh({ label, colKey, sort, onSort, defaultDir, title, className, style }) {
    const active = sort && sort.key === colKey;
    const dir = active ? sort.dir : 0;
    const onActivate = () => onSort(colKey, defaultDir);
    return h('th', {
      className: `mrr-th-sort${className ? ' ' + className : ''}`,
      'data-active': active ? '1' : '0',
      'aria-sort': active ? (dir === 1 ? 'ascending' : 'descending') : 'none',
      title: title ? `${title}（点击切换排序）` : '点击切换排序',
      tabIndex: 0,
      style,
      onClick: onActivate,
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onActivate(); }
      },
    }, label, active ? h('span', { className: 'mrr-sortarrow', 'aria-hidden': true }, dir === 1 ? '▲' : '▼') : null);
  }

  // tokens 展示串（"742B" / "1.2T"）→ 可比较数字；解析不出来则不参与数值排序
  function parseTokenLabel(label) {
    if (typeof label === 'number' && Number.isFinite(label)) return label;
    const raw = String(label == null ? '' : label).trim().replace(/,/g, '');
    const m = raw.match(/^([\d.]+)\s*([KMBT])?$/i);
    if (!m) return null;
    const mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[String(m[2] || '').toUpperCase()] || 1;
    const n = parseFloat(m[1]);
    return Number.isFinite(n) ? n * mult : null;
  }

  const CSV_BOM = '\uFEFF';
  function csvCell(value) {
    const raw = value === null || value === undefined ? '' : String(value);
    // LB-05：CSV/Excel 公式注入防护（OWASP）——以 = + - @ Tab CR 开头的单元格前置单引号，
    // 使 Excel/WPS 按文本处理而不是当公式执行（模型名/厂商名等来自第三方榜单，不可信）。
    const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function buildCsv(header, rows) {
    return CSV_BOM + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
  }
  function csvDateStamp() {
    const d = new Date();
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  }
  // 浏览器端触发下载；失败返回 { ok:false, error }，由调用方给出提示（SSR / 无 Blob 环境不会崩）
  function downloadCsv(filename, csvText) {
    try {
      if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || !URL.createObjectURL) {
        return { ok: false, error: '当前环境不支持文件下载' };
      }
      const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      (document.body || document.documentElement).appendChild(a);
      a.click();
      setTimeout(() => {
        try { a.remove(); } catch { /* noop */ }
        try { URL.revokeObjectURL(url); } catch { /* noop */ }
      }, 0);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  }

  // 每个榜单卡片顶部的工具条：标题/副标题 + 导出 CSV（导出当前筛选+排序后的行）
  function TableToolbar({ title, subtitle, filename, header, rows }) {
    const [note, setNote] = useState(null);
    const onExport = () => {
      const result = downloadCsv(filename, buildCsv(header, rows));
      if (!result.ok) setNote('导出失败：' + result.error);
    };
    return h('div', { className: 'mrr-tablebar' },
      h('span', { className: 'mrr-tablebar-title' }, title),
      subtitle ? h('span', { className: 'mrr-tablebar-sub' }, subtitle) : h('span', { className: 'mrr-tablebar-sub' }),
      note ? h('span', { className: 'mrr-exportnote', role: 'alert' }, note) : null,
      h('button', {
        type: 'button', className: 'mrr-exportbtn',
        onClick: onExport,
        title: `导出当前筛选结果（UTF-8 BOM CSV，共 ${rows.length} 行）`,
        'aria-label': '导出当前列表为 CSV',
      }, '导出 CSV'));
  }

  // 数据源状态：来源名 / ok / 失败原因 / 上次成功；来源 key 见 pipeline.fetchSources().sources
  const SOURCE_META = {
    arena: { label: 'LMArena', key: 'lmarena-dataset', section: 'arena', home: 'https://lmarena.ai/' },
    aa: { label: 'Artificial Analysis', key: 'aa-models', section: 'aa', home: 'https://artificialanalysis.ai/models' },
    usage: { label: 'OpenRouter', key: 'openrouter-rankings', section: 'usage', home: 'https://openrouter.ai/rankings' },
    livebench: { label: 'LiveBench', key: 'livebench-data', section: 'livebench', home: 'https://livebench.ai/' },
  };

  function SourceStatusBar({ sourceId, snapshot, meta }) {
    const info = SOURCE_META[sourceId];
    if (!info) return null;
    const section = snapshot && snapshot[info.section];
    const sourceInfo = (snapshot && snapshot.sources && snapshot.sources[info.key])
      || (meta && meta.sourceInfo && meta.sourceInfo[info.key])
      || null;
    const ok = !!(sourceInfo && sourceInfo.ok);
    const stale = !!(section && section.stale);
    const rawError = sourceInfo && sourceInfo.error ? String(sourceInfo.error) : '';
    // 内置快照阶段：宿主标记 ok=false + "runtime fetch only"，不是抓取失败，用「待联网更新」措辞
    const pendingOnline = !ok && (!sourceInfo || /runtime fetch only|bundled|内置快照|尚未抓取/i.test(rawError));
    const warn = stale || !ok;
    const lastSuccess = meta && meta.lastSuccessMs ? relTime(new Date(meta.lastSuccessMs).toISOString()) : '';
    const asOf = section && section.asOf;
    const msg = stale
      ? '数据源待更新（显示上次成功数据）'
      : (!sourceInfo
          ? '待联网更新'
          : (pendingOnline ? '待联网更新（内置快照不含第三方数据）' : (!ok ? `抓取失败：${rawError || '未知原因'}` : '数据源正常')));
    return h('div', { className: 'mrr-srcbar', role: 'status', 'aria-live': 'polite', 'aria-label': `${info.label}：${msg}${asOf ? '，数据截至 ' + asOf : ''}`, 'data-kind': warn ? 'warn' : 'ok', title: sourceInfo && sourceInfo.url ? `请求地址：${sourceInfo.url}` : undefined },
      h('span', { className: 'mrr-srcbar-dot', 'aria-hidden': true }),
      h('a', { className: 'mrr-srcbar-name mrr-srcbar-link', href: info.home, target: '_blank', rel: 'noopener noreferrer', title: `数据来源：${info.home}` }, info.label),
      h('span', { className: 'mrr-srcbar-sep', 'aria-hidden': true }, '·'),
      h('span', { className: 'mrr-srcbar-msg' }, msg),
      asOf ? h('span', { className: 'mrr-srcbar-asof' }, `数据截至 ${asOf}`) : null,
      lastSuccess ? h('span', { className: 'mrr-srcbar-asof' }, `上次成功 ${lastSuccess}`) : null,
    );
  }

  const TABS = [
    { id: 'arena', label: 'Arena 对战', note: 'LMArena 文本对战榜（人类盲测 Bradley-Terry 评分）' },
    { id: 'aa', label: '综合智能', note: 'Artificial Analysis 智能指数（0–100）' },
    { id: 'livebench', label: '能力榜', note: 'LiveBench 2.0 长任务能力榜（官方公开 CSV，按官方类别权重加权）' },
    { id: 'week', label: 'OpenRouter 周', note: '真实开发者用量（tokens）' },
    { id: 'month', label: 'OpenRouter 月', note: '近 30 天用量' },
    { id: 'share', label: '市场份额', note: '各厂商请求份额' },
    { id: 'local', label: '本机接入', note: '我的模型用量、provider 分布与接入清单' },
  ];

  // ---------------------------------------------------------------------------
  // 组件
  // ---------------------------------------------------------------------------

  function PanelIcon(props) {
    const size = (props && props.size) || 16;
    return h('svg', {
      className: 'mrr-sidebarIcon', 'aria-hidden': true, focusable: false,
      width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round',
    },
      h('path', { d: 'M2.5 13.5h11' }),
      h('path', { d: 'M4.5 13.5V9.8a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v3.7' }),
      h('path', { d: 'M9.5 13.5V6.8a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v6.7' }),
      h('circle', { cx: '7.9', cy: '3.4', r: '1.6' }),
      h('path', { d: 'M7.9 5v1.6' }));
  }

  function Medal({ rank }) {
    if (rank >= 1 && rank <= 3) {
      return h('span', { className: 'mrr-medal', 'data-medal': String(rank) }, String(rank));
    }
    return h('span', { className: 'mrr-num' }, String(rank));
  }

  function Badge({ kind, children, title }) {
    return h('span', { className: 'mrr-badge', 'data-kind': kind, title: title || undefined }, children);
  }

  function Bar({ value, max }) {
    const pct = (typeof value === 'number' && max > 0) ? Math.max(4, Math.min(100, Math.round((value / max) * 100))) : 0;
    return h('div', { className: 'mrr-barwrap' },
      h('div', { className: 'mrr-bar' }, h('i', { style: { width: pct + '%' } })),
      h('span', { className: 'mrr-barval' }, typeof value === 'number' ? value.toFixed(1) : '—'),
    );
  }

  function ChangeBadge({ change }) {
    if (!change || !change.kind) return null;
    if (change.kind === 'new') return h('span', { className: 'mrr-change', 'data-kind': 'new' }, 'NEW');
    const arrow = change.kind === 'up' ? '▲' : '▼';
    const pct = change.pct != null ? `${arrow} ${change.pct}%` : arrow;
    return h('span', { className: 'mrr-change', 'data-kind': change.kind }, pct);
  }

  function SearchBox({ value, onChange, placeholder }) {
    return h('div', { className: 'mrr-search' },
      h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true },
        h('circle', { cx: '7', cy: '7', r: '4.4' }), h('path', { d: 'M10.4 10.4 14 14' })),
      h('input', {
        type: 'search', value, placeholder: placeholder || '搜索模型 / 厂商 / 已接入名字…', onChange: (e) => onChange(e.target.value),
        'aria-label': '搜索模型',
      }));
  }

  function PanelHeader({ meta, inventory, onRefresh, refreshing, hasSnapshot, snapshot }) {
    const asOf = meta && meta.usageAsOf;
    const bundled = meta && meta.bundled;
    const lastSuccessMs = meta && meta.lastSuccessMs;
    const updated = lastSuccessMs ? relTime(new Date(lastSuccessMs).toISOString()) : '';
    // bundled 且从未联网成功：不显示「更新于 —」，明确说明是内置快照、等待联网更新
    const bundledNote = bundled
      ? (lastSuccessMs ? '' : `内置快照${snapshot && snapshot.fetchedAt ? `（${relTime(snapshot.fetchedAt)}生成）` : ''} · 等待联网更新`)
      : '';
    return h('div', { className: 'mrr-head' },
      h('div', { className: 'mrr-headtitle' },
        h('h1', null, '模型排行', h('span', { className: 'mrr-title-sub' }, '· 选择困难症克星')),
        h('div', { className: 'mrr-sub' },
          h('span', { className: 'mrr-livedot', 'data-kind': bundled ? 'stale' : 'ok', 'aria-hidden': true }),
          h('span', null, lastSuccessMs ? `数据更新于 ${updated}` : (bundledNote || '数据更新于 —')),
          asOf ? h('span', null, `· OpenRouter 截点 ${asOf}`) : null,
          h('span', null, '· 每天自动刷新一次'),
          bundled ? h(Badge, { kind: 'stale', title: '这是插件内置的快照（宿主还没完成首次联网刷新）' }, '内置快照') : null,
        ),
      ),
      h('div', { className: 'mrr-headactions' },
        h('button', { className: 'mrr-refreshbtn', 'data-busy': refreshing ? '1' : '0', disabled: !!refreshing, onClick: onRefresh, 'aria-label': '立即刷新榜单数据', 'aria-busy': refreshing ? 'true' : 'false' },
          refreshing ? h('i', { className: 'mrr-spin' }) : null,
          refreshing ? '正在刷新…' : '刷新数据'),
      ),
    );
  }

  function fmtVotes(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
    if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
    return String(v);
  }

  function ArenaTable({ arena, query, onlyLocal, onRowOpen }) {
    const rows = Array.isArray(arena && arena.rows) ? arena.rows : [];
    const [sort, onSort] = useTableSort('rank', 1);
    const visible = useMemo(() => {
      const q = normKey(query);
      if (!q && !onlyLocal) return rows;
      return rows.filter((row) => {
        if (onlyLocal && !row.local) return false;
        if (!q) return true;
        const hay = normKey([row.model, row.orgDisplay, row.local && row.local.id].filter(Boolean).join(' '));
        return hay.includes(q);
      });
    }, [rows, query, onlyLocal]);
    const sorted = useMemo(() => applyTableSort(visible, sort, (row) => {
      if (sort.key === 'model') return row.model || null;
      if (sort.key === 'rating') return typeof row.rating === 'number' ? row.rating : null;
      if (sort.key === 'votes') return typeof row.votes === 'number' ? row.votes : null;
      return typeof row.rank === 'number' ? row.rank : null;
    }), [visible, sort]);

    if (!rows.length) {
      return h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
        h('h2', null, '暂无对战榜数据'),
        h('p', null, 'LMArena 数据源本次刷新失败且没有历史缓存。')));
    }
    if (!visible.length) {
      return h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
        h('h2', null, '没有匹配的模型'), h('p', null, onlyLocal ? '试试关闭"仅看已接入"' : '换个关键词试试。')));
    }

    const ratings = sorted.map((r) => r.rating).filter((v) => typeof v === 'number');
    const min = ratings.length ? Math.min(...ratings) : 0;
    const max = ratings.length ? Math.max(...ratings) : 1;
    const span = Math.max(1, max - min);
    const confOf = (row) => (row.ratingLower != null && row.ratingUpper != null ? `${(row.ratingUpper - row.ratingLower).toFixed(1)}` : null);
    const rowOpenProps = (row) => (onRowOpen ? {
      className: 'mrr-row-clickable',
      tabIndex: 0,
      onClick: () => onRowOpen({ source: 'arena', row }),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onRowOpen({ source: 'arena', row }); }
      },
    } : {});

    return h('div', { className: 'mrr-card' },
      h(TableToolbar, {
        title: 'Arena 对战榜', subtitle: `共 ${rows.length} 行 · 当前显示 ${sorted.length} 行`,
        filename: `dsh-model-rank-arena-${csvDateStamp()}.csv`,
        header: ['名次', '模型', '机构', 'Arena Score', '置信区间宽度', '票数', '已接入 provider'],
        rows: sorted.map((row) => [row.rank, row.model, row.orgDisplay || row.orgKey || '', row.rating != null ? row.rating.toFixed(1) : '', confOf(row) || '', row.votes != null ? row.votes : '', row.local ? (row.local.providerDisplay || row.local.provider || '已接入') : '']),
      }),
      h('table', { className: 'mrr-table' },
        h('thead', null, h('tr', null,
          h(SortableTh, { label: '#', colKey: 'rank', sort, onSort, defaultDir: 1, className: 'mrr-td-rank', title: '按名次' }),
          h(SortableTh, { label: '模型', colKey: 'model', sort, onSort, defaultDir: 1, title: '按模型名' }),
          h(SortableTh, { label: 'Arena Score', colKey: 'rating', sort, onSort, defaultDir: -1, title: '按评分（条形为榜内相对位置）', className: 'mrr-th-num', style: { minWidth: '186px' } }),
          h('th', { className: 'mrr-th-num', title: 'rating 的 95% 置信区间宽度' }, '95% 置信'),
          h(SortableTh, { label: '票数', colKey: 'votes', sort, onSort, defaultDir: -1, title: '按投票数', className: 'mrr-th-num' }),
          h('th', null, '接入状态'),
        )),
        h('tbody', null, sorted.map((row) => {
          const pct = typeof row.rating === 'number' ? Math.max(4, Math.round(((row.rating - min) / span) * 97) + 3) : 0;
          const ci = confOf(row);
          return h('tr', { key: `${row.rank}-${row.model}`, ...rowOpenProps(row) },
            h('td', { className: 'mrr-td-rank' }, h(Medal, { rank: row.rank })),
            h('td', { className: 'mrr-td-model' },
              h('div', { className: 'mrr-modelname' },
                h('b', { title: row.model }, row.model),
                h('span', null, row.orgDisplay || row.orgKey || '—'),
              ),
            ),
            h('td', { className: 'mrr-td-metric', 'data-label': 'Arena Score' },
              h('div', { className: 'mrr-barwrap' },
                h('div', { className: 'mrr-bar', title: '榜内相对位置' }, h('i', { style: { width: pct + '%' } })),
                h('span', { className: 'mrr-barval' }, row.rating != null ? row.rating.toFixed(1) : '—'),
              ),
            ),
            h('td', { className: 'mrr-td-num mrr-muted', 'data-label': '95% 置信' }, ci ? `± ${ci}` : '—'),
            h('td', { className: 'mrr-td-num mrr-muted', 'data-label': '票数' }, fmtVotes(row.votes)),
            h('td', { className: 'mrr-td-status', 'data-label': '状态' }, row.local
              ? h('div', { className: 'mrr-badges' }, h(Badge, { kind: 'local', title: `本机 provider：${row.local.provider}` }, '已接入'))
              : h('span', { className: 'mrr-muted' }, '—')),
          );
        })),
      ),
      h('div', { className: 'mrr-note' },
        `共 ${arena.totalModels || rows.length} 个模型参战（本表显示 Top ${rows.length}）。Arena Score 是人类盲测的 Bradley-Terry 评分，口径独立，不可与"综合智能"指数互相比较。`,
      ),
    );
  }

  function AaTable({ models, query, onlyLocal, onRowOpen }) {
    const hasSource = Array.isArray(models) && models.some((mm) => mm && !/deprecated/i.test(mm.name || ''));
    const [sort, onSort] = useTableSort('rank', 1);
    const visible = useMemo(() => {
      const list = (Array.isArray(models) ? models : []).filter((mm) => !/deprecated/i.test((mm && mm.name) || ''));
      if (!list.length) return [];
      const maxHeight = Math.max(...list.map((mm) => (typeof mm.intelligence === 'number' ? mm.intelligence : 0)), 1);
      const q = normKey(query);
      const out = list.filter((mm) => {
        if (onlyLocal && !mm.local) return false;
        if (!q) return true;
        const hay = normKey([mm.name, mm.provider, mm.slug, mm.local && mm.local.id].filter(Boolean).join(' '));
        return hay.includes(q);
      });
      return { rows: out, maxHeight };
    }, [models, query, onlyLocal]);
    const sorted = useMemo(() => applyTableSort(visible.rows || [], sort, (mm) => {
      if (sort.key === 'model') return mm.name || mm.slug || null;
      if (sort.key === 'intelligence') return typeof mm.intelligence === 'number' ? mm.intelligence : null;
      if (sort.key === 'price') return mm.price && typeof mm.price.blended31 === 'number' ? mm.price.blended31 : null;
      if (sort.key === 'speed') return mm.speed && typeof mm.speed.tokensPerSec === 'number' ? mm.speed.tokensPerSec : null;
      if (sort.key === 'context') return typeof mm.contextTokens === 'number' ? mm.contextTokens : null;
      return typeof mm.rank === 'number' ? mm.rank : null;
    }), [visible, sort]);

    if (!hasSource) {
      return h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
        h('h2', null, '暂无综合智能数据'),
        h('p', null, '当前快照不含 Artificial Analysis 数据（该数据源只在宿主联网刷新时实时抓取，随包内置快照不再包含第三方数据）。稍后点右上角「刷新数据」即可。')));
    }
    if (!visible.rows.length) {
      return h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
        h('h2', null, '没有匹配的模型'), h('p', null, onlyLocal ? '试试关闭"仅看已接入"，或换一个关键词。' : '换个关键词试试。')));
    }
    const rowOpenProps = (mm) => (onRowOpen ? {
      className: 'mrr-row-clickable',
      tabIndex: 0,
      onClick: () => onRowOpen({ source: 'aa', row: mm }),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onRowOpen({ source: 'aa', row: mm }); }
      },
    } : {});

    return h('div', { className: 'mrr-card' },
      h(TableToolbar, {
        title: 'Artificial Analysis 综合智能', subtitle: `共 ${visible.rows.length} 行 · 当前显示 ${sorted.length} 行`,
        filename: `dsh-model-rank-artificial-analysis-${csvDateStamp()}.csv`,
        header: ['名次', '模型', '提供方', '智能指数', '价格3:1 (USD/1M)', '速度 (t/s)', '首字 (s)', '上下文', '已接入 provider'],
        rows: sorted.map((mm) => {
          const p = mm.price || {};
          const speed = mm.speed || {};
          return [mm.rank, mm.name || mm.slug, mm.provider || '', mm.intelligence != null ? mm.intelligence : '',
            p.blended31 != null ? p.blended31 : '',
            speed.tokensPerSec != null ? Math.round(speed.tokensPerSec) : '',
            speed.ttftMs != null ? (speed.ttftMs / 1000).toFixed(2) : '',
            mm.contextTokens != null ? mm.contextTokens : '',
            mm.local ? (mm.local.providerDisplay || mm.local.provider || '已接入') : ''];
        }),
      }),
      h('table', { className: 'mrr-table' },
        h('thead', null, h('tr', null,
          h(SortableTh, { label: '#', colKey: 'rank', sort, onSort, defaultDir: 1, className: 'mrr-td-rank', title: '按名次' }),
          h(SortableTh, { label: '模型', colKey: 'model', sort, onSort, defaultDir: 1, title: '按模型名' }),
          h(SortableTh, { label: '智能指数', colKey: 'intelligence', sort, onSort, defaultDir: -1, title: '按智能指数（0–100）', className: 'mrr-th-num', style: { minWidth: '186px' } }),
          h(SortableTh, { label: '价格 3:1', colKey: 'price', sort, onSort, defaultDir: 1, title: '按 Artificial Analysis 3:1 混合价（USD / 每百万 tokens）', className: 'mrr-th-num' }),
          h(SortableTh, { label: '速度', colKey: 'speed', sort, onSort, defaultDir: -1, title: '按输出速度', className: 'mrr-th-num' }),
          h(SortableTh, { label: '上下文', colKey: 'context', sort, onSort, defaultDir: -1, title: '按上下文窗口', className: 'mrr-th-num' }),
          h('th', null, '接入状态'),
        )),
        h('tbody', null, sorted.map((mm) => {
          const p = mm.price || {};
          const speed = mm.speed || {};
          return h('tr', { key: mm.slug || mm.rank, ...rowOpenProps(mm) },
            h('td', { className: 'mrr-td-rank' }, h(Medal, { rank: mm.rank })),
            h('td', { className: 'mrr-td-model' },
              h('div', { className: 'mrr-modelname' },
                h('b', { title: mm.name || '' }, mm.name || mm.slug),
                h('span', null,
                  mm.provider || '—',
                  mm.suffix ? ` · ${mm.suffix}` : '',
                  mm.openWeights ? ' · 开源' : '',
                ),
              ),
            ),
            h('td', { className: 'mrr-td-metric', 'data-label': '智能指数' },
              h('div', { className: 'mrr-barwrap' },
                h('div', { className: 'mrr-bar', title: '智能指数（0–100）' }, h('i', { style: { width: Math.max(4, Math.round(((mm.intelligence || 0) / (visible.maxHeight || 1)) * 100)) + '%' } })),
                h('span', { className: 'mrr-barval' }, mm.intelligence != null ? mm.intelligence.toFixed(1) : '—'),
                mm.intelligenceEstimated ? h('span', { className: 'mrr-muted', title: '该指数为估算值' }, '(估)') : null,
              ),
            ),
            h('td', null,
              h('div', { className: 'mrr-cell2' },
                h('span', { title: p.input != null ? `输入 ${fmtPrice(p.input)} · 输出 ${fmtPrice(p.output)} · 缓存命中 ${fmtPrice(p.cacheHit)} / 1M tokens` : undefined },
                  p.blended31 != null ? fmtPrice(p.blended31) : '—'),
                h('small', null, '每 1M tokens'),
              ),
            ),
            h('td', null,
              h('div', { className: 'mrr-cell2' },
                h('span', null, fmtSpeed(speed.tokensPerSec)),
                h('small', null, fmtTtft(speed.ttftMs) || ''),
              ),
            ),
            h('td', { className: 'mrr-muted' }, `${fmtCtx(mm.contextTokens)}`),
            h('td', null,
              mm.local
                ? h('div', { className: 'mrr-badges' },
                    h(Badge, { kind: 'local', title: `本机 provider：${mm.local.provider}` }, '已接入'))
                : h('span', { className: 'mrr-muted' }, '—')),
          );
        })),
      ));
  }

  function UsageTable({ rows, query, onlyLocal, tokensHeader, source, onRowOpen }) {
    const [sort, onSort] = useTableSort('rank', 1);
    const visible = useMemo(() => {
      const q = normKey(query);
      return (Array.isArray(rows) ? rows : []).filter((row) => {
        if (onlyLocal && !row.local) return false;
        if (!q) return true;
        const hay = normKey([row.model, row.authorDisplay, row.slug, row.local && row.local.id].filter(Boolean).join(' '));
        return hay.includes(q);
      });
    }, [rows, query, onlyLocal]);
    const sorted = useMemo(() => applyTableSort(visible, sort, (row) => {
      if (sort.key === 'model') return row.model || null;
      if (sort.key === 'author') return row.authorDisplay || null;
      if (sort.key === 'tokens') return parseTokenLabel(row.tokens && row.tokens.label);
      if (sort.key === 'change') return row.change && typeof row.change.pct === 'number' ? row.change.pct : null;
      return typeof row.rank === 'number' ? row.rank : null;
    }), [visible, sort]);

    if (!visible.length) {
      return h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
        h('h2', null, '没有匹配的模型'),
        h('p', null, onlyLocal ? '"仅看已接入"下无命中；看看别的榜单或关闭筛选。' : '暂无数据。')));
    }
    const sourceName = source === 'month' ? 'openrouter-month' : 'openrouter-week';
    const rowOpenProps = (row) => (onRowOpen ? {
      className: 'mrr-row-clickable',
      tabIndex: 0,
      onClick: () => onRowOpen({ source: source || 'week', row }),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onRowOpen({ source: source || 'week', row }); }
      },
    } : {});

    return h('div', { className: 'mrr-card' },
      h(TableToolbar, {
        title: source === 'month' ? 'OpenRouter 月榜' : 'OpenRouter 周榜',
        subtitle: `共 ${sorted.length} 行`,
        filename: `dsh-model-rank-${sourceName}-${csvDateStamp()}.csv`,
        header: ['名次', '模型', '厂商', tokensHeader || 'tokens', '变化', '已接入 provider'],
        rows: sorted.map((row) => [row.rank, row.model, row.authorDisplay || '', (row.tokens && row.tokens.label) || '',
          row.change ? (row.change.kind === 'new' ? 'NEW' : `${row.change.kind === 'up' ? '+' : '-'}${row.change.pct != null ? row.change.pct + '%' : ''}`) : '',
          row.local ? (row.local.providerDisplay || row.local.provider || '已接入') : '']),
      }),
      h('table', { className: 'mrr-table' },
        h('thead', null, h('tr', null,
          h(SortableTh, { label: '#', colKey: 'rank', sort, onSort, defaultDir: 1, className: 'mrr-td-rank', title: '按名次' }),
          h(SortableTh, { label: '模型', colKey: 'model', sort, onSort, defaultDir: 1, title: '按模型名' }),
          h(SortableTh, { label: '厂商', colKey: 'author', sort, onSort, defaultDir: 1, title: '按厂商名' }),
          h(SortableTh, { label: tokensHeader, colKey: 'tokens', sort, onSort, defaultDir: -1, title: '按榜单 tokens 量级' }),
          h(SortableTh, { label: '变化', colKey: 'change', sort, onSort, defaultDir: -1, title: '按变化百分比' }),
          h('th', null, '接入状态'),
        )),
        h('tbody', null, sorted.map((row) => h('tr', { key: `${row.rank}-${row.model}`, ...rowOpenProps(row) },
          h('td', { className: 'mrr-td-rank' }, h(Medal, { rank: row.rank })),
          h('td', null, h('div', { className: 'mrr-modelname' }, h('b', null, row.model))),
          h('td', { className: 'mrr-muted' }, row.authorDisplay || '—'),
          h('td', null, h('span', { style: { fontWeight: 600 } }, (row.tokens && row.tokens.label) || '—')),
          h('td', null, h(ChangeBadge, { change: row.change })),
          h('td', null, row.local
            ? h('div', { className: 'mrr-badges' }, h(Badge, { kind: 'local', title: `本机 provider：${row.local.provider}` }, '已接入'))
            : h('span', { className: 'mrr-muted' }, '—')),
        ))),
      ));
  }

  // P1-14：市场份额页「仅看已接入」的过滤语义抽成纯函数（orgMatched=本机已接入厂商），便于离线断言
  function filterShareRows(rows, query, onlyLocal) {
    const q = normKey(query);
    let list = Array.isArray(rows) ? rows : [];
    if (onlyLocal) list = list.filter((row) => !!(row && row.orgMatched));
    if (!q) return list;
    return list.filter((row) => normKey(`${row.author} ${row.authorKey}`).includes(q));
  }

  function ShareList({ rows, query, onlyLocal, onRowOpen }) {
    const [sort, onSort] = useTableSort('rank', 1);
    const visible = useMemo(() => filterShareRows(rows, query, onlyLocal), [rows, query, onlyLocal]);
    const shareNum = (row) => {
      const num = parseFloat(String(row.share || '').replace('%', ''));
      return Number.isFinite(num) ? num : null;
    };
    const sorted = useMemo(() => applyTableSort(visible, sort, (row) => {
      if (sort.key === 'author') return row.author || null;
      if (sort.key === 'share') return shareNum(row);
      return typeof row.rank === 'number' ? row.rank : null;
    }), [visible, sort]);
    if (!sorted.length) return h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
      h('h2', null, onlyLocal ? '没有本机已接入的厂商' : '暂无份额数据'),
      onlyLocal ? h('p', null, '关闭「仅看已接入」可查看完整厂商份额。') : null));

    const maxShare = Math.max(...sorted.map((r) => shareNum(r) || 0), 1);
    const rowOpenProps = (row) => (onRowOpen ? {
      className: 'mrr-row-clickable',
      tabIndex: 0,
      role: 'button',
      onClick: () => onRowOpen({ source: 'share', row }),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onRowOpen({ source: 'share', row }); }
      },
    } : {});

    return h('div', { className: 'mrr-card' },
      h(TableToolbar, {
        title: '市场份额', subtitle: `共 ${sorted.length} 行`,
        filename: `dsh-model-rank-market-share-${csvDateStamp()}.csv`,
        header: ['名次', '厂商', '份额', '已接入'],
        rows: sorted.map((row) => [row.rank, row.author, row.share || '', row.orgMatched ? '已接入' : '']),
      }),
      h('div', { className: 'mrr-tablebar-sub', style: { padding: '6px 12px 0' } }, '提示：点下方 chip 切换排序；点行查看明细'),
      sorted.map((row) => {
        const num = shareNum(row);
        const width = num != null ? Math.max(3, Math.round((num / maxShare) * 100)) : 0;
        return h('div', { className: 'mrr-share', key: row.author, ...rowOpenProps(row) },
          h('div', { className: 'mrr-sharerank' }, String(row.rank)),
          h('div', { className: 'mrr-shareauthor' },
            row.author,
            row.orgMatched ? h('span', { className: 'mrr-badges', style: { marginLeft: 6, display: 'inline-flex' } }, h(Badge, { kind: 'local' }, '已接入')) : null,
          ),
          h('div', { className: 'mrr-sharebar' }, h('i', { style: { width: width + '%' } })),
          h('div', { className: 'mrr-shareval' }, row.share || '—'),
        );
      }),
      h('div', { className: 'mrr-tablebar' },
        h('span', { className: 'mrr-tablebar-sub' }, `份额口径：OpenRouter 各厂商请求占比 · 当前按 ${sort.key === 'rank' ? '名次' : sort.key === 'author' ? '厂商' : '份额'}${sort.dir === 1 ? '升序' : '降序'}`),
        ...['rank', 'author', 'share'].map((key) => h('button', {
          key, type: 'button', className: 'mrr-chip', 'data-active': sort.key === key ? '1' : '0',
          onClick: () => onSort(key, key === 'rank' || key === 'author' ? 1 : -1),
          title: `按${key === 'rank' ? '名次' : key === 'author' ? '厂商' : '份额'}排序`,
        }, key === 'rank' ? '按名次' : key === 'author' ? '按厂商' : '按份额')),
      ),
    );
  }

  // ---------------------------------------------------------------------------
  // LiveBench 2.0 能力榜（mrr-lb-*）
  // 快照结构见 .team/research.md §6.3：generation/release/releaseId/asOf/source/overall/
  // categories/rows/ranked/notes/stale/fetchedAt；rows[].scores 按 categories[].key 取分，
  // overall = 官方类别加权均值（缺类不计入分母）；rows[].local 只在运行时快照存在（内置快照已 strip）。
  // ---------------------------------------------------------------------------

  // 类别三字母代码（列头标签用；未知类别按名称前 3 个字母兜底）
  const LIVEBENCH_CATEGORY_CODES = {
    long_agentic: 'AGT', reasoning: 'REA', coding: 'COD', browser: 'BRS',
    data_analysis: 'DAT', research: 'RES', design: 'DES', agentic: 'AGT',
  };
  function livebenchCategoryCode(cat) {
    if (!cat) return '';
    if (LIVEBENCH_CATEGORY_CODES[cat.key]) return LIVEBENCH_CATEGORY_CODES[cat.key];
    const name = String(cat.name || cat.key || '').replace(/[^A-Za-z]/g, '');
    return (name.slice(0, 3) || String(cat.key || '').slice(0, 3)).toUpperCase();
  }

  function livebenchGenerationLabel(lb) {
    return lb && lb.generation === 'v1' ? 'LiveBench v1' : 'LiveBench 2.0';
  }

  function livebenchScoreOf(row, key) {
    if (!row || !row.scores || typeof row.scores !== 'object') return null;
    const v = row.scores[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  // 每类分数在本次 release 内的 25/50/75 分位，用于 mini 热格四档底色
  function livebenchHeatThresholds(lb) {
    const categories = lb && Array.isArray(lb.categories) ? lb.categories.filter((c) => c && c.key) : [];
    const rows = lb && Array.isArray(lb.rows) ? lb.rows : [];
    const out = {};
    for (const cat of categories) {
      const values = rows.map((r) => livebenchScoreOf(r, cat.key)).filter((v) => v != null).sort((a, b) => a - b);
      if (!values.length) { out[cat.key] = null; continue; }
      const at = (p) => values[Math.min(values.length - 1, Math.max(0, Math.floor((values.length - 1) * p)))];
      out[cat.key] = [at(0.25), at(0.5), at(0.75)];
    }
    return out;
  }

  function livebenchHeatTier(score, thresholds) {
    if (score == null || !Array.isArray(thresholds) || thresholds.length < 3) return 0;
    if (score >= thresholds[2]) return 3;
    if (score >= thresholds[1]) return 2;
    if (score >= thresholds[0]) return 1;
    return 0;
  }

  function LivebenchSection({ livebench, query, onlyLocal, onRefresh, snapshot, meta, onRowOpen }) {
    const [categoryKey, setCategoryKey] = useState('overall');
    const [sort, onSort] = useTableSort('overall', -1);
    const lb = livebench && typeof livebench === 'object' ? livebench : null;
    const categories = lb && Array.isArray(lb.categories) ? lb.categories.filter((c) => c && c.key) : [];
    const rows = lb && Array.isArray(lb.rows) ? lb.rows : [];
    const thresholds = useMemo(() => livebenchHeatThresholds(lb), [lb]);
    const activeCategory = categoryKey === 'overall' ? null : (categories.find((c) => c.key === categoryKey) || null);
    const activeKey = activeCategory ? activeCategory.key : null;
    const weightTitle = categories.length
      ? `官方类别权重：${categories.map((c) => `${c.name || c.key} ×${c.weight != null ? c.weight : 1}`).join('、')}`
      : '官方类别权重';

    // 空态：宿主还没有抓到 LiveBench 数据（内置快照不含第三方数据）
    if (!lb) {
      return h('div', null,
        h(SourceStatusBar, { sourceId: 'livebench', snapshot, meta }),
        h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
          h('h2', null, '暂无能力榜数据'),
          h('p', null, '能力榜数据在宿主首次联网刷新后出现（内置快照不含第三方数据）。'),
          h('button', { className: 'mrr-refreshbtn', onClick: onRefresh }, '刷新数据'))));
    }
    if (!rows.length) {
      return h('div', null,
        h(SourceStatusBar, { sourceId: 'livebench', snapshot, meta }),
        h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
          h('h2', null, '本次未解析到有效分数'),
          h('p', null, lb.stale ? '数据源本次刷新失败，页面保留上次成功的数据。' : '等待下一次联网刷新。'))));
    }

    const q = normKey(query);
    const filtered = rows.filter((row) => {
      if (onlyLocal && !row.local) return false;
      if (!q) return true;
      return normKey([row.display, row.model, row.local && row.local.id, row.local && row.local.provider].filter(Boolean).join(' ')).includes(q);
    });
    const sorted = applyTableSort(filtered, sort, (row) => {
      if (sort.key === 'model') return row.display || row.model || null;
      if (sort.key === 'rank') return typeof row.rank === 'number' ? row.rank : null;
      if (sort.key === 'local') return row.local ? 1 : 0;
      if (activeKey && sort.key === activeKey) return livebenchScoreOf(row, activeKey);
      return typeof row.overall === 'number' ? row.overall : null;
    });
    const csvHeader = ['名次', '模型', '综合分', ...categories.map((c) => `${c.name || c.key}${c.weight != null ? `(权重×${c.weight})` : ''}`), '已接入 provider'];
    const csvRows = sorted.map((row) => [
      row.rank,
      row.display || row.model,
      typeof row.overall === 'number' ? row.overall.toFixed(2) : '',
      ...categories.map((c) => { const v = livebenchScoreOf(row, c.key); return v == null ? '' : v.toFixed(1); }),
      row.local ? (row.local.providerDisplay || row.local.provider || '已接入') : '',
    ]);
    const rowOpenProps = (row) => (onRowOpen ? {
      className: 'mrr-row-clickable',
      tabIndex: 0,
      onClick: () => onRowOpen({ source: 'livebench', row, category: activeKey, livebench: lb }),
      onKeyDown: (e) => {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); onRowOpen({ source: 'livebench', row, category: activeKey, livebench: lb }); }
      },
    } : {});

    return h('div', { className: 'mrr-lb' },
      h(SourceStatusBar, { sourceId: 'livebench', snapshot, meta }),
      h('div', { className: 'mrr-lb-head' },
        h('div', { className: 'mrr-lb-titleline' },
          h('h2', null, 'LiveBench 能力榜'),
          h('span', { className: 'mrr-lb-badge', title: weightTitle },
            `${livebenchGenerationLabel(lb)}${lb.release ? ' · ' + lb.release : (lb.releaseId ? ' · ' + lb.releaseId : '')}`),
          lb.stale ? h(Badge, { kind: 'stale', title: '数据源最近一次抓取失败，显示的是上次成功的数据' }, '数据源待更新') : null,
          h('span', { className: 'mrr-muted', style: { fontSize: 11 } }, `${typeof lb.ranked === 'number' ? lb.ranked : rows.length} 个模型计入总分`),
        ),
        h('div', { className: 'mrr-lb-sub' },
          h('span', null, `综合分 = 官方类别加权均值（缺类不计入分母${lb.overall ? '，' + lb.overall : ''}；官方 notes 有「等权」表述，本插件以官方权重配置为准）`),
          h('a', { href: (lb.source && lb.source.home) || 'https://livebench.ai/', target: '_blank', rel: 'noopener noreferrer' }, 'livebench.ai'),
          lb.source && lb.source.table ? h('a', { href: lb.source.table, target: '_blank', rel: 'noopener noreferrer' }, '官方 table.csv') : null,
        ),
        Array.isArray(lb.notes) && lb.notes.length
          ? h('details', { className: 'mrr-lb-notes' },
              h('summary', null, `数据口径与官方说明（${lb.notes.length} 条）`),
              h('div', { className: 'mrr-usagebox-sub' },
                '口径提示：官方 notes 中有「等权」表述，但官方 categories.json 的 _overall_weights 为 Long Agentic×2 / Coding×1.5 / Design×1.5（其余×1），两者矛盾；本插件以官方权重配置为准（加权均值）。'),
              h('ul', null, lb.notes.map((note, i) => h('li', { key: i }, String(note)))))
          : null,
      ),
      h('div', { className: 'mrr-lb-chips', role: 'group', 'aria-label': '能力类别筛选' },
        h('span', { className: 'mrr-lb-chiplabel' }, '类别：'),
        h('button', {
          type: 'button', className: 'mrr-chip', 'data-active': categoryKey === 'overall' ? '1' : '0',
          'aria-pressed': categoryKey === 'overall' ? 'true' : 'false',
          onClick: () => setCategoryKey('overall'), title: '按官方加权综合分',
        }, '综合'),
        categories.map((cat) => h('button', {
          key: cat.key, type: 'button', className: 'mrr-chip',
          'data-active': categoryKey === cat.key ? '1' : '0',
          'aria-pressed': categoryKey === cat.key ? 'true' : 'false',
          onClick: () => setCategoryKey(cat.key),
          title: `${cat.name || cat.key}：官方权重 ×${cat.weight != null ? cat.weight : 1}（点击只看该类分数）`,
        }, cat.name || cat.key)),
        h('span', { className: 'mrr-lb-legend', title: `热格颜色四档（低 → 高）：分数越高颜色越深；列头缩写对应 7 个官方类别，悬停可看类别全名与权重。${weightTitle}`, 'aria-hidden': true },
          h('span', { className: 'mrr-lb-chiplabel', style: { marginLeft: '6px' } }, '热格'),
          h('i', { 'data-tier': '0' }), h('i', { 'data-tier': '1' }), h('i', { 'data-tier': '2' }), h('i', { 'data-tier': '3' })),
      ),
      filtered.length
        ? h('div', { className: 'mrr-card' },
            h(TableToolbar, {
              title: 'LiveBench 能力榜', subtitle: `共 ${filtered.length} 行 · 当前 ${categoryKey === 'overall' ? '综合分' : (activeCategory && (activeCategory.name || activeCategory.key)) || '综合分'} 口径`,
              filename: `dsh-model-rank-livebench-${(lb.releaseId || lb.release || csvDateStamp()).toString().replace(/[^\w-]/g, '')}-${csvDateStamp()}.csv`,
              header: csvHeader, rows: csvRows,
            }),
            h('table', { className: 'mrr-table mrr-lb-table' },
              h('thead', null, h('tr', null,
                h(SortableTh, { label: '#', colKey: 'rank', sort, onSort, defaultDir: 1, className: 'mrr-td-rank', title: '按名次' }),
                h(SortableTh, { label: '模型', colKey: 'model', sort, onSort, defaultDir: 1, title: '按模型名' }),
                h(SortableTh, { label: '综合分', colKey: 'overall', sort, onSort, defaultDir: -1, title: '按官方加权综合分（0–100；官方 notes 有「等权」表述但 categories.json 给权重，以权重为准）', className: 'mrr-th-num', style: { minWidth: '186px' } }),
                activeCategory
                  ? h(SortableTh, { label: `${activeCategory.name || activeCategory.key} 分`, colKey: activeCategory.key, sort, onSort, defaultDir: -1, title: `按${activeCategory.name || activeCategory.key}类别分` })
                  : null,
                h('th', { className: 'mrr-lb-cell-head', title: `${categories.length} 个官方类别分数：颜色越深分越高（四档），悬停查看精确分与官方权重` },
                  h('span', null, `${categories.length} 类分项`),
                  h('span', { className: 'mrr-lb-codes', 'aria-hidden': true, title: `列缩写依次对应 ${categories.length} 个官方类别（悬停单个缩写看全名与权重）` },
                    categories.map((cat) => h('span', { key: cat.key, title: `${cat.name || cat.key}（官方权重 ×${cat.weight != null ? cat.weight : 1}）` }, livebenchCategoryCode(cat))))),
                h('th', null, '接入状态'),
              )),
              h('tbody', null, sorted.map((row) => {
                const overall = typeof row.overall === 'number' ? row.overall : null;
                const barPct = overall != null ? Math.max(4, Math.min(100, Math.round(overall))) : 0;
                const activeScore = activeKey ? livebenchScoreOf(row, activeKey) : null;
                return h('tr', { key: row.model || row.rank, ...rowOpenProps(row) },
                  h('td', { className: 'mrr-td-rank' }, h(Medal, { rank: row.rank })),
                  h('td', { className: 'mrr-td-model' },
                    h('div', { className: 'mrr-modelname' },
                      h('b', { title: row.model || '' }, row.display || row.model),
                      h('span', null, row.local
                        ? (row.local.providerDisplay || row.local.provider || '已接入')
                        : (row.model !== row.display ? row.model : 'LiveBench 官方模型')),
                    ),
                  ),
                  h('td', { className: 'mrr-td-metric', 'data-label': '综合分' },
                    h('div', { className: 'mrr-barwrap' },
                      h('div', { className: 'mrr-bar', title: '官方加权综合分（0–100）' }, h('i', { style: { width: barPct + '%' } })),
                      h('span', { className: 'mrr-barval' }, overall != null ? overall.toFixed(2) : '—'),
                    ),
                  ),
                  activeCategory
                    ? h('td', { className: 'mrr-td-num', 'data-label': activeCategory.name || activeCategory.key }, h('span', { className: 'mrr-usage-num mrr-lb-catname' }, activeScore != null ? activeScore.toFixed(1) : '—'))
                    : null,
                  h('td', { className: 'mrr-td-heat' },
                    h('div', { className: 'mrr-lb-heats' },
                      categories.map((cat) => {
                        const score = livebenchScoreOf(row, cat.key);
                        const sel = activeKey === cat.key ? '1' : '0';
                        if (score == null) {
                          return h('span', {
                            key: cat.key, className: 'mrr-lb-heat', 'data-missing': '1', 'data-sel': sel,
                            title: `${cat.name || cat.key}：无该类别分数（官方权重 ×${cat.weight != null ? cat.weight : 1}）`,
                          }, '—');
                        }
                        const tier = livebenchHeatTier(score, thresholds[cat.key]);
                        return h('span', {
                          key: cat.key, className: 'mrr-lb-heat', 'data-tier': String(tier), 'data-sel': sel,
                          title: `${cat.name || cat.key}：${score.toFixed(1)} 分（官方权重 ×${cat.weight != null ? cat.weight : 1}）；颜色越深分越高`,
                          'aria-label': `${cat.name || cat.key} ${score.toFixed(1)} 分`,
                        }, String(Math.round(score)));
                      })),
                  ),
                  h('td', { className: 'mrr-td-status', 'data-label': '状态' }, row.local
                    ? h('div', { className: 'mrr-badges' }, h(Badge, { kind: 'local', title: `本机 provider：${row.local.provider}` }, '已接入'))
                    : h('span', { className: 'mrr-muted' }, '—')),
                );
              })),
            ))
        : h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-empty' },
            h('h2', null, '没有匹配的模型'),
            h('p', null, onlyLocal ? '试试关闭"仅看已接入"。' : '换个关键词试试。'))),
      h('div', { className: 'mrr-lb-foot' },
        '来源 LiveBench · livebench.ai（官方公开 CSV）；总分 = 官方类别加权均值，与 Arena / 综合智能指数口径不可混比。官方 notes 中存在「等权」表述，本插件以官方权重配置（categories[].weight）为准，详见 README。'),
    );
  }

  // ---------------------------------------------------------------------------
  // 本机用量仪表盘（mrr-usage-*）
  // 数据全部来自宿主 GET /usage（契约见 .team/API-CONTRACT.md）：
  //   - 客户端只做展示，不二次推算业务口径；range 切换只切本地数据、不重新请求；
  //   - 缺失 / 无法定价的字段显示 —，绝不用 0 冒充；
  //   - 整块是独立子组件，designer 做视觉重构时可直接替换结构与 mrr-usage-* 样式。
  // ---------------------------------------------------------------------------

  const CURRENCY_SYMBOL = { CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥' };

  function fmtMoney(total, currency) {
    if (typeof total !== 'number' || !Number.isFinite(total)) return '—';
    const sym = CURRENCY_SYMBOL[String(currency || '').toUpperCase()] || (currency ? String(currency) + ' ' : '');
    return sym + total.toFixed(2);
  }

  function UsageRangeSwitch({ range, onChange }) {
    return h('div', { className: 'mrr-usage-seg', role: 'group', 'aria-label': '用量统计范围' },
      USAGE_RANGES.map((r) => h('button', {
        key: r.id, type: 'button',
        'data-active': range === r.id ? '1' : '0',
        'aria-pressed': range === r.id ? 'true' : 'false',
        title: r.hint,
        onClick: () => onChange(r.id),
      }, r.label)));
  }

  // KPI 卡：四个口径的 tokens / 估算费用 / 调用 / 会话；底部 sparkline 用 byDay 尾窗
  function UsageSparkline({ byDay, days }) {
    const series = usageDaySeries(byDay, days);
    const values = series.map((d) => d.tokens);
    const W = 64;
    const H = 18;
    let points;
    if (values.length >= 2) {
      const max = Math.max(...values, 1);
      const min = Math.min(...values, 0);
      const span = Math.max(1, max - min);
      points = values.map((v, i) => `${((i / (values.length - 1)) * (W - 2) + 1).toFixed(1)},${(H - 2 - ((v - min) / span) * (H - 4)).toFixed(1)}`).join(' ');
    } else {
      // 数据不足：退化平线（不伪造趋势）
      points = `1,${H / 2} ${W - 1},${H / 2}`;
    }
    return h('div', { className: 'mrr-usage-spark', 'aria-hidden': true },
      h('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, preserveAspectRatio: 'none', focusable: false },
        h('polyline', { points })));
  }

  function UsageKpiCards({ usage }) {
    const allTokens = usage && usage.totals && typeof usage.totals.totalTokens === 'number'
      ? usage.totals.totalTokens : null;
    return h('div', { className: 'mrr-usage-kpis' },
      USAGE_RANGES.map((item) => {
        const view = usageRangeView(usage, item.id);
        const m = view.metrics || {};
        const ratio = (allTokens != null && allTokens > 0 && typeof m.totalTokens === 'number')
          ? Math.min(1, m.totalTokens / allTokens) : null;
        const coverageInfo = costCoverageInfo(m, view.costCoverage);
        const sparkDays = item.id === 'd30' || item.id === 'all' ? 30 : 7;
        return h('div', { className: 'mrr-usage-kpi', key: item.id, title: item.hint },
          h('div', { className: 'mrr-usage-kpi-label' },
            h('span', null, item.label),
            item.id === 'all'
              ? (coverageInfo ? h('span', { className: 'mrr-usage-kpi-tag', title: coverageInfo.title }, coverageInfo.kind === 'none' ? coverageInfo.text : `定价${coverageInfo.text}`) : null)
              : (ratio != null ? h('span', { className: 'mrr-usage-kpi-tag' }, `占累计 ${fmtPct(ratio)}`) : null),
          ),
          h('div', { className: 'mrr-usage-kpi-main' },
            h('div', { className: 'mrr-usage-kpi-value' }, fmtTokens(m.totalTokens), h('small', null, 'tokens')),
            h(UsageSparkline, { byDay: usage && usage.byDay, days: sparkDays }),
          ),
          h('div', { className: 'mrr-usage-kpi-meta' },
            h('span', { title: '估算：按 Artificial Analysis 公开价格 × token 用量（USD），仅供参考' },
              '估算 ', h('b', null, fmtCost(m.estimatedCostUsd)),
              coverageInfo && coverageInfo.kind === 'partial' && typeof view.costCoverage === 'number' && view.costCoverage < 1
                ? h('small', { className: 'mrr-usage-dim', title: coverageInfo.title }, ` · ${coverageInfo.text}`) : null),
            h('span', null, '调用 ', h('b', null, fmtInt(m.calls))),
            h('span', null, '会话 ', h('b', null, fmtSessionCount(m.sessions))),
          ),
          ratio != null && item.id !== 'all'
            ? h('div', { className: 'mrr-usage-kpi-share', 'aria-hidden': true },
                h('i', { style: { width: Math.max(2, Math.round(ratio * 100)) + '%' } }))
            : null,
        );
      }));
  }

  function UsageRangeSummary({ range, view }) {
    const m = (view && view.metrics) || {};
    const label = (USAGE_RANGES.find((r) => r.id === range) || {}).label || '';
    const coverageInfo = costCoverageInfo(m, view && view.costCoverage);
    return h('div', { className: 'mrr-usage-rangesum' },
      h('span', null, `${label} · ${fmtSessionCount(m.sessions)} 个会话`),
      h('span', null, `${fmtInt(m.calls)} 次调用`),
      h('span', null, `${fmtTokens(m.totalTokens)} tokens`),
      h('span', null, `估算 ${fmtCost(m.estimatedCostUsd)}`),
      coverageInfo
        ? h('span', { title: coverageInfo.title }, coverageInfo.kind === 'none' ? coverageInfo.text : `定价${coverageInfo.text}`)
        : null,
    );
  }

  // 我的模型用量排行：名次 / 模型+provider / tokens+占比 / 调用 / 估算费用 / AA 智能指数 / OR 周名次
  function UsageModelTable({ view, query, rangeLabel, searchBox }) {
    const rows = Array.isArray(view && view.byModel) ? view.byModel : [];
    const q = normKey(query);
    const visible = q
      ? rows.filter((r) => normKey([r.display, r.model, r.provider, (r.providers || []).join(' ')].filter(Boolean).join(' ')).includes(q))
      : rows;
    const rangeTokens = view && view.metrics && typeof view.metrics.totalTokens === 'number' ? view.metrics.totalTokens : 0;

    if (!rows.length) {
      return h('div', { className: 'mrr-usage-section' },
        h('div', { className: 'mrr-usage-sectionhead' }, h('h3', null, '我的模型用量排行')),
        h('div', { className: 'mrr-empty' },
          h('h2', null, '该范围内还没有模型用量'),
          h('p', null, '切换上方统计范围，或等本机产生新的 DSH 会话后再看。')));
    }
    if (!visible.length) {
      return h('div', { className: 'mrr-usage-section' },
        h('div', { className: 'mrr-usage-sectionhead' }, h('h3', null, '我的模型用量排行')),
        h('div', { className: 'mrr-empty' }, h('h2', null, '没有匹配的模型'), h('p', null, '换个关键词试试。')));
    }

    return h('div', { className: 'mrr-usage-section' },
      h('div', { className: 'mrr-usage-sectionhead' },
        h('h3', null, '我的模型用量排行'),
        h('div', { className: 'mrr-usage-sechead-right' },
          h('span', { className: 'mrr-usage-sechead-sub' }, `按 tokens 降序 · 共 ${rows.length} 个模型${rangeLabel ? ` · ${rangeLabel}` : ''}`),
          searchBox || null)),
      h('table', { className: 'mrr-table mrr-usage-modeltable' },
        h('thead', null, h('tr', null,
          h('th', { className: 'mrr-td-rank' }, '#'),
          h('th', null, '模型'),
          h('th', { className: 'mrr-th-num', style: { minWidth: '150px' } }, 'tokens / 占比'),
          h('th', { className: 'mrr-th-num', title: '去重后的计费调用次数（usage 事件）' }, '调用'),
          h('th', { className: 'mrr-th-num', title: '按 Artificial Analysis 公开价格估算，仅供参考' }, '估算费用'),
          h('th', { className: 'mrr-th-num', title: 'Artificial Analysis 智能指数（0–100）' }, 'AA 智能'),
          h('th', { className: 'mrr-th-num', title: 'OpenRouter 周榜名次（全球开发者用量）' }, 'OR 周名次'),
        )),
        h('tbody', null, visible.map((r, i) => {
          const rank = typeof r.localRank === 'number' ? r.localRank : i + 1;
          const share = typeof r.share === 'number' ? r.share
            : (rangeTokens > 0 && typeof r.totalTokens === 'number' ? r.totalTokens / rangeTokens : null);
          const aa = r.aa && typeof r.aa.intelligence === 'number' ? r.aa : null;
          const gw = r.globalWeekly && r.globalWeekly.rank != null ? r.globalWeekly : null;
          const providerNames = Array.isArray(r.providers) && r.providers.length ? r.providers : (r.provider ? [r.provider] : []);
          return h('tr', { key: `${rank}-${r.model || i}` },
            h('td', { className: 'mrr-td-rank' }, h(Medal, { rank })),
            h('td', { className: 'mrr-td-model' },
              h('div', { className: 'mrr-usage-modelname' },
                h('b', { title: r.model || r.display || '' }, r.display || r.model || '—'),
                h('span', { title: providerNames.join(' / ') },
                  providerNames[0] || '—', providerNames.length > 1 ? ` 等 ${providerNames.length} 个 provider` : ''),
              )),
            h('td', { className: 'mrr-td-metric', 'data-label': 'tokens' },
              h('div', { className: 'mrr-usage-tokencell' },
                h('div', { className: 'mrr-usage-sharebar' },
                  h('i', { style: { width: (share != null ? Math.max(2, Math.min(100, Math.round(share * 100))) : 0) + '%' } })),
                h('div', { className: 'mrr-usage-tokenline' },
                  h('b', { title: typeof r.totalTokens === 'number' ? `${fmtInt(r.totalTokens)} tokens` : undefined }, fmtTokens(r.totalTokens)),
                  h('small', null, share != null ? `${fmtPct(share)} 占比` : '占比 —')),
              )),
            h('td', { className: 'mrr-td-num', 'data-label': '调用' }, h('span', { className: 'mrr-usage-num' }, fmtInt(r.calls))),
            h('td', { className: 'mrr-td-num', 'data-label': '估算费用' },
              h('div', { className: 'mrr-usage-cell2' },
                h('span', { title: '按 AA 公开价格估算（USD）' }, fmtCost(r.estimatedCostUsd)),
                typeof r.estimatedCostUsd === 'number' ? h('small', null, '估算') : h('small', null, '无价格'),
              )),
            h('td', { className: 'mrr-td-num', 'data-label': 'AA 智能' }, aa
              ? h('span', {
                  className: 'mrr-usage-num',
                  title: aa.name ? `${aa.name} · Artificial Analysis 智能指数（0–100）` : 'Artificial Analysis 智能指数（0–100）',
                }, aa.intelligence.toFixed(1))
              : h('span', { className: 'mrr-usage-dim', title: '该模型未匹配到 Artificial Analysis 数据（内置快照不含 AA，需宿主联网刷新）' }, '—')),
            h('td', { className: 'mrr-td-num', 'data-label': 'OR 周名次' }, gw
              ? h('div', { className: 'mrr-usage-cell2' },
                  h('span', { className: 'mrr-usage-num', title: `OpenRouter 周榜第 ${gw.rank} 名` }, `#${gw.rank}`),
                  (gw.tokensLabel || gw.authorDisplay) ? h('small', null, gw.tokensLabel || gw.authorDisplay) : null)
              : h('span', { className: 'mrr-usage-dim', title: '该模型未出现在 OpenRouter 周榜' }, '—')),
          );
        })),
      ));
  }

  function UsageProviderBars({ view, rangeLabel }) {
    const rows = (view && view.byProvider) || [];
    if (!rows.length) {
      return h('div', { className: 'mrr-usage-section' },
        h('div', { className: 'mrr-usage-sectionhead' }, h('h3', null, 'provider 用量分布')),
        h('div', { className: 'mrr-usage-providers' }, h('span', { className: 'mrr-usage-dim', style: { fontSize: 12 } }, '该范围内还没有 provider 用量。')));
    }
    return h('div', { className: 'mrr-usage-section' },
      h('div', { className: 'mrr-usage-sectionhead' },
        h('h3', null, 'provider 用量分布'),
        h('span', { className: 'mrr-usage-sechead-sub' }, `共 ${rows.length} 个 provider${rangeLabel ? ` · ${rangeLabel}` : ''}`)),
      h('div', { className: 'mrr-usage-providers' }, rows.map((r, i) => {
        const share = typeof r.share === 'number' ? r.share : null;
        return h('div', { className: 'mrr-usage-prow', key: `${r.provider || i}` },
          h('div', { className: 'mrr-usage-pname', title: r.provider || '' }, r.display || r.provider || '—'),
          h('div', { className: 'mrr-usage-pbar', 'aria-hidden': true },
            h('i', { style: { width: (share != null ? Math.max(2, Math.min(100, Math.round(share * 100))) : 0) + '%' } })),
          h('div', { className: 'mrr-usage-pval' }, share != null ? fmtPct(share) : '—'),
          h('div', { className: 'mrr-usage-pmeta' },
            `${fmtTokens(r.totalTokens)} · ${fmtInt(r.calls)} 次`),
        );
      })));
  }

  // 近 14 天 tokens 趋势：纯 SVG，无第三方库；今日高亮 + hover title
  function UsageTrendChart({ byDay }) {
    const series = usageDaySeries(byDay, 14);
    const total = series.reduce((sum, d) => sum + d.tokens, 0);
    if (!series.length) {
      return h('div', { className: 'mrr-usage-section' },
        h('div', { className: 'mrr-usage-sectionhead' }, h('h3', null, '近 14 天趋势')),
        h('div', { className: 'mrr-usage-providers' }, h('span', { className: 'mrr-usage-dim', style: { fontSize: 12 } }, '还没有按天聚合的数据。')));
    }
    const W = 560; const H = 112; const plotH = 88; const top = 14; const gap = 4;
    const barW = Math.max(3, (W - gap * (series.length - 1)) / series.length);
    const max = Math.max(...series.map((d) => d.tokens), 1);
    const todayKey = localDayKey(new Date());
    return h('div', { className: 'mrr-usage-section' },
      h('div', { className: 'mrr-usage-sectionhead' },
        h('h3', null, '近 14 天趋势'),
        h('span', { className: 'mrr-usage-sechead-sub' }, '每日 tokens · 今日高亮')),
      h('div', { className: 'mrr-usage-chart' },
        h('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': '近 14 天每日 tokens 趋势柱状图' },
          h('line', { className: 'mrr-usage-gridline', x1: 0, y1: plotH, x2: W, y2: plotH }),
          series.map((d, i) => {
            const bh = d.tokens > 0 ? Math.max(2, Math.round((d.tokens / max) * (plotH - top))) : 1;
            return h('rect', {
              key: d.day || i,
              x: i * (barW + gap), y: plotH - bh, width: barW, height: bh, rx: 2,
              'data-today': d.day === todayKey ? '1' : undefined,
            }, h('title', null, `${d.day || '—'} · ${fmtTokens(d.tokens)} tokens · ${fmtInt(d.calls)} 次调用`));
          }),
          h('text', { className: 'mrr-usage-axis', x: 0, y: 9 }, `峰值 ${fmtTokens(max)}`),
          h('text', { className: 'mrr-usage-axis', x: 0, y: H - 2 }, series[0].day.slice(5)),
          h('text', { className: 'mrr-usage-axis', x: W, y: H - 2, textAnchor: 'end' }, series[series.length - 1].day.slice(5)),
        )),
      h('div', { className: 'mrr-usage-chartfoot' },
        h('span', null, `14 天合计 ${fmtTokens(total)} tokens`),
        h('span', null, '单位按天聚合，来自宿主 /usage 的 byDay')),
    );
  }

  // 账户余额 / 套餐窗口：accounts 为空数组时整块不渲染
  // 账户三态：#1 有余额/套餐数据；#2 未配置凭据；#3 该 provider 不支持余额/套餐查询
  function usageAccountState(a) {
    const balance = a && a.balance;
    const plans = a && Array.isArray(a.plan) ? a.plan : [];
    const hasBalance = !!(balance && typeof balance.total === 'number');
    const hasPlan = plans.some((p) => p && typeof p.percent === 'number');
    if (hasBalance || hasPlan) return 'ok';
    const credential = a && typeof a.credential === 'string' ? a.credential : '';
    if (!credential || credential === 'none') return 'no-credential';
    return 'unsupported';
  }

  function UsageAccounts({ accounts }) {
    const list = Array.isArray(accounts) ? accounts : [];
    if (!list.length) return null;
    const stateText = {
      'no-credential': '未配置凭据（credential=none），无法读取余额与套餐窗口；配置后可自动显示。',
      unsupported: '该 provider 不支持余额/套餐查询，或本次未返回数据（不影响用量统计）。',
    };
    return h('div', { className: 'mrr-usage-section' },
      h('div', { className: 'mrr-usage-sectionhead' },
        h('h3', null, '账户余额 / 套餐窗口'),
        h('span', { className: 'mrr-usage-sechead-sub' }, '只读自本机 dsh-usage 快照')),
      h('div', { className: 'mrr-usage-accounts' }, list.map((a, i) => {
        const balance = a && a.balance;
        const plans = (a && Array.isArray(a.plan)) ? a.plan : [];
        const state = usageAccountState(a);
        const credential = a && typeof a.credential === 'string' && a.credential ? a.credential : 'none';
        const credentialLabel = credential === 'env' ? '环境变量' : credential === 'none' ? '无凭据' : credential;
        return h('div', { className: 'mrr-usage-account', key: (a && (a.provider || a.displayName)) || i, 'data-state': state },
          h('div', { className: 'mrr-usage-accounthead' },
            h('b', null, (a && (a.displayName || a.provider)) || '账户'),
            h('span', { className: 'mrr-usage-cred', title: `凭据来源：${credential}` }, credentialLabel),
            balance && balance.updatedAt
              ? h('span', { className: 'mrr-usage-dim' }, `${relTime(new Date(balance.updatedAt).toISOString())}`)
              : null),
          state === 'ok'
            ? (balance && typeof balance.total === 'number'
                ? h('div', { className: 'mrr-usage-balance' },
                    fmtMoney(balance.total, balance.currency),
                    h('small', null, '账户余额'))
                : h('div', { className: 'mrr-usage-acct-state' }, '未返回余额数字（可能为订阅制/后付费账户）'))
            : h('div', { className: 'mrr-usage-acct-state' }, stateText[state] || stateText.unsupported),
          state === 'ok'
            ? (plans.length
                ? plans.map((p, j) => {
                    const percent = typeof p.percent === 'number' && Number.isFinite(p.percent) ? Math.max(0, Math.min(100, p.percent)) : null;
                    return h('div', { className: 'mrr-usage-plan', key: (p && p.key) || j },
                      h('span', null, (p && p.key) || '窗口'),
                      h('div', { className: 'mrr-usage-planbar' },
                        h('i', { style: { width: (percent != null ? percent : 0) + '%' } })),
                      h('span', { title: p && p.resetsAt ? `重置时间：${new Date(p.resetsAt).toLocaleString()}` : undefined },
                        `${percent != null ? Math.round(percent) + '%' : '—'}${p && p.resetsAt ? ` · ${fmtEta(p.resetsAt)}` : ''}`));
                  })
                : h('div', { className: 'mrr-usage-acct-state' }, '未返回套餐窗口数据'))
            : null,
        );
      })));
  }

  // 接入清单：现有 provider 卡片 + 各 provider 的本机用量；下方保留「已接入模型在榜单上的位置」
  function UsageConnections({ inventory, usage, query, snapshot }) {
    const providers = (inventory && inventory.userProviders) || [];
    const usageProviderMap = {};
    for (const row of usageRangeView(usage, 'all').byProvider) {
      if (row && row.provider) usageProviderMap[normKey(row.provider)] = row;
    }
    // 冷启动（内置快照无 profile 清单）时：用 /usage 实时 inventory 撑标题/计数与 provider 卡片骨架
    const usageInv = (usage && usage.inventory) || null;
    const usageProviderNames = usageInv && Array.isArray(usageInv.providers) ? usageInv.providers.filter((x) => typeof x === 'string' && x) : [];
    const providerCards = providers.length
      ? providers
      : usageProviderNames.map((name) => ({ name, display: null, models: [] }));
    const modelCount = (inventory && inventory.userModelsCount != null)
      ? inventory.userModelsCount
      : (usageInv && typeof usageInv.models === 'number' ? usageInv.models : null);
    const aa = (snapshot && snapshot.aa && snapshot.aa.models) || [];
    const useaa = (snapshot && snapshot.usage && snapshot.usage.weekly) || [];
    const arenaRows = (snapshot && snapshot.arena && snapshot.arena.rows) || [];
    const lbRows = (snapshot && snapshot.livebench && snapshot.livebench.rows) || [];
    const q = normKey(query);
    const myRanked = [];
    for (const row of arenaRows) if (row.local) myRanked.push({ source: 'Arena 对战', rank: row.rank, name: row.model, extra: row.rating != null ? `评分 ${row.rating}` : '' });
    for (const mm of aa) if (mm.local) myRanked.push({ source: '综合智能', rank: mm.rank, name: mm.name, extra: mm.intelligence != null ? `指数 ${mm.intelligence.toFixed(1)}` : '' });
    for (const row of lbRows) if (row.local) myRanked.push({ source: 'LiveBench 能力榜', rank: row.rank, name: row.display || row.model, extra: row.overall != null ? `综合分 ${row.overall.toFixed(2)}` : '' });
    for (const row of useaa) if (row.local) myRanked.push({ source: 'OpenRouter 周榜', rank: row.rank, name: row.model, extra: row.tokens && row.tokens.label });
    const filteredRanked = q ? myRanked.filter((r) => normKey(r.name).includes(q)) : myRanked;

    return h('div', null,
      h('div', { className: 'mrr-usage-section' },
        h('div', { className: 'mrr-usage-sectionhead' },
          h('h3', null, '接入清单'),
          h('span', { className: 'mrr-usage-sechead-sub' }, '来自 profile 的模型清单（只读）')),
        providerCards.length
          ? h('div', { className: 'mrr-localgrid' }, providerCards.map((p) => {
              const u = usageProviderMap[normKey(p.name)];
              return h('div', { className: 'mrr-localcard', key: p.name },
                h('h3', null, p.display || p.name, ' ',
                  h('span', { className: 'mrr-muted', style: { fontWeight: 400, fontSize: 11 } }, p.name)),
                (p.models || []).length
                  ? h('div', { className: 'mrr-localmodels' },
                      (p.models || []).map((mm) => h('span', { className: 'mrr-modelchip', title: mm.id, key: mm.id }, mm.name || mm.id)))
                  : h('div', { className: 'mrr-usage-connusage' }, '模型清单将在宿主联网刷新后补全'),
                u
                  ? h('div', { className: 'mrr-usage-connusage' },
                      h('span', null, '累计占本机 ', h('b', null, fmtPct(u.share))),
                      h('span', null, `${fmtTokens(u.totalTokens)} tokens`),
                      h('span', null, `${fmtInt(u.calls)} 次调用`))
                  : h('div', { className: 'mrr-usage-connusage' }, '暂无会话用量记录'));
            }))
          : h('div', { className: 'mrr-note' },
              `未读到你 profile 的模型清单（cordis.patch.yml 的 llm-pi-ai 段；下次刷新时会再读一次）。${query ? '' : '榜单仍可正常查看，只是没有"已接入"标记。'}`),
        providers.length === 0 && providerCards.length
          ? h('div', { className: 'mrr-note' }, '说明：profile 模型清单尚未读取（内置快照不含清单），上面是 /usage 里实时检测到的 provider；宿主联网刷新后会自动补全。')
          : null,
        h('div', { className: 'mrr-note' },
          `本机共接入 ${modelCount != null ? modelCount : '?'} 个模型。`),
      ),
      filteredRanked.length
        ? h('div', { className: 'mrr-card', style: { marginTop: 12 } },
            h('div', { className: 'mrr-note' }, '你接入的模型在榜单上的位置（按当前已缓存数据）：'),
            h('div', { className: 'mrr-ranklist' }, filteredRanked.map((r, i) => h('div', { className: 'mrr-rankrow', key: `${r.source}-${i}` },
              h('span', { className: 'mrr-myrank' }, `#${r.rank}`),
              h('b', null, r.name),
              h('small', null, `${r.source} · ${r.extra}`),
            ))))
        : h('div', { className: 'mrr-card', style: { marginTop: 12 } },
            h('div', { className: 'mrr-note' }, q
              ? '没有匹配"已接入"的模型排行，换个关键词试试。'
              : '当前快照里没有匹配到"已接入"的模型排行（可能本机模型多为渠道专有版本，不在公开榜单里；智能榜/周榜/能力榜不受影响）。')),
    );
  }

  function UsagePanel({ usage, loading, error, fetchedAt, refreshing, onReload, query, inventory, snapshot, searchBox }) {
    const [range, setRange] = useState(() => {
      try {
        const saved = localStorage.getItem(USAGE_RANGE_KEY);
        if (USAGE_RANGES.some((r) => r.id === saved)) return saved;
      } catch { /* 无 localStorage 时用默认 */ }
      return USAGE_DEFAULT_RANGE;
    });
    const changeRange = useCallback((id) => {
      setRange(id);
      try { localStorage.setItem(USAGE_RANGE_KEY, id); } catch { /* noop */ }
    }, []);

    const head = h('div', { className: 'mrr-usage-head' },
      h('div', null,
        h('h2', { className: 'mrr-usage-title' }, '本机用量', h('span', { className: 'mrr-usage-titlebadge' }, '只读本地')),
        h('div', { className: 'mrr-usage-sub' },
          h('span', null, '来自本机 DSH 会话日志，不上传'),
          fetchedAt ? h('span', null, `用量读取：${relTime(new Date(fetchedAt).toISOString())}`) : null,
        ),
      ),
      h('div', { className: 'mrr-usage-actions' },
        h('button', {
          className: 'mrr-usage-linkbtn', onClick: onReload, disabled: !!refreshing,
          title: '只重新读取本机会话日志，与顶部「刷新数据」（抓取公开榜单）相互独立',
        }, refreshing ? '正在读取…' : '重新读取用量'),
      ),
    );

    // 无缓存且首次加载：骨架屏
    if (!usage) {
      if (loading) {
        return h('div', { className: 'mrr-usage' }, head,
          h('div', { className: 'mrr-usage-kpis' }, [1, 2, 3, 4].map((i) => h('div', { className: 'mrr-usage-kpi', key: i },
            h('div', { className: 'mrr-usage-skbar', 'data-w': '3' }),
            h('div', { className: 'mrr-usage-skbar', 'data-w': '2' }),
            h('div', { className: 'mrr-usage-skbar', 'data-w': '1' })))),
          h('div', { className: 'mrr-usage-section' }, h('div', { className: 'mrr-usage-skeleton' },
            h('div', { className: 'mrr-usage-skbar', 'data-w': '1' }),
            h('div', { className: 'mrr-usage-skbar', 'data-w': '2' }),
            h('div', { className: 'mrr-usage-skbar', 'data-w': '1' }))));
      }
      return h('div', { className: 'mrr-usage' }, head,
        h('div', { className: 'mrr-usage-empty' },
          h('b', null, '用量数据暂不可用'),
          h('p', null, error
            ? `读取失败：${error}。本机榜单功能不受影响；宿主恢复后会自动出现（也可点「刷新用量」重试）。`
            : '宿主暂未提供 /usage 接口。本机榜单功能不受影响；宿主提供用量接口后会自动出现。'),
          h('button', { className: 'mrr-refreshbtn', onClick: onReload, disabled: !!refreshing }, '重试读取')));
    }

    const view = usageRangeView(usage, range);
    const rangeLabel = (USAGE_RANGES.find((r) => r.id === range) || {}).label || '';
    const hasData = usageHasData(usage);
    const warnings = Array.isArray(usage.warnings) ? usage.warnings.filter((w) => typeof w === 'string' && w) : [];
    const sessions = (usage.sources && usage.sources.sessions) || {};
    const accountsInfo = (usage.sources && usage.sources.accounts) || null;
    const errorNotice = error
      ? h('div', { className: 'mrr-err' }, `用量刷新失败：${error}（当前显示上次成功读取的数据）`)
      : null;
    const metaLine = h('div', { className: 'mrr-usage-meta' },
      h('span', null, `会话文件 ${fmtInt(sessions.files)} · 已解析 ${fmtInt(sessions.parsed)} · 用量事件 ${fmtInt(sessions.events)}`),
      usage.generatedAt ? h('span', null, `宿主计算：${relTime(new Date(usage.generatedAt).toISOString())}${typeof usage.durationMs === 'number' ? ` · 耗时 ${usage.durationMs}ms` : ''}`) : null,
      accountsInfo && accountsInfo.available ? h('span', null, '账户数据已读取') : null,
    );
    const warnList = warnings.length
      ? h('div', { className: 'mrr-usage-warns' },
          warnings.slice(0, 4).map((w, i) => h('div', { className: 'mrr-usage-warn', key: i }, w)))
      : null;

    const emptyState = !hasData
      ? h('div', { className: 'mrr-usage-empty' },
          h('b', null, '还没有本机用量记录'),
          h('p', null, '插件只读取本机 DSH 会话日志里的用量事件：从插件启用后产生的会话开始累积（若历史会话日志仍可读，也会一并计入）。这里不会显示任何推测或演示数据。'),
          h('button', { className: 'mrr-refreshbtn', onClick: onReload, disabled: !!refreshing }, '重新读取'))
      : null;

    const toolbar = hasData
      ? h('div', { className: 'mrr-usage-toolbar' },
          h(UsageRangeSwitch, { range, onChange: changeRange }),
          h(UsageRangeSummary, { range, view }))
      : null;

    const modelSection = hasData ? h(UsageModelTable, { view, query, rangeLabel, searchBox }) : null;
    const overview = hasData
      ? h('div', { className: 'mrr-usage-overview' },
          h('div', { className: 'mrr-usage-overview-head' },
            h('h3', null, '用量概览'),
            h('div', { className: 'mrr-usage-overview-actions' }, toolbar)),
          h(UsageKpiCards, { usage }))
      : emptyState;
    const trendRow = hasData
      ? h('div', { className: 'mrr-usage-grid2' },
          h(UsageTrendChart, { byDay: usage.byDay }),
          h(UsageProviderBars, { view, rangeLabel }))
      : null;
    const railRow = hasData
      ? h('div', { className: 'mrr-usage-grid-rail' },
          modelSection,
          h('div', { className: 'mrr-usage-rail' },
            h(UsageAccounts, { accounts: usage.accounts }),
            h(UsageConnections, { inventory, usage, query, snapshot })))
      : null;

    return h('div', { className: 'mrr-usage' },
      head,
      errorNotice,
      metaLine,
      warnList,
      overview,
      trendRow,
      railRow,
    );
  }

  // ---------------------------------------------------------------------------
  // 数据 hooks
  // ---------------------------------------------------------------------------

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.snapshot && parsed.snapshot.version === 1) return parsed;
    } catch { /* 缓存损坏按无缓存处理 */ }
    return null;
  }

  function writeCache(payloadObj) {
    try {
      if (payloadObj && payloadObj.snapshot) {
        localStorage.setItem(CACHE_KEY, JSON.stringify({ snapshot: payloadObj.snapshot, meta: payloadObj.meta, inventory: payloadObj.inventory, at: payloadObj.nowMs }));
      }
    } catch { /* 存不下就算了 */ }
  }

  // ---------------------------------------------------------------------------
  // 本机用量数据流（契约见 .team/API-CONTRACT.md）
  //   - 打开面板：localStorage 缓存先渲染，同时与 snapshot 并行请求 /usage；
  //   - 手动刷新：与榜单刷新并行；
  //   - 面板挂载且 document.visibilityState==='visible' 时每 60s 静默刷新，失败静默保留旧数据。
  // ---------------------------------------------------------------------------

  function normalizeUsagePayload(data) {
    if (!data || typeof data !== 'object') throw new Error('用量数据为空');
    if (data.ok === false) throw new Error(data.error || (Array.isArray(data.warnings) && data.warnings[0]) || '用量服务返回失败');
    if (!data.totals || typeof data.totals !== 'object' || !data.ranges || typeof data.ranges !== 'object') {
      throw new Error('用量数据格式不符');
    }
    return data;
  }

  function fetchUsage() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), USAGE_TIMEOUT_MS);
    return fetch(`${RPC_BASE}/usage`, { method: 'GET', signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.text();
      })
      .then((raw) => {
        clearTimeout(timer);
        let data;
        try { data = JSON.parse(raw); } catch { throw new Error('响应不是 JSON'); }
        return normalizeUsagePayload(data);
      })
      .catch((err) => {
        clearTimeout(timer);
        if (err && err.name === 'AbortError') throw new Error(`用量读取超时（${Math.round(USAGE_TIMEOUT_MS / 1000)}s）`);
        throw err;
      });
  }

  function readUsageCache() {
    try {
      const raw = localStorage.getItem(USAGE_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const usage = parsed && parsed.usage;
      if (!usage || typeof usage !== 'object') return null;
      if (usage.version != null && usage.version !== 1) return null;
      if (!usage.totals || !usage.ranges) return null;
      return { usage, at: typeof parsed.at === 'number' ? parsed.at : null };
    } catch { /* 缓存损坏按无缓存处理 */ }
    return null;
  }

  function writeUsageCache(usage) {
    try {
      localStorage.setItem(USAGE_CACHE_KEY, JSON.stringify({ usage, at: Date.now() }));
    } catch { /* 容量不足就算了，下次仍可直接拉 RPC */ }
  }

  function useUsageData() {
    const cachedRef = useRef(undefined);
    if (cachedRef.current === undefined) cachedRef.current = readUsageCache();
    const initial = cachedRef.current;
    const [usage, setUsage] = useState(initial ? initial.usage : null);
    const [fetchedAt, setFetchedAt] = useState(initial ? initial.at : null);
    const [loading, setLoading] = useState(!initial);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    const mountedRef = useRef(true);
    const inflightRef = useRef(false);

    useEffect(() => () => { mountedRef.current = false; }, []);

    const load = useCallback((opts) => {
      const silent = !!(opts && opts.silent);
      if (inflightRef.current) return;
      inflightRef.current = true;
      if (!silent && mountedRef.current) setRefreshing(true);
      fetchUsage()
        .then((data) => {
          if (!mountedRef.current) return;
          setUsage(data);
          setFetchedAt(Date.now());
          setError(null);
          setLoading(false);
          writeUsageCache(data);
        })
        .catch((err) => {
          if (!mountedRef.current) return;
          setLoading(false);
          // 静默刷新失败不打扰用户，保留旧数据
          if (!silent) setError(String((err && err.message) || err));
        })
        .finally(() => {
          inflightRef.current = false;
          if (!silent && mountedRef.current) setRefreshing(false);
        });
    }, []);

    useEffect(() => {
      load({ silent: false });
      const tick = () => {
        try {
          if (typeof document !== 'undefined' && document.visibilityState && document.visibilityState !== 'visible') return;
        } catch { /* noop */ }
        load({ silent: true });
      };
      const timer = setInterval(tick, USAGE_POLL_MS);
      let onVisibility = null;
      try {
        if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
          onVisibility = () => {
            try { if (document.visibilityState === 'visible') load({ silent: true }); } catch { /* noop */ }
          };
          document.addEventListener('visibilitychange', onVisibility);
        }
      } catch { /* noop */ }
      return () => {
        clearInterval(timer);
        try {
          if (onVisibility && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', onVisibility);
        } catch { /* noop */ }
      };
    }, [load]);

    return { usage, fetchedAt, loading, refreshing, error, reload: load };
  }

  // ---------------------------------------------------------------------------
  // 明细抽屉（designer 阶段 B 会统一重构视觉；这里提供稳定的 onRowOpen 契约与基础可达性）
  //   onRowOpen({ source, row, ... }) —— source: arena | aa | week | month | share | livebench
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // 明细抽屉（designer 阶段 B 重构）：MRR_DRAWER_V2
  //   - 入参契约保持 onRowOpen({ source, row, extra }) 不变：source: arena | aa | week | month | share | livebench
  //   - 内容分组：综评 / 价格与规格 / AA 基准分项 / LiveBench 能力分项 / 我的用量 / 外部数据源
  //   - 数据全部来自已加载的 snapshot + usage 缓存，不发新请求
  //   - 可访问性：role=dialog + aria-modal、Esc/遮罩关闭、focus trap、关闭后焦点还原
  // ---------------------------------------------------------------------------

  const AA_BENCHMARK_DEFS = [
    ['gdpval', 'GDPval', 'raw'],
    ['terminalBench', 'Terminal-Bench 4.0', 'pct'],
    ['frontierCode', 'FrontierCode', 'pct'],
    ['livecodebench', 'LiveCodeBench', 'pct'],
    ['aime25', 'AIME 2025', 'pct'],
    ['hle', 'Humanity’s Last Exam', 'pct'],
    ['gpqa', 'GPQA Diamond', 'pct'],
  ];

  const DETAIL_LINKS = [
    { label: 'Artificial Analysis', href: 'https://artificialanalysis.ai/models' },
    { label: 'OpenRouter', href: 'https://openrouter.ai/rankings' },
    { label: 'LMArena', href: 'https://lmarena.ai/' },
    { label: 'LiveBench', href: 'https://livebench.ai/' },
  ];

  function detailNormBase(name) {
    return normKey(String(name || '').replace(/\s*\([^)]*\)\s*$/, ''));
  }

  function detailMatchAa(snapshot, seed) {
    const list = snapshot && snapshot.aa && Array.isArray(snapshot.aa.models) ? snapshot.aa.models : [];
    const base = detailNormBase(seed);
    if (!list.length || !base) return null;
    return list.find((m) => {
      const mb = detailNormBase(m.name || m.slug);
      return mb === base || (mb && base.startsWith(mb)) || (base && mb.startsWith(base));
    }) || null;
  }

  function detailMatchArena(snapshot, seed) {
    const rows = snapshot && snapshot.arena && Array.isArray(snapshot.arena.rows) ? snapshot.arena.rows : [];
    const base = detailNormBase(seed);
    if (!base) return null;
    return rows.find((r) => detailNormBase(r.model) === base) || null;
  }

  function detailMatchLivebench(snapshot, seed) {
    const lb = snapshot && snapshot.livebench;
    const rows = lb && Array.isArray(lb.rows) ? lb.rows : [];
    const base = detailNormBase(seed);
    if (!base) return null;
    return rows.find((r) => detailNormBase(r.display || r.model) === base) || null;
  }

  function detailMatchUsage(usagePayload, seed) {
    const ranges = usagePayload && usagePayload.ranges;
    const range = (ranges && ranges.d30) || (ranges && ranges.d7) || null;
    const list = range && Array.isArray(range.byModel) ? range.byModel : [];
    const base = detailNormBase(seed);
    const raw = normKey(seed);
    if (!list.length) return null;
    return list.find((m) => (base && detailNormBase(m.display || m.model) === base) || (raw && normKey(m.model) === raw)) || null;
  }

  function detailScoreToPct(value, mode) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    if (mode === 'raw') return Math.max(2, Math.min(100, Math.round((value / 2200) * 100)));
    return Math.max(2, Math.min(100, Math.round(value * 100)));
  }

  function buildRowDetail(detail, ctx) {
    if (!detail || !detail.row) return null;
    const row = detail.row;
    const source = detail.source;
    const snapshot = (ctx && ctx.snapshot) || null;
    const usagePayload = (ctx && ctx.usage) || null;
    const seed = source === 'arena' ? row.model
      : source === 'livebench' ? (row.display || row.model)
        : source === 'aa' ? (row.name || row.slug)
          : source === 'share' ? row.author
            : row.model;
    const aa = source === 'aa' ? row : detailMatchAa(snapshot, seed);
    const arena = source === 'arena' ? row : detailMatchArena(snapshot, seed);
    const lbRow = source === 'livebench' ? row : detailMatchLivebench(snapshot, seed);
    const usageRow = detailMatchUsage(usagePayload, seed);
    const lbData = detail.livebench || (snapshot && snapshot.livebench) || null;
    const local = row.local || (aa && aa.local) || (lbRow && lbRow.local) || null;
    const org = (aa && aa.provider) || (arena && (arena.orgDisplay || arena.orgKey)) || (lbRow && lbRow.local && lbRow.local.providerDisplay) || (source === 'share' ? row.authorKey : '') || '—';

    const title = source === 'arena' ? row.model
      : source === 'livebench' ? (row.display || row.model)
        : source === 'aa' ? (row.name || row.slug)
          : source === 'share' ? row.author
            : row.model;
    const subtitleBits = [h('span', { key: 'org', className: 'mrr-drawer-org' }, org)];
    if (local) subtitleBits.push(h(Badge, { key: 'local', kind: 'local', title: `本机 provider：${local.provider || ''}` }, `已接入 · ${local.providerDisplay || local.provider || ''}`));
    if (aa && aa.openWeights) subtitleBits.push(h(Badge, { key: 'open', kind: 'open' }, '开源'));

    const sections = [];

    /* ---- 综评 ---- */
    const kv = [];
    if (arena) kv.push({ label: 'Arena 分', value: arena.rating != null ? arena.rating.toFixed(1) : '—', sub: arena.rank != null ? '#' + arena.rank : null });
    if (aa && aa.intelligence != null) kv.push({ label: '智能指数', value: aa.intelligence.toFixed(1), sub: (aa.rank != null ? '#' + aa.rank : '') + (aa.intelligenceEstimated ? ' · 估算' : '') || null });
    if (lbRow && lbRow.overall != null) kv.push({ label: 'LiveBench 综合分', value: lbRow.overall.toFixed(2), sub: lbRow.rank != null ? '#' + lbRow.rank : (lbData && lbData.generation === 'v1' ? 'v1 口径' : null) });
    if (aa && aa.price && aa.price.blended31 != null) kv.push({ label: '价格 3:1（USD/1M）', value: fmtPrice(aa.price.blended31), sub: null });
    if (source === 'week' || source === 'month') {
      kv.push({ label: 'tokens', value: (row.tokens && row.tokens.label) || '—', sub: source === 'week' ? '本周' : '近 30 天' });
      if (row.change) kv.push({ label: '变化', value: row.change.kind === 'new' ? 'NEW' : `${row.change.kind === 'up' ? '▲' : '▼'} ${row.change.pct != null ? row.change.pct + '%' : ''}`, sub: '对比上一周期' });
    }
    if (source === 'share') {
      kv.push({ label: '请求份额', value: row.share || '—', sub: row.orgMatched ? '已接入厂商' : null });
      kv.push({ label: '名次', value: row.rank != null ? '#' + row.rank : '—', sub: null });
    }
    if (kv.length) sections.push({ label: '综评', kind: 'kv', items: kv });

    /* ---- 价格与规格 ---- */
    if (aa) {
      const price = aa.price || {};
      const speed = aa.speed || {};
      const rows = [];
      if (price.input != null || price.output != null) rows.push({ label: '输入 / 输出', value: `${fmtPrice(price.input)} / ${fmtPrice(price.output)} · 每 1M tokens` });
      if (price.cacheHit != null) rows.push({ label: '缓存命中价', value: `${fmtPrice(price.cacheHit)} / 1M` });
      if (price.blended31 != null) rows.push({ label: '3:1 混合价', value: `${fmtPrice(price.blended31)} / 1M` });
      if (aa.contextTokens != null) rows.push({ label: '上下文窗口', value: fmtCtx(aa.contextTokens) + ' tokens' });
      if (speed.tokensPerSec != null) rows.push({ label: '输出速度', value: `${fmtSpeed(speed.tokensPerSec)}${fmtTtft(speed.ttftMs) ? ' · ' + fmtTtft(speed.ttftMs) : ''}` });
      if (aa.costPerTask != null) rows.push({ label: '单任务估算成本', value: fmtCost(aa.costPerTask) });
      if (aa.modalities) rows.push({ label: '输入 / 输出模态', value: aa.modalities.image ? '文本 + 图像' : '文本' });
      if (aa.releasedOn) rows.push({ label: '发布日期', value: String(aa.releasedOn) });
      if (rows.length) sections.push({ label: '价格与规格 · Artificial Analysis 口径', kind: 'kvrows', items: rows });
    }

    /* ---- AA 基准分项 ---- */
    if (aa && aa.benchmarks) {
      const items = [];
      for (const [key, name, mode] of AA_BENCHMARK_DEFS) {
        const v = aa.benchmarks[key];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        const pct = detailScoreToPct(v, mode);
        items.push({ name, pct: pct || 2, text: mode === 'raw' ? `${Math.round(v)} 分` : `${Math.round(v * 100)}%` });
      }
      if (items.length) sections.push({ label: 'AA 基准分项', kind: 'bench', items, note: '比率类指标按 0–100% 展示，GDPval 为原始分。' });
    }

    /* ---- LiveBench 能力分项 ---- */
    if (lbRow && lbData) {
      const categories = Array.isArray(lbData.categories) ? lbData.categories.filter((c) => c && c.key) : [];
      const scores = lbRow.scores || {};
      const items = [];
      let wsum = 0;
      let sum = 0;
      for (const cat of categories) {
        const v = typeof scores[cat.key] === 'number' ? scores[cat.key] : null;
        const w = cat.weight != null ? cat.weight : 1;
        wsum += w;
        if (v != null) sum += v * w;
        items.push({
          name: cat.name || cat.key,
          weight: cat.weight != null ? cat.weight : null,
          pct: v != null ? Math.max(2, Math.min(100, Math.round(v))) : 2,
          text: v != null ? v.toFixed(1) : '—',
        });
      }
      const weighted = wsum > 0 && lbRow.overall != null ? lbRow.overall.toFixed(2) : (wsum > 0 ? (sum / wsum).toFixed(2) : '—');
      sections.push({
        label: `LiveBench 能力分项 · ${(lbData.release || lbData.releaseId || '').toString()}${lbData.generation === 'v1' ? ' · v1' : ''}`,
        kind: 'bench',
        items,
        rows: [{ label: '官方加权综合分', value: `${weighted}${lbRow.rank != null ? ' · 第 ' + lbRow.rank + ' 名' : ''}` }],
        note: '按官方类别权重加权（缺失类别不计入分母）；与 Arena / 智能指数口径独立。',
      });
    }

    /* ---- 我的用量 ---- */
    if (usageRow) {
      sections.push({
        label: '我的用量 · 近 30 天',
        kind: 'usage',
        data: {
          tokens: usageRow.totalTokens,
          calls: usageRow.calls,
          share: usageRow.share,
          cost: usageRow.estimatedCostUsd,
          rank: usageRow.localRank,
          weekly: usageRow.globalWeekly,
        },
      });
    }

    sections.push({ label: '数据来源', kind: 'links', items: DETAIL_LINKS });

    return {
      title,
      subtitleBits,
      sections,
      sourceLabel: source,
      ariaLabel: `${title} 明细`,
    };
  }

  function RowDetailDrawer({ detail, onClose, snapshot, usage }) {
    const panelRef = useRef(null);
    const closeRef = useRef(null);
    const restoreRef = useRef(null);

    useEffect(() => {
      if (!detail) return undefined;
      try { restoreRef.current = document.activeElement; } catch { restoreRef.current = null; }
      const timer = setTimeout(() => {
        const btn = closeRef.current;
        if (btn && btn.focus) { try { btn.focus(); } catch { /* noop */ } }
      }, 0);
      const onKey = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); return; }
        if (e.key !== 'Tab') return;
        const panel = panelRef.current;
        if (!panel) return;
        let nodes;
        try {
          nodes = panel.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select, textarea');
        } catch { return; }
        if (!nodes.length) return;
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); try { last.focus(); } catch { /* noop */ } }
        else if (!e.shiftKey && active === last) { e.preventDefault(); try { first.focus(); } catch { /* noop */ } }
      };
      try { document.addEventListener('keydown', onKey, true); } catch { /* noop */ }
      return () => {
        clearTimeout(timer);
        try { document.removeEventListener('keydown', onKey, true); } catch { /* noop */ }
        const prev = restoreRef.current;
        if (prev && prev.focus) { try { prev.focus(); } catch { /* noop */ } }
      };
    }, [detail, onClose]);

    const info = buildRowDetail(detail, { snapshot, usage });
    if (!info) return null;

    const renderSectionBody = (sec) => {
      if (sec.kind === 'kv') {
        return h('div', { className: 'mrr-kvgrid' }, sec.items.map((it, j) => h('div', { className: 'mrr-kv', key: j },
          h('span', { className: 'mrr-kv-label' }, it.label),
          h('span', { className: 'mrr-kv-value' }, it.value, it.sub ? h('small', null, it.sub) : null))));
      }
      if (sec.kind === 'kvrows') {
        return h('div', null, sec.items.map((it, j) => h('div', { className: 'mrr-kvrow', key: j },
          h('span', null, it.label), h('b', null, it.value))));
      }
      if (sec.kind === 'bench') {
        return h('div', null,
          (sec.rows || []).map((it, j) => h('div', { className: 'mrr-kvrow', key: 'r' + j }, h('span', null, it.label), h('b', null, it.value))),
          sec.items.map((it, j) => h('div', { className: 'mrr-bench', key: j, title: it.weight != null ? `${it.name}：官方权重 ×${it.weight}` : it.name },
            h('span', { className: 'mrr-bench-name' }, it.name, it.weight != null ? h('span', { className: 'mrr-bench-w' }, '×' + it.weight) : null),
            h('span', { className: 'mrr-bench-track', 'data-quiet': it.pct < 50 ? '1' : '0' }, h('i', { style: { width: it.pct + '%' } })),
            h('span', { className: 'mrr-bench-val' }, it.text))),
          sec.note ? h('div', { className: 'mrr-usagebox-sub', style: { marginTop: '6px' } }, sec.note) : null);
      }
      if (sec.kind === 'usage') {
        const u = sec.data || {};
        return h('div', { className: 'mrr-usagebox' },
          h('div', { className: 'mrr-usagebox-top' },
            h('b', null, fmtTokens(u.tokens), h('small', { className: 'mrr-usagebox-unit' }, 'tokens')),
            h('span', { className: 'mrr-usagebox-sub' }, `占比 ${typeof u.share === 'number' ? fmtPct(u.share) : '—'} · 估算 ${fmtCost(u.cost)}`)),
          h('div', { className: 'mrr-usagebox-sub' },
            h('span', null, `${fmtInt(u.calls)} 次调用`),
            u.rank != null ? h('span', null, `本地排名 #${u.rank}`) : null,
            u.weekly && u.weekly.rank != null ? h('span', null, `OpenRouter 周榜 #${u.weekly.rank}${u.weekly.tokensLabel ? ' · ' + u.weekly.tokensLabel : ''}`) : null));
      }
      if (sec.kind === 'links') {
        return h('div', { className: 'mrr-usagebox-sub' }, sec.items.map((it, j) => h('a', {
          key: j, className: 'mrr-drawer-link', href: it.href, target: '_blank', rel: 'noopener noreferrer',
        }, it.label, ' ↗')));
      }
      return null;
    };

    return h('div', { className: 'mrr-drawer-mask', role: 'presentation', onClick: onClose },
      h('aside', {
        className: 'mrr-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': info.ariaLabel,
        ref: panelRef, tabIndex: -1, onClick: (e) => e.stopPropagation(),
      },
        h('div', { className: 'mrr-drawer-head' },
          h('div', { className: 'mrr-drawer-head-main' },
            h('h2', { className: 'mrr-drawer-title' }, info.title),
            h('div', { className: 'mrr-drawer-sub' }, info.subtitleBits)),
          h('button', {
            type: 'button', className: 'mrr-drawer-close', ref: closeRef, onClick: onClose,
            'aria-label': '关闭明细', title: '关闭（Esc）',
          }, '×')),
        h('div', { className: 'mrr-drawer-body' },
          info.sections.map((sec, i) => h('section', { className: 'mrr-drawer-sec', key: i },
            h('h3', { className: 'mrr-drawer-label' }, sec.label),
            renderSectionBody(sec)))),
        h('div', { className: 'mrr-drawer-foot' }, '数据来自当前快照 / 用量缓存，不额外请求；金额为按公开价格估算。'),
      ));
  }

  /**
   * 面板级错误边界（P1-06）：任何一段数据/渲染异常只降级当前区域，不白屏整面板。
   * 注意：这是浏览器渲染边界；SSR/validate-client 里靠各表格的 Array.isArray 防御兜底。
   */
  class PanelBoundary extends React.Component {
    constructor(props) {
      super(props);
      this.state = { error: null };
    }
    static getDerivedStateFromError(error) {
      return { error };
    }
    render() {
      if (this.state.error) {
        const message = String((this.state.error && this.state.error.message) || this.state.error || '未知错误');
        return h('div', { className: 'mrr-card', role: 'alert' },
          h('div', { className: 'mrr-empty' },
            h('h2', null, this.props.title || '视图渲染失败'),
            h('p', null, message),
            h('p', null, '当前数据可能异常；点「重试」或切换标签页后可恢复，其余榜单功能不受影响。'),
            h('button', { type: 'button', className: 'mrr-refreshbtn', onClick: () => this.setState({ error: null }) }, '重试')));
      }
      return this.props.children;
    }
  }

  // P1-05：手动刷新结果 → 提示映射抽成纯函数（throttled/busy/ok:false/ok:true 四态），便于离线断言
  function refreshFeedback(result) {
    if (!result || typeof result !== 'object') return { type: 'unknown', message: null };
    if (result.reason === 'throttled') return { type: 'throttled', message: '刚刷新过（10 分钟最小间隔），请稍后再试。' };
    if (result.reason === 'force-limited') return { type: 'force-limited', message: '强制刷新过于频繁（每小时最多 3 次），请稍后再试。' };
    if (result.reason === 'busy') return { type: 'busy', message: '上一次刷新还在进行中，稍等即可看到结果。' };
    if (result.ok === false) return { type: 'error', message: '刷新失败：' + (result.error || '未知错误') };
    if (result.ok === true) return { type: 'ok', message: null };
    return { type: 'unknown', message: null };
  }

  function Panel(props) {
    const cachedRef = useRef(undefined);
    if (cachedRef.current === undefined) cachedRef.current = readCache();
    const cached = cachedRef.current;
    const [payload, setPayload] = useState(cached);
    const [meta, setMeta] = useState(cached ? cached.meta : null);
    const [inventory, setInventory] = useState(cached ? cached.inventory : null);
    const [loading, setLoading] = useState(!cached);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState(() => {
      try { return localStorage.getItem(TAB_KEY) || 'arena'; } catch { return 'arena'; }
    });
    const [query, setQuery] = useState('');
    const [onlyLocal, setOnlyLocal] = useState(false);
    const [detail, setDetail] = useState(null);
    const mountedRef = useRef(true);
    // 用量与榜单并行拉取：打开面板即同时发起，互不阻塞（缓存优先，见 useUsageData）
    const usageState = useUsageData();
    const reloadUsage = usageState.reload;

    useEffect(() => () => { mountedRef.current = false; }, []);

    const applyPayload = useCallback((p) => {
      if (!p || !p.snapshot) return;
      setPayload(p);
      setMeta(p.meta || null);
      setInventory(p.inventory || null);
      writeCache(p);
    }, []);

    useEffect(() => {
      rpcGet('snapshot')
        .then((p) => { if (mountedRef.current) { applyPayload(p); setLoading(false); } })
        .catch((err) => {
          if (!mountedRef.current) return;
          setLoading(false);
          if (!cached) setError(String((err && err.message) || err));
        });
    }, [applyPayload]);

    const onRefresh = useCallback(async () => {
      setRefreshing(true);
      setError(null);
      // 手动刷新：榜单与用量两者都刷（互不阻塞）
      reloadUsage({ silent: false });
      try {
        // P1-03：host 最坏抓取 ~93s（4 源并行 + 重试），客户端超时放宽到 120s 避免「实际成功却报失败」
        const result = await rpcPost('refresh', {}, 120000);
        // P1-05：先判执行结果（throttled/busy/失败），再应用可能附带的旧快照——
        // host 的 refresh 响应总带 snapshot，旧顺序会让下面的分支永远不执行。
        const feedback = refreshFeedback(result);
        if (feedback.message) setError(feedback.message);
        else if (feedback.type === 'ok') setError(null);
        if (result && result.snapshot) applyPayload(result.snapshot);
      } catch (err) {
        setError('刷新请求失败：' + String((err && err.message) || err));
      } finally {
        if (mountedRef.current) setRefreshing(false);
      }
    }, [applyPayload, reloadUsage]);

    const changeTab = useCallback((id) => {
      setTab(id);
      setDetail(null); // 切 tab 关闭明细抽屉
      try { localStorage.setItem(TAB_KEY, id); } catch { /* noop */ }
    }, []);

    // 明细抽屉稳定接口（designer 阶段 B 的抽屉直接复用；source: arena|aa|week|month|share|livebench）
    const openRowDetail = useCallback((nextDetail) => { setDetail(nextDetail); }, []);
    const closeRowDetail = useCallback(() => { setDetail(null); }, []);
    // tab 键盘导航：←/→ 循环、Home/End；roving tabindex
    const tabKeyHandler = useCallback((e) => {
      const ids = TABS.map((t) => t.id);
      const cur = ids.indexOf(tab);
      let next = -1;
      if (e.key === 'ArrowRight') next = (cur + 1) % ids.length;
      else if (e.key === 'ArrowLeft') next = (cur - 1 + ids.length) % ids.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = ids.length - 1;
      if (next < 0) return;
      e.preventDefault();
      changeTab(ids[next]);
      const el = document.getElementById('mrr-tab-' + ids[next]);
      if (el && el.focus) el.focus();
    }, [tab, changeTab]);

    const snapshot = payload && payload.snapshot;
    const arena = (snapshot && snapshot.arena) || null;
    const aa = (snapshot && snapshot.aa) || null;
    const livebench = (snapshot && snapshot.livebench) || null;
    const usage = (snapshot && snapshot.usage) || null;
    const staleBadge = (section) => section && section.stale ? h(Badge, { kind: 'stale', title: '该数据源最近一次抓取失败，显示的是上一次成功的数据' }, '数据源待更新') : null;
    // P1-13：宿主最近一次抓取/写盘失败要可见（SourceStatusBar 只覆盖单源状态，这里补全局 banner）
    const metaError = meta && (meta.lastError || meta.lastWriteError) ? (meta.lastError || meta.lastWriteError) : null;
    const metaErrorText = meta && meta.lastError
      ? `数据源刷新失败：${meta.lastError.message || '未知错误'}`
      : (meta && meta.lastWriteError ? `快照写入失败：${meta.lastWriteError.message || '未知错误'}` : '');

    let body = null;
    if (!snapshot) {
      body = loading
        ? h('div', { className: 'mrr-card' }, h('div', { className: 'mrr-loading' }, '正在载入快照…'))
        : h('div', { className: 'mrr-card' },
            h('div', { className: 'mrr-empty' },
              h('h2', null, '还没有榜单数据'),
              h('p', null, error ? `载入失败：${error}` : '宿主尚未完成首次抓取。点击下方按钮立即刷新（抓取三个公开榜单源，约几秒钟）。'),
              h('button', { className: 'mrr-refreshbtn', onClick: onRefresh, disabled: refreshing },
                refreshing ? h('i', { className: 'mrr-spin' }) : null, refreshing ? '正在刷新…' : '立即抓取')),
          );
    } else {
      const showFilters = tab === 'arena' || tab === 'aa' || tab === 'livebench' || tab === 'week' || tab === 'month' || tab === 'share' || tab === 'local';
      const isLocalTab = tab === 'local';
      const tokenHeader = tab === 'week' ? '本周 tokens' : '近 30 天 tokens';
      body = h('div', { id: 'mrr-panel-' + tab, className: 'mrr-tabpanel', role: 'tabpanel', 'aria-labelledby': 'mrr-tab-' + tab },
        error ? h('div', { className: 'mrr-err', role: 'status', 'aria-live': 'polite' }, error) : null,
        metaErrorText ? h('div', { className: 'mrr-err', role: 'status', 'aria-live': 'polite', title: metaError && metaError.at ? `记录时间：${metaError.at}` : undefined }, metaErrorText) : null,
        showFilters && !isLocalTab
          ? h('div', { className: 'mrr-filters' },
              h(SearchBox, { value: query, onChange: setQuery }),
              h('button', { className: 'mrr-chip', 'data-active': onlyLocal ? '1' : '0', onClick: () => setOnlyLocal((v) => !v), title: '只显示本机已接入的模型' },
                '仅看已接入'),
            )
          : null,
        tab === 'arena' ? h('div', null,
          h(SourceStatusBar, { sourceId: 'arena', snapshot, meta }),
          staleBadge(arena),
          h(ArenaTable, { arena, query, onlyLocal, onRowOpen: openRowDetail })) : null,
        tab === 'aa' ? h('div', null,
          h(SourceStatusBar, { sourceId: 'aa', snapshot, meta }),
          staleBadge(aa),
          h(AaTable, { models: aa && aa.models, query, onlyLocal, onRowOpen: openRowDetail })) : null,
        tab === 'livebench' ? h(LivebenchSection, {
          livebench, query, onlyLocal, onRefresh, snapshot, meta, onRowOpen: openRowDetail,
        }) : null,
        tab === 'week' ? h('div', null,
          h(SourceStatusBar, { sourceId: 'usage', snapshot, meta }),
          staleBadge(usage),
          h(UsageTable, { rows: usage && usage.weekly, query, onlyLocal, tokensHeader: tokenHeader, source: 'week', onRowOpen: openRowDetail })) : null,
        tab === 'month' ? h('div', null,
          h(SourceStatusBar, { sourceId: 'usage', snapshot, meta }),
          staleBadge(usage),
          h(UsageTable, { rows: usage && usage.month, query, onlyLocal, tokensHeader: tokenHeader, source: 'month', onRowOpen: openRowDetail })) : null,
        tab === 'share' ? h('div', null,
          h(SourceStatusBar, { sourceId: 'usage', snapshot, meta }),
          staleBadge(usage),
          h(ShareList, { rows: usage && usage.marketShare, query, onlyLocal, onRowOpen: openRowDetail })) : null,
        tab === 'local' ? h(UsagePanel, {
          usage: usageState.usage,
          loading: usageState.loading,
          error: usageState.error,
          fetchedAt: usageState.fetchedAt,
          refreshing: usageState.refreshing,
          onReload: () => reloadUsage({ silent: false }),
          query,
          inventory,
          snapshot,
          searchBox: h(SearchBox, { value: query, onChange: setQuery, placeholder: '搜索模型 / provider…' }),
        }) : null,
        h('div', { className: 'mrr-footer' },
          h('span', null, `${(arena && arena.rows ? arena.rows.length : 0)} 个对战榜模型 · ${(aa && aa.models ? aa.models.length : 0)} 个智能榜模型 · ${(livebench && livebench.rows ? livebench.rows.length : 0)} 个能力榜模型 · 榜单每天自动刷新一次`),
          h('span', null, '来源数据署名：LMArena（CC BY 4.0）· OpenRouter（CC BY 4.0）· Artificial Analysis（运行时抓取）· LiveBench（livebench.ai 官方公开数据）'),
        ),
      );
    }

    // P1-06：per-tab 错误边界（key 随 tab 变化，切 tab 自动重置错误态）
    const tabLabel = (TABS.find((t) => t.id === tab) || {}).label || tab;
    body = h(PanelBoundary, { key: 'panel-boundary-' + tab, title: `「${tabLabel}」视图渲染失败` }, body);

    return h(PanelBoundary, { title: '模型排行面板渲染失败' }, h('div', { className: 'mrr-root' },
      h('div', { className: 'mrr-inner' },
        h(PanelHeader, { meta, inventory, onRefresh, refreshing, hasSnapshot: !!snapshot, snapshot }),
        h('div', { className: 'mrr-tabs', role: 'tablist', 'aria-label': '榜单切换', onKeyDown: tabKeyHandler }, TABS.map((t) => {
          const count = t.id === 'arena' ? (arena && arena.rows ? arena.rows.length : 0)
            : t.id === 'aa' ? (aa && aa.models ? aa.models.length : 0)
            : t.id === 'livebench' ? (livebench && livebench.rows ? livebench.rows.length : 0)
            : t.id === 'week' ? (usage && usage.weekly ? usage.weekly.length : 0)
            : t.id === 'month' ? (usage && usage.month ? usage.month.length : 0)
            : t.id === 'share' ? (usage && usage.marketShare ? usage.marketShare.length : 0)
            : (inventory && inventory.userModelsCount) || 0;
          const active = tab === t.id;
          return h('button', {
            key: t.id, type: 'button', role: 'tab', className: 'mrr-tab',
            id: 'mrr-tab-' + t.id, 'data-tab': t.id, 'data-active': active ? '1' : '0',
            'aria-selected': active ? 'true' : 'false', 'aria-controls': 'mrr-panel-' + t.id,
            tabIndex: active ? 0 : -1,
            onClick: () => changeTab(t.id), title: t.note,
          }, t.label, count > 0 ? h('span', { className: 'mrr-tabcount' }, String(count)) : null);
        })),
        body,
      ),
      h(RowDetailDrawer, { detail, onClose: closeRowDetail, snapshot, usage: usageState.usage })));
  }

  // ---------------------------------------------------------------------------
  // 注册（cordis 插件形态：slots 服务晚到也不崩）
  // ---------------------------------------------------------------------------

  function waitSlots(ctx) {
    return new Promise((resolve) => {
      let slots = null;
      try { slots = ctx.slots || (ctx.get && ctx.get('slots')); } catch { slots = null; }
      if (slots) return resolve(slots);
      let i = 0;
      const tick = () => {
        i += 1;
        let s = null;
        try { s = ctx.slots || (ctx.get && ctx.get('slots')); } catch { s = null; }
        if (s || i > 80) return resolve(s);
        const delay = Math.min(300 + i * 20, 1000);
        setTimeout(tick, delay);
      };
      tick();
    });
  }

  async function apply(ctx) {
    const slots = await waitSlots(ctx);
    if (!slots) {
      try { console.warn('[dsh-model-rank] slots 服务未就绪，侧栏入口未注册'); } catch { /* noop */ }
      return;
    }

    try { console.debug('[dsh-model-rank] slots ready'); } catch { /* noop */ }

    ctx.effect(() => installStyles(), `${PLUGIN_ID}: styles`);

    ctx.effect(() => {
      const stopMain = slots.inject('main', () => {
        const stop = slots.register({ name: 'main', key: PANEL_KEY }, Panel);
        return stop;
      });
      const stopSidebar = slots.inject('sidebar.panellist', () => {
        const stop = slots.register({
          name: 'sidebar.panellist',
          id: PANEL_KEY,
          order: SLOT_ORDER,
          label: '模型排行',
        }, PanelIcon);
        return stop;
      });
      return () => {
        try { stopSidebar && stopSidebar(); } catch { /* noop */ }
        try { stopMain && stopMain(); } catch { /* noop */ }
      };
    }, `${PLUGIN_ID}: panel + sidebar entry`);
  }

  module.exports = {
    inject: ['slots'],
    apply,
    // 仅测试出口（validate-client 离线断言用；不参与插件契约，宿主/loader 只读 inject/apply）
    __test: {
      normKey,
      csvCell,
      buildCsv,
      compareSortValues,
      applyTableSort,
      costCoverageInfo,
      refreshFeedback,
      filterShareRows,
      fmtCtx,
      fmtPrice,
    },
  };

  return module.exports;
} });
