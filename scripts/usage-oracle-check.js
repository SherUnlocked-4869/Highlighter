#!/usr/bin/env node
"use strict";

// Usage oracle harness (B0-4).
//
// Modes:
//   --build-fixtures        Regenerate the sanitized fixture home under
//                           test/fixtures/usage/home/ (Codex JSONL, DSH zstd
//                           sessions, synthetic OpenCode SQLite DB).
//   --tt-only [--sync]      Replay the TokenTracker CLI queue.jsonl into the
//                           normalized golden JSON under
//                           test/fixtures/usage/golden/ (LWW by
//                           source|model|hour_start). --sync runs the TT CLI
//                           against the fixture home first.
//   --hl-db <usage.db>      Compare a Highlighter usage.db (schema per plan
//                           section 2.5) against the golden rows: per-bucket
//                           integer token columns (zero tolerance) plus daily
//                           per-source / per-model sums. Exits non-zero on any
//                           mismatch.
//
// The oracle is TokenTracker CLI v1.4.7 (npm package tokentracker-cli), installed
// OUTSIDE this repo on the dev machine (default D:\workspace\_tt-oracle). It is
// never added to product dependencies and never committed.
//
// TODO(B2+): the Highlighter usage.db does not exist yet (B1/B2 build it). The
// --hl-db schema assumptions below are frozen from plan section 2.5
// (`usage_bucket`), so the diff path becomes usable as soon as the store lands;
// re-verify column names there before trusting a green run.

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync, spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const HOME_DIR = path.join(ROOT, "test", "fixtures", "usage", "home");
const GOLDEN_DIR = path.join(ROOT, "test", "fixtures", "usage", "golden");
const QUEUE_REL = path.join(".tokentracker", "tracker", "queue.jsonl");
const GOLDEN_ROWS = "queue-rows.json";
const GOLDEN_SUMMARY = "summary.json";
const TT_VERSION = "1.4.7";
const DEFAULT_TT_CLI = path.join(
  "D:\\workspace\\_tt-oracle",
  "node_modules",
  "tokentracker-cli",
  "bin",
  "tracker.js",
);

// TT queue row token columns (see TokenTracker CLAUDE.md "Queue entry").
const QUEUE_TOKEN_COLUMNS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];
// Column names use the TT queue side as the canonical comparison vocabulary;
// Highlighter's usage_bucket names differ for cache and reasoning, so map
// explicitly instead of relying on identical names.
const HL_COLUMN_BY_QUEUE_COLUMN = {
  input_tokens: "input_tokens",
  cached_input_tokens: "cached_input_tokens",
  cache_creation_input_tokens: "cache_creation_tokens",
  output_tokens: "output_tokens",
  reasoning_output_tokens: "reasoning_tokens",
  total_tokens: "total_tokens",
  billable_total_tokens: "billable_total_tokens",
  conversation_count: "conversation_count",
};
const INTEGER_COLUMNS = Object.keys(HL_COLUMN_BY_QUEUE_COLUMN);
const HL_INTEGER_COLUMNS = Object.values(HL_COLUMN_BY_QUEUE_COLUMN);
const SAMPLE_DIFF_LIMIT = 20;

// ── Aggregation-level oracle (task-10) ─────────────────────────────────────
// TokenTracker's own /functions/tokentracker-usage-* payloads are the oracle
// for period ranges, local-day grouping, rolling windows, model breakdown and
// heatmap levels. The tenant's bucket-level golden is queue-rows.json; these
// files extend parity to the aggregation layer.
const AGGREGATES_SCHEMA = "usage-oracle-aggregates-v1";
const AGGREGATES_CAPTURE_SCHEMA = "hl-usage-aggregates-v1";
const AGGREGATES_TZS = ["Asia/Shanghai", "UTC"];
const AGGREGATES_PERIODS = ["day", "week", "month", "total"];
const AGGREGATE_TT_VERSION = "1.4.7";
// The four token columns the aggregation IPC contract must agree on (plan
// section 2.6/2.7). total/billable/reasoning/conversation are compared too when
// the Highlighter payload provides them.
const AGGREGATE_REQUIRED_TOKEN_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
];
const AGGREGATE_ALL_TOKEN_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "reasoning_output_tokens",
  "total_tokens",
  "billable_total_tokens",
];
const AGGREGATE_ENDPOINTS = {
  summary: "/functions/tokentracker-usage-summary",
  daily: "/functions/tokentracker-usage-daily",
  breakdown: "/functions/tokentracker-usage-model-breakdown",
  heatmap: "/functions/tokentracker-usage-heatmap",
};
const AGGREGATES_SERVE_READY_TIMEOUT_MS = 30000;
const AGGREGATES_FETCH_TIMEOUT_MS = 30000;

