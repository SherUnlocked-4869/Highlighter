#!/usr/bin/env node
"use strict";

// Usage P0 runtime spike (B0-3).
//
// Run as an Electron main script (no BrowserWindow is ever created):
//
//   # normal dev shell:
//   ./node_modules/electron/dist/electron.exe scripts/usage-p0-spike.js
//   # this agent shell inherits ELECTRON_RUN_AS_NODE=1 and cannot start
//   # Chromium's sandbox, so unset it and pass --no-sandbox:
//   env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe --no-sandbox scripts/usage-p0-spike.js
//
// Measures the runtime primitives that decide the usage feature architecture:
//   F2  utilityProcess.fork cold start + first-message latency
//   F3  structured-clone cost of a 3-tool bucket-state payload
//       (~5/15/30 MB synthetic + a realistic 20k-bucket-entry case),
//       measured main->worker and worker->main
//   F4  main-process node:sqlite single transaction: create schema, upsert
//       2,000 usage_bucket rows + one scan_state row, commit
//   F5* worker crash / kill observation + restart after death
//
// Exit code 0 when all measurements complete (threshold overruns are reported
// in the verdict, they do not fail the probe). Prints a compact bullet report
// followed by a single machine-readable JSON line prefixed with
// HIGHLIGHTER_USAGE_P0_SPIKE=.
//
// Probe-environment deviation: inside this agent sandbox the Electron binary is
// denied writes outside the repository (EPERM) and Chromium's sandbox cannot
// start; the probe therefore uses the gitignored `<repo>/.tmp/` scratch root and
// requires --no-sandbox. Neither affects the measured primitives.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const v8 = require("node:v8");
const { app, utilityProcess, BrowserWindow } = require("electron");

// Guard: this probe needs a REAL Electron main process. Under
// ELECTRON_RUN_AS_NODE=1 (set by some agent shells) `app` is undefined and
// utilityProcess is unavailable, so fail with an actionable message instead of
// a TypeError.
if (!app || typeof app.disableHardwareAcceleration !== "function" || process.type !== "browser") {
  process.stderr.write(
    "usage-p0-spike must run as an Electron main script, not under ELECTRON_RUN_AS_NODE=1.\n" +
      "Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron.exe --no-sandbox scripts/usage-p0-spike.js\n",
  );
  process.exit(2);
}

const RESULT_PREFIX = "HIGHLIGHTER_USAGE_P0_SPIKE=";
const WORKER_PATH = path.join(__dirname, "usage-p0-worker.js");
const SQLITE_ROW_COUNT = 2000;
const SQLITE_TARGET_MS = 30;
const CLONE_TARGET_MS = 200;
const PAYLOAD_TARGET_BYTES = 50 * 1024 * 1024;
const REALISTIC_ENTRY_COUNT = 20000;
const PROBE_TIMEOUT_MS = 180000;

// Electron writes: the agent sandbox on this machine denies the Electron binary
// write access outside the repository (EPERM on os.tmpdir()/user profile, while
// plain Node is allowed). Prefer the OS temp dir, fall back to the gitignored
// `<repo>/.tmp/` scratch root so the probe works in both environments.
function resolveScratchRoot() {
  const osTempCandidate = path.join(os.tmpdir(), `hl-usage-p0-spike-${process.pid}`);
  try {
    fs.mkdirSync(osTempCandidate, { recursive: true });
    fs.rmdirSync(osTempCandidate);
    return { root: osTempCandidate, kind: "os-temp", osTempError: null };
  } catch (error) {
    const fallback = path.join(__dirname, "..", ".tmp", "usage-p0-spike", String(process.pid));
    fs.mkdirSync(fallback, { recursive: true });
    return {
      root: fallback,
      kind: "workspace-fallback",
      osTempError: `${error && error.code ? error.code : "ERROR"}: ${error && error.message ? error.message : String(error)}`,
    };
  }
}

const scratch = resolveScratchRoot();
const scratchRoot = scratch.root;
const userDataDir = path.join(scratchRoot, "user-data");
fs.mkdirSync(userDataDir, { recursive: true });
app.disableHardwareAcceleration();
app.setPath("userData", userDataDir);

