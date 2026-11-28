# DEV-08 · Pin real-screen pixel compare — measurement and adopt decision

2026-11-28 · Windows · Electron 43.8.3 · N05 follow-up (`docs/plans/2026-11-28-review-optimization-follow-up-tasks.md` §DEV-08)

**Decision: ADOPT.** On the target host the screen pixels under a pin can be captured while the pin window itself is excluded, including two stacked pins and a placement on the secondary display whose work area starts at a negative `y` origin. The product ships the mode as an explicit per-pin opt-in in the pin context menu; the existing 1 Hz flash and difference modes keep their shipped behaviour and remain the defaults.

Reproducible probe: `scripts/probe-pin-screen-diff.js` (pure measurement tool; the only product import is the side-effect-free UMD planner `pin/pin-screen-diff.js`). Raw JSON from the committed-tool run is written to `.tmp-work/probe/out/pin-screen-diff.json` (scratch, not committed).

```powershell
# from the repository root; a real desktop session with the secondary display attached
Remove-Item Env:ELECTRON_RUN_AS_NODE
$env:TMP="$PWD\.tmp-work\tmp"; $env:TEMP=$env:TMP
.\node_modules\electron\dist\electron.exe --no-sandbox scripts\probe-pin-screen-diff.js `
  --out .tmp-work\probe\out\pin-screen-diff.json --frames 30