const HELP = `Usage oracle harness (TokenTracker CLI -> Highlighter usage.db / IPC payloads)

USAGE
  node scripts/usage-oracle-check.js --build-fixtures
  node scripts/usage-oracle-check.js --tt-only --sync
  node scripts/usage-oracle-check.js --tt-only
  node scripts/usage-oracle-check.js --hl-db <path/to/usage.db>
  node scripts/usage-oracle-check.js --tt-aggregates-only
  node scripts/usage-oracle-check.js --aggregates <hl-aggregates.json>
  node scripts/usage-oracle-check.js --self-test

MODES
  --build-fixtures       Regenerate the sanitized fixture home (deterministic;
                         no real prompt/code content, only token counters). The
                         home stays tool-logs-only; TT scratch is never written
                         there.
  --tt-only              Replay a TokenTracker queue.jsonl as LWW by
                         source|model|hour_start and write the batch golden files
                         (queue-rows.json + summary.json). Without --sync a
                         --queue path is required (the queue lives outside the
                         fixture home).
  --sync                 With --tt-only/--tt-aggregates-only: run the TokenTracker
                         CLI sync against an OUT-OF-REPO scratch copy of the
                         fixture tool logs (fully local; no device token), then
                         delete the scratch home.
  --hl-db <path>         Diff a Highlighter usage.db against the golden files.
                         Zero tolerance on integer token columns; also compares
                         daily per-source and per-model sums. Exit 1 on any
                         mismatch, 2 on unusable input.
  --tt-aggregates-only   Refresh the aggregation-level goldens
                         (test/fixtures/usage/golden/aggregates-<tz>.json) from
                         TT's own local HTTP API: sync an out-of-repo scratch
                         home, start 'tracker.js serve --no-open --no-sync' on a
                         free loopback port pointed at that scratch home, fetch
                         summary/daily/model-breakdown/heatmap for Asia/Shanghai
                         and UTC over day/week/month/total ranges, stop the
                         server, delete the scratch home.
  --aggregates <file>    Compare already-captured Highlighter payloads (the
                         usage:summary/daily/breakdown/heatmap IPC responses,
                         captured against the same fixture home) with the TT
                         aggregation goldens. Exit 1 on any mismatch, 2 on
                         unusable input. Capture-file schema is documented in
                         test/fixtures/usage/golden/README.md and below.
  --self-test            Run the aggregation comparator against synthetic
                         payloads (PASS path, +1 token, missing source, shifted
                         heatmap grid, cost-only drift). Exit 0 when all cases
                         behave as expected.

OPTIONS
  --home <dir>           Fixture home with the synthetic tool logs (default:
                         test/fixtures/usage/home).
  --queue <file>         Explicit TokenTracker queue.jsonl path for replay-only
                         --tt-only (no --sync). TT scratch state never lives
                         inside the fixture home, so there is no in-repo default.
  --tt-cli <file>        TokenTracker CLI entry (default: env TT_ORACLE_CLI, then
                         ${DEFAULT_TT_CLI}).
  --json                 Machine-readable report on stdout (diff modes).
  -h, --help             This help.

SCRATCH HOME (TT hygiene)
  TT never runs with USERPROFILE pointing at the committed fixture home, because
  it writes `.tokentracker/` state (cursors, queue and transient .js/.cjs shims)
  inside that home and repo gates such as scripts/check-js.js syntax-scan the
  whole test/ tree. The harness copies only the tool-log entries (`.codex/`,
  `.dsh/`, `.local/`, plus future `.claude/` etc.; it skips README.md,
  .gitignore, AppData and .tokentracker) into
  os.tmpdir()/hl-usage-oracle-home-<pid>-<rand> (override the base with
  TT_ORACLE_SCRATCH_DIR; fallback is the _tt-oracle install dir), points
  USERPROFILE/HOME/APPDATA/LOCALAPPDATA at it, and removes it in a finally
  block. Any `.tokentracker/` found under the in-repo fixture home is warned
  about and deleted defensively.

HIGHLIGHTER AGGREGATES CAPTURE FILE (--aggregates)
  JSON object, one entry per IPC response captured on the SAME fixture home:
    {
      "schema": "hl-usage-aggregates-v1",
      "captures": [
        { "tz": "Asia/Shanghai", "view": "summary",   "period": "day",   "payload": <usage:summary response> },
        { "tz": "Asia/Shanghai", "view": "daily",     "period": "day",   "payload": <usage:daily response> },
        { "tz": "Asia/Shanghai", "view": "breakdown", "period": "day",   "payload": <usage:breakdown response> },
        { "tz": "Asia/Shanghai", "view": "heatmap",   "period": "total", "payload": <usage:heatmap response> },
        ... (four periods day/week/month/total for summary/daily/breakdown;
             one heatmap entry per tz; repeat for "UTC")
      ]
    }
  "response"/"data" are accepted instead of "payload", and a nested
  { "<tz>": { "<view>": { "<period>": <payload> } } } map is accepted too.
  Integer token columns and conversation_count are compared with zero
  tolerance; heatmap compares the day/value/level cell set only (TT's week grid
  first column drifts with the run date); sharePct is compared within 0.01
  percentage points; cost fields (total_cost_usd / pricing) are ignored.

ENVIRONMENT (TT sync / serve, applied to the out-of-repo scratch home)
  USERPROFILE/HOME=<scratch home>, APPDATA/LOCALAPPDATA=<scratch home>/AppData/**,
  DSH_HOME/CODEX_HOME/XDG_DATA_HOME/OPENCODE_HOME removed,
  TOKENTRACKER_WSL_MODE=native-only, TOKENTRACKER_NO_TELEMETRY=1,
  DO_NOT_TRACK=1. The scratch home has no device token, so TT never uploads and
  never requires an account.

REPRODUCE
  node scripts/usage-oracle-check.js --build-fixtures
  node scripts/usage-oracle-check.js --tt-only --sync
  node scripts/usage-oracle-check.js --tt-aggregates-only
  # Highlighter side (once B1/B2 store exists):
  node scripts/usage-oracle-check.js --hl-db <dataRoot>/usage/usage.db
  node scripts/usage-oracle-check.js --aggregates <captured-hl-payloads.json>

NOTE ON --hl-db
  Expected Highlighter schema (frozen in plan section 2.5): table usage_bucket
  with TEXT source/model/hour_start and INTEGER input_tokens,
  cached_input_tokens, cache_creation_tokens, output_tokens, reasoning_tokens,
  total_tokens, billable_total_tokens, conversation_count. hour_start may be
  'YYYY-MM-DDTHH:MM:00Z' or the TT-style '...:00.000Z' (both canonicalized).
  Compared with zero tolerance: those 8 integer columns for every
  (source,model,hour_start) bucket, plus per-source/day and per-model/day token
  sums. NOT compared in v1: total_cost_usd (REAL, B6 pricing) and
  usage_precision (TEXT). The store is built in B1/B2, so a green diff before
  that only proves the harness wiring; re-verify column names when B2 lands.
`;

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n\n${HELP}`);
    return 2;
  }
  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    if (opts.buildFixtures) return cmdBuildFixtures(opts);
    if (opts.selfTest) return cmdAggregatesSelfTest(opts);
    if (opts.ttAggregatesOnly) return cmdTtAggregatesOnly(opts);
    if (opts.aggregates) return cmdAggregatesCompare(opts);
    if (opts.hlDb) return cmdDiff(opts);
    return cmdTtOnly(opts);
  } catch (error) {
    process.stderr.write(`error: ${error && error.stack ? error.stack : String(error)}\n`);
    return 2;
  }
}

function parseArgs(argv) {
  const opts = {
    help: false,
    buildFixtures: false,
    ttOnly: false,
    sync: false,
    json: false,
    selfTest: false,
    ttAggregatesOnly: false,
    aggregates: null,
    home: HOME_DIR,
    queue: null,
    ttCli: null,
    hlDb: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "--build-fixtures") opts.buildFixtures = true;
    else if (arg === "--tt-only") opts.ttOnly = true;
    else if (arg === "--sync") opts.sync = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--self-test") opts.selfTest = true;
    else if (arg === "--tt-aggregates-only") opts.ttAggregatesOnly = true;
    else if (arg === "--aggregates") opts.aggregates = path.resolve(next());
    else if (arg === "--home") opts.home = path.resolve(next());
    else if (arg === "--queue") opts.queue = path.resolve(next());
    else if (arg === "--tt-cli") opts.ttCli = path.resolve(next());
    else if (arg === "--hl-db") opts.hlDb = path.resolve(next());
    else throw new Error(`unknown option: ${arg}`);
  }
  return opts;
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function relToRoot(target) {
  const relative = path.relative(ROOT, target);
  return relative.startsWith("..") ? target : relative.split(path.sep).join("/");
}

function toInt(value) {
  if (value === null || value === undefined) return 0;
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : 0;
}

// TT emits ISO strings with milliseconds (`2026-03-14T01:00:00.000Z`) while the
// plan's SQL comment shows the minute form (`2026-03-14T01:00:00Z`). Normalize
// both sides through Date so the bucket key comparison is format-independent.
function canonicalHourStart(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
  return text.length;
}

function writeJson(file, value) {
  return writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    const reason = error && error.code === "ENOENT" ? "not found" : error.message;
    throw new Error(`${label} is unusable (${reason}): ${file}`);
  }
}

function dirSizeBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return total;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) total += dirSizeBytes(target);
    else if (entry.isFile()) total += fs.statSync(target).size;
  }
  return total;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

// ── Fixture builder ────────────────────────────────────────────────────────

// All fixtures are synthetic: structural JSON only (record types, timestamps,
// token counters, model ids). Prompt/response/code bodies use the literal
// placeholder "fixture" so no real user text can leak into the repo.
function buildFixtureHome(home) {
  const created = [];
  // The committed fixture home is tool-logs-only. Remove any historical TT
  // scratch dir so repo gates (scripts/check-js.js walks test/**) stay clean.
  fs.rmSync(path.join(home, ".tokentracker"), { recursive: true, force: true });

  const record = (file, bytes) => created.push({ file: relToRoot(file), bytes });

  // ---- Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----
  const codexRoot = path.join(home, ".codex");
  fs.rmSync(codexRoot, { recursive: true, force: true });

  const codexSessionMeta = (uuid, timestamp) => ({
    timestamp,
    type: "session_meta",
    payload: {
      session_id: uuid,
      id: uuid,
      timestamp,
      cwd: "C:\\fixtures\\codex-project",
      originator: "codex_cli_rs",
      cli_version: "0.142.4-fixture",
      source: "cli",
      model_provider: "fixture-provider",
      base_instructions: {},
    },
  });
  const codexTurnContext = (timestamp, model, turnId) => ({
    timestamp,
    type: "turn_context",
    payload: {
      turn_id: turnId,
      cwd: "C:\\fixtures\\codex-project",
      current_date: timestamp.slice(0, 10),
      timezone: "UTC",
      approval_policy: "never",
      sandbox_policy: { type: "read-only" },
      model,
      effort: "medium",
    },
  });
  const codexTokenCount = (timestamp, lastUsage, totalUsage) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: totalUsage,
        last_token_usage: lastUsage,
        model_context_window: 258400,
      },
      rate_limits: { limit_id: "fixture", limit_name: null, primary: null, secondary: null },
    },
  });
  // Codex reports input_tokens as the TOTAL prompt with the cached slice inside
  // it (upstream normalizeUsage subtracts cached before bucketing).
  const codexUsage = (input, cached, output, reasoning) => ({
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  });
  const codexTaskComplete = (timestamp, turnId) => ({
    timestamp,
    type: "event_msg",
    payload: { type: "task_complete", turn_id: turnId, last_agent_message: "fixture", duration_ms: 1000 },
  });
  const writeCodexRollout = (relativePath, lines) => {
    const file = path.join(codexRoot, "sessions", relativePath);
    writeText(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    record(file, fs.statSync(file).size);
  };

  // File 1: cumulative snapshots, two token_count events in one half-hour bucket.
  const uuid1 = "00000000-0000-4000-8000-000000000001";
  writeCodexRollout(
    path.join("2026", "03", "14", "rollout-2026-03-14T01-15-00-00000000-0000-4000-8000-000000000001.jsonl"),
    [
      codexSessionMeta(uuid1, "2026-03-14T01:15:00.000Z"),
      codexTurnContext("2026-03-14T01:15:01.000Z", "gpt-5.4-codex", "turn-1"),
      codexTokenCount(
        "2026-03-14T01:15:10.000Z",
        codexUsage(12000, 8000, 300, 100),
        codexUsage(12000, 8000, 300, 100),
      ),
      codexTokenCount(
        "2026-03-14T01:15:40.000Z",
        codexUsage(4000, 1000, 250, 50),
        codexUsage(16000, 9000, 550, 150),
      ),
      codexTaskComplete("2026-03-14T01:15:45.000Z", "turn-1"),
    ],
  );

  // File 2: second model + a torn trailing token_count line (appended write that
  // never completed) and a malformed terminated line at the very end. Neither
  // may contribute usage; the complete prefix must still be counted.
  const uuid2 = "00000000-0000-4000-8000-000000000002";
  const file2 = path.join(
    codexRoot,
    "sessions",
    "2026",
    "03",
    "14",
    "rollout-2026-03-14T02-05-00-00000000-0000-4000-8000-000000000002.jsonl",
  );
  const file2Text = [
    JSON.stringify(codexSessionMeta(uuid2, "2026-03-14T02:05:00.000Z")),
    JSON.stringify(codexTurnContext("2026-03-14T02:05:01.000Z", "gpt-5.2", "turn-2")),
    JSON.stringify(
      codexTokenCount(
        "2026-03-14T02:05:10.000Z",
        codexUsage(5000, 2000, 400, 0),
        codexUsage(5000, 2000, 400, 0),
      ),
    ),
    // Torn append: parser must stop before this record and not count it.
    '{"timestamp":"2026-03-14T02:06:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":7000',
    // Malformed but terminated line: tolerated (skip) by the parser.
    "{not-json}",
    "",
  ].join("\n");
  writeText(file2, file2Text);
  record(file2, fs.statSync(file2).size);

  // File 3: token events that cross a UTC day boundary (23:50 -> next 00:10).
  const uuid3 = "00000000-0000-4000-8000-000000000003";
  writeCodexRollout(
    path.join("2026", "03", "15", "rollout-2026-03-15T23-50-00-00000000-0000-4000-8000-000000000003.jsonl"),
    [
      codexSessionMeta(uuid3, "2026-03-15T23:50:00.000Z"),
      codexTurnContext("2026-03-15T23:50:01.000Z", "gpt-5.4-mini", "turn-3"),
      codexTokenCount(
        "2026-03-15T23:50:10.000Z",
        codexUsage(6000, 3000, 200, 50),
        codexUsage(6000, 3000, 200, 50),
      ),
      codexTokenCount(
        "2026-03-16T00:10:00.000Z",
        codexUsage(2000, 1000, 100, 0),
        codexUsage(8000, 4000, 300, 50),
      ),
    ],
  );

  // ---- DSH: ~/.dsh/sessions/<project>/<session>/session.v4.jsonl.zstd ----
  // Each appended record is its own zstd frame, matching the harness writer.
  const dshRoot = path.join(home, ".dsh");
  fs.rmSync(dshRoot, { recursive: true, force: true });
  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error("zlib.zstdCompressSync is unavailable (Node >= 23.8 required)");
  }
  const dshModelName = (value) => {
    const trimmed = String(value || "").trim();
    const slash = trimmed.lastIndexOf("/");
    return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  };
  const dshHeader = (sessionId, createdAt) => ({
    type: "session",
    version: 4,
    id: sessionId,
    createdAt,
    cwd: "D:\\fixtures\\dsh-project",
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: "standard",
  });
  const dshRequestHeader = (seq, timeMs, model) => ({
    type: "request/header",
    seq,
    time: timeMs,
    data: { header: { config: { model } } },
  });
  const dshAssistantMessage = (seq, timeMs, model, usage) => ({
    type: "assistant/message",
    seq,
    time: timeMs,
    data: {
      turn: 1,
      step: seq - 1,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fixture" }],
        source: { kind: "model", provider: "fixture-provider", model },
      },
      usage,
    },
  });
  const writeDshSession = (projectKey, sessionId, lines) => {
    const file = path.join(
      dshRoot,
      "sessions",
      projectKey,
      sessionId,
      "session.v4.jsonl.zstd",
    );
    const frames = lines.map((line) => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)));
    ensureDir(path.dirname(file));
    const bundle = Buffer.concat(frames);
    fs.writeFileSync(file, bundle);
    record(file, bundle.length);
  };

  const dshUsage = (input, output, cacheRead, cacheWrite, reasoning) => ({
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    reasoningTokens: reasoning,
  });

  const dshTime1 = Date.parse("2026-03-14T03:10:00.000Z");
  writeDshSession("--fixtures-dsh-project--", "session-00000000-0000-4000-8000-000000000011", [
    dshHeader("session-00000000-0000-4000-8000-000000000011", dshTime1 - 60_000),
    dshRequestHeader(1, dshTime1 - 59_000, "deepseek/deepseek-v4.1-flash"),
    dshAssistantMessage(2, dshTime1, "deepseek-v4.1-flash", dshUsage(3000, 400, 1200, 200, 100)),
    dshAssistantMessage(
      3,
      Date.parse("2026-03-14T03:40:00.000Z"),
      "deepseek-v4.1-flash",
      dshUsage(1500, 300, 800, 0, 40),
    ),
  ]);
  const dshTime2 = Date.parse("2026-03-15T00:20:00.000Z");
  writeDshSession("--fixtures-dsh-project--", "session-00000000-0000-4000-8000-000000000012", [
    dshHeader("session-00000000-0000-4000-8000-000000000012", dshTime2 - 60_000),
    dshRequestHeader(1, dshTime2 - 59_000, "deepseek/deepseek-v4.1-pro"),
    dshAssistantMessage(2, dshTime2, dshModelName("deepseek-v4.1-pro"), dshUsage(5000, 600, 0, 0, 50)),
  ]);

  // ---- OpenCode: ~/.local/share/opencode/opencode.db (synthetic SQLite) ----
  const opencodeRoot = path.join(home, ".local");
  fs.rmSync(opencodeRoot, { recursive: true, force: true });
  buildOpencodeDb(path.join(home, ".local", "share", "opencode", "opencode.db"), record);

  // Scratch state produced by the TT sync: never committed.
  writeText(path.join(home, ".gitignore"), ".tokentracker/\n");

  return {
    home,
    files: created.sort((a, b) => a.file.localeCompare(b.file)),
    totalBytes: created.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

function buildOpencodeDb(dbPath, record) {
  const { DatabaseSync } = require("node:sqlite");
  ensureDir(path.dirname(dbPath));
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE session_v2 (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        directory TEXT NOT NULL
      );
      CREATE TABLE session_message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        type TEXT NOT NULL,
        seq INTEGER NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);

    const insertMessage = db.prepare(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    );
    const insertSession = db.prepare(
      "INSERT INTO session_v2 (id, project_id, directory) VALUES (?, ?, ?)",
    );
    const insertSessionMessage = db.prepare(
      "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );

    // v1 `message` rows: flat modelID/providerID and nested tokens.cache.
    const v1 = [
      {
        id: "msg_fixture_0001",
        sessionID: "ses_fixture_0001",
        created: Date.parse("2026-03-14T04:05:00.000Z"),
        modelID: "glm-5",
        providerID: "fixture-provider",
        tokens: { input: 1000, output: 200, reasoning: 50, cache: { read: 300, write: 100 } },
      },
      {
        id: "msg_fixture_0002",
        sessionID: "ses_fixture_0001",
        created: Date.parse("2026-03-14T04:35:00.000Z"),
        modelID: "claude-sonnet-4-5",
        providerID: "fixture-provider",
        tokens: { input: 2400, output: 500, reasoning: 0, cache: { read: 800, write: 0 } },
      },
    ];
    for (const item of v1) {
      const data = {
        id: item.id,
        sessionID: item.sessionID,
        role: "assistant",
        time: { created: item.created },
        modelID: item.modelID,
        providerID: item.providerID,
        tokens: item.tokens,
        cost: 0,
      };
      insertMessage.run(item.id, item.sessionID, item.created, item.created, JSON.stringify(data));
    }
    // Non-assistant and zero-token rows must be ignored by the parser.
    const userCreated = Date.parse("2026-03-14T04:01:00.000Z");
    insertMessage.run(
      "msg_fixture_0003",
      "ses_fixture_0001",
      userCreated,
      userCreated,
      JSON.stringify({ id: "msg_fixture_0003", sessionID: "ses_fixture_0001", role: "user", time: { created: userCreated } }),
    );

    // v2 `session_message` rows: nested model object, joined session directory.
    insertSession.run("ses_fixture_v2_0001", "prj_fixture_0001", "D:/fixtures/opencode-project");
    const v2 = [
      {
        id: "msg_fixture_0101",
        sessionID: "ses_fixture_v2_0001",
        seq: 2,
        created: Date.parse("2026-03-15T09:05:00.000Z"),
        model: { providerID: "fixture-provider", id: "deepseek-v4.1-flash" },
        tokens: { input: 1800, output: 260, reasoning: 30, cache: { read: 400, write: 0 } },
      },
      {
        id: "msg_fixture_0102",
        sessionID: "ses_fixture_v2_0001",
        seq: 4,
        created: Date.parse("2026-03-15T09:35:00.000Z"),
        model: { providerID: "fixture-provider", id: "deepseek-v4.1-flash" },
        tokens: { input: 900, output: 140, reasoning: 20, cache: { read: 200, write: 50 } },
      },
    ];
    for (const item of v2) {
      const data = {
        id: item.id,
        sessionID: item.sessionID,
        role: "assistant",
        model: item.model,
        tokens: item.tokens,
        time: { created: item.created },
      };
      insertSessionMessage.run(
        item.id,
        item.sessionID,
        "assistant",
        item.seq,
        item.created,
        item.created,
        JSON.stringify(data),
      );
    }
  } finally {
    db.close();
  }
  record(dbPath, fs.statSync(dbPath).size);
}

function cmdBuildFixtures(opts) {
  removeRepoScratchState(opts.home);
  const result = buildFixtureHome(opts.home);
  removeRepoScratchState(opts.home);
  process.stdout.write("Fixture home rebuilt (synthetic; no real user text).\n");
  for (const entry of result.files) {
    process.stdout.write(`  ${formatBytes(entry.bytes).padStart(9)}  ${entry.file}\n`);
  }
  process.stdout.write(`Total fixture bytes: ${formatBytes(result.totalBytes)}\n`);
  process.stdout.write(
    `Home size on disk (includes .gitignore): ${formatBytes(dirSizeBytes(opts.home))}\n`,
  );
  process.stdout.write(`Home: ${relToRoot(opts.home)}\n`);
  process.stdout.write("Home contents: tool logs only (never .tokentracker/TT state).\n");
  process.stdout.write(`Golden dir: ${relToRoot(GOLDEN_DIR)}\n`);
  process.stdout.write(
    "\nNext:\n" +
      "  node scripts/usage-oracle-check.js --tt-only --sync\n",
  );
  return 0;
}

// ── TT queue replay -> golden ──────────────────────────────────────────────

function resolveTtCli(opts) {
  const candidates = [];
  if (opts.ttCli) candidates.push(opts.ttCli);
  if (process.env.TT_ORACLE_CLI) candidates.push(path.resolve(process.env.TT_ORACLE_CLI));
  candidates.push(DEFAULT_TT_CLI);
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(
    `TokenTracker CLI not found. Tried:\n${candidates.map((item) => `  - ${item}`).join("\n")}\n` +
      "Install it outside the repo (see test/fixtures/usage/home/README.md) or pass --tt-cli.",
  );
}

function readTtVersion(ttCli) {
  try {
    const packageFile = path.resolve(path.dirname(ttCli), "..", "package.json");
    const pkg = JSON.parse(fs.readFileSync(packageFile, "utf8"));
    return typeof pkg.version === "string" ? pkg.version : TT_VERSION;
  } catch (_error) {
    return TT_VERSION;
  }
}

// ── Out-of-repo scratch home ───────────────────────────────────────────────
// TokenTracker must NEVER run with USERPROFILE pointing at the committed
// fixture home: it writes `.tokentracker/` state (cursors, queue, and transient
// .js shims under tracker/app/bin) inside `<home>`, and repo gates such as
// scripts/check-js.js syntax-scan the whole `test/` tree. So the tool logs
// (`.codex/`, `.dsh/`, `.local/`, ...) are copied to a scratch home OUTSIDE the
// repository, TT runs there, and the scratch home is deleted afterwards. The
// in-repo fixture home stays tool-logs-only.
const FIXTURE_HOME_NON_TOOL_ENTRIES = new Set([
  ".gitignore",
  "README.md",
  ".tokentracker",
  "AppData",
]);

function isInsideRepo(target) {
  const relative = path.relative(ROOT, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function chooseScratchHomeDir() {
  const bases = [];
  if (process.env.TT_ORACLE_SCRATCH_DIR) bases.push(path.resolve(process.env.TT_ORACLE_SCRATCH_DIR));
  bases.push(os.tmpdir());
  // Fallback next to the one-time TT oracle install (outside this repo).
  bases.push(path.dirname(path.dirname(path.dirname(path.dirname(DEFAULT_TT_CLI)))));
  const tried = [];
  for (const base of bases) {
    const candidate = path.join(
      base,
      `hl-usage-oracle-home-${process.pid}-${Date.now().toString(36)}`,
    );
    if (isInsideRepo(candidate)) {
      tried.push(`${candidate} (inside repo; refused)`);
      continue;
    }
    try {
      fs.mkdirSync(candidate, { recursive: true });
      return candidate;
    } catch (error) {
      tried.push(`${candidate} (${error && error.code ? error.code : error})`);
    }
  }
  throw new Error(
    `cannot create a TokenTracker scratch home outside the repository. Tried:\n  ${tried.join("\n  ")}\n` +
      "Set TT_ORACLE_SCRATCH_DIR to a writable directory outside the repo.",
  );
}

function removeRepoScratchState(fixtureHome) {
  const trackerDir = path.join(fixtureHome, ".tokentracker");
  if (!fs.existsSync(trackerDir)) return false;
  process.stderr.write(
    `warning: found TokenTracker scratch data inside the in-repo fixture home (${relToRoot(trackerDir)}); ` +
      "removing it because TT must run against an out-of-repo scratch copy.\n",
  );
  fs.rmSync(trackerDir, { recursive: true, force: true });
  return true;
}

function createScratchHome(fixtureHome) {
  removeRepoScratchState(fixtureHome);
  const dir = chooseScratchHomeDir();
  const copied = [];
  try {
    for (const entry of fs.readdirSync(fixtureHome, { withFileTypes: true })) {
      if (FIXTURE_HOME_NON_TOOL_ENTRIES.has(entry.name)) continue;
      const source = path.join(fixtureHome, entry.name);
      const target = path.join(dir, entry.name);
      fs.cpSync(source, target, { recursive: true });
      copied.push(entry.name);
    }
    if (copied.length === 0) {
      throw new Error(`fixture home has no tool-log entries to copy: ${fixtureHome}`);
    }
  } catch (error) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (_cleanupError) {
      // ignore
    }
    throw error;
  }
  process.stdout.write(`$ scratch home (outside repo): ${dir}\n$ copied tool logs: ${copied.join(", ")}\n`);
  return {
    dir,
    copied,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        process.stdout.write(`$ scratch home removed: ${dir}\n`);
        return true;
      } catch (error) {
        process.stderr.write(
          `warning: could not remove scratch home ${dir}: ${error && error.message ? error.message : error}\n`,
        );
        return false;
      }
    },
  };
}

function ttSyncEnv(home) {
  const env = { ...process.env };
  // Fake home drives every default root. Remove overrides that would leak the
  // real user home into the oracle run.
  env.USERPROFILE = home;
  env.HOME = home;
  // Several Windows resolvers read APPDATA/LOCALAPPDATA directly (for example
  // CodeBuddy IDE logs and the Reasonix %APPDATA%\reasonix tree), which would
  // otherwise parse the REAL user data even with USERPROFILE redirected.
  env.APPDATA = path.join(home, "AppData", "Roaming");
  env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  for (const key of [
    "DSH_HOME",
    "TOKENTRACKER_DSH_HOME",
    "CODEX_HOME",
    "XDG_DATA_HOME",
    "OPENCODE_HOME",
    "KILO_HOME",
    "CLAUDE_CONFIG_DIR",
    "CODEBUDDY_HOME",
    "TOKENTRACKER_REASONIX_HOME",
    "REASONIX_STATE_HOME",
    "TOKENTRACKER_DEVICE_TOKEN",
    "TOKENTRACKER_LOCAL_SYNC_DEVICE_TOKEN",
    "TOKENTRACKER_INSFORGE_BASE_URL",
    "TOKENTRACKER_CLOUD_OWNER_ID",
    "TOKENTRACKER_CLOUD_DEVICE_ID",
    "TOKENTRACKER_LOCAL_SYNC_ATTEMPT_ID",
  ]) {
    delete env[key];
  }
  // Fully local: never probe WSL, opt out of telemetry/heartbeat.
  env.TOKENTRACKER_WSL_MODE = "native-only";
  env.TOKENTRACKER_NO_TELEMETRY = "1";
  env.DO_NOT_TRACK = "1";
  return env;
}

function runTtSync({ home, ttCli }) {
  // Fresh oracle state: a full cold scan from empty cursors is what makes the
  // golden deterministic across runs.
  const trackerDir = path.dirname(path.join(home, QUEUE_REL));
  fs.rmSync(trackerDir, { recursive: true, force: true });
  fs.mkdirSync(trackerDir, { recursive: true });

  const args = [ttCli, "sync", "--all-local-sources"];
  const display =
    `USERPROFILE=${home} APPDATA=<home>/AppData/Roaming LOCALAPPDATA=<home>/AppData/Local ` +
    `TOKENTRACKER_WSL_MODE=native-only TOKENTRACKER_NO_TELEMETRY=1 node ${args.join(" ")}`;
  process.stdout.write(`$ ${display}\n`);
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(process.execPath, args, {
      env: ttSyncEnv(home),
      cwd: path.dirname(ttCli),
      encoding: "utf8",
      timeout: 300000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    stderr = error && typeof error.stderr === "string" ? error.stderr : "";
    throw new Error(
      `TokenTracker sync failed${error && error.status !== undefined ? ` (exit ${error.status})` : ""}: ` +
        `${error && error.message ? error.message : String(error)}\n${stdout}${stderr}`,
    );
  }
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return { command: display };
}

function readQueueRows(queuePath) {
  if (!fs.existsSync(queuePath)) {
    throw new Error(
      `TokenTracker queue not found: ${queuePath}\n` +
        "Run with --sync to generate it: node scripts/usage-oracle-check.js --tt-only --sync",
    );
  }
  const text = fs.readFileSync(queuePath, "utf8");
  const latest = new Map();
  let parsedRows = 0;
  let skippedRows = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch (_error) {
      skippedRows += 1;
      continue;
    }
    const source = typeof raw.source === "string" ? raw.source.trim() : "";
    const model = typeof raw.model === "string" ? raw.model.trim() : "";
    const hourStart = canonicalHourStart(raw.hour_start);
    if (!source || !model || !hourStart) {
      skippedRows += 1;
      continue;
    }
    parsedRows += 1;
    // Append-only queue: the last row for a bucket key is authoritative (LWW).
    latest.set(`${source}|${model}|${hourStart}`, normalizeQueueRow(raw, source, model, hourStart));
  }
  const rows = [...latest.values()].sort(compareRows);
  return { rows, stats: { parsedRows, skippedRows, uniqueBuckets: rows.length } };
}

function normalizeQueueRow(raw, source, model, hourStart) {
  const row = {
    source,
    model,
    hour_start: hourStart,
  };
  for (const column of QUEUE_TOKEN_COLUMNS) row[column] = toInt(raw[column]);
  row.billable_total_tokens = toInt(
    raw.billable_total_tokens === undefined ? raw.total_tokens : raw.billable_total_tokens,
  );
  row.conversation_count = toInt(raw.conversation_count);
  if (typeof raw.usage_precision === "string" && raw.usage_precision.trim()) {
    row.usage_precision = raw.usage_precision.trim();
  }
  return row;
}

function compareRows(a, b) {
  if (a.source !== b.source) return a.source.localeCompare(b.source);
  if (a.hour_start !== b.hour_start) return a.hour_start.localeCompare(b.hour_start);
  return a.model.localeCompare(b.model);
}

function zeroTotals() {
  const totals = {};
  for (const column of INTEGER_COLUMNS) totals[column] = 0;
  return totals;
}

function addRowToTotals(totals, row) {
  for (const column of INTEGER_COLUMNS) {
    totals[column] += toInt(row[column]);
  }
}

function totalsEqual(a, b) {
  for (const column of INTEGER_COLUMNS) {
    if (toInt(a[column]) !== toInt(b[column])) return false;
  }
  return true;
}

function buildGolden(rows, meta) {
  const totals = zeroTotals();
  const bySourceDay = new Map();
  const byModelDay = new Map();
  for (const row of rows) {
    addRowToTotals(totals, row);
    const day = row.hour_start.slice(0, 10);
    for (const [map, key] of [
      [bySourceDay, `${row.source}\u0000${day}\u0000${row.source}`],
      [byModelDay, `${row.model}\u0000${day}\u0000${row.model}`],
    ]) {
      let entry = map.get(key);
      if (!entry) {
        entry = {
          key: key.split("\u0000")[2],
          day,
          ...zeroTotals(),
        };
        map.set(key, entry);
      }
      addRowToTotals(entry, row);
    }
  }
  const sortTotals = (map) =>
    [...map.values()].sort((a, b) => {
      if (a.key !== b.key) return a.key.localeCompare(b.key);
      return a.day.localeCompare(b.day);
    });
  return {
    rows: {
      schema: "usage-oracle-queue-v1",
      generator: "scripts/usage-oracle-check.js --tt-only",
      tt_version: meta.ttVersion,
      tt_ttl_note: "append-only queue replayed as LWW by source|model|hour_start",
      home: relToRoot(meta.home),
      row_count: rows.length,
      rows,
    },
    summary: {
      schema: "usage-oracle-summary-v1",
      generator: "scripts/usage-oracle-check.js --tt-only",
      tt_version: meta.ttVersion,
      home: relToRoot(meta.home),
      row_count: rows.length,
      totals,
      by_source_day: sortTotals(bySourceDay),
      by_model_day: sortTotals(byModelDay),
    },
  };
}

function cmdTtOnly(opts) {
  const fixtureHome = opts.home;
  if (!fs.existsSync(fixtureHome)) {
    throw new Error(`fixture home not found: ${fixtureHome}\nRun: node scripts/usage-oracle-check.js --build-fixtures`);
  }

  let ttCli = null;
  let ttVersion = TT_VERSION;
  let syncCommand = null;
  let queuePath = null;
  let scratch = null;

  if (opts.sync) {
    ttCli = resolveTtCli(opts);
    ttVersion = readTtVersion(ttCli);
    scratch = createScratchHome(fixtureHome);
    try {
      const result = runTtSync({ home: scratch.dir, ttCli });
      syncCommand = result.command;
      queuePath = opts.queue || path.join(scratch.dir, QUEUE_REL);
      writeGoldenFromQueue({ queuePath, fixtureHome, ttVersion, syncCommand });
    } finally {
      scratch.cleanup();
    }
    return 0;
  }

  // Replay-only: the queue is produced outside the repo, so require an
  // explicit path. Never recreate `.tokentracker/` under the fixture home.
  if (!opts.queue) {
    throw new Error(
      "no --queue given and --sync was not requested.\n" +
        "TokenTracker scratch state must live outside the fixture home, so replay-only mode needs an explicit queue path:\n" +
        "  node scripts/usage-oracle-check.js --tt-only --sync            # regenerate in an out-of-repo scratch home\n" +
        "  node scripts/usage-oracle-check.js --tt-only --queue <path/to/queue.jsonl>",
    );
  }
  queuePath = opts.queue;
  try {
    ttCli = resolveTtCli(opts);
    ttVersion = readTtVersion(ttCli);
  } catch (_error) {
    ttVersion = TT_VERSION; // replay-only still needs no CLI
  }
  writeGoldenFromQueue({ queuePath, fixtureHome, ttVersion, syncCommand: null });
  return 0;
}

function writeGoldenFromQueue({ queuePath, fixtureHome, ttVersion, syncCommand }) {
  const displayQueue = isInsideRepo(queuePath) ? relToRoot(queuePath) : queuePath;
  process.stdout.write(`Reading queue: ${displayQueue}\n`);
  const { rows, stats } = readQueueRows(queuePath);

  const { rows: goldenRows, summary } = buildGolden(rows, { home: fixtureHome, ttVersion });
  const rowsFile = path.join(GOLDEN_DIR, GOLDEN_ROWS);
  const summaryFile = path.join(GOLDEN_DIR, GOLDEN_SUMMARY);
  writeJson(rowsFile, goldenRows);
  writeJson(summaryFile, summary);

  const perSource = new Map();
  for (const row of rows) perSource.set(row.source, (perSource.get(row.source) || 0) + 1);
  process.stdout.write("\nGolden written:\n");
  process.stdout.write(`  ${relToRoot(rowsFile)}  (${rows.length} bucket rows)\n`);
  process.stdout.write(`  ${relToRoot(summaryFile)}  (per-source/per-model daily totals)\n`);
  process.stdout.write(
    `Queue lines: ${stats.parsedRows} parsed, ${stats.skippedRows} skipped, ${stats.uniqueBuckets} unique buckets\n`,
  );
  process.stdout.write(
    `Buckets by source: ${[...perSource.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([source, count]) => `${source}=${count}`)
      .join(", ")}\n`,
  );
  if (rows.length === 0) {
    throw new Error("golden would be empty: the fixture home produced no queue rows");
  }

  process.stdout.write("\nReproduce:\n");
  process.stdout.write("  node scripts/usage-oracle-check.js --build-fixtures\n");
  process.stdout.write("  node scripts/usage-oracle-check.js --tt-only --sync\n");
  if (syncCommand) process.stdout.write(`  (oracle sync command): ${syncCommand}\n`);
}

// ── Diff Highlighter usage.db against golden ───────────────────────────────

function cmdDiff(opts) {
  const rowsFile = path.join(GOLDEN_DIR, GOLDEN_ROWS);
  if (!fs.existsSync(rowsFile)) {
    throw new Error(
      `golden rows missing: ${rowsFile}\nRun: node scripts/usage-oracle-check.js --tt-only --sync`,
    );
  }
  const golden = readJson(rowsFile, "golden rows");
  if (!Array.isArray(golden.rows)) throw new Error(`golden rows file has no rows array: ${rowsFile}`);
  if (!fs.existsSync(opts.hlDb)) {
    throw new Error(
      `Highlighter usage.db not found: ${opts.hlDb}\n` +
        "The store is built in B1/B2 (plan section 2.5); pass the real path once it exists.",
    );
  }

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(opts.hlDb, { readOnly: true });
  let dbRows;
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'usage_bucket'")
      .get();
    if (!table) {
      throw new Error(`usage_bucket table not found in ${opts.hlDb} (schema differs from plan section 2.5)`);
    }
    const columns = new Set(
      db.prepare("PRAGMA table_info(usage_bucket)").all().map((column) => column.name),
    );
    for (const column of ["source", "model", "hour_start", ...HL_INTEGER_COLUMNS]) {
      if (!columns.has(column)) {
        throw new Error(`usage_bucket is missing column "${column}" (expected per plan section 2.5)`);
      }
    }
    const select = ["source", "model", "hour_start", ...HL_INTEGER_COLUMNS].join(", ");
    dbRows = db.prepare(`SELECT ${select} FROM usage_bucket`).all().map((row) => {
      const normalized = {
        source: row.source,
        model: row.model,
        hour_start: canonicalHourStart(row.hour_start),
      };
      // Normalize to the TT queue vocabulary so every downstream comparison is
      // column-name identical.
      for (const column of INTEGER_COLUMNS) {
        normalized[column] = toInt(row[HL_COLUMN_BY_QUEUE_COLUMN[column]]);
      }
      return normalized;
    });
  } finally {
    db.close();
  }

  const goldenMap = new Map();
  for (const row of golden.rows) {
    goldenMap.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }
  const dbMap = new Map();
  for (const row of dbRows) {
    dbMap.set(`${row.source}|${row.model}|${row.hour_start}`, row);
  }

  const bucketDiffs = [];
  for (const [key, expected] of goldenMap) {
    const actual = dbMap.get(key);
    if (!actual) {
      bucketDiffs.push({ type: "missing_in_hl", key, expected });
      continue;
    }
    const mismatched = {};
    for (const column of INTEGER_COLUMNS) {
      const expectedValue = toInt(expected[column]);
      const actualValue = toInt(actual[column]);
      if (expectedValue !== actualValue) {
        mismatched[column] = { expected: expectedValue, actual: actualValue };
      }
    }
    if (Object.keys(mismatched).length > 0) bucketDiffs.push({ type: "value_mismatch", key, mismatched });
  }
  for (const key of dbMap.keys()) {
    if (!goldenMap.has(key)) bucketDiffs.push({ type: "extra_in_hl", key, actual: dbMap.get(key) });
  }

  // Daily sums: per source/day and per model/day, zero tolerance.
  const dailyDiffs = [];
  for (const [scope, keyField] of [
    ["source", "source"],
    ["model", "model"],
  ]) {
    const expectedSums = new Map();
    const actualSums = new Map();
    for (const row of golden.rows) {
      const key = `${row[keyField]}|${row.hour_start.slice(0, 10)}`;
      const totals = expectedSums.get(key) || zeroTotals();
      addRowToTotals(totals, row);
      expectedSums.set(key, totals);
    }
    for (const row of dbRows) {
      const key = `${row[keyField]}|${row.hour_start.slice(0, 10)}`;
      const totals = actualSums.get(key) || zeroTotals();
      for (const column of INTEGER_COLUMNS) totals[column] += toInt(row[column]);
      actualSums.set(key, totals);
    }
    for (const [key, expected] of expectedSums) {
      const actual = actualSums.get(key) || zeroTotals();
      if (!totalsEqual(expected, actual)) {
        dailyDiffs.push({ scope, day: key, expected, actual });
      }
    }
    for (const [key, actual] of actualSums) {
      if (!expectedSums.has(key)) dailyDiffs.push({ scope, day: key, expected: zeroTotals(), actual });
    }
  }

  const clean = bucketDiffs.length === 0 && dailyDiffs.length === 0;
  const report = {
    mode: "hl-db-diff",
    golden_rows_file: relToRoot(rowsFile),
    hl_db: opts.hlDb,
    golden_bucket_rows: goldenMap.size,
    hl_bucket_rows: dbMap.size,
    bucket_diff_count: bucketDiffs.length,
    daily_diff_count: dailyDiffs.length,
    bucket_diffs: bucketDiffs.slice(0, SAMPLE_DIFF_LIMIT),
    daily_diffs: dailyDiffs.slice(0, SAMPLE_DIFF_LIMIT),
    truncated: {
      bucket_diffs: bucketDiffs.length > SAMPLE_DIFF_LIMIT,
      daily_diffs: dailyDiffs.length > SAMPLE_DIFF_LIMIT,
    },
    verdict: clean ? "PASS" : "FAIL",
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("Oracle diff: Highlighter usage.db vs TokenTracker golden\n");
    process.stdout.write(`  golden: ${relToRoot(rowsFile)} (${goldenMap.size} buckets)\n`);
    process.stdout.write(`  hl db : ${opts.hlDb} (${dbMap.size} buckets)\n`);
    process.stdout.write(
      `  buckets: ${bucketDiffs.length} differences; daily sums: ${dailyDiffs.length} differences\n`,
    );
    for (const diff of report.bucket_diffs) {
      if (diff.type === "value_mismatch") {
        process.stdout.write(`  [bucket] ${diff.key}\n`);
        for (const [column, values] of Object.entries(diff.mismatched)) {
          process.stdout.write(`      ${column}: tt=${values.expected} hl=${values.actual}\n`);
        }
      } else {
        process.stdout.write(`  [bucket] ${diff.type} ${diff.key}\n`);
      }
    }
    for (const diff of report.daily_diffs) {
      process.stdout.write(`  [day:${diff.scope}] ${diff.day} differs on integer token sums\n`);
    }
    if (report.truncated.bucket_diffs || report.truncated.daily_diffs) {
      process.stdout.write(`  (showing first ${SAMPLE_DIFF_LIMIT} of each; use --json for details)\n`);
    }
    process.stdout.write(`\nVerdict: ${report.verdict}\n`);
    process.stdout.write("\nReproduce:\n");
    process.stdout.write("  node scripts/usage-oracle-check.js --tt-only --sync\n");
    process.stdout.write(`  node scripts/usage-oracle-check.js --hl-db ${opts.hlDb}\n`);
  }
  return clean ? 0 : 1;
}

// ── Aggregation-level oracle: TT local API capture ────────────────────────

function tzFileSlug(tz) {
  return tz.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const TZ_DAY_FORMATTERS = new Map();
function zonedDayKey(isoString, tz) {
  const parsed = Date.parse(isoString);
  if (!Number.isFinite(parsed)) return "";
  let formatter = TZ_DAY_FORMATTERS.get(tz);
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    } catch (_error) {
      formatter = null;
    }
    TZ_DAY_FORMATTERS.set(tz, formatter);
  }
  if (!formatter) return new Date(parsed).toISOString().slice(0, 10);
  return formatter.format(new Date(parsed));
}

function addDays(dayKey, delta) {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function mondayOf(dayKey) {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  const weekday = date.getUTCDay(); // 0 = Sunday
  const offset = weekday === 0 ? -6 : 1 - weekday;
  return addDays(dayKey, offset);
}

function lastDayOfMonth(dayKey) {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return addDays(nextMonth.toISOString().slice(0, 10), -1);
}

function periodRanges(rows, tz) {
  const days = [...new Set(rows.map((row) => zonedDayKey(row.hour_start, tz)).filter(Boolean))].sort();
  if (days.length === 0) throw new Error(`no queue days for tz ${tz}`);
  const minDay = days[0];
  const maxDay = days[days.length - 1];
  const weekStart = mondayOf(maxDay);
  return {
    days,
    ranges: {
      day: { from: maxDay, to: maxDay },
      week: { from: weekStart, to: addDays(weekStart, 6) },
      month: { from: `${maxDay.slice(0, 7)}-01`, to: lastDayOfMonth(maxDay) },
      total: { from: minDay, to: maxDay },
    },
  };
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startTtServe({ home, ttCli, port }) {
  const args = [ttCli, "serve", "--no-open", "--no-sync", "--port", String(port)];
  const display =
    `USERPROFILE=${home} APPDATA=<home>/AppData/Roaming LOCALAPPDATA=<home>/AppData/Local ` +
    `TOKENTRACKER_WSL_MODE=native-only TOKENTRACKER_NO_TELEMETRY=1 node ${args.join(" ")}`;
  process.stdout.write(`$ ${display}\n`);
  const state = { stdout: "", stderr: "", exited: false, exitCode: null };
  const child = spawn(process.execPath, args, {
    env: ttSyncEnv(home),
    cwd: path.dirname(ttCli),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const capture = (key, chunk) => {
    state[key] = (state[key] + String(chunk)).slice(-8000);
  };
  child.stdout?.on("data", (chunk) => capture("stdout", chunk));
  child.stderr?.on("data", (chunk) => capture("stderr", chunk));
  child.on("exit", (code) => {
    state.exited = true;
    state.exitCode = code;
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + AGGREGATES_SERVE_READY_TIMEOUT_MS;
  let ready = false;
  while (Date.now() < deadline) {
    if (state.exited) {
      throw new Error(
        `TokenTracker serve exited before becoming ready (code ${state.exitCode}).\n` +
          `stdout:\n${state.stdout}\nstderr:\n${state.stderr}`,
      );
    }
    try {
      const response = await fetch(`${baseUrl}/api/local-auth`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        ready = true;
        break;
      }
    } catch (_error) {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!ready) {
    try {
      child.kill();
    } catch (_error) {
      // ignore
    }
    throw new Error(
      `TokenTracker serve did not become ready in ${AGGREGATES_SERVE_READY_TIMEOUT_MS} ms.\n` +
        `stdout:\n${state.stdout}\nstderr:\n${state.stderr}`,
    );
  }
  return {
    baseUrl,
    display,
    logs: () => ({ stdout: state.stdout.trim(), stderr: state.stderr.trim() }),
    stop: async () => {
      if (state.exited) return;
      try {
        child.kill();
      } catch (_error) {
        // ignore
      }
      const deadline = Date.now() + 5000;
      while (!state.exited && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!state.exited) {
        try {
          child.kill("SIGKILL");
        } catch (_error) {
          // ignore
        }
      }
    },
  };
}

async function fetchTtJson(server, pathname, query) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const url = `${server.baseUrl}${pathname}${search.size > 0 ? `?${search}` : ""}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(AGGREGATES_FETCH_TIMEOUT_MS) });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`TT API ${pathname} -> HTTP ${response.status}: ${body.slice(0, 600)}`);
  }
  try {
    return JSON.parse(body);
  } catch (_error) {
    throw new Error(`TT API ${pathname} returned non-JSON: ${body.slice(0, 300)}`);
  }
}

