# Usage page visual-review harness (dev-only)

Headless screenshot harness for the AI usage page. It renders a **static copy of
the settings-window shell** (sidebar + titlebar) with the **real**
`shared/tokens.css`, `config/config.css` and `config/routes/usage.js`, and fakes
`window.electronAPI` with dense deterministic `usage:*` payloads. No visible
window is ever created (`BrowserWindow({show:false})`, `capturePage()` only), so
it is safe to run in agent/CI shells and on the user's machine.

`design-demos/` is not part of `electron-builder` `build.files`, so neither the
preview page nor this harness ships.

## Files

| Path | Purpose |
|---|---|
| `design-demos/usage-page-preview.html` | preview document: static shell, mock `electronAPI`, real route script/CSS, `window.__usagePreviewReady` handshake. Query params: `theme=light\|dark`, `period=day\|week\|month\|total`, `lang=zh-CN\|zh-TW\|en-US`, `compact=1`. |
| `scripts/usage-visual-preview.js` | Electron main script: hidden window per variant, waits for the page, auto-sizes to full document height, writes PNGs, reports console/page errors. |
| `.tmp/usage-preview/` | captures (gitignored). |

## Run

From the repo root. The agent shell exports `ELECTRON_RUN_AS_NODE=1` and cannot
start Chromium's own sandbox, so both workarounds are needed there (a normal dev
shell needs neither):

```bash
# current working tree (after the redesign)
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
  --no-sandbox scripts/usage-visual-preview.js \
  --out .tmp/usage-preview --widths 1180,1440 --themes light,dark --label after

# pre-redesign baseline, built from committed files only (git show of the
# page/CSS/helpers into a temp tree, so uncommitted redesign work cannot leak in)
env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe \
  --no-sandbox scripts/usage-visual-preview.js \
  --from-git HEAD --label before --out .tmp/usage-preview \
  --widths 1180,1440 --themes light,dark
```

Outputs `<out>/<label>-<width>-<theme>.png`; each capture is a full-page shot
(the hidden window is resized to the measured document scroll height). The last
stdout line is `HIGHLIGHTER_USAGE_PREVIEW={...}` with per-variant pixel size,
console/page errors and the DOM stats (KPI cards, source cards, model rows,
trend columns, daily rows, heatmap cells, hourly bars).

Exit codes: `0` = every variant captured with zero pageerror / console-error /
load-failure; `2` = captures were written but at least one variant had an error
(see stderr and the JSON `variants[].pageErrors/consoleErrors`); `1` = harness
failure.

## Options

```
--out <dir>        output directory (default .tmp/usage-preview)
--widths a,b       window content widths (default 1180,1440)
--themes a,b       light|dark (default light,dark)
--label <name>     file prefix (default usage; baseline uses "before")
--period <p>       day|week|month|total (default month)
--lang <lang>      zh-CN|zh-TW|en-US (default zh-CN)
--page-widths a,b  target .usage-page content widths (mutually exclusive with --widths)
--tooltip          open the heatmap tooltip before capture (file suffix -tooltip)
--compact          add body.compact (dense shell variant)
--from-git <ref>   load page/CSS/helpers from <ref> (baseline mode)
--max-height <px>  clamp for the full-page capture (default 6000)
--timeout <ms>     per-variant render timeout (default 30000)
--keep-harness     keep the generated --from-git preview tree
```

## Mock payload coverage

3 sources (codex/dsh/opencode `ok`, cursor/trae `unsupported`) × 8 models
(codex 3, dsh 2, opencode 3, sharing `deepseek-v4.1-flash`), 60 days of daily
rows (30 shown in the month view, 7 in week, 1 in day), a 52-week Monday-first
heatmap with max-relative levels **and per-cell `models` maps**, 24 hourly rows,
rolling 7d/30d + active-day KPIs and matching summary/daily/breakdown totals.
Values are seeded (deterministic for a given day) so before/after shots are
comparable.

## Baseline reference (2026-10-21, pre-redesign, `--from-git HEAD`)

Fixed content-width shots and measured geometry (all zero pageerrors/console
errors/visible windows; pixel-deterministic across runs):

| file | pixels | window | view content | `.usage-page` | heatmap content | heatmap dead space (right) |
|---|---|---|---|---|---|---|
| `before-908-light.png` / `-dark` | 1200x2167 | 1200 | 918 | **908** | 622 | **248 px** |
| `before-1180-light.png` / `-dark` | 1472x1908 | 1472 | 1190 | **1180** | 622 | **520 px** |
| `before-1440-light.png` / `-dark` | 1732x1908 | 1732 | 1450 | **1440** | 622 | **780 px** |
| `before-1180-light-tooltip.png` / `-dark-tooltip` | 1472x1908 | 1472 | 1190 | 1180 | — | tooltip on 2026-10-19, `insideCard:true` (old design has no per-model rows) |

The old heatmap uses fixed 10px cells (622px of content) inside a full-width
card, hence the dead space — the 248px at the default-like 908 column is the
quirk the redesign targets. A plain `--widths 1180` window measures
`.usage-page` = **898** because of the ~10px scrollbar gutter (that is why the
review uses `--page-widths`).

## Round-2 modes (grid redesign + trend modal)

The harness also supports the round-2 layout review:

```bash
# full page at fixed content widths
... --page-widths 908,1180,1440 --themes light,dark --label round2

# trend detail modal: clicks the page's real [data-usage-trend-expand] button,
# waits for the overlay, captures it, then verifies Esc / backdrop / X close
# paths and focus restore to the trigger
... --page-widths 1180 --themes light,dark --label round2 --modal

# heatmap tooltip (kept from round 1)
... --page-widths 1180 --themes light,dark --label round2 --tooltip

# heatmap compact-scroller state: scrolls the strip to the newest week, captures
# the page plus a cropped heatmap-card PNG, and records scrollWidth/clientWidth/
# scrollLeft/maxScrollLeft/scrolledToNewest
... --page-widths 1180 --themes light,dark --label round2 --heatmap-scroll
```

Use `--dump-dom` to print the detected top-level card list (classes/ids/geometry)
when the page markup changes. Every capture also reports `measuredLayout`:
row grouping, card rects, equal-height deltas, dead-band widths, and the
`heatmapBeforeTrend` / `row1EqualHeights` / `row2EqualHeights` /
`tokenCardNotFullWidth` / `integratedCardHasKpis` / `integratedCardHasModelRows`
/ `integratedCardHasFooter` / `dailyFullWidth` checks.
