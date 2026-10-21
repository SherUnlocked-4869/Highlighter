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
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

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

const HELP = `Usage oracle harness (TokenTracker CLI -> Highlighter usage.db)

USAGE
  node scripts/usage-oracle-check.js --build-fixtures
  node scripts/usage-oracle-check.js --tt-only --sync
  node scripts/usage-oracle-check.js --tt-only
  node scripts/usage-oracle-check.js --hl-db <path/to/usage.db>

MODES
  --build-fixtures       Regenerate the sanitized fixture home (deterministic;
                         no real prompt/code content, only token counters).
  --tt-only              Read the TokenTracker queue.jsonl and write the golden
                         files (queue-rows.json + summary.json). Replays the
                         append-only queue as LWW by source|model|hour_start.
  --sync                 With --tt-only: run the TokenTracker CLI sync against
                         the fixture home first (fully local; no device token).
  --hl-db <path>         Diff a Highlighter usage.db against the golden files.
                         Zero tolerance on integer token columns; also compares
                         daily per-source and per-model sums. Exit 1 on any
                         mismatch, 2 on unusable input.

OPTIONS
  --home <dir>           Fixture home used as USERPROFILE (default:
                         test/fixtures/usage/home).
  --queue <file>         Override the TokenTracker queue.jsonl path (default:
                         <home>/.tokentracker/tracker/queue.jsonl).
  --tt-cli <file>        TokenTracker CLI entry (default: env TT_ORACLE_CLI, then
                         ${DEFAULT_TT_CLI}).
  --json                 Machine-readable report on stdout (diff mode).
  -h, --help             This help.

ENVIRONMENT (oracle sync only)
  USERPROFILE/HOME=<home>, DSH_HOME/CODEX_HOME/XDG_DATA_HOME/OPENCODE_HOME removed,
  TOKENTRACKER_WSL_MODE=native-only, TOKENTRACKER_NO_TELEMETRY=1, DO_NOT_TRACK=1.
  A fresh fake home has no device token, so TT sync cannot upload (upload is
  gated on runtime.deviceToken && runtime.baseUrl in sync.js).

REPRODUCE
  node scripts/usage-oracle-check.js --build-fixtures
  node scripts/usage-oracle-check.js --tt-only --sync
  # Highlighter side (once B1/B2 store exists):
  node scripts/usage-oracle-check.js --hl-db <dataRoot>/usage/usage.db

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
  const result = buildFixtureHome(opts.home);
  process.stdout.write("Fixture home rebuilt (synthetic; no real user text).\n");
  for (const entry of result.files) {
    process.stdout.write(`  ${formatBytes(entry.bytes).padStart(9)}  ${entry.file}\n`);
  }
  process.stdout.write(`Total fixture bytes: ${formatBytes(result.totalBytes)}\n`);
  process.stdout.write(
    `Home size on disk (includes .gitignore): ${formatBytes(dirSizeBytes(opts.home))}\n`,
  );
  process.stdout.write(`Home: ${relToRoot(opts.home)}\n`);
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
  const home = opts.home;
  if (!fs.existsSync(home)) {
    throw new Error(`fixture home not found: ${home}\nRun: node scripts/usage-oracle-check.js --build-fixtures`);
  }

  let ttCli = null;
  let ttVersion = TT_VERSION;
  let syncCommand = null;
  if (opts.sync) {
    ttCli = resolveTtCli(opts);
    ttVersion = readTtVersion(ttCli);
    const result = runTtSync({ home, ttCli });
    syncCommand = result.command;
  } else {
    try {
      ttCli = resolveTtCli(opts);
      ttVersion = readTtVersion(ttCli);
    } catch (_error) {
      ttVersion = TT_VERSION; // replay-only still needs no CLI
    }
  }

  const queuePath = opts.queue || path.join(home, QUEUE_REL);
  process.stdout.write(`Reading queue: ${relToRoot(queuePath)}\n`);
  const { rows, stats } = readQueueRows(queuePath);

  const { rows: goldenRows, summary } = buildGolden(rows, { home, ttVersion });
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
  process.stdout.write(`  node scripts/usage-oracle-check.js --tt-only --sync\n`);
  if (syncCommand) process.stdout.write(`  (oracle sync command): ${syncCommand}\n`);
  return 0;
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

process.exitCode = main(process.argv.slice(2));
