// Vendored from TokenTracker v1.4.7 (commit 148b758e, MIT) — see docs/third-party/LICENSE-TokenTracker.txt
//
// Modification V4: upstream read SQLite through an external `sqlite3` CLI first
// (execFileSync/execFile, which requires the binary to be on PATH) and only
// fell back to node:sqlite. That CLI branch is removed here: every read goes
// through the Electron runtime's built-in node:sqlite DatabaseSync opened in
// read-only mode. The module has no child process and no npm dependency, and
// the public API and return shapes are unchanged.

const fssync = require("node:fs");

const warnedSqliteReadFailures = new Set();

function isDebugEnabled(env = process.env) {
  const value = String((env && env.TOKENTRACKER_DEBUG) || "").toLowerCase();
  return value === "1" || value === "true";
}

function formatError(err) {
  if (!err) return "unknown error";
  return err && err.message ? err.message : String(err);
}

function warnSqliteUnavailable({ dbPath, label, nodeSqliteError, env, stderr }) {
  const key = `${label || "SQLite"}:${dbPath || ""}`;
  if (warnedSqliteReadFailures.has(key)) return;
  warnedSqliteReadFailures.add(key);

  const out = stderr && typeof stderr.write === "function" ? stderr : process.stderr;
  const displayLabel = label || "local";
  out.write(
    `[tokentracker] Cannot read ${displayLabel} SQLite database with node:sqlite. Path: ${dbPath}\n`,
  );
  if (isDebugEnabled(env)) {
    out.write(`[tokentracker] node:sqlite error: ${formatError(nodeSqliteError)}\n`);
  }
}

function isNodeSqliteUnavailable(err) {
  const message = formatError(err).toLowerCase();
  return (
    message.includes("no such built-in module") ||
    message.includes("cannot find module 'node:sqlite'") ||
    message.includes('cannot find module "node:sqlite"') ||
    message.includes("node:sqlite databasesync is unavailable")
  );
}

function readSqliteRowsWithNode(dbPath, sql, { requireFn }) {
  const { DatabaseSync } = requireFn("node:sqlite");
  if (typeof DatabaseSync !== "function") {
    throw new Error("node:sqlite DatabaseSync is unavailable");
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare(sql).all();
    return Array.isArray(rows) ? rows : [];
  } finally {
    db.close();
  }
}

function readSqliteJsonRows(dbPath, sql, options = {}) {
  if (!dbPath || !sql) return [];
  try {
    if (!fssync.existsSync(dbPath)) return [];
  } catch (_e) {
    return [];
  }
  const requireFn = options.requireFn || require;
  const env = options.env || process.env;
  const label = options.label || "local";

  let nodeSqliteError = null;
  try {
    return readSqliteRowsWithNode(dbPath, sql, { requireFn });
  } catch (err) {
    nodeSqliteError = err;
  }

  if (isNodeSqliteUnavailable(nodeSqliteError)) {
    warnSqliteUnavailable({
      dbPath,
      label,
      nodeSqliteError,
      env,
      stderr: options.stderr,
    });
  }
  if (options.throwOnReadFailure) {
    const err = new Error(
      `Cannot read ${label} SQLite database at ${dbPath}: ${formatError(nodeSqliteError)}`,
    );
    err.nodeSqliteError = nodeSqliteError;
    throw err;
  }
  return [];
}

// node:sqlite exposes no async API, so this keeps the async signature the
// upstream callers expect while running the same read-only path.
async function readSqliteJsonRowsAsync(dbPath, sql, options = {}) {
  return readSqliteJsonRows(dbPath, sql, options);
}

function readSqliteFirstValue(dbPath, sql, column, options = {}) {
  const rows = readSqliteJsonRows(dbPath, sql, options);
  const row = rows[0];
  if (!row || typeof row !== "object") return null;
  const key = typeof column === "string" && column.length > 0 ? column : Object.keys(row)[0];
  const value = row[key];
  return typeof value === "string" ? value.trim() : value == null ? null : String(value).trim();
}

function resetSqliteReaderWarningsForTests() {
  warnedSqliteReadFailures.clear();
}

module.exports = {
  readSqliteJsonRows,
  readSqliteJsonRowsAsync,
  readSqliteFirstValue,
  resetSqliteReaderWarningsForTests,
};
