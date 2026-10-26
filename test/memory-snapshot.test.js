const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  classifyProcess,
  defaultOutPath,
  deriveAppDirFromElectronPath,
  formatReport,
  normalizeProcess,
  parseArgs,
  parseProcessJson,
  selectProcesses,
  summarizeSamples
} = require('../scripts/memory-snapshot')

test('classifyProcess reports Electron processes as chromium', () => {
  assert.equal(
    classifyProcess({
      name: 'Highlighter.exe',
      executablePath: 'D:\\Program Files\\Highlighter\\Highlighter.exe',
      commandLine: '"D:\\Program Files\\Highlighter\\Highlighter.exe" --type=renderer --user-data-dir=C:\\Users\\me\\AppData\\Roaming\\Highlighter'
    }),
    'chromium'
  )
  assert.equal(
    classifyProcess({
      name: 'electron.exe',
      executablePath: 'F:\\workspace\\Highlighter\\node_modules\\electron\\dist\\electron.exe',
      commandLine: 'electron.exe . --type=gpu-process'
    }),
    'chromium'
  )
})

test('classifyProcess covers every native sidecar executable', () => {
  const cases = [
    [
      { name: 'HighlighterOcrSidecar.exe', executablePath: 'D:\\app\\resources\\native\\ocr\\HighlighterOcrSidecar.exe' },
      'ocr-sidecar'
    ],
    [
      { name: 'HighlighterClipboard.exe', executablePath: 'D:\\app\\resources\\native\\clipboard\\HighlighterClipboard.exe' },
      'clipboard-sidecar'
    ],
    [
      {
        name: 'HighlighterEverything.exe',
        executablePath: 'D:\\app\\resources\\native\\everything-search\\HighlighterEverything.exe'
      },
      'everything-sidecar'
    ],
    [{ name: 'SmartSelect.exe', executablePath: 'D:\\app\\resources\\native\\smart-select\\SmartSelect.exe' }, 'smart-select'],
    [{ name: 'ffmpeg.exe', executablePath: 'D:\\app\\resources\\ffmpeg\\ffmpeg.exe' }, 'ffmpeg'],
    [{ name: 'ffmpeg.exe', executablePath: 'C:\\tools\\bin\\ffmpeg.exe' }, 'ffmpeg']
  ]
  for (const [process, role] of cases) assert.equal(classifyProcess(process), role)
})

test('classifyProcess uses path rules when the executable name is unknown', () => {
  assert.equal(
    classifyProcess({ name: 'helper.exe', executablePath: 'D:\\app\\native\\ocr\\helper.exe' }),
    'ocr-sidecar'
  )
  assert.equal(
    classifyProcess({ name: 'helper.exe', executablePath: 'D:\\app\\native\\everything-search\\bin\\helper.exe' }),
    'everything-sidecar'
  )
})

test('classifyProcess distinguishes managed and external Everything', () => {
  assert.equal(
    classifyProcess({
      name: 'HighlighterEverything.exe',
      executablePath: 'D:\\app\\native\\everything-search\\bin\\HighlighterEverything.exe'
    }),
    'everything-sidecar'
  )
  assert.equal(
    classifyProcess({ name: 'Everything.exe', executablePath: 'D:\\app\\native\\everything\\Everything.exe' }),
    'everything-external'
  )
  assert.equal(
    classifyProcess({
      name: 'Everything.exe',
      executablePath: 'C:\\Users\\me\\AppData\\Roaming\\Highlighter\\runtime\\everything\\Everything.exe'
    }),
    'everything-external'
  )
})

test('classifyProcess splits the two Node utilities by serviceName or commandLine', () => {
  assert.equal(
    classifyProcess({
      name: 'Highlighter.exe',
      executablePath: 'D:\\app\\Highlighter.exe',
      commandLine: '"D:\\app\\Highlighter.exe" --type=utility --utility-sub-type=node.mojom.NodeService',
      serviceName: 'highlighter-usage-scan'
    }),
    'usage-scan-utility'
  )
  assert.equal(
    classifyProcess({
      name: 'Highlighter.exe',
      commandLine: '"Highlighter.exe" --type=utility --highlighter-selection-hook-rounds=100'
    }),
    'selection-hook-utility'
  )
})