function pickIntTotals(sourceTotals) {
  const totals = {};
  for (const column of AGGREGATE_ALL_TOKEN_COLUMNS) totals[column] = toInt(sourceTotals?.[column]);
  if (sourceTotals && sourceTotals.conversation_count !== undefined) {
    totals.conversation_count = toInt(sourceTotals.conversation_count);
  }
  return totals;
}

function normalizeTtSummary(payload, range) {
  const totals = pickIntTotals(payload?.totals);
  totals.conversation_count = toInt(payload?.totals?.conversation_count);
  let rolling = null;
  if (payload?.rolling) {
    const one = payload.rolling.last_7d || {};
    const thirty = payload.rolling.last_30d || {};
    rolling = {
      // TT derives rolling from/to from the machine's current date, so only the
      // stable counters are stored and compared.
      last_7d: {
        active_days: toInt(one.active_days),
        totals: {
          billable_total_tokens: toInt(one.totals?.billable_total_tokens),
          conversation_count: toInt(one.totals?.conversation_count),
        },
      },
      last_30d: {
        active_days: toInt(thirty.active_days),
        totals: {
          billable_total_tokens: toInt(thirty.totals?.billable_total_tokens),
          conversation_count: toInt(thirty.totals?.conversation_count),
        },
        avg_per_active_day: toInt(thirty.avg_per_active_day),
      },
    };
  }
  return { from: range.from, to: range.to, days: toInt(payload?.days), totals, rolling };
}

