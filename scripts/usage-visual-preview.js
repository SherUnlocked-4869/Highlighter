#!/usr/bin/env node
"use strict";

// Dev-only headless visual-review harness for the AI usage page.
//
// Creates a hidden BrowserWindow (NEVER shown: `show:false`), loads
// design-demos/usage-page-preview.html (static settings-window shell + mocked
// usage:* IPC payloads + the real route script and styles), sizes the window to
// the requested content width / full document height and writes PNG captures
// with `capturePage()`.
//
// Two sizing modes:
//   --widths a,b        BrowserWindow CONTENT widths (1180 => #view content 908
//                       after the 224px sidebar + 48px page padding).
//   --page-widths a,b   target `.usage-page` CONTENT widths, measured and
//                       iterated to +/-1px (max-width is pinned for the shot).
//                       Use this to judge layouts at fixed content widths
//                       independent of the shell/viewport.
//
// Optional --tooltip opens the 52-week heatmap tooltip on the richest active
// cell by dispatching the page's real `mouseenter`/`focus` handlers (so its own
// clamping/flip positioning runs) and adds `-tooltip` to the file name.
//
// Usage (from the repo root; the agent shell exports ELECTRON_RUN_AS_NODE=1 and
// cannot start Chromium's own sandbox, so both workarounds are required there —
// a normal dev shell needs neither):
//
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
//     --no-sandbox scripts/usage-visual-preview.js --out .tmp/usage-preview \
//     --page-widths 908,1180,1440 --themes light,dark --label after
//
//   # pre-redesign baseline (page/CSS/helpers read from a git ref into a temp
//   # tree, so uncommitted redesign work cannot leak into the baseline)
//   ... --from-git HEAD --label before --page-widths 908,1180,1440
//
//   # heatmap tooltip shots
//   ... --tooltip --page-widths 1180 --themes light,dark --label after
//
// Output: <out>/<label>-<width>-<theme>[-tooltip].png plus a machine-readable
// JSON line prefixed with HIGHLIGHTER_USAGE_PREVIEW=. Per-variant report
// includes the measured window/view/page widths and heatmap dead space so
// layouts are compared at known fixed points. Exit 0 only when every variant
// captured with zero pageerror/console-error (2 otherwise: captures are still
// written for inspection).

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { app, BrowserWindow } = require("electron");

const RESULT_PREFIX = "HIGHLIGHTER_USAGE_PREVIEW=";
const WORKTREE = path.join(__dirname, "..");
const DEFAULT_PREVIEW = path.join(WORKTREE, "design-demos", "usage-page-preview.html");
const SIDEBAR_WIDTH = 224;
const VIEW_PADDING = 48;

if (!app || typeof app.disableHardwareAcceleration !== "function" || process.type !== "browser") {
  process.stderr.write(
    "usage-visual-preview must run as an Electron main script, not under ELECTRON_RUN_AS_NODE=1.\n" +
      "Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe --no-sandbox scripts/usage-visual-preview.js\n",
  );
  process.exit(2);
}

// Baseline files loaded by the preview; every one is taken from the git ref so
// a concurrent redesign of these files cannot leak into the "before" shots.
const BASELINE_TEXT_FILES = [
  "shared/tokens.css",
  "shared/i18n.js",
  "shared/usage-format.js",
  "shared/locales/zh-CN.js",
  "shared/locales/en-US.js",
  "shared/locales/zh-TW.js",
  "shared/locales/config.js",
  "shared/locales/toolbar.js",
  "config/config.css",
  "config/routes/shared.js",
  "config/routes/usage.js",
  "search/search-utils.js",
  "toolbar/toolbar-action-meta.js",
];
// Asset dirs copied from the working tree (icons are not part of the page
// redesign and must resolve for both baseline and after captures).
const ASSET_DIRS = ["config/icons", "capture/icons", "toolbar/icons"];

function scriptArgs() {
  // Electron may inject Chromium switches (e.g. --no-sandbox) before the app
  // entry, so locate our own script path in argv and take everything after it.
  const argv = process.argv;
  const entryIndex = argv.findIndex(
    (arg, index) => index > 0 && typeof arg === "string" && arg && !arg.startsWith("-") && path.resolve(arg) === path.resolve(__filename),
  );
  if (entryIndex >= 0) return argv.slice(entryIndex + 1);
  return argv.slice(1).filter((arg) => !["--no-sandbox", "--disable-gpu"].includes(arg));
}

function parseList(value, name) {
  const list = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (list.length === 0) throw new Error(`${name} requires a comma-separated list`);
  return list;
}

function parseArgs(argv) {
  const opts = {
    out: path.join(WORKTREE, ".tmp", "usage-preview"),
    widths: null,
    pageWidths: null,
    themes: ["light", "dark"],
    label: "usage",
    period: "month",
    lang: "zh-CN",
    compact: false,
    tooltip: false,
    modal: false,
    modalGranularities: null,
    hourlyEmpty: false,
    heatmapScroll: false,
    sources: null,
    filterClick: null,
    switching: false,
    dumpDom: false,
    fromGit: null,
    maxHeight: 6000,
    timeoutMs: 30000,
    keepHarness: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "--out") opts.out = path.resolve(next());
    else if (arg === "--widths") opts.widths = parseList(next(), "--widths").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    else if (arg === "--page-widths") opts.pageWidths = parseList(next(), "--page-widths").map(Number).filter((n) => Number.isFinite(n) && n > 0);
    else if (arg === "--themes") opts.themes = parseList(next(), "--themes");
    else if (arg === "--label") opts.label = next();
    else if (arg === "--period") opts.period = next();
    else if (arg === "--lang") opts.lang = next();
    else if (arg === "--sources") opts.sources = parseList(next(), "--sources").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--filter-click") opts.filterClick = parseList(next(), "--filter-click").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--switching") opts.switching = true;
    else if (arg === "--compact") opts.compact = true;
    else if (arg === "--tooltip") opts.tooltip = true;
    else if (arg === "--modal") opts.modal = true;
    else if (arg === "--modal-granularity") opts.modalGranularities = String(next()).split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--hourly-empty") opts.hourlyEmpty = true;
    else if (arg === "--heatmap-scroll") opts.heatmapScroll = true;
    else if (arg === "--dump-dom") opts.dumpDom = true;
    else if (arg === "--from-git") opts.fromGit = next();
    else if (arg === "--max-height") opts.maxHeight = Number(next()) || opts.maxHeight;
    else if (arg === "--timeout") opts.timeoutMs = Number(next()) || opts.timeoutMs;
    else if (arg === "--keep-harness") opts.keepHarness = true;
    else if (arg === "-h" || arg === "--help") {
      process.stdout.write(fs.readFileSync(__filename, "utf8").split("\n").slice(1, 62).join("\n") + "\n");
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!["day", "week", "month", "total"].includes(opts.period)) throw new Error(`unsupported --period: ${opts.period}`);
  if (!["zh-CN", "zh-TW", "en-US"].includes(opts.lang)) throw new Error(`unsupported --lang: ${opts.lang}`);
  if (!opts.widths && !opts.pageWidths) opts.widths = [1180, 1440];
  if (opts.widths && opts.pageWidths) throw new Error("use either --widths or --page-widths, not both");
  if (opts.modalGranularities) opts.modal = true;
  const modes = [opts.tooltip, opts.modal, opts.heatmapScroll].filter(Boolean).length;
  if (modes > 1) throw new Error("use only one of --tooltip / --modal / --heatmap-scroll per run");
  if (opts.modalGranularities) {
    const allowed = ["30m", "day", "month"];
    for (const granularity of opts.modalGranularities) {
      if (!allowed.includes(granularity)) throw new Error(`unsupported --modal-granularity value: ${granularity} (expected 30m|day|month)`);
    }
  }
  const allowedSources = ["codex", "dsh", "opencode"];
  if (opts.sources) {
    for (const source of opts.sources) {
      if (!allowedSources.includes(source)) throw new Error(`unsupported --sources value: ${source} (expected codex|dsh|opencode)`);
    }
    // Modes that replace the dashboard would hide the filter row; keep the
    // combinations explicit instead of silently ignoring one of them.
    if (opts.tooltip || opts.modal || opts.heatmapScroll) throw new Error("--sources cannot be combined with --tooltip/--modal/--heatmap-scroll");
  }
  if (opts.filterClick) {
    for (const source of opts.filterClick) {
      if (!allowedSources.includes(source) && source !== "all") {
        throw new Error(`unsupported --filter-click value: ${source} (expected codex|dsh|opencode|all)`);
      }
    }
    if (opts.sources) throw new Error("use either --sources or --filter-click, not both");
    if (opts.modal || opts.heatmapScroll) throw new Error("--filter-click cannot be combined with --modal/--heatmap-scroll");
  }
  return opts;
}

