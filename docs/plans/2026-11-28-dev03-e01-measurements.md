# DEV-03 / E01 measurement record (2026-11-28)

Source tickets: `docs/plans/2026-11-28-review-optimization-follow-up-tasks.md`
§4 DEV-03 (F06 capture window warm-up / SmartSelect lifecycle experiment) and
§6 E01 (attribute the timing failure to load, test or product).

Status: measurement complete; **no product code was modified** (the capture domain,
`capture/**` and `main.js` are untouched). The only new files are probes under
`scripts/` plus this record; all raw data is under `.tmp-work/experiment/`.

## 0. Host and environment

| Item | Value |
|---|---|
| OS / shell | Windows, PowerShell 7, Node v24.22.1 (repo `package.json` 5.1.1, commit `bae6264`) |
| CPU / RAM | 16 logical CPUs, 48.2 GiB |
| Displays | DISPLAY1 2560x1440 @150% (primary, the user's screen); DISPLAY2 1152x2048 @125% at (2560,-136) |
| Electron | 43.8.3 from `node_modules/electron` |
| Ambient load | shared host, other agents active throughout: `Processor(_Total)` 9-50% during the quiet runs, 100% in the intentional load experiment |
| Isolated data root | `PORTABLE_EXECUTABLE_DIR` + `Highlighter.location.json` -> `.tmp-work/experiment/dev03/data-root`; the installed app at `D:\Program Files\Highlighter` was never touched |

New measurement software (all read-only probes; no product hook):

* `scripts/measure-capture-pipeline.js` - launches THIS checkout's app against
  the isolated data root, parks the cursor on DISPLAY2 (re-verified with
  `screen.getDisplayNearestPoint` before every trigger), drives the real hotkey
  entry (`window.electronAPI.executeFunction('screenshot')` -> function-router ->
  `captureDomain.createCaptureWindow`) and observes one capture end to end from a
  main-process observer installed by the probe. It also reads the product's own
  `performanceMonitor` entries from the isolated data root's `logs/app.log`
  (`capture.started` / `capture.acquired` / `capture.interactive` /
  `capture.closed`) and joins them per capture id.
* `scripts/probe-smart-select-lifecycle.js` - drives the real
  `main/domains/capture/smart-select.js` session class against the real
  `native/smart-select/SmartSelect.exe`: spawn->ready, first/steady hit-test
  queries, idle residency, teardown.
* `scripts/probe-smart-select-staleness.js` - proves whether a long-lived
  SmartSelect session observes a window move (it does not; see 2.5).
* `scripts/measure-usage-query-latency.js` - E01 replica that prints p50 for every
  query view (the test itself only prints p95 and aborts on the first over-budget
  view under load).
* `scripts/run-perf-gate.js` - the E01 deliverable: repeatable isolated perf gate.

## 1. E01 - attribution of the `test/usage-query.test.js` timing failure

### 1.1 What the test asserts

`test/usage-query.test.js` builds a 100,000-row synthetic store (24 models x 3
sources over 24 months) and measures, for seven views, the p95 of 25 uncached
repeats after one warm-up. Budgets: summary 100 ms, daily 150 ms, breakdown 300 ms,
heatmap 100 ms, filtered summaryCodex 100 ms, dailyCodex 150 ms, heatmapCodex
100 ms. It also runs dense/plan/sparse heatmap fixtures with budgets 400/120/60 ms.

### 1.2 Solo, low-load runs pass with 2-3x margin

Command: `node --test test/usage-query.test.js` (TMP/TEMP under `.tmp-work`), three
consecutive runs while other agents were active (ambient CPU average 41.7%, max
60%, disk 2.6%). All three exit 0.

| Run | wall | summary | daily | breakdown | heatmap | summaryCodex | dailyCodex | heatmapCodex |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 | 14.4 s | 41.20 | 61.02 | 123.59 | 0.72 | 23.79 | 26.02 | 0.65 |
| 2 | 14.2 s | 45.48 | 50.92 | 112.77 | 0.74 | 20.12 | 24.56 | 0.67 |
| 3 | 14.2 s | 44.30 | 51.69 | 117.19 | 0.74 | 22.30 | 22.27 | 0.62 |

Heatmap fixtures, same runs (uncached p95 in ms): dense262k 111.2/128.3/138.6
(budget 400), plan88k 45.1/48.5/45.7 (budget 120), sparse5k 12.8/13.7/14.8
(budget 60); dense cached p95 = 0 (payload cache).

The handoff's "solo about 67 ms" is consistent with the daily p95 (51-63 ms) rather
than the summary p95 (41-45 ms); either way the margin is large. Replica p50, quiet
run (ambient CPU 32.7%): summary 40.2, daily 40.1, breakdown 128.8, summaryCodex
20.7, dailyCodex 20.6, heatmap* 0.44-0.70.

Best-effort quiet re-run at the end (ambient CPU 11.7%, quietest window of the
session), via the isolated gate twice, both exit 0: usage p95 pair 1 = summary
43.36 / daily 51.20 / breakdown 101.42 / heatmap 0.71 / summaryCodex 18.31 /
dailyCodex 20.56 / heatmapCodex 0.67; pair 2 = 39.39 / 58.10 / 100.69 / 0.71 /
18.14 / 22.71 / 0.64; dense262k p95 109.6/119.5, plan88k 52.2/46.4, sparse5k
11.8/11.7. Nothing changed between the loaded runs and these except host load.

### 1.3 Same workload under CPU saturation fails

Intentional concurrency: `burner.js` busy loops on all logical CPUs; the load sensor
confirms `Processor(_Total)` at 100% during the loaded runs. Five loaded runs:

| Run | hogs | wall | result | failure (from log) |
|---|---|---|---|---|
| A | 16 | 32.5 s | FAIL | `summary p95 169.56ms`; dense uncached p95 418.4 ms |
| B | 16 | 44.8 s | FAIL | `summary p95 177.43ms`; dense uncached p95 480.0 ms |
| C | 24 | 90.0 s | FAIL | `summary p95 392.86ms`; dense uncached p95 1025.5 ms |
| D | 24 | 36.9 s | FAIL | `summary p95 401.92ms` |
| E | 20 + 3 disk churners | 81.8 s | FAIL | `summary p95 407.71ms`; dense uncached p95 1248.5 ms |

The 16-hog range (169-178 ms) reproduces the handoff's historical "concurrent
110-180 ms"; heavier oversubscription pushes the same assertions to 390-408 ms. No
source changed between 1.2 and 1.3. (The first load attempt used a mis-quoted
`node -e` burner and never burned CPU; those `burn4/12/15` logs are discarded
artifacts, not results.)

Full per-view p50/p95 (replica): quiet vs 16 hogs (ambient CPU 100%):

| view | quiet p50 -> load p50 | quiet p95 -> load p95 | budget | load/quiet p95 |
|---|---:|---:|---:|---:|
| summary | 40.2 -> 98.5 | 58.9 -> 127.1 | 100 | 2.16x |
| daily | 40.1 -> 128.2 | 62.9 -> 172.5 | 150 | 2.74x |
| breakdown | 128.8 -> 280.6 | 141.8 -> 354.9 | 300 | 2.50x |
| heatmap | 0.47 -> 0.65 | 0.70 -> 0.82 | 100 | 1.17x |
| summaryCodex | 20.7 -> 44.9 | 22.3 -> 69.4 | 100 | 3.11x |
| dailyCodex | 20.6 -> 53.9 | 27.2 -> 100.5 | 150 | 3.70x |
| heatmapCodex | 0.44 -> 0.60 | 0.66 -> 1.06 | 100 | 1.61x |

Inserting the 100k rows also inflated from 843 ms (quiet) to 1744 ms (load), i.e.
the whole process is CPU-starved, not one SQL branch.

### 1.4 File-level test concurrency alone does not reproduce it

A targeted 15-file concurrent run (`node --test --test-concurrency=15` over
usage-query plus 14 other CPU-heavy unit files, no added burners) finished in 15.9 s
with exit 0 and usage p95 summary 47.4 / daily 64.7 / breakdown 122.7 - inside
budget. On a 16-logical-CPU host, 15 node test processes still fit the scheduler;
the full suite adds Electron probe children, native sidecars and memory/disk
pressure on top, which is why only `npm test` sees 110-180 ms.

### 1.5 Attribution

**Load-only.** Not the test and not the product:

* Test-side hypothesis ruled out: the same file, unchanged, passes 3/3 plus the
  gate 2/2 at low load with 2-3x margin; the measured work (SQLite scans over 100k
  rows) is what the plan asked to bound.
* Product-side hypothesis ruled out: p50 and p95 inflate together (2.2-3.7x), the
  insert phase inflates 2.1x, every view is affected, and the test disables the
  payload cache by design, so no cache-hit shape change is involved.
* Failure mode is CPU starvation: the single-threaded SQLite/JS folds' wall-clock
  p95 tracks scheduler delay when the host is oversubscribed - reproduced at 100%
  CPU with no source change.

### 1.6 The isolated, repeatable perf gate (E01 deliverable)

`scripts/run-perf-gate.js` runs the timing-sensitive files **one at a time** (never
concurrently with another test file), sanitises the known test-host traps
(`ELECTRON_RUN_AS_NODE` removed, TMP/TEMP/HIGHLIGHTER_E2E_DATA_ROOT_BASE redirected
under `.tmp-perf/`), parses the measured p95 maps, prints a human line per file and
one machine-readable `PERF_GATE_RESULT=<json>` line, writes an optional JSON report,
and exits non-zero on failure. Assertions and budgets are unchanged: `npm test`
still runs the same files once.

Verified twice on this host (usage includes `--sandbox-hook` only because this
confined host cannot start Chromium's sandbox; CI does not need it):

```
node scripts/run-perf-gate.js --sandbox-hook <checkout>/.tmp-work/hook/no-sandbox.js
perf gate: running test/usage-query.test.js ... PASS 15166ms summary p95=46.14ms
perf gate: running test/capture-first-paint.test.js ... PASS 1329ms
perf gate: OK (2 run(s), 1x) -> .tmp-work/experiment/e01/perf-gate.json
```

Usage: `node scripts/run-perf-gate.js [--repeat N] [--include-flake-check]
[--files a,b] [--out path] [--json-only]`.

**Exact wiring the root agent should apply (not edited by the experiment owner):**

`package.json` scripts block, after `"test": "node --test test/*.test.js"`:

```json
"test:perf": "node scripts/run-perf-gate.js",
```

`.github/workflows/windows-ci.yml`, `quality` ("Check and test") job, immediately
after the existing `- name: Run tests / run: npm test` step:

```yaml
      - name: Run isolated performance gate
        run: node scripts/run-perf-gate.js --out perf-gate.json
        timeout-minutes: 8

      - name: Upload performance gate result
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: perf-gate-result
          path: perf-gate.json
```

The full entry point is untouched: `npm test` keeps running
`test/usage-query.test.js` once with the original budgets, so coverage and the
"full suite still executes it" requirement are preserved; the new step adds a
serial low-noise measurement whose numbers are comparable across commits.

### 1.7 Known flake and first-paint, standalone

* `node --test test/clipboard-coordination.test.js` standalone x2: **PASS 2/2**,
  4/4 tests each time, wall 2.72 s / 2.70 s; the lease-round test ran in 110.7 ms
  and finished its 100 rounds. No `Lease round N` failure in this sample.
* `node --test test/capture-first-paint.test.js` standalone x2: **PASS 2/2**, test
  process wall 1.31 s / 1.65 s. Probe first-paint samples (600 ms threshold,
  `elapsedMs` from `capture:init` handling to the double-rAF paint before
  `render-ready`): run 1: 184.3 ms (800x600), 273.6 ms (900x600); run 2: 176.9 ms,
  274.6 ms. All under 600 ms with ~2.2x margin.

---

## 2. DEV-03 - capture warm-up / SmartSelect lifecycle baseline

### 2.1 What is measured and how

The product's own timing seams were used, not re-invented: every capture records
`capture.started`, `capture.acquired` (= captureMs), `capture.interactive`
(= trigger-to-`capture:render-ready` total plus `smartSelectMs` / `windowLoadMs` /
renderer pid) and `capture.closed` into `app.log`. The probe reads those back per
capture id and joins them with an independent observer:

```
trigger (hotkey IPC) -> BrowserWindow constructed -> dom-ready -> loadFile done
        -> renderer "capture:ready" -> renderer "capture:render-ready" (first
        operable frame; the product reveals the window here) -> closed
```

Memory: `app.getAppMetrics()` at the render-ready instant (Electron tree), plus a
read-only PowerShell process-tree sample keyed by the probe app's main pid (private
bytes, working set, CPU, per-process GPU dedicated/shared, per-role sidecars), plus
a 150 ms sidecar watcher for `SmartSelect.exe` lifetime/memory. CPU load is sampled
from `os.cpus()` deltas and reported per phase. All windows were created on
DISPLAY2; the probe verifies `screen.getDisplayNearestPoint` before every trigger
and asserts the product captured the expected display size.

"Cold" = first capture after the app sat idle; "hot" = repeated captures 500 ms
apart in the same session. Each app launch pays one discarded warm-up capture first
(the first-ever native capture helper compile costs ~500 ms and is a first-install
one-time cost, not a per-hotkey cost).

### 2.2 Candidate options

1. **(i) current on-demand** - measured directly through the real entry point.
2. **(ii) hidden-window pre-warm** - simulated by measuring, in the running app, the
   real cost of `new BrowserWindow(capture.html + preload) -> capture:ready`,
   `-> first operable frame after init`, and the incremental idle memory of keeping
   such a hidden window loaded. A full production prototype (reusing the window for
   a real capture) would require product edits, which this experiment forbids.
3. **(iii) reused SmartSelect session** - measured with the real session class and
   real sidecar: spawn->ready, first/steady target queries, idle residency,
   staleness after a real window move, teardown. The product today spawns one
   helper per region capture; reuse is a product change.

### 2.3 Adoption thresholds (written before the decision)

| Dimension | Threshold | Rationale |
|---|---|---|
| Minimum effective p95 improvement | hotkey->first-operable **hot p95 improves by >= 30 ms AND >= 12% on every measured capture-display configuration**, with the candidate's p95 outside the baseline run noise | window/renderer components measured at 30-100 ms; 30 ms/12% is the smallest change a user could feel and is above the observed spread |
| Acceptable idle memory | incremental **private bytes <= 48 MiB** and working set **<= 128 MiB** per resident instance, **<= 0.1% of one core** average CPU over the idle hold | host has 48 GiB but two resident copies would double the figure |
| Reclaim deadline | resources back to baseline **<= 500 ms after the capture window closes**; a kept-warm pool must expire by **<= 120 s idle**, max **1 resident instance** | bounds crash/lock-screen exposure |
| Cold path | cold first-operable p95 must not regress (<= baseline cold p95 + noise) | the report is about the first hotkey of a session |

### 2.4 Baseline (option i), two capture-display configurations

Run A (`capture-pipeline-secondary.json`, COMPLIANT): cursor held on DISPLAY2,
31 samples = 1 cold (after 60 s idle) + 30 hot; all 30/30 hot captures are
1152x2048 @125% (native backend); ambient CPU during sampling avg 19.4%, max
26.8%. Run B (`capture-pipeline-main.json`, also retained): the 10-minute idle run;
the user's mouse moved to the primary screen during the hold, so this dataset
measured the 2560x1440 @150% capture (29 hot samples, ambient CPU avg 14.6%) - it
is the more representative "user's main screen" case and the 10-minute idle memory
evidence comes from it.

| Metric (all from trigger) | A cold (n=1) | A hot p50 (n=30) | A hot p95 | B cold (n=1) | B hot p50 (n=29) | B hot p95 |
|---|---:|---:|---:|---:|---:|---:|
| window created | 73 | 76 | 82 | 89 | 77 | 82 |
| dom-ready | 164 | 168 | 181 | 191 | 165 | 183 |
| loadFile done (window loaded) | 174 | 177 | 190 | 191 | 176 | 184 |
| first operable frame (render-ready) | 194 | 197 | 212 | 301 | 285 | 315 |
| product `capture.acquired` (screen grab) | 152.1 | 147.8 | 170.8 | 252.7 | 238.2 | 269.8 |
| product `smartSelectMs` (helper spawn->ready) | 60.0 | 60.9 | 67.5 | 60.5 | 57.7 | 60.0 |
| product `windowLoadMs` (loadFile) | 96.5 | 97.0 | 103.2 | 97.2 | 94.2 | 97.4 |
| renderer: capture/window-ready -> first operable (derived) | 48.3 | 46.4 | ~48 | 48.3 | 46.4 | ~48 |
| app private at render-ready (whole tree) | - | 445 MiB | 454 MiB | - | 580 MiB | 658 MiB |
| app working set at render-ready | - | 600 MiB | 606 MiB | - | 754 MiB | 762 MiB |
| Electron processes at ready | - | 5 | 5 | - | 5 | 5 |

The first-operable frame is therefore: `max(captureMs, smartSelectMs + window
boot)` + renderer init+decode+paint (~46-48 ms). Two independent facts decide
where a warm-up could act:

* `captureMs` is the largest single component in both configurations (148 ms hot
  p50 / 238 ms hot p50 respectively; p95 171/270 ms). The two p95 outliers in each
  dataset are capture spikes (269.8/270.6 ms -> first-operable 315/316 ms), not
  window or renderer work.
* Window boot (create ~19 ms + `windowLoadMs` ~97 ms) happens in parallel with the
  screen grab; its tail from trigger is `smartSelectMs + window boot` = 158-162 ms
  (run A) / 152 ms (run B). Therefore a fully pre-warmed window (and/or an already
  spawned SmartSelect session) can only remove
  `max(capture, smartSelect + windowBoot) - max(capture, smartSelect[+0])` from the
  critical path. Measured per hot sample:

| Run | captureMs p50/p95 | saveable by prewarm or session-reuse (p50 / p95) | samples where capture is the tail |
|---|---:|---:|---:|
| A (DISPLAY2 1152x2048) | 147.8 / 170.8 | **30.8 / 41.6 ms** (19.6% of hot p95 212) | 0/30 |
| B (DISPLAY1 2560x1440@150%) | 238.2 / 269.8 | **0.0 / 0.0 ms** | 29/29 |

This is a component-derived estimate (an end-to-end prototype would need product
edits); it is labelled as such. It is the reason the option verdict below is
configuration-dependent rather than a blanket yes.

Cold after idle, both configurations: A 194 ms vs hot p95 212 ms, B 301 ms vs hot
p95 315 ms - **no reproducible cold penalty after 10 minutes of idle**. The only
large cold cost is the first-ever capture in a fresh install/temp root: the
discarded warm-up capture measured `captureMs` 310 ms (run B) and 697 ms in the
very first smoke run, because the native screenshot helper compiles its C# helper
once. That is a one-time install/first-use cost, not an idle-cold one.

Idle overhead of the current behaviour (run B, 10-minute hold, samples every 60 s):
4 Electron processes, private 417.9-419.1 MiB, working set 520.2-521.5 MiB, CPU
0.00-0.03% of one core, all flat; no SmartSelect/OCR helper resident (the app's
Everything sidecar exits during the idle hold). The Chrome/Electron GPU process
accounted for 267.8 of those private MiB (`gpuDedicatedMiB` 173.1, shared 0.35 at
the end of idle; baseline tree 102.3 dedicated / 6.8 shared at first window, after
the capture samples 237.5 dedicated / 44.0 shared). This GPU-process growth is a
dev-instance observation across the whole session (it also grew during the idle
hold); separating warm-up from a leak needs a longer no-capture run and is out of
this ticket's scope.

### 2.5 SmartSelect lifecycle probe (option iii components)

Run: `scripts/probe-smart-select-lifecycle.js` against the real helper; corrected
staleness check in `scripts/probe-smart-select-staleness.js`.

| Observation | Value |
|---|---|
| spawn -> ready (`spawnToReadyMs`) | cold 61.9 ms; fresh respawn 60.0 ms |
| first target hit-test query | 60.7 ms (probe); 49.0-132.7 ms in the real capture renderer |
| steady queries, n=30 | p50 4.99 ms, p95 5.61 ms (min 4.65, max 5.65) |
| rect conversion in main process | < 0.1 ms (p50/p95 ~0) |
| per-capture helper cost today | 1 process, 21.5-23.2 MiB private / 25.0-34.3 MiB WS, 0.06-0.08 CPU-s, lifetime = capture-window lifetime |
| idle residency (8 min hold) | 24.7-24.9 MiB private / 35.6-35.8 MiB WS, flat; CPU 0.19 s -> 0.19 s (0 over 8 min) |
| dispose -> process gone | 167.8 ms (single, pid-verified) |
| **staleness** | **proven**: after a real window move, a long-lived session returned the identical frozen rectangle set for the old point, the new point and the old point after the move; a newly spawned session queried at the moved window's new centre returned 3 different rectangles matching the moved window (`smart-select-staleness.json`, `staleSessionAnswersFrozenAcrossMove=true`, `freshSessionAnswersDifferAtNewPoint=true`) |

Root cause of staleness is in the sidecar source, not the session wrapper:
`native/smart-select/Program.cs` calls `LoadWindows()` once before printing its
`ready` line and `HitTest()` only reads that static list; there is no refresh
command in the line protocol. Reusing a session therefore returns out-of-date
window rectangles after any window appears, moves or closes - a correctness
failure, not just a latency trade-off. Measured heap of the reuse case: the helper
is cheap (<=25 MiB private, 0 idle CPU) and disposably fast (168 ms), but it is
only correct if it is respawned per capture (today's behaviour) or the protocol is
extended.

### 2.6 Hidden pre-warm simulation (option ii components)

In-app probe, 8 iterations in each run; a hidden `BrowserWindow` with the real
capture page + `preload-capture.js`, loaded ahead of time:

| Observation | Run A | Run B |
|---|---:|---:|
| construct -> renderer `capture:ready` | p50 91 ms / p95 94 ms | p50 86 ms / p95 86 ms |
| init -> render-ready (pre-warmed window cost) | p50 24 ms / p95 97 ms* | p50 16 ms / p95 97 ms* |
| construct -> first operable (on-demand, isolated) | p50 116 ms | p50 103 ms |
| incremental memory while hidden+loaded | +1 renderer process, +28.9 MiB private, +103.0 MiB WS | +29.1-33.0 MiB private, +103.2-107.2 MiB WS |
| after destroy | back to 4 Electron processes | back to 4 Electron processes |

*one 97 ms outlier out of 8; the other samples are 15-27 ms.

### 2.7 Decision per option

| Option | Effective hot p95 improvement | Idle memory | Reclaim | Verdict |
|---|---|---|---|---|
| (i) current on-demand | baseline: 212 ms p95 (DISPLAY2), 315 ms p95 (DISPLAY1) | n/a | n/a | **KEEP** |
| (ii) hidden-window pre-warm | DISPLAY2: est. **-41.6 ms p95 / -30.8 ms p50 (19.6%)**; DISPLAY1: **0 ms** (capture is the tail in 29/29 samples) | +29-33 MiB private / +103-107 MiB WS per resident window; 0 CPU while idle | destroy returns to baseline immediately; a pool would need TTL <=120 s | **REJECT** |
| (iii) reused SmartSelect session | first-operable: same as (ii) (0 ms on DISPLAY1, est. -30..-42 ms p95 on DISPLAY2); first target query improves 49-133 ms -> ~5-8 ms | +22-25 MiB private / +25-36 MiB WS while resident; 0 idle CPU | 168 ms -> within 500 ms | **REJECT as specified** |

Rationale:

* **(ii) REJECT.** It passes the numeric threshold only on the smaller secondary
  capture (1152x2048, where the screen grab is faster than window boot) and gains
  exactly 0 ms on the 2560x1440 @150% primary capture, because there the screen grab
  (238 ms p50) already exceeds the window-ready tail (176 ms). Users mostly capture
  the primary screen, so a product change whose whole benefit disappears there - at
  a cost of a resident hidden window (~103 MiB WS, +30 MiB private) and a window
  lifecycle to maintain - is not justified by this baseline. If a future
  capture-display-aware prototype is wanted for small secondary panels, it must
  demonstrate the DISPLAY2-class saving end-to-end and keep the idle budget; that
  is a new ticket, not a warm-up ship.
* **(iii) REJECT as specified.** The first-operable analysis is the same as (ii);
  its unique extra benefit is the first SmartSelect target query (49-133 ms once
  per capture, versus 5-8 ms when warm), which is user-visible in the smart-outline
  latency but does not move the first-operable budget. The correctness blocker is
  decisive: the helper snapshots the window list at spawn (proven by the staleness
  probe and the source), so a reused session returns wrong rectangles after window
  moves/appearance. Adopting it requires a bounded per-query window-list refresh in
  `native/smart-select` plus a TTL/max-one-instance policy (<=120 s), an explicit
  cross-domain contract, and a rebuild/regression cycle - out of scope for this
  experiment (and it would need its own ticket with the native build gate).

**Product change justified next: none for capture warm-up / SmartSelect lifecycle.**
The measured critical path is the screen grab (`captureMs` p95 171-270 ms depending
on the captured display) plus the renderer's ~46-48 ms init->paint; the window and
SmartSelect spawn are hidden underneath the capture on the primary display and only
become the tail on the small secondary display, where budget-limited warm-up would
cost more (resident memory, lifecycle risk) than it returns. Keep the current
on-demand lifecycle. If capture latency work continues, the numbers to target are
`capture.acquired` (grab backend / pixels) and the renderer's ~46-48 ms, and both
candidate ideas should be re-measured with `scripts/measure-capture-pipeline.js`
before any code is written. A separate, cheaper follow-up worth scheduling is the
SmartSelect protocol refresh (plus session reuse with TTL) if the 50-130 ms
first-outline latency is a UX priority; it should be measured against
`smart-select-lifecycle.json` / `smart-select-staleness.json`.

---

## 3. Raw data index

| Path (under `.tmp-work/experiment/`) | Content |
|---|---|
| `e01/solo-usage-query-run{1,2,3}.log` | three solo test runs, full output |
| `e01/solo-load.ndjson` | ambient load during the solo runs |
| `e01/latency-baseline.json`, `latency-baseline.log` | replica p50/p95, quiet |
| `e01/latency-loaded.json`, `latency-loaded.log` | replica p50/p95 under 16 CPU hogs |
| `e01/burn16-{a,b}-usage-query.log` | 16-hog failures, 169.6/177.4 ms |
| `e01/burn24-{a,b}-usage-query.log`, `burn20-churn3-usage-query.log` | heavier oversubscription failures |
| `e01/files15.log` | 15-file concurrent (passes) |
| `e01/concurrency-summary-v2.json` | summarised concurrency runs |
| `e01/perf-gate.json`, `e01/perf-gate-final.json` | isolated gate validation output (incl. quiet re-run) |
| `e01/clipboard-coordination-run{1,2}.log` | known-flake standalone x2 |
| `e01/capture-first-paint-run{1,2}.log`, `capture-first-paint-samples.json` | first-paint samples |
| `dev03/capture-pipeline-secondary.json` | clean DEV-03 capture run on DISPLAY2 (31 samples, all verified) |
| `dev03/capture-pipeline-main.json` | 10-minute idle run incl. idle memory evidence (captured DISPLAY1 because of cursor drift) |
| `dev03/smart-select-lifecycle.json` | SmartSelect sidecar lifecycle (raw) |
| `dev03/smart-select-staleness.json` | stale-vs-respawned session proof |
| `dev03/sidecars-*.ndjson` | 150 ms sidecar watcher trace |
| `dev03/collect-process-tree.ps1`, `dev03/sidecar-watcher.ps1` | probe helper scripts |
| `.tmp-work/experiment/e01/*-load.ndjson` | CPU/disk per E01 phase |

## 4. Honesty and limitations

* The host was shared with other agents and the user's own sessions. Quoted ambient
  CPU is measured per phase; the quiet runs still had 9-33% ambient CPU. The
  capture timings in run B were taken at 14.6% ambient CPU, run A at 19.4%.
* Capture latency is display/backend dependent: DISPLAY2 (1152x2048 @125%) 148 ms
  p50 vs DISPLAY1 (2560x1440 @150%) 238 ms p50, both native backend. This is why the
  prewarm verdict is configuration-dependent and why the default policy is rejected
  rather than claimed as a win.
* Only 1 true cold sample per configuration (one 10-minute or one 60-second idle
  hold each); 30 hot samples were collected as targeted (target was 30 cold + 30
  hot). Cold/hot launches are progressively reduced and this is the recorded
  deviation. Cold evidence is still sufficient to show no idle-cold penalty.
* Options (ii) and (iii) are measured components/probes, not shipped prototypes;
  the "saving" columns are component-derived estimates, labelled as such. No
  product code was modified, so an end-to-end adoption still requires a prototype
  plus the same measurement.
* Run B's captures were of the primary display, not DISPLAY2, because the user's
  cursor moved onto the primary screen during the 10-minute idle hold; that also
  means 30 visible capture overlays were shown on the primary display for a few
  hundred ms each. Run A fixed this by re-parking and verifying the cursor before
  every trigger (30/30 captures on the expected display). Both datasets are kept
  because they measure the two real capture sizes.
* The sidecar watcher matches process names system-wide, so rows for `Everything` /
  `HighlighterClipboard` may include the installed app's sidecars; SmartSelect
  helper memory is attributed by capture-window time and matches the
  one-process-per-capture model (`helperAtReady` 30/30 / 31/31).
