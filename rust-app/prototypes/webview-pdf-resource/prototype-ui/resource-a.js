// R0-06 二进制资源通道自检：窗口 media-a（资源所有者与主要验证方）。
//
// 验证项（对应 docs/plans/rust-migration/r0-resource-channel.md 的证据表）：
//   image_protocol / image_command        图片显示（协议 vs command 二进制响应）
//   video_protocol_load/seek/play         视频加载、Range seek、播放与画布取证
//   range_manual/range_suffix/range_bad   显式 Range 请求的 206/416/Content-Range
//   video_command_path                    command 二进制响应能否覆盖视频（内存 vs 流）
//   unknown_id / traversal / expiring / revoked   拒绝路径
//   csp_block                              CSP 拦截与 securitypolicyviolation 事件
//   transport_command / transport_protocol 20 MiB 传输耗时对照（同一份数据）
//
// 结果通过 `resource_report` 命令交回宿主；宿主写入 .tmp-r0-resource/resource-report.json。

(async () => {
  const invoke = window.__TAURI__.core.invoke
  const base = 'http://media.localhost'
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
  const now = () => performance.now()

  const violations = []
  document.addEventListener('securitypolicyviolation', (event) => {
    violations.push({
      effectiveDirective: event.effectiveDirective,
      violatedDirective: event.violatedDirective,
      blockedURI: event.blockedURI,
      disposition: event.disposition,
      sample: event.sample
    })
  })

  const results = {
    windowLabel: null,
    userAgent: navigator.userAgent,
    base,
    tests: {},
    violations,
    console: []
  }

  function instrumentConsole() {
    const originalError = console.error
    console.error = function (...args) {
      results.console.push(args.map((value) => String(value)).join(' '))
      originalError.apply(console, args)
    }
  }
  instrumentConsole()

  async function test(name, body) {
    const started = now()
    try {
      const value = (await body()) || {}
      results.tests[name] = { ok: true, elapsedMs: Math.round((now() - started) * 10) / 10, ...value }
    } catch (error) {
      results.tests[name] = {
        ok: false,
        elapsedMs: Math.round((now() - started) * 10) / 10,
        error: errorText(error)
      }
    }
    const record = results.tests[name]
    log(`${name}: ${record.ok ? 'ok' : 'FAIL'} (${record.elapsedMs} ms)${record.error ? ' :: ' + record.error : ''}`)
  }

  function rangesOf(timeRanges) {
    const list = []
    if (!timeRanges) return list
    for (let index = 0; index < timeRanges.length; index += 1) {
      list.push([timeRanges.start(index), timeRanges.end(index)])
    }
    return list
  }

  async function decodeImage(source) {
    const image = new Image()
    image.crossOrigin = 'anonymous'
    image.src = source
    await image.decode()
    return { naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight }
  }

  async function loadVideo(video, source) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('video loadeddata timeout 15000 ms')), 15000)
      const onLoaded = () => {
        clearTimeout(timer)
        cleanup()
        resolve()
      }
      const onError = () => {
        clearTimeout(timer)
        cleanup()
        reject(new Error(`video error code=${video.error ? video.error.code : 'unknown'} message=${video.error ? video.error.message : ''}`))
      }
      const cleanup = () => {
        video.removeEventListener('loadeddata', onLoaded)
        video.removeEventListener('error', onError)
      }
      video.addEventListener('loadeddata', onLoaded)
      video.addEventListener('error', onError)
      video.src = source
      video.load()
    })
    return {
      duration: video.duration,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      readyState: video.readyState,
      seekable: rangesOf(video.seekable)
    }
  }

  async function seekVideo(video, seconds) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('seeked timeout 15000 ms')), 15000)
      const onSeeked = () => {
        clearTimeout(timer)
        video.removeEventListener('seeked', onSeeked)
        resolve()
      }
      video.addEventListener('seeked', onSeeked)
      video.currentTime = seconds
    })
    return {
      requested: seconds,
      currentTime: video.currentTime,
      seekable: rangesOf(video.seekable),
      readyState: video.readyState
    }
  }

  function resourceTiming(filter) {
    return performance
      .getEntriesByType('resource')
      .filter((entry) => filter(entry.name))
      .map((entry) => ({
        name: entry.name,
        initiatorType: entry.initiatorType,
        transferSize: entry.transferSize,
        encodedBodySize: entry.encodedBodySize,
        decodedBodySize: entry.decodedBodySize,
        durationMs: Math.round(entry.duration * 10) / 10
      }))
  }

  async function fetchJsonOrText(url, init) {
    const response = await fetch(url, init)
    const text = await response.text()
    return { status: response.status, body: text.slice(0, 400) }
  }

  // ---- 0) 宿主元数据 -----------------------------------------------------
  let meta = null
  await test('meta', async () => {
    meta = await invoke('resource_meta')
    results.windowLabel = meta.windowLabel
    results.monitors = meta.monitors
    results.windowPlacement = meta.windowPlacement
    return { windowLabel: meta.windowLabel, resources: meta.resources.map((item) => ({ tag: item.tag, byteLength: item.byteLength, mime: item.mime })) }
  })
  const byTag = Object.fromEntries(((meta && meta.resources) || []).map((item) => [item.tag, item]))

  // ---- 1) 图片：协议 vs command -----------------------------------------
  await test('image_protocol', async () => {
    const entry = byTag.image
    if (!entry) throw new Error('meta.image missing')
    const fetched = await fetchJsonOrText(entry.url, { cache: 'no-store' })
    const decoded = await decodeImage(entry.url)
    return { status: fetched.status, contentTypeHeadersProbe: fetched.body.slice(0, 120), ...decoded, url: entry.url }
  })

  await test('image_command', async () => {
    const entry = byTag.image
    if (!entry) throw new Error('meta.image missing')
    const bytes = await invoke('resource_command', { id: entry.id })
    const buffer = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer || bytes)
    const blob = new Blob([buffer], { type: entry.mime })
    const objectUrl = URL.createObjectURL(blob)
    const decoded = await decodeImage(objectUrl)
    URL.revokeObjectURL(objectUrl)
    return { byteLength: buffer.byteLength, expected: entry.byteLength, ...decoded }
  })

  // ---- 2) 视频：协议加载 / seek / 播放 / 画布取证 ------------------------
  const videoProtocol = document.getElementById('video-protocol')
  await test('video_protocol_load', async () => {
    const entry = byTag.video
    if (!entry) throw new Error('meta.video missing')
    return loadVideo(videoProtocol, entry.url)
  })

  await test('video_protocol_seek', async () => {
    const entry = byTag.video
    if (!entry) throw new Error('meta.video missing')
    return { url: entry.url, ...(await seekVideo(videoProtocol, 8.5)) }
  })

  await test('video_protocol_play', async () => {
    videoProtocol.muted = true
    const before = videoProtocol.currentTime
    await videoProtocol.play()
    await sleep(700)
    videoProtocol.pause()
    const after = videoProtocol.currentTime
    return { before, after, advanced: after > before, paused: videoProtocol.paused }
  })

  await test('video_frame_artifact', async () => {
    const canvas = document.getElementById('frame')
    if (!canvas) throw new Error('canvas#frame missing')
    canvas.width = 480
    canvas.height = 270
    canvas.getContext('2d').drawImage(videoProtocol, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/png')
    const saved = await invoke('resource_save_artifact', {
      name: 'video-frame-protocol',
      base64: dataUrl.split(',')[1]
    })
    return { saved, tainted: false }
  })

  // ---- 3) 显式 Range 请求 ------------------------------------------------
  await test('range_manual', async () => {
    const entry = byTag.video
    if (!entry) throw new Error('meta.video missing')
    const response = await fetch(entry.url, { headers: { Range: 'bytes=1000-1999' }, cache: 'no-store' })
    const body = await response.arrayBuffer()
    return {
      status: response.status,
      contentRange: response.headers.get('content-range'),
      acceptRanges: response.headers.get('accept-ranges'),
      contentLength: response.headers.get('content-length'),
      bodyBytes: body.byteLength
    }
  })

  await test('range_suffix', async () => {
    const entry = byTag.video
    if (!entry) throw new Error('meta.video missing')
    const response = await fetch(entry.url, { headers: { Range: 'bytes=-500' }, cache: 'no-store' })
    const body = await response.arrayBuffer()
    return { status: response.status, contentRange: response.headers.get('content-range'), bodyBytes: body.byteLength }
  })

  await test('range_invalid', async () => {
    const entry = byTag.video
    if (!entry) throw new Error('meta.video missing')
    const response = await fetch(entry.url, {
      headers: { Range: `bytes=${entry.byteLength + 999999}-` },
      cache: 'no-store'
    })
    return { status: response.status, contentRange: response.headers.get('content-range'), body: (await response.text()).slice(0, 200) }
  })

  await test('custom_header_preflight', async () => {
    const entry = byTag.video
    if (!entry) throw new Error('meta.video missing')
    const response = await fetch(entry.url, { headers: { 'X-R0-Probe': '1' }, cache: 'no-store' })
    const body = await response.arrayBuffer()
    return { status: response.status, bodyBytes: body.byteLength }
  })

  // ---- 4) 视频走 command（全量二进制，不可 seek 流式） --------------------
  await test('video_command_path', async () => {
    const entry = byTag.video
    if (!entry) throw new Error('meta.video missing')
    const bytes = await invoke('resource_command', { id: entry.id })
    const buffer = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer || bytes)
    const blob = new Blob([buffer], { type: entry.mime })
    const objectUrl = URL.createObjectURL(blob)
    const video = document.getElementById('video-command')
    try {
      const loaded = await loadVideo(video, objectUrl)
      const seeked = await seekVideo(video, 6)
      return { byteLength: buffer.byteLength, expected: entry.byteLength, loaded, seeked }
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  })

  // ---- 5) 拒绝路径：未知 / 遍历 / 过期 / 撤销 ----------------------------
  await test('unknown_id', async () => {
    const response = await fetch(`${base}/r/${'0'.repeat(32)}`, { cache: 'no-store' })
    return { status: response.status, body: (await response.text()).slice(0, 240) }
  })

  await test('traversal_dotdot', async () => {
    const encoded = await fetchJsonOrText(`${base}/r/..%2F..%2FWindows%2Fwin.ini`, { cache: 'no-store' })
    const normalized = await fetchJsonOrText(`${base}/../../Windows/win.ini`, { cache: 'no-store' })
    return { encoded, normalized }
  })

  await test('path_traversal_query', async () => {
    const entry = byTag.image
    if (!entry) throw new Error('meta.image missing')
    const response = await fetch(`${entry.url}?path=../../Windows/win.ini`, { cache: 'no-store' })
    const body = await response.arrayBuffer()
    return { status: response.status, bodyBytes: body.byteLength, note: 'query 不参与资源解析，仍返回资源本体' }
  })

  await test('expiring_id', async () => {
    const created = await invoke('resource_make_expiring', { ttlMs: 1200 })
    await sleep(created.ttlMs + 1200)
    const response = await fetch(`${created.url}?after=expiry`, { cache: 'no-store' })
    return { status: response.status, body: (await response.text()).slice(0, 240), ttlMs: created.ttlMs }
  })

  await test('revoked_id', async () => {
    const entry = byTag['release-test']
    if (!entry) throw new Error('meta.release-test missing')
    const revoked = await invoke('resource_revoke', { id: entry.id })
    const response = await fetch(`${entry.url}?after=revoke`, { cache: 'no-store' })
    return { revoked, status: response.status, body: (await response.text()).slice(0, 240) }
  })

  // ---- 6) CSP ------------------------------------------------------------
  await test('csp_block', async () => {
    let fetchError = null
    try {
      await fetch('http://csp-blocked.invalid/r/x', { cache: 'no-store' })
    } catch (error) {
      fetchError = errorText(error)
    }
    let imageError = null
    try {
      await decodeImage('http://csp-blocked.invalid/r/x.png')
    } catch (error) {
      imageError = errorText(error)
    }
    await sleep(500)
    return { fetchError, imageError, violationCount: violations.length, violations: violations.slice(0, 8) }
  })

  // ---- 7) 20 MiB 传输对照：command vs protocol ---------------------------
  const transport = { runs: [], command: [], protocol: [] }
  await test('transport_20mb', async () => {
    const entry = byTag['big-20mb']
    if (!entry) throw new Error('meta.big-20mb missing')
    const memorySamples = []
    const sampleMemory = () => {
      const memory = performance.memory
      return memory ? { usedJSHeapSize: memory.usedJSHeapSize, totalJSHeapSize: memory.totalJSHeapSize } : null
    }
    for (let round = 0; round < 3; round += 1) {
      const commandStart = now()
      const bytes = await invoke('resource_command', { id: entry.id })
      const commandMs = now() - commandStart
      const commandLength = bytes instanceof ArrayBuffer ? bytes.byteLength : (bytes.buffer ? bytes.buffer.byteLength : bytes.length)
      transport.command.push({ round, ms: Math.round(commandMs * 10) / 10, byteLength: commandLength })
      transport.runs.push({ round, path: 'command', ms: Math.round(commandMs * 10) / 10, byteLength: commandLength })
      memorySamples.push(sampleMemory())

      const protocolStart = now()
      const response = await fetch(`${entry.url}?round=${round}`, { cache: 'no-store' })
      const buffer = await response.arrayBuffer()
      const protocolMs = now() - protocolStart
      transport.protocol.push({
        round,
        ms: Math.round(protocolMs * 10) / 10,
        byteLength: buffer.byteLength,
        status: response.status,
        contentLength: response.headers.get('content-length')
      })
      transport.runs.push({ round, path: 'protocol', ms: Math.round(protocolMs * 10) / 10, byteLength: buffer.byteLength })
      memorySamples.push(sampleMemory())
    }
    const summarize = (runs) => ({
      minMs: Math.min(...runs.map((run) => run.ms)),
      maxMs: Math.max(...runs.map((run) => run.ms)),
      avgMs: Math.round((runs.reduce((sum, run) => sum + run.ms, 0) / runs.length) * 10) / 10,
      byteLength: runs[0] ? runs[0].byteLength : null
    })
    return {
      expectedBytes: entry.byteLength,
      command: transport.command,
      protocol: transport.protocol,
      commandSummary: summarize(transport.command),
      protocolSummary: summarize(transport.protocol),
      memorySamples: memorySamples.filter(Boolean),
      resourceTiming: resourceTiming((name) => name.indexOf('media.localhost') !== -1),
      note: 'memorySamples 是 Chromium 非标准 performance.memory，未强制 GC，只作数量级参考'
    }
  })

  // ---- 8) 收尾：把结果交回宿主 ------------------------------------------
  results.protocolTiming = resourceTiming((name) => name.indexOf('media.localhost') !== -1)
  results.allResourceTiming = performance
    .getEntriesByType('resource')
    .slice(0, 80)
    .map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
      durationMs: Math.round(entry.duration * 10) / 10
    }))
  let reported = false
  for (let attempt = 0; attempt < 3 && !reported; attempt += 1) {
    try {
      await invoke('resource_report', { report: results })
      reported = true
    } catch (error) {
      log(`resource_report attempt ${attempt + 1} failed: ${errorText(error)}`)
      await sleep(300)
    }
  }
  log(reported ? 'report delivered' : 'report FAILED')
  if (reported) {
    log('所有 A 侧测试完成，等待宿主汇总（窗口可保留到自动退出）。')
  }
})()
