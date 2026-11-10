// R0-06 资源通道自检：窗口 media-b（非资源所有者，验证“窗口归属鉴权”是否真的生效）。
//
// 测试项：
//   command_own          B 调用自己拥有的资源：应成功（command 入口按 webview label 放行）
//   command_foreign      B 用合法 ID 调 A 的资源：应被 window-owner-mismatch 拒绝
//   protocol_foreign     B 用合法 URL 请求 A 的资源：协议处理器按 UriSchemeContext.webview_label()
//                        拒绝（预期 403）；这是“自定义协议能否识别调用窗口”的关键证据
//   protocol_unknown     同一窗口请求一个随机不存在的 ID：404（对照组）
//
// 宿主在 A 侧测试完成后把 phase 置为 "foreign"，B 轮询到该阶段后才发起请求，
// 避免与 A 的撤销/过期测试互相干扰。

(async () => {
  const invoke = window.__TAURI__.core.invoke
  const logLines = []
  const logElement = document.getElementById('log')
  const log = (line) => {
    logLines.push(line)
    if (logElement) logElement.textContent = logLines.join('\n')
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const errorText = (error) =>
    error && typeof error === 'object'
      ? `code=${error.code || ''} message=${error.message || String(error)}`
      : String(error)

  const results = { windowLabel: null, phase: null, tests: {} }
  async function test(name, body) {
    try {
      results.tests[name] = { ok: true, ...((await body()) || {}) }
    } catch (error) {
      results.tests[name] = { ok: false, error: errorText(error) }
    }
    const record = results.tests[name]
    log(`${name}: ${record.ok ? 'ok' : 'FAIL'}${record.error ? ' :: ' + record.error : ''}`)
  }

  let meta = null
  await test('meta', async () => {
    meta = await invoke('resource_meta')
    results.windowLabel = meta.windowLabel
    results.windowPlacement = meta.windowPlacement
    return { resources: meta.resources.map((item) => ({ tag: item.tag, byteLength: item.byteLength })) }
  })

  // 等待宿主阶段信号（A 侧测试完成 -> phase=foreign）。
  let phase = ''
  for (let attempt = 0; attempt < 160; attempt += 1) {
    const payload = await invoke('resource_phase')
    phase = payload.phase
    if (phase === 'foreign') break
    await sleep(250)
  }
  results.phase = phase
  log(`phase: ${phase || '(timeout)'}`)

  const own = ((meta && meta.resources) || []).find((item) => item.tag === 'b-owned')
  await test('command_own', async () => {
    if (!own) throw new Error('meta.b-owned missing')
    const bytes = await invoke('resource_command', { id: own.id })
    const length = bytes instanceof ArrayBuffer ? bytes.byteLength : (bytes.buffer ? bytes.buffer.byteLength : bytes.length)
    return { byteLength: length, expected: own.byteLength }
  })

  let foreign = null
  await test('foreign_id_probe', async () => {
    foreign = await invoke('resource_foreign_probe')
    return foreign
  })

  await test('command_foreign', async () => {
    if (!foreign || !foreign.id) throw new Error('foreign id unavailable')
    try {
      await invoke('resource_command', { id: foreign.id })
      return { rejected: false, note: '意外成功：command 未做窗口归属校验' }
    } catch (error) {
      return { rejected: true, error: errorText(error) }
    }
  })

  await test('protocol_foreign', async () => {
    if (!foreign || !foreign.url) throw new Error('foreign url unavailable')
    const response = await fetch(foreign.url, { cache: 'no-store' })
    const text = await response.text()
    return { status: response.status, body: text.slice(0, 300), rejected: response.status === 403 }
  })

  await test('protocol_unknown', async () => {
    const response = await fetch(`${'http://media.localhost'}/r/${'f'.repeat(32)}`, { cache: 'no-store' })
    const text = await response.text()
    return { status: response.status, body: text.slice(0, 200) }
  })

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await invoke('resource_report', { report: results })
      log('report delivered')
      break
    } catch (error) {
      log(`resource_report attempt ${attempt + 1} failed: ${errorText(error)}`)
      await sleep(300)
    }
  }
})()