test('classifyProcess falls back to other for unknown or empty input', () => {
  assert.equal(classifyProcess({}), 'other')
  assert.equal(classifyProcess(), 'other')
  assert.equal(classifyProcess({ name: 'notepad.exe', executablePath: 'C:\\Windows\\notepad.exe' }), 'other')
  assert.equal(classifyProcess({ name: 'crashpad_handler.exe', executablePath: 'D:\\app\\crashpad_handler.exe' }), 'other')
})

test('parseProcessJson tolerates every PowerShell shape', () => {
  assert.deepEqual(parseProcessJson(''), [])
  assert.deepEqual(parseProcessJson('  \r\n\t '), [])
  assert.deepEqual(parseProcessJson('not json {'), [])
  assert.deepEqual(parseProcessJson('null'), [])
  assert.deepEqual(parseProcessJson('"just a string"'), [])
  assert.deepEqual(parseProcessJson('[]'), [])

  const single = parseProcessJson('\uFEFF{"ProcessId":11,"Name":"Highlighter.exe"}')
  assert.equal(single.length, 1)
  assert.equal(single[0].ProcessId, 11)

  const array = parseProcessJson('[{"ProcessId":1},{"ProcessId":2}]')
  assert.deepEqual(array.map((item) => item.ProcessId), [1, 2])

  const mixed = parseProcessJson('[null, {"ProcessId":3}, 7]')
  assert.deepEqual(mixed, [{ ProcessId: 3 }])
})

test('normalizeProcess converts CIM bytes into MiB and seconds', () => {
  assert.deepEqual(
    normalizeProcess({
      ProcessId: 42,
      ParentProcessId: 7,
      Name: 'HighlighterOcrSidecar.exe',
      ExecutablePath: 'D:\\app\\resources\\native\\ocr\\HighlighterOcrSidecar.exe',
      WorkingSetSize: 57 * 1024 * 1024,
      PageFileUsage: 50 * 1024,
      CpuSeconds: 1.2345
    }),
    {
      pid: 42,
      parentPid: 7,
      role: 'ocr-sidecar',
      name: 'HighlighterOcrSidecar.exe',
      executablePath: 'D:\\app\\resources\\native\\ocr\\HighlighterOcrSidecar.exe',
      workingSetMiB: 57,
      privateMiB: 50,
      cpuSeconds: 1.23
    }
  )

  // Get-Process shaped fallbacks (bytes instead of KiB).
  assert.deepEqual(
    normalizeProcess({
      Id: 9,
      ProcessName: 'ffmpeg.exe',
      WorkingSet64: 1024 * 1024,
      PrivateMemorySize64: 2 * 1024 * 1024,
      CPU: 3.333
    }),
    {
      pid: 9,
      parentPid: null,
      role: 'ffmpeg',
      name: 'ffmpeg.exe',
      executablePath: '',
      workingSetMiB: 1,
      privateMiB: 2,
      cpuSeconds: 3.33
    }
  )

  // A zero PageFileUsage is real data and must not fall back to PrivateMemorySize64.
  assert.equal(normalizeProcess({ ProcessId: 5, PageFileUsage: 0, PrivateMemorySize64: 1024 * 1024 }).privateMiB, 0)
  assert.equal(normalizeProcess(null), null)
  assert.equal(normalizeProcess({ Name: 'x.exe' }), null)
  assert.equal(normalizeProcess({ ProcessId: 0 }), null)
})