let browserWindowsCreated = 0;
app.on("browser-window-created", () => {
  browserWindowsCreated += 1;
});

function epochMs() {
  return performance.timeOrigin + performance.now();
}

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function formatMiB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function toMessage(raw) {
  return raw && typeof raw === "object" && "data" in raw && raw.data && typeof raw.data === "object"
    ? raw.data
    : raw;
}

function forkWorker(serviceName) {
  const startedAt = epochMs();
  const child = utilityProcess.fork(WORKER_PATH, [], {
    serviceName,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const forkCallMs = epochMs() - startedAt;
  const state = { child, startedAt, forkCallMs, stdout: "", stderr: "" };
  const capture = (key, chunk) => {
    state[key] = (state[key] + String(chunk)).slice(-4000);
  };
  try {
    child.stdout?.on("data", (chunk) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk) => capture("stderr", chunk));
  } catch (_error) {
    // stdio pipes are best-effort in the probe.
  }
  return state;
}

function waitForMessage(state, predicate, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.child.removeListener("message", onMessage);
      reject(new Error(`timed out waiting for worker message (${timeoutMs} ms)`));
    }, timeoutMs);
    function onMessage(raw) {
      const message = toMessage(raw);
      let matched = false;
      try {
        matched = Boolean(predicate(message));
      } catch (_error) {
        matched = false;
      }
      if (!matched) return;
      clearTimeout(timer);
      state.child.removeListener("message", onMessage);
      resolve({ message, atMs: epochMs() });
    }
    state.child.on("message", onMessage);
  });
}

function waitForExit(state, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ code: null, reason: "timeout", atMs: epochMs() });
    }, timeoutMs);
    state.child.once("exit", (code, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: code === undefined ? null : code, reason: reason || null, atMs: epochMs() });
    });
  });
}

async function forkAndAwaitHello(label) {
  const state = forkWorker(`usage-p0-${label}`);
  const hello = await waitForMessage(state, (message) => message.type === "hello", 30000);
  state.workerNode = hello.message.node;
  state.workerPid = hello.message.pid;
  state.firstMessageMs = hello.atMs - state.startedAt;
  return state;
}

async function shutdownWorker(state) {
  if (!state || !state.child) return null;
  const sentAt = epochMs();
  try {
    state.child.postMessage({ type: "shutdown" });
  } catch (_error) {
    // ignore
  }
  const exit = await waitForExit(state, 5000);
  return { ...exit, latencyMs: round(exit.atMs - sentAt) };
}

// ── F2: utilityProcess.fork cold start ─────────────────────────────────────

async function measureForkColdStart() {
  const runs = [];
  let reusable = null;
  for (let index = 0; index < 3; index += 1) {
    const state = await forkAndAwaitHello(`cold-start-${index + 1}`);
    runs.push({
      forkCallMs: round(state.forkCallMs),
      firstMessageMs: round(state.firstMessageMs),
      workerNode: state.workerNode,
      workerPid: state.workerPid,
    });
    if (index === 0) {
      reusable = state;
    } else {
      await shutdownWorker(state);
    }
  }
  return {
    runs,
    medianFirstMessageMs: round(median(runs.map((run) => run.firstMessageMs))),
    minFirstMessageMs: round(Math.min(...runs.map((run) => run.firstMessageMs))),
    medianForkCallMs: round(median(runs.map((run) => run.forkCallMs))),
    worker: reusable,
  };
}

// ── F3: structured clone main <-> worker ───────────────────────────────────

// Realistic bucket row shape (plan section 2.5 `usage_bucket`).
const TOOLS = [
  { source: "codex", models: ["gpt-5.4-codex", "gpt-5.2", "gpt-5.4-mini"] },
  { source: "dsh", models: ["deepseek-v4.1-flash", "deepseek-v4.1-pro"] },
  { source: "opencode", models: ["glm-5", "claude-sonnet-4-5", "deepseek-v4.1-flash"] },
];
const HOUR_STARTS = [
  "2025-11-03T00:00:00.000Z",
  "2025-11-03T00:30:00.000Z",
  "2025-11-03T01:00:00.000Z",
  "2025-11-03T01:30:00.000Z",
];