function normalizeTtDaily(payload, range) {
  const rows = (Array.isArray(payload?.data) ? payload.data : [])
    .map((row) => {
      const out = { day: typeof row.day === "string" ? row.day : "" };
      for (const column of AGGREGATE_ALL_TOKEN_COLUMNS) out[column] = toInt(row[column]);
      out.conversation_count = toInt(row.conversation_count);
      return out;
    })
    .filter((row) => row.day)
    .sort((a, b) => a.day.localeCompare(b.day));
  return { from: range.from, to: range.to, rows };
}

function normalizeTtBreakdown(payload, range) {
  const sources = (Array.isArray(payload?.sources) ? payload.sources : [])
    .map((source) => ({
      source: String(source?.source || "unknown"),
      source_scope: typeof source?.source_scope === "string" ? source.source_scope : null,
      totals: pickIntTotals(source?.totals),
      models: (Array.isArray(source?.models) ? source.models : [])
        .map((model) => ({
          model: String(model?.model || model?.model_id || "unknown"),
          totals: pickIntTotals(model?.totals),
        }))
        .sort((a, b) => a.model.localeCompare(b.model)),
    }))
    .sort((a, b) => a.source.localeCompare(b.source));
  return { from: range.from, to: range.to, sources };
}

function normalizeTtHeatmap(payload, weeks) {
  const cells = [];
  for (const week of Array.isArray(payload?.weeks) ? payload.weeks : []) {
    for (const cell of Array.isArray(week) ? week : []) {
      const billable = toInt(cell?.billable_total_tokens);
      const total = toInt(cell?.total_tokens);
      const level = toInt(cell?.level);
      if (billable === 0 && total === 0 && level === 0) continue;
      if (typeof cell?.day !== "string" || !cell.day) continue;
      cells.push({
        day: cell.day,
        total_tokens: total,
        billable_total_tokens: billable,
        level,
      });
    }
  }
  cells.sort((a, b) => a.day.localeCompare(b.day));
  return {
    weeks,
    week_starts_on: typeof payload?.week_starts_on === "string" ? payload.week_starts_on : null,
    active_days: toInt(payload?.active_days),
    streak_days: toInt(payload?.streak_days),
    // Only cells with data are stored/compared: TT's 52-week grid starts
    // relative to the server run date, so its column alignment drifts daily.
    cells,
  };
}