test('selectProcesses keeps app-directory processes and whitelisted names', () => {
  const records = [
    { ProcessId: 1, Name: 'helper.exe', ExecutablePath: 'C:\\app\\bin\\helper.exe', WorkingSetSize: 1024 * 1024 },
    { ProcessId: 2, Name: 'ffmpeg.exe', ExecutablePath: 'C:\\elsewhere\\ffmpeg.exe', WorkingSetSize: 1024 * 1024 },
    { ProcessId: 3, Name: 'notepad.exe', ExecutablePath: 'C:\\Windows\\notepad.exe', WorkingSetSize: 1024 * 1024 },
    { ProcessId: 4, Name: 'Highlighter.exe', ExecutablePath: 'c:\\APP\\Highlighter.exe', WorkingSetSize: 1024 * 1024 },
    { ProcessId: 5, Name: 'other.exe', ExecutablePath: 'C:\\application\\other.exe', WorkingSetSize: 1024 * 1024 }
  ]

  const selected = selectProcesses(records, { appDir: 'C:\\app\\' })
  assert.deepEqual(
    selected.map((process) => process.pid),
    [1, 2, 4]
  )
  assert.equal(selected[0].role, 'other')
  assert.equal(selected[1].role, 'ffmpeg')
  assert.equal(selected[2].role, 'chromium')

  assert.deepEqual(selectProcesses(null), [])
  assert.deepEqual(selectProcesses(records, { appDir: null, names: [] }), [])
  assert.equal(selectProcesses(records, { appDir: 'C:\\app', names: [] }).length, 2)
})

test('summarizeSamples averages memory and peaks per-role process counts', () => {
  const summary = summarizeSamples([
    {
      timestamp: '2026-10-26T13:00:00.000Z',
      processes: [
        { role: 'chromium', workingSetMiB: 100, privateMiB: 50, cpuSeconds: 1 },
        { role: 'ocr-sidecar', workingSetMiB: 20, privateMiB: 10, cpuSeconds: 0.5 }
      ]
    },
    {
      timestamp: '2026-10-26T13:00:02.000Z',
      processes: [
        { role: 'chromium', workingSetMiB: 60, privateMiB: 25, cpuSeconds: 1 },
        { role: 'chromium', workingSetMiB: 40, privateMiB: 25, cpuSeconds: 1 },
        { role: 'ffmpeg', workingSetMiB: 10, privateMiB: 5, cpuSeconds: 0.1 }
      ]
    }
  ])

  assert.deepEqual(summary, {
    sampleCount: 2,
    first: '2026-10-26T13:00:00.000Z',
    last: '2026-10-26T13:00:02.000Z',
    // Per-role memory is averaged over ALL samples (missing role counts as 0),
    // so sum(perRole averages) equals total averages.
    perRole: {
      chromium: { count: 2, workingSetMiB: 100, privateMiB: 50, cpu: 1.5 },
      'ocr-sidecar': { count: 1, workingSetMiB: 10, privateMiB: 5, cpu: 0.25 },
      ffmpeg: { count: 1, workingSetMiB: 5, privateMiB: 2.5, cpu: 0.05 }
    },
    total: { processCount: 3, workingSetMiB: 115, privateMiB: 57.5, cpu: 1.8 }
  })
})

test('summarizeSamples handles empty and malformed samples', () => {
  assert.deepEqual(summarizeSamples([]), {
    sampleCount: 0,
    first: null,
    last: null,
    perRole: {},
    total: { processCount: 0, workingSetMiB: 0, privateMiB: 0, cpu: 0 }
  })
  assert.deepEqual(summarizeSamples(undefined), {
    sampleCount: 0,
    first: null,
    last: null,
    perRole: {},
    total: { processCount: 0, workingSetMiB: 0, privateMiB: 0, cpu: 0 }
  })
  assert.deepEqual(summarizeSamples([{}]), {
    sampleCount: 1,
    first: null,
    last: null,
    perRole: {},
    total: { processCount: 0, workingSetMiB: 0, privateMiB: 0, cpu: 0 }
  })

  // Unknown roles are folded into `other` so totals stay complete.
  const folded = summarizeSamples([
    { timestamp: 't', processes: [{ role: 'weird-role', workingSetMiB: 1, privateMiB: 2, cpuSeconds: 0.5 }] }
  ])
  assert.deepEqual(folded.perRole.other, { count: 1, workingSetMiB: 1, privateMiB: 2, cpu: 0.5 })
  assert.deepEqual(folded.perRole.weirdRole, undefined)
})