function buildBucketRow(index) {
  const tool = TOOLS[index % TOOLS.length];
  const model = tool.models[Math.floor(index / 3) % tool.models.length];
  const hour = HOUR_STARTS[Math.floor(index / 9) % HOUR_STARTS.length];
  const input = 800 + ((index * 37) % 24000);
  const cached = 200 + ((index * 53) % 9000);
  const cacheWrite = (index * 11) % 700;
  const output = 50 + ((index * 17) % 1800);
  const reasoning = (index * 7) % 600;
  return {
    source: tool.source,
    model,
    hour_start: hour,
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_tokens: cacheWrite,
    output_tokens: output,
    reasoning_tokens: reasoning,
    total_tokens: input + cached + cacheWrite + output + reasoning,
    billable_total_tokens: input + cached + cacheWrite + output + reasoning,
    conversation_count: 1 + (index % 3),
    updated_at: "2026-10-21T00:00:00.000Z",
  };
}

// Every row gets its own half-hour bucket so the 2,000-row transaction really
// inserts 2,000 distinct primary keys (the clone payload reuses bucket shapes).
const SQLITE_BASE_HOUR_MS = Date.parse("2025-01-01T00:00:00.000Z");
function buildSqliteBucketRow(index) {
  const row = buildBucketRow(index);
  row.hour_start = new Date(SQLITE_BASE_HOUR_MS + index * 30 * 60 * 1000).toISOString();
  return row;
}

function buildStatePayload({ label, entryCount = null, targetBytes = null }) {
  let count = entryCount;
  if (!count) {
    // Calibrate from one row so the synthetic payload lands near the target.
    const sampleBytes = Buffer.byteLength(JSON.stringify(buildBucketRow(0)));
    count = Math.max(64, Math.ceil(targetBytes / sampleBytes));
  }
  const rows = new Array(count);
  for (let index = 0; index < count; index += 1) rows[index] = buildBucketRow(index);
  const payload = {
    kind: "usage-state",
    label,
    toolCount: 3,
    rowCount: count,
    rows,
  };
  const jsonBytes = Buffer.byteLength(JSON.stringify(payload));
  const v8Bytes = v8.serialize(payload).byteLength;
  return { payload, jsonBytes, v8Bytes, rowCount: count };
}

async function measureCloneScenario(workerState, scenario) {
  const built = buildStatePayload(scenario);
  const requestId = `${scenario.label}-${Date.now()}`;
  const sentAt = epochMs();
  let reply;
  try {
    workerState.child.postMessage({
      type: "clone:roundtrip",
      id: requestId,
      label: scenario.label,
      payload: built.payload,
    });
    reply = await waitForMessage(
      workerState,
      (message) => message.type === "clone:reply" && message.id === requestId,
      120000,
    );
  } catch (error) {
    return {
      label: scenario.label,
      targetMiB: scenario.targetMiB || null,
      rowCount: built.rowCount,
      jsonMiB: round(built.jsonBytes / 1024 / 1024, 2),
      v8MiB: round(built.v8Bytes / 1024 / 1024, 2),
      error: error && error.message ? error.message : String(error),
    };
  }
  const mainToWorkerMs = reply.message.receivedAt - sentAt;
  const workerToMainMs = reply.atMs - reply.message.receivedAt;
  const roundtripMs = reply.atMs - sentAt;
  const echoOk = Boolean(reply.message.payload && reply.message.payload.rows) &&
    reply.message.payload.rows.length === built.rowCount;
  const result = {
    label: scenario.label,
    targetMiB: scenario.targetMiB || null,
    rowCount: built.rowCount,
    jsonMiB: round(built.jsonBytes / 1024 / 1024, 2),
    v8MiB: round(built.v8Bytes / 1024 / 1024, 2),
    mainToWorkerMs: round(mainToWorkerMs),
    workerToMainMs: round(workerToMainMs),
    roundtripMs: round(roundtripMs),
    echoOk,
    workerNode: reply.message.workerNode || workerState.workerNode,
  };
  return result;
}

