'use strict'

const os = require('node:os')

function processKey(row) {
  return `${row.pid}:${row.createdAt}`
}

class ProcessResourceSeries {
  constructor({ rootPid, logicalProcessors = os.cpus().length, label = 'uncontrolled' }) {
    if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new TypeError('A positive root PID is required')
    if (!Number.isSafeInteger(logicalProcessors) || logicalProcessors <= 0) throw new TypeError('A positive CPU count is required')
    this.rootPid = rootPid
    this.logicalProcessors = logicalProcessors
    this.label = String(label).slice(0, 80)
    this.rootKey = null
    this.known = new Set()
    this.previous = null
    this.samples = []
    this.events = []
  }

  add(inventory, elapsedMs) {
    if (!Array.isArray(inventory) || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new TypeError('Invalid resource sample')
    if (this.previous && elapsedMs <= this.previous.elapsedMs) throw new RangeError('Sample time must increase')
    const rows = inventory.filter((row) => Number.isSafeInteger(row.pid) && row.pid > 0 &&
      Number.isSafeInteger(row.parentPid) && typeof row.createdAt === 'string' &&
      Number.isFinite(Date.parse(row.createdAt)))
    const root = rows.find((row) => row.pid === this.rootPid)
    if (!this.rootKey) {
      if (!root) throw new Error('Root process is unavailable')
      this.rootKey = processKey(root)
      this.known.add(this.rootKey)
    }
    // Previously observed descendants remain ours after a parent exits. A PID
    // alone is never sufficient: Windows reuses it for unrelated processes.
    const owned = new Map(rows.filter((row) => this.known.has(processKey(row))).map((row) => [row.pid, row]))
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) {
        if (owned.has(row.pid)) continue
        const parent = owned.get(row.parentPid)
        if (!parent || Date.parse(row.createdAt) < Date.parse(parent.createdAt)) continue
        owned.set(row.pid, row)
        changed = true
      }
    }
    const processes = [...owned.values()].map((row) => {
      this.known.add(processKey(row))
      return {
        pid: row.pid, parentPid: row.parentPid, createdAt: row.createdAt,
        name: String(row.name || 'unknown').slice(0, 80), role: String(row.role || 'unknown').slice(0, 32),
        available: row.available !== false,
        cpuSeconds: finiteOrNull(row.cpuSeconds),
        privateBytes: finiteOrNull(row.privateBytes), workingSetBytes: finiteOrNull(row.workingSetBytes),
        threadCount: finiteOrNull(row.threadCount), handleCount: finiteOrNull(row.handleCount)
      }
    }).sort((a, b) => a.pid - b.pid)
    const previousByKey = new Map((this.previous?.processes || []).map((row) => [processKey(row), row]))
    const currentKeys = new Set(processes.map(processKey))
    let cpuSeconds = 0
    let cpuComplete = !!this.previous
    for (const row of processes) {
      const previous = previousByKey.get(processKey(row))
      if (!previous) {
        this.events.push({ type: 'observed', elapsedMs, pid: row.pid, createdAt: row.createdAt, role: row.role })
        if (this.previous) cpuComplete = false
      } else if (row.cpuSeconds === null || previous.cpuSeconds === null || row.cpuSeconds < previous.cpuSeconds) {
        cpuComplete = false
      } else {
        cpuSeconds += row.cpuSeconds - previous.cpuSeconds
      }
    }
    for (const row of this.previous?.processes || []) {
      if (!currentKeys.has(processKey(row))) {
        this.events.push({ type: 'exited-or-unavailable', elapsedMs, pid: row.pid, createdAt: row.createdAt, role: row.role })
        // The final CPU time of an exited process is unavailable. Do not turn
        // a lower-bound measurement into an apparently precise total.
        cpuComplete = false
      }
    }
    const durationSeconds = this.previous ? (elapsedMs - this.previous.elapsedMs) / 1000 : 0
    const sample = {
      elapsedMs,
      rootAlive: !!root && processKey(root) === this.rootKey,
      processCount: processes.length,
      unavailableCount: processes.filter((row) => !row.available).length,
      privateBytes: sumAvailable(processes, 'privateBytes'),
      workingSetBytes: sumAvailable(processes, 'workingSetBytes'),
      threadCount: sumAvailable(processes, 'threadCount'),
      handleCount: sumAvailable(processes, 'handleCount'),
      cpuComplete,
      cpuPercent: cpuComplete ? 100 * cpuSeconds / durationSeconds / this.logicalProcessors : null,
      processes
    }
    this.samples.push(sample)
    this.previous = sample
    return sample
  }

  report() {
    const metric = (name) => summarize(this.samples.map((sample) => sample[name]))
    return {
      schemaVersion: 1, label: this.label, rootPid: this.rootPid, rootKey: this.rootKey,
      logicalProcessors: this.logicalProcessors,
      limitations: [
        'Process ancestry is sampled; a child born and exited between samples can be missed.',
        'Exited/new processes make interval CPU incomplete; those intervals are null.',
        'Working Set sums can count shared pages more than once.',
        'GPU and audio usage are not measured by this collector.'
      ],
      summary: {
        privateBytes: metric('privateBytes'), workingSetBytes: metric('workingSetBytes'),
        cpuPercent: metric('cpuPercent'), threadCount: metric('threadCount'), handleCount: metric('handleCount')
      },
      events: this.events, samples: this.samples
    }
  }
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function sumAvailable(rows, name) {
  if (rows.some((row) => row[name] === null)) return null
  return rows.reduce((sum, row) => sum + row[name], 0)
}

function summarize(values) {
  const valid = values.filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b)
  const at = (ratio) => valid.length ? valid[Math.max(0, Math.ceil(valid.length * ratio) - 1)] : null
  return { count: valid.length, missing: values.length - valid.length, mean: valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null, median: at(0.5), p95: at(0.95), max: at(1) }
}

module.exports = { ProcessResourceSeries, summarize }