const AGGREGATE_PERIOD_DEFINITIONS = {
  day: "the latest fixture local day that has usage",
  week: "Monday-start 7-day week containing the latest fixture local day (TT dashboard uses Monday weeks)",
  month: "calendar month containing the latest fixture local day",
  total: "fixture span (first..latest fixture local day); bounded subset of TT's rolling 24-month total",
};

async function captureTtAggregates({ server, rows, tz, home, ttVersion }) {
  const { days, ranges } = periodRanges(rows, tz);
  const doc = {
    schema: AGGREGATES_SCHEMA,
    generator: "scripts/usage-oracle-check.js --tt-aggregates-only",
    tt_version: ttVersion,
    home: relToRoot(home),
    tz,
    row_count: rows.length,
    local_days: days,
    period_definitions: AGGREGATE_PERIOD_DEFINITIONS,
    ranges,
    summary: {},
    daily: {},
    breakdown: {},
    heatmap: null,
    notes: {
      heatmap:
        "TT grid starts 52 weeks before its run date (week_starts_on:'sun'); only data-bearing cells are stored and compared (day/value/level), grid alignment is ignored.",
      cost: "total_cost_usd/pricing are out of scope for the usage page and are stripped.",
      rolling:
        "TT rolling 7/30d windows are relative to the machine's current date; only active_days/counters are stored.",
      total_period: "bounded to the fixture span, not TT's rolling 24-month window.",
    },
  };
  for (const period of AGGREGATES_PERIODS) {
    const { from, to } = ranges[period];
    const query = { from, to, tz };
    doc.summary[period] = normalizeTtSummary(
      await fetchTtJson(server, AGGREGATE_ENDPOINTS.summary, query),
      { from, to },
    );
    doc.daily[period] = normalizeTtDaily(
      await fetchTtJson(server, AGGREGATE_ENDPOINTS.daily, query),
      { from, to },
    );
    doc.breakdown[period] = normalizeTtBreakdown(
      await fetchTtJson(server, AGGREGATE_ENDPOINTS.breakdown, query),
      { from, to },
    );
  }
  doc.heatmap = normalizeTtHeatmap(
    await fetchTtJson(server, AGGREGATE_ENDPOINTS.heatmap, { weeks: 52, tz }),
    Number(doc.heatmap?.weeks) || 52,
  );
  return doc;
}