function prepareBaselineTree(opts) {
  const ref = opts.fromGit;
  const safeRef = ref.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const dir = path.join(opts.out, `harness-${safeRef}-${Date.now()}`);
  fs.mkdirSync(dir, { recursive: true });
  const written = [];
  for (const rel of BASELINE_TEXT_FILES) {
    let buffer;
    try {
      buffer = execFileSync("git", ["show", `${ref}:${rel}`], {
        cwd: WORKTREE,
        encoding: "buffer",
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw new Error(`git show ${ref}:${rel} failed: ${error && error.message ? error.message : String(error)}`);
    }
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    written.push(rel);
  }
  for (const rel of ASSET_DIRS) {
    const source = path.join(WORKTREE, rel);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(dir, rel), { recursive: true });
  }
  const previewPath = path.join(dir, "design-demos", "usage-page-preview.html");
  fs.mkdirSync(path.dirname(previewPath), { recursive: true });
  fs.copyFileSync(DEFAULT_PREVIEW, previewPath);
  process.stdout.write(`$ baseline tree (${ref}): ${dir}\n$ baseline files: ${written.length}\n`);
  return {
    previewPath,
    dir,
    cleanup() {
      if (opts.keepHarness) return;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (_error) {
        // ignore
      }
    },
  };
}

function attachConsoleCapture(win) {
  const consoleErrors = [];
  const consoleWarnings = [];
  win.webContents.on("console-message", (...args) => {
    // Electron 35+ passes (event, details); older builds pass
    // (event, level, message, line, sourceId). Accept both.
    const second = args[1];
    let level = null;
    let message = null;
    if (second && typeof second === "object" && "message" in second) {
      level = second.level;
      message = second.message;
    } else {
      level = args[1];
      message = args[2];
    }
    const text = String(message === undefined || message === null ? "" : message);
    const levelText = typeof level === "string" ? level.toLowerCase() : String(level);
    if (levelText === "error" || level === 3) consoleErrors.push(text);
    else if (levelText === "warning" || level === 2) consoleWarnings.push(text);
  });
  return { consoleErrors, consoleWarnings };
}

function waitForReady(win, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return (async function poll() {
    while (Date.now() < deadline) {
      try {
        const ready = await win.webContents.executeJavaScript("window.__usagePreviewReady === true", true);
        if (ready) return true;
      } catch (_error) {
        // page still loading
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`preview did not become ready within ${timeoutMs} ms`);
  })();
}

const measureScript = `(() => {
  if (typeof window.__usagePreviewMeasure === 'function') return window.__usagePreviewMeasure();
  const page = document.querySelector('.usage-page');
  const view = document.getElementById('view');
  const heatScroll = document.querySelector('[data-usage-heatmap-scroll], .usage-heatmap-scroll');
  const heatGrid = document.querySelector('.usage-heatmap-grid, .usage-heat-grid, .usage-heat-canvas');
  const heatCells = (heatGrid || document.querySelector('#usageHeatmap, .usage-heatmap'))
    ? Array.from((heatGrid || document.querySelector('#usageHeatmap, .usage-heatmap')).querySelectorAll('.usage-heat-cell, [data-usage-heat-day]'))
    : [];
  const rect = (element) => {
    if (!element) return null;
    const r = element.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
  };
  return {
    windowInnerWidth: window.innerWidth,
    viewClientWidth: view ? view.clientWidth : null,
    viewRect: rect(view),
    pageWidth: page ? page.getBoundingClientRect().width : null,
    pageRect: rect(page),
    heatmapCardRect: rect(document.querySelector('.usage-heatmap')),
    heatmapScrollClientWidth: heatScroll ? heatScroll.clientWidth : null,
    heatmapScrollWidth: heatScroll ? heatScroll.scrollWidth : null,
    heatmapContentWidth: heatCells.length > 0
      ? Math.round(Math.max(...heatCells.map((c) => c.getBoundingClientRect().right)) - Math.min(...heatCells.map((c) => c.getBoundingClientRect().left)))
      : null,
    heatmapLeftDeadSpacePx: heatCells.length > 0 && heatScroll
      ? Math.max(0, Math.round(Math.min(...heatCells.map((c) => c.getBoundingClientRect().left)) - heatScroll.getBoundingClientRect().left))
      : null,
    heatmapDeadSpacePx: (() => {
      if (!heatScroll || heatCells.length === 0) return null;
      const rightMost = Math.max(...heatCells.map((c) => c.getBoundingClientRect().right));
      return Math.max(0, Math.round(heatScroll.getBoundingClientRect().right - rightMost));
    })(),
    heatmapMarginDeltaPx: (() => {
      if (!heatScroll || heatCells.length === 0) return null;
      const scrollRect = heatScroll.getBoundingClientRect();
      const leftMost = Math.min(...heatCells.map((c) => c.getBoundingClientRect().left));
      const rightMost = Math.max(...heatCells.map((c) => c.getBoundingClientRect().right));
      return Math.round(Math.abs((leftMost - scrollRect.left) - (scrollRect.right - rightMost)));
    })(),
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)
  };
})()`;

const tooltipScript = `(() => {
  const chart = document.querySelector('[data-usage-heatmap]');
  const card = document.querySelector('.usage-heatmap') || chart;
  if (!chart) return { ok: false, reason: 'no heatmap chart' };
  const cells = Array.from(chart.querySelectorAll('[data-usage-heat-day]'));
  if (cells.length === 0) return { ok: false, reason: 'no heatmap cells' };
  const richDay = window.__usagePreviewRichDay;
  const withData = cells.filter((cell) => (cell.getAttribute('data-usage-heat-level') || '0') !== '0' && cell.getAttribute('data-usage-heat-level') !== null);
  const cell = (richDay && cells.find((item) => item.dataset.usageHeatDay === richDay))
    || (withData.length > 0 ? withData[withData.length - 1] : cells[cells.length - 1]);
  // Dispatch the page's real handlers so its own clamp/flip positioning runs.
  window.__usagePreviewTooltipCell = cell.dataset.usageHeatDay;
  cell.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false, cancelable: false, view: window }));
  cell.dispatchEvent(new FocusEvent('focus', { bubbles: false, cancelable: false, view: window }));
  const tooltip = chart.querySelector('[data-usage-heatmap-tooltip]') || document.querySelector('[data-usage-heatmap-tooltip]');
  if (!tooltip) return { ok: false, reason: 'no tooltip element', cellDay: cell.dataset.usageHeatDay };
  const t = tooltip.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const cellRect = cell.getBoundingClientRect();
  const inside = (value, min, max) => value >= min - 1 && value <= max + 1;
  const styles = window.getComputedStyle(tooltip);
  return {
    ok: true,
    computedStyle: {
      display: styles.display,
      visibility: styles.visibility,
      opacity: styles.opacity,
      position: styles.position,
      zIndex: styles.zIndex,
      pointerEvents: styles.pointerEvents,
      overflow: styles.overflow
    },
    offsetParentTag: tooltip.offsetParent ? tooltip.offsetParent.tagName : null,
    cellDay: cell.dataset.usageHeatDay,
    cellLevel: cell.getAttribute('data-usage-heat-level'),
    hidden: tooltip.hidden,
    tooltipRect: { left: t.left, top: t.top, width: t.width, height: t.height, right: t.right, bottom: t.bottom },
    cardRect: { left: c.left, top: c.top, width: c.width, height: c.height, right: c.right, bottom: c.bottom },
    cellRect: { left: cellRect.left, top: cellRect.top, width: cellRect.width, height: cellRect.height },
    insideCard: inside(t.left, c.left, c.right) && inside(t.right, c.left, c.right) && inside(t.top, c.top, c.bottom) && inside(t.bottom, c.top, c.bottom),
    modelRows: tooltip.querySelectorAll('.usage-heat-tip-model').length,
    scrollHeight: tooltip.scrollHeight,
    clientHeight: tooltip.clientHeight,
    clippedVertically: tooltip.scrollHeight > tooltip.clientHeight + 1,
    modelListClipped: (() => {
      const list = tooltip.querySelector('.usage-heat-tip-models');
      if (!list) return null;
      return list.scrollHeight > list.clientHeight + 1;
    })(),
    modelListScrollHeight: (() => {
      const list = tooltip.querySelector('.usage-heat-tip-models');
      return list ? list.scrollHeight : null;
    })(),
    modelListClientHeight: (() => {
      const list = tooltip.querySelector('.usage-heat-tip-models');
      return list ? list.clientHeight : null;
    })(),
    modelRowsFullyVisible: (() => {
      const rows = Array.from(tooltip.querySelectorAll('.usage-heat-tip-model'));
      return rows.filter((row) => {
        const rr = row.getBoundingClientRect();
        return rr.top >= t.top - 1 && rr.bottom <= t.bottom + 1;
      }).length;
    })(),
    footerVisible: (() => {
      const foot = tooltip.querySelector('.usage-heat-tip-foot');
      if (!foot) return null;
      const f = foot.getBoundingClientRect();
      return f.bottom <= t.bottom + 1 && f.top >= t.top - 1;
    })(),
    textLength: (tooltip.textContent || '').replace(/\\s+/g, ' ').trim().length
  };
})()`;

const tooltipStateScript = `(() => {
  const chart = document.querySelector('[data-usage-heatmap]');
  const card = document.querySelector('.usage-heatmap') || chart;
  const tooltip = chart && (chart.querySelector('[data-usage-heatmap-tooltip]') || document.querySelector('[data-usage-heatmap-tooltip]'));
  if (!chart || !tooltip) return { ok: false, reason: 'no tooltip element' };
  const t = tooltip.getBoundingClientRect();
  const c = card.getBoundingClientRect();
  const inside = (value, min, max) => value >= min - 1 && value <= max + 1;
  const styles = window.getComputedStyle(tooltip);
  const list = tooltip.querySelector('.usage-heat-tip-models');
  const rows = Array.from(tooltip.querySelectorAll('.usage-heat-tip-model'));
  const tpl = tooltip.querySelector('.usage-heat-tip-level');
  return {
    ok: true,
    cellDay: window.__usagePreviewTooltipCell || null,
    cellLevel: (() => {
      const d = window.__usagePreviewTooltipCell;
      const cell = d ? chart.querySelector('[data-usage-heat-day="' + d + '"]') : null;
      return cell ? cell.getAttribute('data-usage-heat-level') : null;
    })(),
    computedStyle: { display: styles.display, visibility: styles.visibility, opacity: styles.opacity, position: styles.position, zIndex: styles.zIndex, pointerEvents: styles.pointerEvents, overflow: styles.overflow },
    hidden: tooltip.hidden,
    tooltipRect: { left: t.left, top: t.top, width: t.width, height: t.height, right: t.right, bottom: t.bottom },
    cardRect: { left: c.left, top: c.top, width: c.width, height: c.height, right: c.right, bottom: c.bottom },
    insideCard: inside(t.left, c.left, c.right) && inside(t.right, c.left, c.right) && inside(t.top, c.top, c.bottom) && inside(t.bottom, c.top, c.bottom),
    modelRows: rows.length,
    modelRowsFullyVisible: rows.filter((row) => { const rr = row.getBoundingClientRect(); return rr.top >= t.top - 1 && rr.bottom <= t.bottom + 1; }).length,
    modelListClipped: list ? list.scrollHeight > list.clientHeight + 1 : null,
    modelListScrollHeight: list ? list.scrollHeight : null,
    modelListClientHeight: list ? list.clientHeight : null,
    tooltipScrollHeight: tooltip.scrollHeight,
    tooltipClientHeight: tooltip.clientHeight,
    clippedVertically: tooltip.scrollHeight > tooltip.clientHeight + 1,
    footerVisible: (() => { const foot = tooltip.querySelector('.usage-heat-tip-foot'); if (!foot) return null; const f = foot.getBoundingClientRect(); return f.bottom <= t.bottom + 1 && f.top >= t.top - 1; })(),
    moreModelsLine: (() => { const more = tooltip.querySelector('.usage-heat-tip-more'); return more ? more.textContent.trim() : null; })(),
    levelPill: tpl ? tpl.textContent.trim() : null,
    textLength: (tooltip.textContent || '').replace(/\s+/g, ' ').trim().length
  };
})()`;

const layoutScript = `(() => {
  const page = document.querySelector('.usage-page');
  if (!page) return null;
  const pageRect = page.getBoundingClientRect();
  const all = Array.from(page.querySelectorAll('.usage-card, .card')).filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 150 && r.height > 50;
  });
  const top = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
  };
  const entries = top.map((el) => ({
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    className: typeof el.className === 'string' ? el.className : '',
    left: Math.round(el.getBoundingClientRect().left),
    top: Math.round(el.getBoundingClientRect().top),
    width: Math.round(el.getBoundingClientRect().width),
    height: Math.round(el.getBoundingClientRect().height),
    right: Math.round(el.getBoundingClientRect().right),
    bottom: Math.round(el.getBoundingClientRect().bottom),
    heading: (() => { const h = el.querySelector('h1,h2,h3,.usage-card-head h2'); return h ? h.textContent.trim() : null; })(),
    hasModelRows: !!el.querySelector('.usage-model-row, .usage-model, .usage-integrated-row'),
    hasKpis: !!el.querySelector('.usage-kpi, .usage-kpi-pill, [data-usage-kpi], .usage-pills, #usageKpis'),
    hasFooter: /开始使用|活跃天数|first use|active days/i.test(el.textContent || ''),
    hasTotal: !!el.querySelector('#usageTotal')
  }));
  entries.sort((a, b) => a.top - b.top || a.left - b.left);
  const rows = [];
  for (const entry of entries) {
    const row = rows.find((item) => Math.abs(item.top - entry.top) <= 4);
    if (row) row.cards.push(entry);
    else rows.push({ top: entry.top, cards: [entry] });
  }
  rows.sort((a, b) => a.top - b.top);
  rows.forEach((row) => row.cards.sort((a, b) => a.left - b.left));
  const rowInfo = rows.map((row) => ({
    top: row.top,
    count: row.cards.length,
    equalHeightDelta: row.cards.length > 1 ? Math.max(...row.cards.map((c) => c.height)) - Math.min(...row.cards.map((c) => c.height)) : null,
    horizontalGaps: row.cards.slice(1).map((card, index) => card.left - (row.cards[index].left + row.cards[index].width)),
    cards: row.cards.map((card) => ({ id: card.id, className: card.className, left: card.left, width: card.width, height: card.height, heading: card.heading }))
  }));
  const rowGaps = rows.slice(1).map((row, index) => {
    const prev = rows[index];
    const prevBottom = Math.max(...prev.cards.map((card) => card.top + card.height));
    return row.top - prevBottom;
  });
  const findCard = (selectors) => {
    for (const selector of selectors) {
      const el = page.querySelector(selector);
      if (el) return el;
    }
    return null;
  };
  const heat = findCard(['#usageHeatmap', '.usage-heatmap']);
  const trend = findCard(['#usageTrend', '.usage-trend']);
  const models = findCard(['.usage-integrated', '#usageBreakdown', '.usage-models']) || top.find((el) => el.hasModelRows);
  const token = findCard(['.usage-token', '.usage-token-card', '.usage-hero', '#usageTokenCard']) || top.find((el) => el.hasTotal);
  const daily = findCard(['.usage-daily', '.usage-daily-table']);
  const heatRect = rectOf(heat);
  const trendRect = rectOf(trend);
  const modelsRect = rectOf(models);
  const tokenRect = rectOf(token);
  const dailyRect = rectOf(daily);
  const gaps = [].concat(...rowInfo.map((row) => row.horizontalGaps), rowGaps.filter((gap) => Number.isFinite(gap)));
  const maxDeadBand = gaps.length ? Math.max(...gaps) : 0;
  // Toolbar fit (2026-10-22 filter row): the AI-tool chips must stay inside the
  // page and on one line; an overflow here is invisible in the card geometry.
  const toolbar = page.querySelector('.usage-toolbar');
  const filter = page.querySelector('.usage-source-filter');
  const toolbarRect = toolbar ? toolbar.getBoundingClientRect() : null;
  const filterRect = filter ? filter.getBoundingClientRect() : null;
  return {
    pageWidth: Math.round(pageRect.width),
    viewportHeight: window.innerHeight,
    cards: entries,
    rows: rowInfo,
    rowGaps,
    toolbar: toolbarRect ? {
      height: Math.round(toolbarRect.height),
      width: Math.round(toolbarRect.width),
      scrollWidth: toolbar.scrollWidth,
      clientWidth: toolbar.clientWidth
    } : null,
    sourceFilter: filterRect ? {
      right: Math.round(filterRect.right),
      width: Math.round(filterRect.width),
      overflowsPage: Math.round(filterRect.right) > Math.round(pageRect.right) + 1,
      chipCount: filter.querySelectorAll('[data-usage-source-filter]').length
    } : null,
    rects: { heatmap: heatRect, trend: trendRect, models: modelsRect, token: tokenRect, daily: dailyRect },
    checks: {
      heatmapBeforeTrend: !!(heatRect && trendRect) && (heatRect.top < trendRect.top || (heatRect.top === trendRect.top && heatRect.left < trendRect.left)),
      row1EqualHeights: !!(heatRect && trendRect) && Math.abs(heatRect.height - trendRect.height) <= 2,
      row2EqualHeights: !!(modelsRect && tokenRect) && Math.abs(modelsRect.height - tokenRect.height) <= 2,
      tokenCardNotFullWidth: !!(tokenRect) && tokenRect.width < pageRect.width * 0.9,
      noWideDeadBands: maxDeadBand <= 40,
      integratedCardHasKpis: !!(models) && !!models.querySelector('.usage-kpi, .usage-kpi-pill, [data-usage-kpi], .usage-pills, #usageKpis'),
      integratedCardHasModelRows: !!(models) && !!models.querySelector('.usage-model-row, .usage-model, .usage-integrated-row'),
      integratedCardHasFooter: !!(models) && /开始使用|活跃天数|first use|active days/i.test(models.textContent || ''),
      dailyFullWidth: !!(dailyRect) && dailyRect.width > pageRect.width * 0.85,
      sourceFilterInsidePage: !filterRect || Math.round(filterRect.right) <= Math.round(pageRect.right) + 1,
      toolbarNoOverflow: !toolbar || toolbar.scrollWidth <= toolbar.clientWidth + 1
    },
    maxDeadBandPx: maxDeadBand
  };
})()`;

const MODAL_OPEN_SCRIPT = `(() => {
  const button = document.querySelector('[data-usage-trend-expand], .usage-trend-expand, [data-usage-expand-trend]');
  if (!button) return { ok: false, reason: 'expand button not found' };
  button.focus();
  button.click();
  return { ok: true, label: (button.getAttribute('aria-label') || button.textContent || '').trim(), disabled: !!button.disabled };
})()`;

const OVERLAY_HELPERS = `
  const OVERLAY_SELECTORS = ['[data-usage-trend-modal]', '[data-usage-modal]', '.usage-trend-modal', '.usage-modal', '[role="dialog"]', 'dialog[open]', '.modal-overlay'];
  const visibleOverlay = () => {
    for (const selector of OVERLAY_SELECTORS) {
      const el = Array.from(document.querySelectorAll(selector)).find((candidate) => {
        const r = candidate.getBoundingClientRect();
        const s = window.getComputedStyle(candidate);
        return r.width > 200 && r.height > 200 && s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) > 0;
      });
      if (el) return { el, selector };
    }
    return null;
  };
`;

const MODAL_PROBE_SCRIPT = `(() => {${OVERLAY_HELPERS}
  const found = visibleOverlay();
  if (!found) return { open: false, reason: 'no visible modal overlay', overlayCandidateCounts: OVERLAY_SELECTORS.map((selector) => ({ selector, count: document.querySelectorAll(selector).length })) };
  const overlay = found.el;
  const r = overlay.getBoundingClientRect();
  const text = (overlay.textContent || '').replace(/\\s+/g, ' ').trim();
  const tabs = Array.from(overlay.querySelectorAll('[role="tab"], button')).map((button) => (button.textContent || '').trim()).filter(Boolean);
  const granularityLabels = tabs.filter((label) => /30\\s*分钟|分钟|天|周|月|hour|day|week|month/i.test(label)).slice(0, 8);
  const has = (selectors) => selectors.some((selector) => !!overlay.querySelector(selector));
  return {
    open: true,
    overlaySelector: found.selector,
    activeGranularity: (() => {
      const active = Array.from(overlay.querySelectorAll('[data-usage-granularity]')).find(
        (button) => button.getAttribute('aria-selected') === 'true' || button.classList.contains('is-active'),
      );
      return active ? active.getAttribute('data-usage-granularity') : null;
    })(),
    chartColumns: (() => {
      const chartEl = overlay.querySelector('[data-usage-modal-chart]');
      if (!chartEl) return 0;
      return chartEl.querySelectorAll('[data-usage-modal-column], .usage-modal-col, .usage-trend-col').length;
    })(),
    chartEmptyText: (() => {
      const chartEl = overlay.querySelector('[data-usage-modal-chart]');
      const empty = chartEl ? chartEl.querySelector('.usage-modal-empty') : null;
      return empty ? (empty.textContent || '').trim() : null;
    })(),
    overlayRect: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
    title: (() => { const t = overlay.querySelector('h1,h2,h3,.usage-modal-title'); return t ? t.textContent.trim() : null; })(),
    hasLeftInsightPanel: has(['[data-usage-modal-insight]', '.usage-modal-insight', '.usage-trend-insight', '.usage-modal-side', '.usage-insight', '.usage-modal-left']),
    hasRightChart: has(['[data-usage-modal-chart]', '.usage-modal-chart', '.usage-trend-detail-chart', 'canvas', 'svg', '.usage-trend-modal-chart']),
    hasGranularityTabs: has(['[data-usage-granularity]', '.usage-modal-granularity', '.usage-granularity', '.usage-granularity-tabs', '.usage-modal-tabs', '[role="tablist"]']),
    granularityLabels,
    tabLabels: tabs.slice(0, 10),
    hasCloseButton: has(['[data-usage-modal-close]', '.usage-modal-close', '.usage-modal-x', 'button[aria-label*="关闭"]', 'button[aria-label*="Close"]', 'button[title*="关闭"]', 'button[title*="Close"]']),
    textLength: text.length,
    textSample: text.slice(0, 400)
  };
})()`;

const MODAL_STATE_SCRIPT = `(() => {${OVERLAY_HELPERS}
  const found = visibleOverlay();
  const trigger = document.querySelector('[data-usage-trend-expand], .usage-trend-expand, [data-usage-expand-trend]');
  const active = document.activeElement;
  return {
    open: Boolean(found),
    activeElement: active ? (active.tagName.toLowerCase() + (active.id ? '#' + active.id : '') + (typeof active.className === 'string' && active.className ? '.' + active.className.split(' ').filter(Boolean).join('.') : '')) : null,
    focusRestored: Boolean(trigger && active === trigger)
  };
})()`;

const MODAL_ESCAPE_SCRIPT = `(() => {
  const options = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
  document.dispatchEvent(new KeyboardEvent('keydown', options));
  window.dispatchEvent(new KeyboardEvent('keydown', options));
  return true;
})()`;

const MODAL_BACKDROP_SCRIPT = `(() => {${OVERLAY_HELPERS}
  const found = visibleOverlay();
  if (!found) return { ok: false, reason: 'not open' };
  found.el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  return { ok: true, selector: found.selector };
})()`;

const MODAL_CLOSE_BUTTON_SCRIPT = `(() => {${OVERLAY_HELPERS}
  const found = visibleOverlay();
  if (!found) return { ok: false, reason: 'not open' };
  const overlay = found.el;
  const selectors = ['[data-usage-modal-close]', '.usage-modal-close', '.usage-modal-x', 'button[aria-label*="关闭"]', 'button[aria-label*="Close"]', 'button[title*="关闭"]', 'button[title*="Close"]'];
  for (const selector of selectors) {
    const button = overlay.querySelector(selector);
    if (button) { button.click(); return { ok: true, selector }; }
  }
  return { ok: false, reason: 'close button not found' };
})()`;

const HEATMAP_SCROLL_SCRIPT = `(() => {
  const selectors = ['[data-usage-heatmap-scroll]', '.usage-heatmap-scroll', '.usage-heatmap-scroller', '.usage-heatmap-track'];
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const canScroll = el.scrollWidth > el.clientWidth + 1;
    const before = { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: el.scrollLeft };
    el.scrollLeft = el.scrollWidth;
    el.dispatchEvent(new Event('scroll', { bubbles: true }));
    return {
      ok: true,
      selector,
      canScroll,
      before,
      after: { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollLeft: Math.round(el.scrollLeft) },
      maxScrollLeft: Math.max(0, el.scrollWidth - el.clientWidth),
      scrolledToNewest: el.scrollLeft >= el.scrollWidth - el.clientWidth - 2
    };
  }
  return { ok: false, reason: 'heatmap scroller not found', candidates: selectors.map((selector) => ({ selector, count: document.querySelectorAll(selector).length })) };
})()`;

const HEATMAP_SCROLL_STATE_SCRIPT = `(() => {
  const el = document.querySelector('[data-usage-heatmap-scroll], .usage-heatmap-scroll, .usage-heatmap-scroller, .usage-heatmap-track');
  if (!el) return { ok: false, reason: 'heatmap scroller not found' };
  return {
    ok: true,
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollLeft: Math.round(el.scrollLeft),
    maxScrollLeft: Math.max(0, el.scrollWidth - el.clientWidth),
    scrolledToNewest: el.scrollLeft >= el.scrollWidth - el.clientWidth - 2
  };
})()`;

const MODAL_GRANULARITY_CLICK_SCRIPT = `(() => {
  const overlay = document.querySelector('[data-usage-trend-modal]') || document.querySelector('[role="dialog"]');
  if (!overlay) return { ok: false, reason: 'modal not open' };
  try {
    if (!window.__qaHourlyWrapperInstalled && window.electronAPI && typeof window.electronAPI.usageHourly === 'function') {
      window.__qaHourlyWrapperInstalled = true;
      const originalHourly = window.electronAPI.usageHourly;
      window.electronAPI.usageHourly = async function (query) {
        try {
          const result = await originalHourly(query);
          window.__qaHourlySeen = {
            query: query || null,
            rows: result && Array.isArray(result.rows) ? result.rows.length : null,
            resultKeys: result && typeof result === 'object' ? Object.keys(result) : null,
            firstRow: result && Array.isArray(result.rows) && result.rows[0] ? Object.keys(result.rows[0]) : null
          };
          return result;
        } catch (error) {
          window.__qaHourlySeen = { query: query || null, error: error && error.message ? error.message : String(error) };
          throw error;
        }
      };
    }
  } catch (_error) {}
  try {
    if (!window.__qaChartWrapperInstalled && typeof usageModalChartHtml === 'function') {
      window.__qaChartWrapperInstalled = true;
      window.__qaChartCalls = [];
      const original = usageModalChartHtml;
      window.usageModalChartHtml = function (series, emptyKey) {
        try {
          window.__qaChartCalls.push({ length: Array.isArray(series) ? series.length : null, emptyKey: emptyKey || null, at: Date.now() });
        } catch (_error) {}
        return original.apply(this, arguments);
      };
    }
  } catch (_error) {}
  const button = overlay.querySelector('[data-usage-granularity="' + (window.__qaGranularity || 'day') + '"]');
  if (!button) return { ok: false, reason: 'granularity button not found', target: window.__qaGranularity };
  button.click();
  return { ok: true, target: window.__qaGranularity, active: button.getAttribute('aria-selected') };
})()`;

const MODAL_GRANULARITY_STATE_SCRIPT = `(async () => {
  const overlay = document.querySelector('[data-usage-trend-modal]') || document.querySelector('[role="dialog"]');
  if (!overlay) return { ok: false, reason: 'modal not open' };
  const chart = overlay.querySelector('[data-usage-modal-chart]');
  const tabs = Array.from(overlay.querySelectorAll('[data-usage-granularity]')).map((button) => ({
    id: button.getAttribute('data-usage-granularity'),
    active: button.getAttribute('aria-selected') === 'true' || button.classList.contains('is-active'),
    label: (button.textContent || '').trim()
  }));
  const empty = chart ? chart.querySelector('.usage-modal-empty') : null;
  let hourlyDebug = null;
  try {
    const today = new Date().toISOString().slice(0, 10);
    const hourly = await window.electronAPI.usageHourly({ day: today });
    hourlyDebug = {
      apiType: typeof window.electronAPI.usageHourly,
      hasOptionalHelper: typeof window.usageHasOptionalApi === 'function' ? window.usageHasOptionalApi('usageHourly') : null,
      rows: hourly && Array.isArray(hourly.rows) ? hourly.rows.length : null
    };
  } catch (error) {
    hourlyDebug = { error: error && error.message ? error.message : String(error) };
  }
  hourlyDebug.mockCalls = window.__usagePreviewHourlyDebug || null;
  hourlyDebug.chartCalls = window.__qaChartCalls || null;
  hourlyDebug.hourlySeenByPage = window.__qaHourlySeen || null;
  hourlyDebug.dashboardSummaryTo = (() => {
    try { return typeof usageDashboardPayload !== 'undefined' && usageDashboardPayload && usageDashboardPayload.summary ? usageDashboardPayload.summary.to : null; } catch (_error) { return 'unavailable'; }
  })();
  hourlyDebug.modalDay = (() => {
    try { return typeof usageModalDay === 'function' && typeof usageDashboardPayload !== 'undefined' ? usageModalDay(usageDashboardPayload) : null; } catch (_error) { return 'error'; }
  })();
  const columns = chart ? chart.querySelectorAll('.usage-modal-col, [data-usage-modal-col], .usage-trend-col').length : null;
  return {
    ok: true,
    tabs,
    activeGranularity: (tabs.find((tab) => tab.active) || {}).id || null,
    chartText: chart ? (chart.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : null,
    emptyText: empty ? (empty.textContent || '').replace(/\s+/g, ' ').trim() : null,
    emptyVisible: Boolean(empty && empty.getBoundingClientRect().height > 0),
    chartColumns: Number(columns) || 0,
    hourlyDebug,
    chartHtmlLength: chart ? chart.innerHTML.length : null,
    axisText: (() => { const axis = overlay.querySelector('[data-usage-modal-axis]'); return axis ? (axis.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : null; })()
  };
})()`;

async function captureModalGranularity(win, granularity) {
  await win.webContents.executeJavaScript(`window.__qaGranularity = ${JSON.stringify(granularity)}`, true);
  const click = await win.webContents.executeJavaScript(MODAL_GRANULARITY_CLICK_SCRIPT, true);
  await new Promise((resolve) => setTimeout(resolve, 900));
  await win.webContents.capturePage();
  try {
    win.webContents.invalidate();
  } catch (_error) {
    // ignore
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  const state = await win.webContents.executeJavaScript(MODAL_GRANULARITY_STATE_SCRIPT, true);
  const hourlyRows = state && state.hourlyDebug && state.hourlyDebug.hourlySeenByPage
    ? state.hourlyDebug.hourlySeenByPage.rows
    : null;
  const expectedColumns = typeof hourlyRows === "number" ? hourlyRows : null;
  const silentReferenceError = Boolean(
    granularity === "30m" && typeof hourlyRows === "number" && hourlyRows > 0 && (!state || state.chartColumns === 0 || state.emptyVisible),
  );
  return {
    granularity,
    click,
    state,
    hourlyRows,
    expectedColumns,
    chartColumnsMatchHourly: granularity === "30m" && typeof hourlyRows === "number" ? state.chartColumns === hourlyRows : null,
    silentReferenceError,
  };
}

const HEATMAP_ARROW_SCRIPT = `(async () => {
  const el = document.querySelector('[data-usage-heatmap-scroll], .usage-heatmap-scroll');
  if (!el) return { ok: false, reason: 'scroller not found' };
  const previous = el.querySelector('[data-usage-heat-scroll="-1"]') || document.querySelector('[data-usage-heat-scroll="-1"]');
  const next = el.querySelector('[data-usage-heat-scroll="1"]') || document.querySelector('[data-usage-heat-scroll="1"]');
  if (!previous || !next) return { ok: false, reason: 'arrow buttons not found' };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Hidden windows do not tick smooth-scroll animations; emulate reduced motion
  // so the page's arrow handler uses instant scrolling (its own branch).
  const originalMatchMedia = window.matchMedia;
  try {
    window.matchMedia = function (query) {
      if (typeof query === 'string' && query.indexOf('prefers-reduced-motion') >= 0) {
        return { matches: true, media: query, addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {}, removeListener: function () {} };
      }
      return originalMatchMedia.call(window, query);
    };
  } catch (_error) {}
  el.scrollLeft = 0;
  await wait(120);
  const start = Math.round(el.scrollLeft);
  next.click();
  await wait(420);
  const afterNext = Math.round(el.scrollLeft);
  previous.click();
  await wait(420);
  const afterPrev = Math.round(el.scrollLeft);
  try {
    window.matchMedia = originalMatchMedia;
  } catch (_error) {}
  const style = window.getComputedStyle(el);
  return {
    ok: true,
    hasPrevious: true,
    hasNext: true,
    start,
    afterNext,
    afterPrev,
    nextScrolls: afterNext > start,
    previousScrollsBack: afterPrev < afterNext,
    scrollbarWidth: style.scrollbarWidth || null,
    overflowX: style.overflowX
  };
})()`;

// Period-switch flicker probe (2026-10-22 feedback): after clicking another tab
// the page must never paint the full-page loading card and the previous
// dashboard must stay mounted (dimmed at most) until the new payload lands.
// Samples the DOM on every animation frame for the whole switch.
const SWITCH_PROBE_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const snapshot = () => {
    const page = document.querySelector('.usage-page');
    const view = document.getElementById('view');
    return {
      hasPage: !!page,
      state: page ? page.getAttribute('data-usage-state') : null,
      busy: page ? page.getAttribute('data-usage-busy') === 'true' : false,
      hasDashboard: !!(page && page.querySelector('.usage-dashboard')),
      cardCount: page ? page.querySelectorAll('.usage-dashboard > .usage-card').length : 0,
      loadingCard: !!document.querySelector('.usage-loading'),
      period: (() => {
        const el = page && page.querySelector('[data-usage-view]');
        return el ? el.getAttribute('data-usage-view') : null;
      })(),
      scrollTop: view ? view.scrollTop : null,
      emptyCards: page ? page.querySelectorAll('.usage-dashboard > .usage-card:empty').length : 0,
    };
  };
  const target = Array.from(document.querySelectorAll('[data-usage-tab]')).find(
    (button) => button.getAttribute('data-usage-tab') !== 'month' && button.getAttribute('aria-selected') !== 'true',
  );
  if (!target) return { ok: false, reason: 'no other period tab found' };
  const periodBefore = snapshot();
  const samples = [];
  let frames = 0;
  target.click();
  // Sample ~40 frames or until the new period is painted.
  while (frames < 40) {
    samples.push(snapshot());
    if (samples[samples.length - 1].period && samples[samples.length - 1].period !== periodBefore.period && !samples[samples.length - 1].busy) break;
    await frame();
    frames += 1;
  }
  await wait(220);
  const after = snapshot();
  const sawLoadingCard = samples.some((sample) => sample.loadingCard);
  const sawMissingDashboard = samples.some((sample) => sample.hasPage && !sample.hasDashboard);
  const sawZeroCards = samples.some((sample) => sample.hasPage && sample.hasDashboard && sample.cardCount === 0);
  const sawLoadingState = samples.some((sample) => sample.state === 'loading');
  return {
    ok: !sawLoadingCard && !sawMissingDashboard && !sawZeroCards && !sawLoadingState,
    periodBefore: periodBefore.period,
    periodAfter: after.period,
    requested: target.getAttribute('data-usage-tab'),
    framesSampled: samples.length,
    sawLoadingCard,
    sawLoadingState,
    sawMissingDashboard,
    sawZeroCards,
    sawBusy: samples.some((sample) => sample.busy),
    scrollTopBefore: periodBefore.scrollTop,
    scrollTopAfter: after.scrollTop,
    cardsBefore: periodBefore.cardCount,
    cardsAfter: after.cardCount,
  };
})()`;

// Focus + scroll hand-off across the same kind of in-place swap (filter chips
// keep the period, so the content height — and therefore the scroll offset — is
// directly comparable).
const CONTROL_STATE_PROBE_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const view = document.getElementById('view');
  if (!view) return { ok: false, reason: 'no #view' };
  // The preview lets the document grow; force the app's real scrolling shape.
  view.style.overflow = 'auto';
  view.style.height = '380px';
  view.style.flex = '0 0 380px';
  await wait(120);
  const chip = document.querySelector('[data-usage-source-filter="codex"]');
  if (!chip) return { ok: false, reason: 'no filter chip' };
  const readTotal = () => (document.querySelector('#usageTotal') || {}).textContent || '';
  const baselineTotal = readTotal();
  // Focus first (focus() legitimately scrolls the chip into view), then scroll:
  // the captured offset must survive the in-place swap exactly.
  chip.focus();
  await frame();
  view.scrollTop = 220;
  await frame();
  await frame();
  const scrolled = view.scrollTop;
  chip.click();
  await wait(420);
  const afterFilter = {
    scrollTop: view.scrollTop,
    max: Math.max(0, view.scrollHeight - view.clientHeight),
    total: readTotal(),
    focused: document.activeElement ? document.activeElement.getAttribute('data-usage-source-filter') : null,
    active: (window.__usagePreviewActiveFilters ? window.__usagePreviewActiveFilters() : []),
  };
  // Clearing the filter must restore the unfiltered totals, so "no chip" really
  // is the "all tools" state (requirement: click again to deselect).
  const all = document.querySelector('[data-usage-source-filter="all"]');
  if (all) all.click();
  await wait(420);
  const afterReset = {
    scrollTop: view.scrollTop,
    total: readTotal(),
    active: (window.__usagePreviewActiveFilters ? window.__usagePreviewActiveFilters() : []),
  };
  return {
    ok:
      scrolled > 0 &&
      afterFilter.scrollTop === scrolled &&
      afterFilter.focused === 'codex' &&
      afterFilter.total !== baselineTotal &&
      afterReset.total === baselineTotal &&
      afterReset.active.length === 1 &&
      afterReset.active[0] === 'all',
    baselineTotal,
    scrolled,
    afterFilter,
    afterReset,
  };
})()`;

async function runModalCloseTests(win) {
  const results = [];
  const paths = [
    { path: 'escape', closeScript: MODAL_ESCAPE_SCRIPT },
    { path: 'backdrop', closeScript: MODAL_BACKDROP_SCRIPT },
    { path: 'close-button', closeScript: MODAL_CLOSE_BUTTON_SCRIPT }
  ];
  for (const entry of paths) {
    const reopen = await win.webContents.executeJavaScript(MODAL_OPEN_SCRIPT, true);
    await new Promise((resolve) => setTimeout(resolve, 220));
    const opened = await win.webContents.executeJavaScript(MODAL_STATE_SCRIPT, true);
    let closeAttempt = null;
    try {
      closeAttempt = await win.webContents.executeJavaScript(entry.closeScript, true);
    } catch (error) {
      closeAttempt = { ok: false, error: error && error.message ? error.message : String(error) };
    }
    await new Promise((resolve) => setTimeout(resolve, 240));
    const state = await win.webContents.executeJavaScript(MODAL_STATE_SCRIPT, true);
    results.push({
      path: entry.path,
      reopenOk: Boolean(reopen && reopen.ok),
      opened: Boolean(opened && opened.open),
      closeAttempt,
      closed: Boolean(state && !state.open),
      focusRestored: Boolean(state && state.focusRestored),
      activeElement: state ? state.activeElement : null
    });
  }
  return results;
}

async function captureVariant({ previewPath, opts, target, theme }) {
  const pageMode = target.kind === "page";
  const query = {
    theme,
    period: opts.period,
    lang: opts.lang,
    ...(opts.compact ? { compact: "1" } : {}),
    ...(opts.hourlyEmpty ? { emptyHourly: "1" } : {}),
    ...(opts.sources ? { filter: opts.sources.join(",") } : {}),
  };
  const initialWidth = pageMode ? Math.round(target.width + SIDEBAR_WIDTH + VIEW_PADDING + 20) : target.width;
  const win = new BrowserWindow({
    show: false,
    width: initialWidth,
    height: 900,
    useContentSize: true,
    backgroundColor: theme === "dark" ? "#121110" : "#eeebe4",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });
  const consoleCapture = attachConsoleCapture(win);
  const loadFailures = [];
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    loadFailures.push(`${errorCode} ${errorDescription} ${validatedURL}`);
  });

  const variant = {
    mode: pageMode ? "page-width" : "window-width",
    targetWidth: target.width,
    theme,
    tooltip: opts.tooltip,
    file: null,
    pixels: null,
    bytes: null,
  };
  try {
    await win.loadFile(previewPath, { query });
    await waitForReady(win, opts.timeoutMs);
    // Post-load chip clicks: exercises the page's real filter handler instead of
    // a pre-baked query, so a capture proves the interaction actually filters.
    let filterClickInfo = null;
    if (Array.isArray(opts.filterClick) && opts.filterClick.length > 0) {
      filterClickInfo = { sequence: [], ok: true };
      for (const chip of opts.filterClick) {
        const before = await win.webContents.executeJavaScript("window.__usagePreviewActiveFilters ? window.__usagePreviewActiveFilters() : null", true);
        const applied = await win.webContents.executeJavaScript(
          `window.__usagePreviewApplyFilter ? window.__usagePreviewApplyFilter(${JSON.stringify([chip])}) : null`,
          true,
        );
        const totals = await win.webContents.executeJavaScript(
          "(() => { const el = document.querySelector('#usageTotal'); return el ? el.textContent.trim() : null; })()",
          true,
        );
        filterClickInfo.sequence.push({ chip, before, applied, totalsText: totals });
      }
      // Repaint so the freshly swapped dashboard is what capturePage() sees.
      await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))", true);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    const stats = await win.webContents.executeJavaScript("window.__usagePreviewStats || null", true);
    const pageErrors = await win.webContents.executeJavaScript("window.__usagePreviewErrors || []", true);

    if (pageMode) {
      // Pin the content-column max-width to the review width, then iterate the
      // window width until the measured `.usage-page` width hits the target
      // (+/-1px). This keeps the sidebar/titlebar real while making the content
      // column width a fixed, reportable number.
      await win.webContents.executeJavaScript(
        `(() => {
          const page = document.querySelector('.usage-page');
          if (page) page.style.maxWidth = '${Math.round(target.width)}px';
          return true;
        })()`,
        true,
      );
      let width = initialWidth;
      for (let iteration = 0; iteration < 6; iteration += 1) {
        const measurement = await win.webContents.executeJavaScript(measureScript, true);
        const measured = Number(measurement && measurement.pageWidth);
        const desiredHeight = Math.max(600, Math.min(opts.maxHeight, Math.ceil(Number(measurement && measurement.documentHeight) || 900)));
        const delta = Number.isFinite(measured) ? Math.round(target.width - measured) : 0;
        win.setContentSize(Math.max(400, width + delta), desiredHeight);
        await new Promise((resolve) => setTimeout(resolve, 160));
        width += delta;
        if (Math.abs(delta) <= 1 && iteration > 0) break;
      }
    } else {
      let height = await win.webContents.executeJavaScript(
        "Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)",
        true,
      );
      height = Math.max(600, Math.min(opts.maxHeight, Math.ceil(Number(height) || 0)));
      win.setContentSize(target.width, height);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }

    // Final settle + full-height resize after the last width change.
    const beforeFinal = await win.webContents.executeJavaScript(measureScript, true);
    const finalHeight = Math.max(600, Math.min(opts.maxHeight, Math.ceil(Number(beforeFinal && beforeFinal.documentHeight) || 900)));
    win.setContentSize(win.getContentSize()[0], finalHeight);
    await new Promise((resolve) => setTimeout(resolve, 180));
    let measurement = await win.webContents.executeJavaScript(measureScript, true);

    let tooltipInfo = null;
    if (opts.tooltip) {
      // Dispatch the page's real hover/focus handlers first.
      await win.webContents.executeJavaScript(tooltipScript, true);
      await new Promise((resolve) => setTimeout(resolve, 180));

      // Hidden BrowserWindows do not repaint post-load DOM mutations before
      // capturePage(). Verified workaround (page probe + our own runs):
      //   1) capturePage() once as a warm-up to force a frame,
      //   2) invalidate(),
      //   3) wait ~200 ms,
      //   4) capturePage() again -> the tooltip is present in the saved PNG.
      await win.webContents.capturePage();
      try {
        win.webContents.invalidate();
      } catch (_error) {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 220));

      measurement = await win.webContents.executeJavaScript(measureScript, true);
      tooltipInfo = await win.webContents.executeJavaScript(tooltipStateScript, true);
      try {
        win.webContents.invalidate();
      } catch (_error) {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }

    const layoutInfo = await win.webContents.executeJavaScript(layoutScript, true);
    if (opts.dumpDom) {
      process.stderr.write(
        `  [dom] ${JSON.stringify((layoutInfo && layoutInfo.cards ? layoutInfo.cards : []).map((card) => ({ id: card.id, cls: card.className, top: card.top, w: card.width, h: card.height, heading: card.heading })))}\n`,
      );
    }

    let modalInfo = null;
    let modalCloseTests = null;
    let heatmapScrollInfo = null;
    let switchInfo = null;
    let controlStateInfo = null;
    if (opts.switching) {
      // Run the probe last so the page still ends on the switched period.
      switchInfo = await win.webContents.executeJavaScript(SWITCH_PROBE_SCRIPT, true);
      controlStateInfo = await win.webContents.executeJavaScript(CONTROL_STATE_PROBE_SCRIPT, true);
      await new Promise((resolve) => setTimeout(resolve, 160));
    }
    if (opts.modal) {
      const openAttempt = await win.webContents.executeJavaScript(MODAL_OPEN_SCRIPT, true);
      await new Promise((resolve) => setTimeout(resolve, 260));
      const probe = await win.webContents.executeJavaScript(MODAL_PROBE_SCRIPT, true);
      // Same hidden-window repaint workaround as the tooltip capture.
      await win.webContents.capturePage();
      try {
        win.webContents.invalidate();
      } catch (_error) {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 220));
      const probeAfterPaint = await win.webContents.executeJavaScript(MODAL_PROBE_SCRIPT, true);
      modalInfo = { openAttempt, probe, probeAfterPaint, open: Boolean(probeAfterPaint && probeAfterPaint.open) };
      if (modalInfo.open && Array.isArray(opts.modalGranularities) && opts.modalGranularities.length > 0) {
        modalInfo.granularityCaptures = [];
        for (const granularity of opts.modalGranularities) {
          const capture = await captureModalGranularity(win, granularity);
          const suffix = `-modal-${granularity}${opts.hourlyEmpty ? "-empty" : ""}.png`;
          const targetFile = path.join(opts.out, `${opts.label}-${target.width}-${theme}${suffix}`);
          const granularityImage = await win.webContents.capturePage();
          fs.writeFileSync(targetFile, granularityImage.toPNG());
          capture.file = targetFile;
          capture.pixels = `${granularityImage.getSize().width}x${granularityImage.getSize().height}`;
          modalInfo.granularityCaptures.push(capture);
        }
      }
      measurement = await win.webContents.executeJavaScript(measureScript, true);
    } else if (opts.heatmapScroll) {
      const scrollAttempt = await win.webContents.executeJavaScript(HEATMAP_SCROLL_SCRIPT, true);
      await new Promise((resolve) => setTimeout(resolve, 260));
      await win.webContents.capturePage();
      try {
        win.webContents.invalidate();
      } catch (_error) {
        // ignore
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
      const afterPaint = await win.webContents.executeJavaScript(HEATMAP_SCROLL_STATE_SCRIPT, true);
      const arrowChecks = await win.webContents.executeJavaScript(HEATMAP_ARROW_SCRIPT, true);
      heatmapScrollInfo = { ...scrollAttempt, afterPaint, arrows: arrowChecks };
      measurement = await win.webContents.executeJavaScript(measureScript, true);
    }

    const image = await win.webContents.capturePage();
    // Granularity runs leave the modal on the last-clicked tab, so they must not
    // overwrite the default-granularity `-modal.png` capture.
    const modalSuffix = opts.modal
      ? (Array.isArray(opts.modalGranularities) && opts.modalGranularities.length > 0 ? "-modal-base" : "-modal")
      : null;
    const suffix = modalSuffix || (opts.heatmapScroll ? "-heatmap-scroll" : opts.tooltip ? "-tooltip" : "")
      + (Array.isArray(opts.filterClick) && opts.filterClick.length > 0 ? `-filter-${opts.filterClick.join("+")}` : "")
      + (Array.isArray(opts.sources) && opts.sources.length > 0 ? `-filter-${opts.sources.join("+")}` : "");
    const fileName = `${opts.label}-${target.width}-${theme}${suffix}.png`;
    const filePath = path.join(opts.out, fileName);
    const png = image.toPNG();
    fs.writeFileSync(filePath, png);
    const size = image.getSize();

    if (opts.modal) modalCloseTests = await runModalCloseTests(win);

    let heatmapCardFile = null;
    if (opts.heatmapScroll && layoutInfo && layoutInfo.rects && layoutInfo.rects.heatmap) {
      try {
        const rect = layoutInfo.rects.heatmap;
        const cardImage = await win.webContents.capturePage({
          x: Math.max(0, rect.left),
          y: Math.max(0, rect.top),
          width: Math.max(50, rect.width),
          height: Math.max(50, rect.height),
        });
        heatmapCardFile = path.join(opts.out, `${opts.label}-${target.width}-${theme}-heatmap-card.png`);
        fs.writeFileSync(heatmapCardFile, cardImage.toPNG());
      } catch (_error) {
        heatmapCardFile = null;
      }
    }
    const contentWidth = measurement && measurement.pageRect ? Math.round(measurement.pageRect.width) : null;
    const viewContentWidth = measurement && measurement.viewRect
      ? Math.round(Number(measurement.viewRect.width) - VIEW_PADDING)
      : null;
    Object.assign(variant, {
      file: filePath,
      pixels: `${size.width}x${size.height}`,
      bytes: png.length,
      windowContentWidth: size.width,
      measuredPageWidth: contentWidth,
      measuredViewContentWidth: viewContentWidth,
      measuredHeatmapDeadSpacePx: measurement ? measurement.heatmapDeadSpacePx : null,
      measuredHeatmapScrollClientWidth: measurement ? measurement.heatmapScrollClientWidth : null,
      measuredHeatmapScrollWidth: measurement ? measurement.heatmapScrollWidth : null,
      measuredHeatmapContentWidth: measurement ? measurement.heatmapContentWidth : null,
      measuredHeatmapLeftDeadSpacePx: measurement ? measurement.heatmapLeftDeadSpacePx : null,
      measuredHeatmapRightDeadSpacePx: measurement ? measurement.heatmapDeadSpacePx : null,
      measuredHeatmapMarginDeltaPx: measurement ? measurement.heatmapMarginDeltaPx : null,
      measuredCardRects: measurement ? measurement.cardRects : null,
      measuredTableMetrics: measurement ? measurement.tableMetrics : null,
      contentHeight: finalHeight,
      stats,
      tooltipInfo,
      measuredLayout: layoutInfo,
      modalInfo,
      modalCloseTests,
      heatmapScrollInfo,
      heatmapCardFile,
      filterClickInfo,
      switchInfo,
      controlStateInfo,
      // Read live (not from the bootstrap stats) so it reflects post-click state.
      filterInfo: await win.webContents
        .executeJavaScript(
          "(() => ({ active: window.__usagePreviewActiveFilters ? window.__usagePreviewActiveFilters() : null, chips: document.querySelectorAll('[data-usage-source-filter]').length }))()",
          true,
        )
        .catch(() => null),
      pageErrors,
      consoleErrors: consoleCapture.consoleErrors,
      consoleWarnings: consoleCapture.consoleWarnings,
      loadFailures,
      windowShown: win.isVisible(),
    });
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
  return variant;
}