async function measureStructuredClone(workerState) {
  const scenarios = [
    { label: "synthetic-5MB", targetBytes: 5 * 1024 * 1024, targetMiB: 5 },
    { label: "synthetic-15MB", targetBytes: 15 * 1024 * 1024, targetMiB: 15 },
    { label: "synthetic-30MB", targetBytes: 30 * 1024 * 1024, targetMiB: 30 },
    { label: "realistic-20k-entries", entryCount: REALISTIC_ENTRY_COUNT },
  ];
  const results = [];
  for (const scenario of scenarios) {
    results.push(await measureCloneScenario(workerState, scenario));
  }
  const directionOver200ms = results
    .filter((result) => !result.error &&
      (Number(result.mainToWorkerMs) > CLONE_TARGET_MS || Number(result.workerToMainMs) > CLONE_TARGET_MS))
    .map((result) => ({
      label: result.label,
      mainToWorkerMs: result.mainToWorkerMs,
      workerToMainMs: result.workerToMainMs,
    }));
  const roundtripOver200ms = results
    .filter((result) => !result.error && Number(result.roundtripMs) > CLONE_TARGET_MS)
    .map((result) => ({ label: result.label, roundtripMs: result.roundtripMs }));
  const maxPayloadBytes = Math.max(
    0,
    ...results.map((result) => Math.round((result.jsonMiB || 0) * 1024 * 1024)),
  );
  return {
    scenarios: results,
    flags: {
      // Real usage sends state one way; each direction is compared to the
      // 200 ms budget. The round trip echoes the same payload back, so it is
      // reported separately rather than treated as a single transfer.
      cloneDirectionOver200ms: directionOver200ms,
      roundtripOver200ms,
      payloadOver50MB: maxPayloadBytes > PAYLOAD_TARGET_BYTES,
      maxPayloadMiB: round(maxPayloadBytes / 1024 / 1024, 2),
    },
  };
}

// ── F4: main-process node:sqlite single transaction ────────────────────────