async function cmdTtAggregatesOnly(opts) {
  const fixtureHome = opts.home;
  if (!fs.existsSync(fixtureHome)) {
    throw new Error(
      `fixture home not found: ${fixtureHome}\nRun: node scripts/usage-oracle-check.js --build-fixtures`,
    );
  }
  const ttCli = resolveTtCli(opts);
  const ttVersion = readTtVersion(ttCli);

  // TT must never write `.tokentracker/` inside the committed fixture tree, so
  // the tool logs are copied to a scratch home outside the repo for the whole
  // sync+serve+capture cycle, and deleted in `finally`.
  const scratch = createScratchHome(fixtureHome);
  const written = [];
  let server = null;
  try {
    // A deterministic aggregation capture needs a deterministic queue: run the
    // same local-only TT sync as --tt-only --sync (fresh scratch-home state).
    runTtSync({ home: scratch.dir, ttCli });
    const queuePath = opts.queue || path.join(scratch.dir, QUEUE_REL);
    const { rows } = readQueueRows(queuePath);
    if (rows.length === 0) throw new Error("fixture home produced no queue rows; cannot capture aggregates");

    ensureDir(GOLDEN_DIR);
    const port = await freeTcpPort();
    server = await startTtServe({ home: scratch.dir, ttCli, port });
    for (const tz of AGGREGATES_TZS) {
      const doc = await captureTtAggregates({ server, rows, tz, home: fixtureHome, ttVersion });
      const file = path.join(GOLDEN_DIR, `aggregates-${tzFileSlug(tz)}.json`);
      writeJson(file, doc);
      written.push({ file, tz, doc });
    }
    const logs = server.logs();
    if (logs.stderr) process.stderr.write(`${logs.stderr}\n`);
  } finally {
    if (server) await server.stop();
    scratch.cleanup();
    // Belt and braces: if anything (or an older checkout) ran TT against the
    // in-repo home, remove the scratch dir so repo gates stay clean.
    removeRepoScratchState(fixtureHome);
  }

  process.stdout.write("\nAggregation goldens written:\n");
  for (const entry of written) {
    const cellCount = entry.doc.heatmap ? entry.doc.heatmap.cells.length : 0;
    process.stdout.write(
      `  ${relToRoot(entry.file)}  (tz=${entry.tz}, ${AGGREGATES_PERIODS.length} periods x 3 views, heatmap cells=${cellCount})\n`,
    );
  }
  process.stdout.write(
    `  ranges per tz: ${written
      .map((entry) => `${entry.tz} day=${entry.doc.ranges.day.from} total=${entry.doc.ranges.total.from}..${entry.doc.ranges.total.to}`)
      .join("; ")}\n`,
  );
  process.stdout.write(
    `  scratch home used: ${scratch.dir} (removed); fixture home kept tool-logs-only\n`,
  );
  process.stdout.write("\nReproduce:\n");
  process.stdout.write("  node scripts/usage-oracle-check.js --build-fixtures\n");
  process.stdout.write("  node scripts/usage-oracle-check.js --tt-aggregates-only\n");
  process.stdout.write("  node scripts/usage-oracle-check.js --self-test\n");
  if (server) process.stdout.write(`  (TT serve command): ${server.display}\n`);
  return 0;
}

// ── Aggregation-level oracle: comparator ───────────────────────────────────

const AGGREGATE_VIEW_ALIASES = {
  summary: "summary",
  daily: "daily",
  breakdown: "breakdown",
  "model-breakdown": "breakdown",
  model_breakdown: "breakdown",
  modelbreakdown: "breakdown",
  heatmap: "heatmap",
};

function normalizeViewName(view) {
  const key = String(view || "").trim().toLowerCase();
  return AGGREGATE_VIEW_ALIASES[key] || null;
}

function aggregateKey(tz, view, period) {
  return `${tz}|${view}|${period}`;
}

function loadAggregateGoldens() {
  if (!fs.existsSync(GOLDEN_DIR)) return [];
  const files = fs
    .readdirSync(GOLDEN_DIR)
    .filter((name) => /^aggregates-.*\.json$/.test(name))
    .sort();
  return files.map((name) => {
    const file = path.join(GOLDEN_DIR, name);
    const doc = readJson(file, "aggregate golden");
    if (!doc || doc.schema !== AGGREGATES_SCHEMA) {
      throw new Error(`unexpected aggregate golden schema in ${name}: ${doc && doc.schema}`);
    }
    return { file, doc };
  });
}

function extractAggregateCaptureEntries(capture) {
  const entries = [];
  const pushEntry = (entry, defaults = {}) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const view = normalizeViewName(entry.view || entry.kind || entry.channel);
    const period = String(entry.period || "").trim().toLowerCase() || null;
    const payload =
      entry.payload !== undefined
        ? entry.payload
        : entry.response !== undefined
          ? entry.response
          : entry.body !== undefined
            ? entry.body
            : undefined;
    const tz = entry.tz || entry.timezone || defaults.tz || null;
    if (!view || !period || !tz || payload === undefined) return;
    entries.push({ tz: String(tz), view, period, payload });
  };
  const pushNested = (node, defaults = {}) => {
    if (!node || typeof node !== "object") return;
    for (const tz of Object.keys(node)) {
      const byTz = node[tz];
      if (!byTz || typeof byTz !== "object") continue;
      // { "<tz>": { "<view>": { "<period>": payload } } }
      for (const view of Object.keys(byTz)) {
        const canonicalView = normalizeViewName(view);
        if (!canonicalView) continue;
        const byPeriod = byTz[view];
        if (!byPeriod || typeof byPeriod !== "object") continue;
        for (const period of Object.keys(byPeriod)) {
          if (canonicalView === "heatmap") {
            pushEntry({ tz, view: canonicalView, period: "total", payload: byPeriod[period] });
          } else {
            pushEntry({ tz, view: canonicalView, period, payload: byPeriod[period] });
          }
        }
      }
      // { "<tz>": { captures: [...] } }
      if (Array.isArray(byTz.captures)) {
        for (const entry of byTz.captures) pushEntry(entry, { tz });
      }
    }
  };

  if (Array.isArray(capture)) {
    for (const entry of capture) pushEntry(entry);
    return entries;
  }
  if (!capture || typeof capture !== "object") return entries;
  if (Array.isArray(capture.captures)) {
    for (const entry of capture.captures) pushEntry(entry, { tz: capture.tz });
    return entries;
  }
  if (capture.captures && typeof capture.captures === "object") {
    pushNested(capture.captures, { tz: capture.tz });
    return entries;
  }
  if (capture.results && typeof capture.results === "object") {
    for (const entry of Object.values(capture.results)) {
      if (entry && typeof entry === "object" && (entry.view || entry.kind)) pushEntry(entry, { tz: capture.tz });
    }
    if (entries.length > 0) return entries;
    pushNested(capture.results, { tz: capture.tz });
    return entries;
  }
  // Bare nested tz map.
  pushNested(capture, { tz: capture.tz });
  return entries;
}

function addIntDiff(diffs, context, path, expectedValue, actualValue) {
  const expectedInt = toInt(expectedValue);
  const actualInt = toInt(actualValue);
  if (expectedInt !== actualInt) {
    diffs.push({
      ...context,
      kind: "value_mismatch",
      path,
      expected: expectedInt,
      actual: actualInt,
    });
  }
}

function isZeroAggregateRow(row) {
  for (const column of AGGREGATE_ALL_TOKEN_COLUMNS) {
    if (toInt(row?.[column]) !== 0) return false;
  }
  return toInt(row?.conversation_count) === 0;
}

function extractSummaryTotals(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (payload.totals && typeof payload.totals === "object") return payload.totals;
  if (payload.summary && typeof payload.summary === "object") return payload.summary;
  if (payload.data && typeof payload.data === "object" && payload.data.totals) return payload.data.totals;
  if (Array.isArray(payload.rows) && payload.rows.length === 0) return {};
  return null;
}