test('parseArgs applies defaults and parses both flag forms', () => {
  assert.deepEqual(parseArgs([]), {
    label: 'snapshot',
    samples: 30,
    interval: 2000,
    appDir: null,
    out: null,
    help: false
  })

  const parsed = parseArgs([
    '--label',
    'tray-idle',
    '--samples=5',
    '--interval',
    '100',
    '--app-dir',
    'D:\\app',
    '--out',
    '.tmp-memory/custom.json'
  ])
  assert.equal(parsed.label, 'tray-idle')
  assert.equal(parsed.samples, 5)
  assert.equal(parsed.interval, 100)
  assert.equal(parsed.appDir, path.resolve('D:\\app'))
  assert.equal(parsed.out, path.resolve('.tmp-memory/custom.json'))
  assert.equal(parseArgs(['--help']).help, true)
})

test('parseArgs rejects malformed input', () => {
  assert.throws(() => parseArgs(['--bogus']), /未知参数/)
  assert.throws(() => parseArgs(['--label']), /缺少参数值/)
  assert.throws(() => parseArgs(['--label', '--samples']), /缺少参数值/)
  assert.throws(() => parseArgs(['--label=']), /不能为空/)
  assert.throws(() => parseArgs(['--samples', '0']), /正整数/)
  assert.throws(() => parseArgs(['--samples', 'abc']), /正整数/)
  assert.throws(() => parseArgs(['--interval', '-1']), /非负整数/)
})

test('formatReport renders role rows, totals, and an explicit empty table', () => {
  const emptyReport = formatReport(summarizeSamples([]), {
    label: 'smoke',
    platform: 'win32',
    appDir: 'D:\\app',
    generatedAt: '2026-10-26T13:00:00.000Z',
    requestedSamples: 1,
    failureCount: 0
  })
  assert.match(emptyReport, /内存快照：smoke/)
  assert.match(emptyReport, /\| 角色 \|/)
  assert.match(emptyReport, /（无匹配进程）/)
  assert.match(emptyReport, /\*\*合计\*\* \| 0 \| 0\.0 \| 0\.0 \| 0\.00/)

  const populatedReport = formatReport(
    summarizeSamples([
      {
        timestamp: 't',
        processes: [
          { role: 'ffmpeg', workingSetMiB: 3, privateMiB: 2, cpuSeconds: 0.1 },
          { role: 'chromium', workingSetMiB: 100, privateMiB: 50, cpuSeconds: 2 }
        ]
      }
    ])
  )
  assert.match(populatedReport, /\| chromium \| 1 \| 100\.0 \| 50\.0 \| 2\.00 \|/)
  assert.match(populatedReport, /\| ffmpeg \| 1 \| 3\.0 \| 2\.0 \| 0\.10 \|/)
  assert.ok(populatedReport.indexOf('| chromium |') < populatedReport.indexOf('| ffmpeg |'))
})

test('app directory helpers resolve packaged and dev layouts', () => {
  assert.equal(
    deriveAppDirFromElectronPath('F:\\workspace\\Highlighter\\node_modules\\electron\\dist\\electron.exe'),
    'F:\\workspace\\Highlighter'
  )
  assert.equal(
    deriveAppDirFromElectronPath('D:\\Program Files\\Highlighter\\Highlighter.exe'),
    'D:\\Program Files\\Highlighter'
  )
  assert.equal(deriveAppDirFromElectronPath(''), null)

  const outPath = defaultOutPath('smoke', new Date('2026-10-26T13:14:15.000Z'))
  assert.equal(path.basename(outPath), 'smoke-2026-10-26T13-14-15-000Z.json')
  assert.ok(outPath.includes(`${path.sep}.tmp-memory${path.sep}`))

  // A label is user input and becomes a filename: separators and reserved
  // characters are folded so `--label ../../evil` cannot escape .tmp-memory.
  const traversal = defaultOutPath('../../evil', new Date('2026-10-26T13:14:15.000Z'))
  assert.ok(traversal.startsWith(path.resolve('.tmp-memory') + path.sep))
  assert.equal(path.basename(traversal), '.._.._evil-2026-10-26T13-14-15-000Z.json')
  assert.equal(path.basename(defaultOutPath('..', new Date('2026-10-26T13:14:15.000Z'))), 'snapshot-2026-10-26T13-14-15-000Z.json')
})