async function main(opts) {
  fs.mkdirSync(opts.out, { recursive: true });

  let baseline = null;
  let previewPath = DEFAULT_PREVIEW;
  try {
    if (opts.fromGit) {
      baseline = prepareBaselineTree(opts);
      previewPath = baseline.previewPath;
    } else if (!fs.existsSync(DEFAULT_PREVIEW)) {
      throw new Error(`preview page not found: ${DEFAULT_PREVIEW}`);
    }
    if (!fs.existsSync(previewPath)) throw new Error(`preview page not found: ${previewPath}`);

    const targets = opts.pageWidths
      ? opts.pageWidths.map((width) => ({ kind: "page", width }))
      : opts.widths.map((width) => ({ kind: "window", width }));
    const command =
      "env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe --no-sandbox " +
      `scripts/usage-visual-preview.js ${scriptArgs().join(" ")}`;
    process.stdout.write(`$ ${command}\n`);
    process.stdout.write(`$ preview: ${previewPath}\n`);

    const variants = [];
    for (const theme of opts.themes) {
      for (const target of targets) {
        const variant = await captureVariant({ previewPath, opts, target, theme });
        variants.push(variant);
        const errorCount = (variant.pageErrors || []).length + (variant.consoleErrors || []).length + (variant.loadFailures || []).length;
        const tooltipNote = opts.tooltip
          ? variant.tooltipInfo && variant.tooltipInfo.ok
            ? ` tooltip=${variant.tooltipInfo.cellDay} insideCard=${variant.tooltipInfo.insideCard}`
            : ` tooltip=FAILED(${variant.tooltipInfo ? variant.tooltipInfo.reason : "?"})`
          : "";
        process.stdout.write(
          `  ${errorCount === 0 ? "ok  " : "ERR "} ${path.basename(variant.file)}  ${variant.pixels}  ${Math.round(variant.bytes / 1024)} KiB` +
            `  window=${variant.windowContentWidth}px viewContent=${variant.measuredViewContentWidth}px page=${variant.measuredPageWidth}px` +
            `  rows=${variant.stats ? variant.stats.dailyRows : "?"} heat=${variant.stats ? variant.stats.heatmapActiveCells ?? variant.stats.heatmapCells : "?"}` +
            `  heatDead=${variant.measuredHeatmapDeadSpacePx}px` +
            tooltipNote +
            (errorCount > 0 ? `  errors=${errorCount}` : "") +
            "\n",
        );
        for (const message of variant.pageErrors || []) process.stderr.write(`  pageerror: ${message}\n`);
        for (const message of variant.consoleErrors || []) process.stderr.write(`  console.error: ${message}\n`);
        for (const message of variant.loadFailures || []) process.stderr.write(`  load-failure: ${message}\n`);
        if ((variant.consoleWarnings || []).length > 0) {
          process.stdout.write(`       console warnings: ${variant.consoleWarnings.length}\n`);
        }
        if (variant.measuredLayout) {
          const checks = variant.measuredLayout.checks || {};
          const rows = (variant.measuredLayout.rows || []).map((row) => `${row.count}@${row.top}`).join(",");
          process.stdout.write(
            `       layout rows=${variant.measuredLayout.rows.length} [${rows}] maxDeadBand=${variant.measuredLayout.maxDeadBandPx}px ` +
              `heatmapFirst=${checks.heatmapBeforeTrend} row1Eq=${checks.row1EqualHeights} row2Eq=${checks.row2EqualHeights} ` +
              `tokenNotFull=${checks.tokenCardNotFullWidth} integratedKpis=${checks.integratedCardHasKpis} ` +
              `integratedModels=${checks.integratedCardHasModelRows} integratedFooter=${checks.integratedCardHasFooter} dailyFull=${checks.dailyFullWidth}\n`,
          );
        }
        if (variant.modalInfo) {
          const probe = variant.modalInfo.probeAfterPaint || variant.modalInfo.probe || {};
          const closes = (variant.modalCloseTests || []).map((entry) => `${entry.path}:${entry.opened && entry.closed ? "ok" : "FAIL"}${entry.focusRestored ? "+focus" : ""}`).join(",");
          process.stdout.write(
            `       modal open=${variant.modalInfo.open} overlay=${probe.overlaySelector || "?"} defaultGranularity=${probe.activeGranularity} columns=${probe.chartColumns} ` +
              `empty=${JSON.stringify(probe.chartEmptyText)} insight=${probe.hasLeftInsightPanel} chart=${probe.hasRightChart} ` +
              `tabs=${probe.hasGranularityTabs} labels=${JSON.stringify(probe.granularityLabels || [])} closeBtn=${probe.hasCloseButton} closes=[${closes}]\n`,
          );
          for (const capture of variant.modalInfo.granularityCaptures || []) {
            const state = capture.state || {};
            process.stdout.write(
              `       modal-granularity ${capture.granularity}: active=${state.activeGranularity} columns=${state.chartColumns} ` +
                `hourlyRows=${capture.hourlyRows} match=${capture.chartColumnsMatchHourly} silentRefError=${capture.silentReferenceError} ` +
                `empty=${JSON.stringify(state.emptyText)} file=${path.basename(capture.file || "")}\n`,
            );
          }
        }
        if (variant.heatmapScrollInfo) {
          const info = variant.heatmapScrollInfo;
          process.stdout.write(
            `       heatmap-scroll selector=${info.selector || "?"} canScroll=${info.canScroll} scrollWidth=${info.before && info.before.scrollWidth} clientWidth=${info.before && info.before.clientWidth} ` +
              `scrollLeft=${info.after && info.after.scrollLeft} max=${info.maxScrollLeft} newest=${info.scrolledToNewest} ` +
              `arrows=${info.arrows && info.arrows.ok ? `next=${info.arrows.nextScrolls} prev=${info.arrows.previousScrollsBack}` : "missing"}\n`,
          );
        }
      }
    }

    const windowsOpen = BrowserWindow.getAllWindows().length;
    const report = {
      mode: opts.fromGit ? "baseline-from-git" : "working-tree",
      sizing: opts.pageWidths ? "page-width" : "window-width",
      fromGit: opts.fromGit,
      preview: previewPath,
      out: opts.out,
      period: opts.period,
      lang: opts.lang,
      compact: opts.compact,
      tooltip: opts.tooltip,
      modal: opts.modal,
      modalGranularities: opts.modalGranularities,
      hourlyEmpty: opts.hourlyEmpty,
      heatmapScroll: opts.heatmapScroll,
      variants,
      windowsOpenAtEnd: windowsOpen,
      visibleWindows: variants.filter((variant) => variant.windowShown === true).length,
      ok:
        variants.every(
          (variant) =>
            (variant.pageErrors || []).length === 0 &&
            (variant.consoleErrors || []).length === 0 &&
            (variant.loadFailures || []).length === 0 &&
            (!opts.tooltip || (variant.tooltipInfo && variant.tooltipInfo.ok)),
        ) &&
        (!opts.modal ||
          variants.every(
            (variant) =>
              variant.modalInfo &&
              variant.modalInfo.open &&
              Array.isArray(variant.modalCloseTests) &&
              variant.modalCloseTests.every((entry) => entry.opened && entry.closed && entry.focusRestored),
          )) &&
        (!opts.heatmapScroll ||
          variants.every(
            (variant) =>
              variant.heatmapScrollInfo &&
              variant.heatmapScrollInfo.ok &&
              variant.heatmapScrollInfo.canScroll &&
              variant.heatmapScrollInfo.scrolledToNewest,
          )) &&
        (!opts.switching || (variants.every((variant) => variant.switchInfo && variant.switchInfo.ok && variant.controlStateInfo && variant.controlStateInfo.ok))) &&
        (!Array.isArray(opts.modalGranularities) || opts.modalGranularities.length === 0 ||
          variants.every((variant) => {
            const captures = (variant.modalInfo && variant.modalInfo.granularityCaptures) || [];
            if (captures.length === 0) return false;
            return captures.every((capture) => {
              if (opts.hourlyEmpty) {
                const state = capture.state || {};
                return Boolean(state.emptyText) && Number(state.chartColumns) === 0;
              }
              if (capture.granularity === "30m") {
                return capture.hourlyRows > 0 && Boolean(capture.chartColumnsMatchHourly) && !capture.silentReferenceError;
              }
              return Boolean(capture.state && capture.state.ok);
            });
          })),
    };
    process.stdout.write("\n");
    process.stdout.write(
      `captures: ${variants.length}; pageerrors: ${variants.reduce((n, v) => n + (v.pageErrors || []).length, 0)}; ` +
        `console errors: ${variants.reduce((n, v) => n + (v.consoleErrors || []).length, 0)}; ` +
        `visible windows: ${report.visibleWindows}` +
        (opts.tooltip
          ? `; tooltip inside card: ${variants.filter((v) => v.tooltipInfo && v.tooltipInfo.ok && v.tooltipInfo.insideCard).length}/${variants.length}`
          : "") +
        "\n",
    );
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(report)}\n`);
    return report.ok ? 0 : 2;
  } finally {
    if (baseline) baseline.cleanup();
  }
}

// Must run before app is ready.
const EARLY_OPTS = (() => {
  try {
    return parseArgs(scriptArgs());
  } catch (error) {
    process.stderr.write(`error: ${error && error.message ? error.message : String(error)}\n`);
    process.exit(2);
  }
})();
fs.mkdirSync(EARLY_OPTS.out, { recursive: true });
const USER_DATA_DIR = path.join(EARLY_OPTS.out, "user-data");
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
app.setPath("userData", USER_DATA_DIR);
// Capturing destroys each hidden window before the next variant; keep the app
// alive instead of letting Electron quit when the last window closes.
app.on("window-all-closed", () => {});
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("force-device-scale-factor", "1");

app.whenReady()
  .then(() => main(EARLY_OPTS))
  .then((code) => app.exit(code))
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : String(error)}\n`);
    app.exit(1);
  });