function diffAggregateSummary(expected, actualPayload, context) {
  const diffs = [];
  const totals = extractSummaryTotals(actualPayload);
  if (!totals) {
    diffs.push({ ...context, kind: "missing_payload_fields", path: "totals", message: "no totals object in Highlighter summary payload" });
    return diffs;
  }
  for (const column of AGGREGATE_ALL_TOKEN_COLUMNS) {
    addIntDiff(diffs, context, `totals.${column}`, expected.totals[column], totals[column]);
  }
  addIntDiff(
    diffs,
    context,
    "totals.conversation_count",
    expected.totals.conversation_count,
    totals.conversation_count,
  );
  if (actualPayload && actualPayload.days !== undefined && expected.days !== undefined) {
    addIntDiff(diffs, context, "days", expected.days, actualPayload.days);
  }
  const actualRolling = actualPayload && (actualPayload.rolling || (actualPayload.data && actualPayload.data.rolling));
  if (expected.rolling && actualRolling) {
    for (const window of ["last_7d", "last_30d"]) {
      const expectedWindow = expected.rolling[window];
      const actualWindow = actualRolling[window];
      addIntDiff(diffs, context, `rolling.${window}.active_days`, expectedWindow.active_days, actualWindow?.active_days);
      addIntDiff(
        diffs,
        context,
        `rolling.${window}.totals.billable_total_tokens`,
        expectedWindow.totals.billable_total_tokens,
        actualWindow?.totals?.billable_total_tokens,
      );
      addIntDiff(
        diffs,
        context,
        `rolling.${window}.totals.conversation_count`,
        expectedWindow.totals.conversation_count,
        actualWindow?.totals?.conversation_count,
      );
      if (window === "last_30d") {
        addIntDiff(
          diffs,
          context,
          "rolling.last_30d.avg_per_active_day",
          expectedWindow.avg_per_active_day,
          actualWindow?.avg_per_active_day,
        );
      }
    }
  }
  return diffs;
}

