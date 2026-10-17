'use strict'

// Measures only a disabled prototype, not the whole application's G0 A/B gate.
const fs = require('node:fs')
const { parseArguments, collect } = require('./benchmark-clipboard')
const { probe } = require('./probe-clipboard-native')

async function run() {
  const args = process.argv.slice(2)
  for (let index = 0; index < args.length; index += 2) {
    if (!['--duration-seconds', '--interval-ms', '--output'].includes(args[index])) throw new Error(`Invalid argument: ${args[index]}`)
  }
  const options = parseArguments(['--root-pid', '1', '--label', 'native-prototype-disabled-no-listener', ...args])
  if (fs.existsSync(options.output)) throw new Error('Output exists; refusing to overwrite')
  let report
  const identity = await probe({
    timeoutMs: options.durationSeconds * 1000 + 60000,
    observe: async (pid, initialized) => {
      report = await collect({ ...options, rootPid: pid })
      report.observedState = { enabled: initialized.enabled, listenerStarted: false, capabilities: initialized.capabilities }
    }
  })
  report.nativeBuildId = identity.buildId
  fs.mkdirSync(require('node:path').dirname(options.output), { recursive: true })
  fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify({ output: options.output, samples: report.samples.length, summary: report.summary })}\n`)
}

if (require.main === module) run().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
