"use strict";

// Utility-process worker for the usage P0 runtime spike (B0-3).
//
// Probe only: it knows nothing about the product. It answers runtime primitive
// measurements requested by scripts/usage-p0-spike.js:
//   - hello handshake (cold start latency)
//   - structured-clone round trip (payload in, same payload echoed back)
//   - crash / busy / shutdown lifecycle probes

function parentPort() {
  return process.parentPort || null;
}

function epochMs() {
  return performance.timeOrigin + performance.now();
}

function send(message) {
  try {
    const port = parentPort();
    if (port) port.postMessage(message);
    else if (typeof process.send === "function") process.send(message);
  } catch (_error) {
    // The parent may already be gone; nothing useful to do in a probe.
  }
}

function handleMessage(raw) {
  const message =
    raw && typeof raw === "object" && "data" in raw && raw.data && typeof raw.data === "object"
      ? raw.data
      : raw;
  if (!message || typeof message !== "object") return;

  switch (message.type) {
    case "clone:roundtrip": {
      const receivedAt = epochMs();
      send({
        type: "clone:reply",
        id: message.id,
        label: message.label,
        receivedAt,
        payload: message.payload,
        workerNode: process.versions.node,
      });
      break;
    }
    case "crash": {
      // Uncaught exception, not process.exit: proves the parent observes an
      // abnormal utility-process termination.
      setImmediate(() => {
        throw new Error("usage-p0-worker: probe crash");
      });
      break;
    }
    case "busy": {
      // Keep working until the parent kills this process.
      const timer = setInterval(() => {
        send({ type: "busy:tick", at: epochMs() });
      }, 50);
      timer.unref?.();
      break;
    }
    case "shutdown": {
      send({ type: "bye", at: epochMs(), workerNode: process.versions.node });
      setTimeout(() => process.exit(0), 5);
      break;
    }
    default:
      break;
  }
}

function bindParent() {
  const port = parentPort();
  if (port) {
    port.on("message", handleMessage);
    return;
  }
  if (typeof process.on === "function") process.on("message", handleMessage);
}

bindParent();
send({
  type: "hello",
  node: process.versions.node,
  electron: process.versions.electron,
  pid: process.pid,
  createdAt: epochMs(),
});