function extractDailyRows(payload) {
  if (!payload) return null;
  const candidates = [
    payload.data,
    payload.rows,
    payload.days,
    payload.daily,
    payload.data && payload.data.rows,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function diffAggregateDaily(expected, actualPayload, context) {
  const diffs = [];
  const actualRows = extractDailyRows(actualPayload);
  if (!actualRows) {
    diffs.push({ ...context, kind: "missing_payload_fields", path: "rows", message: "no daily rows array in Highlighter payload" });
    return diffs;
  }
  const actualByDay = new Map();
  for (const row of actualRows) {
    const day = typeof row?.day === "string" ? row.day : typeof row?.date === "string" ? row.date : "";
    if (day) actualByDay.set(day, row);
  }
  for (const expectedRow of expected.rows) {
    const actualRow = actualByDay.get(expectedRow.day);
    if (!actualRow) {
      diffs.push({ ...context, kind: "missing_day", path: expectedRow.day });
      continue;
    }
    for (const column of AGGREGATE_ALL_TOKEN_COLUMNS) {
      addIntDiff(diffs, context, `day[${expectedRow.day}].${column}`, expectedRow[column], actualRow[column]);
    }
    addIntDiff(
      diffs,
      context,
      `day[${expectedRow.day}].conversation_count`,
      expectedRow.conversation_count,
      actualRow.conversation_count,
    );
  }
  const expectedDays = new Set(expected.rows.map((row) => row.day));
  for (const [day, actualRow] of actualByDay) {
    if (expectedDays.has(day)) continue;
    // Highlighter daily payloads may zero-fill the requested range; extra
    // all-zero days are not a parity failure.
    if (!isZeroAggregateRow(actualRow)) {
      diffs.push({ ...context, kind: "extra_day", path: day });
    }
  }
  return diffs;
}

function extractBreakdownSources(payload) {
  if (!payload) return null;
  const direct = payload.sources || (payload.data && payload.data.sources) || (payload.breakdown && payload.breakdown.sources);
  if (Array.isArray(direct)) return direct;
  const models = payload.models || (payload.data && payload.data.models);
  if (Array.isArray(models)) {
    // Flat model list: group by source when the payload carries one.
    const grouped = new Map();
    for (const model of models) {
      const source = String(model?.source || model?.sourceId || "unknown");
      if (!grouped.has(source)) grouped.set(source, { source, models: [] });
      grouped.get(source).models.push(model);
    }
    return [...grouped.values()];
  }
  return null;
}

function extractBreakdownTotals(node) {
  if (!node || typeof node !== "object") return null;
  if (node.totals && typeof node.totals === "object") return node.totals;
  if (node.data && typeof node.data === "object" && node.data.totals) return node.data.totals;
  return node;
}

function compareShare(diffs, context, path, expectedShare, actualNode) {
  if (!actualNode || typeof actualNode !== "object") return;
  const raw =
    actualNode.sharePct !== undefined
      ? actualNode.sharePct
      : actualNode.share_pct !== undefined
        ? actualNode.share_pct
        : actualNode.share !== undefined
          ? actualNode.share
          : null;
  if (raw === null || raw === undefined) return;
  const actual = Number(raw);
  if (!Number.isFinite(actual)) {
    diffs.push({ ...context, kind: "bad_share_pct", path, actual: raw });
    return;
  }
  if (Math.abs(actual - expectedShare) > 0.01) {
    diffs.push({
      ...context,
      kind: "share_mismatch",
      path,
      expected: Number(expectedShare.toFixed(4)),
      actual: Number(actual.toFixed(4)),
    });
  }
}

function diffAggregateBreakdown(expected, actualPayload, context) {
  const diffs = [];
  const actualSources = extractBreakdownSources(actualPayload);
  if (!actualSources) {
    diffs.push({ ...context, kind: "missing_payload_fields", path: "sources", message: "no sources array in Highlighter breakdown payload" });
    return diffs;
  }
  const globalTotal = expected.sources.reduce((sum, source) => sum + toInt(source.totals.total_tokens), 0);
  const actualBySource = new Map(actualSources.map((source) => [String(source?.source || "unknown"), source]));
  for (const expectedSource of expected.sources) {
    const actualSource = actualBySource.get(expectedSource.source);
    if (!actualSource) {
      diffs.push({ ...context, kind: "missing_source", path: expectedSource.source });
      continue;
    }
    const actualTotals = extractBreakdownTotals(actualSource) || {};
    for (const column of AGGREGATE_REQUIRED_TOKEN_COLUMNS) {
      addIntDiff(
        diffs,
        context,
        `source[${expectedSource.source}].totals.${column}`,
        expectedSource.totals[column],
        actualTotals[column],
      );
    }
    for (const column of ["total_tokens", "billable_total_tokens", "reasoning_output_tokens"]) {
      if (actualTotals[column] !== undefined) {
        addIntDiff(
          diffs,
          context,
          `source[${expectedSource.source}].totals.${column}`,
          expectedSource.totals[column],
          actualTotals[column],
        );
      }
    }
    if (actualTotals.conversation_count !== undefined) {
      addIntDiff(
        diffs,
        context,
        `source[${expectedSource.source}].totals.conversation_count`,
        expectedSource.totals.conversation_count,
        actualTotals.conversation_count,
      );
    }
    if (globalTotal > 0) {
      compareShare(
        diffs,
        context,
        `source[${expectedSource.source}].sharePct`,
        (toInt(expectedSource.totals.total_tokens) / globalTotal) * 100,
        actualSource,
      );
    }
    const actualModels = Array.isArray(actualSource.models) ? actualSource.models : [];
    const actualModelsByKey = new Map(
      actualModels.map((model) => [String(model?.model || model?.model_id || model?.id || "unknown"), model]),
    );
    for (const expectedModel of expectedSource.models) {
      const actualModel = actualModelsByKey.get(expectedModel.model);
      if (!actualModel) {
        diffs.push({
          ...context,
          kind: "missing_model",
          path: `${expectedSource.source}/${expectedModel.model}`,
        });
        continue;
      }
      const modelTotals = extractBreakdownTotals(actualModel) || {};
      for (const column of AGGREGATE_REQUIRED_TOKEN_COLUMNS) {
        addIntDiff(
          diffs,
          context,
          `source[${expectedSource.source}].model[${expectedModel.model}].${column}`,
          expectedModel.totals[column],
          modelTotals[column],
        );
      }
      if (actualModel && actualModel.sharePct !== undefined && globalTotal > 0) {
        compareShare(
          diffs,
          context,
          `source[${expectedSource.source}].model[${expectedModel.model}].sharePct`,
          (toInt(expectedModel.totals.total_tokens) / globalTotal) * 100,
          actualModel,
        );
      }
    }
    for (const [modelKey] of actualModelsByKey) {
      if (!expectedSource.models.some((model) => model.model === modelKey)) {
        diffs.push({ ...context, kind: "extra_model", path: `${expectedSource.source}/${modelKey}` });
      }
    }
  }
  const expectedSources = new Set(expected.sources.map((source) => source.source));
  for (const [sourceKey] of actualBySource) {
    if (expectedSources.has(sourceKey)) continue;
    diffs.push({ ...context, kind: "extra_source", path: sourceKey });
  }
  return diffs;
}

function extractHeatmapCells(payload) {
  if (!payload) return null;
  const cells = [];
  const weeks = payload.weeks;
  if (Array.isArray(weeks) && weeks.some((week) => Array.isArray(week))) {
    for (const week of weeks) {
      if (!Array.isArray(week)) continue;
      for (const cell of week) {
        if (cell && typeof cell === "object") cells.push(cell);
      }
    }
    return cells;
  }
  for (const candidate of [payload.cells, payload.data, payload.days, payload.rows]) {
    if (Array.isArray(candidate)) {
      for (const cell of candidate) {
        if (cell && typeof cell === "object") cells.push(cell);
      }
      return cells;
    }
  }
  return null;
}

function heatmapCellValue(cell) {
  if (cell?.billable_total_tokens !== undefined) return toInt(cell.billable_total_tokens);
  if (cell?.value !== undefined) return toInt(cell.value);
  return toInt(cell?.total_tokens);
}

function diffAggregateHeatmap(expected, actualPayload, context) {
  const diffs = [];
  const cells = extractHeatmapCells(actualPayload);
  if (!cells) {
    diffs.push({ ...context, kind: "missing_payload_fields", path: "weeks", message: "no heatmap cells in Highlighter payload" });
    return diffs;
  }
  const actualActive = new Map();
  for (const cell of cells) {
    const day = typeof cell?.day === "string" ? cell.day : "";
    if (!day) continue;
    const value = heatmapCellValue(cell);
    const level = toInt(cell?.level);
    if (value === 0 && level === 0) continue;
    actualActive.set(day, { value, level });
  }
  for (const expectedCell of expected.cells) {
    const actualCell = actualActive.get(expectedCell.day);
    if (!actualCell) {
      diffs.push({ ...context, kind: "missing_heatmap_day", path: expectedCell.day });
      continue;
    }
    addIntDiff(
      diffs,
      context,
      `heatmap[${expectedCell.day}].value`,
      expectedCell.billable_total_tokens,
      actualCell.value,
    );
    addIntDiff(diffs, context, `heatmap[${expectedCell.day}].level`, expectedCell.level, actualCell.level);
  }
  const expectedDays = new Set(expected.cells.map((cell) => cell.day));
  for (const [day] of actualActive) {
    if (!expectedDays.has(day)) {
      diffs.push({ ...context, kind: "extra_heatmap_day", path: day });
    }
  }
  if (actualPayload && actualPayload.active_days !== undefined && expected.active_days !== undefined) {
    addIntDiff(diffs, context, "heatmap.active_days", expected.active_days, actualPayload.active_days);
  }
  return diffs;
}

function compareAggregateView(view, expected, actualPayload, context) {
  if (view === "summary") return diffAggregateSummary(expected, actualPayload, context);
  if (view === "daily") return diffAggregateDaily(expected, actualPayload, context);
  if (view === "breakdown") return diffAggregateBreakdown(expected, actualPayload, context);
  return diffAggregateHeatmap(expected, actualPayload, context);
}

function compareAggregates(goldens, capture) {
  const expected = new Map();
  for (const { doc } of goldens) {
    for (const period of AGGREGATES_PERIODS) {
      expected.set(aggregateKey(doc.tz, "summary", period), {
        tz: doc.tz,
        view: "summary",
        period,
        expected: doc.summary && doc.summary[period],
      });
      expected.set(aggregateKey(doc.tz, "daily", period), {
        tz: doc.tz,
        view: "daily",
        period,
        expected: doc.daily && doc.daily[period],
      });
      expected.set(aggregateKey(doc.tz, "breakdown", period), {
        tz: doc.tz,
        view: "breakdown",
        period,
        expected: doc.breakdown && doc.breakdown[period],
      });
    }
    expected.set(aggregateKey(doc.tz, "heatmap", "total"), {
      tz: doc.tz,
      view: "heatmap",
      period: "total",
      expected: doc.heatmap,
    });
  }

  const diffs = [];
  const missingCandidates = [];
  const actualMap = new Map();
  for (const entry of extractAggregateCaptureEntries(capture)) {
    actualMap.set(aggregateKey(entry.tz, entry.view, entry.period), entry);
  }
  const compared = [];
  for (const [key, target] of expected) {
    const actualEntry = actualMap.get(key);
    if (!actualEntry) {
      missingCandidates.push({ key, tz: target.tz, view: target.view, period: target.period });
      continue;
    }
    actualMap.delete(key);
    compared.push(key);
    const context = { key, tz: target.tz, view: target.view, period: target.period };
    diffs.push(...compareAggregateView(target.view, target.expected, actualEntry.payload, context));
  }
  const extraCandidates = [...actualMap.keys()];
  const failureCount = diffs.length + missingCandidates.length + extraCandidates.length;
  return {
    expectedCount: expected.size,
    comparedCount: compared.length,
    diffs,
    missingCandidates,
    extraCandidates,
    failureCount,
    verdict: failureCount === 0 ? "PASS" : "FAIL",
  };
}

function cmdAggregatesCompare(opts) {
  const goldens = loadAggregateGoldens();
  if (goldens.length === 0) {
    throw new Error(
      "no aggregation goldens found in test/fixtures/usage/golden/aggregates-*.json\n" +
        "Run: node scripts/usage-oracle-check.js --tt-aggregates-only",
    );
  }
  const capture = readJson(opts.aggregates, "Highlighter aggregates capture");
  const entries = extractAggregateCaptureEntries(capture);
  if (entries.length === 0) {
    throw new Error(
      "capture file has no usable entries; expected {schema:'hl-usage-aggregates-v1', captures:[{tz,view,period,payload}]} — see --help or test/fixtures/usage/golden/README.md",
    );
  }
  const result = compareAggregates(goldens, capture);

  const report = {
    mode: "aggregates-compare",
    golden_files: goldens.map((entry) => relToRoot(entry.file)),
    capture_file: opts.aggregates,
    capture_entries: entries.length,
    expected_entries: result.expectedCount,
    compared_entries: result.comparedCount,
    diff_count: result.diffs.length,
    missing_capture_entries: result.missingCandidates.slice(0, SAMPLE_DIFF_LIMIT),
    extra_capture_entries: result.extraCandidates.slice(0, SAMPLE_DIFF_LIMIT),
    sample_diffs: result.diffs.slice(0, SAMPLE_DIFF_LIMIT),
    truncated:
      result.diffs.length > SAMPLE_DIFF_LIMIT ||
      result.missingCandidates.length > SAMPLE_DIFF_LIMIT ||
      result.extraCandidates.length > SAMPLE_DIFF_LIMIT,
    verdict: result.verdict,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write("Aggregation oracle diff: Highlighter IPC payloads vs TokenTracker local API\n");
    process.stdout.write(`  goldens: ${goldens.map((entry) => relToRoot(entry.file)).join(", ")}\n`);
    process.stdout.write(`  capture: ${opts.aggregates} (${entries.length} entries)\n`);
    process.stdout.write(
      `  entries: ${result.comparedCount}/${result.expectedCount} compared; ` +
        `${result.diffs.length} value diffs; ${result.missingCandidates.length} missing; ${result.extraCandidates.length} extra\n`,
    );
    for (const missing of result.missingCandidates.slice(0, SAMPLE_DIFF_LIMIT)) {
      process.stdout.write(`  [missing] ${missing.key}\n`);
    }
    for (const extra of result.extraCandidates.slice(0, SAMPLE_DIFF_LIMIT)) {
      process.stdout.write(`  [extra]   ${extra}\n`);
    }
    for (const diff of report.sample_diffs) {
      if (diff.kind === "value_mismatch" || diff.kind === "share_mismatch") {
        process.stdout.write(
          `  [diff] ${diff.key} ${diff.path}: tt=${JSON.stringify(diff.expected)} hl=${JSON.stringify(diff.actual)}\n`,
        );
      } else {
        process.stdout.write(`  [diff] ${diff.key} ${diff.kind} ${diff.path || ""}\n`);
      }
    }
    if (report.truncated) {
      process.stdout.write(`  (showing first ${SAMPLE_DIFF_LIMIT}; use --json for the full list)\n`);
    }
    process.stdout.write(`\nVerdict: ${result.verdict}\n`);
    process.stdout.write(
      "\nNotes: heatmap compares day/value/level cells only (TT grid alignment is ignored); " +
        "total_cost_usd/pricing are out of scope.\n",
    );
    process.stdout.write("\nReproduce:\n");
    process.stdout.write("  node scripts/usage-oracle-check.js --tt-aggregates-only\n");
    process.stdout.write(`  node scripts/usage-oracle-check.js --aggregates ${opts.aggregates}\n`);
  }
  return result.verdict === "PASS" ? 0 : 1;
}

// ── Aggregation comparator self-test (synthetic PASS/FAIL cases) ───────────

function buildSyntheticAggregateGolden(tz = "UTC") {
  const totals = {
    input_tokens: 1000,
    output_tokens: 200,
    cached_input_tokens: 300,
    cache_creation_input_tokens: 40,
    reasoning_output_tokens: 10,
    total_tokens: 1550,
    billable_total_tokens: 1550,
    conversation_count: 2,
  };
  const day = "2026-03-14";
  const source = {
    source: "codex",
    source_scope: "local",
    totals: { ...totals, conversation_count: undefined },
    models: [{ model: "gpt-5.4-codex", totals: { ...totals, conversation_count: undefined } }],
  };
  // Strip undefined conversation_count from breakdown (TT breakdown has none).
  delete source.totals.conversation_count;
  delete source.models[0].totals.conversation_count;
  return {
    tz,
    summary: Object.fromEntries(
      AGGREGATES_PERIODS.map((period) => [period, { from: day, to: day, days: 1, totals: { ...totals }, rolling: null }]),
    ),
    daily: Object.fromEntries(
      AGGREGATES_PERIODS.map((period) => [period, { from: day, to: day, rows: [{ day, ...totals }] }]),
    ),
    breakdown: Object.fromEntries(
      AGGREGATES_PERIODS.map((period) => [
        period,
        { from: day, to: day, sources: [{ ...source, totals: { ...source.totals }, models: [{ ...source.models[0], totals: { ...source.models[0].totals } }] }] },
      ]),
    ),
    heatmap: {
      weeks: 52,
      week_starts_on: "sun",
      active_days: 1,
      streak_days: 0,
      cells: [{ day, total_tokens: 1550, billable_total_tokens: 1550, level: 4 }],
    },
  };
}

function buildSyntheticCapture(golden) {
  const captures = [];
  for (const period of AGGREGATES_PERIODS) {
    captures.push({
      tz: golden.tz,
      view: "summary",
      period,
      payload: JSON.parse(JSON.stringify(golden.summary[period])),
    });
    captures.push({
      tz: golden.tz,
      view: "daily",
      period,
      payload: { data: JSON.parse(JSON.stringify(golden.daily[period].rows)) },
    });
    captures.push({
      tz: golden.tz,
      view: "breakdown",
      period,
      payload: { sources: JSON.parse(JSON.stringify(golden.breakdown[period].sources)) },
    });
  }
  captures.push({
    tz: golden.tz,
    view: "heatmap",
    period: "total",
    payload: {
      weeks: [[...golden.heatmap.cells]],
      active_days: golden.heatmap.active_days,
    },
  });
  return { schema: AGGREGATES_CAPTURE_SCHEMA, captures };
}

function runSelfTestCase(name, golden, mutateCapture, expectVerdict) {
  const capture = buildSyntheticCapture(golden);
  if (typeof mutateCapture === "function") mutateCapture(capture);
  const result = compareAggregates([{ file: "<synthetic>", doc: golden }], capture);
  const passed = result.verdict === expectVerdict;
  return { name, expected: expectVerdict, actual: result.verdict, failureCount: result.failureCount, passed };
}

function cmdAggregatesSelfTest() {
  const golden = buildSyntheticAggregateGolden("UTC");
  const cases = [];

  cases.push(runSelfTestCase("exact-match", golden, null, "PASS"));
  cases.push(
    runSelfTestCase(
      "plus-one-token",
      golden,
      (capture) => {
        const entry = capture.captures.find((item) => item.view === "summary" && item.period === "day");
        entry.payload.totals.input_tokens += 1;
      },
      "FAIL",
    ),
  );
  cases.push(
    runSelfTestCase(
      "missing-source",
      golden,
      (capture) => {
        const entry = capture.captures.find((item) => item.view === "breakdown" && item.period === "day");
        entry.payload.sources = [];
      },
      "FAIL",
    ),
  );
  cases.push(
    runSelfTestCase(
      "shifted-heatmap-grid",
      golden,
      (capture) => {
        const entry = capture.captures.find((item) => item.view === "heatmap");
        // Same active cell, different week/column alignment: must still pass.
        entry.payload.weeks = [[], [], [{ ...entry.payload.weeks[0][0], day: entry.payload.weeks[0][0].day }]];
      },
      "PASS",
    ),
  );
  cases.push(
    runSelfTestCase(
      "cost-only-drift",
      golden,
      (capture) => {
        for (const entry of capture.captures) {
          if (entry.payload && typeof entry.payload === "object") {
            entry.payload.total_cost_usd = "999.000000";
            entry.payload.pricing = { model: "fake", input: 1 };
          }
        }
      },
      "PASS",
    ),
  );
  cases.push(
    runSelfTestCase(
      "zero-filled-extra-day",
      golden,
      (capture) => {
        const entry = capture.captures.find((item) => item.view === "daily" && item.period === "week");
        entry.payload.data.push({
          day: "2026-03-15",
          input_tokens: 0,
          output_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 0,
          billable_total_tokens: 0,
          conversation_count: 0,
        });
      },
      "PASS",
    ),
  );
  cases.push(
    runSelfTestCase(
      "missing-heatmap-day",
      golden,
      (capture) => {
        const entry = capture.captures.find((item) => item.view === "heatmap");
        entry.payload.weeks = [[]];
      },
      "FAIL",
    ),
  );

  const failed = cases.filter((item) => !item.passed);
  process.stdout.write("Aggregation comparator self-test (synthetic payloads):\n");
  for (const item of cases) {
    process.stdout.write(
      `  ${item.passed ? "ok  " : "FAIL"} ${item.name}: expected ${item.expected}, got ${item.actual} (${item.failureCount} failures)\n`,
    );
  }
  process.stdout.write(
    `\n${cases.length - failed.length}/${cases.length} cases behaved as expected\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

// main() is synchronous for most modes but the TT-serve capture mode is async,
// so resolve a possibly-promise result before setting the process exit code.
Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then((code) => {
    process.exitCode = typeof code === "number" ? code : 0;
  })
  .catch((error) => {
    process.stderr.write(`error: ${error && error.stack ? error.stack : String(error)}\n`);
    process.exitCode = 2;
  });
