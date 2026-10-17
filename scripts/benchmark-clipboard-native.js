'use strict'

// Measures only a disabled prototype, not the whole application's G0 A/B gate.
const fs = require('node:fs')
const { parseArguments, collect } = require('./benchmark-clipboard')
const { probe } = require('./probe-clipboard-native')

async function run() {
  const args = process.argv.slice(2)
  const forwarded = []
  let mode
  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === '--mode') {
      if (mode || !['disabled', 'coordinator'].includes(args[index + 1])) throw new Error('Mode must be disabled or coordinator')
      mode = args[index + 1]
    } else {
      if (!['--duration-seconds', '--interval-ms', '--output'].includes(args[index])) throw new Error(`Invalid argument: ${args[index]}`)
      forwarded.push(args[index], args[index + 1])
    }
  }
  mode ||= 'disabled'
  const options = parseArguments(['--root-pid', '1', '--label', `native-prototype-${mode}-no-listener`, ...forwarded])
  if (fs.existsSync(options.output)) throw new Error('Output exists; refusing to overwrite')
  let report
  const identity = await probe({
    timeoutMs: options.durationSeconds * 1000 + 60000,
    observe: async (pid, initialized, request) => {
      if (mode === 'coordinator') {
        const started = await request('coordination.start', { hostPid: process.pid })
        if (!started.ok) throw new Error(`Coordinator start failed: ${started.error?.code}`)
      }
      report = await collect({ ...options, rootPid: pid })
      report.observedState = { enabled: initialized.enabled, listenerStarted: false, coordinatorRegistered: mode === 'coordinator', capabilities: initialized.capabilities }
      if (mode === 'coordinator' && !(await request('coordination.stop')).ok) throw new Error('Coordinator did not stop')
    }
  })
  report.nativeBuildId = identity.buildId
  fs.mkdirSync(require('node:path').dirname(options.output), { recursive: true })
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ output: options.output, samples: report.samples.length, summary: report.summary })}\n`)
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