function measureSqlite() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch (error) {
    return {
      nodeSqliteAvailable: false,
      error: error && error.message ? error.message : String(error),
    };
  }
  if (typeof DatabaseSync !== "function") {
    return { nodeSqliteAvailable: false, error: "DatabaseSync is not a constructor" };
  }

  const dir = fs.mkdtempSync(path.join(scratchRoot, "sqlite-"));
  const dbPath = path.join(dir, "usage.db");
  const result = { nodeSqliteAvailable: true, rowCount: SQLITE_ROW_COUNT, scratchKind: scratch.kind };
  let db = null;
  try {
    const schemaSql = `
      CREATE TABLE IF NOT EXISTS usage_bucket (
        source                 TEXT NOT NULL,
        model                  TEXT NOT NULL,
        hour_start             TEXT NOT NULL,
        input_tokens           INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens    INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens          INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens       INTEGER NOT NULL DEFAULT 0,
        total_tokens           INTEGER NOT NULL DEFAULT 0,
        billable_total_tokens  INTEGER NOT NULL DEFAULT 0,
        conversation_count     INTEGER NOT NULL DEFAULT 0,
        total_cost_usd         REAL NOT NULL DEFAULT 0,
        usage_precision        TEXT,
        updated_at             TEXT NOT NULL,
        PRIMARY KEY (source, model, hour_start)
      );
      CREATE TABLE IF NOT EXISTS scan_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
    `;
    const openStartedAt = epochMs();
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec("PRAGMA user_version = 1");
    result.openAndPragmaMs = round(epochMs() - openStartedAt);

    // F4 as specified: create the schema AND upsert 2,000 bucket rows plus one
    // scan_state row, then commit - all inside ONE transaction.
    const transactionStartedAt = epochMs();
    db.exec("BEGIN IMMEDIATE");
    db.exec(schemaSql);
    const upsert = db.prepare(`
      INSERT INTO usage_bucket (
        source, model, hour_start, input_tokens, cached_input_tokens, cache_creation_tokens,
        output_tokens, reasoning_tokens, total_tokens, billable_total_tokens, conversation_count,
        total_cost_usd, usage_precision, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, model, hour_start) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        cached_input_tokens = excluded.cached_input_tokens,
        cache_creation_tokens = excluded.cache_creation_tokens,
        output_tokens = excluded.output_tokens,
        reasoning_tokens = excluded.reasoning_tokens,
        total_tokens = excluded.total_tokens,
        billable_total_tokens = excluded.billable_total_tokens,
        conversation_count = excluded.conversation_count,
        total_cost_usd = excluded.total_cost_usd,
        usage_precision = excluded.usage_precision,
        updated_at = excluded.updated_at
    `);
    const writeScanState = db.prepare(`
      INSERT INTO scan_state (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    for (let index = 0; index < SQLITE_ROW_COUNT; index += 1) {
      const row = buildSqliteBucketRow(index);
      upsert.run(
        row.source,
        row.model,
        row.hour_start,
        row.input_tokens,
        row.cached_input_tokens,
        row.cache_creation_tokens,
        row.output_tokens,
        row.reasoning_tokens,
        row.total_tokens,
        row.billable_total_tokens,
        row.conversation_count,
        0,
        null,
        row.updated_at,
      );
    }
    writeScanState.run(
      "codex:files",
      JSON.stringify({ fixtureRows: SQLITE_ROW_COUNT, cursorVersion: 1 }),
      "2026-10-21T00:00:00.000Z",
    );
    db.exec("COMMIT");
    result.schemaAndRowsTransactionMs = round(epochMs() - transactionStartedAt);
    result.avgPerRowMs = round(result.schemaAndRowsTransactionMs / SQLITE_ROW_COUNT, 4);

    // Comparison number: a second transaction that only re-upserts the 2,000
    // rows + scan_state (the steady-state path after the schema exists).
    const rowsOnlyStartedAt = epochMs();
    db.exec("BEGIN IMMEDIATE");
    for (let index = 0; index < SQLITE_ROW_COUNT; index += 1) {
      const row = buildSqliteBucketRow(index);
      upsert.run(
        row.source,
        row.model,
        row.hour_start,
        row.input_tokens,
        row.cached_input_tokens,
        row.cache_creation_tokens,
        row.output_tokens,
        row.reasoning_tokens,
        row.total_tokens,
        row.billable_total_tokens,
        row.conversation_count,
        0,
        null,
        row.updated_at,
      );
    }
    writeScanState.run(
      "codex:files",
      JSON.stringify({ fixtureRows: SQLITE_ROW_COUNT, cursorVersion: 1 }),
      "2026-10-21T00:00:00.000Z",
    );
    db.exec("COMMIT");
    result.rowsOnlyTransactionMs = round(epochMs() - rowsOnlyStartedAt);

    // Idempotent DDL pass (every store open re-runs it).
    const ddlIdempotentStartedAt = epochMs();
    db.exec("BEGIN IMMEDIATE");
    db.exec("PRAGMA user_version = 1");
    db.exec(schemaSql);
    db.exec("COMMIT");
    result.ddlIdempotentMs = round(epochMs() - ddlIdempotentStartedAt);

    const counted = db.prepare("SELECT COUNT(*) AS rows FROM usage_bucket").get();
    const scanRows = db.prepare("SELECT COUNT(*) AS rows FROM scan_state").get();
    result.rowsCommitted = Number(counted?.rows) || 0;
    result.scanStateRowsCommitted = Number(scanRows?.rows) || 0;
    result.primaryTransactionMs = result.schemaAndRowsTransactionMs;
    result.under30msTarget = result.schemaAndRowsTransactionMs < SQLITE_TARGET_MS;
    result.dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    result.walBytes = fs.existsSync(`${dbPath}-wal`) ? fs.statSync(`${dbPath}-wal`).size : 0;
  } catch (error) {
    result.error = error && error.message ? error.message : String(error);
    result.stack = error && error.stack ? String(error.stack).slice(0, 800) : null;
  } finally {
    try {
      db?.close();
    } catch (_error) {
      // ignore
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_error) {
      // ignore
    }
  }
  return result;
}

// ── F5*: crash / kill / restart observation ────────────────────────────────

async function measureCrashAndRestart(forkBaselineMs) {
  const out = {};

  // 1) Abnormal worker death observed by the parent.
  const crashState = await forkAndAwaitHello("crash");
  const crashSentAt = epochMs();
  crashState.child.postMessage({ type: "crash" });
  const crashExit = await waitForExit(crashState, 20000);
  out.crash = {
    exitCode: crashExit.code,
    exitReason: crashExit.reason,
    latencyMs: round(crashExit.atMs - crashSentAt),
    stderrTail: crashState.stderr.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 500) || null,
  };

  // 2) Parent-initiated kill while the worker is busy.
  const killState = await forkAndAwaitHello("kill");
  killState.child.postMessage({ type: "busy" });
  await waitForMessage(killState, (message) => message.type === "busy:tick", 15000);
  const killSentAt = epochMs();
  let killReturned = null;
  try {
    killReturned = killState.child.kill();
  } catch (error) {
    killReturned = `threw: ${error && error.message ? error.message : String(error)}`;
  }
  const killExit = await waitForExit(killState, 20000);
  out.kill = {
    killReturned,
    exitCode: killExit.code,
    exitReason: killExit.reason,
    latencyMs: round(killExit.atMs - killSentAt),
  };

  // 3) Restart path: a fresh fork still works after crash + kill.
  const restartState = await forkAndAwaitHello("restart");
  out.restart = {
    firstMessageMs: round(restartState.firstMessageMs),
    forkCallMs: round(restartState.forkCallMs),
    workerNode: restartState.workerNode,
    workerPid: restartState.workerPid,
    restartSlowerThanBaselineMs:
      forkBaselineMs === null ? null : round(restartState.firstMessageMs - forkBaselineMs),
  };
  const shutdownResult = await shutdownWorker(restartState);
  out.restartShutdown = {
    exitCode: shutdownResult ? shutdownResult.code : null,
    exitReason: shutdownResult ? shutdownResult.reason : null,
    latencyMs: shutdownResult ? shutdownResult.latencyMs : null,
  };
  return out;
}

// ── Report ─────────────────────────────────────────────────────────────────

function buildVerdict(report) {
  const sqlite = report.sqlite || {};
  const clone = report.structuredClone || {};
  const s2Feasible = sqlite.nodeSqliteAvailable === true &&
    sqlite.rowsCommitted === SQLITE_ROW_COUNT &&
    Number(sqlite.primaryTransactionMs) < SQLITE_TARGET_MS;
  const cloneFlags = clone.flags || {};
  const s3Feasible = (cloneFlags.cloneDirectionOver200ms || []).length === 0 &&
    cloneFlags.payloadOver50MB !== true;
  const realistic = (clone.scenarios || []).find((scenario) => scenario.label === "realistic-20k-entries");
  const fifteenMb = (clone.scenarios || []).find((scenario) => scenario.label === "synthetic-15MB");
  const thirtyMb = (clone.scenarios || []).find((scenario) => scenario.label === "synthetic-30MB");
  return {
    s2_mainProcessSingleWriter: s2Feasible ? "feasible" : "not-feasible",
    s2Note: `node:sqlite available=${sqlite.nodeSqliteAvailable}; schema+${SQLITE_ROW_COUNT} upserts+scan_state in one transaction ${sqlite.primaryTransactionMs} ms (target <${SQLITE_TARGET_MS} ms); rows committed ${sqlite.rowsCommitted}; rows-only transaction ${sqlite.rowsOnlyTransactionMs} ms`,
    s3_sinkStaging: s3Feasible ? "feasible" : "needs-change",
    s3Note: realistic
      ? `realistic 20k buckets (${realistic.jsonMiB} MiB): main->worker ${realistic.mainToWorkerMs} ms, worker->main ${realistic.workerToMainMs} ms; expected upper bound 15 MB: ${fifteenMb ? `${fifteenMb.mainToWorkerMs}/${fifteenMb.workerToMainMs} ms` : "n/a"}; 30 MB synthetic: ${thirtyMb ? `${thirtyMb.mainToWorkerMs}/${thirtyMb.workerToMainMs} ms` : "n/a"} (per-direction threshold ${CLONE_TARGET_MS} ms / payload ${PAYLOAD_TARGET_BYTES / 1024 / 1024} MB); 30 MB round-trip echo ${thirtyMb && thirtyMb.roundtripMs} ms (both directions, not the real one-way pattern)`
      : "structured clone measurement failed",
    thresholds: {
      sqliteTransactionMs: SQLITE_TARGET_MS,
      cloneDirectionMs: CLONE_TARGET_MS,
      payloadBytes: PAYLOAD_TARGET_BYTES,
    },
    flags: {
      sqliteOver30ms: sqlite.nodeSqliteAvailable === true && !sqlite.under30msTarget,
      cloneDirectionOver200ms: cloneFlags.cloneDirectionOver200ms || [],
      roundtripOver200ms: cloneFlags.roundtripOver200ms || [],
      payloadOver50MB: cloneFlags.payloadOver50MB === true,
    },
  };
}

function printReport(report) {
  const lines = [];
  lines.push("");
  lines.push("Usage P0 runtime spike (B0-3) - headless Electron main-process probe");
  lines.push(`  Electron ${report.environment.electron} / Node ${report.environment.node} (main) / worker Node ${report.forkColdStart.workerNode || "n/a"} / ${report.environment.platform}-${report.environment.arch}`);
  lines.push(`  visible windows created: ${report.environment.browserWindowsCreated} (probe never constructs a BrowserWindow)`);
  lines.push(`  launch: ${report.environment.launchNote}`);
  if (report.environment.scratch.kind !== "os-temp") {
    lines.push(`  scratch dir: ${report.environment.scratch.kind} (${report.environment.scratch.osTempError})`);
  }
  lines.push("");
  lines.push(`F2 utilityProcess.fork cold start (${report.forkColdStart.runs.length} runs):`);
  for (const run of report.forkColdStart.runs) {
    lines.push(`  - fork() call ${run.forkCallMs} ms; fork->first message ${run.firstMessageMs} ms`);
  }
  lines.push(`  median first-message ${report.forkColdStart.medianFirstMessageMs} ms (min ${report.forkColdStart.minFirstMessageMs} ms)`);
  lines.push("");
  lines.push("F3 structured clone main <-> worker (payload is a 3-tool usage_bucket state):");
  for (const scenario of report.structuredClone.scenarios) {
    if (scenario.error) {
      lines.push(`  - ${scenario.label}: ERROR ${scenario.error}`);
      continue;
    }
    lines.push(
      `  - ${scenario.label}: ${scenario.rowCount} rows, json ${scenario.jsonMiB} MiB (v8 clone ~${scenario.v8MiB} MiB)` +
      ` => main->worker ${scenario.mainToWorkerMs} ms, worker->main ${scenario.workerToMainMs} ms, roundtrip ${scenario.roundtripMs} ms`,
    );
  }
  lines.push(
    `  flags: direction-over200ms=${JSON.stringify(report.structuredClone.flags.cloneDirectionOver200ms)}` +
    ` roundtrip-over200ms=${JSON.stringify(report.structuredClone.flags.roundtripOver200ms)}` +
    ` payloadOver50MB=${report.structuredClone.flags.payloadOver50MB}`,
  );
  lines.push("");
  lines.push(`F4 main-process node:sqlite (schema + ${SQLITE_ROW_COUNT} usage_bucket upserts + 1 scan_state, ONE transaction):`);
  if (report.sqlite.nodeSqliteAvailable) {
    lines.push(
      `  open+pragmas ${report.sqlite.openAndPragmaMs} ms; schema+rows transaction ${report.sqlite.primaryTransactionMs} ms` +
      ` (${report.sqlite.avgPerRowMs} ms/row); rows-only transaction ${report.sqlite.rowsOnlyTransactionMs} ms; idempotent DDL ${report.sqlite.ddlIdempotentMs} ms`,
    );
    lines.push(
      `  rows committed ${report.sqlite.rowsCommitted}; scan_state rows ${report.sqlite.scanStateRowsCommitted};` +
      ` db ${(report.sqlite.dbBytes / 1024).toFixed(1)} KiB + wal ${(report.sqlite.walBytes / 1024).toFixed(1)} KiB`,
    );
  } else {
    lines.push(`  node:sqlite unavailable: ${report.sqlite.error}`);
  }
  lines.push("");
  lines.push("F5* worker death observation + restart:");
  lines.push(`  crash: exit code=${report.crash.crash.exitCode} reason=${report.crash.crash.exitReason} observed ${report.crash.crash.latencyMs} ms after crash message`);
  lines.push(`  kill : kill()=${report.crash.kill.killReturned} exit code=${report.crash.kill.exitCode} reason=${report.crash.kill.exitReason} after ${report.crash.kill.latencyMs} ms`);
  lines.push(`  restart after death works: first message ${report.crash.restart.firstMessageMs} ms (baseline ${report.forkColdStart.medianFirstMessageMs} ms)`);
  lines.push("");
  lines.push(`VERDICT: S2 main-process single writer = ${report.verdict.s2_mainProcessSingleWriter}; S3 sink/staging = ${report.verdict.s3_sinkStaging}`);
  lines.push(`  S2: ${report.verdict.s2Note}`);
  lines.push(`  S3: ${report.verdict.s3Note}`);
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function run() {
  const environment = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    processType: process.type,
    command: "node_modules/electron/dist/electron.exe --no-sandbox scripts/usage-p0-spike.js",
    launchNote: [
      app.commandLine.hasSwitch("no-sandbox")
        ? "--no-sandbox was supplied (required in this agent shell: Chromium's own sandbox cannot start under the host process confinement; a normal dev shell does not need it)"
        : "default Chromium sandbox",
      process.env.ELECTRON_RUN_AS_NODE
        ? "ELECTRON_RUN_AS_NODE was inherited but unset for this run"
        : "ELECTRON_RUN_AS_NODE unset (real Electron main process)",
    ].join("; "),
    browserWindowsCreated: 0,
    workerPath: WORKER_PATH,
    scratch: {
      kind: scratch.kind,
      path: scratchRoot,
      osTempError: scratch.osTempError,
    },
  };

  const coldStart = await measureForkColdStart();
  environment.browserWindowsCreated = browserWindowsCreated;
  const clone = await measureStructuredClone(coldStart.worker);
  await shutdownWorker(coldStart.worker);
  coldStart.worker = null;
  const sqlite = measureSqlite();
  const crash = await measureCrashAndRestart(coldStart.medianFirstMessageMs);
  environment.browserWindowsCreated = browserWindowsCreated;

  const report = {
    spike: "B0-3-usage-p0",
    generatedAt: new Date().toISOString(),
    environment,
    forkColdStart: {
      runs: coldStart.runs,
      medianFirstMessageMs: coldStart.medianFirstMessageMs,
      minFirstMessageMs: coldStart.minFirstMessageMs,
      medianForkCallMs: coldStart.medianForkCallMs,
      workerNode: coldStart.runs[0]?.workerNode || null,
    },
    structuredClone: clone,
    sqlite,
    crash,
  };
  report.verdict = buildVerdict(report);
  return report;
}

let finished = false;

function cleanupScratch() {
  try {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
    return true;
  } catch (_error) {
    return false;
  }
}

const timeout = setTimeout(() => {
  if (finished) return;
  finished = true;
  console.error("Usage P0 spike timed out");
  cleanupScratch();
  app.exit(1);
}, PROBE_TIMEOUT_MS);

app.whenReady()
  .then(run)
  .then((report) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    printReport(report);
    process.stdout.write(`${RESULT_PREFIX}${JSON.stringify(report)}\n`);
    const cleaned = cleanupScratch();
    process.stdout.write(`scratch cleanup: ${cleaned ? "ok" : "partial (locked files left in .tmp; gitignored)"}\n`);
    app.exit(0);
  })
  .catch((error) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    console.error(error && error.stack ? error.stack : String(error));
    cleanupScratch();
    app.exit(1);
  });
