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
    else if (arg === "--compact") opts.compact = true;
    else if (arg === "--tooltip") opts.tooltip = true;
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
  const heatScroll = document.querySelector('[data-usage-heatmap-scroll]');
  const heatGrid = document.querySelector('.usage-heatmap-grid');
  const heatCells = heatGrid ? Array.from(heatGrid.querySelectorAll('.usage-heat-cell')) : [];
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

async function captureVariant({ previewPath, opts, target, theme }) {
  const pageMode = target.kind === "page";
  const query = {
    theme,
    period: opts.period,
    lang: opts.lang,
    ...(opts.compact ? { compact: "1" } : {}),
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

    const image = await win.webContents.capturePage();
    const suffix = opts.tooltip ? "-tooltip" : "";
    const fileName = `${opts.label}-${target.width}-${theme}${suffix}.png`;
    const filePath = path.join(opts.out, fileName);
    const png = image.toPNG();
    fs.writeFileSync(filePath, png);
    const size = image.getSize();
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
      variants,
      windowsOpenAtEnd: windowsOpen,
      visibleWindows: variants.filter((variant) => variant.windowShown === true).length,
      ok: variants.every(
        (variant) =>
          (variant.pageErrors || []).length === 0 &&
          (variant.consoleErrors || []).length === 0 &&
          (variant.loadFailures || []).length === 0 &&
          (!opts.tooltip || (variant.tooltipInfo && variant.tooltipInfo.ok)),
      ),
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