```

## 1. Method

1. Pick the secondary display (`screen.getAllDisplays()` → first non-primary). Open a frameless always-on-top `BrowserWindow` filled with a solid colour, sized 426×284 DIP.
2. Translate the window's DIP image box to display-local PHYSICAL pixels with `planScreenCapture` (same planner the product uses): intersect the DIP box with the display bounds, subtract the display origin, multiply by that display's `scaleFactor` (mixed-DPI safe; negative coordinate origins fall out of the same subtraction).
3. Capture the display through `desktopCapturer.getSources({types:['screen'], thumbnailSize: plan.thumbnail})`, match the source by `display_id`, `thumbnail.crop(plan.physicalRect)`, then `nativeImage.toBitmap()` (the deprecated `getBitmap()` is not used) converted BGRA→RGBA by `pin-screen-diff.bgraToRgba`.
4. Positive control: content protection OFF — the window colour must dominate its captured region.
5. Exclusion: `win.setContentProtection(true)`, 30 consecutive frames @ ~1050 ms — the window colour must be absent while the background (desktop or a second window) is present. Consecutive protected frames also give the frame bytes/rate for the adoption gate.
6. Move the protected window by (+40, +20) DIP: exclusion must follow the new geometry (no ghost of either rect), and protection-off must bring the colour back.
7. Stacked pins: an unprotected bottom window (solid blue) with a protected top window (solid red) on top of it. The captured frame over the top window must contain the bottom window's colour and none of the top's.
8. Controlled alignment: 10 consecutive frames of the stacked region while the bottom window is static. Any pair delta is capture noise/misalignment — the live desktop is NOT an "unchanged design", so it is reported separately.
9. Negative coordinates: same checks for a window placed at the secondary display's origin (`bounds.y = -136` on this host).

## 2. Host

| Item | Value |
|---|---|
| Windows | 10.0.26300 |
| Electron | 43.8.3 |
| Primary display | 2560×1440 @ 150%, rotation 0 |
| Secondary display | 1152×2048 @ 125%, rotation 90, origin `(2560, -136)` |
| Probe window (single) | 430×289 DIP @ `(2700, 44)` → 538×361 physical |
| Probe window (negative) | 300×200 DIP @ `(2590, -126)` → 383×258 physical, display-local `(38, 13)` |

## 3. Raw numbers (committed-tool run, 30 protected frames)

| Check | Measurement | Threshold | Result |
|---|---|---|---|
| Screen capture works (control) | window colour = **0.9856** of captured region | > 0.5 | pass |
| Exclusion, single pin | self-capture colour ratio **0** on 30/30 frames; background visible | ≤ 0.02 | pass |
| Exclusion follows geometry | protected after move **0** (physical 535×356), visible control after move **0.9872** | ≤ 0.02 / > 0.5 | pass |
| Stacked pins | visible control top **0.9832**; protected top **0**, bottom **0.9325** | top ≤ 0.02, bottom ≥ 0.2 | pass |
| Controlled alignment (static bottom, 9 consecutive pairs) | every pair ratio **0**; mean **0** | ≤ 0.05 | pass |
| Negative coordinates | visible **0.9782**; protected **0**; plan kept `dipRect.y = -126`, display-local physical `y = 13` | visible > 0.5, protected ≤ 0.02 | pass |
| Frame budget | max frame **776,872 B** (538×361×4) | ≤ 64,000,000 B | pass |
| Sampling interval | **1,486–1,551 ms** measured per frame (capture latency dominates the 1,050 ms sleep) | ≥ 1,000 ms | pass |

The gates are the module's own constants: `SELF_CAPTURE_MAX_RATIO = 0.02`, `ALIGNMENT_TOLERANCE_RATIO = 0.05`, `MIN_PROBE_SAMPLES = 3`, `MAX_CAPTURE_BYTES = 64 MB`; `evaluateDiffAdoption` returns `{adopt: true, reasons: []}` for the committed-tool run and for the temporary probe run that preceded it (30 frames, self-capture 0, alignment 0, max frame 756,860 B, interval 1,050 ms).

**Honest caveat about the desktop alignment proxy.** The first committed-tool run measured `alignmentRatio = 0.0935` when the "unchanged design" was whatever happened to be on the live desktop behind the protected window: 10 of 29 consecutive pairs differed by 12–22%, which is real background content change (animation/cursor/other windows), not pin misalignment. The probe was therefore changed to measure alignment against a **static bottom window** (controlled condition); every pair is 0. The product's renderer likewise compares each frame against its OWN deterministic offscreen composition of the pinned picture (`pin/pin-view-export.js`), not against a live desktop.

## 4. Mechanism and known limits

- Exclusion is `BrowserWindow.setContentProtection(true)` (Windows `SetWindowDisplayAffinity`). On this Electron/Windows pair the window stays visible but is absent from `desktopCapturer`; older Electron/Windows combinations may map it to `WDA_MONITOR`, which would return a black rectangle instead of the background. The product handles that as "alignment unavailable" (badge message) rather than showing a wrong diff.
- The side effect is disclosed where the mode is enabled: while compare is on, that pin is excluded from screenshots and recordings.
- Protection state: Electron offers no getter, so the pin domain records the value it last set and restores that on stop/close/hide/crash. The shipped product sets it nowhere else.
- Stops on: mode off/menu change, window hide (including workspace suspend), window close, renderer crash, capture failure limit (3 consecutive failures), invalid/oversized frame. The pin domain has no `powerMonitor` lock/sleep listener today, so lock/sleep behaviour is still a real-device check (the session simply fails and stops after the failure cap).
- The product's comparison region is the PIN WINDOW's content box (DIP `getContentBounds`), not the renderer's image rectangle: "the pixels under the pin" is exactly what the window covers, and using the window box makes long captures (which scroll inside the window) and moved windows work without re-reading renderer geometry. The renderer overlays the mask at `dipRect - window.screenX/screenY`, so a capture clamped at a display edge still lands on the right pixels.
- The renderer diffs each frame against its OWN offscreen composition of the pinned picture at the same physical size (`pin/pin-view-export.js`), not against a live desktop. A size mismatch is reported as "alignment unavailable" (never resampled into a false diff).
- Frames are memory-only: main converts BGRA→RGBA, sends ONE bounded frame per second to the renderer, and keeps only numeric stats. The renderer downsamples to a bounded comparison grid (≤1 Mpx mask), diffs against its offscreen composition, paints the mask + badge and drops the buffers.

## 5. Remaining real-device checks (not measurable here)

1. Multi-monitor **cross-DPI drag** while compare is on: the interval between moves is 1 Hz, so the overlay may lag one frame behind a drag; record whether the mask lands on the right pixels after the move settles (planner is covered by unit tests for mixed DPI).
2. Lock screen / sleep / RDP disconnect while compare is on: confirm the sampler stops (failure cap) and content protection does not persist after unlock.
3. CPU/GPU curve and battery impact over a 10-minute session (30 frames × 0.75 MB ≈ 23 MB total IPC traffic per minute max, but compositing cost is unmeasured).
4. A genuine WDA_MONITOR host (older Windows/Electron): confirm the "alignment unavailable" degradation instead of a black diff.
5. Recording-app verification: a protected pin must be absent from a third-party screen recording (the probe's `desktopCapturer` check is the same capture family, but a real encoder path is worth one manual pass).

## 6. Rollback

Disable by removing the context-menu entry / calling `stopRealPixelCompare` in `main/domains/pin/index.js`; the renderer overlay is inert without frames. Flash and difference modes are independent and unchanged, so rollback leaves the shipped compare behaviour intact.
