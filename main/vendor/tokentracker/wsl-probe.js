// Vendored from TokenTracker v1.4.7 (commit 148b758e, MIT) — see docs/third-party/LICENSE-TokenTracker.txt
//
// Modification V5: this file replaces upstream wsl-probe.js with a no-op stub.
// Upstream synchronously spawns `wsl.exe` (distro list, per-distro `whoami`)
// and copies SQLite databases out of `\\wsl$` UNC paths. Highlighter's AI Usage
// page is native-only by decision (plan §0.5 / S6), so this module performs no
// child-process and no network I/O at all: every probe reports "no WSL
// install" and every path helper passes native input through unchanged.
//
// Call sites were enumerated with `grep -o "wsl\.[A-Za-z0-9_]*"` over the
// vendored closure: defaultRunWsl, discoverWslHome, getWslMode, isUncPath,
// mapWslCwdToUnc, parseWslListVerbose, probeWslDistros, resolveAllWin32Paths,
// shouldProbeNative, shouldProbeWsl, snapshotSqliteDb.

const NATIVE_ONLY_MODE = "native-only";

function getWslMode() {
  return NATIVE_ONLY_MODE;
}

function shouldProbeWsl() {
  return false;
}

function shouldProbeNative() {
  return true;
}

function discoverWslHome() {
  return null;
}

function defaultRunWsl() {
  return "";
}

function parseWslListVerbose() {
  return [];
}

function probeWslDistros() {
  return [];
}

function isUncPath() {
  return false;
}

function mapWslCwdToUnc(cwd) {
  return cwd;
}

function snapshotSqliteDb(dbPath) {
  // Upstream copies the database and its WAL/SHM/journal sidecars to a temp
  // directory because SQLite locking is unreliable over the WSL 9P/SMB bridge.
  // WSL is disabled here, so callers always hold a native path: handing that
  // path back is equivalent and skips the extra copy.
  return {
    path: dbPath,
    cleanup() {},
  };
}

function resolveAllWin32Paths({ nativeValue, wslValue, env, platform } = {}) {
  void env;
  void wslValue;
  const currentPlatform = platform || process.platform;
  if (currentPlatform !== "win32") return { native: null, wsl: null };
  return { native: nativeValue ?? null, wsl: null };
}

module.exports = {
  defaultRunWsl,
  discoverWslHome,
  getWslMode,
  isUncPath,
  mapWslCwdToUnc,
  parseWslListVerbose,
  probeWslDistros,
  resolveAllWin32Paths,
  shouldProbeNative,
  shouldProbeWsl,
  snapshotSqliteDb,
};
