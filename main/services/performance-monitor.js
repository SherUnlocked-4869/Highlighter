const { performance } = require('node:perf_hooks')

function round(value, digits = 2) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  const factor = 10 ** digits
  return Math.round(number * factor) / factor
}

function summarizeAppMetrics(metrics = []) {
  const summary = {
    processCount: 0,
    workingSetMiB: 0,
    peakWorkingSetMiB: 0,
    privateMiB: 0,
    cpuPercent: 0,
    byType: {}
  }

  for (const metric of Array.isArray(metrics) ? metrics : []) {
    const type = String(metric?.type || 'Unknown')
    const memory = metric?.memory || {}
    const workingSetKiB = Number(memory.workingSetSize) || 0
    const peakWorkingSetKiB = Number(memory.peakWorkingSetSize) || 0
    const privateKiB = Number(memory.privateBytes) || 0
    const cpuPercent = Number(metric?.cpu?.percentCPUUsage) || 0
    const bucket = summary.byType[type] || {
      processCount: 0,
      workingSetMiB: 0,
      privateMiB: 0,
      cpuPercent: 0
    }

    summary.processCount++
    summary.workingSetMiB += workingSetKiB / 1024
    summary.peakWorkingSetMiB += peakWorkingSetKiB / 1024
    summary.privateMiB += privateKiB / 1024
    summary.cpuPercent += cpuPercent
    bucket.processCount++
    bucket.workingSetMiB += workingSetKiB / 1024
    bucket.privateMiB += privateKiB / 1024
    bucket.cpuPercent += cpuPercent
    summary.byType[type] = bucket
  }

  for (const key of ['workingSetMiB', 'peakWorkingSetMiB', 'privateMiB', 'cpuPercent']) {
    summary[key] = round(summary[key])
  }
  for (const bucket of Object.values(summary.byType)) {
    for (const key of ['workingSetMiB', 'privateMiB', 'cpuPercent']) bucket[key] = round(bucket[key])
  }
  return summary
}

class PerformanceMonitor {
  constructor({
    logger,
    now = () => performance.now(),
    getAppMetrics = () => []
  } = {}) {
    this.logger = logger
    this.now = now
    this.getAppMetrics = getAppMetrics
  }

  begin(name, details = {}) {
    return {
      name: String(name || 'unknown'),
      startedAt: this.now(),
      details: details && typeof details === 'object' ? details : {}
    }
  }

  record(name, durationMs, details = {}) {
    const entry = {
      name: String(name || 'unknown'),
      durationMs: round(Math.max(0, Number(durationMs) || 0)),
      ...(details && typeof details === 'object' ? details : {})
    }
    this.logger?.event?.('performance', entry)
    return entry
  }

  finish(token, details = {}) {
    if (!token || typeof token !== 'object') throw new TypeError('Performance token is required')
    return this.record(token.name, this.now() - token.startedAt, {
      ...token.details,
      ...(details && typeof details === 'object' ? details : {})
    })
  }

  measure(name, operation, details = {}) {
    if (typeof operation !== 'function') throw new TypeError('Performance operation must be a function')
    const token = this.begin(name, details)
    try {
      const result = operation()
      if (!result || typeof result.then !== 'function') {
        this.finish(token, { outcome: 'success' })
        return result
      }
      return result.then(
        (value) => {
          this.finish(token, { outcome: 'success' })
          return value
        },
        (error) => {
          this.finish(token, { outcome: 'error', errorName: error?.name || 'Error' })
          throw error
        }
      )
    } catch (error) {
      this.finish(token, { outcome: 'error', errorName: error?.name || 'Error' })
      throw error
    }
  }

  snapshot(label, details = {}) {
    let metrics = []
    try {
      metrics = this.getAppMetrics()
    } catch {
      metrics = []
    }
    const entry = {
      label: String(label || 'snapshot'),
      ...summarizeAppMetrics(metrics),
      ...(details && typeof details === 'object' ? details : {})
    }
    this.logger?.event?.('performance-snapshot', entry)
    return entry
  }
}

module.exports = {
  PerformanceMonitor,
  round,
  summarizeAppMetrics
}
